import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEED_CHATTY_CAP, RunDoc } from '../web/lib/doc.mjs';

const mk = (by) => { const d = new RunDoc('test'); d.by = by; d._persistSoon = () => {}; return d; };

function withLocalStorage(fn) {
  const store = new Map();
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  try {
    return fn(store);
  } finally {
    if (prev === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prev;
  }
}

test('LWW map converges regardless of merge order and duplicates', () => {
  const a = mk('a');
  const b = mk('b');
  a.set('enc:route-29:p1', { species: 16 });
  b.set('enc:route-29:p2', { species: 161 });
  b.set('pair:route-29', { state: 'dead' });
  a.set('rules', { typeClause: 'off' });
  b.set('rules', { typeClause: 'party' }); // later write wins
  const snapA = structuredClone(a.entries);
  const snapB = structuredClone(b.entries);
  a.merge(snapB); a.merge(snapB);
  b.merge(snapA);
  assert.deepEqual(a.entries, b.entries);
  assert.equal(a.get('rules').typeClause, 'party');
  assert.equal(a.get('pair:route-29').state, 'dead');
});

test('deletes are tombstones that win over older values', () => {
  const a = mk('a');
  const b = mk('b');
  a.set('enc:x:p1', { species: 1 });
  b.merge(structuredClone(a.entries));
  b.del('enc:x:p1');
  a.merge(structuredClone(b.entries));
  assert.equal(a.get('enc:x:p1'), undefined);
  assert.deepEqual(a.scan('enc:'), {});
});

test('a failed server save is retried with growing pauses until it succeeds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 3) throw new Error('server restarting');
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) };
  };
  const flush = () => new Promise((r) => setImmediate(r));
  try {
    await withLocalStorage(async () => {
      const d = new RunDoc('retry');
      d.by = 'a';
      d.set('enc:x:p1', { species: 1 });
      t.mock.timers.tick(600); // debounce → first try
      await flush();
      assert.equal(calls, 1);
      t.mock.timers.tick(1999);
      await flush();
      assert.equal(calls, 1); // not before the first pause is over
      t.mock.timers.tick(1);
      await flush();
      assert.equal(calls, 2);
      t.mock.timers.tick(5000);
      await flush();
      assert.equal(calls, 3); // succeeded – no more tries
      t.mock.timers.tick(60000);
      await flush();
      assert.equal(calls, 3);
    });
  } finally {
    globalThis.fetch = saved;
  }
});

test('localStorage persist is debounced and omits live:* (#44)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) });
  try {
    await withLocalStorage(async (store) => {
      const d = new RunDoc('ls-perf');
      d.by = 'a';
      d.set('enc:r1:p1', { species: 16, outcome: 'caught' });
      d.set('live:p1', { party: [{ hp: 10, maxHp: 20 }] });
      assert.equal(store.has('sl-doc-ls-perf'), false, 'no sync stringify before debounce');
      t.mock.timers.tick(599);
      assert.equal(store.has('sl-doc-ls-perf'), false);
      t.mock.timers.tick(1);
      const raw = store.get('sl-doc-ls-perf');
      assert.ok(raw);
      const snap = JSON.parse(raw);
      assert.ok(snap['enc:r1:p1']);
      assert.equal(snap['live:p1'], undefined, 'live keys stay out of the LS snapshot');
      assert.ok(d.get('live:p1'), 'in-memory live still present');
    });
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('chatty feed keys are capped; trophy types are kept (#45)', () => {
  const d = mk('a');
  d.batch(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [
    `feed:catch-${i}`, { at: i, type: 'catch', slot: 'p1', area: `r${i}`, species: 1 + i },
  ])));
  d.batch(Object.fromEntries(Array.from({ length: FEED_CHATTY_CAP + 40 }, (_, i) => [
    `feed:run-${i}`, { at: 1000 + i, type: 'run', slot: 'p1', text: 'reopened' },
  ])));
  const live = d.scan('feed:');
  const catches = Object.keys(live).filter((id) => id.startsWith('catch-'));
  const runs = Object.keys(live).filter((id) => id.startsWith('run-'));
  assert.equal(catches.length, 10, 'catch entries never pruned');
  assert.equal(runs.length, FEED_CHATTY_CAP, 'chatty run/resume capped');
  assert.equal(d.entries['feed:run-0'].v, null, 'oldest chatty tombstoned for LWW/server merge');
  assert.equal(d.entries['feed:run-39'].v, null);
  assert.equal(live['run-40']?.type, 'run');
  assert.equal(live[`run-${FEED_CHATTY_CAP + 39}`]?.type, 'run', 'newest chatty kept');
});
