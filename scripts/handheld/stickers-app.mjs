// The FREE and EARNED sticker designs of "Your handheld" (shared/handheld.mjs has the catalog): original pixel art in the
// banner family – no Pokémon or Nintendo motifs. Build input only: scripts/build-handheld-atlas.mjs turns them into the
// app's pre-built atlas (web/assets/handheld/); the page never runs this. The souldew+ designs are not in this repository –
// they come with the souldew+ pack (scripts/plus-dev-pack.mjs --handheld).
import { WORD_S } from '../../web/lib/cosmetics/banners/engine/brand.mjs';

const art = (rows, map) => ({ w: Math.max(...rows.map((r) => r.length)), h: rows.length, rows, map });

function raster(w, h) {
  const g = Array.from({ length: h }, () => Array(w).fill('.'));
  const map = {};
  let next = 0;
  const key = (c) => { for (const [k, v] of Object.entries(map)) if (v === c) return k; const k = 'abcdefghijklmnopqrstuvwxyz'[next++]; map[k] = c; return k; };
  return {
    w, h,
    put(x, y, c) { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < w && y < h) g[y][x] = c ? key(c) : '.'; },
    get(x, y) { return x >= 0 && y >= 0 && x < w && y < h ? map[g[y][x]] || null : null; },
    disc(cx, cy, r, c, test) { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy); if (d <= r && (!test || test(x, y, d))) this.put(x, y, c); } },
    done() { return { w, h, rows: g.map((r) => r.join('')), map }; },
  };
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const od = (x, y, f) => f * 16 > BAYER[((y & 3) << 2) | (x & 3)] + 0.5;

function moonBadge() { // a night-sky disc with a crescent and three stars (The Night Train's palette)
  const R = raster(21, 21);
  R.disc(10.5, 10.5, 10.4, '#191f37');
  R.disc(10.5, 10.5, 10.4, '#2a3050', (x, y) => od(x, y, Math.max(0, (y - 9) / 14))); // a dithered horizon glow
  R.disc(11.6, 9.6, 6.4, '#ece6cf', (x, y) => Math.hypot(x + 0.5 - 14.4, y + 0.5 - 7.4) > 5.3);
  R.disc(11.6, 9.6, 6.4, '#b9b29a', (x, y) => Math.hypot(x + 0.5 - 14.4, y + 0.5 - 7.4) > 5.3 && Math.hypot(x + 0.5 - 13.6, y + 0.5 - 8.2) <= 6.3);
  for (const [x, y, big] of [[4, 6, 1], [16, 15, 0], [6, 15, 0], [16, 4, 0]]) {
    R.put(x, y, '#e8ecf6');
    if (big) { R.put(x - 1, y, '#8a92b4'); R.put(x + 1, y, '#8a92b4'); R.put(x, y - 1, '#8a92b4'); R.put(x, y + 1, '#8a92b4'); }
  }
  return R.done();
}

function sparkle() { // a four-point star, warm gold
  const R = raster(15, 15);
  for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) {
    const dx = Math.abs(x - 7) / 7.4, dy = Math.abs(y - 7) / 7.4;
    const v = Math.sqrt(dx) + Math.sqrt(dy);
    if (v <= 1) R.put(x, y, v < 0.42 ? '#fff4d2' : v < 0.72 ? '#f2c477' : '#d79a3e');
  }
  return R.done();
}

function logo() { // the souldew wordmark (the app's own pixel grid) on a cream pill
  const w = WORD_S[0].length + 6, h = WORD_S.length + 6;
  const R = raster(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const cx = Math.min(x + 0.5, w - x - 0.5), cy = Math.min(y + 0.5, h - y - 0.5);
    const r = h / 2;
    if (cx < r && Math.hypot(r - cx, r - cy) > r - 0.05) continue;
    R.put(x, y, '#ebe6da');
  }
  WORD_S.forEach((row, j) => [...row].forEach((ch, i) => { if (ch === 'a') R.put(i + 3, j + 3, '#1b1a1f'); }));
  return R.done();
}

function rings() { // two linked rings – cream and gold – tied by a red thread (earned: Bound by Fate)
  const R = raster(23, 19);
  const ring = (cx, cy, c, c2, front) => R.disc(cx, cy, 5.6, c, (x, y, d) => d > 3.3 && (!front || front(x, y)) && true) || R.disc(cx, cy, 5.6, c2, (x, y, d) => d > 3.3 && d <= 4.2 && (!front || front(x, y)));
  ring(8, 8, '#ebe6da', '#c9c2b0');
  ring(15, 8, '#e9c46e', '#b88a3a', (x, y) => !(x <= 11 && y < 8 && Math.hypot(x + 0.5 - 8, y + 0.5 - 8) > 3.3 && Math.hypot(x + 0.5 - 8, y + 0.5 - 8) <= 5.6));
  // the cream ring passes over the gold one at the bottom crossing
  R.disc(8, 8, 5.6, '#ebe6da', (x, y, d) => d > 3.3 && x >= 10 && y >= 8);
  for (const [x, y] of [[11, 13], [11, 14], [12, 15], [13, 15], [14, 16], [15, 16], [16, 17], [17, 17], [18, 16], [10, 14], [9, 15]]) R.put(x, y, '#d0443a');
  return R.done();
}

