// Link sessions between the players of a run: trades and battles the in-game way (docs/MULTIPLAYER.md). This is the
// page's half – invite, answer, the check that every seat's game is here (SHA-1, never the ROM itself), the battery
// saves (encrypted by the run's channel, compressed), the start, then the buttons and hashes while it runs. Every peer's
// link host runs ALL seats; only the buttons travel – here over the run's peer channel (web/lib/sync.mjs `link`).
//
// Up to four seats (docs/MULTIPLAYER.md › "Four players"): any 2 of the run's players trade while the others play on;
// 3–4 seats for multi battles and the Union Room. Buttons go to every other seat directly (a mesh: no player is a
// relay or a clock for the others – each host waits for the inputs it lacks); the input delay comes from the slowest
// link.
//
// Messages (msg.t), all with msg.sid = the session id; every player speaks for their OWN seat's game only:
//   invite {kind, seats:[slot], sha1:{me}, crc:{me}, system}   from the one who starts it
//   accept {sha1:{me}, crc:{me}} | refuse {reason}            every invited player, to everybody in the session
//   ready                                                     "every seat's game is here" (after a pick or a build)
//   save   {slot, sha1, i, n, data}                           each seat's battery save, in parts (base64 deflate-raw)
//   ping {n} / pong {n}                                       the round trip, measured by the inviter
//   go     {delay, rtc}                                       from the inviter: everybody starts the link host
//   in     {s, f, k:[…]}                                      seat s's buttons from frame f on (u32 each) – also a
//                                                             resend of any seat's, which any peer may answer
//   need   {s, f}                                             "I miss seat s's buttons from frame f" (a gap)
//   hash   {f, h}                                             every 120 frames
//   rejoin                                                    a player whose game dropped out comes back …
//   state  {i, n, data, frame} | state-busy                  … and gets the session as the others have it
//   bye    {reason}                                           a player left: the session ends for everybody
import { serverErrorText } from './errors.mjs';

const PART = 12 * 1024; // bytes of base64 per message (well below the data channel's message size)
const FRAME_MS = 1000 / 59.7275;
const REJOIN_KEY = (runId) => `sl-link-${runId}`;
const REJOIN_MAX_MS = 30 * 60 * 1000;
export const linkDelay = (rttMs) => Math.min(60, Math.max(4, Math.ceil(((rttMs / 2) * 1.25) / FRAME_MS) + 3));

const sha1 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const newSid = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');
export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
const deflate = (b) => pipe(b, new CompressionStream('deflate-raw'));
const inflate = (b) => pipe(b, new DecompressionStream('deflate-raw'));
const store = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(k) || 'null');
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // private mode
    }
  },
};

/** Parts of a big blob over the channel: collects { i, n, data } and gives the joined string once all are there. */
function collect(box, m) {
  if (!Number.isInteger(m.n) || m.n < 1 || m.n > 20000 || !Number.isInteger(m.i) || m.i < 0 || m.i >= m.n || typeof m.data !== 'string') return null;
  box.parts ||= [];
  box.parts[m.i] = m.data;
  box.got = box.parts.filter((x) => x !== undefined).length;
  return box.got === m.n ? box.parts.join('') : null;
}

/**
 * One per run and page. `sync`: the run's SyncLink; `onChange(state)` re-renders the UI; `openSession(target)` starts
 * the play view's game for a running link session; `closeSession(state)` ends it.
 * state: { phase: 'idle' | 'inviting' | 'invited' | 'preparing' | 'need' | 'running' | 'rejoinable' | 'rejoining' |
 *          'ended', sid, kind, seats, host, sha1, crc, missing, route, … }
 */
