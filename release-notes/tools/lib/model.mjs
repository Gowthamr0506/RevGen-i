// Load and validate releases.json + every releases/vX.Y.Z/content.json, and compute the derived index fields.
import fs from 'node:fs';
import path from 'node:path';
import {
  CATEGORY_IDS, IMAGE_EXT, SEMVER, STATUSES, TYPES, clearFsCache, compareVersions, existsExact, findCaseInsensitive,
  formatBytes, isIsoDate, isSafeUrl, normalizeVersion, readText, releaseOrder, slugify, typeFromVersion,
} from './util.mjs';
import { readImageInfo } from './images.mjs';
import { itemId } from '../../assets/js/render-shared.mjs';

export const SECTION_IDS = ['overview', 'new-features', 'enhancements-improvements', 'bug-fixes'];
const AUTHORED = ['version', 'date', 'type', 'status', 'featured', 'sample', 'page', 'title', 'summary', 'tags', 'derived'];
const BLOCK_TYPES = ['p', 'heading', 'list', 'image', 'gallery', 'steps', 'callout'];
const LINK_KINDS = ['video', 'demo', 'docs', 'other'];
const MAX_IMAGE_BYTES = 1024 * 1024;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';

export class Report {
  constructor() { this.items = []; }
  err(file, message) { this.items.push({ level: 'error', file, message }); }
  warn(file, message) { this.items.push({ level: 'warning', file, message }); }
  get errors() { return this.items.filter((i) => i.level === 'error'); }
  get warnings() { return this.items.filter((i) => i.level === 'warning'); }
}

export { itemId };
export const releaseDir = (version) => `releases/v${version}`;

/** Every image referenced by a content file, with a human-readable location. */
export function* walkImages(content) {
  if (content?.cover) yield { img: content.cover, where: 'cover' };
  for (const [i, item] of (content?.items ?? []).entries()) {
    for (const [b, block] of (item.body ?? []).entries()) {
      const at = `items[${i}].body[${b}]`;
      if (block.type === 'image') yield { img: block, where: at };
      if (block.type === 'gallery') for (const [g, img] of (block.images ?? []).entries()) yield { img, where: `${at}.images[${g}]` };
      if (block.type === 'steps') for (const [s, step] of (block.items ?? []).entries())
        for (const [g, img] of (step.images ?? []).entries()) yield { img, where: `${at}.items[${s}].images[${g}]` };
    }
  }
}

