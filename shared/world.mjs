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
/** Families whose maps share ids: a partner is only drawn in a game of the same family (Ruby ↔ Sapphire, FR ↔ LG). */
export const FAMILIES = { rs: 1, e: 2, frlg: 3, rb: 11, y: 12, gs: 13, c: 14 };

// GBA key bits (KEYINPUT / gMain.heldKeys)
export const GBA_KEY = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512 };

/**
 * The Shared World table of a running game, or null where souldew doesn't know its memory (another language, a hack
 * with a moved layout): no overlay then, the board keeps saying where the partner is.
 * `entry`: the addresses.json game (findEntry); `rev`: the ROM's software version (header 0xBC).
 */
export function worldTable(entry, rev = 0) {
  const w = entry?.world;
  if (!w || entry.gen !== 3) return null;
  const rom = w.rom?.[String(rev)] || null;
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
export function readCamera(t, read) {
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
  };
}

/**
 * The local player for the partners (read from the RAM mirror, 10–15 times a second): where, which way, riding what.
 * { map, x, y (world px), tx, ty, facing, kind, gender, run } or null. `cam`: readCamera's result of the same moment.
 */
export function readPlayer(t, read, cam = readCamera(t, read)) {
  if (!cam) return null;
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
  };
}

/**
 * Can partners be drawn over the picture right now? The overworld (the game's own overworld callback, or the one
 * learned while the player walked: `learned`), no battle, no menu or script holding the player, no full fade.
 */
export function drawable(t, cam, learned = 0) {
  if (!t || !cam || cam.battle || cam.locked || cam.fade >= 16) return false;
  const cb2 = t.overworldCb2 || learned;
  return cb2 ? cam.cb2 === cb2 : true;
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
 * A player's state on the wire (~40 bytes of JSON): [v, seq, t, fam, map, x, y, flags]. flags: facing (bits 0–2),
 * kind (3–6), gender (7), run (8), hidden (9: not on the overworld – nothing to draw). `t`: the sender's clock (ms).
 */
export const WIRE_V = 1;
export function packState(st, seq, t) {
  if (!st || st.hidden) return [WIRE_V, seq >>> 0, Math.round(t), st?.fam || 0, 0, 0, 0, 1 << 9];
  const k = Math.max(0, KINDS.indexOf(st.kind));
  const flags = (st.facing & 7) | (k << 3) | ((st.gender & 1) << 7) | (st.run ? 1 << 8 : 0);
  return [WIRE_V, seq >>> 0, Math.round(t), st.fam | 0, st.map | 0, Math.round(st.x), Math.round(st.y), flags];
}

/** The other way – null for anything malformed (it comes from the network). */
export function unpackState(a) {
  if (!Array.isArray(a) || a.length < 8 || a[0] !== WIRE_V || !a.slice(1, 8).every(Number.isFinite)) return null;
  const [, seq, t, fam, map, x, y, flags] = a;
  if (Math.abs(x) > 0x8000 || Math.abs(y) > 0x8000 || map < 0 || map > 0xffff) return null;
  if (flags & (1 << 9)) return { seq, t, fam, hidden: true };
  const facing = flags & 7;
  return { seq, t, fam, map, x, y, facing: facing >= 1 && facing <= 4 ? facing : DIR.S, kind: KINDS[(flags >> 3) & 15] || 'walk', gender: (flags >> 7) & 1, run: !!(flags & (1 << 8)), hidden: false };
}

/** How often the sender sends: while something changes up to 15 a second, else a heartbeat once a second. */
export const SEND = { minMs: 66, idleMs: 1000, relayMs: 2000 };
/** Is `st` different enough from the last sent one to send now? */
export function changed(a, b) {
  if (!a || !b) return a !== b;
  return a.hidden !== b.hidden || a.map !== b.map || a.x !== b.x || a.y !== b.y || a.facing !== b.facing || a.kind !== b.kind || a.run !== b.run || a.gender !== b.gender;
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

  /** The state at `now` (our clock): { map, x, y, facing, kind, gender, run, fam, moving, hidden } or null. */
  sample(now) {
    const b = this.buf;
    if (!b.length || this.offset === null) return null;
    const rt = now - this.offset - this.delay; // render time on the sender's clock
    let i = b.length - 1;
    while (i > 0 && b[i].t > rt) i--;
    const a = b[i];
    const n = b[i + 1];
    if (a.t > rt) return { ...a, moving: false }; // older than anything we have: the oldest
    if (a.hidden) return { ...a, moving: false };
    if (n && !n.hidden && n.map === a.map && n.fam === a.fam && n.t > a.t) {
      const d = Math.abs(n.x - a.x) + Math.abs(n.y - a.y);
      if (d > this.snapPx) return { ...a, moving: false };
      const k = (rt - a.t) / (n.t - a.t);
      // (speed in pixels per game frame: 1 walking, 2 running or cycling, more on the Mach Bike)
      return { ...a, x: a.x + (n.x - a.x) * k, y: a.y + (n.y - a.y) * k, facing: d > 0 ? n.facing : k < 0.5 ? a.facing : n.facing, moving: d > 0, speed: d / Math.max(1, (n.t - a.t) / FRAME_MS) };
    }
    if (n) return { ...a, moving: false }; // the next one is on another map / hidden: hold until it's due
    // past the newest: keep going the way it went, for a moment (a held direction keeps walking in the game too)
    const p = b[i - 1];
    if (p && !p.hidden && p.map === a.map && a.t > p.t && rt - a.t < this.maxExtrapolate) {
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
 * same game family, or off the picture (with a margin for the sprite and the name).
 */
export function screenPos(t, cam, p) {
  if (!t || !cam || !p || p.hidden || p.fam !== t.fam || p.map !== cam.map) return null;
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
    if (!state || state.hidden || state.fam !== t.fam || state.map !== local.map) continue;
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
