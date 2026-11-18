// "Your handheld" where you meet it (the owner's decision after round 6: under Settings alone it gets lost):
//   HandheldTile      a compact tile in the library's header – a small still of your device in its current design and
//                     the design's name; a click opens the editor (#/handheld). Members and non-members alike; a quiet
//                     "+" says more skins and stickers come with souldew+ – no ad.
//   HandheldShowcase  the souldew+ page's featured section – your device, live and turning slowly, "Dress your handheld",
//                     Surprise me, the skins and stickers. The editor itself stays in Settings › Play › Launch animation.
//   HandheldStillImg  one still of your handheld (the launch scene, rendered once, then the GPU is let go).
import { html, useEffect, useRef, useState } from '/vendor/htm-preact.mjs';
import { t } from '../lib/i18n.mjs';
import { useApp } from '../lib/ui.mjs';
import { packState } from '../lib/cosmetics/index.mjs';
import { PlusMark } from '../lib/cosmetics/components.mjs';
import { prefersReduced } from '../lib/cosmetics/motion.mjs';
import { previewSrc, usePreviews } from '../lib/cosmetics/previews.mjs';
import { WRAPS, STICKERS, UNLOCKS, launchLook, wrapById, devKey } from '/shared/handheld.mjs';
import { useHandheld, setHandheld, handheldStill, launchConfig, poseScene, viewPlan, isFold, useCosmeticsTick } from '../lib/handheld/look.mjs';
import { placeLayout } from '../lib/handheld/geometry.mjs';
import { atlasNow, loadAtlas } from '../lib/handheld/stickers.mjs';
import { wrapThumb } from '../lib/handheld/wrap.mjs';

const DEV = ['gba', 'nds', '3ds', 'gb'];

/** A still of your handheld as an <img> (cached per look while the app runs). */
export function HandheldStillImg({ sys, look, skin, stickers, w, h, view, zoom, class: cls = '' }) {
  useCosmeticsTick();
  const box = useRef(null);
  const [url, setUrl] = useState(null);
  const [, setAtlas] = useState(null);
  useEffect(() => { let a = true; loadAtlas().then((x) => a && setAtlas(x), () => {}); return () => { a = false; }; }, [packState().entitled]);
  useEffect(() => {
    let alive = true;
    handheldStill({ sys, look, skin, stickers, w, h, el: box.current, view, zoom }).then((u) => alive && setUrl(u), () => {});
    return () => { alive = false; };
  }, [sys, look, skin, JSON.stringify(stickers), w, h, view, packState().entitled, atlasNow() ? 1 : 0]);
  return html`<span class=${`hh-still ${cls}`} ref=${box}>${url ? html`<img src=${url} alt="" draggable="false" />` : html`<span class="hh-still-wait"></span>`}</span>`;
}

/** What the handheld wears, in a few words: the worn design's name, else the skin's, else "your theme colour". */
function wearing(doc) {
  const d = doc.designs.find((x) => x.id === doc.active);
  if (doc.surprise && doc.designs.length > 1) return t('hh.surpriseShort', 'Surprise me · {n} designs', { n: doc.designs.length });
  if (d) return d.name;
  return wrapById(doc.skin)?.name || t('hh.themeColourCap', 'Theme colour');
}

/** The library header's tile. `system`: the device to show (the game you play most recently), DS without one. */
export function HandheldTile({ system }) {
  const { navigate, status } = useApp();
  const doc = useHandheld();
  const sys = devKey(system) || 'nds';
  const L = launchConfig(status?.config);
  const member = !!packState().entitled;
  const look = launchLook(L.look).tier === 'plus' && !member ? 'theme' : launchLook(L.look).look;
  return html`<button type="button" class="hh-tile" onClick=${() => navigate('handheld', { sys })} title=${t('hh.dress', 'Dress your handheld')}>
    <${HandheldStillImg} sys=${sys} look=${look} skin=${doc.skin} stickers=${doc.stickers[sys] || []} w=${84} h=${52} zoom=${2.6} class="hh-tile-pic" />
    <span class="hh-tile-txt"><span class="hh-tile-k">${t('hh.title', 'Your handheld')}${!member && html` <${PlusMark} title=${t('hh.plusQuiet', 'More skins and stickers come with souldew+')} />`}</span>
      <b class="ellipsis">${wearing(doc)}</b></span>
  </button>`;
}

