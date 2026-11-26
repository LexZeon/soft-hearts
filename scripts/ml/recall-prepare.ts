// Embedding comparison (I-127), step 1b: from the segments export (memory-export.ts) build the exact strings each model embeds, for
// one character scope. Memories: the text the app embeds (memoryEmbedText). Queries: every user line of that scope, cut like the app
// cuts it (queryEmbedText). Each model gets its own documented formatting:
//   bge:    query = the app's QUERY_INSTRUCTION + line; memory = text as is (exactly what the app does)
//   gemma:  query = "task: search result | query: " + line; memory = "title: none | text: " + text (EmbeddingGemma 2 model card)
// Writes <out-dir>/items.json (what each row is) and <out-dir>/texts-<model>.json (embed-bench input). Output holds private text.
//
//   node node_modules/tsx/dist/cli.mjs scripts/ml/recall-prepare.ts --segments <segments.json> --scope <scope> --out-dir <dir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { MEMORY_SEMANTIC_KNOBS } from '../../shared/memory/memory-semantic/knobs';
import { queryEmbedText } from '../../shared/memory/memory-semantic/score';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`missing --${name}`);
  return v;
}
interface Segment { id: string; scope: string; createdAt: number; lastAt: number; embedText: string; messages: { role: string; content: string; at: number }[] }
const data = JSON.parse(readFileSync(path.resolve(arg('segments')), 'utf8')) as { segments: Segment[] };
const scope = arg('scope'), outDir = path.resolve(arg('out-dir'));
mkdirSync(outDir, { recursive: true });

const segs = data.segments.filter(s => s.scope === scope).sort((a, b) => a.createdAt - b.createdAt);
const cut = (line: string) => Array.from(line.replace(/\s+/gu, ' ').trim()).slice(0, MEMORY_SEMANTIC_KNOBS.text.queryChars).join('');
type Item = { kind: 'memory'; seg: number; at: number; lastAt: number } | { kind: 'query'; seg: number; line: number; at: number };
const items: Item[] = [], bge: string[] = [], gemma: string[] = [];
segs.forEach((s, n) => {
  if (!s.embedText) return;
  items.push({ kind: 'memory', seg: n, at: s.createdAt, lastAt: s.lastAt });
  bge.push(s.embedText); gemma.push(`title: none | text: ${s.embedText}`);
});
segs.forEach((s, n) => s.messages.filter(m => m.role === 'user').forEach((m, line) => {
  if (!m.content.trim()) return;
  items.push({ kind: 'query', seg: n, line, at: m.at });
  bge.push(queryEmbedText(m.content)); gemma.push(`task: search result | query: ${cut(m.content)}`);
}));
// One-line timing: short queries (4..30 characters), the first 60.
const latency = items.map((it, i) => ({ it, i })).filter(({ it, i }) => it.kind === 'query' && (() => { const n = Array.from(cut(segs[it.seg]!.messages.filter(m => m.role === 'user')[(it as { line: number }).line]!.content)).length; return n >= 4 && n <= 30; })() && i >= 0).slice(0, 60).map(({ i }) => i);
writeFileSync(path.join(outDir, 'items.json'), JSON.stringify({ scope, segments: segs.length, items }));
writeFileSync(path.join(outDir, 'texts-bge.json'), JSON.stringify({ texts: bge, latency }));
writeFileSync(path.join(outDir, 'texts-gemma.json'), JSON.stringify({ texts: gemma, latency }));
console.log(JSON.stringify({ segments: segs.length, memories: items.filter(i => i.kind === 'memory').length, queries: items.filter(i => i.kind === 'query').length, latency: latency.length }));
