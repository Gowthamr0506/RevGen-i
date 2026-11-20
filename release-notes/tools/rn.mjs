#!/usr/bin/env node
// RevGen-i release notes CLI. Zero dependencies; needs Node 20+.
//   node tools/rn.mjs new <version> --title "..." --summary "..." [--date YYYY-MM-DD] [--images <dir|file>...]
//   node tools/rn.mjs images <version> <dir|file>...      add screenshots to an existing release
//   node tools/rn.mjs build                               validate, then regenerate pages + releases.json
//   node tools/rn.mjs validate [--strict]                 read-only check (also reports stale generated files)
//   node tools/rn.mjs publish <version>                   draft -> published
//   node tools/rn.mjs list                                one line per release
//   node tools/rn.mjs stage [--out <dir>]                 build the folder that GitHub Pages deploys (no drafts)
//   node tools/rn.mjs serve [--port 5211] [--root <dir>]  local preview server
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  DEFAULT_ROOT, IMAGE_EXT, SEMVER, STATUSES, TYPES, formatBytes, isIsoDate, normalizeVersion, releaseOrder, slugify,
  todayIso, typeFromVersion, writeIfChanged,
} from './lib/util.mjs';
import { readImageInfo } from './lib/images.mjs';
import { loadProject, serializeEntry, sortedRecords } from './lib/model.mjs';
import { runBuild, stage } from './lib/build.mjs';

const HELP = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(1, 10).map((l) => l.slice(3)).join('\n');
class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };

/* ---------- reporting ---------- */
function printReport(report, root) {
  const gh = !!process.env.GITHUB_ACTIONS;
  const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  for (const it of report.items) {
    const tag = it.level === 'error' ? 'ERROR' : 'WARN ';
    console.log(`${tag} ${it.file}: ${it.message}`);
    if (gh) {
      const abs = path.join(root, it.file.split(' ')[0]);
      const file = path.relative(process.env.GITHUB_WORKSPACE || process.cwd(), abs).replace(/\\/g, '/');
      console.log(`::${it.level === 'error' ? 'error' : 'warning'} file=${file}::${esc(it.message)}`);
    }
  }
}
function finish(report, root, { strict = false } = {}) {
  printReport(report, root);
  const bad = report.errors.length > 0 || (strict && report.warnings.length > 0);
  console.log(`\n${report.errors.length} error${report.errors.length === 1 ? '' : 's'}, ${report.warnings.length} warning${report.warnings.length === 1 ? '' : 's'}`);
  return bad ? 1 : 0;
}

/* ---------- images ---------- */
function safeName(name) {
  const ext = path.extname(name).toLowerCase();
  return `${slugify(path.basename(name, path.extname(name))) || 'image'}${ext}`;
}
/** Copy images into releases/vX/images with URL-safe names. Never overwrites a different file. */
function importImages(root, version, sources) {
  const dest = path.join(root, 'releases', `v${version}`, 'images');
  fs.mkdirSync(dest, { recursive: true });
  const files = [];
  for (const s of sources) {
    const abs = path.resolve(s);
    if (!fs.existsSync(abs)) fail(`Image path not found: ${s}`);
    if (fs.statSync(abs).isDirectory()) {
      for (const n of fs.readdirSync(abs).sort()) if (IMAGE_EXT.has(path.extname(n).toLowerCase())) files.push(path.join(abs, n));
    } else if (IMAGE_EXT.has(path.extname(abs).toLowerCase())) files.push(abs);
    else fail(`Not a supported image type: ${s} (use ${[...IMAGE_EXT].join(' ')})`);
  }
  const out = [];
  for (const f of files) {
    let name = safeName(path.basename(f));
    const { name: base, ext } = path.parse(name);
    let n = 2, target = path.join(dest, name);
    while (fs.existsSync(target) && !fs.readFileSync(target).equals(fs.readFileSync(f))) { name = `${base}-${n++}${ext}`; target = path.join(dest, name); }
    fs.copyFileSync(f, target);
    out.push({ from: path.basename(f), to: `images/${name}`, info: readImageInfo(target), bytes: fs.statSync(target).size });
  }
  return out;
}
function printImported(list) {
  if (!list.length) return console.log('  (no images imported)');
  for (const i of list) {
    const dims = i.info ? `${i.info.w}x${i.info.h}, ` : '';
    console.log(`  ${i.from} -> ${i.to}  (${dims}${formatBytes(i.bytes)})${i.bytes > 1048576 ? '  large: consider WebP' : ''}`);
  }
}

