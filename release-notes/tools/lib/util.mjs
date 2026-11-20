// Shared helpers for the release-notes tooling. Zero dependencies (Node built-ins only).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ROOT = path.resolve(TOOLS_DIR, '..');

/** Release categories, in display order. `plural` is the section / filter label. */
export const CATEGORIES = [
  { id: 'new-feature', label: 'New feature', plural: 'New Features' },
  { id: 'enhancement', label: 'Enhancement', plural: 'Enhancements' },
  { id: 'improvement', label: 'Improvement', plural: 'Improvements' },
  { id: 'bug-fix', label: 'Bug fix', plural: 'Bug Fixes' },
];
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
export const TYPES = { major: 'Major release', minor: 'Minor release', patch: 'Patch release' };
export const STATUSES = ['published', 'draft'];
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const toPosix = (p) => p.split(path.sep).join('/');
export const norm = (s) => s.replace(/\r\n/g, '\n');

export function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); // tolerate BOMs from Windows editors
}

/** Write a file only when its content differs (CRLF-insensitive). Returns true when written. */
export function writeIfChanged(file, content) {
  const next = norm(content);
  if (fs.existsSync(file) && norm(readText(file)) === next) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  return true;
}

/* ---------- versions, dates ---------- */
export const normalizeVersion = (v) => String(v ?? '').trim().replace(/^v/i, '');
export const parseVersion = (v) => normalizeVersion(v).split('.').map(Number);
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
/** Newest first: by date, then by version. The same rule is used by the browser code. */
export const releaseOrder = (a, b) =>
  (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || compareVersions(b.version, a.version);
export function typeFromVersion(v) {
  const [, minor, patch] = parseVersion(v);
  return patch > 0 ? 'patch' : minor > 0 ? 'minor' : 'major';
}
export function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export const formatDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* ---------- text ---------- */
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const slugify = (s) =>
  String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

const SAFE_URL = /^(https?:\/\/|mailto:|#|\/|\.\/|\.\.\/|[A-Za-z0-9_-][^:]*$)/;
export const isSafeUrl = (u) => typeof u === 'string' && u.trim() !== '' && SAFE_URL.test(u.trim()) && !/^\s*(javascript|data|vbscript):/i.test(u);

/** Tiny inline formatter for content strings: `code`, **bold**, [label](url). Everything else is escaped. */
export function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (m, label, url) => {
    const raw = url.replace(/&amp;/g, '&');
    if (!isSafeUrl(raw)) return label;
    const external = /^https?:\/\//i.test(raw);
    return `<a href="${url}"${external ? ' rel="noopener noreferrer"' : ''}>${label}</a>`;
  });
  return s;
}
/** Plain-text version of inline markup (for attributes and search). */
export const plain = (text) =>
  String(text ?? '').replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\((?:[^()\s]|\([^()\s]*\))+\)/g, '$1');

/* ---------- filesystem checks that behave like GitHub Pages (Linux, case-sensitive) ---------- */
const dirCache = new Map();
export const clearFsCache = () => dirCache.clear();
function listDir(abs) {
  if (!dirCache.has(abs)) {
    try { dirCache.set(abs, new Set(fs.readdirSync(abs))); } catch { dirCache.set(abs, null); }
  }
  return dirCache.get(abs);
}
/** True only if every path segment below `root` exists with exactly this capitalisation. */
export function existsExact(root, rel) {
  let cur = root;
  for (const part of rel.split('/').filter(Boolean)) {
    const names = listDir(cur);
    if (!names || !names.has(part)) return false;
    cur = path.join(cur, part);
  }
  return true;
}
/** If the file exists under different capitalisation, return the real relative path (for a helpful error). */
export function findCaseInsensitive(root, rel) {
  let cur = root;
  const out = [];
  for (const part of rel.split('/').filter(Boolean)) {
    const names = listDir(cur);
    if (!names) return null;
    const hit = names.has(part) ? part : [...names].find((n) => n.toLowerCase() === part.toLowerCase());
    if (!hit) return null;
    out.push(hit);
    cur = path.join(cur, hit);
  }
  return out.join('/');
}

export function formatBytes(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
