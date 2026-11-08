// Small per-platform runtime pack on the project's GitHub Release: pack first,
// official npm tarballs as the fallback, every byte checked. Fake download sources only; no network anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ComponentInstallError, PoseComponentStore, type ComponentProgress } from '../electron/pose/component-store';
import { PoseSensingHost } from '../electron/pose/host';
import {
  POSE_ARCHIVES, POSE_MANIFEST, POSE_MODEL_FILES, POSE_PACK_REPLACES, POSE_PLATFORMS, archiveFiles, downloadBytes, officialDownloadBytes, packProblem,
  posePackFiles, type ManifestArchive, type ManifestPack, type PoseManifest,
} from '../electron/pose/manifest';
import { parsePoseView, type PoseSensingView } from '../shared/pose-signals';
import { setUiLanguage } from '../shared/ui-language';
import { poseStatusText } from '../src/ui/PoseSensingPanel';
import { fakeFetch, integrity, makeTgz, makeZip, sha256 } from './helpers/pose-archives';

// ------------------------------------------------------------ a miniature of the real manifest, with a pack

const bytes = (text: string, size: number) => Buffer.from(text.repeat(Math.ceil(size / text.length)).slice(0, size));
const NODE = 'runtime/node_modules/onnxruntime-node', COMMON = 'runtime/node_modules/onnxruntime-common';
const js = bytes('module.exports = 1;\n', 900), binding = bytes('ARM64-BINDING', 20_000), dll = bytes('ARM64-DLL', 40_000);
const bindingX64 = bytes('X64-BINDING', 18_000), commonJs = bytes('exports.common = 1;\n', 700);
const detector = bytes('DETECTOR-ONNX', 60_000), pose = bytes('POSE-ONNX', 90_000);
const nodeTgz = makeTgz([
  { name: 'package.json', data: Buffer.from('{"name":"onnxruntime-node"}') }, { name: 'dist/index.js', data: js },
  { name: 'bin/napi-v6/win32/arm64/onnxruntime_binding.node', data: binding }, { name: 'bin/napi-v6/win32/arm64/onnxruntime.dll', data: dll },
  { name: 'bin/napi-v6/win32/x64/onnxruntime_binding.node', data: bindingX64 }, { name: 'bin/napi-v6/linux/x64/libonnxruntime.so', data: bytes('LINUX', 80_000) },
]);
const commonTgz = makeTgz([{ name: 'package.json', data: Buffer.from('{}') }, { name: 'dist/cjs/index.js', data: commonJs }]);
const detZip = makeZip([{ name: 'rtmpose-cpu/rtmdet-nano/end2end.onnx', data: detector }]);
const poseZip = makeZip([{ name: '20230831/rtmpose-m/end2end.onnx', data: pose }]);
const URLS = {
  node: 'https://registry.example/onnxruntime-node.tgz', common: 'https://registry.example/onnxruntime-common.tgz',
  det: 'https://models.example/rtmpose-cpu.zip', pose: 'https://models.example/pose.zip',
  pack: 'https://github.com/LexZeon/soft-hearts/releases/download/pose-components-v1/soft-hearts-pose-runtime-v1-win32-arm64.tgz',
};
const kept = (from: string, dir: string, data: Buffer) => ({ from, to: `${dir}/${from}`, size: data.length, sha256: sha256(data) });
const archives: ManifestArchive[] = [
  { id: 'onnxruntime-node', kind: 'tgz', url: URLS.node, size: nodeTgz.length, integrity: integrity(nodeTgz), networkBytes: nodeTgz.length,
    files: { all: [kept('dist/index.js', NODE, js)],
      'win32-arm64': [kept('bin/napi-v6/win32/arm64/onnxruntime_binding.node', NODE, binding), kept('bin/napi-v6/win32/arm64/onnxruntime.dll', NODE, dll)],
      'win32-x64': [kept('bin/napi-v6/win32/x64/onnxruntime_binding.node', NODE, bindingX64)] } },
  { id: 'onnxruntime-common', kind: 'tgz', url: URLS.common, size: commonTgz.length, integrity: integrity(commonTgz), networkBytes: commonTgz.length,
    files: { all: [kept('dist/cjs/index.js', COMMON, commonJs)] } },
  { id: 'rtmdet-nano', kind: 'zip', url: URLS.det, size: detZip.length, sha256: sha256(detZip), networkBytes: detZip.length,
    files: { all: [{ from: 'rtmdet-nano/end2end.onnx', to: POSE_MODEL_FILES.detector, size: detector.length, sha256: sha256(detector) }] } },
  { id: 'rtmpose-m-body7', kind: 'zip', url: URLS.pose, size: poseZip.length, sha256: sha256(poseZip), networkBytes: poseZip.length,
    files: { all: [{ from: 'end2end.onnx', to: POSE_MODEL_FILES.pose, size: pose.length, sha256: sha256(pose) }] } },
];
const replaces = ['onnxruntime-node', 'onnxruntime-common'];
const packFiles = posePackFiles(archives, replaces, 'win32-arm64');
const packData = new Map<string, Buffer>([[`${NODE}/dist/index.js`, js], [`${NODE}/bin/napi-v6/win32/arm64/onnxruntime_binding.node`, binding],
  [`${NODE}/bin/napi-v6/win32/arm64/onnxruntime.dll`, dll], [`${COMMON}/dist/cjs/index.js`, commonJs]]);
