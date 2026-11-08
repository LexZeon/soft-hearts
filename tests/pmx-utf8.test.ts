/**
 * UTF-8 PMX text (docs/claude/2026-11-02-pmx-utf8.md).
 * three's MMDParser decodes every PMX text field as UTF-16LE whatever the
 * header says, so a UTF-8 PMX loads with garbled bone/morph/material names and
 * the model profile cannot map it. shared/pmx-text-encoding.ts rewrites the
 * text fields (and the encoding byte) of an in-memory copy; the mmd-asset
 * protocol (electron/asset-protocol.ts) and the model lab use it. Files on disk
 * are never changed.
 * - Conversion: synthetic models written as UTF-8 become, byte for byte, the
 *   same model written as UTF-16LE (every PMX 2.0/2.1 section, every index
 *   size, additional UVs, all deform types, every morph type, soft bodies);
 *   MMDParser then reads the right names and the same numbers.
 * - Text edge cases, damaged files (returned untouched, never thrown), files
 *   that are not UTF-8 PMX (the same object back), Gene (identity, pinned hash).
 * - The protocol handler: unchanged behaviour for everything but UTF-8 PMX,
 *   converted bytes with a matching Content-Length for UTF-8 PMX.
 * - The model profile maps a UTF-8 model like its UTF-16 twin; the lab agrees.
 * - Timing on a ~100k-vertex model.
 * PMX 2.1 (same doc, "PMX 2.1"): MMDParser refuses every 2.1 file (its version
 * check compares a Float32 with 2.1) and cannot read QDEF or flip/impulse
 * morphs, so `preparePmxForMmdParser` also serves a 2.1 file as 2.0:
 * - QDEF → BDEF4, flip → group, impulse → empty group, soft bodies left unread
 *   after the joints; the result is byte for byte the 2.0 twin plus that tail,
 *   and MMDParser/MMDLoader read it exactly like the twin; UTF-8 + 2.1 in one go;
 *   a 2.1 file with no 2.1 structure only changes its version.
 * - Damaged 2.1 files come back untouched; non-2.1 files behave as before.
 * - The protocol reads 2.1 files whole (Content-Length, a note header); the
 *   profile and the lab treat a 2.1 humanoid exactly like its 2.0 twin.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Three.js r170 does not publish declarations for its bundled MMD parser.
// @ts-expect-error Bundled parser has no TypeScript declaration.
import { MMDParser } from 'three/examples/jsm/libs/mmdparser.module.js';
import { Texture, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import bundled from '../shared/bundled-assets.json';
import { CORE_BONES, MORPH_SLOTS } from '../shared/model-profile';
import {
  PMX_HEADER_SNIFF_BYTES, describePmxPreparation, preparePmxForMmdParser, readPmxHeader, transcodePmxUtf8ToUtf16, type PmxDowngrade,
} from '../shared/pmx-text-encoding';
import { createAssetProtocolHandler, type AssetProtocolPorts } from '../electron/asset-protocol';
import { AssetRegistry } from '../electron/assets';
import { BlushCalibrationStore } from '../electron/blush-calibration';
import { StageModelProfile } from '../src/stage/model-profile';
import { analyzeModel, type ModelReport } from '../scripts/model-lab/analyze';
import { loadBundledMotions } from '../scripts/model-lab/cli';
import { REPO_ROOT } from '../scripts/model-lab/guard';
import { labMesh, parsePmx, type PmxData } from '../scripts/model-lab/pmx-mesh';
import { renderModelMarkdown } from '../scripts/model-lab/report';
import { toyModel } from './helpers/model-fixtures';
import { pmxFromModelData, writePmx, type PmxSkin, type PmxWriteBone, type PmxWriteModel, type PmxWriteMorph } from './helpers/pmx-write';

const GENE_PATH = path.join(REPO_ROOT, 'assets/bundled', bundled.root, bundled.model.relativePath);
type RawParse = (buffer: ArrayBuffer, leftToRight: boolean) => PmxData & Record<string, unknown>;
const mmdParse: RawParse = (buffer, leftToRight) => new (MMDParser as { Parser: new () => { parsePmx: RawParse } }).Parser().parsePmx(buffer, leftToRight);
const arrayBuffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const utf8Length = (value: string) => new TextEncoder().encode(value).length;
const withEncoding = (model: PmxWriteModel, encoding: 0 | 1) => writePmx({ ...model, encoding });

// ---------------------------------------------------------------- fixtures

const BONES: PmxWriteBone[] = [
  { name: '全ての親', englishName: 'master', parent: -1, position: [0, 0, 0], connect: 1 },
  { name: 'センター', englishName: 'center', parent: 0, position: [0, 8, 0] },
  { name: '上半身', englishName: 'upper body', parent: 1, position: [0, 11, 0], connect: 3 },
  { name: '首', parent: 2, position: [0, 15, 0], localAxes: { x: [1, 0, 0], z: [0, 0, 1] } },
  { name: '頭', parent: 3, position: [0, 16.5, 0] },
  { name: '右腕', englishName: 'arm_R', parent: 2, position: [-1.4, 15, 0] },
  { name: '右ひじ', parent: 5, position: [-3.6, 13.6, 0] },
  { name: '右腕捩', parent: 5, position: [-2.5, 14.3, 0], fixAxis: [-0.8, -0.6, 0] },
  { name: '右手首', parent: 6, position: [-6, 12, 0] },
  { name: '右手捩', parent: 6, position: [-4.8, 12.8, 0], grant: { parent: 6, ratio: 0.5 } },
  { name: '左目', parent: 4, position: [0.4, 17.9, -0.5], grant: { parent: 4, ratio: 0.3, position: true, local: true }, externalKey: 7 },
  { name: '左足', parent: 1, position: [0.9, 10.5, 0] },
  { name: '左ひざ', parent: 11, position: [0.9, 5.8, 0] },
  { name: '左足首', parent: 12, position: [0.9, 1.3, 0] },
  { name: '左足ＩＫ', englishName: 'leg IK_L', parent: 0, position: [0.9, 1.3, 0],
    ik: { effector: 13, links: [{ index: 12, limits: [[-3.14159, 0, 0], [-0.008, 0, 0]] }, 11] } },
  { name: '😀絵文字', englishName: 'emoji', parent: 0, position: [0, 20, 0] },
  { name: '', englishName: 'empty name', parent: 0, position: [0, 21, 0] },
  { name: 'aaあ', englishName: 'odd utf-8 length', parent: 0, position: [0, 22, 0] },
];

/** Every PMX 2.0 section MMDParser reads (so it parses), with Japanese text everywhere. */
function richModel(options: Partial<PmxWriteModel> = {}): PmxWriteModel {
  const vertices = 12, positions: number[] = [], skin: PmxSkin[] = [];
  for (let vertex = 0; vertex < vertices; vertex++) {
    positions.push(vertex * 0.1, 16 + vertex * 0.2, 0.3 * (vertex % 3));
    const kind = vertex % 4;
    if (kind === 0) skin.push({ deform: 0, bones: [4], weights: [1] });
    else if (kind === 1) skin.push({ deform: 1, bones: [3, 4], weights: [0.25] });
    else if (kind === 2) skin.push({ deform: 2, bones: [2, 3, 4, -1], weights: [0.5, 0.3, 0.2, 0] });
    else skin.push({ deform: 3, bones: [5, 6], weights: [0.7], sdef: [-2.5, 14, 0.1, -1.4, 15, 0, -3.6, 13.6, 0] });
  }
  const morphs: PmxWriteMorph[] = [
    { name: 'あ', englishName: 'a', type: 1, indices: [0, 1], deltas: [0, -0.1, 0, 0, -0.2, 0] },
    { name: 'まばたき', englishName: 'blink', type: 1, indices: [4, 5, 6], deltas: [0, -0.3, 0, 0, -0.3, 0, 0, -0.3, 0], panel: 2 },
    { name: '笑い', type: 0, group: [[0, 0.5], [1, 1]], panel: 2 },
    { name: 'ボーン動き', type: 2, bones: [{ index: 4, translation: [0, 0.1, 0], rotation: [0, 0, 0.0872, 0.9962] }], panel: 4 },
    { name: 'ＵＶスクロール', type: 3, uvs: [{ index: 2, value: [0.1, 0.2, 0, 0] }], panel: 4 },
    { name: '材質：顔', type: 8, materials: [{ index: 0, operation: 1 }, { index: -1, operation: 0 }], panel: 4 },
    { name: '🎉', englishName: 'party', type: 1, indices: [11], deltas: [0.01, 0, 0] },
  ];
  return {
    name: '合成モデル', englishName: 'synthetic model', comment: '日本語のコメント\r\n二行目', englishComment: 'comment', positions, skin,
    faces: [0, 1, 2, 2, 3, 4, 4, 5, 6, 6, 7, 8, 8, 9, 10, 9, 10, 11],
    textures: ['tex\\顔.png', 'toon\\トゥーン01.bmp', 'sph/髪.spa', 'body.png'],
    materials: [
      { name: '顔', englishName: 'face', texture: 0, toon: { texture: 1 }, memo: 'メモ：顔', surfaces: 9 },
      { name: '髪', texture: 3, sphere: 2, toon: { shared: 3 }, surfaces: 9 },
    ],
    bones: BONES, morphs,
    frames: [
      { name: 'Root', special: true, elements: [{ morph: false, index: 0 }] },
      { name: '表情', englishName: 'Exp', special: true, elements: [{ morph: true, index: 0 }, { morph: true, index: 1 }, { morph: true, index: 6 }] },
      { name: '体（上）', elements: [{ morph: false, index: 1 }, { morph: false, index: 2 }, { morph: false, index: 14 }] },
    ],
    rigidBodies: [{ boneIndex: 4, type: 0, name: '頭' }, { boneIndex: 3, type: 1, name: '首' }, { boneIndex: 15, type: 2, name: '髪_1', englishName: 'hair 1' }],
    joints: [{ a: 0, b: 1, name: '首-頭' }, { a: 1, b: 2, name: 'ジョイント' }],
    ...options,
  };
}

/** PMX 2.1 extras MMDParser cannot read: QDEF, additional-UV, flip and impulse morphs, soft bodies. */
function rich21Model(options: Partial<PmxWriteModel> = {}): PmxWriteModel {
  const base = richModel({ additionalUv: 4 });
  return {
    ...base, version: 2.1,
    skin: base.skin.map((skin, vertex) => vertex === 7 ? { deform: 4, bones: [1, 2, 3, 4], weights: [0.25, 0.25, 0.25, 0.25] } : skin),
    morphs: [...base.morphs,
      { name: '追加UV1', type: 4, uvs: [{ index: 3, value: [1, 2, 3, 4] }] }, { name: '追加UV2', type: 5, uvs: [{ index: 4, value: [0, 0, 1, 1] }] },
      { name: '追加UV3', type: 6, uvs: [] }, { name: '追加UV4', type: 7, uvs: [{ index: 11, value: [0.5, 0.5, 0.5, 0.5] }] },
      { name: 'フリップ', type: 9, flips: [[0, 1], [1, 0.5]] },
      { name: 'インパルス', type: 10, impulses: [{ body: 2, local: true, velocity: [0, 1, 0], torque: [0.1, 0, 0] }] }],
    softBodies: [
      { name: 'スカート', englishName: 'skirt', material: 1, anchors: [{ body: 0, vertex: 3, near: true }, { body: 1, vertex: 5 }], pins: [1, 2, 3] },
      { name: '', material: 0, anchors: [], pins: [] },
    ],
    ...options,
  };
}

