// The interactive walkthrough viewer: a full-screen native <dialog> that steps through a release, feature by feature and section by
// section, with the screenshots and explanations from its content.json. Loaded only when someone clicks "Interactive walkthrough"
// (common.js: RN.openWalkthrough), so pages load exactly as before. The slides themselves come from walkthrough.mjs (pure, tested).
// Nothing here runs a script from the content or writes an inline style: slides are escaped HTML from render-shared.mjs, and the
// progress bar width is set through the CSSOM (allowed by the page CSP; inline style attributes are not).
import { esc, plain } from './render-shared.mjs';
import { buildWalkthrough, renderIntro, renderStop, stopLabel } from './walkthrough.mjs';

const PLAY_MS = 8000; // how long auto-play stays on one stop
const make = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

/** Label of a stop in the outline and the jump list, when its feature has several: "1. Title", "2. Title". */
function numbered(s, g) {
  const t = plain(s.title || '');
  if (s.kind === 'section') return `${s.n}. ${t || `Section ${s.n}`}`;
  if (s.kind === 'step') return `${s.n}. ${t || `Step ${s.n}`}`;
  return t || g.title;
}

/** The outline: the introduction, then each feature (its stops listed under it when it has more than one). Buttons carry the slide number. */
function outline(w) {
  let k = 1, html = '<li><button type="button" class="wt-go" data-i="0">Release overview</button></li>';
  for (const g of w.groups) {
    if (g.stops.length === 1) {
      html += `<li><button type="button" class="wt-go wt-go-g" data-i="${k}"><span class="wt-gl">${esc(g.label)}</span>${esc(g.title)}</button></li>`;
      k += 1;
      continue;
    }
    html += `<li class="wt-grp"><p class="wt-g"><span class="wt-gl">${esc(g.label)}</span>${esc(g.title)}</p><ol>`;
    for (const s of g.stops) { html += `<li><button type="button" class="wt-go" data-i="${k}">${esc(numbered(s, g))}</button></li>`; k += 1; }
    html += '</ol></li>';
  }
  return `<ol class="wt-list">${html}</ol>`;
}

/** The same list for small screens, where there is no room for the outline. */
function jumpList(w) {
  let k = 1, html = '<option value="0">Release overview</option>';
  for (const g of w.groups) {
    html += `<optgroup label="${esc(`${g.label}: ${g.title}`)}">`;
    for (const s of g.stops) { html += `<option value="${k}">${esc(g.stops.length === 1 ? g.title : numbered(s, g))}</option>`; k += 1; }
    html += '</optgroup>';
  }
  return html;
}

/**
 * Open the walkthrough of one release. entry = its releases.json entry, siteRoot = absolute URL of the site root (with a trailing
 * slash). start = the slide to open on (0 = the introduction). hash: keep "#walkthrough-N" in the address bar so the view can be shared.
 * Returns {dialog, ready}; ready resolves once the content has loaded (or failed, in which case the dialog says so).
 */
