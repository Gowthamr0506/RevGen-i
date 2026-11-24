// Logic for the manual release composer (admin/index.html). No DOM access, no dependencies, so it runs in the
// browser and in Node (tests/composer.test.mjs drives it against a simulated GitHub API).
// It produces exactly what tools/rn.mjs expects: releases/vX.Y.Z/content.json, images/, and an entry in releases.json.

export const CATEGORIES = [
  { id: 'new-feature', label: 'New feature' },
  { id: 'enhancement', label: 'Enhancement' },
  { id: 'improvement', label: 'Improvement' },
  { id: 'bug-fix', label: 'Bug fix' },
];
const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif'];
const RESERVED_IDS = ['overview', 'new-features', 'enhancements-improvements', 'bug-fixes'];
const BLOCK_TYPES = ['p', 'heading', 'list', 'image', 'gallery', 'steps', 'callout', 'section'];
const LINK_KINDS = ['video', 'demo', 'docs', 'other'];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_IMAGE_BYTES = 1024 * 1024;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';

/* ------------------------------------------------------------------ small helpers */
export const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

/** URL-safe file name, same rule as `rn.mjs images`: lowercase slug + lowercase extension. */
export function safeFileName(name) {
  const m = String(name).match(/\.([A-Za-z0-9]+)$/);
  const ext = m ? `.${m[1].toLowerCase()}` : '';
  return `${slugify(String(name).replace(/\.[A-Za-z0-9]+$/, '')) || 'image'}${ext}`;
}
/** Returns `name`, or `name-2`, `name-3`... when taken; adds the result to `taken`. */
export function uniqueName(name, taken) {
  const dot = name.lastIndexOf('.');
  const base = dot < 0 ? name : name.slice(0, dot), ext = dot < 0 ? '' : name.slice(dot);
  let out = name, i = 2;
  while (taken.has(out)) out = `${base}-${i++}${ext}`;
  taken.add(out);
  return out;
}
export const isSemver = (v) => SEMVER.test(String(v));
export const parseVersion = (v) => String(v).split('.').map(Number);
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
export function nextVersion(versions) {
  const valid = versions.filter(isSemver).sort(compareVersions);
  if (!valid.length) return '1.0.0';
  const [maj, min] = parseVersion(valid[valid.length - 1]);
  return `${maj}.${min + 1}.0`;
}
export function typeFromVersion(v) {
  const [, minor, patch] = parseVersion(v);
  return patch > 0 ? 'patch' : minor > 0 ? 'minor' : 'major';
}
export function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export const isSafeUrl = (u) => /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(String(u).trim());
export const itemId = (item) => item.id || slugify(item.title || '');

/* ------------------------------------------------------------------ details text -> content blocks */
/**
 * Plain-text "details" syntax (shown as help in the page):
 *   blank line = new paragraph          ## Heading            - bullet / 1. numbered
 *   > note        !> important note     [[image 2]] = place the item's 2nd screenshot here
 *   ### Step title   starts a numbered step; paragraphs, > notes and [[image N]] below it belong to that step
 * Screenshots that are not placed are added at the end of the item.
 */
