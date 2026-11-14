// Partner screens: the other players' games, live, while you play – each partner in a window of its own over the
// play area (two players: one window, three or four: one per partner at once). A window moves by its header and
// resizes from its corner grip (the picture keeps its aspect), snaps lightly to the edges and to the other windows,
// never leaves the play area and is remembered per run and partner (position, size, hidden) on this computer. The
// layout button below the right column switches between a stack in that column (the start) and small tiles in the
// game's corner; "Reset layout" brings back the start. A hidden window leaves a tab there to bring it back.
// The layout math lives in lib/pslayout.mjs.
//
// Picture transport lives in SyncLink (lib/sync.mjs): WebRTC video when the direct link to that partner is up, small
// encrypted stills every ~1.5 s over the relay otherwise. Only shown windows watch – a hidden one costs nothing, as
// does the game in the corner (this view isn't there then).
//
// Nothing here takes the keyboard or the controller from the game: presses keep the focus in the game frame
// (keepFocus) and the windows are plain page content, not dialogs – the controller reaches their buttons only when
// it is the app's anyway (lib/padnav.mjs: game paused, a menu open …).
import { html, useState, useEffect, useLayoutEffect, useRef } from '/vendor/htm-preact.mjs';
import { useApp } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { othersOf, players as getPlayers } from '../lib/run.mjs';
import {
  GAP, arOf, defaultWidth, snapRect, resizeRect, resizeAnchored, gripSide, toStored, fromStored, columnLayout, columnHeight,
  cornerLayout, runLayout, winState, updateRun, isCustom,
} from '../lib/pslayout.mjs';

const PREF = 'sl-partnerscreen'; // per computer – see lib/pslayout.mjs (runLayout)
const STALE_MS = 20000; // a still picture older than this means the partner stopped sending
const DOCK_H = 30; // the row with the layout buttons and the tabs of hidden windows (.ps-dock)

function loadPref() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF) || '{}');
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

function savePref(p) {
  try {
    localStorage.setItem(PREF, JSON.stringify(p));
  } catch {
    // private mode
  }
}

/** Screen source for SyncLink.startScreenShare() backed by the emulator iframe's window.__emu. */
export function emuScreenSource(getEmu, system) {
  const emu = () => {
    try {
      const e = getEmu?.();
      return e?.ready ? e : null;
    } catch {
      return null; // iframe navigated away
    }
  };
  return {
    system,
    getStream: () => emu()?.captureStream?.(15) || null,
    getSnapshot: (opts) => emu()?.snapshot?.(opts) || null,
    isActive: () => {
      const e = emu();
      return !!e && !e.paused();
    },
  };
}

/** Shares our game picture with the partners while `enabled` (re-attaches when the link is replaced). */
export function useScreenShare(link, getEmu, { system, enabled = true } = {}) {
  const ref = useRef(getEmu);
  ref.current = getEmu;
  useEffect(() => {
    if (!link || !enabled || !link.startScreenShare) return undefined;
    link.startScreenShare(emuScreenSource(() => ref.current?.(), system));
    return () => link.stopScreenShare();
  }, [link, enabled, system]);
}

/** Watches one partner's picture while mounted – one per shown window, so hiding one never disturbs the others. */
function Watch({ link, slot, onView }) {
  const cb = useRef(onView);
  cb.current = onView;
  useEffect(() => {
    if (!link?.watchPartnerScreen) return undefined;
    return link.watchPartnerScreen((v) => cb.current(slot, v), slot);
  }, [link, slot]);
  return null;
}

// Clicking here must not take the keyboard away from the game iframe.
const keepFocus = (e) => e.preventDefault();

/** A rectangle of `el` relative to the layer. */
function relRect(el, base) {
  const r = el.getBoundingClientRect();
  return { x: r.left - base.left, y: r.top - base.top, w: el.clientWidth || r.width, h: r.height };
}

/**
 * All partner windows of the run, over the play area (mount it as a child of .session-body).
 *   link      – the current SyncLink (useApp().link)
 *   system    – our own system: the aspect of a window until its first picture arrives
 *   onReserve – (px) room the windows stacked in the right column take at its bottom: the column keeps that much free
 *               space under its content, so everything in it can be scrolled into view above them
 */
