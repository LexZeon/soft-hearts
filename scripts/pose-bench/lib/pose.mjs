// Pose feasibility bench: isomorphic (Node + browser) pre/post-processing for YOLOX / RTMDet person detectors
// and RTMPose / RTMW top-down pose models, plus a finger-extension rock-paper-scissors rule.
// Ported from the model pipeline.json files and checked against the rtmlib reference (Apache-2.0).
// NOT product code. No imports on purpose: the same file runs in Node and in the Electron test window.

/** Bilinear sample of an RGBA image at (x, y) in OpenCV pixel convention (pixel centres on integers). Zero outside. */
function sampleRGBA(rgba, w, h, x, y, out) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  let r = 0, g = 0, b = 0;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const xx = x0 + i, yy = y0 + j;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const wgt = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      const p = (yy * w + xx) * 4;
      r += rgba[p] * wgt; g += rgba[p + 1] * wgt; b += rgba[p + 2] * wgt;
    }
  }
  out[0] = r; out[1] = g; out[2] = b;
}

/**
 * Detector input: keep aspect ratio, resize into the top-left of a size x size canvas padded with 114,
 * channels in BGR order (mmdet/cv2 convention), optional per-channel mean/std in BGR order.
 * Returns { data: Float32Array NCHW, ratio }.
 */
export function detectorInput(rgba, w, h, size, norm = null) {
  const ratio = Math.min(size / h, size / w);
  const nw = Math.floor(w * ratio), nh = Math.floor(h * ratio);
  const plane = size * size;
  const data = new Float32Array(3 * plane);
  const mean = norm ? norm.mean : [0, 0, 0], std = norm ? norm.std : [1, 1, 1];
  for (let c = 0; c < 3; c++) data.fill((114 - mean[c]) / std[c], c * plane, (c + 1) * plane);
  const px = [0, 0, 0];
  for (let y = 0; y < nh; y++) {
    const sy = (y + 0.5) * (h / nh) - 0.5;
    for (let x = 0; x < nw; x++) {
      const sx = (x + 0.5) * (w / nw) - 0.5;
      sampleRGBA(rgba, w, h, Math.min(Math.max(sx, 0), w - 1), Math.min(Math.max(sy, 0), h - 1), px);
      const o = y * size + x;
      // BGR planes
      data[o] = (px[2] - mean[0]) / std[0];
      data[plane + o] = (px[1] - mean[1]) / std[1];
      data[2 * plane + o] = (px[0] - mean[2]) / std[2];
    }
  }
  return { data, ratio };
}

/** dets: Float32Array [N,5] (x1,y1,x2,y2,score) in detector input pixels. Returns person boxes in image pixels, best first. */
export function detectorBoxes(dets, n, ratio, scoreThr = 0.3, w = Infinity, h = Infinity) {
  const boxes = [];
  for (let i = 0; i < n; i++) {
    const s = dets[i * 5 + 4];
    if (!(s > scoreThr)) continue;
    const x1 = Math.max(0, dets[i * 5] / ratio), y1 = Math.max(0, dets[i * 5 + 1] / ratio);
    const x2 = Math.min(w, dets[i * 5 + 2] / ratio), y2 = Math.min(h, dets[i * 5 + 3] / ratio);
    if (x2 - x1 < 8 || y2 - y1 < 8) continue;
    boxes.push({ x1, y1, x2, y2, score: s, area: (x2 - x1) * (y2 - y1) });
  }
  boxes.sort((a, b) => b.area * b.score - a.area * a.score);
  return boxes;
}

/**
 * Top-down pose input. bbox in image pixels. Pads the box by 1.25, fixes the aspect ratio to W:H, warps with bilinear
 * sampling (zero outside), normalises as RGB with the standard mmpose mean/std. Returns { data NCHW, center, scale }.
 */
