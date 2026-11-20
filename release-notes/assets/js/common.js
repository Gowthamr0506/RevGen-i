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

  // Mark the header link that points at this page (links with a #hash are anchors, not pages).
  document.querySelectorAll('.nav-links a').forEach((a) => {
    const u = new URL(a.getAttribute('href'), location.href);
    if (!u.hash && u.pathname.replace(/index\.html$/, '') === location.pathname.replace(/index\.html$/, '')) a.setAttribute('aria-current', 'page');
  });
  reveal();

  window.RN = { root, CATS, TYPES, esc, order, fmtDate, catById, loadReleases, reveal, includeDrafts, reduceMotion };
})();
