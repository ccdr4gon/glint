// Runs Claude for Glint's own checks and lookups.
//
// A request goes to the background helper (daemon.mjs) when it's running: it keeps a Claude process
// started ahead of time, so an answer takes ~1.5-3 s instead of ~4-6 s. If the helper isn't running,
// the request runs as a one-off `claude -p` and the helper is started for next time.
//
// Child processes use the user's own Claude CLI login. Variables the host Claude Code session sets
// (CLAUDECODE, CLAUDE_CODE_*) are removed, so a child doesn't act as part of that session and keeps
// working after it ends.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(SCRIPTS_DIR, '..');
export const HOME = process.env.GLINT_HOME || path.join(os.homedir(), '.claude', 'glint');
export const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  } catch {
    return 'dev';
  }
})();

const HOST_SESSION_VARS = /^(CLAUDECODE|CLAUDE_CODE_\w*|CLAUDE_AGENT_SDK_\w*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_\w*|AI_AGENT|USE_LOCAL_OAUTH|USE_STAGING_OAUTH)$/i;

export function childEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !HOST_SESSION_VARS.test(k)));
  env.GLINT_CHILD = '1'; // our hooks see this and do nothing, so a child never checks itself
  return env;
}

// [executable, ...leading args]. GLINT_CLAUDE overrides it (tests point it at a fake .mjs).
export function claudeCommand() {
  const override = process.env.GLINT_CLAUDE;
  if (override) return /\.[cm]?js$/i.test(override) ? [process.execPath, override] : [override];
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin')];
  for (const dir of dirs) {
    if (dir && fs.existsSync(path.join(dir, exe))) return [path.join(dir, exe)];
  }
  return [exe];
}

// spec: { model, effort, system, schema? }. Same spec -> same warm process in the helper.
export function claudeArgs(spec, { streamInput = false } = {}) {
  const args = [
    '-p', '--model', spec.model, '--effort', spec.effort ?? 'low',
    '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '',
    '--settings', '{"disableAllHooks":true}', '--disable-slash-commands',
    '--system-prompt', spec.system,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  ];
  if (spec.schema) args.push('--json-schema', JSON.stringify(spec.schema));
  if (streamInput) args.push('--input-format', 'stream-json');
  return args;
}

export function specKey(spec) {
  return crypto.createHash('sha1').update(JSON.stringify([spec.model, spec.effort, spec.system, spec.schema ?? null])).digest('hex');
}

export function spawnClaude(spec, options) {
  const [cmd, ...pre] = claudeCommand();
  return spawn(cmd, [...pre, ...claudeArgs(spec, options)], {
    cwd: os.tmpdir(), // keep any project CLAUDE.md out of it
    env: childEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

// Reads stream-json lines from a Claude process until its result. Resolves { isError, text, structured }.
export function readResult(child, onDelta) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += d));
    const rl = readline.createInterface({ input: child.stdout });
    const onLine = (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const delta = msg.type === 'stream_event' && msg.event?.delta?.type === 'text_delta' ? msg.event.delta.text : null;
      if (delta) onDelta?.(delta);
      if (msg.type === 'result') {
        cleanup();
        resolve({ isError: Boolean(msg.is_error), text: String(msg.result ?? ''), structured: msg.structured_output ?? null });
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(stderr.trim().split('\n').pop() || `claude exited with code ${code} before answering`));
    };
    const cleanup = () => {
      rl.off('line', onLine);
      child.off('exit', onExit);
    };
    rl.on('line', onLine);
    child.on('exit', onExit);
    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(`no answer after ${Math.round(ms / 1000)} s`));
      }, ms);
    }),
  ]);
}

export async function runOnce(spec, user, { onDelta, timeoutMs = 40000 } = {}) {
  const child = spawnClaude(spec);
  const result = readResult(child, onDelta);
  child.stdin.end(user); // the prompt goes in on stdin, so text starting with "-" can't look like a flag
  return withTimeout(result, timeoutMs, () => child.kill());
}

// ---------- background helper ----------

export function pipePath() {
  const id = crypto.createHash('sha1').update(HOME.toLowerCase()).digest('hex').slice(0, 10);
  const name = `glint-${id}-${VERSION}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

// Sends one JSON request and collects the reply lines. Rejects with code NO_DAEMON if nothing is listening.
export function askDaemon(request, { onDelta, timeoutMs = 40000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipePath());
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`no answer after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    let connected = false;
    sock.on('error', (err) => finish(reject, connected ? err : Object.assign(new Error('helper not running'), { code: 'NO_DAEMON', cause: err })));
    sock.on('close', () => finish(reject, new Error('helper closed the connection')));
    sock.on('connect', () => {
      connected = true;
      // Read replies only once connected: a readline interface on a socket that fails to connect
      // re-emits the error, and with nobody listening that would crash the hook.
      const rl = readline.createInterface({ input: sock });
      rl.on('error', () => {});
      rl.on('line', (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === 'delta') onDelta?.(msg.text);
        else if (msg.type === 'result') finish(resolve, msg.result);
        else if (msg.type === 'error') finish(reject, new Error(msg.message));
      });
      sock.write(JSON.stringify(request) + '\n');
    });
  });
}

export function startDaemon(warmSpec) {
  if (process.env.GLINT_NO_DAEMON) return;
  const args = [path.join(SCRIPTS_DIR, 'glint.mjs'), 'daemon'];
  if (warmSpec) args.push(Buffer.from(JSON.stringify(warmSpec)).toString('base64'));
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env: childEnv() });
  child.unref();
}

// Run a request through the helper, or once directly if the helper isn't there (and start it).
export async function runClaude(spec, user, { onDelta, timeoutMs = 40000 } = {}) {
  if (!process.env.GLINT_NO_DAEMON) {
    try {
      return await askDaemon({ spec, user, stream: Boolean(onDelta) }, { onDelta, timeoutMs });
    } catch (err) {
      if (err.code !== 'NO_DAEMON') throw err;
      startDaemon(spec);
    }
  }
  return runOnce(spec, user, { onDelta, timeoutMs });
}