const INDEX_SIZES: PmxWriteModel['indexSizes'][] = [
  { vertex: 1, texture: 1, material: 1, bone: 1, morph: 1, rigidBody: 1 },
  { vertex: 2, texture: 1, material: 1, bone: 2, morph: 1, rigidBody: 1 },
  { vertex: 4, texture: 4, material: 4, bone: 4, morph: 4, rigidBody: 4 },
  { vertex: 2, texture: 2, material: 2, bone: 2, morph: 2, rigidBody: 2 },
];

function textFieldCount(model: PmxWriteModel): number {
  return 4 + (model.textures?.length ?? 0) + 3 * (model.materials?.length ?? 0)
    + 2 * (model.bones.length + model.morphs.length + (model.frames?.length ?? 0) + (model.rigidBodies?.length ?? 0) + (model.joints?.length ?? 0))
    + (model.version === 2.1 ? 2 * (model.softBodies?.length ?? 0) : 0);
}

function assertConvertsToTwin(model: PmxWriteModel, label: string) {
  const utf8 = withEncoding(model, 1), utf16 = withEncoding(model, 0), before = Uint8Array.from(utf8);
  assert.equal(readPmxHeader(utf8)?.encoding, 1, label);
  const result = transcodePmxUtf8ToUtf16(utf8);
  assert.ok(result.changed, `${label}: ${result.changed ? '' : `${result.reason} ${result.detail ?? ''}`}`);
  assert.equal(Buffer.compare(result.bytes, utf16), 0, `${label}: converted bytes equal the UTF-16LE twin`);
  assert.equal(result.textFields, textFieldCount(model), `${label}: text fields`);
  assert.equal(result.replacedTextFields, 0); assert.equal(result.trailingBytes, 0);
  assert.equal(readPmxHeader(result.bytes)?.encoding, 0);
  assert.deepEqual(utf8, before, `${label}: the input is not modified`);
  return { utf8, utf16, converted: result.bytes };
}

// ---------------------------------------------------------------- conversion

test('a UTF-8 PMX 2.0 becomes, byte for byte, the same model written as UTF-16LE (every index size, 0/2/4 additional UVs)', () => {
  for (const indexSizes of INDEX_SIZES) for (const additionalUv of [0, 2, 4])
    assertConvertsToTwin(richModel({ indexSizes, additionalUv }), `sizes ${JSON.stringify(indexSizes)} auv ${additionalUv}`);
});

test('MMDParser reads the converted names and every numeric field exactly as from the UTF-16 file (and garbles the raw UTF-8)', () => {
  const model = richModel({ additionalUv: 2 });
  const { utf8, utf16, converted } = assertConvertsToTwin(model, 'rich');
  const fromConverted = mmdParse(arrayBuffer(converted), true), fromTwin = mmdParse(arrayBuffer(utf16), true);
  assert.deepStrictEqual(fromConverted, fromTwin);
  const parsed = fromConverted as unknown as {
    metadata: { modelName: string; englishModelName: string; comment: string; encoding: number };
    bones: { name: string; englishName: string; grant?: { isLocal: boolean; affectPosition: boolean }; ik?: { links: { angleLimitation: number }[] }; key?: number }[];
    morphs: { name: string; type: number }[]; textures: string[]; materials: { name: string; comment: string; toonFlag: number }[];
    frames: { name: string }[]; rigidBodies: { name: string }[]; constraints: { name: string }[]; vertices: { auvs: number[][]; skinC?: number[] }[];
  };
  assert.equal(parsed.metadata.modelName, '合成モデル'); assert.equal(parsed.metadata.comment, '日本語のコメント\r\n二行目'); assert.equal(parsed.metadata.encoding, 0);
  assert.deepEqual(parsed.bones.map(bone => bone.name), BONES.map(bone => bone.name));
  assert.deepEqual(parsed.bones.map(bone => bone.englishName), BONES.map(bone => bone.englishName ?? bone.name));
  assert.ok(['センター', '上半身', '右腕', '左足ＩＫ'].every(name => parsed.bones.some(bone => bone.name === name)));
  assert.deepEqual(parsed.morphs.map(morph => morph.name), ['あ', 'まばたき', '笑い', 'ボーン動き', 'ＵＶスクロール', '材質：顔', '🎉']);
  assert.deepEqual(parsed.morphs.map(morph => morph.type), [1, 1, 0, 2, 3, 8, 1]);
  assert.deepEqual(parsed.textures, model.textures);
  assert.deepEqual(parsed.materials.map(material => [material.name, material.comment, material.toonFlag]), [['顔', 'メモ：顔', 0], ['髪', '', 1]]);
  assert.deepEqual(parsed.frames.map(frame => frame.name), ['Root', '表情', '体（上）']);
  assert.deepEqual(parsed.rigidBodies.map(body => body.name), ['頭', '首', '髪_1']);
  assert.deepEqual(parsed.constraints.map(joint => joint.name), ['首-頭', 'ジョイント']);
  assert.equal(parsed.bones[10].grant?.isLocal, true); assert.equal(parsed.bones[10].grant?.affectPosition, true); assert.equal(parsed.bones[10].key, 7);
  assert.equal(parsed.bones[14].ik?.links[0].angleLimitation, 1);
  assert.equal(parsed.vertices[5].auvs.length, 2); assert.ok(parsed.vertices[3].skinC);

  // Today's behaviour without the conversion. A text with an odd UTF-8 byte length ('あ' is 3 bytes) makes MMDParser's
  // two-byte reader overrun it by one byte, so the rest of the file is misread and the load fails outright.
  assert.throws(() => mmdParse(arrayBuffer(utf8), true));
  // When every text happens to have an even byte length the structure parses, but no name survives.
  const even: PmxWriteModel = { name: 'モデル名', englishName: 'model1', comment: 'comment1', englishComment: 'comment2', positions: [], skin: [],
    bones: [{ name: 'センター', englishName: 'center', parent: -1, position: [0, 8, 0] }, { name: '右腕', englishName: 'arm_R1', parent: 0, position: [-1, 15, 0] }],
    morphs: [{ name: 'まばたき', englishName: 'blink1', type: 0, group: [] }] };
  const evenUtf8 = withEncoding(even, 1);
  const raw = mmdParse(arrayBuffer(evenUtf8), true) as unknown as typeof parsed;
  assert.equal(raw.metadata.encoding, 1);
  assert.notEqual(raw.metadata.modelName, 'モデル名'); assert.notEqual(raw.bones[0].name, 'センター'); assert.notEqual(raw.morphs[0].name, 'まばたき');
  const fixed = mmdParse(arrayBuffer(assertConvertsToTwin(even, 'even').converted), true) as unknown as typeof parsed;
  assert.deepEqual([fixed.metadata.modelName, fixed.bones[0].name, fixed.bones[1].name, fixed.morphs[0].name], ['モデル名', 'センター', '右腕', 'まばたき']);
});

test('PMX 2.1: QDEF, additional-UV, flip and impulse morphs and soft bodies convert to the UTF-16 twin; the text-only conversion keeps 2.1', () => {
  for (const indexSizes of INDEX_SIZES) {
    const model = rich21Model({ indexSizes });
    const { utf16, converted } = assertConvertsToTwin(model, `2.1 ${JSON.stringify(indexSizes)}`);
    // three's version check compares the Float32 2.1 with the double 2.1, so the text-only result is still refused;
    // preparePmxForMmdParser (the "PMX 2.1" tests below) also downgrades it, which is what the app and the lab use.
    assert.throws(() => mmdParse(arrayBuffer(utf16), true), (error: unknown) => /PMX version 2\.09999/.test(String(error)));
    assert.throws(() => mmdParse(arrayBuffer(converted), true), (error: unknown) => /PMX version 2\.09999/.test(String(error)));
  }
  // A 2.1 file that ends right after its joints (no soft body section) still converts.
  const model = rich21Model({ softBodies: [] });
  const utf8 = withEncoding(model, 1).slice(0, -4), utf16 = withEncoding(model, 0).slice(0, -4);
  const result = transcodePmxUtf8ToUtf16(utf8);
  assert.ok(result.changed); assert.equal(Buffer.compare(result.bytes, utf16), 0);
  // PMX 2.0 may carry additional-UV morphs too; MMDParser loses its place on them, but the conversion walks them like the spec.
  const auvMorph = richModel({ additionalUv: 1, morphs: [...richModel().morphs, { name: '追加UV1', type: 4, uvs: [{ index: 0, value: [1, 1, 1, 1] }] }] });
  assertConvertsToTwin(auvMorph, '2.0 additional-UV morph');
});

test('text edge cases: odd UTF-8 lengths, empty strings, emoji (surrogate pairs), ZWJ sequences, a leading BOM, NUL and line breaks', () => {
  const names = ['', 'a', 'あ', 'aaあ', 'é', '😀', '👩‍👩‍👧', '\uFEFFbom', 'x\u0000y', '改行\r\nあり', 'ｾﾝﾀｰ', '中文骨骼名', '𠮷野家'];
  assert.ok(names.some(name => utf8Length(name) % 2 === 1) && names.some(name => utf8Length(name) === 0));
  const base = richModel();
  const model: PmxWriteModel = {
    ...base, name: '😀', englishName: '', comment: '', englishComment: '\uFEFF',
    bones: [...base.bones, ...names.map((name, k) => ({ name, englishName: names[names.length - 1 - k], parent: 0, position: [k, 0, 0] }))],
    morphs: [...base.morphs, ...names.map(name => ({ name, type: 0 as const, group: [] as [number, number][] }))],
  };
  const { converted } = assertConvertsToTwin(model, 'edge text');
  const parsed = mmdParse(arrayBuffer(converted), true) as unknown as { metadata: { modelName: string; englishModelName: string; englishComment: string }; bones: { name: string }[]; morphs: { name: string }[] };
  assert.equal(parsed.metadata.modelName, '😀'); assert.equal(parsed.metadata.englishModelName, ''); assert.equal(parsed.metadata.englishComment, '\uFEFF');
  // MMDParser stops a name at a NUL code unit, as it does in a UTF-16 file.
  const expected = names.map(name => name.split('\u0000')[0]);
  assert.deepEqual(parsed.bones.slice(base.bones.length).map(bone => bone.name), expected);
  assert.deepEqual(parsed.morphs.slice(base.morphs.length).map(morph => morph.name), expected);
});

/** Offset of the first occurrence of `needle`, or -1. */
function find(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let at = from; at <= haystack.length - needle.length; at++) {
    for (let k = 0; k < needle.length; k++) if (haystack[at + k] !== needle[k]) continue outer;
    return at;
  }
  return -1;
}
const ascii = (value: string) => new TextEncoder().encode(value);

test('invalid UTF-8 inside a name becomes U+FFFD in that name only (a leading BOM kept); everything else converts', () => {
  const base = richModel();
  const model = { ...base, bones: [...base.bones, { name: 'BROKENNAME', parent: 0, position: [0, 0, 0] }, { name: '\uFEFFSECONDBAD', parent: 0, position: [0, 0, 0] }] };
  const utf8 = withEncoding(model, 1), at = find(utf8, ascii('BROKENNAME')), second = find(utf8, ascii('SECONDBAD'));
  assert.ok(at > 0 && second > 0);
  utf8[at] = 0xff; utf8[at + 1] = 0xe3; // a byte that never occurs in UTF-8, then a lead byte without its continuation
  utf8[second] = 0xc0; // an overlong lead byte
  const result = transcodePmxUtf8ToUtf16(utf8);
  assert.ok(result.changed); assert.equal(result.replacedTextFields, 2);
  const parsed = mmdParse(arrayBuffer(result.bytes), true) as unknown as { bones: { name: string }[] };
  assert.equal(parsed.bones.at(-2)!.name, '\uFFFD\uFFFDOKENNAME');
  assert.equal(parsed.bones.at(-1)!.name, '\uFEFF\uFFFDECONDBAD');
  assert.deepEqual(parsed.bones.slice(0, -2).map(bone => bone.name), BONES.map(bone => bone.name));
});

