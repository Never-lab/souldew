// Link sessions (trades and battles between the players of a run, docs/MULTIPLAYER.md) – everything but the link host
// itself (test/linkhost.test.mjs): which file plays each seat (server/lib/linkroms.mjs), the TURN servers
// (server/lib/linkice.mjs), the link host's arguments and the commands a page may send (server/lib/native.mjs), the
// link rooms on the "You are here" sign, the trade's log entry, and the page's protocol (web/lib/linksession.mjs): two
// players wired through a fake peer channel – invite, the partner's game, saves, go, buttons, a gap and its resend,
// a desync and the saves going back, a rejoin from the others' state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { ownSeat, resolveSeat, pickSeat, loadPicks, partnerBuildRequest, extractTarget } from '../server/lib/linkroms.mjs';
import { cleanIceServers, linkIceServers, resetLinkIce } from '../server/lib/linkice.mjs';
import { linkArgs, checkLinkCommands, LCMD, LINK_SYSTEMS } from '../server/lib/native.mjs';
import { command } from '../server/lib/ctr.mjs';
import { baseRomsFor } from '../shared/restart.mjs';
import { readLocation } from '../shared/live/location.mjs';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('/shared/')) return next(ROOT + spec.slice(1), ctx);
    if (spec.startsWith('/vendor/')) return next(ROOT + 'web' + spec, ctx);
    return next(spec, ctx);
  },
});