/** Load the project. Never throws: problems are collected in project.report. */
export function loadProject(root) {
  clearFsCache();
  const report = new Report();
  const project = { root, data: null, releases: [], report, imageInfo: new Map() };
  const F = 'releases.json';

  let data;
  try { data = JSON.parse(readText(path.join(root, F))); }
  catch (e) { report.err(F, `Cannot read or parse releases.json: ${e.message}`); return project; }
  if (!isObj(data) || !Array.isArray(data.releases)) { report.err(F, 'Top level must be an object with a "releases" array.'); return project; }
  project.data = data;
  if (!isText(data.product)) report.warn(F, 'Missing "product" name; defaulting to "RevGen-i".');
  const site = data.site ?? {};
  if (!isObj(site)) report.err(F, '"site" must be an object.');
  else if (site.url && !/^https:\/\/\S+\/$/.test(site.url)) report.err(F, `"site.url" must be an https URL ending in "/" (got ${site.url}).`);

  const seen = new Map();
  data.releases.forEach((entry, idx) => {
    const at = `releases[${idx}]`;
    if (!isObj(entry)) { report.err(F, `${at}: must be an object.`); return; }
    const before = report.errors.length;
    const label = isText(entry.version) ? `v${entry.version}` : at;
    const e = (m) => report.err(F, `${label}: ${m}`);
    const w = (m) => report.warn(F, `${label}: ${m}`);

    if (!isText(entry.version) || entry.version !== normalizeVersion(entry.version) || !SEMVER.test(entry.version))
      e(`"version" must be semantic MAJOR.MINOR.PATCH without a leading "v" (got ${JSON.stringify(entry.version)}).`);
    else if (seen.has(entry.version)) e(`duplicate version (also at ${seen.get(entry.version)}). Each version may appear once.`);
    else seen.set(entry.version, at);
    if (!isIsoDate(entry.date)) e(`"date" must be a real calendar date as YYYY-MM-DD (got ${JSON.stringify(entry.date)}).`);
    if (!(entry.type in TYPES)) e(`"type" must be one of ${Object.keys(TYPES).join(', ')} (got ${JSON.stringify(entry.type)}).`);
    else if (SEMVER.test(entry.version ?? '') && typeFromVersion(entry.version) !== entry.type)
      w(`type "${entry.type}" does not match the version number (expected "${typeFromVersion(entry.version)}").`);
    if (!STATUSES.includes(entry.status)) e(`"status" must be "published" or "draft" (got ${JSON.stringify(entry.status)}).`);
    for (const k of ['featured', 'sample']) if (k in entry && typeof entry[k] !== 'boolean') e(`"${k}" must be true or false.`);
    if ('page' in entry && !['generated', 'custom'].includes(entry.page)) e('"page" must be "generated" or "custom".');
    if (!isText(entry.title)) e('"title" is required.');
    else if (entry.title.length > 110) w('"title" is long (over 110 characters); it is the page heading and the card title.');
    if (!isText(entry.summary)) (entry.status === 'draft' ? w : e)('"summary" is required (one or two sentences, shown on cards and used as the page description).');
    else if (entry.summary.length > 260) w('"summary" is over 260 characters; keep it to one or two sentences.');
    if ('tags' in entry && !(Array.isArray(entry.tags) && entry.tags.every(isText))) e('"tags" must be an array of non-empty strings.');
    for (const k of Object.keys(entry)) if (!AUTHORED.includes(k)) w(`unknown field "${k}" (ignored).`);
    if (report.errors.length > before) return; // cannot trust this entry any further

    const rec = { entry, version: entry.version, dir: releaseDir(entry.version), custom: entry.page === 'custom', content: null, valid: false };
    project.releases.push(rec);
    if (!existsExact(root, rec.dir)) { e(`folder ${rec.dir}/ is missing.`); return; }
    if (rec.custom) {
      if (!existsExact(root, `${rec.dir}/index.html`)) { e(`custom page: ${rec.dir}/index.html is missing.`); return; }
    } else if (!existsExact(root, `${rec.dir}/content.json`)) { e(`${rec.dir}/content.json is missing.`); return; }
    const contentFile = `${rec.dir}/content.json`;
    if (existsExact(root, contentFile)) {
      let content;
      try { content = JSON.parse(readText(path.join(root, contentFile))); }
      catch (err) { report.err(contentFile, `Cannot parse JSON: ${err.message}`); return; }
      const n = report.errors.length;
      validateContent(project, rec, content);
      rec.content = content;
      rec.valid = report.errors.length === n;
    } else rec.valid = true; // custom page without structured content
  });

  // Folders on disk that are not in the index.
  const releasesDir = path.join(root, 'releases');
  if (fs.existsSync(releasesDir)) {
    for (const d of fs.readdirSync(releasesDir, { withFileTypes: true })) {
      if (d.isDirectory() && /^v\d+\.\d+\.\d+$/.test(d.name) && !seen.has(d.name.slice(1)))
        report.warn(`releases/${d.name}`, 'folder is not listed in releases.json, so it will not be published. Add an entry or delete the folder.');
    }
  }

  // Dates should not run against version order.
  const byVersion = project.releases.filter((r) => r.entry.status === 'published').sort((a, b) => compareVersions(a.version, b.version));
  for (let i = 1; i < byVersion.length; i++)
    if (byVersion[i].entry.date < byVersion[i - 1].entry.date)
      report.warn(F, `v${byVersion[i].version} is dated ${byVersion[i].entry.date}, earlier than the lower version v${byVersion[i - 1].version} (${byVersion[i - 1].entry.date}). Check the dates.`);

  const drafts = data.releases.filter((r) => r?.status === 'draft').length;
  const samples = data.releases.filter((r) => r?.sample === true).length;
  if (drafts) report.warn(F, `${drafts} draft release${drafts > 1 ? 's' : ''} will NOT be published (the staged site excludes drafts).`);
  if (samples) report.warn(F, `${samples} sample release${samples > 1 ? 's are' : ' is'} flagged "sample": true and will be published with a "Sample" badge. Delete them before go-live.`);
  return project;
}