export function parseBody(text, images = []) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [], errors = [], used = new Set();
  let para = [], list = null, stepsBlock = null, step = null;

  const emit = (b) => {
    if (!step) return blocks.push(b);
    if (b.type === 'p') step.text.push(b.text);
    else if (b.type === 'callout') step.note = step.note ? `${step.note} ${b.text}` : (b.tone === 'important' ? `Important: ${b.text}` : b.text);
    else if (b.type === 'image') step.images.push({ src: b.src, alt: b.alt, ...(b.caption ? { caption: b.caption } : {}) });
    else if (b.type === 'list') b.items.forEach((t, i) => step.text.push(b.ordered ? `${i + 1}. ${t}` : `• ${t}`));
  };
  const flushPara = () => { if (para.length) emit({ type: 'p', text: para.join(' ') }); para = []; };
  const flushList = () => { if (list) emit(list); list = null; };
  const endSteps = () => { step = null; stepsBlock = null; };

  for (const raw of lines) {
    const t = raw.trim();
    let m;
    if (!t) { flushPara(); flushList(); continue; }
    if ((m = t.match(/^###\s+(.+)$/))) {
      flushPara(); flushList();
      if (!stepsBlock) { stepsBlock = { type: 'steps', items: [] }; blocks.push(stepsBlock); }
      step = { title: m[1], text: [], images: [] };
      stepsBlock.items.push(step);
      continue;
    }
    if ((m = t.match(/^##\s+(.+)$/))) { flushPara(); flushList(); endSteps(); blocks.push({ type: 'heading', text: m[1] }); continue; }
    if ((m = t.match(/^\[\[\s*image\s+(\d+)\s*\]\]$/i))) {
      flushPara(); flushList();
      const n = Number(m[1]), img = images[n - 1];
      if (!img) errors.push(`[[image ${n}]] points to a screenshot that has not been added to this section.`);
      else { used.add(n - 1); emit({ type: 'image', src: `images/${img.name}`, alt: img.alt, ...(img.caption ? { caption: img.caption } : {}) }); }
      continue;
    }
    if ((m = t.match(/^(!>|>)\s*(.+)$/))) { flushPara(); flushList(); emit({ type: 'callout', tone: m[1] === '!>' ? 'important' : 'note', text: m[2] }); continue; }
    if ((m = t.match(/^[-*]\s+(.+)$/))) {
      flushPara();
      if (!list || list.ordered) { flushList(); list = { type: 'list', ordered: false, items: [] }; }
      list.items.push(m[1]); continue;
    }
    if ((m = t.match(/^\d+[.)]\s+(.+)$/))) {
      flushPara();
      if (!list || !list.ordered) { flushList(); list = { type: 'list', ordered: true, items: [] }; }
      list.items.push(m[1]); continue;
    }
    flushList(); para.push(t);
  }
  flushPara(); flushList(); endSteps();

  for (const b of blocks) {
    if (b.type !== 'steps') continue;
    for (const s of b.items) {
      if (s.text.length === 1) s.text = s.text[0]; else if (!s.text.length) delete s.text;
      if (!s.images.length) delete s.images;
    }
  }
  const unplaced = images.map((img, i) => ({ img, i })).filter(({ i }) => !used.has(i))
    .map(({ img }) => ({ src: `images/${img.name}`, alt: img.alt, ...(img.caption ? { caption: img.caption } : {}) }));
  if (unplaced.length === 1) blocks.push({ type: 'image', ...unplaced[0] });
  else if (unplaced.length > 1) blocks.push({ type: 'gallery', images: unplaced });
  return { blocks, errors };
}

/* ------------------------------------------------------------------ form model -> content.json */
const paragraphs = (t) => String(t || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
const csv = (t) => String(t || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * The parts of a feature as the form holds them: [{title, body, images:[{name,alt,caption}]}]. Each part has its own explanation
 * (body) and screenshots. An older shape (one `body` text and one `images` list on the item) counts as a single part.
 */
export const itemSections = (it) => (Array.isArray(it?.sections) && it.sections.length ? it.sections : [{ title: '', body: it?.body ?? '', images: it?.images ?? [] }]);
const sectionAt = (n, secs, k) => `Item ${n + 1}${secs.length > 1 ? `, section ${k + 1}` : ''}`;

/** model: {overview, links:[{label,url,kind}], items:[{category,title,module,audience,summary, sections:[{title,body,images}]}]} */
export function buildContent(model) {
  const content = {};
  const overview = paragraphs(model.overview);
  if (overview.length) content.overview = overview;
  const links = (model.links || []).filter((l) => isText(l.label) || isText(l.url))
    .map((l) => ({ label: String(l.label || '').trim(), url: String(l.url || '').trim(), kind: LINK_KINDS.includes(l.kind) ? l.kind : 'other' }));
  if (links.length) content.links = links;
  const parseErrors = [];
  content.items = (model.items || []).map((it, n) => {
    const item = { category: it.category, title: String(it.title || '').trim() };
    if (isText(it.module)) item.module = it.module.trim();
    const aud = csv(it.audience);
    if (aud.length) item.audience = aud;
    if (isText(it.summary)) item.summary = it.summary.trim();
    // each part of the feature is turned into blocks with its own screenshots; a part with nothing in it is skipped
    const secs = itemSections(it), parts = [];
    secs.forEach((s, k) => {
      const { blocks, errors } = parseBody(s.body, s.images || []);
      errors.forEach((e) => parseErrors.push(`${sectionAt(n, secs, k)}: ${e}`));
      const title = String(s.title || '').trim();
      if (!blocks.length && title) parseErrors.push(`${sectionAt(n, secs, k)} ("${title}"): add some text or a screenshot to this section, or remove it.`);
      if (blocks.length) parts.push({ title, blocks });
    });
    // one untitled part stays plain text, as before; two or more, or a titled one, become numbered "Section 1", "Section 2"...
    if (parts.length === 1 && !parts[0].title) item.body = parts[0].blocks;
    else if (parts.length) item.body = parts.map((p) => ({ type: 'section', ...(p.title ? { title: p.title } : {}), body: p.blocks }));
    return item;
  });
  return { content, parseErrors };
}

/* ------------------------------------------------------------------ validation (mirrors the key rules of tools/rn.mjs) */
/** Validates a content object. `imageNames` = file names that will exist in images/. Used for generated AND hand-edited JSON. */
export function validateContent(content, imageNames, { published = true } = {}) {
  const errors = [], warnings = [];
  const err = (m) => errors.push(m), warn = (m) => warnings.push(m);
  const used = new Set();
  if (!isObj(content)) return { errors: ['The content must be a JSON object.'], warnings };
  const checkImage = (img, where) => {
    if (!isObj(img) || !isText(img.src)) return err(`${where}: a screenshot needs a "src".`);
    const m = img.src.match(/^images\/([^/\\]+)$/);
    if (!m) return err(`${where}: screenshots must live in the release's images folder (got "${img.src}").`);
    if (!imageNames.has(m[1])) return err(`${where}: "${m[1]}" has not been attached, so it would be a broken image.`);
    used.add(m[1]);
    if (img.decorative !== true && !isText(img.alt)) err(`${where}: add alt text describing the screenshot (needed for screen readers).`);
  };
  const checkLink = (l, where) => {
    if (!isObj(l) || !isText(l.label) || !isText(l.url)) return err(`${where}: a link needs both a label and a web address.`);
    if (!isSafeUrl(l.url)) err(`${where}: "${l.url}" must start with https:// (or mailto:).`);
    else if (/^http:\/\//i.test(l.url)) warn(`${where}: "${l.url}" is not https.`);
    if (l.kind !== undefined && !LINK_KINDS.includes(l.kind)) err(`${where}: unknown link type "${l.kind}".`);
  };
  if (content.overview !== undefined && !(isText(content.overview) || (Array.isArray(content.overview) && content.overview.every(isText)))) err('The overview must be text.');
  if (content.cover !== undefined) checkImage(content.cover, 'Cover');
  (content.links || []).forEach((l, i) => checkLink(l, `Link ${i + 1}`));
  if (!Array.isArray(content.items)) { err('"items" must be a list.'); return { errors, warnings }; }
  if (published && content.items.length === 0) err('A published release needs at least one item.');
  const ids = new Map();
  content.items.forEach((item, n) => {
    const at = `Item ${n + 1}${isText(item?.title) ? ` (“${item.title}”)` : ''}`;
    if (!isObj(item)) return err(`${at}: must be an object.`);
    if (!CATEGORY_IDS.includes(item.category)) err(`${at}: choose a category.`);
    if (!isText(item.title)) return err(`${at}: add a title.`);
    if (!isText(item.summary) && !(Array.isArray(item.body) && item.body.length)) err(`${at}: add a short description or some details.`);
    const id = itemId(item);
    if (item.id !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(item.id)) err(`${at}: "id" must be lowercase letters, digits and hyphens.`);
    if (!id) err(`${at}: the title needs letters or digits.`);
    else if (RESERVED_IDS.includes(id)) err(`${at}: that title produces a reserved page anchor ("${id}"); reword it slightly.`);
    else if (ids.has(id)) err(`${at}: the same title is used by item ${ids.get(id)}; make the titles different.`);
    else ids.set(id, n + 1);
    (item.links || []).forEach((l, i) => checkLink(l, `${at}, link ${i + 1}`));
    const checkBlock = (b, w, nested) => {
      if (!isObj(b) || !BLOCK_TYPES.includes(b.type)) return err(`${w}: unknown block type.`);
      if (b.type === 'section') { // a numbered part of the feature, with blocks of its own
        if (nested) return err(`${w}: a section cannot contain another section.`);
        if (b.title !== undefined && typeof b.title !== 'string') err(`${w}: the section title must be text.`);
        if (!(Array.isArray(b.body) && b.body.length)) return err(`${w}: a section needs some text or a screenshot.`);
        return b.body.forEach((inner, k) => checkBlock(inner, `${w}, part ${k + 1}`, true));
      }
      if ((b.type === 'p' || b.type === 'heading' || b.type === 'callout') && !isText(b.text)) err(`${w}: "text" is required.`);
      if (b.type === 'list' && !(Array.isArray(b.items) && b.items.length && b.items.every(isText))) err(`${w}: the list needs items.`);
      if (b.type === 'image') checkImage(b, w);
      if (b.type === 'gallery') (Array.isArray(b.images) && b.images.length ? b.images : []).forEach((im, k) => checkImage(im, `${w}, screenshot ${k + 1}`));
      if (b.type === 'steps') {
        if (!(Array.isArray(b.items) && b.items.length)) return err(`${w}: steps need at least one step.`);
        b.items.forEach((s, k) => {
          if (!isObj(s) || !isText(s.title)) return err(`${w}, step ${k + 1}: add a step title.`);
          (s.images || []).forEach((im, j) => checkImage(im, `${w}, step ${k + 1}, screenshot ${j + 1}`));
        });
      }
    };
    (Array.isArray(item.body) ? item.body : []).forEach((b, i) => checkBlock(b, `${at}, block ${i + 1}`, false));
  });
  for (const name of imageNames) if (!used.has(name) && content.cover?.src !== `images/${name}`) warn(`The screenshot "${name}" is attached but not used anywhere.`);
  return { errors, warnings };
}

/** Release details only (version, date, type, title, summary). ctx: {existingVersions:[]}. */
export function validateMeta(model, ctx = {}) {
  const errors = [], warnings = [];
  const err = (m) => errors.push(m);
  const published = model.status !== 'draft';
  if (!isSemver(model.version)) err('Version must look like 2.43.0 (three numbers separated by dots, no "v").');
  else if ((ctx.existingVersions || []).includes(model.version)) err(`Version ${model.version} already exists. Pick a new version number (existing releases are never overwritten).`);
  if (!isIsoDate(model.date)) err('Choose a valid release date.');
  if (!['major', 'minor', 'patch'].includes(model.type)) err('Choose a release type.');
  else if (isSemver(model.version) && typeFromVersion(model.version) !== model.type) warnings.push(`The type "${model.type}" does not match the version number (it looks like a ${typeFromVersion(model.version)} release).`);
  if (!isText(model.title)) err('Add a release title.');
  else if (model.title.length > 110) warnings.push('The title is long; the page heading and card read better under about 110 characters.');
  if (!isText(model.summary)) { if (published) err('Add a short summary (one or two sentences).'); }
  else if (model.summary.length > 260) warnings.push('The summary is over 260 characters; keep it to one or two sentences.');
  return { errors, warnings };
}

/** Attached screenshots: unique supported file names, alt text, size. Returns the set of names that will exist in images/. */
export function validateAttachments(model, ctx = {}) {
  const errors = [], warnings = [], names = new Set();
  (model.items || []).forEach((it, n) => {
    const secs = itemSections(it);
    secs.forEach((s, j) => (s.images || []).forEach((im, k) => {
      const at = `${sectionAt(n, secs, j)}, screenshot ${k + 1}`;
      if (names.has(im.name)) errors.push(`${at}: the file name "${im.name}" is used twice.`);
      names.add(im.name);
      if (!IMAGE_EXT.some((e) => String(im.name).toLowerCase().endsWith(e))) errors.push(`${at}: "${im.name}" is not a supported image type.`);
      if (!isText(im.alt)) errors.push(`${at}: add alt text describing the screenshot (needed for screen readers).`);
      if ((ctx.imageSizes || {})[im.name] > MAX_IMAGE_BYTES) warnings.push(`"${im.name}" is over 1 MB; turn on "Optimize screenshots" or use a smaller image.`);
    }));
  });
  return { errors, warnings, names };
}

/** Full check of the form. ctx: {existingVersions:[], imageSizes?:{name:bytes}}. Returns the content/entry to publish when valid. */
export function validateRelease(model, ctx = {}) {
  const meta = validateMeta(model, ctx), att = validateAttachments(model, ctx);
  const { content, parseErrors } = buildContent(model);
  const structural = validateContent(content, att.names, { published: model.status !== 'draft' });
  // a screenshot without alt text is already reported once per attachment; do not list it again per place it is used
  const structuralErrors = structural.errors.filter((e) => !/add alt text describing the screenshot/.test(e));
  const errors = [...meta.errors, ...att.errors, ...parseErrors, ...structuralErrors];
  const warnings = [...meta.warnings, ...att.warnings, ...structural.warnings];
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)], content, entry: makeEntry(model) };
}

export function makeEntry(model) {
  const entry = { version: model.version, date: model.date, type: model.type, status: model.status === 'draft' ? 'draft' : 'published', featured: model.featured === true, title: String(model.title || '').trim() };
  if (isText(model.summary)) entry.summary = model.summary.trim();
  const tags = csv(model.tags);
  if (tags.length) entry.tags = tags;
  return entry;
}

/* ------------------------------------------------------------------ GitHub (REST, Git Data API: one atomic commit) */
export class GitHubError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}
function explain(status, data, what) {
  const detail = data && data.message ? ` (${data.message})` : '';
  if (status === 401) return `GitHub rejected the token: it is mistyped or has expired.${detail}`;
  if (status === 403) return `GitHub refused this: the token needs “Contents: Read and write” on this repository (or you hit a rate limit).${detail}`;
  if (status === 404) return `${what || 'That'} was not found, or the token cannot see this repository.${detail}`;
  if (status === 409 || status === 422) return `GitHub could not apply the change${detail}`;
  return `GitHub returned an error (${status}).${detail}`;
}
async function gh(fetchFn, token, method, url, body, what) {
  const res = await fetchFn(`https://api.github.com${url}`, {
    method,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new GitHubError(res.status, explain(res.status, data, what), data);
  return data;
}
export function b64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
export function b64ToBytes(b64) {
  return Uint8Array.from(atob(String(b64).replace(/\s+/g, '')), (c) => c.charCodeAt(0));
}
export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Checks the token can see the repository and loads releases.json (authoritative: includes drafts). */
export async function connect({ fetch: f = globalThis.fetch, token, owner, repo, branch = 'main', dir = 'release-notes' }) {
  const info = await gh(f, token, 'GET', `/repos/${owner}/${repo}`, null, 'The repository');
  const file = await gh(f, token, 'GET', `/repos/${owner}/${repo}/contents/${dir}/releases.json?ref=${encodeURIComponent(branch)}`, null, `${dir}/releases.json`);
  const index = JSON.parse(b64ToUtf8(file.content));
  return { fullName: info.full_name, isPrivate: !!info.private, branch, releases: index.releases || [], product: index.product, site: index.site || {} };
}

/**
 * Adds one release in a single commit: releases/vX/content.json + images + the releases.json entry.
 * images: [{name, bytes:Uint8Array}]. Never overwrites an existing version. Retries if someone pushed meanwhile.
 */
export async function publish({ fetch: f = globalThis.fetch, token, owner, repo, branch = 'main', dir = 'release-notes', entry, content, images = [], message, onProgress = () => {} }) {
  const api = (m, p, b, what) => gh(f, token, m, `/repos/${owner}/${repo}${p}`, b, what);
  const blobCache = new Map();
  const blob = async (key, payload) => {
    if (!blobCache.has(key)) blobCache.set(key, (await api('POST', '/git/blobs', payload, 'The upload')).sha);
    return blobCache.get(key);
  };
  const base = `${dir}/releases/v${entry.version}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    onProgress('Reading the repository…');
    const headSha = (await api('GET', `/git/ref/heads/${encodeURI(branch)}`, null, `The branch "${branch}"`)).object.sha;
    const baseTree = (await api('GET', `/git/commits/${headSha}`, null, 'The latest commit')).tree.sha;
    const idx = await api('GET', `/contents/${dir}/releases.json?ref=${headSha}`, null, `${dir}/releases.json`);
    const data = JSON.parse(b64ToUtf8(idx.content));
    if ((data.releases || []).some((r) => r.version === entry.version)) throw new GitHubError(409, `Version ${entry.version} already exists in the repository. Pick a new version number.`);
    const folderExists = await api('GET', `/contents/${base}?ref=${headSha}`, null, 'The release folder').then(() => true, (e) => { if (e.status === 404) return false; throw e; });
    if (folderExists) throw new GitHubError(409, `The folder ${base}/ already exists in the repository. Pick a new version number.`);

    data.releases = [...(data.releases || []), entry];
    const tree = [];
    let done = 0;
    for (const img of images) {
      onProgress(`Uploading screenshots (${done + 1} of ${images.length})…`);
      tree.push({ path: `${base}/images/${img.name}`, mode: '100644', type: 'blob', sha: await blob(`img:${img.name}`, { content: bytesToB64(img.bytes), encoding: 'base64' }) });
      done++;
    }
    onProgress('Saving the release…');
    tree.push({ path: `${base}/content.json`, mode: '100644', type: 'blob', sha: await blob(`content:${JSON.stringify(content)}`, { content: `${JSON.stringify(content, null, 2)}\n`, encoding: 'utf-8' }) });
    tree.push({ path: `${dir}/releases.json`, mode: '100644', type: 'blob', sha: await api('POST', '/git/blobs', { content: `${JSON.stringify(data, null, 2)}\n`, encoding: 'utf-8' }, 'The upload').then((b) => b.sha) });
    const newTree = (await api('POST', '/git/trees', { base_tree: baseTree, tree }, 'The upload')).sha;
    const commit = (await api('POST', '/git/commits', { message: message || `Add release ${entry.version}`, tree: newTree, parents: [headSha] }, 'The upload')).sha;
    try {
      await api('PATCH', `/git/refs/heads/${encodeURI(branch)}`, { sha: commit, force: false }, `The branch "${branch}"`);
    } catch (e) {
      if ((e.status === 422 || e.status === 409) && attempt < 2) { onProgress('Someone else just committed; trying again…'); continue; }
      throw e;
    }
    return { commitSha: commit, commitUrl: `https://github.com/${owner}/${repo}/commit/${commit}`, version: entry.version };
  }
  throw new GitHubError(409, 'The repository kept changing while publishing. Try again in a moment.');
}

/* ------------------------------------------------------------------ deleting a release */
const assertVersion = (v) => { if (!isSemver(v)) throw new GitHubError(422, `"${v}" is not a version number like 2.43.0.`); };

async function readReleaseState(api, branch, dir, version) {
  const headSha = (await api('GET', `/git/ref/heads/${encodeURI(branch)}`, null, `The branch "${branch}"`)).object.sha;
  const baseTree = (await api('GET', `/git/commits/${headSha}`, null, 'The latest commit')).tree.sha;
  const tree = await api('GET', `/git/trees/${baseTree}?recursive=1`, null, 'The repository files');
  if (tree.truncated) throw new GitHubError(422, 'The repository is too large to list safely from this page. Ask Claude to delete the release instead.');
  const prefix = `${dir}/releases/v${version}/`; // built only from a validated MAJOR.MINOR.PATCH, so it cannot point anywhere else
  const found = (tree.tree || []).filter((t) => t.type === 'blob' && t.path.startsWith(prefix));
  const files = found.map((t) => t.path);
  const shas = Object.fromEntries(found.map((t) => [t.path, t.sha])); // lets the preview fetch a screenshot by its blob
  const idx = await api('GET', `/contents/${dir}/releases.json?ref=${headSha}`, null, `${dir}/releases.json`);
  const data = JSON.parse(b64ToUtf8(idx.content));
  return { headSha, baseTree, files, shas, data, entry: (data.releases || []).find((r) => r.version === version) || null };
}

/**
 * Loads one saved release so the page can preview it: its releases.json entry, content.json and screenshots (bytes).
 * Read-only. A release with a hand-written page has no content.json to draw, so it comes back as {custom:true, entry}.
 */
export async function loadReleaseForPreview({ fetch: f = globalThis.fetch, token, owner, repo, branch = 'main', dir = 'release-notes', version, onProgress = () => {} }) {
  assertVersion(version);
  const api = (m, p, b, what) => gh(f, token, m, `/repos/${owner}/${repo}${p}`, b, what);
  onProgress('Reading the repository…');
  const s = await readReleaseState(api, branch, dir, version);
  if (!s.entry) throw new GitHubError(404, `Version ${version} is not in the release list.`);
  if (s.entry.page === 'custom') return { custom: true, entry: s.entry };
  const prefix = `${dir}/releases/v${version}/`;
  let content;
  try { content = JSON.parse(b64ToUtf8((await api('GET', `/contents/${prefix}content.json?ref=${s.headSha}`, null, 'content.json')).content)); }
  catch (e) {
    if (e instanceof GitHubError) throw e.status === 404 ? new GitHubError(404, `v${version} has no content.json, so there is nothing to preview.`) : e;
    throw new GitHubError(422, `The content.json of v${version} is not valid JSON, so it cannot be previewed.`);
  }
  const imgPrefix = `${prefix}images/`;
  const paths = s.files.filter((p) => p.startsWith(imgPrefix) && !p.slice(imgPrefix.length).includes('/'));
  const images = [];
  for (let i = 0; i < paths.length; i += 4) { // a few at a time: quick, and kind to the API
    onProgress(`Loading screenshots (${Math.min(i + 4, paths.length)} of ${paths.length})…`);
    images.push(...await Promise.all(paths.slice(i, i + 4).map(async (p) => ({
      name: p.slice(imgPrefix.length),
      bytes: b64ToBytes((await api('GET', `/git/blobs/${s.shas[p]}`, null, 'A screenshot')).content),
    }))));
  }
  return { entry: s.entry, content, images };
}

/** What deleting a release would remove: every file under releases/vX.Y.Z/ and its releases.json entry. Changes nothing. */
export async function previewDelete({ fetch: f = globalThis.fetch, token, owner, repo, branch = 'main', dir = 'release-notes', version }) {
  assertVersion(version);
  const api = (m, p, b, what) => gh(f, token, m, `/repos/${owner}/${repo}${p}`, b, what);
  const s = await readReleaseState(api, branch, dir, version);
  if (!s.entry && !s.files.length) throw new GitHubError(404, `Version ${version} was not found in the repository. It may already have been deleted.`);
  return { version, files: s.files, entry: s.entry };
}

/**
 * Deletes one release in a single commit: all files under releases/vX.Y.Z/ plus its releases.json entry.
 * Other releases are not touched. Retries if someone pushed meanwhile.
 */
export async function deleteRelease({ fetch: f = globalThis.fetch, token, owner, repo, branch = 'main', dir = 'release-notes', version, message, onProgress = () => {} }) {
  assertVersion(version);
  const api = (m, p, b, what) => gh(f, token, m, `/repos/${owner}/${repo}${p}`, b, what);
  for (let attempt = 0; attempt < 3; attempt++) {
    onProgress('Reading the repository…');
    const s = await readReleaseState(api, branch, dir, version);
    if (!s.entry && !s.files.length) throw new GitHubError(404, `Version ${version} was not found in the repository. It may already have been deleted.`);
    onProgress(`Removing ${s.files.length} file${s.files.length === 1 ? '' : 's'} and the release list entry…`);
    s.data.releases = (s.data.releases || []).filter((r) => r.version !== version);
    const indexBlob = (await api('POST', '/git/blobs', { content: `${JSON.stringify(s.data, null, 2)}\n`, encoding: 'utf-8' }, 'The change')).sha;
    const tree = [...s.files.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })), { path: `${dir}/releases.json`, mode: '100644', type: 'blob', sha: indexBlob }];
    const newTree = (await api('POST', '/git/trees', { base_tree: s.baseTree, tree }, 'The change')).sha;
    const commit = (await api('POST', '/git/commits', { message: message || `Delete release ${version}`, tree: newTree, parents: [s.headSha] }, 'The change')).sha;
    try {
      await api('PATCH', `/git/refs/heads/${encodeURI(branch)}`, { sha: commit, force: false }, `The branch "${branch}"`);
    } catch (e) {
      if ((e.status === 422 || e.status === 409) && attempt < 2) { onProgress('Someone else just committed; trying again…'); continue; }
      throw e;
    }
    return { commitSha: commit, commitUrl: `https://github.com/${owner}/${repo}/commit/${commit}`, version, removedFiles: s.files.length };
  }
  throw new GitHubError(409, 'The repository kept changing while deleting. Try again in a moment.');
}

