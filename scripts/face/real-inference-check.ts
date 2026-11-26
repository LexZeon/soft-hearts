// I-135: real ONNX inference with the pinned models and runtime on images made without any person (docs/claude/2026-11-15-i135-face-chat.md).
// Run: FACE_COMPONENT_DIR=<components>/face-v1/win32-arm64 node node_modules/tsx/dist/cli.mjs scripts/face/real-inference-check.ts
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { FaceEngine, type FaceOrtLike } from '../../electron/senses/face/engine';
import { decodeYunet, detectorInput, largestFace } from '../../electron/senses/face/yunet';
import { alignFace, SFACE_SIZE } from '../../electron/senses/face/align';
import { FACE_KNOBS } from '../../electron/senses/face/knobs';
import { cosine, l2normalize } from '../../electron/senses/face/score';

const base = process.env.FACE_COMPONENT_DIR; if (!base) throw new Error('Set FACE_COMPONENT_DIR to the installed face component folder (…/face-v1/win32-arm64).');
const req = createRequire(base + '/runtime/');
const ort = req('onnxruntime-node') as any;
const det = new Uint8Array(readFileSync(base + '/models/face_detection_yunet_2023mar.onnx'));
const rec = new Uint8Array(readFileSync(base + '/models/face_recognition_sface_2021dec_int8.onnx'));
const opts = { graphOptimizationLevel: 'all', logSeverityLevel: 3, executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1 };

const W = 640, H = 480;
function blank(r: number, g: number, b: number): Uint8Array { const a = new Uint8Array(W * H * 4); for (let i = 0; i < W * H; i++) { a[i * 4] = r; a[i * 4 + 1] = g; a[i * 4 + 2] = b; a[i * 4 + 3] = 255; } return a; }
function noise(seed: number): Uint8Array { let s = seed; const a = new Uint8Array(W * H * 4); for (let i = 0; i < W * H * 4; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = i % 4 === 3 ? 255 : (s >>> 24); } return a; }
function ellipse(a: Uint8Array, cx: number, cy: number, rx: number, ry: number, c: [number, number, number]) {
  for (let y = Math.max(0, Math.floor(cy - ry)); y < Math.min(H, Math.ceil(cy + ry)); y++) for (let x = Math.max(0, Math.floor(cx - rx)); x < Math.min(W, Math.ceil(cx + rx)); x++) {
    if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) { const o = (y * W + x) * 4; a[o] = c[0]; a[o + 1] = c[1]; a[o + 2] = c[2]; }
  }
}
/** A schematic face: skin oval, hair, two eyes with brows, nose, mouth. Not a person. */
function cartoon(scale = 1, shade = 1): Uint8Array {
  const a = blank(200, 205, 210); const cx = 320, cy = 250, rx = 110 * scale, ry = 140 * scale;
  ellipse(a, cx, cy - 20 * scale, rx * 1.12, ry * 1.1, [40, 30, 25]);
  ellipse(a, cx, cy, rx, ry, [Math.round(224 * shade), Math.round(172 * shade), Math.round(140 * shade)]);
  for (const sx of [-1, 1]) { ellipse(a, cx + sx * 45 * scale, cy - 30 * scale, 22 * scale, 12 * scale, [250, 250, 250]); ellipse(a, cx + sx * 45 * scale, cy - 30 * scale, 9 * scale, 9 * scale, [30, 20, 15]); ellipse(a, cx + sx * 45 * scale, cy - 55 * scale, 28 * scale, 5 * scale, [50, 35, 25]); }
  ellipse(a, cx, cy + 20 * scale, 12 * scale, 22 * scale, [200, 140, 115]);
  ellipse(a, cx, cy + 75 * scale, 35 * scale, 9 * scale, [150, 60, 60]);
  return a;
}
function crop112(kind: 'smooth' | 'smooth2' | 'noise', seed = 1): Float32Array {
  const out = new Float32Array(3 * 112 * 112); let s = seed;
  for (let y = 0; y < 112; y++) for (let x = 0; x < 112; x++) for (let c = 0; c < 3; c++) {
    let v: number;
    if (kind === 'noise') { s = (s * 1664525 + 1013904223) >>> 0; v = s >>> 24; }
    else if (kind === 'smooth') v = 128 + 100 * Math.sin((x + 20 * c) / 14) * Math.cos(y / 17 + c);
    else v = 128 + 100 * Math.cos((x - 30 * c) / 11) * Math.sin(y / 9 + 2 * c);
    out[c * 112 * 112 + y * 112 + x] = v;
  }
  return out;
}
const flipH = (a: Float32Array) => { const o = new Float32Array(a.length); for (let c = 0; c < 3; c++) for (let y = 0; y < 112; y++) for (let x = 0; x < 112; x++) o[c * 12544 + y * 112 + x] = a[c * 12544 + y * 112 + (111 - x)]; return o; };
const swapRB = (a: Float32Array) => { const o = new Float32Array(a.length); for (let i = 0; i < 12544; i++) { o[i] = a[2 * 12544 + i]; o[12544 + i] = a[12544 + i]; o[2 * 12544 + i] = a[i]; } return o; };
const f = (n: number) => n.toFixed(4);

