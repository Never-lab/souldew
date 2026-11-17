// The souldew account on the page: one shared store (signed in or not, the own profile, the pending counters) fed by
// the local server (/api/account – server/lib/accounts/index.mjs), plus the friends and invite lists while a screen
// shows them. The page never holds a token: every call goes to the local server, which talks to the service.
// Signed out, nothing here polls or reports anything.
import { useState, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { api } from './api.mjs';
import { openExternal } from './ui.mjs';

let state = { loaded: false, session: { signedIn: false, persistent: true, condition: null, pending: false, account: null }, me: null, pending: null, service: '' };
let inflight = null;
const subs = new Set();
const notify = () => subs.forEach((fn) => fn(state));
const set = (patch) => {
  state = { ...state, ...patch };
  notify();
};

/** Ask the local server again (signed in? the own profile, the counters). */
export function reloadAccount() {
  if (inflight) return inflight;
  inflight = api.get('/api/account').then((r) => {
    set({ loaded: true, session: r.session, me: r.me, brief: r.brief, pending: r.pending, service: r.service });
    return state;
  }).catch(() => {
    set({ loaded: true });
    return state;
  }).finally(() => {
    inflight = null;
  });
  return inflight;
}

export const accountState = () => state;
export const signedIn = () => !!state.session?.signedIn;

/** The account store, loaded the first time it is used. */
export function useAccount() {
  const [s, setS] = useState(state);
  useEffect(() => {
    subs.add(setS);
    if (!state.loaded) reloadAccount();
    else setS(state);
    return () => subs.delete(setS);
  }, []);
  return s;
}

// ---- events from the local server (app.mjs passes them on from its event stream) ------------------------------------
const pendingSubs = new Set();
/** fn(pending) whenever the service's counters (friend requests, invites, join requests) change. */
export function onPending(fn) {
  pendingSubs.add(fn);
  return () => pendingSubs.delete(fn);
}
const signInSubs = new Set();
/** fn() when the browser handed a sign-in back (Settings shows "You're signed in"). */
export function onSignedIn(fn) {
  signInSubs.add(fn);
  return () => signInSubs.delete(fn);
}
export function accountEvent(p) {
  if (p?.kind === 'pending') {
    set({ pending: p.pending });
    pendingSubs.forEach((fn) => fn(p.pending));
  } else {
    reloadAccount().then(() => {
      if (p?.kind === 'signed-in') signInSubs.forEach((fn) => fn());
    });
  }
}

// ---- actions --------------------------------------------------------------------------------------------------------
export async function signIn() {
  const r = await api.post('/api/account/login');
  // the desktop app opened the system browser itself; the browser build opens a tab
  if (!r.opened) openExternal(r.url);
  await reloadAccount();
  return r;
}
export const cancelSignIn = () => api.post('/api/account/login/cancel').finally(reloadAccount);
export async function signOut(everywhere = false) {
  const r = await api.post('/api/account/logout', { everywhere });
  await reloadAccount();
  return r;
}
export async function updateMe(patch) {
  const me = await api.patch('/api/account/me', patch);
  set({ me });
  return me;
}
export async function setHandle(handle) {
  const me = await api.put('/api/account/handle', { handle });
  set({ me });
  return me;
}
export async function newFriendCode() {
  const me = await api.post('/api/account/friend-code');
  if (me) set({ me });
  return me;
}
export const exportData = () => api.get('/api/account/export');
export async function deleteAccount(handle) {
  const r = await api.del('/api/account', { confirm: handle });
  await reloadAccount();
  return r;
}
export async function linkEmail(email) {
  const r = await api.post('/api/account/link-email', { email });
  await reloadAccount();
  return r;
}
export const entitlements = () => api.get('/api/account/entitlements');
export const profileOf = (id) => api.get(`/api/account/users/${encodeURIComponent(id)}`);
export const editorChoices = () => api.get('/api/account/choices');

// friends
export const addFriend = (query) => api.post('/api/account/friends/requests', { query });
export const answerRequest = (id, accept) => api.post(`/api/account/friends/requests/${encodeURIComponent(id)}/${accept ? 'accept' : 'ignore'}`);
export const cancelRequest = (id) => api.del(`/api/account/friends/requests/${encodeURIComponent(id)}`);
export const removeFriend = (id) => api.del(`/api/account/friends/${encodeURIComponent(id)}`);
export const blockUser = (userId) => api.post('/api/account/blocks', { userId });
export const report = (body) => api.post('/api/account/reports', body);
export const askToJoin = (to) => api.post('/api/account/join-requests', { to });

// ---- catalog --------------------------------------------------------------------------------------------------------
let catalog = null;
let catalogLoading = null;
/** Cosmetics and the accent palette (no account needed; loaded on first use, kept for the session). */
export function useCatalog() {
  const [c, setC] = useState(catalog);
  useEffect(() => {
    if (catalog) return;
    catalogLoading ||= api.get('/api/account/catalog').then((r) => (catalog = r)).catch(() => (catalogLoading = null));
    catalogLoading.then((r) => r && setC(r));
  }, []);
  return c;
}
/** An accent key → its colour (only from the catalog's palette – shared/social.mjs safeHex checked it). */
export const accentHex = (cat, key) => cat?.accents?.find((a) => a.key === key)?.hex || null;

// ---- lists that a screen shows (polled while it is open) ------------------------------------------------------------
function usePolled(url, every, enabled) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const alive = useRef(true);
  const load = () => api.get(url).then((d) => {
    if (alive.current) {
      setData(d);
      setError(null);
    }
    return d;
  }).catch((e) => {
    if (alive.current) setError(e);
  });
  useEffect(() => {
    alive.current = true;
    if (!enabled) return () => { alive.current = false; };
    load();
    const id = setInterval(load, every);
    const off = onPending(() => load());
    return () => {
      alive.current = false;
      clearInterval(id);
      off();
    };
  }, [url, enabled]);
  return { data, error, reload: load };
}
/** Friends with their presence, and friend requests both ways. */
export const useFriends = (enabled = true) => usePolled('/api/account/friends', 20000, enabled);
/** Invites and join requests both ways. */
export const useInvites = (enabled = true) => usePolled('/api/account/invites', 20000, enabled);

