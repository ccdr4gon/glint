// Glint background helper: keeps one Claude process started ahead of time for each kind of
// request (check / lookup), so a request doesn't wait ~2-3 s for Claude to start up.
//
// Started on demand by llm.mjs (`node glint.mjs daemon`). It listens on a named pipe (Unix socket on
// macOS/Linux), handles one request per connection, and exits after 30 minutes without requests.
// Each warm process answers one request and is then replaced, so no conversation builds up.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { HOME, pipePath, readResult, spawnClaude, specKey } from './llm.mjs';

const IDLE_EXIT_MS = 30 * 60 * 1000;
const SPARE_IDLE_MS = 15 * 60 * 1000;  // drop a warm process nobody has used for this long
const REQUEST_TIMEOUT_MS = 45 * 1000;
const LOG_FILE = path.join(HOME, 'daemon.log');

function log(message) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 200_000) fs.rmSync(LOG_FILE);
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${message}\n`);
  } catch {
    // logging must never take the helper down
  }
}

class Spare {
  constructor(spec) {
    this.spec = spec;
    this.lastUsed = Date.now();
    this.child = spawnClaude(spec, { streamInput: true });
    this.dead = false;
    this.child.on('exit', () => (this.dead = true));
    this.child.on('error', (err) => {
      this.dead = true;
      log(`claude failed to start: ${err.message}`);
    });
  }

  async run(user, onDelta) {
    const result = readResult(this.child, onDelta);
    this.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: user } }) + '\n');
    let timer;
    try {
      return await Promise.race([
        result,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer after ${REQUEST_TIMEOUT_MS / 1000} s`)), REQUEST_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  close() {
    if (this.dead) return;
    this.child.stdin.end();
    setTimeout(() => this.dead || this.child.kill(), 5000).unref();
  }
}

const spares = new Map(); // spec key -> Spare waiting for its next request
const queues = new Map(); // spec key -> promise chain, so requests of one kind run in order
let lastActivity = Date.now();

function takeSpare(spec, key) {
  const spare = spares.get(key);
  spares.delete(key);
  if (spare && !spare.dead) return spare;
  spare?.close();
  return new Spare(spec);
}

async function handle(request, send) {
  const { spec, user, stream } = request;
  const key = specKey(spec);
  const prev = queues.get(key) ?? Promise.resolve();
  const job = prev.catch(() => {}).then(async () => {
    const started = Date.now();
    const spare = takeSpare(spec, key);
    try {
      const result = await spare.run(user, stream ? (text) => send({ type: 'delta', text }) : undefined);
      send({ type: 'result', result });
      log(`answered in ${Date.now() - started} ms`);
    } catch (err) {
      send({ type: 'error', message: err.message });
      log(`request failed: ${err.message}`);
    } finally {
      spare.close();
      const next = spares.get(key);
      if (!next || next.dead) spares.set(key, new Spare(spec)); // warm up the next one right away
      lastActivity = Date.now();
    }
  });
  queues.set(key, job);
  return job;
}

function shutdown(reason) {
  log(`exiting: ${reason}`);
  for (const spare of spares.values()) spare.close();
  server.close();
  setTimeout(() => process.exit(0), 300).unref();
}

const server = net.createServer((sock) => {
  sock.on('error', () => {});
  const rl = readline.createInterface({ input: sock });
  rl.once('line', (line) => {
    rl.close();
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      sock.end(JSON.stringify({ type: 'error', message: 'bad request' }) + '\n');
      return;
    }
    if (request.type === 'shutdown') {
      sock.end(JSON.stringify({ type: 'result', result: 'bye' }) + '\n');
      shutdown('asked to stop');
      return;
    }
    if (request.type === 'warm') {
      // Keep a process ready for this kind of request (the window asks every few minutes).
      if (request.spec?.model && request.spec?.system) {
        const key = specKey(request.spec);
        const spare = spares.get(key);
        if (spare && !spare.dead) spare.lastUsed = Date.now();
        else spares.set(key, new Spare(request.spec));
      }
      lastActivity = Date.now();
      sock.end(JSON.stringify({ type: 'result', result: 'warm' }) + '\n');
      return;
    }
    if (request.type === 'status') {
      const warm = [...spares.values()].filter((s) => !s.dead).length;
      sock.end(JSON.stringify({ type: 'result', result: { pid: process.pid, warm, idleSeconds: Math.round((Date.now() - lastActivity) / 1000) } }) + '\n');
      return;
    }
    if (!request.spec?.model || !request.spec?.system || typeof request.user !== 'string') {
      sock.end(JSON.stringify({ type: 'error', message: `unknown request: ${String(request.type ?? 'run').slice(0, 40)}` }) + '\n');
      return;
    }
    lastActivity = Date.now();
    const send = (msg) => sock.writable && sock.write(JSON.stringify(msg) + '\n');
    handle(request, send).finally(() => sock.end());
  });
});

export function runDaemon(warmSpecBase64) {
  process.on('uncaughtException', (err) => log(`unexpected error: ${err?.stack ?? err}`)); // log it, keep serving
  const where = pipePath();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      process.exit(0); // another helper is already running
    }
    log(`server error: ${err.message}`);
    process.exit(1);
  });
  if (process.platform !== 'win32' && fs.existsSync(where)) {
    // A socket file left behind by a helper that crashed: remove it if nothing answers on it.
    const probe = net.connect(where);
    probe.on('connect', () => process.exit(0));
    probe.on('error', () => {
      fs.rmSync(where, { force: true });
      listen(where, warmSpecBase64);
    });
    return;
  }
  listen(where, warmSpecBase64);
}

function listen(where, warmSpecBase64) {
  server.listen(where, () => {
    log(`listening on ${where}`);
    if (warmSpecBase64) {
      try {
        const spec = JSON.parse(Buffer.from(warmSpecBase64, 'base64').toString('utf8'));
        spares.set(specKey(spec), new Spare(spec));
      } catch (err) {
        log(`bad warm-up spec: ${err.message}`);
      }
    }
  });
  setInterval(() => {
    const now = Date.now();
    for (const [key, spare] of spares) {
      if (spare.dead || now - spare.lastUsed > SPARE_IDLE_MS) {
        spare.close();
        spares.delete(key);
      }
    }
    if (now - lastActivity > IDLE_EXIT_MS) shutdown('idle');
  }, 30 * 1000).unref();
  // keep the process alive while the server is open
}