export function openWalkthrough({ entry, siteRoot, start = 0, hash = false, onClose } = {}) {
  const base = `${siteRoot}releases/v${encodeURIComponent(entry.version)}/`;
  const dlg = make('dialog', 'wt');
  dlg.setAttribute('aria-label', `Interactive walkthrough of version ${entry.version}`);
  dlg.innerHTML = `<header class="wt-top"><div class="wt-id"><span class="wt-ver">v${esc(entry.version)}</span><span class="wt-name">${esc(entry.title)}</span></div>` +
    '<span class="wt-count" aria-hidden="true"></span>' +
    '<button class="btn btn-outline btn-sm wt-play" type="button" aria-pressed="false" hidden>Auto-play</button>' +
    '<button class="btn btn-outline btn-sm wt-close" type="button">Close <kbd>Esc</kbd></button></header>' +
    '<div class="wt-prog" aria-hidden="true"><i></i></div>' +
    '<div class="wt-main"><nav class="wt-rail" aria-label="Walkthrough outline" hidden></nav>' +
    '<div class="wt-stage" tabindex="-1"><p class="wt-load">Loading the walkthrough…</p></div></div>' +
    '<footer class="wt-foot"><button class="btn btn-outline wt-prev" type="button" disabled>&#8592; Back</button>' +
    '<label class="wt-jumpl"><span class="sr">Jump to a stop</span><select class="wt-jump" hidden></select></label>' +
    '<p class="wt-keys" hidden>Use <kbd>&#8592;</kbd> <kbd>&#8594;</kbd> to move between stops</p>' +
    '<button class="btn btn-primary wt-next" type="button" disabled autofocus>Next &#8594;</button></footer>' +
    '<p class="sr wt-live" role="status"></p>';
  const $ = (s) => dlg.querySelector(s);
  const stage = $('.wt-stage'), rail = $('.wt-rail'), prev = $('.wt-prev'), next = $('.wt-next'), jump = $('.wt-jump'), keys = $('.wt-keys');
  const play = $('.wt-play'), count = $('.wt-count'), fill = $('.wt-prog i'), live = $('.wt-live');
  let w = null, total = 0, cur = 0, playing = false, timer = 0, zoom = null;
  const slides = [], preloaded = new Set();

  /* ---------- the slides ---------- */
  const slideHtml = (i) => slides[i] ?? (slides[i] = i === 0 ? renderIntro(w) : renderStop(w, i - 1, { imgBase: base }));
  function preload(i) { // fetch the next slide's screenshots while this one is being read
    if (i > total || preloaded.has(i)) return;
    preloaded.add(i);
    const t = make('template', '', slideHtml(i)); // a template's images are inert: only their addresses are read
    t.content.querySelectorAll('img').forEach((img) => { const pre = new Image(); pre.src = img.getAttribute('src'); });
  }
  const labelOf = (i) => { if (i === 0) return 'Introduction'; const s = w.stops[i - 1], g = w.groups[s.gi]; return s.title ? `${g.title}, ${plain(s.title)}` : g.title; };

  function go(i) {
    if (!w) return;
    cur = Math.max(0, Math.min(total, i));
    stage.innerHTML = slideHtml(cur);
    stage.scrollTop = 0;
    rail.querySelectorAll('[data-i]').forEach((b) => { if (Number(b.dataset.i) === cur) { b.setAttribute('aria-current', 'step'); if (rail.offsetParent) b.scrollIntoView({ block: 'nearest' }); } else b.removeAttribute('aria-current'); });
    jump.value = String(cur);
    count.textContent = cur === 0 ? 'Introduction' : `${cur} of ${total}`;
    fill.style.width = `${total ? Math.round((cur / total) * 100) : 100}%`;
    prev.disabled = cur === 0;
    next.innerHTML = cur >= total ? 'Done' : 'Next &#8594;';
    live.textContent = cur === 0 ? 'Introduction' : `Stop ${cur} of ${total}: ${labelOf(cur)}`;
    preload(cur + 1);
    if (hash) history.replaceState(null, '', `${location.pathname}${location.search}#walkthrough${cur ? `-${cur}` : ''}`);
    if (playing) schedule();
  }

  /* ---------- auto-play (off until asked for; pauses while a screenshot is enlarged) ---------- */
  function stopPlay() { playing = false; clearTimeout(timer); play.setAttribute('aria-pressed', 'false'); }
  function schedule() {
    clearTimeout(timer);
    if (!playing) return;
    if (cur >= total) { stopPlay(); return; }
    timer = setTimeout(() => (zoom && zoom.open ? schedule() : go(cur + 1)), PLAY_MS);
  }
  play.addEventListener('click', () => {
    if (playing) { stopPlay(); return; }
    playing = true; play.setAttribute('aria-pressed', 'true');
    if (cur >= total) go(0); else schedule();
  });

  /* ---------- controls ---------- */
  prev.addEventListener('click', () => go(cur - 1));
  next.addEventListener('click', () => (cur >= total ? dlg.close() : go(cur + 1)));
  $('.wt-close').addEventListener('click', () => dlg.close());
  rail.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) go(Number(b.dataset.i)); });
  jump.addEventListener('change', () => go(Number(jump.value)));
  dlg.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !w) return;
    if (e.target.closest && (e.target.closest('.wt-zoom') || e.target.closest('select'))) return; // the viewer and the list use the arrow keys themselves
    if (e.key === 'ArrowRight') { e.preventDefault(); go(cur + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(cur - 1); }
  });
  dlg.addEventListener('close', () => {
    stopPlay();
    if (hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
    dlg.remove();
    if (onClose) onClose();
  });

  /* ---------- enlarge a screenshot (same look as the release page's viewer; it cannot be reused because it only knows the page's own images) ---------- */
  function shots() { return [...stage.querySelectorAll('a[data-lightbox]')]; }
  function enlarge(index) {
    const list = shots();
    if (!list.length) return;
    if (!zoom) {
      zoom = make('dialog', 'lb wt-zoom',
        '<div class="lb-bar"><span class="lb-count" aria-live="polite"></span><span class="lb-cap"></span><button class="btn btn-light btn-sm lb-close" type="button">Close <kbd>Esc</kbd></button></div>' +
        '<div class="lb-stage"><button class="lb-nav prev" type="button" aria-label="Previous screenshot">&#8249;</button><div class="lb-scroll"><img alt=""></div>' +
        '<button class="lb-nav next" type="button" aria-label="Next screenshot">&#8250;</button></div>' +
        '<p class="lb-foot">Click the image to switch between fit and full size. Use the arrow keys to move between screenshots.</p>');
      zoom.setAttribute('aria-label', 'Screenshot viewer');
      dlg.appendChild(zoom);
      const zi = zoom.querySelector('img'), zs = zoom.querySelector('.lb-scroll');
      let at = 0;
      const show = (n) => {
        const l = shots(); if (!l.length) return;
        at = (n + l.length) % l.length;
        const a = l[at], thumb = a.querySelector('img');
        zs.classList.remove('zoomed');
        zi.src = a.getAttribute('href'); zi.alt = thumb ? thumb.alt : '';
        zoom.querySelector('.lb-cap').textContent = a.dataset.caption || (thumb ? thumb.alt : '');
        zoom.querySelector('.lb-count').textContent = `${at + 1} / ${l.length}`;
        zoom.querySelector('.prev').hidden = zoom.querySelector('.next').hidden = l.length < 2;
        zs.scrollTo(0, 0);
      };
      zoom.show = show;
      zoom.querySelector('.prev').addEventListener('click', () => show(at - 1));
      zoom.querySelector('.next').addEventListener('click', () => show(at + 1));
      zoom.querySelector('.lb-close').addEventListener('click', () => zoom.close());
      zi.addEventListener('click', () => zs.classList.toggle('zoomed'));
      zoom.addEventListener('click', (e) => { if (e.target === zoom) zoom.close(); });
      zoom.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); show(at - 1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); show(at + 1); }
      });
      zoom.addEventListener('close', () => zi.removeAttribute('src'));
    }
    zoom.show(index);
    zoom.showModal();
  }
  stage.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[data-lightbox]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return; // let people open the file in a new tab
    e.preventDefault();
    enlarge(shots().indexOf(a));
  });

  /* ---------- go ---------- */
  document.body.appendChild(dlg);
  dlg.showModal();
  const ready = fetch(`${base}content.json`, { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((content) => {
      w = buildWalkthrough({ entry, content });
      total = w.stops.length;
      rail.innerHTML = outline(w); rail.hidden = false;
      jump.innerHTML = jumpList(w); jump.hidden = false;
      keys.hidden = false; play.hidden = total < 2;
      next.disabled = false;
      go(Math.max(0, Math.min(total, Number(start) || 0)));
      next.focus();
    })
    .catch(() => {
      stage.innerHTML = '<div class="wt-slide"><h2 class="wt-h">The walkthrough could not be loaded</h2><div class="wt-content"><div class="wt-text blocks"><p>Check your connection and try again. The full release notes are still on the page behind this window.</p></div></div></div>';
      live.textContent = 'The walkthrough could not be loaded.';
    });
  return { dialog: dlg, ready };
}