/* ------------------------------------------------------------------ publishing a draft / unpublishing */
/** Why a draft cannot be published yet (same rules the website build enforces). Empty array = safe to publish. */
async function publishProblems(api, dir, version, s) {
  const errors = [];
  const entry = s.entry, prefix = `${dir}/releases/v${version}/`;
  if (!isText(entry.title)) errors.push('The release has no title.');
  if (!isText(entry.summary)) errors.push('The release has no summary. A published release needs one (one or two sentences).');
  if (entry.page === 'custom') {
    if (!s.files.includes(`${prefix}index.html`)) errors.push('Its custom page (index.html) is missing.');
    return errors;
  }
  let content = null;
  try { content = JSON.parse(b64ToUtf8((await api('GET', `/contents/${prefix}content.json?ref=${s.headSha}`, null, 'content.json')).content)); }
  catch (e) { if (!(e instanceof GitHubError) || e.status !== 404) errors.push('Its content.json could not be read.'); }
  if (!content) { if (!errors.some((x) => /content\.json/.test(x))) errors.push('Its content.json is missing.'); return errors; }
  const names = new Set(s.files.filter((p) => p.startsWith(`${prefix}images/`)).map((p) => p.slice(`${prefix}images/`.length)).filter((n) => !n.includes('/')));
  errors.push(...validateContent(content, names, { published: true }).errors);
  return errors;
}

