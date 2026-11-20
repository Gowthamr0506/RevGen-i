// Run:  node --test tools/tests/rn.test.mjs      (Node 20+, no dependencies)
// Every test works on a throw-away copy of the portal in the OS temp folder; your real releases are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProject } from '../lib/model.mjs';
import { readImageInfo } from '../lib/images.mjs';
import { inline } from '../lib/util.mjs';

const REAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RN = path.join(REAL, 'tools', 'rn.mjs');

function makePortal(site = { url: '', noindex: false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-test-'));
  for (const p of ['templates', 'assets', 'index.html', 'releases/index.html']) fs.cpSync(path.join(REAL, p), path.join(root, p), { recursive: true });
  fs.writeFileSync(path.join(root, 'releases.json'), JSON.stringify({ product: 'RevGen-i', schemaVersion: 1, site, releases: [] }));
  return root;
}
const rn = (root, ...args) => { const r = spawnSync(process.execPath, [RN, ...args, '--root', root], { encoding: 'utf8' }); return { code: r.status, out: `${r.stdout}${r.stderr}` }; };
const png = (w, h) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const ITEM = (extra = {}) => ({ category: 'new-feature', title: 'A feature', summary: 'It does a thing.', ...extra });

function addRelease(root, version, content, flags = []) {
  const r = rn(root, 'new', version, '--title', `Release ${version}`, '--summary', `Summary of ${version}.`, ...flags);
  assert.equal(r.code, 0, r.out);
  fs.writeFileSync(path.join(root, 'releases', `v${version}`, 'content.json'), JSON.stringify(content ?? { items: [ITEM()] }));
}
function snapshot(root) {
  const out = new Map();
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.set(path.relative(root, p).replace(/\\/g, '/'), crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'));
    }
  })(root);
  return out;
}
const errorsOf = (root) => loadProject(root).report.errors.map((e) => e.message);

test('new + build produces a page, a derived index entry, and is idempotent', () => {
  const root = makePortal();
  addRelease(root, '1.0.0', { items: [ITEM(), ITEM({ category: 'bug-fix', title: 'A fix' })] });
  assert.equal(rn(root, 'build').code, 0);
  const index = JSON.parse(fs.readFileSync(path.join(root, 'releases.json'), 'utf8'));
  assert.deepEqual(index.releases[0].derived.categories, ['new-feature', 'bug-fix']);
  assert.deepEqual(index.releases[0].derived.counts, { 'new-feature': 1, 'bug-fix': 1 });
  assert.ok(fs.existsSync(path.join(root, 'releases/v1.0.0/index.html')));
  assert.match(rn(root, 'build').out, /Wrote 0 files/);
  assert.equal(rn(root, 'validate').code, 0);
});

test('adding a release leaves every other release byte-identical', () => {
  const root = makePortal();
  addRelease(root, '1.0.0');
  addRelease(root, '1.1.0');
  assert.equal(rn(root, 'build').code, 0);
  const before = snapshot(root);
  addRelease(root, '1.2.0');
  assert.equal(rn(root, 'build').code, 0);
  const after = snapshot(root);
  const changed = [...after.keys()].filter((k) => before.get(k) !== after.get(k));
  assert.ok(changed.length > 0);
  for (const f of changed) assert.ok(f === 'releases.json' || f.startsWith('releases/v1.2.0/'), `unexpected change: ${f}`);
  for (const k of before.keys()) if (k !== 'releases.json') assert.equal(after.get(k), before.get(k), `${k} was modified or removed`);
});

