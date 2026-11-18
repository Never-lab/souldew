// The profile's showcase – up to three trophies, the most trusted Pokémon line and the favourite game – in the layout
// the player picked (API.md §2.2 showcase_layout, shown to friends the same way):
//   'case'  "Display case": a full-width glass case under the numbers – the trophies on lit plinths in their rarity,
//           the most trusted line on its own stand with its numbers, the favourite game as the app's cartridge
//   'lcd'   "Trainer card": the most trusted line on the handheld's screen, the trophies as pins – in the side column
//   'shelf' "Shelf": the compact side column – three trophy tiles in a row, the line on a small stand
// and its two pickers: the trophy cabinet (the three picks big on top, search, categories, rarity filters, a calm grid)
// and "Most trusted" (your regulars: the twelve lines your own runs relied on most, any other Pokémon by search).
// Everything another player wrote (the note) is text, never HTML.
import { html, useState, useMemo } from '/vendor/htm-preact.mjs';
import { t } from '../lib/i18n.mjs';
import { Icon } from '../lib/icons.mjs';
import { useApp, Modal, Sprite } from '../lib/ui.mjs';
import { speciesName, pokeapi, catalog as gameCatalog } from '../lib/data.mjs';
import { useTrophies } from '../lib/trophies.mjs';
import { achText, catLabel, rarityLabel } from '../lib/trophytexts.mjs';
import { toCatalogId, fromCatalogId } from '../lib/achievementids.mjs';
import { speciesInText, splitTrusted } from '../lib/trusted.mjs';
import { shortTitle } from '../lib/presence.mjs';
import { ACHIEVEMENTS, CATEGORIES, RARITIES } from '/shared/trophies.mjs';
import { cabinetList, togglePick, searchSpecies } from '../lib/showcasepick.mjs';
import { SHOWCASE_LAYOUTS } from '/shared/social.mjs';
import { lineRoot, TRUSTED_NOTE_MAX, REGULARS } from '/shared/trustedlines.mjs';
import { AchIcon } from './trophies.mjs';
import { coverOf } from './library.mjs';

const DEFS = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));
const monthYear = (ms) => (ms ? new Date(ms).toLocaleDateString(document.documentElement.lang || undefined, { month: 'short', year: 'numeric' }) : '');

/**
 * A showcase trophy (catalog id) → the achievement as the tiles draw it ({ id, rarity, cat, target, ok, at }) – the
 * date only for your own (from this computer's trophies), never guessed for a friend. null for an unknown id.
 */
export function achOf(catalogId, earned = null) {
  const id = fromCatalogId(catalogId);
  const def = id && DEFS[id];
  if (!def) return null;
  const mine = earned?.find((a) => a.id === id);
  return { id, rarity: def.rarity, cat: def.cat, target: def.target || 1, hidden: false, ok: true, at: mine?.at ?? null };
}

/** The layouts in the player's words. */
export const layoutLabel = (id) => ({ case: t('sc.layoutCase', 'Display case'), lcd: t('sc.layoutLcd', 'Trainer card'), shelf: t('sc.layoutShelf', 'Shelf') }[id] || id);

/** The favourite game as the library knows it: its cover, system and cartridge colour (or just the title). */
function gameOf(library, title) {
  if (!title) return null;
  const g = (gameCatalog().games || []).find((x) => !x.variantOf && shortTitle({ gameId: x.id }) === title);
  return { title, cover: g ? coverOf(library, { gameId: g.id }) : null, system: g?.system || null, color: g?.color || null };
}

