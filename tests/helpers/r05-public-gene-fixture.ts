import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bone, Matrix3, ShaderMaterial, SkinnedMesh, Texture, Vector3 } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
// Three.js r170 does not publish declarations for its bundled MMD parser.
// @ts-expect-error Bundled parser has no TypeScript declaration; local interface below scopes its use.
import { MMDParser } from 'three/examples/jsm/libs/mmdparser.module.js';
import { probeBlushAnchors } from '../../src/stage/procedural-blush';

interface PublicGeneData {
  morphs: { type: number; name: string; elements: { index: number }[] }[];
}
interface PublicGeneParserModule {
  Parser: new () => { parsePmx(buffer: ArrayBuffer, leftToRight: boolean): PublicGeneData };
}
interface InertTexture extends Texture { readyCallbacks: unknown[] }
interface FixtureMmdLoader {
  meshBuilder: {
    materialBuilder: { _loadTexture: (...args: unknown[]) => InertTexture };
    build(data: PublicGeneData, resourcePath: string): SkinnedMesh;
  };
}
export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const frozenSource = 'tests/fixtures';
export const sourcePins = {
  [`${frozenSource}/r05-legacy-cheek-projection.ts`]: 'a9a0be4948aef1a983dd3c5d24b802a62659a1902d8888c03b34651ad29c5cbd',
  'src/stage/procedural-blush.ts': null,
  'assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/model/gene.pmx': '0ef63a75a7699f58399ae655357f91542fc5209355aac925a589aac42669df37',
};
export const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function loadPublicGene() {
  const identities = [];
  for (const [relative, expected] of Object.entries(sourcePins)) {
    const bytes = await readFile(path.join(repo, relative));
    const actual = sha(bytes);
    if (expected !== null) assert.equal(actual, expected, relative);
    identities.push({ path: relative, sha256: actual, bytes: bytes.length });
  }
  const modelPath = Object.keys(sourcePins)[2];
  const bytes = await readFile(path.join(repo, modelPath));
  const data = new (MMDParser as PublicGeneParserModule).Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, true);
  const loader = new MMDLoader() as unknown as FixtureMmdLoader;
  const textures: Texture[] = [];
  loader.meshBuilder.materialBuilder._loadTexture = () => {
    const texture = new Texture() as InertTexture;
    texture.readyCallbacks = [];
    textures.push(texture);
    return texture;
  };
  const mesh = loader.meshBuilder.build(data, '') as SkinnedMesh;
  const materials = mesh.material as ShaderMaterial[];
  const bone = (name: string) => mesh.skeleton.bones.find((value) => value.name === name) as Bone;
  const head = bone('頭'), eyes = [bone('左目'), bone('右目')];
  assert.ok(head && eyes.every(Boolean));
  mesh.updateWorldMatrix(true, true); mesh.skeleton.update();
  const probe = probeBlushAnchors(mesh, head, eyes);
  assert.ok(probe.anchors, probe.reason);
  const anchors = probe.anchors;
  const eyeMidpoint = new Vector3().fromArray(anchors.leftEye).add(new Vector3().fromArray(anchors.rightEye)).multiplyScalar(0.5);
  const right = new Vector3().fromArray(anchors.right), up = new Vector3().fromArray(anchors.up), forward = new Vector3().fromArray(anchors.forward);
  const toHead = head.matrixWorld.clone().invert().multiply(mesh.matrixWorld);
  const normalMatrix = new Matrix3().getNormalMatrix(toHead);
  const toFrame = (point: Vector3) => {
    const offset = point.clone().sub(eyeMidpoint);
    return { x: offset.dot(right) / anchors.eyeDistance, y: offset.dot(up) / anchors.eyeDistance, z: offset.dot(forward) / anchors.eyeDistance };
  };
  const materialVertices = materials.map((material, materialIndex) => {
    const indices = new Set<number>();
    for (const group of mesh.geometry.groups.filter((group) => group.materialIndex === materialIndex)) {
      for (let i = group.start; i < group.start + group.count; i++) indices.add(mesh.geometry.index!.getX(i));
    }
    return { name: material.name, index: materialIndex, points: [...indices].map((index) => {
      const point = mesh.getVertexPosition(index, new Vector3()).applyMatrix4(toHead);
      const attribute = mesh.geometry.getAttribute('normal');
      const normal = new Vector3().fromBufferAttribute(attribute, index).applyNormalMatrix(normalMatrix);
      return { index, point, normal, ...toFrame(point), facing: normal.dot(forward) };
    }) };
  });
  return {
    mesh, head, eyes, materials, anchors, probe, data, identities, eyeMidpoint, right, up, forward, materialVertices, toFrame,
    dispose() { mesh.geometry.dispose(); materials.forEach((material) => material.dispose()); textures.forEach((texture) => texture.dispose()); mesh.skeleton.dispose(); },
  };
}
