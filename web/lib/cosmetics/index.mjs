// souldew+ cosmetics – the public interface (README.md in this folder documents every name; keep them stable, the
// profile / friends UI and the account client import them).
import { CATALOG, state, onChange, owned, has } from './state.mjs';

export { applySkin, previewSkin, endPreview, listSkins, skinState, onSkinChange, applyStoredSkin } from './skins.mjs';
export { mountBanner, mountNameplate, bannerStats } from './banners/runtime.mjs';
export { mountFrame, frameStats, sizing as frameSizing } from './frames/runtime.mjs';
export { playLaunch, previewLaunch, launchAvailable, layoutKey } from './launch/player.mjs';
export { refreshPack, forgetPack, packState, setPackAccessProvider, getPackAccess, GRACE_MS } from './pack/client.mjs';
export { setReducedMotion } from './motion.mjs';
export { setPlusHandler, openPlus } from './plus.mjs';
export { onChange, owned, has };

const KINDS = ['banners', 'frames', 'nameplates', 'skins', 'launch'];
const RARITY = ['free', 'common', 'rare', 'epic', 'legendary'];

/**
 * Everything there is, owned or not – for pickers and profile editors:
 *   { banners, frames, nameplates, skins, launch: [{ id, name, collection, collectionName, rarity, pairsWith, plus,
 *     owned, available, sw, … }], collections: { banners, frames } }
 * owned: usable now (free, or souldew+ with the pack loaded). available: its content is in memory (owned or preview).
 */
export function catalog() {
  const tag = (kind, list) => list.map((x) => ({ ...x, owned: owned(kind, x.id), available: has(kind, x.id) }));
  const nameplates = CATALOG.banners.map((b) => ({ id: b.id, name: b.name, collection: b.collection, collectionName: b.collectionName, rarity: b.rarity, pairsWith: b.pairsWith, plus: b.plus, sw: b.sw }));
  return {
    banners: tag('banners', CATALOG.banners),
    frames: tag('frames', CATALOG.frames),
    nameplates: tag('nameplates', nameplates),
    skins: tag('skins', CATALOG.skins),
    launch: tag('launch', CATALOG.launch),
    collections: CATALOG.collections,
  };
}

export const COSMETIC_KINDS = KINDS;
export const RARITIES = RARITY;
/** current generation of loaded content (changes when a pack loads or is wiped) */
export const contentGeneration = () => state.generation;
