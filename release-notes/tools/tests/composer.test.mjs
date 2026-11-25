// Run:  node --test tools/tests/composer.test.mjs
// Tests the manual release composer (admin/core.mjs) against a simulated GitHub API, then feeds what it
// "committed" to the REAL generator (tools/rn.mjs) to prove the page can only produce releases the build accepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from '../../admin/core.mjs';
import * as preview from '../../admin/preview.mjs';
import * as editor from '../../admin/editor.mjs';
import * as pdf from '../../assets/js/pdf.mjs';
import * as walk from '../../assets/js/walkthrough.mjs';

const REAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RN = path.join(REAL, 'tools', 'rn.mjs');
const png = (w, h) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return new Uint8Array(b); };
const ok = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const b64 = (s) => Buffer.from(s).toString('base64').replace(/(.{60})/g, '$1\n');

/** A tiny in-memory GitHub: just the endpoints the composer uses, with real fast-forward semantics. */
function mockGitHub({ releases = [], raceOnce = false, failWith = null } = {}) {
  const st = { head: 'c0', files: new Map(), commits: new Map(), trees: new Map(), blobs: new Map(), fileBlobs: new Map(), n: 0, fb: 0, calls: [], raced: false };
  st.files.set('release-notes/releases.json', JSON.stringify({ product: 'RevGen-i', schemaVersion: 1, site: { url: '', noindex: false }, releases }));
  st.commits.set('c0', { files: new Map(st.files), parent: null });
  const fetch = async (url, init = {}) => {
    const u = new URL(url), p = u.pathname.replace('/repos/o/r', ''), method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    st.calls.push(`${method} ${p}`);
    if (failWith) return ok({ message: 'nope' }, failWith);
    if (!init.headers.Authorization.startsWith('Bearer ')) return ok({ message: 'Bad credentials' }, 401);
    if (method === 'GET' && p === '') return ok({ full_name: 'o/r', private: false });
    if (method === 'GET' && p === '/git/ref/heads/main') return ok({ object: { sha: st.head } });
    if (method === 'GET' && p.startsWith('/git/commits/')) return ok({ tree: { sha: `t-${p.split('/').pop()}` } });
    if (method === 'GET' && p.startsWith('/contents/')) {
      const file = decodeURI(p.replace('/contents/', ''));
      const files = st.commits.get(u.searchParams.get('ref'))?.files ?? st.files;
      if (files.has(file)) return ok({ content: b64(files.get(file)), encoding: 'base64' });
      if ([...files.keys()].some((k) => k.startsWith(`${file}/`))) return ok([{ name: 'x' }]);
      return ok({ message: 'Not Found' }, 404);
    }
    if (method === 'POST' && p === '/git/blobs') { const sha = `b${++st.n}`; st.blobs.set(sha, body.encoding === 'base64' ? Buffer.from(body.content, 'base64') : Buffer.from(body.content, 'utf8')); return ok({ sha }, 201); }
    if (method === 'POST' && p === '/git/trees') {
      const files = new Map(st.commits.get(st.head).files);
      for (const e of body.tree) { if (e.sha === null) files.delete(e.path); else files.set(e.path, st.blobs.get(e.sha)); } // sha:null deletes, as on GitHub
      const sha = `tree${++st.n}`; st.trees.set(sha, files); return ok({ sha }, 201);
    }
    if (method === 'GET' && p.startsWith('/git/trees/')) {
      const files = st.commits.get(p.split('/').pop().replace(/^t-/, ''))?.files ?? new Map();
      return ok({ truncated: false, tree: [...files.keys()].map((path) => { const sha = `fb${++st.fb}`; st.fileBlobs.set(sha, files.get(path)); return { path, mode: '100644', type: 'blob', sha }; }) });
    }
    if (method === 'GET' && p.startsWith('/git/blobs/')) { // reading a file by the sha the tree listing gave
      const data = st.fileBlobs.get(p.split('/').pop());
      return data === undefined ? ok({ message: 'Not Found' }, 404) : ok({ content: b64(data), encoding: 'base64' });
    }
    if (method === 'POST' && p === '/git/commits') { const sha = `c${++st.n}`; st.commits.set(sha, { files: st.trees.get(body.tree), parent: body.parents[0] }); return ok({ sha }, 201); }
    if (method === 'PATCH' && p === '/git/refs/heads/main') {
      if (raceOnce && !st.raced) { st.raced = true; const sha = 'other'; st.commits.set(sha, { files: new Map(st.commits.get(st.head).files), parent: st.head }); st.head = sha; }
      if (st.commits.get(body.sha).parent !== st.head) return ok({ message: 'Update is not a fast forward' }, 422);
      st.head = body.sha; st.files = st.commits.get(body.sha).files; return ok({ ok: true });
    }
    if (method === 'GET' && p === '/actions/runs') return ok({ workflow_runs: [{ name: 'Release notes portal', status: 'completed', conclusion: 'success', html_url: 'https://example.test/run/1' }] });
    return ok({ message: `unmocked ${method} ${p}` }, 500);
  };
  return { st, fetch };
}

const model = (over = {}) => ({
  version: '2.43.0', date: '2026-12-01', type: 'minor', status: 'published', featured: false, title: 'Claim reminders', summary: 'Set a reminder on any claim.', tags: 'claims, reminders',
  overview: 'First paragraph.\n\nSecond paragraph.', links: [],
  items: [{ category: 'new-feature', title: 'Follow-up reminders', module: 'Claims', audience: 'Leads, Managers', summary: 'Pick a date.', body: '', images: [] }],
  ...over,
});
const opts = (m, extra = {}) => ({ token: 't', owner: 'o', repo: 'r', branch: 'main', ...extra, ...m });

function materialize(st) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-composer-'));
  for (const p of ['templates', 'assets', 'admin', 'index.html', 'releases/index.html']) fs.cpSync(path.join(REAL, p), path.join(root, p), { recursive: true });
  for (const [file, data] of st.files) {
    if (!file.startsWith('release-notes/')) continue;
    const dest = path.join(root, file.slice('release-notes/'.length));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  return root;
}
const rn = (root, ...a) => { const r = spawnSync(process.execPath, [RN, ...a, '--root', root], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };

test('details text becomes the right blocks: paragraphs, headings, lists, notes, steps, screenshots', () => {
  const images = [{ name: 'a.png', alt: 'A', caption: 'First' }, { name: 'b.png', alt: 'B' }, { name: 'c.png', alt: 'C' }];
  const { blocks, errors } = core.parseBody([
    'Intro line one', 'still the same paragraph', '', '## Rules', '- first', '- second', '', '1. one', '2. two', '', '> a note', '!> careful', '',
    '[[image 1]]', '', '### Open the screen', 'Go to **Home**.', '> only admins', '[[image 2]]', '', '### Save it', 'Click Save.',
  ].join('\n'), images);
  assert.deepEqual(errors, []);
  assert.deepEqual(blocks.map((b) => b.type), ['p', 'heading', 'list', 'list', 'callout', 'callout', 'image', 'steps', 'image']);
  assert.equal(blocks[0].text, 'Intro line one still the same paragraph');
  assert.equal(blocks[2].ordered, false); assert.equal(blocks[3].ordered, true);
  assert.equal(blocks[5].tone, 'important');
  assert.deepEqual(blocks[6], { type: 'image', src: 'images/a.png', alt: 'A', caption: 'First' });
  assert.deepEqual(blocks[7].items[0], { title: 'Open the screen', text: 'Go to **Home**.', note: 'only admins', images: [{ src: 'images/b.png', alt: 'B' }] });
  assert.deepEqual(blocks[7].items[1], { title: 'Save it', text: 'Click Save.' });
  assert.deepEqual(blocks[8], { type: 'image', src: 'images/c.png', alt: 'C' }, 'a screenshot that was not placed is appended');
  assert.deepEqual(core.parseBody('[[image 3]]', [images[0]]).errors.length, 1);
  assert.equal(core.parseBody('', images).blocks[0].type, 'gallery', 'several unplaced screenshots become a gallery');
});

test('helpers: file names, unique names, next version, type from version', () => {
  assert.equal(core.safeFileName('My Shot (1).PNG'), 'my-shot-1.png');
  const taken = new Set();
  assert.deepEqual([core.uniqueName('a.png', taken), core.uniqueName('a.png', taken), core.uniqueName('a.png', taken)], ['a.png', 'a-2.png', 'a-3.png']);
  assert.equal(core.nextVersion(['2.9.0', '2.42.0', '2.41.1']), '2.43.0');
  assert.equal(core.nextVersion([]), '1.0.0');
  assert.deepEqual(['1.0.0', '1.2.0', '1.2.3'].map(core.typeFromVersion), ['major', 'minor', 'patch']);
});

test('validation explains problems in plain words and blocks duplicates', () => {
  const bad = model({
    version: 'v2.43', date: '2026-02-31', title: '', summary: '',
    items: [
      { category: '', title: 'Same', summary: 'x', body: '', images: [] },
      { category: 'bug-fix', title: 'Same', summary: '', body: '', images: [{ name: 'a.png', alt: '', caption: '' }] },
      { category: 'bug-fix', title: 'Pointer', summary: 'x', body: '[[image 4]]', images: [] },
      { category: 'bug-fix', title: 'Empty one', summary: '', body: '', images: [] },
    ],
    links: [{ label: 'Demo', url: 'ftp://nope', kind: 'demo' }],
  });
  const text = core.validateRelease(bad, { existingVersions: [] }).errors.join('\n');
  for (const re of [/Version must look like/, /valid release date/, /release title/, /short summary/, /choose a category/, /same title is used by item 1/, /alt text/, /\[\[image 4\]\]/, /https:\/\//, /add a short description/]) assert.match(text, re);
  assert.match(core.validateRelease(model({ version: '2.42.0' }), { existingVersions: ['2.42.0'] }).errors.join(), /already exists/);
  assert.equal(core.validateRelease(model(), { existingVersions: ['2.42.0'] }).errors.length, 0);
  assert.match(core.validateRelease(model({ version: '2.43.1', type: 'minor' })).warnings.join(), /does not match the version/);
  assert.deepEqual(core.validateRelease(model({ status: 'draft', summary: '' })).errors, [], 'a draft may omit the summary');
  assert.ok(core.validateContent({ items: [{ category: 'bug-fix', title: 'x', summary: 'y', body: [{ type: 'image', src: 'https://evil/x.png', alt: 'a' }] }] }, new Set()).errors.length, 'hand-edited JSON cannot smuggle an external image');
});

test('publish: one atomic commit with images, content.json and the releases.json entry; the real build accepts it', async () => {
  const gh = mockGitHub();
  const m = model({ items: [{ category: 'new-feature', title: 'Follow-up reminders', module: 'Claims', audience: 'Leads', summary: 'Pick a date.', body: '### Open the claim\nChoose Follow-up.\n[[image 1]]\n\n> Reminders belong to you.', images: [{ name: 'claim.png', alt: 'The claim toolbar', caption: 'Claim toolbar' }] },
    { category: 'bug-fix', title: 'Notes order', summary: 'Newest first.', body: '', images: [] }] });
  const v = core.validateRelease(m, { existingVersions: [] });
  assert.deepEqual(v.errors, []);
  const progress = [];
  const res = await core.publish(opts({ entry: v.entry, content: v.content, images: [{ name: 'claim.png', bytes: png(64, 40) }], onProgress: (t) => progress.push(t), fetch: gh.fetch }));
  assert.equal(res.version, '2.43.0');
  assert.equal(gh.st.calls.filter((c) => c === 'PATCH /git/refs/heads/main').length, 1, 'exactly one commit is published');
  assert.ok(progress.some((t) => /Uploading screenshots \(1 of 1\)/.test(t)));
  const files = [...gh.st.files.keys()].sort();
  assert.deepEqual(files, ['release-notes/releases.json', 'release-notes/releases/v2.43.0/content.json', 'release-notes/releases/v2.43.0/images/claim.png']);
  assert.deepEqual(JSON.parse(gh.st.files.get('release-notes/releases.json')).releases[0], v.entry);

  const root = materialize(gh.st);
  const build = rn(root, 'build');
  assert.equal(build.code, 0, build.out);
  assert.equal(rn(root, 'validate').code, 0);
  const page = fs.readFileSync(path.join(root, 'releases/v2.43.0/index.html'), 'utf8');
  assert.match(page, /Follow-up reminders/);
  assert.match(page, /<li class="step" id="follow-up-reminders-step-1">/);
  assert.match(page, /<img src="images\/claim\.png" alt="The claim toolbar" width="64" height="40"/);
  assert.equal(rn(root, 'stage', '--out', path.join(root, '_site')).code, 0);
});

test('publish appends to existing releases without touching them, and keeps drafts out of the public site', async () => {
  const existing = [{ version: '2.42.0', date: '2026-08-15', type: 'minor', status: 'published', featured: true, title: 'Existing', summary: 'Already live.', derived: { categories: ['new-feature'], counts: { 'new-feature': 1 }, items: [] } }];
  const gh = mockGitHub({ releases: existing });
  const oldContent = JSON.stringify({ items: [{ category: 'new-feature', title: 'Old feature', summary: 'Live already.' }] });
  gh.st.files.set('release-notes/releases/v2.42.0/content.json', oldContent);
  gh.st.commits.get('c0').files.set('release-notes/releases/v2.42.0/content.json', oldContent); // part of the repo's current commit
  const m = model({ version: '2.43.0', status: 'draft', title: 'Upcoming' });
  const v = core.validateRelease(m, { existingVersions: ['2.42.0'] });
  await core.publish(opts({ entry: v.entry, content: v.content, fetch: gh.fetch }));
  const index = JSON.parse(gh.st.files.get('release-notes/releases.json'));
  assert.deepEqual(index.releases[0], existing[0], 'the existing entry is byte-for-byte what it was');
  assert.equal(index.releases[1].status, 'draft');
  assert.ok(!gh.st.calls.some((c) => c.includes('v2.42.0') && c.startsWith('POST')), 'nothing under the existing release is rewritten');
  const root = materialize(gh.st);
  const build = rn(root, 'build');
  assert.equal(build.code, 0, build.out);
  const out = path.join(root, '_site');
  const stage = rn(root, 'stage', '--out', out);
  assert.equal(stage.code, 0, stage.out);
  assert.ok(!fs.existsSync(path.join(out, 'releases/v2.43.0')), 'the draft is not deployed');
  assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(out, 'releases.json'), 'utf8'))).includes('Upcoming'));
});

