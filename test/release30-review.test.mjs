// Regression tests from the 3.0 release review (one block per fix).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SLS_DATA_DIR = mkdtempSync(join(tmpdir(), 'souldew-review30-'));
// a service address on this computer nobody answers at: nothing leaves the machine
process.env.SLS_ACCOUNTS_URL = 'http://127.0.0.1:9';
const { startServer } = await import('../server/app.mjs');

const servers = [];
after(() => {
  for (const s of servers) s.close();
});

test('a souldew+ preview that can\'t be had is a 404 answer, never an unhandled rejection that leaves the request hanging', async () => {
  const unhandled = [];
  const onRejection = (e) => unhandled.push(e);
  process.on('unhandledRejection', onRejection);
  try {
    const s = await startServer({ port: 0, background: false });
    servers.push(s.server);
    const r = await fetch(`http://127.0.0.1:${s.port}/api/plus/previews/file?path=banners/none.png`, { headers: { 'x-soullink': '1' }, signal: AbortSignal.timeout(20000) });
    assert.equal(r.status, 404);
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(unhandled.map((e) => e?.message), []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('signing out while a token refresh is on its way: the late answer doesn\'t sign the player back in', async () => {
  const { createSession } = await import('../server/lib/accounts/session.mjs');
  let stored = { access: 'a'.repeat(20), accessExp: 0, refresh: 'r'.repeat(20), sid: null, service: 'http://127.0.0.1:9', account: { id: 'u_1' } };
  const store = { load: () => stored, save: (v) => (stored = v), clear: () => (stored = null), persistent: () => true };
  let release;
  const gate = new Promise((res) => (release = res));
  const json = (status, body) => ({ status, json: async () => body, headers: new Headers() });
  const fetchImpl = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (url.endsWith('/auth/token') && body.grant_type === 'refresh_token') {
      await gate;
      return json(200, { access_token: 'b'.repeat(20), refresh_token: 's'.repeat(20), expires_in: 900 });
    }
    if (url.endsWith('/auth/logout')) return json(200, {});
    return json(200, {});
  };
  const s = createSession({ store, port: () => 1, fetchImpl, env: { SLS_ACCOUNTS_URL: 'http://127.0.0.1:9' } });
  assert.equal(s.signedIn, true);
  const pending = s.request('/v1/me'); // the access token ran out: a refresh starts
  await new Promise((res) => setTimeout(res, 10));
  await s.signOut();
  assert.equal(s.signedIn, false);
  release();
  await pending;
  assert.equal(s.signedIn, false, 'still signed out');
  assert.equal(stored, null, 'nothing stored again');
});

test('upgrade backup: a file that vanishes between the plan and the copy is skipped, the rest is still backed up', async () => {
  const { makeBackup, backupPlan } = await import('../server/lib/upgrade.mjs');
  const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'souldew-review30-backup-'));
  mkdirSync(join(dir, 'runs', 'abcd1234'), { recursive: true });
  writeFileSync(join(dir, 'runs', 'abcd1234', 'p1.sav'), Buffer.alloc(1024, 7));
  writeFileSync(join(dir, 'Cookies-journal'), 'x');
  const plan = backupPlan(dir);
  assert.equal(plan.files.length, 2);
  // the journal is gone by the time the copy reaches it
  const { rmSync } = await import('node:fs');
  rmSync(join(dir, 'Cookies-journal'));
  const made = makeBackup(dir, { label: '3.0', plan, free: 1e12 });
  assert.equal(made.files, 1);
  assert.equal(made.bytes, 1024);
  assert.deepEqual(readFileSync(join(made.path, 'runs', 'abcd1234', 'p1.sav')), Buffer.alloc(1024, 7));
  assert.equal(existsSync(join(made.path, 'Cookies-journal')), false);
});
