// souldew+ premium pack cache on disk. The server only ever holds what the accounts service hands out – the signed
// manifest and the per-file ENCRYPTED envelopes (API.md §10). It never sees a pack key, never decrypts, verifies or runs
// anything from a pack: it downloads the envelopes from the short-lived signed URLs, keeps them in the data folder,
// hands them to the app's own page (which verifies and decrypts in memory), and wipes them.
//
//   GET    /api/plus/pack/meta          { packId, version, manifest, signature, keyId, watermark, paths, fetchedAt,
//                                        lastOnline, until } or { none: true }
//   GET    /api/plus/pack/file?path=    one cached envelope (bytes)                           – PRIVATE_GETS
//   POST   /api/plus/pack/fetch         the service's download answer + until → downloads what isn't cached yet
//                                        (unchanged files of an older version with the same key are kept: small updates)
//   POST   /api/plus/pack/meta          { lastOnline?, until? } – the page confirmed the membership online
//   DELETE /api/plus/pack               wipe (signed out, membership ended, key changed, offline grace over)
//   POST   /api/plus/fetch              { url } → one envelope, NOT stored (live theme preview: memory only, no grace)
//   GET    /api/plus/dev/access?purpose=pack|preview   only with SLS_PLUS_DEV_PACK (scripts/plus-dev-pack.mjs)
//   GET    /api/plus/dev/key            the throwaway pack key to trust – only with SLS_PLUS_DEV_PACK, or with
//                                        SLS_PLUS_DEV_KEY while SLS_ACCOUNTS_URL points at a service on this computer
//
// Offline grace is enforced here as well as in the page: a cache whose last online confirmation is older than GRACE_MS
// is wiped the moment anything asks for it.
import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic, httpError } from './fsutil.mjs';
import { accountsBase } from './accounts/contract.mjs';

export const GRACE_MS = 7 * 24 * 3600 * 1000;
export const MAX_FILE_BYTES = 8 * 1024 * 1024 + 4096; // a file plus its envelope header and tag
export const MAX_PACK_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 2000;
const DEV_SCHEME = 'souldew-dev:';
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const validPath = (p) => typeof p === 'string' && p.length <= 200 && PATH_RE.test(p) && !p.split('/').some((s) => s === '.' || s === '..');
const B64URL = (v, max) => typeof v === 'string' && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);
const isLoopback = (host) => ['127.0.0.1', 'localhost', '[::1]'].includes(host);

/**
 * Where a pack file may come from: the accounts service – https on souldew.app, or the address SLS_ACCOUNTS_URL names
 * (which accountsBase only takes when it is https or http on this computer). Anything else (another host, http, an
 * IP, credentials in the URL, another port) is refused, so a page can't turn this into a request elsewhere (SSRF).
 */