test('publish refuses an existing version before uploading anything, and retries when someone else pushed', async () => {
  const dup = mockGitHub({ releases: [{ version: '2.43.0', date: '2026-01-01', type: 'minor', status: 'published', featured: false, title: 'x', summary: 'y' }] });
  const v = core.validateRelease(model(), { existingVersions: [] });
  await assert.rejects(core.publish(opts({ entry: v.entry, content: v.content, fetch: dup.fetch })), (e) => e.status === 409 && /already exists/.test(e.message));
  assert.ok(!dup.st.calls.some((c) => c.startsWith('POST')), 'no blobs were created for a duplicate');

  const race = mockGitHub({ raceOnce: true });
  const progress = [];
  const res = await core.publish(opts({ entry: v.entry, content: v.content, fetch: race.fetch, onProgress: (t) => progress.push(t) }));
  assert.ok(res.commitSha);
  assert.ok(progress.some((t) => /trying again/.test(t)));
  assert.equal(race.st.head, res.commitSha, 'the second attempt fast-forwarded the branch');
});

test('checkLive: only says "live" once the page answers AND the public release list includes it', async () => {
  const base = 'https://x.example/RevGen-i/';
  const script = [
    () => ({ ok: false, status: 404 }),                                                       // attempt 1: page not published yet
    () => ({ ok: true, status: 200 }), () => ({ ok: true, json: async () => ({ releases: [{ version: '2.42.0', status: 'published' }] }) }), // attempt 2: page up, list still old
    () => ({ ok: true, status: 200 }), () => ({ ok: true, json: async () => ({ releases: [{ version: '2.42.0', status: 'published' }, { version: '2.43.0', status: 'published' }] }) }), // attempt 3: both fine
  ];
  const urls = [], waits = [];
  const f = async (url, init) => { urls.push(url); assert.equal(init.cache, 'no-store', 'caches must be bypassed'); return script.shift()(); };
  const seen = [];
  const res = await core.checkLive({ fetch: f, baseUrl: base, version: '2.43.0', tries: 5, intervalMs: 1, sleep: async (ms) => { waits.push(ms); }, onAttempt: (n) => seen.push(n) });
  assert.deepEqual([res.ok, res.attempts], [true, 3]);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(waits.length, 2, 'it waits between attempts, not after success');
  assert.ok(urls[0].endsWith('/releases/v2.43.0/') && urls.some((u) => u.endsWith('/releases.json')));

  const never = await core.checkLive({ fetch: async () => { throw new Error('offline'); }, baseUrl: base, version: '2.43.0', tries: 3, intervalMs: 1, sleep: async () => {} });
  assert.deepEqual([never.ok, never.attempts], [false, 3]);
  assert.match(never.reason, /could not be reached/);
  const draftOnly = await core.checkLive({ fetch: async (u) => (u.endsWith('releases.json') ? { ok: true, json: async () => ({ releases: [{ version: '2.43.0', status: 'draft' }] }) } : { ok: true }), baseUrl: base, version: '2.43.0', tries: 2, intervalMs: 1, sleep: async () => {} });
  assert.equal(draftOnly.ok, false, 'a draft in the list does not count as live');
  assert.equal(core.liveLink(base, '2.43.0', 'abcdef1234567'), 'https://x.example/RevGen-i/releases/v2.43.0/?r=abcdef1');
});

test('delete: removes exactly one release (its folder and list entry) in one commit; the real build accepts what is left', async () => {
  const gh = mockGitHub();
  const withShot = (version, title) => model({ version, title, items: [{ category: 'new-feature', title: `${title} feature`, summary: 'x.', body: '', images: [{ name: 'shot.png', alt: 'A shot', caption: '' }] }] });
  for (const [v, t] of [['1.0.0', 'First'], ['1.1.0', 'Second']]) {
    const val = core.validateRelease(withShot(v, t), { existingVersions: [] });
    assert.deepEqual(val.errors, []);
    await core.publish(opts({ entry: val.entry, content: val.content, images: [{ name: 'shot.png', bytes: png(40, 30) }], fetch: gh.fetch }));
  }
  const before = new Map(gh.st.files);
  const callsBefore = gh.st.calls.length;

  const preview = await core.previewDelete(opts({ version: '1.0.0', fetch: gh.fetch }));
  assert.deepEqual(preview.files.sort(), ['release-notes/releases/v1.0.0/content.json', 'release-notes/releases/v1.0.0/images/shot.png']);
  assert.equal(preview.entry.title, 'First');
  assert.deepEqual([...gh.st.files.keys()], [...before.keys()], 'a preview changes nothing');

  const progress = [];
  const res = await core.deleteRelease(opts({ version: '1.0.0', fetch: gh.fetch, onProgress: (t) => progress.push(t) }));
  assert.equal(res.removedFiles, 2);
  assert.ok(progress.some((t) => /Removing 2 files/.test(t)));
  assert.equal(gh.st.calls.slice(callsBefore).filter((c) => c.startsWith('PATCH')).length, 1, 'exactly one commit');
  assert.deepEqual([...gh.st.files.keys()].sort(), ['release-notes/releases.json', 'release-notes/releases/v1.1.0/content.json', 'release-notes/releases/v1.1.0/images/shot.png']);
  assert.deepEqual(JSON.parse(gh.st.files.get('release-notes/releases.json')).releases.map((r) => r.version), ['1.1.0']);
  for (const k of before.keys()) if (k.includes('/v1.1.0/')) assert.deepEqual(gh.st.files.get(k), before.get(k), `${k} must be untouched`);

  const root = materialize(gh.st);
  assert.equal(rn(root, 'build').code, 0);
  assert.equal(rn(root, 'validate').code, 0);
  const out = path.join(root, '_site');
  assert.equal(rn(root, 'stage', '--out', out).code, 0);
  assert.ok(!fs.existsSync(path.join(out, 'releases/v1.0.0')) && fs.existsSync(path.join(out, 'releases/v1.1.0/index.html')));
  await assert.rejects(core.deleteRelease(opts({ version: '1.0.0', fetch: gh.fetch })), (e) => e.status === 404 && /was not found/.test(e.message), 'deleting twice reports it is already gone');
});

test('delete is safe: bad versions never reach the API, drafts can be deleted, and a race is retried', async () => {
  const idle = mockGitHub();
  for (const bad of ['../etc', '1.0', '1.0.0/../..', '', '1.0.0 ', 'v1.0.0']) {
    await assert.rejects(core.deleteRelease(opts({ version: bad, fetch: idle.fetch })), (e) => /not a version number/.test(e.message), `"${bad}" must be refused`);
    await assert.rejects(core.previewDelete(opts({ version: bad, fetch: idle.fetch })), /not a version number/);
  }
  assert.equal(idle.st.calls.length, 0, 'no request was sent for an invalid version');
  await assert.rejects(core.deleteRelease(opts({ version: '9.9.9', fetch: idle.fetch })), (e) => e.status === 404);
  assert.ok(!idle.st.calls.some((c) => c.startsWith('POST') || c.startsWith('PATCH')), 'nothing was written for a missing release');

  const draft = { version: '3.0.0', date: '2026-01-01', type: 'major', status: 'draft', featured: false, title: 'Draft' };
  const race = mockGitHub({ releases: [draft], raceOnce: true });
  const content = JSON.stringify({ items: [] });
  race.st.files.set('release-notes/releases/v3.0.0/content.json', content);
  race.st.commits.get('c0').files.set('release-notes/releases/v3.0.0/content.json', content);
  const progress = [];
  const res = await core.deleteRelease(opts({ version: '3.0.0', fetch: race.fetch, onProgress: (t) => progress.push(t) }));
  assert.ok(progress.some((t) => /trying again/.test(t)));
  assert.equal(race.st.head, res.commitSha);
  assert.deepEqual(JSON.parse(race.st.files.get('release-notes/releases.json')).releases, []);
  assert.ok(![...race.st.files.keys()].some((k) => k.includes('v3.0.0')));
});

