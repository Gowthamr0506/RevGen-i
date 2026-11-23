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

const REAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RN = path.join(REAL, 'tools', 'rn.mjs');
const png = (w, h) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return new Uint8Array(b); };
const ok = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const b64 = (s) => Buffer.from(s).toString('base64').replace(/(.{60})/g, '$1\n');

/** A tiny in-memory GitHub: just the endpoints the composer uses, with real fast-forward semantics. */
function mockGitHub({ releases = [], raceOnce = false, failWith = null } = {}) {
  const st = { head: 'c0', files: new Map(), commits: new Map(), trees: new Map(), blobs: new Map(), n: 0, calls: [], raced: false };
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
      return ok({ truncated: false, tree: [...files.keys()].map((path) => ({ path, mode: '100644', type: 'blob', sha: 'x' })) });
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
