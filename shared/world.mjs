// Shared World (docs/MULTIPLAYER.md › 9): the partners of a SoulLink walk visibly in your own game when they are on
// the same map, and you can walk up to them and press A. souldew draws them as an overlay on top of the emulator
// picture – nothing is written into the game's memory, no game objects are injected.
//
// This module is the part without a browser: which RAM to read per game (shared/data/addresses.json › world, from the
// pret symbol files), what a player's state is, the compact message the players exchange, the interpolation that makes
// 10–15 messages a second look like 60 fps, and the rules for when a partner is drawn. The overlay itself is
// web/lib/worldoverlay.mjs (in the player page), the network side web/lib/sharedworld.mjs (in the play view).
//
// Coordinates are world pixels of the current map: tile × 16 (+ the sub-tile offset while walking). Gen 3 map coords
// are SaveBlock1 `pos` (the camera's tile = the player's tile), the object events' coords carry +7 (MAP_OFFSET).

import { gbWorldTable, gbWatchRanges, gbReadCamera, gbReadPlayer, gbDrawable, gbLocalSprite, gbReadConnections, gbPopupRect } from './worldgb.mjs';

const hex = (v) => (typeof v === 'string' ? parseInt(v, 16) : Number(v));
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const s16 = (b, o) => (u16(b, o) << 16) >> 16;
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const s32 = (b, o) => u32(b, o) | 0;
const ok = (b, n) => !!b && b.length >= n;

export const TILE = 16;
const FRAME_MS = 1000 / 59.7275;
/** Directions as the games number them (Gen 3 DIR_*): 1 south, 2 north, 3 west, 4 east. */
export const DIR = { S: 1, N: 2, W: 3, E: 4 };
const STEP = { 1: [0, 1], 2: [0, -1], 3: [-1, 0], 4: [1, 0] };

/** Avatar kinds (what the player rides or does). Index = the number on the wire. */
export const KINDS = ['walk', 'mach', 'acro', 'bike', 'surf', 'dive', 'fieldmove', 'fish', 'water', 'vsseeker'];
/**
 * Families whose maps share ids: a partner is only drawn in a game of the same family (Ruby ↔ Sapphire, FR ↔ LG; Red,
 * Blue and Yellow; Gold, Silver and Crystal – Gold/Silver maps go out with Crystal's numbers, shared/worldgb.mjs; Diamond,
 * Pearl and Platinum; HeartGold and SoulSilver – shared/worldds.mjs).
 */
export const FAMILIES = { rs: 1, e: 2, frlg: 3, rby: 11, gsc: 13, dppt: 21, hgss: 22 };

// GBA key bits (KEYINPUT / gMain.heldKeys)
export const GBA_KEY = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512 };

/**
 * The Shared World table of a running game, or null where souldew doesn't know its memory (another language, a hack
 * with a moved layout): no overlay then, the board keeps saying where the partner is.
 * `entry`: the addresses.json game (findEntry); `rev`: the ROM's software version (header 0xBC); `code`: its game code
 * (header 0xAC) – one entry can cover several languages that share the RAM but not the ROM (FireRed DE/FR/IT/ES): the
 * ROM addresses are then kept per code and revision ("BPRD:0"), and a language without its own is learned/searched.
 */
export function worldTable(entry, rev = 0, code = '') {
  const w = entry?.world;
  if (w && (entry.gen === 1 || entry.gen === 2)) return gbWorldTable(entry);
  if (!w || entry.gen !== 3) return null;
  const rom = (code && w.rom?.[`${code}:${rev}`]) || w.rom?.[String(rev)] || null;
  const inBattle = entry.inBattle ? { addr: hex(entry.inBattle.addr), mask: hex(entry.inBattle.mask || '0xff') } : null;
  return {
    gen: 3,
    id: entry.id,
    family: w.family,
    fam: FAMILIES[w.family] || 0,
    objectEvents: hex(w.objectEvents),
    playerAvatar: hex(w.playerAvatar),
    fieldCamera: hex(w.fieldCamera),
    saveBlock1Ptr: w.saveBlock1Ptr ? hex(w.saveBlock1Ptr) : 0,
    saveBlock1: w.saveBlock1 ? hex(w.saveBlock1) : 0,
    main: hex(w.main),
    paletteFade: hex(w.paletteFade),
    lock: hex(w.lockFieldControls),
    sprites: w.sprites ? hex(w.sprites) : 0,
    inBattle,
    // the map's top layer (occlusion, shared/worldmap.mjs) and the map-name popup – 0 / null where unknown: off then
    mapHeader: w.mapHeader ? hex(w.mapHeader) : 0,
    backupMap: w.backupMapLayout ? hex(w.backupMapLayout) : 0,
    tasks: w.tasks ? hex(w.tasks) : 0,
    help: w.inHelpSystem ? hex(w.inHelpSystem) : 0,
    // FR/LG's "Previously on your quest…" replays your last steps with the overworld callback, unlocked: gQuestLogState
    // 2/3 (QL_STATE_PLAYBACK*) – 1 is the recording that runs all the time
    questLog: w.questLogState ? hex(w.questLogState) : 0,
    popup: w.mapNamePopup && w.tasks && rom?.mapNamePopupTask
      ? { task: (hex(rom.mapNamePopupTask) | 1) >>> 0, rect: w.mapNamePopup.rect, data: w.mapNamePopup.offsetData ?? null, base: w.mapNamePopup.offsetBase ?? 0 }
      : null,
    // ROM addresses of this revision (unknown revisions: the overworld callback is learned, the tables are searched)
    overworldCb2: rom?.overworldCb2 ? (hex(rom.overworldCb2) | 1) >>> 0 : 0,
    graphicsInfo: rom?.graphicsInfo ? hex(rom.graphicsInfo) : 0,
    spritePalettes: rom?.spritePalettes ? hex(rom.spritePalettes) : 0,
    avatars: (w.avatars || []).map(([kind, male, female]) => ({ kind, gfx: [male, female] })),
    // where the player's tile is on the 240×160 picture (its top-left corner): the camera keeps the player there
    anchor: { x: 112, y: 72 },
    screen: { w: 240, h: 160 },
  };
}

