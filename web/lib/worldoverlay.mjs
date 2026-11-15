// Shared World, the player page's half (docs/MULTIPLAYER.md › 9): the partners drawn over the game's picture, their
// names, the wave bubble, and the little menu when you walk up to a partner and press A (Trade / Battle / Wave).
// Nothing is written into the game: souldew reads where the camera is (every picture: the native player sends those
// few bytes with each frame, web/lib/nativeplayer.mjs WATCH; the browser player reads its memory directly) and draws
// the partners' sprites – taken from this computer's ROM – on a canvas exactly on top of the picture.
//
// The play view (web/lib/sharedworld.mjs) drives it through window.__world: config(), partner(), gone(), wave(). This
// page tells it the local player's state ('emu-world', ~15 a second) and what was picked in the menu ('emu-world-act').
import {
  worldTable, watchRanges, rangeReader, chainReaders, readCamera, readPlayer, readLocalSprite, drawable, OverworldLearner,
  Track, unpackState, screenPos, facedPartner, gfxFor, kindFor, animFor, GBA_KEY, TILE,
} from '/shared/world.mjs';
import { gen3Avatar, animFrame, liveFrame, avatarPalette } from '/shared/worldsprites.mjs';

const STATE_MS = 66; // the local state to the play view (it decides what goes out)
const WAVE_MS = 2600;
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
`;

// a small waving hand, original pixel art (9×8), for the wave bubble
const HAND = ['..#.#.#..', '..#.#.#.#', '#.#.#.#.#', '#.#######', '#########', '.########', '..######.', '...####..'];

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
    wave: (slot) => st?.wave(slot),
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
  if (host.system !== 'gba') return { t: null, setConfig() {}, partner() {}, gone() {}, wave() {}, onWatched() {}, input() {}, debug: () => ({ supported: false }), stop() {} };
  const [{ findEntry }, addresses, rom] = await Promise.all([
    import('/shared/live/parse.mjs'),
    fetch('/shared/data/addresses.json').then((r) => r.json()),
    fetch(host.romUrl).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? new Uint8Array(b) : null)),
  ]);
  const code = rom && rom.length > 0xc0 ? String.fromCharCode(...rom.subarray(0xac, 0xb0)) : cfg.code || '';
  const entry = findEntry(addresses, { platform: 'gba', code });
  const t = worldTable(entry, rom ? rom[0xbc] : 0);
  if (!t || !rom) return { t: null, setConfig() {}, partner() {}, gone() {}, wave() {}, onWatched() {}, input() {}, debug: () => ({ supported: false, code }), stop() {} };
  return world(host, t, rom);
}

function world(host, t, rom) {
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

  let cfg = { me: null, players: {}, enabled: false, actions: {}, labels: {} };
  const tracks = new Map(); // slot → Track
  const tags = new Map(); // slot → name tag element
  const avatars = new Map(); // gfx id → { w, h, frames: [canvas], anims } | null
  const anim = new Map(); // slot → { time, lastX, lastY }
  const waves = new Map(); // slot → until (ms)
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
      avatars.set(gfx, a ? { ...a, vtop, frames: a.frames.map((f) => toCanvas(f, a.w, a.h)) } : null);
    }
    return avatars.get(gfx);
  };

  // ---- reading the game ---------------------------------------------------------------------------------------------
  const mirror = (addr, len) => host.read(addr, len);
  /** This picture's bytes where the native player sent them, else the memory (mirror or the browser emulator's own). */
  const reader = () => (watched?.bytes ? chainReaders(rangeReader(watched.ranges, watched.bytes), mirror) : mirror);
  function rewatch() {
    if (!host.watch) return;
    const p = t.saveBlock1Ptr ? host.read(t.saveBlock1Ptr, 4) : null;
    const sb1 = t.saveBlock1 || (p && p.length === 4 ? (p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24)) >>> 0 : 0);
    const av = host.read(t.playerAvatar + 4, 1);
    const spriteId = av && av.length ? av[0] : null;
    const key = `${sb1}:${spriteId}:${cfg.enabled}`;
    if (key === watchKey) return;
    watchKey = key;
    if (!cfg.enabled) {
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

  function drawBubble(x, y, color, age) {
    // a white speech bubble (15×13) with the hand, bobbing once when it appears
    const bob = age < 160 ? Math.round(-2 * Math.sin((age / 160) * Math.PI)) : 0;
    const bx = Math.round(x) - 7;
    const by = Math.round(y) - 15 + bob;
    ctx.fillStyle = '#26232c';
    ctx.fillRect(bx + 1, by, 13, 13);
    ctx.fillRect(bx, by + 1, 15, 11);
    ctx.fillRect(bx + 6, by + 13, 3, 2);
    ctx.fillStyle = '#fbf8f1';
    ctx.fillRect(bx + 1, by + 1, 13, 11);
    ctx.fillRect(bx + 7, by + 12, 1, 2);
    ctx.fillStyle = color;
    HAND.forEach((row, j) => [...row].forEach((ch, i) => ch === '#' && ctx.fillRect(bx + 3 + i, by + 3 + j, 1, 1)));
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
    // the partners see us even while our switch is off (it says what *we* see)
    if (now - lastState >= STATE_MS) {
      lastState = now;
      sendState(read, cfg.enabled && drawable(t, cam, learner.cb2));
    }
    const rect = placeLayer();
    if (!rect || !cfg.enabled || !host.ready()) {
      near = 0;
      canvas.style.opacity = '0';
      for (const el of tags.values()) el.style.opacity = '0';
      return;
    }
    const can = drawable(t, cam, learner.cb2);
    const target = can ? 1 - (cam.fade || 0) / 16 : 0;
    shown = target; // (the CSS transition smooths it)
    canvas.style.opacity = String(Math.round(shown * 100) / 100);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const list = [];
    for (const [slot, tr] of tracks) {
      const s = tr.sample(now);
      const pos = can && s ? screenPos(t, cam, s) : null;
      list.push({ slot, s, pos });
    }
    // the partners behind the local player first, then the player's own sprite again (only where it covers one of
    // them), then those in front: depth as in the game, by the feet's line
    const spr = can ? readLocalSprite(t, read) : null;
    const localFeet = spr ? spr.y + spr.h : t.anchor.y + TILE;
    const drawn = list.filter((p) => p.pos).sort((a, b) => a.pos.y - b.pos.y);
    let localDone = false;
    for (const p of drawn) {
      if (!localDone && p.pos.y + TILE > localFeet) {
        drawLocal(spr, drawn);
        localDone = true;
      }
      drawPartner(p, now);
    }
    if (!localDone) drawLocal(spr, drawn);
    // names and waves
    for (const p of list) {
      const el = tagFor(p.slot);
      if (!el) continue;
      const vis = !!p.pos && can;
      el.style.opacity = vis ? String(Math.round(shown * 100) / 100) : '0';
      el.style.pointerEvents = vis ? 'auto' : 'none';
      const until = waves.get(p.slot);
      const waving = vis && until && now < until;
      const a = vis ? avatarFor(gfxFor(t, p.s.kind, p.s.gender)) : null;
      const head = vis ? p.pos.y + TILE - (a?.h || 32) + (a?.vtop || 0) : 0;
      if (vis) {
        // the name just above the head – above the bubble while they wave
        el.style.left = `${((p.pos.x + TILE / 2) / t.screen.w) * 100}%`;
        el.style.top = `${((head - (waving ? 18 : 1)) / t.screen.h) * 100}%`;
      }
      if (waving) drawBubble(p.pos.x + TILE / 2, head - 1, cfg.players[p.slot]?.color || '#fff', now - (until - WAVE_MS));
    }
    const mine = waves.get(cfg.me);
    if (can && mine && now < mine) {
      const la = lastLocalGfx !== null ? avatarFor(lastLocalGfx) : null;
      const head = spr ? spr.y + (la?.vtop || 0) : t.anchor.y - 8;
      drawBubble(spr ? spr.x + spr.w / 2 : t.anchor.x + 8, head - 1, cfg.players[cfg.me]?.color || '#fff', now - (mine - WAVE_MS));
    }
    interact(now, read, can, list);
    near = drawn.length;
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
    const img = a.frames[c.img] || a.frames[0];
    const x = Math.round(p.pos.x + TILE / 2 - a.w / 2);
    const y = Math.round(p.pos.y + TILE - a.h);
    if (c.flip) {
      ctx.save();
      ctx.translate(x + a.w, y);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    } else ctx.drawImage(img, x, y);
    p.box = { x, y, w: a.w, h: a.h };
  }

  /** The local player's own sprite, again – only when a partner behind them overlaps it (their exact current frame). */
  function drawLocal(spr, drawn) {
    if (!spr) return;
    lastSprite = spr;
    const over = drawn.some((p) => p.box && p.pos.y + TILE <= spr.y + spr.h && p.box.x < spr.x + spr.w && p.box.x + p.box.w > spr.x && p.box.y < spr.y + spr.h && p.box.y + p.box.h > spr.y);
    if (!over) return;
    const me = readPlayer(t, reader(), cam);
    const pal = me && avatarPalette(rom, t, gfxFor(t, me.kind, me.gender), spriteCache);
    const px = pal && liveFrame(rom, spr, pal, frameCache);
    if (!px) return;
    const key = `c:${spr.images}:${spr.animNum}:${spr.cmd}`;
    if (!frameCache.has(key)) frameCache.set(key, toCanvas(px, spr.w, spr.h));
    const img = frameCache.get(key);
    if (spr.flip) {
      ctx.save();
      ctx.translate(spr.x + spr.w, spr.y);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    } else ctx.drawImage(img, spr.x, spr.y);
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
    host.post({ type: 'emu-world', st: onOverworld ? { ...me, fam: t.fam } : { hidden: true, fam: t.fam }, drawn: can, near });
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
  function openMenu(slot) {
    if (menu || !cfg.players[slot]) return;
    const pl = cfg.players[slot];
    const L = cfg.labels;
    const ac = cfg.actions[slot] || {};
    const items = [
      { act: 'trade', label: L.trade || 'Trade', on: !!ac.trade },
      { act: 'battle', label: L.battle || 'Battle', on: !!ac.battle },
      { act: 'wave', label: L.wave || 'Wave', on: true },
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
    const buttons = items.map((it, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = it.label;
      b.disabled = !it.on;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        choose(i);
      });
      b.addEventListener('pointerenter', () => it.on && select(i));
      el.append(b);
      return b;
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
    menu = { el, slot, items, buttons, sel: -1, wasPaused, pad: {} };
    select(items.findIndex((x) => x.on));
    positionMenu();
    addEventListener('keydown', onKey, true);
    addEventListener('keyup', swallow, true);
    addEventListener('pointerdown', outside, true);
  }
  function positionMenu() {
    if (!menu) return;
    const r = host.rect();
    const p = tracks.get(menu.slot)?.sample(performance.now());
    const pos = p && cam ? screenPos(t, cam, p) : null;
    const k = r.width / t.screen.w;
    const mw = menu.el.offsetWidth;
    const mh = menu.el.offsetHeight;
    let x = pos ? r.left + (pos.x + TILE / 2) * k - mw / 2 : r.left + r.width / 2 - mw / 2;
    let y = pos ? r.top + (pos.y - 20) * k - mh : r.top + r.height / 2 - mh / 2;
    if (y < r.top + 6) y = pos ? r.top + (pos.y + TILE + 6) * k : r.top + 6;
    x = Math.max(r.left + 6, Math.min(x, r.left + r.width - mw - 6));
    y = Math.max(r.top + 6, Math.min(y, r.top + r.height - mh - 6));
    menu.el.style.left = `${Math.round(x)}px`;
    menu.el.style.top = `${Math.round(y)}px`;
  }
  function select(i) {
    if (!menu || i < 0) return;
    menu.sel = i;
    menu.buttons.forEach((b, j) => b.setAttribute('aria-selected', String(j === i)));
  }
  function move(d) {
    if (!menu) return;
    const n = menu.items.length;
    for (let k = 1; k <= n; k++) {
      const i = (menu.sel + d * k + n * 4) % n;
      if (menu.items[i].on) return select(i);
    }
  }
  function choose(i) {
    if (!menu) return;
    const it = menu.items[i];
    if (!it?.on) return;
    const slot = menu.slot;
    closeMenu();
    if (it.act === 'close') return;
    if (it.act === 'wave') waves.set(cfg.me, performance.now() + WAVE_MS);
    host.post({ type: 'emu-world-act', act: it.act, slot });
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
    else if (k === 'Enter' || k === ' ' || b === 'a') choose(menu.sel);
    else if (k === 'Escape' || k === 'Backspace' || b === 'b') closeMenu();
  }
  function outside(e) {
    if (menu && !menu.el.contains(e.target)) closeMenu();
  }
  // a controller in the menu: D-pad, A, B (standard mapping)
  function pollPad() {
    if (!menu) return;
    const pad = [...(navigator.getGamepads?.() || [])].find(Boolean);
    if (!pad) return;
    const was = menu.pad;
    const now = { a: pad.buttons[0]?.pressed, b: pad.buttons[1]?.pressed, up: pad.buttons[12]?.pressed || pad.axes[1] < -0.5, down: pad.buttons[13]?.pressed || pad.axes[1] > 0.5 };
    menu.pad = now;
    if (now.down && !was.down) move(1);
    if (now.up && !was.up) move(-1);
    if (now.a && !was.a && was.a !== undefined) choose(menu.sel);
    else if (now.b && !was.b && was.b !== undefined) closeMenu();
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
    },
    gone(slot) {
      tracks.delete(slot);
      anim.delete(slot);
      tags.get(slot)?.remove();
      tags.delete(slot);
      if (menu?.slot === slot) closeMenu();
    },
    wave(slot) {
      waves.set(slot, performance.now() + WAVE_MS);
    },
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
    menuOpen: () => !!menu,
    debug() {
      const now = performance.now();
      return {
        supported: true, game: t.id, enabled: cfg.enabled, cam, shown, learned: learner.cb2, perFrame: !!watched?.bytes, menu: menu ? { slot: menu.slot, sel: menu.items[menu.sel]?.act } : null,
        local: cam ? readPlayer(t, reader(), cam) : null, sprite: lastSprite,
        partners: Object.fromEntries([...tracks].map(([slot, tr]) => {
          const s = tr.sample(now);
          return [slot, { s, pos: s && cam ? screenPos(t, cam, s) : null, delay: Math.round(tr.delay) }];
        })),
      };
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      clearInterval(padTimer);
      closeMenu();
      layer.remove();
      style.remove();
      host.watch?.([]);
    },
  };
}
