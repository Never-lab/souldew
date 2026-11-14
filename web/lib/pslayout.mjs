// Partner screens as windows (views/partnerscreen.mjs): the pure layout math – sizes that keep the picture's aspect,
// keeping a window inside the play area, light snapping to the edges and to the other windows, resizing from a
// corner, the two presets (a stack in the right column, tiles in the game's corner) and the remembered layout per run.
// Everything here works on plain rectangles { x, y, w, h } relative to the play area (its top-left is 0, 0); the
// area itself is { w, h }. Tested in test/pslayout.test.mjs.

/** Header row of a window (name, age, buttons) – the CSS gives .ps-head exactly this height. */
export const HEAD = 32;
/** Border (2) + the gap under the picture (6). */
const CHROME_Y = 8;
/** Border (2) + the gaps left and right of the picture (12). */
const CHROME_X = 14;
export const MIN_W = 140; // the header still shows the name, the age and its buttons
export const MAX_W = 720;
export const GAP = 8; // between windows that snap together, and to the edges in the presets
export const SNAP = 10; // how close (px) an edge must come before it snaps – light on purpose
const COL_MAX_H = 340; // in the column a single window is never taller than this (a DS stays about as wide as before)

/** Picture aspect (width / height) by system, until the first picture says better. */
export const SYSTEM_AR = { nds: 256 / 384, gba: 3 / 2, gbc: 10 / 9, gb: 10 / 9, '3ds': 400 / 480 };
export const arOf = (system, measured) => (measured > 0 ? measured : SYSTEM_AR[system] || 3 / 2);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Window height for a width (the picture keeps its aspect). */
export function heightFor(w, ar) {
  return Math.round(HEAD + CHROME_Y + Math.max(0, w - CHROME_X) / ar);
}

/** Window width for a height. */
export function widthFor(h, ar) {
  return Math.floor(Math.max(0, h - HEAD - CHROME_Y) * ar + CHROME_X);
}

/** Largest width that fits the area (width and height) and MAX_W – never below MIN_W. */
export function maxWidth(ar, area) {
  let w = Math.min(MAX_W, area.w, widthFor(area.h, ar));
  while (w > MIN_W && heightFor(w, ar) > area.h) w--; // rounding must never make it a pixel too tall
  return Math.max(MIN_W, w);
}

/** { w, h } for a wanted width: within MIN_W … maxWidth, the height from the aspect. */
export function sizeFor(w, ar, area) {
  const ww = Math.round(clamp(Number.isFinite(w) ? w : MIN_W, MIN_W, maxWidth(ar, area)));
  return { w: ww, h: heightFor(ww, ar) };
}

/** The window's default width: the size the single partner screen always had. */
export function defaultWidth(ar, big = false) {
  if (ar < 1) return big ? 320 : 176;
  if (ar > 2) return big ? 640 : 340;
  return big ? 480 : 240;
}

/** Keeps a rectangle inside the area (moves it; a rectangle bigger than the area sits at its top-left). */
export function clampRect(r, area) {
  return { ...r, x: Math.round(clamp(r.x, 0, Math.max(0, area.w - r.w))), y: Math.round(clamp(r.y, 0, Math.max(0, area.h - r.h))) };
}

// The nearest candidate within `snap` of `v`, else v.
function nearest(v, candidates, snap) {
  let best = v;
  let dist = snap + 0.001;
  for (const c of candidates) {
    const d = Math.abs(c - v);
    if (d < dist) [best, dist] = [c, d];
  }
  return best;
}

const overlaps = (a0, a1, b0, b1, slack) => a0 < b1 + slack && b0 < a1 + slack;

/**
 * Light snapping while a window is dragged: its edges stick to the area's edges, to the other windows and to `guides`
 * ({ x: [...], y: [...] } – e.g. the edge of the right column). A neighbour level with it pulls it alongside (GAP
 * between them); one right next to it (above, below, beside) lines up with its edges. Returns the moved rectangle,
 * inside the area.
 */
