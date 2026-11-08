// Pose feasibility bench: run the Electron (browser-side) measurement matrix one task at a time. NOT product code.
// Usage: node run-electron-matrix.mjs [group ...]   groups: web mp npu gesture   (default: all)
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, "run-electron.mjs");
const P = (extra = {}) => JSON.stringify({ paced: [5, 10], seconds: 15, frames: 60, ...extra });
const runs = {
  web: [
    ["ortweb", "web-gpu-A", P({ ep: "webgpu", det: "yolox_nano", pose: "rtmpose_m" })],
    ["ortweb", "web-gpu-B", P({ ep: "webgpu", det: "yolox_nano", pose: "rtmw_l_256" })],
    ["ortweb", "web-gpu-C", P({ ep: "webgpu", det: "yolox_nano", pose: "rtmw_l_384" })],
    ["ortweb", "web-gpu-Bm", P({ ep: "webgpu", det: "yolox_nano", pose: "rtmw_m_256" })],
    ["ortweb", "web-wasm4-A", P({ ep: "wasm", threads: 4, det: "yolox_nano", pose: "rtmpose_m" })],
  ],
  mp: [
    ["mediapipe", "mp-gpu", JSON.stringify({ delegate: "GPU", paced: [5, 10], seconds: 15, frames: 100 })],
    ["mediapipe", "mp-cpu", JSON.stringify({ delegate: "CPU", paced: [5, 10], seconds: 15, frames: 100 })],
  ],
  npu: [["webnn", "webnn-probe", "{}"]],
  gesture: [["gesture", "gesture-webgpu", JSON.stringify({ ep: "webgpu", rtmw: ["rtmw_l_256", "rtmw_l_384", "rtmw_m_256"], sets: ["hagrid", "rps-cgi"], mpDelegates: ["GPU", "CPU"] })]],
};
const groups = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(runs);
for (const g of groups) for (const [task, tag, params] of runs[g]) {
  console.log(`\n##### ${g}: ${task} ${tag} ${params}`);
  const r = spawnSync(process.execPath, [runner, task, tag, params], { stdio: "inherit" });
  if (r.status !== 0) console.log(`!!!!! exit ${r.status}`);
}
