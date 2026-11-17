// Launch animations: the timing contract (first frame early / late / never, skip, reduced motion) on the pure timeline,
// and the worker host that plays an animation from the pack against it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimeline, EARLY_RATE, SKIP_MS, REDUCED_MS, HOLD_CAP } from '../web/lib/cosmetics/launch/timeline.mjs';

/** runs a timeline at 60 fps (ms = the time after each step); events: [[ms, 'ready' | 'skip']]; returns { endMs, frames } */
function run(tl, events = [], maxMs = 30000) {
  const frames = [];
  const todo = [...events];
  for (let n = 0; (n * 1000) / 60 <= maxMs; n++) {
    const ms = ((n + 1) * 1000) / 60;
    while (todo.length && ms >= todo[0][0]) {
      const [, ev] = todo.shift();
      if (ev === 'ready') tl.markReady(ms);
      else tl.skip(ms);
    }
    const f = tl.step(1 / 60, ms);
    frames.push({ ms, ...f });
    if (f.done) return { endMs: ms, frames };
  }
  return { endMs: Infinity, frames };
}
const FRAME = 1000 / 60 + 1;

const anim = { dur: 1.95, revealAt: 0.6 };

test('first frame on time: cover, then the reveal, done at dur', () => {
  const { endMs, frames } = run(createTimeline(anim), [[600, 'ready']]);
  assert.ok(Math.abs(endMs - 1950) < FRAME, `done at ${endMs}`);
  assert.ok(Math.abs(frames.find((f) => f.r0 !== Infinity).r0 - 0.6) < 0.02, 'the reveal starts at revealAt');
});

test('first frame EARLY: the rest of the cover plays faster, the reveal starts sooner', () => {
  const { endMs } = run(createTimeline(anim), [[100, 'ready']]);
  // 0.1 s at 1×, then (0.6 − 0.1) / 1.6 for the cover, then the 1.35 s reveal
  const expect = (0.1 + 0.5 / EARLY_RATE + 1.35) * 1000;
  assert.ok(Math.abs(endMs - expect) < FRAME && endMs < 1950, `done at ${endMs}, expected ≈ ${expect}`);
});

test('first frame LATE: the cover keeps moving (no frozen picture), the reveal starts when the frame is there', () => {
  const { endMs, frames } = run(createTimeline(anim), [[2600, 'ready']]);
  const waiting = frames.filter((f) => f.ms > 700 && f.ms < 2550);
  assert.ok(waiting.every((f) => f.r0 === Infinity && !f.still), 'ambient motion while waiting');
  assert.ok(waiting[waiting.length - 1].t > waiting[0].t + 1.5, 'the clock keeps running');
  const r0 = frames.find((f) => f.r0 !== Infinity).r0;
  assert.ok(Math.abs(r0 - 2.6) < 0.04, `r0 ${r0}`);
  assert.ok(Math.abs(endMs - (2600 + 1350)) < 2 * FRAME, `done at ${endMs}`);
});

test('no first frame at all: the reveal starts by itself after HOLD_CAP – the overlay never holds the game back', () => {
  const { endMs } = run(createTimeline(anim));
  assert.ok(Math.abs(endMs - (HOLD_CAP + 1.35) * 1000) < 60, `done at ${endMs}`);
});

test('skip: whatever is on screen dissolves in SKIP_MS, before or after the first frame', () => {
  const a = run(createTimeline(anim), [[300, 'skip']]);
  assert.ok(a.endMs - 300 <= SKIP_MS + FRAME, `done ${a.endMs - 300} ms after the key`);
  const cuts = a.frames.filter((f) => f.ms >= 300).map((f) => f.cut);
  assert.ok(cuts.every((c, i) => i === 0 || c >= cuts[i - 1]), 'the dissolve only grows');
  const b = run(createTimeline(anim), [[200, 'ready'], [1000, 'skip']]);
  assert.ok(b.endMs - 1000 <= SKIP_MS + FRAME);
});

test('reduced motion: one still frame until the first game frame, then four whole dissolve steps', () => {
  const tl = createTimeline({ ...anim, reduced: true });
  const { endMs, frames } = run(tl, [[1200, 'ready']]);
  const before = frames.filter((f) => f.ms < 1200);
  assert.ok(before.every((f) => f.still && f.cut === 0 && f.t === 0.6), 'a still of the cover');
  const steps = [...new Set(frames.filter((f) => f.ms >= 1200).map((f) => f.cut))];
  assert.deepEqual(steps, [0.25, 0.5, 0.75, 1]);
  assert.ok(endMs - 1200 <= REDUCED_MS + FRAME && endMs - 1200 >= REDUCED_MS * 0.7, `dissolve took ${endMs - 1200} ms`);
  const skipped = run(createTimeline({ ...anim, reduced: true }), [[400, 'skip']]);
  assert.ok(skipped.endMs - 400 <= SKIP_MS + FRAME, 'skip works in reduced motion too');
});

// ---- the worker host, with a stand-in worker scope and OffscreenCanvas
test('worker host: plays a pack animation into the canvas and reports done; missing ids end at once', async () => {
  const posted = [];
  let onmessage = null;
  globalThis.self = { postMessage: (m) => posted.push(m), set onmessage(fn) { onmessage = fn; }, get onmessage() { return onmessage; } };
  let puts = 0;
  const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: () => puts++, clearRect() {} }) };
  const draws = [];
  const tiny = { id: 'tiny', name: 'Tiny', dur: 0.4, revealAt: 0.1, pal: ['#112233'], setup: (env) => ({ n: env.W }), draw: (buf, t, r0) => { draws.push([t, r0]); if (t < 0.3) buf.fill(1); } };
  const { host } = await import('../web/lib/cosmetics/launch/worker-host.mjs');
  host([tiny, { id: 'old', cut: 'reason', dur: 1, revealAt: 0.5, pal: [], draw() {} }]);
  assert.deepEqual(posted.shift(), { op: 'ready', ids: ['tiny'] }, 'cut animations are not offered');
  onmessage({ data: { op: 'play', anim: 'nope', canvas } });
  assert.equal(posted.shift().op, 'missing');
  onmessage({ data: { op: 'play', anim: 'tiny', canvas, layout: 'ds-tb', reduced: false } });
  assert.equal(posted.shift().op, 'started');
  assert.deepEqual([canvas.width, canvas.height], [256, 384], 'drawn on the game’s own pixel grid');
  onmessage({ data: { op: 'ready' } });
  const t0 = Date.now();
  while (!posted.some((m) => m.op === 'done') && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
  const done = posted.find((m) => m.op === 'done');
  assert.ok(done, 'done reported');
  assert.ok(puts >= 3 && done.stats.frames === puts, `${puts} frames presented`);
  assert.ok(draws.every(([t]) => t <= 0.4 + 1e-9));
  delete globalThis.self;
});
