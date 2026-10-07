// Run with: node --test plugins/glint/tests/glint.test.mjs
// Gate-mode tests use fake-claude.mjs instead of the real Claude CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyFix, formatHeld, normalizeCheck, parseFeedback, proseForCheck, shouldCheck, similarity, stripNonProse } from '../scripts/glint.mjs';
import { cfHtml, commandChips, draftToHtml, editDraftHtml, fragmentFromCfHtml, parseDraftHtml } from '../scripts/richtext.mjs';
import { checkRtf, rtfEscape } from '../scripts/rtf.mjs';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(TESTS, '..', 'scripts', 'glint.mjs');
const FAKE_CLAUDE = path.join(TESTS, 'fake-claude.mjs');
const CFG = { enabled: true, minWords: 3 };

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glint-'));
}

function env(home, extra = {}) {
  return {
    ...process.env,
    GLINT_HOME: home,
    GLINT_CLAUDE: FAKE_CLAUDE,
    GLINT_NO_DAEMON: '1',
    GLINT_KEYS: 'windows', // the same key names on every platform
    FAKE_CLAUDE_LOG: path.join(home, 'fake-claude.log'),
    ...extra,
  };
}

function run(args, { input = '', home, extraEnv }) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8', env: env(home, extraEnv) });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function promptHook(home, prompt, { session = 's1', extraEnv } = {}) {
  return run(['prompt'], { home, extraEnv, input: JSON.stringify({ session_id: session, cwd: '/work/my-app', prompt }) });
}