/* ---------- releases.json editing (authored fields only; build refreshes derived) ---------- */
function readIndex(root) {
  const project = loadProject(root);
  if (!project.data) { printReport(project.report, root); fail('releases.json could not be read.'); }
  return project;
}
const saveIndex = (root, data) => writeIfChanged(path.join(root, 'releases.json'), `${JSON.stringify(data, null, 2)}\n`);

/* ---------- commands ---------- */
function cmdNew(argv) {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    date: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, type: { type: 'string' }, status: { type: 'string' },
    featured: { type: 'boolean' }, sample: { type: 'boolean' }, tags: { type: 'string' }, images: { type: 'string', multiple: true }, root: { type: 'string' } } });
  const root = path.resolve(v.root ?? DEFAULT_ROOT);
  const version = normalizeVersion(positionals[0]);
  if (!SEMVER.test(version)) fail('Give a semantic version, e.g.  node tools/rn.mjs new 2.43.0 --title "..." --summary "..."');
  const status = v.status ?? 'published';
  if (!STATUSES.includes(status)) fail(`--status must be ${STATUSES.join(' or ')}.`);
  const type = v.type ?? typeFromVersion(version);
  if (!(type in TYPES)) fail(`--type must be ${Object.keys(TYPES).join(', ')}.`);
  const date = v.date ?? todayIso();
  if (!isIsoDate(date)) fail('--date must be a real date as YYYY-MM-DD.');
  if (!v.title?.trim()) fail('--title is required (the release headline).');
  if (!v.summary?.trim() && status === 'published') fail('--summary is required for a published release (one or two sentences).');

  const project = readIndex(root);
  if (project.data.releases.some((r) => r.version === version)) fail(`Version ${version} already exists in releases.json. Versions must be unique.`);
  const dir = path.join(root, 'releases', `v${version}`);
  if (fs.existsSync(dir)) fail(`${path.relative(root, dir)} already exists. Refusing to touch it.`);

  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  const imported = importImages(root, version, v.images ?? []);
  fs.writeFileSync(path.join(dir, 'content.json'), `${JSON.stringify({ overview: [], items: [] }, null, 2)}\n`);
  const entry = { version, date, type, status, featured: v.featured === true, ...(v.sample ? { sample: true } : {}), title: v.title.trim(),
    ...(v.summary ? { summary: v.summary.trim() } : {}), ...(v.tags ? { tags: v.tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}) };
  project.data.releases.push(serializeEntry(entry));
  project.data.releases.sort(releaseOrder);
  saveIndex(root, project.data);

  console.log(`Created releases/v${version}/ (${status}, ${type}, ${date})`);
  console.log('Images:'); printImported(imported);
  console.log(`\nNext: write releases/v${version}/content.json, then run  node tools/rn.mjs build`);
  return 0;
}

function cmdImages(argv) {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { root: { type: 'string' } } });
  const root = path.resolve(v.root ?? DEFAULT_ROOT);
  const version = normalizeVersion(positionals[0]);
  const project = readIndex(root);
  if (!project.data.releases.some((r) => r.version === version)) fail(`Version ${version} is not in releases.json. Create it first with "new".`);
  if (positionals.length < 2) fail('Give at least one image file or folder.');
  console.log(`Images for v${version}:`); printImported(importImages(root, version, positionals.slice(1)));
  return 0;
}

function cmdBuild(argv) {
  const { values: v } = parseArgs({ args: argv, options: { root: { type: 'string' } } });
  const root = path.resolve(v.root ?? DEFAULT_ROOT);
  const { project, written } = runBuild(root, { write: true });
  const code = finish(project.report, root);
  if (code === 0) {
    const pages = written.filter((f) => /^releases\/v.*\/index\.html$/.test(f)).length;
    console.log(`Build OK. ${project.releases.length} releases. Wrote ${written.length} file${written.length === 1 ? '' : 's'}${written.length ? ` (${pages} release page${pages === 1 ? '' : 's'})` : ' (everything was already up to date)'}.`);
    for (const f of written) console.log(`  updated ${f}`);
  } else console.log('Build FAILED: fix the errors above. Nothing was written.');
  return code;
}

