/**
 * Offline maintainer inspection. Run from the isolated source with its existing
 * tsx runtime. No Electron, WebGL, texture loading, settings or user assets.
 * This inventories real source clips; it does not approve a playback use.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshBasicMaterial, type AnimationClip, type KeyframeTrack, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { createVmdParser } from '../src/stage/vmd';
import { BEHAVIOR_IDLE_BONES, isBehaviorBodyTrack, type BehaviorBodyMaskId } from '../src/stage/behavior-body';
import type { VmdTrackReport } from '../src/stage/vmd-tracks';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.resolve(sourceRoot, '..', 'stand-compatibility.json');
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const binary = (value: Buffer): ArrayBuffer => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
const normalizedRelative = (value: string) => path.relative(sourceRoot, value).split(path.sep).join('/');
interface CatalogMotion { id: string; relativePath: string; sha256: string; durationFrames: number }
interface CatalogPack { id: string; source: string; revision: string; motions: CatalogMotion[] }
interface Catalog { packs: CatalogPack[] }
interface Manifest { root: string; model: { relativePath: string; sha256: string } }

// The expected mask is independently listed here so an accidental player-policy
// edit cannot silently redefine what this inspection calls the idle23 mask.
const expectedIdleBones = [
  '上半身', '上半身2', '首', '頭', '左肩', '右肩', '左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首',
  '下半身', '左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首', '左足ＩＫ', '右足ＩＫ', '左つま先ＩＫ', '右つま先ＩＫ',
] as const;
assert.equal(new Set(expectedIdleBones).size, 23);
assert.deepEqual([...BEHAVIOR_IDLE_BONES].sort(), [...expectedIdleBones].sort(), 'The player idle23 whitelist changed; review this inspection.');

const modelSha256 = '0ef63a75a7699f58399ae655357f91542fc5209355aac925a589aac42669df37';
const inputs = [
  { packId: 'gene', motionId: 'stand', sha256: '42080246b98aaa8a5b98d1ecd73994cf42b2587f9c04c3ed7435cf859fef83aa' },
  { packId: 'gene', motionId: 'convinced', sha256: '10e9afe2685408850935acbf5f54210098896a530c274ebf4f88a0e31ce0ce82' },
  { packId: '100style-idles', motionId: 'neutral-idle', sha256: '58887fab2e456bc9f5da21f275cc986a5fa8e96997b61b481e064ca3696002bb' },
  { packId: '100style-idles', motionId: 'proud-idle', sha256: '811ae39e09565bf824baf4803f8467b2881f1b42088448a49e9cb2fde7403a05' },
] as const;

function trackRecord(track: KeyframeTrack) {
  const size = track.getValueSize();
  let maxComponentChangeFromFirst = 0;
  for (let index = size; index < track.values.length; index++)
    maxComponentChangeFromFirst = Math.max(maxComponentChangeFromFirst, Math.abs(track.values[index] - track.values[index % size]));
  return {
    name: track.name,
    valueSize: size,
    keyframes: track.times.length,
    firstSeconds: track.times[0] ?? null,
    lastSeconds: track.times[track.times.length - 1] ?? null,
    maxComponentChangeFromFirst,
    changesFromFirst: maxComponentChangeFromFirst > 1e-8,
    interpolationFactory: track.createInterpolant.name,
  };
}

async function main() {
  const catalogBytes = await readFile(path.join(sourceRoot, 'shared/motion-catalog.json'));
  const catalog = JSON.parse(catalogBytes.toString('utf8')) as Catalog;
  const manifestBytes = await readFile(path.join(sourceRoot, 'shared/bundled-assets.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Manifest;
  const modelPath = path.join(sourceRoot, 'assets/bundled', manifest.root, manifest.model.relativePath);
  const modelBytes = await readFile(modelPath);
  assert.equal(hash(modelBytes), modelSha256, 'Only the public pinned Gene is inspected.');
  if (manifest.model.sha256) assert.equal(manifest.model.sha256, modelSha256);
  const parserModule = 'three/examples/jsm/libs/mmdparser.module.js';
  const { MMDParser } = await import(parserModule);
  const data = new MMDParser.Parser().parsePmx(binary(modelBytes), true);
  const loader = new MMDLoader() as any;
  // Real geometry, skeleton and morph builder; materials are inert CPU fixtures.
  loader.meshBuilder.materialBuilder.build = () => data.materials.map((value: { name: string }) => {
    const material = new MeshBasicMaterial(); material.name = value.name; return material;
  });
  const mesh = loader.meshBuilder.build(data, '') as SkinnedMesh;
  try {
    const clips: { packId: string; motionId: string; sha256: string; relativePath: string; revision: string;
      durationFrames: number; sourceDurationMs: number; builtDurationMs: number; cleanup: VmdTrackReport;
      clip: AnimationClip; tracks: ReturnType<typeof trackRecord>[] }[] = [];
    for (const input of inputs) {
      const pack = catalog.packs.find(value => value.id === input.packId);
      assert.ok(pack, `Missing pack ${input.packId}`);
      const entry = pack.motions.find(value => value.id === input.motionId);
      assert.ok(entry, `Missing motion ${input.motionId}`);
      assert.equal(entry.sha256, input.sha256, 'The independently pinned resource identity must match the catalog.');
      const assetPath = path.join(sourceRoot, 'assets/bundled', pack.source, pack.id, pack.revision, entry.relativePath);
      const bytes = await readFile(assetPath);
      assert.equal(hash(bytes), input.sha256);
      let cleanup: VmdTrackReport | null = null;
      const parser = createVmdParser(value => { cleanup = value; }) as { parseVmd(buffer: ArrayBuffer, convert: boolean): unknown };
      const vmd = parser.parseVmd(binary(bytes), true);
      assert.ok(cleanup, 'The original parser must report source timing and whole-default-track cleanup.');
      const report = cleanup as VmdTrackReport;
      assert.equal(report.durationFrames, entry.durationFrames, 'Original source endpoint is preserved.');
      const clip = loader.animationBuilder.build(vmd, mesh) as AnimationClip;
      clip.duration = Math.max(clip.duration, report.durationFrames / 30);
      assert.equal(new Set(clip.tracks.map(track => track.name)).size, clip.tracks.length, 'Duplicate built track identity needs review.');
      clips.push({ ...input, relativePath: normalizedRelative(assetPath), revision: pack.revision,
        durationFrames: report.durationFrames, sourceDurationMs: report.durationFrames / 30 * 1_000,
        builtDurationMs: clip.duration * 1_000, cleanup: report, clip, tracks: clip.tracks.map(trackRecord) });
    }
    const stand = clips.find(value => value.packId === 'gene' && value.motionId === 'stand')!;
    const standNames = stand.tracks.map(value => value.name);
    const maskNames = (maskId: BehaviorBodyMaskId) => maskId === 'candidate-head-v1'
      ? ['.bones[首].quaternion', '.bones[頭].quaternion']
      : expectedIdleBones.flatMap(bone => [`.bones[${bone}].position`, `.bones[${bone}].quaternion`]);
    const masks = (['candidate-head-v1', 'candidate-pose-v1'] as const).map(maskId => {
      const names = maskNames(maskId);
      assert.ok(names.every(name => isBehaviorBodyTrack(name, maskId)));
      const overlaps = standNames.filter(name => names.includes(name));
      const nonOverlaps = standNames.filter(name => !names.includes(name));
      return { maskId, exactAllowedProperties: names, standOverlapProperties: overlaps,
        standNonOverlapProperties: nonOverlaps, partialStandOverlap: overlaps.length > 0 && nonOverlaps.length > 0 };
    });
    const comparisons = clips.filter(value => value !== stand).map(value => {
      const maskId: BehaviorBodyMaskId = value.motionId === 'convinced' ? 'candidate-head-v1' : 'candidate-pose-v1';
      const admittedNames = value.tracks.map(track => track.name).filter(name => isBehaviorBodyTrack(name, maskId));
      const overlaps = standNames.filter(name => admittedNames.includes(name));
      const nonOverlaps = standNames.filter(name => !admittedNames.includes(name));
      const partial = overlaps.length > 0 && nonOverlaps.length > 0;
      return { packId: value.packId, motionId: value.motionId, maskId,
        admittedSourceProperties: admittedNames,
        excludedSourceProperties: value.tracks.map(track => track.name).filter(name => !admittedNames.includes(name)),
        standOverlapProperties: overlaps, standNonOverlapProperties: nonOverlaps,
        partialStandOverlap: partial,
        strictWholeActionAttenuation: partial ? 'reject-partial-base-overlap' : overlaps.length ? 'all-base-properties-overlap' : 'no-base-overlap',
        explanation: partial
          ? 'Attenuating the complete original Stand Action would also change its non-overlapping properties. A property projection must preserve their original weight, clock and interpolation before this case can be admitted.'
          : overlaps.length
            ? 'All Stand properties overlap this admitted source set; this fact alone does not approve mixing or visible quality.'
            : 'The admitted source set does not overlap Stand tracks; this fact alone does not approve mixing or visible quality.',
      };
    });
    const helperFiles = ['src/stage/vmd.ts', 'src/stage/vmd-tracks.ts', 'src/stage/behavior-body.ts', 'scripts/behavior-stand-compatibility.ts'];
    const helperHashes = Object.fromEntries(await Promise.all(helperFiles.map(async relative =>
      [relative, hash(await readFile(path.join(sourceRoot, relative)))] as const)));
    const report = {
      schemaVersion: 1,
      inspection: 'offline-public-gene-stand-property-overlap',
      inspectedAt: new Date().toISOString(),
      method: 'Original Three MMDLoader PMX/AnimationBuilder with inert CPU materials and createVmdParser whole-default-track cleanup; no Action playback.',
      model: { sha256: modelSha256, relativePath: normalizedRelative(modelPath), bones: mesh.skeleton.bones.length },
      inputHashes: { catalog: hash(catalogBytes), bundledManifest: hash(manifestBytes), ...helperHashes },
      stand: { totalBuiltTracks: standNames.length, positionTracks: standNames.filter(name => name.endsWith('.position')).length,
        quaternionTracks: standNames.filter(name => name.endsWith('.quaternion')).length,
        morphTracks: standNames.filter(name => name.startsWith('.morphTargetInfluences')).length, exactTrackNames: standNames },
      masks,
      clips: clips.map(({ clip: _clip, ...record }) => ({ ...record, totalBuiltTracks: record.tracks.length })),
      comparisons,
      limitations: [
        'Track overlap inventory only; no WebGL/Electron, native input, original Action/IK/grant playback or visual acceptance was performed.',
        'No candidate body/idle use, loop, model compatibility, material quality or daily deployment is approved by this report.',
        'Position and quaternion are distinct properties. The idle whitelist contains23 bones and up to46 properties; the head mask contains only2 quaternion properties.',
        'All original asset bytes remain unchanged. Default-track cleanup and source timing reports are included explicitly.',
      ],
    };
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ output: '../stand-compatibility.json', standTracks: standNames.length,
      comparisons: comparisons.map(value => ({ motionId: value.motionId, overlap: value.standOverlapProperties.length,
        nonOverlap: value.standNonOverlapProperties.length, partial: value.partialStandOverlap })) })}\n`);
  } finally {
    mesh.geometry.dispose(); mesh.skeleton.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
  }
}

await main();
