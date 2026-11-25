// The interactive walkthrough of a release, built from its content: an introduction, then every feature in turn, with one stop for
// each of its sections, each of its steps, or the feature itself when it has neither. Pure (no DOM, no network), so it runs in the
// browser (walkthrough-ui.mjs draws it) and in Node (the website build uses offersWalkthrough/countStops to mark releases that have
// one; tools/tests/composer.test.mjs tests it). Blocks are drawn by render-shared.mjs, so a stop looks like the release page.
import { CATEGORIES, SECTIONS, TYPES, categoryLabel, esc, formatDate, inline, itemId, plain, renderBlocks } from './render-shared.mjs';

const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const isMedia = (b) => b?.type === 'image' || b?.type === 'gallery';

/** A step of a "steps" block as ordinary blocks (its text, its screenshots, its note). */
function stepBlocks(s) {
  const out = asList(s?.text).map((t) => ({ type: 'p', text: t }));
  const imgs = s?.images ?? [];
  if (imgs.length > 1) out.push({ type: 'gallery', images: imgs });
  else if (imgs.length === 1) out.push({ type: 'image', ...imgs[0] });
  if (s?.note) out.push({ type: 'callout', tone: 'note', text: s.note });
  return out;
}

/** True if any of these blocks (looking inside sections and steps) shows a screenshot. */
export function hasImage(blocks) {
  return (blocks ?? []).some((b) => isMedia(b) || (b?.type === 'steps' && (b.items ?? []).some((s) => (s?.images ?? []).length)) || (b?.type === 'section' && hasImage(b.body)));
}

/** The tour as groups (one per feature) and a flat list of stops, in the order of the release page. */
function tour(content) {
  const items = (content?.items ?? []).filter((i) => CAT[i?.category]);
  const totals = {}, nums = new Map();
  for (const it of items) { totals[it.category] = (totals[it.category] ?? 0) + 1; nums.set(it, totals[it.category]); }
  const groups = [], stops = [];
  for (const sec of SECTIONS) {
    for (const it of items.filter((i) => sec.cats.includes(i.category))) {
      const g = {
        id: itemId(it), gi: groups.length, label: categoryLabel(it, totals, nums), category: it.category, title: it.title ?? '',
        summary: it.summary ?? '', module: it.module ?? '', audience: asList(it.audience), stops: [],
      };
      const mine = [], body = it.body ?? [], parts = body.filter((b) => b?.type === 'section').length;
      let loose = [], part = 0;
      // Loose blocks before/after the parts become a stop of their own, unless they are only headings (a lone "How to ..." line above
      // the steps has nothing under it to show; the stops below carry their own titles).
      const flush = (title) => { if (loose.some((b) => b.type !== 'heading')) mine.push({ kind: 'overview', title, blocks: loose }); loose = []; };
      for (const b of body) {
        if (b?.type === 'section') {
          flush('Overview'); part += 1;
          mine.push({ kind: 'section', title: b.title ?? '', n: part, of: parts, blocks: b.body ?? [] });
        } else if (b?.type === 'steps') {
          flush('Overview');
          (b.items ?? []).forEach((s, k, all) => mine.push({ kind: 'step', title: s?.title ?? '', n: k + 1, of: all.length, blocks: stepBlocks(s), audience: s?.audience, path: s?.path }));
        } else if (b) loose.push(b);
      }
      flush(mine.length ? 'More' : ''); // with no parts at all, the loose blocks are the feature's one stop and need no heading of their own
      if (!mine.length) mine.push({ kind: 'overview', title: '', blocks: [] });
      mine.forEach((s, si) => {
        const kicker = s.kind === 'section' ? (s.of > 1 || s.title ? `Section ${s.n} of ${s.of}` : '') : s.kind === 'step' ? `Step ${s.n} of ${s.of}` : '';
        const stop = { ...s, gi: g.gi, si, first: si === 0, kicker, id: `${g.id}-${si + 1}`, media: hasImage(s.blocks) };
        g.stops.push(stop); stops.push(stop);
      });
      groups.push(g);
    }
  }
  return { groups, stops, counts: CATEGORIES.map((c) => ({ label: totals[c.id] === 1 ? c.label : c.plural, n: totals[c.id] ?? 0 })).filter((c) => c.n), features: items.length };
}

