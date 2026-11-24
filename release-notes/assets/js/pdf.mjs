// Draws a release note as a PDF file. Pure (no DOM, no network, no libraries), so it runs in the browser and in Node and is
// tested in tools/tests/composer.test.mjs. Used by the public release pages and by the composer (admin/). The site loads no
// third-party code, so this is a small PDF writer of its own:
// A4 pages, the standard Helvetica and Courier fonts (nothing to embed), screenshots as JPEG, clickable links, page numbers.
// The structure follows the website page (overview, then New Features / Enhancements & Improvements / Bug Fixes), using the
// same section and category definitions from assets/js/render-shared.mjs.
import { CATEGORIES, SECTIONS, TYPES, categoryLabel, formatDate, isSafeUrl } from './render-shared.mjs';

const PW = 595.28, PH = 841.89, ML = 54, MR = 54, MT = 54, MB = 64;
const CW = PW - ML - MR;
const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

/* ------------------------------------------------------------------ text: encoding and widths */
const CP1252 = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
  0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F,
};
const TRANSLIT = { '→': '->', '←': '<-', '‑': '-', '‒': '-', '−': '-', '​': '', '‍': '', '️': '', '﻿': '', '★': '*', '✓': '' };

/** Keeps only characters the standard PDF fonts can show (Latin-1 plus the usual typographic marks); the rest become "?". */
export function clean(str) {
  let out = '';
  for (const ch of String(str ?? '').normalize('NFC')) {
    const cp = ch.codePointAt(0);
    if (cp === 9 || cp === 10 || cp === 13 || cp === 0xA0) out += ' ';
    else if ((cp >= 32 && cp <= 126) || (cp >= 161 && cp <= 255) || CP1252[cp] !== undefined) out += ch;
    else if (TRANSLIT[ch] !== undefined) out += TRANSLIT[ch];
    else if (cp < 32 || (cp >= 127 && cp <= 160)) out += '';
    else out += '?';
  }
  return out;
}
const winByte = (ch) => { const cp = ch.codePointAt(0); return CP1252[cp] !== undefined ? CP1252[cp] : cp; };

// Advance widths (1/1000 em) of Helvetica and Helvetica-Bold for U+0020..U+007E
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const EXTRA_REG = { '‘': 222, '’': 222, '“': 333, '”': 333, '•': 350, '–': 556, '—': 1000, '…': 1000, '›': 333, '‹': 333, '€': 556, '™': 1000, '©': 737, '®': 737, '·': 278, '°': 400, '×': 584, '÷': 584, '±': 584, '«': 556, '»': 556, 'ß': 611, 'æ': 889, 'Æ': 1000, 'œ': 944, 'Œ': 1000, 'ø': 611, 'Ø': 778 };
const EXTRA_BOLD = { '‘': 278, '’': 278, '“': 500, '”': 500, '•': 350, '–': 556, '—': 1000, '…': 1000, '›': 333, '‹': 333, '€': 556, '™': 1000, '©': 737, '®': 737, '·': 278, '°': 400, '×': 584, '÷': 584, '±': 584, '«': 556, '»': 556, 'ß': 611, 'æ': 889, 'Æ': 1000, 'œ': 944, 'Œ': 1000, 'ø': 611, 'Ø': 778 };

// Font keys: r regular, b bold, i italic (same widths as regular), c code (Courier)
function glyph(ch, f) {
  if (f === 'c') return 600;
  const t = f === 'b' ? W_BOLD : W_REG, cp = ch.codePointAt(0);
  if (cp >= 32 && cp <= 126) return t[cp - 32];
  const x = (f === 'b' ? EXTRA_BOLD : EXTRA_REG)[ch];
  if (x !== undefined) return x;
  const base = ch.normalize('NFD')[0];
  if (base !== ch && base.codePointAt(0) < 127) return t[base.codePointAt(0) - 32];
  return f === 'b' ? 611 : 556;
}
const fontSize = (f, size) => (f === 'c' ? size * 0.92 : size);
export function textWidth(str, f, size) {
  let w = 0;
  for (const ch of clean(str)) w += glyph(ch, f);
  return (w / 1000) * fontSize(f, size);
}

