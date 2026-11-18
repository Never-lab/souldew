// Shared World, the player page's half (docs/MULTIPLAYER.md › 9): the partners drawn over the game's picture, their
// names, the Pokémon following each of them (and you), the emote bubbles, and the little menu when you walk up to a
// partner and press A (Trade / Battle / Wave / Rock-paper-scissors / emotes) – with the rock-paper-scissors picker.
// Nothing is written into the game: souldew reads where the camera is (every picture: the native player sends those
// few bytes with each frame, web/lib/nativeplayer.mjs WATCH; the browser player reads its memory directly) and draws
// the partners' sprites – taken from this computer's ROM – on a canvas exactly on top of the picture.
//
// The play view (web/lib/sharedworld.mjs) drives it through window.__world: config(), partner(), gone(), wave(),
// emote(), rps(), rpsRound(). This page tells it the local player's state ('emu-world', ~15 a second), what was picked
// in the menu ('emu-world-act') and in the rock-paper-scissors picker ('emu-world-rps').
import {
  worldTable, watchRanges, rangeReader, chainReaders, readCamera, readPlayer, readLocalSprite, drawable, OverworldLearner,
  Track, unpackState, screenPos, facedPartner, gfxFor, kindFor, animFor, readMapView, blockReader, popupRect, GBA_KEY, TILE,
  Follower, followerHidden, readConnections, inLocalFrame,
} from '/shared/world.mjs';
import { findMonIcons, monIcon, iconIndex, dexToInternal, NAT } from '/shared/worldicons.mjs';
import { ART, HAND_ART, artSize, paintArt, artCanvas, INK } from '/lib/worldart.mjs';
import { rpsLine } from '/shared/rps.mjs';
import { gen3Avatar, animFrame, liveFrame, avatarPalette } from '/shared/worldsprites.mjs';
import { mapTop, coverMask, aboveTopLayer } from '/shared/worldmap.mjs';

const STATE_MS = 66; // the local state to the play view (it decides what goes out)
const WAVE_MS = 2600; // an emote bubble
const HAND_MS = 2400; // the hands of a rock-paper-scissors round
const EMOTE_ROW = ['heart', 'excl', 'quest', 'gg'];
const A_CONFIRM_MS = 110; // after A: the game's own answer (a sign, a person) takes over first
const RETRO_A = 1 << 8; // libretro joypad bit of A (nativeplayer's input)

const CSS = `
.sw-layer{position:fixed;pointer-events:none;overflow:hidden;z-index:5}
.sw-layer canvas{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;transition:opacity .14s linear}
.sw-tag{position:absolute;transform:translate(-50%,-100%);padding:1px 6px 2px;border-radius:7px;font:600 11px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;
  color:var(--c);background:rgba(14,13,18,.74);border:1px solid color-mix(in srgb,var(--c) 55%,transparent);white-space:nowrap;letter-spacing:.01em;
  pointer-events:auto;cursor:pointer;transition:opacity .14s linear;text-shadow:0 1px 0 #000}
.sw-tag:hover{background:rgba(14,13,18,.92)}
.sw-menu{position:fixed;z-index:6;min-width:132px;padding:6px;border-radius:10px;background:#1b1a1f;border:1px solid #4a4855;box-shadow:0 8px 28px #000a,inset 0 1px 0 #ffffff10;
  font:600 13px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;color:#ebe6da;animation:sw-in .12s ease-out}
@keyframes sw-in{from{opacity:0;transform:translateY(4px) scale(.97)}to{opacity:1;transform:none}}
.sw-menu .sw-who{padding:4px 8px 6px;font-size:12px;color:var(--c);display:flex;gap:6px;align-items:center}
.sw-menu .sw-who i{width:7px;height:7px;border-radius:50%;background:var(--c);box-shadow:0 0 6px var(--c)}
.sw-menu button{display:flex;width:100%;align-items:center;gap:8px;padding:7px 10px;border:0;border-radius:7px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.sw-menu button[aria-selected="true"]{background:color-mix(in srgb,var(--c) 22%,#2a2931);box-shadow:inset 2px 0 0 var(--c)}
.sw-menu button:disabled{opacity:.42;cursor:default}
.sw-menu .sw-why{padding:2px 10px 4px;font:500 11px/1.35 system-ui,sans-serif;color:#a9a5b3;max-width:220px}
.sw-menu .sw-keys{padding:5px 10px 2px;font:500 10px/1 system-ui,sans-serif;color:#77757f}
.sw-menu .sw-row{display:flex;gap:4px;padding:2px 4px}
.sw-menu .sw-row button{width:auto;flex:1;justify-content:center;padding:6px 0}
.sw-menu canvas.px-art{image-rendering:pixelated;display:block}
.sw-rps{min-width:216px}
.sw-rps .sw-hands{display:flex;gap:6px;padding:4px}
.sw-rps .sw-hands button{flex-direction:column;gap:5px;padding:8px 4px 6px;justify-content:center;align-items:center;font-size:11px}
.sw-rps .sw-hands button.picked{background:color-mix(in srgb,var(--c) 30%,#2a2931);opacity:1}
.sw-rps .sw-time{height:3px;margin:4px 8px 2px;border-radius:2px;background:#2d2c33;overflow:hidden}
.sw-rps .sw-time i{display:block;height:100%;background:var(--c);transform-origin:left;transition:transform .25s linear}
.sw-rps .sw-say{padding:6px 8px 2px;font:600 12px/1.35 system-ui,sans-serif;min-height:16px}
`;

// a little four-point star over a shiny follower (party icons have no shiny colours in Gen 3) – original pixel art
const SPARKLE = ['..#..', '..#..', '##o##', '..#..', '..#..'];

/**
 * Installs window.__world in a player page. `host`: { system, romUrl, read(addr, len), rect() → the picture's box in
 * CSS pixels, watch?(ranges) (native: per-picture bytes), pause(), resume(), paused(), post(msg), keyButton?(e) }.
 */
