// Turns a release (releases.json entry + content.json) into a static HTML page using templates/release.html.
// Output depends only on that release's own data, never on its neighbours, so adding a release never
// changes another release's page. (Previous/next links are filled in by assets/js/release.js.)
import { CATEGORIES, TYPES, esc, formatDate, inline, plain } from './util.mjs';
import { itemId } from './model.mjs';

const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
const SECTIONS = [
  { id: 'new-features', title: 'New Features', cats: ['new-feature'] },
  { id: 'enhancements-improvements', title: 'Enhancements & Improvements', cats: ['enhancement', 'improvement'] },
  { id: 'bug-fixes', title: 'Bug Fixes', cats: ['bug-fix'] },
];
const SECTION_OF = Object.fromEntries(SECTIONS.flatMap((s) => s.cats.map((c) => [c, s.id])));

/** Replace {{tokens}} in one pass, so inserted content is never re-scanned. */
export const fill = (template, values) => template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in values ? values[k] : m));

/** Keep shared regions (<!--@name-->...<!--/@name-->) identical in every page, from templates/partials/<name>.html. */
export function syncRegions(html, partials, root) {
  return html.replace(/<!--@(\w+)-->[\s\S]*?<!--\/@\1-->/g, (m, name) => {
    if (!(name in partials)) return m;
    return `<!--@${name}-->\n${partials[name].replaceAll('{{root}}', root).trim()}\n<!--/@${name}-->`;
  });
}

const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const isExternal = (u) => /^https?:\/\//i.test(u);
const encodeSrc = (src) => encodeURI(src);

/* ---------- blocks ---------- */
function figure(img, ctx) {
  const info = ctx.project.imageInfo.get(`${ctx.rec.dir}/${img.src}`);
  const dim = info ? ` width="${info.w}" height="${info.h}"` : '';
  const cap = img.caption ? `<figcaption>${inline(img.caption)}</figcaption>` : '';
  const alt = img.decorative === true ? '' : img.alt;
  return `<figure class="shot"><a class="shot-link" href="${esc(encodeSrc(img.src))}" data-lightbox data-caption="${esc(plain(img.caption || ''))}">` +
    `<img src="${esc(encodeSrc(img.src))}" alt="${esc(alt)}"${dim} loading="lazy" decoding="async">` +
    `<span class="shot-zoom" aria-hidden="true">Enlarge</span><span class="sr"> (opens enlarged image)</span></a>${cap}</figure>`;
}
const gallery = (images, ctx) => `<div class="gallery gallery-${Math.min(images.length, 3)}">${images.map((i) => figure(i, ctx)).join('')}</div>`;
const callout = (text, tone = 'note') =>
  `<aside class="callout callout-${tone}"><span class="callout-label">${tone === 'important' ? 'Important' : 'Note'}</span><p>${inline(text)}</p></aside>`;

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

function item(it, ctx) {
  const id = itemId(it);
  const cat = CAT[it.category];
  const body = (it.body ?? []).map((b) => block(b, ctx, id)).join('');
  const links = it.links?.length ? `<p class="item-links">${it.links.map(linkButton).join('')}</p>` : '';
  const aud = (it.audience ?? []).map((a) => `<span class="chip aud"><span class="sr">For </span>${esc(a)}</span>`).join('');
  return `<article class="item${body || links ? '' : ' item-compact'}" id="${id}">` +
    `<header class="item-head"><div class="item-tags"><span class="chip cat-${cat.id}">${cat.label}</span>` +
    (it.module ? `<span class="item-module">${esc(it.module)}</span>` : '') + aud + `</div>` +
    `<h3 class="d"><a class="anchor" href="#${id}">${esc(it.title)}</a></h3></header>` +
    (it.summary ? `<p class="item-summary">${inline(it.summary)}</p>` : '') +
    (body ? `<div class="blocks">${body}</div>` : '') + links + `</article>`;
}

