// The release composer page. All the logic that matters (parsing, validation, the GitHub commit) is in core.mjs and is unit-tested;
// editor.mjs holds the pure helpers for editing comforts and preview.mjs draws the preview. This file only wires them to the page.
import * as core from './core.mjs';
import * as preview from './preview.mjs';
import * as editor from './editor.mjs';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  sget: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  sset: (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* private mode */ } },
};
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif' };
const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

const state = {
  conn: null, connecting: false, items: [], links: [], typeTouched: false, jsonOverride: false, busy: false, done: false, managing: false, previewing: false,
  ready: null, view: null, issues: null, tried: false, tab: 'add', filter: 'all', query: '',
};
const newItem = () => ({ category: '', title: '', module: '', audience: '', summary: '', body: '', images: [], collapsed: false });

/* ------------------------------------------------------------------ small UI helpers */
function setStatus(el, text, kind = '') { el.textContent = text; el.className = `status ${kind}`.trim(); }
const getCfg = () => ({ owner: $('#owner').value.trim(), repo: $('#repo').value.trim(), branch: $('#branch').value.trim() || 'main', token: $('#token').value.trim() });
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const siteBase = () => state.conn?.site?.url || `${location.origin}${location.pathname.replace(/admin\/(index\.html)?$/, '')}`;
const allNames = () => new Set(state.items.flatMap((it) => it.images.map((im) => im.name)));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------------ connection */
function renderConn() {
  const c = state.conn, box = $('#conn');
  box.dataset.state = state.connecting ? 'busy' : c ? 'on' : 'off';
  $('#connText').textContent = c ? `Connected to ${c.fullName}${c.isPrivate ? ' (private)' : ''}` : state.connecting ? 'Connecting…' : 'Not connected';
  $('#connToggle').textContent = c ? 'Disconnect' : 'Connect';
  $('#connToggle').disabled = state.connecting;
  $('#connect').hidden = !!c;
  $('#manageCount').hidden = !c;
  $('#manageCount').textContent = c ? String(c.releases.length) : '';
}

function updateRepoSummary() {
  const cfg = getCfg();
  const known = cfg.owner && cfg.repo;
  $('#repoSummary').textContent = known ? `Repository: ${cfg.owner}/${cfg.repo}, branch ${cfg.branch} (change)` : 'Repository settings: which repository should this use?';
  if (!known) $('#repoSettings').open = true;
}

function focusConnect(message) {
  renderConn();
  $('#connect').scrollIntoView({ block: 'center', behavior: smooth() });
  $('#token').focus({ preventScroll: true });
  if (message) setStatus($('#connectStatus'), message, 'err');
}

async function doConnect() {
  const cfg = getCfg(), out = $('#connectStatus');
  if (!cfg.owner || !cfg.repo) { $('#repoSettings').open = true; return setStatus(out, 'Enter the repository owner and name under “Repository”.', 'err'); }
  if (!cfg.token) { $('#token').focus(); return setStatus(out, 'Paste your access token first.', 'err'); }
  setStatus(out, '');
  state.connecting = true; renderConn();
  $('#connectBtn').disabled = true;
  try {
    const c = await core.connect(cfg);
    state.conn = c;
    store.set('rn-admin-cfg', JSON.stringify({ owner: cfg.owner, repo: cfg.repo, branch: cfg.branch }));
    store.sset('rn-admin-token', $('#remember').checked ? cfg.token : null);
    const latest = c.releases.map((r) => r.version).filter(core.isSemver).sort(core.compareVersions).pop();
    $('#versionHint').textContent = latest ? `Latest in the repository: v${latest}. Suggested next: ${core.nextVersion(c.releases.map((r) => r.version))}` : 'Three numbers, e.g. 1.0.0';
    if (!$('#version').value) { $('#version').value = core.nextVersion(c.releases.map((r) => r.version)); syncType(); }
    $('#connText').title = `${plural(c.releases.length, 'release')} so far${latest ? `, latest v${latest}` : ''}`;
  } catch (e) {
    state.conn = null;
    setStatus(out, e.message || String(e), 'err');
  }
  state.connecting = false;
  $('#connectBtn').disabled = false;
  renderConn(); renderManage(); runChecks();
}

function disconnect() {
  state.conn = null;
  $('#token').value = '';
  store.sset('rn-admin-token', null);
  setStatus($('#connectStatus'), '');
  renderConn(); renderManage(); runChecks();
  $('#token').focus();
}
const invalidateConnection = () => { if (state.conn) { state.conn = null; setStatus($('#connectStatus'), 'Settings changed. Connect again.'); renderConn(); renderManage(); runChecks(); } };

/* ------------------------------------------------------------------ tabs */
function showTab(name, { updateHash = true } = {}) {
  state.tab = name;
  for (const t of ['add', 'manage']) {
    const on = t === name;
    const btn = $(`#tab-${t}`);
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
    $(`#view-${t}`).hidden = !on;
  }
  if (updateHash) history.replaceState(null, '', name === 'manage' ? '#manage' : `${location.pathname}${location.search}`);
  if (name === 'manage') renderManage();
  queueSpy();
}
const tabFromHash = () => (location.hash === '#manage' ? 'manage' : 'add');

/* ------------------------------------------------------------------ screenshots */
async function prepareImage(file, optimize) {
  const ext = (file.name.toLowerCase().match(/\.[a-z0-9]+$/) || [''])[0];
  const raw = new Uint8Array(await file.arrayBuffer());
  const plain = { bytes: raw, ext, size: raw.length, original: raw.length };
  if (!optimize || !/^image\/(png|jpeg|webp)$/.test(file.type)) return plain; // GIF, SVG and AVIF are kept untouched
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1800 / bmp.width);
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85));
    if (blob && blob.type === 'image/webp' && (blob.size < raw.length || scale < 1)) {
      return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: '.webp', size: blob.size, original: raw.length };
    }
  } catch { /* fall back to the original file */ }
  return plain;
}