/* ------------------------------------------------------------------ content.json */
function validateContent(project, rec, content) {
  const { report, root } = project;
  const file = `${rec.dir}/content.json`;
  const err = (m) => report.err(file, m);
  const warn = (m) => report.warn(file, m);
  const referenced = new Set();
  const ids = new Map();

  if (!isObj(content)) return err('Must be a JSON object with "overview" and "items".');
  for (const k of Object.keys(content)) if (!['overview', 'cover', 'items', 'links'].includes(k)) warn(`unknown field "${k}" (ignored).`);

  const ov = content.overview;
  if (ov !== undefined && !(isText(ov) || (Array.isArray(ov) && ov.every(isText)))) err('"overview" must be a string or an array of non-empty strings.');

  const checkImage = (img, where) => {
    if (!isObj(img)) return err(`${where}: an image must be an object with "src" and "alt".`);
    const src = img.src;
    if (!isText(src)) return err(`${where}: "src" is required.`);
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return err(`${where}: external images are not allowed (${src}). Copy the file into ${rec.dir}/images/ instead.`);
    if (src.includes('\\') || src.startsWith('/') || src.split('/').includes('..')) return err(`${where}: "${src}" must be a relative path inside the release folder, using forward slashes.`);
    if (!IMAGE_EXT.has(path.extname(src).toLowerCase())) return err(`${where}: "${src}" is not a supported image type (${[...IMAGE_EXT].join(' ')}).`);
    const rel = `${rec.dir}/${src}`;
    if (!existsExact(root, rel)) {
      const real = findCaseInsensitive(root, rel);
      return err(`${where}: image not found: ${rel}` + (real ? ` - a file exists as "${real}"; GitHub Pages is case-sensitive, so match the capitalisation exactly.` : '.'));
    }
    referenced.add(src);
    if (!project.imageInfo.has(rel)) project.imageInfo.set(rel, readImageInfo(path.join(root, rel)));
    const info = project.imageInfo.get(rel);
    if (!info) warn(`${where}: could not read the dimensions of ${src}; it will render without width/height.`);
    else if (info.bytes > MAX_IMAGE_BYTES) warn(`${where}: ${src} is ${formatBytes(info.bytes)}. Large screenshots slow the page; consider WebP at about 1800px wide.`);
    if (!/^[A-Za-z0-9._/-]+$/.test(src)) warn(`${where}: "${src}" contains characters that need URL-encoding; prefer letters, digits, "-" and "_".`);
    if (img.decorative !== true && !isText(img.alt)) err(`${where}: "alt" text is required (or set "decorative": true for purely decorative images).`);
    if (img.caption !== undefined && typeof img.caption !== 'string') err(`${where}: "caption" must be a string.`);
  };

  const checkLink = (link, where) => {
    if (!isObj(link) || !isText(link.label) || !isText(link.url)) return err(`${where}: a link needs "label" and "url".`);
    if (link.kind !== undefined && !LINK_KINDS.includes(link.kind)) err(`${where}: "kind" must be one of ${LINK_KINDS.join(', ')}.`);
    const url = link.url.trim();
    if (!isSafeUrl(url)) return err(`${where}: unsafe or malformed URL "${url}".`);
    if (/^http:\/\//i.test(url)) warn(`${where}: "${url}" is not https.`);
    if (/^(https?:\/\/|mailto:)/i.test(url)) return;
    const target = url.split('#')[0].split('?')[0];
    if (!target) return;
    if (target.split('/').includes('..') || target.startsWith('/')) return err(`${where}: relative links must stay inside ${rec.dir}/ (got "${url}").`);
    if (!existsExact(root, `${rec.dir}/${decodeURI(target)}`)) err(`${where}: linked file not found: ${rec.dir}/${target}`);
  };

  if (content.cover !== undefined) checkImage(content.cover, 'cover');
  if (content.links !== undefined) {
    if (!Array.isArray(content.links)) err('"links" must be an array.');
    else content.links.forEach((l, i) => checkLink(l, `links[${i}]`));
  }
  if (!Array.isArray(content.items)) return err('"items" must be an array.');
  if (rec.entry.status === 'published' && content.items.length === 0) err('A published release needs at least one item.');

  content.items.forEach((item, i) => {
    const at = `items[${i}]`;
    if (!isObj(item)) return err(`${at}: must be an object.`);
    for (const k of Object.keys(item)) if (!['id', 'category', 'title', 'module', 'audience', 'summary', 'body', 'links'].includes(k)) warn(`${at}: unknown field "${k}" (ignored).`);
    if (!CATEGORY_IDS.includes(item.category)) err(`${at}: "category" must be one of ${CATEGORY_IDS.join(', ')} (got ${JSON.stringify(item.category)}).`);
    if (!isText(item.title)) return err(`${at}: "title" is required.`);
    if (item.id !== undefined && !(isText(item.id) && /^[a-z0-9][a-z0-9-]*$/.test(item.id))) err(`${at}: "id" must be lowercase letters, digits and hyphens.`);
    const id = itemId(item);
    if (!id) err(`${at}: cannot build an anchor id from the title; set "id".`);
    else if (SECTION_IDS.includes(id)) err(`${at}: id "${id}" is reserved for a page section; set a different "id".`);
    else if (ids.has(id)) err(`${at}: duplicate id "${id}" (also ${ids.get(id)}). Set an explicit, unique "id".`);
    else ids.set(id, at);
    for (const k of ['module', 'summary']) if (item[k] !== undefined && typeof item[k] !== 'string') err(`${at}: "${k}" must be a string.`);
    if (item.audience !== undefined && !(Array.isArray(item.audience) && item.audience.every(isText))) err(`${at}: "audience" must be an array of strings.`);
    if (item.body !== undefined && !Array.isArray(item.body)) err(`${at}: "body" must be an array of blocks.`);
    if (!isText(item.summary) && !(Array.isArray(item.body) && item.body.length)) err(`${at} ("${item.title}"): add a "summary" or a "body"; an item with no description is not useful to readers.`);
    (item.links ?? []).forEach((l, k) => checkLink(l, `${at}.links[${k}]`));

    (Array.isArray(item.body) ? item.body : []).forEach((block, b) => {
      const where = `${at}.body[${b}]`;
      if (!isObj(block) || !BLOCK_TYPES.includes(block.type)) return err(`${where}: "type" must be one of ${BLOCK_TYPES.join(', ')}.`);
      switch (block.type) {
        case 'p': case 'heading':
          if (!isText(block.text)) err(`${where}: "text" is required.`); break;
        case 'callout':
          if (!isText(block.text)) err(`${where}: "text" is required.`);
          if (block.tone !== undefined && !['note', 'important'].includes(block.tone)) err(`${where}: "tone" must be "note" or "important".`);
          break;
        case 'list':
          if (!(Array.isArray(block.items) && block.items.length && block.items.every(isText))) err(`${where}: "items" must be a non-empty array of strings.`); break;
        case 'image': checkImage(block, where); break;
        case 'gallery':
          if (!(Array.isArray(block.images) && block.images.length)) err(`${where}: "images" must be a non-empty array.`);
          else block.images.forEach((img, g) => checkImage(img, `${where}.images[${g}]`));
          break;
        case 'steps':
          if (!(Array.isArray(block.items) && block.items.length)) { err(`${where}: "items" must be a non-empty array of steps.`); break; }
          block.items.forEach((s, k) => {
            const sw = `${where}.items[${k}]`;
            if (!isObj(s) || !isText(s.title)) return err(`${sw}: a step needs a "title".`);
            if (s.text !== undefined && !(typeof s.text === 'string' || (Array.isArray(s.text) && s.text.every(isText)))) err(`${sw}: "text" must be a string or array of strings.`);
            if (s.path !== undefined && !(Array.isArray(s.path) && s.path.every(isText))) err(`${sw}: "path" must be an array of menu names.`);
            if (s.audience !== undefined && typeof s.audience !== 'string') err(`${sw}: "audience" must be a string.`);
            if (s.note !== undefined && typeof s.note !== 'string') err(`${sw}: "note" must be a string.`);
            (s.images ?? []).forEach((img, g) => checkImage(img, `${sw}.images[${g}]`));
          });
          break;
      }
    });
  });

  // Images in the release folder that no content references.
  const imgDir = path.join(root, rec.dir, 'images');
  if (fs.existsSync(imgDir)) {
    for (const name of fs.readdirSync(imgDir)) {
      if (IMAGE_EXT.has(path.extname(name).toLowerCase()) && !referenced.has(`images/${name}`))
        warn(`images/${name} is not used by any item (unused files are still published).`);
    }
  }
}

/* ------------------------------------------------------------------ derived index fields */
/** Fields stored in releases.json under "derived" so the portal never has to fetch every content file. */
export function derive(project, rec) {
  const items = rec.content?.items ?? [];
  const categories = CATEGORY_IDS.filter((id) => items.some((i) => i.category === id));
  const counts = Object.fromEntries(categories.map((id) => [id, items.filter((i) => i.category === id).length]));
  const list = items.map((i) => ({ category: i.category, title: i.title, ...(i.module ? { module: i.module } : {}) }));
  let cover = rec.content?.cover;
  if (!cover) { for (const { img } of walkImages(rec.content)) { cover = img; break; } }
  const derived = { categories, counts, items: list };
  if (cover?.src) {
    const rel = `${rec.dir}/${cover.src}`;
    const info = project.imageInfo.get(rel);
    derived.cover = { src: rel, alt: cover.alt || '', ...(info ? { w: info.w, h: info.h } : {}) };
  }
  return derived;
}

/** Canonical key order so diffs stay small and predictable. */
export function serializeEntry(entry, derived) {
  const out = { version: entry.version, date: entry.date, type: entry.type, status: entry.status, featured: entry.featured === true };
  if (entry.sample === true) out.sample = true;
  if (entry.page === 'custom') out.page = 'custom';
  out.title = entry.title;
  if (entry.summary !== undefined) out.summary = entry.summary;
  if (entry.tags?.length) out.tags = entry.tags;
  const d = derived ?? entry.derived;
  if (d) out.derived = d;
  return out;
}

export const sortedRecords = (project) => [...project.releases].sort((a, b) => releaseOrder(a.entry, b.entry));