/** SaveBlock1's address (Emerald and FR/LG move it around: gSaveBlock1Ptr; Ruby/Sapphire: fixed). */
function saveBlock1(t, read) {
  if (t.saveBlock1) return t.saveBlock1;
  const p = read(t.saveBlock1Ptr, 4);
  if (!ok(p, 4)) return 0;
  const a = u32(p, 0);
  return a >= 0x02000000 && a < 0x02040000 ? a : 0;
}

/**
 * The byte ranges the overlay needs with every picture (the native player's WATCH, web/lib/nativeplayer.mjs): the
 * camera's sub-tile offset, SaveBlock1's pos and map, the keys, the screen state. `sb1`: SaveBlock1's address now
 * (it moves – the overlay asks again when it does).
 */
export function watchRanges(t, sb1, spriteId = null) {
  if (!t) return [];
  if (t.gen <= 2) return gbWatchRanges(t);
  const r = [
    [t.fieldCamera + 0x10, 8], // CameraObject x, y (s32)
    [t.main + 4, 4], // gMain.callback2
    [t.main + 0x2c, 2], // gMain.heldKeys
    [t.paletteFade + 4, 4], // PaletteFadeControl: y, blendColor, active
    [t.lock, 1], // sLockFieldControls
  ];
  if (t.saveBlock1Ptr) r.push([t.saveBlock1Ptr, 4]);
  if (sb1) r.push([sb1, 8]); // pos (x, y), location (mapGroup, mapNum)
  if (t.inBattle) r.push([t.inBattle.addr, 1]);
  if (t.questLog) r.push([t.questLog, 1]);
  r.push([t.playerAvatar + 4, 2]); // the player's sprite and object event ids
  if (t.sprites && Number.isInteger(spriteId) && spriteId < 64) r.push([t.sprites + spriteId * 0x44, 0x44]);
  return r;
}

/**
 * The local player's sprite as the game draws it this frame (gSprites[spriteId]: its OAM position, the frame image
 * and the flip) – so a partner walking behind the player can be drawn behind them: { x, y, w, h, images, anims,
 * animNum, cmd, flip } or null. `cam` gives nothing here; the sprite id comes from gPlayerAvatar.
 */
export function readLocalSprite(t, read) {
  if (t?.gen <= 2) return gbLocalSprite(t, read);
  if (!t?.sprites) return null;
  const av = read(t.playerAvatar + 4, 2);
  if (!ok(av, 2) || av[0] >= 64) return null;
  const s = read(t.sprites + av[0] * 0x44, 0x44);
  if (!ok(s, 0x44) || !(s[0x3e] & 1) || s[0x3e] & 4) return null; // inUse, invisible
  const attr0 = u16(s, 0);
  const attr1 = u16(s, 2);
  if ((attr0 >> 8) & 3) return null; // affine / hidden OAM: not the plain player sprite
  const shape = attr0 >> 14;
  const size = attr1 >> 14;
  const dims = [[[8, 8], [16, 16], [32, 32], [64, 64]], [[16, 8], [32, 8], [32, 16], [64, 32]], [[8, 16], [8, 32], [16, 32], [32, 64]]][shape]?.[size];
  if (!dims) return null;
  let x = attr1 & 0x1ff;
  if (x >= 240 + 64) x -= 512;
  let y = attr0 & 0xff;
  if (y >= 160 + 64) y -= 256;
  return { spriteId: av[0], x, y, w: dims[0], h: dims[1], anims: u32(s, 8), images: u32(s, 12), animNum: s[0x2a], cmd: s[0x2b], flip: !!(attr1 & 0x1000) };
}

/** A read function over WATCHED bytes (`ranges` as watchRanges gave them, `bytes` one after the other). */
export function rangeReader(ranges, bytes) {
  const at = [];
  let o = 0;
  for (const [addr, len] of ranges) {
    at.push([addr, len, o]);
    o += len;
  }
  return (addr, len) => {
    for (const [a, l, off] of at) if (addr >= a && addr + len <= a + l && off + (addr - a) + len <= bytes.length) return bytes.subarray(off + (addr - a), off + (addr - a) + len);
    return null;
  };
}

/** The first reader that has the bytes. */
export const chainReaders = (...readers) => (addr, len) => {
  for (const r of readers) {
    const b = r && r(addr, len);
    if (b) return b;
  }
  return null;
};

/**
 * The camera, per picture: { sb1, map, tx, ty (the camera's tile), cx, cy (its world pixels), keys, cb2, locked, fade
 * (0 = clear … 16 = black/white), battle } – or null when SaveBlock1 isn't there yet (title screen, intro).
 */
