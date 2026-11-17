// The souldew profile (look "A – Logbook"): banner, avatar with frame and presence, name in its nameplate, title,
// the numbers and run history (only when the player opted in to "Show my runs on my profile"), what they do now,
// most trusted, favourite game and the showcase. #/profile is your own (with "Edit profile"), #/profile?id=<user> a
// friend's (with "Invite to a run"). The editor changes banner, frame, nameplate, title (earned trophies), accent
// (the curated palette only), showcase, status line and privacy with a live preview; souldew+ items can be previewed
// by everyone and are marked quietly, never pushed.
import { html, useState, useEffect, useMemo } from '/vendor/htm-preact.mjs';
import { useApp, Modal, Led } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { speciesName } from '../lib/data.mjs';
import { settingsLink } from '../lib/settingsindex.mjs';
import { useAccount, useCatalog, accentHex, profileOf, updateMe, editorChoices, useFriends, askToJoin } from '../lib/account.mjs';
import { toCatalogId, fromCatalogId } from '../lib/achievementids.mjs';
import { achText } from '../lib/trophytexts.mjs';
import { presenceFrom } from '../lib/presence.mjs';
import { takenSlots } from './invitecode.mjs';
import { Avatar, presenceText, canAskToJoin, Badges, TitlePlate, achTitle } from './social.mjs';
import { SignInFirst, InviteModal, coverForTitle } from './friends.mjs';
import { Banner, CosmeticPicker } from '../lib/cosmetics/components.mjs';
import { STATUS_MAX, TRUSTED_MAX, FAVORITE_MAX } from '/shared/social.mjs';

const RANK = { none: 0, supporter: 1, plus: 2 };
const NEEDS = { free: 0, supporter: 1, plus: 2 };
/** May this tier wear this catalog item? (Others see a locked item as nothing – the service decides that.) */
const allowed = (item, tier) => !item || (RANK[tier] || 0) >= (NEEDS[item.tier] ?? 2);
const monthYear = (ms) => (ms ? new Date(ms).toLocaleDateString(document.documentElement.lang || undefined, { month: 'long', year: 'numeric' }) : '');
const shortDate = (ms) => (ms ? new Date(ms).toLocaleDateString(document.documentElement.lang || undefined, { month: 'short', year: 'numeric' }) : '');

function Stat({ n, label, tone }) {
  return html`<div class=${`pf-stat ${tone || ''}`}><b>${n == null ? '–' : n.toLocaleString()}</b><span>${label}</span></div>`;
}

function StatsStrip({ stats }) {
  const s = stats?.totals || {};
  return html`<div class="pf-stats">
    <${Stat} n=${s.runsStarted} label=${t('pf.runs', 'Runs')} />
    <${Stat} n=${s.runsCompleted} label=${t('pf.won', 'Won')} tone="ok" />
    <${Stat} n=${s.pokemonCaught} label=${t('pf.caught', 'Caught')} />
    <${Stat} n=${s.deaths} label=${t('pf.fallen', 'Fallen')} tone="bad" />
    <${Stat} n=${s.badgesEarned} label=${t('pf.badges', 'Badges')} />
    <${Stat} n=${s.playtimeMinutes == null ? null : Math.round(s.playtimeMinutes / 60)} label=${t('pf.hours', 'Hours')} />
  </div>`;
}

function Pips({ n, of = 8 }) {
  const total = n > 8 ? 16 : of;
  return html`<span class="pf-pips" role="img" aria-label=${t('pf.badgesN', '{n} badges', { n })}>${Array.from({ length: total }, (_, i) => html`<i class=${i < n ? 'on' : ''}></i>`)}</span>`;
}

const resultLabel = (r) => ({ won: t('pf.rWon', 'Won'), lost: t('pf.rLost', 'Wiped'), abandoned: t('pf.rEnded', 'Ended'), active: t('pf.rActive', 'Live') }[r] || r);

