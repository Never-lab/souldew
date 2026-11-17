// souldew+ PREVIEW MEDIA: what someone without souldew+ sees of every premium item before buying it – pictures only,
// rendered offline with the same engines from the design sources. No recipe, no code, no stylesheet: a PNG still and
// a short, low-resolution animated WebP loop per item, plus a still of the app in every colour skin. They are free to
// give away: the accounts service serves them to anyone (GET /v1/previews), signed like every pack, so the app still
// checks them against the pinned pack key before it shows one.
//
//   <kind>/<id>.png    still, display size ×2: banners 768×112, nameplates 320×52, frames 208×208, launch 480×320
//   <kind>/<id>.webp   loop, native resolution (the page scales it pixelated), ≤ 150 KB, a few seconds
//   skins/<id>.webp    the library in that skin, 960×600 (scripts/plus-skin-shots.mjs renders it in Electron)
//
// Used by scripts/plus-dev-pack.mjs (--previews-source, and the test pack of --out).
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, mkdtempSync, statSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PREVIEW_KINDS = ['banners', 'nameplates', 'frames', 'launch', 'skins'];
export const LOOP_MAX_BYTES = 150 * 1024;
const FPS = 12;

/** RGBA little-endian Uint32 pixels → nearest-neighbour ×k */
function upscale(w, h, src, k) {
  if (k === 1) return src;
  const out = new Uint32Array(w * k * h * k);
  for (let y = 0; y < h * k; y++) { const sy = (y / k) | 0; for (let x = 0; x < w * k; x++) out[y * w * k + x] = src[sy * w + ((x / k) | 0)]; }
  return out;
}

/** an animated WebP from RGBA frames (img2webp: lossless first – pixel art packs small – lossy when that is too big) */
function loopWebp(frames, w, h, encodePNG, file) {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-loop-'));
  try {
    const names = frames.map((f, i) => {
      const p = join(dir, `f${String(i).padStart(3, '0')}.png`);
      writeFileSync(p, encodePNG(w, h, f));
      return p;
    });
    for (const mode of [['-lossless'], ['-lossy', '-q', '80'], ['-lossy', '-q', '55']]) {
      const r = spawnSync('img2webp', ['-loop', '0', '-d', String(Math.round(1000 / FPS)), '-mixed', ...mode, ...names, '-o', file], { encoding: 'utf8' });
      if (r.error) throw new Error('img2webp is needed for the preview loops (brew install webp)');
      if (r.status !== 0) throw new Error(`img2webp failed: ${r.stderr}`);
      if (statSync(file).size <= LOOP_MAX_BYTES) return;
    }
    throw new Error(`${basename(file)}: the loop stays over ${LOOP_MAX_BYTES} bytes`);
  } finally {
    for (const n of readdirSync(dir)) rmSync(join(dir, n));
    rmdirSync(dir);
  }
}

/** a canvas stand-in for the launch placeholder (fillStyle / fillRect into RGBA) */
function fakeDoc() {
  return {
    createElement: () => {
      const cv = { width: 0, height: 0 };
      cv.getContext = () => {
        cv.px = cv.px || new Uint32Array(cv.width * cv.height);
        let col = 0xff000000;
        return {
          set fillStyle(c) {
            const m = /^#([0-9a-f]{6})$/i.exec(c) || /^#([0-9a-f]{3})$/i.exec(c);
            let h = m ? m[1] : '000';
            if (h.length === 3) h = [...h].map((x) => x + x).join('');
            const n = parseInt(h, 16);
            col = (0xff000000 | ((n & 0xff) << 16) | (n & 0xff00) | (n >> 16)) >>> 0;
          },
          fillRect(x, y, w, h) {
            for (let j = Math.max(0, y | 0); j < Math.min(cv.height, (y | 0) + (h | 0)); j++) cv.px.fill(col, j * cv.width + Math.max(0, x | 0), j * cv.width + Math.min(cv.width, (x | 0) + (w | 0)));
          },
        };
      };
      return cv;
    },
  };
}

/**
 * Renders every premium banner, nameplate, frame and launch animation into `out` (<kind>/<id>.png + .webp) and returns
 * the file list [{ path, bytes }]. design: the design/plus folder; banners / frames / anims: the premium items.
 */
