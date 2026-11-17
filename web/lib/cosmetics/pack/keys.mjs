// The public keys a souldew+ pack must be signed with (Ed25519, raw 32 bytes as base64). Pinned in the app: a pack signed
// with any other key is refused before a single byte of it is used.
//
// PRODUCTION_KEYS: the owner's pack signing key (souldew-accounts tools/keygen.mjs pack – the same key whose public half
// is the Worker's PACK_PUBLIC_KEY), public half as base64url, kid QlIZs36crrFq. scripts/check-pinned-keys.mjs stops a
// release while an entry here is not a real key.
// Rotation: add the new key next to the old one, ship, then sign new packs with the new key and drop the old one later.
export const PRODUCTION_KEYS = ['3bUP9p0dK5iIY7valeKJWJhUPOzI-ukWGC_ZR54Uvqc'];

/**
 * The keys to trust. A dev key is accepted only when the local server offers one (/api/plus/dev/key): with a dev pack
 * (SLS_PLUS_DEV_PACK, scripts/plus-dev-pack.mjs) or SLS_PLUS_DEV_KEY while SLS_ACCOUNTS_URL points at a service on this
 * computer (scripts/plus-e2e.mjs) – the player's own machine choosing to test, never something a download decides.
 */
export function trustedKeys(devKey = null) {
  return devKey ? [...PRODUCTION_KEYS, devKey] : [...PRODUCTION_KEYS];
}
