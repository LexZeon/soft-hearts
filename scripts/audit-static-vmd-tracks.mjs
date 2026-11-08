/** Read-only audit: node --import tsx scripts/audit-static-vmd-tracks.mjs */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MMDParser } from 'three/examples/jsm/libs/mmdparser.module.js';
import { stripDefaultVmdTracks } from '../src/stage/vmd-tracks.ts';
import { readableVmdHeader } from '../src/stage/vmd.ts';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await readFile(path.join(workspace, 'shared/motion-catalog.json'), 'utf8'));
const parser = new MMDParser.Parser();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const motions = [];
for (const pack of catalog.packs) for (const entry of pack.motions) {
  const relative = `${pack.source}/${pack.id}/${pack.revision}/${entry.relativePath}`;
  const file = path.join(workspace, 'assets/bundled', ...relative.split('/'));
  const bytes = await readFile(file);
  const beforeHash = hash(bytes);
  assert.equal(beforeHash, entry.sha256, `${pack.id}/${entry.id}: reviewed source hash`);
  const raw = parser.parseVmd(readableVmdHeader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), true);
  const serialized = JSON.stringify(raw);
  const { vmd, report } = stripDefaultVmdTracks(raw);
  assert.equal(JSON.stringify(raw), serialized, 'parsed input remains unchanged');
  assert.equal(hash(await readFile(file)), beforeHash, 'source file remains unchanged');
  assert.equal(vmd.metadata.motionCount, vmd.motions.length);
  assert.equal(vmd.metadata.morphCount, vmd.morphs.length);
  motions.push({ packId: pack.id, motionId: entry.id, relativePath: relative, sha256: beforeHash, ...report });
}
const summary = {
  motions: motions.length,
  removedBoneTracks: motions.reduce((sum, motion) => sum + motion.removedBoneNames.length, 0),
  removedMorphTracks: motions.reduce((sum, motion) => sum + motion.removedMorphNames.length, 0),
  boneKeyframesBefore: motions.reduce((sum, motion) => sum + motion.before.boneKeyframes, 0),
  boneKeyframesAfter: motions.reduce((sum, motion) => sum + motion.after.boneKeyframes, 0),
  morphKeyframesBefore: motions.reduce((sum, motion) => sum + motion.before.morphKeyframes, 0),
  morphKeyframesAfter: motions.reduce((sum, motion) => sum + motion.after.morphKeyframes, 0),
  keptStaticPoseTracks: motions.reduce((sum, motion) => sum + motion.keptStaticPoseNames.length, 0),
  keptStaticNonzeroMorphTracks: motions.reduce((sum, motion) => sum + motion.keptStaticMorphNames.length, 0),
  emptyAfterFiltering: motions.filter(motion => motion.after.boneKeyframes === 0 && motion.after.morphKeyframes === 0).map(motion => `${motion.packId}/${motion.motionId}`),
  originalFilesUnchanged: true,
};
const directory = path.join(workspace, '.local/static-track-audit');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'report.json'), JSON.stringify({ schemaVersion: 1,
  policy: 'Remove only whole default-position/identity-rotation bone tracks and all-zero morph tracks. Preserve non-default static initial poses, nonzero expressions, dynamic and invalid tracks. Original bone/morph duration is reported separately; source files and hashes stay unchanged.',
  ...summary, motions,
}, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