function journal(home) {
  try {
    return fs.readFileSync(path.join(home, 'journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function claudeLaunches(home) {
  try {
    return fs.readFileSync(path.join(home, 'fake-claude.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// A gate-mode home with the clipboard copy off, so tests never touch the real clipboard.
function gateHome() {
  const home = tempHome();
  run(['config', 'gate'], { home });
  run(['config', 'copyOnBlock', 'off'], { home });
  return home;
}

// What the window does on Alt+Enter: `check --in draft --out result`.
function windowCheck(home, draft) {
  const inFile = path.join(home, 'draft.txt');
  const out = path.join(home, 'result.txt');
  fs.writeFileSync(inFile, draft);
  const r = run(['check', '--in', inFile, '--out', out], { home });
  return {
    code: r.code,
    message: fs.readFileSync(out, 'utf8'),
    natural: fs.readFileSync(`${out}.natural`, 'utf8'),
    done: fs.existsSync(`${out}.done`),
  };
}

function inlineHome() {
  const home = tempHome();
  run(['config', 'inline'], { home });
  return home;
}

// ---------- which prompts get checked ----------

test('checks normal prose prompts', () => {
  assert.equal(shouldCheck('plz help me check why the build got error', CFG), true);
});

test('skips slash commands, shell mode, and the * opt-out prefix', () => {
  for (const p of ['/glint:review', '!git status', '* just do it the same way as before']) {
    assert.equal(shouldCheck(p, CFG), false, p);
  }
});

test('skips harness-generated events like background task notifications', () => {
  const p = '<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n<summary>Agent finished the research task</summary>\n</task-notification>';
  assert.equal(shouldCheck(p, CFG), false);
});

test('still checks a question that follows pasted content', () => {
  assert.equal(shouldCheck('<pasted_content id="1">\nError: ENOENT\n</pasted_content id="1">\nwhy this error happen ah', CFG), true);
});

test('skips short replies and prompts that are only code', () => {
  assert.equal(shouldCheck('ok continue', CFG), false);
  assert.equal(shouldCheck('```js\nconst a = 1; let b = a + 2; console.log(b)\n```', CFG), false);
});

test('does not count pasted content (including the closing tag with an id), code, or quotes as prose', () => {
  const text = 'fix\n<pasted_content id="x">\nlots of words in a stack trace here\n</pasted_content id="x">\n`some code here`\n> quoted words from docs';
  assert.equal(stripNonProse(text).match(/[a-z]+/gi).join(' '), 'fix');
});

test('the gate check sees placeholders instead of pasted text and code', () => {
  const text = 'why this fail?\n<pasted_content id="1">\nstack trace\n</pasted_content id="1">\n```\ncode\n```';
  assert.equal(proseForCheck(text), 'why this fail?\n[pasted text]\n[code]');
});

test('counts Chinese characters so mixed-language prompts get checked', () => {
  assert.equal(shouldCheck('帮我看看这个问题', CFG), true);
});

test('does nothing when disabled', () => {
  assert.equal(shouldCheck('please review my pull request', { ...CFG, enabled: false }), false);
});

// ---------- hotkey mode (the default) ----------

test('hotkey: by default the hook shows nothing in the session and never calls Claude', () => {
  const home = tempHome();
  const r = promptHook(home, 'can help me check why the api got error');
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.equal(r.err, '');
  assert.equal(claudeLaunches(home).length, 0);
});

test('hotkey: Alt+Enter check writes the suggestions, the fixed version, and a done marker', () => {
  const home = tempHome();
  const r = windowCheck(home, 'the build got error, what to do next?');
  assert.equal(r.code, 0);
  assert.ok(r.done);
  assert.match(r.message, /^📝 English check\n• "got error" → "throws an error"/);
  assert.match(r.message, /◦ Optional: "what to do next\?" → "what should I do next\?"/);
  assert.match(r.message, /✏️ Natural version: Why does the API throw an error\?/);
  assert.match(r.message, /Fix it in Claude or click "Use fixed version", then press Enter to send\.$/);
  assert.equal(r.natural, 'Why does the API throw an error?');
  const [entry] = journal(home);
  assert.equal(entry.mode, 'hotkey');
  assert.equal(entry.clean, false);
});

test('hotkey: what you send after a check is saved as its revision, once', () => {
  const home = tempHome();
  windowCheck(home, 'the build got error');
  promptHook(home, '/glint:review'); // commands don't count
  assert.equal(promptHook(home, 'The build throws an error.').out, '');
  promptHook(home, 'An unrelated later prompt.');
  const [check, revision, ...rest] = journal(home);
  assert.equal(revision.type, 'revision');
  assert.equal(revision.ref, check.id);
  assert.equal(revision.prompt, 'The build throws an error.');
  assert.equal(rest.length, 0, 'only the first prompt after a check is its revision');
});

test('hotkey: prompts from other sessions or tools leave the check open, so Apply still works (a real case)', () => {
  const home = tempHome();
  const draft = 'and I want a entirely frosted glass effect not only applied on head and foot';
  const result = {
    mistakes: [
      { original: 'a entirely', better: 'an entirely', reason: "Use 'an' before vowel sounds." },
      { original: 'not only applied on head and foot', better: 'not only applied to the header and footer', reason: "'Applied to'." },
    ],
    suggestions: [
      { original: 'I want a entirely frosted glass effect not only applied on head and foot', better: 'I want the frosted glass effect applied to the entire page, not only the header and footer', reason: 'Clearer.' },
    ],
    natural: 'x',
    notEnglish: false,
  };
  fs.mkdirSync(path.join(home, 'window'), { recursive: true });
  fs.writeFileSync(path.join(home, 'window', 'last-check.json'), JSON.stringify({ id: 'c1', at: Date.now(), draft, result, showNatural: true, applied: [] }));

  let current = draft;
  let calls = 0;
  const apply = (n) => {
    fs.writeFileSync(path.join(home, 'current.txt'), current);
    const out = path.join(home, `out-${++calls}.txt`);
    run(['apply', '--index', String(n), '--in', path.join(home, 'current.txt'), '--out', out], { home });
    const [state, message] = fs.readFileSync(`${out}.status`, 'utf8').split('\n');
    if (state === 'ok') current = fs.readFileSync(out, 'utf8');
    return { state, message };
  };

  assert.equal(apply(1).state, 'ok');
  // Another Claude Code session sends a JSON prompt 9 s later (this happened for real).
  promptHook(home, '{"items":[{"i":0,"object":{"kind":"stock","name":"MSFT"},"source":"xhs"}]}', { session: 'other' });
  promptHook(home, 'Summarise the latest earnings call for me please', { session: 'other' });
  const second = apply(2);
  assert.equal(second.state, 'ok', second.message);
  assert.equal(current, 'and I want an entirely frosted glass effect not only applied to the header and footer');
  assert.deepEqual(journal(home), [], 'no bogus revision recorded');

  // Sending the checked message closes the check and records the revision.
  promptHook(home, current);
  assert.equal(journal(home)[0].type, 'revision');
  assert.match(apply(3).message, /Nothing to apply yet/);
});

test('similarity: a fixed message is close to its draft; other prompts are not', () => {
  assert.ok(similarity('the build got error, what to do next?', 'The build throws an error. What should I do next?') >= 0.3);
  assert.ok(similarity('and I want a entirely frosted glass effect', 'I want the frosted glass effect applied to the entire page') >= 0.3);
  assert.ok(similarity('and I want a entirely frosted glass effect', '{"items":[{"kind":"stock","name":"MSFT"}]}') < 0.1);
  assert.equal(similarity('', 'anything'), 0);
});

test('gate and inline modes skip JSON prompts from tools driving Claude Code', () => {
  assert.equal(shouldCheck('{"items":[{"kind":"stock","name":"Microsoft","note":"buy the dip"}]}', CFG), false);
  assert.equal(shouldCheck('[{"task":"summarise the latest news about this company"}]', CFG), false);
});

test('hotkey: clean drafts, style-only drafts, and empty drafts', () => {
  const home = tempHome();
  const clean = windowCheck(home, 'Please add unit tests for the date parser.');
  assert.equal(clean.message, '📝 English check: ✅ Looks good. Press Enter to send.');
  assert.equal(clean.natural, '');

  const styleOnly = windowCheck(home, 'I have run both commands, what to do next?');
  assert.match(styleOnly.message, /^📝 English check: ✅ No mistakes\. Optional ideas:\n◦ "what to do next\?"/);
  assert.match(styleOnly.message, /Fine to send as it is: press Enter in Claude\.$/);
  assert.notEqual(styleOnly.natural, '', 'the improved version is still offered');

  assert.match(windowCheck(home, '   ').message, /Nothing to check/);
  assert.match(windowCheck(home, 'x'.repeat(9000)).message, /message box probably wasn't focused/);
});

test('rtf: text is escaped to plain ASCII, including Chinese and emoji', () => {
  assert.equal(rtfEscape('a{b}\\c\nd'), 'a\\{b\\}\\\\c\\line d');
  assert.equal(rtfEscape('帮'), '\\u24110?');
  assert.equal(rtfEscape('→'), '\\u8594?');
  assert.equal(rtfEscape('�'), '\\u-3?', 'values above 32767 are written as negative numbers');
  assert.equal(rtfEscape('📝'), '\\u-10179?\\u-8995?', 'emoji become a surrogate pair (U+1F4DD = D83D DCDD)');
  const rtf = checkRtf(normalizeCheck({ mistakes: [{ original: '帮 got error', better: 'throws an error', reason: 'no "got"' }] }), { theme: 'light' });
  assert.ok(/^[\x00-\x7f]*$/.test(rtf), 'the whole document is ASCII');
});

test('rtf: a check shows mistakes struck through in red and fixes in green, in either theme', () => {
  const result = normalizeCheck({
    english: true,
    mistakes: [{ original: 'have ran', better: 'have run', reason: 'past participle' }],
    suggestions: [{ original: 'what to do next?', better: 'what should I do next?', reason: 'more natural' }],
    natural: 'I have run both commands. What should I do next?',
  });
  const light = checkRtf(result, { theme: 'light' });
  assert.match(light, /^\{\\rtf1/);
  assert.match(light, /1 thing to fix/);
  assert.match(light, /\{\\cf3\\f0\\strike have ran\}/, 'original: red, struck through');
  assert.match(light, /\{\\cf4\\f1 have run\}/, 'fix: green, semibold');
  assert.match(light, /OPTIONAL IDEAS/);
  assert.match(light, /\{\\cf6\\f1 what should I do next\?\}/, 'optional idea: amber');
  assert.match(light, /NATURAL VERSION/);
  assert.match(light, /\\red196\\green43\\blue28;/, 'light red');
  assert.match(checkRtf(result, { theme: 'dark' }), /\\red255\\green153\\blue164;/, 'dark red');
  assert.doesNotMatch(checkRtf(result, { theme: 'light', showNatural: false }), /NATURAL VERSION/);
  assert.match(checkRtf(normalizeCheck({ english: true, mistakes: [], suggestions: [] })), /Looks good/);
});

test('hotkey: the window gets rich text for checks and lookups', () => {
  const home = tempHome();
  windowCheck(home, 'the build got error');
  const rtf = fs.readFileSync(path.join(home, 'result.txt.rtf'), 'utf8');
  assert.match(rtf, /\{\\cf3\\f0\\strike got error\}/);

  const q = path.join(home, 'q.txt');
  const a = path.join(home, 'a.txt');
  fs.writeFileSync(q, 'meaning of nitpick');
  run(['ask', '--in', q, '--out', a, '--theme', 'dark'], { home });
  const lookup = fs.readFileSync(`${a}.rtf`, 'utf8');
  assert.match(lookup, /meaning of nitpick/);
  assert.match(lookup, /Could you take a look\?/);
  assert.match(lookup, /\\red243\\green243\\blue243;/, 'dark text colour');
});

test('applyFix: replaces the first match, tolerating case, spacing and quote style', () => {
  assert.deepEqual(applyFix('I have ran the both commands.', 'have ran the both', 'have run both'),
    { text: 'I have run both commands.', found: true, index: 2, length: 17, replacement: 'have run both' }, 'and where, for the HTML edit');
  assert.equal(applyFix('Can help check the logs?', 'can help check', 'can you help me check').text,
    'Can you help me check the logs?', 'keeps the capital at the start of a sentence');
  assert.equal(applyFix('it got   error\nagain', 'got error again', 'fails again').text, 'it fails again', 'any spacing');
  assert.equal(applyFix('it’s done', "it's done", 'it is done').text, 'it is done', 'curly vs straight quotes');
  assert.equal(applyFix('a (b) c (b)', '(b)', '[b]').text, 'a [b] c (b)', 'regex characters are literal; first match only');
  assert.equal(applyFix('nothing here', 'got error', 'x').found, false);
  assert.equal(applyFix('anything', '', 'x').found, false);
});

test('rtf: fixes get an "Apply" link, an Applied mark, or nothing', () => {
  const result = normalizeCheck({
    english: true,
    mistakes: [{ original: 'a', better: 'b', reason: 'r1' }, { original: 'c', better: 'd', reason: 'r2' }],
    suggestions: [{ original: 'e', better: 'f', reason: 'r3' }],
  });
  const rtf = checkRtf(result, { states: ['applied', 'no', 'can'] });
  assert.doesNotMatch(rtf, /HYPERLINK "fix:1"/);
  assert.match(rtf, /\\u10003\?/, '✓ Applied for fix 1');
  assert.doesNotMatch(rtf, /HYPERLINK "fix:2"/, 'no link when the words are not in the draft');
  assert.match(rtf, /\{\\field\{\\\*\\fldinst\{HYPERLINK "fix:3"\}\}\{\\fldrslt\{\\cf5\\f0\\fs18 Apply\}\}\}/, 'suggestions are numbered after mistakes');
  assert.doesNotMatch(rtf, /Alt\+\d/, 'no number shortcuts (Alt+1 is the user\'s screenshot key)');
  assert.doesNotMatch(checkRtf(result), /HYPERLINK/, 'no links unless states are given');
});

test('hotkey: Apply replaces one phrase in the current draft and marks it applied', () => {
  const home = tempHome();
  const draft = 'the build got error, what to do next?';
  windowCheck(home, draft);
  const view = fs.readFileSync(path.join(home, 'result.txt.rtf'), 'utf8');
  assert.match(view, /HYPERLINK "fix:1"/);
  assert.match(view, /HYPERLINK "fix:2"/);

  let calls = 0;
  const apply = (n, current) => {
    const inFile = path.join(home, 'current.txt');
    const out = path.join(home, `applied-${++calls}.txt`);
    fs.writeFileSync(inFile, current);
    run(['apply', '--index', String(n), '--in', inFile, '--out', out], { home });
    const [state, message] = fs.readFileSync(`${out}.status`, 'utf8').split('\n');
    return { state, message, text: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null, rtf: fs.existsSync(`${out}.rtf`) ? fs.readFileSync(`${out}.rtf`, 'utf8') : '' };
  };

  // The user typed more after the check: their addition is kept.
  const first = apply(1, `${draft} thanks`);
  assert.equal(first.state, 'ok');
  assert.equal(first.text, 'the build throws an error, what to do next? thanks');
  assert.match(first.message, /Applied fix 1\. Ctrl\+Z in Claude undoes it\./);
  assert.doesNotMatch(first.rtf, /HYPERLINK "fix:1"/);
  assert.match(first.rtf, /HYPERLINK "fix:2"/, 'the other fix can still be applied');

  const again = apply(1, first.text);
  assert.equal(again.state, 'fail');
  assert.match(again.message, /Fix 1 is already in your message/);
  assert.equal(again.text, null, 'nothing to paste');

  const edited = apply(1, 'the build broke, what to do next?'); // the user rewrote those words themselves
  assert.match(edited.message, /"got error" isn't in your message any more/);

  assert.match(apply(9, first.text).message, /There's no fix number 9/);
  assert.match(apply(2, '').message, /Couldn't read your message/);

  promptHook(home, 'The build throws an error. What should I do next?'); // sending ends the check
  assert.match(apply(2, 'what to do next?').message, /Nothing to apply yet/);
});

test('hotkey: overlapping fixes keep their Apply links, in any order (a real check)', () => {
  const home = tempHome();
  const draft = 'give me a prompt about what you changes in the recent link test, cause the claude design already ouput one proto previously';
  const result = {
    mistakes: [
      { original: 'what you changes', better: 'what you changed', reason: 'past tense' },
      { original: 'cause the claude design already ouput one proto previously', better: 'because Claude Design already output a prototype earlier', reason: 'because; output' },
      { original: 'ouput one proto', better: 'output a prototype', reason: 'spelling; article' },
    ],
    suggestions: [
      { original: 'give me a prompt about what you changes in the recent link test', better: 'write me a prompt summarizing what you changed in the recent link test', reason: 'more natural' },
    ],
    natural: 'x',
    notEnglish: false,
  };
  fs.mkdirSync(path.join(home, 'window'), { recursive: true });
  fs.writeFileSync(path.join(home, 'window', 'last-check.json'), JSON.stringify({ id: null, at: Date.now(), draft, result, showNatural: true, applied: [] }));

  let current = draft;
  let calls = 0;
  const apply = (n) => {
    fs.writeFileSync(path.join(home, 'current.txt'), current);
    const out = path.join(home, `out-${++calls}.txt`);
    run(['apply', '--index', String(n), '--in', path.join(home, 'current.txt'), '--out', out], { home });
    const [state, message] = fs.readFileSync(`${out}.status`, 'utf8').split('\n');
    if (state === 'ok') current = fs.readFileSync(out, 'utf8');
    const rtf = fs.readFileSync(`${out}.rtf`, 'utf8');
    return { state, message, links: (rtf.match(/fix:\d/g) ?? []).join(' '), fixed: (rtf.match(/Already fixed/g) ?? []).length };
  };

  // Fix 1 first: the idea (fix 4) contains the same words, and must keep its link.
  const a = apply(1);
  assert.equal(a.state, 'ok');
  assert.equal(a.links, 'fix:2 fix:3 fix:4');
  // Fix 3 (inside fix 2's words) next: fix 2 must keep its link too.
  assert.equal(apply(3).links, 'fix:2 fix:4');
  assert.equal(apply(2).links, 'fix:4');
  assert.equal(apply(4).state, 'ok');
  assert.equal(current, 'write me a prompt summarizing what you changed in the recent link test, because Claude Design already output a prototype earlier');
});

test('hotkey: a fix covered by a bigger overlapping fix shows "Already fixed"', () => {
  const home = tempHome();
  const draft = 'claude design already ouput one proto previously';
  const result = {
    mistakes: [
      { original: 'already ouput one proto previously', better: 'already output a prototype earlier', reason: 'r' },
      { original: 'ouput one proto', better: 'output a prototype', reason: 'r' },
    ],
    suggestions: [],
    natural: 'x',
    notEnglish: false,
  };
  fs.mkdirSync(path.join(home, 'window'), { recursive: true });
  fs.writeFileSync(path.join(home, 'window', 'last-check.json'), JSON.stringify({ id: null, at: Date.now(), draft, result, showNatural: true, applied: [] }));
  fs.writeFileSync(path.join(home, 'current.txt'), draft);
  const out = path.join(home, 'out.txt');
  run(['apply', '--index', '1', '--in', path.join(home, 'current.txt'), '--out', out], { home });
  const rtf = fs.readFileSync(`${out}.rtf`, 'utf8');
  assert.doesNotMatch(rtf, /fix:2/);
  assert.match(rtf, /Already fixed/);
});

test('panel: check, apply and ask write the state that window.glint.render() takes', () => {
  const home = tempHome();
  windowCheck(home, 'the build got error, what to do next?');
  const check = JSON.parse(fs.readFileSync(path.join(home, 'result.txt.json'), 'utf8'));
  assert.equal(check.view, 'check');
  assert.deepEqual(check.mistakes, [{ original: 'got error', better: 'throws an error', reason: '"got" here is Singlish', state: 'can' }]);
  assert.equal(check.suggestions[0].state, 'can');
  assert.equal(check.natural, 'Why does the API throw an error?');
  assert.equal(check.notEnglish, false);
  assert.equal(check.canUseFix, true);

  fs.writeFileSync(path.join(home, 'current.txt'), 'the build got error, what to do next?');
  const out = path.join(home, 'applied.txt');
  run(['apply', '--index', '1', '--in', path.join(home, 'current.txt'), '--out', out], { home });
  const applied = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8'));
  assert.equal(applied.mistakes[0].state, 'applied');
  assert.equal(applied.suggestions[0].state, 'can');
  assert.equal(applied.status, 'Applied fix 1. Ctrl+Z in Claude undoes it.');

  const empty = path.join(home, 'empty.txt');
  fs.writeFileSync(path.join(home, 'blank.txt'), '  ');
  run(['check', '--in', path.join(home, 'blank.txt'), '--out', empty], { home });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${empty}.json`, 'utf8')), {
    view: 'message', title: 'Nothing to check', body: 'Type your message in Claude first, then press Alt+Enter.',
  });

  fs.writeFileSync(path.join(home, 'q.txt'), 'meaning of nitpick');
  run(['ask', '--in', path.join(home, 'q.txt'), '--out', path.join(home, 'a.txt')], { home });
  const lookup = JSON.parse(fs.readFileSync(path.join(home, 'a.txt.json'), 'utf8'));
  assert.equal(lookup.view, 'lookup');
  assert.equal(lookup.question, 'meaning of nitpick');
  assert.equal(lookup.streaming, false, 'the final write says the answer is complete');
  assert.match(lookup.answer, /Could you take a look\?/);
});

test('hotkey: check works from the terminal too', () => {
  const home = tempHome();
  assert.match(run(['check', 'the', 'build', 'got', 'error'], { home }).out, /• "got error" → "throws an error"/);
});

test('hotkey: the Mac panel gets Mac key names', () => {
  const home = tempHome();
  const mac = { GLINT_KEYS: 'mac' };
  fs.writeFileSync(path.join(home, 'blank.txt'), '');
  run(['check', '--in', path.join(home, 'blank.txt'), '--out', path.join(home, 'empty.txt')], { home, extraEnv: mac });
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'empty.txt.json'), 'utf8')).body, 'Type your message in Claude first, then press ⌘Enter.');

  fs.writeFileSync(path.join(home, 'draft.txt'), 'the build got error, what to do next?');
  run(['check', '--in', path.join(home, 'draft.txt'), '--out', path.join(home, 'result.txt')], { home, extraEnv: mac });
  const out = path.join(home, 'applied.txt');
  run(['apply', '--index', '1', '--in', path.join(home, 'draft.txt'), '--out', out], { home, extraEnv: mac });
  assert.equal(JSON.parse(fs.readFileSync(`${out}.json`, 'utf8')).status, 'Applied fix 1. ⌘Z in Claude undoes it.');
});

test('warm: starts the helper with a check ready', async () => {
  const home = tempHome();
  const helperEnv = { GLINT_NO_DAEMON: '' };
  try {
    run(['warm'], { home, extraEnv: helperEnv });
    let status = '';
    for (let i = 0; i < 50 && !/1 warm/.test(status); i++) {
      await new Promise((res) => setTimeout(res, 100));
      status = run(['daemon', 'status'], { home, extraEnv: helperEnv }).out;
    }
    assert.match(status, /Helper running .*1 warm Claude process/);
    run(['warm'], { home, extraEnv: helperEnv }); // a second warm-up reuses the same process
    assert.match(run(['daemon', 'status'], { home, extraEnv: helperEnv }).out, /1 warm Claude process/);
  } finally {
    run(['daemon', 'stop'], { home, extraEnv: helperEnv });
  }
});

// ---------- gate mode ----------

test('gate: a prompt with mistakes is held back with corrections (JSON block + exit 2)', () => {
  const home = gateHome();
  const r = promptHook(home, 'can help me check why the api got error');
  assert.equal(r.code, 2);
  const out = JSON.parse(r.out);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /📝 English check: not sent yet/);
  assert.match(out.reason, /• "got error" → "throws an error": "got" here is Singlish/);
  assert.match(out.reason, /✏️ Natural version: Why does the API throw an error\?/);
  assert.match(out.reason, /Send it again, edited or as-is/);
  assert.equal(out.hookSpecificOutput.suppressOriginalPrompt, false, 'keep "Original prompt:" when nothing was copied');
  assert.equal(r.err, out.reason, 'stderr carries the same message for the exit-2 path');
});

test('gate: the next prompt in the same session goes straight through, and is saved as the revision', () => {
  const home = gateHome();
  assert.equal(promptHook(home, 'can help me check why the api got error').code, 2);
  const resend = promptHook(home, 'Can you help me check why the API throws an error?');
  assert.equal(resend.code, 0);
  assert.equal(resend.out, '');
  assert.equal(claudeLaunches(home).length, 1, 'the resend was not checked again');

  const [check, revision] = journal(home);
  assert.equal(check.type, 'check');
  assert.equal(check.clean, false);
  assert.deepEqual(check.notes, ['"got error" → "throws an error": "got" here is Singlish']);
  assert.deepEqual(revision, { type: 'revision', ref: check.id, ts: revision.ts, prompt: 'Can you help me check why the API throws an error?' });

  const printed = run(['journal'], { home }).out;
  assert.match(printed, /They then sent: Can you help me check why the API throws an error\?/);
});

test('gate: a free resend belongs to its own session only', () => {
  const home = gateHome();
  promptHook(home, 'can help me check why the api got error', { session: 'a' });
  assert.equal(promptHook(home, 'and this one also got error in it', { session: 'b' }).code, 2);
});

test('gate: slash commands after a block do not use up the free resend', () => {
  const home = gateHome();
  promptHook(home, 'can help me check why the api got error');
  assert.equal(promptHook(home, '/glint:config status').code, 0);
  assert.equal(promptHook(home, 'still got error here, please check').code, 0, 'resend still free');
});

test('gate: a clean prompt goes through untouched and is recorded as clean', () => {
  const home = gateHome();
  const r = promptHook(home, 'Please add unit tests for the date parser.');
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.equal(journal(home)[0].clean, true);
});

test('gate: "*" skips the check without calling Claude', () => {
  const home = gateHome();
  assert.equal(promptHook(home, '* this one got error but just send it').code, 0);
  assert.equal(claudeLaunches(home).length, 0);
});

test('gate: Claude runs without the host session variables, and our hooks ignore its own prompts', () => {
  const home = gateHome();
  promptHook(home, 'Please add unit tests for the date parser.', { extraEnv: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'host' } });
  const [launch] = claudeLaunches(home);
  assert.deepEqual(launch.env, { CLAUDECODE: null, CLAUDE_CODE_SESSION_ID: null, GLINT_CHILD: '1' });
  assert.ok(launch.args.includes('--json-schema') && launch.args.includes('claude-sonnet-5-5'));

  const child = promptHook(home, 'this got error but it is our own child process', { extraEnv: { GLINT_CHILD: '1' } });
  assert.equal(child.out, '');
  assert.equal(claudeLaunches(home).length, 1);
});

test('gate: problems let the prompt through with a note (logged-out CLI, timeout)', () => {
  const home = gateHome();
  const loggedOut = promptHook(home, 'LOGIN please check this sentence for me');
  assert.equal(loggedOut.code, 0);
  assert.match(JSON.parse(loggedOut.out).systemMessage, /not logged in.*\/login/);

  const slow = promptHook(home, 'SLOW please check this sentence for me', { extraEnv: { GLINT_CHECK_TIMEOUT_MS: '500' } });
  assert.equal(slow.code, 0);
  assert.match(JSON.parse(slow.out).systemMessage, /English check skipped: no answer after/);
});

test('gate: the window feedback file gets the prompt and corrections', () => {
  const home = gateHome();
  promptHook(home, 'can help me check why the api got error');
  const feedback = fs.readFileSync(path.join(home, 'window', 'feedback.txt'), 'utf8');
  assert.match(feedback, /^Your prompt:\ncan help me check why the api got error\n\n📝 English check/);
  assert.equal(fs.readFileSync(path.join(home, 'window', 'natural.txt'), 'utf8'), 'Why does the API throw an error?');
});

test('gate: a prompt with only style suggestions goes through, with a tip', () => {
  const home = gateHome();
  const r = promptHook(home, 'I have run both commands, what to do next?');
  assert.equal(r.code, 0, 'not held back');
  assert.equal(JSON.parse(r.out).systemMessage,
    '📝 English tip (your prompt was sent): "what to do next?" → "what should I do next?": a bit more natural as a direct question');
  const [entry] = journal(home);
  assert.equal(entry.clean, true);
  assert.deepEqual(entry.notes, []);
  assert.deepEqual(entry.tips, ['"what to do next?" → "what should I do next?": a bit more natural as a direct question']);
  assert.match(run(['journal'], { home }).out, /- \(tip\) "what to do next\?"/);
  assert.match(fs.readFileSync(path.join(home, 'window', 'tips.txt'), 'utf8'), /English tip/);
  assert.equal(fs.existsSync(path.join(home, 'held')), false, 'no free resend needed');
});

test('gate: when a prompt is held back, suggestions show as optional', () => {
  const home = gateHome();
  const r = promptHook(home, 'the build got error, what to do next?');
  assert.equal(r.code, 2);
  const reason = JSON.parse(r.out).reason;
  assert.match(reason, /• "got error" → "throws an error"/);
  assert.match(reason, /◦ Optional: "what to do next\?" → "what should I do next\?"/);
});

test('gate: level strict holds back for suggestions too; level light ignores them', () => {
  const strict = gateHome();
  run(['config', 'strict'], { home: strict });
  assert.equal(promptHook(strict, 'I have run both commands, what to do next?').code, 2);

  const light = gateHome();
  run(['config', 'light'], { home: light });
  const r = promptHook(light, 'I have run both commands, what to do next?');
  assert.equal(r.code, 0);
  assert.equal(r.out, '', 'no tip either');
});

test('gate: a prompt mostly in another language is held back with its English version', () => {
  const home = gateHome();
  const r = promptHook(home, '帮我看一下为什么这个测试一直失败');
  assert.equal(r.code, 2);
  assert.match(JSON.parse(r.out).reason, /✏️ In English: Please help me check this\./);
});

test('formatHeld: rewrite=never hides the natural version; copied prompts are mentioned', () => {
  const result = { mistakes: [{ original: 'a', better: 'b', reason: 'c' }], suggestions: [], natural: 'x', notEnglish: false };
  assert.doesNotMatch(formatHeld(result, { rewrite: 'never' }), /Natural version/);
  assert.match(formatHeld(result, { rewrite: 'auto' }, { words: 5 }), /✏️ Natural version: x/);
  assert.match(formatHeld(result, { rewrite: 'auto' }, { copied: true }), /on the clipboard/);
});

test('normalizeCheck: a malformed answer never holds a prompt back', () => {
  const item = { original: 'x', better: 'y', reason: 'z' };
  assert.equal(normalizeCheck(null).hold, false);
  assert.equal(normalizeCheck({ english: false }).hold, false, 'not English but no translation: nothing to show');
  assert.equal(normalizeCheck({ mistakes: [{ original: 'same', better: 'same', reason: 'no change' }] }).hold, false, 'no-op fixes are dropped');
  assert.equal(normalizeCheck({ suggestions: [item] }).hold, false, 'suggestions alone never hold');
  assert.equal(normalizeCheck({ suggestions: [item] }, 'strict').hold, true);
  assert.equal(normalizeCheck({ items: [item] }).hold, true, 'older "items" field still counts as mistakes');
});

test('gate: the background helper answers checks with a warm process, then stops', async () => {
  const home = gateHome();
  const daemonEnv = { ...env(home), GLINT_NO_DAEMON: '' };
  const daemon = spawn(process.execPath, [SCRIPT, 'daemon'], { env: daemonEnv, stdio: 'ignore' });
  try {
    let status = '';
    for (let i = 0; i < 50 && !status.includes('Helper running'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = spawnSync(process.execPath, [SCRIPT, 'daemon', 'status'], { env: daemonEnv, encoding: 'utf8' }).stdout;
    }
    assert.match(status, /Helper running/);

    const viaHelper = (prompt, session) => spawnSync(process.execPath, [SCRIPT, 'prompt'], {
      env: daemonEnv, encoding: 'utf8', input: JSON.stringify({ session_id: session, cwd: '/w', prompt }),
    });
    assert.equal(viaHelper('can help me check why the api got error', 'x').status, 2);
    assert.equal(viaHelper('Please add unit tests for the date parser.', 'y').status, 0);

    const launches = claudeLaunches(home);
    assert.ok(launches.length >= 2, 'the helper starts a fresh warm process after each request');
    assert.ok(launches.every((l) => l.args.includes('--input-format')), 'all requests went through warm processes');

    const bad = spawnSync(process.execPath, ['-e', `
      const net = require('net'); const s = net.connect(${JSON.stringify(spawnSync(process.execPath, ['--input-type=module', '-e', `import { pipePath } from ${JSON.stringify(new URL('../scripts/llm.mjs', import.meta.url).href)}; console.log(pipePath())`], { env: daemonEnv, encoding: 'utf8' }).stdout.trim())});
      s.on('connect', () => s.write('{"type":"bogus"}\\n')); s.on('data', (d) => { process.stdout.write(d); s.end(); });`], { encoding: 'utf8' });
    assert.match(bad.stdout, /unknown request: bogus/, 'a malformed request gets an error, not a crash');
    assert.match(spawnSync(process.execPath, [SCRIPT, 'daemon', 'status'], { env: daemonEnv, encoding: 'utf8' }).stdout, /Helper running/);

    assert.match(spawnSync(process.execPath, [SCRIPT, 'daemon', 'stop'], { env: daemonEnv, encoding: 'utf8' }).stdout, /Helper stopped/);
    await new Promise((r) => daemon.once('exit', r));
    assert.match(fs.readFileSync(path.join(home, 'daemon.log'), 'utf8'), /exiting: asked to stop/, 'a clean shutdown, not a crash');
  } finally {
    if (daemon.exitCode === null) {
      spawnSync(process.execPath, [SCRIPT, 'daemon', 'stop'], { env: daemonEnv });
      daemon.kill();
    }
  }
});

test('gate: with no helper running, the check runs once directly and starts the helper for next time', async () => {
  const home = gateHome();
  const helperEnv = { GLINT_NO_DAEMON: '' };
  try {
    const r = promptHook(home, 'can help me check why the api got error', { extraEnv: helperEnv });
    assert.equal(r.code, 2, `held back (stderr: ${r.err})`);
    assert.ok(!claudeLaunches(home)[0].args.includes('--input-format'), 'first check was a one-off run');

    let status = '';
    for (let i = 0; i < 50 && !status.includes('Helper running'); i++) {
      await new Promise((res) => setTimeout(res, 100));
      status = run(['daemon', 'status'], { home, extraEnv: helperEnv }).out;
    }
    assert.match(status, /Helper running/);
  } finally {
    run(['daemon', 'stop'], { home, extraEnv: helperEnv });
  }
});

test('daemon status/stop say so when no helper is running', () => {
  const home = tempHome();
  const r = run(['daemon', 'status'], { home, extraEnv: { GLINT_NO_DAEMON: '' } });
  assert.equal(r.code, 0);
  assert.match(r.out, /Helper is not running/);
});

// ---------- phrase lookups ----------

test('ask: the window protocol writes the answer, a .done marker, and a journal entry', () => {
  const home = tempHome();
  const q = path.join(home, 'q.txt');
  const a = path.join(home, 'a.txt');
  fs.writeFileSync(q, 'how to say "can or not" politely');
  assert.equal(run(['ask', '--in', q, '--out', a], { home }).code, 0);
  assert.match(fs.readFileSync(a, 'utf8'), /Could you take a look\?/);
  assert.ok(fs.existsSync(`${a}.done`));
  const [lookup] = journal(home);
  assert.equal(lookup.type, 'lookup');
  assert.equal(lookup.question, 'how to say "can or not" politely');
  assert.match(run(['journal'], { home }).out, /Phrases they looked up/);
});

test('ask: works from the terminal too', () => {
  const home = tempHome();
  assert.match(run(['ask', 'meaning', 'of', 'nitpick'], { home }).out, /Could you take a look\?/);
});

// ---------- inline mode ----------

test('inline: prompt hook injects instructions as additionalContext', () => {
  const home = inlineHome();
  const r = promptHook(home, 'plz help me check why the build got error');
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out).hookSpecificOutput;
  assert.equal(out.hookEventName, 'UserPromptSubmit');
  assert.match(out.additionalContext, /<glint>/);
  assert.match(out.additionalContext, /very start of your first reply/);
  assert.ok(out.additionalContext.length < 1400, `instructions stay short (${out.additionalContext.length} chars)`);
  assert.doesNotMatch(out.additionalContext, /\{\{\w+\}\}/, 'all placeholders filled');
  assert.equal(claudeLaunches(home).length, 0, 'inline mode never calls Claude itself');
});

test('inline: settings change the injected instructions', () => {
  const home = inlineHome();
  run(['config', 'strict'], { home });
  run(['config', 'position', 'end'], { home });
  run(['config', 'maxItems', '3'], { home });
  const ctx = JSON.parse(promptHook(home, 'please check my grammar here').out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Also flag casual chat style/);
  assert.match(ctx, /very end of your final reply/);
  assert.match(ctx, /up to 3,/);
});

test('prompt hook prints nothing for skipped prompts or bad input', () => {
  const home = inlineHome();
  assert.equal(promptHook(home, '/glint:config off').out, '');
  const bad = run(['prompt'], { home, input: 'not json' });
  assert.equal(bad.code, 0);
  assert.equal(bad.out, '');
});

test('turning Glint off stops it', () => {
  const home = inlineHome();
  run(['config', 'off'], { home });
  assert.equal(promptHook(home, 'please review my pull request now').out, '');
  run(['config', 'on'], { home });
  assert.notEqual(promptHook(home, 'please review my pull request now').out, '');
});

test('parses a feedback block with notes and a rewrite', () => {
  const fb = parseFeedback([
    'Sure.',
    '> 📝 **English check**',
    '> - "got error" → "fails with an error": "got" isn\'t used for "there is"',
    '> - "can or not" → "is that possible?": Singlish tag question',
    '> ✏️ Natural version: "Why does the build fail?"',
    '',
    'Let me look at the build.',
  ].join('\n'));
  assert.deepEqual(fb, {
    clean: false,
    notes: [
      '"got error" → "fails with an error": "got" isn\'t used for "there is"',
      '"can or not" → "is that possible?": Singlish tag question',
    ],
    rewrite: '"Why does the build fail?"',
  });
});

test('parses the all-clear line', () => {
  assert.deepEqual(parseFeedback('> 📝 **English check**: ✅ Natural and correct.\n\nDone.'), { clean: true, notes: [], rewrite: '' });
});

test('returns null when there is no feedback block', () => {
  assert.equal(parseFeedback('Here is the fix.'), null);
});

function writeTranscript(dir, assistantText) {
  const later = new Date(Date.now() + 5000).toISOString();
  const lines = [
    { type: 'user', timestamp: '2020-01-01T00:00:00.000Z', message: { role: 'user', content: 'old prompt' } },
    { type: 'assistant', timestamp: '2020-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '> 📝 **English check**\n> - "old" → "stale": should be ignored' }] } },
    { type: 'assistant', timestamp: later, message: { role: 'assistant', content: [{ type: 'text', text: assistantText }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
    { type: 'user', timestamp: later, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'assistant', timestamp: later, message: { role: 'assistant', content: [{ type: 'text', text: 'The build passes now.' }] } },
  ];
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('inline: stop hook saves only the current turn\'s feedback to the journal, once', () => {
  const home = inlineHome();
  promptHook(home, 'plz help me check why the build got error');
  const transcript = writeTranscript(home, '> 📝 **English check**\n> - "got error" → "fails": wrong verb\n\nChecking.');
  const stopInput = JSON.stringify({ session_id: 's1', transcript_path: transcript, stop_hook_active: false });

  assert.equal(run(['stop'], { home, input: stopInput }).code, 0);
  assert.equal(run(['stop'], { home, input: stopInput }).code, 0); // second Stop in the same turn: no duplicate

  const entries = journal(home);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].prompt, 'plz help me check why the build got error');
  assert.equal(entries[0].project, 'my-app');
  assert.deepEqual(entries[0].notes, ['"got error" → "fails": wrong verb']);
  assert.match(run(['journal'], { home }).out, /last 1 of 1 checked prompts/);
});

test('inline: stop hook falls back to last_assistant_message when feedback is at the end', () => {
  const home = inlineHome();
  promptHook(home, 'can you help me to refactor this function');
  const transcript = writeTranscript(home, 'Refactoring now.');
  run(['stop'], {
    home,
    input: JSON.stringify({
      session_id: 's1',
      transcript_path: transcript,
      last_assistant_message: 'Done.\n\n> 📝 **English check**\n> - "help me to refactor" → "help me refactor": drop "to"',
    }),
  });
  assert.deepEqual(journal(home)[0].notes, ['"help me to refactor" → "help me refactor": drop "to"']);
});

test('inline: journal setting off means nothing is recorded', () => {
  const home = inlineHome();
  run(['config', 'journal', 'off'], { home });
  promptHook(home, 'plz help me check why the build got error');
  assert.equal(fs.existsSync(path.join(home, 'pending')), false);
});

// ---------- config CLI ----------

test('config rejects bad values with a helpful message', () => {
  const home = tempHome();
  const r = run(['config', 'level', 'extreme'], { home });
  assert.equal(r.code, 0, 'exit 0 so the skill still shows the message');
  assert.match(r.out, /^Error: level must be one of: light, normal, strict/);
  assert.match(run(['config', 'colour', 'red'], { home }).out, /Unknown setting "colour"/);
  assert.match(run(['config', 'model', 'bad/model!'], { home }).out, /model must be a model name/);
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false, 'nothing saved');
});

test('config accepts settings as one quoted string, in any case, and mode/model shorthands', () => {
  const home = tempHome();
  run(['config', 'Position END'], { home });
  run(['config', 'maxitems 2'], { home });
  run(['config', 'inline'], { home });
  run(['config', 'model claude-opus-5-5'], { home });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')), {
    mode: 'inline', model: 'claude-opus-5-5', maxItems: 2, position: 'end',
  });
});

test('config only stores values that differ from the defaults, and reset clears them', () => {
  const home = tempHome();
  run(['config', 'light'], { home });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')), { level: 'light' });
  run(['config', 'reset'], { home });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')), {});
});

// ---------- Claude's message box as HTML: list numbers and /command chips ----------

// What Claude's message box (TipTap) copies as HTML for a draft with a /goal command chip, a numbered
// list and an empty line. Its plain-text copy has neither the "1." nor the chip.
const BOX_HTML = '<p data-pm-slice="0 0 []"><span data-skill-chip="" dir="auto" skillid="goal">/goal</span> refer to the screenshot：</p>'
  + '<ol><li><p>the build got error on staging</p></li><li><p>left top2 buttons</p></li></ol><p></p><p>next, check the code &amp; logs</p>';
const BOX_TEXT = '/goal refer to the screenshot：\n1. the build got error on staging\n2. left top2 buttons\n\nnext, check the code & logs';

test('message box HTML: read as text with the list numbers and /command chips', () => {
  const parsed = parseDraftHtml(BOX_HTML);
  assert.equal(parsed.text, BOX_TEXT);
  assert.deepEqual(parsed.chips, [{ text: '/goal', html: '<span data-skill-chip="" dir="auto" skillid="goal">/goal</span>' }]);
  // bullets, a nested list with a start number, a hard break and a code block
  const more = parseDraftHtml('<ul><li><p>a</p><ol start="3"><li><p>b</p></li><li><p>c<br>d</p></li></ol></li><li><p>e</p></li></ul><pre><code>x &lt; 1</code></pre>');
  assert.equal(more.text, '- a\n   3. b\n   4. c\nd\n- e\n```\nx < 1\n```');
});

test('message box HTML: a fix changes only its words, keeping the list and the chip', () => {
  const parsed = parseDraftHtml(BOX_HTML);
  const start = parsed.text.indexOf('got error');
  assert.equal(editDraftHtml(parsed, start, start + 'got error'.length, 'throws an error'), BOX_HTML.replace('got error', 'throws an error'));
  // words that run into the chip or a list number can't be changed in place
  assert.equal(editDraftHtml(parsed, 0, 'goal refer'.length + 1, 'x'), null);
  const marker = parsed.text.indexOf('1. ');
  assert.equal(editDraftHtml(parsed, marker, marker + 6, 'x'), null);
});

test('message box HTML: rebuilt from text with real lists and the same chips', () => {
  const parsed = parseDraftHtml(BOX_HTML);
  const html = draftToHtml('/goal Refer to the screenshot:\n1. The build throws an error on staging\n2. The two top-left buttons\n\nNext, check the code & logs.', parsed.chips);
  assert.equal(html, '<p data-pm-slice="0 0 []"><span data-skill-chip="" dir="auto" skillid="goal">/goal</span> Refer to the screenshot:</p>'
    + '<ol><li><p>The build throws an error on staging</p></li><li><p>The two top-left buttons</p></li></ol><p></p><p>Next, check the code &amp; logs.</p>');
  const nested = '- a\n   3. b\n   4. c\n- d';
  assert.equal(parseDraftHtml(draftToHtml(nested)).text, nested, 'nested lists keep their shape');
});

test('message box HTML: the clipboard\'s "HTML Format" data and its byte offsets', () => {
  const data = cfHtml('<p>héllo</p>');
  const text = data.toString('utf8');
  const offset = (name) => Number(new RegExp(`${name}:(\\d+)`).exec(text)[1]);
  assert.equal(data.subarray(offset('StartFragment'), offset('EndFragment')).toString('utf8'), '<p>héllo</p>');
  assert.equal(offset('EndHTML'), data.length);
  assert.equal(fragmentFromCfHtml(data), '<p>héllo</p>');
  assert.equal(fragmentFromCfHtml(Buffer.concat([data, Buffer.from([0, 0])])), '<p>héllo</p>', 'ignores the terminator from the clipboard');
});

test('fixes never include list numbers or bullets', () => {
  const r = normalizeCheck({ mistakes: [{ original: '1. the build got error', better: '1. the build throws an error', reason: 'r' }] });
  assert.deepEqual(r.mistakes.map((m) => [m.original, m.better]), [['the build got error', 'the build throws an error']]);
});

test('hotkey: a check of the message box HTML sees the list numbers and /goal, and its fixed version keeps them', () => {
  const home = tempHome();
  const prompts = path.join(home, 'prompts.log');
  fs.writeFileSync(path.join(home, 'draft.txt'), 'the plain copy, without numbers');
  fs.writeFileSync(path.join(home, 'draft.html'), cfHtml(BOX_HTML));
  const out = path.join(home, 'result.txt');
  run(['check', '--in', path.join(home, 'draft.txt'), '--html', path.join(home, 'draft.html'), '--out', out], { home, extraEnv: { FAKE_CLAUDE_PROMPTS: prompts } });
  const sent = JSON.parse(fs.readFileSync(prompts, 'utf8').trim().split('\n').pop()).text;
  assert.match(sent, /\/goal refer to the screenshot：\n1\. the build got error on staging\n2\. left top2 buttons/);
  assert.equal(fs.readFileSync(`${out}.natural`, 'utf8'), BOX_TEXT.replace('got error', 'throws an error'));
  const html = fragmentFromCfHtml(fs.readFileSync(`${out}.naturalhtml`));
  assert.equal(html, BOX_HTML.replace('got error', 'throws an error').replace('code &amp; logs', 'code &amp; logs'));
});

test('hotkey: Apply on the message box HTML keeps the list and the /goal chip', () => {
  const home = tempHome();
  const result = {
    mistakes: [
      { original: 'got error', better: 'throws an error', reason: 'r' },
      { original: '/goal refer', better: '/goal please refer', reason: 'r' },
    ],
    suggestions: [],
    natural: 'x',
    notEnglish: false,
  };
  fs.mkdirSync(path.join(home, 'window'), { recursive: true });
  fs.writeFileSync(path.join(home, 'window', 'last-check.json'), JSON.stringify({ id: null, at: Date.now(), draft: BOX_TEXT, result, showNatural: true, applied: [] }));
  fs.writeFileSync(path.join(home, 'draft.txt'), 'the plain copy, without numbers');
  fs.writeFileSync(path.join(home, 'draft.html'), cfHtml(BOX_HTML));
  const apply = (n) => {
    const out = path.join(home, `applied-${n}.txt`);
    run(['apply', '--index', String(n), '--in', path.join(home, 'draft.txt'), '--html', path.join(home, 'draft.html'), '--out', out], { home });
    return {
      status: fs.readFileSync(`${out}.status`, 'utf8'),
      text: fs.readFileSync(out, 'utf8'),
      html: fragmentFromCfHtml(fs.readFileSync(`${out}.cfhtml`)),
    };
  };
  // words inside a list item: changed in place, everything else exactly as it was
  const one = apply(1);
  assert.match(one.status, /^ok/);
  assert.equal(one.text, BOX_TEXT.replace('got error', 'throws an error'));
  assert.equal(one.html, BOX_HTML.replace('got error', 'throws an error'));
  // a fix that runs into the chip: the message is rebuilt, still with the chip and the list
  const two = apply(2);
  assert.match(two.status, /^ok/);
  assert.match(two.html, /^<p data-pm-slice="0 0 \[\]"><span data-skill-chip="" dir="auto" skillid="goal">\/goal<\/span> please refer/);
  assert.match(two.html, /<ol><li><p>the build got error on staging<\/p><\/li><li><p>left top2 buttons<\/p><\/li><\/ol><p><\/p>/);
});

// ---------- the message box read through UI Automation: plain text, no HTML ----------

test('a /command at the start of a draft read as text becomes a chip again', () => {
  assert.deepEqual(commandChips('/goal make it better'), [{ text: '/goal', html: '<span data-skill-chip="" dir="auto" skillid="goal">/goal</span>' }]);
  assert.deepEqual(commandChips('/review'), [{ text: '/review', html: '<span data-skill-chip="" dir="auto" skillid="review">/review</span>' }]);
  assert.deepEqual(commandChips('/usr/bin is a path'), [], 'a path is not a command');
  assert.deepEqual(commandChips('please /goal later'), [], 'only at the very start');
});

test('hotkey: a check of plain text (UI Automation) still gives a fixed version with real lists and the /goal chip', () => {
  const home = tempHome();
  // what UI Automation reads from the message box: list numbers written out, the chip as "/goal"
  const draft = '/goal fix these:\n1. the build got error\n2. left top2 buttons';
  const { natural } = windowCheck(home, draft);
  assert.equal(natural, draft.replace('got error', 'throws an error'));
  const html = fragmentFromCfHtml(fs.readFileSync(path.join(home, 'result.txt.naturalhtml')));
  assert.equal(html, '<p data-pm-slice="0 0 []"><span data-skill-chip="" dir="auto" skillid="goal">/goal</span> fix these:</p>'
    + '<ol><li><p>the build throws an error</p></li><li><p>left top2 buttons</p></li></ol>');
  // a fixed version that dropped the command gets it back
  const other = tempHome();
  assert.equal(windowCheck(other, '/goal the build got error').natural, '/goal Why does the API throw an error?');
});

test('"Use fixed version" with an @mention: the chip comes back from the message box HTML', () => {
  const home = tempHome();
  const mention = '<span data-type="at-mention" dir="auto" data-id="file:C:/v/a.mp4" data-label="a.mp4">@a.mp4</span>';
  fs.writeFileSync(path.join(home, 'box.html'), cfHtml(`<p data-pm-slice="0 0 []">look at ${mention} please</p>`));
  fs.writeFileSync(path.join(home, 'natural.txt'), 'Please look at @a.mp4.');
  const out = path.join(home, 'natural.out');
  run(['natural', '--in', path.join(home, 'natural.txt'), '--html', path.join(home, 'box.html'), '--out', out], { home });
  assert.equal(fragmentFromCfHtml(fs.readFileSync(`${out}.cfhtml`)), `<p data-pm-slice="0 0 []">Please look at ${mention}.</p>`);
});