// ---------------------------------------------------------------- damaged and other files

function assertUntouched(input: Uint8Array, reason: string, label: string) {
  const copy = Uint8Array.from(input);
  let result: ReturnType<typeof transcodePmxUtf8ToUtf16> | undefined;
  assert.doesNotThrow(() => { result = transcodePmxUtf8ToUtf16(input); }, label);
  assert.equal(result!.changed, false, label);
  assert.equal(result!.bytes, input, `${label}: the same bytes object comes back`);
  if (!result!.changed) assert.equal(result!.reason, reason, `${label}: ${result!.reason} ${result!.detail ?? ''}`);
  assert.equal(Buffer.compare(input, copy), 0, `${label}: input not modified`);
}

/** Offset just past the four header texts (the vertex count). */
function headerEnd(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 9 + bytes[8];
  for (let k = 0; k < 4; k++) at += 4 + view.getInt32(at, true);
  return at;
}
const setI32 = (bytes: Uint8Array, at: number, value: number) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt32(at, value, true);

test('truncated UTF-8 PMX files come back untouched at every cut, without throwing', () => {
  for (const model of [richModel({ additionalUv: 1 }), richModel({ indexSizes: INDEX_SIZES[0] })]) {
    const full = withEncoding(model, 1);
    for (let cut = 10; cut < full.length; cut++) assertUntouched(full.slice(0, cut), 'malformed', `cut at ${cut} of ${full.length}`);
  }
});

test('damaged UTF-8 PMX structures come back untouched: bad deform/morph/toon/frame/IK values, bad counts, lengths and index sizes', () => {
  const base = richModel({ indexSizes: INDEX_SIZES[1] });
  const cases: [string, Uint8Array][] = [];
  const patched = (label: string, model: PmxWriteModel, patch: (bytes: Uint8Array) => void) => { const bytes = withEncoding(model, 1); patch(bytes); cases.push([label, bytes]); };
  cases.push(['deform type 9', withEncoding({ ...base, skin: base.skin.map((skin, vertex) => vertex === 3 ? { ...skin, deform: 9 as never } : skin) }, 1)]);
  cases.push(['morph type 11', withEncoding({ ...base, morphs: [...base.morphs, { name: 'x', type: 11 as never, uvs: [{ index: 0, value: [0, 0, 0, 0] }] }] }, 1)]);
  patched('toon flag 5', { ...base, materials: [{ name: 'm', toon: { shared: 2 }, memo: 'TOONMARK', surfaces: 0 }] }, bytes => {
    const memo = find(bytes, ascii('TOONMARK')); bytes[memo - 4 - 2] = 5;
  });
  patched('display frame element target 2', { ...base, frames: [{ name: 'FRAMEMARK', englishName: 'FRAMEMARK2', elements: [{ morph: false, index: 0 }] }] }, bytes => {
    const english = find(bytes, ascii('FRAMEMARK2')); bytes[english + 10 + 1 + 4] = 2;
  });
  patched('IK link limit flag 2', { ...base, bones: [...base.bones.slice(0, 14), { ...base.bones[14], ik: { effector: 13, links: [{ index: 12, limits: [[1234.5, 0, 0], [0, 0, 0]] }] } }, ...base.bones.slice(15)] }, bytes => {
    const limit = new Uint8Array(new Float32Array([1234.5]).buffer); bytes[find(bytes, limit) - 1] = 2;
  });
  patched('negative vertex count', base, bytes => setI32(bytes, headerEnd(bytes), -1));
  patched('vertex count past the end', base, bytes => setI32(bytes, headerEnd(bytes), 0x7fffffff));
  patched('first text longer than the file', base, bytes => setI32(bytes, 17, 0x7fffffff));
  patched('negative text length', base, bytes => setI32(bytes, 17, -2));
  patched('index size 3', base, bytes => { bytes[11] = 3; });
  patched('additional UV count 5', base, bytes => { bytes[10] = 5; });
  patched('header with 7 globals', base, bytes => { bytes[8] = 7; });
  const skeletal: PmxWriteModel = { positions: [], skin: [], bones: BONES, morphs: [] };
  patched('bone count past the end', skeletal, bytes => setI32(bytes, headerEnd(bytes) + 16, 1_000_000));
  const soft = rich21Model({ indexSizes: INDEX_SIZES[1], softBodies: [{ name: 's', material: 0, anchors: [{ body: 0, vertex: 1 }], pins: [] }] });
  patched('soft body anchor count past the end', soft, bytes => setI32(bytes, bytes.length - 4 - (1 + 2 + 1) - 4, 0x7fffffff));
  cases.push(['2.1 with a 3-byte tail where the soft body count belongs', Uint8Array.from([...withEncoding(rich21Model({ softBodies: [] }), 1).slice(0, -4), 1, 2, 3])]);
  for (const [label, bytes] of cases) assertUntouched(bytes, 'malformed', label);

  // Random single-byte damage never throws; whatever converts is a full, consistent walk.
  let state = 12345;
  const random = () => (state = (state * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const good = withEncoding(base, 1);
  for (let trial = 0; trial < 400; trial++) {
    const bytes = Uint8Array.from(good), at = 10 + Math.floor(random() * (bytes.length - 10));
    bytes[at] = Math.floor(random() * 256);
    const copy = Uint8Array.from(bytes);
    const result = transcodePmxUtf8ToUtf16(bytes);
    assert.deepEqual(bytes, copy);
    if (!result.changed) assert.equal(result.bytes, bytes);
  }
});

test('trailing bytes after a complete PMX 2.0 are carried over unchanged', () => {
  const model = richModel(), tail = [0xde, 0xad, 0xbe];
  const result = transcodePmxUtf8ToUtf16(Uint8Array.from([...withEncoding(model, 1), ...tail]));
  assert.ok(result.changed); assert.equal(result.trailingBytes, 3);
  assert.equal(Buffer.compare(result.bytes, Uint8Array.from([...withEncoding(model, 0), ...tail])), 0);
});

test('files that are not UTF-8 PMX come back as the same object: UTF-16 PMX, other versions/encodings, VMD, PMD, images, short or empty input', () => {
  const vmd = Uint8Array.from([...ascii('Vocaloid Motion Data 0002'), ...new Uint8Array(40)]);
  const pmd = Uint8Array.from([...ascii('Pmd'), 0, 0, 0x80, 0x3f, ...new Uint8Array(40)]);
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const version = (value: number) => { const bytes = withEncoding(richModel(), 1); new DataView(bytes.buffer).setFloat32(4, value, true); return bytes; };
  const encoding = (value: number) => { const bytes = withEncoding(richModel(), 1); bytes[9] = value; return bytes; };
  const cases: [string, Uint8Array, string][] = [
    ['UTF-16 PMX 2.0', withEncoding(richModel(), 0), 'utf16'], ['UTF-16 PMX 2.1', withEncoding(rich21Model(), 0), 'utf16'],
    ['PMX 1.0', version(1), 'unsupported-version'], ['PMX 3.0', version(3), 'unsupported-version'], ['PMX 2.05', version(2.05), 'unsupported-version'],
    ['encoding 2', encoding(2), 'unknown-encoding'], ['encoding 255', encoding(255), 'unknown-encoding'],
    ['VMD', vmd, 'not-pmx'], ['PMD', pmd, 'not-pmx'], ['PNG', png, 'not-pmx'], ['empty', new Uint8Array(0), 'not-pmx'],
    ['"PMX"', ascii('PMX'), 'not-pmx'], ['PMX header cut at 9 bytes', withEncoding(richModel(), 1).slice(0, 9), 'malformed'],
  ];
  for (const [label, bytes, reason] of cases) assertUntouched(bytes, reason, label);
  assert.equal(readPmxHeader(vmd), null); assert.equal(readPmxHeader(ascii('PMX')), null);
  assert.deepEqual(readPmxHeader(withEncoding(rich21Model(), 1)), { version: '2.1', encoding: 1, additionalUv: 4 });
  assert.equal(PMX_HEADER_SNIFF_BYTES, 11);
  assert.equal(readPmxHeader(withEncoding(richModel(), 0).slice(0, 10)), null, 'the additional-UV count is part of the header');
});

test('Gene is UTF-16: the conversion is the identity and the pinned hash still matches the untouched bytes', () => {
  const gene = new Uint8Array(readFileSync(GENE_PATH));
  assert.equal(sha256(gene), bundled.model.sha256);
  assert.deepEqual(readPmxHeader(gene), { version: '2.0', encoding: 0, additionalUv: 0 });
  assertUntouched(gene, 'utf16', 'gene');
  assert.equal(sha256(gene), bundled.model.sha256);
  // A Buffer view into a larger allocation (how fs hands bytes over) is handled the same way.
  const pooled = Buffer.alloc(gene.length + 64); pooled.set(gene, 32);
  assertUntouched(pooled.subarray(32, 32 + gene.length), 'utf16', 'gene in a pooled buffer');
});

// ---------------------------------------------------------------- the mmd-asset protocol

/** The handler as it was inline in electron/main.ts before this change, over the same ports. */
function legacyHandler(ports: AssetProtocolPorts) {
  return async (request: Request) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
      const response = await ports.fetchFile(pathToFileURL(await ports.resolve(request.url)).href);
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
    } catch {
      return new Response('Asset unavailable', { status: 403 });
    }
  };
}