/** Built the way scripts/pose-release-pack.ts builds the real one: kept files at their `to` paths, licences, a manifest. */
const makePack = (data = packData) => makeTgz([...[...data].map(([name, body]) => ({ name, data: body })),
  { name: 'licenses/onnxruntime-LICENSE.txt', data: Buffer.from('MIT License\n') }, { name: 'PACK-MANIFEST.json', data: Buffer.from('{}') }],
'soft-hearts-pose-runtime-v1-win32-arm64');
const goodPack = makePack();
const packEntry = (data: Buffer = goodPack, over: Partial<ManifestPack> = {}): ManifestPack => ({ id: 'pose-runtime-win32-arm64', kind: 'tgz', url: URLS.pack,
  size: data.length, sha256: sha256(data), networkBytes: data.length, replaces, files: { 'win32-arm64': packFiles }, ...over });
const manifest = (pack: ManifestPack | null = packEntry()): PoseManifest => ({ version: 1, archives,
  generated: [{ to: `${NODE}/package.json`, text: '{"main":"dist/index.js"}\n' }], ...(pack ? { packs: { 'win32-arm64': pack } } : {}) });
const served = (pack: Buffer | null = goodPack) => new Map<string, Buffer>([[URLS.node, nodeTgz], [URLS.common, commonTgz], [URLS.det, detZip], [URLS.pose, poseZip],
  ...(pack ? [[URLS.pack, pack] as [string, Buffer]] : [])]);

function rig(t: { after(fn: () => void): void }, options: { manifest?: PoseManifest; files?: Map<string, Buffer>; fail?: (url: string) => boolean; cut?: (url: string) => boolean } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'pose-pack-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'components'), licenses = path.join(base, 'licenses');
  mkdirSync(licenses, { recursive: true });
  writeFileSync(path.join(licenses, 'onnxruntime-LICENSE.txt'), 'MIT License\n');
  const net = fakeFetch(options.files ?? served(), { fail: options.fail, cut: options.cut });
  const store = new PoseComponentStore({ root, platform: 'win32-arm64', manifest: options.manifest ?? manifest(), fetch: net.fetch, licenseDir: licenses });
  return { base, root, net, store, dir: path.join(root, 'pose-v1', 'win32-arm64') };
}
const tree = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
  .map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/')).sort() : [];
const contents = (dir: string) => new Map(tree(dir).filter(file => file !== 'installed.json').map(file => [file, sha256(readFileSync(path.join(dir, file)))]));
const urls = (net: { calls: { url: string }[] }) => [...new Set(net.calls.map(call => call.url))];
const failure = (kind: string) => (error: unknown) => error instanceof ComponentInstallError && error.failure === kind;

// ------------------------------------------------------------ the store

