/**
 * Pose-sensing component manifest (I-001 stage 1). Built into the app; never read from a download.
 *
 * Every kept file has its size and SHA-256 here, and every archive its own hash (npm: the registry's
 * SHA-512 integrity; OpenMMLab zips and our runtime packs: SHA-256). The model weights always come from
 * OpenMMLab's own server and are never redistributed (licence note in
 * THIRD_PARTY_NOTICES.md). The runtime comes first from this project's GitHub Release as a small
 * per-platform pack (about 85 MB instead of 170 MB for the first download),
 * which holds byte-for-byte the files this manifest keeps from the two npm tarballs; when the pack cannot
 * be downloaded, the npm tarballs are the fallback. Regenerate the file hashes with
 * `node scripts/pose-component-hashes.mjs` when bumping a version, rebuild the packs with
 * `scripts/pose-release-pack.ts` (docs/claude/2026-11-03-pose-small-package.md), and bump POSE_COMPONENT_VERSION.
 */

/** Independent of the app version (R45): an app update that keeps this number downloads nothing. */
export const POSE_COMPONENT_VERSION = 1;
export const POSE_PLATFORMS = ['win32-arm64', 'win32-x64'] as const;
export type PosePlatform = typeof POSE_PLATFORMS[number];

export interface ManifestFile {
  /** Path inside the archive (tar: without the leading `package/`; zip: matched as a suffix). */
  from: string;
  /** Path inside `components/pose-v<N>/<platform>/`. */
  to: string;
  size: number;
  sha256: string;
}
export interface ManifestArchive {
  id: string;
  /** `file`: a single file served as is (e.g. a model on Hugging Face); its one kept file has the archive's own size and hash. */
  kind: 'tgz' | 'zip' | 'file';
  url: string;
  /** Exact size of the archive file. */
  size: number;
  /** One of these must be present: SHA-256 (hex) or an npm integrity string (sha512-…). */
  sha256?: string;
  integrity?: string;
  /** zip only: fetch just the one entry with HTTP range requests (the archive hash cannot be checked then; each kept file still is). */
  rangeEntry?: boolean;
  /** Bytes actually fetched over the network (range download: the entry plus the zip directory, measured once). */
  networkBytes: number;
  /** Files to keep, per platform; `all` applies to every platform. */
  files: Partial<Record<PosePlatform | 'all', ManifestFile[]>>;
}
/**
 * A per-platform pack on this project's GitHub Release that replaces some archives (the runtime tarballs).
 * Its kept files are exactly theirs (same `to`, size and SHA-256; `from` = `to` inside the pack's top folder),
 * so a pack install and an npm install leave identical folders. Tried first; when it cannot be downloaded the
 * replaced archives are fetched from their official URLs instead.
 */
export interface ManifestPack extends ManifestArchive { kind: 'tgz'; sha256: string; replaces: readonly string[] }
/** Small text files the app writes itself (no reason to trust or download them). */
export interface GeneratedFile { to: string; text: string }

const NPM = 'https://registry.npmjs.org';
const OPENMMLAB = 'https://download.openmmlab.com/mmpose/v1/projects';
/** This project's GitHub Release that carries the per-platform runtime packs (one tag per component version). */
export const POSE_RELEASE_TAG = `pose-components-v${POSE_COMPONENT_VERSION}`;
export const POSE_RELEASE_BASE = `https://github.com/LexZeon/soft-hearts/releases/download/${POSE_RELEASE_TAG}`;
const nodeDir = 'runtime/node_modules/onnxruntime-node';
const commonDir = 'runtime/node_modules/onnxruntime-common';
const file = (dir: string, prefix = '') => ([from, size, sha256]: [string, number, string]): ManifestFile =>
  ({ from: prefix + from, to: `${dir}/${from}`, size, sha256 });

