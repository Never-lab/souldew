#!/usr/bin/env node
// Network test of the link host (native/link-host): two link hosts in net mode – one per player, each running BOTH
// consoles – exchange only their player's buttons through a relay that adds latency and jitter (an ordered, reliable
// channel like a WebRTC data channel). Both must stay in step (equal RAM hashes every 120 frames) and end with the same
// battery saves; with a recording (linkhost --record) the result is also compared with the local session's saves.
//
//   node scripts/link-net-test.mjs --host <linkhost> --rom a.gba --rom b.gba --sram a.sav --sram b.sav --rtc <ms>
//        --script <rec> --frames N [--rtt 80] [--jitter 10] [--delay auto|D] [--speed 1|max] [--out <dir>]
//        [--expect <dir with seat0.sav, seat1.sav>]
// Never commit ROMs or saves.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHost } from './link-drive.mjs';

const args = process.argv.slice(2);
const opt = (n, d = null) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const all = (n) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const roms = all('rom'), srams = all('sram');
const frames = Number(opt('frames', '3000'));
const rtt = Number(opt('rtt', '80')), jitter = Number(opt('jitter', '10'));
const FRAME_MS = 1000 / 59.7275;
// the input delay for this round trip (linkcable's rule of thumb: half the RTT with a margin, plus 3 frames)
const delay = opt('delay', 'auto') === 'auto' ? Math.min(60, Math.max(4, Math.ceil(((rtt / 2) * 1.25) / FRAME_MS) + 3)) : Number(opt('delay'));
const speed = opt('speed', 'max') === 'max' ? 1000 : Number(opt('speed'));
const out = opt('out');

const hashes = [{}, {}];
const waits = [0, 0];
const hosts = [0, 1].map((seat) => startHost(opt('host'), [
  ...roms.flatMap((r) => ['--rom', r]), ...srams.flatMap((s) => ['--sram', s]), '--rtc', opt('rtc', '1763150000000'),
  '--local', String(seat), '--net', '--delay', String(delay), ...(opt('script') ? ['--script', opt('script')] : []),
], {
  onEvent: (e) => {
    if (e.event === 'hash') hashes[seat][e.frame] = e.hash;
    if (e.event === 'wait') waits[seat]++;
  },
  onMessage: (m) => { if (m.type === 12) relay(seat, m.payload); },
}));

// the "network": in order, each message after rtt/2 ± jitter
const lastAt = [0, 0];
const chain = [Promise.resolve(), Promise.resolve()];
let sent = 0, bytes = 0;
function relay(from, payload) {
  const to = 1 - from;
  const at = Math.max(lastAt[from], Date.now() + rtt / 2 + (Math.random() * 2 - 1) * jitter);
  lastAt[from] = at;
  sent++;
  bytes += payload.length;
  const p = Buffer.from(payload);
  // (a timer per message, strictly in order – Node may fire timers of different lengths out of order)
  chain[from] = chain[from].then(() => new Promise((res) => setTimeout(res, Math.max(0, at - Date.now())))).then(() => hosts[to].send(21, p));
}

await Promise.all(hosts.map((h) => h.loaded));
const t0 = Date.now();
const f32 = (x) => Buffer.from(new Float32Array([x]).buffer);
for (const h of hosts) h.send(2, f32(speed));
await Promise.all(hosts.map((h) => { const w = h.wait((m) => m.event?.event === 'stepped'); h.send(24, h.u32(frames)); return w; }));
const dt = (Date.now() - t0) / 1000;
const saves = await Promise.all(hosts.map((h) => h.flush(roms.length)));
for (const h of hosts) h.send(6);

const common = Object.keys(hashes[0]).filter((f) => f in hashes[1]);
const bad = common.filter((f) => hashes[0][f] !== hashes[1][f]);
const sameSaves = [0, 1].every((s) => saves[0][s].equals(saves[1][s]));
let expectOk = null;
if (opt('expect')) expectOk = [0, 1].every((s) => readFileSync(join(opt('expect'), `seat${s}.sav`)).equals(saves[0][s]));
if (out) {
  mkdirSync(out, { recursive: true });
  for (const p of [0, 1]) for (const s of [0, 1]) writeFileSync(join(out, `peer${p}-seat${s}.sav`), saves[p][s]);
}
const res = {
  frames, rtt, jitter, delay, speed: speed >= 1000 ? 'max' : speed, seconds: dt, fps: +(frames / dt).toFixed(1),
  hashChecks: common.length, hashMismatches: bad.length, firstMismatch: bad[0] ?? null, waitEvents: waits,
  messages: sent, bytesPerSecondPerPeer: Math.round(bytes / dt / 2), savesEqualBetweenPeers: sameSaves, savesEqualToLocalSession: expectOk,
};
console.log(JSON.stringify(res, null, 2));
process.exit(bad.length || !sameSaves || expectOk === false ? 1 : 0);