const seed = (gh, file, content) => { gh.st.files.set(file, content); gh.st.commits.get('c0').files.set(file, content); }; // part of the repo's current commit

test('publish / unpublish: one commit that changes only releases.json; the real build then adds or removes the release', async () => {
  const gh = mockGitHub();
  const draft = model({ version: '2.0.0', type: 'major', status: 'draft', title: 'Work in progress', items: [{ category: 'new-feature', title: 'Big thing', summary: 'It is big.', body: '', images: [{ name: 'big.png', alt: 'A big thing', caption: '' }] }] });
  const val = core.validateRelease(draft, { existingVersions: [] });
  assert.deepEqual(val.errors, []);
  await core.publish(opts({ entry: val.entry, content: val.content, images: [{ name: 'big.png', bytes: png(50, 30) }], fetch: gh.fetch }));
  const stageHas = (root) => { // the deploy workflow always runs build, then stage
    const b = rn(root, 'build'); assert.equal(b.code, 0, b.out);
    const out = path.join(root, '_site'); const r = rn(root, 'stage', '--out', out); assert.equal(r.code, 0, r.out);
    return fs.existsSync(path.join(out, 'releases/v2.0.0/index.html'));
  };
  assert.equal(stageHas(materialize(gh.st)), false, 'a draft is not on the website');

  const preview = await core.previewStatusChange(opts({ version: '2.0.0', to: 'published', fetch: gh.fetch }));
  assert.deepEqual([preview.from, preview.errors], ['draft', []]);
  const before = new Map(gh.st.files), calls = gh.st.calls.length, progress = [];
  const res = await core.setReleaseStatus(opts({ version: '2.0.0', to: 'published', fetch: gh.fetch, onProgress: (t) => progress.push(t) }));
  assert.equal(res.status, 'published');
  assert.ok(progress.some((t) => /Checking the release is complete/.test(t)));
  assert.equal(gh.st.calls.slice(calls).filter((c) => c.startsWith('PATCH')).length, 1, 'exactly one commit');
  const changed = [...gh.st.files.keys()].filter((k) => !before.has(k) || gh.st.files.get(k) !== before.get(k));
  assert.deepEqual(changed, ['release-notes/releases.json'], 'only the release list changes; the release files are not touched');
  assert.equal(JSON.parse(gh.st.files.get('release-notes/releases.json')).releases[0].status, 'published');
  assert.equal(stageHas(materialize(gh.st)), true, 'now it is on the website');

  const back = await core.setReleaseStatus(opts({ version: '2.0.0', to: 'draft', fetch: gh.fetch }));
  assert.equal(back.status, 'draft');
  assert.equal(stageHas(materialize(gh.st)), false, 'unpublished: gone from the website, files still in the repo');
  assert.ok(gh.st.files.has('release-notes/releases/v2.0.0/content.json') && gh.st.files.has('release-notes/releases/v2.0.0/images/big.png'));
  await assert.rejects(core.setReleaseStatus(opts({ version: '2.0.0', to: 'draft', fetch: gh.fetch })), (e) => e.status === 409 && /already a draft/.test(e.message));
});

test('an incomplete draft is refused with plain reasons and nothing is written', async () => {
  const entry = (extra) => ({ version: '1.0.0', date: '2026-01-01', type: 'major', status: 'draft', featured: false, title: 'T', ...extra });
  const gh = mockGitHub({ releases: [entry({})] });
  seed(gh, 'release-notes/releases/v1.0.0/content.json', JSON.stringify({ items: [] }));
  const p = await core.previewStatusChange(opts({ version: '1.0.0', to: 'published', fetch: gh.fetch }));
  assert.match(p.errors.join(' | '), /no summary/);
  assert.match(p.errors.join(' | '), /at least one item/);
  const calls = gh.st.calls.length;
  await assert.rejects(core.setReleaseStatus(opts({ version: '1.0.0', to: 'published', fetch: gh.fetch })), (e) => e.status === 422 && Array.isArray(e.errors) && e.errors.length >= 2 && /cannot be published yet/.test(e.message));
  assert.ok(!gh.st.calls.slice(calls).some((c) => c.startsWith('POST') || c.startsWith('PATCH')), 'nothing was written');

  const broken = mockGitHub({ releases: [entry({ summary: 'ok' })] });
  seed(broken, 'release-notes/releases/v1.0.0/content.json', JSON.stringify({ items: [{ category: 'bug-fix', title: 'x', summary: 'y', body: [{ type: 'image', src: 'images/missing.png', alt: 'a' }] }] }));
  assert.match((await core.previewStatusChange(opts({ version: '1.0.0', to: 'published', fetch: broken.fetch }))).errors.join(), /has not been attached/);

  const noContent = mockGitHub({ releases: [entry({ summary: 'ok' })] });
  assert.match((await core.previewStatusChange(opts({ version: '1.0.0', to: 'published', fetch: noContent.fetch }))).errors.join(), /content\.json is missing/);

  const custom = mockGitHub({ releases: [entry({ summary: 'ok', page: 'custom' })] });
  assert.match((await core.previewStatusChange(opts({ version: '1.0.0', to: 'published', fetch: custom.fetch }))).errors.join(), /custom page/);
  seed(custom, 'release-notes/releases/v1.0.0/index.html', '<html></html>');
  assert.deepEqual((await core.previewStatusChange(opts({ version: '1.0.0', to: 'published', fetch: custom.fetch }))).errors, [], 'a hand-written page only needs its index.html');

  const idle = mockGitHub();
  for (const bad of ['../x', '1.0', 'v1.0.0']) await assert.rejects(core.setReleaseStatus(opts({ version: bad, to: 'published', fetch: idle.fetch })), /not a version number/);
  await assert.rejects(core.setReleaseStatus(opts({ version: '1.0.0', to: 'archived', fetch: idle.fetch })), /must be "published" or "draft"/);
  assert.equal(idle.st.calls.length, 0, 'invalid requests never reach the API');
  await assert.rejects(core.previewStatusChange(opts({ version: '4.0.0', to: 'published', fetch: idle.fetch })), (e) => e.status === 404);
});

test('changing status retries after a race, and refuses a release that is already in that state', async () => {
  const gh = mockGitHub({ releases: [{ version: '1.0.0', date: '2026-01-01', type: 'major', status: 'published', featured: false, title: 'T', summary: 'S' }], raceOnce: true });
  const progress = [];
  const res = await core.setReleaseStatus(opts({ version: '1.0.0', to: 'draft', fetch: gh.fetch, onProgress: (t) => progress.push(t) }));
  assert.ok(progress.some((t) => /trying again/.test(t)));
  assert.equal(gh.st.head, res.commitSha);
  assert.equal(JSON.parse(gh.st.files.get('release-notes/releases.json')).releases[0].status, 'draft');
  await assert.rejects(core.setReleaseStatus(opts({ version: '1.0.0', to: 'draft', fetch: gh.fetch })), (e) => e.status === 409);
});

test('checkGone: only says "gone" once the list no longer has it AND the page is a 404', async () => {
  const base = 'https://x.example/RevGen-i/';
  const steps = [
    { list: ['2.42.0', '2.43.0'], page: 200 }, // still listed
    { list: ['2.42.0'], page: 200 },           // list updated, page not yet
    { list: ['2.42.0'], page: 404 },           // gone
  ];
  let i = -1;
  const f = async (url) => {
    if (url.endsWith('releases.json')) { i++; return { ok: true, json: async () => ({ releases: steps[i].list.map((version) => ({ version, status: 'published' })) }) }; }
    return { ok: false, status: steps[i].page };
  };
  const res = await core.checkGone({ fetch: f, baseUrl: base, version: '2.43.0', tries: 5, intervalMs: 1, sleep: async () => {} });
  assert.deepEqual([res.ok, res.attempts], [true, 3]);
  const stuck = await core.checkGone({ fetch: async (u) => (u.endsWith('releases.json') ? { ok: true, json: async () => ({ releases: [{ version: '2.43.0' }] }) } : { ok: true, status: 200 }), baseUrl: base, version: '2.43.0', tries: 2, intervalMs: 1, sleep: async () => {} });
  assert.equal(stuck.ok, false);
  assert.match(stuck.reason, /still includes it/);
});

test('GitHub errors become plain advice; connect() and the build-status lookup work', async () => {
  const v = core.validateRelease(model(), { existingVersions: [] });
  for (const [status, re] of [[401, /mistyped or has expired/], [403, /Contents: Read and write/], [404, /not found, or the token cannot see/]]) {
    await assert.rejects(core.publish(opts({ entry: v.entry, content: v.content, fetch: mockGitHub({ failWith: status }).fetch })), (e) => e.status === status && re.test(e.message));
  }
  const gh = mockGitHub({ releases: [{ version: '1.0.0', date: '2026-01-01', type: 'major', status: 'draft', featured: false, title: 'x' }] });
  const c = await core.connect(opts({ fetch: gh.fetch }));
  assert.equal(c.fullName, 'o/r');
  assert.equal(c.releases[0].status, 'draft', 'connect() sees drafts, which the public site hides');
  const run = await core.getBuildRun(opts({ sha: 'abc', fetch: gh.fetch }));
  assert.deepEqual([run.status, run.conclusion], ['completed', 'success']);
});

/* ------------------------------------------------------------------ preview */
const mainOf = (html) => html.match(/<main id="main"[\s\S]*<\/main>/)[0];

test('preview: the page drawn for a saved release is exactly the page the real build writes', async () => {
  const gh = mockGitHub();
  const m = model({
    featured: true, overview: 'First paragraph.\n\nSecond one with a [link](https://example.com).',
    links: [{ label: 'Watch the demo', url: 'https://example.com/demo', kind: 'video' }],
    items: [
      { category: 'new-feature', title: 'Follow-up reminders', module: 'Claims', audience: 'Leads, Managers', summary: 'Pick a date.',
        body: '## Rules\n- one\n- two\n\n### Open the claim\nChoose **Follow-up**.\n[[image 1]]\n\n> Reminders belong to you.\n\n!> Careful.\n\n### Save it\nClick Save.',
        images: [{ name: 'claim.png', alt: 'The claim toolbar', caption: 'Claim `toolbar`' }, { name: 'two.png', alt: 'Two' }, { name: 'three.png', alt: 'Three' }] },
      { category: 'enhancement', title: 'Bulk export', summary: 'More columns.', body: '', images: [] },
      { category: 'bug-fix', title: 'Notes order', summary: 'Newest first.', body: '', images: [] },
    ],
  });
  const val = core.validateRelease(m, { existingVersions: [] });
  assert.deepEqual(val.errors, []);
  await core.publish(opts({ entry: val.entry, content: val.content, images: ['claim.png', 'two.png', 'three.png'].map((name) => ({ name, bytes: png(64, 40) })), fetch: gh.fetch }));
  const root = materialize(gh.st);
  const build = rn(root, 'build');
  assert.equal(build.code, 0, build.out);
  const built = mainOf(fs.readFileSync(path.join(root, 'releases/v2.43.0/index.html'), 'utf8'));

  const calls = gh.st.calls.length, progress = [];
  const saved = await core.loadReleaseForPreview(opts({ version: '2.43.0', fetch: gh.fetch, onProgress: (t) => progress.push(t) }));
  assert.ok(gh.st.calls.slice(calls).every((c) => c.startsWith('GET')), 'loading a preview only reads from GitHub');
  assert.ok(progress.some((t) => /Loading screenshots \(3 of 3\)/.test(t)));
  assert.deepEqual(saved.images.map((i) => i.name).sort(), ['claim.png', 'three.png', 'two.png']);
  assert.deepEqual([...saved.images.find((i) => i.name === 'claim.png').bytes], [...png(64, 40)], 'screenshots arrive byte for byte');
  const prep = preview.prepare(saved.entry, saved.content, '2026-01-01');
  assert.deepEqual([prep.missing, prep.omitted], [[], []]);
  assert.deepEqual(prep.content, saved.content, 'complete content is drawn as it is');
  const doc = preview.previewDocument({ ...prep, imageInfo: () => ({ w: 64, h: 40 }), root: '../../' });
  assert.equal(mainOf(doc), built, 'same code, same data: the preview is the published page');
  assert.match(built, /gallery gallery-2/);
});