const dir = mkdtempSync(join(tmpdir(), 'souldew-link-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const sha1 = (b) => createHash('sha1').update(b).digest('hex');
const file = (name, bytes) => {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
};

// ---- server/lib/linkroms.mjs ---------------------------------------------------------------------------------------
test('linkroms: my own seat – its SHA-1, and the CRC only for a plain run (the library ROM as it is)', () => {
  const rom = file('a.gba', Buffer.from('emerald'));
  const runFile = (id, name) => join(dir, name);
  const plain = { id: 'r1', outputs: { p1: { rom: 'a.gba' } }, base: { crc: 'abcd1234' }, randomizer: { enabled: false } };
  assert.deepEqual(ownSeat(plain, 'p1', runFile), { path: rom, sha1: sha1(Buffer.from('emerald')), crc: 'ABCD1234' });
  assert.equal(ownSeat({ ...plain, randomizer: { enabled: true } }, 'p1', runFile).crc, null, 'a randomized game is no library ROM');
  assert.deepEqual(ownSeat(plain, 'p2', runFile), { path: null, sha1: null, crc: null });
});

test('linkroms: a seat is found by SHA-1 – the build, another build, a pick, the library by CRC (zips unpacked)', () => {
  const run = join(dir, 'run');
  mkdirSync(run, { recursive: true });
  const runFile = (id, name) => join(run, name);
  const mine = Buffer.from('my emerald'), theirs = Buffer.from('their firered'), other = Buffer.from('another file');
  writeFileSync(join(run, 'p1.gba'), mine);
  writeFileSync(join(run, 'p2.gba'), mine); // a plain run built both seats from my file
  const m = { id: 'r', outputs: { p1: { rom: 'p1.gba' }, p2: { rom: 'p2.gba' } }, randomizer: { enabled: false } };
  const deps = { runFile, dir: run, libraryRoms: [] };
  assert.equal(resolveSeat(m, 'p1', sha1(mine), null, deps).how, 'build');
  assert.equal(resolveSeat({ ...m, outputs: { p1: m.outputs.p1 } }, 'p2', sha1(mine), null, deps).how, 'same', 'the partner plays the same file as me');
  assert.equal(resolveSeat(m, 'p2', sha1(theirs), null, deps), null, 'their game isn\'t here');
  assert.equal(resolveSeat(m, 'p2', 'nope', null, deps), null);
  // the library: only a ROM with their CRC is hashed, and only an equal SHA-1 counts
  const fr = file('FireRed.gba', theirs);
  const lib = [{ id: 'x', file: file('Other.gba', other), crc: '11111111' }, { id: 'y', file: fr, crc: 'DEADBEEF' }];
  assert.equal(resolveSeat(m, 'p2', sha1(theirs), 'deadbeef', { ...deps, libraryRoms: lib }).path, fr);
  assert.ok(loadPicks(run)[sha1(theirs)], 'remembered for next time');
  assert.equal(resolveSeat(m, 'p2', sha1(theirs), null, deps).how, 'picked', 'found again without the library');
  assert.equal(resolveSeat(m, 'p2', sha1(other), '11111110', { ...deps, libraryRoms: lib }), null, 'another CRC: not looked at');
  // a zipped library ROM: unpacked (here: a stand-in) and checked
  const zipped = { id: 'z::g.gba', container: 'z.zip', entry: 'g.gba', crc: 'CAFEF00D', system: 'gba' };
  const target = extractTarget(run, zipped);
  assert.match(target, /link-g\.gba$/);
  const ex = () => (writeFileSync(target, Buffer.from('zipped')), target);
  assert.equal(resolveSeat(m, 'p2', sha1(Buffer.from('zipped')), 'cafef00d', { ...deps, libraryRoms: [zipped], extract: ex }).path, target);
});

test('linkroms: "Pick your copy" takes a file only when its SHA-1 is the partner\'s', () => {
  const run = join(dir, 'pick');
  const good = file('good.gba', Buffer.from('same')), bad = file('bad.gba', Buffer.from('different'));
  assert.equal(pickSeat({ id: 'g', file: good }, sha1(Buffer.from('same')), { dir: run }), good);
  assert.equal(pickSeat({ id: 'b', file: bad }, sha1(Buffer.from('same')), { dir: run }), null);
  assert.equal(pickSeat(null, sha1(Buffer.from('same')), { dir: run }), null);
  assert.equal(loadPicks(run)[sha1(Buffer.from('same'))].path, good);
});

test('linkroms: "Build Tim\'s game" – the run\'s own base, patch, settings and seeds, that slot only', () => {
  const m = { id: 'r9', name: 'Run', mode: 'soullink', players: { p1: { name: 'A' }, p2: { name: 'B' } }, base: { crc: 'AAAA0001' }, game: { id: 'pokemon-emerald', hackId: null, system: 'gba' },
    patch: { sha1: 'p'.repeat(40), hackId: 'h' }, randomizer: { enabled: true, values: { x: 1 }, seeds: { p1: '1', p2: '2' }, sharedSeed: false }, expectedOutputs: { p2: { sha1: 'e'.repeat(40) } } };
  const lib = { roms: [{ id: 'rom1', crc: 'AAAA0001', gameId: 'pokemon-emerald' }], patches: [{ id: 'pat', sha1: 'p'.repeat(40) }] };
  const b = partnerBuildRequest(m, 'p2', lib, baseRomsFor);
  assert.deepEqual([b.runId, b.romId, b.patchId, b.buildFor, b.seeds, b.randomize, b.values], ['r9', 'rom1', 'pat', ['p2'], { p1: '1', p2: '2' }, true, { x: 1 }]);
  assert.deepEqual(b.expectedOutputs, m.expectedOutputs);
  assert.throws(() => partnerBuildRequest(m, 'p2', { roms: [], patches: lib.patches }, baseRomsFor), (e) => e.code === 'no-rom');
  assert.throws(() => partnerBuildRequest(m, 'p2', { roms: lib.roms, patches: [] }, baseRomsFor), (e) => e.code === 'no-patch');
});

// ---- server/lib/linkice.mjs ------------------------------------------------------------------------------------------
test('linkice: only well-formed STUN/TURN entries; TURN only with credentials', () => {
  assert.deepEqual(cleanIceServers([
    { urls: ['stun:stun.cloudflare.com:3478', 'javascript:alert(1)'] },
    { urls: 'turn:turn.cloudflare.com:3478?transport=udp', username: 'u', credential: 'c' },
    { urls: ['turns:turn.cloudflare.com:5349?transport=tcp'] }, // no credentials
    { urls: [] }, null,
  ]), [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }]);
  assert.deepEqual(cleanIceServers('x'), []);
});

test('linkice: the bot\'s /link/ice, cached while the credentials are young; STUN only when it can\'t be reached', async () => {
  resetLinkIce();
  const calls = [];
  const answer = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }], ttl: 7200, turn: true };
  const fetchImpl = async (url) => (calls.push(url), { ok: true, json: async () => answer });
  const a = await linkIceServers({ fetchImpl, env: {}, now: 1000 });
  assert.equal(a.turn, true);
  assert.equal(a.iceServers.length, 2);
  assert.equal(calls[0], 'https://api.souldew.app/link/ice');
  await linkIceServers({ fetchImpl, env: {}, now: 1000 + 3600_000 });
  assert.equal(calls.length, 1, 'cached');
  await linkIceServers({ fetchImpl, env: {}, now: 1000 + 7000_000 });
  assert.equal(calls.length, 2, 'renewed before the credentials run out');
  resetLinkIce();
  const down = await linkIceServers({ fetchImpl: async () => { throw new Error('offline'); }, env: {}, now: 5 });
  assert.deepEqual(down, { iceServers: [], turn: false, ttl: 0 });
  resetLinkIce();
  assert.equal((await linkIceServers({ fetchImpl, env: { SOULDEW_LINK_ICE: 'off' } })).turn, false);
  resetLinkIce();
});

