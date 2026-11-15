// Trades and battles between the players of a run (docs/MULTIPLAYER.md, web/lib/linksession.mjs): the buttons on the
// board's player cards, the invite, and the bar that says what the link is doing.
import { html, useState } from '/vendor/htm-preact.mjs';
import { useApp } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { players as getPlayers, rules as getRules } from '../lib/run.mjs';

/** Systems whose games can link in this version (the link host's backends). */
export const LINK_SYSTEMS = ['gba', 'gb', 'gbc'];

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
  linkRomMissing: t('linkplay.romMissing', 'A player’s game isn’t built on one of the computers yet. Open the run and build every player’s game, then try again.'),
  linkRomDiffers: t('linkplay.romDiffers', 'The games aren’t byte-identical on both computers (another base ROM or version). Linking needs exactly the same games.'),
  linkSaveDiffers: t('linkplay.saveDiffers', 'A save arrived damaged. Try again.'),
  linkNoDirect: t('linkplay.noDirect', 'There’s no direct connection to {name} – linking needs one. Check the Connection page.', { name }),
  linkDesync: t('linkplay.desync', 'The games fell out of step – the link has ended. Nothing after the last in-game save was kept.'),
  linkStart: t('linkplay.startFailed', 'The linked games didn’t start.'),
}[code] || t('linkplay.left', 'The link has ended.'));

/** Trade / Battle on a partner's card (the board): only when both can link right now. */
export function LinkButtons({ slot }) {
  const { doc, manifest, me, onlineSlots, linkSessions, linkPlay, linkStatus, toast } = useApp();
  const [busy, setBusy] = useState(false);
  if (!linkSessions || slot === me || !LINK_SYSTEMS.includes(manifest?.game?.system)) return null;
  const online = onlineSlots?.has?.(slot);
  const direct = !!linkStatus?.partners?.[slot]?.p2p;
  const idle = !linkPlay || linkPlay.phase === 'idle' || linkPlay.phase === 'ended';
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
  const why = !online ? t('linkplay.needOnline', '{name} isn’t online', { name }) : !direct ? t('linkplay.needDirect', 'No direct connection to {name} yet', { name }) : null;
  return html`<div class="row link-buttons">
    ${linkAllowed(doc, manifest, 'trade') && html`<button class="btn small" disabled=${busy || !idle || !!why} title=${why || t('linkplay.tradeHint', 'Both games open in the link – meet in the Pokémon Center upstairs, as with a cable')}
      onClick=${() => start('trade')}><${Icon} name="link" size=${14} />${t('linkplay.trade', 'Trade')}</button>`}
    ${linkAllowed(doc, manifest, 'battle') && html`<button class="btn small" disabled=${busy || !idle || !!why} title=${why || t('linkplay.battleHint', 'A link battle in the Colosseum – losses here don’t count for the run')}
      onClick=${() => start('battle')}><${Icon} name="bolt" size=${14} />${t('linkplay.battle', 'Battle')}</button>`}
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
  let body;
  if (st.phase === 'invited') {
    body = html`<span class="grow">${st.kind === 'battle' ? t('linkplay.invitedBattle', '{name} wants to battle you!', { name: host }) : t('linkplay.invitedTrade', '{name} wants to trade Pokémon with you!', { name: host })}
        <span class="small muted"> ${t('linkplay.saveFirst', 'Save in your game first – the link starts from your last in-game save.')}</span></span>
      <button class="btn small primary" onClick=${() => linkSessions.accept()}>${t('linkplay.join', 'Join')}</button>
      <button class="btn small ghost" onClick=${() => linkSessions.decline()}>${t('linkplay.notNow', 'Not now')}</button>`;
  } else if (st.phase === 'inviting' || st.phase === 'preparing') {
    body = html`<span class="grow">${st.phase === 'inviting' ? t('linkplay.waitingFor', 'Waiting for {name} to join the {kind} …', { name: others, kind }) : t('linkplay.preparing', 'Getting the link ready: checking the games, swapping saves …')}</span>
      <button class="btn small ghost" onClick=${() => linkSessions.leave('left')}>${t('common.cancel', 'Cancel')}</button>`;
  } else if (st.phase === 'running') {
    const waiting = st.waiting && Date.now() - st.waiting.at < 1500;
    body = html`<span class="grow"><b>${t('linkplay.linked', 'Linked with {name}', { name: others })}</b>
        <span class="small muted"> · ${waiting ? t('linkplay.waitingPartner', 'waiting for {name} …', { name: others }) : t('linkplay.delay', 'delay {n} frames', { n: st.delay })}
        · ${t('linkplay.goUpstairs', 'Meet in the Pokémon Center, upstairs at the counter.')}</span></span>
      <button class="btn small" onClick=${() => linkSessions.leave('left')}>${t('linkplay.leave', 'Leave link')}</button>`;
  } else if (st.phase === 'ended') {
    body = html`<span class="grow">${reasonText(st.ended?.reason || st.error, others || host)}</span>
      <button class="btn small ghost" onClick=${() => linkSessions._set({ phase: 'idle', sid: null })}>${t('common.close', 'Close')}</button>`;
  }
  return html`<div class="link-bar panel row" role="status" aria-live="polite"><${Icon} name="link" size=${16} />${body}</div>`;
}