test('duplicate versions are refused, by the CLI and by the validator', () => {
  const root = makePortal();
  addRelease(root, '1.0.0');
  const dup = rn(root, 'new', '1.0.0', '--title', 'Again', '--summary', 'Again.');
  assert.equal(dup.code, 1);
  assert.match(dup.out, /already exists/);
  const file = path.join(root, 'releases.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.releases.push({ ...data.releases[0] });
  fs.writeFileSync(file, JSON.stringify(data));
  assert.ok(errorsOf(root).some((m) => /duplicate version/.test(m)));
});

test('releases are ordered newest first (date, then version)', () => {
  const root = makePortal();
  addRelease(root, '1.0.0', null, ['--date', '2026-01-10']);
  addRelease(root, '1.1.0', null, ['--date', '2026-03-01']);
  addRelease(root, '1.0.1', null, ['--date', '2026-03-01']);
  assert.equal(rn(root, 'build').code, 0);
  const versions = JSON.parse(fs.readFileSync(path.join(root, 'releases.json'), 'utf8')).releases.map((r) => r.version);
  assert.deepEqual(versions, ['1.1.0', '1.0.1', '1.0.0']);
});

test('validation: missing images, wrong capitalisation, missing alt text, external images', () => {
  const root = makePortal();
  addRelease(root, '1.0.0', { items: [ITEM({ body: [
    { type: 'image', src: 'images/missing.png', alt: 'x' },
    { type: 'image', src: 'images/shot.png', alt: 'wrong case' },
    { type: 'image', src: 'images/Real.png', alt: '' },
    { type: 'image', src: 'https://example.com/a.png', alt: 'remote' },
    { type: 'image', src: '../v1.0.0/images/Real.png', alt: 'escape' },
  ] })] });
  fs.writeFileSync(path.join(root, 'releases/v1.0.0/images/Shot.png'), png(10, 10));
  fs.writeFileSync(path.join(root, 'releases/v1.0.0/images/Real.png'), png(10, 10));
  const errors = errorsOf(root).join('\n');
  assert.match(errors, /image not found: releases\/v1\.0\.0\/images\/missing\.png/);
  assert.match(errors, /different capitalisation|case-sensitive/);
  assert.match(errors, /"alt" text is required/);
  assert.match(errors, /external images are not allowed/);
  assert.match(errors, /relative path inside the release folder/);
});

test('validation: bad metadata and content structure', () => {
  const root = makePortal();
  addRelease(root, '1.0.0', { items: [] });
  assert.ok(errorsOf(root).some((m) => /needs at least one item/.test(m)), 'published release with no items');
  addRelease(root, '1.1.0', { items: [ITEM({ id: 'same' }), ITEM({ id: 'same', title: 'B' }), ITEM({ category: 'nope', title: 'C' }), { category: 'bug-fix', title: 'No text' }] });
  const e = errorsOf(root).join('\n');
  assert.match(e, /duplicate id "same"/);
  assert.match(e, /"category" must be one of/);
  assert.match(e, /no description is not useful|add a "summary" or a "body"/);
  const file = path.join(root, 'releases.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.releases[0].date = '2026-02-30';
  data.releases[1].version = 'v1.0';
  fs.writeFileSync(file, JSON.stringify(data));
  const e2 = errorsOf(root).join('\n');
  assert.match(e2, /real calendar date/);
  assert.match(e2, /semantic MAJOR\.MINOR\.PATCH/);
});

test('stage never publishes drafts or source files', () => {
  const root = makePortal();
  addRelease(root, '1.0.0', { items: [ITEM({ body: [{ type: 'image', src: 'images/a.png', alt: 'A' }] })] });
  fs.writeFileSync(path.join(root, 'releases/v1.0.0/images/a.png'), png(40, 30));
  addRelease(root, '1.1.0', { items: [ITEM({ title: 'Secret upcoming feature' })] }, ['--status', 'draft']);
  assert.equal(rn(root, 'build').code, 0);
  const out = path.join(root, '_site');
  const r = rn(root, 'stage', '--out', out);
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(out, 'releases/v1.0.0/index.html')));
  assert.ok(fs.existsSync(path.join(out, 'releases/v1.0.0/images/a.png')));
  assert.ok(fs.existsSync(path.join(out, '.nojekyll')));
  assert.ok(!fs.existsSync(path.join(out, 'releases/v1.1.0')), 'draft folder must not be staged');
  assert.ok(!fs.existsSync(path.join(out, 'releases/v1.0.0/content.json')), 'source content must not be staged');
  assert.ok(!fs.existsSync(path.join(out, 'tools')) && !fs.existsSync(path.join(out, 'templates')));
  const staged = fs.readFileSync(path.join(out, 'releases.json'), 'utf8');
  assert.ok(!staged.includes('Secret upcoming feature') && !staged.includes('"1.1.0"'), 'draft must not appear in the staged releases.json');
  const everything = [...snapshot(out).keys()].map((k) => fs.readFileSync(path.join(out, k), 'latin1')).join('');
  assert.ok(!everything.includes('Secret upcoming feature'));
});

