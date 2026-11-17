// The launch animation's timing contract – a pure state machine, so it is the same in the worker that draws and in the
// tests that check it (no DOM, no clock of its own: the caller passes the time).
//
//   the cover runs from 0 to revealAt; the reveal from r0 to r0 + (dur − revealAt), r0 = revealAt normally;
//   first frame EARLY (before revealAt): the rest of the cover plays at 1.6× – the reveal starts sooner;
//   first frame LATE: the cover keeps its ambient motion and the reveal starts the moment the frame is there (r0 = then);
//   no first frame after HOLD_CAP s: the reveal starts anyway (the game is never held back by the overlay);
//   skip (click / key): whatever is on the overlay dissolves in SKIP_MS (ordered whole pixels);
//   reduced motion: one still of the cover, then a REDUCED_MS dissolve in four whole steps once the frame is there.
export const EARLY_RATE = 1.6;
export const SKIP_MS = 160;
export const REDUCED_MS = 200;
export const HOLD_CAP = 20;

export function createTimeline({ dur, revealAt, reduced = false, poster = null }) {
  const revealLen = dur - revealAt;
  let t = 0, r0 = Infinity, isReady = false, readyAt = 0, skipAt = 0, done = false;
  const api = {
    get ready() { return isReady; },
    get done() { return done; },
    /** the first game frame is there (now: ms) */
    markReady(now) {
      if (isReady) return;
      isReady = true;
      readyAt = now;
    },
    /** click / key (now: ms) */
    skip(now) {
      if (!skipAt) skipAt = now;
    },
    /**
     * Advances by dt seconds at time now (ms). Returns what to draw: { t, r0, cut, done, still }.
     * still: the frame doesn't change (reduced motion before the hand-over) – the caller need not redraw.
     */
    step(dt, now) {
      if (done) return { t, r0, cut: 1, done, still: true };
      const cutSkip = skipAt ? Math.min(1, (now - skipAt) / SKIP_MS) : 0;
      if (reduced) {
        const at = poster ?? revealAt;
        if (!isReady && !skipAt) return { t: at, r0: Infinity, cut: 0, done: false, still: true };
        const from = isReady ? readyAt : skipAt;
        const k = Math.max(cutSkip, Math.min(1, Math.floor(((now - from) / REDUCED_MS) * 4 + 1) / 4)); // four whole steps
        done = k >= 1;
        return { t: at, r0: Infinity, cut: k, done, still: false };
      }
      t += dt * (isReady && t < revealAt ? EARLY_RATE : 1);
      if (!isReady && t >= HOLD_CAP) api.markReady(now);
      if (isReady && r0 === Infinity) r0 = Math.max(revealAt, t);
      const shown = Math.min(t, r0 + revealLen);
      done = cutSkip >= 1 || t >= r0 + revealLen;
      return { t: shown, r0, cut: cutSkip, done, still: false };
    },
  };
  return api;
}
