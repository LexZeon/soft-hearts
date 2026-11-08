// How much of the per-frame cost is the JS pre/post-processing itself (no inference)? NOT product code.
import { readdirSync } from "node:fs";
import path from "node:path";
import { BENCH, decodeImage } from "./lib/node-common.mjs";
import { detectorInput, poseInput, simccDecode, summarize } from "./lib/pose.mjs";

const hag = path.join(BENCH, "images", "hagrid", "palm");
const src = decodeImage(path.join(hag, readdirSync(hag).filter((f) => f.endsWith(".jpg"))[3]));
const FW = 640, FH = 480, frame = new Uint8Array(FW * FH * 4);
for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
  const o = (y * FW + x) * 4, s = (Math.min(src.h - 1, Math.floor((y / FH) * src.h)) * src.w + Math.min(src.w - 1, Math.floor((x / FW) * src.w))) * 4;
  frame[o] = src.rgba[s]; frame[o + 1] = src.rgba[s + 1]; frame[o + 2] = src.rgba[s + 2]; frame[o + 3] = 255;
}
const t = (fn, n = 60) => { for (let i = 0; i < 5; i++) fn(); const a = []; for (let i = 0; i < n; i++) { const s = performance.now(); fn(); a.push(performance.now() - s); } const m = summarize(a); return `${m.p50.toFixed(2)} / ${m.p90.toFixed(2)} ms`; };
const box = { x1: 100, y1: 40, x2: 540, y2: 470 };
console.log("detector input 416 (YOLOX)  p50/p90:", t(() => detectorInput(frame, FW, FH, 416, null)));
console.log("detector input 320 (RTMDet) p50/p90:", t(() => detectorInput(frame, FW, FH, 320, { mean: [103.53, 116.28, 123.675], std: [57.375, 57.12, 58.395] })));
console.log("pose input 192x256          p50/p90:", t(() => poseInput(frame, FW, FH, box, 192, 256)));
console.log("pose input 288x384          p50/p90:", t(() => poseInput(frame, FW, FH, box, 288, 384)));
const sx = new Float32Array(133 * 384).map(() => Math.random()), sy = new Float32Array(133 * 512).map(() => Math.random());
console.log("SimCC decode 133 points     p50/p90:", t(() => simccDecode(sx, sy, 133, 192, 256, [320, 240], [440, 586])));
