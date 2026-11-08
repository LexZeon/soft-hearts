import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeTestMotion } from '../scripts/create-test-motion.mjs';

interface ParsedVmd {
  metadata: { magic: string; name: string; motionCount: number; morphCount: number; cameraCount: number; };
  motions: { boneName: string; frameNum: number; position: number[]; rotation: number[]; interpolation: number[]; }[];
}

test('original VMD fixture parses with the actual MMD parser and needs no private model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desk-mate-vmd-'));
  try {
    const target = join(directory, 'original-breath.vmd');
    await writeTestMotion(target);
    const bytes = await readFile(target);
    // three does not publish typings for this bundled parser module.
    const parserModule = 'three/examples/jsm/libs/mmdparser.module.js';
    const { MMDParser } = await import(parserModule);
    const parsed = new MMDParser.Parser().parseVmd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true) as ParsedVmd;
    assert.equal(parsed.metadata.magic, 'Vocaloid Motion Data 0002');
    assert.equal(parsed.metadata.name, 'DeskMate original');
    assert.equal(parsed.metadata.motionCount, 3);
    assert.equal(parsed.metadata.morphCount, 0);
    assert.equal(parsed.metadata.cameraCount, 0);
    assert.deepEqual(parsed.motions.map(frame => frame.boneName), ['センター', 'センター', 'センター']);
    assert.deepEqual(parsed.motions.map(frame => frame.frameNum), [0, 30, 60]);
    assert.equal(parsed.motions[0].position[1], 0);
    assert.ok(Math.abs(parsed.motions[1].position[1] - 0.08) < 1e-7);
    assert.equal(parsed.motions[2].position[1], 0);
    for (const frame of parsed.motions) {
      assert.deepEqual(frame.rotation.map(value => value || 0), [0, 0, 0, 1]);
      assert.equal(frame.interpolation.length, 64);
      assert.ok(frame.interpolation.every(value => value >= 0 && value <= 127));
    }
  } finally {
    await rm(join(directory, 'original-breath.vmd'), { force: true });
    await rmdir(directory);
  }
});
