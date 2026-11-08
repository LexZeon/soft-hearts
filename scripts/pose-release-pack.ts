// Maintainer tool for the per-platform pose runtime packs on the GitHub Release (docs/claude/2026-11-03-pose-small-package.md).
//
//   Build:  node node_modules/tsx/dist/cli.mjs scripts/pose-release-pack.ts build --official <dir> --out <dir>
//           <dir> holds onnxruntime-node-1.31.1.tgz and onnxruntime-common-1.31.1.tgz exactly as downloaded from the
//           npm registry URLs in electron/pose/manifest.ts. Each tarball is checked against the registry integrity in
//           the manifest, each kept file against its SHA-256, then the files are written unchanged (only split by
//           platform) into a deterministic .tgz with the licence texts and a PACK-MANIFEST.json, plus
//           <pack>.manifest.json and SHA256SUMS.txt next to it. Same inputs and Node version → same bytes.
//   Verify: node node_modules/tsx/dist/cli.mjs scripts/pose-release-pack.ts verify --dir <dir>
//           Checks the .tgz files in <dir> (e.g. downloaded back from the Release) against the sizes and SHA-256 that
//           the app has built in, and every file inside against the official hashes. Never uploads anything.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { extractTarGz } from '../electron/pose/archive';
import {
  POSE_ARCHIVES, POSE_COMPONENT_VERSION, POSE_MANIFEST, POSE_PACK_REPLACES, POSE_PLATFORMS, archiveFiles, packProblem, posePackFiles, posePackName,
  type ManifestArchive, type ManifestFile, type PosePlatform,
} from '../electron/pose/manifest';

const LICENSE_DIR = path.resolve('electron/pose/licenses');
/** Fixed timestamp for every tar entry (2026-11-03 00:00 UTC) so the pack bytes do not depend on when it was built. */
const PACK_MTIME = Date.UTC(2026, 10, 3) / 1000;

/** Where each licence text in electron/pose/licenses came from (written into the pack manifest). */
const LICENSE_SOURCES: Record<string, string> = {
  'README.txt': 'written by this project (sources and terms of every component)',
  'onnxruntime-LICENSE.txt': 'https://github.com/microsoft/onnxruntime/blob/v1.31.1/LICENSE',
  'onnxruntime-ThirdPartyNotices.txt': 'https://github.com/microsoft/onnxruntime/blob/v1.31.1/ThirdPartyNotices.txt',
  'DirectML-LICENSE.txt': 'LICENSE.txt in the Microsoft.AI.DirectML 1.15.4 NuGet package (https://www.nuget.org/packages/Microsoft.AI.DirectML/1.15.4)',
  'DirectML-ThirdPartyNotices.txt': 'ThirdPartyNotices.txt in the Microsoft.AI.DirectML 1.15.4 NuGet package',
  'DirectXShaderCompiler-LICENSE.txt': 'https://github.com/microsoft/DirectXShaderCompiler/blob/v1.8.2502/LICENSE.TXT',
  'DirectXShaderCompiler-ThirdPartyNotices.txt': 'https://github.com/microsoft/DirectXShaderCompiler/blob/v1.8.2502/ThirdPartyNotices.txt',
};

