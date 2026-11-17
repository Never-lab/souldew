// souldew+ launch animations v2 – engine. Dependency-free ES module (browser and Node).
//
// The idea that keeps these crisp and cheap: an animation is drawn on the GAME'S OWN PIXEL GRID. A GBA launch is a
// 240×160 picture, a DS one 256×384 (or 512×192 side by side), a 3DS one 400×480 – the same native size the core
// renders – scaled by the browser exactly like the game (image-rendering: pixelated). So every animation pixel sits on
// a game pixel, and a frame costs one small putImageData.
//
// Pixel rules (shared with the banner engine): one palette per animation (≤ 15 colours + transparent), every pixel is
// a palette index or transparent, no alpha blending. Soft edges only through the 4×4 ordered (Bayer) matrix. Index 0
// is "transparent": that is where the game shows through – which is how every animation hands over.
//
// An animation module:
//   { id, name, collection, dur, revealAt, pal: ['#rrggbb', …] (indices 1…n),
//     setup(env) → state      precomputed fields (once per mount; env = { W, H, screens, seed })
//     draw(buf, t, r0, st, env)  write indices into buf (W×H Uint8Array, cleared to 0 by the caller)
//   }
// t is the animation clock (seconds). r0 is when the reveal starts: revealAt normally, later when the game's first
// frame was late (the cover then keeps its ambient motion going until the frame is there). draw must be a pure
// function of (t, r0) – that is what makes the render script, the gallery and the app show the same thing.

// ------------------------------------------------------------------ layouts (the play view's screen shapes)
// The 3DS rectangles are shared/ctrlayout.mjs's LAYOUTS (1× units); the DS ones are the player's 256×192 screens,
// stacked ('tb') or side by side ('lr'), with no gap – exactly what play.mjs sizes the frame with (arn).
const R = (x, y, w, h) => ({ x, y, w, h });
export const LAYOUTS = {
  gb: { W: 160, H: 144, screens: [R(0, 0, 160, 144)] },
  gba: { W: 240, H: 160, screens: [R(0, 0, 240, 160)] },
  'ds-tb': { W: 256, H: 384, screens: [R(0, 0, 256, 192), R(0, 192, 256, 192)] },
  'ds-lr': { W: 512, H: 192, screens: [R(0, 0, 256, 192), R(256, 0, 256, 192)] },
  '3ds-tb': { W: 400, H: 480, screens: [R(0, 0, 400, 240), R(40, 240, 320, 240)] },
  '3ds-bt': { W: 400, H: 480, screens: [R(0, 240, 400, 240), R(40, 0, 320, 240)] },
  '3ds-lr': { W: 720, H: 240, screens: [R(0, 0, 400, 240), R(400, 0, 320, 240)] },
  '3ds-large': { W: 560, H: 240, screens: [R(0, 0, 400, 240), R(400, 120, 160, 120)] },
  '3ds-top': { W: 400, H: 240, screens: [R(0, 0, 400, 240)] },
};
/** play.mjs's target.system + its DS / 3DS layout setting → a LAYOUTS key */
export function layoutKey(system, dsLayout = 'tb', ctrLayout = 'tb') {
  if (system === 'gba') return 'gba';
  if (system === 'nds') return dsLayout === 'lr' ? 'ds-lr' : 'ds-tb';
  if (system === '3ds') return `3ds-${LAYOUTS[`3ds-${ctrLayout}`] ? ctrLayout : 'tb'}`;
  return 'gb';
}