const CART_KIND = { gb: 'gb', gbc: 'gb', gba: 'gba', nds: 'nds', '3ds': 'nds' };
const SYS = { gb: 'GB', gbc: 'GBC', gba: 'GBA', nds: 'DS', '3ds': '3DS' };
/** A cartridge to look at (not a button – the library's carts open games): the cover on the module of its system. */
function Cartridge({ game }) {
  const kind = CART_KIND[game.system] || 'gb';
  return html`<div class=${`cart cart-${kind} big sc-cart`} aria-hidden="true"><div class="cart-slot"><div class="cart-body" style=${`--cc:${game.color || '#4a4954'}`}>
    <span class="cart-grip"></span>
    <div class="cart-label">${game.cover ? html`<img class="pixel" src=${game.cover} alt="" loading="lazy" />` : html`<span class="fallback">${game.title}</span>`}</div>
    <div class="cart-foot"><div class="badge-row">${game.system && html`<span class="sys">${SYS[game.system] || game.system}</span>`}</div>${kind === 'gb' && html`<span class="cart-arrow"></span>`}</div>
  </div></div></div>`;
}

/** teams · top level · fell – in pixel digits; nothing when the owner doesn't share them. */
export function TrustedStats({ tr }) {
  if (!tr || tr.teams == null) return null;
  return html`<div class="sc-tstats">
    <span><b>${tr.teams}</b>${t('sc.teams', 'team|teams', { count: tr.teams })}</span>
    <span><b>${tr.topLevel}</b>${t('sc.topLv', 'top Lv')}</span>
    <span class=${tr.fell ? 'bad' : 'ok'}>${tr.fell ? html`<b>${tr.fell}</b>${t('sc.fell', 'fell')}` : t('sc.neverFell', 'never fell')}</span>
  </div>`;
}

const lineName = (tr) => t('pf.lineOf', '{name} line', { name: speciesName(tr.species) });

/** The old free-text "most trusted" (before it was a line): the Pokémon it names, or a quiet ball, and the words. */
function LegacyTrusted({ text }) {
  const id = useMemo(() => speciesInText(text, pokeapi()?.names), [text]);
  const { head, rest } = splitTrusted(text);
  return html`<div class="pf-trusted">
    <span class=${`pf-trusted-mon${id ? '' : ' blank'}`}>${id ? html`<${Sprite} id=${id} gen=${5} size=${80} alt=${speciesName(id)} />` : html`<${Icon} name="ball" size=${26} />`}</span>
    <div class="stack-s pf-trusted-text">${head && html`<b class="pf-trusted-head">${head}</b>`}<p>${rest}</p></div>
  </div>`;
}

/** The line on its stand (side column, the picker's preview). */
export function TrustedCard({ tr, big = false }) {
  if (!tr) return null;
  return html`<div class=${`sc-tcard ${big ? 'big' : ''}`}>
    <span class="sc-stand"><${Sprite} id=${tr.species} gen=${5} size=${big ? 112 : 88} alt=${speciesName(tr.species)} /></span>
    <div class="sc-tcard-text"><b class="sc-tname">${lineName(tr)}</b><${TrustedStats} tr=${tr} />
      ${tr.note && html`<p class="sc-note">“${tr.note}”</p>`}</div>
  </div>`;
}

/** Your own profile: which layout friends see, switched right here (saved on the service). */
export function LayoutSwitch({ value, onChange, busy }) {
  return html`<div class="seg small sc-layout" role="radiogroup" aria-label=${t('sc.layout', 'Showcase layout')}>
    ${SHOWCASE_LAYOUTS.map((id) => html`<button type="button" role="radio" aria-checked=${value === id} class=${value === id ? 'on' : ''} disabled=${busy}
      onClick=${() => value !== id && onChange(id)}>${layoutLabel(id)}</button>`)}</div>`;
}

/** The showcase's parts for a profile: the trophies (as tiles), the line (or the old text) and the favourite game. */
function useParts(prof) {
  const { library } = useApp();
  const tr = useTrophies();
  const sc = prof.showcase || {};
  const trophies = (sc.trophies || []).map((id) => achOf(id, tr?.achievements)).filter(Boolean);
  return { trophies, trusted: sc.trusted || null, legacy: sc.trusted ? null : sc.trustedText || null, game: gameOf(library, sc.favoriteGame) };
}