/** The souldew+ page's featured section: your device turning slowly, the way into the editor, Surprise me. */
export function HandheldShowcase() {
  useCosmeticsTick();
  usePreviews();
  const { navigate, status } = useApp();
  const doc = useHandheld();
  const member = !!packState().entitled;
  const [sys, setSys] = useState('nds');
  const box = useRef(null), cvs = useRef(null);
  const L = launchConfig(status?.config);
  const look = launchLook(L.look).tier === 'plus' && !member ? 'theme' : launchLook(L.look).look;
  const stickers = doc.stickers[sys] || [];
  useEffect(() => {
    let alive = true, scene = null, raf = 0, io = null, seen = true;
    const reduced = prefersReduced();
    const fold = isFold(sys);
    const yaw = { v: fold ? -10 : -24 };
    const cv = document.createElement('canvas'); // one per build (a WebGL context belongs to its canvas)
    cvs.current.replaceChildren(cv);
    (async () => {
      const b = box.current.getBoundingClientRect();
      const r = await poseScene(cv, { sys, look, skin: doc.skin, w: Math.round(b.width), h: Math.round(b.height), el: box.current, reduced, clear: L.clear,
        plan: () => viewPlan(sys, fold ? 'lid' : 'back', { yaw: yaw.v, tilt: fold ? 4 : 2, zoom: 1.45 }) });
      scene = r.scene;
      if (!alive) { scene.dispose(); return; }
      scene.setStickers(placeLayout(stickers, scene.regions(), r.atlas?.rects || {}));
      scene.render(0);
      if (reduced) return;
      io = new IntersectionObserver((es) => { seen = es.some((e) => e.isIntersecting); });
      io.observe(box.current);
      const t0 = performance.now();
      let last = 0;
      const tick = (now) => { // slow: a full turn in about 40 s, drawn at 30 fps, never while off screen
        if (!alive) return;
        if (seen && now - last > 32) { last = now; yaw.v = (fold ? -10 : -24) + ((now - t0) / 1000) * 9; scene.render(now - t0); }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })().catch(() => {});
    return () => { alive = false; cancelAnimationFrame(raf); io?.disconnect(); scene?.dispose(); };
  }, [sys, look, doc.skin, JSON.stringify(stickers), packState().entitled, L.clear]);
  const skins = WRAPS.map((w) => ({ ...w, pic: wrapThumb(w.id) || previewSrc('wraps', w.id) }));
  const nPlus = STICKERS.filter((s) => s.tier === 'plus').length;
  return html`<section class="plus-sec hh-show" aria-label=${t('hh.title', 'Your handheld')}>
    <div class="hh-show-stage" ref=${box}><span class="hh-show-cv" ref=${cvs}></span>
      <div class="hh-devs hh-show-devs" role="tablist" aria-label=${t('hh.device', 'Handheld')}>${DEV.map((id) => html`<button type="button" role="tab" aria-selected=${sys === id}
        class=${`hh-dev ${sys === id ? 'on' : ''}`} onClick=${() => setSys(id)}>${{ gba: 'GBA', nds: 'DS', '3ds': '3DS', gb: 'GB' }[id]}</button>`)}</div></div>
    <div class="hh-show-text stack-s">
      <span class="plus-kicker">${t('hh.showK', 'Your handheld')}</span>
      <h2>${t('hh.showT', 'Dress the device your games start on')}</h2>
      <p class="small muted">${t('hh.showP', 'Your launch animation plays on your own souldew handheld. Wrap it in a skin made from a banner, stick on up to 8 stickers per device – holo, glitter, over the edges – and save designs. Only you see it.')}</p>
      <div class="hh-show-skins" aria-label=${t('hh.skins', 'Skins')}>${skins.map((w) => html`<span class=${`hh-show-skin ${w.finish}`} title=${w.name} style=${w.pic ? `background-image:url(${w.pic})` : ''}>${w.tier === 'free' && html`<i>${t('hh.free', 'free')}</i>`}</span>`)}</div>
      <span class="small faint">${t('hh.showCounts', '{skins} skins · {stickers} stickers · {earned} you can only earn', { skins: WRAPS.length, stickers: STICKERS.length, earned: UNLOCKS.length })}${member ? '' : ` · ${t('hh.showPlus', '{n} stickers, 6 skins and holo / glitter come with souldew+', { n: nPlus })}`}</span>
      <div class="row hh-show-btns"><button type="button" class="btn primary" onClick=${() => navigate('handheld', { sys })}>${t('hh.dress', 'Dress your handheld')}</button>
        <label class="check small"><input type="checkbox" checked=${!!doc.surprise} disabled=${doc.designs.length < 2} onChange=${(e) => setHandheld({ ...doc, surprise: e.target.checked })} />
          <span>${t('hh.surprise', 'Surprise me at start')}<span class="hint">${doc.designs.length < 2 ? t('hh.surpriseHint0', 'Save two designs or more and every launch picks one of them.') : t('hh.surpriseHint', 'Every launch picks one of your designs at random.')}</span></span></label></div>
    </div>
  </section>`;
}