export class LinkSessions {
  constructor({ sync, runId, me, onChange = () => {}, openSession = () => {}, closeSession = () => {}, emu = () => null, fetchImpl = null }) {
    Object.assign(this, { sync, runId, me, onChange, openSession, closeSession, emu });
    this.fetch = fetchImpl || ((...a) => fetch(...a)); // (tests give each player's page its own server)
    this.state = { phase: 'idle' };
    this.off = sync.onLink((m) => this._in(m));
    this.onWindow = (e) => this._fromPlayer(e);
    addEventListener('message', this.onWindow);
    this.cmdQueue = [];
    this.stats = {}; // (tests / diagnostics: hashes compared, inputs sent and received, resends)
    this.cmdBusy = false;
    this.needAt = {};
    // a session this page was in when it went away (reload, crash, app restart): offer to rejoin it
    const old = store.get(REJOIN_KEY(runId));
    if (old?.sid && Date.now() - (old.at || 0) < REJOIN_MAX_MS && Array.isArray(old.seats) && old.seats.includes(me)) {
      this.state = { phase: 'rejoinable', ...old };
    } else if (old) store.set(REJOIN_KEY(runId), null);
    this.routeTimer = setInterval(() => this._routes(), 3000);
    this.routeTimer?.unref?.(); // (Node, in tests: no reason to stay alive)
  }

