// ============================================================================================================
// STUB – replaced at merge by the real cosmetics module of branch feat/plus-cosmetics (web/lib/cosmetics/index.mjs).
// Only the names the account screens use, with the real module's signatures (its README › Public interface).
// ============================================================================================================

let provider = null;
let plusHandler = null;
export const applySkin = () => false;
export const listSkins = () => [];
export const catalog = () => ({ banners: [], frames: [], nameplates: [], skins: [], launch: [], collections: { banners: [], frames: [] } });
export const packState = () => ({ entitled: false, preview: false, until: null, packVersion: null, loading: false, error: null });
export const refreshPack = async () => (provider ? provider({ purpose: 'pack' }) : null);
export const forgetPack = async () => {};
/** The account client's hook (lib/account.mjs cosmeticsPackAccess). */
export function setPackAccessProvider(fn) {
  provider = typeof fn === 'function' ? fn : null;
}
export const getPackAccess = (opts = {}) => (provider ? provider(opts) : Promise.resolve(null));
export function setPlusHandler(fn) {
  plusHandler = typeof fn === 'function' ? fn : null;
}
export const openPlus = (info = {}) => plusHandler?.(info);
export const onChange = () => () => {};
