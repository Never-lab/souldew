// End-to-end test of Shared World in the real app (docs/MULTIPLAYER.md › 9): two or three souldew servers with scratch
// data folders (players on this computer), one SoulLink run (created on A, joined on the others), each player's
// battery save in it, every page in Electron (muted) playing its own game in the fast player. The players stand on the
// same map; B walks around while A's page draws B over A's game – screenshots and a strip of frames go to --out. Then A
// walks up to B and presses A: the menu opens, A picks Wave, and B sees the bubble.
//
//   node scripts/world-e2e.mjs --rom <emerald.gba | red.gb | platinum.nds | heartgold.nds> --save1 <a.sav> --save2 <b.sav> [--save3 <c.sav>] [--save4 <d.sav>] --data <dir> --out <dir> [--show]
//                              [--rom2/--rom3/--rom4 <rom>] (that player's own game – a pair run of Emerald and Sapphire …)
//                              (Game Boy games too: Red, Blue, Yellow, Gold, Silver, Crystal – a Repel that never runs out
//                              keeps wild Pokémon away while the players walk)
//                              [--lang de]   (the app's language on every computer)
//                              [--look color] (Settings › "Game Boy look" on every computer: original or color)
//                              [--port 7411] (the first server's port; the others follow – another run on this computer
//                                             needs other ports)
//                              [--edge [north|south|west|east]] (B walks over the edge of A's map, A to the last tiles
//                                             before it: B drawn across the connection; B walks back – a strip)
//                              [--frames]    (A's game run frame by frame while A walks a step each way: the camera the
//                                             overlay read against the picture's background, frames.json)
//                              [--browser]   (A plays in the browser player, EmulatorJS, instead of the fast player)
//                              [--engine]    (every fast player is the souldew engine – Settings › "souldew engine (beta)")
//                              [--occlusion] (Emerald, three saves in the Oldale Pokémon Center 2F: instead of the walk and
//                                             the menu, the players line up behind the potted plants, then walk out to a
//                                             tree top in Oldale Town, then A walks into Route 101 while B stands under
//                                             the map-name popup – crops of every player's picture side by side)
//                              [--lead <n>]  (--plus: the lead every page shows when live tracking can't read the team)
//                              [--behind --walk up,left,…] (the DS: B walks those steps, A's picture and the map's
//                                             depth cut after each)
//                              [--clip]      (a muted clip of A's picture: B walks away and around, A walks and turns)
// The DS (Gen 4) is driven frame-exactly through the fast player's step() – a tap turns, six frames walk a tile.
//                              [--plus]      (followers, emotes and rock-paper-scissors: B walks with A's and B's
//                                             Pokémon following – a strip and a muted clip; A challenges B from the
//                                             A menu, both pick in their pictures, the hands show over both heads and
//                                             the log gets its line; A sends a heart; with four players the fourth
//                                             has Shared World off and answers a challenge in the app's card)
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

/**
 * The occlusion scenario (--occlusion): where the game draws the map's top layer over its sprites, the partners must
 * vanish exactly like the real player – compared on the same picture (A's own sprite next to the partners) and with
 * the partners' own pictures. Positions are Emerald's (Oldale Pokémon Center 2F → 1F → Oldale Town → Route 101).
 */
