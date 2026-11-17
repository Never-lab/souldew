// The cosmetics layer's shared state: what the pack client has loaded (premium content, in memory only) next to the free
// content that ships with the app, and the subscribers that re-render when it changes.
import FREE_BANNERS from './content/banners-free.mjs';
import CATALOG from './content/catalog.mjs';

export { CATALOG };

const listeners = new Set();
export const state = {
  entitled: false, // the account owns souldew+ and its pack is loaded and verified
  preview: false, // a live theme preview is in memory (API.md §10.4): its skins can be tried, nothing can be kept
  previewUntil: null, // when the preview ends (ISO) – its content is dropped then
  previewLoading: false,
  until: null,
  packVersion: null,
  loading: false,
  error: null, // null | 'offline' | 'expired' | 'signature' | 'decrypt' | 'hash' | 'download' | …
  generation: 0, // bumps whenever the loaded content changes (instances remount)
};

/** In-memory premium content (never written anywhere in plain form). */
export const content = {
  banners: new Map(FREE_BANNERS.map((b) => [b.id, b])),
  skinCss: new Map(), // skin id → CSS text with pack: urls (resolved on first use)
  files: new Map(), // pack path → bytes (fonts, art the skins use)
  framesModule: null, // signed module text (frames.mjs) – runs only in a worker (sandbox.mjs)
  frameIds: new Set(),
  launchModule: null, // signed module text (launch.mjs)
  launchIds: new Set(),
};

export function setContent(next) {
  content.banners = new Map(FREE_BANNERS.map((b) => [b.id, b]));
  for (const b of next?.banners || []) if (b && typeof b.id === 'string') content.banners.set(b.id, b);
  content.skinCss = new Map(next?.skinCss || []);
  content.files = new Map(next?.files || []);
  content.framesModule = next?.framesModule || null;
  content.frameIds = new Set(next?.frameIds || []);
  content.launchModule = next?.launchModule || null;
  content.launchIds = new Set(next?.launchIds || []);
  state.generation++;
}

export function update(patch) {
  Object.assign(state, patch);
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch (e) {
      console.error('cosmetics listener failed', e);
    }
  }
}

/** Subscribe to pack / content changes; returns the unsubscribe function. */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const FREE_FRAME_IDS = new Set(CATALOG.frames.filter((f) => !f.plus).map((f) => f.id));

/** Is this item usable right now (free, or premium with the pack loaded)? Preview content counts only for previews. */
export function owned(kind, id) {
  const item = CATALOG[kind]?.find((x) => x.id === id);
  if (!item) return false;
  if (!item.plus) return true;
  return state.entitled && has(kind, id);
}

/** Is the content for this item in memory (owned or as a preview)? */
export function has(kind, id) {
  if (kind === 'banners' || kind === 'nameplates') return content.banners.has(id);
  if (kind === 'frames') return FREE_FRAME_IDS.has(id) || content.frameIds.has(id);
  if (kind === 'launch') return id === 'cartridge' || content.launchIds.has(id);
  if (kind === 'skins') return id === 'classic' || content.skinCss.has(id);
  return false;
}
