// souldew 3.0 community + souldew+ end to end, against the REAL accounts service (souldew-accounts) running locally in
// `wrangler dev` – never the production one. Re-runnable; everything lives in a scratch folder and is stopped at the end.
//
//   node scripts/plus-e2e.mjs --accounts <souldew-accounts checkout> --design <design/plus> --out <screens dir> [--show] [--keep]
//
// What it does (muted, scratch profiles, never port 47390):
//   1. throwaway keys and secrets; the pack source folders from the design sources (scripts/plus-dev-pack.mjs), signed by
//      the OWNER's pack tool (souldew-accounts tools/pack-build.mjs) with a throwaway signing key; the catalog seed from
//      this app (tools/catalog-seed.mjs)
//   2. local D1 migrations, the signed packs into local R2, `wrangler dev` on a free port with DEV_FAKE_DISCORD=1 (the
//      dev-only fake Discord – the Worker refuses it unless PUBLIC_URL is this computer)
//   3. admin: tier map, catalog, register both packs (the Worker re-verifies the signatures)
//   4. two souldew servers (Robin, Kim) with SLS_ACCOUNTS_URL at the Worker; both sign in through the real loopback flow
//      in a "system browser" window: fake authorize page → callback → "Sign in to souldew on this computer as …?" → app
//   5. friends, an invite to a run, the join
//   6. a signed BMC webhook (live_mode) for Robin's payer email, Robin links it in Settings › Account → souldew+
//   7. the pack: downloaded per file, verified, decrypted in the page; a skin applied, banner + frame on the profile,
//      a launch animation previewed
//   8. Kim (no membership) tries a souldew+ theme for 15 minutes (POST …/preview) – the "Preview" state
//   4b. the public preview media (a signed "previews" pack, registered free): Kim, signed OUT, sees the real pictures of
//      souldew+ items in Settings › Account – no account needed
//   9. Robin unlinks the membership → pack key rotated, tier gone → the encrypted cache is wiped, the theme goes back
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { createHmac } from 'node:crypto';

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
  const scratch = mkdtempSync(join(tmpdir(), 'souldew-plus-e2e-'));
  app.setPath('userData', join(scratch, 'electron'));
  app.on('window-all-closed', () => {});
  app.whenReady().then(() => main(scratch));
}

/** A port nobody uses right now (never the installed app's 47390). */
const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => (port === 47390 ? freePort().then(res) : res(port)));
  });
});

/** A header-only Emerald cartridge (recognised by its serial – enough for the wizard; nothing is played). */
function fakeEmerald() {
  const rom = Buffer.alloc(0x10000);
  rom.write('POKEMON EMER', 0xa0, 'ascii');
  rom.write('BPEE', 0xac, 'ascii');
  rom[0xb2] = 0x96;
  return rom;
}

