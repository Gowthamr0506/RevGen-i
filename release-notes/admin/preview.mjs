// Builds the preview of a release page for the composer. No DOM, no network: it takes the release data and returns an HTML
// document. The page itself is drawn by assets/js/render-shared.mjs, the same code the website build runs, so the preview is
// the page that will be published. The composer shows the result in a sandboxed iframe (admin.mjs).
import { CATEGORIES, TYPES, esc, renderReleaseMain } from '../assets/js/render-shared.mjs';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ITEM_ID = /^[a-z0-9][a-z0-9-]*$/;
const isIsoDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

const DRAFT_BANNER = '<div class="banner banner-draft" role="note"><strong>Draft.</strong> This release is not published. It stays hidden from the website until you publish it.</div>';

/**
 * Makes whatever the form (or a hand-edited JSON) holds safe and complete enough to draw, and says what had to be filled in.
 * The page is meant to be shown while the release is still being written, so gaps are covered with placeholders, never errors.
 * Returns {entry, content, missing:[what was filled in], omitted:[items left out]}.
 */
export function prepare(entry, content, today) {
  const missing = [], omitted = [];
  const e = { ...entry, status: entry?.status === 'draft' ? 'draft' : 'published' };
  if (!SEMVER.test(String(e.version))) { missing.push('the version number'); e.version = '0.0.0'; }
  if (!isIsoDate(e.date)) { missing.push('the release date'); e.date = today; }
  if (!TYPES[e.type]) e.type = 'minor';
  if (!String(e.title ?? '').trim()) { missing.push('the title'); e.title = 'Untitled release'; }

  const c = isObj(content) ? { ...content } : {};
  c.items = [];
  (isObj(content) && Array.isArray(content.items) ? content.items : []).forEach((raw, n) => {
    if (!isObj(raw) || !CATEGORIES.some((k) => k.id === raw.category)) {
      omitted.push(`Item ${n + 1}${isObj(raw) && String(raw.title || '').trim() ? ` (“${String(raw.title).trim()}”)` : ''}`);
      return;
    }
    const it = { ...raw };
    if (it.id !== undefined && !ITEM_ID.test(String(it.id))) delete it.id; // the title's slug is used instead
    if (Array.isArray(it.body)) it.body = it.body.map((b) => (isObj(b) && b.type === 'callout' && b.tone !== 'important' ? { ...b, tone: 'note' } : b));
    c.items.push(it);
  });
  return { entry: e, content: c, missing, omitted };
}

/**
 * The full HTML document for the preview iframe.
 * @param imageUrls  {fileName: url} for screenshots the browser holds (blob: URLs), looked up from "images/<fileName>"
 * @param imageInfo  (src) => {w,h} | undefined, optional
 * @param skip, header, footer  markup copied from the composer page so the preview has the real brand header and footer
 * Throws if the content cannot be drawn (the caller shows a message).
 */
export function previewDocument({ entry, content, imageUrls = {}, imageInfo, skip = '', header = '', footer = '', root = '../' }) {
  const imgSrc = (src) => {
    const m = /^images\/([^/]+)$/.exec(String(src));
    return m && Object.prototype.hasOwnProperty.call(imageUrls, m[1]) ? imageUrls[m[1]] : encodeURI(src);
  };
  const main = renderReleaseMain({ entry, content, root, imageInfo, imgSrc, banner: entry.status === 'draft' ? DRAFT_BANNER : undefined });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`v${entry.version}: ${entry.title}`)} (preview)</title>
<link rel="stylesheet" href="../assets/css/fonts.css">
<link rel="stylesheet" href="../assets/css/portal.css">
</head>
<body class="page-release" data-root="../" data-version="${entry.version}" data-status="${entry.status}">
${skip}
${header}
${main}
${footer}
</body></html>`;
}

/** The sentence(s) shown above the preview about what has been filled in or left out. */
export function describeGaps({ missing, omitted }) {
  const list = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
  const out = [];
  if (missing.length) out.push(`Not filled in yet, so a placeholder is shown for ${list(missing)}.`);
  if (omitted.length) out.push(`${list(omitted)} ${omitted.length === 1 ? 'is' : 'are'} left out because ${omitted.length === 1 ? 'it has' : 'they have'} no category yet.`);
  return out;
}
