// souldew+ pack cache and lifecycle: the server's encrypted cache (allow-listed downloads, offline grace, wipe) and the
// page's pack client on top of it (load, not a member, membership ended, offline within / beyond the grace period,
// a pack that doesn't verify, a damaged download).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlusPack, packUrlAllowed, GRACE_MS } from '../server/lib/pluspack.mjs';
import { buildArchive, sealEnvelope, makeSigner, b64encode } from '../web/lib/cosmetics/pack/format.mjs';

const enc = new TextEncoder();
const DAY = 86400e3;
const URL_OK = 'https://accounts.souldew.app/pack/abc?sig=1';

async function makePack(version = 'v1') {
  const signer = await makeSigner();
  const files = [
    { path: 'contents.json', bytes: enc.encode(JSON.stringify({ skins: [{ id: 'moss', css: 'skins/moss.css' }], banners: 'banners.json', launch: { module: 'launch.mjs', ids: ['gust'] } })) },
    { path: 'skins/moss.css', bytes: enc.encode("html[data-skin='moss'] { --shell: #1f2a20; } .x { background: url('pack:assets/a.svg') }") },
    { path: 'assets/a.svg', bytes: enc.encode('<svg xmlns="http://www.w3.org/2000/svg"/>') },
    { path: 'banners.json', bytes: enc.encode(JSON.stringify([{ id: 'night-marsh', name: 'Night Marsh', pal: { a: '#000000' }, layers: [] }])) },
    { path: 'launch.mjs', bytes: enc.encode('export const ANIMS = [];') },
  ];
  const { archive, sig } = await buildArchive({ packVersion: version, files }, signer.sign);
  const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const env = await sealEnvelope(archive, key, { watermark: 'acct', packVersion: version });
  return { signer, sig, key, env, version };
}

const fakeFetch = (bytes, status = 200) => async () => ({
  ok: status === 200, status, headers: new Map([['content-length', String(bytes.length)]]),
  body: (async function* chunks() { yield bytes; })(),
});

// ------------------------------------------------------------------ server cache
test('pack URLs: https on souldew.app only (no SSRF to other hosts, http, IPs, credentials, ports)', () => {
  assert.ok(packUrlAllowed(URL_OK));
  assert.ok(packUrlAllowed('https://packs.souldew.app/x'));
  for (const u of ['http://accounts.souldew.app/x', 'https://souldew.app.evil.com/x', 'https://evil.com/souldew.app', 'https://127.0.0.1/x',
    'https://user:pw@accounts.souldew.app/x', 'https://accounts.souldew.app:8443/x', 'file:///etc/passwd', 'souldew-dev:pack.sdpk', '', null]) {
    assert.equal(packUrlAllowed(u), false, String(u));
  }
  assert.ok(packUrlAllowed('souldew-dev:pack.sdpk', { dev: true }), 'the dev pack only with SLS_PLUS_DEV_PACK');
});

test('server cache: download, meta, touch only forward, wipe; the bytes stay encrypted', async () => {
  const p = await makePack();
  const dir = mkdtempSync(join(tmpdir(), 'souldew-plus-'));
  let now = Date.parse('2026-11-17T12:00:00Z');
  const plus = createPlusPack({ dir, devDir: '', fetchImpl: fakeFetch(p.env), now: () => now });
  assert.deepEqual(plus.meta(), { none: true });
  await assert.rejects(plus.fetch({ url: 'https://evil.com/p' }), { code: 'plusUrl' });
  const meta = await plus.fetch({ url: URL_OK, packVersion: 'v1', until: '2026-12-17T00:00:00Z' });
  assert.equal(meta.packVersion, 'v1');
  assert.deepEqual(new Uint8Array(plus.pack()), p.env, 'the cache is the envelope as downloaded – never decrypted on the server');
  assert.ok(!readFileSync(join(dir, 'pack.sdpk')).includes(Buffer.from('--shell')), 'no plain CSS on disk');
  now += DAY;
  assert.equal(plus.touch({ lastOnline: new Date(now).toISOString() }).lastOnline, new Date(now).toISOString());
  assert.equal(plus.touch({ lastOnline: new Date(now - 5 * DAY).toISOString() }).lastOnline, new Date(now).toISOString(), 'never backwards');
  assert.equal(plus.touch({ lastOnline: new Date(now + 30 * DAY).toISOString() }).lastOnline, new Date(now).toISOString(), 'never past the clock');
  plus.wipe();
  assert.ok(!existsSync(join(dir, 'pack.sdpk')) && !existsSync(join(dir, 'pack.json')));
  await assert.rejects(async () => plus.pack(), { code: 'plusNone' });
});

