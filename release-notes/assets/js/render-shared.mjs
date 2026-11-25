// The release-page renderer, shared by the website build (tools/lib/render.mjs, Node) and the composer's preview
// (admin/preview.mjs, browser). Pure functions only: no DOM, no Node built-ins, no network. Because both sides run this
// exact code, the preview is the page that will be published, not a lookalike.
// Output must stay byte-identical for unchanged content: tools/tests/rn.test.mjs checks the generated pages.

/** Release categories, in display order. `plural` is the section / filter label. */
export const CATEGORIES = [
  { id: 'new-feature', label: 'New feature', plural: 'New Features' },
  { id: 'enhancement', label: 'Enhancement', plural: 'Enhancements' },
  { id: 'improvement', label: 'Improvement', plural: 'Improvements' },
  { id: 'bug-fix', label: 'Bug fix', plural: 'Bug Fixes' },
];
export const TYPES = { major: 'Major release', minor: 'Minor release', patch: 'Patch release' };

/* ---------- text ---------- */
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const slugify = (s) =>
  String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

export const itemId = (item) => item.id || slugify(item.title || '');

export const formatDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

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

/* ---------- structure ---------- */
const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
export const SECTIONS = [
  { id: 'new-features', title: 'New Features', cats: ['new-feature'] },
  { id: 'enhancements-improvements', title: 'Enhancements & Improvements', cats: ['enhancement', 'improvement'] },
  { id: 'bug-fixes', title: 'Bug Fixes', cats: ['bug-fix'] },
];
const SECTION_OF = Object.fromEntries(SECTIONS.flatMap((s) => s.cats.map((c) => [c, s.id])));

const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const isExternal = (u) => /^https?:\/\//i.test(u);
const encodeSrc = (src) => encodeURI(src);

/* ---------- blocks ---------- */
// ctx = { imageInfo(src) -> {w,h} | undefined, imgSrc(src) -> url }
function figure(img, ctx) {
  const info = ctx.imageInfo(img.src);
  const dim = info ? ` width="${info.w}" height="${info.h}"` : '';
  const url = esc(ctx.imgSrc(img.src));
  const cap = img.caption ? `<figcaption>${inline(img.caption)}</figcaption>` : '';
  const alt = img.decorative === true ? '' : img.alt;
  return `<figure class="shot"><a class="shot-link" href="${url}" data-lightbox data-caption="${esc(plain(img.caption || ''))}">` +
    `<img src="${url}" alt="${esc(alt)}"${dim} loading="lazy" decoding="async">` +
    `<span class="shot-zoom" aria-hidden="true">Enlarge</span><span class="sr"> (opens enlarged image)</span></a>${cap}</figure>`;
}
const gallery = (images, ctx) => `<div class="gallery gallery-${Math.min(images.length, 3)}">${images.map((i) => figure(i, ctx)).join('')}</div>`;
const callout = (text, tone = 'note') => {
  const t = tone === 'important' ? 'important' : 'note'; // only the two known styles, whatever the content says
  return `<aside class="callout callout-${t}"><span class="callout-label">${t === 'important' ? 'Important' : 'Note'}</span><p>${inline(text)}</p></aside>`;
};

function linkButton(l) {
  const ext = isExternal(l.url);
  const glyph = l.kind === 'video' ? '<span class="btn-glyph" aria-hidden="true">&#9654;</span>' : '';
  return `<a class="btn btn-outline btn-sm" href="${esc(l.url)}"${ext ? ' rel="noopener noreferrer" target="_blank"' : ''}>${glyph}${esc(l.label)}${ext ? ' <span aria-hidden="true">&#8599;</span><span class="sr">(opens in a new tab)</span>' : ''}</a>`;
}

function steps(block, ctx, parentId) {
  const lis = block.items.map((s, i) => {
    const n = i + 1;
    const path = s.path?.length
      ? `<span class="path" aria-label="Menu path">${s.path.map(esc).join('<span class="sep" aria-hidden="true">&#8250;</span>')}</span>` : '';
    const aud = s.audience ? `<span class="chip aud"><span class="sr">For </span>${esc(s.audience)}</span>` : '';
    const imgs = s.images ?? [];
    return `<li class="step" id="${parentId}-step-${n}"><span class="step-n" aria-hidden="true">${n}</span><div class="step-main">` +
      `<h4 class="step-title">${inline(s.title)}</h4>` +
      (aud || path ? `<div class="step-meta">${aud}${path}</div>` : '') +
      asList(s.text).map((t) => `<p>${inline(t)}</p>`).join('') +
      (imgs.length > 1 ? gallery(imgs, ctx) : imgs.length === 1 ? figure(imgs[0], ctx) : '') +
      (s.note ? callout(s.note) : '') + `</div></li>`;
  });
  return `<ol class="steps">${lis.join('')}</ol>`;
}