export const POSE_ARCHIVES: readonly ManifestArchive[] = Object.freeze([
  {
    id: 'onnxruntime-node', kind: 'tgz', url: `${NPM}/onnxruntime-node/-/onnxruntime-node-1.31.1.tgz`, size: 115_391_311,
    integrity: 'sha512-ijnSghbDHVWaQ2nDPmVccPlCHI8kH1Mx1aJ4a/qzRP16bBcVs4E3EqZQKZCkhWnbqN1tuQWxagimFtDpbPYYQw==',
    networkBytes: 115_391_311,
    files: {
      all: ([
        ['dist/backend.js', 6316, '67e1c8bf72817a4dd0d598aa660ba431a9b3e90c6504e002a902e13bee523cf2'],
        ['dist/binding.js', 1590, '2a85ac5de943c7222aae5ca2897f52d73891f528d4295b701fab077470c668c0'],
        ['dist/index.js', 1602, '019eb02133b94b1f7fdf2d89eb93b590ce1288d271f7b280647fb3978e6391fa'],
        ['dist/version.js', 361, 'd83ca5483dba1d108ec2cac1b6d0f3e11d865546e897683a6ec825c93193723c'],
      ] as [string, number, string][]).map(file(nodeDir)),
      'win32-arm64': ([
        ['bin/napi-v6/win32/arm64/onnxruntime_binding.node', 504160, '6f34d4635793371c85e5260dbdc0864c2ef62ccfcb1f439afa3501ba6f8d530d'],
        ['bin/napi-v6/win32/arm64/onnxruntime.dll', 32835936, '14d1cd398fa5bc8b5c61bdfba899f17b40550012ec2884955ce656a5d8a8ff77'],
        ['bin/napi-v6/win32/arm64/DirectML.dll', 18444600, '4bb0639eb23a02de2c5f1eddd117f13330819f55b556e8c75068b68ad1a3516e'],
        ['bin/napi-v6/win32/arm64/dxcompiler.dll', 22285624, '4a77bcadf4d437ad50d10517bb0b4a5a4c2fc84b1fde4d1cf5a5abe9e2dce431'],
      ] as [string, number, string][]).map(file(nodeDir)),
      'win32-x64': ([
        ['bin/napi-v6/win32/x64/onnxruntime_binding.node', 358200, '8d9f996ff7dcc60c4899aa87aa7abe07d806f9c314882f44a001d0fd8a23d16f'],
        ['bin/napi-v6/win32/x64/onnxruntime.dll', 31736672, 'beb6e1edba0e74c132453fe4df113da2ea2b99ef8ea7dfc25696a872efd11c45'],
        ['bin/napi-v6/win32/x64/DirectML.dll', 18527544, 'd16be72fa002dd610cca93e376f0ef44865dfce43de4b7bf9738af22534f7a9d'],
        ['bin/napi-v6/win32/x64/dxcompiler.dll', 17986400, '430eed027979399769a325b60319aca4e4afa4daebe475d3c763dcf2a0190a72'],
      ] as [string, number, string][]).map(file(nodeDir)),
    },
  },
  {
    id: 'onnxruntime-common', kind: 'tgz', url: `${NPM}/onnxruntime-common/-/onnxruntime-common-1.31.1.tgz`, size: 72_322,
    integrity: 'sha512-F+nnYNiQtmNJ95V6R/isBJqiVpdANCrsMEg1OaF+Bkbl3GAtzWLR7Ng17Ld0QtYtYJyotOHPJzOQn1Y6PLZjpg==',
    networkBytes: 72_322,
    files: {
      all: ([
        ['dist/cjs/backend-impl.js', 7357, '7ec5d5b37145f23fb776d11cb8dab749caa162fade9eddab100d8edfe56c3de4'],
        ['dist/cjs/backend.js', 433, '325aaee7a2649ea27629666f3ca01c0d80b9751e704ce502e43a8352390749b4'],
        ['dist/cjs/env-impl.js', 969, '35cd8cac33973538eab471b68622c86c35a6896f4307d1a74c9ca0eda7abbac6'],
        ['dist/cjs/env.js', 366, '22c7647f8ca1c1b83b437a92b95fee1457fcb72866fa029616b8f146dc609be8'],
        ['dist/cjs/index.js', 2008, '4c532c6b100d176594e0175757fe373d09e12abd5277695c376a40affddfaace'],
        ['dist/cjs/inference-session-impl.js', 9960, '80455e8b5278e66721c1f680765fb430502771edb2854683652cec696474d971'],
        ['dist/cjs/inference-session.js', 467, '458be26f316c5068d32a56ddbc30ca0aa687c636e079b3d161a69f0f14a683f1'],
        ['dist/cjs/lora-adapter-impl.js', 1104, '490c28348ae9681d8b73f5c15e31c093a3a27cb90af3d77e9a284b28899d4cad'],
        ['dist/cjs/lora-adapter.js', 432, '18c3f4b891c2a9f758fd223061f006b40b36cff39aed46c42cda50e9546d8668'],
        ['dist/cjs/onnx-model.js', 211, '667f5fdac4b6df25e17f8a864d4dc619507f541f9fa0aafb6d3572fcca1e25e5'],
        ['dist/cjs/onnx-value.js', 211, '8446854766f4955ce438a7338216f49223767ecc508bb502b73a3dc1a1f1998e'],
        ['dist/cjs/tensor-conversion-impl.js', 8067, '9815e72c0bb91896035de93b3113a2256a1a998bc53c7b5e6bf5fb4e93714766'],
        ['dist/cjs/tensor-conversion.js', 218, '28cc462d4a9ea556ecc86c0e6d16a51d61b58d5bc5b4b7b48976b14bc8035bdc'],
        ['dist/cjs/tensor-factory-impl.js', 11656, 'a3204838a2c14416e4e61c968dc17c663ab3c9b8b2c4a8b7f2a1c5b06e3e5173'],
        ['dist/cjs/tensor-factory.js', 215, '13b8d735350b828a49bda8aeec50b1dac888cf42268006efc4312f50a88b6906'],
        ['dist/cjs/tensor-impl-type-mapping.js', 2995, '333110edbbffdb7575ea340cb341bcaf691862d6594a649db28097f7d8cb19b7'],
        ['dist/cjs/tensor-impl.js', 16458, '11645352ba5d08971344717d3339f86aac560f84f29229b2ebe07f1ec8aa8905'],
        ['dist/cjs/tensor-utils-impl.js', 2213, 'e7b1db989d33d54bdd1807b080a0989ff0b10d5f7dd8c93b92bbf293103aa4d5'],
        ['dist/cjs/tensor-utils.js', 213, 'd3f577e90dc2257c72ac728e5e6355c34af0342d971158d9f22b69d22aa97b8d'],
        ['dist/cjs/tensor.js', 393, '9097114de356750f36f28776fa6ccd08d13694f0f9aac9e7669c30b6c43153f7'],
        ['dist/cjs/trace.js', 2496, 'faecd0df94998d786e2085d56aa6003449f1ac3b35c350e0d2762498604e5d72'],
        ['dist/cjs/type-helper.js', 212, '7f786da8d2a611ad751c70a74edf4d9acfccd26be8e5c6b1cb730f982892bf32'],
        ['dist/cjs/version.js', 361, 'd83ca5483dba1d108ec2cac1b6d0f3e11d865546e897683a6ec825c93193723c'],
      ] as [string, number, string][]).map(file(commonDir)),
    },
  },
  {
    // RTMDet-nano person detector: OpenMMLab only publishes it inside this 54.5 MB zip, so by default only its
    // entry is fetched with range requests (feasibility test: 3.76 MB on the wire, same SHA-256 as the full zip).
    id: 'rtmdet-nano', kind: 'zip', url: `${OPENMMLAB}/rtmpose/rtmpose-cpu.zip`, size: 54_564_140,
    sha256: '54e1d48a8946c87d66e96f81438344fec6e471cb3e44b71dfa04be6e879f3528', rangeEntry: true, networkBytes: 3_760_000,
    files: { all: [{ from: 'rtmdet-nano/end2end.onnx', to: 'models/det_rtmdet_nano.onnx', size: 4_012_393,
      sha256: 'b8585adb6d1352796f6e86337e09c3459b830645a7e7192d9381670bea2facbd' }] },
  },
  {
    id: 'rtmpose-m-body7', kind: 'zip',
    url: `${OPENMMLAB}/rtmposev1/onnx_sdk/rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504.zip`, size: 50_799_818,
    sha256: 'f7fbb6c5c11a1bb70f3d445e4ddec5d144ea89ad5649c081ef976f9b24a0b741', networkBytes: 50_799_818,
    files: { all: [{ from: 'end2end.onnx', to: 'models/pose_rtmpose_m_256x192.onnx', size: 54_330_655,
      sha256: '5c0a4bf67953e6d2ac43ce15e77dc9d5d354ae18430a47d2c5963a7bc5683e3c' }] },
  },
] satisfies ManifestArchive[]);