export function poseInput(rgba, w, h, bbox, W, H) {
  const cx = (bbox.x1 + bbox.x2) / 2, cy = (bbox.y1 + bbox.y2) / 2;
  let sw = (bbox.x2 - bbox.x1) * 1.25, sh = (bbox.y2 - bbox.y1) * 1.25;
  const aspect = W / H;
  if (sw > sh * aspect) sh = sw / aspect; else sw = sh * aspect;
  const k = sw / W; // identical to sh / H after the aspect fix
  const plane = W * H;
  const data = new Float32Array(3 * plane);
  const mean = [123.675, 116.28, 103.53], std = [58.395, 57.12, 57.375];
  const px = [0, 0, 0];
  for (let v = 0; v < H; v++) {
    const sy = cy + (v - H / 2) * k;
    for (let u = 0; u < W; u++) {
      const sx = cx + (u - W / 2) * k;
      sampleRGBA(rgba, w, h, sx, sy, px);
      const o = v * W + u;
      data[o] = (px[0] - mean[0]) / std[0];
      data[plane + o] = (px[1] - mean[1]) / std[1];
      data[2 * plane + o] = (px[2] - mean[2]) / std[2];
    }
  }
  return { data, center: [cx, cy], scale: [sw, sh] };
}

/** SimCC decode: simccX [K, W*2], simccY [K, H*2] (flat Float32Array). Returns { kpts: Float32Array [K,2], scores: Float32Array [K] } in image pixels. */
export function simccDecode(simccX, simccY, K, W, H, center, scale, split = 2) {
  const nx = simccX.length / K, ny = simccY.length / K;
  const kpts = new Float32Array(K * 2), scores = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    let bx = 0, vx = -Infinity, by = 0, vy = -Infinity;
    const ox = k * nx, oy = k * ny;
    for (let i = 0; i < nx; i++) { const v = simccX[ox + i]; if (v > vx) { vx = v; bx = i; } }
    for (let i = 0; i < ny; i++) { const v = simccY[oy + i]; if (v > vy) { vy = v; by = i; } }
    const px = bx / split, py = by / split;
    kpts[k * 2] = (px / W) * scale[0] + center[0] - scale[0] / 2;
    kpts[k * 2 + 1] = (py / H) * scale[1] + center[1] - scale[1] / 2;
    scores[k] = Math.min(vx, vy);
  }
  return { kpts, scores };
}

// COCO-WholeBody 133 layout: 0-16 body, 17-22 feet, 23-90 face, 91-111 left hand, 112-132 right hand.
export const HAND_OFFSET = { left: 91, right: 112 };
const FINGERS = { index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] };

/** One hand: which of the four non-thumb fingers are extended, from the tip-vs-PIP distance to the wrist. */
export function handFingers(kpts, scores, offset, ratioThr = 1.15) {
  const pt = (i) => [kpts[(offset + i) * 2], kpts[(offset + i) * 2 + 1]];
  const wrist = pt(0);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let meanScore = 0;
  for (let i = 0; i < 21; i++) meanScore += scores[offset + i];
  meanScore /= 21;
  const ext = {};
  for (const [name, [m, p, dd, t]] of Object.entries(FINGERS)) {
    const dTip = d(wrist, pt(t)), dPip = d(wrist, pt(p));
    ext[name] = dPip > 1e-6 && dTip / dPip >= ratioThr;
  }
  return { ext, meanScore };
}

/** rock = no finger extended; scissors = exactly index + middle; paper = at least three extended; otherwise "none". */
export function rpsFromFingers(ext) {
  const n = Object.values(ext).filter(Boolean).length;
  if (n === 0) return "rock";
  if (ext.index && ext.middle && !ext.ring && !ext.pinky) return "scissors";
  if (n >= 3) return "paper";
  return "none";
}

/** Pick the more confident hand and classify. Returns { label, hand, meanScore, ext }. */
export function rpsFromWholeBody(kpts, scores, { ratioThr = 1.15, minHandScore = 0.3 } = {}) {
  const l = handFingers(kpts, scores, HAND_OFFSET.left, ratioThr);
  const r = handFingers(kpts, scores, HAND_OFFSET.right, ratioThr);
  const best = l.meanScore >= r.meanScore ? { hand: "left", ...l } : { hand: "right", ...r };
  if (best.meanScore < minHandScore) return { label: "none", ...best };
  return { label: rpsFromFingers(best.ext), ...best };
}

export function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
export function summarize(ms) {
  const s = [...ms].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { n: s.length, mean, p50: percentile(s, 50), p90: percentile(s, 90), min: s[0], max: s[s.length - 1] };
}