/** Looks at one release and says whether it can move to `to` ("published" or "draft"). Changes nothing. */
export async function previewStatusChange({ fetch: f = globalThis.fetch, token, owner, repo, branch = 'main', dir = 'release-notes', version, to }) {
  assertVersion(version);
  if (!['published', 'draft'].includes(to)) throw new GitHubError(422, 'The new status must be "published" or "draft".');
  const api = (m, p, b, what) => gh(f, token, m, `/repos/${owner}/${repo}${p}`, b, what);
  const s = await readReleaseState(api, branch, dir, version);
  if (!s.entry) throw new GitHubError(404, `Version ${version} is not in the release list.`);
  let errors = [];
  if (s.entry.status === to) errors = [to === 'published' ? `v${version} is already published.` : `v${version} is already a draft.`];
  else if (to === 'published') errors = await publishProblems(api, dir, version, s);
  return { version, from: s.entry.status, to, entry: s.entry, errors };
}

/**
 * Publishes a draft or unpublishes a release by changing its status in releases.json: one commit, one file.
 * Publishing is refused (with a list of reasons) if the release is not complete enough for the website build.
 */
export async function setReleaseStatus({ fetch: f = globalThis.fetch, token, owner, repo, branch = 'main', dir = 'release-notes', version, to, message, onProgress = () => {} }) {
  assertVersion(version);
  if (!['published', 'draft'].includes(to)) throw new GitHubError(422, 'The new status must be "published" or "draft".');
  const api = (m, p, b, what) => gh(f, token, m, `/repos/${owner}/${repo}${p}`, b, what);
  for (let attempt = 0; attempt < 3; attempt++) {
    onProgress('Reading the repository…');
    const s = await readReleaseState(api, branch, dir, version);
    if (!s.entry) throw new GitHubError(404, `Version ${version} is not in the release list.`);
    if (s.entry.status === to) throw new GitHubError(409, to === 'published' ? `v${version} is already published.` : `v${version} is already a draft.`);
    if (to === 'published') {
      onProgress('Checking the release is complete…');
      const errors = await publishProblems(api, dir, version, s);
      if (errors.length) { const err = new GitHubError(422, `v${version} cannot be published yet: ${errors.join(' ')}`); err.errors = errors; throw err; }
    }
    onProgress(to === 'published' ? 'Publishing…' : 'Unpublishing…');
    s.entry.status = to;
    const indexBlob = (await api('POST', '/git/blobs', { content: `${JSON.stringify(s.data, null, 2)}\n`, encoding: 'utf-8' }, 'The change')).sha;
    const newTree = (await api('POST', '/git/trees', { base_tree: s.baseTree, tree: [{ path: `${dir}/releases.json`, mode: '100644', type: 'blob', sha: indexBlob }] }, 'The change')).sha;
    const commit = (await api('POST', '/git/commits', { message: message || `${to === 'published' ? 'Publish' : 'Unpublish'} release ${version}`, tree: newTree, parents: [s.headSha] }, 'The change')).sha;
    try {
      await api('PATCH', `/git/refs/heads/${encodeURI(branch)}`, { sha: commit, force: false }, `The branch "${branch}"`);
    } catch (e) {
      if ((e.status === 422 || e.status === 409) && attempt < 2) { onProgress('Someone else just committed; trying again…'); continue; }
      throw e;
    }
    return { commitSha: commit, commitUrl: `https://github.com/${owner}/${repo}/commit/${commit}`, version, status: to };
  }
  throw new GitHubError(409, 'The repository kept changing while saving. Try again in a moment.');
}

