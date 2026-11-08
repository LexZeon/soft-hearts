// Pose feasibility bench: page that runs inside the throw-away Electron window. NOT product code.
// Tasks (chosen by main.cjs --task): info | ortweb | mediapipe | gesture | webnn
import { detectorInput, detectorBoxes, poseInput, simccDecode, rpsFromWholeBody, summarize } from "/lib/pose.mjs";

const cfg = await (await fetch("/api/params")).json();
const { task, params } = cfg;
const out = document.getElementById("o");
const log = (m) => { out.textContent += "\n" + m; fetch("/api/log?m=" + encodeURIComponent(m)).catch(() => {}); };
const report = (obj) => fetch("/api/report", { method: "POST", body: JSON.stringify(obj, null, 1) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OD = "/bench/npm/node_modules/onnxruntime-web/dist/";
const M = (f) => `/bench/models/flat/${f}`;
const DETECTORS = {
  yolox_nano: { url: M("det_yolox_nano.onnx"), size: 416, norm: null },
  yolox_tiny: { url: M("det_yolox_tiny.onnx"), size: 416, norm: null },
  rtmdet_nano: { url: M("det_rtmdet_nano.onnx"), size: 320, norm: { mean: [103.53, 116.28, 123.675], std: [57.375, 57.12, 58.395] } },
};
const POSERS = {
  rtmpose_m: { url: M("pose_rtmpose_m_256x192.onnx"), W: 192, H: 256, K: 17 },
  rtmw_m_256: { url: M("wb_rtmw_m_256x192.onnx"), W: 192, H: 256, K: 133 },
  rtmw_l_256: { url: M("wb_rtmw_l_256x192.onnx"), W: 192, H: 256, K: 133 },
  rtmw_l_384: { url: M("wb_rtmw_l_384x288.onnx"), W: 288, H: 384, K: 133 },
};

async function envInfo() {
  const info = { userAgent: navigator.userAgent, crossOriginIsolated: self.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency, hasWebGPU: !!navigator.gpu, hasWebNN: !!navigator.ml };
  try {
    const a = await navigator.gpu.requestAdapter();
    const i = a.info ?? (await a.requestAdapterInfo?.());
    info.webgpuAdapter = { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description, features: [...a.features].slice(0, 30) };
  } catch (e) { info.webgpuError = String(e); }
  return info;
}

async function loadRGBA(url, w, h) {
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  const W = w ?? bmp.width, H = h ?? bmp.height;
  const c = new OffscreenCanvas(W, H); const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, W, H);
  const id = ctx.getImageData(0, 0, W, H);
  return { rgba: id.data, w: W, h: H, canvas: c };
}

async function sampled(label, seconds, work) {
  const start = await (await fetch(`/api/sampler/start?label=${label}&seconds=${seconds + 5}`)).json();
  await sleep(3000);
  const from = Date.now();
  const extra = await work();
  const to = Date.now();
  await sleep(1000);
  const red = await (await fetch(`/api/sampler/finish?label=${label}&from=${from}&to=${to}`)).json();
  return { ...red, processes: start.types, ...extra };
}

async function paced(fps, seconds, fn) {
  const interval = 1000 / fps; const per = []; let late = 0, i = 0; const t0 = performance.now();
  while (performance.now() - t0 < seconds * 1000) {
    const wait = t0 + i * interval - performance.now();
    if (wait > 0) await sleep(wait); else late++;
    const a = performance.now(); await fn(i); per.push(performance.now() - a); i++;
  }
  const s = summarize(per);
  return { frames: per.length, achievedFps: +(per.length / seconds).toFixed(2), lateFrames: late, frameMsP50: +s.p50.toFixed(1), frameMsP90: +s.p90.toFixed(1) };
}
const sm = (arr) => Object.fromEntries(Object.entries(summarize(arr)).map(([k, v]) => [k, +v.toFixed(2)]));

async function makeOrt(bundle) {
  const ort = await import(OD + bundle);
  ort.env.wasm.wasmPaths = OD;
  ort.env.wasm.numThreads = params.threads ?? 4;
  ort.env.logLevel = "error";
  return ort;
}
const epOf = (ep) => (ep === "webnn-npu" ? { name: "webnn", deviceType: "npu" } : ep === "webnn-gpu" ? { name: "webnn", deviceType: "gpu" } : ep);
async function makeSession(ort, url, ep) {
  const t0 = performance.now();
  const session = await ort.InferenceSession.create(url, { executionProviders: [epOf(ep)], graphOptimizationLevel: "all" });
  return { session, loadMs: performance.now() - t0 };
}

/** Detector + pose on one RGBA image; returns { box, kpts, scores, tDet, tPose }. */
async function runPipeline(ort, d, det, p, pose, img, { forceFull = false, box: given = null } = {}) {
  let box = given, tDet = 0;
  if (!box) {
    if (forceFull) box = { x1: 0, y1: 0, x2: img.w, y2: img.h };
    else {
      const a = performance.now();
      const di = detectorInput(img.rgba, img.w, img.h, det.size, det.norm);
      const out = await d.session.run({ [d.session.inputNames[0]]: new ort.Tensor("float32", di.data, [1, 3, det.size, det.size]) });
      const dets = out[d.session.outputNames[0]];
      const arr = await dets.getData();
      box = detectorBoxes(arr, dets.dims[1], di.ratio, 0.3, img.w, img.h)[0] || { x1: 0, y1: 0, x2: img.w, y2: img.h, noPerson: true };
      tDet = performance.now() - a;
    }
  }
  const b = performance.now();
  const pi = poseInput(img.rgba, img.w, img.h, box, pose.W, pose.H);
  const o = await p.session.run({ [p.session.inputNames[0]]: new ort.Tensor("float32", pi.data, [1, 3, pose.H, pose.W]) });
  const sx = await o[p.session.outputNames[0]].getData(), sy = await o[p.session.outputNames[1]].getData();
  const dec = simccDecode(sx, sy, pose.K, pose.W, pose.H, pi.center, pi.scale);
  return { box, ...dec, tDet, tPose: performance.now() - b };
}

// ---------------------------------------------------------------- tasks
async function taskInfo() { return { task, env: await envInfo() }; }

async function taskOrtweb() {
  const ep = params.ep || "webgpu";
  const bundle = params.bundle || (ep.startsWith("webnn") ? "ort.all.bundle.min.mjs" : ep === "wasm" ? "ort.wasm.bundle.min.mjs" : "ort.webgpu.bundle.min.mjs");
  const ort = await makeOrt(bundle);
  const det = DETECTORS[params.det || "yolox_nano"], pose = POSERS[params.pose || "rtmpose_m"];
  const res = { task, ep, bundle, det: params.det || "yolox_nano", pose: params.pose || "rtmpose_m", threads: params.threads ?? 4, env: await envInfo() };
  let d, p;
  try {
    d = await makeSession(ort, det.url, params["det-ep"] || ep);
    p = await makeSession(ort, pose.url, ep);
  } catch (e) { res.error = String(e && e.message || e); log("session error " + res.error); return res; }
  res.loadMs = { det: +d.loadMs.toFixed(0), pose: +p.loadMs.toFixed(0) };
  const frame = await loadRGBA((await (await fetch("/api/list?dir=hagrid/palm")).json()).map((f) => `/bench/images/hagrid/palm/${f}`)[3], 640, 480);
  const t0 = performance.now();
  await runPipeline(ort, d, det, p, pose, frame);
  res.firstFrameMs = +(performance.now() - t0).toFixed(1);
  for (let i = 0; i < 3; i++) await runPipeline(ort, d, det, p, pose, frame);
  const frames = params.frames ?? 60;
  const all = [], poseOnly = []; let box = null;
  for (let i = 0; i < frames; i++) { const a = performance.now(); const r = await runPipeline(ort, d, det, p, pose, frame); all.push({ det: r.tDet, pose: r.tPose, total: performance.now() - a }); box = r.box; }
  for (let i = 0; i < frames; i++) { const a = performance.now(); await runPipeline(ort, d, det, p, pose, frame, { box }); poseOnly.push(performance.now() - a); }
  res.unpaced = { det: sm(all.map((x) => x.det)), pose: sm(all.map((x) => x.pose)), total: sm(all.map((x) => x.total)), poseOnlyTotal: sm(poseOnly),
    maxFps: +(1000 / summarize(all.map((x) => x.total)).mean).toFixed(1), maxFpsPoseOnly: +(1000 / summarize(poseOnly).mean).toFixed(1) };
  res.idleBaseline = await sampled("idle", 6, async () => { await sleep(6000); return {}; });
  res.paced = {};
  const seconds = params.seconds ?? 15;
  for (const fps of params.paced ?? []) res.paced[fps] = await sampled(`paced${fps}`, seconds, () => paced(fps, seconds, () => runPipeline(ort, d, det, p, pose, frame)));
  return res;
}

async function taskMediapipe() {
  const { FilesetResolver, GestureRecognizer } = await import("/bench/npm/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs");
  const fileset = await FilesetResolver.forVisionTasks("/bench/npm/node_modules/@mediapipe/tasks-vision/wasm");
  const delegate = params.delegate || "GPU";
  const res = { task, delegate, env: await envInfo() };
  const t0 = performance.now();
  let rec;
  try {
    rec = await GestureRecognizer.createFromOptions(fileset, { baseOptions: { modelAssetPath: "/bench/models/mediapipe/gesture_recognizer.task", delegate }, runningMode: "VIDEO", numHands: params.numHands ?? 1 });
  } catch (e) { res.error = String(e && e.message || e); return res; }
  res.loadMs = +(performance.now() - t0).toFixed(0);
  const frame = await loadRGBA((await (await fetch("/api/list?dir=hagrid/palm")).json()).map((f) => `/bench/images/hagrid/palm/${f}`)[3], 640, 480);
  const canvas = frame.canvas;
  let ts = 1000;
  const one = async () => { ts += 33; const r = rec.recognizeForVideo(canvas, ts); return r; };
  const a = performance.now(); await one(); res.firstFrameMs = +(performance.now() - a).toFixed(1);
  for (let i = 0; i < 5; i++) await one();
  const per = []; for (let i = 0; i < (params.frames ?? 100); i++) { const t = performance.now(); await one(); per.push(performance.now() - t); }
  res.unpaced = { ...sm(per), maxFps: +(1000 / summarize(per).mean).toFixed(1) };
  res.idleBaseline = await sampled("idle", 6, async () => { await sleep(6000); return {}; });
  res.paced = {};
  const seconds = params.seconds ?? 15;
  for (const fps of params.paced ?? []) res.paced[fps] = await sampled(`paced${fps}`, seconds, () => paced(fps, seconds, one));
  return res;
}

const HAGRID_TRUTH = { fist: "rock", palm: "paper", peace: "scissors", ok: "none", like: "none", one: "none", call: "none" };
const MP_MAP = { Closed_Fist: "rock", Open_Palm: "paper", Victory: "scissors" };

async function taskGesture() {
  const ort = await makeOrt(params.bundle || "ort.webgpu.bundle.min.mjs");
  const ep = params.ep || "webgpu";
  const det = DETECTORS[params.det || "yolox_nano"];
  const res = { task, ep, det: params.det || "yolox_nano", env: await envInfo(), variants: params.rtmw ?? ["rtmw_l_256"], mpDelegates: params.mpDelegates ?? ["GPU", "CPU"], rows: [], timing: {} };
  // ---- image lists
  const sets = [];
  if ((params.sets ?? ["hagrid", "rps-cgi"]).includes("hagrid")) {
    const m = await (await fetch("/bench/images/hagrid/manifest.json")).json();
    sets.push({ name: "hagrid", forceFull: false, items: m.files.map((f) => ({ url: `/bench/images/hagrid/${f.cls}/${f.file}`, file: `${f.cls}/${f.file}`, truth: HAGRID_TRUTH[f.cls], cls: f.cls })) });
  }
  if ((params.sets ?? ["hagrid", "rps-cgi"]).includes("rps-cgi")) {
    const list = await (await fetch("/api/list?dir=rps-cgi")).json();
    const per = params.cgiPerClass ?? 80; const count = {};
    sets.push({ name: "rps-cgi", forceFull: true, items: list.filter((f) => /\/(rock|paper|scissors)\//.test(f)).sort().filter((f) => { const c = f.match(/\/(rock|paper|scissors)\//)[1]; count[c] = (count[c] ?? 0) + 1; return count[c] <= per; }).map((f) => ({ url: `/bench/images/rps-cgi/${f}`, file: f, truth: f.match(/\/(rock|paper|scissors)\//)[1], cls: f.match(/\/(rock|paper|scissors)\//)[1] })) });
  }
  if (params.limit) for (const s of sets) { const step = Math.max(1, Math.floor(s.items.length / params.limit)); s.items = s.items.filter((_, i) => i % step === 0).slice(0, params.limit); }
  // ---- RTMW sessions
  const d = await makeSession(ort, det.url, params["det-ep"] || ep);
  const sessions = {};
  for (const v of res.variants) sessions[v] = await makeSession(ort, POSERS[v].url, ep);
  res.loadMs = { det: +d.loadMs.toFixed(0), ...Object.fromEntries(Object.entries(sessions).map(([k, v]) => [k, +v.loadMs.toFixed(0)])) };
  // ---- MediaPipe
  const { FilesetResolver, GestureRecognizer } = await import("/bench/npm/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs");
  const fileset = await FilesetResolver.forVisionTasks("/bench/npm/node_modules/@mediapipe/tasks-vision/wasm");
  const mp = {};
  for (const delegate of res.mpDelegates) {
    try { mp[delegate] = await GestureRecognizer.createFromOptions(fileset, { baseOptions: { modelAssetPath: "/bench/models/mediapipe/gesture_recognizer.task", delegate }, runningMode: "IMAGE", numHands: 2 }); }
    catch (e) { res.timing["mp-" + delegate + "-error"] = String(e && e.message || e); }
  }
  const tm = {};
  const push = (k, v) => (tm[k] ??= []).push(v);
  // warm up each path once on the first image
  const warm = await loadRGBA(sets[0].items[0].url);
  for (const v of res.variants) await runPipeline(ort, d, det, sessions[v], POSERS[v], warm, { forceFull: sets[0].forceFull });
  for (const dl of Object.keys(mp)) mp[dl].recognize(warm.canvas);
  for (const s of sets) {
    for (const it of s.items) {
      const img = await loadRGBA(it.url);
      const row = { set: s.name, file: it.file, truth: it.truth, cls: it.cls, w: img.w, h: img.h, rtmw: {}, mp: {} };
      for (const v of res.variants) {
        const r = await runPipeline(ort, d, det, sessions[v], POSERS[v], img, { forceFull: s.forceFull });
        const g = rpsFromWholeBody(r.kpts, r.scores);
        const hand = (off) => Array.from({ length: 21 }, (_, i) => [+r.kpts[(off + i) * 2].toFixed(1), +r.kpts[(off + i) * 2 + 1].toFixed(1), +r.scores[off + i].toFixed(2)]);
        row.rtmw[v] = { label: g.label, hand: g.hand, handScore: +g.meanScore.toFixed(2), noPerson: !!r.box.noPerson, tDet: +r.tDet.toFixed(1), tPose: +r.tPose.toFixed(1), left: hand(91), right: hand(112) };
        push(`${s.name}|rtmw|${v}|total`, r.tDet + r.tPose); push(`${s.name}|rtmw|${v}|pose`, r.tPose);
      }
      for (const [dl, rec] of Object.entries(mp)) {
        const a = performance.now();
        const r = rec.recognize(img.canvas);
        const ms = performance.now() - a;
        let best = null;
        r.gestures.forEach((g, i) => { if (g[0] && (!best || g[0].score > best.score)) best = { cat: g[0].categoryName, score: g[0].score, hands: r.gestures.length }; });
        row.mp[dl] = { raw: best ? best.cat : "NoHand", score: best ? +best.score.toFixed(2) : 0, label: best ? (MP_MAP[best.cat] ?? "none") : "none", ms: +ms.toFixed(1) };
        push(`${s.name}|mp|${dl}`, ms);
      }
      res.rows.push(row);
    }
    log(`set ${s.name} done (${s.items.length})`);
  }
  res.timing = { ...res.timing, ...Object.fromEntries(Object.entries(tm).map(([k, v]) => [k, sm(v)])) };
  return res;
}

async function taskWebnn() {
  const res = { task, env: await envInfo(), attempts: {} };
  for (const kind of ["npu", "gpu", "cpu"]) {
    try { const ctx = await navigator.ml.createContext({ deviceType: kind }); res.attempts["context-" + kind] = "ok"; void ctx; }
    catch (e) { res.attempts["context-" + kind] = String(e && e.message || e).slice(0, 300); }
  }
  try {
    const ort = await makeOrt("ort.all.bundle.min.mjs");
    for (const ep of ["webnn-npu", "webnn-gpu"]) {
      const t0 = performance.now();
      try {
        const d = await makeSession(ort, DETECTORS.yolox_nano.url, ep);
        const x = new ort.Tensor("float32", new Float32Array(3 * 416 * 416).fill(100), [1, 3, 416, 416]);
        const a = performance.now(); await d.session.run({ input: x }); const first = performance.now() - a;
        const per = []; for (let i = 0; i < 30; i++) { const b = performance.now(); await d.session.run({ input: x }); per.push(performance.now() - b); }
        res.attempts["ort-" + ep] = { ok: true, loadMs: +d.loadMs.toFixed(0), firstRunMs: +first.toFixed(1), ...sm(per) };
      } catch (e) { res.attempts["ort-" + ep] = { ok: false, error: String(e && e.message || e).slice(0, 400), ms: +(performance.now() - t0).toFixed(0) }; }
    }
  } catch (e) { res.attempts.ortLoad = String(e); }
  return res;
}

/** Run one model back-to-back for N seconds on a given EP so external tools (sampler, nvidia-smi) can see which device is busy. */
async function taskWebnnLoad() {
  const ep = params.ep || "webnn-npu";
  const ort = await makeOrt(ep.startsWith("webnn") ? "ort.all.bundle.min.mjs" : "ort.webgpu.bundle.min.mjs");
  const res = { task, ep, env: await envInfo() };
  const d = await makeSession(ort, DETECTORS.yolox_nano.url, ep);
  res.loadMs = +d.loadMs.toFixed(0);
  const x = new ort.Tensor("float32", new Float32Array(3 * 416 * 416).fill(100), [1, 3, 416, 416]);
  await d.session.run({ input: x });
  const seconds = params.seconds ?? 15;
  Object.assign(res, await sampled("load", seconds, async () => {
    const per = []; const t0 = performance.now();
    while (performance.now() - t0 < seconds * 1000) { const a = performance.now(); await d.session.run({ input: x }); per.push(performance.now() - a); }
    return { runs: per.length, fps: +(per.length / seconds).toFixed(1), ...sm(per) };
  }));
  return res;
}

try {
  const fn = { info: taskInfo, ortweb: taskOrtweb, mediapipe: taskMediapipe, gesture: taskGesture, webnn: taskWebnn, webnnload: taskWebnnLoad }[task];
  const r = await fn();
  r.params = params; r.tag = cfg.tag; r.finishedAt = new Date().toISOString();
  await report(r);
} catch (e) {
  log("FATAL " + (e && e.stack || e));
  await report({ task, params, fatal: String(e && e.stack || e) });
}