export async function renderItemPreviews({ design, banners, frames, anims, out, log = console.log }) {
  const imp = (p) => import(pathToFileURL(join(design, p)).href);
  const { encodePNG } = await imp('banners/tools/png.mjs');
  const { compile } = await imp('banners/engine/index.mjs');
  const { compileFrame } = await imp('frames/engine/index.mjs');
  const { LAYOUTS, pal32 } = await imp('launch/engine.mjs');
  const { placeholderCanvas } = await import(pathToFileURL(join(ROOT, 'web', 'lib', 'cosmetics', 'launch', 'placeholder.mjs')).href);
  const files = [];
  const put = (path, bytes) => {
    const target = join(out, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    files.push({ path, bytes: new Uint8Array(bytes) });
  };
  const loop = (path, frs, w, h) => {
    const target = join(out, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    loopWebp(frs, w, h, encodePNG, target);
    files.push({ path, bytes: new Uint8Array(readFileSync(target)) });
  };
  const frameTimes = (from, secs) => Array.from({ length: Math.max(1, Math.round(secs * FPS)) }, (_, i) => from + i / FPS);

  // banners: the profile strip at 384 native columns (768×112 still), the loop at native size, 4 s
  for (const b of banners) {
    const sc = compile(b, { width: 384 });
    sc.noIntro = true;
    const buf = new Uint32Array(sc.W * sc.H);
    sc.frame(sc.still, buf);
    put(`banners/${b.id}.png`, encodePNG(sc.W * 2, sc.H * 2, upscale(sc.W, sc.H, buf, 2)));
    const lw = 192;
    const lc = compile(b, { width: lw });
    lc.noIntro = true;
    const span = sc.animated === false ? 0 : Math.min(4, lc.loop || 24);
    const frs = (span ? frameTimes(lc.still, span) : [lc.still]).map((t) => { const f = new Uint32Array(lc.W * lc.H); lc.frame(t, f); return f; });
    loop(`banners/${b.id}.webp`, frs, lc.W, lc.H);
    // nameplate: the banner's window behind a list row, faded into classic's row colour (160×26 native)
    const pc = compile({ ...b, plateBg: '#1b1a1f' }, { width: 384 });
    pc.noIntro = true;
    const pw = 160;
    const ph = 26;
    const o = { w: pw, h: ph, x: b.focusX ?? 250, y: 18 };
    const plate = (t) => { const f = new Uint32Array(pw * ph); pc.plate(t, f, o); return f; };
    put(`nameplates/${b.id}.png`, encodePNG(pw * 2, ph * 2, upscale(pw, ph, plate(pc.still), 2)));
    loop(`nameplates/${b.id}.webp`, (span ? frameTimes(pc.still, Math.min(3, span)) : [pc.still]).map(plate), pw, ph);
  }
  log(`previews: ${banners.length} banners + nameplates`);

  // frames: the profile size (N 40 → 52 px with the overhang; still ×4 = 208 px), the loop with its intro and some idle
  for (const r of frames) {
    const sc = compileFrame(r, { N: 40 });
    sc.noIntro = true;
    const buf = new Uint32Array(sc.G * sc.G);
    sc.frame(sc.still, buf);
    put(`frames/${r.id}.png`, encodePNG(sc.G * 4, sc.G * 4, upscale(sc.G, sc.G, buf, 4)));
    const lc = compileFrame(r, { N: 40 });
    lc.noIntro = false;
    const intro = lc.intro ? lc.intro.dur : 0;
    const secs = Math.min(4, intro + (lc.animated ? 2.5 : 0.8));
    const frs = frameTimes(0, secs).map((t) => { const f = new Uint32Array(lc.G * lc.G); lc.frame(t, f); return f; });
    loop(`frames/${r.id}.webp`, frs, lc.G, lc.G);
  }
  log(`previews: ${frames.length} frames`);

  // launch animations: the GBA screen over the neutral placeholder game – the poster still (×2) and the whole run
  const L = LAYOUTS.gba;
  const game = placeholderCanvas('gba', fakeDoc()).px;
  for (const a of anims) {
    const env = { W: L.W, H: L.H, screens: L.screens, seed: 1 };
    const st = a.setup ? a.setup(env) : {};
    const lut = pal32(a.pal);
    const idx = new Uint8Array(L.W * L.H);
    const at = (t, r0) => {
      idx.fill(0);
      a.draw(idx, t, r0, st, env);
      const f = new Uint32Array(L.W * L.H);
      for (let i = 0; i < f.length; i++) f[i] = idx[i] ? lut[idx[i]] : game[i];
      return f;
    };
    // the still: the animation's own poster, or else its richest moment up to the reveal – the most of the screen
    // covered, in the most of its colours (a blank sheet or a bare game says nothing)
    let still = a.poster;
    if (still == null) {
      let best = -1;
      for (let t = 0; t <= a.revealAt + 1e-9; t += 1 / FPS) {
        idx.fill(0);
        a.draw(idx, t, a.revealAt, st, env);
        let n = 0;
        const cols = new Set();
        for (let i = 0; i < idx.length; i++) if (idx[i]) { n++; cols.add(idx[i]); }
        const score = n * cols.size;
        if (score > best) { best = score; still = t; }
      }
    }
    put(`launch/${a.id}.png`, encodePNG(L.W * 2, L.H * 2, upscale(L.W, L.H, at(still, a.revealAt), 2)));
    loop(`launch/${a.id}.webp`, [...frameTimes(0, a.dur), ...frameTimes(a.dur, 0.6)].map((t) => at(t, a.revealAt)), L.W, L.H);
  }
  log(`previews: ${anims.length} launch animations`);
  return files;
}

/** The app in every colour skin (Electron: scripts/plus-skin-shots.mjs) → skins/<id>.webp, 960×600. */
export function renderSkinPreviews({ skins, out, log = console.log }) {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-skinshots-'));
  try {
    writeFileSync(join(dir, 'skins.json'), JSON.stringify(skins.map((s) => ({ id: s.id, css: s.css }))));
    const electron = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'));
    const r = spawnSync(electron, [join(ROOT, 'scripts', 'plus-skin-shots.mjs'), dir], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 600000, env });
    if (r.status !== 0) throw new Error('could not render the skin previews');
    const files = [];
    mkdirSync(join(out, 'skins'), { recursive: true });
    for (const s of skins) {
      const png = join(dir, `${s.id}.png`);
      if (!existsSync(png)) throw new Error(`no skin preview for ${s.id}`);
      const target = join(out, 'skins', `${s.id}.webp`);
      const c = spawnSync('cwebp', ['-quiet', '-q', '82', '-m', '6', png, '-o', target]);
      if (c.status !== 0) throw new Error(`cwebp failed for ${s.id}`);
      files.push({ path: `skins/${s.id}.webp`, bytes: new Uint8Array(readFileSync(target)) });
    }
    log(`previews: ${skins.length} skins`);
    return files;
  } finally {
    for (const n of readdirSync(dir)) rmSync(join(dir, n), { recursive: true, force: true });
    rmdirSync(dir);
  }
}