test('preview: screenshots come from the browser (blob urls); unknown ones fall back to the release folder; no scripts', () => {
  const content = { items: [{ category: 'bug-fix', title: 'Fix', summary: 's', body: [{ type: 'image', src: 'images/a b.png', alt: 'A' }, { type: 'image', src: 'images/missing.png', alt: 'M' }] }] };
  const entry = { version: '1.0.0', date: '2026-01-01', type: 'major', status: 'published', title: 'T' };
  const doc = preview.previewDocument({ entry, content, imageUrls: { 'a b.png': 'blob:https://x/1' }, skip: '<a class="skip" href="#main">Skip</a>', header: '<header class="site-header">H</header>', footer: '<footer class="site-footer">F</footer>' });
  assert.match(doc, /<img src="blob:https:\/\/x\/1" alt="A"/);
  assert.match(doc, /<a class="shot-link" href="blob:https:\/\/x\/1"/);
  assert.match(doc, /<img src="images\/missing\.png" alt="M"/, 'a screenshot that is not attached stays a broken image, as it would on the website');
  assert.ok(doc.indexOf('class="skip"') < doc.indexOf('site-header') && doc.indexOf('site-header') < doc.indexOf('<main') && doc.indexOf('<main') < doc.indexOf('site-footer'));
  assert.match(doc, /href="\.\.\/assets\/css\/portal\.css"/);
  assert.ok(!/<script/i.test(doc), 'the preview runs no scripts');
});

test('preview: gaps get placeholders, items without a category are left out, odd values cannot inject markup', () => {
  const evil = '"><img src=x onerror=alert(1)>';
  const p = preview.prepare({ version: evil, date: '', type: 'huge', status: 'whatever', title: '  ' }, { items: [
    { category: '', title: 'No category yet', summary: 'x' },
    { category: 'bug-fix', title: 'Fine', summary: 'x', id: evil, body: [{ type: 'callout', tone: evil, text: 'hi' }] },
    null,
  ] }, '2026-12-01');
  assert.deepEqual(p.missing, ['the version number', 'the release date', 'the title']);
  assert.deepEqual([p.entry.version, p.entry.date, p.entry.type, p.entry.status, p.entry.title], ['0.0.0', '2026-12-01', 'minor', 'published', 'Untitled release']);
  assert.deepEqual(p.omitted, ['Item 1 (“No category yet”)', 'Item 3']);
  assert.equal(p.content.items.length, 1);
  assert.equal(p.content.items[0].id, undefined, 'an unsafe id is dropped (the title is used)');
  assert.equal(p.content.items[0].body[0].tone, 'note');
  assert.ok(!preview.previewDocument(p).includes(evil), 'nothing typed into the form reaches the markup unescaped');
  assert.deepEqual(preview.describeGaps(p), [
    'Not filled in yet, so a placeholder is shown for the version number, the release date and the title.',
    'Item 1 (“No category yet”) and Item 3 are left out because they have no category yet.',
  ]);
  assert.deepEqual(preview.describeGaps({ missing: [], omitted: ['Item 2'] }), ['Item 2 is left out because it has no category yet.']);
  assert.deepEqual(preview.describeGaps({ missing: [], omitted: [] }), []);

  const d = preview.previewDocument(preview.prepare({ version: '1.0.0', date: '2026-01-01', type: 'major', status: 'draft', title: 'T' }, { items: [] }, '2026-01-01'));
  assert.match(d, /banner-draft/);
  assert.match(d, /stays hidden from the website until you publish/);
  assert.match(d, /This release has no items yet/);
  assert.equal(preview.prepare({ version: '1.0.0', date: '2026-01-01', type: 'major', status: 'published', title: 'T' }, 'not an object', '2026-01-01').content.items.length, 0, 'hand-edited JSON of the wrong shape does not break the preview');
});

test('loading a saved release for the preview is read-only and safe', async () => {
  const entry = (extra) => ({ version: '1.0.0', date: '2026-01-01', type: 'major', status: 'draft', featured: false, title: 'T', summary: 'S', ...extra });
  const idle = mockGitHub();
  for (const bad of ['../x', '1.0', 'v1.0.0']) await assert.rejects(core.loadReleaseForPreview(opts({ version: bad, fetch: idle.fetch })), /not a version number/);
  assert.equal(idle.st.calls.length, 0, 'an invalid version never reaches the API');
  await assert.rejects(core.loadReleaseForPreview(opts({ version: '4.0.0', fetch: idle.fetch })), (e) => e.status === 404);

  const custom = mockGitHub({ releases: [entry({ page: 'custom' })] });
  const c = await core.loadReleaseForPreview(opts({ version: '1.0.0', fetch: custom.fetch }));
  assert.deepEqual([c.custom, c.entry.version, c.images], [true, '1.0.0', undefined], 'a hand-written page has nothing to draw');

  const none = mockGitHub({ releases: [entry()] });
  await assert.rejects(core.loadReleaseForPreview(opts({ version: '1.0.0', fetch: none.fetch })), (e) => e.status === 404 && /no content\.json/.test(e.message));
  const broken = mockGitHub({ releases: [entry()] });
  seed(broken, 'release-notes/releases/v1.0.0/content.json', '{ nope');
  await assert.rejects(core.loadReleaseForPreview(opts({ version: '1.0.0', fetch: broken.fetch })), (e) => e.status === 422 && /not valid JSON/.test(e.message));

  const gh = mockGitHub({ releases: [entry()] });
  seed(gh, 'release-notes/releases/v1.0.0/content.json', JSON.stringify({ items: [] }));
  seed(gh, 'release-notes/releases/v1.0.0/images/a.png', Buffer.from(png(10, 10)));
  seed(gh, 'release-notes/releases/v1.0.0/images/nested/b.png', Buffer.from(png(10, 10)));
  seed(gh, 'release-notes/releases/v2.0.0/images/other.png', Buffer.from(png(10, 10)));
  const r = await core.loadReleaseForPreview(opts({ version: '1.0.0', fetch: gh.fetch }));
  assert.deepEqual(r.images.map((i) => i.name), ['a.png'], "only this release's own screenshots are loaded");
  assert.ok(gh.st.calls.every((c) => c.startsWith('GET')), 'nothing is written');
});

test('the preview frame stays locked down: no scripts, no popups, and the page CSP is unchanged', () => {
  const html = fs.readFileSync(path.join(REAL, 'admin/index.html'), 'utf8');
  assert.match(html, /<iframe[^>]*id="pvFrame"[^>]*sandbox="allow-same-origin"/);
  assert.ok(!/allow-scripts|allow-popups|allow-forms|allow-top-navigation|allow-modals/.test(html));
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /connect-src 'self' https:\/\/api\.github\.com;/);
  assert.ok(!/unsafe-|frame-src|\*/.test(csp), 'the CSP gained nothing');
});

