// Shared World on the DS, the player page's half (docs/MULTIPLAYER.md › 9, "Gen 4"): the partners in the 3D field of
// Platinum, Diamond/Pearl and HeartGold/SoulSilver – their own overworld sprites from this computer's ROM, stood on the
// field with the game's own camera (shared/worldds.mjs projects with the matrices the game hands its 3D engine), scaled
// with the distance like the game's billboards, with their names, the Pokémon following them, the emotes, the A menu
// and rock-paper-scissors (web/lib/worldui.mjs, the same as on the GBA). Nothing is written into the game.
//
// The fast player (web/lib/nativeplayer.mjs) sends the bytes this needs with every picture (WATCH); the heap objects
// they live in move with every map load, so the pointers are read from the RAM mirror now and then and watched anew.
import { Track, unpackState, Follower, followerHidden, DIR, chainReaders, rangeReader } from '/shared/world.mjs';
import {
  dsWorldTable, dsPointers, dsWatchRanges, dsReadFrame, Displayed, billboard, project, dsPlayer, dsDrawable, dsMapKey,
  dsFacedPartner, dsAvatarSheets, dsAvatarFrame, dsFollowerFrame, findFollowerTable, btxSheet,
  findIconPalettes, dsMonIcon, measureTint, DS_SCREEN, DS_TILE,
} from '/shared/worldds.mjs';
import { ART, HAND_ART, artSize } from '/lib/worldart.mjs';
import { WORLD_CSS, drawBubble, createWorldUi } from '/lib/worldui.mjs';

const STATE_MS = 66;
const WAVE_MS = 2600;
const HAND_MS = 2400;
const A_CONFIRM_MS = 110; // after A: the game's own answer (a sign, a person) takes over first
const RETRO_A = 1 << 8; // libretro joypad bit of A (nativeplayer's input)
const DS_A = 1; // PAD_BUTTON_A in gSystem.heldKeysRaw
const SPARKLE = ['..#..', '..#..', '##o##', '..#..', '..#..'];
const none = (extra = {}) => ({ t: null, setConfig() {}, partner() {}, gone() {}, emote() {}, onWatched() {}, input() {}, debug: () => ({ supported: false, ...extra }), stop() {} });

/** The DS overlay for a player page, or a stand-in that does nothing (a game or language souldew has no table for). */
export async function startDs(host, cfg) {
  if (!host.watch) return none({ why: 'no per-picture bytes (browser player)' });
  const [{ findEntry }, addresses, rom] = await Promise.all([
    import('/shared/live/parse.mjs'),
    fetch('/shared/data/addresses.json').then((r) => r.json()),
    fetch(host.romUrl).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? new Uint8Array(b) : null)),
  ]);
  const code = rom && rom.length > 0x200 ? String.fromCharCode(...rom.subarray(0x0c, 0x10)) : cfg.code || '';
  const entry = findEntry(addresses, { platform: 'nds', code });
  // (another language of a known game shares the save layout, not the RAM: no overlay rather than a wrong one)
  const t = entry && !entry.scanOnly ? dsWorldTable(entry) : null;
  if (!t || !rom) return none({ code });
  const gfx = await loadGraphics(rom, t).catch((e) => (console.warn('shared world (DS) sprites', e), null));
  if (!gfx?.avatars?.walk?.[0]) return none({ code, why: 'sprites' });
  return worldDs(host, t, gfx);
}

/**
 * Everything drawn, taken out of the ROM once (the ROM itself isn't kept): the players' sheets per kind and gender,
 * and the followers – HGSS's own overworld Pokémon (its NARC members kept, decoded on first use) or the party icons.
 */