const dSession = await ort.InferenceSession.create(det, opts);
const rSession = await ort.InferenceSession.create(rec, opts);
console.log('YuNet inputs', dSession.inputNames, 'outputs', dSession.outputNames);
console.log('SFace inputs', rSession.inputNames, 'outputs', rSession.outputNames);

// --- 1. YuNet raw outputs and decode on blank / noise / cartoon
const knobs = FACE_KNOBS.detector;
async function detect(name: string, rgba: Uint8Array) {
  const input = detectorInput(rgba, W, H, knobs.inputSize);
  const t0 = performance.now();
  const out = await dSession.run({ [dSession.inputNames[0]]: new ort.Tensor('float32', input.data, [1, 3, input.size, input.size]) });
  const ms = performance.now() - t0;
  const shapes = Object.fromEntries(Object.entries(out).map(([k, v]: any) => [k, v.dims.join('x')]));
  const faces = decodeYunet(out as any, input, knobs);
  let maxCls = 0; for (const k of Object.keys(out)) if (k.startsWith('cls')) for (const v of (out as any)[k].data) maxCls = Math.max(maxCls, v);
  const best = largestFace(faces);
  console.log(`[YuNet ${name}] ${ms.toFixed(0)} ms, shapes ${JSON.stringify(shapes)}, max raw cls ${f(maxCls)}, decoded faces ${faces.length}${best ? `, best score ${f(best.score)} box ${JSON.stringify(best.box ?? {})}` : ''}`);
  return best;
}
await detect('blank grey', blank(128, 128, 128));
await detect('blank black', blank(0, 0, 0));
await detect('blank white', blank(255, 255, 255));
await detect('noise', noise(7));
const c1 = await detect('cartoon face', cartoon());
await detect('cartoon small', cartoon(0.5));
await detect('cartoon dark', cartoon(1, 0.45));

// --- 2. SFace on direct 112x112 inputs
async function embed(data: Float32Array) {
  const out = await rSession.run({ [rSession.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, 112, 112]) });
  const t = out[rSession.outputNames[0]]; return { dims: t.dims.join('x'), v: Float32Array.from(t.data as ArrayLike<number>) };
}
const a = crop112('smooth'), b = crop112('smooth2'), n1 = crop112('noise', 3);
const ea = await embed(a), ea2 = await embed(a), eb = await embed(b), en = await embed(n1);
const norm = (v: Float32Array) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
console.log(`[SFace] output dims ${ea.dims}, length ${ea.v.length}, finite ${ea.v.every(Number.isFinite)}, L2 norm ${f(norm(ea.v))}`);
console.log(`[SFace] same input twice: cosine ${f(cosine(ea.v, ea2.v))}, max abs diff ${Math.max(...ea.v.map((x, i) => Math.abs(x - ea2.v[i]))).toExponential(2)}`);
console.log(`[SFace] different patterns: smooth vs smooth2 ${f(cosine(ea.v, eb.v))}, smooth vs noise ${f(cosine(ea.v, en.v))}`);
const ef = await embed(flipH(a));
console.log(`[SFace] smooth vs its horizontal flip ${f(cosine(ea.v, ef.v))} (a real face's flip is usually well above 0.5; a synthetic stripe pattern proves nothing about that)`);
const es = await embed(swapRB(a));
console.log(`[SFace] smooth vs its R/B swapped copy ${f(cosine(ea.v, es.v))} (shows the net is colour-order sensitive on this input; which order is right needs a real face)`);

// --- 3. Whole pipeline through FaceEngine (the same class the worker uses) on the cartoon
const engine = await FaceEngine.open(ort as FaceOrtLike, det, rec, 1);
const t0 = performance.now();
const blankResult = await engine.analyze(blank(100, 100, 100), W, H);
console.log(`[Engine blank] found=${blankResult.found} embedding=${blankResult.embedding === null ? 'null' : 'present'}`);
const cart = await engine.analyze(cartoon(), W, H);
console.log(`[Engine cartoon] found=${cart.found} detScore=${f(cart.detScore)} width=${cart.faceWidth.toFixed(0)} frontal=${f(cart.frontal)} sharp=${cart.sharpness.toFixed(1)} bright=${cart.brightness.toFixed(1)} embedding=${cart.embedding ? cart.embedding.length : null}  (${(performance.now() - t0).toFixed(0)} ms for both)`);
if (cart.embedding) {
  const again = await engine.analyze(cartoon(), W, H);
  console.log(`[Engine cartoon] same image again: cosine ${f(cosine(cart.embedding, again.embedding!))}`);
  const shifted = await engine.analyze(cartoon(1.15), W, H);
  if (shifted.embedding) console.log(`[Engine cartoon] 1.15x larger drawing: cosine ${f(cosine(cart.embedding, shifted.embedding))}`);
  const darker = await engine.analyze(cartoon(1, 0.7), W, H);
  if (darker.embedding) console.log(`[Engine cartoon] darker skin tone: cosine ${f(cosine(cart.embedding, darker.embedding))}`);
}
if (c1) {
  const aligned = alignFace(cartoon(), W, H, c1.landmarks);
  console.log(`[align] cartoon crop ${aligned.rgb.length} floats (expected ${3 * SFACE_SIZE * SFACE_SIZE}), landmarks ${JSON.stringify(c1.landmarks)}`);
}
await engine.release?.();
await dSession.release(); await rSession.release();
console.log('done');
