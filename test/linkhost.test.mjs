// The real link host (native/link-host, docs/MULTIPLAYER.md) on tiny ROMs made here: two linked Game Boys (SameBoy) and
// two linked GBAs (mGBA) run deterministically (the same hash twice), a whole-session state taken in the middle loads
// into a fresh host and goes on exactly as the session did (rejoin), the battery saves come out, the sound has a rate.
// Skipped when the link host isn't built (npm run native).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { linkTool } from '../server/lib/native.mjs';
import { startHost as startLinkHost } from '../scripts/link-drive.mjs';

const host = linkTool();
const skip = !host && 'link host not built (npm run native)';
const dir = mkdtempSync(join(tmpdir(), 'souldew-linkhost-'));
const started = []; // every host a test starts: none outlives the file, also when a test fails halfway
const startHost = (...a) => { const h = startLinkHost(...a); started.push(h.proc); return h; };
test.after(() => {
  for (const p of started) if (p.exitCode === null) p.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

/** A 32 KB Game Boy ROM (MBC1 + battery RAM) that counts 0xC000 up forever and copies it to the cartridge RAM. */
function gbRom() {
  const r = Buffer.alloc(0x8000);
  r.set([0x00, 0xc3, 0x50, 0x01], 0x100);
  r.set([0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b], 0x104); // (the header bytes backend_sameboy.c's probe looks for)
  r.write('SOULDEWLINK', 0x134, 'latin1');
  r[0x147] = 0x03, r[0x148] = 0x00, r[0x149] = 0x02;
  let x = 0;
  for (let i = 0x134; i <= 0x14c; i++) x = (x - r[i] - 1) & 0xff;
  r[0x14d] = x;
  r.set([0x3e, 0x0a, 0xea, 0x00, 0x00, 0x21, 0x00, 0xc0, 0x34, 0x7e, 0xea, 0x00, 0xa0, 0x18, 0xf9], 0x150);
  return r;
}

/** A 64 KB GBA ROM: from the entry it jumps to a loop that counts a word in IWRAM up (no BIOS needed). */
function gbaRom() {
  const r = Buffer.alloc(0x10000);
  r.writeUInt32LE(0xea00002e, 0); // b 0xC0
  r.write('SOULDEWLINK', 0xa0, 'latin1');
  r[0xb2] = 0x96; // the fixed header byte
  let c = 0;
  for (let i = 0xa0; i <= 0xbc; i++) c = (c - r[i]) & 0xff;
  r[0xbd] = (c - 0x19) & 0xff;
  // ldr r0,=0x03000000 (pc-relative: [pc, #8]); loop: ldr r1,[r0]; add r1,r1,#1; str r1,[r0]; b loop; .word 0x03000000
  [0xe59f0008, 0xe5901000, 0xe2811001, 0xe5801000, 0xeafffffb, 0x03000000].forEach((w, i) => r.writeUInt32LE(w, 0xc0 + i * 4));
  return r;
}

const games = { gb: ['gb', gbRom()], gba: ['gba', gbaRom()] };
for (const [name, [ext, bytes]] of Object.entries(games)) writeFileSync(join(dir, `${name}.${ext}`), bytes);
const rom = (name) => join(dir, `${name}.${games[name][0]}`);

function bench(name, frames) {
  const r = spawnSync(host, ['--rom', rom(name), '--rom', rom(name), '--rtc', '1763200000000', '--bench', String(frames)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const m = r.stderr.match(/bench: (\w+) (\w+), 2 seats, .* hash ([0-9a-f]{16})/);
  assert.ok(m, r.stderr);
  return { backend: m[1], system: m[2], hash: m[3] };
}

for (const name of Object.keys(games)) {
  test(`link host, two linked ${name.toUpperCase()}s: deterministic, the right backend`, { skip }, () => {
    const a = bench(name, 300);
    const b = bench(name, 300);
    assert.equal(a.backend, name === 'gb' ? 'sameboy' : 'mgba');
    assert.equal(a.system, name);
    assert.equal(a.hash, b.hash);
  });

  test(`link host, two linked ${name.toUpperCase()}s: a session state loads into a fresh host and goes on the same (rejoin)`, { skip }, async () => {
    const argv = ['--rom', rom(name), '--rom', rom(name), '--rtc', '1763200000000'];
    const hashes = (box) => (e) => e.event === 'hash' && (box[e.frame] = e.hash);
    const ha = {}, hb = {};
    const A = startHost(host, argv, { onEvent: hashes(ha) });
    const la = (await A.loaded).event;
    assert.equal(la.event, 'loaded');
    assert.ok(la.sampleRate > 0, 'the link host has sound');
    await A.step(130); // (the host also runs at real time meanwhile: the frame is the one the state says)
    const state = await A.saveState();
    assert.ok(state.length > 1000);
    const tail = state.lastIndexOf(Buffer.from('LSES', 'latin1')); // then the frame, then each seat's known buttons
    assert.ok(tail > 0 && tail + 8 + 4 * 2 <= state.length, 'the session tail');
    const at = state.readUInt32LE(tail + 4); // the frame it was taken at
    assert.ok(at >= 130 && at < 240, `state at frame ${at}`);
    await A.step(250 - at);
    const sa = await A.flush(2);
    const file = join(dir, `${name}.state`);
    writeFileSync(file, state);
    const B = startHost(host, [...argv, '--load', file], { onEvent: hashes(hb) });
    const lb = (await B.loaded).event;
    assert.equal(lb.frame, at);
    await B.step(250 - at);
    const sb = await B.flush(2);
    assert.ok(ha[240] && ha[240] === hb[240], `hash at frame 240: ${ha[240]} / ${hb[240]}`);
    assert.ok(sa[0].equals(sb[0]) && sa[1].equals(sb[1]), 'the battery saves are the same');
    A.send(6), B.send(6);
    // a state of other games is refused
    const bad = join(dir, 'bad.state');
    writeFileSync(bad, readFileSync(file).subarray(0, 100));
    const r = spawnSync(host, [...argv, '--load', bad], { encoding: 'utf8', input: '' });
    assert.notEqual(r.status, 0);
  });
}

test('link host: NEED answers with the seat\'s buttons it knows', { skip }, async () => {
  const A = startHost(host, ['--rom', rom('gb'), '--rom', rom('gb'), '--net', '--delay', '4', '--local', '0', '--rtc', '1763200000000']);
  await A.loaded;
  const got = A.wait((m) => m.type === 12 && m.payload.readUInt32LE(0) === 0 && m.payload.readUInt32LE(4) === 0 && m.payload.length > 12);
  A.send(25, A.u32(0, 0)); // NEED seat 0 from frame 0 (the local seat: frames 0–3 are "nothing pressed", known)
  const m = await got;
  assert.ok((m.payload.length - 8) / 4 >= 4);
  A.send(6);
});

test('the link host build is there when the native part is (npm run native builds it)', { skip }, () => {
  assert.ok(existsSync(host));
});
