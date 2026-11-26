/**
 * I-152 step 1 (docs/claude/2026-11-19-model-adapter-and-vrm-display.md): every place that takes a model file now takes .vrm, and
 * the safety lines stay where they were:
 * - the model content key (keyForModel) still accepts only an absolute local path of a model file and keys it by the content's
 *   sha256: never a URL or a relative path, never another extension (.glb, .gltf, .vmd, .json …);
 * - the agent channel's load_model takes a .vrm only with the user's own words and a 允许 in the soft hearts dialog (sensitive:
 *   loading a file), and refuses other file types before anything is asked;
 * - the asset protocol serves a .vrm from the approved model folder, and still nothing else outside its list;
 * - a new card is named after the VRM's own meta name.
 * Mutation entries: scripts/dev/mutations/safety.json (VRM-1 … VRM-3).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { AppSettings } from '../shared/foundation/settings';
import { MODEL_DIALOG_EXTENSIONS, MODEL_FILE_EXTENSIONS, isModelFileExtension, modelExtensionOf, modelFormatOf } from '../shared/foundation/model-format';
import { glbJsonEnd, glbWithJson, readGlbJson, readVrmModelName } from '../shared/foundation/glb-json';
import { BlushCalibrationStore, isModelKeyPath } from '../electron/mood/blush-calibration';
import { AssetRegistry } from '../electron/foundation/assets';
import { readModelIdentity } from '../electron/cards/character-model-link';
import { AgentToolRegistry, type AgentConfirmRequest } from '../electron/safety/agent-channel/registry';
import type { FileSystemPort } from '../electron/safety/agent-channel/validate';
import { createAppTools, type AgentAppBridge } from '../electron/safety/agent-channel/app-tools';
import { syntheticVrm } from './helpers/synthetic-vrm';

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'vrm-native-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('the model formats: one list, any case, URLs and file names', () => {
  assert.deepEqual([...MODEL_FILE_EXTENSIONS], ['.pmx', '.pmd', '.vrm']);
  assert.deepEqual([...MODEL_DIALOG_EXTENSIONS], ['pmx', 'pmd', 'vrm']);
  for (const ok of ['.pmx', '.PMD', '.Vrm']) assert.equal(isModelFileExtension(ok), true, ok);
  for (const no of ['.glb', '.gltf', '.vmd', '.json', '.png', '', 'vrm', '.vrm.exe']) assert.equal(isModelFileExtension(no), false, no);
  assert.equal(modelFormatOf('C:\\m\\Mumi.VRM'), 'vrm');
  assert.equal(modelFormatOf('mmd-asset://0123/%E8%8F%B2.pmx'), 'mmd');
  assert.equal(modelFormatOf(`mmd-asset://abc/${encodeURIComponent('她 的.vrm')}`), 'vrm');
  assert.equal(modelFormatOf('mmd-asset://abc/model.vrm?x=1#y'), 'vrm');
  assert.equal(modelFormatOf('model.glb'), null);
  assert.equal(modelFormatOf(''), null);
  assert.equal(modelExtensionOf('a/b.c/d'), '');
});

test('keyForModel: a .vrm is keyed by its content like a .pmx; URLs, relative paths and other file types are refused before any read', async () => {
  for (const ok of ['Mumi.vrm', 'Gene.PMX', 'x.pmd', 'Mumi.VRM']) assert.equal(isModelKeyPath(path.resolve('/m', ok)), true, ok);
  for (const no of ['Mumi.vrm', 'mmd-asset://abc/Mumi.vrm', 'https://example.invalid/Mumi.vrm', 'file:///C:/m/Mumi.vrm', path.resolve('/m/Mumi.glb'),
    path.resolve('/m/Mumi.gltf'), path.resolve('/m/pose.vmd'), path.resolve('/m/Mumi.vrm.json'), path.resolve('/m/Mu\0mi.vrm'), path.resolve('/m/' + 'a'.repeat(33_000) + '.vrm'), 42, null])
    assert.equal(isModelKeyPath(no), false, String(no).slice(0, 60));
  await withDir(async dir => {
    const store = new BlushCalibrationStore(path.join(dir, 'profile'));
    await store.load();
    const models = path.join(dir, 'PRIVATE_MODELS'); await mkdir(models);
    const bytes = Buffer.from(syntheticVrm());
    const vrm = path.join(models, 'Mumi.vrm'), copy = path.join(models, 'copy.pmx'), glb = path.join(models, 'Mumi.glb');
    await writeFile(vrm, bytes); await writeFile(copy, bytes); await writeFile(glb, bytes);
    const expected = createHash('sha256').update(bytes).digest('hex');
    assert.equal(await store.keyForModel(vrm), expected, 'the content hash, nothing of the path');
    assert.equal(await store.keyForModel(copy), expected, 'the same bytes under another name: the same key');
    await assert.rejects(store.keyForModel(glb), /PMX\/PMD\/VRM/);
    await assert.rejects(store.keyForModel('Mumi.vrm'));
    await assert.rejects(store.keyForModel('mmd-asset://abc/Mumi.vrm'));
    await assert.rejects(store.keyForModel('https://example.invalid/Mumi.vrm'));
  });
});

test('the asset protocol serves a .vrm from the approved folder and still refuses other types', async () => {
  await withDir(async dir => {
    await writeFile(path.join(dir, 'Mumi.vrm'), syntheticVrm()); await writeFile(path.join(dir, 'Mumi.glb'), 'x'); await writeFile(path.join(dir, 'notes.txt'), 'x');
    const assets = new AssetRegistry();
    const ref = await assets.register(path.join(dir, 'Mumi.vrm'));
    assert.match(ref.url, /^mmd-asset:\/\/[0-9a-f]{32}\/Mumi\.vrm$/);
    assert.equal(await assets.resolve(ref.url), path.join(await import('node:fs/promises').then(fs => fs.realpath(dir)), 'Mumi.vrm'));
    const token = new URL(ref.url).hostname;
    await assert.rejects(assets.resolve(`mmd-asset://${token}/Mumi.glb`), /不支持的资源类型/);
    await assert.rejects(assets.resolve(`mmd-asset://${token}/notes.txt`), /不支持的资源类型/);
  });
});

test('a new card for a VRM is named after the VRM itself (1.0 meta.name, 0.x meta.title); the JSON chunk is read whole', async () => {
  for (const version of ['1.0', '0.x'] as const) {
    const bytes = syntheticVrm({ version });
    assert.equal(readVrmModelName(bytes), 'Synthetic', version);
    assert.ok(glbJsonEnd(bytes)! > 20);
    const json = readGlbJson(bytes)!;
    (json.extensions as Record<string, { meta: Record<string, string> }>)[version === '1.0' ? 'VRMC_vrm' : 'VRM'].meta[version === '1.0' ? 'name' : 'title'] = 'ミュミ';
    const renamed = glbWithJson(bytes, json);
    assert.equal(readVrmModelName(renamed), 'ミュミ');
    assert.deepEqual(renamed.subarray(glbJsonEnd(renamed)!), bytes.subarray(glbJsonEnd(bytes)!), 'the binary chunk is kept byte for byte');
    await withDir(async dir => {
      // A JSON chunk longer than the 16 KB header read: pad the meta so the name sits past it.
      const long = readGlbJson(bytes)!;
      (long.asset as Record<string, unknown>).copyright = 'x'.repeat(40_000);
      const file = path.join(dir, 'folder', 'Mumi.vrm');
      await mkdir(path.dirname(file)); await writeFile(file, glbWithJson(bytes, long));
      const identity = await readModelIdentity(file, { bundled: false });
      assert.equal(identity.newName, 'Synthetic');
      assert.deepEqual(identity.names, ['Synthetic', 'folder', 'Mumi']);
    });
  }
  assert.equal(readVrmModelName(new Uint8Array([1, 2, 3])), null);
  assert.equal(readVrmModelName(glbWithJson(syntheticVrm(), { asset: { version: '2.0' } })), null, 'a glTF without a VRM extension is not a VRM');
});

// ---- load_model through the agent channel: the real tool definition, a stubbed host -------------------------------------------
function channel(file: { size?: number } = {}) {
  const settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
  settings.model = { path: 'C:\\m\\gene.pmx', url: 'local://gene', name: 'gene.pmx' };
  const loads: string[] = [];
  const bridge = {
    version: () => '0.1.0', settings: () => structuredClone(settings), characters: () => ({ activeId: 'a', cards: [] }),
    windows: () => ({ pet: { visible: true, minimized: false }, controls: { visible: true, minimized: false } }),
    loadModel: async (path_: string) => { loads.push(path_); settings.model = { path: path_, url: 'local://x', name: path.win32.basename(path_) }; return { name: path.win32.basename(path_) }; },
    interconnected: () => true,
  } as unknown as AgentAppBridge;
  const fs: FileSystemPort = { realpath: async value => value, stat: async () => ({ isFile: () => true, size: file.size ?? 10, mtimeMs: 1 }) };
  const asked: AgentConfirmRequest[] = [];
  let answer = true;
  const registry = new AgentToolRegistry(createAppTools(bridge, { fs, platform: 'win32' }), {
    enabled: () => true, interconnect: () => true, confirm: async request => { asked.push(request); return answer; } });
  return { registry, asked, loads, deny: () => { answer = false; } };
}

test('load_model takes a .vrm only with the user\'s words and a 允许 in the dialog; other types are refused before anything is asked', async () => {
  const words = channel();
  const noWords = await words.registry.call('load_model', { path: 'C:\\m\\Mumi.vrm' });
  assert.equal(noWords.ok, false, 'no words: refused');
  assert.equal(words.asked.length, 0); assert.deepEqual(words.loads, []);

  const yes = channel();
  const loaded = await yes.registry.call('load_model', { path: 'C:\\m\\Mumi.vrm', userWords: '换成 Mumi 的 VRM' });
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(yes.asked.length, 1, 'the dialog opened even with the words (loading a file is sensitive)');
  assert.equal(yes.asked[0].title, 'Claude 请求载入一个模型（MMD 或 VRM）');
  assert.match(yes.asked[0].detail, /文件：Mumi\.vrm/);
  assert.match(yes.asked[0].detail, /你在 Claude 里说：「换成 Mumi 的 VRM」/);
  assert.deepEqual(yes.loads, ['C:\\m\\Mumi.vrm']);

  const no = channel(); no.deny();
  const denied = await no.registry.call('load_model', { path: 'C:\\m\\Mumi.vrm', userWords: '换成 Mumi' });
  assert.equal(denied.ok, false, 'the user pressed 不允许');
  assert.deepEqual(no.loads, []);

  for (const bad of ['C:\\m\\Mumi.glb', 'C:\\m\\Mumi.gltf', 'C:\\m\\Mumi.vrm.exe', 'mmd-asset://abc/Mumi.vrm', 'https://example.invalid/Mumi.vrm', 'Mumi.vrm']) {
    const f = channel();
    const result = await f.registry.call('load_model', { path: bad, userWords: '换成它' });
    assert.equal(result.ok, false, bad);
    assert.equal(f.asked.length, 0, `${bad}: refused before the dialog`);
    assert.deepEqual(f.loads, []);
  }
});
