// The public keys a souldew+ pack must be signed with (Ed25519, raw 32 bytes as base64). Pinned in the app: a pack signed
// with any other key is refused before a single byte of it is used.
//
// PRODUCTION_KEY is a placeholder until the owner generates the real signing key (souldew-accounts tools/keygen.mjs pack,
// the same key whose public half is the Worker's PACK_PUBLIC_KEY) and pastes its public half here (base64url or base64). A placeholder never decodes to 32 bytes, so until then no pack verifies (fail closed).
// Rotation: add the new key next to the old one, ship, then sign new packs with the new key and drop the old one later.
export const PRODUCTION_KEYS = ['REPLACE_WITH_PRODUCTION_PACK_PUBLIC_KEY'];

/**
 * The keys to trust. A dev key is accepted only when the local server offers one (/api/plus/dev/key): with a dev pack
 * (SLS_PLUS_DEV_PACK, scripts/plus-dev-pack.mjs) or SLS_PLUS_DEV_KEY while SLS_ACCOUNTS_URL points at a service on this
 * computer (scripts/plus-e2e.mjs) – the player's own machine choosing to test, never something a download decides.
 */
export function trustedKeys(devKey = null) {
  return devKey ? [...PRODUCTION_KEYS, devKey] : [...PRODUCTION_KEYS];
}