export const isEmpty = (prof) => {
  const sc = prof?.showcase || {};
  return !(sc.trophies || []).length && !sc.trusted && !sc.trustedText && !sc.favoriteGame;
};

function Head({ title, own, layout, onLayout, busy, onEdit }) {
  return html`<div class="pf-head"><h2>${title}</h2><span class="pf-rule"></span>
    ${own && onLayout && html`<${LayoutSwitch} value=${layout} onChange=${onLayout} busy=${busy} />`}
    ${own && onEdit && html`<button type="button" class="btn small ghost" onClick=${onEdit}>${t('sc.arrange', 'Arrange')}</button>`}</div>`;
}

/** 'case' – the display case, full width under the numbers. */
export function ShowcaseCase({ prof, own, onLayout, busy, onEdit }) {
  const { trophies, trusted, legacy, game } = useParts(prof);
  const empty = isEmpty(prof);
  if (empty && !own) return null;
  return html`<section class="pf-section sc-case-sec">
    <${Head} title=${t('pf.showcase', 'Showcase')} own=${own} layout="case" onLayout=${onLayout} busy=${busy} onEdit=${onEdit} />
    ${empty ? html`<p class="small muted sc-empty">${t('sc.emptyOwn', 'Nothing in your showcase yet – Arrange puts up to three trophies, your most trusted Pokémon and your favourite game here.')}</p>`
      : html`<div class="sc-case">
      <span class="sc-glass" aria-hidden="true"></span>
      ${trophies.length > 0 && html`<div class="sc-case-trophies" style=${`--n:${trophies.length}`}>${trophies.map((a) => {
        const tx = achText(a.id, a.target);
        return html`<figure class=${`sc-ped r-${a.rarity}`}><span class="sc-light" aria-hidden="true"></span><span class="sc-ped-item"><${AchIcon} a=${a} size=${34} /></span><span class="sc-ped-top" aria-hidden="true"></span>
          <figcaption><b>${tx.name}</b><span class="small muted">${tx.desc}</span><span class="row tight sc-ped-meta"><span class=${`rarity r-${a.rarity}`}>${rarityLabel(a.rarity)}</span>${a.at && html`<span class="tiny faint">${monthYear(a.at)}</span>`}</span></figcaption></figure>`;
      })}</div>`}
      ${trusted && html`<figure class="sc-case-mon"><span class="sc-light mon" aria-hidden="true"></span><span class="sc-case-sprite"><${Sprite} id=${trusted.species} gen=${5} size=${128} alt=${speciesName(trusted.species)} /></span><span class="sc-ped-top wide" aria-hidden="true"></span>
        <figcaption><span class="pf-tag">${t('pf.trusted', 'Most trusted')}</span><b class="sc-case-monname">${lineName(trusted)}</b><${TrustedStats} tr=${trusted} />
          ${trusted.note && html`<p class="sc-note">“${trusted.note}”</p>`}</figcaption></figure>`}
      ${legacy && html`<div class="sc-case-legacy"><span class="pf-tag">${t('pf.trusted', 'Most trusted')}</span><${LegacyTrusted} text=${legacy} /></div>`}
      ${game && html`<figure class="sc-case-fav"><${Cartridge} game=${game} /><figcaption><span class="pf-tag">${t('pf.favorite', 'Favourite game')}</span><b>${game.title}</b></figcaption></figure>`}
    </div>`}
  </section>`;
}

/** The favourite game as a row (the side-column layouts). */
function FavRow({ game }) {
  if (!game) return null;
  return html`<div class="pf-fav">${game.cover ? html`<img class="pixel" src=${game.cover} alt="" />` : html`<span class="pf-fav-blank"><${Icon} name="play" size=${16} /></span>`}
    <div class="stack-s" style="gap:0"><b>${game.title}</b><span class="small muted">${t('pf.favorite', 'Favourite game')}</span></div></div>`;
}