async function loadGraphics(rom, t) {
  const { listNdsFiles, parseNarc, ndsArm9 } = await import('/shared/nds.mjs');
  const files = listNdsFiles(rom);
  const narc = (path) => {
    const f = files.find((x) => x.path === path);
    return f ? parseNarc(rom.subarray(f.start, f.end)).map((m) => m.slice()) : null;
  };
  const mm = narc(t.mmodel);
  if (!mm) return null;
  const avatars = dsAvatarSheets(mm, t.sprites);
  const arm9 = ndsArm9(rom).bytes;
  let followers = null;
  if (t.followers === 'overworld') {
    const at = findFollowerTable(arm9);
    if (at >= 0) {
      const lut = new Uint16Array(494);
      for (let i = 0; i < 494; i++) lut[i] = arm9[at + i * 2] | (arm9[at + i * 2 + 1] << 8);
      const base = mm.length - (lut[493] + 18);
      followers = { kind: 'overworld', lut, files: mm.slice(Math.max(0, base)), base };
    }
  } else if (t.icons) {
    const at = findIconPalettes(arm9);
    const icons = at >= 0 ? narc(t.icons) : null;
    if (icons) followers = { kind: 'icons', pals: arm9.slice(at, at + 494), files: icons };
  }
  return { avatars, followers };
}

