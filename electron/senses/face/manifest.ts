/**
 * I-135 face check component (user approved the model download on 2026-11-14). Built into the app; never read from a download.
 *
 * Models, both from OpenCV Zoo (https://github.com/opencv/opencv_zoo), fetched unchanged from its repository, never
 * redistributed by this project:
 *  - YuNet face detector, face_detection_yunet_2023mar.onnx — MIT (Shiqi Yu et al., libfacedetection.train).
 *  - SFace face recognizer, face_recognition_sface_2021dec_int8.onnx (int8 only; the fp32 file is not used) — Apache-2.0
 *    (Yaoyao Zhong et al., SFace: Sigmoid-Constrained Hypersphere Loss for Robust Face Recognition).
 * Sizes and SHA-256 pinned from the files the lead downloaded on 2026-11-14 (checked with scripts/face/pin-models.mjs and
 * against the graphs: YuNet input 1×3×640×640, outputs cls/obj/bbox/kps × strides 8/16/32; SFace input data 1×3×112×112,
 * output fc1 1×128).
 *
 * Runtime: byte-for-byte the same onnxruntime-node files as local pose sensing (electron/foundation/pose-manifest.ts); copied from an
 * installed pose, speech or recall component after a hash check instead of being downloaded again.
 */
import { POSE_ARCHIVES, POSE_GENERATED_FILES, POSE_PACKS, POSE_RUNTIME_ENTRY, type ManifestArchive, type PoseManifest } from '../../foundation/pose-manifest';

/** Independent of the app version: an app update that keeps this number downloads nothing. */
export const FACE_COMPONENT_VERSION = 1;
/**
 * The repository path the files come from. `main` is a branch, not a commit: the pinned hashes below are what protect the
 * download (a changed file is refused). TODO(lead): replace `main` with the commit id once looked up, so the URL itself is fixed.
 */
const ZOO = 'https://github.com/opencv/opencv_zoo/raw/main/models';

export const FACE_MODEL_FILES = Object.freeze({
  detector: 'models/face_detection_yunet_2023mar.onnx',
  recognizer: 'models/face_recognition_sface_2021dec_int8.onnx',
});

/** Pinned 2026-11-14 (lead's download, real ONNX). */
export const FACE_MODEL_PINS = Object.freeze({
  detector: Object.freeze({ url: `${ZOO}/face_detection_yunet/face_detection_yunet_2023mar.onnx`, size: 232_589,
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4' }),
  recognizer: Object.freeze({ url: `${ZOO}/face_recognition_sface/face_recognition_sface_2021dec_int8.onnx`, size: 9_896_933,
    sha256: '2b0e941e6f16cc048c20aee0c8e31f569118f65d702914540f7bfdc14048d78a' }),
});

const single = (id: string, url: string, to: string, size: number, sha256: string): ManifestArchive =>
  ({ id, kind: 'file', url, size, sha256, networkBytes: size, files: { all: [{ from: to, to, size, sha256 }] } });

const RUNTIME = POSE_ARCHIVES.filter(archive => archive.id === 'onnxruntime-node' || archive.id === 'onnxruntime-common');

export const FACE_ARCHIVES: readonly ManifestArchive[] = Object.freeze([
  ...RUNTIME,
  single('yunet-model', FACE_MODEL_PINS.detector.url, FACE_MODEL_FILES.detector, FACE_MODEL_PINS.detector.size, FACE_MODEL_PINS.detector.sha256),
  single('sface-model', FACE_MODEL_PINS.recognizer.url, FACE_MODEL_FILES.recognizer, FACE_MODEL_PINS.recognizer.size, FACE_MODEL_PINS.recognizer.sha256),
]);

export const FACE_MANIFEST: PoseManifest = Object.freeze({
  version: FACE_COMPONENT_VERSION, archives: FACE_ARCHIVES, generated: POSE_GENERATED_FILES, packs: POSE_PACKS,
});
export const FACE_RUNTIME_ENTRY = POSE_RUNTIME_ENTRY;
/** Only the two models (what is downloaded when the runtime is copied from another component). */
export const FACE_MODEL_DOWNLOAD_BYTES = FACE_MODEL_PINS.detector.size + FACE_MODEL_PINS.recognizer.size;
