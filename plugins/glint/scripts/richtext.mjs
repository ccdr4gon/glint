// Claude's message box (a TipTap/ProseMirror editor) holds more than text: real numbered and bulleted
// lists, whose numbers aren't part of the text, and chips for /commands and @mentions. Its plain-text
// copy leaves the list numbers out, and pasting plain text back turns a /command chip into plain
// words. Its HTML copy ("HTML Format" on the Windows clipboard) keeps both, so the window copies that
// too. These helpers read it as text with the list markers written out ("1. ", "- "), change words
// inside it, and build HTML for a new text, so a fix pastes back with lists and chips intact.

const VOID = new Set(['br', 'img', 'hr', 'meta', 'input', 'wbr', 'link', 'col', 'source', 'area', 'base']);
const TEXTBLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre']);
const CONTAINERS = new Set(['div', 'blockquote', 'li', 'ol', 'ul', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'section', 'article', 'header', 'footer', 'figure', 'dl', 'dt', 'dd', 'details', 'summary', 'body', 'html']);
const SKIP = new Set(['head', 'style', 'script', 'title', 'template']);
// Inline nodes the editor renders as a <span> with one of these attributes: /command (skill) chips,
// @mentions and connector chips. Their text can't be edited, only kept or dropped as a whole.
const CHIP_ATTRS = ['data-skill-chip', 'data-type', 'data-id', 'data-mention', 'data-connector-mention', 'data-connector-tool-chip'];
const TOKEN_RE = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|[^<]+|</g;
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
// A list item's marker at the start of a line of draft text: "1. ", "2) ", "- ", "* " or "• ".
export const LIST_ITEM_RE = /^( *)(?:(\d+)[.)]|([-*•]))[ \t]+/;

export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

const encodeText = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');

function tokenize(html) {
  const tokens = [];
  for (const m of html.matchAll(TOKEN_RE)) {
    const raw = m[0];
    if (raw.startsWith('<!--')) tokens.push({ type: 'comment', raw });
    else if (m[2]) {
      const name = m[2].toLowerCase();
      tokens.push({ type: m[1] ? 'close' : 'open', name, attrs: m[3] ?? '', raw, selfClosing: VOID.has(name) || /\/\s*$/.test(m[3] ?? '') });
    } else tokens.push({ type: 'text', raw });
  }
  return tokens;
}