function worldDs(host, t, gfx) {
  const style = document.createElement('style');
  style.textContent = WORLD_CSS;
  document.head.append(style);
  const layer = document.createElement('div');
  layer.className = 'sw-layer';
  const canvas = document.createElement('canvas');
  canvas.width = DS_SCREEN.w;
  canvas.height = DS_SCREEN.h;
  canvas.style.opacity = '0';
  layer.append(canvas);
  document.body.append(layer);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const scratch = document.createElement('canvas');
  scratch.width = DS_SCREEN.w;
  scratch.height = DS_SCREEN.h;
  const sctx = scratch.getContext('2d');
  sctx.imageSmoothingEnabled = false;

  let cfg = { me: null, players: {}, enabled: false, actions: {}, labels: {}, lead: null, follow: true };
  const tracks = new Map(); // slot → Track
  const anim = new Map(); // slot → { dist, x, y }
  const bubbles = new Map();
  const leads = new Map(); // slot → { species, shiny, form } | null
  const followers = new Map(); // slot → Follower
  const ownFollower = new Follower();
  const shownAt = new Map(); // slot → their box this picture { x, top, bottom } (the menu, the name tag)
  const displayed = new Displayed();
  const canvases = new WeakMap(); // rgba → canvas
  const folSheets = new Map(); // species → sheet | null
  let ptr = null; // the field's heap objects, as last watched
  let ptrKey = '';
  let watched = null; // { ranges, total, bytes }
  let latest = null; // this picture's reading (what the game is at)
  let shown = null; // the reading the picture was drawn with
  let opacity = 0;
  let aHeld = false;
  let aAt = 0;
  let lastState = 0;
  let raf = 0;
  let stopped = false;
  let inputBits = 0;
  let near = 0;
  let ticks = 0;
  let drawnDebug = {};
  let tint = [1, 1, 1]; // the field's light on its billboards (measureTint), applied to everything drawn
  let tintAt = 0;
  let tintErr = null;

  const ui = createWorldUi({
    host, layer, screen: DS_SCREEN, getCfg: () => cfg,
    anchor: (slot) => shownAt.get(slot) || null,
    canModal: () => dsDrawable(shown),
    onClosed: () => (aHeld = true),
  });

  /** A frame as a canvas – lit like the field (`lit`: the tint applies; the masks stay as they are). */
  const canvasOf = (rgba, w, h, lit = true) => {
    const key = lit ? tint.map((v) => Math.round(v * 32)).join(',') : 'raw';
    let c = canvases.get(rgba);
    if (!c || c.key !== key) {
      c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.key = key;
      let px = rgba;
      if (lit && key !== '32,32,32') {
        px = new Uint8ClampedArray(rgba);
        for (let i = 0; i < px.length; i += 4) {
          px[i] *= tint[0];
          px[i + 1] *= tint[1];
          px[i + 2] *= tint[2];
        }
      }
      c.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
      canvases.set(rgba, c);
    }
    return c;
  };
  const sheetFor = (kind, gender) => {
    const k = gfx.avatars[kind]?.[gender ? 1 : 0] ? kind : 'walk';
    return gfx.avatars[k]?.[gender ? 1 : 0] || gfx.avatars.walk[0];
  };
  /** The follower's picture for a lead { species, shiny, form }: HGSS's own overworld Pokémon, else the party icon. */
  const followerFor = (lead) => {
    const f = gfx.followers;
    if (!lead || !f) return null;
    if (!folSheets.has(lead.species)) {
      let s = null;
      if (f.kind === 'overworld') {
        const b = lead.species > 0 && lead.species <= 493 ? f.files[f.lut[lead.species]] : null;
        s = b ? btxSheet(b) : null;
        if (s) s.kind = 'overworld';
      } else {
        const ic = dsMonIcon(f.files, f.pals, lead.species);
        if (ic) s = { kind: 'icon', w: 32, h: 32, frames: ic.frames.map((rgba) => ({ rgba, w: 32, h: 32 })), top: ic.top, bottom: ic.bottom, left: ic.left, right: ic.right };
      }
      folSheets.set(lead.species, s);
    }
    return folSheets.get(lead.species);
  };

  // ---- reading the game -------------------------------------------------------------------------------------------
  const mirror = (addr, len) => host.read(addr, len);
  const reader = () => (watched?.bytes ? chainReaders(rangeReader(watched.ranges, watched.bytes), mirror) : mirror);
  const active = () => cfg.enabled || (cfg.follow && !!cfg.lead && !!gfx.followers && t.followers !== 'overworld');
  function rewatch(force = false) {
    const p = dsPointers(t, mirror);
    const key = `${p ? Object.values(p).join(':') : '-'}:${active()}`;
    if (!force && key === ptrKey) return;
    ptrKey = key;
    ptr = p;
    displayed.reset();
    if (!active()) {
      watched = null;
      if (!host.watch([])) ptrKey = '';
      return;
    }
    const ranges = dsWatchRanges(t, p);
    watched = { ranges, total: ranges.reduce((n, r) => n + r[1], 0), bytes: null };
    if (!host.watch(ranges)) ptrKey = ''; // (the game isn't running yet: again later)
  }

  function placeLayer() {
    const r = host.screen?.() || host.rect();
    if (!r || !r.width) return null;
    const s = layer.style;
    const v = [`${r.left}px`, `${r.top}px`, `${r.width}px`, `${r.height}px`];
    if (s.left !== v[0] || s.top !== v[1] || s.width !== v[2] || s.height !== v[3]) Object.assign(s, { left: v[0], top: v[1], width: v[2], height: v[3] });
    return r;
  }

  // ---- one picture --------------------------------------------------------------------------------------------------
  function frame(now) {
    raf = requestAnimationFrame(frame);
    render(now, false);
  }

  /** `fresh`: a new picture's bytes came (the snapshot queue moves on); else the same picture is drawn again. */
  function render(now, fresh) {
    if (!(++ticks % 30)) rewatch();
    if (fresh) {
      latest = dsReadFrame(t, reader(), ptr);
      shown = displayed.feed(latest);
      // (the pointers moved – a new map: watch the new ones right away)
      if (latest && latest.field === false && ptr) rewatch();
    }
    if (now - lastState >= STATE_MS) {
      lastState = now;
      sendState();
    }
    const rect = placeLayer();
    const can = cfg.enabled && dsDrawable(shown) && dsDrawable(latest);
    const m = shown;
    const me = dsPlayer(t, shown);
    if (fresh && can && me && now - tintAt > 400) relight(me);
    const key = me ? me.map : -1;
    // the partners where the picture is now; their followers walk on even while nothing is drawn
    const list = [];
    for (const [slot, tr] of tracks) {
      const s = tr.sample(now);
      const here = !!s && !s.hidden && s.fam === t.fam && s.map === key;
      list.push({ slot, s, here });
      followTrail(slot, s, here);
    }
    const ownOn = cfg.follow && cfg.lead && t.followers !== 'overworld' && me && !followerHidden(me) && dsDrawable(shown);
    const own = ownOn ? ownFollower.update(`L${key}`, me.x, me.y, me.facing) : null;
    if (!own) ownFollower.trail = [];
    shownAt.clear();
    drawnDebug = {};
    if (!rect || !active() || !host.ready()) {
      near = 0;
      canvas.style.opacity = '0';
      for (const el of ui.tags.values()) el.style.opacity = '0';
      return;
    }
    const target = dsDrawable(shown) && dsDrawable(latest) ? 1 : 0;
    if (target !== opacity) {
      opacity = target;
      canvas.style.opacity = String(opacity);
    }
    ctx.clearRect(0, 0, DS_SCREEN.w, DS_SCREEN.h);
    // everything as billboards, far to near by their feet on the picture
    const sprites = [];
    if (can) {
      for (const p of list) {
        if (!p.here) continue;
        const sheet = sheetFor(p.s.kind, p.s.gender);
        const bb = billboard(m, p.s.x, p.s.h ?? me?.h ?? 0, p.s.y, sheet.w, sheet.h, t.foot);
        if (!bb || bb.x > DS_SCREEN.w + 8 || bb.x + bb.w < -8 || bb.y > DS_SCREEN.h + 8 || bb.y + bb.h < -24) continue;
        sprites.push({ type: 'partner', slot: p.slot, s: p.s, sheet, bb });
        const f = followers.get(p.slot)?.last;
        const fs = followerFor(leads.get(p.slot));
        if (f && !f.hidden && fs && !followerHidden(p.s)) addFollower(sprites, p.slot, f, fs, leads.get(p.slot), p.s.h ?? me?.h ?? 0);
      }
    }
    if (own && !own.hidden && dsDrawable(shown)) {
      const fs = followerFor(cfg.lead);
      if (fs) addFollower(sprites, cfg.me, own, fs, cfg.lead, me.h);
    }
    // the local player: partners behind them lose what the player's figure covers (their own sheet, every frame of
    // the direction they face – the game draws one of those)
    const localBb = me ? billboard(m, me.x, me.h, me.y, 32, 32, t.foot) : null;
    const localMask = me && localBb ? silhouette(sheetFor(me.kind, me.gender), me.facing) : null;
    sprites.sort((a, b) => a.bb.foot - b.bb.foot);
    for (const sp of sprites) {
      const behind = localBb && sp.bb.foot < localBb.foot - 0.5 && overlaps(sp.bb, localBb);
      drawSprite(sp, now, behind ? { mask: localMask, bb: localBb } : null);
    }
    // names and bubbles
    for (const p of list) {
      const el = ui.tagFor(p.slot);
      if (!el) continue;
      const sp = sprites.find((x) => x.type === 'partner' && x.slot === p.slot);
      const vis = !!sp && can;
      el.style.opacity = vis ? '1' : '0';
      el.style.pointerEvents = vis ? 'auto' : 'none';
      if (!vis) continue;
      const head = sp.bb.y + sp.sheet.top * sp.bb.k;
      shownAt.set(p.slot, { x: sp.bb.cx, top: head - 20, bottom: sp.bb.foot + 6 });
      const b = bubbles.get(p.slot);
      const talking = b && now < b.until;
      el.style.left = `${(sp.bb.cx / DS_SCREEN.w) * 100}%`;
      el.style.top = `${((head - (talking ? 19 + (artSize(b.art)[1] - 8) : 1)) / DS_SCREEN.h) * 100}%`;
      if (talking) drawBubble(ctx, sp.bb.cx, head - 1, cfg.players[p.slot]?.color || '#fff', now - b.start, b.art, !!b.lose && now - b.start > 500);
    }
    const mine = bubbles.get(cfg.me);
    if (can && mine && now < mine.until && localBb) {
      const head = localBb.y + sheetFor(me.kind, me.gender).top * localBb.k;
      drawBubble(ctx, localBb.cx, head - 1, cfg.players[cfg.me]?.color || '#fff', now - mine.start, mine.art, !!mine.lose && now - mine.start > 500);
    }
    interact(now, can, list);
    near = list.filter((p) => p.here).length;
  }

  /**
   * The field's light, off the local player standing still (their standing frame is what the game draws then): a fit
   * that doesn't match – something in front of them, an animation – is skipped.
   */
  function relight(me) {
    tintAt = performance.now();
    const pic = host.picture?.();
    if (!pic || me.x !== me.tx * DS_TILE + DS_TILE / 2 || me.y !== me.ty * DS_TILE + DS_TILE / 2) return;
    const sheet = sheetFor(me.kind, me.gender);
    const bb = billboard(shown, me.x, me.h, me.y, sheet.w, sheet.h, t.foot);
    if (!bb || Math.abs(bb.k - 1) > 0.03) return;
    const f = sheet.frames[dsAvatarFrame(sheet, me.facing, false, 0, 0, me.kind)];
    const r = measureTint(pic, f, Math.round(bb.x), Math.round(bb.y));
    tintErr = r ? Math.round(r.err * 10) / 10 : null;
    if (!r || r.err > 10) return;
    tint = tint.map((v, k) => Math.round((v * 0.5 + r.tint[k] * 0.5) * 100) / 100);
  }

  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const silCache = new Map();
  function silhouette(sheet, facing) {
    const k = `${sheet.name}:${facing}`;
    if (!silCache.has(k)) {
      const d = { [DIR.N]: 0, [DIR.S]: 1, [DIR.W]: 2, [DIR.E]: 3 }[facing] ?? 1;
      const idx = sheet.frames.length >= 16 ? [0, 1, 2, 3].map((i) => d * 4 + i) : [Math.min(d, sheet.frames.length - 1)];
      const rgba = new Uint8ClampedArray(sheet.w * sheet.h * 4);
      for (const i of idx) {
        const f = sheet.frames[i].rgba;
        for (let p = 3; p < f.length; p += 4) if (f[p]) rgba[p] = 255;
      }
      silCache.set(k, canvasOf(rgba, sheet.w, sheet.h, false));
    }
    return silCache.get(k);
  }

  function addFollower(list, slot, f, sheet, lead, h) {
    const bb = billboard(shown, f.x, h, f.y, sheet.w, sheet.h, t.foot);
    if (!bb) return;
    list.push({ type: 'follower', slot, f, sheet, lead, bb });
  }

  /** One billboard; `cut`: the local player in front of it (their figure is cut out of it). */
  function drawSprite(sp, now, cut) {
    const { bb, sheet } = sp;
    let img;
    let flip = false;
    if (sp.type === 'partner') {
      const s = sp.s;
      const k = anim.get(sp.slot) || { dist: 0, x: s.x, y: s.y };
      const d = Math.abs(s.x - k.x) + Math.abs(s.y - k.y);
      k.dist = s.moving ? k.dist + d : 0;
      k.x = s.x;
      k.y = s.y;
      anim.set(sp.slot, k);
      const i = dsAvatarFrame(sheet, s.facing, s.moving, k.dist, s.speed || 0, s.kind);
      img = canvasOf(sheet.frames[i].rgba, sheet.w, sheet.h);
      drawnDebug[sp.slot] = { x: Math.round(bb.x), y: Math.round(bb.y), k: Math.round(bb.k * 100) / 100, frame: i, cut: !!cut };
    } else if (sheet.kind === 'overworld') {
      const i = dsFollowerFrame(sheet, sp.f.facing ?? DIR.S, sp.f.moving, sp.f.dist ?? 0);
      img = canvasOf(sheet.frames[i].rgba, sheet.w, sheet.h);
      drawnDebug[`f:${sp.slot}`] = { x: Math.round(bb.x), y: Math.round(bb.y), species: sp.lead?.species, frame: i };
    } else {
      // a party icon: two frames, it looks left – mirrored walking right; stands on the tile like a sprite
      const fr = sp.f.frame & 1;
      img = canvasOf(sheet.frames[fr].rgba, 32, 32);
      flip = sp.f.flip;
      drawnDebug[`f:${sp.slot}`] = { x: Math.round(bb.x), y: Math.round(bb.y), species: sp.lead?.species, frame: fr };
    }
    // (scale 1 – the interiors and most of the outdoors near the player: whole pixels, crisp like the game's own)
    const k = bb.k;
    const exact = Math.abs(k - 1) < 0.03;
    // (a party icon has empty rows under it: its lowest pixel stands on the feet's line, like a trainer's)
    const drop = sheet.kind === 'icon' ? Math.max(0, sheet.h - 2 - sheet.bottom) * k : 0;
    const x = exact ? Math.round(bb.x) : bb.x;
    const y = exact ? Math.round(bb.y + drop) : bb.y + drop;
    const w = exact ? sheet.w : sheet.w * k;
    const h = exact ? sheet.h : sheet.h * k;
    const target = cut ? sctx : ctx;
    if (cut) sctx.clearRect(0, 0, DS_SCREEN.w, DS_SCREEN.h);
    target.save();
    if (flip) {
      target.translate(x + w, y);
      target.scale(-1, 1);
      target.drawImage(img, 0, 0, w, h);
    } else target.drawImage(img, x, y, w, h);
    target.restore();
    if (cut) {
      sctx.save();
      sctx.globalCompositeOperation = 'destination-out';
      const lk = cut.bb.k;
      const le = Math.abs(lk - 1) < 0.03;
      sctx.drawImage(cut.mask, le ? Math.round(cut.bb.x) : cut.bb.x, le ? Math.round(cut.bb.y) : cut.bb.y, cut.bb.w, cut.bb.h);
      sctx.restore();
      ctx.drawImage(scratch, 0, 0);
    }
    if (sp.type === 'follower' && sp.lead?.shiny) sparkle(x + w * 0.7, y + (sheet.top ?? 8) * k, now);
  }

  function sparkle(sx, sy, now) {
    const k = (now % 2400) / 2400;
    if (k >= 0.22) return;
    const x0 = Math.round(sx - k * 6);
    const y0 = Math.round(sy - 1);
    SPARKLE.forEach((row, j) => [...row].forEach((ch, i) => {
      if (ch === '.') return;
      ctx.fillStyle = ch === 'o' ? '#ffffff' : '#ffe9a8';
      ctx.fillRect(x0 + i, y0 + j, 1, 1);
    }));
  }

  /** A partner's follower walks their (interpolated) path in world units, a tile behind. */
  function followTrail(slot, s, here) {
    const lead = leads.get(slot);
    let f = followers.get(slot);
    if (!lead || !s || !here || followerHidden(s)) {
      if (f) f.last = null;
      if (f && (!s || s.hidden || !here)) followers.delete(slot);
      return;
    }
    if (!f) followers.set(slot, (f = new Follower()));
    const r = f.update(s.map, s.x, s.y, s.facing);
    // (the overworld Pokémon face where they walk: from the trail's last stretch, else their player's way)
    const tr = f.trail;
    const a = tr[tr.length - 2];
    const b = tr[tr.length - 1];
    let facing = s.facing;
    if (a && b && (a.x !== b.x || a.y !== b.y)) facing = Math.abs(b.x - a.x) > Math.abs(b.y - a.y) ? (b.x > a.x ? DIR.E : DIR.W) : b.y > a.y ? DIR.S : DIR.N;
    f.last = { ...r, facing, dist: f.dist };
  }

  // ---- the local player for the partners ------------------------------------------------------------------------------
  function sendState() {
    const r = latest;
    const me = dsPlayer(t, r);
    // seen wherever we stand in the field – also while a menu or a message is open here; not in a battle or a menu
    // screen (the field's child program), nor while the field isn't running (a map loading)
    const onField = !!me && !!r?.running && !!r.parent && !r.child;
    host.post({ type: 'emu-world', st: onField ? { ...me, fam: t.fam } : { hidden: true, fam: t.fam }, size: null, drawn: cfg.enabled && dsDrawable(shown), near });
  }

  // ---- walking up to a partner ------------------------------------------------------------------------------------------
  function interact(now, can, list) {
    const a = !!((latest?.keys || 0) & DS_A) || !!(inputBits & RETRO_A);
    const edge = a && !aHeld;
    aHeld = a;
    if (ui.menu || !can) {
      aAt = 0;
      return;
    }
    if (edge) aAt = now;
    if (!aAt || now - aAt < A_CONFIRM_MS) return;
    aAt = 0;
    if (latest?.task) return; // the game answered the button itself (a sign, someone standing there)
    const me = dsPlayer(t, latest);
    if (!me || me.x !== me.tx * DS_TILE + DS_TILE / 2 || me.y !== me.ty * DS_TILE + DS_TILE / 2) return; // standing still
    const faced = dsFacedPartner(me, list.filter((p) => p.here).map((p) => ({ slot: p.slot, state: p.s })));
    if (faced) ui.openMenu(faced);
  }

  raf = requestAnimationFrame(frame);
  return {
    t,
    // (HeartGold/SoulSilver have their own Pokémon walking behind you: souldew draws only your partners')
    ownFollower: t.followers !== 'overworld',
    setConfig(c) {
      cfg = { ...cfg, ...c, players: c.players || cfg.players, labels: c.labels || cfg.labels, actions: c.actions || cfg.actions };
      ui.prune();
      if (!cfg.enabled) ui.closeMenu();
      rewatch(true);
    },
    partner(slot, wire) {
      if (stopped || slot === cfg.me) return;
      const s = unpackState(wire);
      if (!s) return;
      if (!tracks.has(slot)) tracks.set(slot, new Track({ snapPx: 3 * DS_TILE }));
      tracks.get(slot).push(s, performance.now());
      if (s.ext && 'follower' in s.ext) leads.set(slot, s.ext.follower);
    },
    gone(slot) {
      tracks.delete(slot);
      anim.delete(slot);
      followers.delete(slot);
      leads.delete(slot);
      ui.gone(slot);
    },
    emote(slot, name) {
      if (!ART[name]) return;
      const now = performance.now();
      bubbles.set(slot, { art: name, start: now, until: now + WAVE_MS });
    },
    rps(v) {
      if (v && v.phase === 'pick') v = { ...v, untilPage: performance.now() + Math.max(0, v.leftMs ?? 10000) };
      ui.rpsView(v);
    },
    rpsRound(r) {
      const now = performance.now();
      for (const [slot, hand] of Object.entries(r?.hands || {})) {
        if (!HAND_ART[hand]) continue;
        bubbles.set(slot, { art: HAND_ART[hand], start: now, until: now + HAND_MS, lose: !!r.winner && r.winner !== slot });
      }
    },
    canPresent: () => !stopped && cfg.enabled && dsDrawable(shown),
    onWatched(bytes) {
      if (!watched || !bytes || bytes.length !== 4 + watched.total) return;
      watched.bytes = bytes.subarray(4);
      if (!stopped) render(performance.now(), true);
    },
    input(bits) {
      inputBits = bits >>> 0;
    },
    rewatch() {
      ptrKey = '';
      watched = null;
      rewatch();
    },
    menuOpen: () => ui.modal(),
    debug() {
      const now = performance.now();
      const me = dsPlayer(t, latest);
      return {
        supported: true, game: t.id, gen: 4, enabled: cfg.enabled, follow: cfg.follow, lead: cfg.lead, drawable: dsDrawable(shown), perFrame: !!watched?.bytes,
        local: me, shownLocal: dsPlayer(t, shown), map: latest ? dsMapKey(latest) : null, field: latest ? { task: latest.task, running: latest.running, parent: latest.parent, child: latest.child, fc: latest.fc } : null,
        followerKind: gfx.followers?.kind || null, drawn: drawnDebug, tint, tintErr, ...ui.debug(),
        followers: Object.fromEntries(Object.entries(drawnDebug).filter(([k]) => k.startsWith('f:')).map(([k, v]) => [k.slice(2), v])),
        bubbles: Object.fromEntries([...bubbles].filter(([, b]) => now < b.until).map(([slot, b]) => [slot, b.art])),
        localPos: me && shown ? project(shown, me.x, me.h, me.y) : null,
        partners: Object.fromEntries([...tracks].map(([slot, tr]) => {
          const s = tr.sample(now);
          return [slot, { s, pos: shownAt.get(slot) || null, delay: Math.round(tr.delay), lead: leads.get(slot) ?? null }];
        })),
      };
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      ui.stop();
      layer.remove();
      style.remove();
      host.watch?.([]);
    },
  };
}