// ---- server/lib/native.mjs ---------------------------------------------------------------------------------------------
test('native: link host arguments – every system incl. the DS, a rejoin\'s state, the clock', () => {
  assert.ok(LINK_SYSTEMS.includes('nds') && LINK_SYSTEMS.includes('gb') && LINK_SYSTEMS.includes('gba'));
  const a = linkArgs({ system: 'nds', roms: ['/a.nds', '/b.nds'], saves: ['/a.sav', null], local: 1, delay: 6, rtc: 1234, state: '/s.state' });
  assert.deepEqual(a.slice(0, 8), ['--rom', '/a.nds', '--sram', '/a.sav', '--rom', '/b.nds', '--sram', '-']);
  assert.deepEqual(a.slice(a.indexOf('--local'), a.indexOf('--local') + 7), ['--local', '1', '--net', '--delay', '6', '--rtc', '1234']);
  assert.ok(a.includes('--ram') && a[a.indexOf('--ram') + 1] === '0x2000000:0x400000', 'the DS main RAM for live tracking');
  assert.deepEqual(a.slice(-2), ['--load', '/s.state']);
  assert.throws(() => linkArgs({ system: '3ds', roms: ['a', 'b'], saves: [], local: 0 }), /Linken/);
  assert.throws(() => linkArgs({ system: 'gba', roms: ['a'], saves: [], local: 0 }), /Plätze/);
});

test('native: a page may send a link session buttons, a peer\'s request, a session state request – never LOAD, POKE, READ', () => {
  const u32 = (...v) => Buffer.from(new Uint32Array(v).buffer);
  const ok = Buffer.concat([command(LCMD.INPUT, Buffer.alloc(17)), command(LCMD.RINPUT, u32(1, 10, 5)), command(LCMD.NEED, u32(1, 10)), command(LCMD.SAVE), command(LCMD.UNTIL, u32(99))]);
  assert.equal(checkLinkCommands(ok), ok);
  for (const bad of [command(4, Buffer.alloc(8)), command(23, u32(0, 0, 1)), command(22, u32(0, 0, 4)), command(LCMD.NEED, u32(1)), command(LCMD.RINPUT, Buffer.alloc(9))]) {
    assert.throws(() => checkLinkCommands(bad), /Befehl/);
  }
});

