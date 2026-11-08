// Sanity check: run detector + pose once on one public image (CPU) and write an annotated PNG into the bench folder.
// Usage: node sanity.mjs <image> [detector=yolox_nano] [pose=rtmw_l_256] [route=cpu]
import { writeFileSync } from "node:fs";
import path from "node:path";
import { BENCH, ort, PNG, DETECTORS, POSERS, decodeImage, createSession } from "./lib/node-common.mjs";
import { detectorInput, detectorBoxes, poseInput, simccDecode, rpsFromWholeBody } from "./lib/pose.mjs";

const [imgPath, detName = "yolox_nano", poseName = "rtmw_l_256", route = "cpu"] = process.argv.slice(2);
const det = DETECTORS[detName], pose = POSERS[poseName];
const img = decodeImage(imgPath);
const d = await createSession(det.file, route === "dml" ? "cpu" : route); // detector on the same route when asked
const p = await createSession(pose.file, route);
console.log("det inputs", d.session.inputNames, d.session.outputNames, "pose", p.session.inputNames, p.session.outputNames, "load ms", d.loadMs | 0, p.loadMs | 0);

const di = detectorInput(img.rgba, img.w, img.h, det.size, det.norm);
const dout = await d.session.run({ [d.session.inputNames[0]]: new ort.Tensor("float32", di.data, [1, 3, det.size, det.size]) });
for (const [k, v] of Object.entries(dout)) console.log("det out", k, v.dims, v.type);
const dets = dout[d.session.outputNames[0]];
const boxes = detectorBoxes(dets.data, dets.dims[1], di.ratio, 0.3, img.w, img.h);
console.log("image", img.w, img.h, "boxes", boxes.slice(0, 3));
const box = boxes[0] || { x1: 0, y1: 0, x2: img.w, y2: img.h };
const pi = poseInput(img.rgba, img.w, img.h, box, pose.W, pose.H);
const pout = await p.session.run({ [p.session.inputNames[0]]: new ort.Tensor("float32", pi.data, [1, 3, pose.H, pose.W]) });
for (const [k, v] of Object.entries(pout)) console.log("pose out", k, v.dims);
const sx = pout[p.session.outputNames[0]], sy = pout[p.session.outputNames[1]];
const { kpts, scores } = simccDecode(sx.data, sy.data, pose.K, pose.W, pose.H, pi.center, pi.scale);
if (pose.K === 133) console.log("rps", rpsFromWholeBody(kpts, scores));

// draw
const png = new PNG({ width: img.w, height: img.h });
png.data = Buffer.from(img.rgba);
const dot = (x, y, r, g, b) => { for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { const xx = Math.round(x) + i, yy = Math.round(y) + j; if (xx >= 0 && yy >= 0 && xx < img.w && yy < img.h) { const o = (yy * img.w + xx) * 4; png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; } } };
for (let k = 0; k < pose.K; k++) if (scores[k] > 0.3) dot(kpts[k * 2], kpts[k * 2 + 1], k >= 91 ? 255 : 0, k >= 91 ? 0 : 255, k >= 112 ? 255 : 0);
for (const x of [box.x1, box.x2]) for (let y = Math.floor(box.y1); y < box.y2; y++) dot(x, y, 255, 255, 0);
const out = path.join(BENCH, "runs", "sanity.png");
writeFileSync(out, PNG.sync.write(png));
console.log("wrote", out);
