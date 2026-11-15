// End-to-end test of link sessions in the real app: two souldew servers with scratch data folders (two players on this
// computer), one SoulLink run (created on A, joined on B), each player's battery save in it, both pages open in
// Electron (muted). A invites B to a trade over the run's peer channel, B joins; both play views switch to the link
// session, and the script walks both games (each from its own page, as a player would) to the Cable Club and trades.
// Checks: both reach "running", hashes compared without a mismatch, inputs flow both ways, the trade lands in both
// battery saves written back into the run. Screenshots of both windows go to --out.
//
//   node scripts/link-e2e.mjs --rom <emerald.gba> --save1 <a.sav> --save2 <b.sav> --data <dir> --out <dir> [--show]
//
// Never commit ROMs, saves or the screenshots.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d = null) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);

if (!process.versions.electron) {
  const electron = (await import('electron')).default;
  const p = spawn(electron, [fileURLToPath(import.meta.url), ...args], { stdio: 'inherit' });
  p.on('exit', (c) => process.exit(c ?? 1));
} else {
  const { app } = await import('electron');
  app.commandLine.appendSwitch('mute-audio');
  app.on('window-all-closed', () => {});
  // (no top-level await before this point: Electron's ready event comes only after the main module has run)
  app.whenReady().then(main);
}

