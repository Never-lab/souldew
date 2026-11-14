// The DS, GBA and Game Boy in souldew's fast player: the native host (native/retro-host) runs a libretro core – melonDS
// DS with its JIT, mGBA, Gambatte – as a native program and speaks the 3DS host's protocol (server/lib/ctr.mjs) with a
// few more messages (see the header of native/retro-host/retrohost.c). Sessions, the page's stream and the command
// checks are the 3DS ones (CtrSessions); this module knows the cores, their memory and their settings.
//
// tools/native/<platform>-<arch>/ (bundled with the app, or in the data folder's tools):
//   retrohost[.exe]                                   the host
//   melondsds_libretro.dylib | .dll | .so             DS
//   mgba_libretro.*                                   GBA
//   gambatte_libretro.*                               Game Boy / Game Boy Color
// When the host or a core is missing, the play view uses the built-in browser emulator (player.html) as before.
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BUNDLED_TOOLS, TOOLS_DIR, DATA_DIR, DEV, APP_ROOT } from './paths.mjs';
import { httpError } from './fsutil.mjs';
import { CtrSessions, MSG, splitMessages, PLATFORM_DIR } from './ctr.mjs';

const EXE = process.platform === 'win32' ? 'retrohost.exe' : 'retrohost';
const LINK_EXE = process.platform === 'win32' ? 'linkhost.exe' : 'linkhost';
const LIB_EXT = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';

/** Messages of the native host on top of the 3DS host's (MSG); LINPUT / SEATSRAM come from the link host only. */
export const NMSG = { ...MSG, RAM: 8, SRAM: 9, MEMREAD: 11, LINPUT: 12, SEATSRAM: 14 };
/** Commands the page may send it. */
export const NCMD = { INPUT: 1, SPEED: 2, SAVE: 3, LOAD: 4, QUIT: 6, RESET: 7, WRITE: 9, FLUSH: 10, SRAM: 11, RESYNC: 12, STEP: 13 };

/** Commands of a link session (native/link-host/linkhost.c): no states, cheats, steps or memory access from a page. */
export const LCMD = { INPUT: 1, SPEED: 2, QUIT: 6, FLUSH: 10, RESYNC: 12, VIEW: 20, RINPUT: 21, UNTIL: 24 };
/** Systems the link host plays (its mGBA backend); the DS backend comes later (docs/MULTIPLAYER.md). */
export const LINK_SYSTEMS = ['gba', 'gb', 'gbc'];
export const MAX_LINK_SEATS = 4;

const MAX_SAVE = 4 * 1024 * 1024; // the biggest battery save of a DS game is 8 Mbit; GBA / GB far less

/**
 * Per system: the core, the memory the live reader reads (bus address, length – what player.html's read() maps:
 * DS main RAM, GBA EWRAM + IWRAM, Game Boy WRAM banks 0 and 1) and the core options souldew sets. `id` names the
 * core for save states (a state of the browser emulator's core can't be loaded here, and the other way round).
 */
export const NATIVE_CORES = {
  nds: {
    id: 'melonds-native',
    lib: 'melondsds_libretro',
    ram: [[0x02000000, 0x400000]],
    options: {
      melonds_console_mode: 'ds', // DS mode: the built-in BIOS/firmware, save states – no DSi system files needed
      melonds_sysfile_mode: 'builtin',
      melonds_boot_mode: 'direct',
      melonds_jit_enable: 'enabled',
      melonds_render_mode: 'software',
      melonds_threaded_renderer: 'enabled', // the 3D picture is drawn on its own core
      melonds_touch_mode: 'touch', // a click is a tap at that spot
      melonds_show_cursor: 'disabled',
      melonds_number_of_screen_layouts: '1',
      melonds_screen_layout1: 'top-bottom', // the page arranges the two screens itself (side by side too)
      melonds_screen_gap: '0',
      melonds_show_current_layout: 'disabled',
      melonds_show_bios_warnings: 'disabled',
      melonds_network_mode: 'disabled',
      melonds_mic_input: 'silence',
    },
  },
  gba: {
    id: 'mgba-native',
    lib: 'mgba_libretro',
    ram: [[0x02000000, 0x40000], [0x03000000, 0x8000]],
    options: { mgba_skip_bios: 'ON', mgba_use_bios: 'OFF', mgba_idle_optimization: 'Remove Known' },
  },
  gb: { id: 'gambatte-native', lib: 'gambatte_libretro', ram: [[0xc000, 0x2000]], options: {} },
};
NATIVE_CORES.gbc = NATIVE_CORES.gb;

/** Where the native tools are: the first folder with the host in it. */
export function nativeDirs() {
  return [join(BUNDLED_TOOLS, 'native', PLATFORM_DIR), join(TOOLS_DIR, 'native', PLATFORM_DIR), ...(DEV ? [join(APP_ROOT, 'tools', 'native', PLATFORM_DIR)] : [])];
}

