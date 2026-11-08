/**
 * Pre/post-processing for RTMDet-nano (person boxes) and RTMPose-m body7 (17 COCO keypoints).
 * Ported from the feasibility bench (scripts/pose-bench/lib/pose.mjs), which was checked against the
 * models' pipeline.json and rtmlib (Apache-2.0, reference only). Pure functions; runs in the inference process.
 */

export interface Box { x1: number; y1: number; x2: number; y2: number; score: number }
export interface DetectorSpec { size: number; mean: readonly [number, number, number]; std: readonly [number, number, number] }
export interface PoseSpec { width: number; height: number; keypoints: number }

/** RTMDet-nano from rtmpose-cpu.zip: 320×320, BGR mean/std (its pipeline.json). */
export const RTMDET_NANO: DetectorSpec = Object.freeze({ size: 320, mean: [103.53, 116.28, 123.675] as const, std: [57.375, 57.12, 58.395] as const });
/** RTMPose-m body7 256×192 (H×W), SimCC split ratio 2. */
export const RTMPOSE_M: PoseSpec = Object.freeze({ width: 192, height: 256, keypoints: 17 });

function sample(rgba: Uint8Array, w: number, h: number, x: number, y: number, out: Float32Array): void {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  let r = 0, g = 0, b = 0;
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const xx = x0 + i, yy = y0 + j;
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const weight = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
    const p = (yy * w + xx) * 4;
    r += rgba[p] * weight; g += rgba[p + 1] * weight; b += rgba[p + 2] * weight;
  }
  out[0] = r; out[1] = g; out[2] = b;
}

/** Letterbox into the top-left of a size×size canvas padded with 114, BGR planes, normalised. */
export function detectorInput(rgba: Uint8Array, w: number, h: number, spec: DetectorSpec = RTMDET_NANO): { data: Float32Array; ratio: number } {
  const size = spec.size, ratio = Math.min(size / h, size / w);
  const nw = Math.max(1, Math.floor(w * ratio)), nh = Math.max(1, Math.floor(h * ratio)), plane = size * size;
  const data = new Float32Array(3 * plane);
  for (let c = 0; c < 3; c++) data.fill((114 - spec.mean[c]) / spec.std[c], c * plane, (c + 1) * plane);
  const px = new Float32Array(3);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(Math.max((y + 0.5) * (h / nh) - 0.5, 0), h - 1);
    for (let x = 0; x < nw; x++) {
      sample(rgba, w, h, Math.min(Math.max((x + 0.5) * (w / nw) - 0.5, 0), w - 1), sy, px);
      const o = y * size + x;
      data[o] = (px[2] - spec.mean[0]) / spec.std[0];
      data[plane + o] = (px[1] - spec.mean[1]) / spec.std[1];
      data[2 * plane + o] = (px[0] - spec.mean[2]) / spec.std[2];
    }
  }
  return { data, ratio };
}

/** dets: [N,5] (x1,y1,x2,y2,score) in detector pixels → boxes in frame pixels, best (area × score) first. */
export function detectorBoxes(dets: ArrayLike<number>, n: number, ratio: number, w: number, h: number, threshold = 0.3): Box[] {
  const boxes: Box[] = [];
  for (let i = 0; i < n; i++) {
    const score = dets[i * 5 + 4];
    if (!(score > threshold)) continue;
    const x1 = Math.max(0, dets[i * 5] / ratio), y1 = Math.max(0, dets[i * 5 + 1] / ratio);
    const x2 = Math.min(w, dets[i * 5 + 2] / ratio), y2 = Math.min(h, dets[i * 5 + 3] / ratio);
    if (x2 - x1 < 4 || y2 - y1 < 4) continue;
    boxes.push({ x1, y1, x2, y2, score });
  }
  return boxes.sort((a, b) => (b.x2 - b.x1) * (b.y2 - b.y1) * b.score - (a.x2 - a.x1) * (a.y2 - a.y1) * a.score);
}