/* ------------------------------------------------------------------ inline markup and wrapping */
function resolveUrl(u, baseUrl) {
  const s = String(u ?? '').trim();
  try {
    if (/^(https?:|mailto:)/i.test(s)) return new URL(s).href;
    if (baseUrl && !/^#/.test(s)) return new URL(s, baseUrl).href;
  } catch { /* not a usable address */ }
  return null; // a relative address with nothing to resolve it against stays plain text
}

/** `code`, **bold** and [label](url), as the website understands them, as runs {t, f, url?}. base = the font for plain text. */
export function inlineRuns(text, base = 'r', baseUrl = '') {
  const s = String(text ?? ''), runs = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) runs.push({ t: s.slice(last, m.index), f: base });
    if (m[1] !== undefined) runs.push({ t: m[1], f: 'c' });
    else if (m[2] !== undefined) runs.push({ t: m[2], f: 'b' });
    else runs.push({ t: m[3], f: base, url: isSafeUrl(m[4]) ? resolveUrl(m[4], baseUrl) : null });
    last = re.lastIndex;
  }
  if (last < s.length) runs.push({ t: s.slice(last), f: base });
  return runs;
}

/** Breaks runs into lines no wider than `width`. A word wider than a line is split. Returns [{toks:[{s,f,url,w}], w}]. */
export function wrapRuns(runs, size, width) {
  const toks = [];
  for (const r of runs) {
    for (const part of clean(r.t).split(/(\s+)/)) {
      if (part === '') continue;
      const s = /^\s+$/.test(part) ? ' ' : part;
      toks.push({ s, f: r.f, url: r.url || null, w: textWidth(s, r.f, size), color: r.color });
    }
  }
  const lines = [];
  let line = [], w = 0;
  const push = () => {
    while (line.length && line[line.length - 1].s === ' ') w -= line.pop().w;
    lines.push({ toks: line, w });
    line = []; w = 0;
  };
  for (let tok of toks) {
    if (tok.s === ' ') { if (line.length) { line.push(tok); w += tok.w; } continue; }
    if (w + tok.w <= width + 0.01) { line.push(tok); w += tok.w; continue; }
    if (line.length) push();
    while (tok.w > width + 0.01) { // a single word longer than the line: cut it where it fits
      let n = 1;
      const chars = Array.from(tok.s);
      while (n < chars.length && textWidth(chars.slice(0, n + 1).join(''), tok.f, size) <= width) n += 1;
      const head = chars.slice(0, n).join(''), rest = chars.slice(n).join('');
      line.push({ ...tok, s: head, w: textWidth(head, tok.f, size) }); w += textWidth(head, tok.f, size);
      push();
      tok = { ...tok, s: rest, w: textWidth(rest, tok.f, size) };
    }
    line.push(tok); w += tok.w;
  }
  if (line.length || !lines.length) push();
  return lines;
}

/* ------------------------------------------------------------------ colours and PDF syntax */
const INK = [25, 40, 57], SOFT = [64, 86, 109], BLUE = [48, 94, 255], LINK = [41, 80, 218], NAVY = [13, 26, 72], LINE = [205, 208, 212], WASH = [243, 244, 246], WHITE = [255, 255, 255];
const AMBER = [154, 91, 0], AMBER_BG = [255, 248, 236], GREEN = [14, 122, 79], BLUE_WASH = [234, 239, 255];
const num = (v) => String(Math.round(v * 100) / 100);
const rgb = (c) => `${c.map((v) => Math.round((v / 255) * 1000) / 1000).join(' ')}`;
const Y = (y) => PH - y; // distance from the top of the page -> PDF coordinates
const FONT_NAME = { r: 'F1', b: 'F2', i: 'F3', c: 'F4' };

