/**
 * Local speech recognition component (downloaded on request, free, the
 * voice never leaves the computer). Built into the app; never read from a download.
 *
 * Model: SenseVoiceSmall (Alibaba Tongyi Lab, FunAudioLLM; FunASR Model Open Source License v1.1 — use, copy, modify and
 * share allowed, source/author must be credited and the model name kept; see electron/asr/licenses/), as converted to
 * ONNX with int8 weights by the sherpa-onnx project (k2-fsa, Fangjun Kuang). Fetched from the converter's own Hugging
 * Face repository at a pinned commit, never redistributed by this project.
 *
 * Runtime: byte-for-byte the same onnxruntime-node files as local pose sensing (electron/pose/manifest.ts). When pose
 * sensing is installed they are copied from its folder after a hash check instead of being downloaded again.
 */
import { POSE_ARCHIVES, POSE_GENERATED_FILES, POSE_PACKS, POSE_RUNTIME_ENTRY, type ManifestArchive, type PoseManifest } from '../pose/manifest';

/** Independent of the app version: an app update that keeps this number downloads nothing. */
export const ASR_COMPONENT_VERSION = 1;
/** The converter's repository and the exact commit the hashes below come from. */
export const SENSEVOICE_REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
export const SENSEVOICE_REVISION = '2365baeacb507f821a0c8120fcee3d484dba7a07';
const HF = `https://huggingface.co/${SENSEVOICE_REPO}/resolve/${SENSEVOICE_REVISION}`;

export const ASR_MODEL_FILES = Object.freeze({ model: 'models/sensevoice-small.int8.onnx', tokens: 'models/sensevoice-tokens.txt' });

const single = (id: string, url: string, to: string, size: number, sha256: string): ManifestArchive =>
  ({ id, kind: 'file', url, size, sha256, networkBytes: size, files: { all: [{ from: to, to, size, sha256 }] } });

/** The two runtime tarballs of pose sensing (same objects, so the shared pack still stands in for them). */
const RUNTIME = POSE_ARCHIVES.filter(archive => archive.id === 'onnxruntime-node' || archive.id === 'onnxruntime-common');

export const ASR_ARCHIVES: readonly ManifestArchive[] = Object.freeze([
  ...RUNTIME,
  // Sizes and SHA-256 as published by Hugging Face (LFS oid) and checked against a real download on 2026-11-03.
  single('sensevoice-model', `${HF}/model.int8.onnx`, ASR_MODEL_FILES.model, 239_233_841, 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51'),
  single('sensevoice-tokens', `${HF}/tokens.txt`, ASR_MODEL_FILES.tokens, 315_894, 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc'),
]);

export const ASR_MANIFEST: PoseManifest = Object.freeze({
  version: ASR_COMPONENT_VERSION, archives: ASR_ARCHIVES, generated: POSE_GENERATED_FILES, packs: POSE_PACKS,
});
export const ASR_RUNTIME_ENTRY = POSE_RUNTIME_ENTRY;