export function readCamera(t, read, prior = null) {
  if (t?.gen <= 2) return gbReadCamera(t, read, prior);
  const sb1 = saveBlock1(t, read);
  if (!sb1) return null;
  const pos = read(sb1, 8);
  const cam = read(t.fieldCamera + 0x10, 8);
  if (!ok(pos, 8) || !ok(cam, 8)) return null;
  const tx = s16(pos, 0);
  const ty = s16(pos, 2);
  // CameraObject x/y: how far the camera has come from the last tile toward the current one (−15…15); CameraMove()
  // already counted the whole tile in pos when the step began
  const ox = s32(cam, 0);
  const oy = s32(cam, 4);
  if (Math.abs(ox) > 15 || Math.abs(oy) > 15 || Math.abs(tx) > 0x400 || Math.abs(ty) > 0x400) return null;
  const main = read(t.main + 4, 4);
  const keys = read(t.main + 0x2c, 2);
  const fade = read(t.paletteFade + 4, 4);
  const lock = read(t.lock, 1);
  const battle = t.inBattle ? read(t.inBattle.addr, 1) : null;
  const help = t.help ? read(t.help, 1) : null;
  const ql = t.questLog ? read(t.questLog, 1) : null;
  const fadeActive = ok(fade, 4) && !!(fade[3] & 0x80);
  return {
    sb1,
    map: pos[4] * 256 + pos[5],
    tx,
    ty,
    cx: tx * TILE + ox - Math.sign(ox) * TILE,
    cy: ty * TILE + oy - Math.sign(oy) * TILE,
    keys: ok(keys, 2) ? u16(keys, 0) : 0,
    cb2: ok(main, 4) ? u32(main, 0) : 0,
    locked: ok(lock, 1) && lock[0] !== 0,
    fade: fadeActive ? (u16(fade, 0) >> 6) & 0x1f : 0,
    battle: !!(battle && battle[0] & t.inBattle.mask),
    // FR/LG's help screen (L/R) runs over the overworld without locking it or changing the callback
    help: !!(help && help[0]),
    replay: !!(ql && (ql[0] === 2 || ql[0] === 3)),
  };
}

/**
 * The local player for the partners (read from the RAM mirror, 10–15 times a second): where, which way, riding what.
 * { map, x, y (world px), tx, ty, facing, kind, gender, run } or null. `cam`: readCamera's result of the same moment.
 */
export function readPlayer(t, read, cam = readCamera(t, read)) {
  if (!cam) return null;
  if (t.gen <= 2) return gbReadPlayer(t, read, cam);
  const av = read(t.playerAvatar, 8);
  if (!ok(av, 8)) return null;
  const id = av[5];
  if (id >= 16) return null;
  const o = read(t.objectEvents + id * 0x24, 0x24);
  if (!ok(o, 0x24) || !(o[0] & 1) || !(o[2] & 1)) return null; // active, isPlayer
  const ctx = s16(o, 0x10) - 7;
  const cty = s16(o, 0x12) - 7;
  // the camera follows the player (trackedByCamera): its pixels are the player's; else (a cutscene moved the camera)
  // the player's own tile
  const follows = (o[1] & 0x80) && ctx === cam.tx && cty === cam.ty;
  const gfx = o[5];
  let kind = 'walk';
  let gender = av[7] & 1;
  for (const a of t.avatars) {
    const g = a.gfx.indexOf(gfx);
    if (g >= 0) {
      kind = a.kind;
      gender = g;
      break;
    }
  }
  return {
    map: cam.map,
    x: follows ? cam.cx : ctx * TILE,
    y: follows ? cam.cy : cty * TILE,
    tx: ctx,
    ty: cty,
    facing: o[0x18] & 0x0f || DIR.S,
    kind,
    gender,
    run: kind === 'walk' && !!(av[0] & 0x80),
    // previousElevation: what the game sets the sprite's priority from – on a bridge nothing on the map covers it
    elev: o[0x0b] >> 4,
  };
}

/**
 * The map as the game holds it now (gMapHeader.mapLayout: the layout in the ROM, for the tilesets; gBackupMapLayout:
 * its blocks in RAM with 7 tiles of the connected maps around them – doors that opened, trees that were cut, the
 * generated floors of the Battle Pyramid are in there): { layout, w, h, map } or null.
 */
export function readMapView(t, read) {
  if (!t?.mapHeader || !t.backupMap) return null;
  const h = read(t.mapHeader, 4);
  const b = read(t.backupMap, 12);
  if (!ok(h, 4) || !ok(b, 12)) return null;
  const layout = u32(h, 0);
  const w = s32(b, 0);
  const hh = s32(b, 4);
  const map = u32(b, 8);
  if (layout < 0x08000000 || layout >= 0x0a000000 || w <= 15 || hh <= 14 || w * hh > 0x2800 || map < 0x02000000 || map + w * hh * 2 > 0x02040000) return null;
  return { layout, w, h: hh, map };
}

/** A reader of the metatile ids of a map view (map coordinates; −1 outside what the game holds). */
export function blockReader(view, read) {
  return (mx, my) => {
    const x = mx + 7;
    const y = my + 7;
    if (!view || x < 0 || y < 0 || x >= view.w || y >= view.h) return -1;
    const b = read(view.map + (y * view.w + x) * 2, 2);
    return ok(b, 2) ? u16(b, 0) & 0x3ff : -1;
  };
}

