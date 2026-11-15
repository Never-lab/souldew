// PROTOTYPE (feat/play-layout) – three layout options for the big play view, for the owner to choose from. Not product
// code: switched on with localStorage 'sl-proto-layout' = 'a' | 'b' | 'c' (off without it – the view is unchanged).
//   A "Theatre"   – rail folds while playing, one info column on the right (folds to an icon strip), no header row
//   B "Immersive" – the game fills the window; info and partners float in the free space around the picture
//                   (translucent, foldable), the game bar shows on mouse move / pause and hides again
//   C "Adaptive dock" – one dock that sits where the picture leaves room: right of tall layouts, under wide ones
//                   (DS / 3DS side by side, 3DS large); nothing ever covers the game
// Demo flags for the screenshots: 'sl-proto-battle' (a wild battle on screen), 'sl-proto-attn' (an attention pop-up).
import { html, useState, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { useApp } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { othersOf, players as getPlayers } from '../lib/run.mjs';
import { arOf } from '../lib/pslayout.mjs';

const read = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

export const protoMode = () => (['a', 'b', 'c'].includes(read('sl-proto-layout')) ? read('sl-proto-layout') : null);
export const protoBattle = () => (read('sl-proto-battle') ? { kind: 'wild', enemy: { species: Number(read('sl-proto-battle')) > 1 ? Number(read('sl-proto-battle')) : 403, level: 6, hp: 21, maxHp: 23 }, foes: [], active: { index: 0 }, actives: [] } : null);
export const protoAttn = () => {
  try {
    return JSON.parse(read('sl-proto-attn') || 'null');
  } catch {
    return null;
  }
};

/** Dock/gutter side for the game's aspect `ar` in the play area: where the picture gets bigger. */
export function dockSide(area, ar, { dockW = 316, dockH = 214 } = {}) {
  if (!area?.w || !area?.h) return 'right';
  const fit = (w, h) => Math.max(0, Math.min(w, h * ar)) * Math.max(0, Math.min(h, w / ar));
  return fit(area.w, area.h - dockH) > fit(area.w - dockW, area.h) * 1.04 ? 'bottom' : 'right';
}

/** Size of an element (ResizeObserver). */
export function useSize(ref) {
  const [size, setSize] = useState(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const m = () => {
      const r = el.getBoundingClientRect();
      setSize((s) => (s && s.w === Math.round(r.width) && s.h === Math.round(r.height) ? s : { w: Math.round(r.width), h: Math.round(r.height) }));
    };
    m();
    const ro = new ResizeObserver(m);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref.current]);
  return size;
}

/** The partners' games as tiles in a row or column (B and C) – same pictures as the windows, no dragging. */
export function PartnerStrip({ link, system, dir = 'row', max = 200 }) {
  const { manifest, doc, me } = useApp() || {};
  const [views, setViews] = useState({});
  const others = manifest && me ? othersOf(me, manifest) : [];
  const names = manifest && doc ? getPlayers(doc, manifest) : manifest?.players || {};
  useEffect(() => {
    let demo = null;
    try {
      demo = JSON.parse(localStorage.getItem('sl-ps-demo') || 'null');
    } catch {}
    const offs = others.map((slot) => {
      if (demo?.[slot]) {
        setViews((v) => ({ ...v, [slot]: { mode: 'image', url: demo[slot].url, active: true, known: true, system: demo[slot].system } }));
        return null;
      }
      return link?.watchPartnerScreen?.((v) => setViews((all) => ({ ...all, [slot]: v })), slot);
    });
    return () => offs.forEach((off) => off?.());
  }, [link, others.join()]);
  if (!others.length) return null;
  return html`<div class=${`pstrip ${dir}`} role="group" aria-label=${t('ps.screens', 'Partner screens')}>
    ${others.map((slot, i) => {
      const v = views[slot];
      const ar = arOf(v?.system || system, 0);
      const style = dir === 'row' ? `height:${max}px;width:${Math.round((max - 32) * ar) + 12}px;--ar:${ar}` : `--ar:${ar};--tw:${max}px`;
      return html`<section class=${`pstile p${i + 2}`} key=${slot} style=${style}>
        <header><span class=${`ps-dot ${v?.active ? '' : 'off'}`}></span><b class="px">${names[slot]?.name || slot}</b><span class="spacer"></span>
          <button class="ps-btn" title=${t('ps.bigger', 'Bigger')}><${Icon} name="full" size=${11} /></button></header>
        <div class="pstile-pic">${v?.url ? html`<img src=${v.url} alt="" />` : html`<span class="ps-msg">${t('ps.noPicture', 'No picture from {name} right now', { name: names[slot]?.name || slot })}</span>`}</div>
      </section>`;
    })}
  </div>`;
}

/** "Something needs you": a pop-up over the top of the game that leaves by itself (A/B/C) – demo content. */
export function AttentionCard({ attn }) {
  if (!attn) return null;
  return html`<div class=${`attn ${attn.kind || 'death'}`} role="alert">
    <span class="attn-ico"><${Icon} name=${attn.kind === 'catch' ? 'link' : attn.kind === 'cap' ? 'signal' : 'grave'} size=${18} /></span>
    <div class="attn-text"><b>${attn.title}</b><span>${attn.text}</span></div>
    <button class="btn small ghost">${attn.action || t('proto.open', 'Show')}</button>
    <button class="ps-btn" title=${t('common.close', 'Close')}><${Icon} name="close" size=${12} /></button>
  </div>`;
}

/** A's folded column: one icon per section, with the dot that tells something changed there. */
export function SideRail({ onOpen, names, hasBattle, partners }) {
  const item = (icon, label, dot = '') => html`<button class=${`siderail-btn ${dot}`} title=${label} aria-label=${label} onClick=${onOpen}><${Icon} name=${icon} size=${18} /></button>`;
  return html`<nav class="siderail" aria-label=${t('proto.panels', 'Panels')}>
    <button class="siderail-btn open" title=${t('proto.showPanel', 'Show the panel (I)')} onClick=${onOpen}><${Icon} name="panelRight" size=${18} /></button>
    <span class="siderail-sep"></span>
    ${item('signal', t('proto.place', 'Where you are'))}
    ${item('link', t('pairs.titleGroup', 'Linked groups'), 'dot-warn')}
    ${hasBattle && item('candy', t('battle.title', 'Battle'), 'dot-live')}
    ${partners > 0 && html`<span class="siderail-sep"></span>`}
    ${Object.entries(names || {}).slice(1, 1 + partners).map(([s, p]) => html`<button class=${`siderail-who who-${s}`} title=${p.name} onClick=${onOpen}>${(p.name || s)[0]}</button>`)}
  </nav>`;
}

/** B: shows the floating bar while the mouse moves (or the game is paused), hides it after a moment of play. */
export function useIdle(ms = 2200) {
  const [idle, setIdle] = useState(false);
  const timer = useRef(0);
  useEffect(() => {
    const wake = () => {
      setIdle(false);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setIdle(true), ms);
    };
    wake();
    addEventListener('pointermove', wake);
    addEventListener('keydown', wake);
    return () => {
      clearTimeout(timer.current);
      removeEventListener('pointermove', wake);
      removeEventListener('keydown', wake);
    };
  }, []);
  return read('sl-proto-idle') === '1' ? true : read('sl-proto-idle') === '0' ? false : idle;
}
