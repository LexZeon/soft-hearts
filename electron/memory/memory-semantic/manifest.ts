/**
 * Local "recall by meaning" component (user approved the download; free, runs on this computer only,
 * nothing leaves it). Built into the app; never read from a download.
 *
 * Model: BGE-small-zh-v1.5 (BAAI / FlagEmbedding, MIT as declared on the model card; 512-dimension Chinese sentence embedding,
 * 4 layers). BAAI publishes no ONNX file, so this is the ONNX conversion of the same weights by the transformers.js maintainers
 * (Hugging Face user Xenova), int8-quantized variant `onnx/model_int8.onnx`, plus the model's own `vocab.txt`. Fetched from
 * the converter's repository at a pinned commit, never redistributed by this project. The fp32 file (94.9 MB) measured the same
 * on this project's synthetic recall set (docs/claude/2026-11-13-bge-recall.md), so the 4x smaller one is used.
 *
 * Runtime: byte-for-byte the same onnxruntime-node files as local pose sensing and speech recognition (electron/foundation/pose-manifest.ts);
 * copied from either installed component after a hash check instead of being downloaded again.
 */
import { POSE_ARCHIVES, POSE_GENERATED_FILES, POSE_PACKS, POSE_RUNTIME_ENTRY, type ManifestArchive, type PoseManifest } from '../../foundation/pose-manifest';

/** Independent of the app version: an app update that keeps this number downloads nothing. */
export const SEMANTIC_COMPONENT_VERSION = 1;
export const BGE_REPO = 'Xenova/bge-small-zh-v1.5';
export const BGE_REVISION = '75c43b069aac4d136ba6bc1122f995fedcfd2781';
const HF = `https://huggingface.co/${BGE_REPO}/resolve/${BGE_REVISION}`;

export const SEMANTIC_MODEL_FILES = Object.freeze({ model: 'models/bge-small-zh-v1.5.int8.onnx', vocab: 'models/bge-small-zh-v1.5.vocab.txt' });
/** What a stored vector says it was made by: the model file, the query format and this number (bump when the text recipe changes). */
export const SEMANTIC_MODEL_VERSION = `bge-small-zh-v1.5-int8-${BGE_REVISION.slice(0, 8)}-r1`;

const single = (id: string, url: string, to: string, size: number, sha256: string): ManifestArchive =>
  ({ id, kind: 'file', url, size, sha256, networkBytes: size, files: { all: [{ from: to, to, size, sha256 }] } });

const RUNTIME = POSE_ARCHIVES.filter(archive => archive.id === 'onnxruntime-node' || archive.id === 'onnxruntime-common');

export const SEMANTIC_ARCHIVES: readonly ManifestArchive[] = Object.freeze([
  ...RUNTIME,
  // Sizes and SHA-256 as published by Hugging Face (LFS oid for the model) and checked against a real download on 2026-11-13.
  single('bge-model', `${HF}/onnx/model_int8.onnx`, SEMANTIC_MODEL_FILES.model, 23_903_394, 'b9837c19ce154ff0726d398ee77abbc03a7faf0476c6f93016c84e531be7ebb5'),
  single('bge-vocab', `${HF}/vocab.txt`, SEMANTIC_MODEL_FILES.vocab, 109_540, '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c'),
]);

export const SEMANTIC_MANIFEST: PoseManifest = Object.freeze({
  version: SEMANTIC_COMPONENT_VERSION, archives: SEMANTIC_ARCHIVES, generated: POSE_GENERATED_FILES, packs: POSE_PACKS,
});
export const SEMANTIC_RUNTIME_ENTRY = POSE_RUNTIME_ENTRY;
