// The play view's souldew+ launch animation – the counterpart of views/cartinsert.mjs (which stays the free default).
// Mounted inside .console-screen next to the game's iframe: it covers the game box only (never the dock or the bar),
// adds no text, and plays from the moment the session opens while the core boots underneath. `ready` (the core's first
// frame) hands over: the iframe is visible UNDER the overlay and the animation's reveal uncovers the real picture – the
// game never waits for the animation. A click or any key skips it; reduced motion gets its still-then-dissolve form.
// Silent: the cartridge click isn't played under a launch animation.
import { html, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { playLaunch } from '../lib/cosmetics/index.mjs';

export function LaunchOverlay({ kind, system, dsLayout, ctrLayout, ready, onDone }) {
  const host = useRef(null);
  const ctl = useRef(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    ctl.current = playLaunch(host.current, kind, { system, dsLayout, ctrLayout, onDone: () => done.current?.() });
    if (!ctl.current) done.current?.(); // not available after all (the pack went away): no overlay, nothing waits
    return () => ctl.current?.destroy();
  }, []);
  useEffect(() => {
    if (ready) ctl.current?.ready();
  }, [ready]);
  return html`<div class="launch-host" ref=${host} aria-hidden="true"></div>`;
}