function laurel() { // a laurel wreath, open at the top, with a ribbon (earned: Untouchable)
  const R = raster(21, 19);
  const cx = 10.5, cy = 9.5;
  for (let k = 0; k < 2; k++) {
    const side = k ? 1 : -1;
    for (let i = 0; i < 10; i++) { // leaves along an arc from the bottom to the upper side
      const a = Math.PI / 2 + side * (0.22 + i * 0.27);
      const x = cx + Math.cos(a) * 7.6, y = cy + Math.sin(a) * 7.6;
      const ox = Math.cos(a + side * 1.25) * 1.9, oy = Math.sin(a + side * 1.25) * 1.9;
      R.put(x, y, '#9a7a2a');
      R.put(x + ox * 0.6, y + oy * 0.6, '#e9c46e');
      R.put(x + ox, y + oy, i % 2 ? '#e9c46e' : '#f6dc96');
      R.put(x - ox * 0.5, y - oy * 0.5, '#c9a24a');
      R.put(x - ox, y - oy, i % 2 ? '#c9a24a' : '#e9c46e');
    }
  }
  for (const [x, y] of [[9, 17], [10, 17], [11, 17], [8, 18], [12, 18], [10, 16]]) R.put(x, y, '#d0443a');
  return R.done();
}

const HEART = art([
  '.ooo...ooo.',
  'ohhro.orrro',
  'ohrrrorrrro',
  'orrrrrrrrdo',
  'orrrrrrrrdo',
  '.orrrrrrdo.',
  '..orrrrdo..',
  '...orrdo...',
  '....odo....',
  '.....o.....',
], { o: '#9c3d45', r: '#dc7268', h: '#f8b9ad', d: '#b4505a' });

const SIGNPOST = art([
  '.....aa........',
  '.aaaaaaaaaaaa..',
  '.abbbbbbbbbbba.',
  '.aaaaaaaaaaaa..',
  '.....aa........',
  '..aaaaaaaaaaaa.',
  '.abbbbbbbbbbba.',
  '..aaaaaaaaaaaa.',
  '.....aa........',
  '.....aa........',
  '.....aa........',
  '..ggggggg......',
  '.gGGGgggpppp...',
  'ggggpppp....pp.',
  '..pp.........pp',
], { a: '#6a4a30', b: '#c8a070', g: '#5ea048', G: '#86c060', p: '#d6c49a' });

const STAR = art([ // a tiny five-point star for clusters
  '...y...',
  '..yWy..',
  'yyyWyyy',
  '.yyyyd.',
  '..yyd..',
  '.yy.dd.',
  '.y...d.',
], { y: '#f2c477', W: '#fff4d2', d: '#d79a3e' });

const DOT = art([ // a round dot (a confetti dot, for clusters)
  '.ccc.',
  'cWccc',
  'ccccc',
  'cccCC',
  '.CCC.',
], { c: '#dc7268', W: '#f8b9ad', C: '#b4505a' });

const DEW = art([ // a dew drop – the app's name, in one drop
  '..b..',
  '..b..',
  '.bbb.',
  '.bbbb',
  'bWbbb',
  'bWbbd',
  'bbbbd',
  '.bdd.',
], { b: '#7fc4d8', W: '#eef9fc', d: '#4a8aa8' });

const CLOUD = art([ // a cumulus in three puffs: lit rims on top, a shaded belly
  '.......hhhh........',
  '.....hhwwwwhh......',
  '....hwwwwwwwwh.....',
  '....wwwwwwwwwwh.hh.',
  '.hh.wwwwwwwwwwwwwwh',
  'hwwhwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwwwwww',
  'mwwwwwwwwwwwwwwwwwm',
  'smmmmmmmmmmmmmmmmms',
  '.sssssssssssssssss.',
], { h: '#ffffff', w: '#eceef3', m: '#d0d6e4', s: '#a8b2c8' });

/** { id, outline, art } for every free and earned sticker */
export const DESIGNS = [
  { id: 'heart', outline: '#5a2228', art: HEART },
  { id: 'moon', outline: '#0a0d19', art: moonBadge() },
  { id: 'sparkle', outline: '#7a5420', art: sparkle() },
  { id: 'logo', outline: '#1b1a1f', art: logo() },
  { id: 'star', outline: '#6a4418', art: STAR },
  { id: 'dot', outline: '#6a2228', art: DOT },
  { id: 'dew', outline: '#1a3a4a', art: DEW },
  { id: 'cloud', outline: '#3a4258', art: CLOUD },
  { id: 'thread', outline: '#1b1a1f', art: rings() },
  { id: 'signpost', outline: '#2a1e14', art: SIGNPOST },
  { id: 'laurel', outline: '#5a4214', art: laurel() },
];