async function occlusion({ world, hold, shot, log, sleep, until, out, emu }) {
  const step = async (i, dir) => { await hold(i, [dir], 150); await sleep(420); };
  const local = async (i) => (await world(i))?.local;
  // a straight line on one map: one axis, then the other (`yFirst`), giving up after 40 steps
  const goto = async (i, tx, ty, yFirst = false) => {
    for (let n = 0; n < 40; n++) {
      const s = await local(i);
      if (!s) { await sleep(200); continue; }
      if (s.tx === tx && s.ty === ty) return s;
      const moveX = s.tx !== tx && (!yFirst || s.ty === ty);
      if (moveX) await step(i, s.tx < tx ? 'right' : 'left');
      else await step(i, s.ty < ty ? 'down' : 'up');
    }
    const s = await local(i);
    log('goto', i, 'wanted', tx, ty, 'is at', JSON.stringify(s));
    return s;
  };
  // onto a warp tile (stairs, door, the exit mat – that one wants the direction once more): steps in `dir` until the
  // map changes, then wait for the new map to settle
  const warp = async (i, dir) => {
    const before = (await world(i))?.cam?.map;
    for (let n = 0; n < 6 && (await world(i))?.cam?.map === before; n++) {
      await hold(i, [dir], 200);
      await sleep(900);
    }
    await until(`warp ${i}`, async () => {
      const w = await world(i);
      return w?.cam && w.cam.map !== before && !w.cam.locked && w.cam.fade === 0 && w.local;
    }, 15000);
    await sleep(900);
  };
  const face = async (i, dir) => { await hold(i, [dir], 40); await sleep(300); };
  const occ = async (i) => (await world(i))?.occlusion;
  const all = (name) => Promise.all([0, 1, 2].map((i) => shot(name, i, true)));

  // 1. behind the potted plants (2F row 8: the leaves are top layer and walkable) – A's own sprite at (6,8) shows what
  //    the game does, B at (5,8) and C at (9,8) are drawn by souldew
  await Promise.all([goto(0, 6, 7, true).then(() => goto(0, 6, 8)), goto(1, 5, 7, true).then(() => goto(1, 5, 8)), goto(2, 9, 7, true).then(() => goto(2, 9, 8))]);
  await Promise.all([face(0, 'down'), face(1, 'down'), face(2, 'down')]);
  await sleep(1200);
  await all('10-plants');
  log('plants: A sees', JSON.stringify(await occ(0)), 'B sees', JSON.stringify(await occ(1)));
  // one step up: out of the leaves, nothing hidden
  await step(1, 'up');
  await sleep(900);
  await shot('11-plants-B-out', 0, true);
  log('B out of the leaves: A sees', JSON.stringify(await occ(0)));
  // right behind A: B is drawn first, then A's own sprite again over B – still without its legs (the leaves cover them)
  await goto(1, 6, 7);
  await face(1, 'down');
  await sleep(900);
  await shot('12-behind-A', 0, true);
  log('B behind A: A sees', JSON.stringify(await occ(0)));
  await goto(1, 5, 7);

  // 2. down the stairs (1,6) and out of the door (6,8) into Oldale Town
  for (const i of [1, 2, 0]) {
    await goto(i, 2, 6, true);
    await warp(i, 'left');
    log('1F', i, JSON.stringify(await local(i)));
    await goto(i, 6, 7);
    await warp(i, 'down');
    log('Oldale', i, JSON.stringify(await local(i)));
  }
  // the tree tops on row 17 (x 16, 17): the canopy of the tree below covers the feet – B on (16,17), A on (17,17)
  await goto(1, 16, 17);
  await goto(2, 13, 17);
  await goto(0, 17, 17, true);
  await Promise.all([face(0, 'up'), face(1, 'up')]);
  await sleep(1200);
  await all('20-treetop');
  log('tree top: A sees', JSON.stringify(await occ(0)));

  // 3. the map-name popup: B waits on Route 101 (6,2) – where the popup is on A's picture once A stands on (9,5)
  await goto(1, 9, 17);
  await goto(1, 9, 19, true);
  await step(1, 'down'); // (across the connection: Route 101 (9,0))
  await sleep(600);
  await goto(1, 9, 2, true);
  await goto(1, 6, 2);
  await face(1, 'down');
  log('B on Route 101', JSON.stringify(await local(1)));
  await goto(0, 9, 17);
  await goto(0, 9, 19, true);
  // A walks down into Route 101 and on to (9,5); frames while the popup shows
  const frames = [];
  const walking = (async () => { for (let n = 0; n < 6; n++) await step(0, 'down'); })();
  const t0 = Date.now();
  while (Date.now() - t0 < 4200) {
    const w = await world(0);
    frames.push({ t: Date.now() - t0, popup: w?.popup || null, local: w?.local, partners: w?.partners });
    await shot(`30-popup-${String(frames.length).padStart(2, '0')}`, 0, true);
    await sleep(150);
  }
  await walking;
  writeFileSync(join(out, 'popup-frames.json'), JSON.stringify(frames, null, 1));
  log('popup frames', frames.length, 'with a popup', frames.filter((f) => f.popup).length);
  await shot('31-after-popup', 0, true);
  void emu;
}

/**
 * A clip of A's picture (--clip): B walks away and around while A walks and turns – the partner on the ground the
 * whole time, the camera following A. PNG frames into out/clip-frames, then a muted out/clip.mp4 (ffmpeg).
 */
async function clip({ world, log, sleep, out, wins, gameRect, ds, hold }) {
  const step = ds?.step || (async (i, dir) => { await hold(i, [dir], 150); await sleep(420); });
  const dir = join(out, 'clip-frames');
  mkdirSync(dir, { recursive: true });
  for (const d of ['right', 'right', 'right', 'right', 'down']) await step(1, d);
  let rec = true;
  let n = 0;
  const states = [];
  const t0 = Date.now();
  const r = await gameRect(0);
  const top = { ...r, height: Math.round(r.height / 2) };
  const recording = (async () => {
    while (rec) {
      const img = await wins[0].webContents.capturePage(top);
      writeFileSync(join(dir, `f${String(n++).padStart(4, '0')}.png`), img.toPNG());
      if (!(n % 4)) {
        const w = await world(0);
        states.push({ n, drawn: w?.drawn, drawable: w?.drawable, field: w?.field, p: Object.fromEntries(Object.entries(w?.partners || {}).map(([k, v]) => [k, { x: v.s?.x, y: v.s?.y, map: v.s?.map, hidden: v.s?.hidden, pos: v.pos }])) });
      }
      await sleep(25);
    }
  })();
  const walk = async (i, keys) => { for (const k of keys) await step(i, k); };
  await Promise.all([
    walk(1, ['left', 'left', 'up', 'up', 'right', 'right', 'down', 'down', 'left', 'left']),
    (async () => { await sleep(800); await walk(0, ['left', 'left', 'right', 'right', 'down', 'up']); if (ds) { await ds.turn(0, 'down'); await ds.turn(0, 'right'); } })(),
  ]);
  await sleep(1500);
  rec = false;
  await recording;
  const secs = (Date.now() - t0) / 1000;
  writeFileSync(join(out, 'clip-states.json'), JSON.stringify(states, null, 1));
  log('clip frames', n, 'in', secs.toFixed(1), 's', JSON.stringify((await world(0))?.drawn || (await world(0))?.partners));
  await new Promise((res) => spawn('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(Math.max(1, Math.round(n / secs))), '-i', join(dir, 'f%04d.png'), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p', '-an', join(out, 'clip.mp4')]).on('exit', res).on('error', res));
}

