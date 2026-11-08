// Pose feasibility bench: onnxruntime-node (CPU / DirectML) speed + resource measurement. NOT product code.
// Input frames are one public photo (HaGRID, a person at a desk-like distance) upscaled to 640x480 - no camera is opened.
//   node bench-node.mjs --route cpu --threads 4 --det yolox_nano --pose rtmw_l_256 --frames 60 --paced 5,10 --seconds 20 --tag cpu4-rtmw_l
import { writeFileSync, readdirSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { BENCH, ort, DETECTORS, POSERS, decodeImage, createSession } from "./lib/node-common.mjs";
import { detectorInput, detectorBoxes, poseInput, simccDecode, summarize } from "./lib/pose.mjs";
import { startSampler, reduce } from "./lib/sampling.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const route = args.route || "cpu", threads = Number(args.threads || 0);
const detName = args.det || "yolox_nano", poseName = args.pose || "rtmpose_m";
const detRoute = args["det-route"] || route; // the detector may run on a different route than the pose model
const frames = Number(args.frames || 60), seconds = Number(args.seconds || 20);
const paced = (args.paced || "").split(",").filter(Boolean).map(Number);
const tag = args.tag || `${route}${threads || ""}${args.spin === "0" ? "ns" : ""}-${detName}-${poseName}`;
const detEvery = Number(args["det-every"] || 1);
mkdirSync(path.join(BENCH, "runs"), { recursive: true });

// ---- frame source: public photo scaled to 640x480 (stretching is irrelevant for timing)
const hag = path.join(BENCH, "images", "hagrid", "palm");
const src = decodeImage(path.join(hag, readdirSync(hag).filter((f) => f.endsWith(".jpg"))[3]));
const FW = 640, FH = 480;
const frame = new Uint8Array(FW * FH * 4);
for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
  const sx = Math.min(src.w - 1, Math.floor((x / FW) * src.w)), sy = Math.min(src.h - 1, Math.floor((y / FH) * src.h));
  const o = (y * FW + x) * 4, s = (sy * src.w + sx) * 4;
  frame[o] = src.rgba[s]; frame[o + 1] = src.rgba[s + 1]; frame[o + 2] = src.rgba[s + 2]; frame[o + 3] = 255;
}

const det = DETECTORS[detName], pose = POSERS[poseName];
const result = { tag, route, detRoute, threads, det: detName, pose: poseName, node: process.version, ort: ort.env?.versions ?? null, frames, startedAt: new Date().toISOString() };

const d = await createSession(det.file, detRoute, threads, args.spin);
const p = await createSession(pose.file, route, threads, args.spin);
result.loadMs = { det: +d.loadMs.toFixed(0), pose: +p.loadMs.toFixed(0) };

let lastBox = null;
async function oneFrame(useDet) {
  const t0 = performance.now();
  let box = lastBox;
  let tDetPre = 0, tDet = 0;
  if (useDet || !box) {
    const a = performance.now();
    const di = detectorInput(frame, FW, FH, det.size, det.norm);
    const b = performance.now();
    const out = await d.session.run({ [d.session.inputNames[0]]: new ort.Tensor("float32", di.data, [1, 3, det.size, det.size]) });
    const c = performance.now();
    const dets = out[d.session.outputNames[0]];
    const boxes = detectorBoxes(dets.data, dets.dims[1], di.ratio, 0.3, FW, FH);
    box = boxes[0] || { x1: 0, y1: 0, x2: FW, y2: FH };
    lastBox = box;
    tDetPre = b - a; tDet = c - b + (performance.now() - c);
  }
  const e = performance.now();
  const pi = poseInput(frame, FW, FH, box, pose.W, pose.H);
  const f = performance.now();
  const pout = await p.session.run({ [p.session.inputNames[0]]: new ort.Tensor("float32", pi.data, [1, 3, pose.H, pose.W]) });
  const g = performance.now();
  simccDecode(pout[p.session.outputNames[0]].data, pout[p.session.outputNames[1]].data, pose.K, pose.W, pose.H, pi.center, pi.scale);
  const h = performance.now();
  return { det: tDetPre + tDet, pose: (f - e) + (g - f) + (h - g), poseRun: g - f, total: h - t0, ranDet: useDet || tDet > 0 };
}