async function main(scratch) {
  const { app, BrowserWindow } = await import('electron');
  const ACC = resolve(opt('accounts', join(homedir(), 'souldew-accounts')));
  const DESIGN = resolve(opt('design', join(root, '..', 'design-plus', 'design', 'plus')));
  const out = resolve(opt('out', join(scratch, 'shots')));
  mkdirSync(out, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const procs = [];
  const results = [];
  const check = (what, ok, detail = '') => {
    results.push({ what, ok: !!ok, detail });
    log(ok ? 'PASS' : 'FAIL', what, detail);
    if (!ok) throw new Error(`check failed: ${what} ${detail}`);
  };
  const run = (cmd, argv, opts = {}) => {
    const r = spawnSync(cmd, argv, { encoding: 'utf8', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', ...(opts.env || {}) }, cwd: opts.cwd || root, timeout: opts.timeout || 300000 });
    if (r.status !== 0) throw new Error(`${cmd} ${argv.slice(0, 4).join(' ')} … failed (${r.status}): ${(r.stderr || '').slice(-1500)} ${(r.stdout || '').slice(-800)}`);
    return r.stdout;
  };
  // a real Node for the tools and wrangler (wrangler re-spawns itself, which Electron-as-Node doesn't survive)
  const NODE = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).stdout.trim() || 'node';
  const node = (argv, opts) => run(NODE, argv, opts);
  const wrangler = (argv, opts = {}) => node([join(ACC, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), ...argv], { cwd: ACC, ...opts });

  const finish = async (code) => {
    for (const p of procs.reverse()) {
      try {
        if (p.group) process.kill(-p.pid, 'SIGTERM');
        else p.kill('SIGTERM');
      } catch {}
    }
    await sleep(800);
    for (const p of procs) {
      try {
        if (p.group) process.kill(-p.pid, 'SIGKILL');
        else p.kill('SIGKILL');
      } catch {}
    }
    writeFileSync(join(out, 'results.json'), JSON.stringify({ ok: code === 0, results }, null, 2));
    if (!args.includes('--keep')) rmSync(scratch, { recursive: true, force: true });
    else log('scratch kept:', scratch);
    app.exit(code);
  };

  try {
    // ------------------------------------------------------------------ 1 · keys, packs, catalog
    const { generateEd25519, generateSecret } = await import(pathToFileURL(join(ACC, 'tools', 'keygen.mjs')).href);
    const keysDir = join(scratch, 'keys');
    mkdirSync(keysDir, { recursive: true });
    const packKey = generateEd25519();
    const entKey = generateEd25519(); // the entitlement key – the apps trust its public half (SLS_ACCOUNTS_DEV_ENT_KEY)
    writeFileSync(join(keysDir, 'pack-signing.jwk'), JSON.stringify(packKey.jwk), { mode: 0o600 });
    const W = await freePort();
    const PUBLIC = `http://127.0.0.1:${W}`;
    const secrets = {
      PUBLIC_URL: PUBLIC, DEV_FAKE_DISCORD: '1', PACK_PUBLIC_KEY: packKey.publicKey,
      DISCORD_CLIENT_ID: 'fake-client-id', DISCORD_CLIENT_SECRET: `fake-${generateSecret()}`,
      SESSION_SIGNING_KEY: JSON.stringify(generateEd25519().jwk), ENTITLEMENT_SIGNING_KEY: JSON.stringify(entKey.jwk),
      PACK_MASTER_KEY: generateSecret(), EMAIL_HASH_KEY: generateSecret(), ADMIN_KEY: generateSecret(), BOT_LINK_SECRET: generateSecret(),
      BMC_WEBHOOK_SECRET: generateSecret(),
    };
    // single-quoted: .env files take those literally (the JWKs are JSON with double quotes)
    writeFileSync(join(scratch, 'dev.env'), Object.entries(secrets).map(([k, v]) => `${k}='${v}'`).join('\n') + '\n', { mode: 0o600 });
    const srcDir = join(scratch, 'pack-src');
    const pvDir = join(scratch, 'preview-src');
    node([join(root, 'scripts', 'plus-dev-pack.mjs'), '--design', DESIGN, '--source', srcDir, '--preview-source', pvDir], { timeout: 180000 });
    const dist = join(scratch, 'dist');
    const VERSION = '1.0.0';
    node([join(ACC, 'tools', 'pack-build.mjs'), srcDir, '--id', 'souldew-plus', '--version', VERSION, '--kind', 'mixed', '--title', 'souldew+', '--key', join(keysDir, 'pack-signing.jwk'), '--out', dist]);
    node([join(ACC, 'tools', 'pack-build.mjs'), pvDir, '--id', 'skins-preview', '--version', VERSION, '--kind', 'preview', '--title', 'Skin preview', '--key', join(keysDir, 'pack-signing.jwk'), '--out', dist]);
    check('owner pack tool signed both packs', existsSync(join(dist, 'souldew-plus', VERSION, 'manifest.sig')) && existsSync(join(dist, 'skins-preview', VERSION, 'manifest.sig')));
    // the public preview media: rendered from the design sources, a few of each kind (uploading all ~700 to local R2
    // one wrangler call at a time would take long), signed by the owner's tool as kind "previews"
    const mediaAll = join(scratch, 'previews-all');
    node([join(root, 'scripts', 'plus-dev-pack.mjs'), '--design', DESIGN, '--previews-source', mediaAll], { timeout: 900000 });
    const mediaDir = join(scratch, 'previews-src');
    for (const kind of ['banners', 'nameplates', 'frames', 'launch', 'skins']) {
      mkdirSync(join(mediaDir, kind), { recursive: true });
      const names = readdirSync(join(mediaAll, kind)).sort();
      const ids = [...new Set(names.map((n) => n.replace(/\.(png|webp)$/, '')))].slice(0, 3);
      for (const n of names.filter((x) => ids.includes(x.replace(/\.(png|webp)$/, '')))) writeFileSync(join(mediaDir, kind, n), readFileSync(join(mediaAll, kind, n)));
    }
    node([join(ACC, 'tools', 'pack-build.mjs'), mediaDir, '--id', 'souldew-previews', '--version', VERSION, '--kind', 'previews', '--title', 'souldew+ previews', '--key', join(keysDir, 'pack-signing.jwk'), '--out', dist]);
    const seedDir = join(scratch, 'seed');
    node([join(ACC, 'tools', 'catalog-seed.mjs'), '--app', root, '--out', seedDir]);

    // ------------------------------------------------------------------ 2 · local D1 + R2, wrangler dev
    const state = join(scratch, 'wrangler-state');
    wrangler(['d1', 'migrations', 'apply', 'souldew-accounts', '--local', '--persist-to', state]);
    const listFiles = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? listFiles(join(dir, d.name), base) : [join(dir, d.name).slice(base.length + 1)]));
    let uploaded = 0;
    for (const id of ['souldew-plus', 'skins-preview', 'souldew-previews']) {
      const dir = join(dist, id, VERSION);
      for (const rel of listFiles(join(dir, 'files'))) {
        wrangler(['r2', 'object', 'put', `souldew-packs/packs/${id}/${VERSION}/files/${rel}`, '--file', join(dir, 'files', rel), '--local', '--persist-to', state]);
        uploaded++;
      }
      for (const f of ['manifest.json', 'manifest.sig']) wrangler(['r2', 'object', 'put', `souldew-packs/packs/${id}/${VERSION}/${f}`, '--file', join(dir, f), '--local', '--persist-to', state]);
    }
    log(`local R2: ${uploaded} pack files`);
    const inspector = await freePort();
    const wr = spawn(NODE, [join(ACC, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'dev', '--port', String(W), '--ip', '127.0.0.1', '--env-file', join(scratch, 'dev.env'),
      '--persist-to', state, '--inspector-port', String(inspector),
      // the Worker sees this computer's address, not the production route's (wrangler.toml has the custom domain, and
      // wrangler dev would rewrite request.url / Origin to it – the sign-in confirmation then refuses its own form)
      '--infer-origin-from-routes=false', '--show-interactive-dev-session=false', '--log-level', 'warn'],
    { cwd: ACC, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    wr.group = true;
    procs.push(wr);
    const wlog = [];
    wr.stdout.on('data', (d) => wlog.push(String(d)));
    wr.stderr.on('data', (d) => wlog.push(String(d)));
    const until = async (what, fn, ms = 30000, every = 250) => {
      const t0 = Date.now();
      for (;;) {
        const v = await fn().catch(() => null);
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
        await sleep(every);
      }
    };
    let lastHealth = null;
    await until('wrangler dev', async () => {
      const r = await fetch(`${PUBLIC}/health`);
      lastHealth = `${r.status} ${(await r.text()).slice(0, 200)}`;
      return r.ok;
    }, 90000, 500).catch((e) => { console.error(lastHealth, wlog.join('').slice(-3000)); throw e; });
    log('accounts Worker on', PUBLIC);
    const svc = async (method, path, body, headers = {}) => {
      const r = await fetch(PUBLIC + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
      const t = await r.text();
      let j = t;
      try { j = JSON.parse(t); } catch {}
      return { status: r.status, body: j };
    };
    const admin = (method, path, body) => svc(method, path, body, { 'X-Admin-Key': secrets.ADMIN_KEY });

    // ------------------------------------------------------------------ 3 · admin setup
    check('tier map', (await admin('PUT', '/v1/admin/tier-map', { map: { 'lvl-supporter': 'supporter', 'lvl-plus': 'plus', 'lvl-patron': 'patron' }, default: 'supporter', one_time: 'supporter' })).status === 200);
    const cat = await admin('PUT', '/v1/admin/cosmetics', JSON.parse(readFileSync(join(seedDir, 'admin-cosmetics.json'), 'utf8')));
    check('catalog seeded from the app', cat.status === 200, JSON.stringify(cat.body).slice(0, 80));
    for (const [id, kind, title] of [['souldew-plus', 'mixed', 'souldew+'], ['skins-preview', 'preview', 'Skin preview']]) {
      const r = await admin('PUT', `/v1/admin/packs/${id}`, { version: VERSION, title, kind, required_tier: 'plus', published: true });
      check(`pack ${id} registered (Worker verified the signature${kind === 'preview' ? ' and the ≤512 px images' : ''})`, r.status === 200, JSON.stringify(r.body).slice(0, 200));
    }
    {
      const r = await admin('PUT', '/v1/admin/packs/souldew-previews', { version: VERSION, title: 'souldew+ previews', kind: 'previews', required_tier: 'free', published: true });
      check('preview media registered (pictures only, checked in R2)', r.status === 200, JSON.stringify(r.body).slice(0, 200));
      const pub = await svc('GET', '/v1/previews');
      check('GET /v1/previews answers without an account', pub.status === 200 && pub.body.version === VERSION && pub.body.files.length > 20, `${pub.status}`);
      const pic = await fetch(pub.body.files.find((f) => f.path.endsWith('.webp')).url);
      check('a preview picture is public and cacheable', pic.ok && /^image\/webp/.test(pic.headers.get('content-type')) && /immutable/.test(pic.headers.get('cache-control') || ''));
    }

    // ------------------------------------------------------------------ 4 · two apps, the real sign-in
    const servers = [];
    const profiles = [['host', 'Robin', await freePort()], ['guest', 'Kim', await freePort()]].map(([id, name, port]) => {
      const dir = join(scratch, id);
      const lib = join(dir, 'roms');
      mkdirSync(lib, { recursive: true });
      writeFileSync(join(lib, 'Pokemon Emerald.gba'), fakeEmerald());
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ onboarded: true, lang: 'en', playerName: name, libraryFolders: [lib], bootAnimation: true, sounds: false, nagOff: true }));
      const p = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SLS_DATA_DIR: dir, PORT: String(port), NO_OPEN: '1', SLS_ACCOUNTS_URL: PUBLIC, SLS_PLUS_DEV_KEY: packKey.publicKey, SLS_ACCOUNTS_DEV_ENT_KEY: entKey.publicKey },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      p.stderr.on('data', (d) => process.stderr.write(`[${id}] ${d}`));
      servers.push(p);
      procs.push(p);
      return { id, name, port, dir, base: `http://127.0.0.1:${port}` };
    });
    const [HOST, GUEST] = profiles;
    const RUN = 'e3a1d07b';
    mkdirSync(join(HOST.dir, 'runs', RUN), { recursive: true });
    writeFileSync(join(HOST.dir, 'runs', RUN, 'run.json'), JSON.stringify({
      id: RUN, name: 'Emerald with Kim', mode: 'soullink', room: 'room-e3a1d07b-5f2c91', secret: 'e2e-room-secret-0c7b2a9d', createdAt: new Date().toISOString(),
      players: { p1: { name: 'Robin' }, p2: { name: 'Kim' } }, game: { id: 'pokemon-emerald', system: 'gba', code: 'BPEE', title: 'POKEMON EMER' },
      randomizer: { enabled: false, values: {}, seeds: { p1: '1', p2: '2' } }, outputs: {}, rules: {},
    }));
    const api = async (pr, path, body, method) => {
      const r = await fetch(pr.base + path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { 'x-soullink': '1', 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const t = await r.text();
      if (!r.ok) throw new Error(`${pr.id} ${path}: ${r.status} ${t.slice(0, 300)}`);
      try { return JSON.parse(t); } catch { return t; }
    };
    for (const pr of profiles) await until(`server ${pr.id}`, async () => (await fetch(`${pr.base}/api/status`, { headers: { 'x-soullink': '1' } })).ok, 60000);
    const show = args.includes('--show');
    const wins = profiles.map((pr, i) => {
      const w = new BrowserWindow({ width: 1440, height: 900, x: 20 + i * 60, y: 20 + i * 40, show, webPreferences: { partition: `plus-e2e-${pr.id}`, backgroundThrottling: false } });
      w.webContents.setAudioMuted(true);
      w.loadURL(`${pr.base}/#/library`);
      return w;
    });
    const ev = (i, js) => wins[i].webContents.executeJavaScript(js, true);
    const go = async (i, hash, ready) => {
      await ev(i, `location.hash = ${JSON.stringify(hash)}; true`);
      if (ready) await until(`${hash} ${ready}`, () => ev(i, `!!document.querySelector(${JSON.stringify(ready)})`));
      await sleep(900);
    };
    const capture = async (w, name) => {
      writeFileSync(join(out, `${name}.png`), (await w.webContents.capturePage()).toPNG());
      log('shot', name);
    };
    const shot = async (i, name, { toasts = false } = {}) => {
      if (!toasts) await ev(i, `document.querySelectorAll('.toast').forEach((t) => t.click()); true`);
      await sleep(400);
      await capture(wins[i], name);
    };
    const click = (i, sel, text) => ev(i, `(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})]; const el = ${text ? `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))` : 'els[0]'}; if (!el) return false; el.click(); return true; })()`);
    const cos = (i, expr) => ev(i, `import('/lib/cosmetics/index.mjs').then((C) => ${expr})`);
    for (const [i] of profiles.entries()) await until(`page ${i}`, () => ev(i, '!!document.querySelector(".nav")'), 60000);

    // the "system browser": its own cookie jar, the real redirects, the fake authorize form, the confirmation page
    const browser = new BrowserWindow({ width: 900, height: 700, show, webPreferences: { partition: 'plus-e2e-system-browser' } });
    browser.webContents.setAudioMuted(true);
    const page = () => browser.webContents.getURL();
    const bev = (js) => browser.webContents.executeJavaScript(js, true);
    const signIn = async (pr, who, n) => {
      await go(n, '#/settings?s=account', '.acct-intro');
      const { url } = await api(pr, '/api/account/login', {});
      check(`${pr.name}: sign-in starts at the local Worker`, url.startsWith(`${PUBLIC}/auth/discord/start?`));
      await browser.loadURL(url);
      await until('fake authorize page', async () => page().includes('/dev/fake-discord/authorize') && (await bev('!!document.querySelector("form")')));
      if (n === 0) await capture(browser, '02a-browser-fake-discord');
      await bev(`(() => { const f = document.querySelector('form'); f.id.value = ${JSON.stringify(who.discordId)}; f.username.value = ${JSON.stringify(who.username)}; f.global_name.value = ${JSON.stringify(who.name)}; f.querySelector('button[value=authorize]').click(); return true; })()`);
      await until('confirmation page', async () => page().includes('/auth/discord/callback') && (await bev('!!document.querySelector("button[value=continue]")')), 30000);
      const confirmText = await bev('document.body.innerText');
      check(`${pr.name}: confirmation page asks "Sign in to souldew on this computer as ${who.name}?"`, confirmText.includes('Sign in to souldew on this computer as') && confirmText.includes(who.name));
      if (n === 0) await capture(browser, '02b-browser-confirmation-page');
      await bev(`document.querySelector('button[value=continue]').click(); true`);
      await until('loopback page', async () => page().startsWith(`${pr.base}/auth/done?r=`), 30000)
        .catch(async (e) => { console.error('browser at', page(), (await bev('document.title').catch(() => '')).slice(0, 120)); throw e; });
      check(`${pr.name}: loopback hand-off ok`, page().startsWith(`${pr.base}/auth/done?r=ok&n=`), page());
      if (n === 0) await capture(browser, '02c-browser-loopback-done');
      await until('signed in', () => ev(n, '!!document.querySelector(".acct-who")'));
      const me = (await api(pr, '/api/account')).me;
      check(`${pr.name}: signed in as @${me.handle}`, me && me.name === who.name);
      return me;
    };
    await shot(0, '01-account-signed-out');
    const robin = await signIn(HOST, { discordId: '200000000000000001', username: 'robin_dew', name: 'Robin' }, 0);
    await sleep(800);
    await shot(0, '03-account-signed-in');
    // a cancelled sign-in is a normal cancel, not an error
    {
      const { url } = await api(GUEST, '/api/account/login', {});
      await browser.loadURL(url);
      await until('fake authorize page (cancel)', async () => (await bev('!!document.querySelector("form")')));
      await bev(`document.querySelector('button[value=cancel]').click(); true`);
      await until('loopback page (cancel)', async () => page().startsWith(`${GUEST.base}/auth/done?r=`), 30000)
        .catch(async (e) => { console.error('browser at', page(), (await bev('document.body.innerText')).slice(0, 300)); throw e; });
      check('Kim: Cancel on the sign-in ends as "cancelled" in the app', page().startsWith(`${GUEST.base}/auth/done?r=denied&n=`), page());
      await capture(browser, '02d-browser-cancelled');
    }
    // ------------------------------------------------------------------ 4b · Kim, signed OUT, sees what souldew+ holds
    {
      const st = await api(GUEST, '/api/plus/previews');
      check('signed out: the app has the verified preview list', st.version === VERSION && Object.keys(st.files || {}).length > 20, JSON.stringify(st).slice(0, 120));
      await go(1, '#/settings?s=account', '.plus-show');
      await ev(1, `document.querySelector('.plus-show').scrollIntoView({ block: 'start' }); true`);
      const seen = async () => until('preview pictures', () => ev(1, `(() => { const i = [...document.querySelectorAll('.plus-show .cos-preview')]; return i.length && i.every((x) => x.complete && x.naturalWidth > 0) ? i.length : 0; })()`), 30000);
      check('signed out: Settings › Account shows the themes as pictures', (await seen()) >= 3);
      await shot(1, '06a-signed-out-plus-showcase');
      await ev(1, `[...document.querySelectorAll('.plus-show .seg button')].find((b) => b.textContent === 'Banners').click(); true`);
      await sleep(600);
      check('signed out: … and the banners', (await seen()) >= 3);
      // hovered (a hidden window has no focus, so its focus events don't fire – the hover does)
      await ev(1, `(() => { document.querySelector('.plus-show-item').dispatchEvent(new PointerEvent('pointerenter')); return true; })()`);
      await sleep(600);
      check('hovered: the banner plays its loop (animated WebP)', await ev(1, `document.querySelector('.plus-show-item img').getAttribute('src').includes('.webp')`));
      await shot(1, '06b-signed-out-plus-banners');
    }
    const kim = await signIn(GUEST, { discordId: '200000000000000002', username: 'kimchi_k', name: 'Kim' }, 1);

    // ------------------------------------------------------------------ 5 · friends, invite, join
    await api(HOST, '/api/account/friends/requests', { query: `@${kim.handle}` });
    const req = await until('request arrives', async () => (await api(GUEST, '/api/account/friends')).incoming[0]);
    await api(GUEST, `/api/account/friends/requests/${req.id}/accept`, {});
    const fr = await until('friends', async () => (await api(HOST, '/api/account/friends')).friends.find((f) => f.user.id === kim.id));
    check('Robin and Kim are friends', !!fr);
    await api(HOST, '/api/account/presence', { state: 'library' }, 'PUT');
    await api(GUEST, '/api/account/presence', { state: 'library' }, 'PUT');
    await go(0, '#/friends', '.fr-list');
    await click(0, '.fr-pick', 'Kim');
    await sleep(1500);
    await shot(0, '04-friends');
    // invite from the board's invite panel
    await go(0, `#/soullink?run=${RUN}`, '.run-steps, .board, main');
    await sleep(1500);
    await click(0, 'button', 'Invite player');
    await until('invite panel', () => ev(0, '!!document.querySelector(".fr-runinv")'));
    await click(0, '.fr-runinv .btn.go');
    await until('picker', () => ev(0, '!!document.querySelector(".fr-picklist")'));
    await click(0, '.fr-pickrow', 'Kim');
    await sleep(300);
    await click(0, '.modal-foot .btn.go');
    await until('invite out', () => ev(0, '!!document.querySelector(".fr-runinv .fr-inv")'), 30000);
    await sleep(800);
    await shot(0, '05-invite-sent');
    const inv = await until('invite at Kim', async () => (await api(GUEST, '/api/account/invites')).incoming.find((x) => x.status === 'pending'));
    check('Kim got the invite through the service', inv.run?.name === 'Emerald with Kim', JSON.stringify(inv.run));
    await go(1, '#/library', '.nav');
    await until('invite toast', () => ev(1, `[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('invites you'))`), 90000);
    await sleep(500);
    await shot(1, '06-invite-notification', { toasts: true });
    await click(1, '.toast .toast-action', 'Join');
    await until('join page', () => ev(1, '!!document.querySelector(".note")'), 30000);
    const accepted = await until('invite accepted', async () => (await api(GUEST, '/api/account/invites')).incoming.find((x) => x.id === inv.id && x.status === 'accepted'), 30000).catch(() => null);
    check('Kim joined with one click (invite accepted at the service)', !!accepted);
    await sleep(2500);
    await shot(1, '07-invite-join');
    const asked = await until('host asked', () => ev(0, `[...document.querySelectorAll('.toast, .fr-inv.asking')].some((t) => t.textContent.includes('wants to join'))`), 60000).catch(() => false);
    if (asked) {
      await shot(0, '08-host-allow', { toasts: true });
      await click(0, '.fr-inv.asking .btn.go') || await click(0, '.toast .toast-action', 'Allow');
      await until('pack on the guest', () => ev(1, `!!document.querySelector('.chip.ok') || document.body.textContent.includes('Your game')`), 60000).catch(() => null);
      await sleep(1200);
      await shot(1, '09-invite-joined');
      results.push({ what: 'run settings reached the guest over the P2P relay', ok: true, detail: 'public MQTT relay' });
    } else {
      results.push({ what: 'run settings over the P2P relay', ok: false, detail: 'relay not reachable (offline?) – not part of the service' });
      log('the P2P relay did not connect (needs internet) – the service part is done');
    }

    // ------------------------------------------------------------------ 6 · souldew+ via a signed BMC webhook + link in the app
    const email = 'robin.payer@example.test';
    const created = Math.floor(Date.now() / 1000);
    const hook = JSON.stringify({ type: 'membership.started', live_mode: true, attempt: 1, created, event_id: Date.now(),
      data: { id: 4242, object: 'membership', status: 'active', supporter_email: email, supporter_name: 'Robin', membership_level_id: 'lvl-plus', membership_level_name: 'souldew+', current_period_end: created + 30 * 86400 } });
    const sig = createHmac('sha256', secrets.BMC_WEBHOOK_SECRET).update(hook).digest('hex');
    const wh = await svc('POST', '/webhooks/bmc', hook, { 'X-Signature-Sha256': sig });
    check('signed BMC webhook (live_mode) accepted', wh.status === 200 && wh.body.ok === true && !wh.body.bmc_test_ok, JSON.stringify(wh.body));
    const forged = await svc('POST', '/webhooks/bmc', hook.replace('lvl-plus', 'lvl-patron'), { 'X-Signature-Sha256': sig });
    check('a webhook with a wrong signature is refused', forged.status === 401);
    await go(0, '#/settings?s=account', '.acct-who');
    await ev(0, `(() => { const d = [...document.querySelectorAll('details.group')].find((x) => x.textContent.includes('Link a membership')); d.open = true; d.scrollIntoView({ block: 'center' }); return true; })()`);
    await sleep(300);
    // a wrong email first: "submitted" – nothing found
    const typeEmail = (v) => ev(0, `(() => { const i = document.querySelector('input[type=email]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await typeEmail('nobody@example.test');
    await sleep(200);
    await click(0, 'details.group .btn', 'Link');
    await until('no match', () => ev(0, `document.body.innerText.includes('No membership found for this email')`), 30000);
    await shot(0, '10-link-email-nomatch');
    await typeEmail(email);
    await sleep(200);
    await click(0, 'details.group .btn', 'Link');
    await until('linked', () => ev(0, `document.body.innerText.includes('Linked – thank you!')`), 30000);
    await sleep(600);
    await shot(0, '11-link-email-linked');
    const ent = await api(HOST, '/api/account/entitlements');
    check('Robin is souldew+ (tier plus, badge, pack key)', ent.tier === 'plus' && ent.badges.includes('plus') && /^[A-Za-z0-9_-]{43}$/.test(ent.packKey || ''), `${ent.tier} ${ent.badges}`);
    const keyId1 = ent.packKeyId;

    // ------------------------------------------------------------------ 7 · the pack in the app
    await cos(0, 'C.refreshPack()');
    const st = await until('pack loaded', () => cos(0, 'C.packState()').then((s) => (s.entitled ? s : null)), 90000);
    check('pack downloaded per file, signature + every file verified, decrypted in the page', st.entitled && st.packVersion === VERSION && !st.error, JSON.stringify(st));
    const meta = await api(HOST, '/api/plus/pack/meta');
    check('the local cache holds only encrypted envelopes', meta.paths.length >= 20 && readdirSync(join(HOST.dir, 'plus', 'files')).every((f) => f.endsWith('.sdp'))
      && !readdirSync(join(HOST.dir, 'plus', 'files')).some((f) => readFileSync(join(HOST.dir, 'plus', 'files', f)).includes(Buffer.from('html[data-skin'))));
    // apply a skin in Settings › General › Theme
    await go(0, '#/settings?s=general', '.skin-setting');
    await ev(0, `document.querySelector('.skin-setting').scrollIntoView({ block: 'start' }); true`);
    await click(0, '[data-skin-preview="dusk"]');
    await until('skin preview', () => ev(0, `document.documentElement.dataset.skin === 'dusk'`));
    await sleep(700);
    await shot(0, '12-skin-preview-member');
    await click(0, '.skin-preview-bar .btn.go');
    await until('skin kept', () => ev(0, `!document.querySelector('.skin-preview-bar') && document.documentElement.dataset.skin === 'dusk'`));
    check('skin applied and saved', (await api(HOST, '/api/status')).config.skin === 'dusk');
    await go(0, '#/library', '.nav');
    await sleep(800);
    await shot(0, '13-skin-applied-library');
    // banner + frame + nameplate on the profile (the service checks the catalog tier)
    const catalog = await cos(0, '({ b: C.catalog().banners.filter((x) => x.plus && x.owned).map((x) => x.id), f: C.catalog().frames.filter((x) => x.plus && x.owned).map((x) => x.id) })');
    const banner = catalog.b.includes('night-marsh') ? 'night-marsh' : catalog.b[0];
    const frame = catalog.f[0];
    // the profile editor itself (the parts drawer): pick a souldew+ banner, frame and nameplate and press Save – a
    // member's picks are kept (no "comes with souldew+" line) → PATCH /v1/me, the service checks the tier
    await go(0, '#/profile', '.pf-mast');
    await click(0, '.pf-actions .btn', 'Edit profile');
    await until('editor', () => ev(0, '!!document.querySelector(".pe-drawer .pe-pcard")'));
    const nameplate = catalog.b.find((x) => x !== banner) || banner;
    for (const [part, id] of [['banner', banner], ['frame', frame], ['nameplate', nameplate]]) {
      await click(0, `.pe-pcard[data-card="${part}"]`);
      await until(`${part} picker`, () => ev(0, `!!document.querySelector('.pe-body.p-${part} .pe-card')`));
      check(`editor: ${part} ${id} picked`, await ev(0, `(() => { const b = document.querySelector('.pe-body [data-cos-id=${JSON.stringify(id)}]'); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; })()`));
      await sleep(300);
      await click(0, '.pe-back');
      await sleep(200);
    }
    check('editor: no "comes with souldew+" line for a member, three changes', await ev(0, `!document.querySelector('.pe-lock') && document.querySelector('.pe-bar-hint').textContent.startsWith('3')`));
    await shot(0, '13b-editor-nameplate-picked');
    await click(0, '.pe-bar .btn.primary', 'Save');
    await until('editor closed', () => ev(0, '!document.querySelector(".pe")'), 20000);
    const saved = (await api(HOST, '/api/account')).me;
    check(`editor saved banner ${banner}, frame ${frame} and nameplate ${nameplate}`, saved.banner === banner && saved.frame === frame && saved.nameplate === nameplate, JSON.stringify({ b: saved.banner, f: saved.frame, n: saved.nameplate }));
    await ev(0, `import('/lib/account.mjs').then((A) => A.updateMe({ accent: 'tide' })).then(() => true)`);
    const drawn = await until('banner + frame drawn', () => ev(0, `!!document.querySelector('.pf-banner canvas') && !!document.querySelector('.pf-mast .cos-frame canvas')`), 20000).catch(() => false);
    check('banner and frame drawn on the own profile', drawn);
    // the frame's pixels really arrive from the sandboxed pack worker (web/lib/cosmetics/sandbox.mjs, canvas-proxy.mjs)
    const framePixels = await until('frame pixels', () => ev(0, `(() => { const c = document.querySelector('.pf-mast .cos-frame canvas'); if (!c) return 0;
      const p = document.createElement('canvas'); p.width = c.width || 1; p.height = c.height || 1; const x = p.getContext('2d'); x.drawImage(c, 0, 0);
      const d = x.getImageData(0, 0, p.width, p.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; })()`), 20000).catch(() => 0);
    check('the frame is painted by the sandboxed pack worker', framePixels > 100, `${framePixels} px`);
    check('own profile shows the souldew+ badge', await ev(0, `!!document.querySelector('.pf-mast .acct-badge.plus')`));
    await sleep(2500);
    await shot(0, '14-profile-banner-frame');
    const kimSees = await api(GUEST, `/api/account/users/${robin.id}`);
    check(`Kim sees Robin's banner ${banner}, frame ${frame}, nameplate ${nameplate} and the souldew+ badge`, kimSees.banner === banner && kimSees.frame === frame && kimSees.nameplate === nameplate && kimSees.badges.includes('plus'), JSON.stringify({ b: kimSees.banner, f: kimSees.frame, n: kimSees.nameplate, badges: kimSees.badges }));
    await go(1, '#/friends', '.fr-list');
    await click(1, '.fr-pick', 'Robin');
    await sleep(2000);
    await shot(1, '15-friends-sees-plus-badge');
    // launch animation preview (Settings › Play)
    await go(0, '#/settings?s=play', '.launch-picker');
    await ev(0, `document.querySelector('.launch-picker').scrollIntoView({ block: 'center' }); true`);
    const anims = await ev(0, `[...document.querySelectorAll('.launch-card')].map((b) => b.textContent)`);
    check('souldew+ launch animations offered', anims.length > 1, anims.join(' | ').slice(0, 120));
    await ev(0, `document.querySelectorAll('.launch-card')[1].click(); true`);
    await sleep(900);
    await shot(0, '16-launch-animation-preview');
    await sleep(1200);
    await shot(0, '16b-launch-animation-preview-later');

    // ------------------------------------------------------------------ 8 · Kim tries a theme for 15 minutes
    await go(1, '#/settings?s=general', '.skin-setting');
    await ev(1, `document.querySelector('.skin-setting').scrollIntoView({ block: 'start' }); true`);
    check('the theme picker holds colour skins only (no editions)', await ev(1, `!document.querySelector('[data-skin-preview="fieldbook"], [data-skin-preview="clearshell"], [data-skin-preview="woodgrain"], [data-skin-preview="enamel"]') && document.querySelectorAll('.skin-group').length === 2`));
    await click(1, '[data-skin-preview="sakura"]');
    await until('locked bar', () => ev(1, `document.body.innerText.includes('try it on for 15 minutes')`));
    await shot(1, '17-preview-offer');
    await click(1, '.skin-preview-bar .btn', 'Try for 15 minutes');
    await until('preview running', () => ev(1, `document.documentElement.dataset.skin === 'sakura' && !!document.querySelector('.skin-live-badge')`), 60000);
    await sleep(800);
    await shot(1, '18-preview-running');
    const kimEnt = await api(GUEST, '/api/account/entitlements');
    check('Kim: preview running, still not a member', kimEnt.tier === 'none' && kimEnt.preview?.packId === 'skins-preview');
    check('the preview is not written to disk', !existsSync(join(GUEST.dir, 'plus', 'pack.json')));
    const kimState = await cos(1, 'C.packState()');
    check('preview ends at expires_at (15 min)', kimState.preview && Math.abs(Date.parse(kimState.previewUntil) - Date.now() - 15 * 60e3) < 60e3, kimState.previewUntil);
    // the service's limits come through: 3 at once
    const extra = [];
    for (let k = 0; k < 3; k++) extra.push(await fetch(`${GUEST.base}/api/account/packs/skins-preview/preview`, { method: 'POST', headers: { 'x-soullink': '1', 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json().then((b) => [r.status, b.vars?.code])));
    check('a 4th preview at once is refused (limit_reached)', extra.some(([s, c]) => s === 409 && c === 'limit_reached'), JSON.stringify(extra));
    await cos(1, 'C.endPackPreview()');
    await until('preview ended', () => ev(1, `!document.documentElement.dataset.skin`));
    await sleep(500);
    await shot(1, '19-preview-ended');

    // ------------------------------------------------------------------ 9 · unlink → key rotated → cache wiped
    await api(HOST, '/api/account/link', undefined, 'DELETE');
    check('unlink wipes the encrypted cache at once', !existsSync(join(HOST.dir, 'plus', 'pack.json')) && !existsSync(join(HOST.dir, 'plus', 'files')));
    const ent2 = await api(HOST, '/api/account/entitlements');
    check('tier gone, pack key rotated', ent2.tier === 'none' && !ent2.packKey && ent2.packKeyId !== keyId1, `${ent2.tier} ${ent2.packKeyId}`);
    await cos(0, 'C.refreshPack()');
    await until('pack gone in the page', () => cos(0, 'C.packState()').then((s) => !s.entitled));
    await go(0, '#/settings?s=general', '.skin-setting');
    await until('skin back to classic', () => ev(0, `!document.documentElement.dataset.skin`));
    await sleep(600);
    await shot(0, '20-after-unlink-theme-back');
    check('the theme waits for souldew+ (pending), the app looks like itself', await ev(0, `document.body.innerText.includes('is back as soon as souldew+ is active')`));

    const failed = results.filter((r) => !r.ok);
    log(`done: ${results.length - failed.length}/${results.length} checks passed →`, out);
    await finish(failed.some((r) => !/P2P relay/.test(r.what)) ? 1 : 0);
  } catch (e) {
    console.error(e);
    try {
      for (const [i, w] of BrowserWindow.getAllWindows().entries()) writeFileSync(join(out, `fail-${i}.png`), (await w.webContents.capturePage()).toPNG());
    } catch {}
    await finish(1);
  }
}