/**
 * Draws a list of blocks (paragraphs, lists, screenshots, notes, steps) exactly as a release page does.
 * Used by the interactive walkthrough. idPrefix keeps the ids of steps unique when several slides are drawn.
 */
export function renderBlocks(blocks, { imageInfo = () => undefined, imgSrc = encodeSrc, idPrefix = 'wt' } = {}) {
  const ctx = { imageInfo, imgSrc, totals: {}, nums: new Map() };
  return (blocks ?? []).map((b) => block(b, ctx, idPrefix)).join('');
}

/** A numbered part of a feature (Section 1, Section 2, ...): its own text and screenshots. n = its number within the feature. */
function section(b, ctx, parentId, n) {
  const sid = `${parentId}-section-${n}`;
  const inner = (b.body ?? []).map((x) => block(x, ctx, sid)).join('');
  return `<section class="sub" id="${sid}" aria-labelledby="${sid}-h"><h4 class="sub-h" id="${sid}-h"><span class="sub-n">Section ${n}</span>` +
    `${b.title ? `<span class="sub-t">${inline(b.title)}</span>` : ''}</h4><div class="sub-body">${inner}</div></section>`;
}

function block(b, ctx, parentId) {
  switch (b.type) {
    case 'p': return `<p>${inline(b.text)}</p>`;
    case 'heading': return `<h4 class="block-h">${inline(b.text)}</h4>`;
    case 'list': { const tag = b.ordered ? 'ol' : 'ul'; return `<${tag} class="list">${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${tag}>`; }
    case 'image': return figure(b, ctx);
    case 'gallery': return gallery(b.images, ctx);
    case 'callout': return callout(b.text, b.tone);
    case 'steps': return steps(b, ctx, parentId);
    default: return '';
  }
}

/** "New feature 1", "New feature 2": a feature is numbered within its kind, but only when the release has several of that kind. */
export function categoryLabel(it, totals, nums) {
  const cat = CAT[it.category];
  return totals[it.category] > 1 ? `${cat.label} ${nums.get(it)}` : cat.label;
}

function item(it, ctx) {
  const id = itemId(it);
  const cat = CAT[it.category];
  let sec = 0;
  const body = (it.body ?? []).map((b) => (b.type === 'section' ? section(b, ctx, id, ++sec) : block(b, ctx, id))).join('');
  const links = it.links?.length ? `<p class="item-links">${it.links.map(linkButton).join('')}</p>` : '';
  const aud = (it.audience ?? []).map((a) => `<span class="chip aud"><span class="sr">For </span>${esc(a)}</span>`).join('');
  return `<article class="item${body || links ? '' : ' item-compact'}" id="${id}">` +
    `<header class="item-head"><div class="item-tags"><span class="chip cat-${cat.id}">${categoryLabel(it, ctx.totals, ctx.nums)}</span>` +
    (it.module ? `<span class="item-module">${esc(it.module)}</span>` : '') + aud + `</div>` +
    `<h3 class="d"><a class="anchor" href="#${id}">${esc(it.title)}</a></h3></header>` +
    (it.summary ? `<p class="item-summary">${inline(it.summary)}</p>` : '') +
    (body ? `<div class="blocks">${body}</div>` : '') + links + `</article>`;
}

/* ---------- the <main> of a release page ---------- */
/**
 * @param entry    the release's releases.json entry (version, date, type, status, featured, sample, title, summary)
 * @param content  the release's content.json (overview, links, items)
 * @param root     path from the page to the portal root ('../../' for a generated page)
 * @param imageInfo  (src) => {w,h} | undefined, so <img> gets its size (no layout shift); optional
 * @param imgSrc   (src) => url the browser should load for an image path; default: the path, URL-encoded
 * @param banner   optional HTML that replaces the draft/sample banner (the preview uses this)
 */
