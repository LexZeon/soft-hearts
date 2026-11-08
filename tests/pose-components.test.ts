import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ComponentInstallError, PoseComponentStore, defaultComponentRoot } from '../electron/pose/component-store';
import { POSE_MANIFEST, POSE_MODEL_FILES, downloadBytes, installedBytes, officialDownloadBytes, posePlatform, type ManifestArchive, type PoseManifest } from '../electron/pose/manifest';
import { fakeFetch, integrity, makeTgz, makeZip, sha256 } from './helpers/pose-archives';

// A miniature manifest with the same shape as the real one: an npm tarball with shared and per-platform files,
// a zip fetched by range request (entry nested in a folder), and a zip downloaded whole. No network anywhere.
const bytes = (text: string, size = 4096) => Buffer.from(text.repeat(Math.ceil(size / text.length)).slice(0, size));
const runtimeJs = bytes('module.exports = 1;\n', 900), binding = bytes('ARM64-BINDING', 20_000), bindingX64 = bytes('X64-BINDING', 18_000);
const detector = bytes('DETECTOR-ONNX', 60_000), pose = bytes('POSE-ONNX', 90_000);
const tgz = makeTgz([
  { name: 'package.json', data: Buffer.from('{"name":"onnxruntime-node"}') },
  { name: 'dist/index.js', data: runtimeJs },
  { name: 'bin/napi-v6/win32/arm64/onnxruntime_binding.node', data: binding },
  { name: 'bin/napi-v6/win32/x64/onnxruntime_binding.node', data: bindingX64 },
  { name: 'bin/napi-v6/linux/x64/onnxruntime_binding.node', data: bytes('LINUX', 5000) },
]);
const detectorZip = makeZip([{ name: 'rtmpose-cpu/rtmpose-ort/rtmpose-m/end2end.onnx', data: bytes('OTHER-MODEL', 30_000) },
  { name: 'rtmpose-cpu/rtmpose-ort/rtmdet-nano/end2end.onnx', data: detector }, { name: 'rtmpose-cpu/README.md', data: bytes('readme', 500) }], 200_000);
const poseZip = makeZip([{ name: '20230831/rtmpose_onnx/rtmpose-m/end2end.onnx', data: pose }, { name: '20230831/rtmpose_onnx/rtmpose-m/pipeline.json', data: Buffer.from('{}') }]);
const URLS = { tgz: 'https://registry.example/ort.tgz', det: 'https://models.example/rtmpose-cpu.zip', pose: 'https://models.example/pose.zip' };

function manifest(version = 1, overrides: Partial<Record<'tgz' | 'det' | 'pose', Partial<ManifestArchive>>> = {}): PoseManifest {
  const archives: ManifestArchive[] = [
    { id: 'onnxruntime-node', kind: 'tgz', url: URLS.tgz, size: tgz.length, integrity: integrity(tgz), networkBytes: tgz.length,
      files: { all: [{ from: 'dist/index.js', to: 'runtime/node_modules/onnxruntime-node/dist/index.js', size: runtimeJs.length, sha256: sha256(runtimeJs) }],
        'win32-arm64': [{ from: 'bin/napi-v6/win32/arm64/onnxruntime_binding.node', to: 'runtime/node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/onnxruntime_binding.node', size: binding.length, sha256: sha256(binding) }],
        'win32-x64': [{ from: 'bin/napi-v6/win32/x64/onnxruntime_binding.node', to: 'runtime/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node', size: bindingX64.length, sha256: sha256(bindingX64) }] },
      ...overrides.tgz },
    { id: 'rtmdet-nano', kind: 'zip', url: URLS.det, size: detectorZip.length, sha256: sha256(detectorZip), rangeEntry: true, networkBytes: 70_000,
      files: { all: [{ from: 'rtmdet-nano/end2end.onnx', to: POSE_MODEL_FILES.detector, size: detector.length, sha256: sha256(detector) }] }, ...overrides.det },
    { id: 'rtmpose-m-body7', kind: 'zip', url: URLS.pose, size: poseZip.length, sha256: sha256(poseZip), networkBytes: poseZip.length,
      files: { all: [{ from: 'end2end.onnx', to: POSE_MODEL_FILES.pose, size: pose.length, sha256: sha256(pose) }] }, ...overrides.pose },
  ];
  return { version, archives, generated: [{ to: 'runtime/node_modules/onnxruntime-node/package.json', text: '{"main":"dist/index.js"}\n' }] };
}
const served = (overrides: Partial<Record<'tgz' | 'det' | 'pose', Buffer>> = {}) =>
  new Map([[URLS.tgz, overrides.tgz ?? tgz], [URLS.det, overrides.det ?? detectorZip], [URLS.pose, overrides.pose ?? poseZip]]);