/** The two package.json files are written by the app (only `main` matters for require-by-directory). */
export const POSE_GENERATED_FILES: readonly GeneratedFile[] = Object.freeze([
  { to: `${nodeDir}/package.json`, text: '{"name":"onnxruntime-node","version":"1.31.1","license":"MIT","main":"dist/index.js"}\n' },
  { to: `${commonDir}/package.json`, text: '{"name":"onnxruntime-common","version":"1.31.1","license":"MIT","main":"dist/cjs/index.js"}\n' },
  { to: `${commonDir}/dist/cjs/package.json`, text: '{"type":"commonjs"}\n' },
]);

export const POSE_MODEL_FILES = Object.freeze({ detector: 'models/det_rtmdet_nano.onnx', pose: 'models/pose_rtmpose_m_256x192.onnx' });
export const POSE_RUNTIME_ENTRY = nodeDir;

// ---------------------------------------------------------------- runtime packs (GitHub Release)

/** Archives a runtime pack stands in for. */
export const POSE_PACK_REPLACES = Object.freeze(['onnxruntime-node', 'onnxruntime-common'] as const);
/** Release asset name, also the pack's top folder (without `.tgz`). */
export const posePackName = (platform: PosePlatform, version = POSE_COMPONENT_VERSION) => `soft-hearts-pose-runtime-v${version}-${platform}`;