export function PartnerScreens({ link, system, onReserve }) {
  const { manifest, doc, me } = useApp() || {};
  const [pref, setPref] = useState(loadPref);
  const [views, setViews] = useState({});
  const [measured, setMeasured] = useState({}); // slot → width / height of the picture actually received
  const [zones, setZones] = useState(null);
  const [drag, setDrag] = useState(null);
  const [, tick] = useState(0);
  const layer = useRef(null);

  const runId = manifest?.id;
  const others = manifest && me ? othersOf(me, manifest) : link?.others || [];
  const names = manifest && doc ? getPlayers(doc, manifest) : manifest?.players || {};
  const nameOf = (slot) => names[slot]?.name || slot.toUpperCase();
  const layout = runLayout(pref, runId);
  const change = (fn) => {
    const next = updateRun(pref, runId, fn);
    setPref(next);
    savePref(next);
  };
  const setWin = (slot, patch) => change((l) => ({ ...l, wins: { ...l.wins, [slot]: { ...(l.wins[slot] || {}), ...patch } } }));

  // The play area and the parts of it the presets use, measured whenever any of them changes size.
  useLayoutEffect(() => {
    const el = layer.current;
    const body = el?.parentElement;
    if (!body) return undefined;
    const measure = () => {
      const base = el.getBoundingClientRect();
      const side = body.querySelector(':scope > .session-side');
      const stage = body.querySelector(':scope > .session-stage');
      const area = { w: Math.round(base.width), h: Math.round(base.height) };
      if (!area.w || !area.h) return;
      const col = side ? relRect(side, base) : { x: area.w - 260, y: 0, w: 260, h: area.h };
      const st = stage ? relRect(stage, base) : { x: 0, y: 0, w: area.w, h: area.h };
      const next = { area, col, stage: st };
      setZones((z) => (JSON.stringify(z) === JSON.stringify(next) ? z : next));
    };
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (ro) for (const x of [el, body.querySelector(':scope > .session-side'), body.querySelector(':scope > .session-stage')]) if (x) ro.observe(x);
    addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      removeEventListener('resize', measure);
    };
  }, []);

  const onView = (slot, v) => setViews((all) => ({ ...all, [slot]: v }));
  const state = Object.fromEntries(others.map((s) => [s, winState(layout, s)]));
  const shownSlots = others.filter((s) => !state[s].hidden);

  // what each shown window shows
  const now = Date.now();
  const info = {};
  for (const slot of shownSlots) {
    const view = views[slot];
    const stream = view?.mode === 'stream' ? view.stream : null;
    const imageMode = view?.mode === 'image' && !!view.url;
    const age = imageMode ? now - view.at : 0;
    const live = !!view?.active && (!!stream || (imageMode && age < STALE_MS));
    // only claim anything when the partner's app can share at all (it told us its state once)
    if (!live && !view?.known) continue;
    info[slot] = { view, stream, imageMode, age, live, ar: arOf(view?.system || system, measured[slot]) };
  }
  const windows = shownSlots.filter((s) => info[s]);

  // Still pictures: the age label ticks (and notices when they stop coming).
  const anyImages = windows.some((s) => info[s].imageMode);
  useEffect(() => {
    if (!anyImages) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [anyImages]);

  // Where every window is: dragged → where the pointer has it; moved before → remembered; else the preset.
  const rects = {};
  let reserve = 0;
  const dockShown = windows.length > 0 || others.some((s) => state[s].hidden);
  if (zones) {
    const { area, col, stage } = zones;
    const colZone = { ...col, h: Math.max(0, col.h - DOCK_H - GAP) };
    const follow = windows.filter((s) => !state[s].stored && drag?.slot !== s).map((id) => ({ id, ar: info[id].ar }));
    const preset = layout.preset === 'corner' ? cornerLayout(follow, stage, area) : columnLayout(follow, colZone, area);
    for (const slot of windows) {
      if (drag?.slot === slot) rects[slot] = drag.rect;
      else if (state[slot].stored) rects[slot] = fromStored(state[slot].stored, info[slot].ar, area);
      else rects[slot] = preset[slot];
    }
    if (layout.preset === 'column' && follow.length) reserve += columnHeight(preset) + GAP;
    if (dockShown) reserve += DOCK_H + GAP;
  }
  const reserveRef = useRef(-1);
  useEffect(() => {
    if (reserveRef.current === reserve) return;
    reserveRef.current = reserve;
    onReserve?.(reserve);
  });
  useEffect(() => () => onReserve?.(0), []);

  /** Pointer down on a window's header (move) or its grip (resize): follows the pointer until it is let go. */
  const startDrag = (e, slot, kind) => {
    if (e.button !== 0 || !zones || !rects[slot]) return;
    if (kind === 'move' && e.target.closest('button')) return;
    const el = e.currentTarget;
    const { area, col } = zones;
    const start = rects[slot];
    const ar = info[slot].ar;
    const others0 = windows.filter((s) => s !== slot).map((s) => rects[s]);
    const guides = { x: [col.x], y: [col.y + col.h - DOCK_H - GAP] };
    const d = { slot, kind, start, rect: start, side: gripSide(start, area), moved: false };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // the pointer is already gone
    }
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      const dx = ev.clientX - e.clientX;
      const dy = ev.clientY - e.clientY;
      if (!d.moved && Math.hypot(dx, dy) < 3) return; // a click, not a drag
      d.moved = true;
      d.rect = kind === 'move' ? snapRect({ ...start, x: start.x + dx, y: start.y + dy }, others0, area, { guides }) : resizeRect(start, dx, dy, ar, area, d.side);
      setDrag({ ...d });
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
      if (d.moved) setWin(slot, toStored(d.rect, area));
      setDrag(null);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  };

  // (the layer stays even without a link: it is measured once when it mounts)
  const custom = isCustom(layout);
  const toCorner = layout.preset !== 'corner';
  const presetLabel = toCorner ? t('ps.layoutCorner', 'Tile the screens in the corner of the game') : t('ps.layoutColumn', 'Stack the screens in the right column');
  const hiddenSlots = others.filter((s) => state[s].hidden);
  const col = zones?.col;
  return html`<div class=${`ps-layer ${drag ? 'dragging' : ''}`} ref=${layer}>
    ${link && shownSlots.map((slot) => html`<${Watch} key=${slot} link=${link} slot=${slot} onView=${onView} />`)}
    ${zones && windows.map((slot) => html`<${PartnerWindow} key=${slot} slot=${slot} name=${nameOf(slot)} info=${info[slot]} rect=${rects[slot]}
      area=${zones.area} dragging=${drag?.slot === slot} grip=${gripSide(rects[slot], zones.area)} system=${system}
      onMeasure=${(ar) => setMeasured((m) => (Math.abs((m[slot] || 0) - ar) > 0.01 ? { ...m, [slot]: ar } : m))}
      onDrag=${(e, kind) => startDrag(e, slot, kind)}
      onSize=${(r) => setWin(slot, toStored(r, zones.area))}
      onHide=${() => setWin(slot, { hidden: true })} />`)}
    ${zones && dockShown && html`<div class="ps-dock" role="group" aria-label=${t('ps.screens', 'Partner screens')}
      style=${`right:${Math.max(0, zones.area.w - (col.x + col.w))}px;bottom:${Math.max(0, zones.area.h - (col.y + col.h))}px;max-width:${Math.max(120, col.w)}px`}>
      ${hiddenSlots.map((slot) => html`<button class="ps-tab" onMouseDown=${keepFocus} onClick=${() => setWin(slot, { hidden: false })}
        title=${t('ps.show', 'Show {name}’s screen', { name: nameOf(slot) })}><span class="ps-dot" aria-hidden="true"></span><span class="ellipsis">${t('ps.showShort', '{name}’s screen', { name: nameOf(slot) })}</span></button>`)}
      <span class="spacer"></span>
      ${windows.length > 0 && html`<button class="ps-btn" onMouseDown=${keepFocus} title=${presetLabel} aria-label=${presetLabel}
        onClick=${() => change((l) => ({ preset: toCorner ? 'corner' : 'column', wins: Object.fromEntries(Object.entries(l.wins).map(([s, w]) => [s, { hidden: !!w?.hidden }])) }))}>
        <${Icon} name=${toCorner ? 'tiles' : 'stack'} size=${12} /></button>`}
      ${custom && html`<button class="ps-btn" onMouseDown=${keepFocus} title=${t('ps.reset', 'Reset layout')} aria-label=${t('ps.reset', 'Reset layout')}
        onClick=${() => change(() => ({ preset: 'column', wins: {} }))}><${Icon} name="reset" size=${12} /></button>`}
    </div>`}
  </div>`;
}

