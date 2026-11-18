// Settings › Play › Launch animation (design round 6): the launch family – "Your colours" (free) and the souldew+ shells,
// Gold, Clear shell (four colours) and Holo label – with Full / Quick / Off, and under the choice the device it plays
// with: "Your handheld" – a still of it, its sticker counts per device, "Dress your handheld" (the editor,
// web/views/handheld.mjs) and "Preview". Rare start isn't a pick: one start in 64 is one, for members.
import { html, useState, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { t } from '../../lib/i18n.mjs';
import { useApp } from '../../lib/ui.mjs';
import { packState } from '../../lib/cosmetics/index.mjs';
import { useCosmetics, PlusMark } from '../../lib/cosmetics/components.mjs';
import { openPlus } from '../../lib/cosmetics/plus.mjs';
import { Icon } from '../../lib/icons.mjs';
import { FavScope } from '../../lib/favourites.mjs';
import { LAUNCH_LOOKS, CLEAR_TINTS, STICKER_MAX, wrapById, launchLook } from '/shared/handheld.mjs';
import { useHandheld, launchConfig, CLEAR, useCosmeticsTick, ownedLook, playableLook } from '../../lib/handheld/look.mjs';
import { LaunchPreview } from '../launchstage.mjs';
import { DEVICE_TABS, devName, lookName } from '../handheld.mjs';
import { HandheldStillImg } from '../handheldtile.mjs';

export const launchNames = () => ({
  'your-colours': [t('launch.yourColours', 'Your colours'), t('launch.yourColoursHint', 'Your handheld in your theme’s colours – or its skin')],
  'clear-shell': [t('launch.clear', 'Clear shell'), t('launch.clearHint', 'See-through plastic, the board lit inside')],
  gold: [t('launch.gold', 'Gold'), t('launch.goldHint', 'A gold shell and a gold cartridge')],
  holo: [t('launch.holo', 'Holo label'), t('launch.holoHint', 'A holographic label on the cartridge')],
});
const clearName = (k) => ({ atomic: t('launch.clearAtomic', 'Atomic purple'), smoke: t('launch.clearSmoke', 'Smoke'), ice: t('launch.clearIce', 'Ice'), jungle: t('launch.clearJungle', 'Jungle') })[k];

/** Settings › Play › Launch animation. */
export function LaunchSetting({ cfg, save }) {
  useCosmetics();
  const member = !!packState().entitled;
  const L = launchConfig(cfg);
  const names = launchNames();
  const [sys, setSys] = useState('nds');
  const [playing, setPlaying] = useState(0);
  const known = LAUNCH_LOOKS.map((l) => l.id);
  const pick = async (id) => {
    if (launchLook(id).tier === 'plus' && !member) return openPlus({ reason: 'launch', id });
    if (id !== cfg.launchAnimation) await save({ launchAnimation: id });
    setPlaying((n) => n + 1);
  };
  const animsOff = cfg.bootAnimation === false;
  const paces = [['full', t('launch.full', 'Full')], ['quick', t('launch.quick', 'Quick')], ['off', t('launch.offPace', 'Off')]];
  return html`<div class="stack-s launch-setting">
    <div class="row launch-head"><span class="launch-title">${t('launch.title', 'Launch animation')}</span><span class="spacer"></span>
      <div class="seg small" role="radiogroup" aria-label=${t('launch.length', 'Length')}>${paces.map(([k, n]) => html`<button type="button" role="radio" aria-checked=${L.pace === k}
        class=${L.pace === k ? 'on' : ''} onClick=${() => save({ launchPace: k })}>${n}</button>`)}</div></div>
    <div class="launch-cards hhs-cards" role="radiogroup" aria-label=${t('launch.title', 'Launch animation')}>
      ${LAUNCH_LOOKS.map((l) => html`<${FavScope} key=${l.id} kind="launch" id=${l.id} name=${names[l.id][0]} known=${known} class="launch-fav"><button type="button" role="radio"
        aria-checked=${l.id === L.look} class=${`launch-card${l.id === L.look ? ' on' : ''}`} onClick=${() => pick(l.id)}>
        <b>${names[l.id][0]}</b><span class="hint">${names[l.id][1]}</span>${l.tier === 'plus' && !member && html`<${PlusMark} />`}
        ${l.id === 'clear-shell' && html`<span class="hhs-tints" role="radiogroup" aria-label=${t('launch.clearColour', 'Colour of the shell')}>${Object.keys(CLEAR_TINTS).map((k) => html`<span role="radio" tabIndex=${member ? 0 : -1}
          aria-checked=${L.clear === k} title=${clearName(k)} aria-label=${clearName(k)} class=${`hhs-tint ${L.clear === k ? 'on' : ''}`} style=${`--tc:${CLEAR[k]}`}
          onClick=${(e) => { e.stopPropagation(); if (member) save({ launchAnimation: 'clear-shell', launchClear: k }).then(() => setPlaying((n) => n + 1)); else openPlus({ reason: 'launch', id: 'clear-shell' }); }}
          onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}></span>`)}</span>`}
      </button><//>`)}
    </div>
    <span class="small faint">${animsOff ? t('launch.off', 'Animations are switched off (General › Play animations) – the game starts without one.')
      : L.pace === 'off' ? t('launch.offHint', 'Off: the game starts without an animation.')
        : t('launch.hint3', 'Plays over the game screen while the game starts – it never makes the game wait, and it is silent. A click or any key skips it. With reduced motion (your system’s setting) it is a short fade, with your handheld in it.')}</span>
    ${launchLook(L.look).tier === 'plus' && !member && !packState().loading && html`<span class="small faint">${t('launch.pending', '{name} plays again as soon as souldew+ is active on this computer – until then your launch plays Your colours.', { name: names[L.look][0] })}</span>`}
    ${member ? html`<span class="small faint">${t('launch.rare', 'souldew+: one start in 64 is a Rare start – golden light, glints and a little dust.')}</span>`
      : html`<span class="small faint plus-note"><${PlusMark} /> ${t('launch.more3', 'Gold, Clear shell, Holo label and the Rare start come with souldew+.')}</span>`}
    <${HandheldRow} cfg=${cfg} sys=${sys} setSys=${setSys} play=${playing} onPreview=${() => setPlaying((n) => n + 1)} />
  </div>`;
}

/** "Your handheld" under the choice: a still of it, the device tabs, what it wears, the way into the editor. */
function HandheldRow({ cfg, sys, setSys, play, onPreview }) {
  useCosmeticsTick();
  const { navigate } = useApp();
  const doc = useHandheld();
  const L = launchConfig(cfg);
  const V = launchLook(playableLook(L.look)); // a souldew+ shell without souldew+: the still shows what the launch plays
  const shellOnly = V.look === 'clear' || V.look === 'gold';
  // what it wears right now: a souldew+ skin or sticker only while souldew+ is active (kept in the handheld either way)
  const own = ownedLook(doc);
  const skin = wrapById(own.skin);
  const kept = (doc.skin && !own.skin) || Object.keys(doc.stickers).some((d) => (doc.stickers[d] || []).length !== (own.stickers[d] || []).length);
  const n = (d) => (own.stickers[d] || []).length;
  const active = doc.designs.find((d) => d.id === doc.active);
  const [showing, setShowing] = useState(false);
  const first = useRef(play);
  useEffect(() => { if (play !== first.current) setShowing(true); }, [play]);
  return html`<div class="hhs-hand">
    <div class="hhs-still">${showing ? html`<${LaunchPreview} key=${`${play}-${sys}`} cfg=${L} system=${sys} onDone=${() => setShowing(false)} />`
      : html`<${HandheldStillImg} sys=${sys} look=${V.look} skin=${own.skin} stickers=${own.stickers[sys] || []} w=${340} h=${210} />`}</div>
    <div class="hhs-text stack-s">
      <h3>${t('hh.title', 'Your handheld')}</h3>
      <span class="small muted">${t('hh.lead', 'The device your launch animation plays with. One skin for all of them, stickers for each – up to {n}. Only you see it: it isn’t on your profile.', { n: STICKER_MAX })}</span>
      <div class="hh-devs hhs-devs" role="tablist" aria-label=${t('hh.device', 'Handheld')}>${DEVICE_TABS.map((id) => html`<button type="button" role="tab"
        aria-selected=${sys === id} class=${`hh-dev ${sys === id ? 'on' : ''}`} onClick=${() => { setSys(id); setShowing(false); }}>${devName(id)}${n(id) ? html`<span class="hh-dev-n">${n(id)}</span>` : ''}</button>`)}</div>
      <span class="small">${devName(sys)} · ${shellOnly ? t('hh.onShell', '{shell} (no skin on it)', { shell: lookName(L.look) }) : skin ? skin.name : t('hh.themeColour', 'your theme colour')} · ${n(sys)
        ? t('hh.stickerCount', 'one sticker|{count} stickers', { count: n(sys) }) : t('hh.noStickers', 'no stickers yet')}</span>
      ${doc.designs.length > 0 && html`<span class="small faint">${t('hh.designCount', 'one saved design|{count} saved designs', { count: doc.designs.length })}${doc.surprise && doc.designs.length > 1
        ? ` · ${t('hh.surpriseOn', 'Surprise me at start: a different one each launch')}` : active ? ` · ${t('hh.wearing', 'wearing “{name}”', { name: active.name })}` : ''}</span>`}
      ${kept && !packState().loading && html`<span class="small faint">${t('hh.keptPlus', 'Your souldew+ skin and stickers are kept – they’re back on it as soon as souldew+ is active on this computer again.')}</span>`}
      ${shellOnly && skin && html`<span class="small faint">${t('hh.shellNote2', '{skin} shows with “Your colours” and Holo label; with {shell}, your stickers do.', { skin: skin.name, shell: lookName(L.look) })}</span>`}
      <div class="hhs-btns"><button type="button" class="btn primary" onClick=${() => navigate('handheld', { sys })}>${t('hh.dress', 'Dress your handheld')}</button>
        <button type="button" class="btn ghost" disabled=${L.off && cfg.bootAnimation === false} onClick=${onPreview}><${Icon} name="play" size=${14} />${t('launch.preview', 'Preview')}</button></div>
    </div>
  </div>`;
}

