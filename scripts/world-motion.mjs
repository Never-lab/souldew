// How smoothly a sprite moves on the picture (Shared World, docs/MULTIPLAYER.md › 9): the overlay's trace
// (web/lib/worldoverlay.mjs / worldds.mjs `trace(true)`) gives, per drawn picture, where each partner, partner follower
// and your own follower was drawn. A game's own sprites walk at a constant speed – one or two pixels every frame (the
// Game Boy games: two pixels every other frame) – so a sprite drawn by souldew must too: no frame that stands still
// and then catches up with a double step, no jump, no step back and forth.
//
//   node scripts/world-motion.mjs <trace.json> [<trace.json> …]   (prints the metrics of every sprite in it)
//
// Used by scripts/world-e2e.mjs --smooth and by the unit tests (test/worldsmooth.test.mjs).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The pictures as they were shown: one per animation frame (the last drawing in each – the overlay draws on every
 * animation frame and again when a game picture comes; the screen shows what was drawn last). `entries`: the trace.
 */
export function shown(entries) {
  const out = [];
  for (const e of entries) {
    if (out.length && e.v !== null && e.v !== undefined && out[out.length - 1].v === e.v) out[out.length - 1] = e;
    else out.push(e);
  }
  return out;
}

/**
 * One sprite's track through the shown pictures: [{ t, x, y }] or null where it wasn't drawn. `key`: the trace key
 * ('p2', 'f:p2' …); `world`: add the camera (the Game Boy Advance and Game Boy overlays trace it) – the position against
 * the map, which is what the eye follows while the background scrolls.
 */
export function track(entries, key, { world = true } = {}) {
  return entries.map((e) => {
    const a = e.at?.[key];
    if (!a) return { t: e.t, f: e.f, x: null, y: null };
    const cx = world && e.cam ? e.cam[0] : 0;
    const cy = world && e.cam ? e.cam[1] : 0;
    return { t: e.t, f: e.f, x: a[0] + cx, y: a[1] + cy };
  });
}

/**
 * The smoothness of a track ([{ x, y }], one per shown picture; null x: not drawn).
 * `cadence`: frames per move of the game (2: the Game Boy games move every other frame – a zero between two moves is
 * their rhythm, not a stall). Returns { frames, moving, steps (histogram of |step| in px), stalls (a frame standing
 * still inside a walk, followed by a catch-up step bigger than the walk's own), jumps (a step over `maxStep` px: 2
 * walking, more at the walk's own speed), backs (a step against the one before while the sprite goes straight on),
 * uneven (moving frames whose step differs from the walk's usual step by more than 1 px), offbeat (moves on an
 * animation frame without a new game picture) }.
 */
export function smoothness(tr, { cadence = 1, maxStep = 2 } = {}) {
  // (the game's frame numbers, where the trace has them: an animation frame without a new game picture, where
  // nothing moved, is the game standing still – not counted; two game frames in one shown picture count as two steps)
  const steps = [];
  let offbeat = 0;
  for (let i = 1; i < tr.length; i++) {
    const a = tr[i - 1];
    const b = tr[i];
    if (a.x === null || b.x === null) { steps.push(null); continue; }
    const df = Number.isFinite(a.f) && Number.isFinite(b.f) ? b.f - a.f : 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (df === 0 && !dx && !dy) continue;
    if (df === 0) offbeat++;
    const n = Math.max(1, Math.min(4, df));
    steps.push({ dx: dx / n, dy: dy / n, d: (Math.abs(dx) + Math.abs(dy)) / n });
  }
  const hist = {};
  let moving = 0;
  let stalls = 0;
  let jumps = 0;
  let backs = 0;
  let uneven = 0;
  const events = [];
  // the walk's usual step: the most common non-zero step among the moving frames
  const nz = steps.filter((s) => s && s.d > 0).map((s) => Math.round(s.d));
  const counts = {};
  for (const d of nz) counts[d] = (counts[d] || 0) + 1;
  const usual = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 1);
  const limit = Math.max(maxStep, usual * 1.5);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s) continue;
    const k = Math.round(s.d);
    hist[k] = (hist[k] || 0) + 1;
    if (s.d > 0) moving++;
    // a stall: standing still between moves (more than the game's cadence allows), then a step bigger than usual
    if (s.d === 0) {
      let before = 0;
      for (let j = i - 1; j >= 0 && j >= i - cadence; j--) if (steps[j]?.d > 0) { before = steps[j].d; break; }
      let run = 1;
      while (steps[i + run] && steps[i + run].d === 0) run++;
      const after = steps[i + run];
      if (before > 0 && after && after.d > usual + 0.5 && run >= cadence) {
        stalls++;
        events.push({ i, kind: 'stall', run, after: after.d });
      }
      continue;
    }
    if (s.d > limit) {
      jumps++;
      events.push({ i, kind: 'jump', d: s.d });
    }
    const p = steps[i - 1];
    const q = steps[i + 1];
    if (p && q && p.d > 0 && q.d > 0 && s.dx * p.dx + s.dy * p.dy < 0 && q.dx * p.dx + q.dy * p.dy > 0) {
      backs++;
      events.push({ i, kind: 'back' });
    }
    if (cadence === 1 && Math.abs(s.d - usual) > 1 && s.d <= limit) uneven++;
  }
  return { frames: tr.length, moving, usual, steps: hist, stalls, jumps, backs, uneven, offbeat, events: events.slice(0, 40) };
}

/** Every sprite key in a trace. */
export const keysOf = (entries) => [...new Set(entries.flatMap((e) => Object.keys(e.at || {})))];

/** All metrics of a trace (`trace`: { entries, marks?, gen? }): per scenario (between marks) and sprite. */
export function report(trace, { cadence = 1 } = {}) {
  const ents = shown(trace.entries || trace);
  const marks = trace.marks || [{ name: 'all', from: -Infinity, to: Infinity }];
  const out = {};
  for (const m of marks) {
    const part = ents.filter((e) => e.t >= m.from && e.t <= m.to);
    const r = {};
    for (const key of keysOf(part)) {
      const tr = track(part, key, { world: !trace.ds });
      if (tr.filter((p) => p.x !== null).length < 10) continue;
      r[key] = smoothness(tr, { cadence });
    }
    out[m.name] = r;
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const f of process.argv.slice(2)) {
    const tr = JSON.parse(readFileSync(f, 'utf8'));
    const rep = report(tr, { cadence: tr.cadence || 1 });
    for (const [name, sprites] of Object.entries(rep)) {
      for (const [key, m] of Object.entries(sprites)) console.log(f, name, key, JSON.stringify({ frames: m.frames, moving: m.moving, usual: m.usual, steps: m.steps, stalls: m.stalls, jumps: m.jumps, backs: m.backs, uneven: m.uneven, offbeat: m.offbeat }));
    }
  }
}