/** How many friends are online (or playing) – the sidebar's count. Polled slowly while signed in. */
export function useOnlineFriends(enabled) {
  const { data } = usePolled('/api/account/friends', 60000, enabled);
  return data ? data.friends.filter((f) => f.presence?.state && f.presence.state !== 'offline').length : 0;
}

// ---- presence -------------------------------------------------------------------------------------------------------
let lastPresence = '';
let lastPresenceAt = 0;
/**
 * What the player is doing now: { state: 'online'|'library'|'playing'|'in_run', game?: { title, system },
 * run?: { name, mode, freeSlot, joinable }, location? }. Sent when it changes and once a minute (the local server keeps
 * the heartbeat to the service and leaves out what the privacy settings hide). Signed out: nothing is sent.
 */
export function reportPresence(p) {
  if (!signedIn()) return;
  const key = JSON.stringify(p);
  if (key === lastPresence && Date.now() - lastPresenceAt < 55000) return;
  lastPresence = key;
  lastPresenceAt = Date.now();
  api.put('/api/account/presence', p).catch(() => {});
}

// ---- souldew+ packs (web/lib/cosmetics/ uses this) -------------------------------------------------------------------
/**
 * What the cosmetics module needs to fetch premium packs (souldew-accounts docs/API.md §8.2, §10):
 *   { signedIn, tier, until, badges, token (signed entitlement JWS – verify with the pinned key), packKey (base64url
 *     AES-256-GCM key, only with souldew+), packKeyId, offlineGraceDays, packs: [{ id, version, kind, title,
 *     requiredTier, entitled }], download(packId) → { packId, version, manifest, signature, watermarkId, packKeyId,
 *     expiresAt, files: [{ path, url }] } }
 * Signed out → { signedIn: false, tier: 'none', … } and no request is made.
 */
export async function getPackAccess() {
  if (!state.loaded) await reloadAccount();
  const none = { signedIn: false, tier: 'none', until: null, badges: [], token: null, packKey: null, packKeyId: null, offlineGraceDays: 7, packs: [], download: async () => null };
  if (!signedIn()) return none;
  const [ent, packs] = await Promise.all([entitlements(), api.get('/api/account/packs').catch(() => ({ items: [] }))]);
  return {
    signedIn: true, tier: ent.tier, until: ent.until, badges: ent.badges, token: ent.token, packKey: ent.packKey, packKeyId: ent.packKeyId,
    offlineGraceDays: ent.offlineGraceDays, packs: packs.items || [],
    download: (packId) => api.post(`/api/account/packs/${encodeURIComponent(packId)}/download`),
  };
}

const b64 = (u) => (u ? u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (u.length % 4)) % 4) : null);
/**
 * The cosmetics module's pack access provider (web/lib/cosmetics: setPackAccessProvider). Resolves to
 * { url, key, manifestSig, until, packVersion } for a souldew+ account, { …, offline: true } from the kept entitlement
 * while the service can't be reached (its grace days), or null (signed out, no souldew+). Throws when it can't tell.
 * (API.md §10 hands out per-file URLs; the cosmetics pack is one envelope – the first file is taken as that envelope.)
 */
export async function cosmeticsPackAccess({ purpose = 'pack' } = {}) {
  if (!state.loaded) await reloadAccount();
  if (!signedIn() || purpose === 'preview') return null;
  const ent = await entitlements();
  if (ent.tier !== 'plus' || !ent.packKey) return null;
  if (ent.offline) {
    return { key: b64(ent.packKey), manifestSig: b64(ent.lastPack?.signature), until: ent.until, packVersion: ent.lastPack?.version || null, offline: true };
  }
  const packs = await api.get('/api/account/packs');
  const pack = (packs.items || []).find((p) => p.entitled);
  if (!pack) return null;
  const dl = await api.post(`/api/account/packs/${encodeURIComponent(pack.id)}/download`);
  return { url: dl.files?.[0]?.url || null, key: b64(ent.packKey), manifestSig: b64(dl.signature), until: ent.until, packVersion: dl.version };
}
