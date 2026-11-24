/* Shared helpers for every page. Classic script (not a module) so release pages keep working when opened from disk. */
(function () {
  'use strict';
  const body = document.body;
  const root = body.dataset.root || './';
  const CATS = [
    { id: 'new-feature', label: 'New feature', plural: 'New Features', section: 'new-features' },
    { id: 'enhancement', label: 'Enhancement', plural: 'Enhancements', section: 'enhancements-improvements' },
    { id: 'improvement', label: 'Improvement', plural: 'Improvements', section: 'enhancements-improvements' },
    { id: 'bug-fix', label: 'Bug fix', plural: 'Bug Fixes', section: 'bug-fixes' },
  ];
  const TYPES = { major: 'Major release', minor: 'Minor release', patch: 'Patch release' };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Drafts are only ever shown in a local preview: ?drafts=1, or when you are looking at a draft page itself.
  const includeDrafts = new URLSearchParams(location.search).get('drafts') === '1' || body.dataset.status === 'draft';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cmpVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  // Same ordering rule as tools/lib/util.mjs: newest date first, then highest version.
  const order = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || cmpVer(b.version, a.version);
  const fmtDate = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const catById = (id) => CATS.find((c) => c.id === id);

  function loadReleases() {
    return fetch(root + 'releases.json', { cache: 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((data) => {
        const all = (data.releases || []).slice().sort(order);
        return { data, all, visible: all.filter((r) => r.status === 'published' || includeDrafts), latest: all.find((r) => r.status === 'published') || null };
      });
  }

  /** Staggered fade-in for elements marked .rv (only used when the user has not asked for reduced motion). */
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { threshold: 0.05, rootMargin: '0px 0px -3% 0px' }) : null;
  function reveal(scope) {
    (scope || document).querySelectorAll('.rv:not(.in)').forEach((el) => {
      if (el.dataset.i) el.style.setProperty('--i', el.dataset.i);
      if (io && !reduceMotion) io.observe(el); else el.classList.add('in');
    });
  }

  /* ---------- PDF download ----------
     The PDF code (assets/js/pdf-browser.mjs) is only fetched when someone asks for a PDF, so pages load exactly as before.
     It reads the release's content.json and screenshots from this site and builds the file in the browser. */
  const SELF = document.currentScript && document.currentScript.src;
  const siteRoot = () => new URL(root, location.href).href;
  // a hand-written (custom) page has no content.json to draw; from disk (file:) nothing can be fetched
  const pdfAvailable = (r) => !!r && r.page !== 'custom' && location.protocol !== 'file:' && !!SELF;
  let live = null;
  const announce = (text) => {
    if (!live) { live = document.createElement('p'); live.className = 'sr'; live.setAttribute('role', 'status'); document.body.appendChild(live); }
    live.textContent = text;
  };
  function downloadPdf(release, button) {
    if (!button || button.getAttribute('aria-busy') === 'true') return Promise.resolve();
    const original = button.innerHTML; // keeps any screen-reader-only text that is part of the button
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Preparing PDF…';
    announce('Preparing the PDF…');
    const restore = (wait) => setTimeout(() => { button.innerHTML = original; button.removeAttribute('aria-busy'); }, wait);
    return import(new URL('pdf-browser.mjs', SELF).href)
      .then((lib) => lib.downloadSiteReleasePdf({ entry: release, siteRoot: siteRoot() }))
      .then(() => { announce('The PDF has been downloaded.'); button.textContent = 'PDF downloaded'; restore(2200); })
      .catch(() => { announce('The PDF could not be created. Try again.'); button.textContent = 'PDF failed. Try again'; restore(3500); });
  }

  // Mark the header link that points at this page (links with a #hash are anchors, not pages).
  document.querySelectorAll('.nav-links a').forEach((a) => {
    const u = new URL(a.getAttribute('href'), location.href);
    if (!u.hash && u.pathname.replace(/index\.html$/, '') === location.pathname.replace(/index\.html$/, '')) a.setAttribute('aria-current', 'page');
  });
  reveal();

  window.RN = { root, CATS, TYPES, esc, order, fmtDate, catById, loadReleases, reveal, includeDrafts, reduceMotion, pdfAvailable, downloadPdf };
})();
