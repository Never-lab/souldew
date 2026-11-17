// souldew+ premium pack cache on disk. The server only ever holds the ENCRYPTED envelope (it never sees the account's
// key, never parses, decrypts or runs anything from a pack): it downloads the envelope from the short-lived URL the
// account service issued, keeps it in the data folder, hands it to the app's own page, and wipes it.
//
//   GET    /api/plus/pack         the cached envelope (bytes)                 – PRIVATE_GETS (app pages only)
//   GET    /api/plus/pack/meta    { packVersion, size, sha256, fetchedAt, lastOnline, until } or { none: true }
//   POST   /api/plus/pack/fetch   { url, packVersion, until } → downloads, replaces the cache atomically → meta
//   POST   /api/plus/pack/meta    { lastOnline?, until? } – the page confirmed the membership online
//   DELETE /api/plus/pack         wipe (signed out, membership ended, offline grace over)
//   GET    /api/plus/dev/access   only with SLS_PLUS_DEV_PACK: the test pack's access (scripts/plus-dev-pack.mjs)
//
// Offline grace is enforced here as well as in the page: a cache whose last online confirmation is older than
// GRACE_MS is wiped the moment anything asks for it.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic, httpError } from './fsutil.mjs';

export const GRACE_MS = 7 * 24 * 3600 * 1000;
export const MAX_PACK_BYTES = 64 * 1024 * 1024;
const DEV_URL = 'souldew-dev:pack.sdpk';

/**
 * Where a pack may come from: https on souldew.app (the accounts service and its R2 delivery host). The signed URL's
 * host is configured on the service; anything else (another host, http, an IP, credentials in the URL) is refused, so a
 * page can't turn this into a request to an arbitrary machine (SSRF).
 */
export function packUrlAllowed(raw, { dev = false } = {}) {
  if (dev && raw === DEV_URL) return true;
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase();
  return host === 'souldew.app' || host.endsWith('.souldew.app');
}

const isoOrNull = (v) => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

export function createPlusPack({ dir, devDir = process.env.SLS_PLUS_DEV_PACK || '', fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const packFile = join(dir, 'pack.sdpk');
  const metaFile = join(dir, 'pack.json');
  const dev = devDir ? resolve(devDir) : '';

  const readMeta = () => {
    try {
      return JSON.parse(readFileSync(metaFile, 'utf8'));
    } catch {
      return null;
    }
  };
  function wipe() {
    rmSync(packFile, { force: true });
    rmSync(metaFile, { force: true });
    return { wiped: true };
  }
  /** the meta of a usable cache, or null (and the cache is gone) */
  function current() {
    const m = readMeta();
    if (!m || !existsSync(packFile)) {
      if (m || existsSync(packFile)) wipe();
      return null;
    }
    const last = Date.parse(m.lastOnline || m.fetchedAt || 0);
    if (!Number.isFinite(last) || now() - last > GRACE_MS || last - now() > GRACE_MS) {
      wipe(); // offline for longer than the grace period (or a clock that jumped far ahead): the membership is unconfirmed
      return null;
    }
    return m;
  }

  async function download(url) {
    if (url === DEV_URL) return readFileSync(join(dev, 'pack.sdpk'));
    const res = await fetchImpl(url, { redirect: 'error', headers: { accept: 'application/octet-stream' } });
    if (!res.ok) throw httpError(502, `Pack download failed (${res.status})`, 'plusDownload');
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > MAX_PACK_BYTES) throw httpError(502, 'Pack too large', 'plusTooLarge');
    const chunks = [];
    let size = 0;
    for await (const c of res.body) {
      size += c.length;
      if (size > MAX_PACK_BYTES) throw httpError(502, 'Pack too large', 'plusTooLarge');
      chunks.push(Buffer.from(c));
    }
    return Buffer.concat(chunks);
  }

  return {
    dev: !!dev,
    meta() {
      const m = current();
      return m ? { ...m } : { none: true };
    },
    pack() {
      if (!current()) throw httpError(404, 'No souldew+ pack', 'plusNone');
      return readFileSync(packFile);
    },
    async fetch(body) {
      const url = String(body?.url || '');
      if (!packUrlAllowed(url, { dev: !!dev })) throw httpError(400, 'Pack URL not allowed', 'plusUrl');
      const bytes = await download(url);
      if (bytes.length < 16 || bytes.subarray(0, 4).toString('latin1') !== 'SDPK') throw httpError(502, 'Not a souldew+ pack', 'plusFormat');
      mkdirSync(dir, { recursive: true });
      const at = new Date(now()).toISOString();
      const meta = {
        packVersion: typeof body.packVersion === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(body.packVersion) ? body.packVersion : null,
        size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        fetchedAt: at, lastOnline: at, until: isoOrNull(body.until),
      };
      writeFileAtomic(packFile, bytes);
      writeFileAtomic(metaFile, JSON.stringify(meta));
      return meta;
    },
    touch(body) {
      const m = current();
      if (!m) return { none: true };
      const lastOnline = isoOrNull(body?.lastOnline);
      // only forward in time and never past this computer's clock: a page can't stretch the grace period
      if (lastOnline && Date.parse(lastOnline) > Date.parse(m.lastOnline || 0) && Date.parse(lastOnline) <= now() + 60e3) m.lastOnline = lastOnline;
      if ('until' in (body || {})) m.until = isoOrNull(body.until);
      writeFileAtomic(metaFile, JSON.stringify(m));
      return m;
    },
    wipe,
    devAccess() {
      if (!dev) throw httpError(404, 'No dev pack', 'plusNoDev');
      const a = JSON.parse(readFileSync(join(dev, 'access.json'), 'utf8'));
      statSync(join(dev, 'pack.sdpk'));
      return { url: DEV_URL, key: a.key, manifestSig: a.manifestSig, until: a.until, packVersion: a.packVersion, publicKey: a.publicKey, dev: true };
    },
  };
}

/** Registers the routes on the app server's router (server/app.mjs). */
export function plusRoutes(route, plus, readBody) {
  route('GET', /^\/api\/plus\/pack$/, () => plus.pack());
  route('GET', /^\/api\/plus\/pack\/meta$/, () => plus.meta());
  route('POST', /^\/api\/plus\/pack\/fetch$/, async (req) => plus.fetch(await readBody(req)));
  route('POST', /^\/api\/plus\/pack\/meta$/, async (req) => plus.touch(await readBody(req)));
  route('DELETE', /^\/api\/plus\/pack$/, () => plus.wipe());
  route('GET', /^\/api\/plus\/dev\/access$/, () => plus.devAccess());
}
