// souldew+ pack format: the signature (valid / invalid / tampered / wrong key / no production key yet), the per-account
// encryption (wrong key, edited ciphertext, edited header), the file hashes, and the manifest's shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildArchive, sealEnvelope, openEnvelope, openPack, parseArchive, verifySignature, makeSigner, checkManifest, b64encode, b64decode, sha256, FORMAT,
} from '../web/lib/cosmetics/pack/format.mjs';
import { PRODUCTION_KEYS, trustedKeys } from '../web/lib/cosmetics/pack/keys.mjs';

const enc = new TextEncoder();
const files = [
  { path: 'contents.json', bytes: enc.encode(JSON.stringify({ skins: [{ id: 'moss', css: 'skins/moss.css' }], banners: 'banners.json' })) },
  { path: 'skins/moss.css', bytes: enc.encode("html[data-skin='moss'] { --shell: #1f2a20; }") },
  { path: 'banners.json', bytes: enc.encode('[{"id":"x","pal":{},"layers":[]}]') },
];
const randKey = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

async function fixture() {
  const signer = await makeSigner();
  const { archive, sig, manifestBytes } = await buildArchive({ packVersion: 't-1', files }, signer.sign);
  const key = randKey();
  const env = await sealEnvelope(archive, key, { watermark: 'acct-42', packVersion: 't-1' });
  return { signer, archive, sig, manifestBytes, key, env, keys: [signer.publicKey] };
}

test('a valid pack opens: every file, its watermark and version', async () => {
  const f = await fixture();
  const p = await openPack(f.env, { key: b64encode(f.key), manifestSig: b64encode(f.sig), keys: [b64encode(f.signer.publicKey)] });
  assert.equal(p.packVersion, 't-1');
  assert.equal(p.watermark, 'acct-42');
  assert.deepEqual([...p.files.keys()], files.map((x) => x.path));
  assert.equal(new TextDecoder().decode(p.files.get('skins/moss.css')), "html[data-skin='moss'] { --shell: #1f2a20; }");
  assert.equal(p.manifest.format, FORMAT);
});

test('signature: valid, invalid, tampered manifest, wrong key', async () => {
  const f = await fixture();
  assert.equal(await verifySignature(f.manifestBytes, f.sig, f.keys), true);
  const bad = f.sig.slice();
  bad[10] ^= 1;
  assert.equal(await verifySignature(f.manifestBytes, bad, f.keys), false, 'flipped signature bit');
  const edited = f.manifestBytes.slice();
  edited[edited.length - 3] ^= 1;
  assert.equal(await verifySignature(edited, f.sig, f.keys), false, 'edited manifest');
  const other = await makeSigner();
  assert.equal(await verifySignature(f.manifestBytes, f.sig, [other.publicKey]), false, 'another key');
  assert.equal(await verifySignature(f.manifestBytes, f.sig.subarray(0, 63), f.keys), false, 'short signature');
  // a pack signed by another key is refused as a whole, even with a matching manifestSig
  const forged = await buildArchive({ packVersion: 't-1', files }, other.sign);
  const env = await sealEnvelope(forged.archive, f.key);
  await assert.rejects(openPack(env, { key: f.key, manifestSig: forged.sig, keys: f.keys }), { code: 'signature' });
});

test('the production key is a placeholder until the owner sets it: nothing verifies (fail closed)', async () => {
  const f = await fixture();
  assert.ok(PRODUCTION_KEYS.every((k) => !b64decode(k) || b64decode(k).length !== 32));
  assert.equal(await verifySignature(f.manifestBytes, f.sig, trustedKeys()), false);
  assert.equal(await verifySignature(f.manifestBytes, f.sig, trustedKeys(f.signer.publicKey)), true, 'the dev key only when passed in');
  await assert.rejects(openPack(f.env, { key: f.key, manifestSig: f.sig, keys: trustedKeys() }), { code: 'signature' });
});

test('the account service must vouch for exactly this pack (manifestSig must match)', async () => {
  const f = await fixture();
  const older = await buildArchive({ packVersion: 't-0', files: files.slice(0, 1) }, f.signer.sign);
  await assert.rejects(openPack(f.env, { key: f.key, manifestSig: older.sig, keys: f.keys }), { code: 'signature' });
  await assert.rejects(openPack(f.env, { key: f.key, manifestSig: 'not base64 !', keys: f.keys }), { code: 'signature' });
});

test('decryption: wrong key, edited ciphertext, edited header (the watermark is authenticated)', async () => {
  const f = await fixture();
  assert.deepEqual((await openEnvelope(f.env, f.key)).archive, f.archive);
  await assert.rejects(openEnvelope(f.env, randKey()), { code: 'decrypt' });
  const ct = f.env.slice();
  ct[ct.length - 20] ^= 0x40;
  await assert.rejects(openEnvelope(ct, f.key), { code: 'decrypt' });
  // swap the watermark in the plaintext header: the GCM tag covers it
  const text = new TextDecoder().decode(f.env.subarray(7, 7 + ((f.env[5] << 8) | f.env[6])));
  const swapped = f.env.slice();
  swapped.set(enc.encode(text.replace('acct-42', 'acct-43')), 7);
  await assert.rejects(openEnvelope(swapped, f.key), { code: 'decrypt' });
  await assert.rejects(openEnvelope(f.env, f.key.subarray(0, 16)), { code: 'key' });
  await assert.rejects(openEnvelope(enc.encode('PK\u0003\u0004 not a pack at all'), f.key), { code: 'envelope' });
  await assert.rejects(openEnvelope(f.env.subarray(0, 12), f.key), { code: 'envelope' });
});

test('file hashes: a file changed after signing is refused, so are unlisted or missing bytes', async () => {
  const f = await fixture();
  const reseal = async (archive) => sealEnvelope(archive, f.key);
  // change one byte of the last file's body (the manifest and signature stay valid)
  const a = f.archive.slice();
  a[a.length - 2] ^= 1;
  await assert.rejects(openPack(await reseal(a), { key: f.key, manifestSig: f.sig, keys: f.keys }), { code: 'hash' });
  const extra = new Uint8Array(f.archive.length + 1);
  extra.set(f.archive);
  await assert.rejects(openPack(await reseal(extra), { key: f.key, manifestSig: f.sig, keys: f.keys }), { code: 'hash' });
  await assert.rejects(openPack(await reseal(f.archive.subarray(0, f.archive.length - 5)), { key: f.key, manifestSig: f.sig, keys: f.keys }), { code: 'hash' });
});

test('manifest shape: paths, sizes, hashes, format are checked even when signed', async () => {
  const ok = { format: FORMAT, packVersion: 'v1', files: [{ path: 'skins/a.css', size: 1, sha256: await sha256(new Uint8Array(1)) }] };
  assert.doesNotThrow(() => checkManifest(ok));
  const bad = (patch) => assert.throws(() => checkManifest({ ...ok, ...patch }), { code: 'manifest' });
  bad({ format: 'other@1' });
  bad({ packVersion: '../x' });
  bad({ files: [{ ...ok.files[0], path: '../etc/passwd' }] });
  bad({ files: [{ ...ok.files[0], path: '/abs.css' }] });
  bad({ files: [{ ...ok.files[0], path: 'a\\b.css' }] });
  bad({ files: [ok.files[0], ok.files[0]] });
  bad({ files: [{ ...ok.files[0], size: -1 }] });
  bad({ files: [{ ...ok.files[0], sha256: 'xyz' }] });
  assert.throws(() => parseArchive(enc.encode('SDPA\u0000\u0000\u0000\u0002{}')), { code: 'archive' });
});
