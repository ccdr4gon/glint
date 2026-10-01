#!/usr/bin/env node
// Glint for Claude Code: hook handlers plus a small CLI.
//
//   node glint.mjs prompt                 UserPromptSubmit hook
//   node glint.mjs stop                   Stop hook (inline mode: saves Claude's feedback to the journal)
//   node glint.mjs check <text>           check a draft's English (--in/--out files: used by the window)
//   node glint.mjs ask <question>         look up an English phrase (--in/--out files: used by the window)
//   node glint.mjs warm                   start the background helper with a check ready
//   node glint.mjs config [key value]     show or change settings (also: on, off, hotkey, gate, inline, reset)
//   node glint.mjs journal [N]            print the last N journal entries (default 40)
//   node glint.mjs daemon [status|stop]   the background helper (started automatically)
//
// Three modes:
//   hotkey (default)  Nothing happens in the session. Press Alt+Enter in the Claude desktop app to
//                     check your draft; the Glint window shows the suggestions.
//   gate              Before Claude sees a prompt, Sonnet checks its English. If it finds mistakes, the
//                     prompt is held back and you get corrections. Send again (edited or as-is) and it
//                     goes straight through. Start a prompt with * to skip the check.
//   inline            The prompt goes straight to Claude, which adds the feedback to its reply.
//
// Data lives in ~/.claude/glint/ (override with GLINT_HOME).
// A hook must never trap the user: any error lets the prompt through.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, PLUGIN_ROOT, askDaemon, runClaude, startDaemon } from './llm.mjs';
import { checkRtf, lookupRtf, messageRtf } from './rtf.mjs';

const PROMPTS_DIR = path.join(PLUGIN_ROOT, 'prompts');
const CONFIG_FILE = path.join(HOME, 'config.json');
const JOURNAL_FILE = path.join(HOME, 'journal.jsonl');
const PENDING_DIR = path.join(HOME, 'pending'); // inline mode: a prompt waiting for Claude's feedback
const HELD_DIR = path.join(HOME, 'held');       // gate mode: the last held-back prompt, so its resend goes through
const WINDOW_DIR = path.join(HOME, 'window');   // latest feedback, shown by the Glint window
const LAST_CHECK_FILE = path.join(WINDOW_DIR, 'last-check.json'); // hotkey mode: links a check to what you then send

const RESEND_WINDOW_MS = 30 * 60 * 1000;
const REVISION_WINDOW_MS = 15 * 60 * 1000; // hotkey mode: a prompt sent this soon after a check is its revision
const CHECK_TIMEOUT_MS = Number(process.env.GLINT_CHECK_TIMEOUT_MS) || 40 * 1000; // hooks.json allows 60 s

const DEFAULTS = {
  enabled: true,
  mode: 'hotkey',             // hotkey | gate | inline
  model: 'claude-sonnet-5-5', // used for gate checks and phrase lookups
  level: 'normal',            // light | normal | strict
  maxItems: 5,
  minWords: 3,                // prompts with fewer prose words ("yes", "continue") are not checked
  copyOnBlock: true,          // gate: put a held-back prompt on the clipboard
  position: 'start',          // inline: where Claude puts the feedback (start | end)
  rewrite: 'auto',            // auto | always | never: the full "Natural version"
  journal: true,              // save feedback so /glint:review can find recurring mistakes
};

const CHOICES = {
  mode: ['hotkey', 'gate', 'inline'],
  level: ['light', 'normal', 'strict'],
  position: ['start', 'end'],
  rewrite: ['auto', 'always', 'never'],
};

const POSITION_RULES = {
  start: 'Put it at the very start of your first reply, before any other text or tool call.',
  end: 'Put it at the very end of your final reply, after everything else.',
};

const LEVEL_RULES = {
  light: 'Only flag clear errors and wording that could confuse a reader; skip style polish.',
  normal: 'Ignore casual chat style (lowercase, missing final punctuation, "pls").',
  strict: 'Also flag casual chat style ("plz", "u") and capitalisation/punctuation (as one grouped item), as if it were a PR description or work email.',
};

const REWRITE_RULES = {
  auto: 'Include "Natural version" only if there are issues and the message is under ~80 words.',
  always: 'Include "Natural version" whenever there are issues.',
  never: 'Leave out the "Natural version" line.',
};

// Gate mode: mistakes hold a prompt back; suggestions (correct but could sound more natural) only
// hold it back at the strict level. Otherwise they're shown as a tip and the prompt goes through.
const CHECK_LEVEL_RULES = {
  light: 'Only report clear mistakes that could confuse a reader. Leave "suggestions" empty.',
  normal: 'Ignore casual chat style (lowercase, missing final punctuation, "pls"). Give at most 2 suggestions.',
  strict: 'Also count casual chat style ("plz", "u", capitalisation, punctuation) as mistakes, grouped into one item, as if it were a PR description or work email. Give at most 3 suggestions.',
};

const CHECK_ITEM = {
  type: 'object',
  properties: { original: { type: 'string' }, better: { type: 'string' }, reason: { type: 'string' } },
  required: ['original', 'better', 'reason'],
};

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    english: { type: 'boolean' },
    mistakes: { type: 'array', items: CHECK_ITEM },
    suggestions: { type: 'array', items: CHECK_ITEM },
    natural: { type: 'string' },
  },
  required: ['english', 'mistakes', 'suggestions'],
};

