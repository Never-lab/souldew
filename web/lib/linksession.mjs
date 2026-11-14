// Link sessions between the players of a run: trades and battles the in-game way (docs/MULTIPLAYER.md). This is the
// page's half – invite, answer, the check that every seat's game is here (SHA-1, never the ROM itself), the battery
// saves (encrypted by the run's channel, compressed), the start, then the buttons and hashes while it runs. Every peer's
// link host runs ALL seats; only the buttons travel – here over the run's peer channel (web/lib/sync.mjs `link`).
//
// Up to four seats (docs/MULTIPLAYER.md › "Four players"): any 2 of the run's players trade while the others play on;
// 3–4 seats for multi battles. Buttons go to every other seat directly (a mesh: no player is a relay or a clock for
// the others – each host waits for the inputs it lacks); the input delay comes from the slowest link.
//
// Messages (msg.t), all with msg.sid = the session id:
//   invite {kind, seats:[slot], sha1:{slot: sha1}, system}   from the one who starts it
//   accept {sha1:{slot: sha1}} | refuse {reason}            every invited player
//   save   {slot, sha1, i, n, data}                          each seat's battery save, in parts (base64 of deflate-raw)
//   ping {n} / pong {n}                                     the round trip, measured by the inviter
//   go     {delay, rtc}                                     from the inviter: everybody starts the link host
//   in     {s, f, k:[…]}                                     seat s's inputs from frame f on (u32 each)
//   hash   {f, h}                                            every 120 frames
//   bye    {reason}                                          a player left: the session ends for everybody
import { api } from './api.mjs';

const PART = 12 * 1024; // bytes of base64 per save message (well below the data channel's message size)
const FRAME_MS = 1000 / 59.7275;
export const linkDelay = (rttMs) => Math.min(60, Math.max(4, Math.ceil(((rttMs / 2) * 1.25) / FRAME_MS) + 3));