function fixture(t: { after(fn: () => void): void }, options: { manifest?: PoseManifest; files?: Map<string, Buffer>; ranges?: boolean; fail?: (url: string, call: number) => boolean; root?: string } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'pose-components-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = options.root ?? path.join(base, 'components'), licenses = path.join(base, 'licenses');
  mkdirSync(licenses, { recursive: true });
  writeFileSync(path.join(licenses, 'onnxruntime-LICENSE.txt'), 'MIT License\n');
  const net = fakeFetch(options.files ?? served(), { ranges: options.ranges, fail: options.fail });
  const make = (m = options.manifest ?? manifest()) => new PoseComponentStore({ root, platform: 'win32-arm64', manifest: m, fetch: net.fetch, licenseDir: licenses });
  return { base, root, licenses, net, store: make(), make };
}
const tree = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/')).sort() : [];

test('download only after the call, verify every file, activate atomically with licences and marker', async t => {
  const f = fixture(t);
  assert.equal(await f.store.refresh(), false);
  assert.equal(f.net.calls.length, 0, 'checking the state never touches the network');
  const progress: number[] = [];
  await f.store.install(new AbortController().signal, p => progress.push(p.done / Math.max(1, p.total)));
  assert.equal(f.store.installed, true);
  const dir = path.join(f.root, 'pose-v1', 'win32-arm64');
  assert.deepEqual(tree(dir), ['installed.json', 'licenses/onnxruntime-LICENSE.txt', POSE_MODEL_FILES.detector, POSE_MODEL_FILES.pose,
    'runtime/node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/onnxruntime_binding.node',
    'runtime/node_modules/onnxruntime-node/dist/index.js', 'runtime/node_modules/onnxruntime-node/package.json'].sort());
  assert.deepEqual(readFileSync(path.join(dir, POSE_MODEL_FILES.detector)), detector);
  assert.ok(!tree(dir).some(file => file.includes('linux') || file.includes('x64')), 'only this platform is kept');
  assert.deepEqual(tree(f.root).filter(file => !file.startsWith('pose-v1/')), [], 'no staging, archive or .partial left');
  // RTMDet-nano came by range requests: the 200 kB of padding and the other model were never fetched.
  const detCalls = f.net.calls.filter(call => call.url === URLS.det);
  assert.ok(detCalls.length >= 2 && detCalls.every(call => call.range));
  assert.ok(f.net.bytes() < tgz.length + poseZip.length + detector.length + 140_000);
  assert.equal(progress.at(-1), 1);
  const paths = f.store.runtimePaths()!;
  for (const value of [paths.runtimeEntry, paths.detector, paths.pose]) assert.ok(path.isAbsolute(value) && value.startsWith(f.root));
  const reopened = f.make();
  assert.equal(await reopened.refresh(), true, 'state survives a restart');
});

test('a tampered archive or entry is rejected, nothing is activated and no partial file stays', async t => {
  const evilTgz = makeTgz([{ name: 'dist/index.js', data: bytes('evil();\n', 900) }, { name: 'bin/napi-v6/win32/arm64/onnxruntime_binding.node', data: binding }]);
  const f = fixture(t, { files: served({ tgz: evilTgz }) });
  await assert.rejects(f.store.install(new AbortController().signal), (error: unknown) => error instanceof ComponentInstallError && error.failure === 'verify-failed');
  assert.equal(f.store.installed, false);
  assert.equal(existsSync(path.join(f.root, 'pose-v1')), false);
  assert.ok(!tree(f.root).some(file => file.endsWith('.partial') || file.endsWith('.tgz')));
  // Range download: the archive hash cannot be checked, so one changed byte in the model itself must be caught.
  const changed = Buffer.concat([detector.subarray(0, 100), Buffer.from('X'), detector.subarray(101)]);
  const tamperedZip = makeZip([{ name: 'rtmpose-cpu/rtmpose-ort/rtmdet-nano/end2end.onnx', data: changed }]);
  const g = fixture(t, { files: served({ det: tamperedZip }), manifest: manifest(1, { det: { size: tamperedZip.length, sha256: sha256(tamperedZip) } }) });
  await assert.rejects(g.store.install(new AbortController().signal), (error: unknown) => error instanceof ComponentInstallError && error.failure === 'verify-failed');
  assert.equal(g.store.installed, false);
  assert.ok(g.net.calls.filter(call => call.url === URLS.det).every(call => call.range), 'it really was the range path');
});