test('small pack: the runtime comes from the Release pack, npm is never touched, the folder is identical to an npm install', async t => {
  const viaPack = rig(t);
  assert.equal(viaPack.store.downloadBytes, goodPack.length + detZip.length + poseZip.length, 'the question shows the small number');
  const progress: ComponentProgress[] = [];
  await viaPack.store.install(new AbortController().signal, p => progress.push(p));
  assert.equal(viaPack.store.installed, true);
  assert.deepEqual(urls(viaPack.net), [URLS.pack, URLS.det, URLS.pose]);
  assert.ok(progress.every(p => !p.fallback), 'nothing to explain when the pack worked');
  assert.equal(progress.at(-1)!.done, progress.at(-1)!.total);
  // The same install from the official tarballs only (no pack in the manifest) leaves byte-identical files.
  const viaNpm = rig(t, { manifest: manifest(null) });
  await viaNpm.store.install(new AbortController().signal);
  assert.deepEqual(contents(viaPack.dir), contents(viaNpm.dir));
  assert.ok(!tree(viaPack.dir).some(file => file.includes('PACK-MANIFEST') || file.includes('x64') || file.includes('linux')), 'only the kept files');
  assert.deepEqual(tree(viaPack.root).filter(file => !file.startsWith('pose-v1/')), [], 'no download, staging or .partial left');
  assert.equal(viaPack.net.bytes(), viaPack.store.downloadBytes, 'exactly the number the question promised');
});

test('small pack with a wrong hash: discarded, reported, nothing installed; the retry goes to the official tarballs and says so', async t => {
  const tampered = makePack(new Map([...packData, [`${NODE}/bin/napi-v6/win32/arm64/onnxruntime.dll`, bytes('EVIL-DLL!', dll.length)]]));
  const r = rig(t, { files: served(tampered) }); // the manifest still has the good pack's size and hash
  await assert.rejects(r.store.install(new AbortController().signal), failure('verify-failed'));
  assert.equal(r.store.installed, false);
  assert.deepEqual(urls(r.net), [URLS.pack], 'no silent switch, nothing else fetched');
  assert.equal(existsSync(r.dir), false);
  assert.ok(!tree(r.root).some(file => file.endsWith('.partial') || file.endsWith('.tgz') || file.includes('onnxruntime')), 'the temporary file is gone, nothing was staged');
  assert.equal(r.store.downloadBytes, r.store.officialDownloadBytes, 'from now on the honest number is the official one');
  const progress: ComponentProgress[] = [];
  await r.store.install(new AbortController().signal, p => progress.push(p));
  assert.equal(r.store.installed, true);
  assert.ok(progress.every(p => p.fallback === true), 'the whole retry is labelled as the official download');
  assert.equal(progress[0].total, nodeTgz.length + commonTgz.length + detZip.length + poseZip.length);
  assert.deepEqual(urls(r.net), [URLS.pack, URLS.node, URLS.common, URLS.det, URLS.pose], 'the pack was not tried again');
  // Even when the pack's own hash matches the manifest, each file inside is still checked against the official hash.
  const g = rig(t, { files: served(tampered), manifest: manifest(packEntry(tampered)) });
  await assert.rejects(g.store.install(new AbortController().signal), failure('verify-failed'));
  assert.equal(g.store.installed, false);
  // Same kept files plus one extra entry: refused on the pack's own SHA-256 before anything is extracted.
  const repacked = makeTgz([...[...packData].map(([name, data]) => ({ name, data })), { name: 'install.js', data: Buffer.from('evil()') }],
    'soft-hearts-pose-runtime-v1-win32-arm64');
  const k = rig(t, { files: served(repacked), manifest: manifest(packEntry(goodPack, { size: repacked.length, networkBytes: repacked.length })) });
  await assert.rejects(k.store.install(new AbortController().signal), failure('verify-failed'));
  assert.equal(k.store.installed, false);
  // A pack bigger than expected is refused while it is still streaming.
  const big = Buffer.concat([goodPack, Buffer.alloc(10)]);
  const h = rig(t, { files: served(big) });
  await assert.rejects(h.store.install(new AbortController().signal), failure('verify-failed'));
  assert.ok(!tree(h.root).some(file => file.endsWith('.partial')));
});