/**
 * The map-name popup (it slides in at the top left when you enter a town or a route, without holding the player): its
 * rectangle on the picture { x, y, w, h, shown, grows } while the game's popup task runs, else null. The slide offset comes
 * from the task's data (Emerald tYOffset, Ruby data[2], FR/LG tPos; `shown`: the rows on screen by it). The tasks come
 * from the RAM mirror, a few frames late: while the popup grows (`prev`: the last result) 12 rows more are cut away.
 */
export function popupRect(t, read, prev = null) {
  if (t?.gen <= 2) return gbPopupRect(t, read);
  const p = t?.popup;
  if (!p) return null;
  const b = read(t.tasks, 16 * 0x28);
  if (!ok(b, 16 * 0x28)) return null;
  for (let i = 0; i < 16; i++) {
    const o = i * 0x28;
    if (!b[o + 4] || u32(b, o) !== p.task) continue;
    const [x, y, w, h] = p.rect;
    const shown = p.data === null ? h : Math.min(h, Math.abs(p.base - s16(b, o + 8 + p.data * 2)));
    // (the same reading comes back for several pictures in a row: the direction it went last holds until it changes)
    const grows = !prev || (shown === prev.shown ? prev.grows !== false : shown > prev.shown);
    const cut = Math.min(h, shown + (grows ? 12 : 0));
    return cut > 0 ? { x, y, w, h: cut, shown, grows } : null;
  }
  return null;
}

/**
 * Can partners be drawn over the picture right now? The overworld (the game's own overworld callback, or the one
 * learned while the player walked: `learned`), no battle, no menu or script holding the player, no full fade.
 */
export function drawable(t, cam, learned = 0) {
  if (t?.gen <= 2) return gbDrawable(t, cam);
  if (!t || !cam || cam.battle || cam.locked || cam.help || cam.replay || cam.fade >= 16) return false;
  const cb2 = t.overworldCb2 || learned;
  return cb2 ? cam.cb2 === cb2 : true;
}

/**
 * Pressing A toward a partner (the Shared World A menu). A press counts from the moment the button goes down – not
 * from a picture that happens to show it held: a short tap between two drawn pictures (a busy or slow computer draws
 * fewer of them) is still a press.
 *
 * `input(down, now)`: the player's own buttons as the fast player sends them to the game – from the first call on only
 * these count, and true means a press began. `sample(down, now)`: the game's held keys as read with a picture (the
 * browser player – nothing else tells it). `swallow()`: the A that chose in a menu doesn't open it again. `due(now, ms)`:
 * the press is `ms` old – true once.
 */
export class APress {
  constructor() {
    this.held = false;
    this.at = 0;
    this.direct = false; // the buttons come through input()
    this.inputDown = false;
  }

  input(down, now) {
    this.direct = true;
    this.inputDown = !!down;
    if (down && !this.held) {
      this.held = true;
      this.at = now || 1;
      return true;
    }
    if (!down) this.held = false;
    return false;
  }

  sample(down, now) {
    // (the fast player: the buttons themselves say it – a swallowed A is over once it isn't held any more)
    if (this.direct) {
      if (!this.inputDown) this.held = false;
      return false;
    }
    const edge = !!down && !this.held;
    this.held = !!down;
    if (edge) this.at = now || 1;
    return edge;
  }

  swallow() {
    this.held = true;
    this.at = 0;
  }

  cancel() {
    this.at = 0;
  }

  get pending() {
    return !!this.at;
  }

  due(now, ms) {
    if (!this.at || now - this.at < ms) return false;
    this.at = 0;
    return true;
  }
}

/**
 * Starts something once: every call gets the promise of the first – also calls made while it still runs. The Shared
 * World overlay is configured again whenever the play view's players, rules or lead change; a second start while the
 * first still loaded its ROM made a second overlay, and the two took turns at the native player's one WATCH list – the
 * one left without bytes kept its first reading and said "not on the field" (a DS partner flickering away).
 */
export function startOnce(fn) {
  let p = null;
  return (...args) => (p ||= Promise.resolve().then(() => fn(...args)));
}

/**
 * Learns the overworld callback of a game whose revision souldew has no address for: the callback that runs while the
 * camera steps one tile on the same map without a fade is the overworld's (a map change or warp never counts).
 */
export class OverworldLearner {
  constructor() {
    this.prev = null;
    this.votes = new Map();
    this.cb2 = 0;
  }
  feed(cam) {
    const p = this.prev;
    this.prev = cam;
    if (this.cb2 || !p || !cam || cam.fade || p.fade || cam.battle || cam.map !== p.map || cam.cb2 !== p.cb2) return this.cb2;
    if (Math.abs(cam.tx - p.tx) + Math.abs(cam.ty - p.ty) !== 1 || (cam.cb2 & 0xff000001) !== 0x08000001) return this.cb2;
    const n = (this.votes.get(cam.cb2) || 0) + 1;
    this.votes.set(cam.cb2, n);
    if (n >= 3) this.cb2 = cam.cb2;
    return this.cb2;
  }
}