async function addImages(i, files, where = '') {
  const it = state.items[i];
  if (!it) return;
  const taken = allNames(), notes = [], before = it.images.length;
  for (const file of files) {
    if (!/^image\//.test(file.type)) { notes.push(`${file.name} is not an image and was skipped.`); continue; }
    const p = await prepareImage(file, $('#optimize').checked);
    let base = core.safeFileName(file.name);
    if (p.ext && !base.endsWith(p.ext)) base = base.replace(/\.[a-z0-9]+$/, '') + p.ext;
    const name = core.uniqueName(base, taken);
    const note = p.size < p.original ? `shrunk from ${fmtBytes(p.original)} to ${fmtBytes(p.size)}` : '';
    it.images.push({ name, alt: '', caption: '', bytes: p.bytes, size: p.size, note, url: URL.createObjectURL(new Blob([p.bytes], { type: MIME[p.ext] || 'image/png' })) });
  }
  const added = it.images.length - before;
  it.notice = [added ? `${plural(added, 'screenshot')} added${where}. Describe each one below.` : '', ...notes].filter(Boolean).join(' ');
  it.collapsed = false;
  renderItems();
  scheduleCheck();
  if (added) { // the next thing to do is describe it
    const row = $$('.item-form')[i] && $$('.shot-row', $$('.item-form')[i])[before];
    const alt = row && $('[data-img=alt]', row);
    if (alt) { alt.scrollIntoView({ block: 'nearest', behavior: smooth() }); alt.focus({ preventScroll: true }); }
  }
}

/* ------------------------------------------------------------------ rendering */
const CAT_HINT = {
  'new-feature': 'Users could not do this before.',
  enhancement: 'An existing feature can do more.',
  improvement: 'It already worked and now works better.',
  'bug-fix': 'It was wrong and is now right.',
};
const TOOLS = [
  ['step', 'Step', 'Start a numbered step'], ['bullet', '• List', 'Bulleted list'], ['numbered', '1. List', 'Numbered list'],
  ['heading', 'Heading', 'Sub-heading'], ['note', 'Note', 'Note box'], ['important', 'Important', 'Important box'], ['bold', 'Bold', 'Make the selected text bold'],
];

function itemHtml(it, i) {
  const cat = core.CATEGORIES.find((c) => c.id === it.category);
  const name = it.title.trim();
  return `
    <article class="item-form" data-i="${i}">
      <div class="item-bar">
        <button type="button" class="item-toggle" data-act="toggle-item" aria-expanded="${!it.collapsed}" aria-controls="item-body-${i}">
          <span class="item-n">${i + 1}</span>
          <span class="item-name${name ? '' : ' empty'}">${esc(name || 'New item')}</span>
          <span class="item-cat chip${cat ? ` cat-${cat.id}` : ''}"${cat ? '' : ' hidden'}>${cat ? esc(cat.label) : ''}</span>
          <span class="item-flag" hidden></span>
          <span class="item-caret" aria-hidden="true"></span>
        </button>
        ${state.items.length > 1 ? '<button type="button" class="btn btn-outline btn-sm" data-act="remove-item">Remove</button>' : ''}
      </div>
      <div class="item-body" id="item-body-${i}"${it.collapsed ? ' hidden' : ''}>
        <fieldset class="field cats" data-fk="category">
          <legend>What kind of change is it?</legend>
          <div class="cat-grid">${core.CATEGORIES.map((c) => `<label class="cat"><input type="radio" name="cat-${i}" data-f="category" value="${c.id}"${it.category === c.id ? ' checked' : ''}><span class="cat-in"><strong>${c.label}</strong><small>${CAT_HINT[c.id]}</small></span></label>`).join('')}</div>
          <small class="field-msg"></small>
        </fieldset>
        <div class="field" data-fk="title"><label for="it-title-${i}">Title</label><input id="it-title-${i}" type="text" data-f="title" maxlength="140" autocomplete="off" placeholder="What the user sees, e.g. Remove Responsible Party" value="${esc(it.title)}"><small class="field-msg"></small></div>
        <div class="grid2">
          <div class="field"><label for="it-module-${i}">Area <span class="opt">optional</span></label><input id="it-module-${i}" type="text" data-f="module" autocomplete="off" placeholder="e.g. Submitted Claims" value="${esc(it.module)}"></div>
          <div class="field"><label for="it-audience-${i}">Who it is for <span class="opt">optional</span></label><input id="it-audience-${i}" type="text" data-f="audience" autocomplete="off" placeholder="e.g. Leads, Managers" value="${esc(it.audience)}"></div>
        </div>
        <div class="field" data-fk="desc"><label for="it-summary-${i}">Short description</label><textarea id="it-summary-${i}" data-f="summary" rows="2" placeholder="One or two sentences.">${esc(it.summary)}</textarea><small class="field-msg"></small></div>
        <div class="field"><label for="it-body-${i}">Details <span class="opt">optional</span></label>
          <div class="tb" role="toolbar" aria-label="Formatting for the details">${TOOLS.map(([k, label, tip]) => `<button type="button" data-fmt="${k}" title="${tip}">${label}</button>`).join('')}</div>
          <textarea id="it-body-${i}" data-f="body" rows="6" placeholder="Explain more, or write numbered steps. The buttons above add the formatting.">${esc(it.body)}</textarea>
        </div>
        <div class="shots">
          <div class="shots-head"><strong>Screenshots</strong><span class="muted small">${it.images.length ? `${it.images.length} added` : 'optional'}</span></div>
          <div class="drop"><span>Drag screenshots here, paste with <kbd>Ctrl</kbd> + <kbd>V</kbd>, or</span><label class="btn btn-outline btn-sm file-btn">Choose files<input type="file" class="sr" data-act="add-images" accept="image/*" multiple></label></div>
          ${it.notice ? `<p class="hint">${esc(it.notice)}</p>` : ''}
          <ul class="shot-list">${it.images.map((im, k) => `
            <li class="shot-row" data-k="${k}">
              <img class="thumb" src="${im.url}" alt="Preview of ${esc(im.name)}">
              <div>
                <div class="shot-title"><strong>Screenshot ${k + 1}</strong><code>[[image ${k + 1}]]</code><span class="muted">${esc(im.name)} · ${fmtBytes(im.size)}${im.note ? ` (${esc(im.note)})` : ''}</span></div>
                <div class="field" data-fk="alt"><label for="it-alt-${i}-${k}">Describe what the screenshot shows</label><input id="it-alt-${i}-${k}" type="text" data-img="alt" autocomplete="off" placeholder="e.g. The Users screen with the Add User window open" value="${esc(im.alt)}"><small class="field-msg"></small></div>
                <div class="field"><label for="it-cap-${i}-${k}">Caption <span class="opt">optional</span></label><input id="it-cap-${i}-${k}" type="text" data-img="caption" autocomplete="off" value="${esc(im.caption)}"></div>
              </div>
              <div class="shot-actions">
                <button type="button" class="btn btn-outline btn-sm" data-act="insert-image" title="Put this screenshot at the cursor in the details">Place in details</button>
                <button type="button" class="btn btn-outline btn-sm" data-act="remove-image">Remove</button>
              </div>
            </li>`).join('')}</ul>
        </div>
      </div>
    </article>`;
}

function renderItems() {
  $('#items').innerHTML = state.items.map(itemHtml).join('');
  applyIssues();
}

function renderLinks() {
  $('#links').innerHTML = state.links.map((l, i) => `
    <div class="link-row" data-l="${i}">
      <label class="field"><span>Label</span><input type="text" data-lf="label" autocomplete="off" placeholder="Watch the demo" value="${esc(l.label)}"></label>
      <label class="field"><span>Web address</span><input type="text" data-lf="url" autocomplete="off" placeholder="https://…" value="${esc(l.url)}"></label>
      <label class="field"><span>Type</span><select data-lf="kind">${['video', 'demo', 'docs', 'other'].map((k) => `<option value="${k}"${l.kind === k ? ' selected' : ''}>${k[0].toUpperCase() + k.slice(1)}</option>`).join('')}</select></label>
      <button type="button" class="btn btn-outline btn-sm" data-act="remove-link">Remove</button>
    </div>`).join('');
}

function setCollapsed(i, collapsed) {
  const form = $$('.item-form')[i];
  if (!form) return;
  state.items[i].collapsed = collapsed;
  $('.item-body', form).hidden = collapsed;
  $('.item-toggle', form).setAttribute('aria-expanded', String(!collapsed));
}

function refreshItemHead(i) {
  const form = $$('.item-form')[i], it = state.items[i];
  if (!form || !it) return;
  const name = it.title.trim(), nameEl = $('.item-name', form), cat = core.CATEGORIES.find((c) => c.id === it.category), chip = $('.item-cat', form);
  nameEl.textContent = name || 'New item';
  nameEl.classList.toggle('empty', !name);
  chip.hidden = !cat;
  chip.textContent = cat ? cat.label : '';
  chip.className = `item-cat chip${cat ? ` cat-${cat.id}` : ''}`;
  if (!cat) chip.hidden = true;
}

/* ------------------------------------------------------------------ problems next to the fields */
function setMsg(field, msg, showNow) {
  if (!field) return;
  const m = $('.field-msg', field);
  const show = !!msg && (showNow || field.classList.contains('touched'));
  field.classList.toggle('invalid', !!msg);
  field.classList.toggle('show-err', show);
  if (m) m.textContent = msg || '';
  $$('input:not([type=radio]),select,textarea', field).forEach((c) => { if (show) c.setAttribute('aria-invalid', 'true'); else c.removeAttribute('aria-invalid'); });
}

function applyIssues() {
  const is = state.issues;
  if (!is) return;
  const now = state.tried;
  for (const k of ['version', 'date', 'title', 'summary']) setMsg($(`#${k}`).closest('.field'), is.meta[k], now);
  $$('.item-form').forEach((form, i) => {
    const o = is.items[i];
    if (!o) return;
    setMsg($('[data-fk=category]', form), o.category, now);
    setMsg($('[data-fk=title]', form), o.title, now);
    setMsg($('[data-fk=desc]', form), o.desc, now);
    $$('.shot-row', form).forEach((row, k) => setMsg($('[data-fk=alt]', row), o.shots[k], now));
    const n = [o.category, o.title, o.desc, ...o.shots].filter(Boolean).length;
    const flag = $('.item-flag', form);
    flag.hidden = !(n && (now || $('.touched', form)));
    flag.textContent = n ? `${n} to fix` : '';
  });
}

function focusField(sel, item) {
  if (item >= 0 && state.items[item]?.collapsed) setCollapsed(item, false);
  const el = $(sel);
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: smooth() });
  if (el.focus) el.focus({ preventScroll: true });
  return true;
}
function goToFirstProblem() {
  for (const p of editor.problemOrder(state.issues)) if (focusField(p.sel, p.item)) return true;
  $('#checks').scrollIntoView({ block: 'center', behavior: smooth() });
  return false;
}

