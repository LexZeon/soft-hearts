/**
 * I-111 recall by meaning, the building blocks (docs/claude/2026-11-13-bge-recall.md): the WordPiece tokenizer, the embedding engine around a
 * fake onnxruntime, the worker protocol, the component manifest, the vector files, and the score scale. Synthetic text only, no model, no
 * network, no real profile. The tokenizer is also checked against ids read from the real vocab.txt when SOFT_HEARTS_BGE_DIR points at it
 * (tests/memory-semantic-real.test.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WordPieceTokenizer, MAX_WORD_CHARS } from '../electron/memory/memory-semantic/tokenizer';
import { EMBEDDING_DIMS, EmbeddingEngine, clsVectors, MAX_TOKENS } from '../electron/memory/memory-semantic/engine';
import { parseSemanticHostMessage, parseSemanticWorkerMessage } from '../electron/memory/memory-semantic/protocol';
import { SEMANTIC_ARCHIVES, SEMANTIC_MANIFEST, SEMANTIC_MODEL_FILES, SEMANTIC_MODEL_VERSION } from '../electron/memory/memory-semantic/manifest';
import { CharacterVectors, VECTOR_FOLDER, VectorStore, fromFile, toFile } from '../electron/memory/memory-semantic/vectors';
import { PoseComponentStore } from '../electron/senses/pose/component-store';
import { MEMORY_SEMANTIC_KNOBS } from '../shared/memory/memory-semantic/knobs';
import { QUERY_INSTRUCTION, dot, memoryEmbedText, queryEmbedText, semanticScore } from '../shared/memory/memory-semantic/score';
import { parseSemanticView, sameSemanticView } from '../shared/memory/memory-semantic/view';
import { conceptVector, fakeEmbedOrt } from './helpers/semantic-fakes';

// A small vocabulary in the real file's shape (one token per line, the line number is the id).
const VOCAB = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', '我', '养', '了', '猫', '，', '。', 'a', 'b', '##b', '##c', 'un', '##able', 'hello', '!', '2', '##5'].join('\n') + '\n';
const ID = Object.fromEntries(VOCAB.trim().split('\n').map((token, index) => [token, index])) as Record<string, number>;

test('tokenizer: Chinese is split per character, punctuation alone, the template is [CLS] ... [SEP], ids are the vocab line numbers', () => {
  const t = new WordPieceTokenizer(VOCAB);
  assert.deepEqual(t.encode('我养了猫，'), [ID['[CLS]'], ID['我'], ID['养'], ID['了'], ID['猫'], ID['，'], ID['[SEP]']]);
  assert.deepEqual(t.encode(''), [ID['[CLS]'], ID['[SEP]']]);
  assert.deepEqual(t.encode('   \n\t '), [ID['[CLS]'], ID['[SEP]']], 'only whitespace');
  assert.deepEqual(t.words('我养了猫abc'), ['我', '养', '了', '猫', 'abc'], 'a Chinese character never joins the Latin letters next to it');
});

test('tokenizer: WordPiece takes the longest match from the left and continues with ##; an unmatched word is one [UNK]', () => {
  const t = new WordPieceTokenizer(VOCAB);
  assert.deepEqual(t.piece('abc'), [ID.a, ID['##b'], ID['##c']]);
  assert.deepEqual(t.piece('unable'), [ID.un, ID['##able']]);
  assert.deepEqual(t.piece('hello'), [ID.hello]);
  assert.deepEqual(t.piece('abz'), [ID['[UNK]']], 'one unknown piece makes the whole word [UNK] (the model\'s own rule)');
  assert.deepEqual(t.piece('a'.repeat(MAX_WORD_CHARS + 1)), [ID['[UNK]']], 'a word over 100 characters is [UNK]');
  assert.deepEqual(t.piece('abcb'), [ID.a, ID['##b'], ID['##c'], ID['##b']], 'the continuation pieces repeat');
});

test('tokenizer: punctuation splits words, control characters and U+FFFD vanish, no lower-casing (the pinned model files say so)', () => {
  const t = new WordPieceTokenizer(VOCAB);
  assert.deepEqual(t.words('hello!2'), ['hello', '!', '2']);
  assert.deepEqual(t.words('he\u0000l\u0007l\ufffdo'), ['hello'], 'control characters and the replacement character are dropped, not turned into spaces');
  assert.deepEqual(t.words('a\u3000b\u00a0c'), ['a', 'b', 'c'], 'ideographic and no-break spaces split');
  assert.deepEqual(t.words('hello Hello'), ['hello', 'Hello']);
  assert.deepEqual(t.piece('Hello'), [ID['[UNK]']], 'no lower-casing: "Hello" is not "hello"');
  assert.deepEqual(t.encode('Hello'), [ID['[CLS]'], ID['[UNK]'], ID['[SEP]']], 'and encode does not lower-case behind the pieces\' back');
  assert.deepEqual(t.encode('hello'), [ID['[CLS]'], ID.hello, ID['[SEP]']]);
  assert.deepEqual(t.words('，。'), ['，', '。']);
});

test('tokenizer: long text is cut to maxTokens with the [SEP] kept; a vocabulary without the special tokens is refused', () => {
  const t = new WordPieceTokenizer(VOCAB);
  const ids = t.encode('猫'.repeat(500), 10);
  assert.equal(ids.length, 10); assert.equal(ids[0], ID['[CLS]']); assert.equal(ids.at(-1), ID['[SEP]']);
  assert.equal(t.encode('猫'.repeat(2000), 9999).length, 512, 'never more than the model\'s 512');
  assert.equal(t.encode('猫', 0).length, 2, 'room for nothing but the template');
  assert.throws(() => new WordPieceTokenizer('我\n猫\n'), /\[CLS\]/);
  assert.deepEqual(t.encode(undefined as never), [ID['[CLS]'], ID['[SEP]']], 'a non-string is an empty text, not a crash');
});

test('clsVectors: the first row of each text, divided by its length; an all-zero or non-finite row is an error, not a vector', () => {
  const data = new Float32Array(2 * 3 * 4);
  data.set([3, 4, 0, 0], 0); data.set([0, 0, 5, 12], 12);
  const [a, b] = clsVectors(data, 2, 3, 4);
  assert.deepEqual([...a], [0.6000000238418579, 0.800000011920929, 0, 0]);
  assert.ok(Math.abs(dot(b, b) - 1) < 1e-6);
  assert.throws(() => clsVectors(new Float32Array(8), 1, 2, 4), /empty/);
  assert.throws(() => clsVectors(Float32Array.of(NaN, 1, 1, 1), 1, 1, 4), /empty/);
});

test('engine: the whole path with a fake runtime: tokens in, one unit vector per text out, padded together, the session released once', async () => {
  const fake = fakeEmbedOrt();
  const engine = await EmbeddingEngine.open(fake.ort, 'C:\\m\\model.onnx', VOCAB, 2);
  const out = await engine.embed(['我养了猫', '猫']);
  assert.equal(out.length, 2);
  for (const v of out) { assert.equal(v.length, EMBEDDING_DIMS); assert.ok(Math.abs(dot(v, v) - 1) < 1e-5); }
  assert.deepEqual(fake.fed[0].input_ids[0].map(Number), [ID['[CLS]'], ID['我'], ID['养'], ID['了'], ID['猫'], ID['[SEP]']]);
  assert.equal(fake.fed[0].input_ids[1].length, 6, 'the shorter text is padded to the longer');
  assert.deepEqual(await engine.embed([]), []);
  await engine.release(); await engine.release();
  assert.equal(fake.released.count, 1);
  await assert.rejects(engine.embed(['猫']), /released/);
});

test('engine: a model with other inputs or another width is refused, not trusted', async () => {
  await assert.rejects(EmbeddingEngine.open(fakeEmbedOrt({ inputs: ['x', 'y'] }).ort, 'C:\\m.onnx', VOCAB), /unexpected/);
  const wide = await EmbeddingEngine.open(fakeEmbedOrt({ dims: 384 }).ort, 'C:\\m.onnx', VOCAB);
  await assert.rejects(wide.embed(['猫']), /unexpected model output/);
  assert.ok(MAX_TOKENS <= 512);
});

test('protocol: only well-formed messages pass, in both directions', () => {
  const unit = new Float32Array(EMBEDDING_DIMS); unit[3] = 1;
  const ok = { type: 'result', id: 'sem-1', vectors: [unit], ms: 3 };
  assert.ok(parseSemanticWorkerMessage(ok));
  assert.equal(parseSemanticWorkerMessage({ ...ok, extra: 1 }), null, 'an extra field');
  assert.equal(parseSemanticWorkerMessage({ ...ok, vectors: [new Float32Array(EMBEDDING_DIMS)] }), null, 'not unit length');
  assert.equal(parseSemanticWorkerMessage({ ...ok, vectors: [new Float32Array(10)] }), null, 'wrong width');
  assert.equal(parseSemanticWorkerMessage({ ...ok, id: 'a b' }), null);
  assert.equal(parseSemanticWorkerMessage({ ...ok, vectors: Array(33).fill(unit) }), null, 'more than 32');
  assert.deepEqual(parseSemanticWorkerMessage({ type: 'ready', loadMs: 120 }), { type: 'ready', loadMs: 120 });
  assert.equal(parseSemanticWorkerMessage({ type: 'failed', reason: 'disk' }), null);
  assert.equal(parseSemanticWorkerMessage(null), null);
  assert.deepEqual(parseSemanticHostMessage({ type: 'embed', id: 'e1', texts: ['猫'] }), { type: 'embed', id: 'e1', texts: ['猫'] });
  assert.equal(parseSemanticHostMessage({ type: 'embed', id: 'e1', texts: [] }), null);
  assert.equal(parseSemanticHostMessage({ type: 'embed', id: 'e1', texts: ['a\0b'] }), null);
  assert.equal(parseSemanticHostMessage({ type: 'embed', id: 'e1', texts: ['x'.repeat(1001)] }), null);
  assert.equal(parseSemanticHostMessage({ type: 'embed', id: 'e1', texts: Array(33).fill('猫') }), null);
  assert.equal(parseSemanticHostMessage({ type: 'init', runtimeEntry: 'C:\\r', model: 'C:\\m', modelSize: 1, modelSha256: 'zz', vocab: 'C:\\v', vocabSha256: 'a'.repeat(64), threads: 2 }), null, 'a hash that is not hex');
  assert.deepEqual(parseSemanticHostMessage({ type: 'stop' }), { type: 'stop' });
});

test('manifest: exact sizes and SHA-256, pinned commit, kept files only under the component folder, and the store accepts it for both platforms', () => {
  const model = SEMANTIC_ARCHIVES.find(a => a.id === 'bge-model')!, vocab = SEMANTIC_ARCHIVES.find(a => a.id === 'bge-vocab')!;
  assert.equal(model.size, 23_903_394); assert.equal(model.sha256, 'b9837c19ce154ff0726d398ee77abbc03a7faf0476c6f93016c84e531be7ebb5');
  assert.equal(vocab.size, 109_540); assert.equal(vocab.sha256, '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c');
  for (const archive of [model, vocab]) assert.match(archive.url, /^https:\/\/huggingface\.co\/Xenova\/bge-small-zh-v1\.5\/resolve\/75c43b069aac4d136ba6bc1122f995fedcfd2781\//, 'pinned to a commit, not a branch');
  assert.deepEqual(Object.values(SEMANTIC_MODEL_FILES).sort(), ['models/bge-small-zh-v1.5.int8.onnx', 'models/bge-small-zh-v1.5.vocab.txt']);
  assert.ok(SEMANTIC_MODEL_VERSION.includes('75c43b06'), 'the vector files name the model they were made by');
  for (const platform of ['win32-arm64', 'win32-x64'] as const)
    assert.doesNotThrow(() => new PoseComponentStore({ root: path.resolve('C:\\components-test', 'semantic'), platform, manifest: SEMANTIC_MANIFEST, component: 'semantic',
      fetch: () => assert.fail('no network in a constructor'), licenseDir: path.resolve('C:\\licenses-test') }));
});

test('vector files: a round trip keeps every entry; another model, another version, or a damaged file reads as empty; a damaged vector is only recomputed', () => {
  const vectors = new CharacterVectors();
  vectors.entries.set('r1', { scope: 's1', signature: '2.10.5', vector: conceptVector('我养了一只猫') });
  vectors.entries.set('r2', { scope: 's1', signature: '1.3.9', vector: null });
  const text = toFile(vectors, 'model-A');
  const back = fromFile(text, 'model-A');
  assert.equal(back.size, 2);
  assert.deepEqual([...back.entries.get('r1')!.vector!], [...vectors.entries.get('r1')!.vector!], 'exact float32 round trip');
  assert.equal(back.entries.get('r2')!.vector, null);
  assert.equal(fromFile(text, 'model-B').size, 0, 'a vector made by another model is never used');
  assert.equal(fromFile(text.replace('"version":1', '"version":2'), 'model-A').size, 0);
  assert.equal(fromFile('{ not json', 'model-A').size, 0);
  assert.equal(fromFile('', 'model-A').size, 0);
  const damaged = JSON.parse(text); damaged.records[0][3] = 'AAAA';
  const partial = fromFile(JSON.stringify(damaged), 'model-A');
  assert.equal(partial.size, 1, 'only the damaged vector is dropped (it is computed again)'); assert.ok(partial.entries.has('r2'));
});

test('vector store: per character files in memory-vectors/, deletion by id across characters, forgetting one character, removing all', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soft-semantic-vectors-'));
  try {
    const store = new VectorStore(dir, 'model-A');
    const make = (ids: string[]) => { const v = new CharacterVectors(); for (const id of ids) v.entries.set(id, { scope: 's', signature: 'x', vector: conceptVector(id) }); return v; };
    await store.save('girl-a', make(['m1', 'm2'])); await store.save('girl-b', make(['m3', 'm1x']));
    assert.equal((await readdir(path.join(dir, VECTOR_FOLDER))).length, 2);
    assert.equal((await store.load('girl-a')).size, 2);
    assert.equal((await store.load('nobody')).size, 0);
    assert.equal(await store.removeFromAll(['m2', 'm3', 'not-there']), 2);
    assert.deepEqual([...(await store.load('girl-a')).entries.keys()], ['m1']);
    assert.deepEqual([...(await store.load('girl-b')).entries.keys()], ['m1x']);
    assert.equal(await new VectorStore(dir, 'model-B').load('girl-a').then(v => v.size), 0, 'another model version reads nothing');
    await store.forgetCharacter('girl-a');
    assert.equal((await store.load('girl-a')).size, 0);
    assert.equal((await readdir(path.join(dir, VECTOR_FOLDER))).length, 1);
    await store.removeAll();
    await assert.rejects(readdir(path.join(dir, VECTOR_FOLDER)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('score scale: nothing below the floor, a tenth of the maximum at the floor, the maximum at the ceiling, always under a name (6) and a three-character term (4)', () => {
  const m = MEMORY_SEMANTIC_KNOBS.match;
  assert.equal(semanticScore(m.floor - 0.001), 0);
  assert.equal(semanticScore(NaN), 0);
  assert.ok(Math.abs(semanticScore(m.floor) - m.maxScore * 0.1) < 1e-9);
  assert.equal(semanticScore(m.ceiling), m.maxScore);
  assert.equal(semanticScore(1), m.maxScore, 'clamped');
  assert.ok(semanticScore(0.65) > semanticScore(0.6));
  assert.equal(semanticScore(m.floor + 0.01, 0.03), 0, 'the jitter lifts the line for this turn');
  assert.ok(m.maxScore < 4 && m.withLiteralMax <= m.maxScore, 'meaning alone never reaches the three-character term score (4) or a name (6)');
  assert.equal(semanticScore(0.9, 0, { ...MEMORY_SEMANTIC_KNOBS, match: { ...m, maxScore: 0 } }), 0);
});

test('texts: a memory is known by what the user said in it (each line and the total cut), a query carries the model\'s own instruction, too little is empty', () => {
  assert.equal(memoryEmbedText(['我养了一只橘猫叫团子']), '我养了一只橘猫叫团子');
  assert.equal(memoryEmbedText(['嗯', '好的']), '', 'under minChars of the user\'s own words: not worth a vector');
  assert.equal(memoryEmbedText([]), '');
  const long = memoryEmbedText(['啊'.repeat(500), '哦'.repeat(500)]);
  assert.ok(Array.from(long).length <= MEMORY_SEMANTIC_KNOBS.text.memoryChars);
  assert.ok(Array.from(long.split('；')[0]).length <= MEMORY_SEMANTIC_KNOBS.text.messageChars);
  assert.equal(queryEmbedText('你还记得我家那只猫吗'), QUERY_INSTRUCTION + '你还记得我家那只猫吗');
  assert.equal(Array.from(queryEmbedText('字'.repeat(500))).length, Array.from(QUERY_INSTRUCTION).length + MEMORY_SEMANTIC_KNOBS.text.queryChars);
  assert.equal(queryEmbedText('  多   余\n空白 '), QUERY_INSTRUCTION + '多 余 空白');
});

test('view: the broadcast guard accepts exactly the fixed shape and equality ignores nothing that is shown', () => {
  const view = { enabled: true, phase: 'ready' as const, downloadBytes: 24_000_000, installedBytes: 24_100_000, progress: null, notice: '' as const, indexed: 3, total: 10 };
  assert.deepEqual(parseSemanticView(view), view);
  assert.equal(parseSemanticView({ ...view, phase: 'weird' }), null);
  assert.equal(parseSemanticView({ ...view, progress: 2 }), null);
  assert.equal(parseSemanticView({ ...view, indexed: -1 }), null);
  assert.equal(parseSemanticView({ ...view, enabled: 'yes' }), null);
  assert.equal(parseSemanticView('x'), null);
  assert.ok(sameSemanticView(view, { ...view }));
  assert.ok(!sameSemanticView(view, { ...view, indexed: 4 }));
  assert.ok(!sameSemanticView(view, { ...view, enabled: false }));
});