// Harness-generated "prompts" (background task results, slash command echoes, etc.), not user writing.
const MACHINE_EVENT_RE = /^<(task-notification|command-(name|message|args)|local-command-(stdout|stderr|caveat)|system-reminder|bash-(input|stdout|stderr)|ci-monitor-event|agent-message|user-prompt-submit-hook)\b/;

// Matches the block header Claude writes in inline mode, tolerating small formatting drift.
const HEADER_RE = /📝\s*\**\s*English check/i;

// ---------- config ----------

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  const changed = Object.fromEntries(Object.entries(cfg).filter(([k, v]) => DEFAULTS[k] !== v));
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(changed, null, 2) + '\n');
}

function parseValue(key, raw) {
  if (!(key in DEFAULTS)) {
    throw new Error(`Unknown setting "${key}". Settings: ${Object.keys(DEFAULTS).join(', ')}.`);
  }
  const value = String(raw ?? '').trim();
  if (CHOICES[key]) {
    if (!CHOICES[key].includes(value.toLowerCase())) throw new Error(`${key} must be one of: ${CHOICES[key].join(', ')}.`);
    return value.toLowerCase();
  }
  if (typeof DEFAULTS[key] === 'boolean') {
    if (['on', 'true', 'yes', '1'].includes(value.toLowerCase())) return true;
    if (['off', 'false', 'no', '0'].includes(value.toLowerCase())) return false;
    throw new Error(`${key} must be on or off.`);
  }
  if (typeof DEFAULTS[key] === 'string') {
    if (!/^[\w.:-]{1,80}$/.test(value)) throw new Error(`${key} must be a model name, like ${DEFAULTS[key]}.`);
    return value;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 50) throw new Error(`${key} must be a whole number from 0 to 50.`);
  return n;
}

function fill(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m).trim();
}

// ---------- shared prompt helpers ----------

// Remove text that isn't the user's own prose, so we only count words they actually wrote.
export function stripNonProse(text) {
  return String(text)
    .replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/gi, ' ')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s*>.*$/gm, ' ');
}

// What the gate check sends to Sonnet: the user's prose, with pasted text and code as placeholders.
export function proseForCheck(text) {
  return String(text)
    .replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/gi, '[pasted text]')
    .replace(/```[\s\S]*?(```|$)/g, '[code]')
    .replace(/^\s*>.*$/gm, '[quoted text]')
    .trim()
    .slice(0, 4000);
}

function proseWordCount(text) {
  const prose = stripNonProse(text);
  const latinWords = prose.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? [];
  const cjkChars = prose.match(/[぀-ヿ㐀-鿿가-힯]/g) ?? [];
  return latinWords.length + Math.floor(cjkChars.length / 2);
}

// "/" = slash command, "!" = shell mode, plus harness events: never user prose.
function isCommandOrEvent(text) {
  return /^[/!]/.test(text) || MACHINE_EVENT_RE.test(text);
}

export function shouldCheck(prompt, cfg) {
  if (!cfg.enabled) return false;
  const text = String(prompt ?? '').trim();
  // "*" = the user's "don't check this one"; "{" / "[" = JSON from a tool driving Claude Code
  if (!text || text.startsWith('*') || /^[[{]/.test(text) || isCommandOrEvent(text)) return false;
  return proseWordCount(text) >= cfg.minWords;
}

function safeId(id) {
  return String(id || 'unknown').replace(/[^\w-]/g, '_');
}

function appendJournal(entry) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.appendFileSync(JOURNAL_FILE, JSON.stringify(entry) + '\n');
}

function noteText(item) {
  return `"${item.original}" → "${item.better}": ${item.reason}`;
}

function friendlyError(err) {
  const msg = String(err?.message ?? err);
  if (/not logged in|\/login/i.test(msg)) return 'the Claude CLI is not logged in. Run `claude` in a terminal and use /login.';
  if (/ENOENT/.test(msg)) return "couldn't find the Claude CLI. Install it, or set GLINT_CLAUDE to its path.";
  return msg.slice(0, 200);
}

// ---------- gate mode ----------

function checkSpec(cfg) {
  const template = fs.readFileSync(path.join(PROMPTS_DIR, 'check-system.md'), 'utf8');
  return {
    model: cfg.model,
    effort: 'low',
    system: fill(template, { LEVEL_RULE: CHECK_LEVEL_RULES[cfg.level] ?? CHECK_LEVEL_RULES.normal, MAX_ITEMS: String(cfg.maxItems) }),
    schema: CHECK_SCHEMA,
  };
}

function askSpec(cfg) {
  return { model: cfg.model, effort: 'low', system: fs.readFileSync(path.join(PROMPTS_DIR, 'ask-system.md'), 'utf8').trim() };
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    try {
      return m ? JSON.parse(m[0]) : null;
    } catch {
      return null;
    }
  }
}

function cleanItems(list) {
  return (Array.isArray(list) ? list : [])
    .filter((i) => i && typeof i.original === 'string' && typeof i.better === 'string' && i.original.trim() !== i.better.trim())
    .map((i) => ({ original: i.original.trim(), better: i.better.trim(), reason: String(i.reason ?? '').trim() }));
}