export function installWorld(host) {
  let st = null; // everything once config() turned it on
  const api = {
    /** From the play view: { me, players: { slot: { name, color } }, enabled, actions: { slot: { trade, battle, why } }, labels } */
    async config(cfg) {
      if (!st) st = await start(host, cfg).catch((e) => (console.warn('shared world', e), null));
      st?.setConfig(cfg);
      return !!st?.t;
    },
    partner: (slot, wire) => st?.partner(slot, wire),
    gone: (slot) => st?.gone(slot),
    wave: (slot) => st?.emote(slot, 'wave'),
    /** An emote bubble over a player (`slot` may be the local one): 'wave' | 'heart' | 'excl' | 'quest' | 'gg' */
    emote: (slot, name) => st?.emote(slot, name),
    /** The rock-paper-scissors game this page shows (shared/rps.mjs view + names), or null: the picker closes */
    rps: (view) => st?.rps?.(view),
    /** A round's hands over both players' heads: { hands: { slot: 0–2 }, winner } */
    rpsRound: (round) => st?.rpsRound?.(round),
    /** Can this page show a rock-paper-scissors game right now (Shared World on, the overworld on screen)? */
    canPresent: () => !!st?.canPresent?.(),
    /** nativeplayer: the WATCHED bytes of the picture that comes next */
    onWatched: (bytes) => st?.onWatched(bytes),
    /** nativeplayer: the buttons as sent to the game (libretro bits) */
    input: (bits) => st?.input(bits),
    /** nativeplayer: another host runs the game now (a seamless link session began or ended) – WATCH goes out again */
    rewatch: () => st?.rewatch?.(),
    /** Is the A menu open? (the game is paused then, but the controller stays with this page) */
    menuOpen: () => !!st?.menuOpen?.(),
    /** tests / diagnostics */
    state: () => st?.debug() || null,
    stop: () => st?.stop(),
  };
  window.__world = api;
  return api;
}