function cmdValidate(argv) {
  const { values: v } = parseArgs({ args: argv, options: { strict: { type: 'boolean' }, root: { type: 'string' } } });
  const root = path.resolve(v.root ?? DEFAULT_ROOT);
  const { project, stale } = runBuild(root, { write: false });
  for (const f of stale) project.report.err(f, 'generated file is out of date. Run: node tools/rn.mjs build');
  return finish(project.report, root, { strict: v.strict });
}

function cmdPublish(argv) {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { root: { type: 'string' } } });
  const root = path.resolve(v.root ?? DEFAULT_ROOT);
  const version = normalizeVersion(positionals[0]);
  const project = readIndex(root);
  const entry = project.data.releases.find((r) => r.version === version);
  if (!entry) fail(`Version ${version} is not in releases.json.`);
  if (entry.status === 'published') { console.log(`v${version} is already published.`); return 0; }
  entry.status = 'published';
  const original = fs.readFileSync(path.join(root, 'releases.json'), 'utf8');
  saveIndex(root, project.data);
  const { project: p2 } = runBuild(root, { write: true });
  if (p2.report.errors.length) { fs.writeFileSync(path.join(root, 'releases.json'), original); printReport(p2.report, root); fail(`v${version} cannot be published yet. releases.json was left unchanged.`); }
  console.log(`v${version} is now published. Commit and push to deploy.`);
  return 0;
}

function cmdList(argv) {
  const { values: v } = parseArgs({ args: argv, options: { root: { type: 'string' } } });
  const project = readIndex(path.resolve(v.root ?? DEFAULT_ROOT));
  for (const r of sortedRecords(project)) {
    const e = r.entry;
    const flags = [e.status === 'draft' ? 'DRAFT' : '', e.featured ? 'featured' : '', e.sample ? 'sample' : ''].filter(Boolean).join(',');
    console.log(`${('v' + e.version).padEnd(9)} ${e.date}  ${e.type.padEnd(5)} ${flags.padEnd(16)} ${e.title}`);
  }
  return 0;
}

function cmdStage(argv) {
  const { values: v } = parseArgs({ args: argv, options: { out: { type: 'string' }, root: { type: 'string' } } });
  const root = path.resolve(v.root ?? DEFAULT_ROOT);
  const { project, files, stale } = runBuild(root, { write: false });
  for (const f of stale) project.report.err(f, 'generated file is out of date. Run: node tools/rn.mjs build');
  if (finish(project.report, root)) { console.log('Not staging: fix the errors above.'); return 1; }
  const res = stage(project, files, v.out ?? path.join(root, '_site'));
  console.log(`Staged ${res.published} published release${res.published === 1 ? '' : 's'} into ${res.out} (${res.excluded} draft/other excluded).`);
  return 0;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.woff2': 'font/woff2', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon' };

function cmdServe(argv) {
  const { values: v } = parseArgs({ args: argv, options: { port: { type: 'string' }, root: { type: 'string' } } });
  const root = path.resolve(v.root ?? DEFAULT_ROOT);
  const port = Number(v.port ?? 5211);
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end('Bad request'); return; }
    let file = path.join(root, rel);
    if (path.relative(root, file).startsWith('..')) { res.writeHead(403).end('Forbidden'); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!rel.endsWith('/')) { res.writeHead(301, { Location: `${rel}/${new URL(req.url, 'http://x').search}` }).end(); return; }
      file = path.join(file, 'index.html');
    }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`404 Not found: ${rel}`); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(buf);
    });
  });
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use. Try --port ${port + 1}.` : e.message); process.exit(1); });
  server.listen(port, '127.0.0.1', () => console.log(`Serving ${root}\n  http://localhost:${port}/\n  add ?drafts=1 to preview drafts. Ctrl+C to stop.`));
  return null; // keep running
}

const COMMANDS = { new: cmdNew, images: cmdImages, build: cmdBuild, validate: cmdValidate, publish: cmdPublish, list: cmdList, stage: cmdStage, serve: cmdServe };
const [cmd, ...rest] = process.argv.slice(2);
if (!COMMANDS[cmd]) { console.log(`RevGen-i release notes tool\n\n${HELP}`); process.exit(cmd ? 1 : 0); }
try {
  const code = COMMANDS[cmd](rest);
  if (code !== null) process.exit(code);
} catch (e) {
  if (e instanceof UserError) { console.error(`Error: ${e.message}`); process.exit(1); }
  if (e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') { console.error(`Error: ${e.message}`); process.exit(1); }
  throw e;
}