/** 'lcd' – the trainer card: the line on the handheld's screen, trophies as pins, in the side column. */
export function ShowcaseLcd({ prof, own, onLayout, busy, onEdit }) {
  const { trophies, trusted, legacy, game } = useParts(prof);
  const empty = isEmpty(prof);
  return html`<div class="pf-side stack-l">
    ${own && html`<div class="sc-side-tools"><${LayoutSwitch} value="lcd" onChange=${onLayout} busy=${busy} />${onEdit && html`<button type="button" class="btn small ghost" onClick=${onEdit}>${t('sc.arrange', 'Arrange')}</button>`}</div>`}
    ${empty && own && html`<p class="small muted sc-empty">${t('sc.emptyOwn', 'Nothing in your showcase yet – Arrange puts up to three trophies, your most trusted Pokémon and your favourite game here.')}</p>`}
    ${(trusted || legacy) && html`<section class="pf-section"><div class="pf-head"><h2>${t('pf.trusted', 'Most trusted')}</h2><span class="pf-rule"></span></div>
      ${trusted ? html`<div class="lcd-card sc-lcd">
        <div class="sc-lcd-screen"><${Sprite} id=${trusted.species} gen=${5} size=${112} alt=${speciesName(trusted.species)} /></div>
        <div class="sc-lcd-info"><b class="px">${speciesName(trusted.species).toUpperCase()}</b>
          ${trusted.teams != null && html`<dl><dt>${t('sc.teamsShort', 'Teams')}</dt><dd>${trusted.teams}</dd><dt>${t('sc.topLv', 'top Lv')}</dt><dd>${trusted.topLevel}</dd><dt>${t('sc.fell', 'fell')}</dt><dd>${trusted.fell}</dd></dl>`}
          ${trusted.note && html`<span class="small sc-lcd-note">“${trusted.note}”</span>`}</div>
      </div>` : html`<${LegacyTrusted} text=${legacy} />`}</section>`}
    ${trophies.length > 0 && html`<section class="pf-section"><div class="pf-head"><h2>${t('pf.showcase', 'Showcase')}</h2><span class="pf-rule"></span></div>
      <div class="sc-pins">${trophies.map((a) => html`<div class=${`sc-pin r-${a.rarity}`} title=${achText(a.id, a.target).desc}><${AchIcon} a=${a} size=${24} /><b>${achText(a.id, a.target).name}</b><span class=${`rarity r-${a.rarity}`}>${rarityLabel(a.rarity)}</span></div>`)}</div></section>`}
    <${FavRow} game=${game} />
  </div>`;
}

/** 'shelf' – the compact side column: three trophy tiles in a row, the line on a stand. */
export function ShowcaseShelf({ prof, own, onLayout, busy, onEdit }) {
  const { trophies, trusted, legacy, game } = useParts(prof);
  const empty = isEmpty(prof);
  return html`<div class="pf-side stack-l">
    ${own && html`<div class="sc-side-tools"><${LayoutSwitch} value="shelf" onChange=${onLayout} busy=${busy} />${onEdit && html`<button type="button" class="btn small ghost" onClick=${onEdit}>${t('sc.arrange', 'Arrange')}</button>`}</div>`}
    ${empty && own && html`<p class="small muted sc-empty">${t('sc.emptyOwn', 'Nothing in your showcase yet – Arrange puts up to three trophies, your most trusted Pokémon and your favourite game here.')}</p>`}
    ${trophies.length > 0 && html`<section class="pf-section"><div class="pf-head"><h2>${t('pf.showcase', 'Showcase')}</h2><span class="pf-rule"></span></div>
      <div class="sc-tiles">${trophies.map((a) => html`<div class=${`sc-tile r-${a.rarity}`} title=${achText(a.id, a.target).desc}><${AchIcon} a=${a} size=${26} /><b>${achText(a.id, a.target).name}</b><span class=${`rarity r-${a.rarity}`}>${rarityLabel(a.rarity)}</span></div>`)}</div></section>`}
    ${(trusted || legacy) && html`<section class="pf-section"><div class="pf-head"><h2>${t('pf.trusted', 'Most trusted')}</h2><span class="pf-rule"></span></div>
      ${trusted ? html`<${TrustedCard} tr=${trusted} />` : html`<${LegacyTrusted} text=${legacy} />`}</section>`}
    <${FavRow} game=${game} />
  </div>`;
}

