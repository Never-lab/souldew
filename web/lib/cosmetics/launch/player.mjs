// Launch animations in the page: an OffscreenCanvas over the game box, drawn by a worker that runs the pack's signed
// launch module (sandbox.mjs, worker-host.mjs). The free default – the cartridge sliding into the slot – stays the app's
// own CartInsert (views/cartinsert.mjs); playLaunch() is only for the souldew+ animations.
//
//   const h = playLaunch(gameBox, id, { onDone, firstFrame, layout | system/dsLayout/ctrLayout, reduced })
//   h.ready()     the core reported its first frame (or pass firstFrame: a Promise / true)
//   h.skip()      click / any key – also wired up here
//   h.destroy()   the play view closed
// The game is never held back: the core boots underneath from the start, the overlay only decides when its picture
// shows; if anything goes wrong (worker fails, animation missing) the overlay ends at once, and it can't outlast
// HOLD_CAP + its own length.
import { startWorker } from '../sandbox.mjs';
import { content } from '../state.mjs';
import { prefersReduced } from '../motion.mjs';
import { layoutKey, LAYOUTS } from './engine.mjs';
import { HOLD_CAP } from './timeline.mjs';
import { placeholderCanvas } from './placeholder.mjs';

export { layoutKey };
/** Is this souldew+ animation loaded and usable right now? ('cartridge' is the app's own and never "available" here.) */
export const launchAvailable = (id) => id !== 'cartridge' && !!content.launchModule && content.launchIds.has(id);

export function playLaunch(gameBox, id, opts = {}) {
  if (!gameBox || !launchAvailable(id)) return null;
  const layout = opts.layout || layoutKey(opts.system, opts.dsLayout, opts.ctrLayout);
  const reduced = opts.reduced ?? prefersReduced();
  const cv = document.createElement('canvas');
  cv.className = 'cos-launch';
  cv.setAttribute('aria-hidden', 'true');
  cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:4;image-rendering:pixelated;image-rendering:crisp-edges;cursor:default';
  gameBox.appendChild(cv);
  const worker = startWorker({ hostModule: 'launch/worker-host.mjs', packText: content.launchModule, packExport: 'ANIMS', name: 'souldew-launch' });
  let finished = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const stats = { setupMs: 0 };
  const finish = (why) => {
    if (finished) return;
    finished = true;
    clearTimeout(safety);
    removeEventListener('keydown', onKey, true);
    cv.removeEventListener('click', skip);
    worker.terminate();
    cv.remove();
    resolveDone(why);
    try {
      opts.onDone?.(why);
    } catch (e) {
      console.error(e);
    }
  };
  worker.onmessage = (e) => {
    const m = e.data || {};
    if (m.op === 'started') stats.setupMs = m.setupMs;
    else if (m.op === 'done') { Object.assign(stats, m.stats); finish('done'); }
    else if (m.op === 'missing' || m.op === 'error') finish(m.op);
  };
  worker.onerror = () => finish('error');
  const off = cv.transferControlToOffscreen();
  worker.postMessage({ op: 'play', canvas: off, anim: id, layout: LAYOUTS[layout] ? layout : 'gba', reduced, seed: opts.seed || 1 }, [off]);
  const dur = 3; // longest animation in the set is 2.25 s
  const safety = setTimeout(() => finish('timeout'), (HOLD_CAP + dur + 2) * 1000);
  const ready = () => { if (!finished) worker.postMessage({ op: 'ready' }); };
  const skip = () => { if (!finished) worker.postMessage({ op: 'skip' }); };
  const onKey = () => skip();
  addEventListener('keydown', onKey, { capture: true, once: true });
  cv.addEventListener('click', skip);
  if (opts.firstFrame === true) ready();
  else opts.firstFrame?.then?.(ready, ready);
  return { ready, skip, done, stats, canvas: cv, destroy: () => finish('destroyed') };
}

/**
 * Settings preview: the animation over our neutral placeholder picture in `box`, the "first frame" arriving after
 * `readyAfter` ms, again and again while `loop`. Returns { destroy }. Cartridge is shown by the caller.
 */
export function previewLaunch(box, id, { layout = 'gba', loop = true, readyAfter = 350, reduced } = {}) {
  let stopped = false;
  let h = null;
  let timer = 0;
  let readyTimer = 0;
  const pic = placeholderCanvas(layout);
  pic.className = 'cos-launch-game';
  pic.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;image-rendering:pixelated';
  box.prepend(pic);
  const run = () => {
    if (stopped) return;
    h = playLaunch(box, id, {
      layout, reduced,
      firstFrame: new Promise((r) => { readyTimer = setTimeout(r, readyAfter); }),
      onDone: (why) => { if (loop && !stopped && why === 'done') timer = setTimeout(run, 1100); },
    });
  };
  run();
  return {
    get playing() { return !!h; },
    destroy() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(readyTimer);
      h?.destroy();
      pic.remove();
    },
  };
}