function attr(tok, name) {
  const m = new RegExp(`(?:^|\\s)${name}(?=[\\s=/]|$)(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+)))?`, 'i').exec(tok.attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

const isChip = (tok) => tok.name === 'span'
  && (CHIP_ATTRS.some((a) => attr(tok, a) !== null) || /contenteditable\s*=\s*["']?false/i.test(tok.attrs));

// The HTML fragment inside the clipboard's "HTML Format" data (a Buffer or string with its header).
export function fragmentFromCfHtml(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8');
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const text = bytes.subarray(0, end).toString('utf8');
  const a = text.indexOf('<!--StartFragment-->');
  const b = text.lastIndexOf('<!--EndFragment-->');
  if (a >= 0 && b > a) return text.slice(a + '<!--StartFragment-->'.length, b);
  const m = /StartFragment:(\d+)[\s\S]*?EndFragment:(\d+)/.exec(text);
  if (m && Number(m[2]) <= end && Number(m[1]) < Number(m[2])) return bytes.subarray(Number(m[1]), Number(m[2])).toString('utf8');
  const body = /<body[^>]*>([\s\S]*?)(?:<\/body>|$)/i.exec(text);
  return body ? body[1] : text.replace(/^Version:[\s\S]*?(?=<)/, '');
}

// The clipboard's "HTML Format" data for `fragment`: a header with byte offsets, then the HTML.
export function cfHtml(fragment) {
  const pre = '<html>\r\n<body>\r\n<!--StartFragment-->';
  const post = '<!--EndFragment-->\r\n</body>\r\n</html>';
  const pad = (n) => String(n).padStart(10, '0');
  const header = (a, b, c, d) => `Version:0.9\r\nStartHTML:${pad(a)}\r\nEndHTML:${pad(b)}\r\nStartFragment:${pad(c)}\r\nEndFragment:${pad(d)}\r\n`;
  const startHtml = Buffer.byteLength(header(0, 0, 0, 0));
  const startFragment = startHtml + Buffer.byteLength(pre);
  const endFragment = startFragment + Buffer.byteLength(fragment);
  const endHtml = endFragment + Buffer.byteLength(post);
  return Buffer.from(header(startHtml, endHtml, startFragment, endFragment) + pre + fragment + post, 'utf8');
}

// Reads the editor's HTML as draft text, like its own plain-text copy (blocks on separate lines, a
// hard break as a new line) plus the list markers it leaves out, and code blocks between ``` lines.
// Returns { text, pieces, tokens, chips }: `pieces` say where each part of the text came from
// ('text': an HTML text node that can be edited; 'atom': a chip; 'mark': a line break or marker
// added here), and `chips` holds each chip's text and HTML, for rebuilding.
export function parseDraftHtml(fragment) {
  const tokens = tokenize(String(fragment ?? ''));
  const pieces = [];
  const chips = [];
  let pos = 0;
  const push = (text, kind, tok = -1) => {
    if (!text) return;
    pieces.push({ text, kind, start: pos, tok });
    pos += text.length;
  };
  const lists = []; // open <ol>/<ul>: { ordered, next }
  const items = []; // open <li>: { marker, started, depth }
  let blocks = 0;
  let inBlock = false; // the current block's line has begun (separator and marker written)
  let textblock = 0;
  let pre = 0;
  let fenced = false;
  let skip = 0;
  let chip = null;
  const begin = () => {
    if (inBlock) return;
    if (blocks++ > 0) push('\n', 'mark');
    const li = items[items.length - 1];
    if (li) {
      const indent = '   '.repeat(li.depth);
      push(li.started ? indent + ' '.repeat(li.marker.length) : indent + li.marker, 'mark');
      li.started = true;
    }
    if (pre && !fenced) {
      push('```\n', 'mark');
      fenced = true;
    }
    inBlock = true;
  };
  tokens.forEach((t, i) => {
    if (chip) {
      chip.html += t.raw;
      if (t.type === 'text') chip.text += decodeEntities(t.raw);
      else if (t.type === 'open' && t.name === chip.name && !t.selfClosing) chip.depth++;
      else if (t.type === 'close' && t.name === chip.name && --chip.depth === 0) {
        push(chip.text, 'atom');
        chips.push({ text: chip.text, html: chip.html });
        chip = null;
      }
      return;
    }
    if (t.type === 'comment') return;
    if (skip) {
      if (t.type === 'open' && SKIP.has(t.name) && !t.selfClosing) skip++;
      else if (t.type === 'close' && SKIP.has(t.name)) skip--;
      return;
    }
    if (t.type === 'text') {
      const text = decodeEntities(t.raw);
      if (!textblock && !inBlock && !text.trim()) return; // layout whitespace between blocks
      begin();
      push(text, 'text', i);
      return;
    }
    const { name } = t;
    if (t.type === 'open') {
      if (SKIP.has(name) && !t.selfClosing) skip++;
      else if (name === 'br') {
        begin();
        push('\n', 'mark');
      } else if (isChip(t)) {
        begin();
        if (t.selfClosing) chips.push({ text: '', html: t.raw });
        else chip = { name, html: t.raw, text: '', depth: 1 };
      } else if (name === 'ol' || name === 'ul') {
        lists.push({ ordered: name === 'ol', next: Number.parseInt(attr(t, 'start') ?? '', 10) || 1 });
        inBlock = false;
      } else if (name === 'li') {
        const list = lists[lists.length - 1] ?? { ordered: false, next: 1 };
        const value = Number.parseInt(attr(t, 'value') ?? '', 10);
        const n = Number.isFinite(value) ? value : list.next;
        if (list.ordered) list.next = n + 1;
        items.push({ marker: list.ordered ? `${n}. ` : '- ', started: false, depth: Math.max(0, lists.length - 1) });
        inBlock = false;
      } else if (TEXTBLOCKS.has(name)) {
        textblock++;
        if (name === 'pre') pre++;
        inBlock = false;
      } else if (CONTAINERS.has(name)) inBlock = false;
      return;
    }
    if (name === 'ol' || name === 'ul') lists.pop();
    else if (name === 'li') {
      if (items[items.length - 1] && !items[items.length - 1].started) begin(); // an empty item is still a line
      items.pop();
    } else if (TEXTBLOCKS.has(name)) {
      begin(); // an empty paragraph is still a line
      if (name === 'pre' && pre > 0) {
        push('\n```', 'mark');
        pre--;
        fenced = false;
      }
      textblock = Math.max(0, textblock - 1);
    } else if (!CONTAINERS.has(name)) return;
    inBlock = false;
  });
  return { text: pieces.map((p) => p.text).join(''), pieces, tokens, chips };
}

// The editor's HTML with draft text [start, end) replaced by `replacement`, or null when that range
// isn't plain words in the HTML (it touches a list marker, a line break or a chip): then rebuild the
// whole message with draftToHtml instead.
export function editDraftHtml(parsed, start, end, replacement) {
  const textPieces = parsed.pieces.filter((p) => p.kind === 'text');
  let targets;
  if (start === end) {
    const host = textPieces.find((p) => p.start <= start && start <= p.start + p.text.length);
    if (!host) return null;
    targets = [host];
  } else {
    const touched = parsed.pieces.filter((p) => p.start < end && p.start + p.text.length > start);
    if (!touched.length || touched.some((p) => p.kind !== 'text')) return null;
    targets = touched;
  }
  const changed = new Map();
  targets.forEach((p, k) => {
    const from = Math.max(start, p.start) - p.start;
    const to = Math.min(end, p.start + p.text.length) - p.start;
    changed.set(p.tok, p.text.slice(0, from) + (k === 0 ? replacement : '') + p.text.slice(to));
  });
  return parsed.tokens.map((t, i) => (changed.has(i) ? encodeText(changed.get(i)) : t.raw)).join('');
}

// The chip for a /command at the start of a draft read as text (UI Automation shows the chip as
// "/goal"), as the editor's HTML has it, so pasting the draft back brings the chip back too.
export function commandChips(text) {
  const m = /^\/(\w[\w:-]{0,128})(?=\s|$)/.exec(String(text ?? ''));
  return m ? [{ text: `/${m[1]}`, html: `<span data-skill-chip="" dir="auto" skillid="${m[1]}">/${m[1]}</span>` }] : [];
}

// HTML for the editor from draft text: lines starting "1. " or "- " become real lists (nested by
// indent), ``` blocks become code blocks, other lines paragraphs. Each chip's text, found in order,
// becomes that chip again. Marked as the editor's own content (data-pm-slice), so it pastes as-is.
export function draftToHtml(text, chips = []) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const places = [];
  let from = 0;
  for (const chip of chips) {
    if (!chip.text) continue;
    const at = src.indexOf(chip.text, from);
    if (at < 0) continue;
    places.push({ start: at, end: at + chip.text.length, html: chip.html });
    from = at + chip.text.length;
  }
  const inline = (start, end) => {
    let html = '';
    let cur = start;
    for (const p of places) {
      if (p.start < cur || p.end > end) continue;
      html += encodeText(src.slice(cur, p.start)) + p.html;
      cur = p.end;
    }
    return html + encodeText(src.slice(cur, end));
  };
  const lines = [];
  let offset = 0;
  for (const line of src.split('\n')) {
    lines.push({ text: line, start: offset });
    offset += line.length + 1;
  }
  let html = '';
  const lists = []; // { tag, indent, open }: open = its last <li> is still open
  const top = () => lists[lists.length - 1];
  const closeList = () => {
    const l = lists.pop();
    html += `${l.open ? '</li>' : ''}</${l.tag}>`;
  };
  const closeAll = () => {
    while (lists.length) closeList();
  };
  for (let i = 0; i < lines.length; i++) {
    const { text: line, start } = lines[i];
    const item = LIST_ITEM_RE.exec(line);
    if (/^\s*```/.test(line)) {
      closeAll();
      const code = [];
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i].text)) code.push(lines[i].text);
      html += `<pre><code>${encodeText(code.join('\n'))}</code></pre>`;
    } else if (item) {
      const indent = item[1].length;
      const tag = item[2] ? 'ol' : 'ul';
      while (lists.length && indent < top().indent) closeList();
      if (lists.length && indent === top().indent && tag !== top().tag) closeList();
      if (lists.length && indent === top().indent) {
        if (top().open) html += '</li>'; // the next item of the same list
      } else {
        // a new list: at the top level, or nested in the item that's still open
        const n = item[2] ? Number(item[2]) : 1;
        html += tag === 'ol' && n !== 1 ? `<ol start="${n}">` : `<${tag}>`;
        lists.push({ tag, indent, open: false });
      }
      html += `<li><p>${inline(start + item[0].length, start + line.length)}</p>`;
      top().open = true;
    } else if (lists.length && top().open && line.trim() && /^ +/.test(line)) {
      html += `<p>${inline(start + line.length - line.trimStart().length, start + line.length)}</p>`; // more of the same item
    } else {
      closeAll();
      html += line ? `<p>${inline(start, start + line.length)}</p>` : '<p></p>';
    }
  }
  closeAll();
  return (html || '<p></p>').replace(/^<(\w+)/, '<$1 data-pm-slice="0 0 []"');
}