/** After a delete has been built: confirms the website no longer serves the release (page gone AND not in the public list). Never throws. */
export async function checkGone({ fetch: f = globalThis.fetch, baseUrl, version, tries = 30, intervalMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onAttempt = () => {} }) {
  let reason = 'no answer yet';
  for (let n = 1; n <= tries; n++) {
    onAttempt(n);
    try {
      const idx = await f(`${baseUrl}releases.json`, { cache: 'no-store' });
      if (!idx.ok) reason = `the release list answered ${idx.status}`;
      else if ((((await idx.json()).releases) || []).some((r) => r.version === version)) reason = 'the public release list still includes it';
      else {
        const page = await f(`${baseUrl}releases/v${version}/`, { cache: 'no-store' });
        if (page.status === 404) return { ok: true, attempts: n };
        reason = `the release page still answers ${page.status}`;
      }
    } catch { reason = 'the website could not be reached from this page'; }
    if (n < tries) await sleep(intervalMs);
  }
  return { ok: false, attempts: tries, reason };
}

/** The release page address plus a short fresh-copy marker, so a browser cannot answer from an older cached copy. */
export const liveLink = (baseUrl, version, sha) => `${baseUrl}releases/v${version}/?r=${String(sha).slice(0, 7)}`;

/**
 * After the build succeeds, confirms the website really serves the new release: the release page answers
 * AND the public release list includes it as published. Bypasses caches. Never throws.
 * Returns {ok:true, attempts} or {ok:false, attempts, reason}.
 */