// Decides what to do with Sonnet's answer. Unexpected or missing fields count as "nothing to fix",
// so a bad answer never holds a prompt back.
export function normalizeCheck(raw, level = 'normal') {
  const mistakes = cleanItems(raw?.mistakes ?? raw?.items);
  let suggestions = level === 'light' ? [] : cleanItems(raw?.suggestions);
  if (level === 'strict') {
    mistakes.push(...suggestions);
    suggestions = [];
  }
  const natural = typeof raw?.natural === 'string' ? raw.natural.trim() : '';
  const notEnglish = raw?.english === false && Boolean(natural);
  return { mistakes, suggestions, natural, notEnglish, hold: mistakes.length > 0 || notEnglish };
}

export function formatHeld(result, cfg, { copied = false, words = 0 } = {}) {
  const lines = ['📝 English check: not sent yet'];
  for (const item of result.mistakes) lines.push(`• ${noteText(item)}`);
  for (const item of result.suggestions) lines.push(`◦ Optional: ${noteText(item)}`);
  const showNatural = result.natural && cfg.rewrite !== 'never'
    && (cfg.rewrite === 'always' || words <= 120 || result.notEnglish);
  if (showNatural) lines.push(`✏️ ${result.notEnglish ? 'In English' : 'Natural version'}: ${result.natural}`);
  const paste = process.platform === 'darwin' ? 'Cmd+V' : 'Ctrl+V';
  lines.push(`↩ Send it again, edited or as-is, and it goes straight through.${copied ? ` Your prompt is on the clipboard (${paste}).` : ''} Start a prompt with * to skip the check.`);
  return lines.join('\n');
}

// ---------- applying one fix to the draft ----------

