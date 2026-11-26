// Embedding comparison (I-127), step 3: one scoring code for every model. Generic: data and labels come from files given on the
// command line (they are private and never live in the repo).
//
//   node node_modules/tsx/dist/cli.mjs scripts/ml/recall-eval.ts --segments <segments.json> --items <items.json> --labels <labels.json>
//        --model name=<vectors.f32>[:<truncate dims>] [--model ...] [--top 2] --out <results.json>
//
// Time is respected: a user line in segment n may only find segments 0..n-1 (all ended before segment n began; its own segment is
// never a candidate), exactly as the app only embeds finished segments. Similarity = dot product of unit vectors (truncated vectors
// are re-normalised). "Surfaces" at a floor = the app's rule without the per-line jitter: the best `top` memories at or above the floor.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const one = (name: string, fallback?: string) => { const i = argv.indexOf(`--${name}`); const v = i >= 0 ? argv[i + 1] : fallback; if (v === undefined) throw new Error(`missing --${name}`); return v; };
const many = (name: string) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]!] : []));
const top = Number(one('top', '2'));

interface Segment { scope: string; createdAt: number; messages: { role: string; content: string }[] }
type Item = { kind: 'memory'; seg: number } | { kind: 'query'; seg: number; line: number };
const segments = (JSON.parse(readFileSync(path.resolve(one('segments')), 'utf8')) as { segments: Segment[] }).segments;
const itemsFile = JSON.parse(readFileSync(path.resolve(one('items')), 'utf8')) as { scope: string; items: Item[] };
const labels = JSON.parse(readFileSync(path.resolve(one('labels')), 'utf8')) as { positives: [number, number, number[], string][]; negatives: [number, number, string][] };
const segs = segments.filter(s => s.scope === itemsFile.scope).sort((a, b) => a.createdAt - b.createdAt);
const userLine = (seg: number, line: number) => segs[seg]!.messages.filter(m => m.role === 'user')[line]!.content;
const memoryText = (seg: number) => segs[seg]!.messages.filter(m => m.role === 'user').map(m => m.content).join('；');

const memRow = new Map<number, number>(), queryRow = new Map<string, number>();
itemsFile.items.forEach((it, i) => { if (it.kind === 'memory') memRow.set(it.seg, i); else queryRow.set(`${it.seg}:${it.line}`, i); });
const memSegs = [...memRow.keys()].sort((a, b) => a - b);

function loadVectors(spec: string): { name: string; rows: Float32Array[] } {
  const [name, rest] = spec.split(/=(.*)/s) as [string, string];
  const m = /^(.*?)(?::(\d+))?$/.exec(rest)!;
  const file = path.resolve(m[1]!), cut = m[2] ? Number(m[2]) : 0;
  const meta = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as { dims: number; count: number };
  const raw = new Float32Array(readFileSync(file).buffer.slice(0));
  const rows: Float32Array[] = [];
  for (let i = 0; i < meta.count; i++) {
    let v = raw.subarray(i * meta.dims, (i + 1) * meta.dims);
    if (cut) { v = Float32Array.from(v.subarray(0, cut)); const n = Math.hypot(...v); for (let d = 0; d < v.length; d++) v[d] /= n; }
    rows.push(v);
  }
  return { name, rows };
}
const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };

// Hard subsets measured from the text, not by hand: no shared CJK bigram or Latin word between the line and the right memories.
const grams = (t: string) => { const s = new Set<string>(); const cjk = Array.from(t).filter(c => /\p{Script=Han}/u.test(c)); for (let i = 0; i + 1 < cjk.length; i++) s.add(cjk[i]! + cjk[i + 1]!); for (const w of t.toLowerCase().match(/[a-z]{2,}/g) ?? []) s.add(w); return s; };
const noShared = (q: string, pos: number[]) => { const a = grams(q); const b = new Set(pos.flatMap(p => [...grams(memoryText(p))])); return ![...a].some(g => b.has(g)); };
const negation = (q: string) => /[不没别]/u.test(q);

interface Ranked { seg: number; sim: number }
// "+center" after a model name: subtract the mean of the memories that exist at that moment (segments 0..n-1, so still no look
// ahead) from the line and from each memory, re-normalise, then compare (the "去底色" idea of docs/claude/2026-11-13-bge-recall.md).
let centered = false;
const unit = (v: Float32Array) => { const n = Math.hypot(...v) || 1; return v.map(x => x / n); };
function rank(rows: Float32Array[], seg: number, line: number): Ranked[] {
  let q = rows[queryRow.get(`${seg}:${line}`)!]!;
  const cands = memSegs.filter(s => s < seg);
  let mems = cands.map(s => rows[memRow.get(s)!]!);
  if (centered && mems.length > 1) {
    const mean = new Float32Array(q.length);
    for (const m of mems) for (let d = 0; d < q.length; d++) mean[d] += m[d]! / mems.length;
    q = unit(q.map((x, d) => x - mean[d]!));
    mems = mems.map(m => unit(m.map((x, d) => x - mean[d]!)));
  }
  return cands.map((s, i) => ({ seg: s, sim: dot(q, mems[i]!) })).sort((a, b) => b.sim - a.sim);
}
const quant = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]!; };
const r3 = (x: number) => Math.round(x * 1000) / 1000;

