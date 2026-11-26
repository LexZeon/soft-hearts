// Embedding comparison (I-127), step 2: embed a list of texts with ONNX Runtime for Node (the same onnxruntime-node build the app
// downloads for pose, speech and the semantic recall), write the unit vectors, and time it on this machine. Generic: no data here.
//
//   --model bge         --model-dir <folder with vocab.txt and onnx/model_int8.onnx>  (the app's own EmbeddingEngine and tokenizer)
//   --model onnx-ids    --model-file <model.onnx>  (any text model taking input_ids + attention_mask and returning sentence_embedding;
//                        the input JSON then carries token ids made elsewhere, e.g. scripts/ml/gemma_tokenize.py; empty
//                        image/video/audio feature inputs are fed when the graph has them)
//   --ort <onnxruntime-node entry>  --in <input.json>  --out <vectors.f32>  [--threads 2] [--batch 16] [--model-variant name]
//
// input.json: { "texts": string[] } for bge (already formatted: instruction/prefix added by the caller), { "ids": number[][] } for
// onnx-ids, plus "latency": the indices of the items used for the one-line timing. Writes <out> (float32, row after row) and
// <out>.json (dims, count, timings, memory). Nothing is printed from the texts.
import { createRequire } from 'node:module';
import { readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { EmbeddingEngine, cpuSessionOptions, type EmbedOrtLike } from '../../electron/memory/memory-semantic/engine';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
}
const model = arg('model'), outFile = path.resolve(arg('out')), threads = Number(arg('threads', '2')), batch = Number(arg('batch', '16'));
const input = JSON.parse(readFileSync(path.resolve(arg('in')), 'utf8')) as { texts?: string[]; ids?: number[][]; latency?: number[] };
const ort = createRequire(import.meta.url)(path.resolve(arg('ort'))) as EmbedOrtLike & { Tensor: new (type: string, data: unknown, dims: number[]) => unknown };

let peakRss = process.memoryUsage().rss;
const sample = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
const rssBefore = process.memoryUsage().rss;
const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const fileBytes = (p: string) => statSync(p).size;

type Embed = (items: number[]) => Promise<Float32Array[]>;
let embed: Embed, release: () => Promise<void>, onDisk = 0, count = 0;
let t0 = performance.now();
if (model === 'bge') {
  const dir = path.resolve(arg('model-dir'));
  const modelFile = path.join(dir, 'onnx', arg('model-variant', 'model_int8.onnx'));
  onDisk = fileBytes(modelFile) + fileBytes(path.join(dir, 'vocab.txt'));
  const engine = await EmbeddingEngine.open(ort, modelFile, readFileSync(path.join(dir, 'vocab.txt'), 'utf8'), threads);
  const texts = input.texts!; count = texts.length;
  embed = items => engine.embed(items.map(i => texts[i]!));
  release = () => engine.release();
} else if (model === 'onnx-ids') {
  const modelFile = path.resolve(arg('model-file'));
  const base = path.basename(modelFile);
  onDisk = readdirSync(path.dirname(modelFile)).filter(f => f === base || f.startsWith(`${base}_data`)).reduce((n, f) => n + fileBytes(path.join(path.dirname(modelFile), f)), 0);
  const session = await (ort.InferenceSession.create as (m: string, o: Record<string, unknown>) => Promise<{ inputNames: string[]; outputNames: string[];
    run(f: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: number[] }>>; release(): Promise<void> }>)(modelFile, cpuSessionOptions(threads));
  const ids = input.ids!; count = ids.length;
  const extra: Record<string, unknown> = {};
  for (const name of session.inputNames) if (/_features$/.test(name)) extra[name] = new ort.Tensor('float32', new Float32Array(0), [0, 512]);
  embed = async items => {
    const rows = items.map(i => ids[i]!);
    const steps = Math.max(...rows.map(r => r.length));
    const idT = new BigInt64Array(rows.length * steps), mask = new BigInt64Array(rows.length * steps);
    rows.forEach((row, b) => row.forEach((id, k) => { idT[b * steps + k] = BigInt(id); mask[b * steps + k] = 1n; }));
    const out = await session.run({ input_ids: new ort.Tensor('int64', idT, [rows.length, steps]), attention_mask: new ort.Tensor('int64', mask, [rows.length, steps]), ...extra });
    const e = out.sentence_embedding!;
    const dims = e.dims[1]!;
    return rows.map((_, b) => {
      const v = Float32Array.from(e.data.subarray(b * dims, (b + 1) * dims));
      const n = Math.hypot(...v); for (let d = 0; d < dims; d++) v[d] /= n; return v;
    });
  };
  release = () => session.release();
} else throw new Error(`unknown --model ${model}`);
const loadMs = performance.now() - t0;
sample();
const rssLoaded = process.memoryUsage().rss;

// All items, in batches like the app's backfill.
const vectors: Float32Array[] = new Array(count);
t0 = performance.now();
for (let i = 0; i < count; i += batch) {
  const items = Array.from({ length: Math.min(batch, count - i) }, (_, k) => i + k);
  const made = await embed(items);
  made.forEach((v, k) => { vectors[items[k]!] = v; });
  sample();
}
const allMs = performance.now() - t0;

// One line at a time (the reply path): warm up 3, then each latency item once.
const latencyItems = input.latency ?? [];
for (const i of latencyItems.slice(0, 3)) await embed([i]);
const single: number[] = [];
for (const i of latencyItems) { const s = performance.now(); await embed([i]); single.push(performance.now() - s); sample(); }

// 1,000 items cycling through the list, batches of `batch` (the backfill pace).
t0 = performance.now();
for (let n = 0; n < 1000; n += batch) await embed(Array.from({ length: Math.min(batch, 1000 - n) }, (_, k) => (n + k) % count));
const thousandMs = performance.now() - t0;
sample();
await release();

const dims = vectors[0]!.length;
const buf = new Float32Array(count * dims);
vectors.forEach((v, i) => buf.set(v, i * dims));
writeFileSync(outFile, Buffer.from(buf.buffer));
const ru = process.resourceUsage();
const metrics = { model, runtime: `onnxruntime-node ${createRequire(import.meta.url)(path.join(path.dirname(path.resolve(arg('ort'))), '..', 'package.json')).version ?? '?'}`,
  threads, batch, count, dims, onDiskBytes: onDisk, loadMs: Math.round(loadMs), allMs: Math.round(allMs),
  singleMs: { n: single.length, median: +quantile(single, 0.5).toFixed(2), p90: +quantile(single, 0.9).toFixed(2) },
  thousandMs: Math.round(thousandMs), rssMB: { before: Math.round(rssBefore / 1e6), loaded: Math.round(rssLoaded / 1e6), peakSampled: Math.round(peakRss / 1e6), maxRss: Math.round(ru.maxRSS / 1e3) } };
writeFileSync(`${outFile}.json`, JSON.stringify(metrics, null, 2));
console.log(JSON.stringify(metrics));
