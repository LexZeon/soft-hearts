/**
 * I-135: YuNet (opencv_zoo face_detection_yunet_2023mar.onnx, MIT) pre- and post-processing. Pure.
 *
 * Input: 1×3×640×640 float, BGR, 0..255, no mean/scale (OpenCV's FaceDetectorYN feeds `blobFromImage(img)` as is).
 * The frame is resized to fit (aspect kept), top-left aligned, and the rest is black.
 * Outputs (checked against the real file's graph, 2026-11-14): cls_{8,16,32} [1,N,1], obj_* [1,N,1], bbox_* [1,N,4],
 * kps_* [1,N,10], N = (640/stride)². Decoding follows OpenCV's FaceDetectorYN::postProcess for this model.
 */
import type { Landmarks5, Point } from './align';

export const YUNET_STRIDES = [8, 16, 32] as const;
export const YUNET_OUTPUTS = YUNET_STRIDES.flatMap(stride => [`cls_${stride}`, `obj_${stride}`, `bbox_${stride}`, `kps_${stride}`]);

export interface DetectorInput { data: Float32Array; size: number; scale: number }

/** RGBA frame → the detector tensor (planar BGR). `scale` maps detector pixels back: source = detector / scale. */
export function detectorInput(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, size = 640): DetectorInput {
  const scale = Math.min(size / width, size / height);
  const outW = Math.min(size, Math.round(width * scale)), outH = Math.min(size, Math.round(height * scale));
  const plane = size * size;
  const data = new Float32Array(3 * plane);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(height - 1, Math.max(0, (y + 0.5) / scale - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(height - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(width - 1, Math.max(0, (x + 0.5) / scale - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(width - 1, x0 + 1), fx = sx - x0;
      const a = (y0 * width + x0) * 4, b = (y0 * width + x1) * 4, c = (y1 * width + x0) * 4, d = (y1 * width + x1) * 4;
      const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
      const at = y * size + x;
      for (let channel = 0; channel < 3; channel++) {
        const value = rgba[a + channel] * w00 + rgba[b + channel] * w01 + rgba[c + channel] * w10 + rgba[d + channel] * w11;
        data[(2 - channel) * plane + at] = value; // R→plane 2, G→1, B→0
      }
    }
  }
  return { data, size, scale };
}

export interface DetectedFace {
  x: number; y: number; width: number; height: number;
  landmarks: Landmarks5;
  score: number;
}

type Outputs = Record<string, { data: ArrayLike<number> }>;

function iou(a: DetectedFace, b: DetectedFace): number {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/** Decode the twelve outputs to faces in SOURCE pixels (divided by `scale`), best first, after NMS. */
export function decodeYunet(outputs: Outputs, input: { size: number; scale: number },
  options: { scoreThreshold: number; nmsThreshold: number; topK: number }): DetectedFace[] {
  const candidates: DetectedFace[] = [];
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  for (const stride of YUNET_STRIDES) {
    const cls = outputs[`cls_${stride}`]?.data, obj = outputs[`obj_${stride}`]?.data;
    const bbox = outputs[`bbox_${stride}`]?.data, kps = outputs[`kps_${stride}`]?.data;
    if (!cls || !obj || !bbox || !kps) throw new Error(`YuNet output for stride ${stride} missing`);
    const cols = Math.floor(input.size / stride), rows = cols;
    if (cls.length < rows * cols || bbox.length < rows * cols * 4 || kps.length < rows * cols * 10) throw new Error('YuNet output too short');
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const index = r * cols + c;
        const score = Math.sqrt(clamp(cls[index]) * clamp(obj[index]));
        if (!(score >= options.scoreThreshold)) continue;
        const cx = (c + bbox[index * 4]) * stride, cy = (r + bbox[index * 4 + 1]) * stride;
        const w = Math.exp(bbox[index * 4 + 2]) * stride, h = Math.exp(bbox[index * 4 + 3]) * stride;
        if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
        const points: Point[] = [];
        for (let n = 0; n < 5; n++) points.push({ x: (kps[index * 10 + 2 * n] + c) * stride / input.scale, y: (kps[index * 10 + 2 * n + 1] + r) * stride / input.scale });
        candidates.push({ x: (cx - w / 2) / input.scale, y: (cy - h / 2) / input.scale, width: w / input.scale, height: h / input.scale,
          landmarks: points as unknown as Landmarks5, score });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const kept: DetectedFace[] = [];
  for (const face of candidates) {
    if (kept.length >= options.topK) break;
    if (kept.every(other => iou(face, other) <= options.nmsThreshold)) kept.push(face);
  }
  return kept;
}

/** The face the check looks at: the largest one (the person closest to the screen). */
export function largestFace(faces: readonly DetectedFace[]): DetectedFace | null {
  let best: DetectedFace | null = null;
  for (const face of faces) if (!best || face.width * face.height > best.width * best.height) best = face;
  return best;
}
