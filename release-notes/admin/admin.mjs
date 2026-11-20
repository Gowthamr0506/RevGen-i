// The release composer page. All the logic that matters (parsing, validation, the GitHub commit) is in core.mjs and is unit-tested;
// this file only wires it to the form.
import * as core from './core.mjs';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  sget: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  sset: (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* private mode */ } },
};
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif' };

const state = { conn: null, items: [], links: [], typeTouched: false, jsonOverride: false, busy: false, done: false, ready: null };
const newItem = () => ({ category: '', title: '', module: '', audience: '', summary: '', body: '', images: [] });

/* ------------------------------------------------------------------ small UI helpers */
function setStatus(el, text, kind = '') { el.textContent = text; el.className = `status ${kind}`.trim(); }
const getCfg = () => ({ owner: $('#owner').value.trim(), repo: $('#repo').value.trim(), branch: $('#branch').value.trim() || 'main', token: $('#token').value.trim() });
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const siteBase = () => state.conn?.site?.url || `${location.origin}${location.pathname.replace(/admin\/(index\.html)?$/, '')}`;
const allNames = () => new Set(state.items.flatMap((it) => it.images.map((im) => im.name)));

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

async function addImages(i, files) {
  const taken = allNames();
  const notes = [];
  for (const file of files) {
    if (!/^image\//.test(file.type)) { notes.push(`${file.name} is not an image and was skipped.`); continue; }
    const p = await prepareImage(file, $('#optimize').checked);
    let base = core.safeFileName(file.name);
    if (p.ext && !base.endsWith(p.ext)) base = base.replace(/\.[a-z0-9]+$/, '') + p.ext;
    const name = core.uniqueName(base, taken);
    const note = p.size < p.original ? `optimized ${fmtBytes(p.original)} to ${fmtBytes(p.size)}` : '';
    state.items[i].images.push({ name, alt: '', caption: '', bytes: p.bytes, size: p.size, note, url: URL.createObjectURL(new Blob([p.bytes], { type: MIME[p.ext] || 'image/png' })) });
  }
  state.items[i].notice = notes.join(' ');
  renderItems();
  scheduleCheck();
}

/* ------------------------------------------------------------------ rendering */
function renderItems() {
  const cats = ['<option value="">Choose a category…</option>', ...core.CATEGORIES.map((c) => `<option value="${c.id}">${c.label}</option>`)].join('');
  $('#items').innerHTML = state.items.map((it, i) => `
    <article class="item-form" data-i="${i}">
      <div class="item-head"><h3>Item ${i + 1}</h3>${state.items.length > 1 ? '<button type="button" class="btn btn-outline btn-sm" data-act="remove-item">Remove this item</button>' : ''}</div>
      <div class="grid2">
        <label class="field"><span>Category</span><select data-f="category">${cats}</select></label>
        <label class="field"><span>Title</span><input type="text" data-f="title" maxlength="140" autocomplete="off" placeholder="What the user sees, e.g. Remove Responsible Party" value="${esc(it.title)}"></label>
      </div>
      <div class="grid2">
        <label class="field"><span>Area (optional)</span><input type="text" data-f="module" autocomplete="off" placeholder="e.g. Submitted Claims" value="${esc(it.module)}"></label>
        <label class="field"><span>Who it is for (optional)</span><input type="text" data-f="audience" autocomplete="off" placeholder="e.g. Leads, Managers" value="${esc(it.audience)}"></label>
      </div>
      <label class="field"><span>Short description</span><textarea data-f="summary" rows="2" placeholder="One or two sentences.">${esc(it.summary)}</textarea></label>
      <label class="field"><span>Details (optional)</span><textarea data-f="body" rows="6" placeholder="Paragraphs, bullets, ### steps… see “How to write the details” below.">${esc(it.body)}</textarea></label>
      <div class="shots">
        <div class="shots-head"><strong>Screenshots</strong>
          <label class="btn btn-outline btn-sm file-btn">Add screenshots<input type="file" class="sr" data-act="add-images" accept="image/*" multiple></label></div>
        ${it.notice ? `<p class="hint">${esc(it.notice)}</p>` : ''}
        <ul class="shot-list">${it.images.map((im, k) => `
          <li class="shot-row" data-k="${k}">
            <img class="thumb" src="${im.url}" alt="Preview of ${esc(im.name)}">
            <div>
              <div class="shot-title"><strong>Screenshot ${k + 1}</strong><code>[[image ${k + 1}]]</code><span class="muted">${esc(im.name)} · ${fmtBytes(im.size)}${im.note ? ` (${esc(im.note)})` : ''}</span></div>
              <label class="field"><span>Alt text: describe what the screenshot shows</span><input type="text" data-img="alt" autocomplete="off" placeholder="e.g. The Users screen with the Add User window open" value="${esc(im.alt)}"></label>
              <label class="field"><span>Caption (optional)</span><input type="text" data-img="caption" autocomplete="off" value="${esc(im.caption)}"></label>
            </div>
            <button type="button" class="btn btn-outline btn-sm" data-act="remove-image">Remove</button>
          </li>`).join('')}</ul>
      </div>
    </article>`).join('');
  $('#items').querySelectorAll('.item-form').forEach((el, i) => { el.querySelector('[data-f=category]').value = state.items[i].category; });
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

/* ------------------------------------------------------------------ live checks */
const readModel = () => ({
  version: $('#version').value.trim(), date: $('#date').value, type: $('#type').value, status: $('#status').value, featured: $('#featured').checked,
  title: $('#title').value, summary: $('#summary').value, tags: $('#tags').value, overview: $('#overview').value, links: state.links, items: state.items,
});
let timer, touched = false; // problems are only listed once the person has started filling the form in
const scheduleCheck = () => { touched = true; clearTimeout(timer); timer = setTimeout(runChecks, 150); };

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
  if (!state.conn) rows.push(['info', 'Connect to GitHub in step 1 before publishing.']);
  if (touched) {
    errors.forEach((e) => rows.push(['err', e]));
    warnings.forEach((w) => rows.push(['warn', w]));
    if (!errors.length && state.conn) rows.push(['good', 'Everything checks out. Press Publish when you are ready.']);
  } else rows.push(['info', 'Fill in the details above. Anything that needs fixing will be listed here.']);
  $('#checks').innerHTML = rows.map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join('');

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
  const can = !!state.ready && !!state.conn && !state.busy && !state.done;
  $('#publishBtn').disabled = !can;
  $('#publishHint').textContent = state.done ? '' : !state.conn ? 'Connect first (step 1).' : errors.length && touched ? `Fix ${errors.length} thing${errors.length > 1 ? 's' : ''} above to publish.` : errors.length ? 'Fill in the details above to publish.' : '';
}

/* ------------------------------------------------------------------ connect */
async function doConnect() {
  const cfg = getCfg(), out = $('#connectStatus');
  if (!cfg.owner || !cfg.repo || !cfg.token) return setStatus(out, 'Enter the repository owner, repository name and your access token.', 'err');
  setStatus(out, 'Connecting…');
  $('#connectBtn').disabled = true;
  try {
    const c = await core.connect(cfg);
    state.conn = c;
    store.set('rn-admin-cfg', JSON.stringify({ owner: cfg.owner, repo: cfg.repo, branch: cfg.branch }));
    store.sset('rn-admin-token', $('#remember').checked ? cfg.token : null);
    const latest = c.releases.map((r) => r.version).filter(core.isSemver).sort(core.compareVersions).pop();
    setStatus(out, `Connected to ${c.fullName}${c.isPrivate ? ' (private)' : ' (public)'}. ${c.releases.length} release${c.releases.length === 1 ? '' : 's'} so far${latest ? `, latest v${latest}` : ''}.`, 'ok');
    $('#versionHint').textContent = latest ? `Latest in the repository: v${latest}. Suggested next: ${core.nextVersion(c.releases.map((r) => r.version))}` : 'Three numbers, e.g. 1.0.0';
    if (!$('#version').value) { $('#version').value = core.nextVersion(c.releases.map((r) => r.version)); syncType(); }
  } catch (e) {
    state.conn = null;
    setStatus(out, e.message || String(e), 'err');
  }
  $('#connectBtn').disabled = false;
  runChecks();
}
const invalidateConnection = () => { if (state.conn) { state.conn = null; setStatus($('#connectStatus'), 'Settings changed. Connect again.'); runChecks(); } };

function syncType() {
  const v = $('#version').value.trim();
  if (!state.typeTouched && core.isSemver(v)) $('#type').value = core.typeFromVersion(v);
}

/* ------------------------------------------------------------------ publish */
async function doPublish() {
  runChecks();
  if (!state.ready || !state.conn || state.busy) return;
  const { entry, content } = state.ready, cfg = getCfg();
  state.busy = true; $('#publishBtn').disabled = true;
  const prog = $('#progress'), result = $('#result');
  prog.hidden = false; prog.innerHTML = ''; result.hidden = true;
  const say = (t) => { const li = document.createElement('li'); li.textContent = t; prog.appendChild(li); };
  try {
    const images = state.items.flatMap((it) => it.images.map((im) => ({ name: im.name, bytes: im.bytes })));
    const res = await core.publish({ ...cfg, entry, content, images, message: `Add release ${entry.version}: ${entry.title}`, onProgress: say });
    state.done = true; state.busy = false;
    say('Saved to GitHub.');
    const live = `${siteBase()}releases/v${entry.version}/`;
    result.className = 'result'; result.hidden = false;
    result.innerHTML = `<p><strong>Saved.</strong> Your release is in the repository (<a href="${esc(res.commitUrl)}" target="_blank" rel="noopener noreferrer">commit ${esc(res.commitSha.slice(0, 7))}</a>).</p><p id="buildLine">Waiting for the website build to start…</p><button class="btn btn-outline btn-sm" type="button" id="another">Add another release</button>`;
    $('#another').addEventListener('click', () => location.reload());
    watchBuild(res.commitSha, entry, live, cfg);
  } catch (e) {
    state.busy = false;
    say('Stopped.');
    result.className = 'result bad'; result.hidden = false;
    result.innerHTML = `<p><strong>Nothing was published.</strong></p><p>${esc(e.message || String(e))}</p>`;
  }
  runChecks();
}

async function watchBuild(sha, entry, liveUrl, cfg) {
  const line = $('#buildLine'), actions = `https://github.com/${cfg.owner}/${cfg.repo}/actions`;
  for (let n = 0; n < 60; n++) {
    await new Promise((r) => setTimeout(r, n === 0 ? 4000 : 5000));
    let run = null;
    try { run = await core.getBuildRun({ ...cfg, sha }); }
    catch { line.innerHTML = `The release is saved, but this page cannot read the build status (the token may lack “Actions: Read”). Check the <a href="${esc(actions)}" target="_blank" rel="noopener noreferrer">Actions tab</a>.`; return; }
    if (!run) continue;
    if (run.status !== 'completed') { line.textContent = 'Building the website (usually under a minute)…'; continue; }
    if (run.conclusion === 'success') {
      line.innerHTML = entry.status === 'draft'
        ? 'Saved as a <strong>draft</strong>. It is not on the website.'
        : `<strong>Live:</strong> <a href="${esc(liveUrl)}" target="_blank" rel="noopener noreferrer">${esc(liveUrl)}</a><br><span class="muted">If you see an older page, refresh in a few minutes: GitHub caches pages for up to 10 minutes.</span>`;
    } else {
      $('#result').className = 'result bad';
      line.innerHTML = `<strong>The website build failed, so the site was not changed.</strong> <a href="${esc(run.url)}" target="_blank" rel="noopener noreferrer">See why</a>. Your files are saved in the repository; ask Claude to fix them, or edit <code>releases/v${esc(entry.version)}/content.json</code> on GitHub.`;
    }
    return;
  }
  line.innerHTML = `The build is taking longer than expected. Check the <a href="${esc(actions)}" target="_blank" rel="noopener noreferrer">Actions tab</a>.`;
}

/* ------------------------------------------------------------------ events */
$('#items').addEventListener('input', (e) => {
  const form = e.target.closest('.item-form'); if (!form) return;
  const it = state.items[+form.dataset.i];
  if (e.target.dataset.f) it[e.target.dataset.f] = e.target.value;
  else if (e.target.dataset.img) it.images[+e.target.closest('.shot-row').dataset.k][e.target.dataset.img] = e.target.value;
  scheduleCheck();
});
$('#items').addEventListener('change', (e) => {
  if (e.target.dataset.f === 'category') { state.items[+e.target.closest('.item-form').dataset.i].category = e.target.value; scheduleCheck(); }
  if (e.target.dataset.act === 'add-images') { const i = +e.target.closest('.item-form').dataset.i; const files = [...e.target.files]; e.target.value = ''; addImages(i, files); }
});
$('#items').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const i = +b.closest('.item-form').dataset.i;
  if (b.dataset.act === 'remove-item') { state.items[i].images.forEach((im) => URL.revokeObjectURL(im.url)); state.items.splice(i, 1); }
  if (b.dataset.act === 'remove-image') { const k = +b.closest('.shot-row').dataset.k; URL.revokeObjectURL(state.items[i].images[k].url); state.items[i].images.splice(k, 1); }
  renderItems(); scheduleCheck();
});
$('#addItem').addEventListener('click', () => { state.items.push(newItem()); renderItems(); scheduleCheck(); const last = $('#items').lastElementChild; last?.querySelector('select')?.focus(); });

