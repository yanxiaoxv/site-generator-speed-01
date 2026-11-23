// solve.js — a faster drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly what makefun-site 1.0.0's build returns for the same input: the
// output tree (path -> text) of the site. The rules it follows are the vendor's own, as stated in
// makefun-site's README and run by its code (front matter, its Markdown subset, its template
// dialect, its slug rule, its report) — not Jekyll's, Hugo's, Eleventy's or metalsmith's, and its
// Markdown is not CommonMark.
//
// How it is fast, while answering byte for byte:
//   - Markdown is lexed and rendered in one pass over the body's lines: no token objects, no
//     second walk. Its inline renderer scans with an index and writes plain runs through a single
//     escape call into one shared parts array, so strong, emphasis and links append into the same
//     array instead of building an intermediate string each; a backslash escape, a code span and a
//     link target are all read with indexOf hops, never character by character.
//   - Templates are parsed once per build into a node tree (as the reference does) and rendered
//     into a parts array joined once; scopes are a small frame stack, and a for loop reuses one
//     frame object per activation, its element and loop record rewritten per item, instead of one
//     scope object per item.
//   - Slugs are cached per build (tag names and titles repeat), words are counted by a manual scan
//     instead of a match array, and front matter is scanned by line index instead of split + join.
//   - Nothing is kept between run() calls: every cache is per build, so each case is answered alone.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

// ---------------------------------------------------------------- text (the vendor's rules)

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped; unchanged when it holds none of them. */
function escapeHtml(text) {
  return ESC_TEST.test(text) ? text.replace(/[&<>"']/g, (c) => ESCAPES[c]) : text;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other
 * than a-z and 0-9 one "-", none at either end, at most 64 characters (a "-" left at the cut
 * dropped), and "untitled" when nothing is left. `cache` is the build's per-string cache. */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Whether a code unit >= 128 is whitespace, as JavaScript's \s reads it (no /u flag). */
function isWSHi(code) {
  return (
    code === 160 || code === 5760 || (code >= 8192 && code <= 8202) || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279
  );
}

/** The words of a body: its runs of characters other than whitespace. One pass, one charCodeAt
 * per character; ASCII whitespace is tested inline, the rest only past 127. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || (c >= 128 && isWSHi(c));
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is
 * refused. `text` has "\n" line ends. Lines are walked by index (no split of the whole text, no
 * join of the body back together).
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing line and its line number (counted from 1 at the opening ---).
  let closeLine = -1; // 0-based line index of the closing ---
  let closeEnd = -1; // index just past the closing line's \n (or text.length)
  {
    let pos = firstNl === -1 ? text.length : firstNl + 1;
    let lineNo = 1; // 0-based index of the line starting at pos
    while (pos <= text.length) {
      const nl = text.indexOf('\n', pos);
      const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
      if (line === '---') {
        closeLine = lineNo;
        closeEnd = nl === -1 ? text.length : nl + 1;
        break;
      }
      if (nl === -1) break;
      pos = nl + 1;
      lineNo++;
    }
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  {
    let pos = firstNl + 1;
    for (let i = 1; i < closeLine; i++) {
      const nl = text.indexOf('\n', pos);
      const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
      if (!/^[ \t]*$/.test(line) && line[0] !== '#') {
        const m = FM_LINE.exec(line);
        if (!m) return { error: `line ${i + 1} is not "key: value"` };
        const key = m[1];
        const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
        if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
        if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
        if (raw === '') return { error: `key "${key}" has no value` };
        const v = valueOf(key, raw);
        if ('error' in v) return v;
        data[key] = v.value;
      }
      pos = nl === -1 ? text.length + 1 : nl + 1;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd >= text.length ? '' : text.slice(closeEnd) };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** Whether `line` holds only spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `ch` may open a fence language (A-Z, a-z, 0-9, _, +, -). */
function isLangChar(code) {
  return (
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 || code === 43 || code === 45
  );
}

/** A fence's language, or null when the line is no fence opening (three backticks, an optional
 * language, then spaces or tabs only). */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  for (let j = i; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, i);
}

/** Whether the line closes a fence (three backticks, spaces or tabs after them). */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

/** Whether the line is a thematic break (`---` or `***`, then spaces or tabs only). */
function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let j = 3; j < line.length; j++) {
    const d = line.charCodeAt(j);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const k = blockKind(line);
  return k === 0 || k === 1 || k === 2 || k === 3;
}

/**
 * What block a line starts, by its first character (the reference tests blank, fence, heading,
 * break, quote and list in that order; no line can match two of them, so the first character
 * decides which tests can even apply): 0 blank, 1 fence, 2 heading, 3 thematic break, 4 list,
 * 5 paragraph, 6 blockquote.
 */
function blockKind(line) {
  if (line.length === 0) return 0;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line) ? 0 : 5;
  if (c === 96) return fenceLang(line) !== null ? 1 : 5;
  if (c === 35) return headingOf(line) !== null ? 2 : 5;
  if (c === 45 || c === 42) {
    if (isHr(line)) return 3;
    return bulletOf(line) !== null ? 4 : 5;
  }
  if (c === 62) return 6;
  if (c >= 48 && c <= 57) return orderedOf(line) !== null ? 4 : 5;
  return 5;
}

/** A bullet list item's text, or null (a line `- ` or `* `). */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c !== 45 && c !== 42) || line.charCodeAt(1) !== 32) return null;
  return line.slice(2);
}

/** An ordered list item's number and text, or null (digits and `. `). */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: line.slice(0, i), text: line.slice(i + 2) };
}

