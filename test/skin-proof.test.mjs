// "A skin changes the look only" – proven on the REAL app: every main view rendered in Electron with classic and with
// every souldew+ skin of a pack, comparing every element's box, the visible text and the generated text
// (test/fixtures/skin-proof-runner.mjs). The automated form of the design's proof.py.
//
// Skins are premium content and not in this repository, so the test needs a pack: SLS_PLUS_PROOF_PACK=<dev pack folder>
// (scripts/plus-dev-pack.mjs), or the design sources next to the checkout (../design-plus/design/plus), from which it
// builds one. Without either – or without a display on Linux – it is skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = join(ROOT, '..', 'design-plus', 'design', 'plus');
const noDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
const havePack = !!process.env.SLS_PLUS_PROOF_PACK || existsSync(join(DESIGN, 'themes', 'skins.json'));
const skip = noDisplay ? 'no display' : !havePack ? 'no souldew+ pack (set SLS_PLUS_PROOF_PACK)' : false;

test('skins never change a box or a text on the real app views', { skip, timeout: 600000 }, async () => {
  let pack = process.env.SLS_PLUS_PROOF_PACK;
  if (!pack) {
    pack = mkdtempSync(join(tmpdir(), 'souldew-proof-pack-'));
    const b = spawnSync(process.execPath, [join(ROOT, 'scripts', 'plus-dev-pack.mjs'), '--design', DESIGN, '--out', pack], { encoding: 'utf8' });
    assert.equal(b.status, 0, b.stderr);
  }
  const data = mkdtempSync(join(tmpdir(), 'souldew-proof-data-'));
  writeFileSync(join(data, 'config.json'), JSON.stringify({ onboarded: true, lang: 'en', playerName: 'Proof', bootAnimation: false, nagOff: true }));
  const out = join(data, 'proof.json');
  const electron = (await import('electron')).default;
  const r = spawnSync(electron, [join(ROOT, 'test', 'fixtures', 'skin-proof-runner.mjs'), out], {
    env: { ...process.env, SLS_DATA_DIR: data, SLS_PLUS_DEV_PACK: pack, ELECTRON_ENABLE_LOGGING: '' }, encoding: 'utf8', timeout: 540000,
  });
  assert.ok(existsSync(out), `the runner wrote no result (exit ${r.status}): ${String(r.stderr).slice(-2000)}`);
  const res = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(res.error, undefined, res.error);
  assert.ok(res.skins >= 20, `${res.skins} skins in the pack`);
  assert.equal(res.views, 11);
  assert.deepEqual(res.diffs, [], `${res.diffs.length} differences`);
  assert.ok(res.boxes > 10000, `${res.boxes} element boxes compared`);
  // glyph runs only where the design has them: page titles of the skins with their own display face
  for (const g of res.glyphRuns) assert.match(g, /^(fieldbook|clearshell|woodgrain) · .* · H1/, g);
  console.log(`skin proof: ${res.skins} skins × ${res.views} views, ${res.boxes} element boxes, 0 differences, ${res.glyphRuns.length} title glyph runs`);
});