/**
 * The followers, emotes and rock-paper-scissors (--plus). A and B play the same game family on the same map.
 */
async function plus({ world, hold, shot, log, sleep, until, out, ev, wins, gameRect, profiles, runId, ds = null }) {
  const step = ds?.step || (async (i, dir) => { await hold(i, [dir], 150); await sleep(420); });
  const key = (i, k) => ev(i, `(() => { const f = document.querySelector('.console-screen iframe'); f.contentWindow.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true })); return true; })()`);
  const local = async (i) => (await world(i))?.local;
  // (around what's in the way – a counter, a pillar: the other axis first, else a step to the side; gives up when stuck)
  const goto = async (i, tx, ty) => {
    let yFirst = false;
    let stuck = 0;
    let side = 0;
    for (let n = 0; n < 40; n++) {
      const s = await local(i);
      if (!s) { await sleep(200); continue; }
      if (s.tx === tx && s.ty === ty) return s;
      const wantX = s.tx !== tx ? (s.tx < tx ? 'right' : 'left') : null;
      const wantY = s.ty !== ty ? (s.ty < ty ? 'down' : 'up') : null;
      const dir = (yFirst ? wantY || wantX : wantX || wantY) || 'down';
      const blocked = stuck >= 2 && !(yFirst ? wantX : wantY);
      await step(i, blocked ? (wantX ? ['up', 'down'] : ['left', 'right'])[side++ % 2] : dir);
      const t = await local(i);
      if (t && t.tx === s.tx && t.ty === s.ty) {
        if (++stuck > 6) return t;
        yFirst = !yFirst;
      } else if (!blocked) stuck = 0;
    }
    return local(i);
  };
  const result = { followers: {}, rps: {}, emote: {}, card: null };
  // 1. who follows whom: the leads as both pages know them
  // (--lead <dex no.>: saves whose team live tracking can't read – the DS recordings' saves hold cloned Pokémon – get
  // this lead handed to the play view instead, on every page)
  if (opt('lead')) {
    const lead = { species: Number(opt('lead')), shiny: false, form: 0 };
    await sleep(5000);
    for (const [i] of profiles.entries()) await ev(i, `(() => { const w = window.__slWorld; if (w && !w.lead) { w.update({ lead: ${JSON.stringify(lead)} }); return 'injected'; } return 'had one'; })()`).then((r) => log('lead', i, r));
  }
  await until('leads known', async () => {
    const [a, b] = [await world(0), await world(1)];
    return a?.lead && b?.lead && a.partners?.p2?.lead && b.partners?.p1?.lead;
  }, 60000);
  const [a0, b0] = [await world(0), await world(1)];
  result.followers.leads = { A: a0.lead, B: b0.lead, AseesB: a0.partners.p2.lead, BseesA: b0.partners.p1.lead };
  log('leads', JSON.stringify(result.followers.leads));
  // 2. a clip: B walks a square, A a few steps the other way – A's picture
  const frames = [];
  const rec = (async () => {
    for (let n = 0; n < 56; n++) {
      frames.push((await wins[0].webContents.capturePage(await gameRect(0))).toPNG());
      await sleep(70);
    }
  })();
  const walk = async (i, keys) => { for (const k of keys) await hold(i, [k], 270); };
  await Promise.all([walk(1, ['left', 'left', 'down', 'down', 'right', 'right', 'up', 'up']), (async () => { await sleep(600); await walk(0, ['down', 'down', 'up', 'up']); })()]);
  await rec;
  mkdirSync(join(out, 'clip'), { recursive: true });
  frames.forEach((png, n) => writeFileSync(join(out, 'clip', `f${String(n).padStart(3, '0')}.png`), png));
  result.followers.drawn = (await world(0)).followers;
  log('followers drawn on A', JSON.stringify(result.followers.drawn));
  await shot('10-followers-A', 0, true);
  await shot('10-followers-B', 1, true);

  // 3. rock-paper-scissors from the A menu: A next to B, facing them, A → down to the game → Enter
  const b = await local(1);
  // (the tile left of B first; where a wall or a pillar is there – the Ruby/Sapphire Pokémon Center 2F – the right one,
  // above or below)
  let side = null;
  for (const [dx, dy, key, dir] of [[-1, 0, 'right', 4], [1, 0, 'left', 3], [0, 1, 'up', 2], [0, -1, 'down', 1]]) {
    const s = await goto(0, b.tx + dx, b.ty + dy);
    if (s?.tx === b.tx + dx && s?.ty === b.ty + dy) { side = { key, dir }; break; }
  }
  side = side || { key: 'right', dir: 4 };
  if (ds) await ds.turn(0, side.key);
  // turn to face B with a tap – a little longer each time; a tap that became a step (Gen 1 turns only on the shortest
  // ones) walks back first
  const opposite = { right: 'left', left: 'right', up: 'down', down: 'up' };
  for (let n = 0; n < 8 && (await local(0))?.facing !== side.dir; n++) {
    const was = await local(0);
    await hold(0, [side.key], 20 + n * 12);
    await sleep(400);
    const now = await local(0);
    if (was && now && (now.tx !== was.tx || now.ty !== was.ty)) {
      await hold(0, [opposite[side.key]], 150);
      await sleep(450);
    }
  }
  log('next to B', JSON.stringify({ local: (await world(0)).local, own: (await world(0)).own, drawn: (await world(0)).followers }));
  await (ds ? ds.press(0, 'a') : hold(0, ['a'], 120));
  if (ds) log('after A', JSON.stringify(await world(0)));
  const m = await until('menu', async () => (await world(0))?.menu, 6000);
  for (let n = 0; n < 8 && (await world(0))?.menu?.sel !== 'rps'; n++) { await key(0, 'ArrowDown'); await sleep(120); }
  await shot('20-menu-rps-A', 0);
  await key(0, 'Enter');
  await until('A picks', async () => (await world(0))?.rps?.phase === 'pick', 6000);
  await until('B is asked', async () => (await world(1))?.rps?.phase === 'pick', 10000);
  result.rps.asked = { A: (await world(0)).rps, B: (await world(1)).rps };
  await shot('21-rps-pick-A', 0);
  await shot('21-rps-pick-B', 1);
  // A: scissors (paper → right), B: paper (as it opens) – A wins
  await key(0, 'ArrowRight');
  await sleep(150);
  await key(0, 'Enter');
  await sleep(400);
  await shot('22-rps-waiting-A', 0, true);
  await key(1, 'Enter');
  await until('hands over the heads', async () => Object.keys((await world(0))?.bubbles || {}).length >= 2, 8000);
  await sleep(250);
  await shot('23-rps-hands-A', 0, true);
  await shot('23-rps-hands-B', 1, true);
  await shot('23-rps-hands-A-page', 0);
  result.rps.bubbles = { A: (await world(0)).bubbles, B: (await world(1)).bubbles, Asays: (await world(0)).rps?.say, Bsays: (await world(1)).rps?.say };
  log('rps', JSON.stringify(result.rps.bubbles));
  await sleep(3500);
  const feedOf = (i) => ev(i, `JSON.stringify(Object.values(window.__slLink.sync.doc.scan('feed:')).filter((f) => f.type === 'rps').map((f) => ({ slot: f.slot, partner: f.partner, text: f.text })))`).then(JSON.parse);
  result.rps.log = { A: await feedOf(0), B: await until('the line reached B', async () => { const f = await feedOf(1); return f.length ? f : null; }, 15000).catch(() => []) };
  log('log', JSON.stringify(result.rps.log));

  // 4. an emote: A → menu → the heart; B sees it over A
  await sleep(600);
  await (ds ? ds.press(0, 'a') : hold(0, ['a'], 120));
  await until('menu again', async () => (await world(0))?.menu, 6000);
  for (let n = 0; n < 8 && !String((await world(0))?.menu?.sel || '').startsWith('emote'); n++) { await key(0, 'ArrowDown'); await sleep(120); }
  await key(0, 'Enter');
  await until('B sees the heart', async () => (await world(1))?.bubbles?.p1 === 'heart', 6000).catch(() => null);
  await shot('30-heart-B', 1, true);
  result.emote = { B: (await world(1)).bubbles };

  // 5. four players: D plays without Shared World – the card
  if (profiles.length > 3) {
    await ev(0, `window.__slWorld.challenge('p4'); true`);
    const card = await until('D’s card', () => ev(3, `document.querySelector('.rps-card') ? document.querySelector('.rps-card').innerText : null`), 10000).catch(() => null);
    log('D’s games', await ev(3, `import('/lib/worldrps.mjs').then((m) => JSON.stringify({ games: m.rpsFor(window.__slLink.sync)?.hub.list(), claimed: [...(m.rpsFor(window.__slLink.sync)?.claimed || [])] }))`));
    await shot('40-card-D', 3);
    await ev(3, `document.querySelectorAll('.rps-card .rps-hands button')[0].click(); true`); // rock
    await until('A picks vs D', async () => (await world(0))?.rps?.phase === 'pick', 6000);
    await key(0, 'Enter'); // paper
    await sleep(1200);
    await shot('41-card-D-result', 3);
    await shot('41-vs-D-A', 0, true);
    result.card = { asked: card, after: await ev(3, `document.querySelector('.rps-card')?.innerText || null`) };
    log('card', JSON.stringify(result.card));
    // C and D (another game family) see each other, not A and B
    const c = await world(2);
    result.cd = { Csees: Object.entries(c?.partners || {}).filter(([, p]) => p.pos).map(([s]) => s), Cfollowers: c?.followers };
  }
  writeFileSync(join(out, 'plus.json'), JSON.stringify(result, null, 1));
  void m;
  void runId;
}
/**
 * Frame by frame (--frames): A's game paused and run one frame at a time while A walks a step each way – per picture
 * the camera the overlay read (from the bytes sent with that picture), the partners' screen positions and the picture
 * itself (160×144). The background's shift between two pictures must be the camera's change between them: then a
 * partner standing still stays put on the map while you walk (frames.json; also the RAM at rest, in the START menu,
 * talking to nobody, for the address checks of docs/MULTIPLAYER.md › 9).
 */
