#!/usr/bin/env node
// Stand-in for `claude -p` in tests. Supports the flags Glint uses.
//
// Replies depend on the text it gets:
//   contains "got error"  -> the check finds a mistake (a draft with a numbered list keeps its
//                            layout in the natural version, like the real model is told to)
//   contains "SLOW"       -> waits 3 s before answering
//   contains "LOGIN"      -> fails like a logged-out CLI
//   anything else         -> the check passes
// Without --json-schema it answers in plain text, streamed when --include-partial-messages is set.
// Set FAKE_CLAUDE_LOG to a file to record each launch (args and the env vars tests care about), and
// FAKE_CLAUDE_PROMPTS to a file to record the text of each request.

import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const schema = opt('--json-schema');
const outputFormat = opt('--output-format') ?? 'text';
const streamInput = opt('--input-format') === 'stream-json';
const partial = args.includes('--include-partial-messages');

if (process.env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
    pid: process.pid,
    args,
    env: {
      CLAUDECODE: process.env.CLAUDECODE ?? null,
      CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID ?? null,
      GLINT_CHILD: process.env.GLINT_CHILD ?? null,
    },
  }) + '\n');
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reply(text) {
  if (/LOGIN/.test(text)) return { error: 'Not logged in · Please run /login' };
  if (schema) {
    if (/[一-鿿]/.test(text)) {
      return { structured: { english: false, mistakes: [], suggestions: [], natural: 'Please help me check this.' } };
    }
    const mistakes = /got error/i.test(text)
      ? [{ original: 'got error', better: 'throws an error', reason: '"got" here is Singlish' }]
      : [];
    const suggestions = /what to do next/i.test(text)
      ? [{ original: 'what to do next?', better: 'what should I do next?', reason: 'a bit more natural as a direct question' }]
      : [];
    const draft = /<prompt>\n?([\s\S]*?)\n?<\/prompt>/.exec(text)?.[1] ?? text;
    let natural;
    if (mistakes.length || suggestions.length) {
      natural = /^\d+\. /m.test(draft) ? draft.replace(/got error/gi, 'throws an error') : 'Why does the API throw an error?';
    }
    return { structured: { english: true, mistakes, suggestions, natural } };
  }
  return { text: `- "Could you take a look?": polite, for work chat\n(question: ${text.trim().slice(0, 40)})` };
}

async function respond(text) {
  if (process.env.FAKE_CLAUDE_PROMPTS) fs.appendFileSync(process.env.FAKE_CLAUDE_PROMPTS, JSON.stringify({ text }) + '\n');
  if (/SLOW/.test(text)) await sleep(3000);
  const r = reply(text);
  const result = r.error
    ? { type: 'result', subtype: 'success', is_error: true, result: r.error }
    : { type: 'result', subtype: 'success', is_error: false, result: r.text ?? JSON.stringify(r.structured), structured_output: r.structured };

  if (outputFormat === 'stream-json') {
    if (partial && r.text) {
      for (const chunk of r.text.match(/[\s\S]{1,8}/g)) {
        emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } });
        await sleep(5);
      }
    }
    emit(result);
  } else if (outputFormat === 'json') {
    process.stdout.write(JSON.stringify(result));
  } else {
    process.stdout.write(String(result.result));
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

if (streamInput) {
  emit({ type: 'system', subtype: 'init' });
  const rl = readline.createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'user') queue = queue.then(() => respond(textOf(msg.message?.content)));
  });
  rl.on('close', () => queue.then(() => process.exit(0)));
} else {
  // One-off runs get the prompt on stdin, like the real `claude -p` when no prompt argument is given.
  await respond(fs.readFileSync(0, 'utf8'));
}
