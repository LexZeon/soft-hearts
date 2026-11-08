// Probe: can onnxruntime-node's DirectML execution provider be pointed at the "NVIDIA NPU" (an MCDM compute-only adapter)?
// Tries several provider-option spellings and prints what happens. NOT product code.
import { ort, DETECTORS } from "./lib/node-common.mjs";

const file = DETECTORS.yolox_nano.file;
const attempts = [
  ["dml deviceId 0", { name: "dml", deviceId: 0 }],
  ["dml deviceId 1", { name: "dml", deviceId: 1 }],
  ["dml device_filter npu", { name: "dml", device_filter: "npu" }],
  ["dml deviceFilter npu", { name: "dml", deviceFilter: "npu" }],
  ["dml performance_preference minimum_power", { name: "dml", performance_preference: "minimum_power" }],
  ["dml device_filter any", { name: "dml", device_filter: "any" }],
];
for (const [label, ep] of attempts) {
  const t0 = performance.now();
  try {
    const s = await ort.InferenceSession.create(file, { executionProviders: [ep], executionMode: "sequential", enableMemPattern: false, logSeverityLevel: 3 });
    console.log("OK  ", label, (performance.now() - t0).toFixed(0), "ms", s.inputNames);
  } catch (e) {
    console.log("FAIL", label, String(e.message).split("\n")[0].replace(/[^\x20-\x7e]/g, "?").slice(0, 160));
  }
}
