// Local recognizer component (electron/asr/manifest.ts on the shared store, electron/pose/component-store.ts):
// plain-file downloads checked by size and SHA-256, the onnxruntime files copied from an installed pose component instead
// of downloaded again, offline import, and the two components never cleaning up each other's folders. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PoseComponentStore } from '../electron/pose/component-store';
import { POSE_ARCHIVES, downloadBytes, officialDownloadBytes, type ManifestArchive, type PoseManifest } from '../electron/pose/manifest';
import { ASR_ARCHIVES, ASR_MANIFEST, ASR_MODEL_FILES, SENSEVOICE_REVISION } from '../electron/asr/manifest';
import { ASR_MODEL_DOWNLOAD_BYTES } from '../electron/asr/host';
import { fakeFetch, integrity, makeTgz, sha256 } from './helpers/pose-archives';

const bytes = (text: string, size: number) => Buffer.from(text.repeat(Math.ceil(size / text.length)).slice(0, size));
const runtimeJs = bytes('module.exports = 1;\n', 900), binding = bytes('ARM64-BINDING', 20_000);
const model = bytes('SENSEVOICE-ONNX', 120_000), tokens = Buffer.from('<unk> 0\n<s> 1\n</s> 2\n今天 3\n');
const tgz = makeTgz([{ name: 'dist/index.js', data: runtimeJs }, { name: 'bin/napi-v6/win32/arm64/onnxruntime_binding.node', data: binding }]);
const URLS = { tgz: 'https://registry.example/ort.tgz', model: 'https://hf.example/model.int8.onnx', tokens: 'https://hf.example/tokens.txt' };
const runtimeArchive: ManifestArchive = { id: 'onnxruntime-node', kind: 'tgz', url: URLS.tgz, size: tgz.length, integrity: integrity(tgz), networkBytes: tgz.length,
  files: { all: [{ from: 'dist/index.js', to: 'runtime/node_modules/onnxruntime-node/dist/index.js', size: runtimeJs.length, sha256: sha256(runtimeJs) }],
    'win32-arm64': [{ from: 'bin/napi-v6/win32/arm64/onnxruntime_binding.node', to: 'runtime/node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/onnxruntime_binding.node', size: binding.length, sha256: sha256(binding) }] } };
const file = (id: string, url: string, to: string, data: Buffer): ManifestArchive =>
  ({ id, kind: 'file', url, size: data.length, sha256: sha256(data), networkBytes: data.length, files: { all: [{ from: to, to, size: data.length, sha256: sha256(data) }] } });
const asrManifest: PoseManifest = { version: 1, archives: [runtimeArchive, file('sensevoice-model', URLS.model, ASR_MODEL_FILES.model, model),
  file('sensevoice-tokens', URLS.tokens, ASR_MODEL_FILES.tokens, tokens)], generated: [{ to: 'runtime/node_modules/onnxruntime-node/package.json', text: '{"main":"dist/index.js"}\n' }] };
const poseManifest: PoseManifest = { version: 1, archives: [runtimeArchive], generated: [] };

function fixture(t: { after(fn: () => void): void }, served = new Map([[URLS.tgz, tgz], [URLS.model, model], [URLS.tokens, tokens]])) {
  const base = mkdtempSync(path.join(tmpdir(), 'asr-components-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'components'), licenses = path.join(base, 'licenses');
  mkdirSync(licenses, { recursive: true });
  writeFileSync(path.join(licenses, 'FunASR-MODEL_LICENSE.txt'), 'FunASR Model Open Source License Agreement\n');
  const net = fakeFetch(served);
  const poseDir = path.join(root, 'pose-v1', 'win32-arm64');
  const asr = new PoseComponentStore({ root: path.join(root, 'asr'), platform: 'win32-arm64', manifest: asrManifest, component: 'asr', fetch: net.fetch,
    licenseDir: licenses, reuseDirs: () => [poseDir] });
  const pose = new PoseComponentStore({ root, platform: 'win32-arm64', manifest: poseManifest, fetch: net.fetch, licenseDir: licenses,
    reuseDirs: () => [path.join(root, 'asr', 'asr-v1', 'win32-arm64')] });
  return { base, root, net, asr, pose, licenses };
}

test('download only on request: plain files are checked by size and SHA-256 and land in asr-v1 with the licence', async t => {
  const f = fixture(t);
  assert.equal(await f.asr.refresh(), false);
  assert.equal(f.net.calls.length, 0);
  await f.asr.install(new AbortController().signal);
  assert.equal(f.asr.installed, true);
  const dir = path.join(f.root, 'asr', 'asr-v1', 'win32-arm64');
  assert.deepEqual(readFileSync(path.join(dir, ...ASR_MODEL_FILES.model.split('/'))), model);
  assert.ok(existsSync(path.join(dir, 'licenses', 'FunASR-MODEL_LICENSE.txt')));
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'installed.json'), 'utf8')).component, 'asr');
  assert.equal(f.asr.installedFile(ASR_MODEL_FILES.model), path.join(dir, 'models', 'sensevoice-small.int8.onnx'));
  assert.equal(f.asr.installedFile('../../evil'), null);
});