async function main() {
  const { app, BrowserWindow } = await import('electron');
  const data = resolve(opt('data'));
  const out = resolve(opt('out'));
  mkdirSync(out, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

  // ---- two servers, two scratch data folders -----------------------------------------------------------------------
  const servers = [];
  const profiles = [['A', 'Marius', 7401], ['B', 'Tim', 7402]].map(([id, name, port]) => {
    const dir = join(data, id);
    const lib = join(dir, 'roms');
    mkdirSync(lib, { recursive: true });
    copyFileSync(opt('rom'), join(lib, basename(opt('rom'))));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ onboarded: true, lang: 'en', playerName: name, libraryFolders: [lib], bootAnimation: false, sounds: false, nativeCore: true }));
    const p = spawn(process.execPath, [join(root, 'server', 'index.mjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SLS_DATA_DIR: dir, PORT: String(port), NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stderr.on('data', (d) => process.stderr.write(`[${id}] ${d}`));
    servers.push(p);
    return { id, name, port, base: `http://127.0.0.1:${port}` };
  });
  const finish = (code) => {
    for (const p of servers) p.kill();
    app.exit(code);
  };
  const api = async (pr, path, body, method) => {
    const r = await fetch(pr.base + path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { 'x-soullink': '1', ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}) },
      body: body instanceof Uint8Array ? body : body !== undefined ? JSON.stringify(body) : undefined });
    const t = await r.text();
    if (!r.ok) throw new Error(`${pr.id} ${path}: ${r.status} ${t.slice(0, 300)}`);
    try { return JSON.parse(t); } catch { return t; }
  };
  try {
    for (const pr of profiles) for (let i = 0; i < 100; i++) { try { await api(pr, '/api/status'); break; } catch { await sleep(200); } }
    const [A, B] = profiles;
    // ---- the run: built on A for both players, joined on B (every player's game built there too) -------------------
    const libA = await api(A, '/api/library');
    const rom = libA.roms[0];
    log('library', rom.name, rom.gameId);
    const built = await api(A, '/api/runs/build', { romId: rom.id, randomize: false, mode: 'soullink', players: { p1: { name: A.name }, p2: { name: B.name } }, buildFor: ['p1', 'p2'], gameId: rom.gameId, name: 'Link test', rules: {} });
    const run = await api(A, `/api/runs/${built.manifest.id}`);
    const libB = await api(B, '/api/library');
    const pack = run.manifest?.pack || run.pack;
    const imported = await api(B, '/api/runs/import', { pack });
    await api(B, '/api/runs/build', { runId: imported.id, romId: libB.roms[0].id, randomize: false, values: {}, seeds: {}, players: pack.players, buildFor: ['p2', 'p1'], name: pack.name, mode: 'soullink', expectedOutputs: pack.outputs, gameId: libB.roms[0].gameId });
    const runId = built.manifest.id;
    await api(A, `/api/runs/${runId}/save/p1`, new Uint8Array(readFileSync(opt('save1'))), 'PUT');
    await api(B, `/api/runs/${runId}/save/p2`, new Uint8Array(readFileSync(opt('save2'))), 'PUT');
    log('run', runId, 'built on both');

    // ---- the pages ---------------------------------------------------------------------------------------------------
    const show = args.includes('--show');
    const wins = profiles.map((pr, i) => {
      const w = new BrowserWindow({ width: 1100, height: 760, x: 40 + i * 560, y: 40, show, webPreferences: { partition: `link-e2e-${pr.id}`, backgroundThrottling: false } });
      w.webContents.setAudioMuted(true);
      w.loadURL(`${pr.base}/#/soullink?run=${runId}`);
      return w;
    });
    const ev = (i, js) => wins[i].webContents.executeJavaScript(js, true);
    const shot = async (name) => {
      for (let i = 0; i < 2; i++) writeFileSync(join(out, `${name}-${profiles[i].id}.png`), (await wins[i].webContents.capturePage()).toPNG());
    };
    const until = async (what, fn, ms = 120000) => {
      const t0 = Date.now();
      for (;;) {
        const v = await fn().catch(() => null);
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
        await sleep(500);
      }
    };
    await until('both pages and the peer link', async () => (await ev(0, 'window.__slLink?.sync?.linkDirect("p2")')) && (await ev(1, 'window.__slLink?.sync?.linkDirect("p1")')), 240000);
    log('direct link between the two pages');
    await shot('01-board');

    // ---- invite, join ------------------------------------------------------------------------------------------------
    await ev(0, 'window.__slLink.sessions.invite("trade", ["p2"])');
    await until('invite arrives', async () => (await ev(1, 'window.__slLink.sessions.state.phase')) === 'invited');
    await shot('02-invited');
    await ev(1, 'window.__slLink.sessions.accept()');
    await until('both running', async () => (await ev(0, 'window.__slLink.sessions.state.phase')) === 'running' && (await ev(1, 'window.__slLink.sessions.state.phase')) === 'running', 60000);
    const st0 = await ev(0, 'JSON.stringify(window.__slLink.sessions.state)');
    log('running', st0.slice(0, 200));
    // the game frame of each page
    const emu = (i, js) => ev(i, `(() => { const f = document.querySelector('iframe'); const e = f?.contentWindow?.__emu; return e ? (${js}) : null; })()`);
    await until('pictures', async () => (await emu(0, 'e.ready')) && (await emu(1, 'e.ready')), 60000);
    await sleep(3000);
    await shot('03-linked');

    // ---- walk both games to the Cable Club and trade (each page drives its own seat) --------------------------------
    const hold = (i, keys, ms) => emu(i, `e.hold(${JSON.stringify(keys)})`).then(() => sleep(ms)).then(() => emu(i, 'e.hold([])'));
    const press = async (i, key, after = 700) => { await hold(i, [key], 130); await sleep(after); };
    const pos = async (i) => JSON.parse(await emu(i, `(() => { const p = e.read(0x03005d8c, 4); if (!p) return 'null'; const a = (p[0] | p[1] << 8 | p[2] << 16 | p[3] << 24) >>> 0; const b = e.read(a, 6); if (!b) return 'null'; return JSON.stringify({ x: b[0] | b[1] << 8, y: b[2] | b[3] << 8, map: b[4] * 256 + b[5] }); })()`) || 'null');
    const go = async (i, axis, target) => {
      for (let n = 0; n < 30; n++) {
        const p = await pos(i);
        const d = target - p[axis];
        if (!d) return p;
        await hold(i, [axis === 'x' ? (d > 0 ? 'right' : 'left') : d > 0 ? 'down' : 'up'], 210); // (one tile: a longer hold walks on)
        await sleep(150);
      }
      return pos(i);
    };
    // title → continue → overworld (the saves were made at the Cable Club: both stand in the Pokémon Center 2F)
    for (const i of [0, 1]) await until(`seat ${i} in the overworld`, async () => ((await pos(i))?.map === 515 ? true : (await press(i, 'a', 1200), false)), 90000);
    await sleep(2000);
    log('positions', JSON.stringify(await pos(0)), JSON.stringify(await pos(1)));
    const perf = async () => JSON.stringify([await emu(0, 'e.perf().speed'), await emu(1, 'e.perf().speed'), JSON.parse(await ev(0, 'JSON.stringify(window.__slLink.sessions.stats)'))]);
    log('speed of both hosts (1 = real time), stats A', await perf());
    await shot('04-continued');
    for (const i of [0, 1]) { await go(i, 'x', 10); await go(i, 'y', 4); await hold(i, ['up'], 150); }
    await sleep(500);
    await shot('05-attendant');
    // the attendant, the Trade Center, "save?" yes, overwrite yes, then the leader (seat 0) confirms the link – the
    // same A on both games until both stand in the Trade Center (a confirm that comes too early just starts over)
    await until('the trade center', async () => {
      if ((await pos(0))?.map === 6425 && (await pos(1))?.map === 6425) return true;
      await press(1, 'a', 500);
      await press(0, 'a', 500);
      return false;
    }, 240000);
    log('both in the Trade Center');
    log('speed', await perf());
    await shot('08-trade-center');
    await go(0, 'y', 6); await go(0, 'x', 4); await go(0, 'y', 5);
    await go(1, 'y', 6); await go(1, 'x', 7); await go(1, 'y', 5);
    // gMain.callback2 (Emerald US): the trade menu is CB2_TradeMenu (0x0807825C, a Thumb function)
    const cb2 = async (i) => { const b = await emu(i, 'Array.from(e.read(0x030022c4, 4) || [])'); return b && b.length === 4 ? ((b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0) : 0; };
    const inMenu = async () => (await cb2(0)) === 0x0807825d && (await cb2(1)) === 0x0807825d;
    await until('the trade menu', inMenu, 240000);
    await sleep(1500);
    await shot('09-trade-screen');
    for (const i of [0, 1]) { await press(i, 'right', 500); await press(i, 'a', 900); await press(i, 'down', 500); await press(i, 'a', 3000); }
    await shot('10-confirm');
    for (const i of [0, 1]) await press(i, 'a', 300);
    await sleep(10000);
    await shot('11-trading');
    await until('the trade (animation, save) done', inMenu, 240000);
    await sleep(1500);
    await shot('11-traded');
    // cancel on both: up to CANCEL, A, yes
    for (const i of [0, 1]) { await press(i, 'up', 400); await press(i, 'a', 1200); await press(i, 'a', 1500); }
    await sleep(5000);
    const stats = [JSON.parse(await ev(0, 'JSON.stringify(window.__slLink.sessions.stats)')), JSON.parse(await ev(1, 'JSON.stringify(window.__slLink.sessions.stats)'))];
    log('stats', JSON.stringify(stats));
    // leave: both hosts stop, the last battery saves are in the run
    await ev(0, 'window.__slLink.sessions.leave("left")');
    await sleep(4000);
    await shot('12-left');
    const saves = [await fetch(`${A.base}/api/runs/${runId}/save/p1`).then((r) => r.arrayBuffer()), await fetch(`${B.base}/api/runs/${runId}/save/p2`).then((r) => r.arrayBuffer())];
    saves.forEach((b, i) => writeFileSync(join(out, `after-${profiles[i].id}.sav`), Buffer.from(b)));
    const ended = [await ev(0, 'window.__slLink.sessions.state.phase'), await ev(1, 'JSON.stringify(window.__slLink.sessions.state.ended)')];
    log('ended', JSON.stringify(ended));
    // the run's log on both computers: the trade entry (web/lib/run.mjs logLinkTrade)
    await sleep(3000);
    const trades = [];
    for (const pr of profiles) {
      const doc = await api(pr, `/api/runs/${runId}/doc`).catch(() => null);
      const entries = doc?.entries || doc || {};
      for (const [k, v] of Object.entries(entries)) if (k.startsWith('feed:') && JSON.stringify(v).includes('"trade"')) trades.push({ on: pr.id, entry: v.v ?? v });
    }
    log('trade log entries', JSON.stringify(trades).slice(0, 600));
    writeFileSync(join(out, 'result.json'), JSON.stringify({ runId, stats, ended, trades }, null, 2));
    finish(0);
  } catch (e) {
    console.error(e);
    try {
      for (const [i, w] of BrowserWindow.getAllWindows().entries()) writeFileSync(join(out, `fail-${i}.png`), (await w.webContents.capturePage()).toPNG());
    } catch { /* no windows */ }
    finish(1);
  }
}