/** Real AssetRegistry (the app's), a stand-in for Electron's net.fetch on file:// URLs, and spies on whole-file reads. */
function protocolFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pmx-utf8-protocol-'));
  const registry = new AssetRegistry();
  const calls = { fetchFile: 0, readFile: 0, readHead: 0 };
  const fetchFile = async (url: string) => {
    calls.fetchFile++;
    const bytes = await readFile(fileURLToPath(url));
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length), 'X-Source': 'net.fetch' } });
  };
  const ports: AssetProtocolPorts = { resolve: url => registry.resolve(url), fetchFile };
  const spied: AssetProtocolPorts = {
    ...ports,
    readFile: async file => { calls.readFile++; return new Uint8Array(await readFile(file)); },
    readHead: async (file, length) => { calls.readHead++; return new Uint8Array(await readFile(file)).slice(0, length); },
  };
  return { directory, registry, calls, ports, spied, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

async function snapshot(response: Response) {
  return { status: response.status, headers: [...response.headers].sort(([a], [b]) => a.localeCompare(b)), body: new Uint8Array(await response.arrayBuffer()) };
}

test('mmd-asset: UTF-16 PMX (Gene too), VMD, images, damaged UTF-8 PMX and refused requests behave exactly as before', async () => {
  const fixture = protocolFixture();
  try {
    const files: [string, Uint8Array][] = [
      ['utf16.pmx', withEncoding(richModel(), 0)], ['motion.vmd', ascii('Vocaloid Motion Data 0002 and some frames')], ['face.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])],
      ['old.pmd', ascii('Pmd model')], ['not-really.pmx', ascii('hello, not a model')], ['tiny.pmx', ascii('PMX')], ['empty.pmx', new Uint8Array(0)],
      ['damaged-utf8.pmx', withEncoding(richModel(), 1).slice(0, 700)], ['note.txt', ascii('text')],
    ];
    for (const [name, bytes] of files) writeFileSync(path.join(fixture.directory, name), bytes);
    const token = new URL((await fixture.registry.register(path.join(fixture.directory, 'utf16.pmx'))).url).hostname;
    const gene = await fixture.registry.register(GENE_PATH);
    const current = createAssetProtocolHandler(fixture.spied), legacy = legacyHandler(fixture.ports);
    const urls = [...files.map(([name]) => `mmd-asset://${token}/${encodeURIComponent(name)}`), gene.url,
      `mmd-asset://${token}/missing.pmx`, `mmd-asset://unknown-token/utf16.pmx`, `mmd-asset://${token}/utf16.pmx?x=1`, `mmd-asset://${token}/..%2F..%2Fsecret.pmx`];
    for (const url of urls) for (const method of ['GET', 'HEAD', 'POST']) {
      const before = fixture.calls.fetchFile;
      const now = await snapshot(await current(new Request(url, { method })));
      const fetched = fixture.calls.fetchFile - before;
      const then = await snapshot(await legacy(new Request(url, { method })));
      assert.deepStrictEqual(now, then, `${method} ${url}`);
      assert.equal(fetched, fixture.calls.fetchFile - before - fetched, `${method} ${url}: net.fetch used as before`);
    }
    // Only the damaged UTF-8 file was read whole (and then served from net.fetch as before); Gene and UTF-16 files only had their header read.
    assert.equal(fixture.calls.readFile, 2, 'damaged-utf8.pmx: GET and HEAD');
    const geneNow = await snapshot(await current(new Request(gene.url)));
    assert.equal(sha256(geneNow.body), bundled.model.sha256);
  } finally { fixture.cleanup(); }
});

test('mmd-asset: a UTF-8 PMX is served converted with a matching Content-Length (GET and HEAD); the file and its identity hash are untouched', async () => {
  const fixture = protocolFixture();
  try {
    const model = richModel({ additionalUv: 2 }), utf8 = withEncoding(model, 1), twin = withEncoding(model, 0);
    for (const name of ['モデル.pmx', 'UPPER.PMX']) {
      const file = path.join(fixture.directory, name);
      writeFileSync(file, utf8);
      const asset = await fixture.registry.register(file);
      const handler = createAssetProtocolHandler(fixture.ports);
      const fetchesBefore = fixture.calls.fetchFile;
      const get = await handler(new Request(asset.url));
      assert.equal(get.status, 200);
      assert.equal(get.headers.get('Access-Control-Allow-Origin'), '*');
      assert.equal(get.headers.get('Content-Length'), String(twin.length));
      const body = new Uint8Array(await get.arrayBuffer());
      assert.equal(Buffer.compare(body, twin), 0, `${name}: served bytes are the UTF-16 twin`);
      const head = await handler(new Request(asset.url, { method: 'HEAD' }));
      assert.equal(head.status, 200); assert.equal(head.headers.get('Content-Length'), String(twin.length));
      assert.equal(head.headers.get('Access-Control-Allow-Origin'), '*');
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      assert.equal(fixture.calls.fetchFile, fetchesBefore, 'converted files do not go through net.fetch');
      assert.equal(Buffer.compare(readFileSync(file), utf8), 0, `${name}: the file on disk is unchanged`);
      const names = (mmdParse(arrayBuffer(body), true) as unknown as { bones: { name: string }[] }).bones.map(bone => bone.name);
      assert.deepEqual(names, BONES.map(bone => bone.name));
    }
    // The host's model identity (blush calibration, model profile cache) hashes the original file, not what the renderer is served.
    const store = new BlushCalibrationStore(path.join(fixture.directory, 'profile')); await store.load();
    assert.equal(await store.keyForModel(path.join(fixture.directory, 'モデル.pmx')), sha256(utf8));
  } finally { fixture.cleanup(); }
});

// ---------------------------------------------------------------- model profile and model lab

const profileOf = (data: PmxData) => { const lab = labMesh(data); try { return new StageModelProfile(lab.mesh, { reviewed: false }).profile!; } finally { lab.dispose(); } };

test('the model profile maps a UTF-8 model to the standard skeleton and expression slots exactly as its UTF-16 twin', () => {
  const model = pmxFromModelData(toyModel({ ik: true, twist: true, groove: true }), { name: 'トイ' });
  const utf8 = withEncoding(model, 1), utf16 = withEncoding(model, 0);
  const fromUtf8 = profileOf(parsePmx(utf8)), fromTwin = profileOf(parsePmx(utf16));
  assert.deepStrictEqual(fromUtf8, fromTwin);
  assert.deepEqual(CORE_BONES.filter(bone => fromUtf8.bones.missing.includes(bone)), []);
  assert.equal(fromUtf8.bones.features.legIk, true);
  assert.deepEqual(MORPH_SLOTS.filter(slot => fromUtf8.morphs[slot].index < 0), ['mouthPucker'], 'the synthetic face has no pucker (skeleton step 2 slot)');
  // Without the conversion (today's loader on the raw bytes) the model does not even load: names such as 首 are 3 UTF-8 bytes.
  assert.throws(() => mmdParse(arrayBuffer(utf8), true));
});

test('the model lab reports a UTF-8 model exactly like its UTF-16 twin (profile, plan, all 76 motions)', () => {
  const model = pmxFromModelData(toyModel({ ik: true }), { name: 'トイ' }), motions = loadBundledMotions();
  const a = analyzeModel({ id: 'utf8', file: 'utf8.pmx', path: 'utf8', bytes: withEncoding(model, 1) }, motions);
  const b = analyzeModel({ id: 'utf8', file: 'utf8.pmx', path: 'utf8', bytes: withEncoding(model, 0) }, motions);
  assert.equal(a.ok, true, a.error ?? ''); assert.equal(a.model.name?.japanese, 'トイ');
  assert.equal(a.motions.length, 76);
  assert.deepStrictEqual(stripReport(a), stripReport(b));
  // The report says the text was converted (and nothing was downgraded); the UTF-16 twin needed nothing.
  assert.equal(a.conversion?.fromUtf8, true); assert.equal(a.conversion?.downgrade, null); assert.equal(a.conversion?.textFields, textFieldCount(model));
  assert.equal(b.conversion, null);
  assert.match(renderModelMarkdown(a, 'now'), /UTF-8 → UTF-16/); assert.doesNotMatch(renderModelMarkdown(b, 'now'), /载入前转换/);
});

/** A lab report without what legitimately differs between two encodings or versions of one model: file size and hash, timings, the conversion note. */
const stripReport = (report: ModelReport) => ({ ...report, model: { ...report.model, bytes: 0, sha256: '' }, conversion: null, timings: null,
  motions: report.motions.map(motion => ({ ...motion, ms: 0 })) });

// ---------------------------------------------------------------- timing

/** About 100k vertices (all four deform types), 150k faces, 1000 bones, 300 morphs, with Japanese names throughout. */
function largeUtf8Model(): PmxWriteModel {
  const vertices = 100_000, positions = new Float32Array(vertices * 3), skin: PmxSkin[] = [];
  for (let vertex = 0; vertex < vertices; vertex++) {
    positions[vertex * 3] = (vertex % 100) * 0.01; positions[vertex * 3 + 1] = Math.floor(vertex / 100) * 0.02; positions[vertex * 3 + 2] = 0;
    const bone = vertex % 1000, kind = vertex % 4;
    skin.push(kind === 0 ? { deform: 0, bones: [bone], weights: [1] } : kind === 1 ? { deform: 1, bones: [bone, (bone + 1) % 1000], weights: [0.5] }
      : kind === 2 ? { deform: 2, bones: [bone, 1, 2, 3], weights: [0.4, 0.3, 0.2, 0.1] } : { deform: 3, bones: [bone, 0], weights: [0.6] });
  }
  const faces: number[] = [];
  for (let face = 0; face < 150_000; face++) faces.push(face % vertices, (face + 1) % vertices, (face + 100) % vertices);
  const bones: PmxWriteBone[] = Array.from({ length: 1000 }, (_, k) => ({ name: k < BONES.length ? BONES[k].name || `骨${k}` : `髪飾り${k}_スカート`, parent: k - 1, position: [0, k * 0.01, 0] }));
  const morphs: PmxWriteMorph[] = Array.from({ length: 300 }, (_, m) => {
    const indices = Array.from({ length: 300 }, (_, k) => (m * 300 + k) % vertices);
    return { name: `表情モーフ${m}`, type: 1, indices, deltas: indices.flatMap(() => [0, 0.001, 0]) };
  });
  return {
    name: '大きいモデル', positions, skin, faces, bones, morphs, additionalUv: 1,
    textures: Array.from({ length: 30 }, (_, k) => `テクスチャ/画像${k}.png`),
    materials: Array.from({ length: 50 }, (_, k) => ({ name: `材質${k}`, texture: k % 30, memo: 'メモ', surfaces: 9000 })),
    frames: [{ name: '表情', special: true, elements: morphs.map((_, k) => ({ morph: true, index: k })) }],
    rigidBodies: Array.from({ length: 200 }, (_, k) => ({ boneIndex: k * 5, type: k % 3, name: `剛体${k}` })),
    joints: Array.from({ length: 150 }, (_, k) => ({ a: k, b: k + 1, name: `ジョイント${k}` })),
  };
}

test('a ≈100k-vertex UTF-8 model converts in well under a second', (t) => {
  const model = largeUtf8Model(), utf8 = withEncoding(model, 1), utf16 = withEncoding(model, 0);
  const runs: number[] = [];
  let result = transcodePmxUtf8ToUtf16(utf8);
  for (let k = 0; k < 5; k++) { const start = performance.now(); result = transcodePmxUtf8ToUtf16(utf8); runs.push(performance.now() - start); }
  assert.ok(result.changed); assert.equal(Buffer.compare(result.bytes, utf16), 0);
  runs.sort((a, b) => a - b);
  const median = runs[2];
  t.diagnostic(`100k vertices, ${(utf8.length / 1e6).toFixed(1)} MB UTF-8 → ${(result.bytes.length / 1e6).toFixed(1)} MB: median ${median.toFixed(1)} ms (min ${runs[0].toFixed(1)}, max ${runs[4].toFixed(1)}), ${result.textFields} text fields`);
  assert.ok(median < 1000, `median ${median} ms`);
});

// ---------------------------------------------------------------- PMX 2.1 → 2.0 for MMDParser

/** The MMDParser fields the 2.1 tests look at. */
interface Parsed21 {
  metadata: { version: number; encoding: number; modelName: string };
  vertices: { type: number; skinIndices: number[]; skinWeights: number[] }[];
  morphs: { name: string; panel: number; type: number; elementCount: number; elements: { index: number; ratio?: number }[] }[];
  frames: { name: string; elements: { target: number; index: number }[] }[];
  bones: { name: string }[]; rigidBodies: unknown[]; constraints: unknown[];
}

/** A PMX 2.1 MMDParser can read once downgraded: two QDEF vertices, a flip and two impulse morphs (shown in a display frame and used by a group), soft bodies. */
function readable21(options: Partial<PmxWriteModel> = {}): PmxWriteModel {
  const base = richModel({ additionalUv: 2 });
  return {
    ...base, version: 2.1,
    skin: base.skin.map((skin, vertex): PmxSkin => vertex === 7 ? { deform: 4, bones: [1, 2, 3, 4], weights: [0.25, 0.25, 0.25, 0.25] }
      : vertex === 10 ? { deform: 4, bones: [5, 6, 9, 0], weights: [0.5, 0.3, 0.2, 0] } : skin),
    morphs: [...base.morphs, // 0-6
      { name: 'フリップ', englishName: 'flip', type: 9, flips: [[0, 1], [1, 0.5]], panel: 2 }, // 7
      { name: 'インパルス', englishName: 'impulse', type: 10, panel: 4, impulses: [
        { body: 2, local: true, velocity: [0, 1, 0], torque: [0.1, 0, 0] }, { body: 0, local: false, velocity: [0.5, 0, -1], torque: [0, 0, 0.2] },
        { body: 1, local: true, velocity: [0, 0, 0], torque: [0, 3, 0] }] }, // 8
      { name: '空のインパルス', type: 10, impulses: [] }, // 9
      { name: '組み合わせ', type: 0, group: [[7, 1], [8, 0.5], [0, 0.25]], panel: 3 }, // 10
    ],
    frames: [...base.frames!, { name: '2.1の表情', elements: [{ morph: true, index: 7 }, { morph: true, index: 8 }, { morph: true, index: 9 }, { morph: true, index: 10 }] }],
    softBodies: [
      { name: 'スカート', englishName: 'skirt', material: 1, anchors: [{ body: 0, vertex: 3, near: true }, { body: 1, vertex: 5 }], pins: [1, 2, 3] },
      { name: '', material: 0, anchors: [], pins: [] },
    ],
    ...options,
  };
}
const READABLE21_DOWNGRADE: PmxDowngrade = { qdefVertices: 2, flipMorphs: 1, impulseMorphs: 2, impulseElements: 3, softBodies: 2 };

/** The same model as a PMX 2.0 author would write it: QDEF as BDEF4, flip as a group of the same elements, impulse as an empty group, no soft bodies. */
function as20(model: PmxWriteModel): PmxWriteModel {
  return {
    ...model, version: 2.0, softBodies: undefined,
    skin: model.skin.map((skin): PmxSkin => skin.deform === 4 ? { ...skin, deform: 2 } : skin),
    morphs: model.morphs.map((morph): PmxWriteMorph => morph.type === 9 ? { name: morph.name, englishName: morph.englishName, panel: morph.panel, type: 0, group: morph.flips }
      : morph.type === 10 ? { name: morph.name, englishName: morph.englishName, panel: morph.panel, type: 0, group: [] } : morph),
  };
}

/** What a 2.1 model should be served as: its UTF-16 2.0 twin followed by the 2.1 file's soft body section, which MMDParser never reads. */
function downgraded(model: PmxWriteModel): Uint8Array {
  const utf16 = withEncoding(model, 0), withoutSoft = withEncoding({ ...model, softBodies: [] }, 0);
  return new Uint8Array(Buffer.concat([withEncoding(as20(model), 0), utf16.subarray(withoutSoft.length - 4)]));
}

function assertPreparedUntouched(input: Uint8Array, reason: string, label: string) {
  const copy = Uint8Array.from(input);
  let result: ReturnType<typeof preparePmxForMmdParser> | undefined;
  assert.doesNotThrow(() => { result = preparePmxForMmdParser(input); }, label);
  assert.equal(result!.changed, false, label);
  assert.equal(result!.bytes, input, `${label}: the same bytes object comes back`);
  if (!result!.changed) assert.equal(result!.reason, reason, `${label}: ${result!.reason} ${result!.detail ?? ''}`);
  assert.equal(Buffer.compare(input, copy), 0, `${label}: input not modified`);
}

/** three's real MMDLoader mesh builder on bytes as the renderer receives them (materials inert, as the model-lab tests do). */
function loaderMeshOf(bytes: Uint8Array): SkinnedMesh {
  const loader = new MMDLoader() as unknown as { meshBuilder: { materialBuilder: { _loadTexture: () => Texture }; build(data: unknown, path: string): SkinnedMesh } };
  loader.meshBuilder.materialBuilder._loadTexture = () => Object.assign(new Texture(), { readyCallbacks: [] });
  return loader.meshBuilder.build(mmdParse(arrayBuffer(bytes), true), '');
}

test('PMX 2.1 is served as 2.0: QDEF → BDEF4, flip → group, impulse → empty group, soft bodies left after the joints (the 2.0 twin plus that tail, byte for byte)', () => {
  for (const indexSizes of INDEX_SIZES) {
    const label = `2.1 ${JSON.stringify(indexSizes)}`, model = readable21({ indexSizes }), input = withEncoding(model, 0), before = Uint8Array.from(input);
    assert.deepEqual(readPmxHeader(input), { version: '2.1', encoding: 0, additionalUv: 2 });
    const result = preparePmxForMmdParser(input);
    assert.ok(result.changed, `${label}: ${result.changed ? '' : `${result.reason} ${result.detail ?? ''}`}`);
    assert.equal(Buffer.compare(result.bytes, downgraded(model)), 0, `${label}: the 2.0 twin plus the soft body tail`);
    assert.deepEqual(readPmxHeader(result.bytes), { version: '2.0', encoding: 0, additionalUv: 2 });
    assert.deepEqual(result.downgrade, READABLE21_DOWNGRADE, label);
    assert.equal(result.version, '2.1'); assert.equal(result.fromUtf8, false); assert.equal(result.textFields, 0); assert.equal(result.trailingBytes, 0);
    // Exactly the three impulse elements' bytes are gone (body index, local flag, velocity, torque).
    assert.equal(input.length - result.bytes.length, 3 * ((indexSizes?.rigidBody ?? 2) + 25), label);
    assert.equal(Buffer.compare(input, before), 0, `${label}: the input is not modified`);
  }
  const result = preparePmxForMmdParser(withEncoding(readable21(), 0));
  assert.ok(result.changed);
  assert.equal(describePmxPreparation(result), 'pmx 2.1 -> 2.0: 2 qdef vertices -> bdef4, 1 flip morph -> group, 2 impulse morphs emptied (3 impulses dropped), 2 soft bodies not read');
  // Bytes after the soft bodies are carried over too.
  const tail = [0xde, 0xad, 0xbe], tailed = preparePmxForMmdParser(Uint8Array.from([...withEncoding(readable21(), 0), ...tail]));
  assert.ok(tailed.changed); assert.equal(tailed.trailingBytes, 3);
  assert.equal(Buffer.compare(tailed.bytes, Uint8Array.from([...downgraded(readable21()), ...tail])), 0);
});

test("three's MMDParser refuses the 2.1 file but reads the served one exactly like the 2.0 twin: vertices, morphs in order, frames, bones, bodies, joints", () => {
  for (const indexSizes of INDEX_SIZES) {
    const model = readable21({ indexSizes }), input = withEncoding(model, 0);
    assert.throws(() => mmdParse(arrayBuffer(input), true), (error: unknown) => /PMX version 2\.09999/.test(String(error)));
    const parsed = mmdParse(arrayBuffer(preparePmxForMmdParser(input).bytes), true) as unknown as Parsed21;
    const twin = mmdParse(arrayBuffer(withEncoding(as20(model), 0)), true) as unknown as Parsed21;
    assert.deepStrictEqual(parsed, twin);
    assert.equal(parsed.metadata.version, 2);
    // Vertices: QDEF became BDEF4 with the same four bones and weights.
    assert.equal(parsed.vertices.length, model.skin.length);
    for (const vertex of [7, 10]) {
      assert.equal(parsed.vertices[vertex].type, 2);
      assert.deepEqual(parsed.vertices[vertex].skinIndices, model.skin[vertex].bones);
      assert.deepEqual(parsed.vertices[vertex].skinWeights, model.skin[vertex].weights.map(Math.fround));
    }
    // Morphs: same count, names, panels and order; the flip is a group of its elements, the impulses are empty groups.
    assert.deepEqual(parsed.morphs.map(morph => morph.name), model.morphs.map(morph => morph.name));
    assert.deepEqual(parsed.morphs.map(morph => morph.type), [1, 1, 0, 2, 3, 8, 1, 0, 0, 0, 0]);
    assert.deepEqual(parsed.morphs[7].elements, [{ index: 0, ratio: 1 }, { index: 1, ratio: 0.5 }]);
    assert.deepEqual([parsed.morphs[8].elementCount, parsed.morphs[9].elementCount, parsed.morphs[8].elements.length], [0, 0, 0]);
    assert.deepEqual(parsed.morphs.slice(7).map(morph => morph.panel), [2, 4, 1, 3]);
    assert.deepEqual(parsed.morphs[10].elements.map(element => element.index), [7, 8, 0]);
    // Display frames still point at the same morphs.
    assert.deepEqual(parsed.frames.at(-1)!.elements.map(element => parsed.morphs[element.index].name), ['フリップ', 'インパルス', '空のインパルス', '組み合わせ']);
    assert.deepEqual(parsed.bones.map(bone => bone.name), BONES.map(bone => bone.name));
    assert.equal(parsed.rigidBodies.length, 3); assert.equal(parsed.constraints.length, 2);
  }
});

test("three's MMDLoader builds the served 2.1 model exactly like its 2.0 twin (skin, morph targets, skeleton, IK, grants, physics)", () => {
  const model = readable21();
  const served = loaderMeshOf(preparePmxForMmdParser(withEncoding(model, 0)).bytes), twin = loaderMeshOf(withEncoding(as20(model), 0));
  for (const name of ['position', 'skinIndex', 'skinWeight']) assert.deepEqual(served.geometry.getAttribute(name).array, twin.geometry.getAttribute(name).array, name);
  assert.deepEqual(served.morphTargetDictionary, twin.morphTargetDictionary);
  assert.deepEqual(Object.keys(served.morphTargetDictionary!), model.morphs.map(morph => morph.name));
  const servedTargets = served.geometry.morphAttributes.position, twinTargets = twin.geometry.morphAttributes.position;
  assert.equal(servedTargets.length, model.morphs.length);
  servedTargets.forEach((target, k) => assert.deepEqual(target.array, twinTargets[k].array, `morph target ${k}`));
  assert.deepEqual(served.skeleton.bones.map(bone => [bone.name, ...bone.position.toArray()]), twin.skeleton.bones.map(bone => [bone.name, ...bone.position.toArray()]));
  assert.deepStrictEqual(served.geometry.userData.MMD, twin.geometry.userData.MMD);
});

test('UTF-8 and 2.1 together: one pass converts the text and downgrades, giving the same bytes as the UTF-16 2.1 file', () => {
  for (const indexSizes of INDEX_SIZES) {
    const label = `UTF-8 2.1 ${JSON.stringify(indexSizes)}`, model = readable21({ indexSizes }), utf8 = withEncoding(model, 1), before = Uint8Array.from(utf8);
    assert.deepEqual(readPmxHeader(utf8), { version: '2.1', encoding: 1, additionalUv: 2 });
    const result = preparePmxForMmdParser(utf8);
    assert.ok(result.changed, label);
    assert.equal(Buffer.compare(result.bytes, downgraded(model)), 0, label);
    assert.equal(result.fromUtf8, true); assert.equal(result.textFields, textFieldCount(model)); assert.equal(result.replacedTextFields, 0);
    assert.deepEqual(result.downgrade, READABLE21_DOWNGRADE, label);
    assert.equal(Buffer.compare(utf8, before), 0, `${label}: the input is not modified`);
  }
  const result = preparePmxForMmdParser(withEncoding(readable21(), 1));
  assert.ok(result.changed);
  assert.match(describePmxPreparation(result), /^utf-8 text -> utf-16le \(\d+ fields\); pmx 2\.1 -> 2\.0: 2 qdef vertices/);
  const parsed = mmdParse(arrayBuffer(result.bytes), true) as unknown as Parsed21;
  assert.equal(parsed.metadata.encoding, 0); assert.equal(parsed.metadata.modelName, '合成モデル');
  assert.deepEqual(parsed.bones.map(bone => bone.name), BONES.map(bone => bone.name));
  assert.deepEqual(parsed.morphs.slice(7).map(morph => morph.name), ['フリップ', 'インパルス', '空のインパルス', '組み合わせ']);
});

test('a 2.1 file with nothing 2.1-specific only gets its version changed (plus its text when UTF-8)', () => {
  const plain: PmxWriteModel = { ...richModel({ additionalUv: 1 }), version: 2.1, softBodies: [] }, as20Bytes = withEncoding({ ...plain, version: 2.0 }, 0);
  const input = withEncoding(plain, 0), result = preparePmxForMmdParser(input);
  assert.ok(result.changed);
  assert.equal(result.bytes.length, input.length);
  assert.ok([...input.keys()].filter(k => input[k] !== result.bytes[k]).every(k => k >= 4 && k < 8), 'only the version bytes differ');
  assert.deepEqual([...result.bytes.subarray(4, 8)], [...new Uint8Array(new Float32Array([2.0]).buffer)]);
  assert.deepEqual(result.downgrade, { qdefVertices: 0, flipMorphs: 0, impulseMorphs: 0, impulseElements: 0, softBodies: 0 });
  assert.equal(describePmxPreparation(result), 'pmx 2.1 -> 2.0: no 2.1-only content');
  // The empty soft body section (a zero count) stays behind the joints.
  assert.equal(Buffer.compare(result.bytes, Buffer.concat([as20Bytes, Buffer.alloc(4)])), 0);
  assert.deepStrictEqual(mmdParse(arrayBuffer(result.bytes), true), mmdParse(arrayBuffer(as20Bytes), true));
  // A 2.1 file that ends right after its joints becomes exactly the 2.0 file.
  const ended = preparePmxForMmdParser(input.slice(0, -4));
  assert.ok(ended.changed); assert.equal(Buffer.compare(ended.bytes, as20Bytes), 0);
  // UTF-8: the text and the version, in one pass.
  const utf8 = preparePmxForMmdParser(withEncoding(plain, 1));
  assert.ok(utf8.changed); assert.equal(Buffer.compare(utf8.bytes, result.bytes), 0);
});

test('truncated or damaged PMX 2.1 files come back untouched, without throwing', (t) => {
  for (const encoding of [0, 1] as const) {
    const model = readable21({ indexSizes: INDEX_SIZES[0] }), full = withEncoding(model, encoding);
    const jointsEnd = withEncoding({ ...model, softBodies: [] }, encoding).length - 4;
    for (let cut = 10; cut < full.length; cut++) {
      // Cut right after the joints it is a complete 2.1 file without soft bodies.
      if (cut === jointsEnd) { assert.ok(preparePmxForMmdParser(full.slice(0, cut)).changed); continue; }
      assertPreparedUntouched(full.slice(0, cut), 'malformed', `encoding ${encoding} cut at ${cut} of ${full.length}`);
    }
    t.diagnostic(`encoding ${encoding}: ${full.length} bytes, cut at every byte from 10`);
  }

  const base = readable21({ indexSizes: INDEX_SIZES[1] });
  const cases: [string, Uint8Array][] = [];
  const patched = (label: string, model: PmxWriteModel, patch: (bytes: Uint8Array) => void) => { const bytes = withEncoding(model, 0); patch(bytes); cases.push([label, bytes]); };
  cases.push(['deform type 5', withEncoding({ ...base, skin: base.skin.map((skin, vertex) => vertex === 7 ? { ...skin, deform: 5 as never } : skin) }, 0)]);
  cases.push(['morph type 11', withEncoding({ ...base, morphs: [...base.morphs, { name: 'x', type: 11 as never, uvs: [{ index: 0, value: [0, 0, 0, 0] }] }] }, 0)]);
  const impulse: PmxWriteModel = { ...base, morphs: [...base.morphs, { name: 'i', type: 10, impulses: [{ body: 0, local: true, velocity: [1234.5, 0, 0], torque: [0, 0, 0] }] }] };
  // The element count sits before the body index (1 byte at these sizes) and the local flag.
  const impulseCount = (bytes: Uint8Array) => find(bytes, new Uint8Array(new Float32Array([1234.5]).buffer)) - 1 - 1 - 4;
  patched('impulse element count past the end', impulse, bytes => setI32(bytes, impulseCount(bytes), 0x7fffffff));
  patched('negative impulse element count', impulse, bytes => setI32(bytes, impulseCount(bytes), -1));
  patched('soft body pin count past the end', readable21({ indexSizes: INDEX_SIZES[1], softBodies: [{ name: 's', material: 0, anchors: [], pins: [] }] }),
    bytes => setI32(bytes, bytes.length - 4, 1000));
  cases.push(['2.1 with a 3-byte tail where the soft body count belongs', Uint8Array.from([...withEncoding({ ...base, softBodies: [] }, 0).slice(0, -4), 1, 2, 3])]);
  for (const [label, bytes] of cases) assertPreparedUntouched(bytes, 'malformed', label);

  // Random single-byte damage never throws; whatever converts is a complete walk served as 2.0.
  let state = 98765;
  const random = () => (state = (state * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const good = withEncoding(base, 0);
  for (let trial = 0; trial < 400; trial++) {
    const bytes = Uint8Array.from(good), at = 10 + Math.floor(random() * (bytes.length - 10));
    bytes[at] = Math.floor(random() * 256);
    const copy = Uint8Array.from(bytes);
    const result = preparePmxForMmdParser(bytes);
    assert.deepEqual(bytes, copy);
    if (!result.changed) assert.equal(result.bytes, bytes);
    else assert.equal(readPmxHeader(result.bytes)?.version, '2.0');
  }
});

test('files with nothing MMDParser cannot read behave as before: UTF-16 2.0 (Gene) is the same object, UTF-8 2.0 only gets its text converted, a 2.0 file with QDEF stays refused', () => {
  const gene = new Uint8Array(readFileSync(GENE_PATH));
  assertPreparedUntouched(gene, 'utf16-2.0', 'gene');
  assert.equal(sha256(gene), bundled.model.sha256);
  assertPreparedUntouched(withEncoding(richModel(), 0), 'utf16-2.0', 'UTF-16 2.0');
  // With additional UVs the file is walked (it could hold additional-UV morph offsets); without any it comes back as the same object.
  assertPreparedUntouched(withEncoding(richModel({ additionalUv: 3 }), 0), 'no-change', 'UTF-16 2.0 with additional UVs');
  // 2.1 structures in a file that says 2.0 (not allowed there) are left alone, so MMDParser refuses the QDEF as it always did.
  const qdef20: PmxWriteModel = { ...readable21(), version: 2.0, softBodies: undefined };
  assertPreparedUntouched(withEncoding(qdef20, 0), 'no-change', '2.0 with QDEF');
  assertPreparedUntouched(withEncoding({ ...qdef20, additionalUv: 0 }, 0), 'utf16-2.0', '2.0 with QDEF, no additional UVs');
  assert.throws(() => mmdParse(arrayBuffer(withEncoding(qdef20, 0)), true), (error: unknown) => /unsupport bone type 4/.test(String(error)));
  // UTF-8 2.0: exactly the text-only conversion, nothing downgraded.
  for (const model of [richModel({ additionalUv: 2 }), qdef20]) {
    const utf8 = withEncoding(model, 1), result = preparePmxForMmdParser(utf8), text = transcodePmxUtf8ToUtf16(utf8);
    assert.ok(result.changed && text.changed);
    assert.equal(Buffer.compare(result.bytes, text.bytes), 0);
    assert.equal(result.downgrade, null); assert.equal(result.additionalUvMorphs, null);
    assert.equal(result.version, '2.0'); assert.equal(result.fromUtf8, true); assert.equal(result.textFields, text.textFields);
    assert.match(describePmxPreparation(result), /^utf-8 text -> utf-16le \(\d+ fields\)$/);
  }
  const version = (value: number) => { const bytes = withEncoding(richModel(), 0); new DataView(bytes.buffer).setFloat32(4, value, true); return bytes; };
  const encoding21 = withEncoding(readable21(), 0); encoding21[9] = 2;
  const cases: [string, Uint8Array, string][] = [
    ['PMX 1.0', version(1), 'unsupported-version'], ['PMX 2.2', version(2.2), 'unsupported-version'], ['2.1 with encoding byte 2', encoding21, 'unknown-encoding'],
    ['VMD', ascii('Vocaloid Motion Data 0002 and frames'), 'not-pmx'], ['empty', new Uint8Array(0), 'not-pmx'],
    ['2.1 header cut at 9 bytes', withEncoding(readable21(), 0).slice(0, 9), 'malformed'], ['header cut at 10 bytes', withEncoding(richModel(), 0).slice(0, 10), 'malformed'],
  ];
  for (const [label, bytes, reason] of cases) assertPreparedUntouched(bytes, reason, label);
});

test('mmd-asset: a PMX 2.1 is read whole and served as 2.0 with a matching Content-Length and a note header; damaged 2.1, UTF-16 2.0 and Gene as before', async () => {
  const fixture = protocolFixture();
  try {
    const model = readable21(), plain: PmxWriteModel = { ...richModel(), version: 2.1, softBodies: [] };
    const served: [string, Uint8Array, Uint8Array, RegExp][] = [
      ['v21.pmx', withEncoding(model, 0), downgraded(model), /^pmx 2\.1 -> 2\.0: 2 qdef/],
      ['ユーティーエフ8.PMX', withEncoding(model, 1), downgraded(model), /^utf-8 text -> utf-16le .*; pmx 2\.1 -> 2\.0: 2 qdef/],
      ['plain21.pmx', withEncoding(plain, 0), new Uint8Array(Buffer.concat([withEncoding({ ...plain, version: 2.0 }, 0), Buffer.alloc(4)])), /^pmx 2\.1 -> 2\.0: no 2\.1-only content$/],
    ];
    const handler = createAssetProtocolHandler(fixture.spied);
    for (const [name, bytes, expected, note] of served) {
      const file = path.join(fixture.directory, name);
      writeFileSync(file, bytes);
      const asset = await fixture.registry.register(file);
      const { fetchFile, readFile: reads, readHead } = { ...fixture.calls };
      const get = await handler(new Request(asset.url));
      assert.equal(get.status, 200, name);
      assert.equal(get.headers.get('Content-Length'), String(expected.length), name);
      assert.equal(get.headers.get('Access-Control-Allow-Origin'), '*');
      assert.match(get.headers.get('X-PMX-Conversion') ?? '', note, name);
      const body = new Uint8Array(await get.arrayBuffer());
      assert.equal(Buffer.compare(body, expected), 0, `${name}: served bytes`);
      assert.equal((mmdParse(arrayBuffer(body), true) as unknown as Parsed21).metadata.version, 2);
      const head = await handler(new Request(asset.url, { method: 'HEAD' }));
      assert.equal(head.status, 200); assert.equal(head.headers.get('Content-Length'), String(expected.length));
      assert.match(head.headers.get('X-PMX-Conversion') ?? '', note);
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      assert.deepEqual([fixture.calls.fetchFile - fetchFile, fixture.calls.readHead - readHead, fixture.calls.readFile - reads], [0, 2, 2], `${name}: header sniffed, read whole, no net.fetch`);
      assert.equal(Buffer.compare(readFileSync(file), bytes), 0, `${name}: the file on disk is unchanged`);
    }

    // A damaged 2.1 file is read whole once per request, then served exactly as the old handler serves it; UTF-16 2.0 and Gene only have their header read.
    writeFileSync(path.join(fixture.directory, 'damaged21.pmx'), withEncoding(model, 0).slice(0, 900));
    writeFileSync(path.join(fixture.directory, 'utf16.pmx'), withEncoding(richModel(), 0));
    const token = new URL((await fixture.registry.register(path.join(fixture.directory, 'utf16.pmx'))).url).hostname;
    const gene = await fixture.registry.register(GENE_PATH), legacy = legacyHandler(fixture.ports);
    for (const [url, wholeReads] of [[`mmd-asset://${token}/damaged21.pmx`, 1], [`mmd-asset://${token}/utf16.pmx`, 0], [gene.url, 0]] as const) {
      for (const method of ['GET', 'HEAD']) {
        const reads = fixture.calls.readFile;
        const now = await snapshot(await handler(new Request(url, { method })));
        assert.equal(fixture.calls.readFile - reads, wholeReads, `${method} ${url}: whole-file reads`);
        assert.deepStrictEqual(now, await snapshot(await legacy(new Request(url, { method }))), `${method} ${url}`);
        assert.ok(!now.headers.some(([key]) => key === 'x-pmx-conversion'), `${method} ${url}: no conversion note`);
      }
    }
  } finally { fixture.cleanup(); }
});

/** The toy humanoid as a PMX 2.1: every third vertex QDEF on its bone and that bone's parent, a flip and an impulse morph, a soft body. */
function humanoid21(): PmxWriteModel {
  const base = pmxFromModelData(toyModel({ ik: true, twist: true, groove: true }), { name: 'トイ' });
  const parentOf = (bone: number) => Math.max(0, base.bones[bone].parent);
  return {
    ...base, version: 2.1,
    skin: base.skin.map((skin, vertex): PmxSkin => vertex % 3 === 0 ? { deform: 4, bones: [skin.bones[0], parentOf(skin.bones[0]), 0, 0], weights: [0.7, 0.3, 0, 0] } : skin),
    morphs: [...base.morphs, { name: 'フリップ', type: 9, flips: [[0, 1], [1, 1]] }, { name: 'インパルス', type: 10, impulses: [{ body: 0, local: true, velocity: [0, 0, 1], torque: [0, 0, 0] }] }],
    softBodies: [{ name: 'スカート', material: 0, anchors: [], pins: [0, 1] }],
  };
}

test('the model profile and the model lab treat a PMX 2.1 humanoid exactly like its 2.0 twin; the lab report notes the downgrade', () => {
  const model = humanoid21(), v21 = writePmx(model), v20 = writePmx(as20(model));
  const qdefVertices = model.skin.filter(skin => skin.deform === 4).length;
  assert.ok(qdefVertices > 100, `${qdefVertices} QDEF vertices`);
  // Without the conversion the app's loader refuses the file outright.
  assert.throws(() => mmdParse(arrayBuffer(v21), true), (error: unknown) => /PMX version 2\.09999/.test(String(error)));
  const fromV21 = profileOf(parsePmx(v21)), fromV20 = profileOf(parsePmx(v20));
  assert.deepStrictEqual(fromV21, fromV20);
  assert.deepEqual(CORE_BONES.filter(bone => fromV21.bones.missing.includes(bone)), []);
  assert.equal(fromV21.bones.features.legIk, true);
  assert.deepEqual(MORPH_SLOTS.filter(slot => fromV21.morphs[slot].index < 0), ['mouthPucker'], 'the synthetic face has no pucker');

  const motions = loadBundledMotions();
  const analyze = (bytes: Uint8Array) => analyzeModel({ id: 'v21', file: 'v21.pmx', path: 'v21', bytes }, motions);
  const a = analyze(v21), b = analyze(v20), c = analyze(withEncoding(model, 1));
  assert.equal(a.ok, true, a.error ?? ''); assert.equal(a.motions.length, 76); assert.equal(a.counts?.deform.bdef4, qdefVertices);
  assert.deepStrictEqual(stripReport(a), stripReport(b));
  assert.deepStrictEqual(stripReport(c), stripReport(b));
  const downgrade: PmxDowngrade = { qdefVertices, flipMorphs: 1, impulseMorphs: 1, impulseElements: 1, softBodies: 1 };
  assert.deepEqual(a.conversion, { fromUtf8: false, textFields: 0, replacedTextFields: 0, downgrade, additionalUvMorphs: null });
  assert.deepEqual(c.conversion, { fromUtf8: true, textFields: textFieldCount(model), replacedTextFields: 0, downgrade, additionalUvMorphs: null });
  assert.equal(b.conversion, null);
  const markdown = renderModelMarkdown(a, 'now');
  assert.match(markdown, /已从 PMX 2\.1 降级为 2\.0/);
  assert.match(markdown, new RegExp(`QDEF→BDEF4 ${qdefVertices} 个顶点`));
  assert.match(markdown, /丢弃 1 个冲量/); assert.match(markdown, /1 个软体不读/);
});

test('a ≈100k-vertex UTF-8 PMX 2.1 (25k QDEF vertices) is converted and downgraded in well under a second', (t) => {
  const large = largeUtf8Model(), model: PmxWriteModel = { ...large, version: 2.1, skin: large.skin.map((skin): PmxSkin => skin.deform === 2 ? { ...skin, deform: 4 } : skin) };
  const utf8 = withEncoding(model, 1), expected = Buffer.concat([withEncoding(large, 0), Buffer.alloc(4)]);
  const runs: number[] = [];
  let result = preparePmxForMmdParser(utf8);
  for (let k = 0; k < 5; k++) { const start = performance.now(); result = preparePmxForMmdParser(utf8); runs.push(performance.now() - start); }
  assert.ok(result.changed); assert.equal(Buffer.compare(result.bytes, expected), 0);
  assert.equal(result.downgrade?.qdefVertices, 25_000);
  runs.sort((a, b) => a - b);
  t.diagnostic(`100k vertices (25k QDEF), ${(utf8.length / 1e6).toFixed(1)} MB UTF-8 2.1 → ${(result.bytes.length / 1e6).toFixed(1)} MB UTF-16 2.0: median ${runs[2].toFixed(1)} ms (min ${runs[0].toFixed(1)}, max ${runs[4].toFixed(1)})`);
  assert.ok(runs[2] < 1000, `median ${runs[2]} ms`);
});

// ---------------------------------------------------------------- additional-UV morphs (types 4-7)

/** Additional-UV morphs of all four kinds, three with offsets (MMDParser reads none of their bytes) and one empty, used by a group and a display frame. */
function withUvMorphs(model: PmxWriteModel): PmxWriteModel {
  const first = model.morphs.length, uv = (index: number, k: number) => ({ index, value: [k / 10, 0.25, 0.5, 1 - k / 10] });
  return {
    ...model,
    morphs: [...model.morphs,
      { name: '追加UV1スクロール', englishName: 'auv1', type: 4, uvs: [uv(0, 1), uv(3, 2), uv(11, 3)], panel: 4 }, // first
      { name: '追加UV2', type: 5, uvs: [uv(5, 4)] },
      { name: '追加UV3（空）', type: 6, uvs: [] },
      { name: '追加UV4', type: 7, uvs: [uv(1, 5), uv(2, 6)], panel: 3 },
      { name: 'UVまとめ', type: 0, group: [[first, 1], [first + 3, 0.5], [0, 0.2]] },
    ],
    frames: [...(model.frames ?? []), { name: '追加UV', elements: [0, 1, 2, 3, 4].map(k => ({ morph: true, index: first + k })) }],
  };
}
const UV_MORPHS = { morphs: 3, elements: 6 };

/** The same model with every additional-UV morph's offsets left out: what the conversion serves. */
function withoutUvOffsets(model: PmxWriteModel): PmxWriteModel {
  return { ...model, morphs: model.morphs.map((morph): PmxWriteMorph => morph.type === 4 || morph.type === 5 || morph.type === 6 || morph.type === 7 ? { ...morph, uvs: [] } : morph) };
}

test('today: MMDParser knows the additional-UV morph types but reads no bytes for their offsets, so the load fails, or (all-zero offsets last) frames, bodies and joints silently vanish', () => {
  for (const indexSizes of INDEX_SIZES)
    assert.throws(() => mmdParse(arrayBuffer(withEncoding(withUvMorphs(richModel({ additionalUv: 2, indexSizes })), 0)), true), RangeError, JSON.stringify(indexSizes));
  const quiet: PmxWriteModel = { ...richModel({ additionalUv: 1 }), morphs: [...richModel().morphs, { name: '追加UV1', type: 4, uvs: [{ index: 0, value: [0, 0, 0, 0] }] }] };
  const parsed = mmdParse(arrayBuffer(withEncoding(quiet, 0)), true) as unknown as Parsed21;
  assert.deepEqual([parsed.frames.length, parsed.rigidBodies.length, parsed.constraints.length], [0, 0, 0], 'loads, without its display frames, rigid bodies and joints');
  const served = mmdParse(arrayBuffer(preparePmxForMmdParser(withEncoding(quiet, 0)).bytes), true) as unknown as Parsed21;
  assert.deepEqual([served.frames.length, served.rigidBodies.length, served.constraints.length], [3, 3, 2]);
});

test('additional-UV morphs with offsets are emptied in place (type, name, panel and index kept): byte for byte the model written with empty ones', () => {
  for (const indexSizes of INDEX_SIZES) {
    const label = `UV morphs ${JSON.stringify(indexSizes)}`, model = withUvMorphs(richModel({ additionalUv: 2, indexSizes }));
    const input = withEncoding(model, 0), before = Uint8Array.from(input), result = preparePmxForMmdParser(input);
    assert.ok(result.changed, `${label}: ${result.changed ? '' : `${result.reason} ${result.detail ?? ''}`}`);
    assert.equal(Buffer.compare(result.bytes, withEncoding(withoutUvOffsets(model), 0)), 0, label);
    assert.deepEqual(result.additionalUvMorphs, UV_MORPHS, label);
    assert.equal(result.downgrade, null); assert.equal(result.fromUtf8, false); assert.equal(result.textFields, 0); assert.equal(result.version, '2.0');
    // Exactly the six offsets (vertex index + four floats) are gone; the type bytes are untouched.
    assert.equal(input.length - result.bytes.length, 6 * ((indexSizes?.vertex ?? 4) + 16), label);
    assert.deepEqual(readPmxHeader(result.bytes), { version: '2.0', encoding: 0, additionalUv: 2 });
    assert.equal(Buffer.compare(input, before), 0, `${label}: the input is not modified`);
  }
  const result = preparePmxForMmdParser(withEncoding(withUvMorphs(richModel({ additionalUv: 2 })), 0));
  assert.ok(result.changed);
  assert.equal(describePmxPreparation(result), '3 additional-uv morphs emptied (6 uv offsets dropped)');
});

test("MMDParser and MMDLoader read the served file exactly like the twin with empty additional-UV morphs: types 4-7 kept, groups and frames intact", () => {
  for (const indexSizes of INDEX_SIZES) {
    const model = withUvMorphs(richModel({ additionalUv: 2, indexSizes }));
    const parsed = mmdParse(arrayBuffer(preparePmxForMmdParser(withEncoding(model, 0)).bytes), true) as unknown as Parsed21 & { vertices: { auvs: number[][] }[] };
    assert.deepStrictEqual(parsed, mmdParse(arrayBuffer(withEncoding(withoutUvOffsets(model), 0)), true));
    assert.deepEqual(parsed.morphs.map(morph => morph.name), model.morphs.map(morph => morph.name));
    assert.deepEqual(parsed.morphs.map(morph => morph.type), [1, 1, 0, 2, 3, 8, 1, 4, 5, 6, 7, 0]);
    assert.deepEqual(parsed.morphs.slice(7, 11).map(morph => morph.elementCount), [0, 0, 0, 0]);
    assert.deepEqual(parsed.morphs.slice(7, 11).map(morph => morph.panel), [4, 1, 1, 3]);
    assert.deepEqual(parsed.morphs[11].elements.map(element => element.index), [7, 10, 0]);
    assert.deepEqual(parsed.frames.at(-1)!.elements.map(element => parsed.morphs[element.index].name), ['追加UV1スクロール', '追加UV2', '追加UV3（空）', '追加UV4', 'UVまとめ']);
    assert.deepEqual([parsed.frames.length, parsed.rigidBodies.length, parsed.constraints.length], [4, 3, 2]);
    assert.equal(parsed.vertices[5].auvs.length, 2, 'the additional UVs themselves are kept');
  }
  const model = withUvMorphs(richModel({ additionalUv: 2 }));
  const served = loaderMeshOf(preparePmxForMmdParser(withEncoding(model, 0)).bytes), twin = loaderMeshOf(withEncoding(withoutUvOffsets(model), 0));
  assert.deepEqual(served.morphTargetDictionary, twin.morphTargetDictionary);
  assert.deepEqual(Object.keys(served.morphTargetDictionary!), model.morphs.map(morph => morph.name));
  served.geometry.morphAttributes.position.forEach((target, k) => assert.deepEqual(target.array, twin.geometry.morphAttributes.position[k].array, `morph target ${k}`));
  assert.deepStrictEqual(served.geometry.userData.MMD, twin.geometry.userData.MMD);
});

test('UTF-8 text, the 2.1 downgrade and additional-UV morphs in one pass', () => {
  for (const indexSizes of INDEX_SIZES) {
    const label = `all three ${JSON.stringify(indexSizes)}`, model = withUvMorphs(readable21({ indexSizes })), expected = downgraded(withoutUvOffsets(model));
    for (const encoding of [0, 1] as const) {
      const result = preparePmxForMmdParser(withEncoding(model, encoding));
      assert.ok(result.changed, label);
      assert.equal(Buffer.compare(result.bytes, expected), 0, `${label} encoding ${encoding}`);
      assert.deepEqual(result.additionalUvMorphs, UV_MORPHS); assert.deepEqual(result.downgrade, READABLE21_DOWNGRADE); assert.equal(result.fromUtf8, encoding === 1);
    }
  }
  const result = preparePmxForMmdParser(withEncoding(withUvMorphs(readable21()), 1));
  assert.ok(result.changed);
  assert.match(describePmxPreparation(result), /^utf-8 text -> utf-16le \(\d+ fields\); pmx 2\.1 -> 2\.0: 2 qdef vertices .*; 3 additional-uv morphs emptied \(6 uv offsets dropped\)$/);
  const parsed = mmdParse(arrayBuffer(result.bytes), true) as unknown as Parsed21;
  assert.deepEqual(parsed.morphs.map(morph => morph.type), [1, 1, 0, 2, 3, 8, 1, 0, 0, 0, 0, 4, 5, 6, 7, 0]);
});

test('only files that may hold additional-UV morphs are walked for them: a UTF-16 2.0 file declaring no additional UVs (Gene) is not, in the app and the lab alike', () => {
  // Without additional UVs a UTF-16 2.0 file is not walked: even a body cut short comes back as 'utf16-2.0', not 'malformed'.
  assertPreparedUntouched(withEncoding(richModel(), 0).slice(0, 200), 'utf16-2.0', 'no additional UVs, cut short');
  assertPreparedUntouched(withEncoding(richModel({ additionalUv: 1 }), 0).slice(0, 200), 'malformed', 'with additional UVs it is walked');
  // Offsets in additional-UV morphs of a file that declares no additional UVs (no channel for them to move) stay in a UTF-16 2.0 file:
  // the app's header check does not pick the file up and the lab, sharing that check, fails on it just as the app does.
  const stray = withUvMorphs(richModel());
  assertPreparedUntouched(withEncoding(stray, 0), 'utf16-2.0', 'UTF-16 2.0 with stray additional-UV morphs');
  assert.throws(() => parsePmx(withEncoding(stray, 0)), /PMX parse failed/);
  // A file that is read whole anyway (UTF-8 or 2.1) has them emptied.
  const utf8 = preparePmxForMmdParser(withEncoding(stray, 1));
  assert.ok(utf8.changed); assert.deepEqual(utf8.additionalUvMorphs, UV_MORPHS);
  assert.equal(Buffer.compare(utf8.bytes, withEncoding(withoutUvOffsets(stray), 0)), 0);
});

test('truncated or damaged files with additional-UV morphs come back untouched, without throwing', (t) => {
  const full = withEncoding(withUvMorphs(richModel({ additionalUv: 1, indexSizes: INDEX_SIZES[0] })), 0);
  for (let cut = 10; cut < full.length; cut++) assertPreparedUntouched(full.slice(0, cut), 'malformed', `cut at ${cut} of ${full.length}`);
  t.diagnostic(`${full.length} bytes, cut at every byte from 10`);

  const base = withUvMorphs(richModel({ additionalUv: 1, indexSizes: INDEX_SIZES[1] }));
  const marked: PmxWriteModel = { ...base, morphs: [...base.morphs, { name: 'm', type: 5, uvs: [{ index: 0, value: [1234.5, 0, 0, 0] }] }] };
  // The element count sits before the vertex index (2 bytes at these sizes).
  const countAt = (bytes: Uint8Array) => find(bytes, new Uint8Array(new Float32Array([1234.5]).buffer)) - 2 - 4;
  const cases: [string, (bytes: Uint8Array) => void][] = [
    ['additional-UV element count past the end', bytes => setI32(bytes, countAt(bytes), 0x7fffffff)],
    ['negative additional-UV element count', bytes => setI32(bytes, countAt(bytes), -1)],
    ['additional-UV morph type 8 offsets read as material elements', bytes => { bytes[countAt(bytes) - 1] = 8; }],
  ];
  for (const [label, patch] of cases) { const bytes = withEncoding(marked, 0); patch(bytes); assertPreparedUntouched(bytes, 'malformed', label); }

  let state = 24680;
  const random = () => (state = (state * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const good = withEncoding(base, 0);
  for (let trial = 0; trial < 400; trial++) {
    const bytes = Uint8Array.from(good), at = 11 + Math.floor(random() * (bytes.length - 11));
    bytes[at] = Math.floor(random() * 256);
    const copy = Uint8Array.from(bytes);
    const result = preparePmxForMmdParser(bytes);
    assert.deepEqual(bytes, copy);
    if (!result.changed) assert.equal(result.bytes, bytes);
  }
});

test('mmd-asset: a UTF-16 2.0 file with additional UVs is read whole, served with emptied additional-UV morphs when it has offsets, else exactly as before', async () => {
  const fixture = protocolFixture();
  try {
    const model = withUvMorphs(richModel({ additionalUv: 2 })), expected = withEncoding(withoutUvOffsets(model), 0);
    const files: [string, Uint8Array][] = [['uv.pmx', withEncoding(model, 0)], ['uv-none.pmx', withEncoding(richModel({ additionalUv: 2 }), 0)], ['stray.pmx', withEncoding(withUvMorphs(richModel()), 0)]];
    for (const [name, bytes] of files) writeFileSync(path.join(fixture.directory, name), bytes);
    const token = new URL((await fixture.registry.register(path.join(fixture.directory, 'uv.pmx'))).url).hostname;
    const url = (name: string) => `mmd-asset://${token}/${name}`;
    const handler = createAssetProtocolHandler(fixture.spied), legacy = legacyHandler(fixture.ports);

    const { fetchFile, readFile: reads, readHead } = { ...fixture.calls };
    const get = await handler(new Request(url('uv.pmx')));
    assert.equal(get.status, 200); assert.equal(get.headers.get('Content-Length'), String(expected.length)); assert.equal(get.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(get.headers.get('X-PMX-Conversion'), '3 additional-uv morphs emptied (6 uv offsets dropped)');
    const body = new Uint8Array(await get.arrayBuffer());
    assert.equal(Buffer.compare(body, expected), 0);
    assert.equal((mmdParse(arrayBuffer(body), true) as unknown as Parsed21).morphs.length, model.morphs.length);
    const head = await handler(new Request(url('uv.pmx'), { method: 'HEAD' }));
    assert.equal(head.headers.get('Content-Length'), String(expected.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.deepEqual([fixture.calls.fetchFile - fetchFile, fixture.calls.readHead - readHead, fixture.calls.readFile - reads], [0, 2, 2]);
    assert.equal(Buffer.compare(readFileSync(path.join(fixture.directory, 'uv.pmx')), files[0][1]), 0, 'the file on disk is unchanged');

    // Additional UVs but no offsets: read whole (the header cannot tell), nothing to change, served by net.fetch as before.
    // Offsets in a file declaring no additional UVs: header only, as before (and MMDParser fails on it, as before).
    for (const [name, wholeReads] of [['uv-none.pmx', 1], ['stray.pmx', 0]] as const) for (const method of ['GET', 'HEAD']) {
      const before = fixture.calls.readFile;
      const now = await snapshot(await handler(new Request(url(name), { method })));
      assert.equal(fixture.calls.readFile - before, wholeReads, `${method} ${name}: whole-file reads`);
      assert.deepStrictEqual(now, await snapshot(await legacy(new Request(url(name), { method }))), `${method} ${name}`);
      assert.ok(!now.headers.some(([key]) => key === 'x-pmx-conversion'));
    }
  } finally { fixture.cleanup(); }
});

test('the model profile and the lab treat a humanoid with additional-UV morphs exactly like the twin with empty ones; the report notes what was dropped', () => {
  const base = pmxFromModelData(toyModel({ ik: true, twist: true }), { name: 'トイ' });
  const model: PmxWriteModel = { ...base, additionalUv: 1, morphs: [...base.morphs, { name: '頬UV', type: 4, uvs: [0, 5, 9, 14].map(index => ({ index, value: [0.1, 0, 0, 0] })) }] };
  const bytes = writePmx(model), twin = writePmx(withoutUvOffsets(model));
  assert.throws(() => mmdParse(arrayBuffer(bytes), true), 'without the conversion the app cannot load it');
  const fromModel = profileOf(parsePmx(bytes));
  assert.deepStrictEqual(fromModel, profileOf(parsePmx(twin)));
  assert.deepEqual(CORE_BONES.filter(bone => fromModel.bones.missing.includes(bone)), []);
  assert.deepEqual(MORPH_SLOTS.filter(slot => fromModel.morphs[slot].index < 0), ['mouthPucker'], 'the synthetic face has no pucker');
  const motions = loadBundledMotions(), analyze = (input: Uint8Array) => analyzeModel({ id: 'uv', file: 'uv.pmx', path: 'uv', bytes: input }, motions);
  const a = analyze(bytes), b = analyze(twin);
  assert.equal(a.ok, true, a.error ?? ''); assert.equal(a.motions.length, 76);
  assert.deepStrictEqual(stripReport(a), stripReport(b));
  assert.deepEqual(a.conversion, { fromUtf8: false, textFields: 0, replacedTextFields: 0, downgrade: null, additionalUvMorphs: { morphs: 1, elements: 4 } });
  assert.equal(b.conversion, null, 'the twin (an empty additional-UV morph) needs nothing');
  const markdown = renderModelMarkdown(a, 'now');
  assert.match(markdown, /追加 UV 表情清空 1 个（丢弃 4 个 UV 偏移；/); assert.doesNotMatch(markdown, /PMX 2\.1/);
});

test('walking a ≈100k-vertex UTF-16 2.0 with additional UVs that needs no change stays cheap', (t) => {
  const utf16 = withEncoding(largeUtf8Model(), 0), runs: number[] = [];
  assert.equal(readPmxHeader(utf16)?.additionalUv, 1);
  for (let k = 0; k < 5; k++) {
    const start = performance.now(), result = preparePmxForMmdParser(utf16); runs.push(performance.now() - start);
    assert.equal(result.changed, false); assert.equal(result.bytes, utf16);
  }
  runs.sort((a, b) => a - b);
  t.diagnostic(`100k vertices, ${(utf16.length / 1e6).toFixed(1)} MB UTF-16 2.0 with 1 additional UV, nothing to change: median ${runs[2].toFixed(1)} ms (min ${runs[0].toFixed(1)}, max ${runs[4].toFixed(1)})`);
  assert.ok(runs[2] < 1000, `median ${runs[2]} ms`);
});
