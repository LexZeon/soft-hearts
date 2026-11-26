/**
 * Unbound v1 step 3 「只认你的声音」 component (user approved this one download; Codex T-247's first choice).
 * Built into the app; never read from a download.
 *
 * Model: CAM++ speaker verification, Chinese common (iic/speech_campplus_sv_zh-cn_16k-common, Apache-2.0 on its ModelScope card), in
 * the ONNX conversion the sherpa-onnx project publishes in its release "speaker-recongition-models" (sic). Input x: N×T×80 log-mel
 * filter banks (Kaldi, Povey window, samples in [-1, 1], each utterance's mean taken off: the file's own metadata says
 * normalize_samples=1, feature_normalize_type=global-mean); output: one 192-number embedding. Size and SHA-256 pinned from the lead's
 * one download on 2026-11-17 (docs/claude/2026-11-17-unbound-step3.md); a changed file is refused.
 *
 * Runtime: byte-for-byte the same onnxruntime-node files as local pose sensing (electron/foundation/pose-manifest.ts), only ever copied
 * from an installed pose, speech, recall or face component after a hash check. The user approved the model only, so the host
 * never starts an install without one of those (electron/senses/voiceprint/host.ts 'needs-runtime').
 */
import { POSE_ARCHIVES, POSE_GENERATED_FILES, POSE_PACKS, POSE_RUNTIME_ENTRY, type ManifestArchive, type PoseManifest } from '../../foundation/pose-manifest';
import type { FetchLike } from '../pose/component-store';

/** Independent of the app version: an app update that keeps this number downloads nothing. */
export const VOICEPRINT_COMPONENT_VERSION = 1;

export const VOICEPRINT_MODEL_FILE = 'models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx';
export const VOICEPRINT_MODEL_PIN = Object.freeze({
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
  size: 28_281_138,
  sha256: 'f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11',
});
/** What the model's input and output are (checked by the worker on load). */
export const VOICEPRINT_MODEL_SHAPE = Object.freeze({ melBins: 80, embedding: 192 });

const RUNTIME = POSE_ARCHIVES.filter(archive => archive.id === 'onnxruntime-node' || archive.id === 'onnxruntime-common');

export const VOICEPRINT_ARCHIVES: readonly ManifestArchive[] = Object.freeze([
  ...RUNTIME,
  { id: 'campplus-model', kind: 'file', url: VOICEPRINT_MODEL_PIN.url, size: VOICEPRINT_MODEL_PIN.size, sha256: VOICEPRINT_MODEL_PIN.sha256,
    networkBytes: VOICEPRINT_MODEL_PIN.size, files: { all: [{ from: VOICEPRINT_MODEL_FILE, to: VOICEPRINT_MODEL_FILE, size: VOICEPRINT_MODEL_PIN.size, sha256: VOICEPRINT_MODEL_PIN.sha256 }] } },
]);

export const VOICEPRINT_MANIFEST: PoseManifest = Object.freeze({
  version: VOICEPRINT_COMPONENT_VERSION, archives: VOICEPRINT_ARCHIVES, generated: POSE_GENERATED_FILES, packs: POSE_PACKS,
});
export const VOICEPRINT_RUNTIME_ENTRY = POSE_RUNTIME_ENTRY;
/** Only the model (the runtime is copied, never downloaded, for this component). */
export const VOICEPRINT_MODEL_DOWNLOAD_BYTES = VOICEPRINT_MODEL_PIN.size;

/** Only the approved model file may be fetched (the user approved that one download, 2026-11-17). */
export function approvedFetch(fetch: FetchLike): FetchLike {
  return ((url: string, init?: unknown) => String(url) === VOICEPRINT_MODEL_PIN.url ? fetch(url, init as never)
    : Promise.reject(new Error('this download is not approved'))) as FetchLike;
}