/* ------------------------------------------------------------------ live checks */
const readModel = () => ({
  version: $('#version').value.trim(), date: $('#date').value, type: $('#type').value, status: $('#status').value, featured: $('#featured').checked,
  title: $('#title').value, summary: $('#summary').value, tags: $('#tags').value, overview: $('#overview').value, links: state.links, items: state.items,
});
let timer, saveTimer, touched = false; // problems are only listed once the person has started filling the form in
const scheduleCheck = () => { touched = true; clearTimeout(timer); timer = setTimeout(runChecks, 150); scheduleSave(); };

function renderStepper() {
  const is = state.issues, done = { details: is.detailsOk, changes: is.changesOk, publish: state.done }, num = { details: 1, changes: 2, publish: 3 };
  $$('#stepper a').forEach((a) => {
    const k = a.dataset.step, ok = !!done[k];
    a.dataset.done = String(ok);
    $('.step-dot', a).textContent = ok ? '✓' : String(num[k]);
    $('.step-state', a).textContent = ok ? ' (done)' : '';
  });
}

let spyQueued = false;
function queueSpy() { if (!spyQueued) { spyQueued = true; requestAnimationFrame(spy); } }
function spy() {
  spyQueued = false;
  if (state.tab !== 'add') return;
  let cur = 'details';
  for (const id of ['details', 'changes', 'publish']) { const el = document.getElementById(id); if (el && el.getBoundingClientRect().top <= 160) cur = id; }
  if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) cur = 'publish';
  $$('#stepper a').forEach((a) => { if (a.dataset.step === cur) a.setAttribute('aria-current', 'step'); else a.removeAttribute('aria-current'); });
}

function updateBar(n) {
  const draft = $('#status').value === 'draft';
  $('#publishBtn').textContent = draft ? 'Save draft' : 'Publish release';
  $('#publishBtn').disabled = state.busy || state.done;
  let k = 'info', text = '', fix = false;
  if (state.done) { k = 'ok'; text = 'Saved to GitHub.'; }
  else if (n && touched) { k = 'warn'; text = `${plural(n, 'thing')} to fix before you can ${draft ? 'save' : 'publish'}.`; fix = true; }
  else if (n) text = 'Fill in the form, preview it, then publish.';
  else if (!state.conn) { k = 'warn'; text = 'Ready. Connect to GitHub to publish.'; }
  else { k = 'ok'; text = draft ? 'Ready to save as a draft.' : 'Ready to publish.'; }
  $('#actionBar').dataset.k = k;
  $('#publishHint').textContent = text;
  $('#barFix').hidden = !fix;
}
function flash(text) { // a short message in the bar (until the next check)
  $('#actionBar').dataset.k = 'err';
  $('#publishHint').textContent = text;
  $('#barFix').hidden = true;
}

function runChecks() {
  const model = readModel();
  const ctx = { existingVersions: (state.conn?.releases || []).map((r) => r.version), imageSizes: Object.fromEntries(state.items.flatMap((it) => it.images.map((im) => [im.name, im.size]))) };
  const gen = core.validateRelease(model, ctx);
  let errors = gen.errors, warnings = gen.warnings, content = gen.content;
  if (!state.jsonOverride) $('#json').value = JSON.stringify(gen.content, null, 2);
  else {
    content = null;
    try { content = JSON.parse($('#json').value); } catch (e) { errors = [`The JSON has a mistake: ${e.message}`]; warnings = []; }
    if (content) {
      const m = core.validateMeta(model, ctx), a = core.validateAttachments(model, ctx), s = core.validateContent(content, a.names, { published: model.status !== 'draft' });
      errors = [...m.errors, ...a.errors, ...s.errors]; warnings = [...m.warnings, ...a.warnings, ...s.warnings];
    }
  }
  const rows = [];
  if (!state.conn) rows.push(['info', 'You are not connected to GitHub yet. You can keep writing and preview the page; connect before publishing.']);
  if (touched) {
    errors.forEach((e) => rows.push(['err', e]));
    warnings.forEach((w) => rows.push(['warn', w]));
    if (!errors.length && state.conn) rows.push(['good', 'Everything checks out. Press Publish when you are ready.']);
  } else rows.push(['info', 'Fill in the details above. Anything that needs fixing will be listed here.']);
  $('#checks').innerHTML = rows.map(([k, t]) => {
    const j = k === 'err' || k === 'warn' ? editor.jumpTarget(t) : null;
    return `<li class="${k}"><span>${esc(t)}</span>${j ? `<button type="button" class="linkish" data-jump="${esc(j.sel)}" data-item="${j.item}">Go to it</button>` : ''}</li>`;
  }).join('');

  const counts = {};
  (content?.items || []).forEach((it) => { counts[it.category] = (counts[it.category] || 0) + 1; });
  const shots = state.items.reduce((n, it) => n + it.images.length, 0);
  const bytes = state.items.reduce((n, it) => n + it.images.reduce((m, im) => m + im.size, 0), 0);
  $('#summaryBox').innerHTML = [
    `<span class="chip type-${esc(model.type)}">v${esc(model.version || '?')}</span>`,
    `<span class="chip">${esc(model.date || 'no date')}</span>`,
    `<span class="chip ${model.status === 'draft' ? 'draft' : 'featured'}">${model.status === 'draft' ? 'Draft' : 'Will be published'}</span>`,
    ...core.CATEGORIES.filter((c) => counts[c.id]).map((c) => `<span class="chip cat-${c.id}">${counts[c.id]} ${esc(c.label)}${counts[c.id] > 1 ? 's' : ''}</span>`),
    shots ? `<span class="chip">${shots} screenshot${shots > 1 ? 's' : ''} · ${fmtBytes(bytes)}</span>` : '',
  ].join('');

  state.ready = !errors.length && content ? { entry: gen.entry, content } : null;
  state.view = content ? { entry: gen.entry, content, problems: errors.length } : null; // what the preview draws, even while there are problems
  state.issues = editor.fieldIssues(model, ctx);

  const len = model.summary.trim().length;
  $('#summaryCount').textContent = len ? `${plural(len, 'character')}${len > 260 ? ': a little long, aim for one or two sentences' : ''}` : 'Shown on the release card and in search results.';
  const extras = (model.tags.trim() ? 1 : 0) + (model.featured ? 1 : 0) + state.links.filter((l) => l.label.trim() || l.url.trim()).length;
  $('#moreCount').textContent = extras ? `(${extras} set)` : '';

  applyIssues();
  renderStepper();
  updateBar(errors.length);
  queueSpy();
}

