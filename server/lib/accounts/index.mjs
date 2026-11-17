// The souldew account in the local server: the page's /api/account/* routes, the sign-in hand-off page
// (/auth/done), the avatar proxy, the presence heartbeat and the opt-in stats upload. The page never talks to the
// accounts service itself and never sees a token; this module checks what the page sends, calls the service through
// the session (./session.mjs) and cleans every answer (./clean.mjs).
//
// Signed out, none of this does anything: no timer runs, no request leaves the computer – the app works exactly as
// it does without an account.
import { createHash } from 'node:crypto';
import { httpError } from '../fsutil.mjs';
import { createTokenStore } from './store.mjs';
import { createSession, errorCode } from './session.mjs';
import { API, accountsBase } from './contract.mjs';
import { authPage, AUTH_PAGE_HEADERS, AUTH_RESULTS } from './authpage.mjs';
import { currentStats, editorChoices } from './stats.mjs';
import {
  cleanMe, cleanProfile, cleanFriend, cleanRequest, cleanPresence, cleanInvite, cleanJoinRequest, cleanCatalog, cleanEntitlements,
  catalogId, inviteCode, isPlusTier,
} from './clean.mjs';
import {
  cleanText, withoutFileNames, safeAvatarUrl, parseFriendQuery, normalizeHandle, oneOf, presenceSystem,
  PROFILE_VISIBILITY, PRESENCE_VISIBILITY, STATUS_MAX, NAME_MAX, TRUSTED_MAX, FAVORITE_MAX, RUN_NAME_MAX,
} from '../../../shared/social.mjs';

const ID = '[A-Za-z0-9_-]{3,64}';
const BODY_LIMIT = 64 * 1024;
const ME_TTL = 30000;
const CATALOG_TTL = 5 * 60000;
const PAGE_ALIVE = 3 * 60000; // the page reports presence at least this often while it is open
const STATS_EVERY = 10 * 60000;
const AVATAR_MAX = 512 * 1024;
const AVATAR_CACHE = 200;

async function readJson(req) {
  const len = Number(req.headers['content-length']);
  if (Number.isFinite(len) && len > BODY_LIMIT) throw httpError(413, 'Request too large', 'requestTooLarge');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > BODY_LIMIT) throw httpError(413, 'Request too large', 'requestTooLarge');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw httpError(400, 'Invalid JSON', 'badJson');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'JSON object expected', 'jsonObject');
  return body;
}

/** A service answer that isn't a success → the error the page gets: { error, code: 'acct', vars: { code, field, retryAfter } }. */
function serviceError(r) {
  if (r.status === 0) return httpError(503, 'The account service can’t be reached', 'acctOffline');
  if (r.status === 401) return httpError(401, 'Signed out', 'acctSignedOut');
  const e = r.body?.error || {};
  const vars = { code: errorCode(r.body) || 'internal' };
  if (typeof e.field === 'string' && /^[a-z_.]{1,40}$/.test(e.field)) vars.field = e.field;
  if (Number.isFinite(e.retry_after)) vars.retryAfter = Math.max(1, Math.ceil(e.retry_after));
  if (typeof e.reason === 'string') vars.reason = cleanText(e.reason, 80);
  return httpError(r.status >= 400 && r.status < 600 ? r.status : 502, `Account service: ${vars.code}`, 'acct', vars);
}

/**
 * secure: Electron's safeStorage wrapper (./store.mjs) or null; port(): this server's port; emit(event, data): the
 * page's event stream; openExternal(url): the system browser (desktop app) – without it the page opens the URL;
 * focus(): bring the app window forward. onPackKeyChange(): the souldew+ pack key changed or went away (tier dropped, key
 * rotated, signed out) – the encrypted pack cache must go (server/lib/pluspack.mjs wipe). fetchImpl / env / now / stats: for tests.
 */
