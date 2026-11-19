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