test('a tampered model download is rejected and nothing is activated', async t => {
  const bad = Buffer.from(model); bad[100] ^= 1;
  const f = fixture(t, new Map([[URLS.tgz, tgz], [URLS.model, bad], [URLS.tokens, tokens]]));
  await assert.rejects(f.asr.install(new AbortController().signal), (error: { failure?: string }) => error.failure === 'verify-failed');
  assert.equal(f.asr.installed, false);
  assert.ok(!existsSync(path.join(f.root, 'asr', 'asr-v1')));
});

test('the runtime is copied from installed pose sensing (hash-checked), never downloaded twice; and the other way round', async t => {
  const f = fixture(t);
  await f.pose.install(new AbortController().signal);
  f.net.calls.length = 0;
  await f.asr.install(new AbortController().signal);
  assert.deepEqual(f.net.calls.map(call => call.url).sort(), [URLS.model, URLS.tokens], 'only the model and tokens');
  // Pose deleted afterwards: the speech component keeps its own copy.
  await f.pose.remove();
  assert.ok(existsSync(path.join(f.root, 'asr', 'asr-v1', 'win32-arm64', 'runtime', 'node_modules', 'onnxruntime-node', 'dist', 'index.js')));
  assert.equal(await f.asr.refresh(), true);
  // Pose installed again later: its runtime comes from the speech component.
  f.net.calls.length = 0;
  await f.pose.install(new AbortController().signal);
  assert.deepEqual(f.net.calls, []);
});

test('a changed file in the other component is not reused (downloaded instead)', async t => {
  const f = fixture(t);
  await f.pose.install(new AbortController().signal);
  writeFileSync(path.join(f.root, 'pose-v1', 'win32-arm64', 'runtime', 'node_modules', 'onnxruntime-node', 'dist', 'index.js'), bytes('tampered', 900));
  f.net.calls.length = 0;
  await f.asr.install(new AbortController().signal);
  assert.ok(f.net.calls.some(call => call.url === URLS.tgz));
});

test('offline import: the model and tokens files are recognised by size and hash', async t => {
  const f = fixture(t);
  const picked = path.join(f.base, 'picked'); mkdirSync(picked);
  writeFileSync(path.join(picked, 'model.int8.onnx'), model); writeFileSync(path.join(picked, 'tokens.txt'), tokens); writeFileSync(path.join(picked, 'other.txt'), 'x');
  const result = await f.asr.importFiles([path.join(picked, 'model.int8.onnx'), path.join(picked, 'tokens.txt'), path.join(picked, 'other.txt')]);
  assert.deepEqual(result, { accepted: 2, rejected: 1, complete: false });
  f.net.calls.length = 0;
  await f.asr.install(new AbortController().signal);
  assert.deepEqual(f.net.calls.map(call => call.url), [URLS.tgz], 'only the runtime is still fetched');
  assert.ok(existsSync(path.join(picked, 'model.int8.onnx')), 'the picked file is left where it was');
});

test('pose and speech never clean up or delete each other', async t => {
  const f = fixture(t);
  await f.asr.install(new AbortController().signal);
  await f.pose.refresh(); await f.pose.cleanup();
  await f.pose.remove();
  assert.equal(await f.asr.refresh(), true, 'deleting pose sensing leaves the speech component');
  await f.pose.install(new AbortController().signal);
  await f.asr.remove();
  assert.equal(await f.pose.refresh(), true, 'deleting the speech component leaves pose sensing');
  assert.deepEqual(readdirSync(path.join(f.root, 'asr')), []);
});

test('real manifest: the same runtime as pose sensing, the model pinned to the converter\'s commit, sizes as told to the user', () => {
  for (const id of ['onnxruntime-node', 'onnxruntime-common']) assert.equal(ASR_ARCHIVES.find(a => a.id === id), POSE_ARCHIVES.find(a => a.id === id), id);
  const files = ASR_ARCHIVES.filter(archive => archive.kind === 'file');
  assert.deepEqual(files.map(archive => archive.id), ['sensevoice-model', 'sensevoice-tokens']);
  for (const archive of files) {
    assert.ok(archive.url.startsWith(`https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/${SENSEVOICE_REVISION}/`), archive.url);
    assert.match(archive.sha256!, /^[0-9a-f]{64}$/);
  }
  assert.equal(files[0]!.size, 239_233_841);
  // Without pose sensing: the 30.6 MB runtime pack + 239.5 MB model and tokens; if the pack is missing, the 115.5 MB npm tarballs.
  assert.equal(Math.round(downloadBytes(ASR_MANIFEST, 'win32-arm64') / 1e6), 270);
  assert.equal(Math.round(officialDownloadBytes(ASR_MANIFEST, 'win32-arm64') / 1e6), 355);
  // With pose sensing installed: only the model and tokens.
  assert.equal(Math.round(ASR_MODEL_DOWNLOAD_BYTES / 1e6), 240);
  assert.throws(() => new PoseComponentStore({ root: path.resolve('x'), platform: 'win32-arm64', manifest: { version: 1, generated: [],
    archives: [{ ...files[0]!, files: { all: [{ ...files[0]!.files.all![0]!, size: 1 }] } }] }, component: 'asr', fetch: fakeFetch(new Map()).fetch, licenseDir: '.' }));
  assert.throws(() => new PoseComponentStore({ root: path.resolve('x'), platform: 'win32-arm64', manifest: ASR_MANIFEST, component: '../asr', fetch: fakeFetch(new Map()).fetch, licenseDir: '.' }));
});