async function frames({ emu, log, sleep, out }) {
  // the picture on A's screen as base64 RGB, 160×144 (the overlay's host keeps the last one)
  const PIC = `(() => { const p = w.picture(); if (!p) return null; const o = new Uint8Array(p.w * p.h * 3); for (let i = 0; i < p.w * p.h; i++) { if (p.fmt === 0) { o[i * 3] = p.px[i * 4 + 2]; o[i * 3 + 1] = p.px[i * 4 + 1]; o[i * 3 + 2] = p.px[i * 4]; } else { const v = p.px[i * 2] | (p.px[i * 2 + 1] << 8); o[i * 3] = (v >> 11) << 3; o[i * 3 + 1] = ((v >> 5) & 63) << 2; o[i * 3 + 2] = (v & 31) << 3; } } let s = ''; for (let i = 0; i < o.length; i += 8192) s += String.fromCharCode(...o.subarray(i, i + 8192)); return btoa(s); })()`;
  const seq = [];
  const ranges = JSON.parse((await emu(0, 'JSON.stringify(w.state().ranges || [])')) || '[]');
  for (const dir of ['right', 'left', 'down', 'up']) {
    await emu(0, `(e.hold(${JSON.stringify([dir])}), true)`);
    // (held for 12 frames: a turn first where the player faced elsewhere, then one step – 16 frames, 8 on the bike)
    for (let n = 0; n < 30; n++) {
      await emu(0, 'e.step(1).then(() => true)');
      if (n === 11) await emu(0, '(e.hold([]), true)');
      await sleep(60); // (the picture and the bytes sent with it reach the page; the overlay draws for them)
      const st = JSON.parse((await emu(0, 'JSON.stringify(w.state())')) || 'null');
      // (and the RAM those come from: the world table's per-picture ranges)
      const raw = JSON.parse((await emu(0, `JSON.stringify((${JSON.stringify(ranges)}).map(([a, l]) => Array.from(e.read(a, l) || [])))`)) || 'null');
      seq.push({ dir, n, cam: st?.cam, frames: st?.frames, local: st?.local, partners: st?.partners, raw, pic: await emu(0, PIC) });
    }
  }
  // the START menu holds the player: the partners go (the game's own lock – Gen 1 the font in VRAM, Gen 2 a script);
  // B closes it again
  const camNow = async (frames) => {
    await emu(0, `e.step(${frames}).then(() => true)`);
    await sleep(80);
    return JSON.parse((await emu(0, 'JSON.stringify({ cam: w.state().cam, drawable: w.state().drawable })')) || 'null');
  };
  const press = async (k, after) => {
    await emu(0, `(e.hold(${JSON.stringify([k])}), true)`);
    await emu(0, 'e.step(6).then(() => true)');
    await emu(0, '(e.hold([]), true)');
    return camNow(after);
  };
  const locks = { menu: await press('start', 50), closed: await press('b', 80) };
  await emu(0, '(e.resume(), true)');
  log('locks', JSON.stringify(locks));
  // the background's shift between two pictures (rows 0–40 and 110–143, away from the sprites in the middle)
  const decode = (b64) => Uint8Array.from(Buffer.from(b64, 'base64'));
  const shift = (a, b) => {
    let best = null;
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        let d = 0;
        for (const y of [...Array(36).keys(), ...Array.from({ length: 30 }, (_, i) => 110 + i)]) {
          for (let x = 8; x < 152; x += 2) {
            const yy = y + dy;
            if (yy < 0 || yy >= 144) continue;
            const i = (y * 160 + x) * 3;
            const j = (yy * 160 + x + dx) * 3;
            d += Math.abs(a[i] - b[j]) + Math.abs(a[i + 1] - b[j + 1]);
          }
        }
        if (!best || d < best.d) best = { dx, dy, d };
      }
    }
    return best;
  };
  const rows = [];
  for (let i = 1; i < seq.length; i++) {
    const [p, q] = [seq[i - 1], seq[i]];
    if (!p.pic || !q.pic || !p.cam || !q.cam || p.dir !== q.dir) continue;
    const s = shift(decode(q.pic), decode(p.pic));
    rows.push({ dir: q.dir, n: q.n, camDx: q.cam.cx - p.cam.cx, camDy: q.cam.cy - p.cam.cy, bgDx: s.dx, bgDy: s.dy, ok: s.dx === q.cam.cx - p.cam.cx && s.dy === q.cam.cy - p.cam.cy });
  }
  writeFileSync(join(out, 'frames.json'), JSON.stringify({ rows, locks, seq: seq.map(({ pic, ...r }) => r) }, null, 1));
  const bad = rows.filter((r) => !r.ok);
  log('frames: camera vs background', rows.length, 'pairs,', bad.length, 'off', JSON.stringify(bad.slice(0, 8)));
  const lockOk = locks.menu?.drawable === false && locks.closed?.drawable === true;
  if (!lockOk) log('the START menu didn’t hide the partners (or closing it didn’t bring them back)');
  return bad.length + (lockOk ? 0 : 1);
}