test('stage refuses to wipe a folder it did not create', () => {
  const root = makePortal();
  addRelease(root, '1.0.0');
  assert.equal(rn(root, 'build').code, 0);
  const precious = path.join(root, 'precious');
  fs.mkdirSync(precious);
  fs.writeFileSync(path.join(precious, 'keep.txt'), 'keep');
  const r = rn(root, 'stage', '--out', precious);
  assert.equal(r.code, 1);
  assert.ok(fs.existsSync(path.join(precious, 'keep.txt')));
  assert.equal(rn(root, 'stage', '--out', root).code, 1, 'must refuse the source folder itself');
});

test('stage writes sitemap and robots only when site.url is set', () => {
  const root = makePortal({ url: 'https://example.github.io/RevGen-i/', noindex: false });
  addRelease(root, '1.0.0');
  assert.equal(rn(root, 'build').code, 0);
  const out = path.join(root, '_site');
  assert.equal(rn(root, 'stage', '--out', out).code, 0);
  assert.match(fs.readFileSync(path.join(out, 'sitemap.xml'), 'utf8'), /https:\/\/example\.github\.io\/RevGen-i\/releases\/v1\.0\.0\//);
  assert.match(fs.readFileSync(path.join(out, 'releases/v1.0.0/index.html'), 'utf8'), /<link rel="canonical" href="https:\/\/example\.github\.io\/RevGen-i\/releases\/v1\.0\.0\/">/);
  const plain = makePortal();
  addRelease(plain, '1.0.0');
  rn(plain, 'build');
  rn(plain, 'stage', '--out', path.join(plain, '_site'));
  assert.ok(!fs.existsSync(path.join(plain, '_site/sitemap.xml')));
});

test('publish flips a draft, and refuses an incomplete one without changing anything', () => {
  const root = makePortal();
  addRelease(root, '1.0.0', { items: [] }, ['--status', 'draft']);
  const before = fs.readFileSync(path.join(root, 'releases.json'), 'utf8');
  const bad = rn(root, 'publish', '1.0.0');
  assert.equal(bad.code, 1);
  assert.equal(fs.readFileSync(path.join(root, 'releases.json'), 'utf8'), before);
  fs.writeFileSync(path.join(root, 'releases/v1.0.0/content.json'), JSON.stringify({ items: [ITEM()] }));
  assert.equal(rn(root, 'publish', '1.0.0').code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'releases.json'), 'utf8')).releases[0].status, 'published');
});

test('image import: URL-safe names, no overwrite of different files, sizes read from headers', () => {
  const root = makePortal();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-src-'));
  fs.writeFileSync(path.join(src, 'My Shot (1).PNG'), png(120, 80));
  const r = rn(root, 'new', '1.0.0', '--title', 'T', '--summary', 'S', '--images', src);
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(root, 'releases/v1.0.0/images/my-shot-1.png')));
  assert.match(r.out, /My Shot \(1\)\.PNG -> images\/my-shot-1\.png {2}\(120x80/);
  const other = path.join(src, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'my shot 1.png'), png(7, 7));
  assert.equal(rn(root, 'images', '1.0.0', other).code, 0);
  assert.ok(fs.existsSync(path.join(root, 'releases/v1.0.0/images/my-shot-1-2.png')), 'a different file with the same name gets a suffix');
  assert.equal(readImageInfo(path.join(root, 'releases/v1.0.0/images/my-shot-1.png')).w, 120);
});

test('image headers: jpeg, gif, webp (VP8X) and svg dimensions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-img-'));
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  fs.writeFileSync(path.join(dir, 'a.jpg'), jpg);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x30, 0x00, 0x20, 0x00]), Buffer.alloc(8)]);
  fs.writeFileSync(path.join(dir, 'a.gif'), gif);
  const webp = Buffer.alloc(40); webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write('VP8X', 12);
  webp.writeUIntLE(99, 24, 3); webp.writeUIntLE(49, 27, 3);
  fs.writeFileSync(path.join(dir, 'a.webp'), webp);
  fs.writeFileSync(path.join(dir, 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150"></svg>');
  assert.deepEqual(readImageInfo(path.join(dir, 'a.jpg')) && { w: readImageInfo(path.join(dir, 'a.jpg')).w, h: readImageInfo(path.join(dir, 'a.jpg')).h }, { w: 64, h: 32 });
  assert.equal(readImageInfo(path.join(dir, 'a.gif')).w, 48);
  assert.deepEqual([readImageInfo(path.join(dir, 'a.webp')).w, readImageInfo(path.join(dir, 'a.webp')).h], [100, 50]);
  assert.deepEqual([readImageInfo(path.join(dir, 'a.svg')).w, readImageInfo(path.join(dir, 'a.svg')).h], [300, 150]);
});