/** One partner's window: header (drag to move, Bigger / Smaller, Hide), the picture, and the resize grip. */
function PartnerWindow({ name, info, rect, area, dragging, grip, onMeasure, onDrag, onSize, onHide }) {
  const { view, stream, imageMode, age, live, ar } = info;
  const video = useRef(null);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (stream) el.play?.().catch(() => {});
  }, [stream, live]);

  const measure = (w, h) => w && h && onMeasure(w / h);
  const secs = Math.round(age / 1000);
  const fresh = !!stream || secs < 4;
  const big = rect.w >= defaultWidth(ar, true) - 1;
  const sizeLabel = big ? t('ps.smaller', 'Smaller') : t('ps.bigger', 'Bigger');
  const message = !view?.known
    ? t('ps.noPicture', 'No picture from {name} right now', { name })
    : view.active
      ? t('ps.connecting', 'Connecting to {name}’s picture …', { name })
      : view.paused
        ? t('ps.paused', '{name}’s game is in a background tab – no picture right now', { name })
        : t('ps.notPlaying', '{name} isn’t playing right now', { name });
  return html`<section class=${`ps ${dragging ? 'is-dragging' : ''}`} aria-label=${t('ps.title', '{name}’s game', { name })} onMouseDown=${keepFocus}
    style=${`left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px`}>
    <header class="ps-head" title=${t('ps.moveHint', 'Drag to move')} onPointerDown=${(e) => onDrag(e, 'move')}>
      <span class=${`ps-dot ${!live ? 'off' : fresh ? '' : 'stale'}`} aria-hidden="true"></span>
      <b class="px ps-name">${name}</b>
      ${live && html`<span class="ps-age mono">${fresh ? t('ps.live', 'live') : t('ps.ago', '{n} s ago', { n: secs })}</span>`}
      <span class="spacer"></span>
      <button class="ps-btn" onMouseDown=${keepFocus} onClick=${() => onSize(resizeAnchored(rect, defaultWidth(ar, !big), ar, area))} aria-pressed=${big}
        title=${sizeLabel} aria-label=${sizeLabel}><${Icon} name=${big ? 'shrink' : 'full'} size=${12} /></button>
      <button class="ps-btn" onMouseDown=${keepFocus} onClick=${onHide} title=${t('ps.hide', 'Hide')} aria-label=${t('ps.hide', 'Hide')}><${Icon} name="close" size=${12} /></button>
    </header>
    <div class="ps-screen">
      ${live && stream && html`<video ref=${video} autoplay muted playsinline disablepictureinpicture
        onLoadedMetadata=${(e) => measure(e.target.videoWidth, e.target.videoHeight)} onResize=${(e) => measure(e.target.videoWidth, e.target.videoHeight)}></video>`}
      ${live && !stream && imageMode && html`<img src=${view.url} alt=${t('ps.alt', 'What {name} sees right now', { name })} onLoad=${(e) => measure(e.target.naturalWidth, e.target.naturalHeight)} />`}
      ${!live && html`<span class="ps-msg" role="status">${message}</span>`}
    </div>
    <span class=${`ps-grip ${grip}`} title=${t('ps.resize', 'Drag to resize')} aria-hidden="true" onPointerDown=${(e) => onDrag(e, 'resize')}></span>
  </section>`;
}