/** Licence of one kept file, by what it is (all of them come from the onnxruntime-node / onnxruntime-common 1.31.1 packages). */
function licenseOf(file: ManifestFile): { component: string; version: string; license: string; licenseFiles: string[] } {
  const name = path.posix.basename(file.to);
  if (name === 'DirectML.dll') return { component: 'DirectML (inside onnxruntime-node)', version: '1.15.4',
    license: 'Microsoft DirectML license terms', licenseFiles: ['licenses/DirectML-LICENSE.txt', 'licenses/DirectML-ThirdPartyNotices.txt'] };
  if (name === 'dxcompiler.dll') return { component: 'DirectX Shader Compiler (inside onnxruntime-node)', version: '1.8.2502',
    license: 'University of Illinois/NCSA Open Source License (LLVM Release License) and the notices in its ThirdPartyNotices',
    licenseFiles: ['licenses/DirectXShaderCompiler-LICENSE.txt', 'licenses/DirectXShaderCompiler-ThirdPartyNotices.txt'] };
  return { component: file.to.includes('onnxruntime-common') ? 'onnxruntime-common' : 'onnxruntime-node', version: '1.31.1', license: 'MIT',
    licenseFiles: ['licenses/onnxruntime-LICENSE.txt', ...(name.endsWith('.dll') || name.endsWith('.node') ? ['licenses/onnxruntime-ThirdPartyNotices.txt'] : [])] };
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const integrity = (data: Uint8Array) => `sha512-${createHash('sha512').update(data).digest('base64')}`;
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

// ---------------------------------------------------------------- deterministic ustar writer

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  let base = name, prefix = '';
  if (Buffer.byteLength(name) > 100) { // ustar: split at the first slash that leaves a name of ≤100 bytes; prefix ≤155
    let at = name.indexOf('/');
    while (at > 0 && Buffer.byteLength(name.slice(at + 1)) > 100) at = name.indexOf('/', at + 1);
    if (at <= 0 || Buffer.byteLength(name.slice(0, at)) > 155) throw new Error(`name too long for ustar: ${name}`);
    prefix = name.slice(0, at); base = name.slice(at + 1);
  }
  header.write(base, 0, 'utf8');
  header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(size.toString(8).padStart(11, '0') + '\0', 124);
  header.write(PACK_MTIME.toString(8).padStart(11, '0') + '\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257); header.write('00', 263);
  header.write('root', 265); header.write('root', 297);
  if (prefix) header.write(prefix, 345, 'utf8');
  let sum = 0; for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return header;
}
function writeTgz(top: string, entries: { path: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    parts.push(tarHeader(`${top}/${entry.path}`, entry.data.length), entry.data, Buffer.alloc((512 - (entry.data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

// ---------------------------------------------------------------- build

async function officialFiles(dir: string, archive: ManifestArchive, platform: PosePlatform): Promise<Map<ManifestFile, Buffer>> {
  const file = path.join(dir, path.posix.basename(new URL(archive.url).pathname));
  const data = readFileSync(file);
  if (data.length !== archive.size || integrity(data) !== archive.integrity) throw new Error(`${file} is not the official ${archive.id} tarball`);
  return extractTarGz(file, archiveFiles(archive, platform)); // every kept file checked against its SHA-256
}

async function build(official: string, out: string): Promise<void> {
  mkdirSync(out, { recursive: true });
  const licenseNames = readdirSync(LICENSE_DIR).filter(name => name.endsWith('.txt')).sort();
  for (const name of licenseNames) if (!LICENSE_SOURCES[name]) throw new Error(`no recorded source for licence ${name}`);
  const sums: string[] = [];
  for (const platform of POSE_PLATFORMS) {
    const name = posePackName(platform);
    const kept = new Map<string, { file: ManifestFile; data: Buffer; archive: ManifestArchive }>();
    for (const archive of POSE_ARCHIVES.filter(a => (POSE_PACK_REPLACES as readonly string[]).includes(a.id)))
      for (const [file, data] of await officialFiles(official, archive, platform)) kept.set(file.to, { file, data, archive });
    const expected = posePackFiles(POSE_ARCHIVES, POSE_PACK_REPLACES, platform);
    if (kept.size !== expected.length) throw new Error(`${platform}: ${kept.size} files, manifest keeps ${expected.length}`);
    const licenses = licenseNames.map(file => ({ path: `licenses/${file}`, data: readFileSync(path.join(LICENSE_DIR, file)) }));
    const manifest = {
      pack: `${name}.tgz`, componentVersion: POSE_COMPONENT_VERSION, platform,
      madeBy: 'soft hearts next (https://github.com/LexZeon/soft-hearts), scripts/pose-release-pack.ts',
      what: 'The ONNX Runtime files soft hearts next keeps for this platform, taken unchanged from the official npm packages and only split by platform. No file was modified, recompiled or re-signed. The model weights are not in this pack; the app downloads them from OpenMMLab.',
      sources: POSE_ARCHIVES.filter(a => (POSE_PACK_REPLACES as readonly string[]).includes(a.id)).map(a => ({
        id: a.id, url: a.url, version: '1.31.1', bytes: a.size, integrity: a.integrity, license: 'MIT', licenseUrl: 'https://github.com/microsoft/onnxruntime/blob/v1.31.1/LICENSE' })),
      files: expected.map(file => {
        const item = kept.get(file.to);
        if (!item) throw new Error(`${platform}: missing ${file.to}`);
        return { path: file.to, bytes: item.data.length, sha256: sha256(item.data), sourceUrl: item.archive.url, sourcePath: `package/${item.file.from}`, ...licenseOf(file) };
      }),
      licenses: licenses.map(entry => ({ path: entry.path, bytes: entry.data.length, sha256: sha256(entry.data), source: LICENSE_SOURCES[path.posix.basename(entry.path)] })),
    };
    for (const file of manifest.files) if (file.sha256 !== expected.find(e => e.to === file.path)!.sha256) throw new Error(`hash drift: ${file.path}`);
    const inner = Buffer.from(`${JSON.stringify(manifest, null, 1)}\n`);
    const tgz = writeTgz(name, [...[...kept.values()].map(item => ({ path: item.file.to, data: item.data })), ...licenses, { path: 'PACK-MANIFEST.json', data: inner }]);
    // Read it back with the app's own extractor (every kept file against the official SHA-256).
    const target = path.join(out, `${name}.tgz`);
    writeFileSync(target, tgz);
    if ((await extractTarGz(target, expected)).size !== expected.length) throw new Error(`${platform}: read-back failed`);
    const outer = { ...manifest, packBytes: tgz.length, packSha256: sha256(tgz), packUrl: POSE_MANIFEST.packs?.[platform]?.url,
      unpackedBytes: manifest.files.reduce((s, f) => s + f.bytes, 0), builtWithNode: process.version };
    writeFileSync(path.join(out, `${name}.manifest.json`), `${JSON.stringify(outer, null, 1)}\n`);
    sums.push(`${outer.packSha256}  ${name}.tgz`);
    console.log(`${name}.tgz  ${tgz.length} bytes  sha256 ${outer.packSha256}  (${manifest.files.length} files, ${outer.unpackedBytes} bytes unpacked)`);
  }
  writeFileSync(path.join(out, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
}

// ---------------------------------------------------------------- verify (after download from the Release)

async function verify(dir: string): Promise<void> {
  let bad = 0;
  for (const platform of POSE_PLATFORMS) {
    const pack = POSE_MANIFEST.packs?.[platform];
    const problem = packProblem(POSE_MANIFEST, platform);
    if (!pack || problem) { console.log(`${platform}: ${problem ?? 'no pack in the manifest'}`); bad++; continue; }
    const file = path.join(dir, path.posix.basename(new URL(pack.url).pathname));
    if (!existsSync(file)) { console.log(`${platform}: missing ${file}`); bad++; continue; }
    const data = readFileSync(file);
    const ok = data.length === pack.size && sha256(data) === pack.sha256;
    let inside = 'not checked';
    if (ok) inside = `${(await extractTarGz(file, archiveFiles(pack, platform))).size} files match the official hashes`;
    console.log(`${platform}: ${path.basename(file)} ${data.length} bytes sha256 ${sha256(data)} ${ok ? 'OK' : `MISMATCH (expected ${pack.size} / ${pack.sha256})`}; ${inside}`);
    if (!ok) bad++;
  }
  if (bad) { console.error(`${bad} problem(s)`); process.exitCode = 1; }
}

const command = process.argv[2];
if (command === 'build') {
  const official = arg('official'), out = arg('out');
  if (!official || !out) throw new Error('usage: build --official <dir with the npm tarballs> --out <dir>');
  await build(path.resolve(official), path.resolve(out));
} else if (command === 'verify') {
  const dir = arg('dir');
  if (!dir) throw new Error('usage: verify --dir <dir with the downloaded .tgz files>');
  await verify(path.resolve(dir));
} else throw new Error('usage: pose-release-pack.ts build|verify …');