const floors = Array.from({ length: 71 }, (_, i) => r3(0.2 + i * 0.01));
const results: Record<string, unknown> = {};
for (const spec of many('model')) {
  const { name, rows } = loadVectors(spec);
  centered = name.endsWith('+center');
  const pos = labels.positives.filter(([s, l, p]) => queryRow.has(`${s}:${l}`) && p.some(x => memRow.has(x) && x < s)).map(([s, l, p, tag]) => {
    const ranked = rank(rows, s, l), relevant = new Set(p.filter(x => memRow.has(x) && x < s));
    const firstRank = ranked.findIndex(r => relevant.has(r.seg)) + 1;
    const q = userLine(s, l);
    return { s, l, tag, ranked, relevant, firstRank, bestRel: ranked.find(r => relevant.has(r.seg))!.sim, top1: ranked[0]!.sim,
      noShared: noShared(q, [...relevant]), negation: negation(q), candidates: ranked.length };
  });
  const negs = labels.negatives.filter(([s, l]) => queryRow.has(`${s}:${l}`) && s > 0).map(([s, l, tag]) => ({ s, l, tag, ranked: rank(rows, s, l) }));
  const all = itemsFile.items.filter((it): it is Extract<Item, { kind: 'query' }> => it.kind === 'query' && it.seg > 0).map(it => rank(rows, it.seg, it.line));

  const quality = (subset: typeof pos) => subset.length ? {
    n: subset.length, r1: r3(subset.filter(p => p.firstRank === 1).length / subset.length), r3: r3(subset.filter(p => p.firstRank <= 3).length / subset.length),
    mrr: r3(subset.reduce((a, p) => a + 1 / p.firstRank, 0) / subset.length),
    // Chance level for this subset: what a random order would give (mean of |relevant|/candidates for recall@1).
    chanceR1: r3(subset.reduce((a, p) => a + p.relevant.size / p.candidates, 0) / subset.length) } : { n: 0 };
  const atFloor = (f: number) => {
    const surfaced = (ranked: Ranked[]) => ranked.filter(r => r.sim >= f).slice(0, top);
    const pRight = pos.filter(p => surfaced(p.ranked).some(r => p.relevant.has(r.seg))).length;
    const pWrongOnly = pos.filter(p => { const s = surfaced(p.ranked); return s.length && !s.some(r => p.relevant.has(r.seg)); }).length;
    const nt = negs.filter(n => n.tag === 'nt'), na = negs.filter(n => n.tag === 'na');
    return { floor: f, posRight: r3(pRight / pos.length), posWrongOnly: r3(pWrongOnly / pos.length),
      ntSurface: r3(nt.filter(n => surfaced(n.ranked).length).length / nt.length), naSurface: r3(na.filter(n => surfaced(n.ranked).length).length / na.length),
      allSurface: r3(all.filter(r => surfaced(r).length).length / all.length), allHitsPerLine: r3(all.reduce((a, r) => a + surfaced(r).length, 0) / all.length) };
  };
  const sweep = floors.map(atFloor);
  const best = sweep.reduce((b, x) => (x.posRight - x.ntSurface > b.posRight - b.ntSurface ? x : b));
  const tenPct = sweep.find(x => x.ntSurface <= 0.1) ?? sweep[sweep.length - 1]!;
  // How well one number separates "the right memory" from "the best match for a line that should find nothing".
  const pScores = pos.map(p => p.bestRel), nScores = negs.filter(n => n.tag === 'nt' && n.ranked.length).map(n => n.ranked[0]!.sim);
  let auc = 0; for (const a of pScores) for (const b of nScores) auc += a > b ? 1 : a === b ? 0.5 : 0;
  auc /= pScores.length * nScores.length;
  const tops = all.filter(r => r.length).map(r => r[0]!.sim);
  results[name] = {
    quality: { all: quality(pos), byTag: Object.fromEntries(['e', 'n', 'p', 't', 'i083'].map(t => [t, quality(pos.filter(p => p.tag === t))])),
      noShared: quality(pos.filter(p => p.noShared)), negation: quality(pos.filter(p => p.negation)) },
    auc: r3(auc), topSimilarity: { p10: r3(quant(tops, 0.1)), p50: r3(quant(tops, 0.5)), p90: r3(quant(tops, 0.9)), max: r3(Math.max(...tops)) },
    relevantSim: { p25: r3(quant(pScores, 0.25)), p50: r3(quant(pScores, 0.5)), p75: r3(quant(pScores, 0.75)) },
    ntNegTopSim: { p50: r3(quant(nScores, 0.5)), p90: r3(quant(nScores, 0.9)) },
    best, tenPct, sweep,
    i083: pos.filter(p => p.tag === 'i083').map(p => ({ q: `S${p.s}u${p.l}`, firstRank: p.firstRank, candidates: p.candidates, bestRel: r3(p.bestRel), top1: r3(p.top1) })),
    perCase: pos.map(p => ({ q: `S${p.s}u${p.l}`, tag: p.tag, firstRank: p.firstRank, bestRel: r3(p.bestRel), top1: r3(p.top1), topSeg: p.ranked[0]!.seg, noShared: p.noShared })),
    negCases: negs.map(n => ({ q: `S${n.s}u${n.l}`, tag: n.tag, top1: n.ranked.length ? r3(n.ranked[0]!.sim) : null, topSeg: n.ranked[0]?.seg })),
  };
  const r = results[name] as { quality: { all: ReturnType<typeof quality>; noShared: ReturnType<typeof quality> }; best: ReturnType<typeof atFloor>; tenPct: ReturnType<typeof atFloor> };
  console.log(name.padEnd(14), JSON.stringify(r.quality.all), 'noShared', JSON.stringify(r.quality.noShared), 'auc', r3(auc), 'best', JSON.stringify(r.best));
}
writeFileSync(path.resolve(one('out')), JSON.stringify({ top, positives: labels.positives.length, negatives: labels.negatives.length, results }, null, 1));
