// Shared World, the play view's half (docs/MULTIPLAYER.md › 9): the local player's state from the player page goes to
// the partners over the run's peer channel (web/lib/sync.mjs `world`), the partners' states go into the player page's
// overlay (web/lib/worldoverlay.mjs), and what's picked in its menu starts a trade or battle (web/lib/linksession.mjs)
// or sends a wave.
//
// Bandwidth stays small and bounded: a state is ~40 bytes, sent only on the overworld, at most 15 times a second while
// something changes and once a second while standing still; partners without a direct link get one every 2 s over the
// encrypted relay. Messages (msg.t): 'p' { w: packState } · 'wave' · 'bye' (left the game).
import { html } from '/vendor/htm-preact.mjs';
import { packState, changed, SEND } from '/shared/world.mjs';
import { t } from './i18n.mjs';

const GONE_MS = 5000; // a partner silent this long is gone from the overlay

/** Systems with a Shared World so far (Gen 3 on the GBA; the player page checks the game itself). */
export const WORLD_SYSTEMS = ['gba'];

/** The per-run "Show partners in my game" switch (this computer only, default on). */
export const worldPrefKey = (runId) => `sl-world-${runId}`;
export function worldEnabled(runId) {
  try {
    return localStorage.getItem(worldPrefKey(runId)) !== 'false';
  } catch {
    return true;
  }
}
export function setWorldEnabled(runId, on) {
  try {
    localStorage.setItem(worldPrefKey(runId), on ? 'true' : 'false');
  } catch {
    // storage blocked: the switch holds for this session
  }
}

/**
 * One per play view of a SoulLink game. `sync`: the run's SyncLink; `frame()`: the player iframe; `players`: { slot:
 * { name, color } }; `actions`: { slot: { trade, battle, why } } – what the menu offers for that partner right now;
 * `onAction(act, slot)`: 'trade' | 'battle' from the menu (waves are handled here).
 */
export class SharedWorld {
  constructor({ sync, me, frame, players = {}, enabled = true, actions = {}, onAction = () => {}, onNear = () => {}, onSupported = () => {}, now = () => performance.now() }) {
    Object.assign(this, { sync, me, frame, players, enabled, actions, onAction, onNear, onSupported, now });
    this.near = 0;
    this.seq = 0;
    this.sent = null; // the last state sent { st, at, relayAt }
    this.local = null;
    this.heard = new Map(); // slot → when (our clock)
    this.configured = new WeakSet(); // the player pages (window objects) told so far
    this.stats = { sent: 0, relayed: 0, received: 0, bytes: 0 };
    this.offWorld = sync?.onWorld?.((m, via) => this._in(m, via)) || null;
    this.onMsg = (e) => this._fromPlayer(e);
    addEventListener('message', this.onMsg);
    this.timer = setInterval(() => this._tick(), 500);
  }

  get world() {
    return this.frame()?.contentWindow?.__world || null;
  }

  /** Changes from the play view (names, colours, the switch, what the link rules allow right now). */
  update(patch) {
    Object.assign(this, patch);
    this.configured = new WeakSet();
    this._configure();
  }

  labels() {
    return {
      trade: t('world.trade', 'Trade'),
      battle: t('world.battle', 'Battle'),
      wave: t('world.wave', 'Wave'),
      cancel: t('common.cancel', 'Cancel'),
      tagHint: t('world.tagHint', 'Trade, battle or wave'),
      keys: t('world.menuKeys', 'A choose · B back'),
    };
  }

  _configure() {
    const w = this.world;
    const win = this.frame()?.contentWindow;
    if (!w || !win || this.configured.has(win)) return;
    this.configured.add(win);
    // (true once the player page found this game's tables – the switch shows only then)
    Promise.resolve(w.config({ me: this.me, players: this.players, enabled: this.enabled, actions: this.actions, labels: this.labels() }))
      .then((ok) => this.onSupported(!!ok), () => this.onSupported(false));
  }