// ---- the trophy cabinet -------------------------------------------------------------------------------------------

function Plinth({ a, n, onRemove }) {
  if (!a) return html`<div class="sc-plinth empty"><span class="sc-plinth-n">${n}</span><span class="small faint">${t('sc.emptySlot', 'Pick a trophy below')}</span></div>`;
  const tx = achText(a.id, a.target);
  return html`<div class=${`sc-plinth r-${a.rarity}`}>
    <span class="sc-plinth-n">${n}</span>
    <button type="button" class="sc-plinth-x" title=${t('sc.takeOut', 'Take out')} aria-label=${t('sc.takeOutName', 'Take {name} out', { name: tx.name })} onClick=${onRemove}><${Icon} name="close" size=${10} /></button>
    <span class="sc-plinth-glow" aria-hidden="true"></span><${AchIcon} a=${a} size=${30} /><b>${tx.name}</b><span class=${`rarity r-${a.rarity}`}>${rarityLabel(a.rarity)}</span></div>`;
}

/**
 * The cabinet. chosen: catalog ids now on the profile; allowed: the catalog ids the service knows (null = all);
 * extra: ids on the profile that weren't earned on this computer (kept, so nothing silently disappears).
 */
export function TrophyCabinet({ chosen: initial, allowed = null, onDone, onClose }) {
  const tr = useTrophies();
  const [chosen, setChosen] = useState(initial);
  const [cat, setCat] = useState('all');
  const [rarity, setRarity] = useState('all');
  const [q, setQ] = useState('');
  const ok = (a) => !allowed || allowed.has(toCatalogId(a.id));
  const earned = useMemo(() => {
    const mine = (tr?.achievements || []).filter((a) => a.ok && ok(a));
    // on the profile but earned on another computer: offered too
    const elsewhere = initial.filter((id) => !mine.some((a) => toCatalogId(a.id) === id)).map((id) => achOf(id)).filter(Boolean);
    return [...mine, ...elsewhere];
  }, [tr]);
  const byId = Object.fromEntries(earned.map((a) => [toCatalogId(a.id), a]));
  const shown = cabinetList(earned, { cat, rarity, q }, (a) => achText(a.id, a.target).name);
  const cats = CATEGORIES.filter((c) => earned.some((a) => a.cat === c));
  const foot = html`<span class="small muted grow">${t('sc.pickedN', '{n} of 3 in the case – in the order you pick them', { n: chosen.length })}</span>
    <button type="button" class="btn ghost" onClick=${onClose}>${t('common.cancel', 'Cancel')}</button>
    <button type="button" class="btn primary" onClick=${() => onDone(chosen)}>${t('sc.putInCase', 'Put in the case')}</button>`;
  return html`<${Modal} open wide onClose=${onClose} title=${t('sc.cabinet', 'Trophy cabinet')} footer=${foot}>
    <div class="sc-picker stack">
      <div class="sc-plinths">${[0, 1, 2].map((i) => html`<${Plinth} a=${byId[chosen[i]]} n=${i + 1} onRemove=${() => setChosen((c) => c.filter((x) => x !== chosen[i]))} />`)}</div>
      ${!earned.length ? html`<p class="small muted">${t('pf.noTrophies', 'Trophies you earn can go here.')}</p>` : html`
      <div class="sc-tools">
        <input type="search" aria-label=${t('sc.searchT', 'Search your {n} trophies', { n: earned.length })} placeholder=${t('sc.searchT', 'Search your {n} trophies', { n: earned.length })} value=${q} onInput=${(e) => setQ(e.target.value)} />
        <div class="seg small" role="radiogroup" aria-label=${t('sc.category', 'Category')}>${[['all', t('pf.all', 'All')], ...cats.map((c) => [c, catLabel(c)])].map(([id, label]) => html`<button type="button" role="radio" aria-checked=${cat === id} class=${cat === id ? 'on' : ''} onClick=${() => setCat(id)}>${label}</button>`)}</div>
      </div>
      <div class="sc-rarities" role="group" aria-label=${t('sc.rarity', 'Rarity')}>${[...RARITIES].reverse().map((r) => {
        const n = earned.filter((a) => a.rarity === r).length;
        return n > 0 && html`<button type="button" aria-pressed=${rarity === r} class=${`sc-rdot r-${r} ${rarity === r ? 'on' : ''}`} onClick=${() => setRarity(rarity === r ? 'all' : r)}><i aria-hidden="true"></i>${rarityLabel(r)}<span class="faint">${n}</span></button>`;
      })}</div>
      <div class="sc-cab">${shown.map((a) => {
        const id = toCatalogId(a.id);
        const on = chosen.includes(id);
        const tx = achText(a.id, a.target);
        return html`<button type="button" key=${id} class=${`sc-cab-i r-${a.rarity} ${on ? 'on' : ''}`} aria-pressed=${on} disabled=${!on && chosen.length >= 3} onClick=${() => setChosen((c) => togglePick(c, id))}>
          <${AchIcon} a=${a} size=${20} /><span class="sc-cab-text"><b>${tx.name}</b><span class="tiny faint">${tx.desc}</span><span class=${`rarity r-${a.rarity}`}>${rarityLabel(a.rarity)}</span></span>
          ${on && html`<span class="sc-cab-n" aria-hidden="true">${chosen.indexOf(id) + 1}</span>`}</button>`;
      })}
        ${!shown.length && html`<p class="small muted">${t('sc.noMatch', 'No trophy matches.')}</p>`}</div>`}
    </div>
  <//>`;
}

