// Turns a release (releases.json entry + content.json) into a static HTML page using templates/release.html.
// Output depends only on that release's own data, never on its neighbours, so adding a release never
// changes another release's page. (Previous/next links are filled in by assets/js/release.js.)
// The <main> markup itself comes from assets/js/render-shared.mjs, the same code the composer's preview runs.
import { esc, plain } from './util.mjs';
import { renderReleaseMain } from '../../assets/js/render-shared.mjs';

/** Replace {{tokens}} in one pass, so inserted content is never re-scanned. */
export const fill = (template, values) => template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in values ? values[k] : m));

/** Keep shared regions (<!--@name-->...<!--/@name-->) identical in every page, from templates/partials/<name>.html. */
export function syncRegions(html, partials, root) {
  return html.replace(/<!--@(\w+)-->[\s\S]*?<!--\/@\1-->/g, (m, name) => {
    if (!(name in partials)) return m;
    return `<!--@${name}-->\n${partials[name].replaceAll('{{root}}', root).trim()}\n<!--/@${name}-->`;
  });
}

/* ---------- page ---------- */
export function renderReleasePage({ project, rec, template, partials }) {
  const { entry, content } = rec;
  const root = '../../';
  const product = project.data.product || 'RevGen-i';
  const site = project.data.site ?? {};
  const url = site.url ? `${site.url}releases/v${entry.version}/` : '';
  const draft = entry.status === 'draft';
  const noindex = draft || site.noindex === true;

  const main = renderReleaseMain({ entry, content, root, imageInfo: (src) => project.imageInfo.get(`${rec.dir}/${src}`) });

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
  site.noindex ? 'User-agent: *\nDisallow: /\n'
    : `User-agent: *\nAllow: /\nDisallow: ${new URL(site.url).pathname}admin/\n\nSitemap: ${site.url}sitemap.xml\n`; // admin/ = the composer, never for search engines
