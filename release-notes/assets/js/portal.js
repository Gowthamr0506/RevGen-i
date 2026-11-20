/* Landing page and archive. Everything is rendered from releases.json: adding a release never needs an HTML or CSS change. */
(function () {
  'use strict';
  const RN = window.RN;
  const { esc, fmtDate } = RN;
  const mode = document.body.dataset.mode; // "landing" | "archive"
  const $ = (s) => document.querySelector(s);
  const el = { q: $('#q'), year: $('#year'), featured: $('#featured'), cats: $('#cats'), count: $('#resultCount'), results: $('#results'),
    more: $('#more'), empty: $('#empty'), clear: $('#clear'), err: $('#loadError'), spot: $('#spotlight') };
  const PAGE = 6;
  const state = { q: '', year: '', cat: '', featured: false, shown: PAGE };
  let releases = [], latest = null, first = true;

  /* ---------- URL <-> state, so a filtered view can be shared ---------- */
  function readUrl() {
    const p = new URLSearchParams(location.search);
    state.q = p.get('q') || ''; state.year = p.get('year') || ''; state.cat = p.get('cat') || ''; state.featured = p.get('featured') === '1';
  }
  function writeUrl() {
    const p = new URLSearchParams(location.search);
    const set = (k, v) => (v ? p.set(k, v) : p.delete(k));
    set('q', state.q.trim()); set('year', state.year); set('cat', state.cat); set('featured', state.featured ? '1' : '');
    const qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }

  /* ---------- search ---------- */
  const href = (r) => RN.root + 'releases/v' + r.version + '/';
  const derived = (r) => r.derived || { categories: [], counts: {}, items: [] };
  function hay(r) {
    if (!r._hay) {
      const d = derived(r);
      r._hay = [r.version, 'v' + r.version, r.title, r.summary, (r.tags || []).join(' '), r.date, fmtDate(r.date), RN.TYPES[r.type],
        r.featured ? 'featured' : '', r.sample ? 'sample' : '', r.status === 'draft' ? 'draft' : '',
        d.items.map((i) => i.title + ' ' + (i.module || '')).join(' '), d.categories.map((c) => RN.catById(c).plural).join(' ')].join(' ').toLowerCase();
    }
    return r._hay;
  }
  const tokens = () => state.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (r, t) => (!state.year || r.date.slice(0, 4) === state.year) && (!state.cat || derived(r).categories.includes(state.cat))
    && (!state.featured || r.featured) && t.every((x) => hay(r).includes(x));

  /** When the search hit is inside a feature rather than the title/summary, say which features matched. */
  function matchNote(r, t) {
    if (!t.length) return '';
    const card = (r.title + ' ' + (r.summary || '')).toLowerCase();
    const extra = t.filter((x) => !card.includes(x));
    if (!extra.length) return '';
    const hits = derived(r).items.filter((i) => extra.some((x) => (i.title + ' ' + (i.module || '')).toLowerCase().includes(x)));
    if (!hits.length) return '';
    const shown = hits.slice(0, 2).map((i) => '<b>' + esc(i.title) + '</b>').join(', ');
    return '<p class="card-match">Also in this release: ' + shown + (hits.length > 2 ? ' and ' + (hits.length - 2) + ' more' : '') + '</p>';
  }

  /* ---------- markup ---------- */
  const catChip = (c, n) => { const m = RN.catById(c); return '<span class="chip cat-' + c + '">' + n + ' ' + (n === 1 ? m.label : m.plural) + '</span>'; };
  const catChips = (r) => derived(r).categories.map((c) => catChip(c, derived(r).counts[c])).join('');
  const flags = (r, dark) => '<span class="chip type-' + r.type + (dark ? ' on-dark' : '') + '">' + RN.TYPES[r.type] + '</span>'
    + (r.featured ? '<span class="chip featured' + (dark ? ' on-dark' : '') + '"><span aria-hidden="true">&#9733;</span> Featured</span>' : '')
    + (r.status === 'draft' ? '<span class="chip draft">Draft</span>' : '') + (r.sample ? '<span class="chip sample' + (dark ? ' on-dark' : '') + '">Sample</span>' : '');
  const linkText = (r) => esc(r.title) + '<span class="sr"> (version ' + esc(r.version) + ' release notes)</span>';

  function card(r, t, i) {
    return '<article class="card' + (first ? ' rv' : '') + '" data-i="' + (i % PAGE) + '">'
      + '<div class="card-top"><span class="card-ver">v' + esc(r.version) + '</span><time class="card-date" datetime="' + r.date + '">' + fmtDate(r.date) + '</time></div>'
      + '<div class="card-flags">' + flags(r) + '</div>'
      + '<h3><a href="' + href(r) + '">' + linkText(r) + '</a></h3>'
      + '<p class="card-sum">' + esc(r.summary || '') + '</p>' + matchNote(r, t)
      + '<div class="card-cats">' + catChips(r) + '</div>'
      + '<span class="card-go">View release notes <span class="arr" aria-hidden="true">&rarr;</span></span></article>';
  }
  function row(r) {
    return '<li class="row"><span class="row-ver">v' + esc(r.version) + '</span><time class="row-date" datetime="' + r.date + '">' + fmtDate(r.date) + '</time>'
      + '<div class="row-main"><h3><a href="' + href(r) + '">' + linkText(r) + '</a></h3><p>' + esc(r.summary || '') + '</p></div>'
      + '<div class="row-chips">' + flags(r) + catChips(r) + '</div><span class="row-arr" aria-hidden="true">&rarr;</span></li>';
  }
  function spotlight(r) {
    const d = derived(r), c = d.cover;
    const tiles = d.categories.map((id) => '<a class="spot-tile" href="' + href(r) + '#' + RN.catById(id).section + '"><b>' + d.counts[id] + '</b><span>'
      + (d.counts[id] === 1 ? RN.catById(id).label : RN.catById(id).plural) + '</span></a>').join('');
    const media = c ? '<div class="spot-media"><a class="spot-shot" href="' + href(r) + '" tabindex="-1" aria-hidden="true"><img src="' + esc(RN.root + c.src) + '" alt=""'
      + (c.w ? ' width="' + c.w + '" height="' + c.h + '"' : '') + ' decoding="async"></a></div>' : '';
    return '<article class="spot rv' + (c ? '' : ' no-media') + '"><div class="spot-main">'
      + '<div class="spot-top"><span class="chip latest"><i></i>Latest release</span>' + flags(r, true) + '</div>'
      + '<div><div class="spot-ver">v' + esc(r.version) + '</div><time class="spot-date" datetime="' + r.date + '">' + fmtDate(r.date) + '</time></div>'
      + '<h3>' + esc(r.title) + '</h3><p class="spot-sum">' + esc(r.summary || '') + '</p>'
      + (tiles ? '<div class="spot-tiles">' + tiles + '</div>' : '')
      + '<div class="spot-cta"><a class="btn btn-primary" href="' + href(r) + '">View release notes <span class="arr" aria-hidden="true">&rarr;</span></a>'
      + '<a class="btn btn-light" href="' + RN.root + 'releases/">Browse all releases</a></div></div>' + media + '</article>';
  }

  /* ---------- render ---------- */
  function describe(n, t, filtering, total) {
    if (!filtering && mode === 'landing') return 'Showing ' + Math.min(state.shown, total) + ' of ' + total + ' earlier release' + (total === 1 ? '' : 's');
    const bits = [n + ' release' + (n === 1 ? '' : 's')];
    if (t.length) bits.push('matching “' + state.q.trim() + '”');
    if (state.year) bits.push('in ' + state.year);
    if (state.cat) bits.push('with ' + RN.catById(state.cat).plural.toLowerCase());
    if (state.featured) bits.push('marked featured');
    return bits.join(' ');
  }
  function render() {
    const t = tokens();
    const filtering = !!(t.length || state.year || state.cat || state.featured);
    let list = releases.filter((r) => matches(r, t));
    if (mode === 'landing' && !filtering && latest) list = list.filter((r) => r !== latest); // the spotlight already shows it
    const total = list.length;
    const visible = mode === 'landing' ? list.slice(0, state.shown) : list;

    if (mode === 'landing') el.results.innerHTML = visible.map((r, i) => card(r, t, i)).join('');
    else {
      const groups = [];
      visible.forEach((r) => { const y = r.date.slice(0, 4); const g = groups[groups.length - 1]; if (g && g.y === y) g.items.push(r); else groups.push({ y, items: [r] }); });
      el.results.innerHTML = groups.map((g) => '<section aria-labelledby="y' + g.y + '"><div class="year-head"><h2 id="y' + g.y + '">' + g.y + '</h2><span>'
        + g.items.length + ' release' + (g.items.length === 1 ? '' : 's') + '</span></div><ul>' + g.items.map(row).join('') + '</ul></section>').join('');
    }
    first = false;
    RN.reveal(el.results);

    el.count.textContent = releases.length ? describe(total, t, filtering, total) : '';
    if (el.more) { const left = total - visible.length; el.more.hidden = left <= 0; el.more.textContent = 'Show ' + Math.min(PAGE, left) + ' more release' + (Math.min(PAGE, left) === 1 ? '' : 's'); }
    el.empty.hidden = !(releases.length && total === 0 && filtering);
    el.results.hidden = el.empty.hidden === false;
    if (!releases.length) el.count.textContent = 'No releases have been published yet.';
  }

  /* ---------- controls ---------- */
  function buildControls() {
    const years = [...new Set(releases.map((r) => r.date.slice(0, 4)))];
    el.year.insertAdjacentHTML('beforeend', years.map((y) => '<option value="' + y + '">' + y + '</option>').join(''));
    const count = (id) => releases.filter((r) => derived(r).categories.includes(id)).length;
    el.cats.innerHTML = [{ id: '', label: 'All releases', n: releases.length }].concat(RN.CATS.map((c) => ({ id: c.id, label: c.plural, n: count(c.id) })).filter((c) => c.n))
      .map((c) => '<button class="fchip" type="button" data-cat="' + c.id + '" aria-pressed="false">' + esc(c.label) + '<em>' + c.n + '</em></button>').join('');
    if (state.year && !years.includes(state.year)) state.year = '';
    if (state.cat && !RN.catById(state.cat)) state.cat = '';
    syncControls();
  }
  function syncControls() {
    el.q.value = state.q; el.year.value = state.year; el.featured.checked = state.featured;
    el.cats.querySelectorAll('.fchip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cat === state.cat)));
  }
  function update() { state.shown = PAGE; writeUrl(); render(); }
  let timer;
  el.q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = el.q.value; update(); }, 90); });
  el.q.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el.q.value) { el.q.value = ''; state.q = ''; update(); } });
  el.year.addEventListener('change', () => { state.year = el.year.value; update(); });
  el.featured.addEventListener('change', () => { state.featured = el.featured.checked; update(); });
  el.cats.addEventListener('click', (e) => { const b = e.target.closest('.fchip'); if (!b) return; state.cat = b.dataset.cat; syncControls(); update(); });
  el.clear.addEventListener('click', () => { Object.assign(state, { q: '', year: '', cat: '', featured: false }); syncControls(); update(); });
  if (el.more) el.more.addEventListener('click', () => { state.shown += PAGE; render(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !e.metaKey && !e.ctrlKey) {
      e.preventDefault(); el.q.focus(); el.q.select();
    }
  });

  /* ---------- go ---------- */
  readUrl();
  RN.loadReleases().then((res) => {
    releases = res.visible; latest = res.latest;
    if (el.spot) {
      el.spot.innerHTML = latest ? spotlight(latest) : '<div class="spot-empty">No releases have been published yet.</div>';
      RN.reveal(el.spot);
    }
    buildControls();
    render();
  }).catch((err) => {
    if (el.spot) el.spot.innerHTML = '';
    el.err.hidden = false;
    el.err.innerHTML = location.protocol === 'file:'
      ? '<p><strong>Open this page through a web server.</strong></p><p>Browsers block a page from reading <code>releases.json</code> when it is opened straight from disk. In the <code>release-notes</code> folder run <code>node tools/rn.mjs serve</code>, then open <code>http://localhost:5211/</code>. The published GitHub Pages site is not affected.</p>'
      : '<p><strong>The release list could not be loaded.</strong></p><p>' + esc(err.message) + '. Refresh the page to try again.</p>';
  });
})();
