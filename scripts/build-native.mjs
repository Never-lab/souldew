// Builds souldew's fast player part into tools/native/<platform>-<arch>/ (bundled with the app like the 3DS part, see
// package.json and server/lib/native.mjs):
//   retrohost[.exe]              native/retro-host/retrohost.c – the host that runs a libretro core for the player page
//   melondsds_libretro.*         DS: melonDS DS (JesseTG/melonds-ds) – software 3D on its own thread, the JIT on
//   mgba_libretro.*              GBA: mGBA
//   gambatte_libretro.*          Game Boy / Game Boy Color: Gambatte (libretro's port)
//   SOURCES.txt                  which source each file was built from (GPL: the same tags/commits are public)
//   linkhost                     native/link-host/linkhost.c – link sessions: N linked consoles in one process, lockstep
//                                (trades and battles between players, docs/MULTIPLAYER.md); GBA on libmgba, GB/GBC on
//                                SameBoy (needs RGBDS for SameBoy's boot ROM)
//
//   node scripts/build-native.mjs [--platform win32-x64] [--only nds,gba,gb,link] [--host-only] [--jobs n]
//   node scripts/build-native.mjs --check      (npm run dist: fails when the part is missing; SLS_NO_NATIVE=1 builds
//                                               without it – the built-in browser emulator then plays everything)
//
// The sources are cloned at fixed tags/commits into _ref/native/. Needs git, cmake, ninja, make and a C/C++
// compiler; Windows is cross-compiled with MinGW-w64 (macOS: brew install mingw-w64; Ubuntu: apt install mingw-w64) –
// every library is linked in statically, the DLLs need nothing but Windows itself.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);
const plat = opt('platform', `${process.platform}-${process.arch}`);
const [os, arch] = plat.split('-');
const cross = plat !== `${process.platform}-${process.arch}`;
const win = os === 'win32';
const ext = win ? 'dll' : os === 'darwin' ? 'dylib' : 'so';
const out = join(root, 'tools', 'native', plat);
const jobs = String(opt('jobs', Math.max(2, cpus().length)));
const only = new Set(String(opt('only', win ? 'nds,gba,gb' : 'nds,gba,gb,link')).split(','));

/** The sources, at fixed versions (bump them here; SOURCES.txt in the build says which ones went in). */
export const SOURCES = {
  nds: { name: 'melonDS DS', repo: 'https://github.com/JesseTG/melonds-ds.git', ref: 'v1.4.0', file: `melondsds_libretro.${ext}`, license: ['LICENSE', 'LICENSE-melonds-ds-GPL-3.0.txt'] },
  gba: { name: 'mGBA', repo: 'https://github.com/mgba-emu/mgba.git', ref: '0.10.5', file: `mgba_libretro.${ext}`, license: ['LICENSE', 'LICENSE-mgba-MPL-2.0.txt'] },
  gb: { name: 'Gambatte (libretro)', repo: 'https://github.com/libretro/gambatte-libretro.git', ref: '77f2567d718b8973d02caa2daa8dce4953faf811', file: `gambatte_libretro.${ext}`, license: ['COPYING', 'LICENSE-gambatte-GPL-2.0.txt'] },
  // the link host links libmgba statically: mGBA's master has the rewritten GBA lockstep driver (sleep/wake instead of
  // blocking threads – what a single-threaded, deterministic scheduler needs). Pinned: every peer must run the same
  // build, or the consoles drift apart (the session compares RAM hashes).
  // GB/GBC link sessions run on SameBoy (MIT): bit-level serial cable between two consoles, cycle-interleaved. Its boot
  // ROM is built from source with RGBDS (rgbasm/rgblink: brew install rgbds; apt install rgbds; Windows: the release zip)
  sameboy: { name: 'SameBoy (link host, Game Boy / Game Boy Color)', repo: 'https://github.com/LIJI32/SameBoy.git', ref: 'v1.0.5', file: null, license: ['LICENSE', 'LICENSE-sameboy-MIT.txt'] },
  link: { name: 'mGBA (libmgba, link host)', repo: 'https://github.com/mgba-emu/mgba.git', ref: 'd58ea8a86f30598fbf3958585de3d33028535072', file: win ? 'linkhost.exe' : 'linkhost', license: ['LICENSE', 'LICENSE-mgba-MPL-2.0.txt'] },
};
const HOST = win ? 'retrohost.exe' : 'retrohost';