function pdfString(str) { // a literal string for the content stream or a dictionary; bytes are WinAnsi
  let out = '(';
  for (const ch of clean(str)) {
    const b = winByte(ch);
    if (b === 0x28 || b === 0x29 || b === 0x5C) out += `\\${String.fromCharCode(b)}`;
    else if (b < 32 || b > 126) out += `\\${b.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(b);
  }
  return `${out})`;
}
const asciiUrl = (u) => `(${String(u).replace(/[^\x21-\x7E]/g, '').replace(/[()\\]/g, (c) => `\\${c}`)})`;
const utf16Hex = (s) => `<FEFF${Array.from(String(s), (ch) => ch.codePointAt(0)).map((cp) => (cp > 0xFFFF ? [0xD800 + ((cp - 0x10000) >> 10), 0xDC00 + ((cp - 0x10000) & 0x3FF)] : [cp])).flat().map((u) => u.toString(16).padStart(4, '0')).join('')}>`;
const latin1 = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i += 1) b[i] = s.charCodeAt(i) & 0xFF; return b; };

/* ------------------------------------------------------------------ layout */
const CHIP = {
  'new-feature': { fill: BLUE, stroke: BLUE, color: WHITE },
  enhancement: { fill: WHITE, stroke: NAVY, color: NAVY },
  improvement: { fill: BLUE_WASH, stroke: [150, 170, 240], color: LINK },
  'bug-fix': { fill: WHITE, stroke: SOFT, color: INK },
  'type-major': { fill: NAVY, stroke: NAVY, color: WHITE },
  'type-minor': { fill: WHITE, stroke: SOFT, color: INK },
  'type-patch': { fill: WHITE, stroke: SOFT, color: SOFT },
  section: { fill: BLUE_WASH, stroke: BLUE_WASH, color: LINK },
  featured: { fill: WHITE, stroke: BLUE, color: LINK },
  draft: { fill: AMBER_BG, stroke: AMBER, color: AMBER },
  sample: { fill: WASH, stroke: SOFT, color: SOFT },
  count: { fill: WASH, stroke: WASH, color: INK },
};

class Layout {
  constructor({ images, baseUrl }) {
    this.images = images; this.baseUrl = baseUrl;
    this.pages = []; this.y = MT; this.fig = 0;
    this.totals = {}; this.nums = new Map();
    this.imgList = []; // distinct images, in the order first used
    this.newPage();
  }

  get page() { return this.pages[this.pages.length - 1]; }
  op(s) { this.page.ops.push(s); }
  newPage() { this.pages.push({ ops: [], links: [], imgs: new Set() }); this.y = MT; }
  room() { return PH - MB - this.y; }
  ensure(h) { if (h > this.room() && this.y > MT + 1) this.newPage(); }
  gap(h) { this.y += h; }

  /* shapes */
  fillRect(x, yTop, w, h, c) { this.op(`${rgb(c)} rg ${num(x)} ${num(Y(yTop + h))} ${num(w)} ${num(h)} re f`); }
  hRule(yTop, c = LINE, x = ML, w = CW) { this.op(`${rgb(c)} RG 0.6 w ${num(x)} ${num(Y(yTop))} m ${num(x + w)} ${num(Y(yTop))} l S`); }
  round(x, yTop, w, h, r, { fill, stroke, lw = 0.7 }) {
    const k = 0.5523 * r, y0 = Y(yTop + h), x1 = x + w, y1 = y0 + h;
    const p = [`${num(x + r)} ${num(y0)} m`, `${num(x1 - r)} ${num(y0)} l`, `${num(x1 - r + k)} ${num(y0)} ${num(x1)} ${num(y0 + r - k)} ${num(x1)} ${num(y0 + r)} c`,
      `${num(x1)} ${num(y1 - r)} l`, `${num(x1)} ${num(y1 - r + k)} ${num(x1 - r + k)} ${num(y1)} ${num(x1 - r)} ${num(y1)} c`,
      `${num(x + r)} ${num(y1)} l`, `${num(x + r - k)} ${num(y1)} ${num(x)} ${num(y1 - r + k)} ${num(x)} ${num(y1 - r)} c`,
      `${num(x)} ${num(y0 + r)} l`, `${num(x)} ${num(y0 + r - k)} ${num(x + r - k)} ${num(y0)} ${num(x + r)} ${num(y0)} c h`].join(' ');
    this.op(`${fill ? `${rgb(fill)} rg ` : ''}${stroke ? `${rgb(stroke)} RG ${lw} w ` : ''}${p} ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`);
  }

  /* text */
  drawLine(ln, x, yTop, size, lead, color) {
    const base = yTop + (lead + size * 0.7) / 2;
    let cx = x, seg = null;
    const flush = () => {
      if (!seg) return;
      const fs = fontSize(seg.f, size), col = seg.url ? LINK : seg.color || color;
      this.op(`BT /${FONT_NAME[seg.f]} ${num(fs)} Tf ${rgb(col)} rg ${num(cx)} ${num(Y(base))} Td ${pdfString(seg.s)} Tj ET`);
      if (seg.url) {
        this.op(`${rgb(LINK)} RG 0.5 w ${num(cx)} ${num(Y(base) - 1.6)} m ${num(cx + seg.w)} ${num(Y(base) - 1.6)} l S`);
        this.page.links.push({ rect: [cx, Y(base) - 3, cx + seg.w, Y(base) + size * 0.8], url: seg.url });
      }
      cx += seg.w; seg = null;
    };
    for (const t of ln.toks) {
      if (seg && seg.f === t.f && seg.url === t.url && seg.color === t.color) { seg.s += t.s; seg.w += t.w; }
      else { flush(); seg = { s: t.s, f: t.f, url: t.url, w: t.w, color: t.color }; }
    }
    flush();
  }
  /** A paragraph. Page breaks between lines; `keep` lines must fit together at the bottom. */
  text(runs, { x = ML, w = CW, size = 10.5, lead = size * 1.45, color = INK, after = 0, keep = 1 } = {}) {
    const lines = wrapRuns(runs, size, w);
    this.ensure(lead * Math.min(lines.length, keep));
    for (const ln of lines) { this.ensure(lead); this.drawLine(ln, x, this.y, size, lead, color); this.y += lead; }
    this.y += after;
    return lines.length;
  }
  plain(s, f = 'r', o = {}) { return this.text([{ t: s, f }], o); }
  rightText(s, f, size, color, yTop) {
    const w = textWidth(s, f, size);
    this.op(`BT /${FONT_NAME[f]} ${num(size)} Tf ${rgb(color)} rg ${num(PW - MR - w)} ${num(Y(yTop + size))} Td ${pdfString(s)} Tj ET`);
  }

  chip(x, yTop, label, style, size = 8) {
    const w = textWidth(label, 'b', size) + 12, h = 15;
    this.round(x, yTop, w, h, 3, { fill: style.fill, stroke: style.stroke });
    this.op(`BT /F2 ${num(size)} Tf ${rgb(style.color)} rg ${num(x + 6)} ${num(Y(yTop + h / 2 + size * 0.34))} Td ${pdfString(label)} Tj ET`);
    return w;
  }
  chipRow(list, { gap = 6 } = {}) { // wraps to a new row when full
    let x = ML;
    this.ensure(22);
    for (const [label, style] of list) {
      const w = textWidth(label, 'b', 8) + 12;
      if (x + w > ML + CW && x > ML) { x = ML; this.y += 21; this.ensure(22); }
      this.chip(x, this.y, label, style); x += w + gap;
    }
    this.y += 21;
  }

  /* images */
  imageIndex(img) { let i = this.imgList.indexOf(img); if (i < 0) { this.imgList.push(img); i = this.imgList.length - 1; } return i + 1; }
  drawImage(img, x, yTop, w, h) {
    const n = this.imageIndex(img);
    this.page.imgs.add(n);
    this.op(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(Y(yTop + h))} cm /Im${n} Do Q`);
  }
  imageFor(src) { const m = /^images\/([^/]+)$/.exec(String(src)); return m ? this.images[m[1]] || null : null; }
  measureFigure(b, w, k = 1) { // size of a screenshot at a given width; k < 1 shrinks it to fit the space left on the page
    const img = this.imageFor(b.src);
    const s = img ? Math.min(w / img.width, 330 / img.height, 1.6) : 0;
    const dw = img ? img.width * s * k : w, dh = img ? img.height * s * k : 46;
    return { img, dw, dh };
  }
  /** How much to shrink a block of screenshots (height imgH, plus captionH of text) to finish on this page. 1 = it fits as it is; 0 = start a new page. */
  fitFactor(imgH, captionH) {
    if (imgH + captionH <= this.room() || this.y <= MT + 1) return 1;
    const k = (this.room() - captionH) / imgH;
    return k >= 0.62 ? k : 0; // a figure is only shrunk a little; much smaller would be unreadable, so it moves to the next page instead
  }
  captionLines(n, b, w) {
    const runs = [{ t: `Figure ${n}`, f: 'b' }, ...(b.caption ? [{ t: '. ', f: 'b' }, ...inlineRuns(b.caption, 'i', this.baseUrl)] : [])];
    return wrapRuns(runs, 8.5, w);
  }
  paintFigure(b, x, yTop, w, n, k = 1) { // returns the height used
    const { img, dw, dh } = this.measureFigure(b, w, k);
    if (img) { this.drawImage(img, x, yTop, dw, dh); this.op(`${rgb(LINE)} RG 0.6 w ${num(x)} ${num(Y(yTop + dh))} ${num(dw)} ${num(dh)} re S`); }
    else {
      this.fillRect(x, yTop, w, dh, WASH);
      this.drawLine(wrapRuns([{ t: `Screenshot not available: ${String(b.src).replace(/^images\//, '')}`, f: 'i' }], 9, w - 16)[0], x + 8, yTop + 14, 9, 14, SOFT);
    }
    const lines = this.captionLines(n, b, w);
    let y = yTop + dh + 4;
    for (const ln of lines) { this.drawLine(ln, x, y, 8.5, 12, SOFT); y += 12; }
    return y - yTop;
  }
  figure(b, { x = ML, w = CW } = {}) {
    const n = this.fig + 1;
    const { dh } = this.measureFigure(b, w), captionH = 4 + this.captionLines(n, b, w).length * 12;
    let k = this.fitFactor(dh, captionH);
    if (k === 0) { this.newPage(); k = 1; }
    this.fig = n;
    this.y += this.paintFigure(b, x, this.y, w, n, k) + 10;
  }
  gallery(images, { x = ML, w = CW } = {}) {
    for (let i = 0; i < images.length; i += 3) {
      const row = images.slice(i, i + 3), gapW = 10, cw = (w - gapW * (row.length - 1)) / row.length;
      const nums = row.map((_, j) => this.fig + j + 1);
      const imgH = Math.max(...row.map((b) => this.measureFigure(b, cw).dh));
      const captionH = Math.max(...row.map((b, j) => 4 + this.captionLines(nums[j], b, cw).length * 12));
      let k = this.fitFactor(imgH, captionH);
      if (k === 0) { this.newPage(); k = 1; }
      const h = Math.max(...row.map((b, j) => this.measureFigure(b, cw, k).dh + 4 + this.captionLines(nums[j], b, cw).length * 12));
      row.forEach((b, j) => this.paintFigure(b, x + j * (cw + gapW), this.y, cw, nums[j], k));
      this.fig += row.length;
      this.y += h + 10;
    }
  }

  /* blocks */
  callout(text, tone, { x = ML, w = CW } = {}) {
    const important = tone === 'important', pad = 8;
    const lines = wrapRuns(inlineRuns(text, 'r', this.baseUrl), 10, w - pad * 2 - 4);
    const h = pad * 2 + 11 + lines.length * 14;
    this.ensure(h);
    const top = this.y;
    this.fillRect(x, top, w, h, important ? AMBER_BG : WASH);
    this.fillRect(x, top, 3, h, important ? AMBER : BLUE);
    this.op(`BT /F2 7.5 Tf ${rgb(important ? AMBER : LINK)} rg ${num(x + pad + 3)} ${num(Y(top + pad + 7))} Td ${pdfString(important ? 'IMPORTANT' : 'NOTE')} Tj ET`);
    let y = top + pad + 11;
    for (const ln of lines) { this.drawLine(ln, x + pad + 3, y, 10, 14, INK); y += 14; }
    this.y = top + h + 9;
  }
  list(b, { x = ML, w = CW } = {}) {
    b.items.forEach((it, i) => {
      const runs = inlineRuns(it, 'r', this.baseUrl);
      this.ensure(15);
      const mark = b.ordered ? `${i + 1}.` : '•';
      this.op(`BT /F1 10.5 Tf ${rgb(b.ordered ? INK : BLUE)} rg ${num(x + 3)} ${num(Y(this.y + (15 + 10.5 * 0.7) / 2))} Td ${pdfString(mark)} Tj ET`);
      this.text(runs, { x: x + 18, w: w - 18, size: 10.5, lead: 15, color: INK, after: 3 });
    });
    this.y += 4;
  }
  steps(b, { x = ML, w = CW } = {}) {
    const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
    const tx = x + 28, tw = w - 28;
    b.items.forEach((s, i) => {
      this.ensure(60);
      const top = this.y;
      this.round(x, top, 19, 19, 9.5, { fill: NAVY });
      const n = String(i + 1), nw = textWidth(n, 'b', 9);
      this.op(`BT /F2 9 Tf ${rgb(WHITE)} rg ${num(x + 9.5 - nw / 2)} ${num(Y(top + 13))} Td ${pdfString(n)} Tj ET`);
      this.text(inlineRuns(s.title, 'b', this.baseUrl), { x: tx, w: tw, size: 11, lead: 16, color: INK, after: 2, keep: 2 });
      const meta = [s.audience ? `For ${s.audience}` : '', s.path?.length ? `Menu: ${s.path.join(' › ')}` : ''].filter(Boolean).join('   ·   ');
      if (meta) this.plain(meta, 'r', { x: tx, w: tw, size: 9, lead: 13, color: SOFT, after: 3 });
      for (const t of asList(s.text)) this.text(inlineRuns(t, 'r', this.baseUrl), { x: tx, w: tw, size: 10.5, lead: 15, color: INK, after: 5 });
      const imgs = s.images ?? [];
      if (imgs.length > 1) this.gallery(imgs, { x: tx, w: tw }); else if (imgs.length === 1) this.figure(imgs[0], { x: tx, w: tw });
      if (s.note) this.callout(s.note, 'note', { x: tx, w: tw });
      this.y += 6;
    });
  }
  /** A numbered part of a feature: "Section 2" and its title, then its own text and screenshots. */
  section(b, n) {
    if (n > 1) { this.ensure(80); this.hRule(this.y + 2, LINE); this.y += 18; } else { this.y += 8; this.ensure(70); }
    const label = `Section ${n}`, cw = textWidth(label, 'b', 8) + 12, top = this.y;
    this.chip(ML, top, label, CHIP.section);
    if (b.title) {
      this.text(inlineRuns(b.title, 'b', this.baseUrl), { x: ML + cw + 10, w: CW - cw - 10, size: 12.5, lead: 17, color: INK, keep: 2 });
      this.y = Math.max(this.y, top + 15) + 6;
    } else this.y += 21;
    this.y += 4;
    for (const inner of b.body ?? []) this.block(inner);
  }
  block(b) {
    switch (b.type) {
      case 'p': this.text(inlineRuns(b.text, 'r', this.baseUrl), { size: 10.5, lead: 15, color: INK, after: 7 }); break;
      case 'heading': this.text(inlineRuns(b.text, 'b', this.baseUrl), { size: 11.5, lead: 16, color: INK, after: 3, keep: 3 }); break;
      case 'list': this.list(b); break;
      case 'image': this.figure(b); break;
      case 'gallery': this.gallery(b.images ?? []); break;
      case 'callout': this.callout(b.text, b.tone); break;
      case 'steps': this.steps(b); break;
      default: break;
    }
  }
  linkLines(links, o = {}) {
    for (const l of links) {
      const url = resolveUrl(l.url, this.baseUrl);
      const runs = [{ t: `${l.label}: `, f: 'b' }, url ? { t: l.url, f: 'r', url } : { t: String(l.url), f: 'r' }];
      this.text(runs, { size: 10, lead: 14.5, color: INK, after: 2, ...o });
    }
  }
  item(it) {
    const cat = CAT[it.category];
    this.ensure(96);
    const w = this.chip(ML, this.y, categoryLabel(it, this.totals, this.nums), CHIP[cat.id]);
    const meta = [it.module, (it.audience ?? []).length ? `For ${it.audience.join(', ')}` : ''].filter(Boolean).join('   ·   ');
    if (meta) this.op(`BT /F1 9 Tf ${rgb(SOFT)} rg ${num(ML + w + 9)} ${num(Y(this.y + 10.6))} Td ${pdfString(meta)} Tj ET`);
    this.y += 23;
    this.text([{ t: it.title, f: 'b' }], { size: 13.5, lead: 18, color: INK, after: 4, keep: 2 });
    if (it.summary) this.text(inlineRuns(it.summary, 'r', this.baseUrl), { size: 10.5, lead: 15, color: SOFT, after: 7 });
    let part = 0;
    for (const b of it.body ?? []) { if (b.type === 'section') this.section(b, ++part); else this.block(b); }
    if (it.links?.length) { this.y += 2; this.linkLines(it.links); }
    this.y += 4;
    this.hRule(this.y);
    this.y += 16;
  }
}