// ---- the "You are here" sign in a link room --------------------------------------------------------------------------
test('location: the link rooms are named as such, not after the place their map number shares', () => {
  const maps = JSON.parse(readFileSync(new URL('../shared/data/maps.json', import.meta.url), 'utf8'));
  const bus = (cells) => (addr, len) => Uint8Array.from({ length: len }, (_, i) => cells[addr + i] ?? 0);
  const at = (base, bytes) => Object.fromEntries(bytes.map((b, i) => [base + i, b]));
  assert.deepEqual(readLocation(maps, 'red_us', bus(at(0xd35e, [0xef]))), { gen: 1, id: 'link:trade', link: 'trade', map: 0xef });
  assert.equal(readLocation(maps, 'red_us', bus(at(0xd35e, [0xf0]))).link, 'colosseum');
  assert.equal(readLocation(maps, 'crystal_us', bus(at(0xdcb5, [20, 2]))).link, 'trade');
  assert.equal(readLocation(maps, 'silver_us', bus(at(0xda00, [20, 3]))).link, 'colosseum');
  // Gen 3: the header the link host read in Emerald's Trade Center (MAPSEC 0x57, music 0x1A6) – and the S.S. Tidal
  const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
  const hdr = (music, sec) => [...le(0x08442540), ...le(0x08539de8), ...le(0x0823b77e), 0, 0, 0, 0, music & 0xff, music >> 8, 0xde, 0, sec, 0, 0, 8];
  assert.equal(readLocation(maps, 'emerald_us', bus(at(0x02037318, hdr(0x1a6, 0x57)))).link, 'cableclub');
  assert.equal(readLocation(maps, 'emerald_us', bus(at(0x02037318, hdr(0x190, 0x57)))).link, undefined, 'a real place with that MAPSEC');
  // Platinum: the save data (behind its pointer) says map 466 – the Union Room
  const pt = { ...at(0x02101d40, le(0x0227e148)), ...at(0x0227e148 + 0x1294, le(466)) };
  assert.equal(readLocation(maps, 'platinum_us', bus(pt)).link, 'union');
});

// ---- the trade's log entry --------------------------------------------------------------------------------------------
test('run: a trade in a link session is logged from the team before and after', async () => {
  const { RunDoc } = await import('../web/lib/doc.mjs');
  const R = await import('../web/lib/run.mjs');
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  const m = { id: 'r', mode: 'soullink', game: { system: 'gba' }, players: { p1: { name: 'Marius' }, p2: { name: 'Tim' } } };
  const before = [{ key: 'a', species: 255 }, { key: 'b', species: 261 }];
  assert.equal(R.logLinkTrade(d, m, 'p1', 'p2', before, before), false, 'nothing changed: no entry');
  assert.equal(R.logLinkTrade(d, m, 'p1', 'p2', before, [{ key: 'a', species: 255 }, { key: 'c', species: 265 }]), true);
  const f = R.feedList(d).find((x) => x.type === 'trade' || /traded/.test(x.text || ''));
  assert.ok(f, 'in the log');
});

// ---- web/lib/linksession.mjs: two players over a fake peer channel ---------------------------------------------------
/** Browser bits the page module uses, for Node. */
function browserGlobals() {
  const listeners = new Set();
  globalThis.location = { origin: 'http://127.0.0.1:7373' };
  globalThis.addEventListener = (t, fn) => t === 'message' && listeners.add(fn);
  globalThis.removeEventListener = (t, fn) => listeners.delete(fn);
  globalThis.window = { dispatchEvent: () => {} };
  const ls = new Map();
  globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
  return { post: (data) => listeners.forEach((fn) => fn({ origin: 'http://127.0.0.1:7373', data })), ls };
}