/** { ok, dir, host, cores: { nds: path|null, gba, gb, gbc } } – ok when the host and at least one core are there. */
export function nativeTools({ dirs = nativeDirs(), exists = existsSync } = {}) {
  const dir = dirs.find((d) => exists(join(d, EXE)));
  if (!dir) return { ok: false, missing: 'host', cores: {} };
  const cores = {};
  for (const [sys, c] of Object.entries(NATIVE_CORES)) {
    const p = join(dir, `${c.lib}.${LIB_EXT}`);
    cores[sys] = exists(p) ? p : null;
  }
  return { ok: Object.values(cores).some(Boolean), dir, host: join(dir, EXE), cores };
}

/** The core folder of a game / run slot (cores keep a few files there; the battery save itself goes through souldew). */
export function nativeSaveDir(key) {
  const h = createHash('sha1').update(String(key)).digest('hex').slice(0, 16);
  return join(DATA_DIR, DEV ? 'runs/.native' : 'native', 'saves', h);
}

/** The link host (tools/native/<platform>/linkhost), or null when this build has none. */
export function linkTool({ dirs = nativeDirs(), exists = existsSync } = {}) {
  const dir = dirs.find((d) => exists(join(d, LINK_EXE)));
  return dir ? join(dir, LINK_EXE) : null;
}

/**
 * The link host's arguments: every seat's ROM and battery save (paths – the server's own), the local seat, net mode
 * with the input delay, the shared clock start, and the local seat's memory for live tracking.
 */
export function linkArgs({ system, roms, saves, local, delay, rtc }) {
  const c = NATIVE_CORES[system];
  if (!c || !LINK_SYSTEMS.includes(system)) throw httpError(400, 'Für dieses System gibt es noch kein Linken', 'linkSystem');
  if (!Array.isArray(roms) || roms.length < 2 || roms.length > MAX_LINK_SEATS) throw httpError(400, 'Ungültige Plätze', 'linkSeats');
  if (!Number.isInteger(local) || local < 0 || local >= roms.length) throw httpError(400, 'Ungültiger Platz', 'linkSeats');
  const d = Math.max(1, Math.min(60, Math.round(Number(delay) || 4)));
  const args = [];
  roms.forEach((r, i) => args.push('--rom', r, '--sram', saves[i] || '-'));
  args.push('--local', String(local), '--net', '--delay', String(d), '--rtc', String(Math.round(Number(rtc) || Date.now())));
  for (const [addr, len] of c.ram) args.push('--ram', `0x${addr.toString(16)}:0x${len.toString(16)}`);
  return args;
}

/** Commands a page may send a link session: input, speed, flush, resync, view, a peer's buttons, the end frame. */
export function checkLinkCommands(body) {
  const { messages, rest } = splitMessages(body);
  if (rest.length || !messages.length) throw httpError(400, 'Ungültiger Befehl', 'badCommand');
  const limits = {
    [LCMD.INPUT]: [17, 32], [LCMD.SPEED]: [4, 4], [LCMD.QUIT]: [0, 0], [LCMD.FLUSH]: [0, 0], [LCMD.RESYNC]: [0, 0], [LCMD.VIEW]: [4, 4],
    [LCMD.RINPUT]: [12, 8 + 4 * 4096], [LCMD.UNTIL]: [4, 4],
  };
  for (const m of messages) {
    const l = limits[m.type];
    if (!l || m.payload.length < l[0] || m.payload.length > l[1] || (m.type === LCMD.RINPUT && (m.payload.length - 8) % 4)) throw httpError(400, 'Ungültiger Befehl', 'badCommand');
  }
  return body;
}

/** The host's arguments for `system` (the paths are the server's own – nothing here comes from the page). */
export function hostArgs({ system, core, rom, saveDir, systemDir, sram = null }) {
  const c = NATIVE_CORES[system];
  if (!c) throw httpError(400, 'Kein nativer Kern für dieses System', 'nativeSystem');
  const args = ['--core', core, '--rom', rom, '--system', systemDir, '--save', saveDir];
  if (sram) args.push('--sram', sram);
  for (const [addr, len] of c.ram) args.push('--ram', `0x${addr.toString(16)}:0x${len.toString(16)}`);
  for (const [k, v] of Object.entries(c.options)) args.push('--option', `${k}=${v}`);
  return args;
}

/**
 * Commands a page may send the native host: known types, sane sizes. A cheat (WRITE) carries an address and at most
 * 64 KB; the host only writes inside the game's RAM regions.
 */
export function checkNativeCommands(body) {
  const { messages, rest } = splitMessages(body);
  if (rest.length || !messages.length) throw httpError(400, 'Ungültiger Befehl', 'badCommand');
  const limits = {
    [NCMD.INPUT]: [17, 32], [NCMD.SPEED]: [4, 4], [NCMD.SAVE]: [0, 0], [NCMD.LOAD]: [1, 64 * 1024 * 1024], [NCMD.QUIT]: [0, 0],
    [NCMD.RESET]: [0, 0], [NCMD.WRITE]: [5, 4 + 65536], [NCMD.FLUSH]: [0, 0], [NCMD.SRAM]: [1, MAX_SAVE], [NCMD.RESYNC]: [0, 0], [NCMD.STEP]: [4, 4],
  };
  for (const m of messages) {
    const l = limits[m.type];
    if (!l || m.payload.length < l[0] || m.payload.length > l[1]) throw httpError(400, 'Ungültiger Befehl', 'badCommand');
  }
  return body;
}