test('a hand-written (custom) release page is listed but never overwritten', () => {
  const root = makePortal();
  addRelease(root, '1.0.0');
  const dir = path.join(root, 'releases/v0.9.0');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Legacy</title><p>Hand written.</p>');
  const file = path.join(root, 'releases.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.releases.push({ version: '0.9.0', date: '2025-01-01', type: 'minor', status: 'published', featured: false, page: 'custom', title: 'Legacy release', summary: 'Older hand-written page.' });
  fs.writeFileSync(file, JSON.stringify(data));
  const r = rn(root, 'build');
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<!doctype html><title>Legacy</title><p>Hand written.</p>');
  const out = path.join(root, '_site');
  assert.equal(rn(root, 'stage', '--out', out).code, 0);
  assert.ok(fs.existsSync(path.join(out, 'releases/v0.9.0/index.html')));
});

test('content is escaped: markup in text cannot inject HTML, and unsafe links are dropped', () => {
  assert.equal(inline('<img src=x onerror=alert(1)> & **bold** `a<b`'), '&lt;img src=x onerror=alert(1)&gt; &amp; <strong>bold</strong> <code>a&lt;b</code>');
  assert.equal(inline('[click](javascript:alert(1))'), 'click');
  assert.match(inline('[docs](https://example.com/a?x=1&y=2)'), /<a href="https:\/\/example\.com\/a\?x=1&amp;y=2" rel="noopener noreferrer">docs<\/a>/);
  assert.match(inline('[wiki](https://example.com/Foo_(bar)) done'), /href="https:\/\/example\.com\/Foo_\(bar\)" rel="noopener noreferrer">wiki<\/a> done/);
  const root = makePortal();
  addRelease(root, '1.0.0', { items: [ITEM({ title: '<script>alert(1)</script>', summary: '<b>x</b>' })] });
  assert.equal(rn(root, 'build').code, 0);
  const html = fs.readFileSync(path.join(root, 'releases/v1.0.0/index.html'), 'utf8');
  assert.ok(!html.includes('<script>alert(1)'), 'raw script tag must not appear');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('url() references in the stylesheets are checked: missing font, wrong case, third-party file', () => {
  const root = makePortal();
  addRelease(root, '1.0.0');
  assert.equal(rn(root, 'build').code, 0, 'the shipped fonts.css must resolve');
  const css = path.join(root, 'assets/css/fonts.css');
  const original = fs.readFileSync(css, 'utf8');
  fs.writeFileSync(css, original.replace('tasa-orbiter-latin.woff2', 'Tasa-Orbiter-Latin.woff2'));
  const wrongCase = rn(root, 'validate');
  assert.equal(wrongCase.code, 1);
  assert.match(wrongCase.out, /assets\/css\/fonts\.css: url\(\.\.\/fonts\/Tasa-Orbiter-Latin\.woff2\) .* not found/);
  fs.writeFileSync(css, `${original}\n@font-face{font-family:X;src:url("https://fonts.gstatic.com/x.woff2")}`);
  const external = rn(root, 'validate');
  assert.equal(external.code, 1);
  assert.match(external.out, /external resource "https:\/\/fonts\.gstatic\.com\/x\.woff2"/);
});

test('the link checker catches a broken link in generated pages', () => {
  const root = makePortal();
  addRelease(root, '1.0.0', { items: [ITEM({ links: [{ label: 'Demo', url: 'nope.html', kind: 'demo' }] })] });
  const r = rn(root, 'build');
  assert.equal(r.code, 1);
  assert.match(r.out, /linked file not found: releases\/v1\.0\.0\/nope\.html/);
  assert.ok(!fs.existsSync(path.join(root, 'releases/v1.0.0/index.html')), 'a failed build writes nothing');
});