/** The pack's kept files, derived from the replaced archives so the two lists can never drift apart. */
export function posePackFiles(archives: readonly ManifestArchive[], replaces: readonly string[], platform: PosePlatform): ManifestFile[] {
  return archives.filter(archive => replaces.includes(archive.id)).flatMap(archive => archiveFiles(archive, platform)).map(file => ({ ...file, from: file.to }));
}

function runtimePack(platform: PosePlatform, size: number, sha256: string): ManifestPack {
  return { id: `pose-runtime-${platform}`, kind: 'tgz', url: `${POSE_RELEASE_BASE}/${posePackName(platform)}.tgz`, size, sha256, networkBytes: size,
    replaces: POSE_PACK_REPLACES, files: { [platform]: posePackFiles(POSE_ARCHIVES, POSE_PACK_REPLACES, platform) } };
}

/** Built by `scripts/pose-release-pack.ts` from the two npm tarballs above (sizes and SHA-256 of the .tgz files). */
export const POSE_PACKS: Readonly<Partial<Record<PosePlatform, ManifestPack>>> = Object.freeze({
  'win32-arm64': runtimePack('win32-arm64', 30_611_826, '607a2e730f6c0d34ba2d90c5af4377bb547ba1a4e207eeda68f8a2ad985c62f0'),
  'win32-x64': runtimePack('win32-x64', 29_499_386, '539a2ec4d1b4e16406c87f438f496c7e4c37057cf5f625ebed8b8c5c19dc016a'),
});

export interface PoseManifest {
  version: number;
  archives: readonly ManifestArchive[];
  generated: readonly GeneratedFile[];
  /** Optional smaller per-platform sources for some archives (tried first, official URLs as the fallback). */
  packs?: Readonly<Partial<Record<PosePlatform, ManifestPack>>>;
}
export const POSE_MANIFEST: PoseManifest = Object.freeze({ version: POSE_COMPONENT_VERSION, archives: POSE_ARCHIVES, generated: POSE_GENERATED_FILES, packs: POSE_PACKS });

/** Windows on ARM64 or x64 only; everything else has no package (old camera behaviour stays there). */
export function posePlatform(platform: string = process.platform, arch: string = process.arch): PosePlatform | null {
  const key = `${platform}-${arch}`;
  return (POSE_PLATFORMS as readonly string[]).includes(key) ? key as PosePlatform : null;
}
export function archiveFiles(archive: ManifestArchive, platform: PosePlatform): ManifestFile[] {
  return [...(archive.files.all ?? []), ...(archive.files[platform] ?? [])];
}
export function neededArchives(manifest: PoseManifest, platform: PosePlatform): ManifestArchive[] {
  return manifest.archives.filter(archive => archiveFiles(archive, platform).length > 0);
}
/** Why a pack cannot stand in for its archives on this platform (null: it can). Checked when a store is created. */
export function packProblem(manifest: PoseManifest, platform: PosePlatform): string | null {
  const pack = manifest.packs?.[platform];
  if (!pack) return null;
  if (pack.kind !== 'tgz' || !/^[0-9a-f]{64}$/.test(pack.sha256) || !(pack.size > 0)) return `pack ${pack.id}: needs a tgz with a SHA-256 and a size`;
  const replaced = manifest.archives.filter(archive => pack.replaces.includes(archive.id));
  if (replaced.length !== pack.replaces.length) return `pack ${pack.id}: replaces an unknown archive`;
  const expected = replaced.flatMap(archive => archiveFiles(archive, platform));
  const actual = archiveFiles(pack, platform);
  if (actual.length !== expected.length) return `pack ${pack.id}: ${actual.length} files, the replaced archives keep ${expected.length}`;
  for (const file of expected)
    if (!actual.some(entry => entry.to === file.to && entry.from === file.to && entry.size === file.size && entry.sha256 === file.sha256))
      return `pack ${pack.id}: ${file.to} differs from the official file`;
  return null;
}
/** First-download bytes: the platform pack (when there is one and it is usable) plus every archive it does not replace. */
export function downloadBytes(manifest: PoseManifest, platform: PosePlatform, usePack = true): number {
  const pack = usePack ? manifest.packs?.[platform] : undefined;
  return neededArchives(manifest, platform).reduce((sum, archive) => sum + (pack?.replaces.includes(archive.id) ? 0 : archive.networkBytes), pack?.networkBytes ?? 0);
}
/** The same download from the official URLs only (the fallback when the pack cannot be fetched). */
export const officialDownloadBytes = (manifest: PoseManifest, platform: PosePlatform) => downloadBytes(manifest, platform, false);
export function installedBytes(manifest: PoseManifest, platform: PosePlatform): number {
  return neededArchives(manifest, platform).reduce((sum, archive) => sum + archiveFiles(archive, platform).reduce((s, f) => s + f.size, 0), 0);
}