// ------------------------------------------------------------------ deterministic random and noise
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function h1(i, s = 0) {
  let h = Math.imul((i | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((s | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 13; h = Math.imul(h, 0x27d4eb2f); h ^= h >>> 15; h = Math.imul(h, 0x165667b1); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export const h2 = (x, y, s = 0) => h1(Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663), s);
const sm = (f) => f * f * (3 - 2 * f);
export function noise1(x, s = 0) { const i = Math.floor(x), f = x - i; const a = h1(i, s), b = h1(i + 1, s); return a + (b - a) * sm(f); }
export function noise2(x, y, s = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = sm(x - ix), fy = sm(y - iy);
  const a = h2(ix, iy, s), b = h2(ix + 1, iy, s), c = h2(ix, iy + 1, s), d = h2(ix + 1, iy + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
export function fbm2(x, y, s = 0, oct = 4) {
  let v = 0, a = 0.5, f = 1, n = 0;
  for (let o = 0; o < oct; o++) { v += a * noise2(x * f, y * f, s + o * 101); n += a; a *= 0.5; f *= 2; }
  return v / n;
}

// ------------------------------------------------------------------ ordered dither (the only "blend")
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** threshold of pixel (x, y) in 0…1 */
export const bay = (x, y) => (BAYER[((y & 3) << 2) | (x & 3)] + 0.5) / 16;
/** true where a fill of strength f (0…1) sets this pixel */
export const od = (x, y, f) => f > bay(x, y);

// ------------------------------------------------------------------ time and easing
export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
/** 0…1 progress of t through [a, b] */
export const seg = (t, a, b) => clamp((t - a) / (b - a));
export const smooth = (t) => t * t * (3 - 2 * t);
export const inQuad = (t) => t * t;
export const inCubic = (t) => t * t * t;
export const outCubic = (t) => 1 - (1 - t) ** 3;
export const outQuart = (t) => 1 - (1 - t) ** 4;
export const inOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
/** CSS cubic-bezier(x1, y1, x2, y2) as a function – the same curves the app's stylesheets use */
export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (s) => ((ax * s + bx) * s + cx) * s, Y = (s) => ((ay * s + by) * s + cy) * s, dX = (s) => (3 * ax * s + 2 * bx) * s + cx;
  return (x) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let s = x;
    for (let i = 0; i < 6; i++) { const e = X(s) - x, d = dX(s); if (Math.abs(e) < 1e-5 || Math.abs(d) < 1e-6) break; s -= e / d; }
    return Y(clamp(s));
  };
}
/** a few names for the curves used across the set (documented in README) */
export const EASE = {
  standard: bezier(0.4, 0, 0.2, 1),
  slide: bezier(0.6, 0, 0.2, 1),      // the round-1 "peel" curve
  settle: bezier(0.2, 0.7, 0.2, 1),
  gravity: bezier(0.55, 0, 1, 0.45),
};

// ------------------------------------------------------------------ drawing into an indexed W×H buffer
export function px(buf, W, H, x, y, c) { x |= 0; y |= 0; if (x >= 0 && y >= 0 && x < W && y < H) buf[y * W + x] = c; }
export function fill(buf, W, H, x, y, w, h, c) {
  const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0), x1 = Math.min(W, (x + w) | 0), y1 = Math.min(H, (y + h) | 0);
  for (let j = y0; j < y1; j++) buf.fill(c, j * W + x0, j * W + x1);
}
export function line(buf, W, H, x0, y0, x1, y1, c) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let e = dx + dy;
  for (let n = 0; n < 4096; n++) { px(buf, W, H, x0, y0, c); if (x0 === x1 && y0 === y1) break; const e2 = 2 * e; if (e2 >= dy) { e += dy; x0 += sx; } if (e2 <= dx) { e += dx; y0 += sy; } }
}
/** scanline polygon fill; pts = [[x, y], …]; c: an index or (x, y) → index; test(x, y) → false skips a pixel */
export function poly(buf, W, H, pts, c, test) {
  let y0 = Infinity, y1 = -Infinity; for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(H - 1, Math.ceil(y1)); y++) {
    const xs = []; const yc = y + 0.5;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) xs.push(a[0] + (yc - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.max(0, Math.round(xs[i])), xb = Math.min(W, Math.round(xs[i + 1]));
      for (let x = xa; x < xb; x++) if (!test || test(x, y)) buf[y * W + x] = typeof c === 'function' ? c(x, y) : c;
    }
  }
}
/** draw a small sprite given as rows of characters; map: char → palette index ('.' / ' ' = skip) */
export function sprite(buf, W, H, rows, x, y, map, flip = false) {
  for (let j = 0; j < rows.length; j++) {
    const r = rows[j];
    for (let i = 0; i < r.length; i++) { const ch = r[flip ? r.length - 1 - i : i]; const c = map[ch]; if (c) px(buf, W, H, x + i, y + j, c); }
  }
}

// ------------------------------------------------------------------ palette → RGBA
export function hex(c) { c = c.replace('#', ''); return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]; }
/** Uint32 lookup (little-endian RGBA) for palette `pal` (index 0 transparent) */
export function pal32(pal) {
  if (pal.length > 15) throw new Error(`palette has ${pal.length} colours (max 15)`);
  const out = new Uint32Array(256);
  pal.forEach((c, i) => { const [r, g, b] = hex(c); out[i + 1] = (255 << 24 | b << 16 | g << 8 | r) >>> 0; });
  return out;
}
