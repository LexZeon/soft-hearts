// StayStill idle round (docs/claude/2026-11-14-staystill-idle.md): the two extra idle measures (continuous head pauses, how the
// head's yaw follows the chest's) and, when the local ML interpreter exists, the Python converter's own tests (file names and the
// official subject splits, freemocap-only extraction, the Blender-export axis renaming with the sign of a neck turn and a chest
// lean, glitch cutting, the neck/head share). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Quaternion, Vector3 } from 'three';
import { firstExceed, headOnChest, pauseRuns, yawRates } from '../scripts/ml/idle-measures';

const here = path.dirname(fileURLToPath(import.meta.url));

test('pauses: only runs under the threshold that last long enough count', () => {
  const fps = 30;
  // 1 s moving, 0.5 s still, 1 s moving, 0.2 s still (too short), 1 s moving, 1 s still: 4.7 s.
  const speeds = [...Array(30).fill(5), ...Array(15).fill(0.2), ...Array(30).fill(5), ...Array(6).fill(0.5), ...Array(30).fill(5), ...Array(30).fill(0)];
  const p = pauseRuns(speeds, fps, 1, 0.3);
  assert.equal(p.count, 2);
  assert.ok(Math.abs(p.share - 45 / speeds.length) < 1e-9);
  assert.ok(Math.abs(p.medianS - 0.5) < 1e-9);
  assert.ok(Math.abs(p.perMinute - 2 / (speeds.length / fps / 60)) < 1e-9);
  // A slow drift that dips under 1°/s for single frames is not a pause.
  const drift = Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? 0.9 : 1.2));
  assert.equal(pauseRuns(drift, fps).count, 0);
  assert.equal(pauseRuns([], fps).perMinute, 0);
});

test('yaw rate: a turn about +Y toward her left is positive, in degrees per second', () => {
  const fps = 60, up = new Vector3(0, 1, 0), tilt = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.05);
  const q = Array.from({ length: 61 }, (_, i) => new Quaternion().setFromAxisAngle(up, (i / fps) * 10 * Math.PI / 180).multiply(tilt));
  const r = yawRates(q, fps);
  assert.equal(r.length, 60);
  for (const v of r) assert.ok(Math.abs(v - 10) < 0.05, `${v}`);
  const back = yawRates([...q].reverse(), fps);
  for (const v of back) assert.ok(Math.abs(v + 10) < 0.05);
});

test('head on chest: riding along is slope 1, holding its direction is 0, turning back against it is negative', () => {
  const chest = Array.from({ length: 200 }, (_, i) => Math.sin(i / 10) * 5);
  const noise = Array.from({ length: 200 }, (_, i) => Math.cos(i * 1.7) * 0.5);
  assert.ok(Math.abs(headOnChest(chest, chest).slope - 1) < 1e-9);
  assert.ok(Math.abs(headOnChest(chest, chest).corr - 1) < 1e-9);
  const held = headOnChest(noise, chest);
  assert.ok(Math.abs(held.slope) < 0.05 && Math.abs(held.corr) < 0.1, JSON.stringify(held));
  const against = headOnChest(chest.map((c, i) => -0.3 * c + noise[i]), chest);
  assert.ok(against.slope < -0.25 && against.corr < -0.5, JSON.stringify(against));
  assert.deepEqual(headOnChest([1], [1]), { slope: 0, corr: 0 });
});

const python = [process.env.SOFT_HEARTS_ML_DIR, path.resolve(here, '../.local/ml'), path.resolve(here, '../../../../.local/ml')]
  .filter(Boolean).map(dir => path.join(dir as string, 'venv', 'Scripts', 'python.exe')).find(file => existsSync(file));

test('the StayStill converter (Python, synthetic data)', { skip: python ? false : 'no local ML interpreter (.local/ml/venv)' }, () => {
  const r = spawnSync(python!, ['-I', path.resolve(here, '../scripts/ml/test_staystill_idle.py')], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /Ran 13 tests/);
});

test('first visible motion: the first frame past the threshold, in seconds; null when it never moves that far', () => {
  const angles = [0, 0.1, 0.3, 0.6, 1.2, 0.8];
  assert.equal(firstExceed(angles, 30, 0.5), 3 / 30);
  assert.equal(firstExceed(angles, 30, 1), 4 / 30);
  assert.equal(firstExceed(angles, 30, 2), null);
});