test('server cache: wiped once the offline grace (7 days) is over, also when the clock jumps', async () => {
  const p = await makePack();
  const dir = mkdtempSync(join(tmpdir(), 'souldew-plus-'));
  let now = Date.parse('2026-11-17T12:00:00Z');
  const plus = createPlusPack({ dir, devDir: '', fetchImpl: fakeFetch(p.env), now: () => now });
  await plus.fetch({ url: URL_OK, packVersion: 'v1' });
  now += GRACE_MS - 1000;
  assert.ok(!plus.meta().none, 'still inside the grace period');
  now += 2000;
  assert.ok(plus.meta().none, 'grace over → wiped');
  assert.ok(!existsSync(join(dir, 'pack.sdpk')));
  await plus.fetch({ url: URL_OK, packVersion: 'v1' });
  now -= 30 * DAY; // the clock was set back far
  assert.ok(plus.meta().none);
});

test('server cache: refuses non-packs, oversized and failed downloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-plus-'));
  await assert.rejects(createPlusPack({ dir, devDir: '', fetchImpl: fakeFetch(enc.encode('<html>login</html>xxxxxx')) }).fetch({ url: URL_OK }), { code: 'plusFormat' });
  await assert.rejects(createPlusPack({ dir, devDir: '', fetchImpl: fakeFetch(enc.encode('x'), 403) }).fetch({ url: URL_OK }), { code: 'plusDownload' });
  const big = async () => ({ ok: true, status: 200, headers: new Map([['content-length', String(200 * 1024 * 1024)]]), body: (async function* g() {})() });
  await assert.rejects(createPlusPack({ dir, devDir: '', fetchImpl: big }).fetch({ url: URL_OK }), { code: 'plusTooLarge' });
  assert.ok(!existsSync(join(dir, 'pack.sdpk')));
});

// ------------------------------------------------------------------ page client on top of the real server module
let server, serverNow;
const realNow = Date.now;
function installFetch(p) {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-plus-'));
  serverNow = realNow();
  const downloads = { n: 0, bytes: p.env };
  server = createPlusPack({ dir, devDir: '', now: () => serverNow, fetchImpl: async () => { downloads.n++; return fakeFetch(downloads.bytes)(); } });
  const json = (v) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => v });
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    const m = opts.method || 'GET';
    try {
      if (url === '/api/plus/pack/meta' && m === 'GET') return json(server.meta());
      if (url === '/api/plus/pack/meta' && m === 'POST') return json(server.touch(body));
      if (url === '/api/plus/pack/fetch') return json(await server.fetch(body));
      if (url === '/api/plus/pack' && m === 'DELETE') return json(server.wipe());
      if (url === '/api/plus/pack') { const b = server.pack(); return { ok: true, status: 200, headers: { get: () => 'application/octet-stream' }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; }
    } catch (e) {
      return { ok: false, status: e.status || 500, headers: { get: () => 'application/json' }, json: async () => ({}) };
    }
    return { ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => ({}) };
  };
  return downloads;
}

const C = await import('../web/lib/cosmetics/pack/client.mjs');
const S = await import('../web/lib/cosmetics/state.mjs');
const access = (p, extra = {}) => ({ url: URL_OK, key: b64encode(p.key), manifestSig: b64encode(p.sig), until: new Date(realNow() + 30 * DAY).toISOString(), packVersion: p.version, ...extra });
// the pinned production key is a placeholder: the tests sign with their own key and trust it through the keys module
const K = await import('../web/lib/cosmetics/pack/keys.mjs');

beforeEach(() => { Date.now = realNow; });

test('client: a member loads the pack – content in memory, entitled, nothing premium before that', async () => {
  const p = await makePack();
  installFetch(p);
  K.PRODUCTION_KEYS.push(b64encode(p.signer.publicKey));
  try {
    C.setPackAccessProvider(async () => access(p));
    assert.equal(S.has('skins', 'moss'), false);
    await C.refreshPack();
    assert.deepEqual({ ...C.packState(), until: null }, { entitled: true, preview: false, until: null, packVersion: 'v1', loading: false, error: null });
    assert.ok(S.has('skins', 'moss') && S.owned('skins', 'moss'));
    assert.ok(S.content.banners.has('night-marsh') && S.content.banners.has('lcd-grid'), 'pack banners next to the free ones');
    assert.ok(S.content.launchIds.has('gust'));
  } finally {
    K.PRODUCTION_KEYS.pop();
  }
});

