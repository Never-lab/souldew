// Builds a TEST souldew+ pack from the design sources, signed with a throwaway dev key, so the whole premium path
// (download → decrypt → verify → load) can be tried locally. Real packs are built and signed by the accounts repo's
// pack builder with the production key – this script never sees that key, and the app never trusts this one unless the
// local server is started with SLS_PLUS_DEV_PACK.
//
//   node scripts/plus-dev-pack.mjs --design <design/plus folder> --out <folder>      # the test pack
//   node scripts/plus-dev-pack.mjs --design <design/plus folder> --catalog           # + the public catalog and free content
//
// Output (--out, never inside the repo): pack.sdpk (the encrypted envelope one account would download), access.json
// (what getPackAccess() would return: key, manifestSig, until, packVersion – plus the dev public key), and
// dev-signing.key (the private key, so later builds keep the same identity). Then start the server with
//   SLS_PLUS_DEV_PACK=<folder> node server/index.mjs
//
// --catalog rewrites web/lib/cosmetics/content/{catalog,banners-free,frames-free}.mjs: the PUBLIC part (names,
// collections, rarities, swatches, pairings – what a locked card shows) and the free banners and frames.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildArchive, sealEnvelope, makeSigner, b64encode, b64decode } from '../web/lib/cosmetics/pack/format.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const DESIGN = resolve(opt('design', join(ROOT, '..', 'design-plus', 'design', 'plus')));
const OUT = opt('out') ? resolve(opt('out')) : null;
const CATALOG = args.includes('--catalog');
const DAYS = Number(opt('days', 30));
if (!existsSync(join(DESIGN, 'themes', 'skins.json'))) {
  console.error(`no design sources at ${DESIGN} (expected themes/, banners/, frames/, launch/) – pass --design`);
  process.exit(2);
}
if (!OUT && !CATALOG) {
  console.error('usage: node scripts/plus-dev-pack.mjs --design <dir> [--out <dir>] [--catalog] [--days 30]');
  process.exit(2);
}
if (OUT && resolve(OUT).startsWith(ROOT)) {
  console.error('--out must be outside the repository (a test pack is premium content and is never committed)');
  process.exit(2);
}
const enc = new TextEncoder();
const imp = (p) => import(pathToFileURL(join(DESIGN, p)).href);

// ------------------------------------------------------------------ sources
const SKINS = JSON.parse(readFileSync(join(DESIGN, 'themes', 'skins.json'), 'utf8'));
const B = await imp('banners/recipes/index.mjs');
const F = await imp('frames/recipes/index.mjs');
const L = await imp('launch/anims/index.mjs');

// launch animations that come with a skin (launch/README.md › "Suggested packaging")
const SKIN_LAUNCH = { fieldbook: 'two-ink', moss: 'cedar-lid', dusk: 'tile-bloom', clearshell: 'tile-bloom' };
const LAUNCH_PAIRS = { 'two-ink': ['fieldbook'], 'fold-away': ['fieldbook'], 'cedar-lid': ['moss'], gust: ['moss'], 'tile-bloom': ['dusk', 'clearshell'], hourglass: ['dusk'] };

/** a few colours of a palette for the locked card's swatch strip (no art – just the mood) */
const swatch = (pal, n = 6) => {
  const vals = Object.values(pal || {}).filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  if (vals.length <= n) return vals;
  return Array.from({ length: n }, (_, i) => vals[Math.round((i * (vals.length - 1)) / (n - 1))]);
};

function assertData(v, where) {
  if (typeof v === 'function') throw new Error(`${where}: a function in data`);
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`${where}: not a finite number`);
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) assertData(x, `${where}.${k}`);
}

const bannerByName = new Map(B.BANNERS.map((b) => [b.name, b.id]));
const freeBanners = B.BANNERS.filter((b) => b.set === 'basics');
const plusBanners = B.BANNERS.filter((b) => b.set !== 'basics');
const freeFrames = F.FRAMES.filter((f) => f.set === 'basics');
const plusFrames = F.FRAMES.filter((f) => f.set !== 'basics');
const plusAnims = L.SET;