function RunHistory({ stats, title }) {
  const { library } = useApp();
  const [filter, setFilter] = useState('all');
  const runs = (stats?.recentRuns || []).filter((r) => filter === 'all' || (filter === 'nuzlocke' ? r.mode !== 'soullink' : r.mode === 'soullink'));
  return html`<section class="pf-section">
    <div class="pf-head"><h2>${title}</h2><span class="pf-rule"></span>
      <div class="seg small" role="group">${[['all', t('pf.all', 'All')], ['soullink', t('nav.soullink', 'SoulLink')], ['nuzlocke', t('nav.nuzlocke', 'Nuzlocke')]].map(([id, label]) => html`<button class=${filter === id ? 'on' : ''} aria-pressed=${filter === id} onClick=${() => setFilter(id)}>${label}</button>`)}</div></div>
    ${runs.length ? html`<table class="pf-table">
      <thead><tr><th></th><th>${t('pf.colRun', 'Run')}</th><th>${t('pf.badges', 'Badges')}</th><th class="num">${t('pf.fallen', 'Fallen')}</th><th>${t('pf.colResult', 'Result')}</th><th class="num">${t('pf.colWhen', 'When')}</th></tr></thead>
      <tbody>${runs.map((r) => {
        const cover = coverForTitle(library, r.game);
        return html`<tr class=${`pf-run ${r.result}`}>
          <td class="pf-cover">${cover ? html`<img class="pixel" src=${cover} alt="" />` : html`<span></span>`}</td>
          <td><b class="ellipsis">${r.name}</b><span class="small muted">${r.game} · ${r.mode === 'soullink' ? t('nav.soullink', 'SoulLink') : t('nav.nuzlocke', 'Nuzlocke')}</span></td>
          <td><${Pips} n=${r.badges || 0} /></td>
          <td class=${`num ${r.deaths > 10 ? 'bad' : ''}`}>${r.deaths ?? '–'}</td>
          <td><span class=${`pf-result ${r.result}`}>${r.result === 'active' ? html`<${Led} on />` : r.result === 'won' ? html`<${Icon} name="heart" size=${11} />` : r.result === 'lost' ? html`<${Icon} name="grave" size=${11} />` : ''}${resultLabel(r.result)}</span></td>
          <td class="num small muted">${r.result === 'active' ? t('pf.nowShort', 'now') : shortDate(r.endedAt)}</td>
        </tr>`;
      })}</tbody></table>` : html`<p class="small muted">${t('pf.noRuns', 'No runs here yet.')}</p>`}
  </section>`;
}

function NowCard({ presence, own, name, onAsk, asked }) {
  const p = presence;
  const live = p && (p.state === 'in_run' || p.state === 'playing');
  return html`<section class="pf-section">
    <div class="pf-head"><h2>${t('pf.now', 'Now')}</h2><span class="pf-rule"></span>
      ${own && html`<span class="pf-tag">${own === 'friends' ? t('pf.visibleFriends', 'Visible to friends') : t('pf.hiddenNow', 'Hidden from friends')}</span>`}</div>
    ${live ? html`<div class="lcd-card pf-now">
      <div class="row"><${Led} on /><span class="px lcd-live">${t('fr.live', 'LIVE')}</span><b class="px">${[p.game?.title, p.run?.name].filter(Boolean).join(' · ')}</b><span class="spacer"></span>
        <span class="small">${[p.location, p.run?.freeSlot ? t('pf.freeSeat', '1 free seat') : ''].filter(Boolean).join(' · ')}</span></div>
      ${!own && canAskToJoin(p) && html`<div class="row fr-live-foot"><span class="small grow">${t('fr.freeAsk', 'This run has a free seat – {name} can let you in.', { name })}</span>
        <button class="btn small primary" disabled=${asked} onClick=${onAsk}>${asked ? t('fr.askedShort', 'Asked') : t('fr.askToJoin', 'Ask to join')}</button></div>`}
    </div>` : html`<p class="small muted pf-quiet">${presenceText(p)}</p>`}
  </section>`;
}