/** Top-down crop: box padded ×1.25, aspect fixed to W:H, bilinear warp, RGB normalised with the mmpose mean/std. */
export function poseInput(rgba: Uint8Array, w: number, h: number, box: Box, spec: PoseSpec = RTMPOSE_M): { data: Float32Array; center: [number, number]; scale: [number, number] } {
  const W = spec.width, H = spec.height;
  const cx = (box.x1 + box.x2) / 2, cy = (box.y1 + box.y2) / 2;
  let sw = (box.x2 - box.x1) * 1.25, sh = (box.y2 - box.y1) * 1.25;
  const aspect = W / H;
  if (sw > sh * aspect) sh = sw / aspect; else sw = sh * aspect;
  const k = sw / W, plane = W * H;
  const data = new Float32Array(3 * plane);
  const mean = [123.675, 116.28, 103.53], std = [58.395, 57.12, 57.375];
  const px = new Float32Array(3);
  for (let v = 0; v < H; v++) {
    const sy = cy + (v - H / 2) * k;
    for (let u = 0; u < W; u++) {
      sample(rgba, w, h, cx + (u - W / 2) * k, sy, px);
      const o = v * W + u;
      data[o] = (px[0] - mean[0]) / std[0];
      data[plane + o] = (px[1] - mean[1]) / std[1];
      data[2 * plane + o] = (px[2] - mean[2]) / std[2];
    }
  }
  return { data, center: [cx, cy], scale: [sw, sh] };
}

/** SimCC argmax decode → keypoints [K,2] in frame pixels and scores [K]. */
export function simccDecode(simccX: ArrayLike<number>, simccY: ArrayLike<number>, spec: PoseSpec, center: readonly [number, number], scale: readonly [number, number], split = 2): { kpts: Float32Array; scores: Float32Array } {
  const K = spec.keypoints, nx = simccX.length / K, ny = simccY.length / K;
  const kpts = new Float32Array(K * 2), scores = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    let bx = 0, vx = -Infinity, by = 0, vy = -Infinity;
    for (let i = 0; i < nx; i++) { const v = simccX[k * nx + i]; if (v > vx) { vx = v; bx = i; } }
    for (let i = 0; i < ny; i++) { const v = simccY[k * ny + i]; if (v > vy) { vy = v; by = i; } }
    kpts[k * 2] = (bx / split / spec.width) * scale[0] + center[0] - scale[0] / 2;
    kpts[k * 2 + 1] = (by / split / spec.height) * scale[1] + center[1] - scale[1] / 2;
    scores[k] = Math.min(vx, vy);
  }
  return { kpts, scores };
}

/** Next frame's crop from this frame's confident keypoints (so the detector need not run every frame). */
export function boxFromKeypoints(kpts: Float32Array, scores: Float32Array, w: number, h: number, threshold = 0.3): Box | null {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, n = 0, sum = 0;
  for (let k = 0; k < scores.length; k++) {
    if (!(scores[k] >= threshold)) continue;
    const x = kpts[k * 2], y = kpts[k * 2 + 1];
    x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); n++; sum += scores[k];
  }
  if (n < 4) return null;
  const mx = (x2 - x1) * 0.15 + 4, my = (y2 - y1) * 0.15 + 4;
  const box = { x1: Math.max(0, x1 - mx), y1: Math.max(0, y1 - my), x2: Math.min(w, x2 + mx), y2: Math.min(h, y2 + my), score: Math.min(1, sum / n) };
  return box.x2 - box.x1 >= 8 && box.y2 - box.y1 >= 8 ? box : null;
}

/** Deterministic test pattern for the start-up self-test (no camera, no image file). */
export function syntheticFrame(w = 320, h = 240, seed = 1): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  let s = seed >>> 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const o = (y * w + x) * 4, body = Math.hypot((x - w / 2) / (w * 0.18), (y - h * 0.62) / (h * 0.4)) < 1 || Math.hypot((x - w / 2) / (w * 0.08), (y - h * 0.25) / (h * 0.12)) < 1;
    rgba[o] = body ? 200 + (s & 15) : 60 + ((x * 3) & 63); rgba[o + 1] = body ? 160 + (s >> 28) : 80 + ((y * 2) & 63); rgba[o + 2] = body ? 140 : 110; rgba[o + 3] = 255;
  }
  return rgba;
}