test('small pack cut off halfway: no half file stays, the official tarballs are fetched instead and the progress says so', async t => {
  const r = rig(t, { cut: url => url === URLS.pack });
  const progress: ComponentProgress[] = [];
  await r.store.install(new AbortController().signal, p => progress.push(p));
  assert.equal(r.store.installed, true);
  assert.deepEqual(urls(r.net), [URLS.pack, URLS.node, URLS.common, URLS.det, URLS.pose]);
  const switched = progress.findIndex(p => p.fallback);
  assert.ok(switched > 0 && progress.slice(0, switched).every(p => !p.fallback), 'small pack first, then the fallback');
  assert.deepEqual({ done: progress[switched].done, total: progress[switched].total },
    { done: 0, total: nodeTgz.length + commonTgz.length + detZip.length + poseZip.length }, 'the percentage restarts against the real, bigger total');
  assert.ok(progress.slice(switched).every(p => p.fallback && p.done <= p.total));
  assert.deepEqual(tree(r.root).filter(file => !file.startsWith('pose-v1/')), [], 'the cut-off pack left nothing behind');
  assert.deepEqual(readFileSync(path.join(r.dir, `${NODE}/bin/napi-v6/win32/arm64/onnxruntime.dll`)), dll);
});

test('Release missing (404) falls back; when the official sources are down too, nothing is installed and the next try uses the pack again', async t => {
  const r = rig(t, { files: served(null) });
  await r.store.install(new AbortController().signal);
  assert.equal(r.store.installed, true);
  assert.deepEqual(urls(r.net), [URLS.pack, URLS.node, URLS.common, URLS.det, URLS.pose]);
  let offline = true;
  const g = rig(t, { fail: url => offline && url !== URLS.det && url !== URLS.pose });
  await assert.rejects(g.store.install(new AbortController().signal), failure('download-failed'));
  assert.equal(g.store.installed, false);
  assert.ok(!tree(g.root).some(file => file.endsWith('.partial') || file.endsWith('.tgz')));
  assert.equal(g.store.downloadBytes, goodPack.length + detZip.length + poseZip.length, 'a network failure does not condemn the pack');
  offline = false; g.net.calls.length = 0;
  await g.store.install(new AbortController().signal);
  assert.equal(g.store.installed, true);
  assert.deepEqual(urls(g.net), [URLS.pack, URLS.det, URLS.pose]);
  // Cancelling during the pack does not fall back.
  const c = rig(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(c.store.install(controller.signal), failure('canceled'));
  assert.deepEqual(urls(c.net), []);
});

test('offline import recognises the Release pack by size and hash, together with the official model zips', async t => {
  const r = rig(t, { fail: () => true });
  const usb = path.join(r.base, 'usb'); mkdirSync(usb);
  const put = (name: string, data: Buffer) => { const file = path.join(usb, name); writeFileSync(file, data); return file; };
  const result = await r.store.importFiles([put('soft-hearts-pose-runtime-v1-win32-arm64.tgz', goodPack), put('rtmpose-cpu.zip', detZip), put('pose.zip', poseZip)]);
  assert.deepEqual(result, { accepted: 3, rejected: 0, complete: true });
  assert.equal(r.store.installed, true);
  assert.equal(r.net.calls.length, 0);
  const s = rig(t, { fail: () => true });
  const other = makePack(new Map([...packData, [`${NODE}/dist/index.js`, bytes('evil();\n', js.length)]]));
  assert.deepEqual(await s.store.importFiles([put('x.tgz', other)]), { accepted: 0, rejected: 1, complete: false }, 'a repacked runtime is not recognised');
});

test('a pack that does not hold exactly the official files is refused when the store is created', t => {
  const base = mkdtempSync(path.join(tmpdir(), 'pose-pack-bad-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const make = (pack: ManifestPack) => new PoseComponentStore({ root: path.join(base, 'c'), platform: 'win32-arm64', manifest: manifest(pack),
    fetch: fakeFetch(new Map()).fetch, licenseDir: base });
  assert.throws(() => make(packEntry(goodPack, { files: { 'win32-arm64': packFiles.slice(1) } })), /files/);
  assert.throws(() => make(packEntry(goodPack, { files: { 'win32-arm64': packFiles.map((f, i) => i ? f : { ...f, sha256: sha256(Buffer.from('x')) }) } })), /differs/);
  assert.throws(() => make(packEntry(goodPack, { replaces: ['onnxruntime-node', 'nope'] })), /unknown/);
  assert.doesNotThrow(() => make(packEntry()));
});

// ------------------------------------------------------------ the real manifest

test('real manifest: one pack per platform on this repo\'s Release, exactly the official kept files, about 85 MB instead of 170', () => {
  for (const platform of POSE_PLATFORMS) {
    const pack = POSE_MANIFEST.packs?.[platform];
    assert.ok(pack, platform);
    assert.equal(pack.url, `https://github.com/LexZeon/soft-hearts/releases/download/pose-components-v1/soft-hearts-pose-runtime-v1-${platform}.tgz`);
    assert.match(pack.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual([...pack.replaces], [...POSE_PACK_REPLACES]);
    assert.equal(packProblem(POSE_MANIFEST, platform), null);
    const official = POSE_ARCHIVES.filter(a => pack.replaces.includes(a.id)).flatMap(a => archiveFiles(a, platform));
    assert.deepEqual(archiveFiles(pack, platform).map(f => [f.to, f.size, f.sha256]), official.map(f => [f.to, f.size, f.sha256]));
    assert.ok(archiveFiles(pack, platform).every(f => !f.to.startsWith('models/')), 'the model weights are never in our pack');
    assert.ok(downloadBytes(POSE_MANIFEST, platform) < officialDownloadBytes(POSE_MANIFEST, platform) / 1.9);
  }
  assert.equal(POSE_MANIFEST.packs!['win32-arm64']!.size, 30_611_826);
  assert.equal(POSE_MANIFEST.packs!['win32-x64']!.size, 29_499_386);
});

// ------------------------------------------------------------ what the user reads

test('while falling back the control window shows the real, bigger size; afterwards everything is back to normal', async t => {
  const r = rig(t, { cut: url => url === URLS.pack });
  const views: PoseSensingView[] = [];
  const host = new PoseSensingHost({
    store: r.store,
    fork: () => ({ postMessage: () => {}, onMessage: () => {}, onExit: () => {}, kill: () => {} }),
    channel: () => ({ worker: 1, sensor: 2 }), openSensor: () => ({ close: () => {} }),
    fingerprint: async () => 'gpu', publish: view => views.push(view), disableCamera: () => {}, promptRaised: () => {},
    trayChanged: () => {}, developerMode: () => false, setTimer: () => 0, clearTimer: () => {},
  });
  await host.init();
  assert.equal(host.view().downloadBytes, goodPack.length + detZip.length + poseZip.length);
  const done = await host.download();
  const during = views.filter(view => view.fallback);
  assert.ok(during.length > 0, 'the switch was published');
  assert.ok(during.every(view => view.phase === 'downloading' || view.phase === 'installing'));
  assert.ok(during.every(view => view.downloadBytes === r.store.officialDownloadBytes));
  assert.ok(views.slice(0, views.indexOf(during[0])).every(view => !view.fallback && view.downloadBytes === goodPack.length + detZip.length + poseZip.length));
  assert.equal(done.phase, 'idle');
  assert.equal(done.fallback, undefined);
  assert.equal(done.notice, '');
  // The renderer-side guard keeps the flag and refuses a wrong type.
  assert.equal(parsePoseView(during[0])?.fallback, true);
  assert.equal(parsePoseView({ ...during[0], fallback: 'yes' }), null);
  assert.equal('fallback' in parsePoseView(done)!, false);
});

test('fallback copy: plain words with the real size, in Chinese and English', () => {
  const view: PoseSensingView = { phase: 'downloading', prompt: false, downloadBytes: 170_023_451, installedBytes: 0, progress: 0.12, route: null,
    level: null, componentVersion: 1, notice: '', fallback: true };
  setUiLanguage('zh-CN');
  assert.equal(poseStatusText(view), '小包下载不了，改从官方地址下载（共约 170 MB）… 12%');
  assert.equal(poseStatusText({ ...view, fallback: undefined, downloadBytes: 85_171_644 }), '正在下载本地识别组件… 12%');
  assert.ok(!/DirectML|onnx|DLL|GitHub|npm|error/i.test(poseStatusText(view)));
  setUiLanguage('en');
  try { assert.equal(poseStatusText(view), 'The small package could not be downloaded, so this comes from the official sources instead (about 170 MB)… 12%'); }
  finally { setUiLanguage('zh-CN'); }
});