async function start(host, cfg) {
  if (host.system !== 'gba') return { t: null, setConfig() {}, partner() {}, gone() {}, emote() {}, onWatched() {}, input() {}, debug: () => ({ supported: false }), stop() {} };
  const [{ findEntry }, addresses, rom, dex] = await Promise.all([
    import('/shared/live/parse.mjs'),
    fetch('/shared/data/addresses.json').then((r) => r.json()),
    fetch(host.romUrl).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? new Uint8Array(b) : null)),
    fetch('/shared/data/gen3_index_to_dex.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const code = rom && rom.length > 0xc0 ? String.fromCharCode(...rom.subarray(0xac, 0xb0)) : cfg.code || '';
  const entry = findEntry(addresses, { platform: 'gba', code });
  const t = worldTable(entry, rom ? rom[0xbc] : 0, code);
  if (!t || !rom) return { t: null, setConfig() {}, partner() {}, gone() {}, emote() {}, onWatched() {}, input() {}, debug: () => ({ supported: false, code }), stop() {} };
  return world(host, t, rom, dex);
}

function world(host, t, rom, dex) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const layer = document.createElement('div');
  layer.className = 'sw-layer';
  const canvas = document.createElement('canvas');
  canvas.width = t.screen.w;
  canvas.height = t.screen.h;
  canvas.style.opacity = '0';
  layer.append(canvas);
  document.body.append(layer);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  let cfg = { me: null, players: {}, enabled: false, actions: {}, labels: {}, lead: null, follow: true };
  const tracks = new Map(); // slot → Track
  const tags = new Map(); // slot → name tag element
  const avatars = new Map(); // gfx id → { w, h, frames: [canvas], anims } | null
  const anim = new Map(); // slot → { time, lastX, lastY }
  const bubbles = new Map(); // slot (or the local one) → { art, start, until, lose, draw }
  // the Pokémon following each player: their lead (from their messages; yours from the play view), its trail
  const icons = findMonIcons(rom); // (the icon tables, found by their palette tags – any language, randomized or not)
  const toInternal = dexToInternal(dex?.map);
  const iconCache = new Map();
  const leads = new Map(); // slot → { species, shiny, form } | null
  const sizes = new Map(); // slot → their map's [w, h] (a partner north or west of a connection)
  const followers = new Map(); // slot → Follower
  const ownFollower = new Follower();
  const connCache = new Map();
  let conns = null; // this map's size and connections, this picture
  let fdraw = {}; // diagnostics: the followers drawn this picture
  let rpsUi = null; // the rock-paper-scissors picker
  const spriteCache = {};
  const frameCache = new Map();
  const learner = new OverworldLearner();
  let watched = null; // { ranges, sb1, spriteId, bytes } – the native player's per-picture bytes
  let watchKey = '';
  let cam = null;
  let shown = 0; // opacity
  let menu = null;
  let aHeld = false;
  let aAt = 0;
  let lastState = 0;
  let raf = 0;
  let stopped = false;
  let inputBits = 0;
  let lastSprite = null; // the local player's sprite as last drawn
  let near = 0; // partners on the picture
  let lastLocalGfx = null; // the local player's avatar (for the head line of their bubble)
  // occlusion (shared/worldmap.mjs): the top layer per map layout, its tilesets decoded once; per picture the blocks
  const tops = new Map(); // layout address → mapTop | null
  const tilesets = new Map();
  let occ = null; // { blockAt, mask, layout } this picture, or null (unknown game, no map yet)
  let popup = null; // the map-name popup's rectangle this picture
  let covered = {}; // diagnostics: hidden pixels per partner slot ('me': the local player's redraw)
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d');

  const toCanvas = (rgba, w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
    return c;
  };
  const avatarFor = (gfx) => {
    if (!avatars.has(gfx)) {
      const a = gen3Avatar(rom, t, gfx, spriteCache);
      // vtop: the first row with a pixel in any standing frame – the head, where the name and the bubble go
      let vtop = a ? a.h : 0;
      for (const f of a ? a.frames.slice(0, 3) : []) for (let i = 3; i < f.length; i += 4) if (f[i]) { vtop = Math.min(vtop, Math.floor((i >> 2) / a.w)); break; }
      avatars.set(gfx, a ? { ...a, vtop, rgba: a.frames, frames: a.frames.map((f) => toCanvas(f, a.w, a.h)) } : null);
    }
    return avatars.get(gfx);
  };

  /** The follower's picture for a lead { species, shiny, form }: the party icon as two canvases, or null. */
  const iconFor = (lead) => {
    if (!lead || !icons) return null;
    const idx = iconIndex(toInternal, lead.species, lead.form);
    if (!idx) return null;
    const key = `${idx}:${lead.species === NAT.DEOXYS ? 1 : 0}`;
    if (!iconCache.has(key)) {
      const ic = monIcon(rom, icons, idx, { deoxys: lead.species === NAT.DEOXYS, cache: iconCache });
      iconCache.set(`c:${key}`, ic ? { ...ic, rgba: ic.frames, frames: ic.frames.map((f) => toCanvas(f, ic.w, ic.h)) } : null);
    }
    return iconCache.get(`c:${key}`) || null;
  };

  // ---- reading the game ---------------------------------------------------------------------------------------------
  /** Anything to draw: the partners (the switch), or just your own follower (its own switch, with a lead to show). */
  const active = () => cfg.enabled || (cfg.follow && !!cfg.lead && !!icons);
  const mirror = (addr, len) => host.read(addr, len);
  /** This picture's bytes where the native player sent them, else the memory (mirror or the browser emulator's own). */
  const reader = () => (watched?.bytes ? chainReaders(rangeReader(watched.ranges, watched.bytes), mirror) : mirror);
  function rewatch() {
    if (!host.watch) return;
    const p = t.saveBlock1Ptr ? host.read(t.saveBlock1Ptr, 4) : null;
    const sb1 = t.saveBlock1 || (p && p.length === 4 ? (p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24)) >>> 0 : 0);
    const av = host.read(t.playerAvatar + 4, 1);
    const spriteId = av && av.length ? av[0] : null;
    const key = `${sb1}:${spriteId}:${active()}`;
    if (key === watchKey) return;
    watchKey = key;
    if (!active()) {
      watched = null;
      if (!host.watch([])) watchKey = '';
      return;
    }
    const ranges = watchRanges(t, sb1 >= 0x02000000 && sb1 < 0x02040000 ? sb1 : 0, spriteId);
    watched = { ranges, bytes: null, total: ranges.reduce((n, r) => n + r[1], 0) };
    if (!host.watch(ranges)) watchKey = ''; // (the game isn't running yet: again later)
  }

  // ---- drawing ----------------------------------------------------------------------------------------------------------
  function placeLayer() {
    const r = host.rect();
    if (!r || !r.width) return false;
    const s = layer.style;
    const v = [`${r.left}px`, `${r.top}px`, `${r.width}px`, `${r.height}px`];
    if (s.left !== v[0] || s.top !== v[1] || s.width !== v[2] || s.height !== v[3]) Object.assign(s, { left: v[0], top: v[1], width: v[2], height: v[3] });
    return r;
  }

  /**
   * A white speech bubble with pixel art (web/lib/worldart.mjs) in `color`, its tail at (x, y), bobbing once when it
   * appears. `dim`: drawn faded (the losing hand of a rock-paper-scissors round).
   */
  function drawBubble(x, y, color, age, art = 'wave', dim = false) {
    const [aw, ah] = artSize(art);
    const w = aw + 6;
    const h = ah + 5;
    const bob = age < 160 ? Math.round(-2 * Math.sin((age / 160) * Math.PI)) : 0;
    const bx = Math.round(x) - (w >> 1);
    const by = Math.round(y) - h - 2 + bob;
    ctx.save();
    if (dim) ctx.globalAlpha = 0.5;
    ctx.fillStyle = INK;
    ctx.fillRect(bx + 1, by, w - 2, h);
    ctx.fillRect(bx, by + 1, w, h - 2);
    ctx.fillRect(bx + (w >> 1) - 1, by + h, 3, 2);
    ctx.fillStyle = '#fbf8f1';
    ctx.fillRect(bx + 1, by + 1, w - 2, h - 2);
    ctx.fillRect(bx + (w >> 1), by + h - 1, 1, 2);
    paintArt(ctx, art, bx + 3, by + 3 - (ah > 8 ? 1 : 0), color);
    ctx.restore();
  }

  /** The top layer of the map the game shows now (built on the first picture of a map, then kept). */
  function readOcclusion(read) {
    const v = readMapView(t, read);
    if (!v) return null;
    if (!tops.has(v.layout)) {
      if (tops.size > 32) (tops.clear(), tilesets.clear());
      tops.set(v.layout, mapTop(rom, t.family, v.layout, tilesets));
    }
    const top = tops.get(v.layout);
    return top ? { blockAt: blockReader(v, read), mask: top.mask, layout: v.layout } : null;
  }

  /**
   * A sprite at picture pixels (x, y), minus what the map's top layer draws over it there (a tree top, a roof, the
   * leaves of a plant) – unless it stands on a bridge (`elev`: its elevation; such sprites are drawn above BG1).
   * `img`: the frame as a canvas, `rgba` its pixels (for the cut-out). Returns the hidden pixel count.
   */
  function drawSprite(img, rgba, w, h, x, y, flip, elev) {
    const mask = occ && rgba && !aboveTopLayer(elev | 0)
      ? coverMask({ x: x - t.anchor.x + cam.cx, y: y - t.anchor.y + cam.cy, w, h }, occ.blockAt, occ.mask)
      : null;
    if (mask) {
      const out = new ImageData(w, h);
      const d = out.data;
      let n = 0;
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          const i = r * w + c;
          if (mask[i]) {
            n++;
            continue;
          }
          const j = (r * w + (flip ? w - 1 - c : c)) * 4;
          d[i * 4] = rgba[j];
          d[i * 4 + 1] = rgba[j + 1];
          d[i * 4 + 2] = rgba[j + 2];
          d[i * 4 + 3] = rgba[j + 3];
        }
      }
      if (scratch.width !== w || scratch.height !== h) (scratch.width = w, scratch.height = h);
      sctx.putImageData(out, 0, 0);
      ctx.drawImage(scratch, x, y);
      return n;
    }
    if (flip) {
      ctx.save();
      ctx.translate(x + w, y);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    } else ctx.drawImage(img, x, y);
    return 0;
  }

  let ticks = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    render(now);
  }
  /** One picture of the overlay – every animation frame, and again right when the native player shows a new picture. */
  function render(now) {
    if (!(++ticks % 30)) rewatch();
    const read = reader();
    cam = readCamera(t, read);
    if (!t.overworldCb2) learner.feed(cam);
    // this map's size and the maps connected to it (partners next door are drawn across the edge)
    conns = cam ? readConnections(t, read, rom, cam.map, connCache) : null;
    // the partners see us even while our switch is off (it says what *we* see)
    if (now - lastState >= STATE_MS) {
      lastState = now;
      sendState(read, cfg.enabled && drawable(t, cam, learner.cb2));
    }
    const rect = placeLayer();
    const can = drawable(t, cam, learner.cb2);
    const me = cam ? readPlayer(t, read, cam) : null;
    // the trails go on while nothing is drawn (a menu here): the followers are where they belong when it closes
    const list = [];
    for (const [slot, tr] of tracks) {
      const conv = conns ? (st) => inLocalFrame(conns, st, sizes.get(slot)) : null;
      const s = tr.sample(now, conv);
      const pos = can && cfg.enabled && s ? screenPos(t, cam, s) : null;
      list.push({ slot, s, pos });
      followTrail(slot, s, conv ? `L${cam?.map}` : s?.map);
    }
    const own = cfg.follow && cfg.lead && me && !followerHidden(me) ? ownFollower.update(`L${cam.map}`, me.x, me.y, me.facing) : null;
    if (!own) ownFollower.trail = [];
    if (!rect || !active() || !host.ready()) {
      near = 0;
      canvas.style.opacity = '0';
      for (const el of tags.values()) el.style.opacity = '0';
      return;
    }
    const target = can ? 1 - (cam.fade || 0) / 16 : 0;
    shown = target; // (the CSS transition smooths it)
    canvas.style.opacity = String(Math.round(shown * 100) / 100);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // the followers, as sprites of their own between the others
    fdraw = {};
    const sprites = list.filter((p) => p.pos).map((p) => ({ ...p, kind: 'partner' }));
    if (can) {
      for (const p of list) {
        const f = cfg.enabled ? followers.get(p.slot)?.last : null;
        if (f && !f.hidden && p.s && !followerHidden(p.s) && (p.s.local || p.s.map === cam.map)) addFollower(sprites, p.slot, f, leads.get(p.slot), p.s.elev);
      }
      if (own && !own.hidden) addFollower(sprites, cfg.me, own, cfg.lead, me.elev);
    }
    // the partners behind the local player first, then the player's own sprite again (only where it covers one of
    // them), then those in front: depth as in the game, by the feet's line
    const spr = can ? readLocalSprite(t, read) : null;
    const localFeet = spr ? spr.y + spr.h : t.anchor.y + TILE;
    const drawn = sprites.sort((a, b) => a.pos.y - b.pos.y || (a.kind === 'follower' ? -1 : 1));
    occ = can && drawn.length ? readOcclusion(read) : null; // (nobody here: no tilesets to decode either)
    popup = can ? popupRect(t, read, popup) : null;
    covered = {};
    // the map-name popup (BG0, over everything) isn't a lock: nothing of ours is drawn on its rectangle
    ctx.save();
    if (popup) {
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      ctx.rect(popup.x, popup.y, popup.w, popup.h);
      ctx.clip('evenodd');
    }
    let localDone = false;
    for (const p of drawn) {
      if (!localDone && p.pos.y + TILE > localFeet) {
        drawLocal(spr, drawn, me);
        localDone = true;
      }
      if (p.kind === 'follower') drawFollower(p, now);
      else drawPartner(p, now);
    }
    if (!localDone) drawLocal(spr, drawn, me);
    // names and bubbles
    const underPopup = (x, y) => !!popup && x >= popup.x - 4 && x < popup.x + popup.w + 4 && y >= popup.y - 4 && y < popup.y + popup.h + 4;
    for (const p of list) {
      const el = tagFor(p.slot);
      if (!el) continue;
      const vis = !!p.pos && can && !underPopup(p.pos.x + TILE / 2, p.pos.y - 8);
      el.style.opacity = vis ? String(Math.round(shown * 100) / 100) : '0';
      el.style.pointerEvents = vis ? 'auto' : 'none';
      const b = bubbles.get(p.slot);
      const talking = vis && b && now < b.until;
      const a = vis ? avatarFor(gfxFor(t, p.s.kind, p.s.gender)) : null;
      const head = vis ? p.pos.y + TILE - (a?.h || 32) + (a?.vtop || 0) : 0;
      if (vis) {
        // the name just above the head – above the bubble while there is one
        el.style.left = `${((p.pos.x + TILE / 2) / t.screen.w) * 100}%`;
        el.style.top = `${((head - (talking ? 19 + (artSize(b.art)[1] - 8) : 1)) / t.screen.h) * 100}%`;
      }
      if (talking) bubble(p.slot, b, p.pos.x + TILE / 2, head - 1, now);
    }
    const mine = bubbles.get(cfg.me);
    if (can && mine && now < mine.until) {
      const la = lastLocalGfx !== null ? avatarFor(lastLocalGfx) : null;
      const head = spr ? spr.y + (la?.vtop || 0) : t.anchor.y - 8;
      bubble(cfg.me, mine, spr ? spr.x + spr.w / 2 : t.anchor.x + 8, head - 1, now);
    }
    ctx.restore();
    interact(now, read, can, list);
    near = list.filter((p) => p.pos).length;
  }

  function bubble(slot, b, x, y, now) {
    // (the losing hand fades a moment after both show)
    drawBubble(x, y, cfg.players[slot]?.color || '#fff', now - b.start, b.art, !!b.lose && now - b.start > 500);
  }

  /** A partner's follower walks their (interpolated) path; it goes back onto them when they're gone or out of frame. */
  function followTrail(slot, s, key) {
    const lead = leads.get(slot);
    let f = followers.get(slot);
    if (!lead || !s || s.hidden || s.away || s.fam !== t.fam || followerHidden(s)) {
      if (f) f.last = null;
      if (f && (!s || s.hidden || s.away)) followers.delete(slot);
      return;
    }
    if (!f) followers.set(slot, (f = new Follower()));
    f.last = f.update(key, s.x, s.y, s.facing);
  }

  function addFollower(list, slot, f, lead, elev) {
    const ic = iconFor(lead);
    if (!ic) return;
    const pos = { x: t.anchor.x + (f.x - cam.cx), y: t.anchor.y + (f.y - cam.cy) };
    if (pos.x < -48 || pos.y < -48 || pos.x > t.screen.w + 32 || pos.y > t.screen.h + 48) return;
    list.push({ kind: 'follower', slot, pos, f, ic, lead, elev });
  }

  /** A follower: the party icon standing on its tile (its lowest pixel on the tile's bottom row), facing its way. */
  function drawFollower(p, now) {
    const { ic, f } = p;
    // the icons look left: walking right they're mirrored (and so is the box their pixels fill)
    const left = f.flip ? ic.w - 1 - ic.right : ic.left;
    const right = f.flip ? ic.w - 1 - ic.left : ic.right;
    const x = Math.round(p.pos.x + TILE / 2 - (left + right + 1) / 2);
    const y = Math.round(p.pos.y + TILE - 1 - ic.bottom);
    const fr = f.frame & 1;
    const n = drawSprite(ic.frames[fr], ic.rgba[fr], ic.w, ic.h, x, y, f.flip, p.elev);
    p.box = { x: x + left, y: y + ic.top, w: right - left + 1, h: ic.bottom - ic.top + 1 };
    fdraw[p.slot] = { species: p.lead.species, x: Math.round(p.pos.x), y: Math.round(p.pos.y), flip: f.flip, frame: fr, moving: f.moving, covered: n };
    // a shiny one sparkles now and then
    if (p.lead.shiny) {
      const k = (now % 2400) / 2400;
      if (k < 0.22) {
        const sx = x + right - 3 - Math.round(k * 6);
        const sy = y + ic.top - 1;
        SPARKLE.forEach((row, j) => [...row].forEach((ch, i) => {
          if (ch === '.') return;
          ctx.fillStyle = ch === 'o' ? '#ffffff' : '#ffe9a8';
          ctx.fillRect(sx + i, sy + j, 1, 1);
        }));
      }
    }
  }

  function drawPartner(p, now) {
    const s = p.s;
    const a = avatarFor(gfxFor(t, s.kind, s.gender));
    if (!a) return;
    const k = anim.get(p.slot) || { time: 0, x: s.x, y: s.y };
    const d = Math.abs(s.x - k.x) + Math.abs(s.y - k.y);
    // the animation advances with the distance walked (in the game's frames at that speed), so feet and ground match
    const speed = Math.max(1, s.speed || 1);
    if (s.moving) k.time += Math.max(d / speed, 0);
    else k.time = 0;
    k.x = s.x;
    k.y = s.y;
    anim.set(p.slot, k);
    const kind = kindFor(t, s.kind);
    const c = animFrame(a, animFor({ ...s, kind }, s.speed || 0), Math.floor(k.time));
    const i = a.frames[c.img] ? c.img : 0;
    const x = Math.round(p.pos.x + TILE / 2 - a.w / 2);
    const y = Math.round(p.pos.y + TILE - a.h);
    covered[p.slot] = drawSprite(a.frames[i], a.rgba[i], a.w, a.h, x, y, c.flip, s.elev);
    p.box = { x, y, w: a.w, h: a.h };
  }

  /**
   * The local player's own sprite, again – only when a partner or a follower behind them overlaps it (their exact
   * current frame): your own follower walking behind you goes behind your legs, not over them.
   */
  function drawLocal(spr, drawn, me) {
    if (!spr) return;
    lastSprite = spr;
    const over = drawn.some((p) => p.box && p.pos.y + TILE <= spr.y + spr.h && p.box.x < spr.x + spr.w && p.box.x + p.box.w > spr.x && p.box.y < spr.y + spr.h && p.box.y + p.box.h > spr.y);
    if (!over || !me) return;
    const pal = me && avatarPalette(rom, t, gfxFor(t, me.kind, me.gender), spriteCache);
    const px = pal && liveFrame(rom, spr, pal, frameCache);
    if (!px) return;
    const key = `c:${spr.images}:${spr.animNum}:${spr.cmd}`;
    if (!frameCache.has(key)) frameCache.set(key, toCanvas(px, spr.w, spr.h));
    // (the game hides the same pixels of the real one: drawn again in full it would stand on top of a tree top)
    covered.me = drawSprite(frameCache.get(key), px, spr.w, spr.h, spr.x, spr.y, spr.flip, me.elev);
  }

  function tagFor(slot) {
    const pl = cfg.players[slot];
    if (!pl) return null;
    let el = tags.get(slot);
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'sw-tag';
      el.style.opacity = '0';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openMenu(slot);
      });
      layer.append(el);
      tags.set(slot, el);
    }
    if (el.textContent !== pl.name) el.textContent = pl.name;
    el.style.setProperty('--c', pl.color || '#ebe6da');
    el.title = cfg.labels.tagHint || '';
    return el;
  }

  // ---- the local player for the partners --------------------------------------------------------------------------
  function sendState(read, can) {
    const me = cam ? readPlayer(t, read, cam) : null;
    if (me) lastLocalGfx = gfxFor(t, me.kind, me.gender);
    // the partners see us wherever we stand on the overworld – also while a menu or a message is open here
    const onOverworld = !!me && !!cam && !cam.battle && cam.fade < 16 && (t.overworldCb2 || learner.cb2 ? cam.cb2 === (t.overworldCb2 || learner.cb2) : true);
    // (and the size of this map: a partner on the map north or west of it places us by it)
    const size = conns && cam && conns.map === cam.map ? [conns.w, conns.h] : null;
    host.post({ type: 'emu-world', st: onOverworld ? { ...me, fam: t.fam } : { hidden: true, fam: t.fam }, size, drawn: can, near });
  }

  // ---- walking up to a partner ----------------------------------------------------------------------------------------
  function interact(now, read, can, list) {
    const a = !!((cam?.keys || 0) & GBA_KEY.A) || !!(inputBits & RETRO_A);
    const edge = a && !aHeld;
    aHeld = a;
    if (menu || !can) {
      aAt = 0;
      return;
    }
    if (edge) aAt = now;
    if (!aAt || now - aAt < A_CONFIRM_MS) return;
    aAt = 0;
    if (cam.locked) return; // the game answered the button itself (a sign, someone standing there)
    const me = readPlayer(t, read, cam);
    if (!me || me.x !== me.tx * TILE || me.y !== me.ty * TILE) return; // only standing still
    const faced = facedPartner(t, me, list.filter((p) => p.pos).map((p) => ({ slot: p.slot, state: p.s })));
    if (faced) openMenu(faced);
  }

  // ---- the menu (the partners stay drawn behind it; the game is paused while it is open) ----------------------------
  // Items: Trade, Battle, Wave, Rock-paper-scissors, a row of emotes (heart, !, ?, GG), Cancel. Up/down between the
  // items, left/right along the emote row.
  function openMenu(slot) {
    if (menu || rpsUi?.modal || !cfg.players[slot]) return;
    const pl = cfg.players[slot];
    const L = cfg.labels;
    const ac = cfg.actions[slot] || {};
    const items = [
      { act: 'trade', label: L.trade || 'Trade', on: !!ac.trade },
      { act: 'battle', label: L.battle || 'Battle', on: !!ac.battle },
      { act: 'wave', label: L.wave || 'Wave', on: true },
      { act: 'rps', label: L.rps || 'Rock-paper-scissors', on: ac.rps !== false },
      { act: 'emote', row: EMOTE_ROW, on: true },
      { act: 'close', label: L.cancel || 'Cancel', on: true },
    ];
    const el = document.createElement('div');
    el.className = 'sw-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', pl.name);
    el.style.setProperty('--c', pl.color || '#ebe6da');
    const who = document.createElement('div');
    who.className = 'sw-who';
    who.append(document.createElement('i'), document.createTextNode(pl.name));
    el.append(who);
    const buttons = [];
    items.forEach((it, i) => {
      const pick = (sub) => (e) => {
        e.stopPropagation();
        choose(i, sub);
      };
      if (it.row) {
        const row = document.createElement('div');
        row.className = 'sw-row';
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', L.emotes || 'Emotes');
        it.buttons = it.row.map((name, k) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.setAttribute('role', 'menuitem');
          b.title = L[`emote_${name}`] || name;
          b.setAttribute('aria-label', b.title);
          b.append(artCanvas(name, '#ebe6da', 2));
          b.addEventListener('click', pick(k));
          b.addEventListener('pointerenter', () => select(i, k));
          row.append(b);
          return b;
        });
        el.append(row);
        buttons.push(row);
        return;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = it.label;
      b.disabled = !it.on;
      b.addEventListener('click', pick(0));
      b.addEventListener('pointerenter', () => it.on && select(i));
      el.append(b);
      buttons.push(b);
    });
    const why = !ac.trade && !ac.battle ? ac.why || '' : '';
    if (why) {
      const w = document.createElement('div');
      w.className = 'sw-why';
      w.textContent = why;
      el.append(w);
    }
    if (L.keys) {
      const k = document.createElement('div');
      k.className = 'sw-keys';
      k.textContent = L.keys;
      el.append(k);
    }
    document.body.append(el);
    const wasPaused = host.paused();
    if (!wasPaused) host.pause();
    menu = { el, slot, items, buttons, sel: -1, sub: 0, wasPaused, pad: {} };
    select(items.findIndex((x) => x.on));
    positionMenu();
    addEventListener('keydown', onKey, true);
    addEventListener('keyup', swallow, true);
    addEventListener('pointerdown', outside, true);
  }
  /**
   * Over the partner (`slot`), or (null) at the bottom of the picture – the players stand in its middle and their
   * bubbles show above them; kept inside the picture.
   */
  function placeBox(el, slot) {
    const r = host.rect();
    if (!r) return;
    const p = slot ? tracks.get(slot)?.sample(performance.now()) : null;
    const pos = p && cam ? screenPos(t, cam, p) : null;
    const k = r.width / t.screen.w;
    const mw = el.offsetWidth;
    const mh = el.offsetHeight;
    let x = pos ? r.left + (pos.x + TILE / 2) * k - mw / 2 : r.left + r.width / 2 - mw / 2;
    let y = pos ? r.top + (pos.y - 20) * k - mh : r.top + r.height - mh - 8;
    if (y < r.top + 6) y = pos ? r.top + (pos.y + TILE + 6) * k : r.top + 6;
    x = Math.max(r.left + 6, Math.min(x, r.left + r.width - mw - 6));
    y = Math.max(r.top + 6, Math.min(y, r.top + r.height - mh - 6));
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  }
  const positionMenu = () => menu && placeBox(menu.el, menu.slot);
  function select(i, sub = null) {
    if (!menu || i < 0) return;
    menu.sel = i;
    if (sub !== null) menu.sub = sub;
    menu.items.forEach((it, j) => {
      if (it.buttons) it.buttons.forEach((b, k) => b.setAttribute('aria-selected', String(j === i && k === menu.sub)));
      else menu.buttons[j].setAttribute('aria-selected', String(j === i));
    });
  }
  function move(d) {
    if (!menu) return;
    const n = menu.items.length;
    for (let k = 1; k <= n; k++) {
      const i = (menu.sel + d * k + n * 4) % n;
      if (menu.items[i].on) return select(i);
    }
  }
  function side(d) {
    const it = menu?.items[menu.sel];
    if (it?.row) select(menu.sel, (menu.sub + d + it.row.length) % it.row.length);
  }
  function choose(i, sub = menu?.sub || 0) {
    if (!menu) return;
    const it = menu.items[i];
    if (!it?.on) return;
    const slot = menu.slot;
    closeMenu();
    if (it.act === 'close') return;
    // (the play view decides – a wave or an emote within the limits shows over you through emote(), a game opens
    // the picker through rps())
    if (it.act === 'emote') host.post({ type: 'emu-world-act', act: 'emote', emote: it.row[sub] || it.row[0], slot });
    else host.post({ type: 'emu-world-act', act: it.act, slot });
  }
  function closeMenu() {
    if (!menu) return;
    const m = menu;
    menu = null;
    m.el.remove();
    removeEventListener('keydown', onKey, true);
    removeEventListener('keyup', swallow, true);
    removeEventListener('pointerdown', outside, true);
    aHeld = true; // the A that chose doesn't open it again
    if (!m.wasPaused) host.resume();
  }
  function swallow(e) {
    e.stopImmediatePropagation();
    e.preventDefault();
  }
  function onKey(e) {
    if (!menu) return;
    swallow(e);
    const b = host.keyButton?.(e);
    const k = e.key;
    if (k === 'ArrowDown' || b === 'down') move(1);
    else if (k === 'ArrowUp' || b === 'up') move(-1);
    else if (k === 'ArrowLeft' || b === 'left') side(-1);
    else if (k === 'ArrowRight' || b === 'right') side(1);
    else if (k === 'Enter' || k === ' ' || b === 'a') choose(menu.sel);
    else if (k === 'Escape' || k === 'Backspace' || b === 'b') closeMenu();
  }
  function outside(e) {
    if (menu && !menu.el.contains(e.target)) closeMenu();
  }

  // ---- rock-paper-scissors: the picker (shared/rps.mjs through the play view) ----------------------------------------
  // While you pick, the game waits (at most the 10 s of the round) and the keys are the picker's: left/right, A, B
  // to pass. Once you picked the game runs on; the result shows as the hands over both heads, and here in words.
  const HANDS_KEYS = ['rock', 'paper', 'scissors'];
  function rpsView(v) {
    if (!v) return closeRps();
    const L = cfg.labels;
    const pl = cfg.players[v.other] || { name: v.other, color: '#ebe6da' };
    if (!rpsUi || rpsUi.id !== v.id) {
      closeRps();
      closeMenu();
      const el = document.createElement('div');
      el.className = 'sw-menu sw-rps';
      el.setAttribute('role', 'dialog');
      el.style.setProperty('--c', pl.color || '#ebe6da');
      const who = document.createElement('div');
      who.className = 'sw-who';
      const name = document.createElement('span');
      who.append(document.createElement('i'), name);
      const hands = document.createElement('div');
      hands.className = 'sw-hands';
      const buttons = HANDS_KEYS.map((h, k) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.append(artCanvas(h, cfg.players[cfg.me]?.color || '#ebe6da', 3), document.createTextNode(L[`hand_${h}`] || h));
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          rpsPick(k);
        });
        b.addEventListener('pointerenter', () => rpsSel(k));
        hands.append(b);
        return b;
      });
      const time = document.createElement('div');
      time.className = 'sw-time';
      const bar = document.createElement('i');
      time.append(bar);
      const say = document.createElement('div');
      say.className = 'sw-say';
      say.setAttribute('aria-live', 'polite');
      const keys = document.createElement('div');
      keys.className = 'sw-keys';
      el.append(who, hands, time, say, keys);
      document.body.append(el);
      rpsUi = { id: v.id, el, name, buttons, bar, say, keys, sel: 1, modal: false, wasPaused: false, pad: {}, closeAt: 0 };
      rpsSel(1);
    }
    const u = rpsUi;
    u.v = v;
    u.name.textContent = `${L.rpsWith ? L.rpsWith.replace('{name}', pl.name) : `Rock-paper-scissors · ${pl.name}`}${v.bo === 3 ? ` · ${L.bestOf3 || 'best of 3'} ${v.wins.me}–${v.wins.them}` : ''}`;
    const picking = v.phase === 'pick';
    u.buttons.forEach((b, k) => {
      b.disabled = !picking;
      b.classList.toggle('picked', v.hand === k && !picking);
    });
    u.keys.textContent = picking ? L.rpsKeys || '◀ ▶ choose · A pick · B pass' : '';
    u.bar.parentNode.style.visibility = picking ? '' : 'hidden';
    u.say.textContent = rpsSay(v, pl.name);
    // the modal part: the keys and the paused game, only while picking on the overworld
    const want = picking && drawable(t, cam, learner.cb2);
    if (want && !u.modal) rpsModal(true);
    else if (!want && u.modal) rpsModal(false);
    if (v.phase === 'end') u.closeAt = u.closeAt || performance.now() + 2600;
    placeBox(u.el, null);
  }
  function rpsSay(v, name) {
    return rpsLine(v, cfg.me, cfg.labels, name, (h) => cfg.labels[`hand_${HANDS_KEYS[h]}`] || HANDS_KEYS[h]);
  }
  function rpsModal(on) {
    const u = rpsUi;
    if (!u || u.modal === on) return;
    u.modal = on;
    if (on) {
      u.wasPaused = host.paused();
      if (!u.wasPaused) host.pause();
      addEventListener('keydown', rpsKey, true);
      addEventListener('keyup', swallow, true);
    } else {
      removeEventListener('keydown', rpsKey, true);
      removeEventListener('keyup', swallow, true);
      aHeld = true;
      if (!u.wasPaused) host.resume();
    }
  }
  function rpsSel(k) {
    if (!rpsUi) return;
    rpsUi.sel = (k + 3) % 3;
    rpsUi.buttons.forEach((b, j) => b.setAttribute('aria-selected', String(j === rpsUi.sel)));
  }
  function rpsPick(k) {
    const u = rpsUi;
    if (!u || u.v?.phase !== 'pick') return;
    rpsSel(k);
    host.post({ type: 'emu-world-rps', id: u.id, hand: k });
    rpsModal(false);
  }
  function rpsPass() {
    const u = rpsUi;
    if (!u) return;
    host.post({ type: 'emu-world-rps', id: u.id, pass: true });
    rpsModal(false);
  }
  function rpsKey(e) {
    if (!rpsUi?.modal) return;
    swallow(e);
    const b = host.keyButton?.(e);
    const k = e.key;
    if (k === 'ArrowLeft' || b === 'left') rpsSel(rpsUi.sel - 1);
    else if (k === 'ArrowRight' || b === 'right') rpsSel(rpsUi.sel + 1);
    else if (k === '1' || k === '2' || k === '3') rpsPick(Number(k) - 1);
    else if (k === 'Enter' || k === ' ' || b === 'a') rpsPick(rpsUi.sel);
    else if (k === 'Escape' || k === 'Backspace' || b === 'b') rpsPass();
  }
  function closeRps() {
    if (!rpsUi) return;
    rpsModal(false);
    rpsUi.el.remove();
    rpsUi = null;
  }

  // a controller in the menu and the picker: D-pad, A, B (standard mapping)
  function pollPad() {
    const box = menu || (rpsUi?.modal ? rpsUi : null);
    if (rpsUi?.closeAt && performance.now() > rpsUi.closeAt) closeRps();
    if (rpsUi && !menu) placeBox(rpsUi.el, null);
    if (rpsUi?.v?.phase === 'pick') rpsUi.bar.style.transform = `scaleX(${Math.max(0, Math.min(1, (rpsUi.v.untilPage - performance.now()) / 10000))})`;
    if (!box) return;
    const pad = [...(navigator.getGamepads?.() || [])].find(Boolean);
    if (!pad) return;
    const was = box.pad;
    const now = {
      a: pad.buttons[0]?.pressed, b: pad.buttons[1]?.pressed, up: pad.buttons[12]?.pressed || pad.axes[1] < -0.5, down: pad.buttons[13]?.pressed || pad.axes[1] > 0.5,
      left: pad.buttons[14]?.pressed || pad.axes[0] < -0.5, right: pad.buttons[15]?.pressed || pad.axes[0] > 0.5,
    };
    box.pad = now;
    const edge = (k) => now[k] && !was[k] && was[k] !== undefined;
    if (box === menu) {
      if (edge('down')) move(1);
      if (edge('up')) move(-1);
      if (edge('left')) side(-1);
      if (edge('right')) side(1);
      if (edge('a')) choose(menu.sel);
      else if (edge('b')) closeMenu();
    } else {
      if (edge('left')) rpsSel(rpsUi.sel - 1);
      if (edge('right')) rpsSel(rpsUi.sel + 1);
      if (edge('a')) rpsPick(rpsUi.sel);
      else if (edge('b')) rpsPass();
    }
  }
  const padTimer = setInterval(pollPad, 50);

  raf = requestAnimationFrame(frame);
  return {
    t,
    setConfig(c) {
      cfg = { ...cfg, ...c, players: c.players || cfg.players, labels: c.labels || cfg.labels, actions: c.actions || cfg.actions };
      for (const [slot, el] of tags) if (!cfg.players[slot] || slot === cfg.me) (el.remove(), tags.delete(slot));
      if (!cfg.enabled) closeMenu();
      watchKey = '';
      rewatch();
    },
    partner(slot, wire) {
      if (stopped || slot === cfg.me) return;
      const at = performance.now(); // (this page's clock – the play view's starts elsewhere)
      const s = unpackState(wire);
      if (!s) return;
      if (!tracks.has(slot)) tracks.set(slot, new Track());
      tracks.get(slot).push(s, at);
      // what changes seldom comes now and then: who follows them, how big their map is
      if (s.ext && 'follower' in s.ext) leads.set(slot, s.ext.follower);
      if (s.ext?.size) sizes.set(slot, s.ext.size);
    },
    gone(slot) {
      tracks.delete(slot);
      anim.delete(slot);
      followers.delete(slot);
      leads.delete(slot);
      sizes.delete(slot);
      tags.get(slot)?.remove();
      tags.delete(slot);
      if (menu?.slot === slot) closeMenu();
    },
    emote(slot, name) {
      if (!ART[name]) return;
      const now = performance.now();
      bubbles.set(slot, { art: name, start: now, until: now + WAVE_MS });
    },
    rps(v) {
      // (the page's own clock for the countdown: the play view's runs elsewhere)
      if (v && v.phase === 'pick') v = { ...v, untilPage: performance.now() + Math.max(0, v.leftMs ?? 10000) };
      rpsView(v);
    },
    rpsRound(r) {
      const now = performance.now();
      for (const [slot, hand] of Object.entries(r?.hands || {})) {
        if (!HAND_ART[hand]) continue;
        bubbles.set(slot, { art: HAND_ART[hand], start: now, until: now + HAND_MS, lose: !!r.winner && r.winner !== slot });
      }
    },
    canPresent: () => !stopped && cfg.enabled && !!cam && drawable(t, cam, learner.cb2),
    onWatched(bytes) {
      // (bytes still on their way for the list before: another length – and a moved SaveBlock1 is checked by readCamera)
      if (!watched || !bytes || bytes.length !== 4 + watched.total) return;
      watched.bytes = bytes.subarray(4);
      if (!stopped) render(performance.now()); // (the picture these bytes belong to is being drawn right now)
    },
    input(bits) {
      inputBits = bits >>> 0;
    },
    rewatch() {
      watchKey = '';
      watched = null;
      rewatch();
    },
    menuOpen: () => !!menu || !!rpsUi?.modal,
    debug() {
      const now = performance.now();
      const it = menu?.items[menu.sel];
      return {
        supported: true, game: t.id, enabled: cfg.enabled, follow: cfg.follow, lead: cfg.lead, cam, shown, learned: learner.cb2, perFrame: !!watched?.bytes,
        menu: menu ? { slot: menu.slot, sel: it?.row ? `emote:${it.row[menu.sub]}` : it?.act } : null,
        rps: rpsUi ? { id: rpsUi.id, phase: rpsUi.v?.phase, modal: rpsUi.modal, sel: rpsUi.sel, say: rpsUi.say.textContent } : null,
        bubbles: Object.fromEntries([...bubbles].filter(([, b]) => now < b.until).map(([slot, b]) => [slot, b.art])),
        local: cam ? readPlayer(t, reader(), cam) : null, sprite: lastSprite, icons: !!icons,
        followers: fdraw, conns,
        occlusion: occ ? { layout: occ.layout, covered } : null, popup,
        partners: Object.fromEntries([...tracks].map(([slot, tr]) => {
          const conv = conns ? (st) => inLocalFrame(conns, st, sizes.get(slot)) : null;
          const s = tr.sample(now, conv);
          return [slot, { s, pos: s && cam ? screenPos(t, cam, s) : null, delay: Math.round(tr.delay), lead: leads.get(slot) ?? null }];
        })),
      };
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      clearInterval(padTimer);
      closeMenu();
      closeRps();
      layer.remove();
      style.remove();
      host.watch?.([]);
    },
  };
}
