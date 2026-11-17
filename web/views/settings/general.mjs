// Settings › General: language, name, start-up animations, app sounds, the welcome tour, the colour scheme.
import { html, useState, useEffect } from '/vendor/htm-preact.mjs';
import { t, LANGS, setLang, currentLang } from '../../lib/i18n.mjs';
import { applyTheme } from '../../lib/theme.mjs';
import { Item, Group, Check } from './parts.mjs';

const THEMES = () => [
  ['classic', t('theme.classic', 'Classic'), t('theme.classicHint', 'Dark, the original colours')],
  ['contrast', t('theme.contrast', 'High contrast'), t('theme.contrastHint', 'Black background, brighter text and edges')],
  ['deutan', t('theme.deutan', 'Red-green safe'), t('theme.deutanHint', 'For deuteranopia / protanopia: blue and orange instead of green and red')],
  ['tritan', t('theme.tritan', 'Blue-yellow safe'), t('theme.tritanHint', 'For tritanopia: teal and magenta instead of blue and yellow')],
];

/** Colour scheme cards (Settings and the welcome tour); a pick applies at once. */
export function ThemePicker({ value, onPick }) {
  const cur = value || 'classic';
  return html`<div class="theme-picker" role="radiogroup" aria-label=${t('set.theme', 'Colour scheme')}>
    ${THEMES().map(([id, name, hint]) => html`<button type="button" role="radio" aria-checked=${cur === id}
      class=${`theme-card ${cur === id ? 'on' : ''}`} data-theme-preview=${id} onClick=${() => { applyTheme(id); onPick(id); }}>
      <span class="theme-swatches" aria-hidden="true"><i class="sw ok"></i><i class="sw bad"></i><i class="sw warn"></i><i class="sw p1"></i><i class="sw p2"></i><i class="sw p3"></i><i class="sw p4"></i></span>
      <b>${name}</b><span class="hint">${hint}</span></button>`)}
  </div>`;
}

function NameField({ cfg, save }) {
  const [name, setName] = useState(cfg.playerName || '');
  useEffect(() => setName(cfg.playerName || ''), [cfg.playerName]);
  const changed = name.trim() !== (cfg.playerName || '');
  return html`<label class="field"><span>${t('set.name', 'Your name')}</span>
    <div class="row nowrap"><input type="text" class="grow" value=${name} maxLength="20" onInput=${(e) => setName(e.target.value)}
      onKeyDown=${(e) => e.key === 'Enter' && changed && save({ playerName: name.trim() })} />
    <button class="btn" disabled=${!changed} onClick=${() => save({ playerName: name.trim() })}>${t('common.save', 'Save')}</button></div></label>`;
}

export function GeneralSection({ cfg, save }) {
  return html`
    <${Group} title=${t('set.basics', 'Basics')}>
      <div class="grid-2">
        <${Item} id="language"><label class="field"><span>${t('set.language', 'Language')}</span>
          <select value=${currentLang()} onChange=${async (e) => { await setLang(e.target.value); await save({ lang: e.target.value }); }}>
            ${LANGS.map((l) => html`<option value=${l.id}>${l.native}</option>`)}</select></label><//>
        <${Item} id="name"><${NameField} cfg=${cfg} save=${save} /><//>
      </div>
      <${Item} id="animations"><${Check} checked=${cfg.bootAnimation !== false} onChange=${(v) => save({ bootAnimation: v })}
        label=${t('set.boot', 'Play animations (start-up, inserting the cartridge)')} /><//>
      <${Item} id="sounds"><${Check} checked=${cfg.sounds !== false} onChange=${(v) => save({ sounds: v })}
        label=${t('set.soundsAll', 'Sounds on this computer (start-up chime, catches, deaths, badges, pings)')} /><//>
      <${Item} id="tour"><div><button class="btn ghost small" onClick=${() => save({ onboarded: false })}>${t('set.replayOnboarding', 'Show the welcome tour again')}</button></div><//>
    <//>
    <${Group} title=${t('set.appearance', 'Appearance')} note=${t('set.themeText', 'Colour scheme of the whole app. The colour-blind schemes replace the green/red signals (alive, dead, warnings) with colours that stay apart with that colour vision.')}>
      <${Item} id="theme"><${ThemePicker} value=${cfg.theme} onPick=${(id) => save({ theme: id })} /><//>
    <//>`;
}
