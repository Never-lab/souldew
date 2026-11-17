// Runs inside the launch worker (sandbox.mjs): plays one launch animation from the pack's signed module into an
// OffscreenCanvas over the game screen, on its own animation frames – so a busy page (the core booting) can't make it
// stutter, and the pack's code never runs in the page.
//
// Messages in:  { op: 'play', canvas, anim, layout, reduced, seed, poster? } · { op: 'ready' } · { op: 'skip' }
//               { op: 'stop' } · { op: 'seek', t, r0?, cut? } (previews, tests)
// Messages out: { op: 'ready', ids } · { op: 'started', setupMs } · { op: 'done', stats } · { op: 'missing' }
//               { op: 'error', message }
import { LAYOUTS, pal32, od } from './engine.mjs';
import { createTimeline } from './timeline.mjs';

const raf = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(() => fn(performance.now()), 16));
const caf = (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));

export function host(anims) {
  const byId = new Map(anims.filter((a) => a && typeof a.id === 'string' && !a.cut).map((a) => [a.id, a]));
  let cur = null;

  function stop() {
    if (cur) caf(cur.raf);
    cur = null;
  }

  function play(m) {
    stop();
    const anim = byId.get(m.anim);
    if (!anim || !m.canvas) {
      self.postMessage({ op: 'missing' });
      return;
    }
    const L = LAYOUTS[m.layout] || LAYOUTS.gba;
    const { W, H, screens } = L;
    const env = { W, H, screens, seed: m.seed || 1, layout: m.layout };
    const cv = m.canvas;
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(W, H);
    const out = new Uint32Array(img.data.buffer);
    const buf = new Uint8Array(W * H);
    const lut = pal32(anim.pal);
    let mask = null;
    const area = screens.reduce((a, s) => a + s.w * s.h, 0);
    if (area < W * H) {
      mask = new Uint8Array(W * H);
      for (const s of screens) for (let y = s.y; y < s.y + s.h; y++) mask.fill(1, y * W + s.x, y * W + s.x + s.w);
    }
    const t0 = performance.now();
    let setupState;
    try {
      setupState = anim.setup ? anim.setup(env) : {};
    } catch (e) {
      self.postMessage({ op: 'error', message: String(e?.message || e) });
      return;
    }
    const stats = { setupMs: performance.now() - t0, frames: 0, ms: 0, max: 0 };
    const tl = createTimeline({ dur: anim.dur, revealAt: anim.revealAt, reduced: !!m.reduced, poster: anim.poster ?? null });
    const present = (t, r0, cut) => {
      const a = performance.now();
      buf.fill(0);
      anim.draw(buf, t, r0, setupState, env);
      if (mask) for (let i = 0; i < buf.length; i++) if (!mask[i]) buf[i] = 0;
      if (cut > 0) for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) if (buf[i] && !od(x, y, 1 - cut)) buf[i] = 0;
      for (let i = 0; i < buf.length; i++) out[i] = lut[buf[i]];
      ctx.putImageData(img, 0, 0);
      const ms = performance.now() - a;
      stats.frames++;
      stats.ms += ms;
      if (ms > stats.max) stats.max = ms;
    };
    cur = { tl, raf: 0, present, last: performance.now(), drewStill: false, stats };
    self.postMessage({ op: 'started', setupMs: stats.setupMs });
    if (m.manual) return; // seek-only (tests, stills)
    const tick = (now) => {
      if (!cur || cur.tl !== tl) return;
      const dt = Math.min(0.1, (now - cur.last) / 1000);
      cur.last = now;
      let f;
      try {
        f = tl.step(dt, now);
        if (!f.still || !cur.drewStill) present(f.t, f.r0, f.cut);
        cur.drewStill = f.still;
      } catch (e) {
        self.postMessage({ op: 'error', message: String(e?.message || e) });
        stop();
        return;
      }
      if (f.done) {
        ctx.clearRect(0, 0, W, H);
        self.postMessage({ op: 'done', stats });
        stop();
        return;
      }
      cur.raf = raf(tick);
    };
    cur.raf = raf((n) => { cur.last = n; tick(n); });
  }

  self.onmessage = (e) => {
    const m = e.data || {};
    if (m.op === 'play') play(m);
    else if (m.op === 'ready') cur?.tl.markReady(performance.now());
    else if (m.op === 'skip') cur?.tl.skip(performance.now());
    else if (m.op === 'stop') stop();
    else if (m.op === 'seek') cur?.present(m.t, m.r0 ?? byId.get(m.anim)?.revealAt ?? Infinity, m.cut || 0);
  };
  self.postMessage({ op: 'ready', ids: [...byId.keys()] });
}