/**
 * Connected maps (--edge [north|south|west|east]): B walks over the edge of A's map onto the map next door, A to the
 * last tiles before it – A still sees B (and B's Pokémon), drawn across the edge; then B walks back while A's page
 * records a strip. Without a direction: the first connection of A's map.
 */
async function edge({ world, hold, shot, log, sleep, out, wins, gameRect }) {
  const step = async (i, d) => { await hold(i, [d], 150); await sleep(420); };
  const local = async (i) => (await world(i))?.local;
  const conns = (await world(0))?.conns;
  const want = opt('edge');
  const names = { [2]: 'north', [1]: 'south', [3]: 'west', [4]: 'east' };
  const c = conns?.list?.find((x) => !want || names[x.dir] === want) || conns?.list?.[0];
  if (!c) throw new Error(`no connection on A's map: ${JSON.stringify(conns)}`);
  const key = { 2: 'up', 1: 'down', 3: 'left', 4: 'right' }[c.dir];
  const back = { up: 'down', down: 'up', left: 'right', right: 'left' }[key];
  const side = key === 'up' || key === 'down' ? ['left', 'right'] : ['up', 'down'];
  // walk in `key` until `done(state)`, around what's in the way: blocked, it goes along the obstacle to one side
  // (trying forward after each step) and turns to the other side when that side is blocked too
  const same = (p, q) => p && q && p.tx === q.tx && p.ty === q.ty && p.map === q.map;
  const walk = async (i, done, max = 90) => {
    let k = 0;
    for (let n = 0; n < max; n++) {
      const s = await local(i);
      if (s && done(s)) return s;
      await step(i, key);
      if (!same(await local(i), s)) continue;
      // blocked: sideways until forward is free (at most 12 steps), else the other way
      for (let m = 0; m < 12; m++) {
        const a = await local(i);
        await step(i, side[k % 2]);
        const b = await local(i);
        if (same(a, b)) {
          k++;
          continue;
        }
        await step(i, key);
        if (!same(await local(i), b)) break;
      }
    }
    return local(i);
  };
  const map0 = (await local(0)).map;
  const near = (s) => s.map === map0 && ({ up: s.ty <= 1, down: s.ty >= conns.h - 2, left: s.tx <= 1, right: s.tx >= conns.w - 2 })[key];
  // A finds its way to the last tiles first; B then goes along A's line (the way A found) and on over the edge
  const a = await walk(0, near);
  const lineKey = key === 'up' || key === 'down' ? 'tx' : 'ty';
  for (let n = 0; n < 40; n++) {
    const s = await local(1);
    if (!s || s[lineKey] === a[lineKey] || s.map !== map0) break;
    await step(1, lineKey === 'tx' ? (s.tx < a.tx ? 'right' : 'left') : s.ty < a.ty ? 'down' : 'up');
    const t = await local(1);
    if (same(t, s)) await step(1, key); // (in the way: forward first, then along again)
  }
  const b = await walk(1, (s) => s.map !== map0);
  await step(1, key);
  await step(1, key);
  await sleep(1200);
  const w = await world(0);
  const seen = { A: a, B: await local(1), conn: c, partner: w.partners?.p2, followers: w.followers };
  log('across the edge', JSON.stringify(seen));
  await shot('50-edge-A', 0, true);
  await shot('50-edge-B', 1, true);
  // B walks back over the edge while A watches
  const strip = [];
  const rec = (async () => {
    for (let n = 0; n < 20; n++) {
      strip.push((await wins[0].webContents.capturePage(await gameRect(0))).toPNG());
      await sleep(120);
    }
  })();
  for (let n = 0; n < 4; n++) await hold(1, [back], 270);
  await rec;
  mkdirSync(join(out, 'edge'), { recursive: true });
  strip.forEach((png, n) => writeFileSync(join(out, 'edge', `f${String(n).padStart(3, '0')}.png`), png));
  const after = await world(0);
  seen.back = { B: await local(1), partner: after.partners?.p2 };
  writeFileSync(join(out, 'edge.json'), JSON.stringify(seen, null, 1));
  // (only a partner on the other map counts: water or a wall on the way leaves B on A's map)
  const across = !!seen.partner?.pos && !!seen.B && seen.B.map !== seen.A?.map;
  if (!across) log('B didn’t get across the edge', JSON.stringify(b));
  return across;
}

