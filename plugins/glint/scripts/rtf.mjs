// Rich text (RTF) for the Glint window, which shows it in a Windows rich edit control.
// Everything is plain ASCII: other characters become \uN escapes, so the window can pass the text
// straight through without caring about encodings.

const THEMES = {
  light: { text: [31, 31, 31], muted: [96, 96, 96], red: [196, 43, 28], green: [16, 124, 16], accent: [0, 95, 184], amber: [157, 93, 0] },
  dark: { text: [243, 243, 243], muted: [168, 168, 168], red: [255, 153, 164], green: [108, 203, 95], accent: [96, 205, 255], amber: [255, 213, 128] },
};
const COLOR_INDEX = { text: 1, muted: 2, red: 3, green: 4, accent: 5, amber: 6 };

export function rtfEscape(text) {
  let out = '';
  for (const ch of String(text).replace(/\r\n?/g, '\n')) {
    const code = ch.codePointAt(0);
    if (ch === '\\' || ch === '{' || ch === '}') out += `\\${ch}`;
    else if (ch === '\n') out += '\\line ';
    else if (ch === '\t') out += '\\tab ';
    else if (code < 0x80) out += ch;
    else if (code <= 0xffff) out += `\\u${code > 0x7fff ? code - 0x10000 : code}?`;
    else {
      // Outside the BMP (emoji): write the UTF-16 surrogate pair.
      const v = code - 0x10000;
      out += `\\u${0xd800 + (v >> 10) - 0x10000}?\\u${0xdc00 + (v & 0x3ff) - 0x10000}?`;
    }
  }
  return out;
}

// One run of text. size is in points; font 1 is the semibold heading font.
function span(text, { color = 'text', size, semibold = false, strike = false } = {}) {
  const fmt = `\\cf${COLOR_INDEX[color]}${semibold ? '\\f1' : '\\f0'}${size ? `\\fs${Math.round(size * 2)}` : ''}${strike ? '\\strike' : ''}`;
  return `{${fmt} ${rtfEscape(text)}}`;
}

// One paragraph. Spacing is in points; lines inside a paragraph are single-spaced.
function para(content, { before = 0, after = 0 } = {}) {
  return `\\pard\\sb${before * 20}\\sa${after * 20} ${content}\\par\n`;
}

function doc(theme, body) {
  const palette = THEMES[theme] ?? THEMES.light;
  const colors = Object.keys(COLOR_INDEX).map((k) => `\\red${palette[k][0]}\\green${palette[k][1]}\\blue${palette[k][2]};`).join('');
  return `{\\rtf1\\ansi\\deff0\\uc1{\\fonttbl{\\f0\\fnil Segoe UI;}{\\f1\\fnil Segoe UI Semibold;}}{\\colortbl;${colors}}\n\\f0\\fs21\\cf1\n${body}}`;
}

const heading = (mark, markColor, text) => para(span(`${mark}  `, { color: markColor, size: 13 }) + span(text, { semibold: true, size: 13 }), { after: 4 });
const label = (text) => para(span(text.toUpperCase(), { color: 'muted', size: 8, semibold: true }), { before: 11, after: 1 });
const hint = (text) => para(span(text, { color: 'muted', size: 9 }), { before: 11 });

// A clickable "Apply" link. The window reads "fix:N" from the click and applies fix N.
// (No number shortcuts: Alt+1 belongs to the user's screenshot tool.)
function applyLink(n) {
  return `{\\field{\\*\\fldinst{HYPERLINK "fix:${n}"}}{\\fldrslt{\\cf${COLOR_INDEX.accent}\\f0\\fs18 Apply}}}`;
}

// One fix. state: 'can' (show an Apply link), 'applied', 'fixed' (already in the message, e.g.
// through an overlapping fix), or anything else (no link).
function item(it, fixColor, { strike, n, state }) {
  const done = { applied: '✓ Applied', fixed: '✓ Already fixed' }[state];
  const action = state === 'can' ? applyLink(n) : done ? span(done, { color: 'green', semibold: true, size: 9 }) : '';
  const reason = it.reason ? span(it.reason, { color: 'muted', size: 9.5 }) : '';
  return para(span(it.original, { color: strike ? 'red' : 'text', strike }) + span('  →  ', { color: 'muted' }) + span(it.better, { color: fixColor, semibold: true }), { before: 6 })
    + (reason || action ? para(reason + (reason && action ? span('     ') : '') + action, { before: 1 }) : '');
}

// The result of an Alt+Enter check. `result` comes from normalizeCheck; `states` has one entry per
// fix (mistakes, then suggestions): 'can', 'applied' or 'no'.
export function checkRtf(result, { theme = 'light', showNatural = true, states = [] } = {}) {
  const { mistakes, suggestions, natural, notEnglish } = result;
  let body = '';
  if (notEnglish) {
    body += heading('●', 'accent', 'In English');
    body += para(span(natural), { before: 6 });
    return doc(theme, body + hint('Alt+F puts this into Claude. Then press Enter to send.'));
  }
  if (!mistakes.length && !suggestions.length) {
    return doc(theme, heading('✓', 'green', 'Looks good') + para(span('No mistakes found.', { color: 'muted' }), { before: 2 }));
  }
  body += mistakes.length
    ? heading('●', 'red', `${mistakes.length} ${mistakes.length === 1 ? 'thing' : 'things'} to fix`)
    : heading('✓', 'green', 'No mistakes');
  mistakes.forEach((it, i) => {
    body += item(it, 'green', { strike: true, n: i + 1, state: states[i] });
  });
  if (suggestions.length) {
    body += label(mistakes.length ? 'Optional ideas' : 'Optional ideas to sound more natural');
    suggestions.forEach((it, i) => {
      const n = mistakes.length + i + 1;
      body += item(it, 'amber', { strike: false, n, state: states[n - 1] });
    });
  }
  if (natural && showNatural) {
    body += label('Natural version');
    body += para(span(natural), { before: 2 });
  }
  // The window's status line and "Use fixed version (Alt+F)" button say what to do next.
  return doc(theme, body);
}

// A plain message, e.g. "Nothing to check" or an error.
export function messageRtf(title, text, { theme = 'light' } = {}) {
  return doc(theme, heading('●', 'muted', title) + (text ? para(span(text, { color: 'muted' }), { before: 4 }) : ''));
}

// A phrase lookup: the question, then the (possibly still arriving) answer.
export function lookupRtf(question, answer, { theme = 'light' } = {}) {
  let body = para(span(question, { color: 'muted', size: 9.5 }), { after: 6 });
  for (const line of String(answer).split('\n')) body += para(span(line), { before: line.trim() ? 3 : 0 });
  return doc(theme, body);
}