// ---- the message -------------------------------------------------------------------------------------------------
/**
 * A player's state on the wire (~40 bytes of JSON): [v, seq, t, fam, map, x, y, flags, ext?]. flags: facing (bits 0–2),
 * kind (3–6), gender (7), run (8), hidden (9: not on the overworld – nothing to draw), elevation (10–13: 0 from older
 * versions, which counts as the ground). `t`: the sender's clock (ms).
 * `ext` (optional, 3.0 builds before the followers stop reading at index 7 and never see it): what changes seldom –
 * sent when it changed and with the heartbeat (packExt), so ~0 bytes while walking:
 *   f: [species (National Dex), flags (bit 0 shiny, bits 1–5 the form: Unown's letter)] – the Pokémon following them,
 *      0 = none (no lead that can walk, or an egg-only team);
 *   z: [w, h] – the size of their map in tiles (a partner on a connected map north or west of yours is placed by it).
 * `h` (optional, the DS: Gen 4 has heights – stairs, slopes, bridges): the 10th element, world units; a 0 stands in
 * for a missing ext before it. Builds without the DS overlay never read past the ext.
 */
export const WIRE_V = 1;
export function packState(st, seq, t, ext = null) {
  const base = !st || st.hidden
    ? [WIRE_V, seq >>> 0, Math.round(t), st?.fam || 0, 0, 0, 0, 1 << 9]
    : [WIRE_V, seq >>> 0, Math.round(t), st.fam | 0, st.map | 0, Math.round(st.x), Math.round(st.y),
      (st.facing & 7) | (Math.max(0, KINDS.indexOf(st.kind)) << 3) | ((st.gender & 1) << 7) | (st.run ? 1 << 8 : 0) | ((st.elev & 15) << 10)];
  if (ext && (ext.f !== undefined || ext.z)) base.push(ext);
  // the DS field's height (world units: stairs, slopes, bridges) as a 10th element – after the ext or a 0 in its place
  if (st && !st.hidden && Number.isFinite(st.h)) {
    if (base.length === 8) base.push(0);
    base.push(Math.round(st.h));
  }
  return base;
}

/** The ext object for packState from a follower { species, shiny, form } (or null: none) and a map size [w, h]. */
export function packExt({ follower, size } = {}) {
  const ext = {};
  if (follower !== undefined) ext.f = follower && follower.species > 0 ? [follower.species | 0, (follower.shiny ? 1 : 0) | ((follower.form & 31) << 1)] : 0;
  if (size && size[0] > 0 && size[1] > 0) ext.z = [size[0] | 0, size[1] | 0];
  return ext;
}

const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
/** The ext of a wire message: { follower?: { species, shiny, form } | null, size?: [w, h] } – malformed parts left out. */
export function unpackExt(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  const out = {};
  if (e.f === 0 || e.f === null) out.follower = null;
  else if (Array.isArray(e.f) && int(e.f[0], 1, 2047) && int(e.f[1], 0, 63)) out.follower = { species: e.f[0], shiny: !!(e.f[1] & 1), form: e.f[1] >> 1 };
  if (Array.isArray(e.z) && int(e.z[0], 1, 1024) && int(e.z[1], 1, 1024)) out.size = [e.z[0], e.z[1]];
  return Object.keys(out).length ? out : null;
}

/** The other way – null for anything malformed (it comes from the network). */
export function unpackState(a) {
  if (!Array.isArray(a) || a.length < 8 || a[0] !== WIRE_V || !a.slice(1, 8).every(Number.isFinite)) return null;
  const [, seq, t, fam, map, x, y, flags] = a;
  if (Math.abs(x) > 0x8000 || Math.abs(y) > 0x8000 || map < 0 || map > 0xffff) return null;
  const ext = a.length > 8 ? unpackExt(a[8]) : null;
  if (flags & (1 << 9)) return { seq, t, fam, hidden: true, ...(ext ? { ext } : {}) };
  const facing = flags & 7;
  const h = a.length > 9 && Number.isFinite(a[9]) && Math.abs(a[9]) <= 0x8000 ? a[9] : undefined;
  return { seq, t, fam, map, x, y, facing: facing >= 1 && facing <= 4 ? facing : DIR.S, kind: KINDS[(flags >> 3) & 15] || 'walk', gender: (flags >> 7) & 1, run: !!(flags & (1 << 8)), elev: (flags >> 10) & 15, hidden: false, ...(h !== undefined ? { h } : {}), ...(ext ? { ext } : {}) };
}

/** How often the sender sends: while something changes up to 15 a second, else a heartbeat once a second. */
export const SEND = { minMs: 66, idleMs: 1000, relayMs: 2000 };
/** Is `st` different enough from the last sent one to send now? */
export function changed(a, b) {
  if (!a || !b) return a !== b;
  return a.hidden !== b.hidden || a.map !== b.map || a.x !== b.x || a.y !== b.y || a.facing !== b.facing || a.kind !== b.kind || a.run !== b.run || a.gender !== b.gender || (a.elev | 0) !== (b.elev | 0) || (a.h ?? null) !== (b.h ?? null);
}

// ---- interpolation -------------------------------------------------------------------------------------------------
/**
 * One partner's track: the states as they arrive, sampled at any moment. The render time trails the newest state by a
 * little more than the usual gap between messages, so there is (almost) always a state on both sides to interpolate
 * between; past the newest one it extrapolates for a short while, then holds. A map change or a jump of more than
 * a few tiles (a warp, Fly) snaps instead of sliding.
 */
