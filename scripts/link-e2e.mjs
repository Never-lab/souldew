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
//        [--desync]          (B's host gets another clock: the games fall out of step – both saves go back; with
//                            --seamless --desync-state <file>: B's host starts A's seat from that state instead – each
//                            game then goes back to where it was before the link)
//        [--seamless [--state1 <a.state> --state2 <b.state> …]]   (docs/MULTIPLAYER.md › "Seamless": every player is
//                            in the middle of their game in the fast player – a state of that moment (the fast player's
//                            format, e.g. linkhost --bench F --export) loaded while paused – and the link starts from the
//                            running games without a restart; --script is then the recording from that moment on. After
//                            the session each game goes on alone from where the session left it: same page, no reboot.
//                            Frame strips of the switch in and out go to --out. --prestep k: the states are k frames
//                            before the recording's start; those k frames run in the fast player, nothing pressed.)
//        [--disconnect <frame>]  (B's peer link goes down there; both players leave – with --seamless each goes on alone
//                            from their own console as it is)
//        [--relay]           (every peer connection relayed through TURN – the bot's /link/ice must answer)
//        [--gb-look original|color] [--gb-look1 …] [--gb-look2 …]  (every / one player's Settings › Game Boy look;
//                            default color, as the recordings were made)
//        [--engine]          (Settings › "souldew engine (beta)": every fast player is the souldew engine – with
//                            --seamless the partners join each player's running game in its own process and leave it
//                            the same way: checks linkedInPlace / aloneInPlace)
//        [--winner p1|p2|p3,p4]   (a battle: the seat(s) the recording's battle is known to end with as the winners –
//                            every computer must have read that result, the same, and logged it; docs/MULTIPLAYER.md
//                            › "Battle results and wagers")
//        [--wager <₽> [--format single|double|multi]]   (A's challenge is for that much money: after the session each
//                            player's game pays / gets it in the overworld – checked in RAM; with --save-after each
//                            player then saves in the game (Gen 3: START, SAVE, YES, YES) and the money is checked in the
//                            run's save file)
//        [--show]
//
// Never commit ROMs, saves or the screenshots.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, statfsSync, constants as fsConstants } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
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
  // (a full disk would hurt more than this test: stop early)
  const free = (() => { try { const f = statfsSync(resolve(opt('data'), '..')); return f.bavail * f.bsize; } catch { return Infinity; } })();
  if (free < 1.2e9) { console.error(`only ${(free / 1e9).toFixed(1)} GB free – not starting`); app.exit(2); return; }
  const result = { kind, frames, players: seats, rom1: basename(rom1), rom2: basename(rom2), checks: {} };
  const SLOTS = ['p1', 'p2', 'p3', 'p4'].slice(0, seats);
  const APP = { headers: { 'x-soullink': '1' } }; // (2.7.1: the server answers save reads only to the app – server/lib/guard.mjs)

  // ---- one server and scratch data folder per player ----------------------------------------------------------------
  const servers = [];
  const profiles = [['A', 'Marius', 7401], ['B', 'Tim', 7402], ['C', 'Robin', 7403], ['D', 'Kim', 7404]].slice(0, seats).map(([id, name, port], i) => [id, name, port, romOf(i)]).map(([id, name, port, rom]) => {
    const dir = join(data, id);
    const lib = join(dir, 'roms');
    mkdirSync(lib, { recursive: true });
    // (--all-roms: every player's library has every game of the session – the partners' are then found by CRC + SHA-1)
    // (a clone where the disk can – APFS: no extra space – else a copy: a DS game is 128–512 MB per player)
    for (const r of flag('all-roms') ? [...new Set([rom, ...[0, 1, 2, 3].slice(0, seats).map(romOf)])] : [rom]) copyFileSync(r, join(lib, basename(r)), fsConstants.COPYFILE_FICLONE);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ onboarded: true, lang: 'en', playerName: name, libraryFolders: [lib], bootAnimation: false, sounds: false, nativeCore: true, nativeEngine: flag('engine'),
      gbLook: opt(`gb-look${'ABCD'.indexOf(id) + 1}`) || opt('gb-look', 'color') })); // (the recordings were made on Game Boy Colors)
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', SLS_DATA_DIR: dir, PORT: String(port), NO_OPEN: '1', SLS_E2E: '1', SLS_LINK_TEST_SCRIPT: script,
      // (--seamless --desync: the states differ instead – a game in the middle of a trade may never read its clock)
      SLS_LINK_TEST_RTC: id === 'B' && flag('desync') ? String(Number(rtc) + 86400000 * 3) : rtc,
      // --relay: every peer connection through Cloudflare TURN (credentials from souldew's bot), never direct; else no
      // TURN at all (both players are on this computer – the bot isn't asked)
      SOULDEW_LINK_ICE: flag('relay') ? 'relay' : 'off' };
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
  // (stopped from outside: no server may outlive the test – the next run would talk to it on the same port)
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => finish(130));
  const api = async (pr, path, body, method) => {
    const r = await fetch(pr.base + path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { 'x-soullink': '1', ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}) },
      body: body instanceof Uint8Array ? body : body !== undefined ? JSON.stringify(body) : undefined });
    const t = await r.text();
    if (!r.ok) throw Object.assign(new Error(`${pr.id} ${path}: ${r.status} ${t.slice(0, 300)}`), { status: r.status, body: t });
    try { return JSON.parse(t); } catch { return t; }
  };
  try {
    for (const [i, p] of servers.entries()) {
      const code = await Promise.race([new Promise((r) => p.once('exit', r)), sleep(2500).then(() => null)]);
      if (code !== null) throw new Error(`server ${profiles[i].id} stopped (port ${profiles[i].port} taken by an older run?)`);
    }
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
      // (the pages' warnings and errors go into result.json – what a failed run needs first)
      w.webContents.on('console-message', (e) => {
        if (e.level === 'warning' || e.level === 'error') (result.console ||= []).push(`${pr.id}: ${String(e.message).slice(0, 300)}`);
      });
      w.loadURL(`${pr.base}/#/soullink?run=${runId}`);
      return w;
    });
    const ev = (i, js) => wins[i].webContents.executeJavaScript(js, true);
    // which player each computer is (an imported run otherwise guesses "p2" – fine for two players, not for four)
    for (const i of all) {
      await new Promise((r) => (wins[i].webContents.isLoading() ? wins[i].webContents.once('did-finish-load', r) : r()));
      // (sl-e2e: the page hands its link session to this script as window.__slLink)
      await ev(i, `localStorage.setItem(${JSON.stringify(`sl-me-${runId}`)}, ${JSON.stringify(JSON.stringify(SLOTS[i]))}); localStorage.setItem('sl-e2e', 'true'); location.reload(); true`);
    }
    await sleep(1500);
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
    const emu = (i, js) => ev(i, `(() => { const f = document.querySelector('iframe[src^="/playernative.html"]'); const e = f?.contentWindow?.__emu; return e ? (${js}) : null; })()`);
    const seamless = flag('seamless');
    // frame strips: the window, as fast as it can be captured, while the game switches into / out of the link session
    const strip = (i, name, ms) => (async () => {
      const t = Date.now();
      for (let k = 0; Date.now() - t < ms; k++) {
        const img = await wins[i].webContents.capturePage();
        writeFileSync(join(out, `strip-${name}-${profiles[i].id}-${String(k).padStart(3, '0')}-${Date.now() - t}ms.png`), img.toPNG());
      }
    })();
    const linked = () => until('every page and the peer links', async () => {
      for (const i of all) for (const s of SLOTS) if (s !== SLOTS[i] && !(await ev(i, `window.__slLink?.sync?.linkDirect(${JSON.stringify(s)})`))) return false;
      return true;
    }, 300000);
    const everyone = async (fn) => { for (const i of all) if (!(await fn(i))) return false; return true; };
    /** A page's run document (the doc the page holds – what it synced from the others too). */
    const docOf = async (i) => JSON.parse(await ev(i, `(() => { const L = window.__slLink?.sync?.doc; if (!L) return null; return JSON.stringify(L.scan(''), (k, v) => v); })()`) || 'null');
    /** Gen 3 money in a battery save: SaveBlock1 (sections 1–4) +0x490 – Emerald XORs it with SaveBlock2's key (+0xAC). */
    const saveMoney3 = (b) => {
      const slot = (o) => ({ o, idx: b.readUInt32LE(o + 0xffc) });
      const newest = [slot(0), slot(0xe000)].sort((x, y) => y.idx - x.idx)[0].o;
      const sec = {};
      for (let k = 0; k < 14; k++) sec[b.readUInt16LE(newest + k * 0x1000 + 0xff4)] = newest + k * 0x1000;
      const sb1 = Buffer.concat([1, 2, 3, 4].map((id) => b.subarray(sec[id], sec[id] + 0xf80)));
      return { money: sb1.readUInt32LE(0x490), key: b.readUInt32LE(sec[0] + 0xac) };
    };
    async function battleChecks() {
      const want = String(opt('winner')).split(',').sort();
      const docs = [];
      await until('every computer has every result', async () => {
        docs.length = 0;
        for (const i of all) docs.push(await docOf(i));
        return docs.every((d) => SLOTS.every((s) => Object.keys(d || {}).some((k) => k.startsWith('lb:') && k.endsWith(`:${s}`))));
      }, 60000).catch(() => null);
      const outcomes = docs.map((d) => {
        const lb = Object.entries(d || {}).filter(([k]) => k.startsWith('lb:')).map(([k, v]) => [k, v?.v ?? v]);
        return { entries: lb, feed: Object.entries(d || {}).filter(([k]) => k.startsWith('feed:lb-')).map(([, v]) => v?.v ?? v) };
      });
      result.battle = outcomes.map((o) => ({ entries: o.entries.map(([k, v]) => ({ k, per: v.per, h: v.h, wager: v.wager, void: v.void || null })), log: o.feed.map((f) => f.text) }));
      const hashes = new Set(outcomes.flatMap((o) => o.entries.map(([, v]) => v.h)));
      result.checks.battleReadOnEveryComputer = outcomes.every((o) => o.entries.length === N && o.entries.every(([, v]) => v.per && !v.void));
      result.checks.battleSameResult = hashes.size === 1 && !hashes.has(undefined);
      const per = outcomes[0].entries[0]?.[1]?.per || {};
      const winners = SLOTS.filter((s) => per[s]?.w > per[s]?.l).sort();
      result.winners = winners;
      result.checks.knownWinner = JSON.stringify(winners) === JSON.stringify(want);
      result.checks.battleLogged = outcomes.every((o) => o.feed.length === 1);
      if (!opt('wager')) return;
      // the wager: each player's own game pays or gets it once it stands in the overworld (RAM), then saves it
      const stake = outcomes[0].entries[0]?.[1]?.wager || 0;
      result.stake = stake;
      const moneyNow = (i) => emu(i, `(() => { const r = (a, n) => e.read(a, n); const u = (b) => (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0;
        if (${JSON.stringify(rom1)}.includes('Emerald') && ${i} % 2 === 0) { const s1 = u(r(0x03005d8c, 4)), s2 = u(r(0x03005d90, 4)); return (u(r(s1 + 0x490, 4)) ^ u(r(s2 + 0xac, 4))) >>> 0; }
        return u(r(0x02025734 + 0x490, 4)); })()`);
      const before = result.moneyBefore = [];
      for (const i of all) before.push(Number(await moneyNow(i)));
      await until('every wager paid', async () => {
        const d = await docOf(0);
        return SLOTS.every((s) => !!(d?.[`lbpay:${Object.keys(d).find((k) => k.startsWith('lb:'))?.split(':')[1]}:${s}`]));
      }, 120000).catch(() => null);
      await sleep(2500);
      const after = result.moneyAfter = [];
      for (const i of all) after.push(Number(await moneyNow(i)));
      const exp = all.map((i) => (want.includes(SLOTS[i]) ? stake : -stake));
      const docEnd = await docOf(0);
      result.payments = Object.entries(docEnd || {}).filter(([k]) => k.startsWith('lbpay:') || k.startsWith('feed:lbp-')).map(([k, v]) => [k, v?.v ?? v]);
      // (the money may already be in when this looks first: each game's own record of before → after, and the RAM now)
      const paid = (s) => result.payments.find(([k]) => k.startsWith('lbpay:') && k.endsWith(`:${s}`))?.[1];
      result.checks.wagerPaidInGame = stake > 0 && all.every((i) => paid(SLOTS[i])?.after - paid(SLOTS[i])?.before === exp[i] && after[i] === paid(SLOTS[i])?.after);
      result.checks.paymentLogged = result.payments.some(([k]) => k.startsWith('feed:lbp-'));
      await shot(`${String(n++).padStart(2, '0')}-paid`);
      for (const i of all) await ev(i, `location.hash = ${JSON.stringify(`#/soullink?run=${runId}`)}; true`);
      await sleep(2500);
      await shot(`${String(n++).padStart(2, '0')}-board-record`);
      result.checks.recordOnBoard = await everyone(async (i) => /1 : 0|0 : 1/.test(String(await ev(i, `document.querySelector('.h2h')?.textContent || ''`))));
      for (const i of all) await ev(i, `location.hash = ${JSON.stringify(`#/play?run=${runId}`)}; true`);
      await sleep(3000);
      if (!flag('save-after')) return;
      // an in-game save: START, (the menu remembers SAVE), A, YES, YES – then the save file holds the money
      for (const i of all) {
        for (const [keys, ms] of [[['start'], 120], [[], 900], [['a'], 120], [[], 1500], [['a'], 120], [[], 1500], [['a'], 120], [[], 6000], [['a'], 120], [[], 1200], [['b'], 120], [[], 600]]) {
          await emu(i, `e.hold(${JSON.stringify(keys)})`);
          await sleep(ms);
        }
      }
      await sleep(8000); // (the battery save settles, then the play view writes it into the run)
      const savedMoney = [];
      for (const [i, pr] of profiles.entries()) {
        const b = Buffer.from(await fetch(`${pr.base}/api/runs/${runId}/save/${SLOTS[i]}`, APP).then((r) => r.arrayBuffer()));
        const m = saveMoney3(b);
        savedMoney.push(i % 2 === 0 && /Emerald/.test(rom1) ? (m.money ^ m.key) >>> 0 : m.money);
      }
      result.moneyInSaves = savedMoney;
      result.checks.wagerInSaves = all.every((i) => savedMoney[i] === after[i]);
      const docSaved = await docOf(0);
      result.checks.paymentMarkedSaved = SLOTS.every((s) => Object.entries(docSaved || {}).some(([k, v]) => k.startsWith('lbpay:') && k.endsWith(`:${s}`) && (v?.v ?? v)?.status === 'saved'));
      await shot(`${String(n++).padStart(2, '0')}-saved`);
    }
    await linked();
    log('peer link up');
    await shot('01-board');

    if (seamless) { // every player is playing: their own game in the fast player, at the recorded moment, paused there
      for (const i of all) await ev(i, `location.hash = ${JSON.stringify(`#/play?run=${runId}`)}; true`);
      await until('every fast player shows a picture', () => everyone((i) => emu(i, 'e.ready')), 120000);
      for (const i of all) {
        const file = opt(`state${i + 1}`);
        if (!file) continue;
        const z = deflateRawSync(readFileSync(file)).toString('base64');
        const ok = await emu(i, `(async () => { e.pause(); const b = Uint8Array.from(atob(${JSON.stringify(z)}), (c) => c.charCodeAt(0));
          const s = new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate-raw'))); return e.loadState(new Uint8Array(await s.arrayBuffer())); })()`);
        if (!ok) throw new Error(`${profiles[i].id}: the mid-game state didn't load`);
        // (--prestep k: the state is k frames before the recording's start, k frames with nothing pressed run here – the
        // picture is then the game's, not the one from before the state was loaded)
        if (Number(opt('prestep', '0')) > 0) await emu(i, `e.step(${Number(opt('prestep'))})`);
      }
      // (a mark in each player page: still there after the session = the page and its canvas never reloaded)
      for (const i of all) await ev(i, `document.querySelector('iframe[src^="/playernative.html"]').contentWindow.__e2eMark = 'm${i}'; true`);
      await sleep(1500);
      await shot('01b-playing');
      // where the game's picture is in each window (for cropping the frame strips)
      result.frameRect = [];
      for (const i of all) result.frameRect.push(JSON.parse(await ev(i, `JSON.stringify((() => { const r = document.querySelector('iframe[src^="/playernative.html"]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, dpr: devicePixelRatio }; })())`)));
      result.checks.ownGamesRunning = await everyone((i) => ev(i, 'window.__slLink.sessions.ownGame()'));
      if (flag('engine')) { // (every game in the souldew engine, alone: the process the link will join)
        result.engineIds = [];
        for (const pr of profiles) result.engineIds.push((await api(pr, '/api/native/status')).session?.id || null);
        result.checks.engineAlone = await everyone(async (i) => (await emu(i, 'e.perf().info?.engine === true && e.perf().info?.mode === "solo"')) === true);
      }
    }

    // ---- invite, join (and the partner's game, when it's another file) -------------------------------------------------
    const stripIn = seamless ? strip(0, 'in', 6000) : null;
    const wagerOpts = opt('wager') ? { wager: Number(opt('wager')), format: opt('format', null) } : {};
    if (opt('wager') && !seamless) { // the challenge on the board: format and wager (a picture of it – the invite is sent below)
      await ev(0, `(() => { const b = [...document.querySelectorAll('.link-buttons button')].find((x) => /Battle/.test(x.textContent)); b?.click(); return !!b; })()`);
      await sleep(700);
      await ev(0, `(() => { const c = document.querySelector('.battle-setup input[type=checkbox]'); c?.click(); return !!c; })()`);
      await sleep(500);
      await shot('01c-challenge');
      await ev(0, `(() => { const b = [...document.querySelectorAll('.battle-setup button')].find((x) => /Cancel/.test(x.textContent)); b?.click(); return !!b; })()`);
    }
    await ev(0, `window.__slLink.sessions.invite(${JSON.stringify(kind)}, ${JSON.stringify(SLOTS.slice(1))}, ${JSON.stringify(wagerOpts)})`);
    await until('invite arrives', () => everyone(async (i) => !i || (await phase(i)) === 'invited'));
    await shot('02-invited');
    if (seamless && flag('desync') && opt('desync-state')) {
      // (out of step on purpose: B's host gets another state for A's seat than A's host has – the hashes differ from
      // frame 120 on. Test-only, in B's page: the snap it received for p1 is swapped for that file before its host starts)
      const other = readFileSync(opt('desync-state'));
      const z = deflateRawSync(other).toString('base64');
      await ev(1, `(() => { const L = window.__slLink.sessions; const start = L._start.bind(L); L._start = (...a) => {
        const st = L.state; st.snaps.p1 = { sha1: ${JSON.stringify(sha(other))}, z: ${JSON.stringify(z)} }; st.saves.p1.state = ${JSON.stringify(sha(other))}; return start(...a); }; return true; })()`);
    }
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
    if (seamless && flag('engine')) { // the partners joined each game in its own process: the same session, now linked
      const ids = [];
      for (const pr of profiles) ids.push((await api(pr, '/api/native/status')).session?.id || null);
      result.checks.linkedInPlace = ids.every((x, i) => x && x === result.engineIds[i])
        && (await everyone(async (i) => (await emu(i, 'e.perf().info?.mode')) === 'link'));
    }
    const st0 = JSON.parse(await ev(0, 'JSON.stringify(window.__slLink.sessions.state)'));
    log('running: delay', st0.delay, 'rtt', st0.rtt);
    result.delay = st0.delay;
    await until('pictures', () => everyone((i) => emu(i, 'e.ready')), 90000);
    if (seamless) {
      await until('every picture switched to the link session', () => everyone(async (i) => (await emu(i, 'e.switches().length')) >= 1), 60000);
      result.seamlessStart = [];
      for (const i of all) result.seamlessStart.push({ player: profiles[i].id, seamless: await ev(i, 'window.__slLink.sessions.state.seamless'), switch: await emu(i, 'e.switches()[0]'), snap: await ev(i, 'window.__slLink.sessions.stats.snap') });
      log('seamless start', JSON.stringify(result.seamlessStart));
      result.checks.startedFromRunningGames = result.seamlessStart.every((x) => x.seamless && x.switch?.to === 'link');
      result.checks.samePlayerPage = await everyone(async (i) => (await ev(i, `document.querySelector('iframe[src^="/playernative.html"]')?.contentWindow?.__e2eMark`)) === `m${i}`);
      await stripIn;
    }
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
    const dropAt = Number(opt('disconnect', '0')); // (B's peer link goes down at that frame: both leave, each goes on alone)
    const frameOf = async (i) => Number(await emu(i, 'e.frames()')) || 0;
    let n = 5;
    for (const target of [...new Set([...shots, rejoinAt, dropAt, frames].filter((x) => x > 0))].sort((a, b) => a - b)) {
      await until(`frame ${target}`, async () => {
        if (flag('desync') && (await phase(0)) === 'ended') return true;
        return everyone(async (i) => (await frameOf(i)) >= target);
      }, Math.max(300000, ((target - (await frameOf(0))) / 60 / Math.max(1, speed)) * 4000 + 120000));
      if (flag('desync') && (await phase(0)) === 'ended') break;
      if (target === dropAt) {
        log('disconnect: B\'s peer link goes down at frame', await frameOf(1));
        await ev(1, 'window.__slLink.sync.stop(); true');
        await sleep(3000);
        result.checks.bothStalled = (await frameOf(0)) - dropAt < 600 && (await frameOf(1)) - dropAt < 600; // (each host waits for the other's buttons)
        await shot(`${String(n++).padStart(2, '0')}-disconnected`);
        break;
      }
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
      const saves = [Buffer.from(await fetch(`${A.base}/api/runs/${runId}/save/p1`, APP).then((r) => r.arrayBuffer())), Buffer.from(await fetch(`${B.base}/api/runs/${runId}/save/p2`, APP).then((r) => r.arrayBuffer()))];
      result.checks.desyncDetected = ended.every((e) => e?.reason === 'linkDesync');
      result.checks.savesBackToBefore = sha(saves[0]) === pre.A && sha(saves[1]) === pre.B;
      result.checks.backupsKept = ended.every((e) => !!e?.restored?.backup);
      if (seamless) { // out of step: each game goes back to where it was before the link – and goes on from there, alone
        result.checks.backToBeforeTheLink = ended.every((e) => e?.resumed === true);
        result.checks.wentOnAlone = await everyone(async (i) => (await emu(i, 'e.perf().core')) !== 'link' && (await emu(i, 'e.switches().at(-1)?.to')) === 'solo');
        result.checks.samePlayerPageAfter = await everyone(async (i) => (await ev(i, `document.querySelector('iframe[src^="/playernative.html"]')?.contentWindow?.__e2eMark`)) === `m${i}`);
      if (flag('engine')) { // each game alone again in the same process (no new player was started)
        const ids = [];
        for (const pr of profiles) ids.push((await api(pr, '/api/native/status')).session?.id || null);
        result.checks.aloneInPlace = ids.every((x, i) => x && x === result.engineIds[i])
          && (await everyone(async (i) => (await emu(i, 'e.perf().info?.mode')) === 'solo'));
      }
      }
      log('desync', JSON.stringify(result.checks));
      return finish(Object.values(result.checks).every(Boolean) ? 0 : 1);
    }

    // ---- leave: both hosts stop, the last battery saves are in the run ---------------------------------------------------
    await sleep(2500);
    const stripOut = seamless ? strip(0, 'out', 6000) : null;
    await ev(0, 'window.__slLink.sessions.leave("left")');
    if (dropAt) await ev(1, 'window.__slLink.sessions.leave("left")'); // (A's bye can't reach B any more: B leaves too)
    await until('everybody ended', () => everyone(async (i) => (await phase(i)) === 'ended'), 60000);
    if (seamless) { // each game goes on alone from where the session left it – the same page, no reboot
      await until('every game going on alone', () => everyone(async (i) => (await emu(i, 'e.switches().length')) >= 2), 60000);
      result.seamlessEnd = [];
      await sleep(800); // (the fast player's first frame count comes four times a second – the link host's last one before)
      for (const i of all) {
        const f1 = Number(await emu(i, 'e.frames()')) || 0;
        await sleep(1500);
        const f2 = Number(await emu(i, 'e.frames()')) || 0;
        result.seamlessEnd.push({ player: profiles[i].id, resumed: await ev(i, 'window.__slLink.sessions.state.ended?.resumed'), switch: await emu(i, 'e.switches().at(-1)'),
          core: await emu(i, 'e.perf().core'), framesAdvance: f2 - f1, sessionOpen: await ev(i, 'location.hash') });
      }
      log('seamless end', JSON.stringify(result.seamlessEnd));
      result.checks.wentOnAlone = result.seamlessEnd.every((x) => x.resumed && x.switch?.to === 'solo' && x.core !== 'link' && x.framesAdvance > 30);
      result.checks.samePlayerPageAfter = await everyone(async (i) => (await ev(i, `document.querySelector('iframe[src^="/playernative.html"]')?.contentWindow?.__e2eMark`)) === `m${i}`);
      if (flag('engine')) { // each game alone again in the same process (no new player was started)
        const ids = [];
        for (const pr of profiles) ids.push((await api(pr, '/api/native/status')).session?.id || null);
        result.checks.aloneInPlace = ids.every((x, i) => x && x === result.engineIds[i])
          && (await everyone(async (i) => (await emu(i, 'e.perf().info?.mode')) === 'solo'));
      }
      await stripOut;
    }
    await sleep(4000);
    await shot(`${String(n++).padStart(2, '0')}-left`);
    const saves = [];
    for (const [i, pr] of profiles.entries()) saves.push(Buffer.from(await fetch(`${pr.base}/api/runs/${runId}/save/${SLOTS[i]}`, APP).then((r) => r.arrayBuffer())));
    saves.forEach((b, i) => writeFileSync(join(out, `after-${profiles[i].id}.sav`), b));
    if (seamless) { // and A plays on (after the saves were taken): a few buttons – close a text box, walk – alone now
      const stripPlay = strip(0, 'play', 4000);
      for (const [keys, ms] of [[['a'], 150], [[], 700], [['a'], 150], [[], 700], [['b'], 150], [[], 400], [['down'], 1200], [[], 300]]) {
        await emu(0, `e.hold(${JSON.stringify(keys)})`);
        await sleep(ms);
      }
      await stripPlay;
      await shot(`${String(n++).padStart(2, '0')}-playing-on`);
    }
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
    if (opt('winner')) await battleChecks();
    if (kind === 'trade' && !dropAt) { // (a session cut off before the trade has none to log)
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
    try { // where every page's session stood
      result.pages = [];
      for (const w of BrowserWindow.getAllWindows()) {
        result.pages.push(await w.webContents.executeJavaScript(`(() => { const L = window.__slLink?.sessions; if (!L) return null; const st = L.state;
          return { phase: st.phase, ended: st.ended, saves: Object.fromEntries(Object.entries(st.saves || {}).map(([k, v]) => [k, { b64: typeof v.b64, state: v.state }])),
            snaps: Object.fromEntries(Object.entries(st.snaps || {}).map(([k, v]) => [k, { sha1: v.sha1, z: typeof v.z, got: v.got }])), ready: st.ready, got: st.got, stats: L.stats }; })()`, true));
      }
    } catch { /* the windows are gone */ }
    try {
      for (const [i, w] of BrowserWindow.getAllWindows().entries()) writeFileSync(join(out, `fail-${i}.png`), (await w.webContents.capturePage()).toPNG());
    } catch { /* no windows */ }
    finish(1);
  }
}