$('#links').addEventListener('input', (e) => { const row = e.target.closest('.link-row'); if (row && e.target.dataset.lf) { state.links[+row.dataset.l][e.target.dataset.lf] = e.target.value; scheduleCheck(); } });
$('#links').addEventListener('click', (e) => { const b = e.target.closest('[data-act=remove-link]'); if (b) { state.links.splice(+b.closest('.link-row').dataset.l, 1); renderLinks(); scheduleCheck(); } });
$('#addLink').addEventListener('click', () => { state.links.push({ label: '', url: '', kind: 'video' }); renderLinks(); scheduleCheck(); });

for (const id of ['#version', '#date', '#type', '#status', '#featured', '#title', '#summary', '#overview', '#tags']) $(id).addEventListener('input', () => { if (id === '#version') syncType(); scheduleCheck(); });
$('#type').addEventListener('change', () => { state.typeTouched = true; });
for (const id of ['#owner', '#repo', '#branch', '#token']) $(id).addEventListener('input', invalidateConnection);
$('#connectBtn').addEventListener('click', doConnect);
$('#token').addEventListener('keydown', (e) => { if (e.key === 'Enter') doConnect(); });
$('#publishBtn').addEventListener('click', doPublish);
$('#editJson').addEventListener('change', (e) => {
  state.jsonOverride = e.target.checked;
  $('#json').readOnly = !state.jsonOverride; $('#resetJson').hidden = !state.jsonOverride;
  runChecks();
});
$('#json').addEventListener('input', scheduleCheck);
$('#resetJson').addEventListener('click', () => { state.jsonOverride = false; $('#editJson').checked = false; $('#json').readOnly = true; $('#resetJson').hidden = true; runChecks(); });
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
  renderItems(); renderLinks(); runChecks();
})();