export function createAccounts({ secure = null, port, emit = () => {}, openExternal = null, focus = () => {}, lang = () => 'en', onPackKeyChange = () => {}, fetchImpl = fetch, env = process.env, now = Date.now, stats = currentStats, choices = editorChoices } = {}) {
  const service = accountsBase(env);
  const store = createTokenStore(secure);
  let me = null;
  let meAt = 0;
  let meGen = 0; // bumps on every local write of `me`: a read that started before it must not overwrite it
  let pending = null;
  let catalog = null;
  let catalogAt = 0;
  const session = createSession({
    store, port, fetchImpl, env, now,
    toAccount: (a) => brief(cleanMe(a, service)),
    onChange: (s) => {
      if (!s.signedIn) {
        me = null;
        pending = null;
        stopHeartbeat();
        dropPackKey();
      }
      emit('account', { kind: 'session' });
    },
  });

  /** The pack key is gone or changed: the cached envelopes are useless (and must not linger) – wipe them. */
  function dropPackKey() {
    try {
      onPackKeyChange();
    } catch (e) {
      console.warn('souldew+ pack wipe failed –', e.message);
    }
  }

  /** What survives offline next to the tokens: the name and picture for Settings and the sidebar. */
  function brief(m) {
    return m ? { id: m.id, handle: m.handle, name: m.name, avatar: m.avatar, tier: m.entitlement?.tier || 'none' } : null;
  }

  /** An authorized call; any failure becomes the page's error. */
  async function call(path, opts = {}) {
    const r = await session.request(path, opts);
    if (r.status >= 200 && r.status < 300) return r.body || {};
    throw serviceError(r);
  }

  async function loadMe(force = false) {
    if (!session.signedIn) return null;
    if (!force && me && now() - meAt < ME_TTL) return me;
    const gen = meGen;
    const r = await session.request(API.me);
    if (r.status === 200 && gen !== meGen) return me; // an edit (PATCH, handle) landed meanwhile – it is newer
    if (r.status === 200) {
      me = cleanMe(r.body, service);
      meAt = now();
      session.rememberAccount(brief(me));
      startHeartbeat();
    }
    return me;
  }

  // ---- presence heartbeat + pending counters + opt-in stats ---------------------------------------------------------
  let report = null; // what the page says the player does: { state, game, run, location }
  let reportAt = 0;
  let timer = null;
  let timerAt = 0;
  let every = 60;
  let lastBeat = 0;
  let statsHash = null;
  let statsAt = 0;
  let lastSent = null;

  function stopHeartbeat() {
    clearTimeout(timer);
    timer = null;
  }
  function startHeartbeat(delay = 0) {
    if (!session.signedIn) return;
    clearTimeout(timer);
    timerAt = now() + delay;
    timer = setTimeout(beat, delay);
    timer.unref?.();
  }

  /** The presence body for the service, or null when nothing about the player may leave the computer. */
  function presenceBody() {
    const vis = me?.privacy?.presence || 'friends';
    if (vis !== 'friends' || !report) return null; // hidden / appear offline: no heartbeat at all, only the counters
    const body = { state: report.state };
    if ((report.state === 'playing' || report.state === 'in_run') && report.game) body.game = report.game;
    if (report.state === 'in_run' && report.run) body.run = report.run;
    if (report.location && me?.privacy?.showLocation) body.location = report.location;
    return body;
  }

  function setPending(p) {
    const next = {
      friendRequests: Math.max(0, Number(p?.friend_requests) || 0), invites: Math.max(0, Number(p?.invites) || 0), joinRequests: Math.max(0, Number(p?.join_requests) || 0),
    };
    if (JSON.stringify(next) === JSON.stringify(pending)) return;
    pending = next;
    emit('account', { kind: 'pending', pending });
  }

  async function beat() {
    timer = null;
    if (!session.signedIn) return;
    const alive = now() - reportAt < PAGE_ALIVE;
    try {
      await loadMe();
      const body = alive ? presenceBody() : null;
      let r;
      if (body) {
        r = await session.request(API.presence, { method: 'PUT', json: body });
        if (r.status === 200) lastSent = JSON.stringify(body);
      } else {
        // appear offline / hidden, or the page is gone: say we're gone once, then only ask for the counters
        if (lastSent) {
          await session.request(API.presence, { method: 'DELETE' });
          lastSent = null;
        }
        r = await session.request(API.pending);
      }
      if (r.status === 200) {
        if (Number.isFinite(r.body?.every)) every = Math.max(30, Math.min(300, r.body.every));
        setPending(r.body?.pending || r.body);
      }
      lastBeat = now();
      await uploadStats();
    } catch (e) {
      console.warn('account heartbeat failed –', e.code || e.name);
    }
    if (session.signedIn && alive) startHeartbeat(every * 1000);
  }

  async function uploadStats(force = false) {
    if (!me?.privacy?.showRuns) return;
    if (!force && now() - statsAt < STATS_EVERY) return;
    let body;
    try {
      body = stats();
    } catch (e) {
      console.warn('account stats –', e.message);
      return;
    }
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    statsAt = now();
    if (hash === statsHash && !force) return;
    const r = await session.request(API.stats, { method: 'PUT', json: body });
    if (r.status === 200) statsHash = hash;
  }

  /** The page's report of what the player does → cleaned; a change goes out soon (the service takes 6 a minute). */
  function setReport(b) {
    const state = oneOf(b.state, ['online', 'library', 'playing', 'in_run'], 'online');
    const g = b.game && typeof b.game === 'object' ? { title: withoutFileNames(b.game.title, 60), system: presenceSystem(b.game.system) } : null;
    const r = b.run && typeof b.run === 'object' ? { name: withoutFileNames(b.run.name, RUN_NAME_MAX), mode: oneOf(b.run.mode, ['soullink', 'nuzlocke'], 'soullink'), free_slot: b.run.freeSlot === true, joinable: b.run.joinable === true } : null;
    const next = { state, game: g?.title && g.system ? g : null, run: r?.name ? r : null, location: withoutFileNames(b.location, 40) || null };
    if (next.state === 'in_run' && !next.run) next.state = next.game ? 'playing' : 'online';
    if (next.state === 'playing' && !next.game) next.state = 'online';
    const wasAlive = now() - reportAt < PAGE_ALIVE;
    const changed = JSON.stringify(next) !== JSON.stringify(report);
    report = next;
    reportAt = now();
    if (!session.signedIn) return;
    if (!wasAlive || !timer) startHeartbeat(0);
    else if (changed) {
      // a change goes out within 10 s – but never later than a beat that is already due sooner (e.g. "appear offline")
      const delay = Math.max(0, 10000 - (now() - lastBeat));
      if (now() + delay < timerAt) startHeartbeat(delay);
    }
  }

  // ---- the page's routes --------------------------------------------------------------------------------------------
  const routes = [];
  const route = (method, path, handler) => routes.push({ method, pattern: new RegExp(`^/api/account${path}$`), handler });
  const signedIn = () => {
    if (!session.signedIn) throw httpError(401, 'Signed out', 'acctSignedOut');
  };

  route('GET', '', async () => {
    let m = null;
    if (session.signedIn) m = (await loadMe().catch(() => null)) || null;
    return { session: session.publicState(), me: m, brief: session.publicState().account, pending, service: new URL(service).host };
  });
  route('POST', '/login', () => {
    const { url } = session.startLogin();
    let opened = false;
    if (openExternal) {
      try {
        openExternal(url);
        opened = true;
      } catch {
        // the page opens it instead
      }
    }
    return { url, opened };
  });
  route('POST', '/login/cancel', () => {
    session.cancelLogin();
    return { ok: true };
  });
  route('POST', '/logout', async (req) => {
    const { everywhere } = await readJson(req);
    if (session.signedIn && lastSent) await session.request(API.presence, { method: 'DELETE' }).catch(() => {});
    lastSent = null;
    report = null;
    return session.signOut({ everywhere: everywhere === true });
  });

  // own account
  route('PATCH', '/me', async (req) => {
    signedIn();
    const patch = mePatch(await readJson(req));
    const body = cleanMe(await call(API.me, { method: 'PATCH', json: patch }), service);
    me = body;
    meAt = now();
    meGen++;
    session.rememberAccount(brief(me));
    if (patch.privacy?.show_runs === true) uploadStats(true).catch(() => {});
    if (patch.privacy?.presence) startHeartbeat(0);
    return body;
  });
  route('PUT', '/handle', async (req) => {
    signedIn();
    const handle = normalizeHandle((await readJson(req)).handle);
    if (!handle) throw httpError(400, 'Invalid handle', 'acct', { code: 'invalid_field', field: 'handle' });
    me = cleanMe(await call(API.handle, { method: 'PUT', json: { handle } }), service);
    meAt = now();
    meGen++;
    session.rememberAccount(brief(me));
    return me;
  });
  route('POST', '/friend-code', async () => {
    signedIn();
    await call(API.friendCode, { method: 'POST' });
    return loadMe(true);
  });
  route('GET', '/export', async () => {
    signedIn();
    return call(API.exportData);
  });
  route('DELETE', '', async (req) => {
    signedIn();
    const handle = normalizeHandle((await readJson(req)).confirm);
    if (!handle) throw httpError(400, 'Invalid handle', 'acct', { code: 'invalid_field', field: 'confirm' });
    await call(API.me, { method: 'DELETE', json: { confirm: handle } });
    session.forget();
    return { ok: true };
  });
  route('GET', '/catalog', async () => {
    if (catalog && now() - catalogAt < CATALOG_TTL) return catalog;
    const r = await fetchPublic(API.catalog);
    if (r.status !== 200) {
      if (catalog) return catalog;
      throw serviceError(r);
    }
    catalog = cleanCatalog(r.body);
    catalogAt = now();
    return catalog;
  });
  route('GET', '/choices', () => {
    signedIn();
    return choices();
  });

  // other players
  route('GET', `/users/(${ID})`, async (req, m) => {
    signedIn();
    return cleanProfile(await call(API.user(m[1])), service);
  });

  // friends: one call for the Friends page – friends with their presence, requests both ways
  route('GET', '/friends', async () => {
    signedIn();
    const [f, p, inc, out] = await Promise.all([call(API.friends), call(API.presenceFriends), call(API.requestsBox('incoming')), call(API.requestsBox('outgoing'))]);
    const presence = new Map(list(p).map(cleanPresence).filter(Boolean).map((x) => [x.userId, x]));
    return {
      friends: list(f).map((x) => cleanFriend(x, service)).filter(Boolean).map((x) => ({ ...x, presence: presence.get(x.user.id) || { userId: x.user.id, state: 'offline' } })),
      incoming: list(inc).map((x) => cleanRequest(x, service)).filter(Boolean),
      outgoing: list(out).map((x) => cleanRequest(x, service)).filter(Boolean),
    };
  });
  route('POST', '/friends/requests', async (req) => {
    signedIn();
    const q = parseFriendQuery((await readJson(req)).query);
    if (!q) throw httpError(400, 'Invalid handle or friend code', 'acct', { code: 'invalid_field', field: 'query' });
    const r = await call(API.requests, { method: 'POST', json: q });
    return { status: r.status === 'accepted' ? 'accepted' : 'sent' };
  });
  route('POST', `/friends/requests/(${ID})/(accept|ignore)`, async (req, m) => {
    signedIn();
    await call(API.request(m[1], m[2]), { method: 'POST' });
    return { ok: true };
  });
  route('DELETE', `/friends/requests/(${ID})`, async (req, m) => {
    signedIn();
    await call(API.request(m[1]), { method: 'DELETE' });
    return { ok: true };
  });
  route('DELETE', `/friends/(${ID})`, async (req, m) => {
    signedIn();
    await call(API.friend(m[1]), { method: 'DELETE' });
    return { ok: true };
  });
  route('GET', '/blocks', async () => {
    signedIn();
    return { items: list(await call(API.blocksList)).map((x) => ({ user: cleanFriend(x, service)?.user, since: null })).filter((x) => x.user) };
  });
  route('POST', '/blocks', async (req) => {
    signedIn();
    const userId = idOf((await readJson(req)).userId);
    await call(API.blocks, { method: 'POST', json: { user_id: userId } });
    return { ok: true };
  });
  route('DELETE', `/blocks/(${ID})`, async (req, m) => {
    signedIn();
    await call(API.block(m[1]), { method: 'DELETE' });
    return { ok: true };
  });
  route('POST', '/reports', async (req) => {
    signedIn();
    const b = await readJson(req);
    const body = {
      user_id: idOf(b.userId), target: oneOf(b.target, ['profile', 'status', 'name', 'other'], 'profile'),
      reason: oneOf(b.reason, ['spam', 'harassment', 'hate', 'impersonation', 'inappropriate', 'other'], 'other'),
    };
    const note = typeof b.note === 'string' ? b.note.replace(/\r\n?/g, '\n').split('\n').slice(0, 6).map((l) => cleanText(l, 300)).join('\n').slice(0, 300).trim() : '';
    if (note) body.note = note;
    const r = await call(API.reports, { method: 'POST', json: body });
    return { ok: true, duplicate: r.duplicate === true };
  });

  // presence
  route('PUT', '/presence', async (req) => {
    setReport(await readJson(req));
    return { ok: true, pending };
  });

  // play with friends
  route('GET', '/invites', async () => {
    signedIn();
    const [ii, io, ji, jo] = await Promise.all([call(API.invitesBox('incoming')), call(API.invitesBox('outgoing')), call(API.joinBox('incoming')), call(API.joinBox('outgoing'))]);
    return {
      incoming: list(ii).map((x) => cleanInvite(x, service)).filter(Boolean).map(({ code, ...x }) => x), // never a code in a list for recipients
      outgoing: list(io).map((x) => cleanInvite(x, service)).filter(Boolean),
      joinIncoming: list(ji).map((x) => cleanJoinRequest(x, service)).filter(Boolean),
      joinOutgoing: list(jo).map((x) => cleanJoinRequest(x, service)).filter(Boolean),
    };
  });
  route('POST', '/invites', async (req) => {
    signedIn();
    const b = await readJson(req);
    const to = [...new Set((Array.isArray(b.to) ? b.to : []).map(idOf))];
    if (!to.length || to.length > 8) throw httpError(400, 'Pick 1 to 8 friends', 'acct', { code: 'invalid_field', field: 'to' });
    const code = inviteCode(b.code);
    if (!code) throw httpError(400, 'Invalid invite code', 'acct', { code: 'invalid_field', field: 'invite_code' });
    const r = await call(API.invites, { method: 'POST', json: { to, run: runRef(b.run), invite_code: code, ttl_minutes: Math.max(5, Math.min(1440, Number(b.ttlMinutes) || 15)) } });
    return cleanInvite(r.invite, service);
  });
  route('POST', `/invites/(${ID})/accept`, async (req, m) => {
    signedIn();
    const r = await call(API.invite(m[1], 'accept'), { method: 'POST' });
    return cleanInvite(r.invite, service, r.invite_code);
  });
  route('POST', `/invites/(${ID})/decline`, async (req, m) => {
    signedIn();
    await call(API.invite(m[1], 'decline'), { method: 'POST' });
    return { ok: true };
  });
  route('DELETE', `/invites/(${ID})`, async (req, m) => {
    signedIn();
    await call(API.invite(m[1]), { method: 'DELETE' });
    return { ok: true };
  });
  route('POST', '/join-requests', async (req) => {
    signedIn();
    const r = await call(API.joinRequests, { method: 'POST', json: { to: idOf((await readJson(req)).to) } });
    return cleanJoinRequest(r.join_request, service);
  });
  route('POST', `/join-requests/(${ID})/accept`, async (req, m) => {
    signedIn();
    const b = await readJson(req);
    const code = inviteCode(b.code);
    if (!code) throw httpError(400, 'Invalid invite code', 'acct', { code: 'invalid_field', field: 'invite_code' });
    const r = await call(API.joinRequest(m[1], 'accept'), { method: 'POST', json: { invite_code: code, run: runRef(b.run) } });
    return cleanInvite(r.invite, service);
  });
  route('POST', `/join-requests/(${ID})/decline`, async (req, m) => {
    signedIn();
    await call(API.joinRequest(m[1], 'decline'), { method: 'POST' });
    return { ok: true };
  });
  route('DELETE', `/join-requests/(${ID})`, async (req, m) => {
    signedIn();
    await call(API.joinRequest(m[1]), { method: 'DELETE' });
    return { ok: true };
  });

  // souldew+
  // the entitlement is kept with the session (encrypted): offline, the cosmetics keep working for its grace days
  route('GET', '/entitlements', async () => {
    signedIn();
    const r = await session.request(API.entitlements);
    if (r.status === 200) {
      const ent = cleanEntitlements(r.body);
      const kept = session.extra('entitlement');
      // §8.2: the tier dropped below souldew+ or pack_key_id changed (sign out everywhere, unlink, takeover) → wipe
      if (kept?.packKey && (!ent.packKey || !isPlusTier(ent.tier) || kept.packKeyId !== ent.packKeyId)) {
        dropPackKey();
        session.setExtra('pack', null);
      }
      session.setExtra('entitlement', { ...ent, token: null, preview: null, at: now() });
      return ent;
    }
    const kept = r.status === 0 ? session.extra('entitlement') : null;
    if (kept && now() - kept.at < (kept.offlineGraceDays || 7) * 86400000) return { ...kept, offline: true, preview: null, lastPack: session.extra('pack') };
    throw serviceError(r);
  });
  // §8.3: the service answers "submitted" whatever the email is (no supporter oracle) – the result is read from the
  // entitlement: linked when the tier or its sources changed
  route('POST', '/link-email', async (req) => {
    signedIn();
    const email = String((await readJson(req)).email || '').trim();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Invalid email', 'acct', { code: 'invalid_field', field: 'email' });
    const before = await session.request(API.entitlements);
    const sig = (b) => JSON.stringify([b?.tier, (b?.sources || []).map((x) => [x.kind, x.tier, x.status, x.until])]);
    const r = await call(API.linkEmail, { method: 'POST', json: { email } });
    if (r.submitted !== true) throw httpError(502, 'Unexpected answer', 'acct', { code: 'internal' });
    // the answer never says whether it matched (no supporter oracle): read the entitlement – a few times, the link is
    // written right away but the entitlement read may land on a replica a moment behind
    let after = null;
    for (let i = 0; i < 3; i++) {
      after = await call(API.entitlements);
      if (before.status !== 200 || sig(before.body) !== sig(after)) break;
      await new Promise((res) => setTimeout(res, 700));
    }
    await loadMe(true).catch(() => null);
    const ent = cleanEntitlements(after);
    return { submitted: true, linked: before.status === 200 && sig(before.body) !== sig(after), tier: ent.tier, badges: ent.badges, until: ent.until };
  });
  route('DELETE', '/link', async () => {
    signedIn();
    await call(API.unlink, { method: 'DELETE' });
    dropPackKey(); // §8.5: the key rotates – nothing cached can be read any more
    session.setExtra('pack', null);
    await loadMe(true).catch(() => null);
    return { ok: true };
  });
  route('GET', '/packs', async () => {
    signedIn();
    return { items: list(await call(API.packs)).map(cleanPack).filter(Boolean) };
  });
  route('POST', `/packs/(${ID})/download`, async (req, m) => {
    signedIn();
    const d = cleanDownload(await call(API.packDownload(m[1]), { method: 'POST' }), service);
    session.setExtra('pack', { packId: d.packId, version: d.version, signature: d.signature, packKeyId: d.packKeyId });
    return d;
  });

  // §10.4: a 15-minute live theme preview (signed-in users; meant for non-members). Memory only on the page.
  route('POST', `/packs/(${ID})/preview`, async (req, m) => {
    signedIn();
    return cleanPreview(await call(API.packPreview(m[1]), { method: 'POST' }), service);
  });

  /** A no-auth GET of the service (the catalog). */
  async function fetchPublic(path) {
    try {
      const r = await fetchImpl(`${service}${path}`, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      let body = {};
      try {
        body = await r.json();
      } catch {}
      return { status: r.status, body };
    } catch {
      return { status: 0, body: {} };
    }
  }

  // ---- the browser's way back: /auth/done ----------------------------------------------------------------------------
  /**
   * GET /auth/done?code=…&state=… – the service's redirect after Discord said yes. Only a real top-level navigation to
   * exactly http://127.0.0.1:<port> is taken (a page's fetch or <img>, another host name, an Origin header, repeated
   * or extra parameters are turned away); the code is used for the pending sign-in only if the state is ours. The
   * answer is a redirect to /auth/done?r=<outcome>, so the code doesn't stay in the browser's address bar and history.
   */
  async function authDone(req, res, url) {
    const page = (status, result) => {
      res.writeHead(status, AUTH_PAGE_HEADERS);
      res.end(authPage(result, lang()));
    };
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
      return res.end();
    }
    const h = req.headers;
    const hostOk = String(h.host || '').toLowerCase() === `127.0.0.1:${port()}`;
    const navigation = (h['sec-fetch-mode'] === undefined || h['sec-fetch-mode'] === 'navigate') && (h['sec-fetch-dest'] === undefined || h['sec-fetch-dest'] === 'document');
    if (!hostOk || !navigation || h.origin !== undefined) return page(403, 'failed');
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length || keys.some((k) => !['code', 'state', 'error', 'r'].includes(k))) return page(400, 'bad');
    const q = Object.fromEntries(url.searchParams);
    if ('r' in q) return keys.length === 1 && AUTH_RESULTS.includes(q.r) ? page(q.r === 'ok' ? 200 : 400, q.r) : page(400, 'bad');
    if (!('state' in q)) return page(400, 'bad');
    const out = await session.finishLogin({ code: q.code, state: q.state, error: q.error ? cleanText(q.error, 40) : null });
    const result = out.ok ? 'ok' : out.error;
    if (out.ok) {
      await loadMe(true).catch(() => null);
      emit('account', { kind: 'signed-in' });
      try {
        focus();
      } catch {}
    }
    res.writeHead(303, { Location: `/auth/done?r=${AUTH_RESULTS.includes(result) ? result : 'failed'}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return res.end();
  }

  // ---- avatars --------------------------------------------------------------------------------------------------------
  const avatars = new Map(); // source URL → { type, buf }
  /** GET /api/account/avatar?src=<allowed avatar URL>: fetched once, checked to be a picture, kept in memory. */
  async function avatar(req, res, url) {
    const src = safeAvatarUrl(url.searchParams.get('src'), service);
    const fail = (status) => {
      res.writeHead(status, { 'Cache-Control': 'no-store' });
      res.end();
    };
    if (req.method !== 'GET' || !src || [...url.searchParams.keys()].length !== 1) return fail(400);
    if (!session.signedIn) return fail(404);
    let hit = avatars.get(src);
    if (!hit) {
      try {
        const r = await fetchImpl(src, { redirect: 'error', signal: AbortSignal.timeout(10000) });
        const len = Number(r.headers.get('content-length'));
        if (!r.ok || (Number.isFinite(len) && len > AVATAR_MAX)) return fail(404);
        const buf = Buffer.from(await r.arrayBuffer());
        const type = imageType(buf);
        if (!type || buf.length > AVATAR_MAX) return fail(404);
        hit = { type, buf };
        avatars.set(src, hit);
        if (avatars.size > AVATAR_CACHE) avatars.delete(avatars.keys().next().value);
      } catch {
        return fail(404);
      }
    }
    res.writeHead(200, { 'Content-Type': hit.type, 'Content-Length': hit.buf.length, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'", 'Cross-Origin-Resource-Policy': 'same-origin' });
    return res.end(hit.buf);
  }

  /** The page asks whether this computer may keep the session (keychain) – part of GET /api/account. */
  function close() {
    stopHeartbeat();
    if (session.signedIn && lastSent) session.request(API.presence, { method: 'DELETE', timeout: 2000 }).catch(() => {});
  }

  /** For "Save diagnostics": signed in yes / no and the tier – nothing else. */
  const diagnostics = () => ({ signedIn: session.signedIn, tier: session.signedIn ? me?.entitlement?.tier || session.publicState().account?.tier || 'none' : null });

  return { routes, authDone, avatar, close, diagnostics, session, setReport, get service() { return service; } };
}

const list = (body) => (Array.isArray(body?.items) ? body.items : []);

function idOf(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{3,64}$/.test(v)) throw httpError(400, 'Invalid id', 'acct', { code: 'invalid_field', field: 'user_id' });
  return v;
}

/** A run as an invite names it (§6.2): name, game, mode, system – nothing that identifies the run itself. */
function runRef(v) {
  const o = v && typeof v === 'object' ? v : {};
  const out = { name: withoutFileNames(o.name, RUN_NAME_MAX) || 'Run', game: withoutFileNames(o.game, 60) || 'Game', mode: oneOf(o.mode, ['soullink', 'nuzlocke'], 'soullink') };
  const sys = presenceSystem(o.system);
  if (sys) out.system = sys;
  return out;
}

/**
 * A free text the player typed, as the service stores it (API.md §0.6): NFKC, single spaces – and refused here
 * already (with the service's own error) when it holds < or > or no letter or digit at all.
 */
export function userText(v, max, field) {
  const s = cleanText(typeof v === 'string' ? v.normalize('NFKC') : v, max);
  if (!s) return null;
  if (/[<>]/.test(s) || !/[\p{L}\p{N}]/u.test(s)) throw httpError(400, 'Text not allowed', 'acct', { code: 'text_rejected', field });
  return s;
}

/** The page's profile edits (camelCase) → the PATCH body of §2.2 – known fields only, each checked. */
export function mePatch(b) {
  const out = {};
  if ('name' in b) out.display_name = b.name === null ? null : userText(b.name, NAME_MAX, 'display_name');
  for (const k of ['banner', 'frame', 'nameplate', 'title', 'accent']) if (k in b) out[k] = b[k] === null ? null : catalogId(b[k]);
  if ('accent' in b && !out.accent) delete out.accent; // never null: the palette always has a colour
  if ('status' in b) out.status = userText(b.status, STATUS_MAX, 'status');
  if ('showcase' in b && b.showcase && typeof b.showcase === 'object') {
    const s = b.showcase;
    out.showcase = {
      trophies: [...new Set((Array.isArray(s.trophies) ? s.trophies : []).map(catalogId).filter(Boolean))].slice(0, 3),
      trusted: userText(s.trusted, TRUSTED_MAX, 'showcase.trusted'),
      favorite_game: userText(s.favoriteGame, FAVORITE_MAX, 'showcase.favorite_game'),
    };
  }
  if ('privacy' in b && b.privacy && typeof b.privacy === 'object') {
    const p = b.privacy;
    const priv = {};
    if (PROFILE_VISIBILITY.includes(p.profile)) priv.profile = p.profile;
    if (PRESENCE_VISIBILITY.includes(p.presence)) priv.presence = p.presence;
    if (typeof p.showLocation === 'boolean') priv.show_location = p.showLocation;
    if (typeof p.showRuns === 'boolean') priv.show_runs = p.showRuns;
    if (['everyone', 'nobody'].includes(p.friendRequests)) priv.friend_requests = p.friendRequests;
    if (Object.keys(priv).length) out.privacy = priv;
  }
  if (!Object.keys(out).length) throw httpError(400, 'Nothing to change', 'acct', { code: 'bad_request' });
  return out;
}

/** PNG, WebP, GIF or JPEG by their first bytes – the declared type of the answer doesn't count. */
export function imageType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

function cleanPack(p) {
  if (!p || typeof p !== 'object' || !catalogId(p.id)) return null;
  return {
    id: p.id, version: typeof p.version === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(p.version) ? p.version : null,
    kind: oneOf(p.kind, ['skins', 'banners', 'frames', 'launch', 'mixed', 'preview'], 'mixed'), title: cleanText(p.title, 60),
    requiredTier: oneOf(p.required_tier, ['free', 'supporter', 'plus'], 'plus'), entitled: p.entitled === true, previewable: p.previewable === true,
  };
}

const b64 = (v, max) => (typeof v === 'string' && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v) ? v : null);

/** A live preview answer (§10.4): like a download, with its own key (for this preview only) and its end. */
function cleanPreview(d, service) {
  const base = cleanDownload(d, service);
  const keyId = typeof d?.key_id === 'string' && /^pv_[A-Za-z0-9_-]{22}$/.test(d.key_id) ? d.key_id : null;
  const key = typeof d?.preview_key === 'string' && d.preview_key.length === 43 && /^[A-Za-z0-9_-]+$/.test(d.preview_key) ? d.preview_key : null;
  const expiresAt = typeof d?.expires_at === 'string' && Number.isFinite(Date.parse(d.expires_at)) ? new Date(d.expires_at).toISOString() : null;
  if (!keyId || !key || !expiresAt || !base.manifest || !base.signature || !base.files.length) throw httpError(502, 'Bad preview answer', 'acct', { code: 'internal' });
  return { ...base, packKeyId: keyId, previewId: keyId, key, expiresAt, offlineGrace: false };
}

/** A pack download answer (§10.2): manifest and signature as base64url, file URLs only on the service itself. */
function cleanDownload(d, service) {
  const origin = new URL(service).origin;
  const files = (Array.isArray(d?.files) ? d.files : []).slice(0, 2000).map((f) => {
    let u = null;
    try {
      u = new URL(f.url);
    } catch {}
    const path = typeof f.path === 'string' && f.path.length <= 200 && /^[A-Za-z0-9_./-]+$/.test(f.path) && !f.path.includes('..') ? f.path : null;
    return u && u.origin === origin && !u.username && path ? { path, url: u.href } : null;
  }).filter(Boolean);
  return {
    packId: catalogId(d?.pack_id), version: typeof d?.version === 'string' ? d.version.slice(0, 32) : null,
    manifest: b64(d?.manifest, 2 * 1024 * 1024), signature: b64(d?.signature, 200), watermarkId: typeof d?.watermark_id === 'string' && /^wm_[A-Za-z0-9_-]{1,40}$/.test(d.watermark_id) ? d.watermark_id : null,
    packKeyId: typeof d?.pack_key_id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(d.pack_key_id) ? d.pack_key_id : null,
    expiresAt: typeof d?.expires_at === 'string' ? Date.parse(d.expires_at) || null : null, files,
  };
}