export function snapRect(r, others = [], area, { snap = SNAP, gap = GAP, guides = {} } = {}) {
  const xs = [0, area.w - r.w];
  const ys = [0, area.h - r.h];
  for (const g of guides.x || []) xs.push(g, g - r.w);
  for (const g of guides.y || []) ys.push(g, g - r.h);
  const near = gap + snap * 2; // "right next to it"
  for (const o of others) {
    if (!o) continue;
    const levelY = overlaps(r.y, r.y + r.h, o.y, o.y + o.h, snap);
    const levelX = overlaps(r.x, r.x + r.w, o.x, o.x + o.w, snap);
    if (levelY) xs.push(o.x + o.w + gap, o.x - gap - r.w);
    if (levelX) ys.push(o.y + o.h + gap, o.y - gap - r.h);
    if (overlaps(r.y, r.y + r.h, o.y, o.y + o.h, near)) xs.push(o.x, o.x + o.w - r.w);
    if (overlaps(r.x, r.x + r.w, o.x, o.x + o.w, near)) ys.push(o.y, o.y + o.h - r.h);
  }
  return clampRect({ ...r, x: nearest(r.x, xs, snap), y: nearest(r.y, ys, snap) }, area);
}

/** Which corner the resize grip sits in: the one facing into the area (a window on the right grows to the left). */
export function gripSide(r, area) {
  return r.x + r.w / 2 > area.w / 2 ? 'left' : 'right';
}

/**
 * Resizing from the bottom corner (`side` 'right': the top-left stays, 'left': the top-right stays) by a pointer
 * moved dx, dy since `start`. The bigger of the two movements decides (a horizontal drag alone is enough), the aspect
 * stays, the size stays within MIN_W … maxWidth, and a window that would stick out is moved back inside.
 */
export function resizeRect(start, dx, dy, ar, area, side = 'right') {
  const byX = side === 'left' ? -dx : dx;
  const byY = dy * ar; // the same change of height, as width
  const w0 = start.w + (Math.abs(byX) >= Math.abs(byY) ? byX : byY);
  const { w, h } = sizeFor(w0, ar, area);
  const x = side === 'left' ? start.x + start.w - w : start.x;
  return clampRect({ x, y: start.y, w, h }, area);
}

/** New width for a window, keeping the corner nearest to the area's corner where it was (Bigger / Smaller). */
export function resizeAnchored(r, w, ar, area) {
  const size = sizeFor(w, ar, area);
  const right = r.x + r.w / 2 > area.w / 2;
  const bottom = r.y + r.h / 2 > area.h / 2;
  return clampRect({ x: right ? r.x + r.w - size.w : r.x, y: bottom ? r.y + r.h - size.h : r.y, ...size }, area);
}

/**
 * A moved window is remembered by where it sits in the free room of the area (0 … 1 each way) and its width – so one
 * at the right edge stays at the right edge when the app window gets bigger or smaller.
 */
export function toStored(r, area) {
  const fx = area.w - r.w > 0 ? clamp(r.x / (area.w - r.w), 0, 1) : 0;
  const fy = area.h - r.h > 0 ? clamp(r.y / (area.h - r.h), 0, 1) : 0;
  return { fx: Math.round(fx * 10000) / 10000, fy: Math.round(fy * 10000) / 10000, w: Math.round(r.w) };
}

export function fromStored(s, ar, area) {
  const { w, h } = sizeFor(s.w, ar, area);
  const fx = clamp(Number(s.fx) || 0, 0, 1);
  const fy = clamp(Number(s.fy) || 0, 0, 1);
  return clampRect({ x: fx * Math.max(0, area.w - w), y: fy * Math.max(0, area.h - h), w, h }, area);
}

/**
 * The column preset: the windows on top of each other at the bottom of `col` (a rectangle in the area – the right
 * column, its bottom already above the layout buttons), as wide as the column. When they don't fit in `maxShare` of
 * its height they get narrower – or go two (three …) side by side, whichever leaves the bigger pictures.
 * items: [{ id, ar }] top to bottom. → { [id]: rect }
 */
export function columnLayout(items, col, area, { maxShare = 0.62 } = {}) {
  const out = {};
  if (!items.length) return out;
  const maxH = Math.max(heightFor(MIN_W, 3 / 2), col.h * maxShare);
  let best = null;
  for (let k = 1; k <= items.length; k++) {
    const rows = [];
    for (let i = 0; i < items.length; i += k) rows.push(items.slice(i, i + k));
    const cellW = (col.w - (k - 1) * GAP) / k;
    // the widest width w (≤ cellW) for which every row, at its tallest picture, fits into maxH together
    const tall = rows.map((row) => Math.min(...row.map((it) => it.ar)));
    let w = cellW;
    for (const ar of tall) w = Math.min(w, widthFor(Math.min(COL_MAX_H, (maxH - (rows.length - 1) * GAP) / rows.length), ar));
    w = Math.floor(Math.min(w, MAX_W));
    if (!best || w > best.w + 0.5) best = { k, w, rows };
    if (w >= cellW - 0.5) break; // full width already – more per row only makes them smaller
  }
  const w = Math.max(MIN_W, best.w);
  const heights = best.rows.map((row) => Math.max(...row.map((it) => heightFor(w, it.ar))));
  const total = heights.reduce((a, b) => a + b, 0) + (heights.length - 1) * GAP;
  let y = col.y + col.h - total;
  best.rows.forEach((row, ri) => {
    // right-aligned like the column's content, the first partner leftmost
    let x = col.x + col.w - row.length * w - (row.length - 1) * GAP;
    for (const it of row) {
      const h = heightFor(w, it.ar);
      out[it.id] = clampRect({ x, y: y + heights[ri] - h, w, h }, area);
      x += w + GAP;
    }
    y += heights[ri] + GAP;
  });
  return out;
}