function SideColumn({ prof }) {
  const { library } = useApp();
  const sc = prof.showcase || {};
  const cover = coverForTitle(library, sc.favoriteGame);
  const trophies = sc.trophies.map((id) => ({ id, ach: fromCatalogId(id) })).filter((x) => x.ach);
  return html`<div class="pf-side stack-l">
    ${sc.trusted && html`<section class="pf-section"><div class="pf-head"><h2>${t('pf.trusted', 'Most trusted')}</h2><span class="pf-rule"></span></div>
      <div class="pf-trusted"><span class="pf-trusted-icon"><${Icon} name="heart" size=${22} /></span><p>${sc.trusted}</p></div></section>`}
    ${sc.favoriteGame && html`<div class="pf-fav">${cover ? html`<img class="pixel" src=${cover} alt="" />` : html`<span class="pf-fav-blank"><${Icon} name="play" size=${16} /></span>`}
      <div class="stack-s" style="gap:0"><b>${sc.favoriteGame}</b><span class="small muted">${t('pf.favorite', 'Favourite game')}</span></div></div>`}
    ${trophies.length > 0 && html`<section class="pf-section"><div class="pf-head"><h2>${t('pf.showcase', 'Showcase')}</h2><span class="pf-rule"></span></div>
      <div class="stack-s">${trophies.map(({ ach }) => html`<div class="pf-trophy"><span class="pf-trophy-icon"><${Icon} name="trophy" size=${18} /></span>
        <div class="stack-s" style="gap:0"><b>${achText(ach).name}</b><span class="small muted">${achText(ach).desc}</span></div></div>`)}</div></section>`}
  </div>`;
}

/** The masthead (shared by the profile and the editor's live preview). */
function Masthead({ prof, presence, accent, actions, meta }) {
  return html`<header class="pf-mast" style=${accent ? `--acc:${accent}` : ''}>
    <div class="pf-banner"><${Banner} id=${prof.banner || null} size="fill" shade /></div>
    <div class="pf-id">
      <${Avatar} user=${prof} size=${104} presence=${presence} accent=${accent} />
      <div class="pf-names grow">
        <div class="row tight pf-nameline"><h1 class="pf-name">${prof.name}</h1><${TitlePlate} text=${achTitle(prof.title)} /><${Badges} badges=${prof.badges} /></div>
        <div class="small muted pf-meta">${meta}</div>
        ${prof.status && html`<p class="pf-status">“${prof.status}”</p>`}
      </div>
      <div class="pf-actions row">${actions}</div>
    </div>
  </header>`;
}