/** Two pages of one run (p1 = Marius, p2 = Tim): their channel, their servers (fetch), what reached the link hosts. */
async function pair({ missingOnB = false } = {}) {
  const g = browserGlobals();
  const { LinkSessions } = await import('../web/lib/linksession.mjs');
  const roms = { p1: 'a'.repeat(40), p2: 'b'.repeat(40) };
  const peers = {};
  const net = { delivered: 0, drop: false, log: [] };
  const sync = (slot) => ({
    onLink: (fn) => ((peers[slot] = fn), () => delete peers[slot]),
    sendLink: (msg, to) => {
      for (const t of to) {
        if (net.drop && msg.t === 'in') continue;
        net.log.push({ from: slot, to: t, t: msg.t });
        queueMicrotask(() => peers[t]?.({ ...msg, from: slot }));
      }
      return true;
    },
    linkDirect: () => true,
    linkRoute: async () => ({ route: 'relayed', rtt: 40 }),
  });
  const server = { p1: { cmds: [], starts: [], restores: [], missing: [] }, p2: { cmds: [], starts: [], restores: [], missing: missingOnB ? [{ slot: 'p1', canBuild: false }] : [] } };
  /** Each player's own local server. */
  const fetchFor = (who) => async (url, opts = {}) => {
    const s = server[who];
    const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    const json = (v) => ({ ok: true, status: 200, json: async () => v });
    if (url.startsWith('/api/link/check')) return json({ tool: true, supported: true, system: 'gba', slots: { [who]: { rom: true, sha1: roms[who], crc: null } } });
    if (url === '/api/link/resolve') return json({ seats: {}, missing: s.missing });
    if (url === '/api/link/pick') { s.missing = []; return json({ ok: true }); }
    if (url.startsWith('/api/runs/')) return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(`save of ${who}`).buffer };
    if (url === '/api/link/start') { s.starts.push(body); return json({ id: `host-${who}`, local: body.seats.findIndex((x) => x.slot === who), seats: 2 }); }
    if (url === '/api/link/restore') { s.restores.push(body); return json({ ok: true, restored: true, backup: 'p.link-x.sav' }); }
    if (url.startsWith('/api/native/cmd')) { s.cmds.push(new Uint8Array(opts.body)); return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }; }
    throw new Error(`unexpected ${url}`);
  };
  const closed = { p1: 0, p2: 0 };
  const emuState = { p1: null, p2: null };
  const mk = (slot) => new LinkSessions({ sync: sync(slot), runId: 'run1', me: slot, onChange: () => {}, openSession: () => {}, closeSession: () => closed[slot]++,
    emu: () => ({ linkState: async () => emuState[slot] }), fetchImpl: fetchFor(slot) });
  const A = mk('p1'), B = mk('p2');
  const settle = async (ms = 1700) => { for (let i = 0; i < ms / 50; i++) await new Promise((r) => setTimeout(r, 50)); };
  const as = (slot, fn) => fn; // (each page has its own server now)
  return { A, B, g, server, net, as, settle, closed, emuState, roms, fetchFor, sync };
}

test('linksession: invite → join → every game here → saves → go: both link hosts start with the same seats', async () => {
  const { A, B, server, as, settle, roms } = await pair();
  await as('p1', () => A.invite('trade', ['p2']))();
  await settle(100);
  assert.equal(B.state.phase, 'invited');
  await as('p2', () => B.accept())();
  await settle(3500);
  assert.equal(A.state.phase, 'running', JSON.stringify(A.state.ended));
  assert.equal(B.state.phase, 'running');
  const [sa, sb] = [server.p1.starts[0], server.p2.starts[0]];
  assert.deepEqual(sa.seats.map((s) => [s.slot, s.sha1]), [['p1', roms.p1], ['p2', roms.p2]]);
  assert.deepEqual(sb.seats.map((s) => [s.slot, s.sha1]), [['p1', roms.p1], ['p2', roms.p2]]);
  assert.equal(sa.delay, sb.delay);
  assert.equal(sa.rtc, sb.rtc, 'one clock for every console');
  assert.ok(sa.seats[1].save && !sa.seats[0].save, 'A gets B\'s save, its own comes from its disk');
  assert.match(sa.seats[1].saveSha1, /^[0-9a-f]{40}$/, 'with its SHA-1 (the server checks it)');
  A.stop(), B.stop();
});