test('the whole-archive hash is checked even when every kept file inside looks right', async t => {
  // Same kept files, one extra entry: a different tarball than the one in the manifest is refused before extraction.
  const repacked = makeTgz([{ name: 'dist/index.js', data: runtimeJs }, { name: 'bin/napi-v6/win32/arm64/onnxruntime_binding.node', data: binding }, { name: 'install.js', data: Buffer.from('evil()') }]);
  const f = fixture(t, { files: served({ tgz: repacked }), manifest: manifest(1, { tgz: { size: repacked.length } }) });
  await assert.rejects(f.store.install(new AbortController().signal), (error: unknown) => error instanceof ComponentInstallError && error.failure === 'verify-failed');
  assert.equal(f.store.installed, false);
});

test('a server without range support falls back to the whole zip, still verified', async t => {
  const f = fixture(t, { ranges: false });
  await f.store.install(new AbortController().signal);
  assert.equal(f.store.installed, true);
  assert.ok(f.net.calls.some(call => call.url === URLS.det && !call.range));
});

test('network failure keeps verified parts; the retry fetches only what is missing; cancel reports canceled', async t => {
  let failPose = true;
  const f = fixture(t, { fail: url => url === URLS.pose && failPose });
  await assert.rejects(f.store.install(new AbortController().signal), (error: unknown) => error instanceof ComponentInstallError && error.failure === 'download-failed');
  assert.equal(f.store.installed, false);
  const before = f.net.calls.filter(call => call.url === URLS.tgz).length;
  failPose = false;
  await f.store.install(new AbortController().signal);
  assert.equal(f.store.installed, true);
  assert.equal(f.net.calls.filter(call => call.url === URLS.tgz).length, before, 'the tarball was not downloaded twice');
  const g = fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(g.store.install(controller.signal), (error: unknown) => error instanceof ComponentInstallError && error.failure === 'canceled');
});

test('offline import: archives or bare model files are recognised only by size and hash; others are rejected', async t => {
  const f = fixture(t, { fail: () => true }); // no network at all
  const dir = path.join(f.base, 'usb'); mkdirSync(dir);
  const write = (name: string, data: Buffer) => { const file = path.join(dir, name); writeFileSync(file, data); return file; };
  const wrong = write('end2end.onnx', bytes('NOT-THE-MODEL', pose.length));
  const partial = await f.store.importFiles([write('ort.tgz', tgz), wrong]);
  assert.deepEqual(partial, { accepted: 1, rejected: 1, complete: false });
  assert.equal(f.store.installed, false);
  const done = await f.store.importFiles([write('det_rtmdet_nano.onnx', detector), write('rtmpose-m.zip', poseZip)]);
  assert.deepEqual(done, { accepted: 2, rejected: 0, complete: true });
  assert.equal(f.store.installed, true);
  assert.equal(f.net.calls.length, 0, 'import never uses the network');
  assert.deepEqual(readFileSync(path.join(f.root, 'pose-v1', 'win32-arm64', POSE_MODEL_FILES.pose)), pose);
  assert.ok(existsSync(wrong), 'the user’s own files are left alone');
});

