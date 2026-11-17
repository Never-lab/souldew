// souldew+ in Settings: the Theme row (General › Appearance, under the colour schemes) and the Launch animation row
// (Play). A theme is tried on the whole app with one click and reverts when you leave Settings or press "Back to …";
// it changes the look only, never the layout or a text. The machinery is web/lib/cosmetics (skins.mjs, launch/).
import { html, useState, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { t } from '../../lib/i18n.mjs';
import { listSkins, previewSkin, endPreview, applySkin, skinState, onSkinChange, packState, previewLaunch, launchAvailable, catalog } from '../../lib/cosmetics/index.mjs';
import { useCosmetics, PlusMark } from '../../lib/cosmetics/components.mjs';
import { openPlus } from '../../lib/cosmetics/plus.mjs';
import { CartInsert } from '../cartinsert.mjs';
import { Icon } from '../../lib/icons.mjs';

function useSkinState() {
  const [s, setS] = useState(skinState);
  useEffect(() => onSkinChange(setS), []);
  return s;
}

function SkinCard({ skin, compact, on, previewing, onClick }) {
  return html`<button type="button" role="radio" aria-checked=${on} data-skin-preview=${skin.id} title=${compact ? skin.hint : undefined}
    class=${`theme-card skin-card${compact ? ' compact' : ''}${on ? ' on' : ''}${previewing ? ' previewing' : ''}`} onClick=${onClick}>
    <span class="theme-swatches" aria-hidden="true">${skin.sw.map((c) => html`<i class="sw" style=${`background:${c}`}></i>`)}</span>
    <b>${skin.name}</b>${!compact && html`<span class="hint">${skin.hint}</span>`}
    ${skin.plus && html`<${PlusMark} />`}
  </button>`;
}

/** Settings › General › Appearance › Theme. save({ skin }) persists the committed choice. */
export function SkinSetting({ cfg, save }) {
  useCosmetics();
  const s = useSkinState();
  const pack = packState();
  const [locked, setLocked] = useState(null); // a souldew+ theme that can't be previewed here (no pack, no preview)
  const skins = listSkins();
  const byId = Object.fromEntries(skins.map((k) => [k.id, k]));
  // leaving Settings puts your theme back – a preview is never saved
  useEffect(() => () => endPreview(), []);
  const committed = s.committed;
  const shown = s.previewing || committed;
  const pick = (k) => {
    setLocked(null);
    if (k.id === committed && !s.previewing) return;
    if (k.id === committed) return endPreview();
    if (!previewSkin(k.id)) setLocked(k.id);
  };
  const keep = async (id) => {
    if (!byId[id]?.owned) return openPlus({ reason: 'skin', id });
    applySkin(id);
    endPreview();
    await save({ skin: id === 'classic' ? null : id });
  };
  const previewName = s.previewing ? byId[s.previewing]?.name : null;
  const backName = byId[committed]?.name || 'souldew';
  const group = (label, list, compact) => html`<div class="skin-group">
    <span class="skin-group-label small faint">${label}</span>
    <div class=${`theme-picker skin-picker${compact ? ' compact' : ''}`} role="radiogroup" aria-label=${label}>
      ${list.map((k) => html`<${SkinCard} key=${k.id} skin=${k} compact=${compact} on=${k.id === (locked || shown)} previewing=${!!s.previewing && k.id === s.previewing}
        onClick=${() => pick(k)} />`)}
    </div></div>`;
  const lockedName = locked ? byId[locked]?.name : null;
  return html`<div class="stack-s skin-setting">
    <h3 class="skin-picker-head">${t('skin.title', 'Theme')} <span class="plus-mark" aria-hidden="true"><${Icon} name="plus" size=${10} /></span></h3>
    <p class="small muted">${t('skin.note', 'Changes the look, never the layout. Click a theme to try it on the whole app – leaving Settings puts yours back.')}</p>
    ${previewName && html`<div class="skin-preview-bar" role="status">
      <span class="led amber on" aria-hidden="true"></span>
      <span>${t('skin.previewing', 'Previewing {name} – nothing is saved.', { name: '\u0000' }).split('\u0000').flatMap((part, i) => (i ? [html`<b>${previewName}</b>`, part] : [part]))}</span>
      <span class="spacer"></span>
      <button type="button" class="btn small ghost" onClick=${() => endPreview()}>${t('skin.back', 'Back to {name}', { name: backName })}</button>
      <button type="button" class="btn small go" onClick=${() => keep(s.previewing)}>${byId[s.previewing]?.owned
        ? t('skin.keep', 'Keep {name}', { name: previewName }) : t('skin.keepPlus', 'Keep {name} with souldew+', { name: previewName })}</button>
    </div>`}
    ${lockedName && html`<div class="skin-preview-bar" role="status">
      <${PlusMark} />
      <span>${pack.loading ? t('skin.loading', 'Loading souldew+ themes …') : t('skin.lockedText', '{name} comes with souldew+.', { name: lockedName })}</span>
      <span class="spacer"></span>
      <button type="button" class="btn small ghost" onClick=${() => setLocked(null)}>${t('skin.back', 'Back to {name}', { name: backName })}</button>
      ${!pack.loading && html`<button type="button" class="btn small go" onClick=${() => openPlus({ reason: 'skin', id: locked })}>${t('skin.getPlus', 'Get souldew+')}</button>`}
    </div>`}
    ${group(t('skin.editions', 'Editions'), skins.filter((k) => k.group === 'editions'), false)}
    ${group(t('skin.dark', 'Colours · dark'), skins.filter((k) => k.group === 'dark'), true)}
    ${group(t('skin.light', 'Colours · light'), skins.filter((k) => k.group === 'light'), true)}
    ${cfg.skin && s.pending && !pack.loading && !pack.entitled && html`<p class="small faint">${t('skin.pending', 'Your theme {name} is back as soon as souldew+ is active on this computer again.', { name: byId[s.pending]?.name || s.pending })}</p>`}
  </div>`;
}

/** Settings › Play › Launch animation: the free cartridge plus the souldew+ animations this account owns. */
export function LaunchSetting({ cfg, save }) {
  useCosmetics();
  const pack = packState();
  const all = catalog().launch;
  const choices = all.filter((a) => a.id === 'cartridge' || (a.owned && launchAvailable(a.id)));
  const value = choices.some((a) => a.id === cfg.launchAnimation) ? cfg.launchAnimation : 'cartridge';
  const [playing, setPlaying] = useState(null);
  const screen = useRef(null);
  const ctl = useRef(null);
  const animsOff = cfg.bootAnimation === false;
  const stop = () => {
    ctl.current?.destroy();
    ctl.current = null;
    setPlaying(null);
  };
  useEffect(() => stop, []);
  const preview = (id) => {
    stop();
    if (id === 'cartridge') return setPlaying('cartridge');
    if (!screen.current) return undefined;
    ctl.current = previewLaunch(screen.current, id, { loop: false });
    setPlaying(id);
    // the preview ends with its animation: the screen shows the placeholder "game" until the next one
    return undefined;
  };
  const pick = async (id) => {
    preview(id);
    if (id !== value) await save({ launchAnimation: id });
  };
  const name = (a) => (a.id === 'cartridge' ? t('launch.cartridge', 'Cartridge') : a.name);
  return html`<div class="stack-s">
    <span class="launch-title">${t('launch.title', 'Launch animation')}</span>
    <div class="launch-picker">
      <div class="launch-cards" role="radiogroup" aria-label=${t('launch.title', 'Launch animation')}>
        ${choices.map((a) => html`<button key=${a.id} type="button" role="radio" aria-checked=${a.id === value}
          class=${`launch-card${a.id === value ? ' on' : ''}`} onClick=${() => pick(a.id)}>
          <b>${name(a)}</b><span class="hint">${a.id === 'cartridge' ? t('launch.cartridgeHint', 'The module drops into the slot – free') : a.collection}</span>
        </button>`)}
      </div>
      <div class="launch-stage">
        <div class="launch-screen" ref=${screen} aria-hidden="true">
          ${playing === 'cartridge' && html`<${CartInsert} target=${{ system: 'gba', label: 'souldew', params: {} }} sound=${false} onDone=${() => setPlaying(null)} />`}
        </div>
        <button type="button" class="btn small ghost" onClick=${() => preview(value)}><${Icon} name="play" size=${14} />${t('launch.preview', 'Preview')}</button>
      </div>
    </div>
    <span class="small faint">${animsOff ? t('launch.off', 'Animations are switched off (General › Play animations) – the game starts without one.')
      : t('launch.hint', 'Plays over the game screen while the game starts – it never makes the game wait. A click or any key skips it.')}</span>
    ${!pack.entitled && html`<span class="small faint plus-note"><${PlusMark} /> ${t('launch.more', 'More launch animations come with souldew+.')}</span>`}
  </div>`;
}
