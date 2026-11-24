// Pure helpers for the composer page's editing comforts: the formatting buttons for the Details box, problems shown next
// to each field, and the locally saved draft. No DOM and no network, so they run in the browser and in Node
// (tools/tests/composer.test.mjs tests them).
import { CATEGORIES, isIsoDate, isSemver, itemSections } from './core.mjs';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const hasText = (v) => typeof v === 'string' && v.trim() !== '';
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/* ------------------------------------------------------------------ formatting buttons for the Details box */
const LINE = { note: '> ', important: '!> ', bullet: '- ', heading: '## ' };
const HAS = { note: /^>\s?/, important: /^!>\s?/, bullet: /^[-*]\s+/, numbered: /^\d+[.)]\s+/, heading: /^##\s+/ };
const ANY_PREFIX = /^(?:!>\s?|>\s?|[-*]\s+|\d+[.)]\s+|#{2,3}\s+)/;
const PLACEHOLDER = { note: 'Note text', important: 'Important text', bullet: 'List item', numbered: 'First item', heading: 'Heading', step: 'Step title', bold: 'bold text' };

/**
 * Applies one formatting button to the Details text. kind: bold | step | note | important | bullet | numbered | heading.
 * Returns the new text and the selection to restore. Line buttons act on every line touched by the selection and toggle
 * off when all of them already have that format.
 */
export function applySyntax(text, start, end, kind) {
  text = String(text ?? '');
  start = clamp(Number.isFinite(start) ? start : text.length, 0, text.length);
  end = clamp(Number.isFinite(end) ? end : start, start, text.length);
  const sel = text.slice(start, end);

  if (kind === 'bold') {
    const t = sel || PLACEHOLDER.bold;
    return { text: `${text.slice(0, start)}**${t}**${text.slice(end)}`, start: start + 2, end: start + 2 + t.length };
  }
  if (kind === 'step') { // a new numbered step, on its own paragraph
    const before = text.slice(0, start), after = text.slice(end);
    const lead = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const title = sel.trim().replace(/\s*\n\s*/g, ' ') || PLACEHOLDER.step;
    const s = before.length + lead.length + 4;
    return { text: `${before}${lead}### ${title}\n${after}`, start: s, end: s + title.length };
  }
  if (!HAS[kind]) return { text, start, end };

  const ls = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
  const lastChar = end > start && text[end - 1] === '\n' ? end - 1 : end; // a selection that ends right after a line break does not include the next line
  let le = text.indexOf('\n', lastChar);
  if (le < 0) le = text.length;
  const lines = text.slice(ls, le).split('\n');
  const filled = lines.filter((l) => l.trim());
  if (!filled.length) { // an empty line: start the format with a placeholder to type over
    const pre = kind === 'numbered' ? '1. ' : LINE[kind], ph = PLACEHOLDER[kind];
    return { text: `${text.slice(0, ls)}${pre}${ph}${text.slice(le)}`, start: ls + pre.length, end: ls + pre.length + ph.length };
  }
  const allHave = filled.every((l) => HAS[kind].test(l));
  let n = 0;
  const block = lines.map((l) => {
    if (!l.trim()) return l;
    const bare = l.replace(ANY_PREFIX, '');
    if (allHave) return bare;
    n += 1;
    return (kind === 'numbered' ? `${n}. ` : LINE[kind]) + bare;
  }).join('\n');
  return { text: `${text.slice(0, ls)}${block}${text.slice(le)}`, start: ls, end: ls + block.length };
}

/** Puts [[image N]] on its own line at the cursor. */
export function insertImageTag(text, start, end, n) {
  text = String(text ?? '');
  start = clamp(Number.isFinite(start) ? start : text.length, 0, text.length);
  end = clamp(Number.isFinite(end) ? end : start, start, text.length);
  const before = text.slice(0, start), after = text.slice(end);
  const lead = !before || before.endsWith('\n') ? '' : '\n';
  const tag = `[[image ${n}]]`;
  const tail = after.startsWith('\n') ? '' : '\n';
  const caret = before.length + lead.length + tag.length + 1;
  return { text: `${before}${lead}${tag}${tail}${after}`, start: caret, end: caret };
}

/* ------------------------------------------------------------------ problems, per field */
/**
 * What is wrong with the form, field by field, in short friendly words. model is what readModel() returns;
 * ctx = {existingVersions}. Used to mark fields, to tick the progress steps and to jump to the first problem.
 */
export function fieldIssues(model, ctx = {}) {
  const meta = {};
  if (!isSemver(model.version)) meta.version = 'Use three numbers, like 2.43.0.';
  else if ((ctx.existingVersions || []).includes(model.version)) meta.version = `v${model.version} already exists. Use a new number.`;
  if (!isIsoDate(model.date)) meta.date = 'Choose a date.';
  if (!hasText(model.title)) meta.title = 'Add a title.';
  if (!hasText(model.summary) && model.status !== 'draft') meta.summary = 'Add a summary of one or two sentences.';
  const items = (model.items || []).map((it) => {
    const o = {}, secs = itemSections(it);
    if (!CATEGORIES.some((c) => c.id === it.category)) o.category = 'Choose what kind of change this is.';
    if (!hasText(it.title)) o.title = 'Add a title.';
    if (!hasText(it.summary) && !secs.some((s) => hasText(s.body))) o.desc = 'Add a short description or some details.';
    // each section: a titled one needs something in it (an untitled empty one is simply left out); screenshots need a description
    o.secs = secs.map((s) => ({
      empty: hasText(s.title) && !hasText(s.body) && !(s.images || []).length ? 'Add some text or a screenshot to this section, or remove it.' : '',
      shots: (s.images || []).map((im) => (hasText(im.alt) ? '' : 'Describe what the screenshot shows, for people who cannot see it.')),
    }));
    return o;
  });
  const itemOk = (o) => !o.category && !o.title && !o.desc && o.secs.every((s) => !s.empty && s.shots.every((x) => !x));
  return { meta, items, detailsOk: Object.keys(meta).length === 0, changesOk: items.length > 0 && items.every(itemOk) };
}