// ---- the editor ---------------------------------------------------------------------------------------------------
function Editor({ me, onClose }) {
  const { toast, navigate } = useApp();
  const cat = useCatalog();
  const [choices, setChoices] = useState(null);
  const [d, setD] = useState(() => ({
    banner: me.banner, frame: me.frame, nameplate: me.nameplate, title: me.title, accent: me.accent, status: me.status || '', name: me.name,
    showcase: { trophies: [...me.showcase.trophies], trusted: me.showcase.trusted || '', favoriteGame: me.showcase.favoriteGame || '' },
    privacy: { profile: me.privacy.profile },
  }));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    editorChoices().then(setChoices, () => setChoices({ achievements: [], species: [], games: [] }));
  }, []);
  const tier = me.entitlement?.tier || 'none';
  const items = (kind) => (cat?.cosmetics || []).filter((c) => c.kind === kind).map((c) => ({ ...c, locked: !allowed(c, tier) }));
  const earned = new Set((choices?.achievements || []).map(toCatalogId));
  // earned on this computer – plus what the profile already shows (earned elsewhere), so nothing silently disappears
  const titles = items('title').filter((c) => (earned.has(c.id) || c.id === me.title) && fromCatalogId(c.id));
  const trophyItems = items('trophy').filter((c) => (earned.has(c.id) || me.showcase.trophies.includes(c.id)) && fromCatalogId(c.id));
  const itemOf = (kind, id) => (cat?.cosmetics || []).find((c) => c.kind === kind && c.id === id);
  // locked: the service's catalog says so for this tier – or the cosmetics module says the pick isn't owned
  const [notOwned, setNotOwned] = useState({});
  const lockedPicks = ['banner', 'frame', 'nameplate'].filter((k) => d[k] && (!allowed(itemOf(k, d[k]), tier) || notOwned[k]));
  const pick = (k) => (id, item) => {
    set({ [k]: id || null });
    setNotOwned((x) => ({ ...x, [k]: !!item && item.owned === false }));
  };
  const accent = accentHex(cat, d.accent);
  const set = (patch) => setD((x) => ({ ...x, ...patch }));
  const setShow = (patch) => setD((x) => ({ ...x, showcase: { ...x.showcase, ...patch } }));
  const toggleTrophy = (id) => setShow({ trophies: d.showcase.trophies.includes(id) ? d.showcase.trophies.filter((x) => x !== id) : [...d.showcase.trophies, id].slice(0, 3) });

  const save = async () => {
    const patch = {};
    for (const k of ['banner', 'frame', 'nameplate', 'title', 'accent']) if ((d[k] || null) !== (me[k] || null)) patch[k] = d[k] || null;
    if (d.status.trim() !== (me.status || '')) patch.status = d.status.trim() || null;
    if (d.name.trim() !== me.name) patch.name = d.name.trim() || null;
    const sc = { trophies: d.showcase.trophies, trusted: d.showcase.trusted.trim() || null, favoriteGame: d.showcase.favoriteGame.trim() || null };
    if (JSON.stringify(sc) !== JSON.stringify({ trophies: me.showcase.trophies, trusted: me.showcase.trusted, favoriteGame: me.showcase.favoriteGame })) patch.showcase = sc;
    if (d.privacy.profile !== me.privacy.profile) patch.privacy = { profile: d.privacy.profile };
    if (!Object.keys(patch).length) return onClose();
    setBusy(true);
    try {
      await updateMe(patch);
      toast({ kind: 'ok', title: t('pf.saved', 'Profile saved') });
      onClose();
    } catch (e) {
      toast({ kind: 'death', title: t('pf.saveFailed', 'Couldn’t save the profile'), text: e.message });
    }
    setBusy(false);
  };

  const preview = { ...me, ...d, showcase: { ...d.showcase, trophies: d.showcase.trophies } };
  return html`<${Modal} open wide onClose=${onClose} title=${t('pf.editTitle', 'Edit profile')}
    footer=${html`${lockedPicks.length > 0 && html`<span class="small muted grow acct-lockline"><${Icon} name="lock" size=${12} />${t('pf.lockedNote', 'Preview only – {what} comes with souldew+.', { what: lockedPicks.map((k) => ({ banner: t('pf.banner', 'Banner'), frame: t('pf.frame', 'Frame'), nameplate: t('pf.nameplate', 'Nameplate') }[k])).join(', ') })}
        <a href="#" onClick=${(e) => { e.preventDefault(); onClose(); navigate('settings', settingsLink('plus')); }}>${t('pf.aboutPlus', 'About souldew+')}</a></span>`}
      <button class="btn ghost" onClick=${onClose}>${t('common.cancel', 'Cancel')}</button>
      <button class="btn primary" disabled=${busy || lockedPicks.length > 0} onClick=${save}>${t('common.save', 'Save')}</button>`}>
    <div class="pf-editor">
      <div class="pf-preview" aria-label=${t('pf.preview', 'Preview')}>
        <${Masthead} prof=${preview} accent=${accent} meta=${html`@${me.handle}`} actions=${null} />
      </div>
      ${!cat && html`<p class="small muted">${t('pf.noCatalog', 'Banners, frames and titles load from the account service – it can’t be reached right now.')}</p>`}
      <div class="pf-form stack-l">
        <section class="stack"><h3 class="fr-head">${t('pf.banner', 'Banner')}</h3><${CosmeticPicker} kind="banners" value=${d.banner} onPick=${pick('banner')} /></section>
        <section class="stack"><h3 class="fr-head">${t('pf.frame', 'Frame')}</h3><${CosmeticPicker} kind="frames" value=${d.frame} onPick=${pick('frame')} /></section>
        <section class="stack"><h3 class="fr-head">${t('pf.nameplate', 'Nameplate')}</h3><${CosmeticPicker} kind="nameplates" value=${d.nameplate} onPick=${pick('nameplate')} /></section>
        <div class="grid-2">
          <label class="field"><span>${t('pf.displayName', 'Display name')}</span><input type="text" maxLength="32" value=${d.name} onInput=${(e) => set({ name: e.target.value })} />
            <span class="hint">${t('pf.displayNameHint', 'Empty: your Discord name ({name}).', { name: me.discord?.globalName || me.discord?.username || '' })}</span></label>
          <label class="field"><span>${t('pf.title', 'Title')}</span>
            <select value=${d.title || ''} onChange=${(e) => set({ title: e.target.value || null })}>
              <option value="">${t('pf.noTitle', 'No title')}</option>
              ${titles.map((c) => html`<option value=${c.id}>${achTitle(c.id)}</option>`)}</select>
            <span class="hint">${titles.length ? t('pf.titleHint', 'The names of trophies you earned.') : t('pf.titleNone', 'Earn trophies to unlock titles.')}</span></label>
        </div>
        <label class="field"><span>${t('pf.status', 'Status line')}</span>
          <div class="row nowrap"><input type="text" class="grow" maxLength=${STATUS_MAX} value=${d.status} placeholder=${t('pf.statusPh', 'e.g. grinding Victory Road')} onInput=${(e) => set({ status: e.target.value })} />
            <span class="small muted pf-count">${Array.from(d.status).length}/${STATUS_MAX}</span></div></label>
        <section class="stack"><h3 class="fr-head">${t('pf.accent', 'Accent colour')}</h3>
          <div class="pf-swatches" role="radiogroup" aria-label=${t('pf.accent', 'Accent colour')}>${(cat?.accents || []).map((a) => html`<button type="button" role="radio" aria-checked=${d.accent === a.key} title=${a.key}
            class=${`pf-swatch ${d.accent === a.key ? 'on' : ''}`} style=${`--sw:${a.hex}`} onClick=${() => set({ accent: a.key })}><span class="sr-only">${a.key}</span></button>`)}</div></section>
        <section class="stack"><h3 class="fr-head">${t('pf.showcase', 'Showcase')} <span class="small muted">${t('pf.showcaseHint', 'up to 3 trophies')}</span></h3>
          ${trophyItems.length ? html`<div class="pf-chips">${trophyItems.map((c) => html`<button type="button" class=${`chip pf-chip ${d.showcase.trophies.includes(c.id) ? 'on' : ''}`} aria-pressed=${d.showcase.trophies.includes(c.id)}
            disabled=${!d.showcase.trophies.includes(c.id) && d.showcase.trophies.length >= 3} onClick=${() => toggleTrophy(c.id)}><${Icon} name="trophy" size=${12} />${achTitle(c.id)}</button>`)}</div>`
            : html`<p class="small muted">${t('pf.noTrophies', 'Trophies you earn can go here.')}</p>`}
          <label class="field"><span>${t('pf.trusted', 'Most trusted')}</span>
            <input type="text" maxLength=${TRUSTED_MAX} value=${d.showcase.trusted} placeholder=${t('pf.trustedPh', 'e.g. Breloom line – carried us through the E4')} onInput=${(e) => setShow({ trusted: e.target.value })} />
            ${choices?.species?.length > 0 && html`<div class="pf-chips">${choices.species.slice(0, 8).map((s) => html`<button type="button" class="chip pf-chip" onClick=${() => setShow({ trusted: t('pf.lineOf', '{name} line', { name: speciesName(s.id) }) })}>${speciesName(s.id)}</button>`)}</div>`}</label>
          <label class="field"><span>${t('pf.favorite', 'Favourite game')}</span>
            <input type="text" list="pf-games" maxLength=${FAVORITE_MAX} value=${d.showcase.favoriteGame} onInput=${(e) => setShow({ favoriteGame: e.target.value })} />
            <datalist id="pf-games">${(choices?.games || []).map((g) => html`<option value=${g.title}></option>`)}</datalist></label>
        </section>
        <label class="field" style="max-width:420px"><span>${t('acct.profileVis', 'Who can see my profile')}</span>
          <select value=${d.privacy.profile} onChange=${(e) => set({ privacy: { profile: e.target.value } })}>
            <option value="friends">${t('acct.visFriends', 'My friends')}</option><option value="link">${t('acct.visLink', 'Anyone with my handle')}</option>
            <option value="nobody">${t('acct.visNobody', 'Only me')}</option></select>
          <span class="hint">${t('pf.moreprivacy', 'Presence, location and your runs: Settings › Account.')}</span></label>
      </div>
    </div>
  <//>`;
}

