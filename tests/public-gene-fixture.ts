import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SkinnedMesh, Texture } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';

interface InertTexture extends Texture { readyCallbacks: unknown[] }
interface FixtureLoader {
  meshBuilder: {
    materialBuilder: { _loadTexture: (...args: unknown[]) => InertTexture };
    build(data: unknown, resourcePath: string): SkinnedMesh;
  };
}
interface ParserModule {
  MMDParser: { Parser: new () => { parsePmx(buffer: ArrayBuffer, leftToRight: boolean): unknown } };
}

// New target-binding use only. No geometry calibration, renderer or asset copy.
// Inert texture substitution follows the frozen R05 public-Gene fixture.
export async function loadPublicGeneForTargets() {
  // Both the isolated source and the repository keep public assets beside tests/.
  const model = new URL('../assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/model/gene.pmx', import.meta.url);
  const bytes = await readFile(model);
  assert.equal(bytes.length, 2814228);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '0ef63a75a7699f58399ae655357f91542fc5209355aac925a589aac42669df37');
  return meshFromPmx(bytes);
}

/**
 * The public Gene with her parsed data changed in memory before the mesh is built (the file is never touched): a public stand-in for
 * a structure only private models have (docs/claude/2026-11-20-mumi-eye-skin.md: irises raised to fill the eye opening).
 */
export async function loadPublicGeneEdited(edit: (data: { bones: { name: string; position: number[] }[] }) => void) {
  const model = new URL('../assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/model/gene.pmx', import.meta.url);
  return meshFromPmx(await readFile(model), edit);
}

/**
 * Development: another PMX the same way (inert textures, read only), for checking the showcase on other models. Not used by
 * the test suite, which runs on the public Gene only.
 */
export async function loadPmxForTargets(file: string | URL) {
  return meshFromPmx(await readFile(file));
}

async function meshFromPmx(bytes: Buffer, edit?: (data: { bones: { name: string; position: number[] }[] }) => void) {
  const parserModule = 'three/examples/jsm/libs/mmdparser.module.js';
  const { MMDParser } = await import(parserModule) as ParserModule;
  const data = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, true);
  edit?.(data as { bones: { name: string; position: number[] }[] });
  const loader = new MMDLoader() as unknown as FixtureLoader;
  const textures: Texture[] = [];
  loader.meshBuilder.materialBuilder._loadTexture = (...args: unknown[]) => {
    const texture = new Texture() as InertTexture;
    texture.userData = { path: typeof args[0] === 'string' ? args[0] : null }; // which file (development renders read it; the suite never does)
    texture.readyCallbacks = []; textures.push(texture); return texture;
  };
  const mesh = loader.meshBuilder.build(data, '');
  return { mesh, close() {
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
    textures.forEach(texture => texture.dispose());
    mesh.skeleton.dispose();
  } };
}
