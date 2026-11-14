import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pairMate, samePairFamily, exclusiveSide, isMixedPairRun, pairHasExclusive, PAIR_TITLES,
} from '../shared/pair-titles.mjs';
import { baseRomsFor, needsIdenticalRom } from '../shared/restart.mjs';

test('PAIR_TITLES is HG ↔ SS only in v1', () => {
  assert.deepEqual(PAIR_TITLES, [['pokemon-heartgold', 'pokemon-soulsilver']]);
  assert.equal(pairMate('pokemon-heartgold'), 'pokemon-soulsilver');
  assert.equal(pairMate('pokemon-soulsilver'), 'pokemon-heartgold');
  assert.equal(pairMate('pokemon-platinum'), null);
});

test('samePairFamily treats variants and sisters as one family', () => {
  const rootOf = (id) => ({ 'pokemon-heartgold-eu': 'pokemon-heartgold', 'pokemon-soulsilver-de': 'pokemon-soulsilver' }[id] || id);
  assert.equal(samePairFamily('pokemon-heartgold', 'pokemon-soulsilver', rootOf), true);
  assert.equal(samePairFamily('pokemon-heartgold-eu', 'pokemon-soulsilver-de', rootOf), true);
  assert.equal(samePairFamily('pokemon-heartgold', 'pokemon-heartgold-eu', rootOf), true);
  assert.equal(samePairFamily('pokemon-heartgold', 'pokemon-platinum', rootOf), false);
});

test('exclusiveSide marks known HG/SS version exclusives', () => {
  assert.equal(exclusiveSide(58), 'heartgold'); // Growlithe
  assert.equal(exclusiveSide(37), 'soulsilver'); // Vulpix
  assert.equal(exclusiveSide(25), null); // Pikachu
  assert.equal(exclusiveSide(null), null);
});

test('isMixedPairRun / pairHasExclusive', () => {
  const host = { game: { id: 'pokemon-heartgold' }, outputs: { p1: { gameId: 'pokemon-heartgold' }, p2: { gameId: 'pokemon-soulsilver' } } };
  assert.equal(isMixedPairRun(host), true);
  assert.equal(isMixedPairRun({ game: { id: 'pokemon-heartgold' }, outputs: { p1: { gameId: 'pokemon-heartgold' }, p2: { gameId: 'pokemon-heartgold' } } }), false);
  assert.equal(isMixedPairRun({ game: { id: 'pokemon-platinum' }, outputs: { p1: { gameId: 'pokemon-pearl' } } }), false);
  assert.equal(pairHasExclusive([25, 58]), true);
  assert.equal(pairHasExclusive([25, 16]), false);
});

test('plain HG run accepts SS ROM via baseRomsFor; randomized does not', () => {
  const rootOf = (id) => ({ 'pokemon-heartgold-eu': 'pokemon-heartgold' }[id] || id);
  const roms = [
    { id: 'hg', crc: 'C180A0E9', gameId: 'pokemon-heartgold' },
    { id: 'ss', crc: 'D0A0BEF9', gameId: 'pokemon-soulsilver' },
    { id: 'ss-hack', crc: 'AAAAAAAA', gameId: 'pokemon-soulsilver', hackId: 'x' },
    { id: 'pt', crc: '9253921D', gameId: 'pokemon-platinum' },
  ];
  const plain = { base: { crc: 'C180A0E9' }, game: { id: 'pokemon-heartgold', system: 'nds' }, randomizer: { enabled: false }, patch: null };
  assert.equal(needsIdenticalRom(plain), false);
  assert.deepEqual(baseRomsFor(plain, roms, rootOf).map((r) => r.id), ['hg', 'ss']);
  assert.deepEqual(baseRomsFor({ ...plain, randomizer: { enabled: true } }, roms, rootOf).map((r) => r.id), ['hg']);
  assert.deepEqual(baseRomsFor({ ...plain, patch: { name: 'x' } }, roms, rootOf).map((r) => r.id), ['hg']);
  // host CRC missing: same-title still matches by gameId, then sister
  assert.deepEqual(baseRomsFor({ ...plain, base: { crc: '00000000' } }, roms, rootOf).map((r) => r.id), ['hg', 'ss']);
  // language-variant host id still finds the sister
  assert.deepEqual(baseRomsFor({ ...plain, game: { id: 'pokemon-heartgold-eu', system: 'nds' } }, roms, rootOf).map((r) => r.id), ['hg', 'ss']);
});

test('isMixedPairRun unions player rows and outputs', () => {
  const rootOf = (id) => id;
  const m = {
    game: { id: 'pokemon-heartgold' },
    outputs: { p1: { gameId: 'pokemon-heartgold' }, p2: { gameId: 'pokemon-heartgold' } },
  };
  assert.equal(isMixedPairRun(m, rootOf, { p1: 'pokemon-heartgold', p2: 'pokemon-soulsilver' }), true);
  assert.equal(isMixedPairRun(m, rootOf, { p1: 'pokemon-heartgold' }), false);
});
