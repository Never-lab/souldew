// Settings › Controls: the keyboard keys and the controller (which one plays, its buttons, navigating the app with it).
import { html, useState, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { t, currentLang } from '../../lib/i18n.mjs';
import { BUTTONS, RESERVED, PRESETS, bindable, keyLabel, resolve as resolveControls, presetMap, activePreset, detectLayout, currentLayout,
  PAD_LABELS, PAD_PRESETS, PAD_HOTKEYS, padMap, padFamily, padLabel, pickPad, padKey, looksLikePad } from '../../lib/controls.mjs';
import { SHORTCUTS, buttonLabel } from '../guide.mjs';
import { suspendPadNav } from '../../lib/padnav.mjs';
import { Item } from './parts.mjs';

const SYS_SHORT = { nds: 'DS', gba: 'GBA', gb: 'GB' };

function shortcutAction(code) {
  const k = RESERVED[code];
  if (k === 'Esc') return t('ctl.escape', 'Cancel / leave fullscreen');
  const hit = SHORTCUTS().find(([s]) => s === k) || (/\d$/.test(k) && SHORTCUTS().find(([s]) => s === '1–4'));
  return hit ? hit[1] : '';
}

// "WASD" is printed as the layout prints those keys (ZQSD on AZERTY)
const presetLabel = (id) => (id === 'arrows' ? t('ctl.presetArrows', 'Arrow keys')
  : ['up', 'left', 'down', 'right'].map((b) => keyLabel(presetMap(id)[b])).join(''));

function KeyboardPanel({ saved, save }) {
  const [, setLayoutTick] = useState(0);
  const lang = currentLang();
  useEffect(() => { detectLayout(lang).then(() => setLayoutTick((x) => x + 1)); }, [lang]);
  const map = resolveControls(saved);
  const active = activePreset(saved); // null = custom
  const [listen, setListen] = useState(null); // button waiting for its new key
  const [msg, setMsg] = useState(null); // { text, swap?: { id, other, k } }
  const bound = useRef(0);
  const store = (next) => { setMsg(null); save({ controls: next }); };
  useEffect(() => {
    if (!listen) return;
    const onKey = (e) => {
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setListen(null); setMsg(null); return; }
      const k = { keyCode: e.keyCode, key: e.key, code: e.code };
      if (e.keyCode in RESERVED) return setMsg({ text: t('ctl.reserved', '{key} is already a shortcut while playing ({action}). Press another key.', { key: keyLabel(k), action: shortcutAction(e.keyCode) }) });
      if (!bindable(e.keyCode)) return setMsg({ text: t('ctl.unbindable', 'This key can’t be used for the game. Press another key.') });
      bound.current = Date.now();
      setListen(null);
      const other = BUTTONS.find((b) => b.id !== listen && map[b.id]?.keyCode === e.keyCode);
      if (other) return setMsg({ text: t('ctl.taken', '{key} is already used for {button}.', { key: keyLabel(k), button: buttonLabel(other.id) }), swap: { id: listen, other: other.id, k } });
      if (map[listen]?.keyCode !== e.keyCode) store({ ...map, [listen]: k });
      else setMsg(null);
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [listen, saved]);
  const swap = () => { const { id, other, k } = msg.swap; store({ ...map, [id]: k, [other]: map[id] }); };
  // the default preset is stored as "nothing saved", so it keeps following the keyboard layout
  const pick = (id) => { setListen(null); if (id !== active) store(id === PRESETS[0].id ? null : presetMap(id)); };
  const lay = currentLayout();
  return html`<section class="panel stack">
    <h2>${t('set.keyboard', 'Keyboard')}</h2>
    <p class="small muted">${t('set.controlsText', 'Keyboard keys for the built-in emulator. Click a key, then press the new one. Changes apply the next time a game starts.')}</p>
    <div class="row">
      <div class="seg" role="group" aria-label=${t('ctl.presets', 'Key presets')}>
        ${PRESETS.map((p) => html`<button type="button" class=${active === p.id ? 'on' : ''} aria-pressed=${active === p.id} onClick=${() => pick(p.id)}>${presetLabel(p.id)}</button>`)}
        <button type="button" class=${active ? '' : 'on'} aria-pressed=${!active} disabled=${!!active} title=${t('ctl.customHint', 'Your own keys – click a key in the table to change it')}>${t('ctl.custom', 'Custom')}</button>
      </div>
      <span class="small faint">${lay.real ? t('ctl.layoutSystem', 'Key names follow your keyboard layout.')
        : t('ctl.layoutGuess', 'Key names assume a {layout} keyboard (from the app language).', { layout: lay.id.toUpperCase() })}</span>
    </div>
    <table class="data"><thead><tr><th>${t('keys.button', 'Console button')}</th><th>${t('keys.key', 'Key')}</th><th>${t('set.system', 'System')}</th></tr></thead><tbody>
      ${BUTTONS.map((b) => html`<tr><td>${buttonLabel(b.id)}</td><td>
        <button type="button" class=${`kbd ctl-key${listen === b.id ? ' on' : ''}`} aria-label=${`${buttonLabel(b.id)}: ${keyLabel(map[b.id])}`}
          onClick=${() => { if (Date.now() - bound.current < 400) return; setMsg(null); setListen(listen === b.id ? null : b.id); }}
          onBlur=${() => setListen((l) => (l === b.id ? null : l))}>${listen === b.id ? t('ctl.press', 'Press a key …') : keyLabel(map[b.id])}</button></td>
        <td class="small faint">${(b.systems || ['nds', 'gba', 'gb']).map((s) => SYS_SHORT[s]).join(' · ')}</td></tr>`)}
    </tbody></table>
    ${msg && html`<div class="note row" role="status"><span class="grow">${msg.text}</span>
      ${msg.swap && html`<button class="btn small" onClick=${swap}>${t('ctl.swap', 'Swap keys')}</button>`}
      <button class="btn small ghost" onClick=${() => setMsg(null)}>${t('common.cancel', 'Cancel')}</button></div>`}
    <div class="row"><span class="small faint">${t('ctl.touch', 'Touch screen (DS): mouse click.')}</span></div>
  </section>`;
}

/** Connected controllers (polled – the Gamepad API has no "button pressed" event). */
export function usePads() {
  const [pads, setPads] = useState([]);
  useEffect(() => {
    let last = '';
    const read = () => {
      const now = [...(navigator.getGamepads?.() || [])].filter((g) => g && g.connected)
        .map((g) => ({ id: g.id, index: g.index, family: padFamily(g.id), standard: g.mapping === 'standard', axes: g.axes.length, buttons: g.buttons.length, pressed: g.buttons.map((b) => b.pressed) }));
      const sig = JSON.stringify(now);
      if (sig !== last) setPads(now); // re-render only when something changed
      last = sig;
    };
    read();
    const id = setInterval(read, 60);
    return () => clearInterval(id);
  }, []);
  return pads;
}

/** Face buttons of a controller we can't name: where they sit. */
export const PAD_POS = () => ({ BUTTON_1: t('pad.posBottom', 'bottom button'), BUTTON_2: t('pad.posRight', 'right button'), BUTTON_3: t('pad.posLeft', 'left button'), BUTTON_4: t('pad.posTop', 'top button') });

export const FAMILY_NAMES = () => ({ playstation: 'PlayStation (DualSense / DualShock)', xbox: 'Xbox', switch: t('pad.switch', 'Nintendo Switch (Pro Controller / Joy-Con)'), generic: t('pad.generic', 'Controller') });

/** A device's name as the browser reports it, without the vendor/product part in brackets. */
export const padName = (id) => String(id || '').replace(/\s*\(.*\)\s*$/, '') || String(id || '');

/**
 * Which connected device plays (lib/controls.mjs pickPad): "Automatic" or one the player picked – remembered as
 * config.pads.device. Shown as soon as there is a choice to make: two devices, one that doesn't look like a controller,
 * or a remembered one.
 */
function PadPicker({ pads, saved, pad, onPick }) {
  const wanted = saved?.device ? padKey(saved.device) : '';
  const missing = wanted && !pads.some((p) => padKey(p.id) === wanted);
  if (pads.length < 2 && !wanted && (!pads.length || looksLikePad(pads[0]))) return null;
  const auto = pickPad(pads);
  // the same model twice has the same id – they are told apart by their slot
  const twice = (p) => pads.filter((q) => q.id === p.id).length > 1;
  const label = (p) => `${padName(p.id)}${twice(p) ? ` (${p.index + 1})` : ''}${looksLikePad(p) ? '' : ` – ${t('pad.notAPad', 'doesn’t look like a controller')}`}`;
  return html`<div class="grid-2"><label class="field"><span>${t('pad.use', 'Controller to use')}</span>
    <select value=${wanted} onChange=${(e) => onPick(e.target.value || null)}>
      <option value="">${auto ? t('pad.auto', 'Automatic – {name}', { name: padName(auto.id) }) : t('pad.autoNone', 'Automatic')}</option>
      ${pads.filter((p, i) => pads.findIndex((q) => q.id === p.id) === i).map((p) => html`<option value=${padKey(p.id)}>${label(p)}</option>`)}
      ${missing && html`<option value=${wanted}>${t('pad.missing', '{name} (not connected)', { name: padName(wanted) })}</option>`}
    </select></label>
    <span class="small faint pad-pick-hint">${pad && wanted && padKey(pad.id) === wanted ? t('pad.remembered', 'souldew remembers this controller and uses it whenever it is connected.')
      : t('pad.autoHint', 'Automatic picks a real controller and skips microphones, headsets and other devices the system lists as controllers.')}</span></div>`;
}

function PadPanel({ saved, save, nav, saveNav }) {
  const pads = usePads();
  const pad = pickPad(pads, saved?.device);
  const odd = !pad && pads.length ? pads : null; // only devices that don't look like a controller
  const keep = saved?.device ? { device: saved.device } : {};
  const family = pad?.family || 'generic';
  const map = padMap(saved);
  const preset = PAD_PRESETS.find((p) => p.id === saved?.preset) || PAD_PRESETS[0];
  const custom = !!saved?.map && BUTTONS.some((b) => map[b.id] !== preset.map[b.id]);
  const [listen, setListen] = useState(null);
  const [msg, setMsg] = useState(null);
  const before = useRef(null);
  // waiting for a button: the first one that goes down (and wasn't down when we started listening) is the new one
  useEffect(() => {
    if (!listen || !pad) return;
    if (!before.current) before.current = pad.pressed;
    const i = pad.pressed.findIndex((p, k) => p && !before.current[k] && k < PAD_LABELS.length);
    if (i < 0) return;
    const label = PAD_LABELS[i];
    before.current = null;
    if (label in PAD_HOTKEYS) {
      setMsg(t('pad.hotkey', '{button} is already used while playing ({action}). Press another button.', { button: padLabel(label, family, PAD_POS()), action: PAD_HOTKEYS[label] === 'turbo' ? t('keys.turbo', 'Turbo') : t('keys.pause', 'Pause / resume') }));
      return;
    }
    const other = BUTTONS.find((b) => b.id !== listen && map[b.id] === label);
    const next = { ...map, [listen]: label, ...(other ? { [other.id]: map[listen] } : {}) };
    setListen(null);
    setMsg(other ? t('pad.swapped', '{button} was on {other} – the two swapped.', { button: padLabel(label, family, PAD_POS()), other: buttonLabel(other.id) }) : null);
    save({ pads: { preset: preset.id, map: next, ...keep } });
  }, [pad?.pressed?.join(), listen]);
  useEffect(() => {
    if (!listen) return undefined;
    const esc = (e) => e.key === 'Escape' && (setListen(null), (before.current = null));
    addEventListener('keydown', esc);
    // the next button pressed is the new one – it must not also move the focus (lib/padnav.mjs)
    const resume = suspendPadNav();
    return () => {
      removeEventListener('keydown', esc);
      resume();
    };
  }, [listen]);
  const pick = (id) => { setListen(null); setMsg(null); save({ pads: { preset: id, ...keep } }); };
  const choose = (device) => {
    setListen(null);
    setMsg(null);
    save({ pads: { ...(saved?.preset ? { preset: saved.preset } : {}), ...(saved?.map ? { map: saved.map } : {}), ...(device ? { device } : {}) } });
  };
  return html`<section class="panel stack">
    <h2>${t('pad.title', 'Controller')}</h2>
    <p class="small muted">${t('pad.text', 'PlayStation, Xbox, Switch and other controllers work over USB or Bluetooth. Click a button in the table, then press the new one on the controller. Changes apply the next time a game starts.')}</p>
    <div class=${`pad-status ${pad ? 'on' : ''}`} role="status">
      <span class=${`led green ${pad ? 'on' : ''}`}></span>
      ${pad ? html`<span><b>${FAMILY_NAMES()[family]}</b> <span class="small faint">${padName(pad.id)}</span>${!pad.standard ? html` <span class="chip">${t('pad.nonStandard', 'unusual layout – check the buttons below')}</span>` : ''}</span>`
        : odd ? html`<span class="small">${t('pad.onlyOdd', 'No controller found – {name} doesn’t look like one. Connect your controller and press a button on it, or pick the device below if it is one.', { name: odd.map((p) => padName(p.id)).join(', ') })}</span>`
        : html`<span class="small">${t('pad.none', 'No controller found. Connect one and press any button on it.')}</span>`}
    </div>
    <${PadPicker} pads=${pads} saved=${saved} pad=${pad} onPick=${choose} />
    <${Item} id="pad-nav"><label class="check"><input type="checkbox" checked=${nav} onChange=${(e) => saveNav(e.target.checked)} /><span>${t('pad.nav', 'Navigate the app with a controller')}
      <span class="hint">${t('pad.navHint', 'D-pad or left stick moves between buttons, A presses, B goes back, L and R switch sections or tabs, Start jumps to the sidebar, the right stick scrolls. While a game runs, the controller belongs to the game – pause it ({button} or Home) to use the menus.', { button: padLabel('LEFT_BOTTOM_SHOULDER', family) })}</span></span></label><//>
    <div class="row">
      <div class="seg" role="group" aria-label=${t('pad.layouts', 'Button layout')}>
        ${PAD_PRESETS.map((p) => html`<button type="button" class=${!custom && preset.id === p.id ? 'on' : ''} aria-pressed=${!custom && preset.id === p.id} onClick=${() => pick(p.id)}>${p.id === 'nintendo' ? t('pad.nintendo', 'Nintendo layout (A right)') : t('pad.xbox', 'Xbox layout (A bottom)')}</button>`)}
        <button type="button" class=${custom ? 'on' : ''} aria-pressed=${custom} disabled=${!custom}>${t('ctl.custom', 'Custom')}</button>
      </div>
    </div>
    <table class="data"><thead><tr><th>${t('keys.button', 'Console button')}</th><th>${t('pad.button', 'Controller button')}</th></tr></thead><tbody>
      ${BUTTONS.map((b) => {
        const lit = pad && map[b.id] && pad.pressed[PAD_LABELS.indexOf(map[b.id])];
        return html`<tr class=${lit ? 'pad-lit' : ''}><td>${buttonLabel(b.id)}</td><td>
          <button type="button" class=${`kbd ctl-key${listen === b.id ? ' on' : ''}`} disabled=${!pad}
            title=${pad ? '' : t('pad.connectFirst', 'Connect a controller first')}
            onClick=${() => { before.current = null; setMsg(null); setListen(listen === b.id ? null : b.id); }}>
            ${listen === b.id ? t('pad.press', 'Press a button …') : padLabel(map[b.id], family, PAD_POS())}</button></td></tr>`;
      })}
    </tbody></table>
    ${msg && html`<div class="note" role="status">${msg}</div>`}
    <ul class="small muted pad-hints">
      <li>${t('pad.stick', 'Left stick: moves like the D-pad.')}</li>
      <li>${t('pad.turbo', '{button}: turbo on / off.', { button: padLabel('RIGHT_BOTTOM_SHOULDER', family) })}</li>
      <li>${t('pad.pause', '{button} or the Home button: pause.', { button: padLabel('LEFT_BOTTOM_SHOULDER', family) })}</li>
    </ul>
  </section>`;
}

export function ControlsSection({ cfg, save, toast }) {
  return html`<div class="set-controls">
    <${Item} id="keyboard"><${KeyboardPanel} saved=${cfg.controls || null} save=${(p) => save(p).catch((e) => toast({ kind: 'death', title: t('set.keyboard', 'Keyboard'), text: e.message }))} /><//>
    <${Item} id="controller"><${PadPanel} saved=${cfg.pads || null} save=${(p) => save(p).catch((e) => toast({ kind: 'death', title: t('pad.title', 'Controller'), text: e.message }))}
      nav=${cfg.padNav !== false} saveNav=${(on) => save({ padNav: on })} /><//>
  </div>`;
}