/** A battery save that is all 0xFF or all 0x00 is an empty cartridge, not a save. */
export const blankSave = (b) => !b?.length || b.every((x) => x === 0xff) || b.every((x) => x === 0);

export class NativeSessions extends CtrSessions {
  /**
   * `writeSave(file, bytes)`: stores a battery save the host sends after its page has gone (the player closed right
   * after the game saved – the page can't wait for the host's last word). Without it such a save is dropped.
   */
  constructor({ writeSave = null, ...opts } = {}) {
    super(opts);
    this.keepTypes = [NMSG.EVENT, NMSG.STATE, NMSG.SRAM, NMSG.LINPUT, NMSG.SEATSRAM];
    this.writeSave = writeSave;
    this.label = 'fast player';
  }

  onMessage(s, m, attached) {
    if (m.type !== NMSG.SRAM || attached || !s.saveFile || !this.writeSave) return;
    const bytes = Buffer.from(m.data.subarray(8));
    if (blankSave(bytes)) return;
    try {
      this.writeSave(s.saveFile, bytes);
    } catch {
      // best effort – the page's own copy is on disk already
    }
  }

  /**
   * Start `rom` (a path) on `system` with the core folder of `key`; `save` = the battery save souldew has for it
   * (bytes) or null. Ends a session that still runs.
   */
  startNative({ rom, key, system, tools, save = null, saveFile = null }) {
    const core = tools.cores?.[system];
    if (!core) throw httpError(409, 'Der schnelle Emulator fehlt für dieses System', 'nativeMissing');
    this.stop();
    const saveDir = nativeSaveDir(key);
    const systemDir = join(DATA_DIR, DEV ? 'runs/.native' : 'native', 'system');
    mkdirSync(saveDir, { recursive: true });
    mkdirSync(systemDir, { recursive: true });
    const boot = join(saveDir, 'boot.sav');
    let sram = null;
    if (save?.length) {
      if (save.length > MAX_SAVE) throw httpError(413, 'Spielstand zu groß', 'saveTooLarge');
      writeFileSync(boot, save);
      sram = boot;
    } else {
      rmSync(boot, { force: true }); // no save (yet): the core starts with an empty cartridge
    }
    const id = this.launch(tools.host, hostArgs({ system, core, rom, saveDir, systemDir, sram }), saveDir);
    this.current.saveFile = saveFile;
    this.current.rom = rom;
    return id;
  }

  /**
   * A link session (docs/MULTIPLAYER.md): `seats` = [{ rom, save (bytes|null) }] in seat order, `local` = this player's
   * seat. Every seat's ROM is a file on this computer (verified by the caller), the partners' saves came over the run's
   * channel. The local seat's battery save goes where the run keeps it (`saveFile`), as in single play.
   */
  startLink({ host, system, seats, local, delay, rtc, key, saveFile = null }) {
    if (!host) throw httpError(409, 'Der Link-Teil fehlt in dieser Version', 'linkMissing');
    this.stop();
    const dir = join(nativeSaveDir(`link:${key}`), 'link');
    mkdirSync(dir, { recursive: true });
    const saves = seats.map((s, i) => {
      if (!s.save?.length) return null;
      if (s.save.length > MAX_SAVE) throw httpError(413, 'Spielstand zu groß', 'saveTooLarge');
      const f = join(dir, `seat${i}.sav`);
      writeFileSync(f, s.save);
      return f;
    });
    const id = this.launch(host, linkArgs({ system, roms: seats.map((s) => s.rom), saves, local, delay, rtc }), dir);
    this.current.saveFile = saveFile;
    this.current.rom = seats[local].rom;
    this.current.link = { seats: seats.length, local, system };
    return id;
  }

  /** The host gets only what it needs from the environment (no tokens or the like the app was started with). */
  hostEnv() {
    const keep = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'windir', 'LANG', 'LC_ALL', 'DISPLAY', 'XDG_RUNTIME_DIR'];
    return Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  }

  check(body) {
    return this.current?.link ? checkLinkCommands(body) : checkNativeCommands(body);
  }

  /** The session for the status: plus the last of what the host wrote to stderr (diagnostics, the ROM matrix). */
  status() {
    const st = super.status();
    return st && { ...st, stderr: this.current.log.join('').slice(-2000) };
  }

  get(id) {
    const s = this.current;
    if (!s || s.id !== id) throw httpError(404, 'Keine laufende Sitzung', 'noNativeSession');
    return s;
  }

  send(id, body) {
    const s = this.get(id);
    if (s.exit) throw httpError(409, 'Das Spiel ist beendet', 'nativeEnded');
    // the host reads its commands between frames – a page that floods it waits instead of piling up memory here
    if (s.child.stdin.writableLength > 128 * 1024 * 1024) throw httpError(503, 'Das Spiel ist beschäftigt', 'nativeBusy');
    s.child.stdin.write(this.check(body));
  }
}