export function renderReleaseMain({ entry, content, root = '../../', imageInfo = () => undefined, imgSrc = encodeSrc, banner }) {
  const items = content.items;
  const overview = asList(content.overview);
  const draft = entry.status === 'draft';

  const sections = SECTIONS.map((s) => ({ ...s, items: items.filter((i) => s.cats.includes(i.category)) })).filter((s) => s.items.length);
  const counts = CATEGORIES.map((c) => ({ ...c, n: items.filter((i) => i.category === c.id).length })).filter((c) => c.n);

  const chips = [
    `<span class="chip type-${entry.type}">${TYPES[entry.type]}</span>`,
    entry.featured ? '<span class="chip featured"><span aria-hidden="true">&#9733;</span> Featured</span>' : '',
    draft ? '<span class="chip draft">Draft</span>' : '',
    entry.sample ? '<span class="chip sample">Sample</span>' : '',
  ].join('');

  const notice = banner ?? (draft
    ? '<div class="banner banner-draft" role="note"><strong>Draft.</strong> This release is not published. It is only visible in a local preview and is excluded from the deployed site.</div>'
    : entry.sample ? '<div class="banner banner-sample" role="note"><strong>Sample release.</strong> This page holds illustrative content to show how the portal looks. It is not a real RevGen-i release.</div>' : '');

  const tiles = counts.length
    ? `<ul class="rel-counts" aria-label="Changes in this release">${counts.map((c) =>
      `<li><a class="count-tile cat-${c.id}" href="#${SECTION_OF[c.id]}"><span class="count-n">${c.n}</span><span class="count-l">${c.n === 1 ? c.label : c.plural}</span></a></li>`).join('')}</ul>` : '';

  // the parts of a feature, listed under it in the contents
  const tocParts = (i) => {
    const parts = (i.body ?? []).filter((b) => b.type === 'section');
    return parts.length ? `<ol>${parts.map((s, k) => `<li><a href="#${itemId(i)}-section-${k + 1}">Section ${k + 1}${s.title ? `: ${esc(plain(s.title))}` : ''}</a></li>`).join('')}</ol>` : '';
  };
  const toc = `<details class="toc" open><summary>On this page</summary><nav aria-label="On this page"><ol>` +
    (overview.length ? '<li><a href="#overview">Overview</a></li>' : '') +
    sections.map((s) => `<li><a href="#${s.id}">${s.title}</a><ol>${s.items.map((i) => `<li><a href="#${itemId(i)}">${esc(i.title)}</a>${tocParts(i)}</li>`).join('')}</ol></li>`).join('') +
    `</ol></nav></details>`;

  const totals = {}, nums = new Map();
  for (const it of items) if (CAT[it.category]) { totals[it.category] = (totals[it.category] ?? 0) + 1; nums.set(it, totals[it.category]); }
  const ctx = { imageInfo, imgSrc, totals, nums };
  return `<main id="main" class="rel" data-version="${entry.version}" data-status="${entry.status}"><div class="wrap">
<nav class="crumbs" aria-label="Breadcrumb"><a href="${root}">Release notes</a><span aria-hidden="true">&#8250;</span><a href="${root}releases/">All releases</a><span aria-hidden="true">&#8250;</span><span aria-current="page">v${entry.version}</span></nav>
${notice}
<header class="rel-hero">
<div class="rel-meta"><span class="rel-ver">v${entry.version}</span><time datetime="${entry.date}">${formatDate(entry.date)}</time>${chips}</div>
<h1 class="d">${esc(entry.title)}</h1>
<p class="lead">${inline(entry.summary || '')}</p>
<div class="rel-actions">${(content.links ?? []).map(linkButton).join('')}<button class="btn btn-outline btn-sm" type="button" data-copy-link>Copy link</button></div>
${tiles}
</header>
<div class="rel-body">
${toc}
<div class="rel-content">
${overview.length ? `<section class="rel-section" id="overview" aria-labelledby="overview-h"><h2 id="overview-h" class="d">Overview</h2>${overview.map((p) => `<p class="overview-p">${inline(p)}</p>`).join('')}</section>` : ''}
${sections.map((s) => `<section class="rel-section" id="${s.id}" aria-labelledby="${s.id}-h"><h2 id="${s.id}-h" class="d">${s.title}<span class="count" aria-label="${s.items.length} items">${s.items.length}</span></h2>${s.items.map((i) => item(i, ctx)).join('\n')}</section>`).join('\n')}
${items.length ? '' : '<p class="empty-note">This release has no items yet.</p>'}
</div>
</div>
<nav class="pager" aria-label="Release navigation" data-pager><a class="pager-all" href="${root}releases/">&#8592; Back to all releases</a></nav>
</div></main>`;
}