// ------------------------------------------------------------------ bundling code recipes into one module
// Frames and launch animations are code (per-pixel functions). Each becomes ONE module whose imports point at the app's
// public engine ('@cosmetics/…' – rewritten to absolute same-origin URLs by web/lib/cosmetics/sandbox.mjs), run in a
// worker. Collection files are wrapped in their own function scope so their top-level names can't collide.
function bundle(files, specMap, exportName, filterExpr) {
  const imports = new Map(); // module → Set(names)
  const parts = [];
  files.forEach((file, i) => {
    let src = readFileSync(file, 'utf8');
    src = src.replace(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?\s*$/gm, (_, names, from) => {
      const target = specMap[from];
      if (!target) throw new Error(`${basename(file)}: unexpected import ${from}`);
      const set = imports.get(target) || new Set();
      for (const n of names.split(',').map((s) => s.trim()).filter(Boolean)) set.add(n);
      imports.set(target, set);
      return '';
    });
    if (/^\s*import\s/m.test(src)) throw new Error(`${basename(file)}: an import the bundler can't map`);
    if ((src.match(/^export default /gm) || []).length !== 1) throw new Error(`${basename(file)}: needs exactly one default export`);
    if (/^export (?!default)/m.test(src)) throw new Error(`${basename(file)}: named exports are not bundled`);
    parts.push(`// ${basename(file)}\nconst __m${i} = (() => {\n${src.replace(/^export default /m, 'return ')}\n})();`);
  });
  const head = [...imports].map(([from, names]) => `import { ${[...names].sort().join(', ')} } from '${from}';`).join('\n');
  const list = files.map((_, i) => `...(Array.isArray(__m${i}) ? __m${i} : [__m${i}])`).join(', ');
  return `// souldew+ pack module (generated by scripts/plus-dev-pack.mjs – do not edit)\n${head}\n\n${parts.join('\n\n')}\n\nexport const ${exportName} = [${list}].filter(${filterExpr});\n`;
}

const FRAME_FILES = readdirSync(join(DESIGN, 'frames', 'recipes')).filter((f) => f.endsWith('.mjs') && !['index.mjs', '_lib.mjs', 'basics.mjs'].includes(f)).sort();
const framesModule = bundle(FRAME_FILES.map((f) => join(DESIGN, 'frames', 'recipes', f)),
  { './_lib.mjs': '@cosmetics/frames/recipe-lib.mjs', '../engine/core.mjs': '@cosmetics/frames/engine/core.mjs' }, 'RECIPES', '(r) => !r.reject');
const ANIM_FILES = plusAnims.map((a) => join(DESIGN, 'launch', 'anims', `${a.id}.mjs`));
const launchModule = bundle(ANIM_FILES, { '../engine.mjs': '@cosmetics/launch/engine.mjs' }, 'ANIMS', '(a) => !a.cut');

