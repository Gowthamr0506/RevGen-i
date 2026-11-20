// Read an image's pixel size from its header. No dependencies. Used for width/height attributes
// (prevents layout shift while screenshots load) and for validation. Never re-encodes an image.
import fs from 'node:fs';
import path from 'node:path';

const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function png(b) {
  if (b.length < 24 || u32be(b, 0) !== 0x89504e47) return null;
  return { w: u32be(b, 16), h: u32be(b, 20) };
}
function gif(b) {
  if (b.length < 10 || b.toString('latin1', 0, 3) !== 'GIF') return null;
  return { w: u16le(b, 6), h: u16le(b, 8) };
}
function jpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { h: u16be(b, i + 5), w: u16be(b, i + 7) };
    }
    i += 2 + u16be(b, i + 2);
  }
  return null;
}
function webp(b) {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8 ') return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
  if (kind === 'VP8L') {
    const [b0, b1, b2, b3] = [b[21], b[22], b[23], b[24]];
    return { w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
  }
  if (kind === 'VP8X') return { w: 1 + u24le(b, 24), h: 1 + u24le(b, 27) };
  return null;
}
function svg(b) {
  const head = b.toString('utf8', 0, Math.min(b.length, 2048));
  const tag = head.match(/<svg\b[^>]*>/i)?.[0];
  if (!tag) return null;
  const vb = tag.match(/viewBox=["']\s*[\d.+-]+[\s,]+[\d.+-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (vb) return { w: Math.round(+vb[1]), h: Math.round(+vb[2]) };
  const w = tag.match(/\swidth=["']([\d.]+)(px)?["']/i), h = tag.match(/\sheight=["']([\d.]+)(px)?["']/i);
  return w && h ? { w: Math.round(+w[1]), h: Math.round(+h[1]) } : null;
}

/** @returns {{w:number,h:number,bytes:number}|null} null when the format is unknown (e.g. AVIF) or corrupt. */
export function readImageInfo(abs) {
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return null; }
  const ext = path.extname(abs).toLowerCase();
  const size = { '.png': png, '.gif': gif, '.jpg': jpeg, '.jpeg': jpeg, '.webp': webp, '.svg': svg }[ext]?.(buf) ?? null;
  return size && size.w > 0 && size.h > 0 ? { ...size, bytes: buf.length } : null;
}
