// souldew+ premium pack: the container format and its cryptography. Isomorphic (WebCrypto only), so the app's renderer,
// the dev pack builder (scripts/plus-dev-pack.mjs) and the tests share one implementation. Nothing in here touches the
// DOM, the network or the disk.
//
// Two layers (README.md › "Pack format"):
//
//   archive  – the pack as built and signed once, identical for every account:
//              "SDPA" | u32 manifestLength | manifest (UTF-8 JSON) | u32 sigLength | Ed25519 signature | file bodies …
//              The manifest lists every file with its size and SHA-256; the signature covers the manifest's exact bytes.
//   envelope – what one account downloads: the archive encrypted for that account (AES-256-GCM):
//              "SDPK" | u8 version | u16 headerLength | header (UTF-8 JSON: alg, iv, wm, issued, packVersion) | ciphertext
//              The header (with the account's watermark) is the GCM additional data, so it can't be swapped or edited.
//
// Order of trust on the way in: decrypt (GCM tag) → parse → the signature from the account service must equal the one in
// the archive → verify it against a pinned key → every file's size and hash → only then is anything used.

export const FORMAT = 'souldew-plus-pack@1';
const ARCHIVE_MAGIC = 'SDPA';
const ENVELOPE_MAGIC = 'SDPK';
const ENVELOPE_VERSION = 1;
/** Hard caps: a pack is a few MB; anything bigger is refused before any work is done. */
export const MAX_PACK_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FILES = 4096;

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw packError('crypto', 'WebCrypto is not available');
  return s;
};

export function packError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ------------------------------------------------------------------ bytes helpers
export function b64encode(bytes) {
  let s = '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
/** base64 or base64url → bytes; null for anything that isn't */
export function b64decode(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '='));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
export const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256(bytes) {
  return hex(await subtle().digest('SHA-256', bytes));
}
function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const readU32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
function concat(parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ------------------------------------------------------------------ manifest shape
const PATH_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){0,3}$/;
/** The manifest is data from outside until its signature is checked – and even then its shape is checked strictly. */
export function checkManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw packError('manifest', 'manifest is not an object');
  if (m.format !== FORMAT) throw packError('manifest', `unknown pack format ${String(m.format).slice(0, 40)}`);
  if (typeof m.packVersion !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(m.packVersion)) throw packError('manifest', 'bad packVersion');
  if (!Array.isArray(m.files) || m.files.length > MAX_FILES) throw packError('manifest', 'bad file list');
  const seen = new Set();
  for (const f of m.files) {
    if (!f || typeof f.path !== 'string' || !PATH_RE.test(f.path) || f.path.includes('..')) throw packError('manifest', 'bad file path');
    if (seen.has(f.path)) throw packError('manifest', `duplicate file ${f.path}`);
    seen.add(f.path);
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_PACK_BYTES) throw packError('manifest', `bad size for ${f.path}`);
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) throw packError('manifest', `bad hash for ${f.path}`);
  }
  return m;
}

// ------------------------------------------------------------------ archive (build + parse)
/** files: [{ path, bytes: Uint8Array }]; sign(bytes) → 64-byte signature. Returns { archive, manifest, manifestBytes, sig }. */
export async function buildArchive({ packVersion, files, extra = {} }, sign) {
  const list = [];
  for (const f of files) list.push({ path: f.path, size: f.bytes.length, sha256: await sha256(f.bytes) });
  const manifest = checkManifest({ format: FORMAT, packVersion, created: new Date().toISOString(), ...extra, files: list });
  const manifestBytes = enc.encode(JSON.stringify(manifest));
  const sig = new Uint8Array(await sign(manifestBytes));
  const archive = concat([enc.encode(ARCHIVE_MAGIC), u32(manifestBytes.length), manifestBytes, u32(sig.length), sig, ...files.map((f) => f.bytes)]);
  return { archive, manifest, manifestBytes, sig };
}

/** Splits an archive. Checks only the framing – the caller verifies the signature and the hashes. */
export function parseArchive(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 12 || dec.decode(b.subarray(0, 4)) !== ARCHIVE_MAGIC) throw packError('archive', 'not a souldew+ pack');
  const mLen = readU32(b, 4);
  if (mLen > MAX_MANIFEST_BYTES || 8 + mLen + 4 > b.length) throw packError('archive', 'bad manifest length');
  const manifestBytes = b.subarray(8, 8 + mLen);
  const sLen = readU32(b, 8 + mLen);
  if (sLen !== 64 || 12 + mLen + sLen > b.length) throw packError('archive', 'bad signature length');
  const sig = b.subarray(12 + mLen, 12 + mLen + sLen);
  let manifest;
  try {
    manifest = JSON.parse(dec.decode(manifestBytes));
  } catch {
    throw packError('manifest', 'manifest is not JSON');
  }
  return { manifest, manifestBytes, sig, body: b.subarray(12 + mLen + sLen) };
}

// ------------------------------------------------------------------ signatures
async function importPublic(raw) {
  return subtle().importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
}
/**
 * True when `sig` is a valid Ed25519 signature of `bytes` by ANY of `keys` (raw 32-byte public keys, or base64 text).
 * Keys that don't decode to 32 bytes (the placeholder before a production key is configured) never verify anything.
 */