// ---- the page -------------------------------------------------------------------------------------------------------
export function ProfileView() {
  const { route, navigate, toast, session, manifest, doc, me: slot, linkStatus } = useApp();
  const acct = useAccount();
  const cat = useCatalog();
  const id = route.params.id || null;
  const own = !id || id === acct.me?.id;
  const [other, setOther] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [asked, setAsked] = useState(false);
  const { data: friends, reload: reloadFriends } = useFriends(!!acct.session?.signedIn);
  useEffect(() => {
    setOther(null);
    setError(null);
    if (acct.session?.signedIn) reloadFriends(); // another profile: its presence fresh, not from the last poll
    if (!own && acct.session?.signedIn) profileOf(id).then(setOther, (e) => setError(e));
  }, [id, acct.session?.signedIn]);
  const ownPresence = useMemo(() => (own ? presenceFrom({ route: 'profile', session, manifest, doc, me: slot, taken: manifest ? takenSlots(manifest, { me: slot, doc, linkStatus }) : [] }) : null), [own, session, manifest]);
  if (!acct.loaded) return null;
  if (!acct.session?.signedIn) return html`<div class="stack-l"><${SignInFirst} what=${t('pf.signInTitle', 'Your souldew profile')} /></div>`;
  const prof = own ? acct.me : other;
  if (!prof) {
    if (error) return html`<div class="panel empty-state"><${Icon} name="user" size=${48} /><h2>${t('pf.notVisible', 'This profile isn’t visible')}</h2>
      <p class="muted">${t('pf.notVisibleText', 'It may be private, or the player isn’t on souldew any more.')}</p><button class="btn" onClick=${() => navigate('friends')}>${t('nav.friends', 'Friends')}</button></div>`;
    return html`<div class="empty-state"><p class="muted">${t('common.loading', 'Loading …')}</p></div>`;
  }
  const friend = !own ? friends?.friends?.find((f) => f.user.id === prof.id) : null;
  const presence = own ? (acct.me?.privacy?.presence === 'friends' ? ownPresence : { state: 'offline' }) : friend?.presence || null;
  const accent = accentHex(cat, prof.accent);
  const friendCount = own ? friends?.friends?.length : null;
  const meta = own ? [`@${prof.handle}`, prof.createdAt && t('pf.since', 'on souldew since {date}', { date: monthYear(prof.createdAt) }), friendCount != null && t('pf.friendsN', '1 friend|{count} friends', { count: friendCount })].filter(Boolean).join(' · ')
    : [`@${prof.handle}`, prof.memberSince && t('pf.since', 'on souldew since {date}', { date: monthYear(prof.memberSince) }), friend?.since && t('fr.since', 'friends since {date}', { date: monthYear(friend.since) })].filter(Boolean).join(' · ');
  const ask = async () => {
    try {
      await askToJoin(prof.id);
      setAsked(true);
    } catch (e) {
      toast({ kind: 'death', title: t('fr.askFailed', 'Couldn’t ask to join'), text: e.message });
    }
  };
  const actions = own ? html`<button class="btn ghost" onClick=${() => setEditing(true)}><${Icon} name="user" size=${14} />${t('pf.edit', 'Edit profile')}</button>`
    : prof.relationship === 'friend' ? html`<button class="btn go" onClick=${() => setInviting(true)}><${Icon} name="link" size=${14} />${t('fr.inviteTo', 'Invite to a run')}</button>` : null;
  return html`<div class="stack-l profile" style=${accent ? `--acc:${accent}` : ''}>
    ${!own && html`<nav class="pf-crumbs small" aria-label=${t('pf.crumbs', 'Breadcrumb')}><a href="#/friends">${t('nav.friends', 'Friends')}</a><span aria-hidden="true">›</span><span>${prof.name}</span></nav>`}
    <${Masthead} prof=${prof} presence=${presence} accent=${accent} actions=${actions} meta=${meta} />
    ${prof.stats ? html`<${StatsStrip} stats=${prof.stats} />`
      : html`<div class="pf-private small muted"><${Icon} name="lock" size=${12} />${own ? html`<span>${t('pf.privateOwn', 'Your runs stay private. Turn on “Show my runs on my profile” to show friends your numbers and last runs.')}</span>
          <a href="#" onClick=${(e) => { e.preventDefault(); navigate('settings', settingsLink('account-privacy')); }}>${t('pf.turnOn', 'Privacy settings')}</a>`
        : html`<span>${t('pf.privateOther', '{name} keeps their runs private.', { name: prof.name })}</span>`}</div>`}
    <div class="pf-cols">
      <div class="pf-main stack-l">
        <${NowCard} presence=${presence} own=${own ? acct.me?.privacy?.presence : null} name=${prof.name} onAsk=${ask} asked=${asked} />
        ${prof.stats && html`<${RunHistory} stats=${prof.stats} title=${own ? t('pf.history', 'Run history') : t('pf.theirRuns', '{name}’s runs', { name: prof.name })} />`}
      </div>
      <${SideColumn} prof=${prof} />
    </div>
    ${editing && html`<${Editor} me=${acct.me} onClose=${() => setEditing(false)} />`}
    ${inviting && html`<${InviteModal} friend=${prof} onClose=${() => setInviting(false)} />`}
  </div>`;
}