/** The whole walkthrough: {intro, groups, stops}. entry = the release's releases.json entry. */
export function buildWalkthrough({ entry, content }) {
  const t = tour(content);
  return {
    intro: {
      title: entry?.title ?? '', version: entry?.version ?? '', date: entry?.date ? formatDate(entry.date) : '', type: entry?.type, typeLabel: TYPES[entry?.type] ?? '',
      summary: entry?.summary ?? '', overview: asList(content?.overview), counts: t.counts, features: t.features, steps: t.stops.length,
    },
    groups: t.groups, stops: t.stops,
  };
}

/** How many stops the walkthrough has (not counting the introduction). */
export const countStops = (content) => tour(content).stops.length;

/**
 * Does this release get an interactive walkthrough? Yes when it has something to walk through (a section, a step or a screenshot),
 * unless the release already links its own walkthrough page (the hand-built one on v2.42.0), which is better than a generated one.
 */
export function offersWalkthrough(content) {
  if (!content || typeof content !== 'object') return false;
  if ((content.links ?? []).some((l) => /walkthrough/i.test(String(l?.label ?? '')))) return false;
  const { stops } = tour(content);
  return stops.some((s) => s.kind === 'section' || s.kind === 'step' || s.media);
}

/* ------------------------------------------------------------------ drawing (HTML strings, everything escaped) */
/** The first slide: the release at a glance. */
export function renderIntro(w) {
  const i = w.intro;
  const chips = [i.typeLabel ? `<span class="chip type-${esc(i.type)}">${esc(i.typeLabel)}</span>` : '', ...i.counts.map((c) => `<span class="chip">${c.n} ${esc(c.label)}</span>`)].join('');
  return `<article class="wt-slide wt-intro"><header class="wt-head"><p class="wt-kicker"><span class="wt-ver">v${esc(i.version)}</span>${i.date ? `<span class="wt-pos">${esc(i.date)}</span>` : ''}</p>` +
    `<h2 class="wt-h">${esc(i.title)}</h2>${i.summary ? `<p class="wt-sum">${inline(i.summary)}</p>` : ''}</header>` +
    `<div class="wt-content"><div class="wt-text blocks">${i.overview.map((p) => `<p>${inline(p)}</p>`).join('')}` +
    `<p class="wt-chips">${chips}</p>` +
    `<p class="wt-hint">${i.steps} stop${i.steps === 1 ? '' : 's'} across ${i.features} feature${i.features === 1 ? '' : 's'}. Use the arrow keys, the buttons below, or pick a feature from the list.</p></div></div></article>`;
}

/**
 * One stop. imgBase = where this release's files live (screenshots are drawn from imgBase + "images/..."); imageInfo(src) gives
 * {w,h} so a screenshot reserves its space. Screenshots go in the media column, everything else in the text column.
 */
export function renderStop(w, i, { imgBase = '', imageInfo } = {}) {
  const s = w.stops[i], g = w.groups[s.gi];
  const imgSrc = (src) => `${imgBase}${encodeURI(src)}`, o = { imageInfo, imgSrc, idPrefix: `wt-${i + 1}` };
  const media = renderBlocks(s.blocks.filter(isMedia), o), text = renderBlocks(s.blocks.filter((b) => !isMedia(b)), o);
  const meta = [s.audience ? `For ${esc(s.audience)}` : '', s.path?.length ? `Menu: ${s.path.map(esc).join(' &#8250; ')}` : ''].filter(Boolean).join('<span class="wt-dot" aria-hidden="true"></span>');
  const aud = s.first && g.audience.length ? `<span class="wt-for">For ${g.audience.map(esc).join(', ')}</span>` : '';
  return `<article class="wt-slide"><header class="wt-head"><p class="wt-kicker"><span class="chip cat-${esc(g.category)}">${esc(g.label)}</span>` +
    `${s.kicker ? `<span class="wt-pos">${esc(s.kicker)}</span>` : ''}${g.module ? `<span class="wt-mod">${esc(g.module)}</span>` : ''}${aud}</p>` +
    `${s.title ? `<p class="wt-feature">${esc(g.title)}</p>` : ''}<h2 class="wt-h">${s.title ? inline(s.title) : esc(g.title)}</h2>` +
    `${s.first && g.summary ? `<p class="wt-sum">${inline(g.summary)}</p>` : ''}${meta ? `<p class="wt-meta">${meta}</p>` : ''}</header>` +
    `${media || text ? `<div class="wt-content${media ? ' has-media' : ''}">${media ? `<div class="wt-media">${media}</div>` : ''}${text ? `<div class="wt-text blocks">${text}</div>` : ''}</div>` : ''}</article>`;
}

/** The plain-text label of a stop, for the outline and the jump list. */
export const stopLabel = (s, g) => plain(s.title || g.title) || g.title;