export async function verifySignature(bytes, sig, keys) {
  if (!(sig instanceof Uint8Array) || sig.length !== 64) return false;
  for (const k of keys || []) {
    const raw = typeof k === 'string' ? b64decode(k) : k;
    if (!(raw instanceof Uint8Array) || raw.length !== 32) continue;
    try {
      if (await subtle().verify({ name: 'Ed25519' }, await importPublic(raw), sig, bytes)) return true;
    } catch {
      // a malformed key is simply not a match
    }
  }
  return false;
}

/** Ed25519 key pair for the dev builder and the tests: { publicKey (raw 32 bytes), sign(bytes) } */
export async function makeSigner(pkcs8) {
  const s = subtle();
  let priv, pubRaw;
  if (pkcs8) {
    priv = await s.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
    const jwk = await s.exportKey('jwk', priv);
    pubRaw = b64decode(jwk.x);
  } else {
    const kp = await s.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    priv = kp.privateKey;
    pubRaw = new Uint8Array(await s.exportKey('raw', kp.publicKey));
  }
  return {
    publicKey: pubRaw,
    pkcs8: async () => new Uint8Array(await s.exportKey('pkcs8', priv)),
    sign: async (bytes) => new Uint8Array(await s.sign({ name: 'Ed25519' }, priv, bytes)),
  };
}

// ------------------------------------------------------------------ per-account envelope
function envelopeHead(header) {
  const h = enc.encode(JSON.stringify(header));
  if (h.length > 4096) throw packError('envelope', 'header too large');
  return concat([enc.encode(ENVELOPE_MAGIC), new Uint8Array([ENVELOPE_VERSION, (h.length >> 8) & 255, h.length & 255]), h]);
}

/** Encrypts an archive for one account (the accounts service does this per download; here for the dev builder and tests). */
export async function sealEnvelope(archive, keyBytes, { watermark = 'dev', packVersion = '', issued = new Date().toISOString() } = {}) {
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32) throw packError('key', 'the pack key must be 32 bytes');
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const head = envelopeHead({ alg: 'A256GCM', iv: b64encode(iv), wm: String(watermark).slice(0, 80), issued, packVersion });
  const key = await subtle().importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: head }, key, archive));
  return concat([head, ct]);
}

/** Envelope → { header, archive }. Throws 'envelope' for framing errors and 'decrypt' for a wrong key or edited bytes. */
export async function openEnvelope(bytes, keyBytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length > MAX_PACK_BYTES) throw packError('envelope', 'pack too large');
  if (b.length < 7 || dec.decode(b.subarray(0, 4)) !== ENVELOPE_MAGIC) throw packError('envelope', 'not a souldew+ envelope');
  if (b[4] !== ENVELOPE_VERSION) throw packError('envelope', `unknown envelope version ${b[4]}`);
  const hLen = (b[5] << 8) | b[6];
  if (7 + hLen + 16 > b.length) throw packError('envelope', 'truncated envelope');
  const head = b.subarray(0, 7 + hLen);
  let header;
  try {
    header = JSON.parse(dec.decode(b.subarray(7, 7 + hLen)));
  } catch {
    throw packError('envelope', 'bad envelope header');
  }
  const iv = b64decode(header?.iv);
  if (header?.alg !== 'A256GCM' || !iv || iv.length !== 12) throw packError('envelope', 'unsupported envelope');
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32) throw packError('key', 'the pack key must be 32 bytes');
  const key = await subtle().importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  try {
    const archive = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: head }, key, b.subarray(7 + hLen)));
    return { header, archive };
  } catch {
    throw packError('decrypt', 'the pack could not be decrypted (wrong key or damaged download)');
  }
}

/**
 * The whole way in: envelope bytes + the account's key + the signature the account service handed out → verified files.
 * Returns { manifest, files: Map(path → Uint8Array), watermark, packVersion }. Throws with e.code on any failure.
 */
export async function openPack(envelope, { key, manifestSig, keys }) {
  const keyBytes = typeof key === 'string' ? b64decode(key) : key;
  const { header, archive } = await openEnvelope(envelope, keyBytes);
  const { manifest, manifestBytes, sig, body } = parseArchive(archive);
  const expected = typeof manifestSig === 'string' ? b64decode(manifestSig) : manifestSig;
  // the account service vouches for exactly this pack: a valid but different (older, other tier) pack is refused too
  if (!equalBytes(expected, sig)) throw packError('signature', 'the pack is not the one the account service issued');
  if (!(await verifySignature(manifestBytes, sig, keys))) throw packError('signature', 'the pack signature is not valid');
  checkManifest(manifest);
  const files = new Map();
  let o = 0;
  for (const f of manifest.files) {
    if (o + f.size > body.length) throw packError('hash', `file ${f.path} is truncated`);
    const bytes = body.slice(o, o + f.size);
    o += f.size;
    if ((await sha256(bytes)) !== f.sha256) throw packError('hash', `file ${f.path} does not match its hash`);
    files.set(f.path, bytes);
  }
  if (o !== body.length) throw packError('hash', 'the pack has unlisted bytes');
  return { manifest, files, watermark: String(header.wm || ''), packVersion: manifest.packVersion };
}

export const text = (bytes) => dec.decode(bytes);