/** Selectors of the fields that have a problem, in the order they appear on the page. */
export function problemOrder(issues) {
  const out = [];
  for (const k of ['version', 'date', 'title', 'summary']) if (issues.meta[k]) out.push({ sel: `#${k}`, item: -1, sec: -1 });
  issues.items.forEach((o, i) => {
    const at = `.item-form[data-i="${i}"]`;
    if (o.category) out.push({ sel: `${at} input[data-f="category"]`, item: i, sec: -1 });
    if (o.title) out.push({ sel: `${at} [data-f="title"]`, item: i, sec: -1 });
    if (o.desc) out.push({ sel: `${at} [data-f="summary"]`, item: i, sec: -1 });
    o.secs.forEach((s, j) => {
      if (s.empty) out.push({ sel: `${at} .part[data-s="${j}"] [data-sf="body"]`, item: i, sec: j });
      s.shots.forEach((m, k) => { if (m) out.push({ sel: `${at} .part[data-s="${j}"] .shot-row[data-k="${k}"] [data-img="alt"]`, item: i, sec: j }); });
    });
  });
  return out;
}

/** Where a validation message points: {sel, item} for a field to focus, or null when it is about the whole release. */
export function jumpTarget(message) {
  const m = String(message).match(/^Item (\d+)(?:[^,:(]*)?(?:, section (\d+))?/);
  if (m) {
    const item = Number(m[1]) - 1, at = `.item-form[data-i="${item}"]`;
    return m[2] ? { sel: `${at} .part[data-s="${Number(m[2]) - 1}"]`, item, sec: Number(m[2]) - 1 } : { sel: at, item, sec: -1 };
  }
  if (/^Version/.test(message)) return { sel: '#version', item: -1, sec: -1 };
  if (/release date/i.test(message)) return { sel: '#date', item: -1, sec: -1 };
  if (/release title/i.test(message)) return { sel: '#title', item: -1, sec: -1 };
  if (/summary/i.test(message)) return { sel: '#summary', item: -1, sec: -1 };
  if (/^The JSON/.test(message)) return { sel: '#json', item: -1, sec: -1 };
  return null;
}

/* ------------------------------------------------------------------ the draft kept in this browser */
export const DRAFT_KEY = 'rn-admin-draft';
const STR_MAX = 100000;
const str = (v) => (typeof v === 'string' ? v.slice(0, STR_MAX) : '');
const KINDS = ['video', 'demo', 'docs', 'other'];

/** The text of the form (never the token, never the screenshots) as a small object to store. */
export function makeDraft({ form, links, items }, now = Date.now()) {
  return {
    v: 1, at: now,
    form: {
      version: str(form.version), date: str(form.date), type: form.type, status: form.status, featured: form.featured === true,
      title: str(form.title), summary: str(form.summary), tags: str(form.tags), overview: str(form.overview),
    },
    links: (links || []).map((l) => ({ label: str(l.label), url: str(l.url), kind: l.kind })),
    items: (items || []).map((it) => ({
      category: it.category, title: str(it.title), module: str(it.module), audience: str(it.audience), summary: str(it.summary),
      sections: itemSections(it).map((s) => ({ title: str(s.title), body: str(s.body), shots: (s.images || []).length })),
    })),
  };
}

/** Reads what was stored, defensively (it could be anything). Returns null when it is not a usable draft. */
export function readDraft(raw) {
  let d;
  try { d = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!isObj(d) || d.v !== 1 || typeof d.at !== 'number' || !isObj(d.form)) return null;
  const f = d.form;
  return {
    at: d.at,
    form: {
      version: str(f.version), date: str(f.date), type: ['major', 'minor', 'patch'].includes(f.type) ? f.type : 'minor',
      status: f.status === 'draft' ? 'draft' : 'published', featured: f.featured === true,
      title: str(f.title), summary: str(f.summary), tags: str(f.tags), overview: str(f.overview),
    },
    links: (Array.isArray(d.links) ? d.links : []).slice(0, 50).map((l) => ({ label: str(l?.label), url: str(l?.url), kind: KINDS.includes(l?.kind) ? l.kind : 'other' })),
    items: (Array.isArray(d.items) ? d.items : []).slice(0, 200).map((it) => {
      const count = (v) => (Number.isInteger(v) && v > 0 ? Math.min(v, 1000) : 0);
      // a draft saved before sections existed has one `body` and one `shots` count per feature: that is a single section
      const raw = Array.isArray(it?.sections) ? it.sections : [{ title: '', body: it?.body, shots: it?.shots }];
      const sections = raw.slice(0, 50).map((s) => ({ title: str(s?.title), body: str(s?.body), shots: count(s?.shots) }));
      return {
        category: CATEGORIES.some((c) => c.id === it?.category) ? it.category : '',
        title: str(it?.title), module: str(it?.module), audience: str(it?.audience), summary: str(it?.summary),
        sections, shots: sections.reduce((n, s) => n + s.shots, 0),
      };
    }),
  };
}

/** A draft with nothing worth keeping (so it is neither saved nor offered back). */
export const isBlankDraft = (d) => !(
  d.form.title.trim() || d.form.summary.trim() || d.form.overview.trim()
  || d.links.some((l) => l.label.trim() || l.url.trim())
  || d.items.some((it) => it.title.trim() || it.summary.trim() || it.sections.some((s) => s.title.trim() || s.body.trim()))
);

export function timeAgo(then, now = Date.now()) {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