export class Track {
  constructor({ maxExtrapolate = 150, snapPx = 3 * TILE } = {}) {
    this.buf = [];
    this.offset = null; // our clock minus theirs (smallest seen = least delayed message)
    this.gaps = [];
    this.lastSeq = -1;
    this.maxExtrapolate = maxExtrapolate;
    this.snapPx = snapPx;
    this.seenAt = 0;
  }

  /** A state from the network, `now` on our clock. Old or repeated ones (out of order) are dropped. */
  push(st, now) {
    if (!st || st.seq <= this.lastSeq) return false;
    this.lastSeq = st.seq;
    this.seenAt = now;
    const off = now - st.t;
    // the offset follows a clock that drifts or a path that got slower – slowly, so jitter doesn't shake it
    this.offset = this.offset === null || off < this.offset ? off : this.offset + Math.min(2, (off - this.offset) * 0.01);
    const last = this.buf[this.buf.length - 1];
    if (last) {
      const gap = st.t - last.t;
      if (gap > 0 && gap < 3000) {
        this.gaps.push(gap);
        if (this.gaps.length > 20) this.gaps.shift();
      }
    }
    this.buf.push(st);
    if (this.buf.length > 64) this.buf.shift();
    return true;
  }

  /** How far behind the newest state the picture runs (ms): 1.5 typical gaps, 60–600 ms. */
  get delay() {
    if (!this.gaps.length) return 120;
    const g = [...this.gaps].sort((a, b) => a - b)[Math.floor(this.gaps.length * 0.75)];
    return Math.min(600, Math.max(60, g * 1.5 + 16));
  }

  /**
   * The state at `now` (our clock): { map, x, y, facing, kind, gender, run, fam, moving, hidden } or null.
   * `conv(state)` (optional): the state's position in the local player's frame – { x, y } or null (another map that
   * isn't connected to yours). With it, x/y come back in that frame (`local: true`, or `away: true` when it has none)
   * and the partner slides across a map connection instead of stopping at the edge.
   */
  sample(now, conv = null) {
    const b = this.buf;
    if (!b.length || this.offset === null) return null;
    const at = (st) => {
      if (!conv) return st;
      const p = st.hidden ? null : conv(st);
      return p ? { ...st, x: p.x, y: p.y, local: true } : { ...st, away: true };
    };
    const same = (p, q) => p.fam === q.fam && (conv ? !!p.local && !!q.local : p.map === q.map);
    const rt = now - this.offset - this.delay; // render time on the sender's clock
    let i = b.length - 1;
    while (i > 0 && b[i].t > rt) i--;
    const a = at(b[i]);
    const n = b[i + 1] ? at(b[i + 1]) : null;
    if (a.t > rt) return { ...a, moving: false }; // older than anything we have: the oldest
    if (a.hidden) return { ...a, moving: false };
    if (n && !n.hidden && same(a, n) && n.t > a.t) {
      const d = Math.abs(n.x - a.x) + Math.abs(n.y - a.y);
      if (d > this.snapPx) return { ...a, moving: false };
      const k = (rt - a.t) / (n.t - a.t);
      // (speed in pixels per game frame: 1 walking, 2 running or cycling, more on the Mach Bike)
      const h = Number.isFinite(a.h) && Number.isFinite(n.h) ? { h: a.h + (n.h - a.h) * k } : {};
      return { ...a, ...h, x: a.x + (n.x - a.x) * k, y: a.y + (n.y - a.y) * k, facing: d > 0 ? n.facing : k < 0.5 ? a.facing : n.facing, moving: d > 0, speed: d / Math.max(1, (n.t - a.t) / FRAME_MS) };
    }
    if (n) return { ...a, moving: false }; // the next one is on another map / hidden: hold until it's due
    // past the newest: keep going the way it went, for a moment (a held direction keeps walking in the game too)
    const p = b[i - 1] ? at(b[i - 1]) : null;
    if (p && !p.hidden && same(p, a) && a.t > p.t && rt - a.t < this.maxExtrapolate) {
      const vx = (a.x - p.x) / (a.t - p.t);
      const vy = (a.y - p.y) / (a.t - p.t);
      if (Math.abs(vx) + Math.abs(vy) > 0 && Math.abs(a.x - p.x) + Math.abs(a.y - p.y) <= this.snapPx) {
        const dt = rt - a.t;
        // never past the tile it was heading for: a stop must not overshoot and snap back
        const tx = vx > 0 ? Math.ceil(a.x / TILE) * TILE : vx < 0 ? Math.floor(a.x / TILE) * TILE : a.x;
        const ty = vy > 0 ? Math.ceil(a.y / TILE) * TILE : vy < 0 ? Math.floor(a.y / TILE) * TILE : a.y;
        const clamp = (v, lim, dir) => (dir > 0 ? Math.min(v, lim) : dir < 0 ? Math.max(v, lim) : v);
        const x = clamp(a.x + vx * dt, tx, vx);
        const y = clamp(a.y + vy * dt, ty, vy);
        return { ...a, x, y, moving: x !== a.x || y !== a.y, speed: (Math.abs(vx) + Math.abs(vy)) * FRAME_MS };
      }
    }
    return { ...a, moving: false };
  }
}

// ---- what is drawn where -------------------------------------------------------------------------------------------
/**
 * Where a partner appears on the picture: their world pixels relative to the camera, from the local player's spot.
 * Returns { x, y } of the partner's tile (top-left, picture pixels) or null when they are not on the same map of the
 * same game family (or a connected one: a state Track.sample put into the local frame, `local`), or off the picture
 * (with a margin for the sprite and the name).
 */