/* ---------- page ---------- */
export function renderReleasePage({ project, rec, template, partials }) {
  const { entry, content } = rec;
  const root = '../../';
  const product = project.data.product || 'RevGen-i';
  const site = project.data.site ?? {};
  const url = site.url ? `${site.url}releases/v${entry.version}/` : '';
  const items = content.items;
  const overview = asList(content.overview);
  const draft = entry.status === 'draft';
  const noindex = draft || site.noindex === true;

  const sections = SECTIONS.map((s) => ({ ...s, items: items.filter((i) => s.cats.includes(i.category)) })).filter((s) => s.items.length);
  const counts = CATEGORIES.map((c) => ({ ...c, n: items.filter((i) => i.category === c.id).length })).filter((c) => c.n);

  const chips = [
    `<span class="chip type-${entry.type}">${TYPES[entry.type]}</span>`,
    entry.featured ? '<span class="chip featured"><span aria-hidden="true">&#9733;</span> Featured</span>' : '',
    draft ? '<span class="chip draft">Draft</span>' : '',
    entry.sample ? '<span class="chip sample">Sample</span>' : '',
  ].join('');

  const banner = draft
    ? '<div class="banner banner-draft" role="note"><strong>Draft.</strong> This release is not published. It is only visible in a local preview and is excluded from the deployed site.</div>'
    : entry.sample ? '<div class="banner banner-sample" role="note"><strong>Sample release.</strong> This page holds illustrative content to show how the portal looks. It is not a real RevGen-i release.</div>' : '';

  const tiles = counts.length
    ? `<ul class="rel-counts" aria-label="Changes in this release">${counts.map((c) =>
      `<li><a class="count-tile cat-${c.id}" href="#${SECTION_OF[c.id]}"><span class="count-n">${c.n}</span><span class="count-l">${c.n === 1 ? c.label : c.plural}</span></a></li>`).join('')}</ul>` : '';

  const toc = `<details class="toc" open><summary>On this page</summary><nav aria-label="On this page"><ol>` +
    (overview.length ? '<li><a href="#overview">Overview</a></li>' : '') +
    sections.map((s) => `<li><a href="#${s.id}">${s.title}</a><ol>${s.items.map((i) => `<li><a href="#${itemId(i)}">${esc(i.title)}</a></li>`).join('')}</ol></li>`).join('') +
    `</ol></nav></details>`;

  const ctx = { project, rec };
  const main = `<main id="main" class="rel" data-version="${entry.version}" data-status="${entry.status}"><div class="wrap">
<nav class="crumbs" aria-label="Breadcrumb"><a href="${root}">Release notes</a><span aria-hidden="true">&#8250;</span><a href="${root}releases/">All releases</a><span aria-hidden="true">&#8250;</span><span aria-current="page">v${entry.version}</span></nav>
${banner}
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

  const desc = plain(entry.summary || '');
  const cover = rec.derived?.cover;
  const meta = [
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="${esc(product)} Release Notes">`,
    `<meta property="og:title" content="${esc(`${product} v${entry.version}: ${entry.title}`)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta name="twitter:card" content="${cover && site.url ? 'summary_large_image' : 'summary'}">`,
    url ? `<link rel="canonical" href="${esc(url)}">\n<meta property="og:url" content="${esc(url)}">` : '',
    cover && site.url ? `<meta property="og:image" content="${esc(site.url + cover.src)}">` : '',
    noindex ? '<meta name="robots" content="noindex, nofollow">' : '',
  ].filter(Boolean).join('\n');

  const ld = {
    '@context': 'https://schema.org', '@type': 'TechArticle',
    headline: `${product} v${entry.version}: ${entry.title}`, description: desc,
    datePublished: entry.date, dateModified: entry.date, inLanguage: 'en',
    about: { '@type': 'SoftwareApplication', name: product, softwareVersion: entry.version },
    ...(url ? { mainEntityOfPage: url } : {}),
  };
  const jsonld = `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;

  const html = fill(template, {
    root, version: entry.version, status: entry.status,
    title: esc(`v${entry.version}: ${entry.title} · ${product} Release Notes`),
    description: esc(desc), meta, jsonld, main,
  });
  return syncRegions(html, partials, root);
}

/* ---------- crawler files (only when site.url is configured) ---------- */
export function renderSitemap(site, published) {
  const rows = [{ loc: site.url, lastmod: published[0]?.entry.date }, { loc: `${site.url}releases/`, lastmod: published[0]?.entry.date },
    ...published.map((r) => ({ loc: `${site.url}releases/v${r.version}/`, lastmod: r.entry.date }))];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.map((r) =>
    `  <url><loc>${esc(r.loc)}</loc>${r.lastmod ? `<lastmod>${r.lastmod}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`;
}
export const renderRobots = (site) =>
  site.noindex ? 'User-agent: *\nDisallow: /\n' : `User-agent: *\nAllow: /\n\nSitemap: ${site.url}sitemap.xml\n`;