test('linksession: the partner\'s game missing → "need" until picked; buttons flow; a gap is asked for and resent; hashes', async () => {
  const { A, B, g, server, as, settle, net } = await pair({ missingOnB: true });
  await as('p1', () => A.invite('battle', ['p2']))();
  await settle(100);
  await as('p2', () => B.accept())();
  await settle(2500);
  assert.equal(B.state.phase, 'need');
  assert.deepEqual(B.state.missing.map((m) => m.slot), ['p1']);
  assert.equal(A.state.phase, 'preparing', 'A waits for B to be ready');
  await as('p2', () => B.pickRom('p1', 'lib-rom'))();
  await settle(2500);
  assert.equal(A.state.phase, 'running');
  assert.equal(B.state.phase, 'running');
  // A's host sends its seat's buttons (LINPUT) → they reach B's host as RINPUT
  const linput = (seat, first, ks) => { const b = new Uint8Array(8 + ks.length * 4); const v = new DataView(b.buffer); v.setUint32(0, seat, true); v.setUint32(4, first, true); ks.forEach((k, i) => v.setUint32(8 + i * 4, k, true)); return b; };
  g.post({ type: 'emu-link-input', bytes: linput(0, 10, [1, 2, 3]) });
  await settle(200);
  const words = (b) => [...new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))];
  assert.deepEqual(words(server.p2.cmds.at(-1)), [21, 20, 0, 10, 1, 2, 3], 'RINPUT seat 0 from frame 10');
  // B's host waits for seat 0 at frame 13: B asks, A's host is told NEED (25) seat 0 from 13
  g.post({ type: 'emu-link-wait', seats: 1, frame: 13, ms: 300 });
  await settle(200);
  assert.ok(net.log.some((m) => m.from === 'p2' && m.t === 'need'));
  assert.ok(server.p1.cmds.some((c) => words(c)[0] === 25 && words(c)[2] === 0 && words(c)[3] === 13), 'NEED to A\'s host');
  // equal hashes: nothing happens
  g.post({ type: 'emu-link-hash', frame: 120, hash: 'aaaa' });
  await settle(200);
  assert.equal(A.state.phase, 'running');
  A.stop(), B.stop();
});

test('linksession: hashes differ → the session ends on both, each run\'s save goes back to before the link', async () => {
  const { A, B, server, as, settle, closed } = await pair();
  await as('p1', () => A.invite('trade', ['p2']))();
  await settle(100);
  await as('p2', () => B.accept())();
  await settle(3500);
  assert.equal(A.state.phase, 'running');
  A._hash('p1', 240, 'aaaa');
  A._hash('p2', 240, 'bbbb'); // (B's hash for that frame arrives – another one)
  await settle(800);
  assert.equal(A.state.phase, 'ended');
  assert.equal(B.state.phase, 'ended');
  assert.equal(A.state.ended.reason, 'linkDesync');
  assert.equal(B.state.ended.reason, 'linkDesync');
  assert.equal(server.p1.restores.length, 1);
  assert.equal(server.p2.restores.length, 1);
  assert.deepEqual([server.p1.restores[0].slot, server.p2.restores[0].slot], ['p1', 'p2']);
  assert.equal(A.state.ended.restored.backup, 'p.link-x.sav');
  // both sides may see it at once: the other's bye arriving afterwards changes nothing (no second restore)
  await A._in({ t: 'bye', reason: 'linkDesync', sid: A.state.sid, from: 'p2' });
  assert.equal(server.p1.restores.length, 1);
  assert.equal(A.state.ended.restored.backup, 'p.link-x.sav');
  assert.equal(closed.p1 + closed.p2, 2);
  A.stop(), B.stop();
});

test('linksession: a page that went away offers to rejoin; the one who stayed sends the session\'s state; it starts from it', async () => {
  const { A, B, server, as, settle, emuState, g, fetchFor } = await pair();
  await as('p1', () => A.invite('trade', ['p2']))();
  await settle(100);
  await as('p2', () => B.accept())();
  await settle(3500);
  assert.equal(B.state.phase, 'running');
  // B's page reloads: a new LinkSessions for the same run finds the session it was in
  B.stop();
  const { LinkSessions } = await import('../web/lib/linksession.mjs');
  assert.ok(g.ls.get('sl-link-run1'), 'remembered');
  emuState.p1 = new Uint8Array(4000).fill(7); // A's host: the whole session's state
  const peersBefore = A.sync;
  const B2 = new LinkSessions({ sync: B.sync, runId: 'run1', me: 'p2', emu: () => null, fetchImpl: fetchFor('p2') });
  assert.equal(B2.state.phase, 'rejoinable');
  assert.ok(peersBefore);
  // (the fake channel delivers to the newest listener of a slot – B2 now)
  await as('p2', () => B2.rejoin())();
  await settle(2500);
  assert.equal(B2.state.phase, 'running', JSON.stringify(B2.state.ended));
  const start = server.p2.starts.at(-1);
  assert.ok(typeof start.state === 'string' && start.state.length > 10, 'started from the state');
  assert.ok(start.seats.every((s) => !s.save), 'no saves: the state has them');
  assert.equal(A.stats.donated, 1);
  A.stop(), B2.stop();
});