export function screenPos(t, cam, p) {
  if (!t || !cam || !p || p.hidden || p.away || p.fam !== t.fam || (!p.local && p.map !== cam.map)) return null;
  const x = t.anchor.x + (p.x - cam.cx);
  const y = t.anchor.y + (p.y - cam.cy);
  if (x < -48 || y < -48 || x > t.screen.w + 32 || y > t.screen.h + 48) return null;
  return { x, y };
}

/** The tile in front of a player (facing 1–4). */
export const frontTile = (tx, ty, facing) => [tx + (STEP[facing]?.[0] || 0), ty + (STEP[facing]?.[1] || 0)];

/**
 * The partner the local player faces – standing on the tile in front of them, on the same map – or null.
 * `partners`: [{ slot, state }] with the interpolated states.
 */
export function facedPartner(t, local, partners) {
  if (!local) return null;
  const [fx, fy] = frontTile(local.tx, local.ty, local.facing);
  for (const { slot, state } of partners) {
    if (!state || state.hidden || state.away || state.fam !== t.fam || (!state.local && state.map !== local.map)) continue;
    if (Math.round(state.x / TILE) === fx && Math.round(state.y / TILE) === fy) return slot;
  }
  return null;
}

/** The kind a game draws for a partner's kind it doesn't have (FR/LG has one bike, Emerald two; nobody dives in Kanto). */
export function kindFor(t, kind) {
  const have = new Set(t.avatars.map((a) => a.kind));
  if (have.has(kind)) return kind;
  const alt = { mach: ['bike', 'acro'], acro: ['bike', 'mach'], bike: ['mach', 'acro'], dive: ['surf'], water: ['walk'], vsseeker: ['walk'] }[kind] || [];
  return alt.find((k) => have.has(k)) || 'walk';
}

/** The game's graphics id for a partner (kind + gender) – what the sprite sheet is extracted for. */
export function gfxFor(t, kind, gender) {
  const k = kindFor(t, kind);
  const a = t.avatars.find((x) => x.kind === k) || t.avatars[0];
  return a ? a.gfx[gender ? 1 : 0] : 0;
}

// Object event animations (Gen 3 ANIM_STD_*): face 0–3, go 4–7, go fast 8–11, go faster 12–15, go fastest 16–19;
// the player's run 20–23. Order within each group: south, north, west, east.
const DIR_INDEX = { 1: 0, 2: 1, 3: 2, 4: 3 };
/** Which animation a partner shows: standing (face), walking, running or riding fast – from the speed (px/frame). */
export function animFor(st, speed) {
  const d = DIR_INDEX[st.facing] ?? 0;
  if (!st.moving) return d;
  if (st.run && st.kind === 'walk') return 20 + d;
  if (speed > 3.5) return 16 + d;
  if (speed > 2.5) return 12 + d;
  if (speed > 1.5) return 8 + d;
  return 4 + d;
}

// ---- connected maps ------------------------------------------------------------------------------------------------
/** Map connection directions (Gen 3 CONNECTION_*); dive/emerge (5, 6) lead to another layer, never side by side. */
export const CONN = { S: 1, N: 2, W: 3, E: 4 };

/**
 * The local map's size and its connections, from gMapHeader (RAM: its layout and connections pointers) and the ROM:
 * { map, w, h, list: [{ dir, offset, map }] } or null. Cached per connections pointer (`cache`: a Map).
 */
export function readConnections(t, read, rom, map, cache = null) {
  if (t?.gen <= 2) return gbReadConnections(t, read, map);
  if (!t?.mapHeader || !rom) return null;
  const h = read(t.mapHeader, 0x10);
  if (!ok(h, 0x10)) return null;
  const layout = u32(h, 0);
  const conns = u32(h, 0x0c);
  const key = `${map}:${layout}:${conns}`;
  if (cache?.has(key)) return cache.get(key);
  const R = (p, n) => (p >= 0x08000000 && p - 0x08000000 + n <= rom.length ? p - 0x08000000 : -1);
  let out = null;
  const lo = R(layout, 8);
  if (lo >= 0) {
    const w = s32(rom, lo);
    const hh = s32(rom, lo + 4);
    if (w > 0 && hh > 0 && w <= 0x400 && hh <= 0x400) {
      const list = [];
      const co = conns ? R(conns, 8) : -1;
      const count = co >= 0 ? s32(rom, co) : 0;
      const at = co >= 0 ? R(u32(rom, co + 4), 12 * Math.max(1, count)) : -1;
      if (count > 0 && count <= 8 && at >= 0) {
        for (let i = 0; i < count; i++) {
          const c = at + i * 12;
          const dir = rom[c];
          if (dir >= CONN.S && dir <= CONN.E) list.push({ dir, offset: s32(rom, c + 4), map: rom[c + 8] * 256 + rom[c + 9] });
        }
      }
      out = { map, w, h: hh, list };
    }
  }
  if (cache) {
    if (cache.size > 64) cache.clear();
    cache.set(key, out);
  }
  return out;
}

/**
 * A partner's position in the local map's frame (world pixels): on the same map as it is, on a map connected to it
 * shifted by the connection (pokeemerald fieldmap.c Fill*Connection: south at your height, east at your width, north
 * and west at minus *their* size – `size` [w, h], which the partner sends) – or null.
 */
