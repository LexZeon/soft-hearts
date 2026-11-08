// Pose feasibility bench: Node-side helpers (onnxruntime-node sessions, image decode, model catalogue).
// NOT product code. Everything lives under the bench folder; nothing is written to the repo or the app profile.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

export const BENCH = process.env.POSE_BENCH_DIR || path.join(process.env.LOCALAPPDATA, "soft-hearts-next-bench");
const requireFromBench = createRequire(path.join(BENCH, "npm", "package.json"));
export const ort = requireFromBench("onnxruntime-node");
export const jpeg = requireFromBench("jpeg-js");
export const { PNG } = requireFromBench("pngjs");

const M = (f) => path.join(BENCH, "models", "flat", f);
export const DETECTORS = {
  yolox_nano: { file: M("det_yolox_nano.onnx"), size: 416, norm: null },
  yolox_tiny: { file: M("det_yolox_tiny.onnx"), size: 416, norm: null },
  rtmdet_nano: { file: M("det_rtmdet_nano.onnx"), size: 320, norm: { mean: [103.53, 116.28, 123.675], std: [57.375, 57.12, 58.395] } },
};
export const POSERS = {
  rtmpose_m: { file: M("pose_rtmpose_m_256x192.onnx"), W: 192, H: 256, K: 17 },
  rtmw_m_256: { file: M("wb_rtmw_m_256x192.onnx"), W: 192, H: 256, K: 133 },
  rtmw_l_256: { file: M("wb_rtmw_l_256x192.onnx"), W: 192, H: 256, K: 133 },
  rtmw_l_384: { file: M("wb_rtmw_l_384x288.onnx"), W: 288, H: 384, K: 133 },
};

/** Decode a JPEG/PNG file to { rgba: Uint8Array, w, h }. */
export function decodeImage(file) {
  const buf = readFileSync(file);
  if (buf[0] === 0xff) { const r = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true }); return { rgba: r.data, w: r.width, h: r.height }; }
  const p = PNG.sync.read(buf);
  return { rgba: new Uint8Array(p.data), w: p.width, h: p.height };
}

/** Execution provider presets for onnxruntime-node. */
export function sessionOptions(route, threads = 0, spin = "") {
  const base = { graphOptimizationLevel: "all", logSeverityLevel: 3, ...(spin === "0" ? { extra: { session: { intra_op: { allow_spinning: "0" } } } } : {}) };
  if (route === "cpu") return { ...base, executionProviders: ["cpu"], ...(threads ? { intraOpNumThreads: threads, interOpNumThreads: 1 } : {}) };
  const m = /^dml(\d+)?$/.exec(route);
  if (m) {
    // DirectML requires sequential execution and no memory-pattern optimisation.
    return { ...base, executionProviders: [{ name: "dml", deviceId: m[1] ? Number(m[1]) : 0 }], executionMode: "sequential", enableMemPattern: false };
  }
  throw new Error("unknown route " + route);
}

export async function createSession(file, route, threads = 0, spin = "") {
  const t0 = performance.now();
  const session = await ort.InferenceSession.create(file, sessionOptions(route, threads, spin));
  return { session, loadMs: performance.now() - t0 };
}