/* ------------------------------------------------------------------ your draft, kept in this browser */
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 800); }
function saveDraft() {
  if (state.done) return;
  const d = editor.makeDraft({ form: readModel(), links: state.links, items: state.items });
  if (editor.isBlankDraft(editor.readDraft(d))) store.del(editor.DRAFT_KEY);
  else store.set(editor.DRAFT_KEY, JSON.stringify(d));
}
function offerDraft() {
  const d = editor.readDraft(store.get(editor.DRAFT_KEY));
  if (!d || editor.isBlankDraft(d)) return;
  const shots = d.items.reduce((n, it) => n + it.shots, 0);
  $('#draftText').textContent = `You have an unfinished release from ${editor.timeAgo(d.at)}${d.form.title.trim() ? `: “${d.form.title.trim()}”` : ''}.${shots ? ` Its ${plural(shots, 'screenshot')} could not be kept, so add them again.` : ''}`;
  $('#draftNote').hidden = false;
  $('#draftRestore').onclick = () => { restoreDraft(d); $('#draftNote').hidden = true; };
}
function restoreDraft(d) {
  const f = d.form;
  $('#version').value = f.version; $('#date').value = f.date || todayIso(); $('#type').value = f.type; $('#status').value = f.status;
  $('#featured').checked = f.featured; $('#title').value = f.title; $('#summary').value = f.summary; $('#tags').value = f.tags; $('#overview').value = f.overview;
  state.typeTouched = true;
  state.links = d.links;
  state.items = d.items.length ? d.items.map((it) => ({ ...newItem(), category: it.category, title: it.title, module: it.module, audience: it.audience, summary: it.summary, body: it.body })) : [newItem()];
  if (state.links.length || f.tags || f.featured) $('#moreOpts').open = true;
  renderItems(); renderLinks();
  touched = true;
  runChecks();
}

function syncType() {
  const v = $('#version').value.trim();
  if (!state.typeTouched && core.isSemver(v)) $('#type').value = core.typeFromVersion(v);
}

/* ------------------------------------------------------------------ publish */
async function onPublishClick() {
  runChecks();
  if (state.busy || state.done) return;
  if (!state.conn) { focusConnect('Connect to GitHub first, then press Publish again.'); return; }
  if (!state.ready) { state.tried = true; touched = true; runChecks(); goToFirstProblem(); return; }
  doPublish();
}

async function doPublish() {
  runChecks();
  if (!state.ready || !state.conn || state.busy) return;
  const { entry, content } = state.ready, cfg = getCfg();
  state.busy = true; updateBar(0);
  const prog = $('#progress'), result = $('#result');
  prog.hidden = false; prog.innerHTML = ''; result.hidden = true;
  prog.scrollIntoView({ block: 'center', behavior: smooth() });
  const say = (t) => { const li = document.createElement('li'); li.textContent = t; prog.appendChild(li); };
  try {
    const images = state.items.flatMap((it) => it.images.map((im) => ({ name: im.name, bytes: im.bytes })));
    const res = await core.publish({ ...cfg, entry, content, images, message: `Add release ${entry.version}: ${entry.title}`, onProgress: say });
    state.done = true; state.busy = false;
    store.del(editor.DRAFT_KEY);
    say('Saved to GitHub.');
    result.className = 'result'; result.hidden = false;
    result.innerHTML = `<p><strong>Saved.</strong> Your release is in the repository (<a href="${esc(res.commitUrl)}" target="_blank" rel="noopener noreferrer">commit ${esc(res.commitSha.slice(0, 7))}</a>).</p><p id="buildLine">Waiting for the website build to start…</p><button class="btn btn-outline btn-sm" type="button" id="another">Add another release</button>`;
    $('#another').addEventListener('click', () => location.reload());
    watchBuild(res.commitSha, entry, cfg);
  } catch (e) {
    state.busy = false;
    say('Stopped.');
    result.className = 'result bad'; result.hidden = false;
    result.innerHTML = `<p><strong>Nothing was published.</strong></p><p>${esc(e.message || String(e))}</p>`;
  }
  runChecks();
}

/** The build passed. Only say "Live" once the new page really loads (not just that GitHub says it deployed). */
async function showLive(line, sha, entry) {
  const base = siteBase();
  // The text shows the clean address (good for copying); the click opens it with a fresh-copy marker.
  const link = `<a href="${esc(core.liveLink(base, entry.version, sha))}" target="_blank" rel="noopener noreferrer">${esc(`${base}releases/v${entry.version}/`)}</a>`;
  if (new URL(base).origin !== location.origin) { // opened from somewhere else (for example a local preview): cannot check from here
    line.innerHTML = `The build passed. Open ${link} to see it. <span class="muted">(This page is not on the website itself, so it cannot check for you.)</span>`;
    return;
  }
  line.textContent = 'The build finished. Checking that the new page really loads…';
  const res = await core.checkLive({ baseUrl: base, version: entry.version, onAttempt: (n) => { if (n > 1) line.textContent = `The build finished. Waiting for GitHub to publish the page (check ${n})…`; } });
  line.innerHTML = res.ok
    ? `<strong>Live and checked:</strong> ${link}<br><span class="muted">The new page and the release list both load. If your browser shows an older copy, press Ctrl + F5.</span>`
    : `The build passed, but the page could not be reached yet (${esc(res.reason)}). GitHub can take a few minutes to publish new pages. Try ${link} again in a minute, and press Ctrl + F5 if it still looks old.`;
}

/** Waits for the workflow run GitHub started for a commit. Returns {run} when finished, or {unreadable}/{timedOut}. */
async function waitForBuild(sha, cfg, say) {
  for (let n = 0; n < 60; n++) {
    await new Promise((r) => setTimeout(r, n === 0 ? 4000 : 5000));
    let run = null;
    try { run = await core.getBuildRun({ ...cfg, sha }); } catch { return { unreadable: true }; }
    if (!run) continue;
    if (run.status !== 'completed') { say('Building the website (usually under a minute)…'); continue; }
    return { run };
  }
  return { timedOut: true };
}
const actionsLink = (cfg) => `<a href="${esc(`https://github.com/${cfg.owner}/${cfg.repo}/actions`)}" target="_blank" rel="noopener noreferrer">Actions tab</a>`;
const unreadable = `this page cannot read the build status (the token may lack “Actions: Read”). Check the`;

async function watchBuild(sha, entry, cfg) {
  const line = $('#buildLine');
  const r = await waitForBuild(sha, cfg, (t) => { line.textContent = t; });
  if (r.unreadable) { line.innerHTML = `The release is saved, but ${unreadable} ${actionsLink(cfg)}.`; return; }
  if (r.timedOut) { line.innerHTML = `The build is taking longer than expected. Check the ${actionsLink(cfg)}.`; return; }
  if (r.run.conclusion === 'success') {
    if (entry.status === 'draft') line.innerHTML = 'Saved as a <strong>draft</strong>. It is not on the website.';
    else await showLive(line, sha, entry);
  } else {
    $('#result').className = 'result bad';
    line.innerHTML = `<strong>The website build failed, so the site was not changed.</strong> <a href="${esc(r.run.url)}" target="_blank" rel="noopener noreferrer">See why</a>. Your files are saved in the repository; ask Claude to fix them, or edit <code>releases/v${esc(entry.version)}/content.json</code> on GitHub.`;
  }
}

