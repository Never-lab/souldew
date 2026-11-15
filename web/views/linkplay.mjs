// Trades and battles between the players of a run (docs/MULTIPLAYER.md, web/lib/linksession.mjs): the buttons on the
// board's player cards, the invite, the partner's game (pick your copy / build it), and the bar that says what the link
// is doing.
import { html, useState, useEffect } from '/vendor/htm-preact.mjs';
import { useApp } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { api } from '../lib/api.mjs';
import { serverErrorText } from '../lib/errors.mjs';
import { players as getPlayers, rules as getRules, slotsOf } from '../lib/run.mjs';
import { sameLinkSystem, LINK_SYSTEMS } from '/shared/link.mjs';

export { LINK_SYSTEMS }; // (the board shows the link buttons for these)


/** Does this run allow link sessions of `kind` ('trade' | 'battle')? The run rule (default: allowed). */
export function linkAllowed(doc, manifest, kind) {
  const r = getRules(doc, manifest) || {};
  if (!LINK_SYSTEMS.includes(manifest?.game?.system)) return false;
  return kind === 'battle' ? r.linkBattles !== 'off' : r.linkTrades !== 'off';
}

export const reasonText = (code, name) => ({
  declined: t('linkplay.declined', '{name} doesn’t want to right now.', { name }),
  left: t('linkplay.left', 'The link has ended.'),
  closed: t('linkplay.left', 'The link has ended.'),
  linkMissing: t('linkplay.missing', 'This version of souldew can’t link games yet – update it on both computers.'),
  linkSystem: t('linkplay.system', 'Linking isn’t available for this game yet.'),
  linkOwnMissing: t('linkplay.ownMissing', 'Your own game for this run isn’t built on this computer.'),
  linkRomMissing: t('linkplay.romMissing2', 'A player’s game isn’t on one of the computers – the link needs every player’s game on every computer.'),
  linkSaveDiffers: t('linkplay.saveDiffers', 'A save arrived damaged. Try again.'),
  linkNoDirect: t('linkplay.noConnection', 'There’s no connection to {name} – check the Connection page and try again.', { name }),
  linkDesync: t('linkplay.desync2', 'The games fell out of step, so the link was stopped. To keep it fair, both of you are back at your saves from before the link – the session’s last save is kept as a backup in the run folder.'),
  linkStart: t('linkplay.startFailed', 'The linked games didn’t start.'),
  linkRejoinGone: t('linkplay.rejoinGone', 'Nobody answered – the others have left the link.'),
  linkRejoinBusy: t('linkplay.rejoinBusy', 'The others’ games are in the middle of a wireless exchange right now, so you can’t rejoin – the link has ended.'),
  busy: t('linkplay.busy', '{name} is in another link right now.', { name }),
  linkNoAnswer: t('linkplay.noAnswer', '{name} didn’t answer.', { name }),
}[code] || serverErrorText({ code }) || t('linkplay.left', 'The link has ended.')); // (a server's code: its own text)

/** Where the players meet in their games for this system. */
const meetText = (system) => system === 'nds'
  ? t('linkplay.goUnionRoom', 'Meet in the Pokémon Center: the Union Room counter (DS wireless).')
  : t('linkplay.goUpstairs', 'Meet in the Pokémon Center, upstairs at the counter.');

/** "direct · 42 ms" / "relayed · 80 ms" for the partners of the session. */
function routeText(route) {
  const list = Object.values(route || {}).filter(Boolean);
  if (!list.length) return null;
  const relayed = list.some((r) => r.route === 'relayed');
  const rtt = list.map((r) => r.rtt).filter(Number.isFinite);
  const ms = rtt.length ? ` · ${Math.max(...rtt)} ms` : '';
  return relayed ? t('linkplay.relayed', 'relayed (TURN)') + ms : t('linkplay.direct', 'direct') + ms;
}

/** Trade / Battle on a partner's card (the board): only when both can link right now. */
export function LinkButtons({ slot }) {
  const { doc, manifest, me, onlineSlots, linkSessions, linkPlay, linkStatus, toast } = useApp();
  const [busy, setBusy] = useState(false);
  if (!linkSessions || slot === me || !LINK_SYSTEMS.includes(manifest?.game?.system)) return null;
  const online = onlineSlots?.has?.(slot);
  const direct = !!linkStatus?.partners?.[slot]?.p2p;
  const idle = !linkPlay || ['idle', 'ended', 'rejoinable'].includes(linkPlay.phase);
  const name = getPlayers(doc, manifest)[slot]?.name || slot;
  const start = async (kind) => {
    setBusy(true);
    try {
      await linkSessions.invite(kind, [slot]);
    } catch (e) {
      toast({ kind: 'death', title: t('linkplay.title', 'Link'), text: reasonText(e.code, name) });
    } finally {
      setBusy(false);
    }
  };
  const why = !online ? t('linkplay.needOnline', '{name} isn’t online', { name }) : !direct ? t('linkplay.needConnection', 'No connection to {name} yet', { name }) : null;
  return html`<div class="row link-buttons">
    ${linkAllowed(doc, manifest, 'trade') && html`<button class="btn small" disabled=${busy || !idle || !!why} title=${why || t('linkplay.tradeHint', 'Both games open in the link – meet in the Pokémon Center upstairs, as with a cable')}
      onClick=${() => start('trade')}><${Icon} name="link" size=${14} />${t('linkplay.trade', 'Trade')}</button>`}
    ${linkAllowed(doc, manifest, 'battle') && html`<button class="btn small" disabled=${busy || !idle || !!why} title=${why || t('linkplay.battleHint2', 'A link battle – by the run’s rules, losing there doesn’t count')}
      onClick=${() => start('battle')}><${Icon} name="bolt" size=${14} />${t('linkplay.battle', 'Battle')}</button>`}
  </div>`;
}