test('client: signed out / no membership → cache wiped, only free content', async () => {
  const p = await makePack();
  installFetch(p);
  K.PRODUCTION_KEYS.push(b64encode(p.signer.publicKey));
  try {
    C.setPackAccessProvider(async () => access(p));
    await C.refreshPack();
    C.setPackAccessProvider(async () => null);
    await C.refreshPack();
    assert.equal(C.packState().entitled, false);
    assert.ok(server.meta().none, 'cache wiped');
    assert.equal(S.has('skins', 'moss'), false);
    assert.ok(S.content.banners.has('lcd-grid') && !S.content.banners.has('night-marsh'));
  } finally {
    K.PRODUCTION_KEYS.pop();
  }
});

test('client: membership ended (until in the past) → wiped, error "expired"', async () => {
  const p = await makePack();
  installFetch(p);
  K.PRODUCTION_KEYS.push(b64encode(p.signer.publicKey));
  try {
    C.setPackAccessProvider(async () => access(p));
    await C.refreshPack();
    C.setPackAccessProvider(async () => access(p, { until: new Date(realNow() - 1000).toISOString() }));
    await C.refreshPack();
    assert.equal(C.packState().entitled, false);
    assert.equal(C.packState().error, 'expired');
    assert.ok(server.meta().none);
  } finally {
    K.PRODUCTION_KEYS.pop();
  }
});

test('client: offline grace – works from the cache for 7 days, then the cache is wiped', async () => {
  const p = await makePack();
  const downloads = installFetch(p);
  K.PRODUCTION_KEYS.push(b64encode(p.signer.publicKey));
  try {
    C.setPackAccessProvider(async () => access(p));
    await C.refreshPack();
    assert.equal(downloads.n, 1);
    // the service is unreachable: the account client hands out the last access it kept (safeStorage)
    C.setPackAccessProvider(async () => access(p, { offline: true }));
    serverNow = realNow() + 6 * DAY;
    Date.now = () => serverNow;
    await C.refreshPack();
    assert.equal(C.packState().entitled, true, 'day 6 offline: still entitled');
    assert.equal(C.packState().error, 'offline');
    assert.equal(downloads.n, 1, 'no download while offline');
    // the provider throwing counts as offline too – but without a key the cache can't be read
    C.setPackAccessProvider(async () => { throw new Error('ENOTFOUND'); });
    await C.refreshPack();
    assert.equal(C.packState().error, 'offline');
    assert.ok(!server.meta().none, 'kept for when the key is back');
    serverNow = realNow() + 8 * DAY;
    Date.now = () => serverNow;
    C.setPackAccessProvider(async () => access(p, { offline: true }));
    await C.refreshPack();
    assert.equal(C.packState().entitled, false, 'day 8 offline: over');
    assert.ok(server.meta().none, 'wiped');
    assert.equal(S.has('skins', 'moss'), false);
  } finally {
    K.PRODUCTION_KEYS.pop();
  }
});

test('client: a pack that does not verify is wiped and never used', async () => {
  const p = await makePack();
  installFetch(p);
  // the production key is still the placeholder: nothing verifies
  C.setPackAccessProvider(async () => access(p));
  await C.refreshPack();
  assert.equal(C.packState().entitled, false);
  assert.equal(C.packState().error, 'signature');
  assert.ok(server.meta().none);
  assert.equal(S.has('skins', 'moss'), false);
});

test('client: a damaged cached pack is downloaded once more; a wrong key fails cleanly', async () => {
  const p = await makePack();
  const downloads = installFetch(p);
  K.PRODUCTION_KEYS.push(b64encode(p.signer.publicKey));
  try {
    const broken = p.env.slice();
    broken[broken.length - 3] ^= 1;
    downloads.bytes = broken;
    C.setPackAccessProvider(async () => access(p));
    await C.refreshPack();
    assert.equal(C.packState().error, 'decrypt');
    assert.equal(downloads.n, 2, 'one retry, then it stops');
    downloads.bytes = p.env;
    await C.refreshPack();
    assert.equal(C.packState().entitled, true);
    C.setPackAccessProvider(async () => access(p, { key: b64encode(new Uint8Array(32)) }));
    await C.refreshPack();
    assert.equal(C.packState().entitled, false);
    assert.equal(S.has('skins', 'moss'), false);
  } finally {
    K.PRODUCTION_KEYS.pop();
  }
});

test('client: a preview pack lets everything be tried and nothing be owned', async () => {
  const p = await makePack();
  installFetch(p);
  K.PRODUCTION_KEYS.push(b64encode(p.signer.publicKey));
  try {
    C.setPackAccessProvider(async ({ purpose }) => (purpose === 'preview' ? access(p) : null));
    await C.refreshPack();
    assert.equal(C.packState().preview, true);
    assert.equal(C.packState().entitled, false);
    assert.ok(S.has('skins', 'moss'));
    assert.equal(S.owned('skins', 'moss'), false);
  } finally {
    K.PRODUCTION_KEYS.pop();
    await C.forgetPack();
  }
});