  stop() {
    this.off?.();
    clearInterval(this.routeTimer);
    removeEventListener('message', this.onWindow);
    // (a running session isn't ended by closing the page: the others wait, this player may come back – rejoin)
    if (this.state.phase === 'preparing' || this.state.phase === 'need' || this.state.phase === 'inviting') this.leave('closed');
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  /** The other seats of the session (their slots). */
  get partners() {
    return (this.state.seats || []).filter((s) => s !== this.me);
  }

  _send(msg, { relayToo = false, to = null } = {}) {
    return this.sync.sendLink({ ...msg, sid: this.state.sid }, to || this.partners, { relayToo });
  }

  /** The local server's JSON API (as web/lib/api.mjs: an error carries the server's code). */
  async _api(path, body) {
    const res = await this.fetch(path, body === undefined ? { headers: { 'x-soullink': '1' } }
      : { method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(serverErrorText(data || {}, res.status)), { code: data?.code });
    return data;
  }

  /** What this computer has of every seat's game: { system, supported, tool, slots: { p1: { rom, sha1, crc } } }. */
  check() {
    return this._api(`/api/link/check?runId=${this.runId}`);
  }

  /** Start a session with `slots` (the others; kind 'trade' | 'battle'). */
  async invite(kind, slots) {
    if (!['idle', 'ended', 'rejoinable'].includes(this.state.phase)) throw new Error('busy');
    const c = await this.check();
    if (!c.tool || !c.supported) throw Object.assign(new Error('unsupported'), { code: c.tool ? 'linkSystem' : 'linkMissing' });
    const own = c.slots[this.me];
    if (!own?.rom) throw Object.assign(new Error('missing'), { code: 'linkOwnMissing' });
    const seats = [this.me, ...slots.filter((s) => s !== this.me)];
    store.set(REJOIN_KEY(this.runId), null);
    this._set({
      phase: 'inviting', sid: newSid(), kind, seats, host: this.me, sha1: { [this.me]: own.sha1 }, crc: { [this.me]: own.crc || null },
      accepted: {}, ready: {}, saves: {}, missing: null, error: null, system: c.system, ended: null, route: {}, waiting: null,
    });
    this._send({ t: 'invite', kind, seats, sha1: { [this.me]: own.sha1 }, crc: { [this.me]: own.crc || null }, system: c.system }, { relayToo: true });
  }

  /** Answer an invite. */
  async accept() {
    const st = this.state;
    if (st.phase !== 'invited') return;
    const c = await this.check().catch(() => null);
    const own = c?.slots?.[this.me];
    const bad = !c?.tool ? 'linkMissing' : !c.supported || c.system !== st.system ? 'linkSystem' : !own?.rom ? 'linkOwnMissing' : null;
    if (bad) {
      this._send({ t: 'refuse', reason: bad }, { relayToo: true });
      return this._set({ phase: 'ended', error: bad, ended: { reason: bad, mine: true, at: Date.now() } });
    }
    st.sha1[this.me] = own.sha1;
    st.crc[this.me] = own.crc || null;
    st.accepted[this.me] = true;
    this._set({ phase: 'preparing' });
    this._send({ t: 'accept', sha1: { [this.me]: own.sha1 }, crc: { [this.me]: own.crc || null } }, { relayToo: true });
    await this._sendSave();
    this._resolve();
  }

  decline() {
    if (this.state.phase !== 'invited') return;
    this._send({ t: 'refuse', reason: 'declined' }, { relayToo: true });
    this._set({ phase: 'idle', sid: null });
  }

  /**
   * Once every seat's SHA-1 is known: are all those games on this computer? Missing ones → phase 'need' (the play view
   * asks the player to pick their copy or to build the partner's game), else 'ready' to everybody.
   */
  async _resolve() {
    const st = this.state;
    if (!['preparing', 'need'].includes(st.phase) || !st.seats.every((s) => st.sha1[s])) return;
    const seats = Object.fromEntries(st.seats.map((s) => [s, { sha1: st.sha1[s], crc: st.crc[s] || null }]));
    let r;
    try {
      r = await this._api('/api/link/resolve', { runId: this.runId, seats });
    } catch (e) {
      return this._fail(e.code || 'linkStart');
    }
    if (this.state.sid !== st.sid) return;
    if (r.missing.length) return this._set({ phase: 'need', missing: r.missing });
    this._set({ phase: 'preparing', missing: null });
    st.ready[this.me] = true;
    this._send({ t: 'ready' }, { relayToo: true });
    this._maybeGo();
  }

  /** "Pick your copy of FireRed": a library ROM for a partner's seat (the server takes it only by SHA-1). */
  async pickRom(slot, romId) {
    await this._api('/api/link/pick', { runId: this.runId, slot, sha1: this.state.sha1[slot], romId });
    await this._resolve();
  }

  /** "Build Tim's game" (a randomized / patched run): that seat's game from the run's settings, then check again. */
  async buildPartner(slot) {
    this._set({ building: slot });
    try {
      await this._api('/api/link/build', { runId: this.runId, slot });
    } finally {
      this._set({ building: null });
    }
    await this._resolve();
  }

  /** Our battery save as it is on disk now (the game running here flushes it first), to every partner. */
  async _sendSave() {
    window.dispatchEvent(new Event('sl-save-now')); // (the play view writes the running game's save to disk)
    await new Promise((r) => setTimeout(r, 1200));
    let bytes = new Uint8Array(0);
    try {
      const r = await this.fetch(`/api/runs/${this.runId}/save/${this.me}`);
      if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
    } catch {
      // no save: a new game on that seat
    }
    const hash = bytes.length ? await sha1(bytes) : '';
    const data = bytes.length ? b64(await deflate(bytes)) : '';
    const n = Math.max(1, Math.ceil(data.length / PART));
    this.state.saves[this.me] = { sha1: hash, b64: bytes.length ? b64(bytes) : '' };
    for (let i = 0; i < n; i++) this._send({ t: 'save', slot: this.me, sha1: hash, i, n, data: data.slice(i * PART, (i + 1) * PART) }, { relayToo: true });
    this._maybeGo();
  }

  /** Leave (or cancel): the session ends for everybody. */
  leave(reason = 'left') {
    const st = this.state;
    if (st.phase === 'rejoinable') {
      store.set(REJOIN_KEY(this.runId), null);
      return this._set({ phase: 'idle', sid: null });
    }
    if (!st.sid || st.phase === 'idle' || st.phase === 'ended') return;
    this._send({ t: 'bye', reason }, { relayToo: true });
    this._end(reason, true);
  }

  _fail(code) {
    this._send({ t: 'bye', reason: code }, { relayToo: true });
    this._end(code, true);
  }

  /** The session is over. A desync puts the run's save back to what it was before (on every computer). */
  async _end(reason, mine = false) {
    const was = this.state.phase;
    const st = this.state;
    store.set(REJOIN_KEY(this.runId), null);
    let restored = null;
    if (reason === 'linkDesync' && st.id && (was === 'running' || was === 'rejoining')) {
      try {
        restored = await this._api('/api/link/restore', { runId: this.runId, id: st.id, slot: this.me });
      } catch {
        restored = null;
      }
    }
    this._set({ phase: 'ended', ended: { reason, mine, at: Date.now(), restored } });
    if (was === 'running' || was === 'rejoining') this.closeSession(this.state);
  }

  // ---- incoming ----------------------------------------------------------------------------------------------------
  async _in(m) {
    const st = this.state;
    if (m.t === 'invite') {
      if (!Array.isArray(m.seats) || !m.seats.includes(this.me) || m.seats.length > 4 || !['idle', 'ended', 'rejoinable'].includes(st.phase)) return;
      return this._set({
        phase: 'invited', sid: m.sid, kind: m.kind === 'battle' ? 'battle' : 'trade', seats: m.seats, host: m.from, sha1: { [m.from]: m.sha1?.[m.from] || null },
        crc: { [m.from]: m.crc?.[m.from] || null }, saves: {}, accepted: { [m.from]: true }, ready: {}, missing: null, error: null, system: m.system, ended: null,
        route: {}, waiting: null,
      });
    }
    if (m.sid !== st.sid) return;
    if (!(st.seats || []).includes(m.from)) return;
    if (m.t === 'refuse') return this._end(m.reason || 'declined');
    if (m.t === 'bye') return this._end(m.reason || 'left');
    if (m.t === 'accept') {
      if (typeof m.sha1?.[m.from] !== 'string') return;
      st.sha1[m.from] = m.sha1[m.from];
      st.crc[m.from] = m.crc?.[m.from] || null;
      st.accepted[m.from] = true;
      if (st.phase === 'inviting' && this.partners.every((s) => st.accepted[s])) {
        this._set({ phase: 'preparing' });
        await this._sendSave();
      }
      this._resolve();
      return;
    }
    if (m.t === 'ready') {
      st.ready[m.from] = true;
      return this._maybeGo();
    }
    if (m.t === 'save') {
      const box = (st.saves[m.from] ||= { sha1: m.sha1 });
      if (typeof box.b64 === 'string') return;
      const packed = collect(box, m);
      if (packed === null) return;
      const bytes = packed ? await inflate(unb64(packed)) : new Uint8Array(0);
      if (bytes.length && (await sha1(bytes)) !== m.sha1) return this._fail('linkSaveDiffers');
      box.b64 = bytes.length ? b64(bytes) : '';
      return this._maybeGo();
    }
    if (m.t === 'ping') return this._send({ t: 'pong', n: m.n }, { to: [m.from] });
    if (m.t === 'pong' && this.pings?.[m.n]) {
      this.rtts.push(performance.now() - this.pings[m.n]);
      return;
    }
    if (m.t === 'go' && m.from === st.host) return this._start(m.delay, m.rtc);
    if (m.t === 'in' && st.phase === 'running') return this._toHost(m);
    if (m.t === 'in' && (st.phase === 'preparing' || st.phase === 'rejoining')) return (this.early ||= []).push(m); // (our host is still starting)
    if (m.t === 'need' && st.phase === 'running') return this._need(m);
    if (m.t === 'hash' && st.phase === 'running') return this._hash(m.from, m.f, m.h);
    if (m.t === 'rejoin' && st.phase === 'running') return this._donate(m.from);
    if (m.t === 'state' && st.phase === 'rejoining') return this._stateIn(m);
    if (m.t === 'state-busy' && st.phase === 'rejoining') return this._end('linkRejoinBusy', true);
  }

  /** Inviter: once every seat's save is here and every player has every game, measure the round trip and say go. */
  async _maybeGo() {
    const st = this.state;
    if (st.host !== this.me || st.phase !== 'preparing' || this.going) return;
    if (!st.seats.every((s) => typeof st.saves[s]?.b64 === 'string' && st.ready[s])) return;
    this.going = true;
    this.pings = {};
    this.rtts = [];
    for (let n = 0; n < 5; n++) {
      this.pings[n] = performance.now();
      this._send({ t: 'ping', n });
      await new Promise((r) => setTimeout(r, 120));
    }
    await new Promise((r) => setTimeout(r, 400));
    // the slowest link counts (a mesh: every host waits for every seat)
    const rtt = this.rtts.length ? Math.max(...this.rtts) : 150;
    const connected = this.partners.every((s) => this.sync.linkDirect(s));
    this.going = false;
    if (this.state.sid !== st.sid) return;
    if (!connected) return this._fail('linkNoDirect');
    const delay = linkDelay(rtt);
    const rtc = Date.now();
    this._send({ t: 'go', delay, rtc });
    this._set({ rtt: Math.round(rtt) });
    this._start(delay, rtc);
  }

  async _start(delay, rtc, state = null) {
    const st = this.state;
    // the partners' saves may still be inflating (messages are handled as they come)
    for (let i = 0; !state && i < 100 && !st.seats.every((s) => s === this.me || typeof st.saves[s]?.b64 === 'string'); i++) await new Promise((r) => setTimeout(r, 100));
    try {
      const seats = st.seats.map((slot) => ({
        slot, sha1: st.sha1[slot], crc: st.crc[slot] || null,
        save: slot === this.me || state ? null : st.saves[slot]?.b64 || null, saveSha1: state ? null : st.saves[slot]?.sha1 || null,
      }));
      const r = await this._api('/api/link/start', { runId: this.runId, local: this.me, seats, delay, rtc, ...(state ? { state } : {}) });
      this.hashes = {};
      this._set({ phase: 'running', id: r.id, delay, rtc, local: r.local, waiting: null, startedAt: Date.now() });
      // what a reload / crash needs to come back into this session (docs/MULTIPLAYER.md › "Rejoin")
      store.set(REJOIN_KEY(this.runId), { sid: st.sid, kind: st.kind, seats: st.seats, host: st.host, sha1: st.sha1, crc: st.crc, delay, rtc, system: st.system, at: Date.now() });
      this.openSession(this.state);
      for (const m of (this.early || []).splice(0)) this._toHost(m);
    } catch (e) {
      this._fail(e.code || 'linkStart');
    }
  }

  // ---- rejoin ------------------------------------------------------------------------------------------------------
  /** Back into a session this page dropped out of: ask the others for its state. */
  rejoin() {
    const st = this.state;
    if (st.phase !== 'rejoinable') return;
    this._set({ phase: 'rejoining', stateBox: {}, ended: null });
    this._send({ t: 'rejoin' }, { relayToo: true });
    clearTimeout(this.rejoinTimer);
    this.rejoinTimer = setTimeout(() => this.state.phase === 'rejoining' && !this.state.stateBox?.got && this._end('linkRejoinGone', true), 15000);
    this.rejoinTimer?.unref?.();
  }

  /** A partner rejoins: the one with the lowest seat among those still in sends the session's state. */
  async _donate(slot) {
    const st = this.state;
    const stay = st.seats.filter((s) => s !== slot && (s === this.me || this.sync.linkDirect(s)));
    if (stay[0] !== this.me) return;
    let bytes = null;
    for (let i = 0; i < 10 && !bytes; i++) { // (a DS console in the middle of a wireless exchange: not now – try again)
      bytes = await this.emu()?.linkState?.().catch(() => null);
      if (!bytes) await new Promise((r) => setTimeout(r, 300));
    }
    if (!bytes) return this._send({ t: 'state-busy' }, { to: [slot], relayToo: true });
    const data = b64(await deflate(bytes));
    const n = Math.max(1, Math.ceil(data.length / PART));
    this.stats.donated = (this.stats.donated || 0) + 1;
    for (let i = 0; i < n; i++) this._send({ t: 'state', i, n, data: data.slice(i * PART, (i + 1) * PART) }, { to: [slot] });
  }

  async _stateIn(m) {
    const st = this.state;
    const packed = collect(st.stateBox, m);
    if (packed === null) return;
    clearTimeout(this.rejoinTimer);
    this.stats.rejoined = (this.stats.rejoined || 0) + 1;
    this._start(st.delay, st.rtc, packed);
  }

  // ---- while it runs ---------------------------------------------------------------------------------------------------
  /** From the fast player (playernative.html): the host's buttons for the partners, hashes, waits. */
  _fromPlayer(e) {
    if (e.origin !== location.origin || this.state.phase !== 'running') return;
    const d = e.data;
    if (d?.type === 'emu-link-input' && d.bytes) {
      const v = new DataView(d.bytes.buffer, d.bytes.byteOffset, d.bytes.byteLength);
      const k = [];
      for (let o = 8; o + 4 <= d.bytes.length; o += 4) k.push(v.getUint32(o, true));
      const to = this.resendTo && v.getUint32(0, true) !== this.state.local ? this.resendTo.splice(0) : null; // (an answer to a need)
      this._send({ t: 'in', s: v.getUint32(0, true), f: v.getUint32(4, true), k }, to?.length ? { to } : {});
      this.stats.sent = (this.stats.sent || 0) + 1;
    } else if (d?.type === 'emu-link-hash') {
      this._send({ t: 'hash', f: d.frame, h: d.hash });
      this._hash(this.me, d.frame, d.hash);
    } else if (d?.type === 'emu-link-wait') {
      this._set({ waiting: { seats: d.seats, ms: d.ms, frame: d.frame, at: Date.now() } });
      // a gap: ask every partner for the missing seats' buttons from that frame (any of them can answer)
      const now = Date.now();
      this.state.seats.forEach((slot, s) => {
        if (!(d.seats & (1 << s)) || now - (this.needAt[s] || 0) < 500) return;
        this.needAt[s] = now;
        this.stats.needs = (this.stats.needs || 0) + 1;
        this._send({ t: 'need', s, f: d.frame });
      });
    }
  }

  /** A partner misses seat m.s's buttons from frame m.f: our host sends what it has (NEED → LINPUT → 'in'). */
  _need(m) {
    if (!Number.isInteger(m.s) || m.s < 0 || m.s >= this.state.seats.length || !Number.isInteger(m.f) || m.f < 0) return;
    (this.resendTo ||= []).push(m.from);
    this.stats.resends = (this.stats.resends || 0) + 1;
    this._cmd(25, [m.s, m.f >>> 0]);
  }

  _hash(slot, f, h) {
    const box = (this.hashes[f] ||= {});
    box[slot] = h;
    const got = Object.values(box);
    this.stats.hashes = (this.stats.hashes || 0) + 1;
    if (got.length > 1 && got.some((x) => x !== got[0])) {
      this.stats.mismatch = { frame: f, hashes: { ...box } };
      return this._fail('linkDesync');
    }
    if (got.length === this.state.seats.length) delete this.hashes[f];
    const old = Object.keys(this.hashes).map(Number).filter((x) => x < f - 1200);
    for (const x of old) delete this.hashes[x];
  }

  /** Buttons of seat m.s into our link host (any seat but our own – a resend may come from any partner). */
  _toHost(m) {
    const k = Array.isArray(m.k) ? m.k : [];
    const seat = m.s;
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.state.seats.length || seat === this.state.local || !k.length || k.length > 4096) return;
    this._cmd(21, [seat, m.f >>> 0, ...k]);
    this.stats.received = (this.stats.received || 0) + 1;
  }

  /** A command to the link host (u32 words), batched: one request at a time, what comes meanwhile goes along. */
  _cmd(type, words) {
    const b = new Uint8Array(8 + words.length * 4);
    const v = new DataView(b.buffer);
    v.setUint32(0, type, true);
    v.setUint32(4, words.length * 4, true);
    words.forEach((x, i) => v.setUint32(8 + i * 4, x >>> 0, true));
    this.cmdQueue.push(b);
    this._flushCmds();
  }

  _flushCmds() {
    if (this.cmdBusy || !this.cmdQueue.length || !this.state.id) return;
    const parts = this.cmdQueue.splice(0);
    const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) body.set(p, o), (o += p.length);
    this.cmdBusy = true;
    this.fetch(`/api/native/cmd?id=${this.state.id}`, { method: 'POST', headers: { 'x-soullink': '1' }, body })
      .then((r) => r.arrayBuffer())
      .catch(() => null)
      .then(() => {
        this.cmdBusy = false;
        this._flushCmds();
      });
  }

  /** How each partner is connected (direct / relayed through TURN), for the bar – while a session is being set up or runs. */
  async _routes() {
    const st = this.state;
    if (!['preparing', 'need', 'running', 'inviting'].includes(st.phase)) return;
    const route = {};
    for (const s of this.partners) route[s] = (await this.sync.linkRoute?.(s).catch(() => null)) || null;
    if (this.state.sid === st.sid && JSON.stringify(route) !== JSON.stringify(st.route || {})) this._set({ route });
  }
}