if (has('check')) {
  const need = [HOST, ...Object.entries(SOURCES).filter(([k]) => k !== 'link' && k !== 'sameboy').map(([, s]) => s.file)]; // (the link host: optional for now)
  const missing = need.filter((f) => !existsSync(join(out, f)));
  if (!missing.length) {
    console.log(`fast player part: ${out} ✓`);
    process.exit(0);
  }
  const msg = `fast player part incomplete in ${out} (missing: ${missing.join(', ')}). Build it with \`npm run native\` (see docs/DEVELOPMENT.md › "Fast player").`;
  if (process.env.SLS_NO_NATIVE) {
    console.warn(`${msg}\nSLS_NO_NATIVE is set: building without it – the browser emulator plays every game.`);
    process.exit(0);
  }
  console.error(`${msg}\nOr set SLS_NO_NATIVE=1 to build without it.`);
  process.exit(1);
}

const run = (cmd, a, o = {}) => {
  console.log(`$ ${cmd} ${a.join(' ')}`);
  const r = spawnSync(cmd, a, { stdio: 'inherit', ...o });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status})`);
};

const MINGW = 'x86_64-w64-mingw32';
const cc = process.env.CC || (win ? (cross ? `${MINGW}-gcc` : 'gcc') : 'cc');
const cxx = process.env.CXX || (win ? (cross ? `${MINGW}-g++` : 'g++') : 'c++');

/** A checkout of `s` at its ref in _ref/native (cloned once). */
function source(key) {
  const s = SOURCES[key];
  const dir = join(root, '_ref', 'native', `${key}-${s.ref.slice(0, 12)}`);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    run('git', ['init', '-q', dir]);
    run('git', ['-C', dir, 'remote', 'add', 'origin', s.repo]);
    run('git', ['-C', dir, 'fetch', '-q', '--depth', '1', 'origin', s.ref]);
    run('git', ['-C', dir, 'checkout', '-q', 'FETCH_HEAD']);
  }
  return dir;
}

/**
 * melonDS DS links `-lonecore`, but uses nothing from it (the built DLL imports only the CRT, KERNEL32, WS2_32 and
 * IPHLPAPI). Newer MinGW-w64 (Homebrew) ships libonecore.a, Ubuntu's doesn't – there an empty stand-in lets the link
 * go through. Returns the extra linker flag, or ''.
 */
function onecoreStub() {
  const found = spawnSync(cc, ['-print-file-name=libonecore.a'], { encoding: 'utf8' }).stdout?.trim() || '';
  if (found && found !== 'libonecore.a' && existsSync(found)) return '';
  const dir = join(root, '_ref', 'native', 'stub-libs');
  mkdirSync(dir, { recursive: true });
  const lib = join(dir, 'libonecore.a');
  if (!existsSync(lib)) run(cross ? `${MINGW}-ar` : 'ar', ['rcs', lib]);
  console.log(`(no libonecore.a in the toolchain – linking against an empty stand-in in ${dir})`);
  return ` -L${dir}`;
}

/** CMake arguments for the target platform (the compiler, Windows cross build, a static runtime). */
function cmakeTarget() {
  const a = ['-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POLICY_VERSION_MINIMUM=3.5'];
  if (os === 'darwin') a.push(`-DCMAKE_OSX_ARCHITECTURES=${arch === 'arm64' ? 'arm64' : 'x86_64'}`, '-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0');
  if (win) {
    const st = `-static -static-libgcc -static-libstdc++${onecoreStub()}`;
    a.push(`-DCMAKE_C_COMPILER=${cc}`, `-DCMAKE_CXX_COMPILER=${cxx}`, `-DCMAKE_SHARED_LINKER_FLAGS=${st}`, `-DCMAKE_MODULE_LINKER_FLAGS=${st}`);
    if (cross) a.push('-DCMAKE_SYSTEM_NAME=Windows', '-DCMAKE_SYSTEM_PROCESSOR=x86_64', `-DCMAKE_RC_COMPILER=${MINGW}-windres`, `-DCMAKE_FIND_ROOT_PATH=/usr/${MINGW}`,
      '-DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER', '-DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY', '-DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY', '-DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=ONLY');
  } else if (os === 'linux') {
    a.push(`-DCMAKE_C_COMPILER=${cc}`, `-DCMAKE_CXX_COMPILER=${cxx}`, '-DCMAKE_SHARED_LINKER_FLAGS=-static-libgcc -static-libstdc++', '-DCMAKE_MODULE_LINKER_FLAGS=-static-libgcc -static-libstdc++');
  }
  return a;
}

/** The core's license next to it (it ships with the app). */
function license(key, src) {
  const [from, to] = SOURCES[key].license;
  copyFileSync(join(src, from), join(out, to));
}

function buildNds() {
  const src = source('nds');
  const build = join(src, `build-${plat}`);
  // no OpenGL (the page draws the picture), no Wi-Fi (souldew never goes online through the core), the JIT on
  run('cmake', [...cmakeTarget(), '-DENABLE_OPENGL=OFF', '-DENABLE_JIT=ON', '-DENABLE_LTO_RELEASE=OFF', '-DBUILD_TESTING=OFF', '-DTRACY_ENABLE=OFF', '-S', src, '-B', build]);
  run('cmake', ['--build', build, '--parallel', jobs]);
  copyFileSync(join(build, 'src', 'libretro', SOURCES.nds.file), join(out, SOURCES.nds.file));
  license('nds', src);
}

function buildGba() {
  const src = source('gba');
  const build = join(src, `build-${plat}`);
  const off = ['QT', 'SDL', 'GL', 'GLES2', 'GLES3', 'EPOXY'].map((x) => `-DBUILD_${x}=OFF`);
  const no = ['FFMPEG', 'ZLIB', 'LIBZIP', 'MINIZIP', 'PNG', 'SQLITE3', 'ELF', 'LUA', 'EDITLINE', 'DISCORD_RPC', 'EPOXY', 'JSON_C', 'DEBUGGERS', 'GDB_STUB'].map((x) => `-DUSE_${x}=OFF`);
  run('cmake', [...cmakeTarget(), '-DBUILD_LIBRETRO=ON', '-DBUILD_SHARED=OFF', '-DBUILD_STATIC=OFF', '-DSKIP_LIBRARY=ON', ...off, ...no, '-S', src, '-B', build]);
  run('cmake', ['--build', build, '--parallel', jobs, '--target', 'mgba_libretro']);
  copyFileSync(join(build, SOURCES.gba.file), join(out, SOURCES.gba.file));
  license('gba', src);
}

function buildGb() {
  const src = source('gb');
  const platform = win ? 'win' : os === 'darwin' ? 'osx' : 'unix';
  // (Windows: winpthread static too – a MinGW build otherwise needs libwinpthread-1.dll next to it)
  const extra = os === 'darwin' ? [`ARCHFLAGS=-arch ${arch === 'arm64' ? 'arm64' : 'x86_64'} -mmacosx-version-min=11.0`] : win ? ['LDFLAGS=-static -lws2_32'] : ['LDFLAGS=-static-libgcc -static-libstdc++'];
  run('make', ['-C', src, '-f', 'Makefile.libretro', 'clean'], { stdio: 'ignore' });
  run('make', ['-C', src, '-f', 'Makefile.libretro', `platform=${platform}`, 'HAVE_NETWORK=0', `CC=${cc}`, `CXX=${cxx}`, ...extra, `-j${jobs}`]);
  copyFileSync(join(src, SOURCES.gb.file), join(out, SOURCES.gb.file));
  license('gb', src);
}

/** The link host: native/link-host (the session + its backends) on libmgba (static, no frontends). */
function buildLink() {
  const src = source('link');
  const build = join(src, `build-static-${plat}`);
  const off = ['QT', 'SDL', 'GL', 'GLES2', 'GLES3', 'LIBRETRO', 'SHARED'].map((x) => `-DBUILD_${x}=OFF`);
  const no = ['FFMPEG', 'ZLIB', 'LIBZIP', 'MINIZIP', 'PNG', 'SQLITE3', 'ELF', 'LUA', 'EDITLINE', 'DISCORD_RPC', 'EPOXY', 'JSON_C'].map((x) => `-DUSE_${x}=OFF`);
  run('cmake', [...cmakeTarget(), '-DBUILD_STATIC=ON', '-DENABLE_SCRIPTING=OFF', ...off, ...no, '-S', src, '-B', build]);
  run('cmake', ['--build', build, '--parallel', jobs, '--target', 'mgba']);
  // the compile definitions libmgba was built with (its structs change shape with them)
  const ninja = readFileSync(join(build, 'build.ninja'), 'utf8');
  const defs = (ninja.match(/build CMakeFiles\/mgba\.dir\/src\/core\/core\.c\.o[\s\S]*?DEFINES = ([^\n]*)/)?.[1] || '').split(/\s+/).filter((d) => d.startsWith('-D'));
  const flags = os === 'darwin' ? ['-arch', arch === 'arm64' ? 'arm64' : 'x86_64', '-mmacosx-version-min=11.0'] : [];
  const libs = os === 'darwin' ? ['-framework', 'CoreFoundation'] : os === 'linux' ? ['-lpthread', '-lm'] : ['-static', '-lm'];
  const sb = buildSameBoy(flags);
  const exe = join(out, SOURCES.link.file);
  run(cc, ['-O2', '-std=gnu11', '-Wall', ...flags, ...defs, '-I', join(src, 'include'), '-I', join(build, 'include'), ...sb.cflags, '-o', exe,
    ...['linkhost.c', 'backend_mgba.c', 'backend_sameboy.c'].map((f) => join(root, 'native', 'link-host', f)), ...sb.objects, join(build, 'libmgba.a'), ...libs]);
  if (!win) chmodSync(exe, 0o755);
  license('link', src);
}

/**
 * SameBoy's core for the link host's Game Boy backend (native/link-host/backend_sameboy.c): its Core/*.c without the
 * debugger, rewind, cheats and real-time pacing, the core's time() pointed at the session clock (determinism: no wall
 * clock), and its CGB boot ROM (assembled from SameBoy's source with RGBDS) as a C array. Returns objects + cflags.
 */
function buildSameBoy(flags) {
  const src = source('sameboy');
  const obj = join(src, `build-souldew-${plat}`);
  mkdirSync(obj, { recursive: true });
  run('make', ['-C', src, 'build/bin/BootROMs/cgb_boot.bin', `CC=${process.env.HOST_CC || 'cc'}`]); // (pb12 is a build-time helper: host compiler)
  const boot = readFileSync(join(src, 'build', 'bin', 'BootROMs', 'cgb_boot.bin'));
  const bootC = join(obj, 'sbl_boot.c');
  writeFileSync(bootC, `/* SameBoy's CGB boot ROM (MIT), assembled from BootROMs/cgb_boot.asm */\nconst unsigned char sbl_cgb_boot[] = {${[...boot].join(',')}};\nconst unsigned sbl_cgb_boot_length = ${boot.length};\n`);
  const defs = ['-DGB_INTERNAL', '-DGB_DISABLE_TIMEKEEPING', '-DGB_DISABLE_REWIND', '-DGB_DISABLE_DEBUGGER', '-DGB_DISABLE_CHEATS', '-DGB_DISABLE_CHEAT_SEARCH',
    '-D_GNU_SOURCE', '-D_USE_MATH_DEFINES', '-DNDEBUG', `-DGB_VERSION="${SOURCES.sameboy.ref.replace(/^v/, '')}"`];
  const files = ['gb', 'sgb', 'apu', 'memory', 'mbc', 'timing', 'display', 'camera', 'sm83_cpu', 'joypad', 'save_state', 'random', 'rumble'];
  const objects = [];
  for (const f of files) {
    const o = join(obj, `${f}.o`);
    run(cc, ['-O2', '-std=gnu11', '-w', ...flags, ...defs, '-Dtime=sbl_time', '-I', src, '-c', join(src, 'Core', `${f}.c`), '-o', o]);
    objects.push(o);
  }
  const bo = join(obj, 'sbl_boot.o');
  run(cc, ['-O2', ...flags, '-c', bootC, '-o', bo]);
  objects.push(bo);
  license('sameboy', src);
  return { objects, cflags: ['-I', src, '-DGB_DISABLE_REWIND', '-DGB_DISABLE_DEBUGGER', '-DGB_DISABLE_CHEATS', '-DGB_DISABLE_CHEAT_SEARCH'] };
}

function buildHost() {
  const exe = join(out, HOST);
  const libs = os === 'linux' ? ['-ldl', '-lpthread', '-lm'] : win ? ['-static', '-lm'] : [];
  const flags = os === 'darwin' ? [`-arch`, arch === 'arm64' ? 'arm64' : 'x86_64', '-mmacosx-version-min=11.0'] : [];
  run(cc, ['-O2', '-Wall', ...flags, '-I', join(root, 'native', 'ctr-host'), '-o', exe, join(root, 'native', 'retro-host', 'retrohost.c'), ...libs]);
  if (!win) chmodSync(exe, 0o755);
}

mkdirSync(out, { recursive: true });
buildHost();
if (!has('host-only')) {
  if (only.has('nds')) buildNds();
  if (only.has('gba')) buildGba();
  if (only.has('gb')) buildGb();
  if (only.has('link')) buildLink();
}
const lines = Object.entries(SOURCES).filter(([, s]) => existsSync(join(out, s.file || SOURCES.link.file))).map(([, s]) => `${s.file || SOURCES.link.file}: ${s.name} ${s.ref} – ${s.repo.replace(/\.git$/, '')}`);
const prev = existsSync(join(out, 'SOURCES.txt')) ? readFileSync(join(out, 'SOURCES.txt'), 'utf8') : '';
writeFileSync(join(out, 'SOURCES.txt'), `${[`${HOST}: souldew native/retro-host/retrohost.c`, ...lines].join('\n')}\n`);
if (prev && prev !== readFileSync(join(out, 'SOURCES.txt'), 'utf8')) console.log('SOURCES.txt updated');
console.log(`fast player part: ${out}`);