// warm-up: first frame is reported separately
const first = await oneFrame(true);
result.firstFrameMs = { det: +first.det.toFixed(1), pose: +first.pose.toFixed(1), total: +first.total.toFixed(1) };
for (let i = 0; i < 3; i++) await oneFrame(true);
result.afterLoad = { rssMB: +(process.memoryUsage().rss / 1048576).toFixed(0) };

// unpaced: detector + pose every frame, then pose only
const all = [];
for (let i = 0; i < frames; i++) all.push(await oneFrame(true));
const poseOnly = [];
for (let i = 0; i < frames; i++) poseOnly.push(await oneFrame(false));
const sm = (k, arr) => Object.fromEntries(Object.entries(summarize(arr.map((x) => x[k]))).map(([a, b]) => [a, +b.toFixed(2)]));
result.unpaced = { det: sm("det", all), pose: sm("pose", all), total: sm("total", all), poseOnlyTotal: sm("total", poseOnly), maxFps: +(1000 / summarize(all.map((x) => x.total)).mean).toFixed(1), maxFpsPoseOnly: +(1000 / summarize(poseOnly.map((x) => x.total)).mean).toFixed(1) };

// idle baseline then paced runs
async function sampled(label, seconds0, work) {
  const out = path.join(BENCH, "runs", `${tag}-${label}.sample.json`);
  const lead = 3, tail = 1;
  const sp = startSampler([process.pid], seconds0 + lead + tail + 1, out);
  await new Promise((r) => setTimeout(r, lead * 1000));
  const from = Date.now(); const cpu0 = process.cpuUsage();
  const extra = await work();
  const cpu1 = process.cpuUsage(cpu0); const to = Date.now();
  await new Promise((r) => setTimeout(r, tail * 1000));
  const raw = await sp;
  if (!raw) return { error: "sampler failed" };
  raw.samples = raw.samples.filter((s) => { const t = Date.parse(s.t); return t >= from + 500 && t <= to + 500; });
  raw.samples.unshift(raw.samples[0] ?? { t: "", sysCpu: 0, procs: {}, gpu: [] }); // reduce() drops the first sample
  const red = reduce(raw, [String(process.pid)]);
  return { ...red, selfCpuCores: +((cpu1.user + cpu1.system) / 1e6 / ((to - from) / 1000)).toFixed(3), ...extra };
}
result.idleBaseline = await sampled("idle", 6, () => new Promise((r) => setTimeout(() => r({}), 6000)));
result.paced = {};
for (const fps of paced) {
  const interval = 1000 / fps;
  result.paced[fps] = await sampled(`paced${fps}`, seconds, async () => {
    const per = []; let late = 0, i = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < seconds * 1000) {
      const due = t0 + i * interval;
      const wait = due - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait)); else late++;
      const useDet = i % detEvery === 0;
      per.push((await oneFrame(useDet)).total);
      i++;
    }
    const s = summarize(per);
    return { frames: per.length, achievedFps: +(per.length / seconds).toFixed(2), lateFrames: late, frameMsP50: +s.p50.toFixed(1), frameMsP90: +s.p90.toFixed(1) };
  });
}
result.finishedAt = new Date().toISOString();
const outFile = path.join(BENCH, "runs", `${tag}.json`);
writeFileSync(outFile, JSON.stringify(result, null, 1));
console.log(JSON.stringify({ tag, loadMs: result.loadMs, first: result.firstFrameMs, unpaced: result.unpaced, idle: { sysCpu: result.idleBaseline.sysCpuPct }, paced: Object.fromEntries(Object.entries(result.paced).map(([k, v]) => [k, { fps: v.achievedFps, procCores: v.procCores, selfCores: v.selfCpuCores, pctMachine: v.procPctOfMachine, sysCpu: v.sysCpuPct, gpu: v.gpuByEngineType, wsMB: v.workingSetMB, privMB: v.privateMB }])) }, null, 1));