test('delete removes every version and leftover; old versions are cleaned once the new one is active and reused files are not downloaded again', async t => {
  const f = fixture(t);
  await f.store.install(new AbortController().signal);
  mkdirSync(path.join(f.root, '.download'), { recursive: true }); writeFileSync(path.join(f.root, '.download', 'x.partial'), 'x');
  await f.store.refresh();
  assert.equal(existsSync(path.join(f.root, '.download')), false, 'leftover partial downloads are removed at startup');
  // Component version 2: the runtime changes, the two models stay byte-identical.
  const tgz2 = makeTgz([{ name: 'dist/index.js', data: bytes('module.exports = 2;\n', 900) }, { name: 'bin/napi-v6/win32/arm64/onnxruntime_binding.node', data: binding }]);
  const js2 = bytes('module.exports = 2;\n', 900);
  const v2 = manifest(2, { tgz: { size: tgz2.length, integrity: integrity(tgz2), networkBytes: tgz2.length,
    files: { all: [{ from: 'dist/index.js', to: 'runtime/node_modules/onnxruntime-node/dist/index.js', size: js2.length, sha256: sha256(js2) }],
      'win32-arm64': [{ from: 'bin/napi-v6/win32/arm64/onnxruntime_binding.node', to: 'runtime/node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/onnxruntime_binding.node', size: binding.length, sha256: sha256(binding) }] } } });
  f.net.calls.length = 0;
  const g = fixture(t, { files: served({ tgz: tgz2 }), manifest: v2, root: f.root });
  assert.equal(await g.store.refresh(), false, 'a new component version is not installed yet');
  assert.ok(existsSync(path.join(f.root, 'pose-v1')), 'the old version stays until the new one is active');
  await g.store.install(new AbortController().signal);
  assert.deepEqual([...new Set(g.net.calls.map(call => call.url))], [URLS.tgz], 'the models were reused from version 1');
  assert.equal(existsSync(path.join(f.root, 'pose-v1')), false, 'version 1 was cleaned up');
  assert.ok(existsSync(path.join(f.root, 'pose-v2', 'win32-arm64', POSE_MODEL_FILES.pose)));
  await g.store.remove();
  assert.equal(g.store.installed, false);
  assert.deepEqual(readdirSync(f.root), []);
  assert.equal(g.store.runtimePaths(), null);
});

test('route cache: only route names and milliseconds, cleared by re-detect', async t => {
  const f = fixture(t);
  await f.store.install(new AbortController().signal);
  await f.store.writeRoute({ fingerprint: 'abc', route: 'dml', dmlBad: false, p90: { dml: 12.5, cpu: 44 } });
  assert.deepEqual(await f.store.readRoute(), { fingerprint: 'abc', route: 'dml', dmlBad: false, p90: { dml: 12.5, cpu: 44 } });
  writeFileSync(path.join(f.root, 'pose-v1', 'win32-arm64', 'route.json'), JSON.stringify({ fingerprint: 'x', route: 'npu', dmlBad: false, p90: { dml: 1, cpu: 1 } }));
  assert.equal(await f.store.readRoute(), null, 'an unknown route is ignored');
  await f.store.clearRoute();
  assert.equal(await f.store.readRoute(), null);
});

test('real manifest: Windows ARM64/x64 only, every file hashed, base download and installed size as told to the user', () => {
  assert.equal(posePlatform('win32', 'arm64'), 'win32-arm64');
  assert.equal(posePlatform('win32', 'x64'), 'win32-x64');
  assert.equal(posePlatform('darwin', 'arm64'), null);
  for (const archive of POSE_MANIFEST.archives) {
    assert.ok(archive.url.startsWith('https://registry.npmjs.org/') || archive.url.startsWith('https://download.openmmlab.com/'), archive.url);
    assert.ok(archive.sha256 ? /^[0-9a-f]{64}$/.test(archive.sha256) : /^sha512-[A-Za-z0-9+/]{86}==$/.test(archive.integrity ?? ''));
    for (const files of Object.values(archive.files)) for (const file of files ?? []) assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
  // First download: our 30.6 / 29.5 MB runtime pack + 50.8 MB pose zip + ~3.8 MB detector range.
  assert.equal(Math.round(downloadBytes(POSE_MANIFEST, 'win32-arm64') / 1e6), 85);
  assert.equal(Math.round(downloadBytes(POSE_MANIFEST, 'win32-x64') / 1e6), 84);
  // Fallback: the 115.4 MB npm runtime tarball (all platforms, npm only publishes it whole) + 0.07 MB + the same models.
  assert.equal(Math.round(officialDownloadBytes(POSE_MANIFEST, 'win32-arm64') / 1e6), 170);
  assert.equal(Math.round(installedBytes(POSE_MANIFEST, 'win32-arm64') / 1e6), 132);
  assert.equal(Math.round(installedBytes(POSE_MANIFEST, 'win32-x64') / 1e6), 127);
  assert.equal(defaultComponentRoot({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }), path.join('C:\\Users\\u\\AppData\\Local', 'soft-hearts-claude', 'components'));
  assert.equal(defaultComponentRoot({}), null);
  assert.ok(!defaultComponentRoot({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })!.includes('Roaming'));
});