/**
 * With three or four players: one invite for everybody online (Gen 3 multi battles need four linked games, the DS
 * Union Room takes all of them).
 */
export function LinkGroupButton() {
  const { doc, manifest, me, onlineSlots, linkSessions, linkPlay, linkStatus, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const slots = manifest ? slotsOf(manifest) : [];
  if (!linkSessions || slots.length < 3 || !LINK_SYSTEMS.includes(manifest?.game?.system) || !linkAllowed(doc, manifest, 'battle')) return null;
  const ready = slots.filter((s) => s !== me && onlineSlots?.has?.(s) && linkStatus?.partners?.[s]?.p2p);
  const idle = !linkPlay || ['idle', 'ended', 'rejoinable'].includes(linkPlay.phase);
  const go = async () => {
    setBusy(true);
    try {
      await linkSessions.invite('battle', ready);
    } catch (e) {
      toast({ kind: 'death', title: t('linkplay.title', 'Link'), text: reasonText(e.code, '') });
    } finally {
      setBusy(false);
    }
  };
  return html`<button class="btn small" disabled=${busy || !idle || ready.length < 2}
    title=${t('linkplay.groupHint', 'All of you in one link: multi battles (Gen 3: four players) and the Union Room')}
    onClick=${go}><${Icon} name="link" size=${14} />${t('linkplay.group', 'Link all of us ({n})', { n: ready.length + 1 })}</button>`;
}

/** "Pick your copy of FireRed" / "Build Tim's game": what's missing before the link can start. */
function NeedRoms({ st, names }) {
  const { linkSessions, manifest } = useApp();
  const [lib, setLib] = useState(null);
  const [pick, setPick] = useState({});
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const loadLib = () => api.get('/api/library').then((l) => setLib((l.roms || []).filter((r) => sameLinkSystem(r.system, manifest?.game?.system))));
  useEffect(() => {
    loadLib().catch(() => setLib([]));
  }, []);
  // a file that isn't in the library yet: into the library (as the Library page adds one), then found by its checksum
  const addFile = async (file) => {
    const res = await fetch(`/api/library/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'x-soullink': '1' }, body: file });
    if (!res.ok) throw Object.assign(new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`), {});
    loadLib().catch(() => {});
    await linkSessions.recheck();
    // (still missing: the added file isn't that game – name the first seat still missing)
    if (linkSessions.state.phase === 'need') throw Object.assign(new Error('differs'), { code: 'linkPickDiffers', slot: linkSessions.state.missing?.[0]?.slot });
  };
  const run = async (fn) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e.code === 'linkPickDiffers' ? t('linkplay.pickDiffers', 'That file isn’t the same game as {name}’s (its SHA-1 differs) – it must be exactly the same release.', { name: names[e.slot]?.name || '' }) : serverErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="stack small">
    ${(st.missing || []).map((m) => {
      const name = names[m.slot]?.name || m.slot;
      if (m.canBuild) {
        return html`<div class="row" key=${m.slot}><span class="grow">${t('linkplay.needBuild', '{name}’s game isn’t built on this computer yet (your run was joined before linking existed).', { name })}</span>
          <button class="btn small primary" disabled=${busy || st.building} onClick=${() => run(() => linkSessions.buildPartner(m.slot))}>
            ${st.building === m.slot ? t('linkplay.building', 'Building …') : t('linkplay.build', 'Build {name}’s game', { name })}</button></div>`;
      }
      return html`<div class="stack-s" key=${m.slot}>
        <span>${t('linkplay.needPick', '{name} plays another file of this game. Pick your copy of it – souldew checks it’s exactly the same (SHA-1).', { name })}</span>
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
          <select class="input small" style="flex:1 1 240px;min-width:0" aria-label=${t('linkplay.pickLabel', 'Your copy of {name}’s game', { name })} value=${pick[m.slot] || ''}
            onChange=${(e) => setPick({ ...pick, [m.slot]: e.target.value })}>
            <option value="">${lib ? t('linkplay.pickOne', 'Choose a game from your library …') : t('common.loading', 'Loading …')}</option>
            ${(lib || []).map((r) => html`<option value=${r.id}>${r.title || r.name}</option>`)}
          </select>
          <button class="btn small primary" disabled=${busy || !pick[m.slot]} onClick=${() => run(() => linkSessions.pickRom(m.slot, pick[m.slot]).catch((e) => { e.slot = m.slot; throw e; }))}>${t('linkplay.pickUse', 'Use this file')}</button>
          <label class="btn small ghost">${t('linkplay.pickAdd', 'Add a file …')}<input type="file" hidden accept=".gb,.gbc,.gba,.nds,.zip"
            onChange=${(e) => { const f = e.target.files?.[0]; if (f) run(() => addFile(f)); e.target.value = ''; }} /></label>
        </div>
      </div>`;
    })}
    ${err && html`<span class="error small" role="alert">${err}</span>`}
  </div>`;
}

/** What the link is doing: an invite to answer, the preparation, the running link (with Leave), how it ended. */
export function LinkBar() {
  const { doc, manifest, linkPlay: st, linkSessions } = useApp();
  if (!st || !linkSessions || st.phase === 'idle') return null;
  const names = getPlayers(doc, manifest);
  const others = (st.seats || []).filter((s) => s !== linkSessions.me).map((s) => names[s]?.name || s).join(', ');
  const host = names[st.host]?.name || st.host;
  const kind = st.kind === 'battle' ? t('linkplay.kindBattle', 'battle') : t('linkplay.kindTrade', 'trade');
  const route = routeText(st.route);
  let body;
  if (st.phase === 'invited') {
    body = html`<span class="grow">${st.kind === 'battle' ? t('linkplay.invitedBattle', '{name} wants to battle you!', { name: host }) : t('linkplay.invitedTrade', '{name} wants to trade Pokémon with you!', { name: host })}
        <span class="small muted"> ${t('linkplay.saveFirst', 'Save in your game first – the link starts from your last in-game save.')}</span></span>
      <button class="btn small primary" onClick=${() => linkSessions.accept()}>${t('linkplay.join', 'Join')}</button>
      <button class="btn small ghost" onClick=${() => linkSessions.decline()}>${t('linkplay.notNow', 'Not now')}</button>`;
  } else if (st.phase === 'inviting' || st.phase === 'preparing') {
    body = html`<span class="grow">${st.phase === 'inviting' ? t('linkplay.waitingFor', 'Waiting for {name} to join the {kind} …', { name: others, kind }) : t('linkplay.preparing', 'Getting the link ready: checking the games, swapping saves …')}
        ${route && html`<span class="small muted"> · ${route}</span>`}</span>
      <button class="btn small ghost" onClick=${() => linkSessions.leave('left')}>${t('common.cancel', 'Cancel')}</button>`;
  } else if (st.phase === 'need') {
    body = html`<div class="grow stack small"><b>${t('linkplay.needTitle', 'One more thing before the link starts')}</b><${NeedRoms} st=${st} names=${names} /></div>
      <button class="btn small ghost" onClick=${() => linkSessions.leave('left')}>${t('common.cancel', 'Cancel')}</button>`;
  } else if (st.phase === 'running') {
    const waiting = st.waiting && Date.now() - st.waiting.at < 1500;
    body = html`<span class="grow"><b>${t('linkplay.linked', 'Linked with {name}', { name: others })}</b>
        <span class="small muted"> · ${waiting ? t('linkplay.waitingPartner2', 'waiting for {name} … (if their game dropped out, they can rejoin)', { name: others }) : t('linkplay.delay', 'delay {n} frames', { n: st.delay })}
        ${route && html` · <span class="link-route" data-route=${Object.values(st.route || {}).some((r) => r?.route === 'relayed') ? 'relayed' : 'direct'}>${route}</span>`}
        · ${meetText(st.system || manifest?.game?.system)}</span></span>
      <button class="btn small" onClick=${() => linkSessions.leave('left')}>${t('linkplay.leave', 'Leave link')}</button>`;
  } else if (st.phase === 'rejoinable' || st.phase === 'rejoining') {
    body = html`<span class="grow">${st.phase === 'rejoining' ? t('linkplay.rejoining', 'Rejoining the link – getting the games from the others …') : t('linkplay.rejoinOffer', 'Your link with {name} was cut off. The others are waiting – rejoin?', { name: others })}</span>
      ${st.phase === 'rejoinable' && html`<button class="btn small primary" onClick=${() => linkSessions.rejoin()}>${t('linkplay.rejoin', 'Rejoin')}</button>`}
      <button class="btn small ghost" onClick=${() => linkSessions.leave('left')}>${t('linkplay.dropIt', 'Leave it')}</button>`;
  } else if (st.phase === 'ended') {
    const r = st.ended?.restored;
    body = html`<span class="grow">${reasonText(st.ended?.reason || st.error, others || host)}${r?.backup ? html` <span class="small muted">(${r.backup})</span>` : ''}</span>
      <button class="btn small ghost" onClick=${() => linkSessions.dismiss()}>${t('common.close', 'Close')}</button>`;
  }
  return html`<div class="link-bar panel row" role="status" aria-live="polite"><${Icon} name="link" size=${16} />${body}</div>`;
}
