// I-111: the REAL model (opt-in). SOFT_HEARTS_BGE_DIR = a folder holding vocab.txt and onnx/model_int8.onnx of Xenova/bge-small-zh-v1.5 at the pinned
// commit (the app downloads them at runtime; they are never committed), SOFT_HEARTS_ORT_ENTRY = the onnxruntime-node entry (e.g. from the pose
// runtime pack). Synthetic sentences only. The numbers of the last run are in docs/claude/2026-11-13-bge-recall.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EmbeddingEngine, type EmbedOrtLike } from '../electron/memory/memory-semantic/engine';
import { SEMANTIC_ARCHIVES } from '../electron/memory/memory-semantic/manifest';
import { WordPieceTokenizer } from '../electron/memory/memory-semantic/tokenizer';
import { dot, memoryEmbedText, queryEmbedText, semanticScore } from '../shared/memory/memory-semantic/score';
import { CORPUS, QUERIES, UNRELATED } from './helpers/semantic-corpus';

const DIR = process.env.SOFT_HEARTS_BGE_DIR;
const SKIP_VOCAB = !DIR && 'set SOFT_HEARTS_BGE_DIR to the model folder to run';
const SKIP_MODEL = (!DIR || !process.env.SOFT_HEARTS_ORT_ENTRY) && 'set SOFT_HEARTS_BGE_DIR and SOFT_HEARTS_ORT_ENTRY to run';

test('real vocab: the downloaded files are the pinned ones, and the tokenizer gives the ids read from vocab.txt', { skip: SKIP_VOCAB }, () => {
  const vocab = readFileSync(path.join(DIR!, 'vocab.txt'));
  const pinned = SEMANTIC_ARCHIVES.find(archive => archive.id === 'bge-vocab')!;
  assert.equal(vocab.length, pinned.size); assert.equal(createHash('sha256').update(vocab).digest('hex'), pinned.sha256);
  const t = new WordPieceTokenizer(vocab.toString('utf8'));
  assert.deepEqual([t.cls, t.sep, t.unk, t.pad], [101, 102, 100, 0]);
  // Ids derived from vocab.txt line numbers (0-based): 我 2769, 养 1075, 了 749, 一 671, 只 1372, 橘 3580, 猫 4344, 叫 1373, 团 1730, 子 2094.
  assert.deepEqual(t.encode('我养了一只橘猫叫团子'), [101, 2769, 1075, 749, 671, 1372, 3580, 4344, 1373, 1730, 2094, 102]);
  assert.deepEqual(t.encode('hello'), [101, 8701, 102]);
  assert.deepEqual(t.piece('tokenizer'), [8228, 11285, 11789, 8180], 'to + ##ken + ##ize + ##r (vocab.txt lines 8228, 11285, 11789, 8180)');
  assert.deepEqual(t.encode('Hello'), [101, 100, 102], 'the model\'s own settings do not lower-case, so a capital H is not in the vocabulary (the official BAAI tokenizer_config says the same)');
  assert.deepEqual(t.encode('猫，猫。'), [101, 4344, 8024, 4344, 511, 102], '，8024 and 。511 are single tokens');
  assert.deepEqual(t.encode('猫\u0000� 猫'), [101, 4344, 4344, 102], 'control characters vanish, a space separates');
});

test('real model: runs, unit vectors, ranks the synthetic corpus, and how long it takes here', { skip: SKIP_MODEL }, async () => {
  const ort = createRequire(import.meta.url)(path.resolve(process.env.SOFT_HEARTS_ORT_ENTRY!)) as EmbedOrtLike;
  const modelFile = path.join(DIR!, 'onnx', 'model_int8.onnx');
  const model = readFileSync(modelFile), pinned = SEMANTIC_ARCHIVES.find(archive => archive.id === 'bge-model')!;
  assert.equal(createHash('sha256').update(model).digest('hex'), pinned.sha256, 'the pinned model file');
  let t0 = performance.now();
  const engine = await EmbeddingEngine.open(ort, modelFile, readFileSync(path.join(DIR!, 'vocab.txt'), 'utf8'), 2);
  const loadMs = performance.now() - t0;
  try {
    const memories = await engine.embed(CORPUS.map(memory => memoryEmbedText([memory.text]) || memory.text));
    const queries = await engine.embed([...QUERIES.map(q => queryEmbedText(q.query)), ...UNRELATED.map(u => queryEmbedText(u))]);
    for (const v of [...memories, ...queries]) assert.ok(Math.abs(dot(v, v) - 1) < 1e-4);
    let top1 = 0, scored = 0;
    QUERIES.forEach((q, i) => {
      const ranked = CORPUS.map((m, j) => ({ id: m.id, similarity: dot(queries[i], memories[j]) })).sort((a, b) => b.similarity - a.similarity);
      if (ranked[0].id === q.expect) top1++;
      if (semanticScore(ranked.find(r => r.id === q.expect)!.similarity) > 0) scored++;
    });
    const falseHits = UNRELATED.filter((_, i) => CORPUS.some((_m, j) => semanticScore(dot(queries[QUERIES.length + i], memories[j])) > 0)).length;
    const single: number[] = [];
    for (let i = 0; i < 20; i++) { t0 = performance.now(); await engine.embed([queryEmbedText(QUERIES[i % QUERIES.length].query)]); single.push(performance.now() - t0); }
    single.sort((a, b) => a - b);
    t0 = performance.now();
    const many = Array.from({ length: 1000 }, (_, i) => `${CORPUS[i % CORPUS.length].text}，第${i}次提到`);
    for (let i = 0; i < many.length; i += 16) await engine.embed(many.slice(i, i + 16));
    const backfillMs = performance.now() - t0;
    console.log(`[bge real] load ${loadMs.toFixed(0)} ms, single embed median ${single[10].toFixed(1)} ms p90 ${single[18].toFixed(1)} ms, backfill 1000 (batch 16) ${(backfillMs / 1000).toFixed(1)} s, `
      + `top1 ${top1}/${QUERIES.length}, above the floor ${scored}/${QUERIES.length}, unrelated lines that still reach the floor ${falseHits}/${UNRELATED.length}, rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
    assert.ok(top1 >= 9, `top-1 ${top1}/${QUERIES.length} (10 at the last run)`);
    assert.ok(single[10] < 100, 'one line well under 100 ms');
  } finally { await engine.release(); }
});