/** Whether the line continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  const c = line.charCodeAt(i);
  return !(c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || (c >= 128 && isWSHi(c)));
}

/** The first index in [`from`, `to`) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, to) {
  for (let j = from; j <= to - what.length; j++) {
    if (s[j] === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [`from`, `to`) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < to && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[a..b)` rendered inline into `out` (a parts array); `env.link(target)` is a link's href.
 * Plain runs go through one escape call each instead of one per character, and nested strong,
 * emphasis and links render into the same array over their ranges, with no substring built.
 */
function inlineInto(s, a, b, env, out) {
  let i = a;
  let run = a;
  const flush = (to) => {
    if (to > run) out.push(escapeHtml(s.slice(run, to)));
  };
  while (i < b) {
    const c = s[i];
    if (c === '\\' && i + 1 < b && ESCAPABLE.has(s[i + 1])) {
      flush(i);
      out.push(escapeHtml(s[i + 1]));
      i += 2;
      run = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1 && j < b) {
        flush(i);
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (i + 1 < b && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j > i + 2) {
          flush(i);
          out.push('<strong>');
          inlineInto(s, i + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
          run = i;
        } else {
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j > i + 1) {
        flush(i);
        out.push('<em>');
        inlineInto(s, i + 1, j, env, out);
        out.push('</em>');
        i = j + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, b);
      const m = k !== -1 && k + 1 < b && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 || m >= b ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineInto(s, i + 1, k, env, out);
        out.push('</a>');
        i = m + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flush(b);
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of
 * contents (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the
 * first paragraph's inline HTML, or ""). Lexing and rendering run in one pass over the lines.
 */
function renderMarkdown(src, env, slugCache) {
  const lines = src.split('\n');
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kind = blockKind(line);
    if (kind === 0) {
      i++;
      continue;
    }
    if (kind === 1) {
      const lang = fenceLang(line);
      const body = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      out.push('<pre><code');
      if (lang !== '') out.push(' class="language-', escapeHtml(lang), '"');
      out.push('>');
      for (const l of body) {
        out.push(escapeHtml(l), '\n');
      }
      out.push('</code></pre>\n');
      continue;
    }
    if (kind === 2) {
      const heading = headingOf(line);
      const id = uniqueSlug(slugify(heading.text, slugCache), ids);
      const parts = [];
      inlineInto(heading.text, 0, heading.text.length, env, parts);
      const html = parts.join('');
      out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (kind === 3) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (kind === 6) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        if (l.charCodeAt(1) === 32) l = l.slice(2);
        else l = l.slice(1);
        l = trimLine(l);
        if (l !== '') body.push(l);
      }
      if (body.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const parts = [];
        const joined = body.join('\n');
        inlineInto(joined, 0, joined.length, env, parts);
        out.push('<blockquote>\n<p>', parts.join(''), '</p>\n</blockquote>\n');
      }
      continue;
    }
    if (kind === 4) {
      const bullet = bulletOf(line);
      const ordered = bullet === null ? orderedOf(line) : null;
      const isOrdered = ordered !== null;
      const start = isOrdered ? Number(ordered.num) : 1;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          const m = bulletOf(l);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
            continue;
          }
        }
        if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      out.push(isOrdered && start !== 1 ? `<ol start="${start}">\n` : isOrdered ? '<ol>\n' : '<ul>\n');
      for (const item of items) {
        const parts = [];
        const joined = item.join('\n');
        inlineInto(joined, 0, joined.length, env, parts);
        out.push('<li>', parts.join(''), '</li>\n');
      }
      out.push(isOrdered ? '</ol>\n' : '</ul>\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const parts = [];
    inlineInto(text, 0, text.length, env, parts);
    const html = parts.join('');
    if (excerpt === null) excerpt = html;
    out.push('<p>', html, '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s` from `a` to `b` holds only spaces and tabs. */
function onlySpaces(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaces(src, lineStart, open) && onlySpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * The value at `path` in the scope chain (`frames`, innermost last): its first name from the
 * nearest frame holding it, then own properties of the value so far.
 */
function lookup(frames, path) {
  for (let f = frames.length - 1; f >= 0; f--) {
    const vars = frames[f];
    if (!Object.hasOwn(vars, path[0])) continue;
    let v = vars[path[0]];
    for (let k = 1; k < path.length; k++) {
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
      v = v[path[k]];
    }
    return v;
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` (a parts array) in the scope chain `frames`. `ctx` holds the parsed
 * templates (a Map of name to nodes; a template that did not parse is absent) and the include depth.
 * A for loop reuses one frame object per activation, its element and loop record rewritten per
 * item, instead of one scope object per item.
 */
function renderNodes(nodes, frames, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(frames, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(frames, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(frames, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, frames, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(frames, n.path);
        if (!Array.isArray(xs)) break;
        const vars = {};
        const loop = { index: 0, first: false, last: false, length: xs.length };
        vars[n.name] = undefined;
        vars.loop = loop;
        frames.push(vars);
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          vars.loop = loop; // after the element, as the reference's literal does: a loop named `loop` still reads the loop record
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, frames, ctx, depth, out);
        }
        frames.pop();
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, frames, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const broken = new Set();

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter, in order: refused, the generator's own directories, a post
  // with no date, a layout no template has, a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        // A target with a scheme (letter, then scheme characters, then ':'), or one opening on
        // '/' or '#', is kept as written — read by hand, not by a regex, per link.
        const c0 = target.charCodeAt(0);
        if (c0 === 47 || c0 === 35) return target;
        if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
          for (let j = 1; j < target.length; j++) {
            const d = target.charCodeAt(j);
            if (d === 58) return target;
            if (!((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 43 || d === 45 || d === 46)) break;
          }
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, [{ site, tags: allTags, recent, ...vars }], ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