test('the shared renderer is browser-safe: no imports and no Node APIs', () => {
  for (const f of ['assets/js/render-shared.mjs', 'admin/preview.mjs', 'admin/editor.mjs', 'assets/js/pdf.mjs', 'assets/js/walkthrough.mjs', 'assets/js/walkthrough-ui.mjs']) {
    const src = fs.readFileSync(path.join(REAL, f), 'utf8');
    assert.ok(!/node:|\bprocess\b|\bBuffer\b|\brequire\(|\bfs\./.test(src), `${f} must not use Node APIs`);
  }
  assert.ok(!/^\s*import\s/m.test(fs.readFileSync(path.join(REAL, 'assets/js/render-shared.mjs'), 'utf8')), 'the shared renderer imports nothing');
});

/* ------------------------------------------------------------------ editing comforts */
test('formatting buttons: bold, step, notes, bullets, numbers, headings; they toggle and work on several lines', () => {
  const a = editor.applySyntax;
  assert.deepEqual(a('', 0, 0, 'bold'), { text: '**bold text**', start: 2, end: 11 });
  assert.deepEqual(a('make this loud', 5, 9, 'bold'), { text: 'make **this** loud', start: 7, end: 11 });
  assert.deepEqual(a('', 0, 0, 'step'), { text: '### Step title\n', start: 4, end: 14 });
  const afterPara = a('Intro text', 10, 10, 'step');
  assert.equal(afterPara.text, 'Intro text\n\n### Step title\n', 'a step starts its own paragraph');
  assert.equal(afterPara.text.slice(afterPara.start, afterPara.end), 'Step title');
  assert.equal(a('Open the claim', 0, 14, 'step').text, '### Open the claim\n', 'selected text becomes the step title');
  assert.equal(a('', 0, 0, 'note').text, '> Note text');
  assert.equal(a('Be careful', 3, 3, 'important').text, '!> Be careful', 'the cursor can be anywhere on the line');
  assert.equal(a('one\ntwo\nthree', 0, 7, 'bullet').text, '- one\n- two\nthree', 'only the selected lines change');
  assert.equal(a('one\n\ntwo', 0, 8, 'numbered').text, '1. one\n\n2. two', 'numbering skips blank lines');
  const on = a('first\nsecond', 0, 12, 'bullet');
  assert.equal(a(on.text, on.start, on.end, 'bullet').text, 'first\nsecond', 'pressing it again turns it off');
  assert.equal(a('> a note', 0, 8, 'bullet').text, '- a note', 'another format replaces the old one');
  assert.equal(a('Title here', 0, 0, 'heading').text, '## Title here');
  assert.equal(a('one\ntwo\n', 0, 4, 'bullet').text, '- one\ntwo\n', 'a selection ending after a line break leaves the next line alone');
  assert.equal(a('\nx', 0, 0, 'note').text, '> Note text\nx', 'an empty first line is handled');
  assert.deepEqual(a('abc', 1, 2, 'unknown'), { text: 'abc', start: 1, end: 2 });
  assert.equal(a('abc', 99, 120, 'bold').text, 'abc**bold text**', 'out of range positions are clamped');
  assert.deepEqual(editor.insertImageTag('Some text', 9, 9, 2), { text: 'Some text\n[[image 2]]\n', start: 22, end: 22 }, 'the cursor lands after the tag, on a fresh line');
  assert.equal(editor.insertImageTag('', 0, 0, 1).text, '[[image 1]]\n');
  assert.equal(editor.insertImageTag('a\nb', 2, 2, 3).text, 'a\n[[image 3]]\nb');
});

test('what the formatting buttons write is what the real parser understands', () => {
  let t = '';
  const press = (kind, start = t.length, end = t.length) => { const r = editor.applySyntax(t, start, end, kind); t = r.text; return r; };
  t = 'An introduction.';
  press('step'); t = t.replace('Step title', 'Open the claim');
  t += 'Choose **Follow-up**.\n';
  const img = editor.insertImageTag(t, t.length, t.length, 1); t = img.text;
  press('note'); t = t.replace('Note text', 'Reminders belong to you.');
  t += '\n';
  press('bullet'); t = t.replace('List item', 'first point');
  const { blocks, errors } = core.parseBody(t, [{ name: 'claim.png', alt: 'The claim', caption: '' }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(blocks.map((b) => b.type), ['p', 'steps']);
  const step = blocks[1].items[0];
  assert.equal(step.title, 'Open the claim');
  assert.deepEqual(step.images, [{ src: 'images/claim.png', alt: 'The claim' }]);
  assert.match(step.note, /Reminders belong to you\./);
});

test('problems are reported per field, in page order, and messages know where to jump', () => {
  const m = model({ version: '2.42.0', date: '', title: ' ', summary: '', items: [
    { category: '', title: 'A', summary: '', body: '', images: [{ name: 'a.png', alt: '', caption: '' }, { name: 'b.png', alt: 'ok', caption: '' }] },
    { category: 'bug-fix', title: 'B', summary: 'fine', body: '', images: [] },
  ] });
  const i = editor.fieldIssues(m, { existingVersions: ['2.42.0'] });
  assert.deepEqual(Object.keys(i.meta), ['version', 'date', 'title', 'summary']);
  assert.match(i.meta.version, /already exists/);
  assert.deepEqual([i.detailsOk, i.changesOk], [false, false]);
  assert.deepEqual(Object.keys(i.items[0]).filter((k) => k !== 'secs' && i.items[0][k]), ['category', 'desc']);
  assert.deepEqual(i.items[0].secs[0].shots.map(Boolean), [true, false]);
  assert.deepEqual(i.items[1], { secs: [{ empty: '', shots: [] }] });
  assert.deepEqual(editor.problemOrder(i).map((p) => p.sel), [
    '#version', '#date', '#title', '#summary',
    '.item-form[data-i="0"] input[data-f="category"]', '.item-form[data-i="0"] [data-f="summary"]', '.item-form[data-i="0"] .part[data-s="0"] .shot-row[data-k="0"] [data-img="alt"]',
  ]);
  const good = editor.fieldIssues(model(), { existingVersions: [] });
  assert.deepEqual([good.detailsOk, good.changesOk], [true, true]);
  assert.equal(editor.fieldIssues(model({ summary: '', status: 'draft' }), {}).meta.summary, undefined, 'a draft may omit the summary');
  assert.equal(editor.fieldIssues(model({ items: [] }), {}).changesOk, false, 'no items yet is not complete');
  assert.deepEqual(editor.jumpTarget('Item 2 (“B”): add a title.'), { sel: '.item-form[data-i="1"]', item: 1, sec: -1 });
  assert.deepEqual(editor.jumpTarget('Item 1, section 3, screenshot 2: add alt text describing the screenshot (needed for screen readers).'), { sel: '.item-form[data-i="0"] .part[data-s="2"]', item: 0, sec: 2 });
  assert.deepEqual(editor.jumpTarget('Item 4, screenshot 1: add alt text.'), { sel: '.item-form[data-i="3"]', item: 3, sec: -1 }, 'a feature with a single section has no section number in its messages');
  assert.equal(editor.jumpTarget('Version must look like 2.43.0 (...)').sel, '#version');
  assert.equal(editor.jumpTarget('Choose a valid release date.').sel, '#date');
  assert.equal(editor.jumpTarget('Add a release title.').sel, '#title');
  assert.equal(editor.jumpTarget('Add a short summary (one or two sentences).').sel, '#summary');
  assert.equal(editor.jumpTarget('The JSON has a mistake: x').sel, '#json');
  assert.equal(editor.jumpTarget('Something else entirely'), null);
});

/* ------------------------------------------------------------------ sections inside a feature */
const secOf = (title, body, ...names) => ({ title, body, images: names.map((n) => ({ name: n, alt: `Alt ${n}`, caption: '' })) });

test('a feature built from sections: each has its own text and screenshots; one plain section stays plain', () => {
  const multi = core.validateRelease(model({ items: [{ category: 'new-feature', title: 'Multi', summary: 'S', sections: [
    secOf('Turn it on', 'Open **Settings**.\n[[image 1]]', 'a.png'), secOf('', 'Then pick a day.', 'b.png', 'c.png'), secOf('', ''),
  ] }] }), { existingVersions: [] });
  assert.deepEqual(multi.errors, []);
  const body = multi.content.items[0].body;
  assert.deepEqual(body.map((b) => b.type), ['section', 'section'], 'the empty third section is left out');
  assert.equal(body[0].title, 'Turn it on');
  assert.equal(body[1].title, undefined, 'a section without a title has none');
  assert.deepEqual(body[0].body.map((b) => b.type), ['p', 'image']);
  assert.deepEqual(body[0].body[1], { type: 'image', src: 'images/a.png', alt: 'Alt a.png' });
  assert.deepEqual(body[1].body.map((b) => b.type), ['p', 'gallery'], "a section's unplaced screenshots follow its text");
  assert.deepEqual(body[1].body[1].images.map((i) => i.src), ['images/b.png', 'images/c.png']);

  // one untitled section is plain text, exactly what the form produced before sections existed
  const plain = core.validateRelease(model({ items: [{ category: 'bug-fix', title: 'P', summary: 'S', sections: [secOf('', 'Just text.\n[[image 1]]', 'a.png')] }] }), {});
  const legacy = core.validateRelease(model({ items: [{ category: 'bug-fix', title: 'P', summary: 'S', body: 'Just text.\n[[image 1]]', images: [{ name: 'a.png', alt: 'Alt a.png', caption: '' }] }] }), {});
  assert.deepEqual(plain.content, legacy.content, 'an older-shaped item and a single section give identical content');
  assert.deepEqual(plain.content.items[0].body.map((b) => b.type), ['p', 'image']);

  // giving the only section a title makes it a numbered section
  const titled = core.validateRelease(model({ items: [{ category: 'bug-fix', title: 'P', summary: 'S', sections: [secOf('Only part', 'Text.')] }] }), {});
  assert.deepEqual(titled.content.items[0].body, [{ type: 'section', title: 'Only part', body: [{ type: 'p', text: 'Text.' }] }]);
  assert.deepEqual(core.itemSections({ body: 'b', images: [1] }), [{ title: '', body: 'b', images: [1] }]);
  assert.equal(core.itemSections({ sections: [] }).length, 1, 'an empty list falls back to one section');
});

test('sections: problems name the section, screenshots are unique across all of them, and empty titled sections are refused', () => {
  const m = model({ items: [{ category: 'new-feature', title: 'Multi', summary: 'S', sections: [
    secOf('One', 'text', 'a.png'),
    { title: 'Two', body: 'text\n[[image 3]]', images: [{ name: 'a.png', alt: '', caption: '' }] },
    secOf('Empty one', ''),
  ] }] });
  const e = core.validateRelease(m, {}).errors.join('\n');
  assert.match(e, /Item 1, section 2, screenshot 1: the file name "a\.png" is used twice/, 'a name used in two sections of one feature (or two features) is caught');
  assert.match(e, /Item 1, section 2, screenshot 1: add alt text/);
  assert.match(e, /Item 1, section 2: \[\[image 3\]\] points to a screenshot that has not been added to this section/);
  assert.match(e, /Item 1, section 3 \("Empty one"\): add some text or a screenshot to this section, or remove it/);
  assert.equal((e.match(/add alt text/g) || []).length, 1, 'a missing description is reported once');
  const lone = core.validateRelease(model({ items: [{ category: 'bug-fix', title: 'Lone', summary: 'S', sections: [secOf('Empty', '')] }] }), {}).errors.join('\n');
  assert.match(lone, /Item 1 \("Empty"\): add some text or a screenshot/, 'with one section, the message does not mention a section number');
  // hand-edited JSON is held to the same rules
  const content = { items: [{ category: 'bug-fix', title: 'x', summary: 'y', body: [
    { type: 'section', title: 'A', body: [{ type: 'section', body: [{ type: 'p', text: 't' }] }] }, { type: 'section', body: [] }, { type: 'section', title: 7, body: [{ type: 'p', text: 't' }] },
    { type: 'section', body: [{ type: 'image', src: 'images/nope.png', alt: 'a' }] },
  ] }] };
  const j = core.validateContent(content, new Set()).errors.join('\n');
  assert.match(j, /a section cannot contain another section/);
  assert.match(j, /a section needs some text or a screenshot/);
  assert.match(j, /the section title must be text/);
  assert.match(j, /"nope\.png" has not been attached/, 'screenshots inside sections are checked too');
});

test('sections: the real build accepts what the composer writes, and the preview draws the same page', async () => {
  const gh = mockGitHub();
  const m = model({ items: [
    { category: 'new-feature', title: 'Multi', summary: 'S', sections: [secOf('Turn it on', 'Open it.\n[[image 1]]', 'a.png'), secOf('Pick a day', 'Choose.\n\n### Pick\nDone.', 'b.png')] },
    { category: 'new-feature', title: 'Second', summary: 'S', sections: [secOf('Part', 'Text.', 'c.png'), secOf('', 'More text.')] },
    { category: 'bug-fix', title: 'Fix', summary: 'Fixed.', sections: [secOf('', 'Details.')] },
  ] });
  const v = core.validateRelease(m, { existingVersions: [] });
  assert.deepEqual(v.errors, []);
  await core.publish(opts({ entry: v.entry, content: v.content, images: ['a.png', 'b.png', 'c.png'].map((name) => ({ name, bytes: png(64, 40) })), fetch: gh.fetch }));
  const root = materialize(gh.st);
  const build = rn(root, 'build');
  assert.equal(build.code, 0, build.out);
  const built = mainOf(fs.readFileSync(path.join(root, 'releases/v2.43.0/index.html'), 'utf8'));
  for (const t of ['Section 1', 'Section 2', 'Turn it on', 'Pick a day', 'New feature 1', 'New feature 2']) assert.ok(built.includes(t), `"${t}" is on the page`);
  assert.equal((built.match(/class="sub-n">Section 1</g) || []).length, 2, 'numbering restarts in each feature');
  assert.match(built, /class="chip cat-bug-fix">Bug fix<\/span>/);
  const prep = preview.prepare(v.entry, v.content, '2026-01-01');
  assert.deepEqual([prep.missing, prep.omitted], [[], []]);
  assert.equal(mainOf(preview.previewDocument({ ...prep, imageInfo: () => ({ w: 64, h: 40 }), root: '../../' })), built, 'the preview of a sectioned release is the published page');
});

/* ------------------------------------------------------------------ interactive walkthrough */
const WALK_ENTRY = { version: '1.0.0', date: '2026-01-01', type: 'minor', title: 'The release', summary: 'What is new.' };
const walkContent = () => ({ overview: ['An intro.'], items: [
  { category: 'bug-fix', title: 'A fix', summary: 'Fixed.', body: [{ type: 'p', text: 'Details.' }, { type: 'list', items: ['a', 'b'] }] },
  { category: 'new-feature', title: 'Multi', summary: 'Has parts.', module: 'Claims', audience: ['Leads'], body: [
    { type: 'p', text: 'Lead-in.' },
    { type: 'section', title: 'Turn **it** on', body: [{ type: 'p', text: 'x' }, { type: 'image', src: 'images/a.png', alt: 'A', caption: 'Cap' }, { type: 'steps', items: [{ title: 'inner' }] }] },
    { type: 'section', body: [{ type: 'gallery', images: [{ src: 'images/b.png', alt: 'B' }, { src: 'images/c.png', alt: 'C' }] }, { type: 'steps', items: [{ title: 'inner again' }] }] },
  ] },
  { category: 'new-feature', title: 'Steps one', summary: 'S', body: [
    { type: 'steps', items: [{ title: 'Open', text: ['t1', 't2'], audience: 'Leads', path: ['Home', 'Settings'], images: [{ src: 'images/d.png', alt: 'D' }], note: 'Mind this.' }, { title: 'Save' }] },
    { type: 'callout', text: 'After.' },
  ] },
  { category: 'enhancement', title: 'Enh', summary: 'e' },
] });

test('walkthrough: an introduction, then one stop per section, step or feature, in the order of the release page', () => {
  const w = walk.buildWalkthrough({ entry: WALK_ENTRY, content: walkContent() });
  assert.deepEqual(w.groups.map((g) => g.label), ['New feature 1', 'New feature 2', 'Enhancement', 'Bug fix'], 'new features first, as on the page, numbered within their kind');
  assert.deepEqual(w.stops.map((s) => `${w.groups[s.gi].title}|${s.kind}|${s.title}|${s.kicker}`), [
    'Multi|overview|Overview|', 'Multi|section|Turn **it** on|Section 1 of 2', 'Multi|section||Section 2 of 2',
    'Steps one|step|Open|Step 1 of 2', 'Steps one|step|Save|Step 2 of 2', 'Steps one|overview|More|',
    'Enh|overview||', 'A fix|overview||',
  ]);
  assert.deepEqual(w.stops.filter((s) => s.first).map((s) => w.groups[s.gi].title), ['Multi', 'Steps one', 'Enh', 'A fix'], 'the first stop of each feature carries its description');
  assert.deepEqual(w.stops.map((s) => s.media), [false, true, true, true, false, false, false, false]);
  assert.deepEqual([w.intro.steps, w.intro.features, w.intro.version, w.intro.date, w.intro.typeLabel], [8, 4, '1.0.0', 'January 1, 2026', 'Minor release']);
  assert.deepEqual(w.intro.counts, [{ label: 'New Features', n: 2 }, { label: 'Enhancement', n: 1 }, { label: 'Bug fix', n: 1 }]);
  assert.equal(walk.countStops(walkContent()), 8);
  assert.deepEqual(walk.buildWalkthrough({ entry: WALK_ENTRY, content: { items: [{ category: 'nope', title: 'x' }] } }).stops, [], 'an item with an unknown kind is left out');
});

test('walkthrough: stops are drawn like the release page, with screenshots in their own column, and everything is escaped', () => {
  const w = walk.buildWalkthrough({ entry: WALK_ENTRY, content: walkContent() });
  const opts = { imgBase: '/site/releases/v1.0.0/' };
  const first = walk.renderStop(w, 0, opts), sec1 = walk.renderStop(w, 1, opts), sec2 = walk.renderStop(w, 2, opts), step = walk.renderStop(w, 3, opts), enh = walk.renderStop(w, 6, opts);
  assert.match(first, /class="chip cat-new-feature">New feature 1<\/span>/);
  assert.match(first, /<span class="wt-mod">Claims<\/span><span class="wt-for">For Leads<\/span>/);
  assert.match(first, /<p class="wt-sum">Has parts\.<\/p>/);
  assert.match(first, /<h2 class="wt-h">Multi<\/h2>|<h2 class="wt-h">Overview<\/h2>/);
  assert.match(sec1, /<span class="wt-pos">Section 1 of 2<\/span>/);
  assert.match(sec1, /<p class="wt-feature">Multi<\/p><h2 class="wt-h">Turn <strong>it<\/strong> on<\/h2>/, 'the feature stays visible above the section title');
  assert.ok(!sec1.includes('Has parts.'), 'only the first stop repeats the description');
  assert.match(sec1, /class="wt-content has-media"><div class="wt-media"><figure class="shot">.*src="\/site\/releases\/v1\.0\.0\/images\/a\.png".*<\/div><div class="wt-text blocks"><p>x<\/p>/s, 'the screenshot is in the media column, the text beside it');
  assert.match(sec2, /<h2 class="wt-h">Multi<\/h2>/, 'an untitled section is headed by its feature');
  assert.match(sec2, /gallery gallery-2/);
  assert.match(step, /For Leads<span class="wt-dot" aria-hidden="true"><\/span>Menu: Home &#8250; Settings/);
  assert.match(step, /<div class="wt-media">.*d\.png.*<div class="wt-text blocks"><p>t1<\/p><p>t2<\/p><aside class="callout callout-note">/s);
  assert.ok(!/class="wt-content/.test(enh), 'a feature with nothing but a description has no content area');
  // every id on every stop is unique when the stops are drawn one after another (steps inside sections included)
  const ids = w.stops.flatMap((_, i) => [...walk.renderStop(w, i, opts).matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  assert.equal(new Set(ids).size, ids.length, 'unique ids across stops');
  assert.ok(ids.includes('wt-2-step-1') && ids.includes('wt-3-step-1'));
  // nothing a person typed can inject markup
  const evil = '<img src=x onerror=alert(1)>';
  const bad = walk.buildWalkthrough({ entry: { ...WALK_ENTRY, title: evil, summary: evil }, content: { overview: [evil], items: [{ category: 'new-feature', title: evil, summary: evil, module: evil, audience: [evil], body: [{ type: 'section', title: evil, body: [{ type: 'p', text: evil }, { type: 'callout', tone: evil, text: evil }] }] }] } });
  const html = walk.renderIntro(bad) + bad.stops.map((_, i) => walk.renderStop(bad, i)).join('');
  assert.ok(!html.includes('<img src=x'), 'markup is escaped');
  assert.ok(!/onerror=alert\(1\)>/.test(html.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, '')), 'no live event handler survives');
  assert.match(walk.renderIntro(w), /v1\.0\.0.*January 1, 2026.*The release.*An intro\..*8 stops across 4 features/s);
});

test('walkthrough: offered when there is something to walk through, and not when the release brings its own', () => {
  const text = { items: [{ category: 'bug-fix', title: 'x', summary: 'y', body: [{ type: 'p', text: 't' }] }, { category: 'enhancement', title: 'z', summary: 'w' }] };
  assert.equal(walk.offersWalkthrough(text), false, 'text only: nothing to step through');
  const withImage = { items: [{ category: 'bug-fix', title: 'x', summary: 'y', body: [{ type: 'image', src: 'images/a.png', alt: 'a' }] }] };
  assert.equal(walk.offersWalkthrough(withImage), true);
  assert.equal(walk.offersWalkthrough({ items: [{ category: 'bug-fix', title: 'x', summary: 'y', body: [{ type: 'section', title: 's', body: [{ type: 'p', text: 't' }] }] }] }), true, 'a section is enough');
  assert.equal(walk.offersWalkthrough({ items: [{ category: 'bug-fix', title: 'x', summary: 'y', body: [{ type: 'steps', items: [{ title: 'a' }] }] }] }), true, 'steps are enough');
  assert.equal(walk.offersWalkthrough({ ...withImage, links: [{ label: 'Interactive walkthrough', url: 'walk.html', kind: 'demo' }] }), false, 'a release with its own walkthrough keeps it');
  assert.equal(walk.offersWalkthrough({ ...withImage, links: [{ label: 'Watch the demo', url: 'https://x.test', kind: 'video' }] }), true, 'other links do not matter');
  for (const nothing of [null, undefined, 'x', 7, {}, { items: [] }]) assert.equal(walk.offersWalkthrough(nothing), false);
  assert.equal(walk.hasImage([{ type: 'section', body: [{ type: 'steps', items: [{ title: 'a', images: [{ src: 'images/a.png', alt: 'a' }] }] }] }]), true, 'screenshots are found inside sections and steps');
  // the real v2.42.0 release: its own hand-built walkthrough is kept, yet the generated tour still draws every stop
  const real = JSON.parse(fs.readFileSync(path.join(REAL, 'releases/v2.42.0/content.json'), 'utf8'));
  assert.equal(walk.offersWalkthrough(real), false);
  const w = walk.buildWalkthrough({ entry: WALK_ENTRY, content: real });
  assert.ok(w.stops.length > 12, `v2.42.0 has ${w.stops.length} stops`);
  w.stops.forEach((_, i) => assert.match(walk.renderStop(w, i, { imgBase: '/x/' }), /<h2 class="wt-h">.+<\/h2>/));
});

test('walkthrough: a lone heading above the steps is not a stop of its own, but real text above them is', () => {
  const item = (body) => ({ items: [{ category: 'new-feature', title: 'F', summary: 's', body }] });
  const steps = { type: 'steps', items: [{ title: 'A' }, { title: 'B' }] };
  const lone = walk.buildWalkthrough({ entry: WALK_ENTRY, content: item([{ type: 'heading', text: 'How to' }, steps, { type: 'heading', text: 'The end' }]) });
  assert.deepEqual(lone.stops.map((s) => `${s.kind}|${s.title}|${s.first}`), ['step|A|true', 'step|B|false'], 'no empty "Overview"/"More" slides');
  const real = walk.buildWalkthrough({ entry: WALK_ENTRY, content: item([{ type: 'heading', text: 'How to' }, { type: 'p', text: 'Read this first.' }, steps]) });
  assert.deepEqual(real.stops.map((s) => `${s.kind}|${s.title}`), ['overview|Overview', 'step|A', 'step|B']);
  assert.deepEqual(real.stops[0].blocks.map((b) => b.type), ['heading', 'p'], 'the heading stays with the text it introduces');
  assert.equal(walk.buildWalkthrough({ entry: WALK_ENTRY, content: item([{ type: 'heading', text: 'Only a heading' }]) }).stops.length, 1, 'a feature always has at least one stop');
});

test('walkthrough viewer: nothing inline, nothing evaluated (the page CSP forbids it)', () => {
  const src = fs.readFileSync(path.join(REAL, 'assets/js/walkthrough-ui.mjs'), 'utf8');
  for (const bad of [/\bstyle=/, /<script/i, /\beval\(/, /new Function/, /javascript:/i, /setAttribute\(\s*['"]style/, /cssText/, /document\.write/, /\bfetch\(\s*['"]https?:/]) assert.ok(!bad.test(src), `walkthrough-ui.mjs must not match ${bad}`);
  // the only network request is for the release's own content.json, relative to the site root it is given
  assert.deepEqual([...src.matchAll(/\bfetch\(([^)]*)\)/g)].map((m) => m[1].split(',')[0]), ['`${base}content.json`']);
});

/* ------------------------------------------------------------------ PDF download */
// A strict reader for the files pdf.mjs writes: object offsets, stream lengths, the page tree, and every piece of text with its position.
const CP1252_BACK = { 0x80: '€', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x99: '™', 0x9B: '›' };
function readPdf(bytes) {
  const s = Buffer.from(bytes).toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4\n'), 'PDF header');
  assert.ok(s.endsWith('%%EOF\n'), 'end-of-file marker');
  const sx = s.lastIndexOf('startxref'), xrefPos = Number(s.slice(sx + 10, s.indexOf('\n', sx + 10)));
  assert.equal(s.slice(xrefPos, xrefPos + 5), 'xref\n', 'startxref points at the cross-reference table');
  const size = Number(s.slice(xrefPos).match(/^xref\n0 (\d+)\n/)[1]);
  const table = s.slice(xrefPos).split('\n').slice(2, 2 + size);
  assert.equal(table[0], '0000000000 65535 f ', 'the free entry');
  const objs = {};
  for (let n = 1; n < size; n += 1) {
    assert.match(table[n], /^\d{10} 00000 n $/, `xref entry ${n} has the exact format`);
    const at = Number(table[n].slice(0, 10));
    assert.equal(s.slice(at, at + `${n} 0 obj\n`.length), `${n} 0 obj\n`, `object ${n} starts where the table says`);
    const end = s.indexOf('\nendobj\n', at);
    const body = s.slice(at + `${n} 0 obj\n`.length, end);
    const st = body.indexOf('stream\n');
    if (st >= 0) {
      const len = Number(body.match(/\/Length (\d+)/)[1]);
      assert.equal(body.slice(st + 7 + len, st + 7 + len + 10), '\nendstream', `object ${n}: the stream length is exact`);
    }
    objs[n] = body;
  }
  assert.ok(sx > xrefPos, 'trailer after the table');
  assert.match(s.slice(xrefPos), new RegExp(`trailer\\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>`));
  const root = objs[1], pagesNo = Number(root.match(/\/Pages (\d+) 0 R/)[1]);
  const kids = [...objs[pagesNo].match(/\/Kids \[([^\]]*)\]/)[1].matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
  assert.equal(Number(objs[pagesNo].match(/\/Count (\d+)/)[1]), kids.length, '/Count matches the page list');
  const pages = kids.map((k) => {
    assert.match(objs[k], /^<< \/Type \/Page /);
    const stream = objs[Number(objs[k].match(/\/Contents (\d+) 0 R/)[1])];
    const content = stream.slice(stream.indexOf('stream\n') + 7, stream.lastIndexOf('\nendstream'));
    const segs = [];
    const re = /\/(F\d) ([\d.]+) Tf [\d. ]+ rg ([\d.-]+) ([\d.-]+) Td \(((?:\\.|[^\\)])*)\) Tj/g;
    for (const m of content.matchAll(re)) {
      const text = m[5].replace(/\\(\d{3}|.)/g, (_, c) => (c.length === 3 ? (CP1252_BACK[parseInt(c, 8)] ?? String.fromCharCode(parseInt(c, 8))) : c));
      segs.push({ font: { F1: 'r', F2: 'b', F3: 'i', F4: 'c' }[m[1]], size: Number(m[2]), x: Number(m[3]), y: Number(m[4]), text });
    }
    return { obj: objs[k], content, segs, annots: [...(objs[k].match(/\/Annots \[([^\]]*)\]/)?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((m) => objs[Number(m[1])]) };
  });
  const flat = pages.flatMap((p) => p.segs.map((g) => g.text)).join(' ').replace(/\s+/g, ' ');
  return { s, size, objs, pages, text: flat, images: Object.values(objs).filter((o) => o.includes('/Subtype /Image')).length };
}
const fakeJpeg = (w, h) => ({ jpeg: Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xFF, 0xD9]), width: w, height: h });
const PDF_NOW = new Date('2026-11-24T10:30:00Z');
const entryOf = (o = {}) => ({ version: '2.43.0', date: '2026-12-01', type: 'minor', status: 'published', featured: false, title: 'Claim reminders', summary: 'Set a reminder on any claim.', ...o });

test('pdf: the real v2.42.0 release becomes a valid, complete, well-laid-out file', () => {
  const index = JSON.parse(fs.readFileSync(path.join(REAL, 'releases.json'), 'utf8'));
  const entry = index.releases.find((r) => r.version === '2.42.0');
  const content = JSON.parse(fs.readFileSync(path.join(REAL, 'releases/v2.42.0/content.json'), 'utf8'));
  const names = new Set(JSON.stringify(content).match(/images\/[^"]+/g).map((p) => p.replace('images/', '')));
  const images = Object.fromEntries([...names].map((n, i) => [n, fakeJpeg(1800, 700 + (i % 4) * 150)]));
  const bytes = pdf.buildReleasePdf({ entry, content, images, logo: fakeJpeg(480, 150), baseUrl: 'https://x.test/RevGen-i/releases/v2.42.0/', now: PDF_NOW });
  const doc = readPdf(bytes);
  assert.ok(doc.pages.length >= 6, `a release this size needs several pages (got ${doc.pages.length})`);
  assert.equal(doc.images, names.size + 1, 'every screenshot and the logo are embedded once');
  assert.match(doc.text, /v2\.42\.0/);
  assert.ok(doc.text.includes(entry.title), 'the release title');
  for (const it of content.items) assert.ok(doc.text.includes(it.title.replace(/\s+/g, ' ')), `item "${it.title}" is in the file`);
  for (const sec of ['Overview', 'New Features', 'Enhancements & Improvements', 'Bug Fixes']) assert.ok(doc.text.includes(sec) || sec === 'Overview' && !content.overview, `section ${sec}`);
  const figs = (doc.text.match(/Figure \d+/g) || []).length;
  assert.equal(figs, (doc.pages.map((p) => (p.content.match(/ Do Q/g) || []).length).reduce((a, b) => a + b, 0)) - 1, 'one numbered caption per screenshot (the logo has none)');
  doc.pages.forEach((p, i) => assert.ok(p.segs.some((g) => g.text === `Page ${i + 1} of ${doc.pages.length}`), `footer on page ${i + 1}`));
  assert.match(doc.text, /support@commitmd\.us/);
  // every piece of text sits inside the margins, so nothing is cut off or overlaps the edge
  for (const [i, p] of doc.pages.entries()) for (const g of p.segs) {
    const w = pdf.textWidth(g.text, g.font, g.font === 'c' ? g.size / 0.92 : g.size);
    assert.ok(g.x >= 53.9 && g.x + w <= 595.28 - 54 + 0.6, `page ${i + 1}: "${g.text.slice(0, 30)}" runs from ${g.x} to ${(g.x + w).toFixed(1)}`);
    assert.ok(g.y >= 20 && g.y <= 842, `page ${i + 1}: text inside the page vertically`);
  }
  assert.equal(Buffer.from(pdf.buildReleasePdf({ entry, content, images, logo: fakeJpeg(480, 150), baseUrl: 'https://x.test/RevGen-i/releases/v2.42.0/', now: PDF_NOW })).equals(Buffer.from(bytes)), true, 'the same input gives the same file');
});

test('pdf: long text wraps inside the width, long words are cut, nothing is lost', () => {
  const runs = [{ t: 'Plain words that must wrap over several lines, ', f: 'r' }, { t: 'with bold ones', f: 'b' }, { t: ' and ', f: 'r' }, { t: 'https://example.com/' + 'a-very-long-path-segment/'.repeat(8), f: 'r' }, { t: ' end', f: 'r' }];
  const lines = pdf.wrapRuns(runs, 10.5, 200);
  assert.ok(lines.length > 3);
  for (const ln of lines) assert.ok(ln.w <= 200.01, `a line is ${ln.w} wide`);
  const joined = lines.map((l) => l.toks.map((t) => t.s).join('')).join(' ').replace(/\s+/g, '');
  assert.equal(joined, runs.map((r) => r.t).join('').replace(/\s+/g, ''), 'every character is kept');
  assert.deepEqual(pdf.wrapRuns([{ t: '', f: 'r' }], 10, 100).map((l) => l.toks.length), [0], 'an empty paragraph is one empty line');
  assert.ok(Math.abs(pdf.textWidth('Hello', 'r', 10) - 22.78) < 0.001, 'Helvetica widths: H 722 e 556 l 222 l 222 o 556 = 2278 units');
  assert.ok(pdf.textWidth('Hello', 'b', 10) > pdf.textWidth('Hello', 'r', 10), 'bold is wider');
  assert.ok(Math.abs(pdf.textWidth('abc', 'c', 10) - 3 * 0.6 * 9.2) < 1e-9, 'code is set at 92% of the size, 600 units per character');
});

test('pdf: special characters are escaped and encoded, and what a PDF font cannot show becomes ?', () => {
  const title = 'Reports (beta) \\ “Quoted” — café • 100% ✓ 😀 →';
  const doc = readPdf(pdf.buildReleasePdf({ entry: entryOf({ title }), content: { items: [] }, now: PDF_NOW }));
  assert.ok(doc.text.includes('Reports (beta) \\ “Quoted” — café • 100% ?'), `decoded: ${doc.text.slice(0, 120)}`);
  assert.match(doc.text, /->/, 'an arrow becomes ->');
  const raw = doc.pages[0].content;
  assert.match(raw, /Reports \\\(beta\\\) \\\\ \\223Quoted\\224 \\227 caf\\351 \\225 100%/, 'parentheses and backslashes are escaped, quotes and dashes use their WinAnsi codes');
  assert.match(doc.objs[3], /\/Title <FEFF/, 'the document title is stored as UTF-16');
  assert.match(doc.objs[3], /\/CreationDate \(D:20261124103000Z\)/);
  assert.equal(pdf.clean('a\tb\nc d​e'), 'a b c de');
});

test('pdf: links are clickable, relative ones resolve, unsafe ones are plain text', () => {
  const content = { items: [{ category: 'new-feature', title: 'Links', summary: 'See [Docs](https://example.com/a(b)) and [the walkthrough](interactive-walkthrough.html) and [bad](javascript:alert(1)).', links: [{ label: 'Demo', url: 'https://example.com/demo', kind: 'video' }] }],
    links: [{ label: 'Watch the demo', url: 'https://example.com/video', kind: 'video' }] };
  const withBase = readPdf(pdf.buildReleasePdf({ entry: entryOf(), content, baseUrl: 'https://x.test/RevGen-i/releases/v1.0.0/', now: PDF_NOW }));
  const uris = withBase.pages.flatMap((p) => p.annots).map((a) => a.match(/\/URI \(((?:\\.|[^\\)])*)\)/)[1].replace(/\\(.)/g, '$1'));
  assert.deepEqual(uris.sort(), ['https://example.com/a(b)', 'https://example.com/demo', 'https://example.com/video', 'https://x.test/RevGen-i/releases/v1.0.0/interactive-walkthrough.html', 'mailto:support@commitmd.us'].sort());
  assert.match(withBase.text, /bad/, 'an unsafe link keeps its label as plain text');
  assert.ok(!uris.some((u) => /javascript/i.test(u)));
  const noBase = readPdf(pdf.buildReleasePdf({ entry: entryOf(), content, now: PDF_NOW }));
  const uris2 = noBase.pages.flatMap((p) => p.annots).map((a) => a.match(/\/URI \(((?:\\.|[^\\)])*)\)/)[1]);
  assert.ok(!uris2.some((u) => /walkthrough/.test(u)), 'a relative link with nothing to resolve it against is not clickable');
  for (const a of withBase.pages.flatMap((p) => p.annots)) assert.match(a, /^<< \/Type \/Annot \/Subtype \/Link \/Rect \[[\d. -]+\] \/Border \[0 0 0\] \/A << \/S \/URI \/URI \(/);
});

test('pdf: every block type renders; a missing screenshot is said so; draft and sample releases are marked', () => {
  const img = { src: 'images/a.webp', alt: 'A', caption: 'First **shot**' };
  const content = {
    overview: ['First paragraph.', 'Second paragraph.'],
    items: [
      { category: 'enhancement', title: 'Everything', module: 'Claims', audience: ['Leads', 'Managers'], summary: 'Summary.', body: [
        { type: 'p', text: 'A paragraph with `code` and **bold**.' }, { type: 'heading', text: 'A sub-heading' },
        { type: 'list', ordered: false, items: ['bullet one', 'bullet two'] }, { type: 'list', ordered: true, items: ['first', 'second'] },
        { type: 'callout', tone: 'important', text: 'Careful here.' }, { type: 'callout', tone: 'note', text: 'Just a note.' },
        { type: 'image', ...img }, { type: 'image', src: 'images/missing.webp', alt: 'M' },
        { type: 'gallery', images: [img, img, img, img] },
        { type: 'steps', items: [{ title: 'Open it', audience: 'Leads', path: ['Home', 'Settings'], text: ['Do this.', 'Then that.'], note: 'Mind this.', images: [img] }, { title: 'Save it' }] },
      ] },
      { category: 'bug-fix', title: 'Plain fix', summary: 'Fixed.' },
    ],
  };
  const doc = readPdf(pdf.buildReleasePdf({ entry: entryOf({ status: 'draft', sample: true, featured: true, type: 'major' }), content, images: { 'a.webp': fakeJpeg(900, 500) }, now: PDF_NOW }));
  for (const t of ['Overview', 'Second paragraph.', 'A sub-heading', 'bullet two', '2. ', 'IMPORTANT', 'NOTE', 'Careful here.', 'Screenshot not available: missing.webp', 'Open it', 'Menu: Home › Settings', 'For Leads', 'Save it', 'Plain fix', 'Draft', 'Sample', 'Featured', 'Major release', 'Figure 7']) {
    assert.ok(doc.text.includes(t), `"${t}" is in the file`);
  }
  assert.match(doc.text, /not published/);
  assert.equal(doc.images, 1, 'one screenshot is embedded once however many times it is used');
  const empty = readPdf(pdf.buildReleasePdf({ entry: entryOf(), content: { items: [] }, now: PDF_NOW }));
  assert.match(empty.text, /This release has no items yet\./);
  assert.equal(empty.pages.length, 1);
  const odd = readPdf(pdf.buildReleasePdf({ entry: entryOf(), content: { items: [{ category: 'nonsense', title: 'x' }, { category: 'bug-fix', title: 'kept', summary: 's' }] }, now: PDF_NOW }));
  assert.ok(odd.text.includes('kept') && !odd.text.includes(' x '), 'an item with an unknown category is left out instead of breaking the file');
});

test('pdf: a screenshot that almost fits is shrunk to finish the page; a much bigger one moves to the next page', () => {
  // The same item with 1..70 filler lines before one 900x500 screenshot: find where the screenshot lands and how big it is.
  const draw = (fill) => {
    const content = { items: [{ category: 'bug-fix', title: 'T', summary: 'S', body: [...Array.from({ length: fill }, (_, i) => ({ type: 'p', text: `Filler line ${i}.` })), { type: 'image', src: 'images/a.webp', alt: 'A' }] }] };
    const doc = readPdf(pdf.buildReleasePdf({ entry: entryOf(), content, images: { 'a.webp': fakeJpeg(900, 500) }, now: PDF_NOW }));
    const pageIdx = doc.pages.findIndex((p) => / Do Q/.test(p.content));
    const m = doc.pages[pageIdx].content.match(/q ([\d.]+) 0 0 ([\d.]+) [\d.]+ ([\d.]+) cm \/Im1 Do Q/);
    const lowest = Math.min(...doc.pages[0].segs.filter((g) => g.y > 40).map((g) => g.y));
    return { pageIdx, w: Number(m[1]), roomBelowText: lowest - 64 }; // PDF y counts from the bottom; the bottom margin is 64
  };
  const natural = 487.28; // a 900x500 picture at the full text width
  const runs = Array.from({ length: 70 }, (_, i) => ({ fill: i + 1, ...draw(i + 1) }));
  const shrunk = runs.filter((r) => r.pageIdx === 0 && r.w < natural - 1);
  assert.ok(shrunk.length >= 3, 'somewhere a screenshot is shrunk to finish the page instead of being pushed away');
  for (const r of shrunk) assert.ok(r.w >= natural * 0.62 - 1, `never shrunk below about 62% (got ${Math.round(r.w / natural * 100)}%)`);
  for (const r of runs.filter((x) => x.pageIdx === 1)) assert.ok(r.roomBelowText < 0.62 * 290 + 30, `with filler ${r.fill} the screenshot moved on although ${Math.round(r.roomBelowText)} pt were free`);
  assert.ok(runs.some((r) => r.pageIdx === 1), 'and a screenshot that really does not fit still starts a new page');
});

test('pdf: many items flow onto more pages with the right footers; file names are safe', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ category: ['new-feature', 'enhancement', 'improvement', 'bug-fix'][i % 4], title: `Item number ${i + 1}`, summary: 'A short summary of the change. '.repeat(6), body: [{ type: 'p', text: 'More detail about it. '.repeat(25) }] }));
  const doc = readPdf(pdf.buildReleasePdf({ entry: entryOf(), content: { items }, now: PDF_NOW }));
  assert.ok(doc.pages.length > 8);
  doc.pages.forEach((p, i) => assert.ok(p.segs.some((g) => g.text === `Page ${i + 1} of ${doc.pages.length}`)));
  for (let i = 1; i <= 40; i += 1) assert.ok(doc.text.includes(`Item number ${i}`), `item ${i}`);
  assert.equal(pdf.pdfFileName({ version: '2.42.0', status: 'published' }), 'RevGen-i-release-notes-v2.42.0.pdf');
  assert.equal(pdf.pdfFileName({ version: '2.43.0', status: 'draft' }), 'RevGen-i-release-notes-v2.43.0-draft.pdf');
  assert.equal(pdf.pdfFileName({ version: '../../x"y', status: 'published' }), 'RevGen-i-release-notes-v....xy.pdf', 'a version can never put path characters in the file name');
});

test('the draft kept in the browser: text only, restored safely, never trusted blindly', () => {
  const form = { version: '2.43.0', date: '2026-12-01', type: 'minor', status: 'draft', featured: true, title: 'T', summary: 'S', tags: 'a', overview: 'O' };
  const items = [{ category: 'bug-fix', title: 'Fix', module: 'M', audience: 'A', summary: 'x', body: 'b', images: [{ name: 'a.png', bytes: new Uint8Array(9) }, { name: 'b.png' }] }];
  const d = editor.makeDraft({ form, links: [{ label: 'L', url: 'https://x.test', kind: 'demo' }], items }, 1000);
  const json = JSON.stringify(d);
  assert.ok(!json.includes('bytes') && !json.includes('a.png'), 'screenshots are never stored, only how many there were');
  const back = editor.readDraft(json);
  assert.deepEqual(back.form, form);
  assert.deepEqual(back.items[0], { category: 'bug-fix', title: 'Fix', module: 'M', audience: 'A', summary: 'x', sections: [{ title: '', body: 'b', shots: 2 }], shots: 2 });
  assert.equal(back.at, 1000);
  // sections survive, each with its own count of screenshots
  const multi = editor.readDraft(JSON.stringify(editor.makeDraft({ form, links: [], items: [{ category: 'new-feature', title: 'F', summary: 's', sections: [{ title: 'One', body: 'a', images: [{ name: 'x.png' }] }, { title: '', body: 'b', images: [{ name: 'y.png' }, { name: 'z.png' }] }] }] })));
  assert.deepEqual(multi.items[0].sections, [{ title: 'One', body: 'a', shots: 1 }, { title: '', body: 'b', shots: 2 }]);
  assert.equal(multi.items[0].shots, 3);
  // a draft saved before sections existed (one body and one shots count per feature) comes back as a single section
  const old = editor.readDraft(JSON.stringify({ v: 1, at: 7, form, links: [], items: [{ category: 'bug-fix', title: 'Old', body: 'old text', shots: 2 }] }));
  assert.deepEqual(old.items[0].sections, [{ title: '', body: 'old text', shots: 2 }]);
  assert.equal(editor.readDraft(JSON.stringify({ v: 1, at: 7, form, items: [{ sections: Array.from({ length: 99 }, () => ({ body: 'x' })) }] })).items[0].sections.length, 50, 'absurdly many sections are cut');
  assert.equal(editor.isBlankDraft(editor.readDraft(JSON.stringify({ v: 1, at: 7, form: { ...form, title: '', summary: '', overview: '' }, items: [{ sections: [{ title: '', body: '  ' }] }] }))), true);
  assert.equal(editor.isBlankDraft(editor.readDraft(JSON.stringify({ v: 1, at: 7, form: { ...form, title: '', summary: '', overview: '' }, items: [{ sections: [{ title: '', body: 'text only in a section' }] }] }))), false);
  for (const bad of [null, '', 'not json', '{}', '{"v":2}', '[]', JSON.stringify({ v: 1, at: 'x', form: {} }), JSON.stringify({ v: 1, at: 1 })]) assert.equal(editor.readDraft(bad), null, `rejects ${bad}`);
  const odd = editor.readDraft(JSON.stringify({ v: 1, at: 5, form: { type: 'huge', status: 'x', title: 7 }, links: [{ kind: 'zzz', label: 5 }, null], items: [{ category: 'nope', shots: -3 }, null, { title: 'ok', shots: 2.5 }] }));
  assert.deepEqual([odd.form.type, odd.form.status, odd.form.title], ['minor', 'published', '']);
  assert.deepEqual(odd.links.map((l) => l.kind), ['other', 'other']);
  assert.deepEqual(odd.items.map((i) => [i.category, i.shots]), [['', 0], ['', 0], ['', 0]]);
  assert.equal(editor.isBlankDraft(editor.readDraft(editor.makeDraft({ form: { ...form, title: '', summary: '', overview: '' }, links: [], items: [{ category: '', title: '', module: '', audience: '', summary: '', body: '', images: [] }] }))), true);
  assert.equal(editor.isBlankDraft(back), false);
  const huge = editor.readDraft(editor.makeDraft({ form: { ...form, overview: 'x'.repeat(300000) }, links: [], items: [] }));
  assert.equal(huge.form.overview.length, 100000, 'absurdly long text is cut');
  assert.deepEqual([0, 30, 50, 90, 3000, 7200, 90000, 200000].map((s) => editor.timeAgo(0, s * 1000)),
    ['just now', 'just now', '1 minute ago', '2 minutes ago', '50 minutes ago', '2 hours ago', 'yesterday', '2 days ago']);
});