/* ------------------------------------------------------------------ preview */
// The page is drawn by the same code the website build uses (assets/js/render-shared.mjs) and shown in a sandboxed frame
// (scripts off, same origin so the stylesheets and blob: screenshots load). Nothing is saved or sent anywhere.
const pv = { dlg: $('#preview'), frame: $('#pvFrame'), stage: $('#pvStage'), note: $('#pvNote'), foot: $('#pvFoot'), dispose: null, footTimer: 0 };
const PV_FOOT = 'Links to other pages are switched off here. The previous / next links and the “Latest release” badge are added by the website once the release is on it.';
const mimeOf = (name) => MIME[name.slice(name.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream';

/** Natural size of each screenshot, so the frame reserves space for it exactly like the built page does. */
function measureImages(urls) {
  const sizes = {};
  return Promise.all(Object.entries(urls).map(([name, url]) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { if (img.naturalWidth) sizes[name] = { w: img.naturalWidth, h: img.naturalHeight }; resolve(); };
    img.onerror = () => resolve();
    setTimeout(resolve, 4000);
    img.src = url;
  }))).then(() => sizes);
}

function setPvFoot(text, temporary) {
  clearTimeout(pv.footTimer);
  pv.foot.textContent = text;
  if (temporary) pv.footTimer = setTimeout(() => { pv.foot.textContent = PV_FOOT; }, 4500);
}

function onFrameClick(e) {
  const a = e.target.closest && e.target.closest('a');
  if (!a) return;
  e.preventDefault(); // nothing in the frame may navigate the frame away
  const href = a.getAttribute('href') || '';
  if (href.startsWith('#')) { // in-page links (contents list, section anchors); handled here because a frame built from text resolves "#x" against this page
    let id = href.slice(1);
    try { id = decodeURIComponent(id); } catch { /* keep as is */ }
    a.ownerDocument.getElementById(id)?.scrollIntoView({ block: 'start' });
  } else if (/^(https?:|blob:)/i.test(a.href) && (a.hasAttribute('data-lightbox') || /^https?:\/\//i.test(href))) {
    window.open(a.href, '_blank', 'noopener'); // enlarge a screenshot, or follow an outside link, in a new tab
  } else setPvFoot('That link goes to another page of the website, so it is switched off in the preview.', true);
}

function wireFrame() {
  const doc = pv.frame.contentDocument, win = pv.frame.contentWindow;
  if (!doc || !doc.body || !doc.body.dataset.version) return; // the empty frame before / after a preview
  const toc = doc.querySelector('.toc');
  if (toc) { // same as the website: the contents list starts open on wide screens and folded on narrow ones
    const mq = win.matchMedia('(max-width: 1100px)');
    const sync = () => { toc.open = !mq.matches; };
    sync(); mq.addEventListener('change', sync);
  }
  doc.addEventListener('click', onFrameClick);
}

/** images: {fileName: blob url}. Throws if the page cannot be drawn; the caller owns (and revokes) the urls unless this succeeds. */
async function openPreview({ entry, content, images = {}, lead, dispose }) {
  const prep = preview.prepare(entry, content, todayIso());
  const sizes = await measureImages(images);
  const imageInfo = (src) => { const m = /^images\/([^/]+)$/.exec(src); return m ? sizes[m[1]] : undefined; };
  const chrome = { skip: $('.skip')?.outerHTML || '', header: $('.site-header')?.outerHTML || '', footer: $('.site-footer')?.outerHTML || '' };
  let html;
  try { html = preview.previewDocument({ entry: prep.entry, content: prep.content, imageUrls: images, imageInfo, ...chrome }); }
  catch (e) { throw new Error(`The preview could not be drawn: ${e.message || e}. Check the content for a mistake.`); }
  pv.note.textContent = [lead, ...preview.describeGaps(prep)].filter(Boolean).join(' ');
  $('#pvTitle').textContent = `Preview of v${prep.entry.version}`;
  setPvFoot(PV_FOOT);
  pv.dispose = dispose || null;
  pv.dlg.showModal();
  pv.frame.srcdoc = html;
}
pv.frame.addEventListener('load', wireFrame);
pv.dlg.addEventListener('close', () => {
  pv.frame.srcdoc = '';
  if (pv.dispose) { pv.dispose(); pv.dispose = null; }
});
pv.dlg.addEventListener('click', (e) => { if (e.target === pv.dlg) pv.dlg.close(); }); // the dark area around the box
$('#pvClose').addEventListener('click', () => pv.dlg.close());
$('#preview .pv-sizes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-size]'); if (!b) return;
  pv.stage.dataset.size = b.dataset.size;
  $$('#preview .pv-sizes [data-size]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
});

/** Preview of what is in the form right now (steps 1 and 2), before anything is saved. */
async function previewForm() {
  runChecks();
  if (!state.view) { flash('The JSON has a mistake, so there is nothing to preview yet. Fix it or press “Reset from the form”.'); return; }
  const { entry, content, problems } = state.view;
  const images = Object.fromEntries(state.items.flatMap((it) => it.images.map((im) => [im.name, im.url]))); // the form's own blob urls: the form revokes them
  const lead = `${entry.status === 'draft' ? 'This is how the draft will look.' : 'This is how the page will look once it is published.'} Nothing has been saved yet.` +
    (problems ? ` ${plural(problems, 'thing')} still need${problems > 1 ? '' : 's'} fixing before you can publish (listed in step 3).` : '');
  try { await openPreview({ entry, content, images, lead }); }
  catch (e) { flash(e.message || String(e)); }
}

/** Preview of a release that is already saved in the repository (Manage releases). Reads it from GitHub; changes nothing. */
async function previewSaved(li) {
  if (state.managing || state.previewing) return;
  const v = li.dataset.v, extra = $('.rel-extra', li), btn = $('[data-act=preview]', li), cfg = getCfg();
  closeConfirms();
  extra.hidden = false;
  extra.innerHTML = '<p class="muted">Loading the saved release…</p>';
  state.previewing = true; btn.disabled = true;
  const urls = [];
  try {
    const r = await core.loadReleaseForPreview({ ...cfg, version: v, onProgress: (t) => { $('p', extra).textContent = t; } });
    if (r.custom) {
      const link = r.entry.status === 'draft' ? '' : ` <a href="${esc(`${siteBase()}releases/v${v}/`)}" target="_blank" rel="noopener noreferrer">Open it on the website</a>.`;
      extra.innerHTML = `<div class="confirm neutral"><p><strong>v${esc(v)} uses a hand-written page.</strong> It is not built from a form, so it cannot be previewed here.${link}</p>${closeBtn}</div>`;
      return;
    }
    const images = {};
    for (const im of r.images) { const u = URL.createObjectURL(new Blob([im.bytes], { type: mimeOf(im.name) })); urls.push(u); images[im.name] = u; }
    const lead = r.entry.status === 'draft'
      ? `This is the saved draft of v${v}, read from GitHub just now. It is not on the website.`
      : `This is v${v} as saved in the repository (read from GitHub just now), drawn the same way the website draws it.`;
    await openPreview({ entry: r.entry, content: r.content, images, lead, dispose: () => urls.forEach((u) => URL.revokeObjectURL(u)) });
    closeConfirms();
  } catch (e) {
    urls.forEach((u) => URL.revokeObjectURL(u));
    extra.innerHTML = `<div class="confirm bad"><p>${esc(e.message || String(e))}</p>${closeBtn}</div>`;
  } finally { state.previewing = false; btn.disabled = false; }
}

/* ------------------------------------------------------------------ manage releases: publish, unpublish, delete */
const relOrder = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || core.compareVersions(b.version, a.version);
const typedMatches = (typed, version) => typed.trim().replace(/^v/i, '') === version; // "2.43.0" or "v2.43.0"