/* ------------------------------------------------------------------ the release note */
export const pdfFileName = (entry) => `RevGen-i-release-notes-v${String(entry.version).replace(/[^0-9A-Za-z.-]/g, '')}${entry.status === 'draft' ? '-draft' : ''}.pdf`;

/**
 * @param entry    the release's releases.json entry
 * @param content  its content.json
 * @param images   {fileName: {jpeg: Uint8Array, width, height}}: each screenshot already as a JPEG (the browser converts them)
 * @param logo     optional {jpeg, width, height} for the page header
 * @param baseUrl  where the release page lives, to turn relative links into clickable addresses (optional)
 * @param now      the creation time written into the file
 * @returns Uint8Array: the PDF file
 */
export function buildReleasePdf({ entry, content, images = {}, logo = null, baseUrl = '', now = new Date() }) {
  const L = new Layout({ images, baseUrl });
  const items = (content.items ?? []).filter((i) => CAT[i.category]);
  L.totals = {}; L.nums = new Map(); // "New feature 1", "New feature 2": numbered within a kind, when there are several
  for (const it of items) { L.totals[it.category] = (L.totals[it.category] ?? 0) + 1; L.nums.set(it, L.totals[it.category]); }
  const overview = content.overview === undefined ? [] : Array.isArray(content.overview) ? content.overview : [content.overview];
  const draft = entry.status === 'draft';

  /* masthead */
  const lh = 26;
  if (logo) L.drawImage(logo, ML, L.y, (logo.width / logo.height) * lh, lh);
  L.rightText('Release notes', 'r', 9, SOFT, L.y + 9);
  L.y += lh + 11;
  L.hRule(L.y);
  L.y += 24;

  const ver = `v${entry.version}`;
  L.op(`BT /F2 28 Tf ${rgb(INK)} rg ${num(ML)} ${num(Y(L.y + 24))} Td ${pdfString(ver)} Tj ET`);
  L.op(`BT /F1 11 Tf ${rgb(SOFT)} rg ${num(ML + textWidth(ver, 'b', 28) + 14)} ${num(Y(L.y + 24))} Td ${pdfString(formatDate(entry.date))} Tj ET`);
  L.y += 40;
  L.chipRow([
    [TYPES[entry.type] ?? 'Release', CHIP[`type-${entry.type}`] ?? CHIP['type-minor']],
    ...(entry.featured ? [['Featured', CHIP.featured]] : []),
    ...(draft ? [['Draft', CHIP.draft]] : []),
    ...(entry.sample ? [['Sample', CHIP.sample]] : []),
  ]);
  L.y += 6;
  L.text([{ t: entry.title, f: 'b' }], { size: 21, lead: 26, color: INK, after: 7, keep: 2 });
  if (entry.summary) L.text(inlineRuns(entry.summary, 'r', baseUrl), { size: 12, lead: 17.5, color: SOFT, after: 10 });
  if (draft) L.callout('**Draft.** This release is not published. It stays hidden from the website until it is published.', 'important');
  else if (entry.sample) L.callout('**Sample release.** This holds illustrative content to show how the portal looks. It is not a real RevGen-i release.', 'note');
  if (content.links?.length) { L.y += 2; L.linkLines(content.links); L.y += 4; }

  const counts = CATEGORIES.map((c) => [c, items.filter((i) => i.category === c.id).length]).filter(([, n]) => n);
  if (counts.length) { L.y += 4; L.chipRow(counts.map(([c, n]) => [`${n} ${n === 1 ? c.label : c.plural}`, CHIP[c.id]])); }
  L.y += 4;
  L.hRule(L.y);
  L.y += 22;

  /* overview, then the sections */
  if (overview.length) {
    L.plain('Overview', 'b', { size: 15, lead: 20, color: INK, after: 7, keep: 3 });
    for (const p of overview) L.text(inlineRuns(p, 'r', baseUrl), { size: 10.5, lead: 15.5, color: INK, after: 8 });
    L.y += 12;
  }
  for (const sec of SECTIONS) {
    const list = items.filter((i) => sec.cats.includes(i.category));
    if (!list.length) continue;
    L.ensure(120);
    L.plain(`${sec.title}  `, 'b', { size: 15, lead: 20, color: INK, after: 0, keep: 4 });
    L.y -= 20; // draw the count on the same line as the heading
    L.op(`BT /F1 11 Tf ${rgb(SOFT)} rg ${num(ML + textWidth(`${sec.title}  `, 'b', 15))} ${num(Y(L.y + 14.6))} Td ${pdfString(String(list.length))} Tj ET`);
    L.y += 24;
    L.hRule(L.y - 4, NAVY);
    L.y += 10;
    for (const it of list) L.item(it);
    L.y += 6;
  }
  if (!items.length) L.plain('This release has no items yet.', 'i', { size: 10.5, color: SOFT });

  L.ensure(46);
  L.y += 6;
  L.text([{ t: 'For any concerns, please contact ', f: 'r' }, { t: 'support@commitmd.us', f: 'r', url: 'mailto:support@commitmd.us' }, { t: '.', f: 'r' }], { size: 10, lead: 14, color: SOFT });

  return assemble(L, { title: `RevGen-i v${entry.version}: ${entry.title}`, now, footer: `RevGen-i release notes  ·  ${ver}` });
}

