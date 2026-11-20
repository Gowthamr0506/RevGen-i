/* Release pages: enlarge-on-click screenshots, previous/next navigation, "on this page" scroll-spy, copy link.
   The page content itself is static HTML, so it reads fine without any of this. */
(function () {
  'use strict';
  const RN = window.RN;
  const version = document.body.dataset.version;
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];

  /* ---------- on this page ---------- */
  const toc = document.querySelector('.toc');
  if (toc) {
    const mq = matchMedia('(max-width: 1100px)');
    const sync = () => { toc.open = !mq.matches; };
    sync();
    mq.addEventListener('change', sync);
    toc.querySelector('summary').addEventListener('click', (e) => { if (!mq.matches) e.preventDefault(); }); // always open on desktop
    toc.addEventListener('click', (e) => { if (mq.matches && e.target.closest('a')) toc.open = false; });
    const links = $$('a[href^="#"]', toc);
    const targets = links.map((a) => document.getElementById(a.getAttribute('href').slice(1))).filter(Boolean);
    let ticking = false;
    const spy = () => {
      ticking = false;
      let cur = null;
      for (const t of targets) { if (t.getBoundingClientRect().top <= 150) cur = t.id; else break; }
      links.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + cur));
    };
    addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(spy); } }, { passive: true });
    spy();
  }

  /* ---------- copy link ---------- */
  $$('[data-copy-link]').forEach((b) => b.addEventListener('click', async () => {
    const label = b.textContent;
    try { await navigator.clipboard.writeText(location.href.split('#')[0]); b.textContent = 'Link copied'; }
    catch (e) { b.textContent = 'Copy from the address bar'; }
    setTimeout(() => { b.textContent = label; }, 2200);
  }));

  /* ---------- previous / next, and the "Latest release" badge ---------- */
  RN.loadReleases().then(({ visible, latest }) => {
    const i = visible.findIndex((r) => r.version === version);
    if (i < 0) return;
    const nav = document.querySelector('[data-pager]');
    const link = (r, cls, dir) => '<a class="pager-link ' + cls + '" rel="' + cls + '" href="../v' + RN.esc(r.version) + '/"><span class="pager-dir">' + dir
      + '</span><span class="pager-ver">v' + RN.esc(r.version) + '</span><span class="pager-title">' + RN.esc(r.title) + '</span></a>';
    const older = visible[i + 1], newer = visible[i - 1];
    if (nav && older) nav.insertAdjacentHTML('afterbegin', link(older, 'prev', '← Previous release'));
    if (nav && newer) nav.insertAdjacentHTML('beforeend', link(newer, 'next', 'Next release →'));
    const meta = document.querySelector('.rel-meta');
    if (meta && latest && latest.version === version) meta.insertAdjacentHTML('beforeend', '<span class="chip latest"><i></i>Latest release</span>');
  }).catch(() => { /* offline or opened from disk: the static "Back to all releases" link remains */ });

  /* ---------- lightbox: native <dialog>, so focus trapping, Esc and focus return come for free ---------- */
  const shots = $$('a[data-lightbox]');
  if (!shots.length || typeof HTMLDialogElement === 'undefined') return;
  const dlg = document.createElement('dialog');
  dlg.className = 'lb';
  dlg.setAttribute('aria-label', 'Screenshot viewer');
  dlg.innerHTML = '<div class="lb-bar"><span class="lb-count" aria-live="polite"></span><span class="lb-cap"></span>'
    + '<button class="btn btn-light btn-sm lb-close" type="button">Close <kbd>Esc</kbd></button></div>'
    + '<div class="lb-stage"><button class="lb-nav prev" type="button" aria-label="Previous screenshot">&#8249;</button>'
    + '<div class="lb-scroll"><img alt=""></div><button class="lb-nav next" type="button" aria-label="Next screenshot">&#8250;</button></div>'
    + '<p class="lb-foot">Click the image to switch between fit and full size. Use the arrow keys to move between screenshots.</p>';
  document.body.appendChild(dlg);
  const img = dlg.querySelector('img'), scroll = dlg.querySelector('.lb-scroll'), cap = dlg.querySelector('.lb-cap'), count = dlg.querySelector('.lb-count');
  const prev = dlg.querySelector('.prev'), next = dlg.querySelector('.next');
  let cur = 0;

  function show(i) {
    cur = (i + shots.length) % shots.length;
    const a = shots[cur], thumb = a.querySelector('img');
    scroll.classList.remove('zoomed');
    img.src = a.getAttribute('href');
    img.alt = thumb ? thumb.alt : '';
    cap.textContent = a.dataset.caption || (thumb ? thumb.alt : '');
    count.textContent = (cur + 1) + ' / ' + shots.length;
    prev.hidden = next.hidden = shots.length < 2;
    scroll.scrollTo(0, 0);
  }
  shots.forEach((a, i) => a.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return; // let people open the file in a new tab
    e.preventDefault(); show(i); dlg.showModal();
  }));
  prev.addEventListener('click', () => show(cur - 1));
  next.addEventListener('click', () => show(cur + 1));
  dlg.querySelector('.lb-close').addEventListener('click', () => dlg.close());
  img.addEventListener('click', () => scroll.classList.toggle('zoomed'));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(cur - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); show(cur + 1); }
  });
  dlg.addEventListener('close', () => { img.removeAttribute('src'); });
})();