function renderManage() {
  const ul = $('#relList');
  $('#mgTools').hidden = !state.conn;
  if (!state.conn) {
    ul.innerHTML = '<li class="rel-empty"><p><strong>Connect to GitHub to see your releases.</strong></p><p>Then you can preview, publish, unpublish or delete any of them here.</p><button type="button" class="btn btn-primary btn-sm" data-act="open-connect">Connect</button></li>';
    return;
  }
  const all = [...state.conn.releases].sort(relOrder);
  const isDraft = (r) => r.status === 'draft';
  const counts = { all: all.length, published: all.filter((r) => !isDraft(r)).length, draft: all.filter(isDraft).length };
  $$('[data-count]').forEach((s) => { s.textContent = counts[s.dataset.count]; });
  const q = state.query.trim().toLowerCase();
  const list = all.filter((r) => (state.filter === 'all' || (state.filter === 'draft') === isDraft(r)) && (!q || `v${r.version} ${r.title || ''}`.toLowerCase().includes(q)));
  if (!all.length) { ul.innerHTML = '<li class="rel-empty"><p><strong>There are no releases in the repository yet.</strong></p><p>Use the <em>Add a release</em> tab to create the first one.</p></li>'; return; }
  if (!list.length) { ul.innerHTML = '<li class="rel-empty"><p><strong>No releases match.</strong></p><p>Try a different search, or show all releases.</p></li>'; return; }
  ul.innerHTML = list.map((r) => {
    const draft = isDraft(r);
    return `
    <li class="rel-row" data-v="${esc(r.version)}">
      <div class="rel-main">
        <div class="rel-line"><strong class="rel-ver">v${esc(r.version)}</strong><span class="muted">${esc(r.date || '')}</span>
          <span class="chip ${draft ? 'draft' : 'featured'}">${draft ? 'Draft' : 'Published'}</span>${r.sample ? '<span class="chip sample">Sample</span>' : ''}</div>
        <div class="rel-title">${esc(r.title || '')}</div>
      </div>
      <div class="rel-actions">
        ${draft ? '' : `<a class="linkish" href="${esc(`${siteBase()}releases/v${r.version}/`)}" target="_blank" rel="noopener noreferrer">View on website</a>`}
        <button type="button" class="btn btn-outline btn-sm" data-act="preview">Preview</button>
        <button type="button" class="btn btn-outline btn-sm" data-act="ask-status" data-to="${draft ? 'published' : 'draft'}">${draft ? 'Publish' : 'Unpublish'}</button>
        <button type="button" class="btn btn-outline-danger btn-sm" data-act="ask-delete">Delete…</button>
      </div>
      <div class="rel-extra" hidden></div>
    </li>`;
  }).join('');
}

async function refreshReleases() {
  if (!state.conn || state.managing) return;
  const st = $('#relStatus'), btn = $('#relRefresh');
  btn.disabled = true; setStatus(st, 'Refreshing…');
  try {
    const c = await core.connect(getCfg());
    state.conn.releases = c.releases;
    renderConn(); renderManage(); runChecks();
    setStatus(st, `Up to date: ${plural(c.releases.length, 'release')}.`, 'ok');
  } catch (e) { setStatus(st, e.message || String(e), 'err'); }
  btn.disabled = false;
}