const sha1 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const newSid = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');
function b64(bytes) {
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

/**
 * One per run and page. `sync`: the run's SyncLink; `onChange(state)` re-renders the UI; `openSession(target)` starts
 * the play view's game for a running link session; `closeSession()` ends it.
 * state: { phase: 'idle' | 'inviting' | 'invited' | 'preparing' | 'running' | 'ended', sid, kind, seats, from, … }
 */
export class LinkSessions {
  constructor({ sync, runId, me, onChange = () => {}, openSession = () => {}, closeSession = () => {} }) {
    Object.assign(this, { sync, runId, me, onChange, openSession, closeSession });
    this.state = { phase: 'idle' };
    this.off = sync.onLink((m) => this._in(m));
    this.onWindow = (e) => this._fromPlayer(e);
    addEventListener('message', this.onWindow);
    this.cmdQueue = [];
    this.cmdBusy = false;
  }

  stop() {
    this.off?.();
    removeEventListener('message', this.onWindow);
    if (this.state.phase === 'running' || this.state.phase === 'preparing') this.leave('closed');
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  /** The other seats of the session (their slots). */
  get partners() {
    return (this.state.seats || []).filter((s) => s !== this.me);
  }

  _send(msg, { relayToo = false } = {}) {
    return this.sync.sendLink({ ...msg, sid: this.state.sid }, this.partners, { relayToo });
  }

  /** What this computer has of every seat's game: { system, supported, tool, slots: { p1: { rom, sha1 } } }. */
  check() {
    return api.get(`/api/link/check?runId=${this.runId}`);
  }

  /** Start a session with `slots` (the others; kind 'trade' | 'battle'). */
  async invite(kind, slots) {
    if (this.state.phase !== 'idle' && this.state.phase !== 'ended') throw new Error('busy');
    const c = await this.check();
    if (!c.tool || !c.supported) throw Object.assign(new Error('unsupported'), { code: c.tool ? 'linkSystem' : 'linkMissing' });
    const seats = [this.me, ...slots];
    const missing = seats.filter((s) => !c.slots[s]?.rom);
    if (missing.length) throw Object.assign(new Error('missing'), { code: 'linkRomMissing', slots: missing });
    const sha = Object.fromEntries(seats.map((s) => [s, c.slots[s].sha1]));
    this._set({ phase: 'inviting', sid: newSid(), kind, seats, host: this.me, sha1: sha, accepted: {}, saves: {}, error: null, system: c.system });
    this._send({ t: 'invite', kind, seats, sha1: sha, system: c.system }, { relayToo: true });
  }

  /** Answer an invite. */
  async accept() {
    const st = this.state;
    if (st.phase !== 'invited') return;
    const c = await this.check().catch(() => null);
    const bad = !c?.tool ? 'linkMissing' : !c.supported ? 'linkSystem' : st.seats.find((s) => !c.slots[s]?.rom) ? 'linkRomMissing' : st.seats.find((s) => c.slots[s].sha1 !== st.sha1[s]) ? 'linkRomDiffers' : null;
    if (bad) {
      this._send({ t: 'refuse', reason: bad }, { relayToo: true });
      return this._set({ phase: 'ended', error: bad });
    }
    this._set({ phase: 'preparing' });
    this._send({ t: 'accept', sha1: Object.fromEntries(st.seats.map((s) => [s, c.slots[s].sha1])) }, { relayToo: true });
    await this._sendSave();
  }

  decline() {
    if (this.state.phase !== 'invited') return;
    this._send({ t: 'refuse', reason: 'declined' }, { relayToo: true });
    this._set({ phase: 'idle', sid: null });
  }

  /** Our battery save as it is on disk now (the game running here flushes it first), to every partner. */
  async _sendSave() {
    window.dispatchEvent(new Event('sl-save-now')); // (the play view writes the running game's save to disk)
    await new Promise((r) => setTimeout(r, 1200));
    let bytes = new Uint8Array(0);
    try {
      const r = await fetch(`/api/runs/${this.runId}/save/${this.me}`);
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
    if (!st.sid || st.phase === 'idle' || st.phase === 'ended') return;
    this._send({ t: 'bye', reason }, { relayToo: true });
    this._end(reason, true);
  }

  _end(reason, mine = false) {
    const was = this.state.phase;
    this._set({ phase: 'ended', ended: { reason, mine, at: Date.now() } });
    if (was === 'running') this.closeSession(this.state);
  }

  // ---- incoming ----------------------------------------------------------------------------------------------------
  async _in(m) {
    const st = this.state;
    if (m.t === 'invite') {
      if (!Array.isArray(m.seats) || !m.seats.includes(this.me) || (st.phase !== 'idle' && st.phase !== 'ended')) return;
      return this._set({ phase: 'invited', sid: m.sid, kind: m.kind === 'battle' ? 'battle' : 'trade', seats: m.seats, host: m.from, sha1: m.sha1 || {}, saves: {}, accepted: {}, error: null, system: m.system });
    }
    if (m.sid !== st.sid) return;
    if (m.t === 'refuse') return this._end(m.reason || 'declined');
    if (m.t === 'bye') return this._end(m.reason || 'left');
    if (m.t === 'accept' && st.host === this.me) {
      if (st.seats.some((s) => m.sha1?.[s] !== st.sha1[s])) {
        this._send({ t: 'bye', reason: 'linkRomDiffers' }, { relayToo: true });
        return this._end('linkRomDiffers', true);
      }
      st.accepted[m.from] = true;
      if (st.phase === 'inviting' && this.partners.every((s) => st.accepted[s])) {
        this._set({ phase: 'preparing' });
        await this._sendSave();
      }
      return;
    }
    if (m.t === 'save') {
      const box = (st.saves[m.from] ||= { parts: [], sha1: m.sha1 });
      box.parts[m.i] = m.data;
      if (box.parts.filter((x) => x !== undefined).length === m.n && !box.b64 && box.b64 !== '') {
        const packed = box.parts.join('');
        const bytes = packed ? await inflate(unb64(packed)) : new Uint8Array(0);
        if (bytes.length && (await sha1(bytes)) !== m.sha1) {
          this._send({ t: 'bye', reason: 'linkSaveDiffers' }, { relayToo: true });
          return this._end('linkSaveDiffers', true);
        }
        box.b64 = bytes.length ? b64(bytes) : '';
        this._maybeGo();
      }
      return;
    }
    if (m.t === 'ping') return this._send({ t: 'pong', n: m.n });
    if (m.t === 'pong' && this.pings?.[m.n]) {
      this.rtts.push(performance.now() - this.pings[m.n]);
      return;
    }
    if (m.t === 'go' && m.from === st.host) return this._start(m.delay, m.rtc);
    if (m.t === 'in' && st.phase === 'running') return this._toHost(21, m);
    if (m.t === 'in' && st.phase === 'preparing') return (this.early ||= []).push(m); // (our host is still starting)
    if (m.t === 'hash' && st.phase === 'running') return this._hash(m.from, m.f, m.h);
  }

  /** Inviter: once every seat's save is here, measure the round trip and say go. */
  async _maybeGo() {
    const st = this.state;
    if (st.host !== this.me || st.phase !== 'preparing' || this.going) return;
    if (!st.seats.every((s) => typeof st.saves[s]?.b64 === 'string')) return;
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
    const direct = this.partners.every((s) => this.sync.linkDirect(s));
    this.going = false;
    if (!direct) {
      this._send({ t: 'bye', reason: 'linkNoDirect' }, { relayToo: true });
      return this._end('linkNoDirect', true);
    }
    const delay = linkDelay(rtt);
    const rtc = Date.now();
    this._send({ t: 'go', delay, rtc });
    this._set({ rtt: Math.round(rtt) });
    this._start(delay, rtc);
  }

  async _start(delay, rtc) {
    const st = this.state;
    // the partners' saves may still be inflating (messages are handled as they come)
    for (let i = 0; i < 100 && !st.seats.every((s) => s === this.me || typeof st.saves[s]?.b64 === 'string'); i++) await new Promise((r) => setTimeout(r, 100));
    try {
      const seats = st.seats.map((slot) => ({ slot, sha1: st.sha1[slot], save: slot === this.me ? null : st.saves[slot]?.b64 || null, saveSha1: st.saves[slot]?.sha1 || null }));
      const r = await api.post('/api/link/start', { runId: this.runId, local: this.me, seats, delay, rtc });
      this.hashes = {};
      this._set({ phase: 'running', id: r.id, delay, local: r.local, waiting: null, startedAt: Date.now() });
      this.openSession(this.state);
      for (const m of (this.early || []).splice(0)) this._toHost(21, m);
    } catch (e) {
      this._send({ t: 'bye', reason: e.code || 'linkStart' }, { relayToo: true });
      this._end(e.code || 'linkStart', true);
    }
  }

  // ---- while it runs ---------------------------------------------------------------------------------------------------
  /** From the fast player (playernative.html): the local seat's inputs, hashes, waits. */
  _fromPlayer(e) {
    if (e.origin !== location.origin || this.state.phase !== 'running') return;
    const d = e.data;
    if (d?.type === 'emu-link-input' && d.bytes) {
      const v = new DataView(d.bytes.buffer, d.bytes.byteOffset, d.bytes.byteLength);
      const k = [];
      for (let o = 8; o + 4 <= d.bytes.length; o += 4) k.push(v.getUint32(o, true));
      this._send({ t: 'in', s: v.getUint32(0, true), f: v.getUint32(4, true), k });
    } else if (d?.type === 'emu-link-hash') {
      this._send({ t: 'hash', f: d.frame, h: d.hash });
      this._hash(this.me, d.frame, d.hash);
    } else if (d?.type === 'emu-link-wait') this._set({ waiting: { seats: d.seats, ms: d.ms, at: Date.now() } });
  }

  _hash(slot, f, h) {
    const box = (this.hashes[f] ||= {});
    box[slot] = h;
    const got = Object.values(box);
    if (got.length > 1 && got.some((x) => x !== got[0])) {
      this._send({ t: 'bye', reason: 'linkDesync' }, { relayToo: true });
      return this._end('linkDesync', true);
    }
    if (got.length === this.state.seats.length) delete this.hashes[f];
    const old = Object.keys(this.hashes).map(Number).filter((x) => x < f - 1200);
    for (const x of old) delete this.hashes[x];
  }

  /** A partner's inputs into our link host (batched: one request at a time, what comes meanwhile goes along). */
  _toHost(type, m) {
    const k = Array.isArray(m.k) ? m.k : [];
    const seat = this.state.seats.indexOf(m.from);
    if (seat < 0 || seat !== m.s || !k.length || k.length > 4096) return;
    const b = new Uint8Array(16 + k.length * 4);
    const v = new DataView(b.buffer);
    v.setUint32(0, type, true);
    v.setUint32(4, 8 + k.length * 4, true);
    v.setUint32(8, seat, true);
    v.setUint32(12, m.f >>> 0, true);
    k.forEach((x, i) => v.setUint32(16 + i * 4, x >>> 0, true));
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
    fetch(`/api/native/cmd?id=${this.state.id}`, { method: 'POST', headers: { 'x-soullink': '1' }, body })
      .then((r) => r.arrayBuffer())
      .catch(() => null)
      .then(() => {
        this.cmdBusy = false;
        this._flushCmds();
      });
  }
}
