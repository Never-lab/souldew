// souldew+ pack client (renderer). Gets the pack access from the account client, has the local server download and cache
// the ENCRYPTED pack, decrypts and verifies it here in the page, and loads its CSS / data / signed modules into memory.
// Nothing premium is ever stored in plain form, and nothing from a pack runs in the Node or main process.
//
// The account client plugs in with setPackAccessProvider(fn). fn({ purpose: 'pack' | 'preview' }) resolves to
//   { url, key, manifestSig, until, packVersion }   – the account owns souldew+ (key and signature from the entitlement)
//   { ..., preview: true }                            – a preview pack: every look can be tried, none kept
//   { ..., offline: true }                            – the service is unreachable; the last access from safeStorage
//   null                                              – signed out / no membership (the cache is wiped)
// and throws (any error) when it can't tell – that counts as offline.
import { openPack, packError, text } from './format.mjs';
import { trustedKeys } from './keys.mjs';
import { state, update, setContent } from '../state.mjs';

export const GRACE_MS = 7 * 24 * 3600 * 1000;
const RECHECK_MS = 6 * 3600 * 1000;
const DEV = Symbol('dev-access');

const headers = { 'x-soullink': '1' };
async function call(method, url, body) {
  const res = await fetch(url, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw packError(res.status === 404 ? 'none' : 'server', `${method} ${url}: ${res.status}`);
  return res.headers.get('content-type')?.includes('json') ? res.json() : new Uint8Array(await res.arrayBuffer());
}

/** Without an account client: the dev pack, when the local server was started with one (SLS_PLUS_DEV_PACK). */
async function devProvider({ purpose } = {}) {
  let a;
  try {
    a = await call('GET', '/api/plus/dev/access');
  } catch {
    return null;
  }
  let preview = false;
  try {
    preview = localStorage.getItem('sl-plus-dev-preview') === '1'; // try the non-member preview flow with the test pack
  } catch {
    // storage blocked
  }
  if (preview && purpose === 'pack') return null;
  return { ...a, preview, [DEV]: true };
}

let provider = devProvider;
/** The account client's hook (see the top of this file). Passing null restores the dev / signed-out default. */
export function setPackAccessProvider(fn) {
  provider = typeof fn === 'function' ? fn : devProvider;
}
export async function getPackAccess(opts = {}) {
  return provider(opts);
}

let inflight = null;
let timer = 0;
const clearContent = () => setContent(null);

async function wipe(error = null) {
  clearContent();
  try {
    await call('DELETE', '/api/plus/pack');
  } catch {
    // the server wipes an expired cache on its own as well
  }
  update({ entitled: false, preview: false, until: null, packVersion: null, error });
}

/** Turns the verified files into in-memory content. */
export function contentFrom(files) {
  const json = (p) => (files.has(p) ? JSON.parse(text(files.get(p))) : null);
  const contents = json('contents.json') || {};
  const skinCss = [];
  for (const s of contents.skins || []) if (files.has(s.css) && /^[a-z0-9-]{1,40}$/.test(s.id)) skinCss.push([s.id, text(files.get(s.css))]);
  const assets = [...files].filter(([p]) => /^(fonts|assets)\//.test(p));
  return {
    banners: contents.banners ? json(contents.banners) || [] : [],
    skinCss,
    files: assets,
    framesModule: contents.frames?.module && files.has(contents.frames.module) ? text(files.get(contents.frames.module)) : null,
    frameIds: contents.frames?.ids || [],
    launchModule: contents.launch?.module && files.has(contents.launch.module) ? text(files.get(contents.launch.module)) : null,
    launchIds: contents.launch?.ids || [],
  };
}

async function accessFor(purpose) {
  try {
    return { access: await provider({ purpose }), offline: false };
  } catch {
    return { access: null, offline: true };
  }
}

async function run() {
  update({ loading: true });
  try {
    let { access, offline } = await accessFor('pack');
    if (!access && !offline) {
      const p = await accessFor('preview');
      if (p.access) access = { ...p.access, preview: true };
    }
    if (access?.offline) offline = true;
    let meta = await call('GET', '/api/plus/pack/meta').catch(() => ({ none: true }));
    if (!access && !offline) return wipe(null); // signed out or no membership
    if (offline) {
      // the server has already dropped a cache older than the grace period
      if (meta.none) {
        clearContent(); // nothing cached, or the grace period ran out on the server's side
        return update({ entitled: false, preview: false, until: null, packVersion: null, error: 'offline' });
      }
      if (!(Date.now() - Date.parse(meta.lastOnline) <= GRACE_MS)) return wipe('expired');
      if (!access?.key) return update({ error: 'offline' }); // can't decrypt without the account's key – keep the cache for later
    } else if (access.until && Date.parse(access.until) < Date.now()) {
      return wipe('expired');
    } else if (meta.none || !access.packVersion || meta.packVersion !== access.packVersion) {
      meta = await call('POST', '/api/plus/pack/fetch', { url: access.url, packVersion: access.packVersion, until: access.until });
    } else {
      meta = await call('POST', '/api/plus/pack/meta', { lastOnline: new Date().toISOString(), until: access.until || null });
    }
    const keys = trustedKeys(access[DEV] ? access.publicKey : null);
    let pack;
    for (let attempt = 0; ; attempt++) {
      try {
        pack = await openPack(await call('GET', '/api/plus/pack'), { key: access.key, manifestSig: access.manifestSig, keys });
        break;
      } catch (e) {
        // a damaged download (or one cached for another key): fetch it once more while online
        if (attempt === 0 && !offline && ['decrypt', 'hash', 'envelope', 'archive'].includes(e.code)) {
          meta = await call('POST', '/api/plus/pack/fetch', { url: access.url, packVersion: access.packVersion, until: access.until });
          continue;
        }
        throw e;
      }
    }
    setContent(contentFrom(pack.files));
    update({ entitled: !access.preview, preview: !!access.preview, until: access.until || meta.until || null, packVersion: pack.packVersion, error: offline ? 'offline' : null });
  } catch (e) {
    const code = e?.code || 'error';
    if (code === 'signature' || code === 'manifest') await wipe(code); // never keep a pack that doesn't verify
    else {
      clearContent();
      update({ entitled: false, preview: false, error: code === 'server' || code === 'none' ? 'download' : code });
    }
  } finally {
    update({ loading: false });
    schedule();
  }
}

function schedule() {
  clearTimeout(timer);
  if (typeof setTimeout !== 'function') return;
  // re-check the membership now and then, and right when it is due to end
  const untilIn = state.until ? Date.parse(state.until) - Date.now() + 1000 : Infinity;
  const ms = Math.max(5000, Math.min(RECHECK_MS, untilIn));
  timer = setTimeout(() => refreshPack(), ms);
  timer?.unref?.();
}

/** Loads (or re-checks) the pack. Concurrent calls share one run. */
export function refreshPack() {
  if (!inflight) inflight = run().finally(() => { inflight = null; });
  return inflight;
}

/** Signed out / "remove souldew+ from this computer": forget everything now. */
export async function forgetPack() {
  clearTimeout(timer);
  await wipe(null);
}

export function packState() {
  return { entitled: state.entitled, preview: state.preview, until: state.until, packVersion: state.packVersion, loading: state.loading, error: state.error };
}
