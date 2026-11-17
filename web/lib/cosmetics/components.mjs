// ============================================================================================================
// STUB – replaced at merge by the real components of branch feat/plus-cosmetics (web/lib/cosmetics/components.mjs).
// Same names and props as the real module (its README › Components), drawn as plain placeholders so the profile,
// the editor and the friends list work and can be reviewed before the cosmetics land. Nothing here is premium content.
// ============================================================================================================
import { html } from '/vendor/htm-preact.mjs';

const tint = (id) => {
  let h = 0;
  for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};

export const useCosmetics = () => 0;
export const useVisibleSkin = () => null;
export const PlusMark = () => html`<span class="plus-mark" aria-label="souldew+">+</span>`;

/** <Banner id size="profile|friend|card|fill" shade /> – stub: a quiet two-tone wash per id. */
export function Banner({ id, size = 'profile', shade = false, class: cls = '', children }) {
  const h = tint(id || 'none');
  const bg = id ? `linear-gradient(180deg, hsl(${h} 32% 22%), hsl(${(h + 30) % 360} 28% 12%))` : 'linear-gradient(180deg, #24232b, #19181d)';
  return html`<div class=${`cos-stub cos-banner cos-banner--${size}${shade ? ' cos-shade' : ''}${cls ? ` ${cls}` : ''}`} data-banner=${id || ''} style=${`background:${bg}`}>${children}</div>`;
}

/** <Frame id size>{img, presence dot}</Frame> – the avatar box; stub: no frame drawn. */
export function Frame({ id, size = 40, class: cls = '', children }) {
  return html`<span class=${`cos-frame${cls ? ` ${cls}` : ''}`} style=${`--av:${size}px`} data-frame=${id || ''}>${children}</span>`;
}

export const useFrame = () => {};

/** <Nameplate id>{row content}</Nameplate> – a row with the nameplate behind it; stub: just the row. */
export function Nameplate({ id, class: cls = '', children, ...rest }) {
  return html`<div class=${`cos-nameplate${id ? ' has-plate' : ''}${cls ? ` ${cls}` : ''}`} data-nameplate=${id || ''} ...${rest}>${children}</div>`;
}

/** <CosmeticPicker kind="banners|frames|nameplates" value onPick(id, item) none /> – stub: the ids of the stub catalog. */
export function CosmeticPicker({ kind = 'banners', value = null, onPick, none = true }) {
  const items = STUB_ITEMS[kind] || [];
  return html`<div class=${`cos-stub cos-picker cos-picker--${kind}`} role="radiogroup">
    ${none && html`<button type="button" role="radio" aria-checked=${!value} class=${`cos-pick${!value ? ' on' : ''}`} onClick=${() => onPick?.(null, null)}><span class="cos-pick-name">–</span></button>`}
    ${items.map((it) => html`<button type="button" role="radio" aria-checked=${value === it.id} class=${`cos-pick${value === it.id ? ' on' : ''}${it.owned ? '' : ' locked'}`} onClick=${() => onPick?.(it.id, it)}>
      ${kind === 'banners' && html`<${Banner} id=${it.id} size="card" />`}<span class="cos-pick-name">${it.name}</span></button>`)}
  </div>`;
}

const STUB_ITEMS = {
  banners: [{ id: 'dusk-ridge', name: 'Dusk Ridge', owned: true }, { id: 'night-train', name: 'Night Train', owned: false }, { id: 'tall-grass', name: 'Tall Grass', owned: false }],
  frames: [{ id: 'plain-ring', name: 'Plain', owned: true }, { id: 'brass-ring', name: 'Brass Ring', owned: false }],
  nameplates: [{ id: 'chalk', name: 'Chalk', owned: true }, { id: 'night-train', name: 'Night Train', owned: false }],
};

export const owned = (kind, id) => !!(STUB_ITEMS[kind] || []).find((x) => x.id === id)?.owned;