export async function checkLive({ fetch: f = globalThis.fetch, baseUrl, version, tries = 30, intervalMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onAttempt = () => {} }) {
  let reason = 'no answer yet';
  for (let n = 1; n <= tries; n++) {
    onAttempt(n);
    try {
      const page = await f(`${baseUrl}releases/v${version}/`, { cache: 'no-store' });
      if (!page.ok) reason = `the release page answered ${page.status}`;
      else {
        const idx = await f(`${baseUrl}releases.json`, { cache: 'no-store' });
        if (!idx.ok) reason = `the release list answered ${idx.status}`;
        else if ((((await idx.json()).releases) || []).some((r) => r.version === version && r.status === 'published')) return { ok: true, attempts: n };
        else reason = 'the page is up, but the public release list does not include it yet';
      }
    } catch { reason = 'the website could not be reached from this page'; }
    if (n < tries) await sleep(intervalMs);
  }
  return { ok: false, attempts: tries, reason };
}

/** Looks up the workflow run GitHub started for a commit. Returns null until it appears. */
export async function getBuildRun({ fetch: f = globalThis.fetch, token, owner, repo, sha }) {
  const data = await gh(f, token, 'GET', `/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=5`, null, 'The build status');
  const run = (data.workflow_runs || [])[0];
  return run ? { status: run.status, conclusion: run.conclusion, url: run.html_url, name: run.name } : null;
}