export function packUrlAllowed(raw, { dev = false, env = process.env } = {}) {
  if (typeof raw === 'string' && raw.startsWith(DEV_SCHEME)) {
    const m = /^(pack|preview)\/(.+)$/.exec(raw.slice(DEV_SCHEME.length));
    return dev && !!m && validPath(m[2]);
  }
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  const service = new URL(accountsBase(env));
  if (u.origin === service.origin && service.origin !== 'https://accounts.souldew.app') return true; // the configured dev/test service
  if (u.protocol !== 'https:' || (u.port && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase();
  return host === 'souldew.app' || host.endsWith('.souldew.app');
}

const isoOrNull = (v) => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
const sha = (s) => createHash('sha256').update(s).digest('hex');

export function createPlusPack({ dir, devDir = process.env.SLS_PLUS_DEV_PACK || '', fetchImpl = globalThis.fetch, now = () => Date.now(), env = process.env } = {}) {
  const metaFile = join(dir, 'pack.json');
  const filesDir = join(dir, 'files');
  const dev = devDir ? resolve(devDir) : '';

  const readMeta = () => {
    try {
      return JSON.parse(readFileSync(metaFile, 'utf8'));
    } catch {
      return null;
    }
  };
  /** Removes the cached envelopes not named in `keep` (a Set of file names), then the folder when it is empty. */
  function prune(keep = new Set()) {
    if (!existsSync(filesDir)) return;
    for (const name of readdirSync(filesDir)) {
      if (keep.has(name) || !/^[0-9a-f]{64}\.sdp(\.\d+\.tmp)?$/.test(name)) continue;
      rmSync(join(filesDir, name), { force: true });
    }
    try {
      if (!keep.size) rmdirSync(filesDir);
    } catch {
      // not empty (a file we don't own) – left alone
    }
  }
  function wipe() {
    rmSync(metaFile, { force: true });
    prune();
    return { wiped: true };
  }
  const fileName = (path, contentSha, keyId) => `${sha(`${path}\n${contentSha}\n${keyId}`)}.sdp`;
  const hasAll = (m) => m?.files && Object.values(m.files).every((f) => existsSync(join(filesDir, f.file)));

  /** the meta of a usable cache, or null (and the cache is gone) */
  function current() {
    const m = readMeta();
    if (!m || !hasAll(m)) {
      if (m || existsSync(filesDir)) wipe();
      return null;
    }
    const last = Date.parse(m.lastOnline || m.fetchedAt || 0);
    if (!Number.isFinite(last) || now() - last > GRACE_MS || last - now() > GRACE_MS) {
      wipe(); // offline for longer than the grace period (or a clock that jumped far ahead): the membership is unconfirmed
      return null;
    }
    return m;
  }

  async function download(url, max = MAX_FILE_BYTES) {
    if (url.startsWith(DEV_SCHEME)) {
      const rel = url.slice(DEV_SCHEME.length);
      return readFileSync(join(dev, ...rel.split('/').map((s, i) => (i === 0 ? `sealed-${s}` : s))));
    }
    const res = await fetchImpl(url, { redirect: 'error', headers: { accept: 'application/octet-stream' }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw httpError(502, `Pack download failed (${res.status})`, 'plusDownload', { status: res.status });
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > max) throw httpError(502, 'Pack file too large', 'plusTooLarge');
    const chunks = [];
    let size = 0;
    for await (const c of res.body) {
      size += c.length;
      if (size > max) throw httpError(502, 'Pack file too large', 'plusTooLarge');
      chunks.push(Buffer.from(c));
    }
    const buf = Buffer.concat(chunks);
    if (buf.length < 22 || buf.subarray(0, 4).toString('latin1') !== 'SDP1') throw httpError(502, 'Not a souldew+ file', 'plusFormat');
    return buf;
  }

  /** The service's download answer → checked shape (the page verifies the signature and every byte later). */
  function answer(body) {
    const b = body && typeof body === 'object' ? body : {};
    const packId = typeof b.packId === 'string' && /^[a-z0-9][a-z0-9-]{1,47}$/.test(b.packId) ? b.packId : null;
    const version = typeof b.version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(b.version) ? b.version : null;
    const keyId = typeof b.keyId === 'string' && /^\d{1,9}$/.test(b.keyId) ? b.keyId : null;
    const watermark = typeof b.watermark === 'string' && /^wm_[A-Za-z0-9_-]{1,40}$/.test(b.watermark) ? b.watermark : null;
    if (!packId || !version || !keyId || !B64URL(b.manifest, 2 * 1024 * 1024) || !B64URL(b.signature, 200)) throw httpError(400, 'Bad pack answer', 'plusAnswer');
    // the manifest is only read for the file list and the hashes (cache keys) – trusting it is the page's job
    let manifest;
    try {
      manifest = JSON.parse(Buffer.from(b.manifest, 'base64url').toString('utf8'));
    } catch {
      throw httpError(400, 'Bad pack manifest', 'plusAnswer');
    }
    const hashes = new Map((Array.isArray(manifest?.files) ? manifest.files : []).slice(0, MAX_FILES).filter((f) => validPath(f?.path) && /^[0-9a-f]{64}$/.test(f?.sha256)).map((f) => [f.path, f.sha256]));
    const files = (Array.isArray(b.files) ? b.files : []).slice(0, MAX_FILES).filter((f) => validPath(f?.path) && hashes.has(f.path) && typeof f.url === 'string');
    if (!hashes.size || files.length !== hashes.size) throw httpError(400, 'The answer does not list every pack file', 'plusAnswer');
    for (const f of files) if (!packUrlAllowed(f.url, { dev: !!dev, env })) throw httpError(400, 'Pack URL not allowed', 'plusUrl');
    return { packId, version, keyId, watermark, manifest: b.manifest, signature: b.signature, hashes, files };
  }

  return {
    dev: !!dev,
    meta() {
      const m = current();
      if (!m) return { none: true };
      const { files, ...rest } = m;
      return { ...rest, paths: Object.keys(files) };
    },
    file(path) {
      const m = current();
      const f = m && validPath(path) ? m.files[path] : null;
      if (!f) throw httpError(404, 'No such souldew+ file', 'plusNone');
      return readFileSync(join(filesDir, f.file));
    },
    async fetch(body) {
      const a = answer(body);
      const old = readMeta();
      mkdirSync(filesDir, { recursive: true });
      const files = {};
      let total = 0;
      let downloaded = 0;
      for (const f of a.files) {
        const name = fileName(f.path, a.hashes.get(f.path), a.keyId);
        const target = join(filesDir, name);
        // unchanged file (same content hash and same key) from the cache: not downloaded again
        if (!existsSync(target)) {
          const bytes = await download(f.url);
          writeFileAtomic(target, bytes);
          downloaded++;
          total += bytes.length;
        }
        if (total > MAX_PACK_BYTES) throw httpError(502, 'Pack too large', 'plusTooLarge');
        files[f.path] = { file: name };
      }
      const at = new Date(now()).toISOString();
      const meta = {
        packId: a.packId, version: a.version, keyId: a.keyId, watermark: a.watermark, manifest: a.manifest, signature: a.signature,
        files, fetchedAt: at, lastOnline: at, until: isoOrNull(body.until), downloaded,
      };
      writeFileAtomic(metaFile, JSON.stringify(meta));
      prune(new Set(Object.values(files).map((x) => x.file)));
      if (old && old.keyId !== a.keyId) console.log('souldew+ pack: key changed – old envelopes dropped');
      return this.meta();
    },
    touch(body) {
      const m = current();
      if (!m) return { none: true };
      const lastOnline = isoOrNull(body?.lastOnline);
      // only forward in time and never past this computer's clock: a page can't stretch the grace period
      if (lastOnline && Date.parse(lastOnline) > Date.parse(m.lastOnline || 0) && Date.parse(lastOnline) <= now() + 60e3) m.lastOnline = lastOnline;
      if ('until' in (body || {})) m.until = isoOrNull(body.until);
      writeFileAtomic(metaFile, JSON.stringify(m));
      const { files, ...rest } = m;
      return { ...rest, paths: Object.keys(files) };
    },
    /** One envelope for the live preview: downloaded, handed over, never written to disk. */
    async fetchOne(body) {
      const url = String(body?.url || '');
      if (!packUrlAllowed(url, { dev: !!dev, env })) throw httpError(400, 'Pack URL not allowed', 'plusUrl');
      return download(url);
    },
    wipe,
    devAccess(purpose = 'pack') {
      if (!dev) throw httpError(404, 'No dev pack', 'plusNoDev');
      const name = purpose === 'preview' ? 'access-preview.json' : 'access.json';
      if (!existsSync(join(dev, name))) throw httpError(404, 'No dev pack for this purpose', 'plusNoDev');
      const a = JSON.parse(readFileSync(join(dev, name), 'utf8'));
      // a dev preview behaves like the service's: 15 minutes from now
      if (purpose === 'preview') a.expiresAt = new Date(now() + 15 * 60e3).toISOString();
      return { ...a, dev: true };
    },
    /** The throwaway key a dev / e2e setup signs with (never with the production service). */
    devKey() {
      if (dev) {
        try {
          return { publicKey: JSON.parse(readFileSync(join(dev, 'access.json'), 'utf8')).publicKey };
        } catch {
          throw httpError(404, 'No dev key', 'plusNoDev');
        }
      }
      const k = env.SLS_PLUS_DEV_KEY;
      const service = new URL(accountsBase(env));
      if (k && /^[A-Za-z0-9_-]{43}$/.test(k) && isLoopback(service.hostname)) return { publicKey: k };
      throw httpError(404, 'No dev key', 'plusNoDev');
    },
  };
}

/** Registers the routes on the app server's router (server/app.mjs). */
export function plusRoutes(route, plus, readBody) {
  route('GET', /^\/api\/plus\/pack\/meta$/, () => plus.meta());
  route('GET', /^\/api\/plus\/pack\/file$/, (req, m, url) => plus.file(url.searchParams.get('path')));
  route('POST', /^\/api\/plus\/pack\/fetch$/, async (req) => plus.fetch(await readBody(req)));
  route('POST', /^\/api\/plus\/pack\/meta$/, async (req) => plus.touch(await readBody(req)));
  route('DELETE', /^\/api\/plus\/pack$/, () => plus.wipe());
  route('POST', /^\/api\/plus\/fetch$/, async (req) => plus.fetchOne(await readBody(req)));
  route('GET', /^\/api\/plus\/dev\/access$/, (req, m, url) => plus.devAccess(url.searchParams.get('purpose') === 'preview' ? 'preview' : 'pack'));
  route('GET', /^\/api\/plus\/dev\/key$/, () => plus.devKey());
}
