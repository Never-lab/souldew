// End-to-end test of link sessions in the real app: two souldew servers with scratch data folders (two players on this
// computer), one SoulLink run (created on A, joined on B), each player's battery save in it, both pages in Electron
// (muted). A invites B over the run's peer channel, B joins; both servers find every seat's game by SHA-1, the saves
// cross the channel, both play views switch to the link session. The buttons come from a recording of the same trade
// or battle (each host plays its own seat's column – SLS_LINK_TEST_SCRIPT, test-only), so the session's outcome is
// known: both hosts must stay in step (hashes), and the battery saves written back into each player's run must be the
// recording's (--expect). Screenshots of both windows go to --out.
//
//   node scripts/link-e2e.mjs --rom1 <A's game> [--rom2 <B's game>] --save1 <a.sav> --save2 <b.sav> --script <rec>
//        --data <dir> --out <dir> [--kind trade|battle] [--rtc ms] [--expect <dir with seat0.sav, seat1.sav …>]
//        [--players 3|4 --save3 … --save4 … [--rom3 … --rom4 …]]   (a group session: everybody linked at once)
//        [--all-roms]        (every library has every game: the partners' are found there by CRC and SHA-1)
//        [--speed 6] [--shots f1,f2,…] [--other-release]   (B plays another file of the game: each side must find or
//        pick the partner's copy – decision (2), "Pick your copy", by SHA-1)
//        [--rejoin <frame>]  (B's page reloads at that frame and rejoins from A's state)
//        [--desync]          (B's host gets another clock: the games fall out of step – both saves go back)
//        [--show]
//
// Never commit ROMs, saves or the screenshots.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join, dirname, basename, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d = null) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const flag = (n) => args.includes(`--${n}`);

if (!process.versions.electron) {
  const electron = (await import('electron')).default;
  const p = spawn(electron, [fileURLToPath(import.meta.url), ...args], { stdio: 'inherit' });
  p.on('exit', (c) => process.exit(c ?? 1));
} else {
  const { app } = await import('electron');
  app.commandLine.appendSwitch('mute-audio');
  app.on('window-all-closed', () => {});
  app.whenReady().then(main);
}

