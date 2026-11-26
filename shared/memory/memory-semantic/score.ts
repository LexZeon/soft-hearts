// "Recall by meaning": the pure part. A cosine similarity (unit vectors, so a dot product) becomes a recall score on the same
// scale as the keyword and note scores (shared/memory/memory-notes/knobs.ts: a person 6, a three-character term 4). Pure: no clock, no I/O.

import { MEMORY_SEMANTIC_KNOBS, type MemorySemanticKnobs } from './knobs';

/** The model's own retrieval instruction for a short question searching longer passages (BGE-zh model card); the memories are embedded without it. */
export const QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章：';

export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

/** 0 below `floor + jitter`; then linear up to knobs.match.maxScore at knobs.match.ceiling. */
export function semanticScore(similarity: number, jitter = 0, knobs: MemorySemanticKnobs = MEMORY_SEMANTIC_KNOBS): number {
  const m = knobs.match, floor = m.floor + Math.max(0, jitter);
  if (!Number.isFinite(similarity) || similarity < floor || m.maxScore <= 0) return 0;
  const span = Math.max(0.01, m.ceiling - floor);
  // A hit at the line itself still counts for a little (a tenth), so that "found" never rounds to nothing.
  return Math.max(m.maxScore * 0.1, Math.min(1, (similarity - floor) / span) * m.maxScore);
}

/** The text a memory is known by: what the user said in it, each line and the whole cut short. Empty when there is too little to mean anything. */
export function memoryEmbedText(userLines: readonly string[], knobs: MemorySemanticKnobs = MEMORY_SEMANTIC_KNOBS): string {
  const t = knobs.text;
  const lines = userLines.map(line => Array.from(line.replace(/\s+/gu, ' ').trim()).slice(0, t.messageChars).join('')).filter(Boolean);
  const joined = Array.from(lines.join('；')).slice(0, t.memoryChars).join('');
  return Array.from(joined.replace(/[；\s]/gu, '')).length < t.minChars ? '' : joined;
}

export function queryEmbedText(text: string, knobs: MemorySemanticKnobs = MEMORY_SEMANTIC_KNOBS): string {
  return QUERY_INSTRUCTION + Array.from(text.replace(/\s+/gu, ' ').trim()).slice(0, knobs.text.queryChars).join('');
}