/** Height the column preset takes at the bottom of the column (for the room kept free under the teams). */
export function columnHeight(rects) {
  const list = Object.values(rects);
  if (!list.length) return 0;
  return Math.max(...list.map((r) => r.y + r.h)) - Math.min(...list.map((r) => r.y));
}

/**
 * The corner preset: small windows down the left edge of `stage` from its top-left corner (next to the game, where
 * a DS or GBA picture leaves room), a new column when the next one doesn't fit. items: [{ id, ar }] → { [id]: rect }
 */
export function cornerLayout(items, stage, area) {
  const out = {};
  const wantW = clamp(Math.round(stage.w * 0.28), 180, 240);
  let x = stage.x + GAP;
  let y = stage.y + GAP;
  let colW = 0;
  for (const it of items) {
    // a portrait DS screen gets the same height as a landscape one would, not the same width
    const w = it.ar < 1 ? Math.max(MIN_W, widthFor(heightFor(wantW, 3 / 2) + 30, it.ar)) : wantW;
    const h = heightFor(w, it.ar);
    if (y > stage.y + GAP && y + h > stage.y + stage.h - GAP) {
      x += colW + GAP;
      y = stage.y + GAP;
      colW = 0;
    }
    out[it.id] = clampRect({ x, y, w, h }, area);
    y += h + GAP;
    colW = Math.max(colW, w);
  }
  return out;
}

// ---- the remembered layout ------------------------------------------------------------------------------------------
// localStorage 'sl-partnerscreen' (per computer): { runs: { [run id]: { at, preset, wins: { [slot]: { hidden, fx, fy,
// w } } } } } – plus { hidden, big } from the single partner screen before, read once as the start for a run.
export const PRESETS = ['column', 'corner'];
const MAX_RUNS = 40;

/** The layout of one run (never null): { preset, wins }. */
export function runLayout(pref, runId) {
  const r = pref?.runs?.[runId];
  if (r) return { preset: PRESETS.includes(r.preset) ? r.preset : 'column', wins: r.wins && typeof r.wins === 'object' ? r.wins : {} };
  return { preset: 'column', wins: {}, legacyHidden: !!pref?.hidden };
}

/** The window's own state in a run's layout: { hidden, stored } (stored: null while it follows the preset). */
export function winState(layout, slot) {
  const w = layout.wins[slot] || {};
  const stored = Number.isFinite(w.w) && Number.isFinite(w.fx) && Number.isFinite(w.fy) ? { fx: w.fx, fy: w.fy, w: w.w } : null;
  return { hidden: w.hidden ?? !!layout.legacyHidden, stored };
}

/** pref with the run's layout changed by `fn(layout) → layout` (oldest runs dropped beyond MAX_RUNS). */
export function updateRun(pref, runId, fn, now = Date.now()) {
  const runs = { ...(pref?.runs || {}) };
  const cur = runLayout(pref, runId);
  const next = fn({ preset: cur.preset, wins: { ...cur.wins } });
  runs[runId] = { at: now, preset: next.preset, wins: next.wins };
  const ids = Object.keys(runs);
  if (ids.length > MAX_RUNS) {
    for (const id of ids.sort((a, b) => (runs[a].at || 0) - (runs[b].at || 0)).slice(0, ids.length - MAX_RUNS)) delete runs[id];
  }
  return { ...pref, runs };
}

/** A run's layout differs from the start (moved, resized, hidden or the other preset) – "Reset layout" is offered. */
export function isCustom(layout) {
  return layout.preset !== 'column' || Object.values(layout.wins).some((w) => w && (w.hidden || Number.isFinite(w.w)));
}