async function main() {
  const { app, BrowserWindow } = await import('electron');
  const data = resolve(opt('data'));
  const out = resolve(opt('out'));
  mkdirSync(out, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const saves = [opt('save1'), opt('save2'), opt('save3'), opt('save4')].filter(Boolean);
  const SLOTS = ['p1', 'p2', 'p3', 'p4'].slice(0, saves.length);

  const servers = [];
  // (--port: the first server's port, the others after it – two e2e runs on one computer must not share servers)
  const port0 = Number(opt('port', 7411));
  const profiles = [['A', 'Marius', port0], ['B', 'Tim', port0 + 1], ['C', 'Kim', port0 + 2], ['D', 'Lena', port0 + 3]].slice(0, saves.length).map(([id, name, port], i) => {
    const dir = join(data, id);
    const lib = join(dir, 'roms');
    mkdirSync(lib, { recursive: true });
    const romFile = opt(`rom${i + 1}`) || opt('rom');
    copyFileSync(romFile, join(lib, basename(romFile)));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ onboarded: true, lang: opt('lang', 'en'), playerName: name, libraryFolders: [lib], bootAnimation: false, sounds: false, nativeCore: !(id === 'A' && args.includes('--browser')), nativeEngine: args.includes('--engine'), ...(opt('look') ? { gbLook: opt('look') } : {}) }));
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
    // (this profile's own copy – the library may list more games it found elsewhere)
    const pick = (lib, i) => lib.roms.find((r) => basename(r.file || '') === basename(opt(`rom${i + 1}`) || opt('rom'))) || lib.roms[0];
    const rom = pick(libA, 0);
    const players = Object.fromEntries(SLOTS.map((s, i) => [s, { name: profiles[i].name }]));
    const built = await api(A, '/api/runs/build', { romId: rom.id, randomize: false, mode: 'soullink', players, buildFor: SLOTS, gameId: rom.gameId, name: 'World test', rules: {} });
    const runId = built.manifest.id;
    const run = await api(A, `/api/runs/${runId}`);
    const pack = run.manifest?.pack || run.pack;
    for (const [i, pr] of profiles.entries()) {
      if (!i) continue;
      const lib = await api(pr, '/api/library');
      const imported = await api(pr, '/api/runs/import', { pack });
      await api(pr, '/api/runs/build', { runId: imported.id, romId: pick(lib, i).id, randomize: false, values: {}, seeds: {}, players: pack.players, buildFor: [SLOTS[i], ...SLOTS.filter((s) => s !== SLOTS[i])], name: pack.name, mode: 'soullink', expectedOutputs: pack.outputs, gameId: pick(lib, i).gameId });
      await api(pr, `/api/runs/${runId}/me`, { slot: SLOTS[i] }).catch(() => null);
    }
    for (const [i, pr] of profiles.entries()) await api(pr, `/api/runs/${runId}/save/${SLOTS[i]}`, new Uint8Array(readFileSync(saves[i])), 'PUT');
    log('run', runId, 'on', profiles.length, 'computers');

    const show = args.includes('--show');
    const wins = profiles.map((pr, i) => {
      const w = new BrowserWindow({ width: 1180, height: 780, x: 30 + i * 420, y: 30 + i * 30, show, webPreferences: { partition: `world-e2e-${pr.id}`, backgroundThrottling: false } });
      w.webContents.setAudioMuted(true);
      // (errors of the pages – the player's iframe too – into the log)
      w.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') console.log(`[page ${pr.id}] ${e.level}: ${String(e.message).slice(0, 300)}`); });
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
    // (sl-e2e: the page hands its peer link to this script as window.__slLink – set once, then a reload)
    for (const [i] of profiles.entries()) {
      await until(`page ${i} loaded`, () => ev(i, `!!document.body && (localStorage.getItem('sl-e2e') === 'true' || (localStorage.setItem('sl-e2e', 'true'), location.reload(), false))`), 60000);
      await until(`page ${i}`, () => ev(i, '!!window.__slLink?.sync'), 120000);
    }
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
    // (--plus with four players: the fourth plays without Shared World – rock-paper-scissors comes in the app's card)
    if (args.includes('--plus') && profiles.length > 3) await ev(3, `localStorage.setItem('sl-world-${runId}', 'false'); true`);
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
    // The DS (Gen 4 walks a tile in 16 frames, a tap turns in place): exact frames through the fast player's step(), the
    // way a slow, loaded machine can't spoil – hold, run n frames, let go, let the step finish, play on.
    const stepFrames = async (i, keys, n, after) => {
      await emu(i, `(e.pause(), e.hold(${JSON.stringify(keys)}), true)`);
      await emu(i, `e.step(${n}).then(() => true)`);
      await emu(i, 'e.hold([])');
      await emu(i, `e.step(${after}).then(() => (e.resume(), true))`);
    };
    const DIRS = { up: 2, down: 1, left: 3, right: 4 };
    const ds = {
      turn: async (i, dir) => { if ((await world(i))?.local?.facing !== DIRS[dir]) await stepFrames(i, [dir], 2, 12); },
      step: async (i, dir) => { await ds.turn(i, dir); await stepFrames(i, [dir], 6, 34); },
      press: (i, key) => stepFrames(i, [key], 4, 8),
    };
    // title → continue → overworld
    for (const [i] of profiles.entries()) {
      await until(`page ${i} in the overworld`, async () => {
        const s = await world(i);
        // (the Game Boy games have no overworld callback: a loaded map, unlocked, is it)
        if (s?.local && s.cam && !s.cam.locked && !s.cam.replay && (s.cam.cb2 || s.gb) && s.cam.fade === 0 && s.drawable !== false) return true;
        // (the DS: the field runs, nothing holds the player)
        if (s?.gen === 4 && s.local && s.drawable) return true;
        if (s?.gen === 4 && s.local) {
          // (the field is there – A would talk to whoever stands in front: wait, and say what holds it)
          log(`page ${i}: field not drawable yet`, JSON.stringify({ field: s.field, perFrame: s.perFrame }));
          await sleep(1500);
          return false;
        }
        // (FR/LG replay your last steps after loading – B skips that; it must not count as being there)
        if (s?.cam?.replay) log(`page ${i}: the quest-log replay – skipped`, JSON.stringify({ drawable: s.shown, local: s.local }));
        await press(i, s?.cam?.replay ? 'b' : 'a', 900);
        return false;
      }, 120000);
    }
    // the Game Boy saves stand in tall grass (the grass hides the partners' legs like the player's): a Repel that never
    // runs out keeps wild Pokémon away while the players walk around (test-only – the e2e's own cheat)
    const REPEL = { red_us: 0xd0db, blue_us: 0xd0db, yellow_us: 0xd0da, gold_us: 0xd9eb, silver_us: 0xd9eb, crystal_us: 0xdca1 };
    const games = await Promise.all(profiles.map((_, i) => world(i).then((s) => s?.game)));
    if (games.some((g) => REPEL[g])) {
      const repel = () => Promise.all(games.map((g, i) => (REPEL[g] ? emu(i, `e.write(${REPEL[g]}, new Uint8Array([200]))`).catch(() => null) : null)));
      await repel();
      setInterval(repel, 2000).unref?.();
    }
    await sleep(1500);
    const st = await Promise.all(profiles.map((_, i) => world(i)));
    const isDs = st[0]?.gen === 4;
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
    if (args.includes('--occlusion')) {
      await occlusion({ world, hold, shot, log, sleep, until, out, emu });
      finish(0);
      return;
    }
    if (args.includes('--behind')) {
      // the DS: B walks the steps of --walk, A stands – after each step A's picture and what of B the map hides there
      const steps = String(opt('walk', '')).split(',').filter(Boolean);
      const seen = [];
      for (const [n, d] of steps.entries()) {
        if (isDs) await ds.step(1, d);
        else { await hold(1, [d], 150); await sleep(450); }
        await sleep(400);
        const w = await world(0);
        seen.push({ n, step: d, B: (await world(1))?.local, depth: w?.depth, drawn: w?.drawn?.p2 });
        log('behind', n, d, JSON.stringify(seen.at(-1)));
        await shot(`behind-${String(n).padStart(2, '0')}`, 0, true);
      }
      writeFileSync(join(out, 'behind.json'), JSON.stringify(seen, null, 1));
      finish(0);
      return;
    }
    if (args.includes('--clip')) {
      await clip({ world, shot, log, sleep, out, wins, gameRect, ds: isDs ? ds : null, hold });
      finish(0);
      return;
    }
    if (args.includes('--edge')) {
      const ok = await edge({ world, hold, shot, log, sleep, out, wins, gameRect });
      finish(ok ? 0 : 1);
      return;
    }
    if (args.includes('--frames')) {
      const bad = await frames({ emu, log, sleep, out });
      finish(bad ? 1 : 0);
      return;
    }
    if (args.includes('--plus')) {
      await plus({ world, hold, shot, log, sleep, until, out, ev, wins, gameRect, profiles, runId, ds: isDs ? ds : null });
      finish(0);
      return;
    }

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
