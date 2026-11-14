/**
 * SoulLink pair titles (v1: HeartGold ↔ SoulSilver) and version-exclusive species.
 * Plain runs may join with the sister title; randomized/patched stays same-title only.
 */

/** Catalog game-id pairs that may share one plain SoulLink. */
export const PAIR_TITLES = Object.freeze([
  Object.freeze(['pokemon-heartgold', 'pokemon-soulsilver']),
]);

const MATE = new Map();
for (const [a, b] of PAIR_TITLES) {
  MATE.set(a, b);
  MATE.set(b, a);
}

/** Sister catalog id for a main game title, or null. */
export function pairMate(gameId) {
  return MATE.get(gameId) || null;
}

/** True when two catalog ids are the same title or a known pair (after variant → root). */
export function samePairFamily(a, b, rootOf = (id) => id) {
  if (!a || !b) return false;
  const ra = rootOf(a);
  const rb = rootOf(b);
  if (ra === rb) return true;
  return pairMate(ra) === rb;
}

/** National dex ids wild/gift-exclusive to HeartGold vs SoulSilver (not exhaustive; chip only). */
const HG_EXCLUSIVE = new Set([
  23, 24, // Ekans, Arbok
  56, 57, // Mankey, Primeape
  58, 59, // Growlithe, Arcanine
  167, 168, // Spinarak, Ariados
  216, 217, // Teddiursa, Ursaring
  240, 126, 467, // Magby, Magmar, Magmortar
  250, // Ho-Oh
  296, 297, // Makuhita, Hariyama
  311, // Plusle
  316, 317, // Gulpin, Swalot
  325, 326, // Spoink, Grumpig
]);

const SS_EXCLUSIVE = new Set([
  27, 28, // Sandshrew, Sandslash
  37, 38, // Vulpix, Ninetales
  52, 53, // Meowth, Persian
  165, 166, // Ledyba, Ledian
  231, 232, // Phanpy, Donphan
  239, 125, 466, // Elekid, Electabuzz, Electivire
  249, // Lugia
  307, 308, // Meditite, Medicham
  312, // Minun
]);

/**
 * Which pair title a species is exclusive to in the HG/SS pair.
 * @returns {'heartgold'|'soulsilver'|null}
 */
export function exclusiveSide(speciesId) {
  const id = Number(speciesId);
  if (!Number.isFinite(id) || id <= 0) return null;
  if (HG_EXCLUSIVE.has(id)) return 'heartgold';
  if (SS_EXCLUSIVE.has(id)) return 'soulsilver';
  return null;
}

/**
 * True when at least one slot’s game is the sister of the host (or of another slot).
 * Prefer synced `playerGameIds` (from the run doc); fall back to local `outputs[slot].gameId`.
 */
export function isMixedPairRun(manifest, rootOf = (id) => id, playerGameIds = null) {
  const host = manifest?.game?.id ? rootOf(manifest.game.id) : null;
  if (!host || !pairMate(host)) return false;
  const fromPlayers = playerGameIds
    ? Object.values(playerGameIds).map((id) => (id ? rootOf(id) : null)).filter(Boolean)
    : [];
  const fromOutputs = Object.values(manifest?.outputs || {}).map((o) => (o?.gameId ? rootOf(o.gameId) : null)).filter(Boolean);
  // Union: synced player rows and local outputs (host may still show HG for a seat the partner rebuilt).
  const ids = [...new Set([...fromPlayers, ...fromOutputs])];
  if (!ids.length) return false;
  const mate = pairMate(host);
  if (ids.some((id) => id === mate)) return true;
  const uniq = [...new Set(ids)];
  return uniq.length >= 2 && uniq.some((id) => pairMate(id) && uniq.includes(pairMate(id)));
}

/** True when any caught species in the list is a version exclusive (for the pair chip). */
export function pairHasExclusive(speciesIds) {
  return (speciesIds || []).some((s) => exclusiveSide(s));
}