  _tick() {
    this._configure();
    const now = this.now();
    for (const [slot, at] of this.heard) {
      if (now - at > GONE_MS) {
        this.heard.delete(slot);
        this.world?.gone(slot);
      }
    }
    // a heartbeat while standing still (late joiners, a relay that lost one)
    if (this.local) this._send(this.local);
  }

  _fromPlayer(e) {
    const win = this.frame()?.contentWindow;
    if (e.origin !== location.origin || !win || e.source !== win) return;
    const d = e.data;
    if (d?.type === 'emu-world' && d.st) {
      this.local = d.st;
      this._send(d.st);
      const n = Number(d.near) || 0;
      if (n !== this.near) this.onNear((this.near = n));
    } else if (d?.type === 'emu-world-act' && typeof d.slot === 'string') {
      if (d.act === 'wave') {
        this.sync?.sendWorld({ t: 'wave' }, { relay: true });
        this.stats.waves = (this.stats.waves || 0) + 1;
      } else if (d.act === 'trade' || d.act === 'battle') this.onAction(d.act, d.slot);
      // (for integrations and tests: what was picked, wherever the link flow lives)
      dispatchEvent(new CustomEvent('sl-world-action', { detail: { act: d.act, slot: d.slot } }));
    }
  }

  /** Sends the state when it changed (≤ 15/s) or as a heartbeat (1/s); the relay gets one every 2 s at most. */
  _send(st) {
    if (!this.sync) return;
    const now = this.now();
    const s = this.sent;
    const diff = changed(st, s?.st);
    if (s && !diff && now - s.at < SEND.idleMs) return;
    if (s && diff && now - s.at < SEND.minMs) return;
    // standing hidden (a battle, a menu screen): one message says so, then quiet but for the heartbeat
    const w = packState(st, ++this.seq, now);
    const relayDue = s?.relayAt == null || now - s.relayAt >= SEND.relayMs;
    const others = this.sync.others || [];
    const direct = this.sync.sendWorld({ t: 'p', w });
    const needRelay = others.some((slot) => !direct.has(slot) && this.sync.status?.partners?.[slot]);
    if (needRelay && relayDue) {
      this.sync.sendWorld({ t: 'p', w }, { relay: true });
      this.stats.relayed++;
    }
    this.stats.sent++;
    this.stats.bytes += JSON.stringify(w).length + 20;
    this.sent = { st, at: now, relayAt: needRelay && relayDue ? now : s?.relayAt ?? null };
  }

  _in(m) {
    if (!m || typeof m.from !== 'string' || m.from === this.me) return;
    const w = this.world;
    this.heard.set(m.from, this.now());
    this.stats.received++;
    if (m.t === 'p' && Array.isArray(m.w)) w?.partner(m.from, m.w);
    else if (m.t === 'wave') w?.wave(m.from);
    else if (m.t === 'bye') {
      this.heard.delete(m.from);
      w?.gone(m.from);
    }
  }

  stop() {
    clearInterval(this.timer);
    removeEventListener('message', this.onMsg);
    this.offWorld?.();
    try {
      this.sync?.sendWorld({ t: 'bye' }, { relay: false });
    } catch {
      // the link is gone already
    }
    this.world?.config({ enabled: false });
  }
}

/** The switch in the play view's side panel: "Show partners in my game". */
export function WorldToggle({ on, onChange, live }) {
  return html`<label class="world-toggle" title=${t('world.toggleHint', 'Your partners walk in your game when you’re on the same map. Walk up to them and press A to trade, battle or wave.')}>
    <input type="checkbox" checked=${on} onChange=${(e) => onChange(e.currentTarget.checked)} />
    <span class="world-switch" aria-hidden="true"></span>
    <span class="tiny">${t('world.toggle', 'Show partners in my game')}</span>
    ${on && live > 0 && html`<span class="tiny faint">· ${t('world.nearby', '{n} here', { n: live })}</span>`}
  </label>`;
}