async function main() {
  const { app, BrowserWindow } = await import('electron');
  const data = resolve(opt('data'));
  const out = resolve(opt('out'));
  mkdirSync(out, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`, ...a);
  const sha = (b) => createHash('sha1').update(b).digest('hex');
  const kind = opt('kind', 'trade');
  const script = resolve(opt('script'));
  const seats = Number(opt('players', '2'));
  const frames = Math.floor(readFileSync(script).length / (4 + 4 * seats));
  const rtc = opt('rtc', '1763200000000');
  const rom1 = resolve(opt('rom1'));
  const rom2 = resolve(opt('rom2') || rom1);
  const romOf = (i) => (i === 0 ? rom1 : i === 1 ? rom2 : resolve(opt(`rom${i + 1}`) || rom1));
  const result = { kind, frames, players: seats, rom1: basename(rom1), rom2: basename(rom2), checks: {} };
  const SLOTS = ['p1', 'p2', 'p3', 'p4'].slice(0, seats);

  // ---- one server and scratch data folder per player ----------------------------------------------------------------
  const servers = [];
  const profiles = [['A', 'Marius', 7401], ['B', 'Tim', 7402], ['C', 'Robin', 7403], ['D', 'Kim', 7404]].slice(0, seats).map(([id, name, port], i) => [id, name, port, romOf(i)]).map(([id, name, port, rom]) => {
    const dir = join(data, id);
    const lib = join(dir, 'roms');
    mkdirSync(lib, { recursive: true });
    // (--all-roms: every player's library has every game of the session – the partners' are then found by CRC + SHA-1)
    for (const r of flag('all-roms') ? [...new Set([rom, ...[0, 1, 2, 3].slice(0, seats).map(romOf)])] : [rom]) copyFileSync(r, join(lib, basename(r)));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ onboarded: true, lang: 'en', playerName: name, libraryFolders: [lib], bootAnimation: false, sounds: false, nativeCore: true }));
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', SLS_DATA_DIR: dir, PORT: String(port), NO_OPEN: '1', SLS_LINK_TEST_SCRIPT: script,
      SLS_LINK_TEST_RTC: id === 'B' && flag('desync') ? String(Number(rtc) + 86400000 * 3) : rtc };
    const p = spawn(process.execPath, [join(root, 'server', 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stderr.on('data', (d) => process.stderr.write(`[${id}] ${d}`));
    servers.push(p);
    return { id, name, port, lib, dir, base: `http://127.0.0.1:${port}` };
  });
  const finish = (code) => {
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
    for (const p of servers) p.kill();
    app.exit(code);
  };
  const api = async (pr, path, body, method) => {
    const r = await fetch(pr.base + path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { 'x-soullink': '1', ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}) },
      body: body instanceof Uint8Array ? body : body !== undefined ? JSON.stringify(body) : undefined });
    const t = await r.text();
    if (!r.ok) throw Object.assign(new Error(`${pr.id} ${path}: ${r.status} ${t.slice(0, 300)}`), { status: r.status, body: t });
    try { return JSON.parse(t); } catch { return t; }
  };
  try {
    for (const pr of profiles) for (let i = 0; i < 100; i++) { try { await api(pr, '/api/status'); break; } catch { await sleep(200); } }
    const [A, B] = profiles;
    const N = profiles.length;
    const all = profiles.map((_, i) => i);
    // ---- the run: built on A, joined on B ------------------------------------------------------------------------------
    const libA = await api(A, '/api/library');
    const own = (lib, i) => lib.roms.find((r) => basename(r.file || '') === basename(romOf(i))) || lib.roms[0];
    const rom = own(libA, 0);
    log('library', rom.name, rom.gameId, rom.system);
    // (every player builds only their own game, as a DS run does when it's joined: the others' are found by SHA-1)
    const players = Object.fromEntries(profiles.map((pr, i) => [SLOTS[i], { name: pr.name }]));
    const built = await api(A, '/api/runs/build', { romId: rom.id, randomize: false, mode: 'soullink', players, buildFor: ['p1'], gameId: rom.gameId, name: 'Link test', rules: {} });
    const runId = built.manifest.id;
    const run = await api(A, `/api/runs/${runId}`);
    const pack = run.manifest?.pack || run.pack;
    for (const [i, pr] of profiles.entries()) {
      if (!i) continue;
      const imported = await api(pr, '/api/runs/import', { pack });
      const lib = await api(pr, '/api/library');
      await api(pr, '/api/runs/build', { runId: imported.id, romId: own(lib, i).id, randomize: false, values: {}, seeds: {}, players: pack.players, buildFor: [SLOTS[i]], name: pack.name, mode: 'soullink', expectedOutputs: pack.outputs, gameId: own(lib, i).gameId });
    }
    const pre = {};
    for (const [i, pr] of profiles.entries()) {
      const bytes = readFileSync(opt(`save${i + 1}`));
      await api(pr, `/api/runs/${runId}/save/${SLOTS[i]}`, new Uint8Array(bytes), 'PUT');
      pre[pr.id] = sha(bytes);
    }
    log('run', runId, 'built on', N, 'computers');

    // ---- the pages ---------------------------------------------------------------------------------------------------
    const show = flag('show');
    const wins = profiles.map((pr, i) => {
      const w = new BrowserWindow({ width: 1100, height: 780, x: 40 + (i % 2) * 560, y: 40 + Math.floor(i / 2) * 400, show, webPreferences: { partition: `link-e2e-${pr.id}`, backgroundThrottling: false } });
      w.webContents.setAudioMuted(true);
      w.loadURL(`${pr.base}/#/soullink?run=${runId}`);
      return w;
    });
    const ev = (i, js) => wins[i].webContents.executeJavaScript(js, true);
    const shot = async (name) => {
      for (let i = 0; i < N; i++) writeFileSync(join(out, `${name}-${profiles[i].id}.png`), (await wins[i].webContents.capturePage()).toPNG());
    };
    const until = async (what, fn, ms = 120000) => {
      const t = Date.now();
      for (;;) {
        const v = await fn().catch(() => null);
        if (v) return v;
        if (Date.now() - t > ms) throw new Error(`timeout: ${what}`);
        await sleep(400);
      }
    };
    const phase = (i) => ev(i, 'window.__slLink?.sessions?.state?.phase');
    const linked = () => until('every page and the peer links', async () => {
      for (const i of all) for (const s of SLOTS) if (s !== SLOTS[i] && !(await ev(i, `window.__slLink?.sync?.linkDirect(${JSON.stringify(s)})`))) return false;
      return true;
    }, 300000);
    const everyone = async (fn) => { for (const i of all) if (!(await fn(i))) return false; return true; };
    await linked();
    log('peer link up');
    await shot('01-board');

    // ---- invite, join (and the partner's game, when it's another file) -------------------------------------------------
    await ev(0, `window.__slLink.sessions.invite(${JSON.stringify(kind)}, ${JSON.stringify(SLOTS.slice(1))})`);
    await until('invite arrives', () => everyone(async (i) => !i || (await phase(i)) === 'invited'));
    await shot('02-invited');
    for (const i of all.slice(1)) await ev(i, 'window.__slLink.sessions.accept()');
    if (flag('other-release')) {
      // each side lacks the other's file: the bar asks to pick it; a wrong file is refused by SHA-1, the right one taken
      await until('A asks for B\'s game', async () => (await phase(0)) === 'need', 60000);
      await until('B asks for A\'s game', async () => (await phase(1)) === 'need', 60000);
      await sleep(800);
      await shot('03-pick-your-copy');
      const wrong = await api(A, '/api/link/pick', { runId, slot: 'p2', sha1: '0'.repeat(40), romId: (await api(A, '/api/library')).roms[0].id }).then(() => 'taken', (e) => e.status);
      result.checks.wrongFileRefused = wrong === 409;
      for (const [pr, file, i] of [[A, rom2, 0], [B, rom1, 1]]) {
        const bytes = readFileSync(file);
        const name = `${basename(file, extname(file))} (copy)${extname(file)}`;
        await fetch(`${pr.base}/api/library/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'x-soullink': '1' }, body: bytes });
        const lib = await api(pr, '/api/library');
        const it = lib.roms.find((r) => r.name?.includes('(copy)') || r.file?.includes('(copy)'));
        await ev(i, `window.__slLink.sessions.pickRom("${i ? 'p1' : 'p2'}", ${JSON.stringify(it.id)})`);
      }
      result.checks.pickedBySha1 = true;
    }
    await until('everybody running', () => everyone(async (i) => (await phase(i)) === 'running'), 120000);
    const st0 = JSON.parse(await ev(0, 'JSON.stringify(window.__slLink.sessions.state)'));
    log('running: delay', st0.delay, 'rtt', st0.rtt);
    result.delay = st0.delay;
    const emu = (i, js) => ev(i, `(() => { const f = document.querySelector('iframe[src^="/playernative.html"]'); const e = f?.contentWindow?.__emu; return e ? (${js}) : null; })()`);
    await until('pictures', () => everyone((i) => emu(i, 'e.ready')), 90000);
    await sleep(2500); // (sound only comes at normal speed)
    result.checks.sound = await everyone(async (i) => Number(await emu(i, 'e.perf().audioIn')) > 0);
    const speed = Number(opt('speed', '6'));
    // faster than real time, and every host stops exactly where the recording ends (UNTIL: the same frame everywhere)
    const setSpeed = async (i) => {
      const id = await ev(i, 'window.__slLink.sessions.state.id');
      const b = Buffer.alloc(24);
      b.writeUInt32LE(2, 0), b.writeUInt32LE(4, 4), b.writeFloatLE(speed, 8);
      b.writeUInt32LE(24, 12), b.writeUInt32LE(4, 16), b.writeUInt32LE(frames, 20);
      await fetch(`${profiles[i].base}/api/native/cmd?id=${id}`, { method: 'POST', headers: { 'x-soullink': '1' }, body: b });
    };
    for (const i of all) await setSpeed(i);
    await sleep(1500);
    await shot('04-linked');
    const route = await ev(0, 'JSON.stringify(window.__slLink.sessions.state.route)');
    result.route = JSON.parse(route || '{}');

    // ---- run the recording to its end ----------------------------------------------------------------------------------
    const shots = String(opt('shots', '')).split(',').filter(Boolean).map(Number).sort((a, b) => a - b);
    const rejoinAt = Number(opt('rejoin', '0'));
    const frameOf = async (i) => Number(await emu(i, 'e.frames()')) || 0;
    let n = 5;
    for (const target of [...new Set([...shots, rejoinAt, frames].filter((x) => x > 0))].sort((a, b) => a - b)) {
      await until(`frame ${target}`, async () => {
        if (flag('desync') && (await phase(0)) === 'ended') return true;
        return everyone(async (i) => (await frameOf(i)) >= target);
      }, Math.max(300000, ((target - (await frameOf(0))) / 60 / Math.max(1, speed)) * 4000 + 120000));
      if (flag('desync') && (await phase(0)) === 'ended') break;
      if (target === rejoinAt) {
        log('rejoin test: B\'s page reloads at frame', await frameOf(1));
        await shot(`${String(n++).padStart(2, '0')}-before-drop`);
        wins[1].webContents.reload();
        await sleep(4000);
        await linked();
        await until('B offers to rejoin', async () => (await phase(1)) === 'rejoinable', 60000);
        await shot(`${String(n++).padStart(2, '0')}-rejoin-offer`);
        const waitA = await ev(0, 'JSON.stringify(window.__slLink.sessions.state.waiting)');
        result.checks.aWaitedForB = !!JSON.parse(waitA || 'null');
        await ev(1, 'window.__slLink.sessions.rejoin()');
        await until('B running again', async () => (await phase(1)) === 'running', 120000);
        await until('B\'s picture', async () => emu(1, 'e.ready'), 60000);
        await setSpeed(1);
        result.checks.rejoined = true;
        log('rejoined at frame', await frameOf(1));
        await sleep(1500);
        await shot(`${String(n++).padStart(2, '0')}-rejoined`);
        continue;
      }
      log('frame', target, 'stats A', await ev(0, 'JSON.stringify(window.__slLink.sessions.stats)'));
      await shot(`${String(n++).padStart(2, '0')}-frame-${target}`);
    }
    const stats = [];
    for (const i of all) stats.push(JSON.parse(await ev(i, 'JSON.stringify(window.__slLink.sessions.stats)')));
    result.stats = stats;
    log('stats', JSON.stringify(stats));

    if (flag('desync')) {
      await until('the desync ends the session on both', async () => (await phase(0)) === 'ended' && (await phase(1)) === 'ended', 120000);
      const ended = [JSON.parse(await ev(0, 'JSON.stringify(window.__slLink.sessions.state.ended)')), JSON.parse(await ev(1, 'JSON.stringify(window.__slLink.sessions.state.ended)'))];
      result.ended = ended;
      await sleep(3000);
      await shot(`${String(n++).padStart(2, '0')}-desync`);
      const saves = [Buffer.from(await fetch(`${A.base}/api/runs/${runId}/save/p1`).then((r) => r.arrayBuffer())), Buffer.from(await fetch(`${B.base}/api/runs/${runId}/save/p2`).then((r) => r.arrayBuffer()))];
      result.checks.desyncDetected = ended.every((e) => e?.reason === 'linkDesync');
      result.checks.savesBackToBefore = sha(saves[0]) === pre.A && sha(saves[1]) === pre.B;
      result.checks.backupsKept = ended.every((e) => !!e?.restored?.backup);
      log('desync', JSON.stringify(result.checks));
      return finish(Object.values(result.checks).every(Boolean) ? 0 : 1);
    }

    // ---- leave: both hosts stop, the last battery saves are in the run ---------------------------------------------------
    await sleep(2500);
    await ev(0, 'window.__slLink.sessions.leave("left")');
    await until('everybody ended', () => everyone(async (i) => (await phase(i)) === 'ended'), 60000);
    await sleep(4000);
    await shot(`${String(n++).padStart(2, '0')}-left`);
    const saves = [];
    for (const [i, pr] of profiles.entries()) saves.push(Buffer.from(await fetch(`${pr.base}/api/runs/${runId}/save/${SLOTS[i]}`).then((r) => r.arrayBuffer())));
    saves.forEach((b, i) => writeFileSync(join(out, `after-${profiles[i].id}.sav`), b));
    result.checks.noMismatch = stats.every((s) => !s.mismatch);
    result.checks.hashesCompared = stats.every((s) => (s.hashes || 0) > 10);
    if (opt('expect')) {
      const exp = all.map((i) => readFileSync(join(opt('expect'), `seat${i}.sav`)));
      // (a Game Boy clock cartridge's save carries its clock footer: the battery RAM must match, the clock is real time)
      const cut = (b, e) => b.subarray(0, e.length);
      result.checks.savesAsRecorded = all.every((i) => cut(saves[i], exp[i]).equals(exp[i]));
      result.savesChanged = all.map((i) => sha(saves[i]) !== pre[profiles[i].id]);
    }
    // the run's log on both computers: the trade entry (web/lib/run.mjs logLinkTrade)
    await sleep(3000);
    if (kind === 'trade') {
      const trades = [];
      for (const pr of profiles) {
        const doc = await api(pr, `/api/runs/${runId}/doc`).catch(() => null);
        for (const [k, v] of Object.entries(doc?.entries || doc || {})) if (k.startsWith('feed:') && JSON.stringify(v).includes('"trade"')) trades.push({ on: pr.id, entry: v.v ?? v });
      }
      result.trades = trades;
      result.checks.tradeLogged = trades.length > 0;
    }
    log('checks', JSON.stringify(result.checks));
    finish(Object.values(result.checks).every(Boolean) ? 0 : 1);
  } catch (e) {
    console.error(e);
    result.error = String(e?.stack || e);
    try {
      for (const [i, w] of BrowserWindow.getAllWindows().entries()) writeFileSync(join(out, `fail-${i}.png`), (await w.webContents.capturePage()).toPNG());
    } catch { /* no windows */ }
    finish(1);
  }
}