// ---- most trusted ---------------------------------------------------------------------------------------------------

/**
 * "Most trusted": your regulars (lines: the editor choices' `lines`, most relied-on first) as sprite cards with their
 * numbers, any other Pokémon by search, an optional note, and a preview of how it shows on the profile.
 * value: the current line ({ species, line, note, … }) or null; share: are the runs shared (then the numbers show)?
 * onDone({ species, line, note } | null).
 */
export function TrustedPicker({ value, lines = [], runs = 0, share = false, onDone, onClose }) {
  const [sel, setSel] = useState(() => (value ? { species: value.species, line: value.line } : lines[0] ? { species: lines[0].species, line: lines[0].line } : null));
  const [note, setNote] = useState(value?.note || '');
  const [q, setQ] = useState('');
  const words = q.trim().toLowerCase();
  const regulars = (words ? lines.filter((l) => speciesName(l.species).toLowerCase().includes(words) || speciesName(l.line).toLowerCase().includes(words)) : lines).slice(0, REGULARS);
  const others = words ? searchSpecies(q, speciesName).filter((id) => !lines.some((l) => l.species === id)).slice(0, 8) : [];
  const known = sel ? lines.find((l) => l.line === sel.line) : null;
  const preview = sel ? { species: sel.species, line: sel.line, note: note.trim() || null, teams: share && known ? known.teams : null, topLevel: known?.top || 1, fell: known?.fell ?? 0 } : null;
  const pickOther = (id) => setSel({ species: id, line: lineRoot(id, pokeapi()?.evolvesFrom) });
  const foot = html`<span class="small muted grow">${t('sc.trustFoot', 'From your {n} runs on this computer · any other Pokémon: search', { n: runs })}</span>
    ${value && html`<button type="button" class="btn ghost" onClick=${() => onDone(null)}>${t('sc.clear', 'Remove')}</button>`}
    <button type="button" class="btn ghost" onClick=${onClose}>${t('common.cancel', 'Cancel')}</button>
    <button type="button" class="btn primary" disabled=${!sel} onClick=${() => onDone({ species: sel.species, line: sel.line, note: note.trim() || null })}>${sel ? t('sc.useThis', 'Use {name}', { name: speciesName(sel.species) }) : t('common.save', 'Save')}</button>`;
  return html`<${Modal} open wide onClose=${onClose} title=${t('pf.trusted', 'Most trusted')} footer=${foot}>
    <div class="sc-picker sc-trust-wrap">
      <div class="stack">
        <div class="sc-tools"><input type="search" aria-label=${t('sc.searchMon', 'Search any Pokémon')} placeholder=${t('sc.searchMon', 'Search any Pokémon')} value=${q} onInput=${(e) => setQ(e.target.value)} />
          <span class="spacer"></span><span class="small faint">${t('sc.regulars', 'Your regulars – the lines you kept bringing')}</span></div>
        ${regulars.length > 0 ? html`<div class="sc-regulars" role="radiogroup" aria-label=${t('sc.regularsAria', 'Your regulars')}>${regulars.map((l) => html`<button type="button" role="radio" key=${l.line} aria-checked=${sel?.line === l.line}
          class=${`sc-reg ${sel?.line === l.line ? 'on' : ''}`} onClick=${() => setSel({ species: l.species, line: l.line })}>
          <span class="sc-reg-rank" aria-hidden="true">${lines.indexOf(l) + 1}</span><${Sprite} id=${l.species} gen=${5} size=${64} alt="" />
          <b>${speciesName(l.species)}</b><span class="sc-reg-stats tiny"><span>${t('sc.teamsN', '{count} team|{count} teams', { count: l.teams })}</span><span>${t('sc.lvN', 'Lv {n}', { n: l.top })}</span>
            ${l.fell > 0 ? html`<span class="bad"><${Icon} name="grave" size=${10} />${l.fell}</span>` : html`<span class="ok">${t('sc.neverFell', 'never fell')}</span>`}</span></button>`)}</div>`
          : !words && html`<p class="small muted">${t('sc.noLines', 'Your runs on this computer haven’t caught anything yet – search for any Pokémon.')}</p>`}
        ${others.length > 0 && html`<div class="stack-s"><span class="pf-tag">${t('sc.anyOther', 'Any other Pokémon')}</span>
          <div class="sc-others" role="radiogroup" aria-label=${t('sc.anyOther', 'Any other Pokémon')}>${others.map((id) => html`<button type="button" role="radio" key=${id} aria-checked=${sel?.species === id}
            class=${`sc-other ${sel?.species === id ? 'on' : ''}`} onClick=${() => pickOther(id)}><${Sprite} id=${id} gen=${5} size=${40} alt="" /><span>${speciesName(id)}</span></button>`)}</div></div>`}
        ${words && !regulars.length && !others.length && html`<p class="small muted">${t('sc.noPokemon', 'No Pokémon matches.')}</p>`}
      </div>
      <aside class="sc-tprev" aria-label=${t('sc.onProfile', 'On your profile')}><span class="pf-tag">${t('sc.onProfile', 'On your profile')}</span>
        ${preview ? html`<${TrustedCard} tr=${preview} big />` : html`<p class="small muted">${t('sc.pickOne', 'Pick a Pokémon.')}</p>`}
        ${known?.nicknames?.length > 0 && html`<span class="small muted">${t('sc.aka', 'as {names}', { names: known.nicknames.map((n) => `“${n}”`).join(', ') })}</span>`}
        <label class="field"><span>${t('sc.inYourWords', 'In your words (optional)')}</span>
          <input type="text" maxLength=${TRUSTED_NOTE_MAX} value=${note} placeholder=${t('sc.notePh', 'e.g. carried me through Victory Road')} onInput=${(e) => setNote(e.target.value)} />
          <span class="hint">${share ? t('sc.wordsHint', 'Shown under the numbers. The numbers update themselves.') : t('sc.wordsHintPrivate', 'Shown under the name. Teams, top level and fallen show once “Show my runs on my profile” is on.')}</span></label>
      </aside>
    </div>
  <//>`;
}