export function inLocalFrame(conns, st, size = null) {
  if (!conns || !st || st.hidden) return null;
  if (st.map === conns.map) return { x: st.x, y: st.y };
  const c = conns.list.find((x) => x.map === st.map);
  if (!c) return null;
  // (the Game Boy games: the offsets from your own RAM – shared/worldgb.mjs gbReadConnections)
  if (c.ox !== undefined) return { x: st.x + c.ox, y: st.y + c.oy };
  const o = c.offset * TILE;
  if (c.dir === CONN.S) return { x: st.x + o, y: st.y + conns.h * TILE };
  if (c.dir === CONN.E) return { x: st.x + conns.w * TILE, y: st.y + o };
  if (!size) return null;
  if (c.dir === CONN.N) return { x: st.x + o, y: st.y - size[1] * TILE };
  return { x: st.x - size[0] * TILE, y: st.y + o };
}

// ---- the Pokémon following a player ---------------------------------------------------------------------------------
/**
 * The follower of one player: it walks the player's path one tile (`gap` px) behind – the trail of where the player
 * has been, not a straight line, so it goes round corners and through doors after them. Fed with the player's
 * position every picture (a partner's interpolated one, or your own); a warp, Fly or another map puts it back onto
 * the player (it steps out of the door after them), the first sight of a player one tile behind their back.
 * Nothing in the game knows about it: it overlaps people and walls like the partners do.
 */
export class Follower {
  constructor({ gap = TILE, snapPx = 3 * TILE } = {}) {
    this.gap = gap;
    this.snapPx = snapPx;
    this.trail = [];
    this.key = null;
    this.pos = null;
    this.dist = 0;
    this.flip = false;
  }

  _reset(x, y, behind) {
    const [dx, dy] = STEP[behind] || [0, 0];
    this.trail = behind ? [{ x: x - dx * this.gap, y: y - dy * this.gap }, { x, y }] : [{ x, y }];
    if (behind === DIR.E) this.flip = true;
    else if (behind === DIR.W) this.flip = false;
    this.pos = null;
  }

  /**
   * The leader at world pixels (x, y) in frame `key` (the map – or the local map for partners shown across a
   * connection), facing 1–4. Returns { x, y (the follower's tile, world px), moving, flip (faces right), frame (0/1),
   * hidden (still on the leader after a warp) }.
   */
  update(key, x, y, facing = DIR.S) {
    const last = this.trail[this.trail.length - 1];
    if (!last) this._reset(x, y, facing);
    else if (key !== this.key || Math.abs(x - last.x) + Math.abs(y - last.y) > this.snapPx) this._reset(x, y, 0);
    else if (x !== last.x || y !== last.y) this.trail.push({ x, y });
    this.key = key;
    // keep just enough path behind the leader
    const len = (from) => {
      let n = 0;
      for (let i = from + 1; i < this.trail.length; i++) n += Math.abs(this.trail[i].x - this.trail[i - 1].x) + Math.abs(this.trail[i].y - this.trail[i - 1].y);
      return n;
    };
    while (this.trail.length > 2 && len(1) >= this.gap) this.trail.shift();
    // one gap back along the path from the leader (or the start of a shorter path)
    let left = this.gap;
    let px = this.trail[0].x;
    let py = this.trail[0].y;
    for (let i = this.trail.length - 1; i > 0; i--) {
      const b = this.trail[i];
      const a = this.trail[i - 1];
      const d = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      if (d >= left) {
        const k = d ? left / d : 0;
        px = b.x + (a.x - b.x) * k;
        py = b.y + (a.y - b.y) * k;
        left = 0;
        break;
      }
      left -= d;
    }
    const prev = this.pos;
    const dx = prev ? px - prev.x : 0;
    const dy = prev ? py - prev.y : 0;
    const moved = Math.abs(dx) + Math.abs(dy);
    this.dist += moved;
    if (dx > 0.01) this.flip = true;
    else if (dx < -0.01) this.flip = false;
    this.pos = { x: px, y: py };
    return { x: px, y: py, moving: moved > 0.01, flip: this.flip, frame: Math.floor(this.dist / 8) & 1, hidden: Math.abs(px - x) + Math.abs(py - y) < 6 };
  }
}

/** Kinds a follower doesn't walk along with: on the water, under it (it would stand on the sea). */
export const followerHidden = (st) => !st || st.hidden || st.kind === 'surf' || st.kind === 'dive' || st.kind === 'water';

// ---- emotes -----------------------------------------------------------------------------------------------------------
/** The emote bubbles (pixel art in web/lib/worldoverlay.mjs), the names on the wire. 'wave' goes as { t: 'wave' }. */
export const EMOTES = ['wave', 'heart', 'excl', 'quest', 'gg'];

/**
 * A token bucket: `burst` at once, then one every `everyMs`. Emotes use it on both ends – the sender's buttons and
 * every partner's receiver (a modified client can't flood your picture with bubbles).
 */
export class RateLimit {
  constructor({ burst = 4, everyMs = 2500 } = {}) {
    this.burst = burst;
    this.everyMs = everyMs;
    this.tokens = burst;
    this.at = null;
  }
  take(now) {
    if (this.at === null) this.at = now;
    this.tokens = Math.min(this.burst, this.tokens + (now - this.at) / this.everyMs);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
export const EMOTE_LIMIT = { burst: 4, everyMs: 2500 };
