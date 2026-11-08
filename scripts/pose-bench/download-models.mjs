// Pose feasibility bench: download the official model files into the bench folder.
// NOT product code. Usage: node scripts/pose-bench/download-models.mjs [bench-dir]
// Every file is recorded in downloads/manifest.json with URL, size and SHA-256.
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";

const bench = process.argv[2] || path.join(process.env.LOCALAPPDATA, "soft-hearts-next-bench");
if (!bench.includes("soft-hearts-next-bench")) throw new Error("refusing to write outside the bench folder");
const dir = path.join(bench, "downloads");
mkdirSync(dir, { recursive: true });
const manifestPath = path.join(dir, "manifest.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};

const OM = "https://download.openmmlab.com/mmpose/v1/projects";
const FILES = [
  ["rtmpose-m_body7_256x192.zip", `${OM}/rtmposev1/onnx_sdk/rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504.zip`],
  ["yolox_nano_humanart.zip", `${OM}/rtmposev1/onnx_sdk/yolox_nano_8xb8-300e_humanart-40f6f0d0.zip`],
  ["yolox_tiny_humanart.zip", `${OM}/rtmposev1/onnx_sdk/yolox_tiny_8xb8-300e_humanart-6f3252f9.zip`],
  ["rtmpose-cpu.zip", `${OM}/rtmpose/rtmpose-cpu.zip`],
  ["rtmw-l_256x192.zip", `${OM}/rtmw/onnx_sdk/rtmw-dw-x-l_simcc-cocktail14_270e-256x192_20231122.zip`],
  ["rtmw-m_256x192.zip", `${OM}/rtmw/onnx_sdk/rtmw-dw-l-m_simcc-cocktail14_270e-256x192_20231122.zip`],
  ["rtmw-l_384x288.zip", `${OM}/rtmw/onnx_sdk/rtmw-dw-x-l_simcc-cocktail14_270e-384x288_20231122.zip`],
  ["gesture_recognizer.task", "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task"],
  ["rps-test-set.zip", "https://storage.googleapis.com/download.tensorflow.org/data/rps-test-set.zip"],
];

async function sha256(file) {
  const h = createHash("sha256");
  await pipeline((await import("node:fs")).createReadStream(file), h);
  return h.digest("hex");
}

for (const [name, url] of FILES) {
  const target = path.join(dir, name);
  if (!existsSync(target)) {
    const res = await fetch(url);
    if (!res.ok) { console.error("FAILED", url, res.status); continue; }
    await pipeline(Readable.fromWeb(res.body), createWriteStream(target));
  }
  manifest[name] = { url, size: statSync(target).size, sha256: await sha256(target), downloadedAt: new Date().toISOString() };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log("ok", name, manifest[name].size);
}