// ------------------------------------------------------------------ skins: CSS with its fonts and art as pack files
function skinFiles() {
  const out = [];
  const extra = new Map();
  for (const s of SKINS.filter((k) => k.kind !== 'classic')) {
    let css = readFileSync(join(DESIGN, 'themes', `${s.id}.css`), 'utf8');
    css = css.replace(/url\((['"]?)(\.\.\/fonts\/|assets\/)([A-Za-z0-9._-]+)\1\)/g, (_, q, dir, name) => {
      const path = `${dir.startsWith('..') ? 'fonts' : 'assets'}/${name.toLowerCase()}`;
      extra.set(path, join(DESIGN, dir.startsWith('..') ? 'fonts' : 'themes/assets', name));
      return `url('pack:${path}')`;
    });
    const foreign = [...css.matchAll(/url\(\s*(['"]?)([^'")]*)/g)].map((m) => m[2]).filter((u) => !/^(data:|pack:|#|%23)/.test(u));
    if (foreign.length) throw new Error(`${s.id}.css: assets the builder doesn't package: ${foreign.join(', ')}`);
    out.push({ path: `skins/${s.id}.css`, bytes: enc.encode(css) });
  }
  for (const [path, file] of extra) out.push({ path, bytes: new Uint8Array(readFileSync(file)) });
  return out;
}

// ------------------------------------------------------------------ the public catalog
const collName = (list, id) => list.find((c) => c.id === id)?.name || id;
function catalogData() {
  const skins = SKINS.map((s) => ({
    id: s.id, name: s.name, hint: s.hint, plus: s.kind !== 'classic',
    group: s.kind === 'colour' ? s.tone : 'editions', tone: s.tone, sw: s.sw, launch: SKIN_LAUNCH[s.id] || null,
  }));
  const bannerPairs = (b) => (b.pairsWith ? [].concat(b.pairsWith) : []);
  const banners = B.BANNERS.map((b) => ({
    id: b.id, name: b.name, collection: b.set, rarity: b.rarity, plus: b.set !== 'basics', pairsWith: bannerPairs(b),
    drop: b.drop || null, sw: swatch(b.pal),
  }));
  const frames = F.FRAMES.map((f) => ({
    id: f.id, name: f.name, collection: f.set, rarity: f.rarity, plus: f.set !== 'basics', pairsWith: f.pairsWith || [],
    pair: f.pair ? bannerByName.get(f.pair) || null : null, sw: swatch(f.pal),
  }));
  const launch = [{ id: 'cartridge', name: 'Cartridge', collection: 'basics', rarity: 'free', plus: false, pairsWith: [], dur: 1.5, revealAt: 0.9 },
    ...plusAnims.map((a) => ({ id: a.id, name: a.name, collection: a.collection.replace(/^Basics · /, ''), rarity: 'rare', plus: true, pairsWith: LAUNCH_PAIRS[a.id] || [], dur: a.dur, revealAt: a.revealAt, sw: swatch(Object.fromEntries((a.pal || []).map((c, i) => [i, c]))) }))];
  const collections = {
    banners: B.COLLECTIONS.map((c) => ({ id: c.id, name: c.name.replace(/ \(free\)$/, '') })),
    frames: F.COLLECTIONS.map((c) => ({ id: c.id, name: c.name.replace(/ \(free\)$/, '') })),
  };
  for (const b of banners) b.collectionName = collName(collections.banners, b.collection);
  for (const f of frames) f.collectionName = collName(collections.frames, f.collection);
  return { skins, banners, frames, launch, collections };
}

if (CATALOG) {
  const dir = join(ROOT, 'web', 'lib', 'cosmetics', 'content');
  mkdirSync(dir, { recursive: true });
  const head = (what) => `// ${what} – generated by scripts/plus-dev-pack.mjs --catalog from the design sources. Do not edit by hand.\n`;
  const cat = catalogData();
  assertData(cat, 'catalog');
  writeFileSync(join(dir, 'catalog.mjs'), `${head('The PUBLIC souldew+ catalog: what every card shows, owned or not (no art, no recipes)')}export default ${JSON.stringify(cat)};\n`);
  for (const b of freeBanners) assertData(b, b.id);
  writeFileSync(join(dir, 'banners-free.mjs'), `${head('The free banners (Basics) – shipped with the app')}export default ${JSON.stringify(freeBanners, null, 1)};\n`);
  let ff = readFileSync(join(DESIGN, 'frames', 'recipes', 'basics.mjs'), 'utf8');
  for (const f of freeFrames) f.pairsWith = f.pairsWith || [];
  ff = `${head('The free avatar frames (Basics) – shipped with the app')}${ff}`;
  writeFileSync(join(dir, 'frames-free.mjs'), ff);
  console.log(`catalog: ${cat.skins.length} skins, ${cat.banners.length} banners, ${cat.frames.length} frames, ${cat.launch.length} launch animations → web/lib/cosmetics/content/`);
}

if (OUT) {
  mkdirSync(OUT, { recursive: true });
  for (const b of plusBanners) assertData(b, b.id);
  const packVersion = opt('version', `dev-${new Date().toISOString().slice(0, 10)}`);
  const contents = {
    skins: SKINS.filter((k) => k.kind !== 'classic').map((s) => ({ id: s.id, css: `skins/${s.id}.css` })),
    banners: 'banners.json', frames: { module: 'frames.mjs', ids: plusFrames.map((f) => f.id) },
    launch: { module: 'launch.mjs', ids: plusAnims.map((a) => a.id) },
  };
  const files = [
    { path: 'contents.json', bytes: enc.encode(JSON.stringify(contents)) },
    { path: 'banners.json', bytes: enc.encode(JSON.stringify(plusBanners)) },
    { path: 'frames.mjs', bytes: enc.encode(framesModule) },
    { path: 'launch.mjs', bytes: enc.encode(launchModule) },
    ...skinFiles(),
  ];
  const keyFile = join(OUT, 'dev-signing.key');
  const signer = await makeSigner(existsSync(keyFile) ? b64decode(readFileSync(keyFile, 'utf8').trim()) : null);
  if (!existsSync(keyFile)) writeFileSync(keyFile, b64encode(await signer.pkcs8()) + '\n', { mode: 0o600 });
  const { archive, sig } = await buildArchive({ packVersion, files }, signer.sign);
  const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const envelope = await sealEnvelope(archive, key, { watermark: 'dev-account', packVersion });
  writeFileSync(join(OUT, 'pack.sdpk'), envelope);
  const access = { key: b64encode(key), manifestSig: b64encode(sig), until: new Date(Date.now() + DAYS * 86400e3).toISOString(), packVersion, publicKey: b64encode(signer.publicKey) };
  writeFileSync(join(OUT, 'access.json'), JSON.stringify(access, null, 2) + '\n', { mode: 0o600 });
  const kb = (n) => `${Math.round(n / 1024)} KB`;
  console.log(`test pack ${packVersion}: ${files.length} files, archive ${kb(archive.length)}, envelope ${kb(envelope.length)} → ${OUT}`);
  console.log(`  skins ${contents.skins.length} · banners ${plusBanners.length} · frames ${plusFrames.length} · launch ${plusAnims.length}`);
  console.log(`  start the server with SLS_PLUS_DEV_PACK=${OUT}`);
}
