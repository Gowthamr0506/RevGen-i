// The browser side of the PDF download: turns the screenshots and the logo into JPEGs (a PDF page cannot hold WebP), builds the
// file with pdf.mjs and saves it. Uses only the page's own canvas and blob: addresses, so the page CSP stays as it is.
import { buildReleasePdf, pdfFileName } from './pdf.mjs';

export { pdfFileName };

/** Draws an image (a blob: address or a same-site file) on white and returns it as a JPEG. width forces the size (sharp logo from an SVG). */
export async function toJpeg(url, { maxWidth = 1400, width = 0, quality = 0.88 } = {}) {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  const nw = img.naturalWidth || 800, nh = img.naturalHeight || 600; // an SVG without a size of its own
  const w = width || Math.min(nw, maxWidth), h = Math.max(1, Math.round((nh * w) / nw));
  // An off-screen canvas hands the JPEG back as a promise; a page canvas needs a callback that browsers slow right down once
  // the person switches to another tab, which would make the download crawl.
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.drawImage(img, 0, 0, w, h);
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/jpeg', quality }) : await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('The browser could not convert a screenshot.');
  return { jpeg: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
}

/** Every screenshot file name the content uses. */
export function usedImages(content) {
  const names = new Set();
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
      if (typeof o.src === 'string') { const m = /^images\/([^/]+)$/.exec(o.src); if (m) names.add(m[1]); }
      Object.values(o).forEach(walk);
    }
  };
  walk(content?.items);
  return [...names];
}

/**
 * The PDF for one release. imageUrls = {fileName: blob url}. A screenshot that cannot be converted is left out (the file then says
 * so in its place) instead of stopping the whole download.
 */
export async function releasePdfBytes({ entry, content, imageUrls = {}, logoUrl = '', baseUrl = '', onProgress = () => {}, now = new Date() }) {
  const names = usedImages(content).filter((n) => imageUrls[n]);
  const images = {};
  for (const [i, name] of names.entries()) {
    onProgress(`Preparing the screenshots (${i + 1} of ${names.length})…`);
    try { images[name] = await toJpeg(imageUrls[name]); } catch { /* left out */ }
  }
  let logo = null;
  if (logoUrl) { try { logo = await toJpeg(logoUrl, { width: 720, quality: 0.95 }); } catch { /* the file is fine without it */ } }
  onProgress('Building the PDF…');
  return buildReleasePdf({ entry, content, images, logo, baseUrl, now });
}

/**
 * The public site's download: reads a published release's content.json and screenshots from the site itself, then saves the PDF.
 * entry = the release's entry from releases.json; siteRoot = the portal's address ending in "/".
 */
export async function downloadSiteReleasePdf({ entry, siteRoot, onProgress = () => {} }) {
  const dir = `${siteRoot}releases/v${entry.version}/`;
  onProgress('Loading the release…');
  const res = await fetch(`${dir}content.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`The release content could not be loaded (HTTP ${res.status}).`);
  const content = await res.json();
  const imageUrls = Object.fromEntries(usedImages(content).map((n) => [n, `${dir}${encodeURI(`images/${n}`)}`]));
  const bytes = await releasePdfBytes({ entry, content, imageUrls, logoUrl: `${siteRoot}assets/images/logo.svg`, baseUrl: dir, onProgress });
  saveBytes(bytes, pdfFileName(entry));
}

/** Hands the bytes to the browser as a download. */
export function saveBytes(bytes, filename, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