/* ------------------------------------------------------------------ the file */
function assemble(L, { title, now, footer }) {
  const total = L.pages.length;
  L.pages.forEach((p, i) => { // footer on every page, now that the page count is known
    p.ops.push(`${rgb(LINE)} RG 0.6 w ${num(ML)} ${num(46)} m ${num(ML + CW)} ${num(46)} l S`);
    p.ops.push(`BT /F1 8 Tf ${rgb(SOFT)} rg ${num(ML)} 32 Td ${pdfString(footer)} Tj ET`);
    const label = `Page ${i + 1} of ${total}`;
    p.ops.push(`BT /F1 8 Tf ${rgb(SOFT)} rg ${num(PW - MR - textWidth(label, 'r', 8))} 32 Td ${pdfString(label)} Tj ET`);
  });

  const objs = []; // objs[n] = Uint8Array body of object n (index 0 unused)
  const put = (n, body) => { objs[n] = typeof body === 'string' ? latin1(body) : body; };
  const stream = (dict, data) => {
    const bytes = typeof data === 'string' ? latin1(data) : data;
    const head = latin1(`<< ${dict} /Length ${bytes.length} >>\nstream\n`), tail = latin1('\nendstream');
    const out = new Uint8Array(head.length + bytes.length + tail.length);
    out.set(head, 0); out.set(bytes, head.length); out.set(tail, head.length + bytes.length);
    return out;
  };
  const CATALOG = 1, PAGES = 2, INFO = 3, FONT0 = 4, IMG0 = FONT0 + 4;
  let next = IMG0 + L.imgList.length;

  put(FONT0, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  put(FONT0 + 1, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  put(FONT0 + 2, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>');
  put(FONT0 + 3, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  L.imgList.forEach((img, i) => put(IMG0 + i, stream(`/Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, img.jpeg)));

  const kids = [];
  for (const p of L.pages) {
    const pageNo = next++, contentNo = next++;
    const annots = p.links.map((l) => {
      const n = next++;
      put(n, `<< /Type /Annot /Subtype /Link /Rect [${l.rect.map(num).join(' ')}] /Border [0 0 0] /A << /S /URI /URI ${asciiUrl(l.url)} >> >>`);
      return n;
    });
    put(contentNo, stream('', p.ops.join('\n')));
    const xobjects = [...p.imgs].map((n) => `/Im${n} ${IMG0 + n - 1} 0 R`).join(' ');
    put(pageNo, `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 ${num(PW)} ${num(PH)}] /Resources << /Font << /F1 ${FONT0} 0 R /F2 ${FONT0 + 1} 0 R /F3 ${FONT0 + 2} 0 R /F4 ${FONT0 + 3} 0 R >>${xobjects ? ` /XObject << ${xobjects} >>` : ''} >> /Contents ${contentNo} 0 R${annots.length ? ` /Annots [${annots.map((n) => `${n} 0 R`).join(' ')}]` : ''} >>`);
    kids.push(pageNo);
  }
  put(PAGES, `<< /Type /Pages /Kids [${kids.map((n) => `${n} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  put(CATALOG, `<< /Type /Catalog /Pages ${PAGES} 0 R /Lang (en) /ViewerPreferences << /DisplayDocTitle true >> >>`);
  const d = now instanceof Date ? now : new Date(now), p2 = (v) => String(v).padStart(2, '0');
  const stamp = `D:${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
  put(INFO, `<< /Title ${utf16Hex(title)} /Author ${utf16Hex('RevGen-i release notes')} /Subject ${utf16Hex('Release notes')} /Creator ${utf16Hex('RevGen-i release composer')} /Producer ${utf16Hex('RevGen-i release composer')} /CreationDate (${stamp}) >>`);

  const parts = [latin1('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')], offsets = [];
  let pos = parts[0].length;
  for (let n = 1; n < next; n += 1) {
    offsets[n] = pos;
    const head = latin1(`${n} 0 obj\n`), tail = latin1('\nendobj\n');
    parts.push(head, objs[n], tail);
    pos += head.length + objs[n].length + tail.length;
  }
  let xref = `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let n = 1; n < next; n += 1) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  parts.push(latin1(`${xref}trailer\n<< /Size ${next} /Root ${CATALOG} 0 R /Info ${INFO} 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