const closeConfirms = () => $$('#relList .rel-extra').forEach((x) => { x.hidden = true; x.innerHTML = ''; });
const closeBtn = '<button type="button" class="btn btn-outline btn-sm" data-act="cancel-confirm">Close</button>';
const problemList = (items) => `<ul class="list">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;

async function askDelete(li) {
  if (state.managing) return;
  const v = li.dataset.v, extra = $('.rel-extra', li), cfg = getCfg();
  closeConfirms();
  extra.hidden = false;
  extra.innerHTML = '<p class="muted">Checking what would be removed…</p>';
  try {
    const p = await core.previewDelete({ ...cfg, version: v });
    const rel = state.conn.releases.find((r) => r.version === v) || {};
    const live = rel.status !== 'draft';
    extra.innerHTML = `
      <div class="confirm">
        <p><strong>Delete v${esc(v)}${rel.title ? ` “${esc(rel.title)}”` : ''}?</strong></p>
        <p>This removes the release page${p.files.length ? `, its ${p.files.length} file${p.files.length === 1 ? '' : 's'} (content and screenshots)` : ''} and its entry in the release list. ${live ? 'The website updates about a minute later and the release disappears from it.' : 'It is a draft, so the website itself does not change.'}</p>
        <p class="muted small">This cannot be undone from this page.${state.conn.isPrivate ? '' : ' The repository is public, so earlier versions of these files stay visible in its history.'}${live ? ' If you only want to hide it for now, use Unpublish instead.' : ''}</p>
        <label class="field"><span>Type <code>${esc(v)}</code> to confirm</span><input type="text" data-confirm autocomplete="off" spellcheck="false"></label>
        <div class="actions"><button type="button" class="btn btn-danger btn-sm" data-act="do-delete" disabled>Delete permanently</button><button type="button" class="btn btn-outline btn-sm" data-act="cancel-confirm">Cancel</button></div>
      </div>`;
    $('[data-confirm]', extra).focus();
  } catch (e) {
    extra.innerHTML = `<div class="confirm bad"><p>${esc(e.message || String(e))}</p>${closeBtn}</div>`;
  }
}

async function askStatus(li, to) {
  if (state.managing) return;
  const v = li.dataset.v, extra = $('.rel-extra', li), cfg = getCfg();
  closeConfirms();
  extra.hidden = false;
  extra.innerHTML = `<p class="muted">${to === 'published' ? 'Checking the release is complete…' : 'Checking…'}</p>`;
  try {
    const p = await core.previewStatusChange({ ...cfg, version: v, to });
    const rel = state.conn.releases.find((r) => r.version === v) || {};
    const name = `v${esc(v)}${rel.title ? ` “${esc(rel.title)}”` : ''}`;
    if (p.errors.length) {
      extra.innerHTML = `<div class="confirm bad"><p><strong>${to === 'published' ? `${name} cannot be published yet` : 'Nothing to change'}</strong></p>${problemList(p.errors)}${to === 'published' ? '<p class="muted small">Fix this (ask Claude, or edit the files on GitHub) and try again.</p>' : ''}${closeBtn}</div>`;
      return;
    }
    extra.innerHTML = to === 'published'
      ? `<div class="confirm neutral"><p><strong>Publish ${name}?</strong></p><p>It passes the same checks the website build uses. About a minute after you confirm, it appears on the website.</p><div class="actions"><button type="button" class="btn btn-primary btn-sm" data-act="do-status" data-to="published">Publish now</button><button type="button" class="btn btn-outline btn-sm" data-act="cancel-confirm">Cancel</button></div></div>`
      : `<div class="confirm neutral"><p><strong>Unpublish ${name}?</strong></p><p>About a minute after you confirm, it disappears from the website. Its files stay in the repository as a draft, and you can publish it again here at any time.</p><div class="actions"><button type="button" class="btn btn-primary btn-sm" data-act="do-status" data-to="draft">Unpublish</button><button type="button" class="btn btn-outline btn-sm" data-act="cancel-confirm">Cancel</button></div></div>`;
  } catch (e) {
    extra.innerHTML = `<div class="confirm bad"><p>${esc(e.message || String(e))}</p>${closeBtn}</div>`;
  }
}

/* shared by delete / publish / unpublish: progress list + result box */
function beginManage() {
  state.managing = true;
  closeConfirms();
  const prog = $('#mgProgress'), result = $('#mgResult');
  prog.hidden = false; prog.innerHTML = ''; result.hidden = true;
  return { result, say: (t) => { const item = document.createElement('li'); item.textContent = t; prog.appendChild(item); } };
}
function failManage(m, e, headline) {
  state.managing = false;
  m.say('Stopped.');
  m.result.className = 'result bad'; m.result.hidden = false;
  m.result.innerHTML = `<p><strong>${esc(headline)}</strong></p>${e.errors && e.errors.length ? problemList(e.errors) : `<p>${esc(e.message || String(e))}</p>`}`;
  m.result.scrollIntoView({ block: 'nearest', behavior: smooth() });
}
function okManage(m, res, headline) {
  state.managing = false;
  m.say('Saved to GitHub.');
  m.result.className = 'result'; m.result.hidden = false;
  m.result.innerHTML = `<p><strong>${esc(headline)}</strong> The change is in the repository (<a href="${esc(res.commitUrl)}" target="_blank" rel="noopener noreferrer">commit ${esc(res.commitSha.slice(0, 7))}</a>).</p><p id="mgLine">Waiting for the website build to start…</p>`;
  m.result.scrollIntoView({ block: 'nearest', behavior: smooth() });
}

async function doDelete(li) {
  const v = li.dataset.v, cfg = getCfg(), typed = $('[data-confirm]', li);
  if (state.managing || !typed || !typedMatches(typed.value, v)) return;
  const rel = state.conn.releases.find((r) => r.version === v) || {};
  const m = beginManage();
  try {
    const res = await core.deleteRelease({ ...cfg, version: v, message: `Delete release ${v}${rel.title ? `: ${rel.title}` : ''}`, onProgress: m.say });
    state.conn.releases = state.conn.releases.filter((r) => r.version !== v);
    renderConn(); renderManage(); runChecks();
    okManage(m, res, `Deleted v${v}.`);
    watchManage(res.commitSha, v, rel.status === 'draft' ? 'draft-only' : 'gone', cfg);
  } catch (e) { failManage(m, e, 'Nothing was deleted.'); }
}

async function doStatus(li, to) {
  const v = li.dataset.v, cfg = getCfg();
  if (state.managing) return;
  const m = beginManage();
  try {
    const res = await core.setReleaseStatus({ ...cfg, version: v, to, onProgress: m.say });
    const rel = state.conn.releases.find((r) => r.version === v);
    if (rel) rel.status = to;
    renderManage(); runChecks();
    okManage(m, res, to === 'published' ? `v${v} is now published.` : `v${v} is now a draft.`);
    watchManage(res.commitSha, v, to === 'published' ? 'live' : 'unpublished', cfg);
  } catch (e) { failManage(m, e, to === 'published' ? 'Nothing was published.' : 'Nothing was changed.'); }
}

/** After the commit: wait for the build, then check the website really shows (or no longer shows) the release. */
async function watchManage(sha, version, goal, cfg) {
  const line = $('#mgLine');
  const r = await waitForBuild(sha, cfg, (t) => { line.textContent = t; });
  if (r.unreadable) { line.innerHTML = `The change is saved, but ${unreadable} ${actionsLink(cfg)}.`; return; }
  if (r.timedOut) { line.innerHTML = `The build is taking longer than expected. Check the ${actionsLink(cfg)}.`; return; }
  if (r.run.conclusion !== 'success') {
    $('#mgResult').className = 'result bad';
    line.innerHTML = `<strong>The website build failed, so the website still shows the old version of the site.</strong> <a href="${esc(r.run.url)}" target="_blank" rel="noopener noreferrer">See why</a>. The change is already saved in the repository.`;
    return;
  }
  if (goal === 'draft-only') { line.innerHTML = 'It was a draft, so the website did not show it and nothing changes there.'; return; }
  if (goal === 'live') { await showLive(line, sha, { version }); return; }
  const base = siteBase();
  if (new URL(base).origin !== location.origin) { line.textContent = 'The build passed. This page is not on the website itself, so it cannot check; open the site to confirm.'; return; }
  line.textContent = 'The build finished. Checking that the release is really gone from the website…';
  const res = await core.checkGone({ baseUrl: base, version, onAttempt: (n) => { if (n > 1) line.textContent = `The build finished. Waiting for GitHub to publish the change (check ${n})…`; } });
  line.innerHTML = res.ok
    ? `<strong>Removed from the website.</strong>${goal === 'unpublished' ? ' Its files are still in the repository as a draft.' : ''}<br><span class="muted">If your browser still shows it, press Ctrl + F5 (browsers can keep an old copy for a few minutes).</span>`
    : `The build passed, but the website still seems to show it (${esc(res.reason)}). GitHub can take a few minutes to publish changes. Check again in a minute, and press Ctrl + F5.`;
}

/* ------------------------------------------------------------------ events: connection and tabs */
$('#connToggle').addEventListener('click', () => { if (state.conn) disconnect(); else focusConnect(); });
$('#connectBtn').addEventListener('click', doConnect);
$('#token').addEventListener('keydown', (e) => { if (e.key === 'Enter') doConnect(); });
$('#tokenShow').addEventListener('click', (e) => {
  const input = $('#token'), show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  e.currentTarget.textContent = show ? 'Hide' : 'Show';
  e.currentTarget.setAttribute('aria-pressed', String(show));
});
for (const id of ['#owner', '#repo', '#branch', '#token']) $(id).addEventListener('input', () => { if (id !== '#token') updateRepoSummary(); invalidateConnection(); });

$('.tabs').addEventListener('click', (e) => { const b = e.target.closest('[role=tab]'); if (b) showTab(b.id === 'tab-manage' ? 'manage' : 'add'); });
$('.tabs').addEventListener('keydown', (e) => {
  const order = ['add', 'manage'], at = order.indexOf(state.tab);
  const next = e.key === 'ArrowRight' ? order[(at + 1) % 2] : e.key === 'ArrowLeft' ? order[(at + 1) % 2] : e.key === 'Home' ? 'add' : e.key === 'End' ? 'manage' : null;
  if (!next) return;
  e.preventDefault(); showTab(next); $(`#tab-${next}`).focus();
});
addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (h === 'manage') showTab('manage', { updateHash: false });
  else if (['details', 'changes', 'publish'].includes(h)) { showTab('add', { updateHash: false }); document.getElementById(h)?.scrollIntoView({ behavior: smooth() }); }
});
addEventListener('scroll', queueSpy, { passive: true });

/* ------------------------------------------------------------------ events: the form */
$('#items').addEventListener('input', (e) => {
  const form = e.target.closest('.item-form'); if (!form) return;
  const i = +form.dataset.i, it = state.items[i];
  if (e.target.dataset.f && e.target.type !== 'radio') { it[e.target.dataset.f] = e.target.value; if (e.target.dataset.f === 'title') refreshItemHead(i); }
  else if (e.target.dataset.img) it.images[+e.target.closest('.shot-row').dataset.k][e.target.dataset.img] = e.target.value;
  scheduleCheck();
});
$('#items').addEventListener('change', (e) => {
  const form = e.target.closest('.item-form'); if (!form) return;
  const i = +form.dataset.i;
  if (e.target.dataset.f === 'category') { state.items[i].category = e.target.value; refreshItemHead(i); scheduleCheck(); }
  if (e.target.dataset.act === 'add-images') { const files = [...e.target.files]; e.target.value = ''; addImages(i, files); }
});

