// End-to-end test of Shared World in the real app (docs/MULTIPLAYER.md › 9): two or three souldew servers with scratch
// data folders (players on this computer), one SoulLink run (created on A, joined on the others), each player's
// battery save in it, every page in Electron (muted) playing its own game in the fast player. The players stand on the
// same map; B walks around while A's page draws B over A's game – screenshots and a strip of frames go to --out. Then A
// walks up to B and presses A: the menu opens, A picks Wave, and B sees the bubble.
//
//   node scripts/world-e2e.mjs --rom <emerald.gba> --save1 <a.sav> --save2 <b.sav> [--save3 <c.sav>] --data <dir> --out <dir> [--show]
//                              [--browser]   (A plays in the browser player, EmulatorJS, instead of the fast player)
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
  app.setPath('userData', join(resolve(opt('data')), 'electron'));
  app.on('window-all-closed', () => {});
  app.whenReady().then(main);
}

async function main() {
  const { app, BrowserWindow } = await import('electron');
  const data = resolve(opt('data'));
  const out = resolve(opt('out'));
  mkdirSync(out, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const saves = [opt('save1'), opt('save2'), opt('save3')].filter(Boolean);
  const SLOTS = ['p1', 'p2', 'p3'].slice(0, saves.length);

  const servers = [];
  const profiles = [['A', 'Marius', 7411], ['B', 'Tim', 7412], ['C', 'Kim', 7413]].slice(0, saves.length).map(([id, name, port]) => {
    const dir = join(data, id);
    const lib = join(dir, 'roms');
    mkdirSync(lib, { recursive: true });
    copyFileSync(opt('rom'), join(lib, basename(opt('rom'))));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ onboarded: true, lang: opt('lang', 'en'), playerName: name, libraryFolders: [lib], bootAnimation: false, sounds: false, nativeCore: !(id === 'A' && args.includes('--browser')) }));
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
    const [A] = profiles;
    const libA = await api(A, '/api/library');
    const rom = libA.roms[0];
    const players = Object.fromEntries(SLOTS.map((s, i) => [s, { name: profiles[i].name }]));
    const built = await api(A, '/api/runs/build', { romId: rom.id, randomize: false, mode: 'soullink', players, buildFor: SLOTS, gameId: rom.gameId, name: 'World test', rules: {} });
    const runId = built.manifest.id;
    const run = await api(A, `/api/runs/${runId}`);
    const pack = run.manifest?.pack || run.pack;
    for (const [i, pr] of profiles.entries()) {
      if (!i) continue;
      const lib = await api(pr, '/api/library');
      const imported = await api(pr, '/api/runs/import', { pack });
      await api(pr, '/api/runs/build', { runId: imported.id, romId: lib.roms[0].id, randomize: false, values: {}, seeds: {}, players: pack.players, buildFor: [SLOTS[i], ...SLOTS.filter((s) => s !== SLOTS[i])], name: pack.name, mode: 'soullink', expectedOutputs: pack.outputs, gameId: lib.roms[0].gameId });
      await api(pr, `/api/runs/${runId}/me`, { slot: SLOTS[i] }).catch(() => null);
    }
    for (const [i, pr] of profiles.entries()) await api(pr, `/api/runs/${runId}/save/${SLOTS[i]}`, new Uint8Array(readFileSync(saves[i])), 'PUT');
    log('run', runId, 'on', profiles.length, 'computers');

    const show = args.includes('--show');
    const wins = profiles.map((pr, i) => {
      const w = new BrowserWindow({ width: 1180, height: 780, x: 30 + i * 420, y: 30 + i * 30, show, webPreferences: { partition: `world-e2e-${pr.id}`, backgroundThrottling: false } });
      w.webContents.setAudioMuted(true);
      w.loadURL(`${pr.base}/#/soullink?run=${runId}`);
      return w;
    });
    const ev = (i, js) => wins[i].webContents.executeJavaScript(js, true);
    const until = async (what, fn, ms = 120000) => {
      const t0 = Date.now();
      for (;;) {
        const v = await fn().catch(() => null);
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
        await sleep(400);
      }
    };
    // each page is the player of its slot (the join picked it; make sure)
    for (const [i] of profiles.entries()) await until(`page ${i}`, () => ev(i, '!!window.__slLink?.sync'), 120000);
    const slotOf = async (i) => ev(i, 'window.__slLink.sync.slot');
    // a joiner's page takes p2 unless told otherwise (web/lib/restart.mjs mySlotIn): the third player is p3
    for (const [i] of profiles.entries()) {
      if ((await slotOf(i)) === SLOTS[i]) continue;
      await ev(i, `localStorage.setItem('sl-me-${runId}', ${JSON.stringify(JSON.stringify(SLOTS[i]))}); location.reload(); true`).catch(() => null);
      await sleep(1500);
      await until(`page ${i} as ${SLOTS[i]}`, async () => (await ev(i, 'window.__slLink?.sync?.slot')) === SLOTS[i], 120000);
    }
    log('slots', JSON.stringify(await Promise.all(profiles.map((_, i) => slotOf(i)))));
    await until('direct links', async () => {
      for (const [i] of profiles.entries()) for (const s of SLOTS) if (s !== SLOTS[i] && !(await ev(i, `window.__slLink.sync.linkDirect(${JSON.stringify(s)})`))) return false;
      return true;
    }, 240000);
    log('direct links between all pages');
    for (const [i] of profiles.entries()) await ev(i, `location.hash = '#/play?run=${runId}'`);
    const emu = (i, js) => ev(i, `(() => { const f = document.querySelector('.console-screen iframe'); const e = f?.contentWindow?.__emu; const w = f?.contentWindow?.__world; return e ? (${js}) : null; })()`);
    await until('pictures', async () => {
      for (const [i] of profiles.entries()) {
        await ev(i, `(() => { const f = document.querySelector('.console-screen iframe'); f?.contentWindow?.document.getElementById('tap')?.click(); return true; })()`).catch(() => null);
        if (!(await emu(i, 'e.ready'))) return false;
      }
      return true;
    }, 90000);
    log('games running', JSON.stringify(await Promise.all(profiles.map((_, i) => emu(i, 'e.perf().core')))));
    // the browser player has no hold(): EmulatorJS' own simulated buttons (its indices: B 0 … A 8)
    const EJS = { b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11 };
    const setKeys = (i, keys, on) => emu(i, `e.native ? e.hold(${JSON.stringify(on ? keys : [])}) : (${JSON.stringify(keys.map((k) => EJS[k]))}.forEach((n) => f.contentWindow.EJS_emulator.gameManager.simulateInput(0, n, ${on ? 1 : 0})), true)`);
    const hold = (i, keys, ms) => setKeys(i, keys, true).then(() => sleep(ms)).then(() => setKeys(i, keys, false));
    const press = async (i, key, after = 600) => { await hold(i, [key], 120); await sleep(after); };
    const world = (i) => emu(i, 'JSON.stringify(w?.state?.() || null)').then((s) => JSON.parse(s || 'null'));
    // title → continue → overworld
    for (const [i] of profiles.entries()) {
      await until(`page ${i} in the overworld`, async () => {
        const s = await world(i);
        if (s?.local && s.cam && !s.cam.locked && s.cam.cb2 && s.cam.fade === 0) return true;
        await press(i, 'a', 900);
        return false;
      }, 120000);
    }
    await sleep(1500);
    const st = await Promise.all(profiles.map((_, i) => world(i)));
    log('local states', JSON.stringify(st.map((s) => ({ game: s?.game, perFrame: s?.perFrame, local: s?.local, learned: s?.learned, sprite: s?.sprite, cam: s?.cam }))));
    const gameRect = async (i) => {
      const r = JSON.parse(await ev(i, `(() => { const f = document.querySelector('.console-screen iframe'); const c = (f.contentWindow.document.getElementById('screen') || f.contentWindow.__emu.canvas()).getBoundingClientRect(); const fr = f.getBoundingClientRect(); return JSON.stringify({ x: Math.round(fr.left + c.left), y: Math.round(fr.top + c.top), width: Math.round(c.width), height: Math.round(c.height) }); })()`));
      return r;
    };
    const shot = async (name, i, crop = false) => {
      const img = await wins[i].webContents.capturePage(crop ? await gameRect(i) : undefined);
      writeFileSync(join(out, `${name}-${profiles[i].id}.png`), img.toPNG());
    };
    await until('partners seen', async () => {
      const s = await world(0);
      return s?.partners && Object.keys(s.partners).length >= profiles.length - 1;
    }, 30000);
    log('A sees', JSON.stringify((await world(0)).partners));
    for (const [i] of profiles.entries()) await shot('01-same-map', i);

    // B walks a little square while A's page records: a strip of frames
    const strip = [];
    const walk = async (i, keys) => {
      for (const k of keys) await hold(i, [k], 260);
    };
    const rec = (async () => {
      for (let n = 0; n < 24; n++) {
        strip.push((await wins[0].webContents.capturePage(await gameRect(0))).toPNG());
        await sleep(110);
      }
    })();
    await walk(1, ['left', 'left', 'down', 'down', 'right', 'right', 'up', 'up']);
    await rec;
    strip.forEach((png, n) => writeFileSync(join(out, `strip-${String(n).padStart(2, '0')}.png`), png));
    log('strip frames', strip.length);
    await shot('02-after-walk', 0);
    if (profiles.length > 2) {
      await walk(2, ['right', 'down']);
      await sleep(800);
      await shot('03-three', 0, true);
    }

    // A faces B and presses A
    const a = (await world(0)).local;
    const b = (await world(1)).local;
    log('A at', JSON.stringify(a), 'B at', JSON.stringify(b));
    const step = async (i, dir) => { await hold(i, [dir], 150); await sleep(450); };
    // walk A next to B (one tile left of B), then face right
    const goto = async (i, tx, ty) => {
      for (let n = 0; n < 40; n++) {
        const s = (await world(i)).local;
        if (!s) { await sleep(200); continue; }
        if (s.tx === tx && s.ty === ty) return s;
        if (s.tx !== tx) await step(i, s.tx < tx ? 'right' : 'left');
        else await step(i, s.ty < ty ? 'down' : 'up');
      }
      return (await world(i)).local;
    };
    const bNow = (await world(1)).local;
    await goto(0, bNow.tx - 1, bNow.ty);
    // turn to face B (a short press turns without walking)
    for (let n = 0; n < 6 && (await world(0)).local?.facing !== 4; n++) { await hold(0, ['right'], 50 + n * 15); await sleep(400); }
    await shot('04-facing', 0, true);
    log('before A', JSON.stringify(await world(0)));
    await press(0, 'a', 600);
    const m = await until('menu opens', async () => (await world(0))?.menu, 5000).catch(() => null);
    log('menu', JSON.stringify(m));
    await shot('05-menu', 0);
    // choose Wave (down, down, A) through the keyboard path of the overlay
    if (m) {
      for (const k of ['ArrowDown', 'ArrowDown']) await ev(0, `(() => { const f = document.querySelector('.console-screen iframe'); f.contentWindow.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true })); })()`);
      await sleep(200);
      await shot('06-menu-wave', 0);
      await ev(0, `(() => { const f = document.querySelector('.console-screen iframe'); f.contentWindow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      await sleep(350);
      await shot('07-waved-A', 0, true);
      await shot('07-waved-B', 1, true);
    }
    const stats = await Promise.all(profiles.map((_, i) => ev(i, 'JSON.stringify(window.__slWorld?.stats || null)')));
    log('stats', stats.join(' '));
    writeFileSync(join(out, 'result.json'), JSON.stringify({ runId, states: st, stats: stats.map((s) => JSON.parse(s)), menu: m }, null, 2));
    finish(0);
  } catch (e) {
    console.error(e);
    try {
      for (const [i, w] of BrowserWindow.getAllWindows().entries()) writeFileSync(join(out, `fail-${i}.png`), (await w.webContents.capturePage()).toPNG());
    } catch { /* no windows */ }
    finish(1);
  }
}