const QUOTE_CLASS = '[\'‘’"“”]';
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Replace the first place `original` appears in `text` with `better`. Tries an exact match, then
// ignores case, then also tolerates different spacing and straight/curly quotes. If the matched
// words started with a capital letter, so does the fix.
export function applyFix(text, original, better) {
  const src = String(text);
  const orig = String(original ?? '').trim();
  if (!orig) return { text: src, found: false };
  const loose = escapeRegExp(orig).replace(/\s+/g, '\\s+').replace(/['‘’"“”]/g, QUOTE_CLASS);
  const search = (pattern) => {
    const m = new RegExp(pattern, 'i').exec(src);
    return m && { index: m.index, length: m[0].length };
  };
  const attempts = [
    () => {
      const i = src.indexOf(orig);
      return i >= 0 ? { index: i, length: orig.length } : null;
    },
    () => search(escapeRegExp(orig)),
    () => search(loose),
  ];
  for (const attempt of attempts) {
    const hit = attempt();
    if (!hit) continue;
    const { length } = hit;
    const matched = src.slice(hit.index, hit.index + length);
    let replacement = String(better);
    if (/^[A-Z]/.test(matched) && /^[a-z]/.test(replacement)) replacement = replacement[0].toUpperCase() + replacement.slice(1);
    return { text: src.slice(0, hit.index) + replacement + src.slice(hit.index + length), found: true };
  }
  return { text: src, found: false };
}

// Mistakes then suggestions, in the order the window numbers them (fix 1, fix 2, ...).
const allItems = (result) => [...result.mistakes, ...result.suggestions];

const contains = (text, phrase) => applyFix(text, phrase, phrase).found;

// Fixes can overlap: an optional idea may rephrase words a mistake also fixes. Once fix A has been
// applied, item i's words look different in the draft, so carry the applied fixes (in the order
// they were applied) over to item i's original before looking for it.
function currentOriginal(items, i, applied = []) {
  let original = items[i].original;
  for (const n of applied) {
    const fix = items[n - 1];
    if (!fix || n - 1 === i) continue;
    const r = applyFix(original, fix.original, fix.better);
    if (r.found) original = r.text;
  }
  return original;
}

// For each item: 'applied' (applied with Apply), 'can' (its words are in the draft), 'fixed' (the
// fix is already in the draft, e.g. through an overlapping fix), or 'no' (its words are gone).
function applyStates(result, draft, applied = []) {
  const items = allItems(result);
  return items.map((it, i) => {
    if (applied.includes(i + 1)) return 'applied';
    if (contains(draft, currentOriginal(items, i, applied))) return 'can';
    if (contains(draft, it.better)) return 'fixed';
    return 'no';
  });
}

// The frosted-glass panel's state for a check (see design/ and window.glint.render in its HTML).
export function panelCheck(result, states, { showNatural = true, status } = {}) {
  const withStates = (list, offset) => list.map((it, i) => ({ ...it, state: states[offset + i] ?? 'no' }));
  const natural = result.natural || '';
  return {
    view: 'check',
    mistakes: withStates(result.mistakes, 0),
    suggestions: withStates(result.suggestions, result.mistakes.length),
    natural: showNatural || result.notEnglish ? natural : '',
    notEnglish: result.notEnglish,
    canUseFix: Boolean(natural) && (result.hold || result.suggestions.length > 0),
    ...(status ? { status } : {}),
  };
}

const panelMessage = (title, body) => ({ view: 'message', title, body });

// Hotkey mode: what the window shows after Alt+Enter. Nothing is held back; the user decides.
export function formatCheck(result, cfg, { words = 0 } = {}) {
  if (!result.hold && !result.suggestions.length) return '📝 English check: ✅ Looks good. Press Enter to send.';
  const lines = [result.hold ? '📝 English check' : '📝 English check: ✅ No mistakes. Optional ideas:'];
  for (const item of result.mistakes) lines.push(`• ${noteText(item)}`);
  for (const item of result.suggestions) lines.push(result.hold ? `◦ Optional: ${noteText(item)}` : `◦ ${noteText(item)}`);
  const showNatural = result.natural && cfg.rewrite !== 'never'
    && (cfg.rewrite === 'always' || words <= 120 || result.notEnglish);
  if (showNatural) lines.push(`✏️ ${result.notEnglish ? 'In English' : 'Natural version'}: ${result.natural}`);
  lines.push(result.hold
    ? 'Fix it in Claude or click "Use fixed version", then press Enter to send.'
    : 'Fine to send as it is: press Enter in Claude.');
  return lines.join('\n');
}

// Shown when a prompt had only suggestions: it went through, and this is a tip for next time.
export function formatTips(suggestions) {
  if (suggestions.length === 1) return `📝 English tip (your prompt was sent): ${noteText(suggestions[0])}`;
  return ['📝 English tips (your prompt was sent):', ...suggestions.map((s) => `◦ ${noteText(s)}`)].join('\n');
}

// PowerShell that puts a UTF-8 file's text on the clipboard, then deletes the file.
export function windowsClipboardScript(file) {
  const quoted = `'${file.replace(/'/g, "''")}'`;
  return `Set-Clipboard -Value ([IO.File]::ReadAllText(${quoted}, [Text.Encoding]::UTF8)); Remove-Item -LiteralPath ${quoted}`;
}

function copyToClipboard(text) {
  try {
    if (process.platform === 'win32') {
      const tmp = path.join(os.tmpdir(), `glint-clip-${process.pid}.txt`);
      fs.writeFileSync(tmp, text, 'utf8');
      // Detached, so the hook doesn't wait ~0.5 s for PowerShell to start.
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsClipboardScript(tmp)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return true;
    }
    const tool = process.platform === 'darwin' ? ['pbcopy'] : process.env.WAYLAND_DISPLAY ? ['wl-copy'] : ['xclip', '-selection', 'clipboard'];
    const child = spawn(tool[0], tool.slice(1), { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(text);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// The Glint window watches these files. It pops up (without taking focus) for feedback.txt,
// a held-back prompt, and shows tips.txt only if it's already open.
function writeWindowFile(name, prompt, message, natural) {
  try {
    fs.mkdirSync(WINDOW_DIR, { recursive: true });
    if (natural !== undefined) fs.writeFileSync(path.join(WINDOW_DIR, 'natural.txt'), natural || '');
    fs.writeFileSync(path.join(WINDOW_DIR, name), `Your prompt:\n${prompt.slice(0, 1500)}\n\n${message}`);
  } catch {
    // the window is optional
  }
}

function takeHeld(session) {
  const file = path.join(HELD_DIR, `${safeId(session)}.json`);
  try {
    const held = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.rmSync(file, { force: true });
    return held;
  } catch {
    return null;
  }
}

function hold(session, id) {
  fs.mkdirSync(HELD_DIR, { recursive: true });
  fs.writeFileSync(path.join(HELD_DIR, `${safeId(session)}.json`), JSON.stringify({ id, at: Date.now() }));
}

async function onPromptGate(input, cfg) {
  const text = String(input.prompt ?? '').trim();
  if (!text || isCommandOrEvent(text)) return null; // commands don't use up a held prompt's free resend

  const session = input.session_id || 'unknown';
  const held = takeHeld(session);
  if (held && Date.now() - held.at < RESEND_WINDOW_MS) {
    if (cfg.journal) appendJournal({ type: 'revision', ref: held.id, ts: new Date().toISOString(), prompt: text.slice(0, 2000) });
    return null; // the resend goes straight through
  }
  if (!shouldCheck(text, cfg)) return null;

  let result;
  try {
    const answer = await runClaude(checkSpec(cfg), `<prompt>\n${proseForCheck(text)}\n</prompt>`, { timeoutMs: CHECK_TIMEOUT_MS });
    if (answer.isError) throw new Error(answer.text);
    result = normalizeCheck(answer.structured ?? parseJsonLoose(answer.text), cfg.level);
  } catch (err) {
    return { systemMessage: `📝 English check skipped: ${friendlyError(err)}` };
  }

  const id = crypto.randomUUID();
  if (cfg.journal) {
    appendJournal({
      type: 'check',
      id,
      ts: new Date().toISOString(),
      session: input.session_id,
      project: input.cwd ? path.basename(input.cwd) : undefined,
      mode: 'gate',
      prompt: text.slice(0, 2000),
      clean: !result.hold,
      notes: result.mistakes.map(noteText),
      tips: result.suggestions.map(noteText),
      rewrite: result.natural,
    });
  }

  if (!result.hold) {
    if (!result.suggestions.length) return null;
    const tips = formatTips(result.suggestions);
    writeWindowFile('tips.txt', text, tips);
    return { systemMessage: tips };
  }

  hold(session, id);
  const copied = cfg.copyOnBlock && copyToClipboard(text);
  const message = formatHeld(result, cfg, { copied, words: proseWordCount(text) });
  writeWindowFile('feedback.txt', text, message, result.natural);
  return { block: message, suppressOriginalPrompt: copied };
}

// ---------- inline mode ----------

export function buildInstructions(cfg) {
  const template = fs.readFileSync(path.join(PROMPTS_DIR, 'coach-instructions.md'), 'utf8');
  return fill(template, {
    POSITION_RULE: POSITION_RULES[cfg.position] ?? POSITION_RULES.start,
    LEVEL_RULE: LEVEL_RULES[cfg.level] ?? LEVEL_RULES.normal,
    REWRITE_RULE: REWRITE_RULES[cfg.rewrite] ?? REWRITE_RULES.auto,
    MAX_ITEMS: String(cfg.maxItems),
  });
}

function pendingFile(sessionId) {
  return path.join(PENDING_DIR, `${safeId(sessionId)}.json`);
}

function onPromptInline(input, cfg) {
  if (!shouldCheck(input.prompt, cfg)) return null;
  if (cfg.journal && input.session_id) {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    fs.writeFileSync(pendingFile(input.session_id), JSON.stringify({ ts: new Date().toISOString(), cwd: input.cwd, prompt: input.prompt }));
  }
  return { context: buildInstructions(cfg) };
}

// ---------- hotkey mode ----------

function wordSet(text) {
  return new Set(String(text).toLowerCase().match(/[a-z0-9']+|[㐀-鿿]/g) ?? []);
}

// How alike two texts are, 0..1, by shared words (Jaccard). A message sent after fixing a few words
// scores about 0.5; an unrelated prompt scores near 0.
export function similarity(a, b) {
  const A = wordSet(a);
  const B = wordSet(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

// The hook shows nothing in this mode. When the user sends the message they checked, the check is
// closed and what they sent is saved as its revision, so /glint:review can see whether they
// fixed their mistakes. Other prompts (another session, or a tool driving Claude Code) look nothing
// like the draft and leave the check alone, so its Apply links keep working.
function onPromptHotkey(input, cfg) {
  const text = String(input.prompt ?? '').trim();
  if (!text || isCommandOrEvent(text)) return null;
  let last;
  try {
    last = JSON.parse(fs.readFileSync(LAST_CHECK_FILE, 'utf8'));
  } catch {
    return null;
  }
  if (Date.now() - last.at > REVISION_WINDOW_MS) {
    fs.rmSync(LAST_CHECK_FILE, { force: true }); // too old to be about this prompt
    return null;
  }
  if (similarity(last.draft ?? '', text) < 0.3) return null;
  fs.rmSync(LAST_CHECK_FILE, { force: true });
  if (cfg.journal && last.id) {
    appendJournal({ type: 'revision', ref: last.id, ts: new Date().toISOString(), prompt: text.slice(0, 2000) });
  }
  return null;
}

async function onPrompt(input) {
  if (process.env.GLINT_CHILD) return null;
  const cfg = loadConfig();
  if (!cfg.enabled) return null;
  if (cfg.mode === 'inline') return onPromptInline(input, cfg);
  if (cfg.mode === 'gate') return onPromptGate(input, cfg);
  return onPromptHotkey(input, cfg);
}

// ---------- stop hook (inline mode) ----------

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
}

// Assistant text written at or after `sinceIso`, oldest first.
export function assistantTextsSince(transcriptPath, sinceIso) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }
  const since = Date.parse(sinceIso) || 0;
  const texts = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant' || entry.isSidechain) continue;
    if (entry.timestamp && Date.parse(entry.timestamp) < since) continue;
    const text = textOf(entry.message?.content);
    if (text) texts.push(text);
  }
  return texts;
}

// Pull the "📝 English check" block out of a reply. Returns null if there isn't one.
export function parseFeedback(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => HEADER_RE.test(l));
  if (start < 0) return null;

  const quoted = /^\s*>/.test(lines[start]);
  const block = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (i > start && (!line.trim() || (quoted && !/^\s*>/.test(line)))) break;
    block.push(line.replace(/^\s*>\s?/, '').trim());
  }

  const header = block[0];
  const notes = [];
  let rewrite = '';
  for (const line of block.slice(1)) {
    const m = line.match(/^(?:✏️|✏)?\s*\**Natural version:?\**:?\s*(.+)$/i);
    if (m) rewrite = m[1].trim();
    else if (/^[-*•]\s+/.test(line)) notes.push(line.replace(/^[-*•]\s+/, ''));
  }
  return { clean: notes.length === 0 && /✅/.test(header), notes, rewrite };
}

function onStop(input) {
  if (process.env.GLINT_CHILD) return;
  const file = pendingFile(input.session_id);
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return; // nothing was checked this turn, or it was already logged
  }

  const texts = assistantTextsSince(input.transcript_path, pending.ts);
  if (input.last_assistant_message) texts.push(input.last_assistant_message);
  const feedback = texts.map(parseFeedback).find(Boolean);
  if (!feedback && input.stop_hook_active) return; // another Stop hook is continuing the turn; try again later

  fs.rmSync(file, { force: true });
  if (!feedback) return;

  appendJournal({
    type: 'check',
    ts: pending.ts,
    session: input.session_id,
    project: pending.cwd ? path.basename(pending.cwd) : undefined,
    mode: 'inline',
    prompt: String(pending.prompt).slice(0, 2000),
    ...feedback,
  });
}

// ---------- CLI ----------

function readJournal() {
  try {
    return fs.readFileSync(JOURNAL_FILE, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

const isCheck = (e) => !e.type || e.type === 'check';

function printConfig(cfg) {
  console.log(`Glint is ${cfg.enabled ? 'ON' : 'OFF'}.`);
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'enabled') continue;
    const options = CHOICES[k] ? `  (${CHOICES[k].join(' | ')})` : '';
    console.log(`  ${k.padEnd(11)} ${String(v).padEnd(17)}${options}`);
  }
  const checks = readJournal().filter(isCheck);
  console.log(`Journal: ${checks.length} checked prompts, ${checks.filter((e) => e.clean).length} with no issues.`);
  console.log(`Data folder: ${HOME}`);
}

function cmdConfig(args) {
  const cfg = loadConfig();
  // Accept both `config level strict` and `config "level strict"` (the skill passes one quoted string).
  const [first, second] = args.join(' ').trim().split(/\s+/).filter(Boolean);
  const firstLower = first?.toLowerCase();
  if (!first || firstLower === 'status') return printConfig(cfg);
  if (firstLower === 'reset') {
    saveConfig({ ...DEFAULTS });
    console.log('Settings reset to defaults.');
    return printConfig(loadConfig());
  }
  if (firstLower === 'on' || firstLower === 'off') {
    cfg.enabled = firstLower === 'on';
  } else if (second === undefined && Object.values(CHOICES).some((opts) => opts.includes(firstLower))) {
    // Shorthand: "config strict" = "config level strict". Each choice value belongs to one setting.
    const [key] = Object.entries(CHOICES).find(([, opts]) => opts.includes(firstLower));
    cfg[key] = firstLower;
  } else {
    const key = Object.keys(DEFAULTS).find((k) => k.toLowerCase() === firstLower) ?? first;
    cfg[key] = parseValue(key, second);
  }
  saveConfig(cfg);
  console.log('Saved.');
  printConfig(cfg);
}

function oneLine(text, max) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cmdJournal(args) {
  const limit = Math.max(1, Number(args[0]) || 40);
  const entries = readJournal();
  const checks = entries.filter(isCheck);
  const lookups = entries.filter((e) => e.type === 'lookup');
  const revisions = new Map(entries.filter((e) => e.type === 'revision').map((e) => [e.ref, e]));
  if (!checks.length && !lookups.length) {
    console.log('The journal is empty. Feedback is saved here after Glint checks your prompts.');
    return;
  }
  const recent = checks.slice(-limit);
  const clean = checks.filter((e) => e.clean).length;
  console.log(`# Glint journal: last ${recent.length} of ${checks.length} checked prompts (${clean} had no issues)\n`);
  for (const e of recent) {
    const when = String(e.ts).slice(0, 16).replace('T', ' ');
    console.log(`## ${when}${e.project ? ` · ${e.project}` : ''}${e.clean ? ' · ✅ clean' : ''}`);
    console.log(`Prompt: ${oneLine(e.prompt, 400)}`);
    for (const n of e.notes ?? []) console.log(`- ${n}`);
    for (const t of e.tips ?? []) console.log(`- (tip) ${t}`);
    if (e.rewrite) console.log(`Natural version: ${e.rewrite}`);
    const revision = e.id && revisions.get(e.id);
    if (revision) console.log(`They then sent: ${oneLine(revision.prompt, 400)}`);
    console.log('');
  }
  if (lookups.length) {
    const recentLookups = lookups.slice(-limit);
    console.log(`# Phrases they looked up: last ${recentLookups.length} of ${lookups.length}\n`);
    for (const l of recentLookups) {
      console.log(`- ${String(l.ts).slice(0, 16).replace('T', ' ')}: ${oneLine(l.question, 200)}`);
      console.log(`  Answer: ${oneLine(l.answer, 300)}`);
    }
  }
}

// `--in file --out file [--theme light|dark]` (the window) or plain words (a terminal).
function parseFileArgs(args) {
  const opts = { rest: [], theme: 'light' };
  for (let i = 0; i < args.length; i++) {
    if (['--in', '--out', '--theme'].includes(args[i])) opts[args[i].slice(2)] = args[++i];
    else opts.rest.push(args[i]);
  }
  return opts;
}

// Check a draft without sending anything (Alt+Enter in the window). With --out, writes the message to
// <out>, rich text for the window to <out>.rtf, the natural version to <out>.natural, then an empty
// <out>.done.
async function cmdCheck(args) {
  const opts = parseFileArgs(args);
  const text = (opts.in ? fs.readFileSync(opts.in, 'utf8') : opts.rest.join(' ')).trim();
  const cfg = loadConfig();
  const { theme } = opts;
  let message;
  let rtf;
  let natural = '';
  let panel;
  if (!text) {
    message = 'Nothing to check. Type your message in Claude first, then press Alt+Enter.';
    rtf = messageRtf('Nothing to check', 'Type your message in Claude first, then press Alt+Enter.', { theme });
    panel = panelMessage('Nothing to check', 'Type your message in Claude first, then press Alt+Enter.');
  } else if (text.length > 8000) {
    message = "That's a lot of text, so the message box probably wasn't focused. Click into Claude's message box, then press Alt+Enter.";
    rtf = messageRtf("That's a lot of text", "The message box probably wasn't focused. Click into Claude's message box, then press Alt+Enter.", { theme });
    panel = panelMessage("That's a lot of text", "The message box probably wasn't focused. Click into Claude's message box, then press Alt+Enter.");
  } else {
    try {
      const answer = await runClaude(checkSpec(cfg), `<prompt>\n${proseForCheck(text)}\n</prompt>`, { timeoutMs: CHECK_TIMEOUT_MS });
      if (answer.isError) throw new Error(answer.text);
      const result = normalizeCheck(answer.structured ?? parseJsonLoose(answer.text), cfg.level);
      const words = proseWordCount(text);
      message = formatCheck(result, cfg, { words });
      const showNatural = cfg.rewrite !== 'never' && (cfg.rewrite === 'always' || words <= 120);
      const states = applyStates(result, text);
      rtf = checkRtf(result, { theme, showNatural, states });
      panel = panelCheck(result, states, { showNatural });
      if (result.hold || result.suggestions.length) natural = result.natural;
      const id = cfg.journal ? crypto.randomUUID() : null;
      if (cfg.journal) {
        appendJournal({
          type: 'check',
          id,
          ts: new Date().toISOString(),
          mode: 'hotkey',
          prompt: text.slice(0, 2000),
          clean: !result.hold,
          notes: result.mistakes.map(noteText),
          tips: result.suggestions.map(noteText),
          rewrite: result.natural,
        });
      }
      // Kept for the "Apply" links and for linking the check to what is then sent.
      fs.mkdirSync(WINDOW_DIR, { recursive: true });
      fs.writeFileSync(LAST_CHECK_FILE, JSON.stringify({ id, at: Date.now(), draft: text, result, showNatural, applied: [] }));
    } catch (err) {
      message = `📝 English check failed: ${friendlyError(err)}`;
      rtf = messageRtf('The check failed', friendlyError(err), { theme });
      panel = panelMessage('The check failed', friendlyError(err));
    }
  }
  if (!opts.out) {
    console.log(message);
    return;
  }
  fs.writeFileSync(opts.out, message);
  fs.writeFileSync(`${opts.out}.rtf`, rtf);
  fs.writeFileSync(`${opts.out}.json`, JSON.stringify(panel));
  fs.writeFileSync(`${opts.out}.natural`, natural);
  fs.writeFileSync(`${opts.out}.done`, '');
}

// Apply fix number N (its Apply link or button) from the last check to the draft in --in.
// Writes the new draft to <out> (only if it worked), the updated view to <out>.rtf (old window)
// and <out>.json (panel), and "ok" or "fail" plus a message for the status line to <out>.status.
function cmdApply(args) {
  const opts = parseFileArgs(args);
  const index = Number(opts.rest[opts.rest.indexOf('--index') + 1] ?? opts.rest[0]);
  const status = (ok, message) => fs.writeFileSync(`${opts.out}.status`, `${ok ? 'ok' : 'fail'}\n${message}`);
  let last;
  try {
    last = JSON.parse(fs.readFileSync(LAST_CHECK_FILE, 'utf8'));
  } catch {
    fs.writeFileSync(`${opts.out}.json`, JSON.stringify(panelMessage('Nothing to apply yet', 'Press Alt+Enter in Claude to check your message first.')));
    return status(false, 'Nothing to apply yet. Press Alt+Enter in Claude to check your message.');
  }
  // Redraw the check with each fix's state for `draft`, and say what happened.
  const respond = (ok, message, draft) => {
    const states = applyStates(last.result, draft, last.applied);
    fs.writeFileSync(`${opts.out}.rtf`, checkRtf(last.result, { theme: opts.theme, showNatural: last.showNatural, states }));
    fs.writeFileSync(`${opts.out}.json`, JSON.stringify(panelCheck(last.result, states, { showNatural: last.showNatural, status: message })));
    status(ok, message);
  };
  const items = allItems(last.result);
  const item = items[index - 1];
  if (!item) return respond(false, `There's no fix number ${index}.`, last.draft);
  const draft = opts.in ? fs.readFileSync(opts.in, 'utf8') : '';
  if (!draft.trim()) return respond(false, "Couldn't read your message in Claude. Click into its message box and try again.", last.draft);

  const { text, found } = applyFix(draft, currentOriginal(items, index - 1, last.applied ?? []), item.better);
  if (!found) {
    return respond(false, contains(draft, item.better)
      ? `Fix ${index} is already in your message.`
      : `"${item.original}" isn't in your message any more, so fix ${index} can't be applied.`, draft);
  }
  last.applied = [...new Set([...(last.applied ?? []), index])];
  last.draft = text;
  fs.writeFileSync(LAST_CHECK_FILE, JSON.stringify(last));
  fs.writeFileSync(opts.out, text);
  respond(true, `Applied fix ${index}. Ctrl+Z in Claude undoes it.`, text);
}

// Start the helper (if needed) with a check ready, so the next Alt+Enter is quick.
async function cmdWarm() {
  const spec = checkSpec(loadConfig());
  try {
    await askDaemon({ type: 'warm', spec }, { timeoutMs: 3000 });
  } catch (err) {
    if (err.code === 'NO_DAEMON') startDaemon(spec);
  }
}

async function cmdAsk(args) {
  const opts = parseFileArgs(args);
  const question = (opts.in ? fs.readFileSync(opts.in, 'utf8') : opts.rest.join(' ')).trim();
  if (!question) {
    console.log('Usage: glint.mjs ask <question>   e.g. glint.mjs ask how to say "can or not" politely');
    return;
  }
  const cfg = loadConfig();
  let text = '';
  const save = (streaming = true) => {
    if (!opts.out) return;
    fs.writeFileSync(`${opts.out}.rtf`, lookupRtf(question, text, { theme: opts.theme }));
    fs.writeFileSync(`${opts.out}.json`, JSON.stringify({ view: 'lookup', question, answer: text, streaming }));
    fs.writeFileSync(opts.out, text);
  };
  try {
    const answer = await runClaude(askSpec(cfg), question, {
      timeoutMs: 60000,
      onDelta: (delta) => {
        text += delta;
        if (opts.out) save();
        else process.stdout.write(delta);
      },
    });
    if (answer.isError) throw new Error(answer.text);
    if (!text && answer.text) {
      text = answer.text;
      if (!opts.out) process.stdout.write(text);
    }
    if (cfg.journal) appendJournal({ type: 'lookup', ts: new Date().toISOString(), question: question.slice(0, 1000), answer: text.slice(0, 2000) });
  } catch (err) {
    const message = `Sorry, the lookup failed: ${friendlyError(err)}`;
    text = text ? `${text}\n\n${message}` : message;
    if (!opts.out) process.stdout.write(message);
  }
  if (opts.out) {
    save(false);
    fs.writeFileSync(`${opts.out}.done`, '');
  } else {
    process.stdout.write('\n');
  }
}

async function cmdDaemon(args) {
  if (args[0] === 'stop' || args[0] === 'status') {
    try {
      const reply = await askDaemon({ type: args[0] === 'stop' ? 'shutdown' : 'status' }, { timeoutMs: 3000 });
      console.log(args[0] === 'stop'
        ? 'Helper stopped.'
        : `Helper running (pid ${reply.pid}), ${reply.warm} warm Claude process(es), idle for ${reply.idleSeconds} s.`);
    } catch {
      console.log('Helper is not running. It starts by itself on the next check or lookup.');
    }
    return;
  }
  const { runDaemon } = await import('./daemon.mjs');
  runDaemon(args[0]);
}

function readStdinJson() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

// Write everything out before exiting: an early exit can cut off piped output on Windows.
function finish(code, stdout = '', stderr = '') {
  let pending = 0;
  const done = () => --pending <= 0 && process.exit(code);
  for (const [stream, data] of [[process.stdout, stdout], [process.stderr, stderr]]) {
    if (data) {
      pending++;
      stream.write(data, done);
    }
  }
  if (!pending) process.exit(code);
}

async function runPromptHook() {
  setTimeout(() => process.exit(0), 55 * 1000).unref(); // never outlive the hook's timeout: let the prompt through
  let result = null;
  try {
    result = await onPrompt(readStdinJson());
  } catch (err) {
    process.stderr.write(`glint: ${err?.message ?? err}\n`);
  }
  if (result?.block) {
    // JSON for the reason and suppressOriginalPrompt, plus exit 2 so the block can't race the prompt.
    const json = { decision: 'block', reason: result.block, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: Boolean(result.suppressOriginalPrompt) } };
    return finish(2, JSON.stringify(json), result.block);
  }
  if (result?.context) {
    return finish(0, JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: result.context } }));
  }
  if (result?.systemMessage) return finish(0, JSON.stringify({ systemMessage: result.systemMessage }));
  finish(0);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'prompt') return runPromptHook();
  if (cmd === 'stop') {
    try {
      onStop(readStdinJson());
    } catch (err) {
      process.stderr.write(`glint: ${err?.message ?? err}\n`);
    }
    return finish(0);
  }
  try {
    if (cmd === 'config') return cmdConfig(args);
    if (cmd === 'journal') return cmdJournal(args);
    if (cmd === 'ask') return await cmdAsk(args);
    if (cmd === 'check') return await cmdCheck(args);
    if (cmd === 'apply') return cmdApply(args);
    if (cmd === 'warm') return await cmdWarm();
    if (cmd === 'daemon') return await cmdDaemon(args);
    console.log('Usage: glint.mjs <prompt|stop|check|ask|warm|config|journal|daemon> [args]');
  } catch (err) {
    // stdout + exit 0 on purpose: skills run this through !`...`, which discards the output of failed commands.
    console.log(`Error: ${err?.message ?? err}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