const bodyBox = (form) => $('[data-f=body]', form);
const caretOf = (ta) => (document.activeElement === ta ? [ta.selectionStart, ta.selectionEnd] : ta.dataset.ss !== undefined ? [+ta.dataset.ss, +ta.dataset.se] : [ta.value.length, ta.value.length]);
function writeBody(ta, r) { // put the new text and selection in the box and tell the page it changed
  ta.value = r.text;
  ta.dataset.ss = r.start; ta.dataset.se = r.end;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(r.start, r.end);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
$('#items').addEventListener('focusout', (e) => {
  if (e.target.matches && e.target.matches('[data-f=body]')) { e.target.dataset.ss = e.target.selectionStart; e.target.dataset.se = e.target.selectionEnd; }
  const f = e.target.closest && e.target.closest('.field');
  if (f && !f.classList.contains('touched')) { f.classList.add('touched'); applyIssues(); }
});
$('#items').addEventListener('mousedown', (e) => { if (e.target.closest('.tb button')) e.preventDefault(); }); // keep the text selected while a formatting button is pressed
$('#items').addEventListener('click', (e) => {
  const fmt = e.target.closest('[data-fmt]');
  if (fmt) {
    const form = fmt.closest('.item-form'), ta = bodyBox(form), [s, en] = caretOf(ta);
    writeBody(ta, editor.applySyntax(ta.value, s, en, fmt.dataset.fmt));
    return;
  }
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const form = b.closest('.item-form'), i = +form.dataset.i, it = state.items[i];
  if (b.dataset.act === 'toggle-item') { setCollapsed(i, !it.collapsed); return; }
  if (b.dataset.act === 'insert-image') {
    const ta = bodyBox(form), k = +b.closest('.shot-row').dataset.k, [s, en] = caretOf(ta);
    writeBody(ta, editor.insertImageTag(ta.value, s, en, k + 1));
    return;
  }
  if (b.dataset.act === 'remove-item') {
    const has = it.title.trim() || it.summary.trim() || it.body.trim() || it.images.length;
    if (has && !b.dataset.armed) { // removing real work asks for a second click
      b.dataset.armed = '1'; b.textContent = 'Click again to remove';
      setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'Remove'; } }, 3500);
      return;
    }
    it.images.forEach((im) => URL.revokeObjectURL(im.url)); state.items.splice(i, 1);
  }
  if (b.dataset.act === 'remove-image') { const k = +b.closest('.shot-row').dataset.k; URL.revokeObjectURL(it.images[k].url); it.images.splice(k, 1); }
  renderItems(); scheduleCheck();
});
$('#addItem').addEventListener('click', () => {
  state.items.push(newItem()); renderItems(); scheduleCheck();
  const last = $('#items').lastElementChild;
  last?.scrollIntoView({ block: 'nearest', behavior: smooth() });
  $('input[type=radio]', last)?.focus({ preventScroll: true });
});

/* drag and drop, and paste, for screenshots */
const dropTarget = (e) => (e.target.closest ? e.target.closest('.shots') : null);
$('#items').addEventListener('dragover', (e) => { const s = dropTarget(e); if (s && [...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); s.classList.add('dragging'); } });
$('#items').addEventListener('dragleave', (e) => { const s = dropTarget(e); if (s && !s.contains(e.relatedTarget)) s.classList.remove('dragging'); });
$('#items').addEventListener('drop', (e) => {
  const s = dropTarget(e); if (!s) return;
  e.preventDefault(); s.classList.remove('dragging');
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) addImages(+s.closest('.item-form').dataset.i, files);
});
document.addEventListener('paste', (e) => {
  if (state.tab !== 'add' || pv.dlg.open) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => /^image\//.test(f.type));
  if (!files.length) return; // plain text pastes are left alone
  const form = e.target.closest && e.target.closest('.item-form');
  const i = form ? +form.dataset.i : state.items.length === 1 ? 0 : -1;
  if (i < 0) return;
  e.preventDefault();
  addImages(i, files.map((f) => (/^image\.[a-z]+$/i.test(f.name) || !f.name ? new File([f], `screenshot.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }) : f)), ' from the clipboard');
});

$('#links').addEventListener('input', (e) => { const row = e.target.closest('.link-row'); if (row && e.target.dataset.lf) { state.links[+row.dataset.l][e.target.dataset.lf] = e.target.value; scheduleCheck(); } });
$('#links').addEventListener('click', (e) => { const b = e.target.closest('[data-act=remove-link]'); if (b) { state.links.splice(+b.closest('.link-row').dataset.l, 1); renderLinks(); scheduleCheck(); } });
$('#addLink').addEventListener('click', () => { state.links.push({ label: '', url: '', kind: 'video' }); renderLinks(); scheduleCheck(); $('#links').lastElementChild?.querySelector('input')?.focus(); });

for (const id of ['#version', '#date', '#type', '#status', '#featured', '#title', '#summary', '#overview', '#tags']) $(id).addEventListener('input', () => { if (id === '#version') syncType(); scheduleCheck(); });
$('#type').addEventListener('change', () => { state.typeTouched = true; });
$('#details').addEventListener('focusout', (e) => { const f = e.target.closest && e.target.closest('.field'); if (f && !f.classList.contains('touched')) { f.classList.add('touched'); applyIssues(); } });

/* publish bar */
$('#publishBtn').addEventListener('click', onPublishClick);
$('#previewBtn').addEventListener('click', previewForm);
$('#barFix').addEventListener('click', () => { state.tried = true; applyIssues(); goToFirstProblem(); });
$('#checks').addEventListener('click', (e) => {
  const b = e.target.closest('[data-jump]'); if (!b) return;
  state.tried = true; applyIssues();
  focusField(b.dataset.jump, +b.dataset.item);
});
$('#editJson').addEventListener('change', (e) => {
  state.jsonOverride = e.target.checked;
  $('#json').readOnly = !state.jsonOverride; $('#resetJson').hidden = !state.jsonOverride;
  runChecks();
});
$('#json').addEventListener('input', scheduleCheck);
$('#resetJson').addEventListener('click', () => { state.jsonOverride = false; $('#editJson').checked = false; $('#json').readOnly = true; $('#resetJson').hidden = true; runChecks(); });
$('#draftDiscard').addEventListener('click', () => { store.del(editor.DRAFT_KEY); $('#draftNote').hidden = true; });

/* manage releases */
$('#relList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const li = b.closest('.rel-row');
  if (b.dataset.act === 'open-connect') focusConnect();
  if (b.dataset.act === 'preview') previewSaved(li);
  if (b.dataset.act === 'ask-delete') askDelete(li);
  if (b.dataset.act === 'ask-status') askStatus(li, b.dataset.to);
  if (b.dataset.act === 'do-status') doStatus(li, b.dataset.to);
  if (b.dataset.act === 'cancel-confirm') closeConfirms();
  if (b.dataset.act === 'do-delete') doDelete(li);
});
$('#relList').addEventListener('input', (e) => { // the delete button only unlocks when the exact version number is typed
  if (!e.target.matches('[data-confirm]')) return;
  const li = e.target.closest('.rel-row');
  $('[data-act=do-delete]', li).disabled = !typedMatches(e.target.value, li.dataset.v);
});
$('#relSearch').addEventListener('input', (e) => { state.query = e.target.value; renderManage(); });
$('.seg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]'); if (!b) return;
  state.filter = b.dataset.filter;
  $$('.seg [data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderManage();
});
$('#relRefresh').addEventListener('click', refreshReleases);

window.addEventListener('beforeunload', (e) => {
  const typed = $('#title').value.trim() || state.items.some((it) => it.title.trim() || it.summary.trim() || it.images.length);
  if (typed && !state.done) { e.preventDefault(); e.returnValue = ''; }
});

/* ------------------------------------------------------------------ start */
(function init() {
  let cfg = {};
  try { cfg = JSON.parse(store.get('rn-admin-cfg') || '{}'); } catch { /* ignore */ }
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i), repoGuess = location.pathname.split('/')[1];
  $('#owner').value = cfg.owner || (m ? m[1] : '');
  $('#repo').value = cfg.repo || (m && repoGuess && repoGuess !== 'admin' ? repoGuess : '');
  $('#branch').value = cfg.branch || 'main';
  const saved = store.sget('rn-admin-token');
  if (saved) { $('#token').value = saved; $('#remember').checked = true; }
  $('#date').value = todayIso();
  state.items.push(newItem());
  updateRepoSummary(); renderItems(); renderLinks(); renderConn(); renderManage();
  runChecks(); // nothing has been typed yet, so no problems are listed
  showTab(tabFromHash(), { updateHash: false });
  offerDraft();
  if (saved && $('#owner').value && $('#repo').value) doConnect(); // the token was kept for this tab: connect without asking again
})();
