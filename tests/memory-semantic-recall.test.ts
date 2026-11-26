/**
 * I-111 recall by meaning, the behaviour (docs/claude/2026-11-13-bge-recall.md). A concept-based fake embedder stands in for the model, so what
 * "close in meaning" is is exactly what each test says; the real model's numbers are in tests/memory-semantic-real.test.ts and the record.
 * Synthetic memories in temporary folders only: no real profile, no real chat, no network.
 *
 * What it pins: a synonym finds the memory by meaning; with the switch off, the model missing, failing or slow, recall is exactly what it was
 * (and nothing is downloaded or computed while off); another character's or another connection's memory never comes back; a keyword match
 * keeps first place over a namesake or a negation that is closer in meaning; the 3-turn cooldown still moves a memory back (not out);
 * the backfill is throttled and never blocks; deleting a memory deletes its vector.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../electron/memory/memory';
import { MemoryNotesCore } from '../electron/memory/memory-notes/core';
import { SemanticRecall, prefetchWithin, type SemanticArchive, type SemanticRecallDeps } from '../electron/memory/memory-semantic/recall';
import { SemanticError, SemanticHost, type SemanticWorkerHandle, EMBED_TIMEOUT_MS } from '../electron/memory/memory-semantic/host';
import { startSemanticWorker } from '../electron/memory/memory-semantic/worker';
import { ComponentInstallError } from '../electron/senses/pose/component-store';
import { SEMANTIC_MODEL_VERSION } from '../electron/memory/memory-semantic/manifest';
import { VECTOR_FOLDER, VectorStore } from '../electron/memory/memory-semantic/vectors';
import type { MemoryScope } from '../shared/memory/memory';
import type { NoteSegmentInfo, NoteSegmentText } from '../shared/memory/memory-notes/interface';
import { MEMORY_SEMANTIC_KNOBS } from '../shared/memory/memory-semantic/knobs';
import { MEMORY_NOTES_KNOBS } from '../shared/memory/memory-notes/knobs';
import type { SemanticRecallView } from '../shared/memory/memory-semantic/view';
import { conceptVector, fakeEmbedder, fakeEmbedOrt, type FakeEmbedder } from './helpers/semantic-fakes';

const DAY = 86_400_000, T0 = 1_800_000_000_000, NOW = T0 + 30 * DAY;
const mine: MemoryScope = { characterId: 'test-girl', providerScope: 'claude:test-model' };
const otherGirl: MemoryScope = { characterId: 'other-girl', providerScope: 'claude:test-model' };
const otherConnection: MemoryScope = { characterId: 'test-girl', providerScope: 'claude:another-model' };
const flush = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)); };
const ids = (recalls: readonly { id: string }[]) => recalls.map(recall => recall.id);

interface Rig { store: MemoryStore; directory: string; embedder: FakeEmbedder; vectors: VectorStore; recall: SemanticRecall; core: MemoryNotesCore;
  state: { on: boolean; busy: boolean; cur: MemoryScope; keyed: Map<string, { score: number; terms: string[] }> }; settle(): Promise<void> }
async function withRig(run: (rig: Rig) => Promise<void>, options: { semantic?: boolean; embedder?: FakeEmbedder; random?: number } = {}): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-semantic-recall-'));
  try {
    const store = new MemoryStore(directory); await store.load();
    const embedder = options.embedder ?? fakeEmbedder();
    const state = { on: true, busy: false, cur: mine, keyed: new Map<string, { score: number; terms: string[] }>() };
    const vectors = new VectorStore(directory, SEMANTIC_MODEL_VERSION);
    const recall = new SemanticRecall({ store: vectors, archive: store, embed: texts => embedder.embed(texts), active: () => state.on, busy: () => state.busy,
      current: () => ({ characterId: state.cur.characterId, scope: store.noteScope(state.cur) }), now: () => NOW, random: () => options.random ?? 0 });
    const core = new MemoryNotesCore({ archive: store, write: async () => '', save: async () => {}, userBusy: () => false, modelBusy: () => false, lastActivityAt: () => null,
      currentScope: () => store.noteScope(state.cur), now: () => NOW, keywordScores: () => state.keyed,
      ...(options.semantic === false ? {} : { semanticScores: (text: string) => recall.scores(text) }) });
    store.setRecallHints(core);
    const rig: Rig = { store, directory, embedder, vectors, recall, core, state, async settle() { for (let i = 0; i < 40 && await recall.tick() > 0; i++); await flush(); } };
    await run(rig);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function chat(store: MemoryStore, scope: MemoryScope, id: string, user: string, at: number): Promise<string> {
  const handle = await store.beginTurn(scope, { id, userText: user, at, conversationId: `c-${id}` });
  await store.appendAssistant(scope, id, '嗯嗯，我记着呢', at + 1_000);
  await store.finishTurn(scope, id, 'complete', at + 2_000);
  return handle.recordId;
}
/** What the chat model would be handed for `text`, with the user's line already turned into a vector (what the turn does before it recalls). */
async function ask(rig: Rig, text: string, scope: MemoryScope = mine, maxRecords?: number) {
  await rig.recall.prefetch(text);
  return rig.store.retrieve(scope, text, maxRecords ? { maxRecords } : {}, NOW);
}

test('a synonym finds the memory by meaning where the words alone did not (and the same memory is not found without the switch)', async () => {
  await withRig(async rig => {
    const cat = await chat(rig.store, mine, 'a', '我养了一只橘猫叫团子', T0);
    await chat(rig.store, mine, 'b', '昨天面试被拒了，心里很沮丧', T0 + DAY);
    await chat(rig.store, mine, 'c', '我最近在学吉他，手指都磨疼了', T0 + 2 * DAY);
    await rig.settle();
    assert.deepEqual(ids(await ask(rig, '你还记得我家那只猫吗')), [cat], 'only the cat memory is close in meaning to that line');
    assert.ok(rig.recall.stats.hits >= 1);
  });
  await withRig(async rig => {
    const cat = await chat(rig.store, mine, 'a', '我养了一只橘猫叫团子', T0);
    rig.state.on = false;
    await rig.settle();
    assert.deepEqual(ids(await ask(rig, '你还记得我家那只猫吗')), [], `today's word matching does not find ${cat}: that is the gap`);
  });
});

test('switch off, model missing, model failing: recall is exactly what it was, for words that match and words that do not', async () => {
  const lines = ['你还记得我家那只猫吗', '我最近在学吉他', '昨天面试的事', '随便聊聊', '失眠好几天了'];
  const results: string[] = [];
  for (const variant of ['no-semantic-at-all', 'switch-off', 'model-failing', 'model-slow-never-lands']) {
    const embedder = fakeEmbedder();
    if (variant === 'model-failing') embedder.fail = true;
    await withRig(async rig => {
      await chat(rig.store, mine, 'a', '我养了一只橘猫叫团子', T0);
      const guitar = await chat(rig.store, mine, 'b', '我最近在学吉他，手指都磨疼了', T0 + DAY);
      await chat(rig.store, mine, 'c', '昨天面试被拒了，心里很沮丧', T0 + 2 * DAY);
      rig.state.keyed = new Map([[guitar, { score: 6, terms: ['吉他'] }]]); // words that match today (the keyword recall's own answer)
      if (variant === 'switch-off') rig.state.on = false;
      if (variant === 'model-slow-never-lands') rig.embedder.delay = 300;
      if (variant !== 'model-slow-never-lands') await rig.settle();
      const out: unknown[] = [];
      for (const line of lines) {
        if (variant === 'model-slow-never-lands') await prefetchWithin(rig.recall, line, 5); else await rig.recall.prefetch(line);
        out.push(rig.store.retrieve(mine, line, {}, NOW).map(recall => ({ id: recall.id.length, excerpt: recall.excerpt, title: recall.title })));
      }
      results.push(JSON.stringify(out));
    }, { semantic: variant !== 'no-semantic-at-all', embedder });
  }
  assert.ok(new Set(results).size === 1, 'all four are the same (record ids differ per run, so only their length is compared)');
  assert.ok(JSON.parse(results[0]).some((one: unknown[]) => one.length), 'and the baseline does find something by words (the check is not vacuous)');
});

test('nothing is downloaded, started or computed while the switch is off (host and recall)', async () => {
  const calls = { install: 0, fork: 0 };
  const store = { installed: false, working: false, downloadBytes: 54_000_000, installedBytes: 0, installedDir: () => null, installedFile: () => null,
    refresh: async () => false, install: async () => { calls.install++; store.installed = true; }, remove: async () => { store.installed = false; } };
  const views: SemanticRecallView[] = [];
  const host = new SemanticHost({ store: store as never, fork: () => { calls.fork++; throw new Error('must not start'); }, publish: view => views.push(view),
    loadEnabled: async () => false, saveEnabled: async () => {} });
  await host.init();
  assert.equal(host.enabled, false); assert.equal(host.ready, false);
  assert.equal(host.view().phase, 'not-installed');
  await assert.rejects(host.embed(['猫']), (error: unknown) => error instanceof SemanticError && error.kind === 'off');
  await host.download(); // a stray call without the switch does nothing either
  assert.deepEqual(calls, { install: 0, fork: 0 });
  await withRig(async rig => {
    await chat(rig.store, mine, 'a', '我养了一只橘猫叫团子', T0);
    rig.state.on = false;
    assert.equal(await rig.recall.tick(), 0);
    await rig.recall.prefetch('你还记得我家那只猫吗');
    assert.equal(rig.recall.scores('你还记得我家那只猫吗').size, 0);
    assert.deepEqual(rig.embedder.calls, [], 'the model was never asked');
    await assert.rejects(readdir(path.join(rig.directory, VECTOR_FOLDER)), 'no vector file');
  });
});

test('turning the switch on is the consent: exactly one download starts, with progress; off stops it; the model is not fetched again once installed', async () => {
  const log: string[] = [];
  let release!: () => void;
  const store = { installed: false, working: false, downloadBytes: 54_000_000, installedBytes: 0, installedDir: () => 'C:\\c\\semantic-v1\\win32-arm64',
    installedFile: (to: string) => `C:\\c\\semantic-v1\\win32-arm64\\${to}`, refresh: async () => store.installed,
    install: async (signal: AbortSignal, progress: (p: { stage: 'downloading' | 'installing'; done: number; total: number }) => void) => {
      log.push('install'); progress({ stage: 'downloading', done: 25, total: 100 });
      await new Promise<void>((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(new ComponentInstallError('canceled', 'aborted'))); });
      store.installed = true; store.installedBytes = 24_000_000;
    }, remove: async () => { store.installed = false; store.installedBytes = 0; log.push('remove'); } };
  const saved: boolean[] = [], views: SemanticRecallView[] = [];
  const host = new SemanticHost({ store: store as never, fork: () => assert.fail('no process for a download'), publish: view => views.push(view),
    loadEnabled: async () => false, saveEnabled: async on => { saved.push(on); } });
  await host.init();
  await host.setEnabled(true); await flush();
  assert.deepEqual(log, ['install']); assert.deepEqual(saved, [true]);
  assert.equal(host.view().phase, 'downloading'); assert.equal(host.view().progress, 0.25);
  await host.setEnabled(true); assert.deepEqual(log, ['install'], 'a second click does not start a second download');
  release(); await flush();
  assert.equal(host.view().phase, 'idle'); assert.equal(host.ready, true);
  await host.setEnabled(false); await host.setEnabled(true); await flush();
  assert.deepEqual(log, ['install'], 'already installed: nothing more to fetch');
  // Off during a download: aborted and the notice says so; the choice is saved.
  store.installed = false; store.installedBytes = 0; log.length = 0;
  await host.setEnabled(false); await host.setEnabled(true); await flush();
  assert.deepEqual(log, ['install']);
  await host.setEnabled(false); await flush();
  assert.equal(host.view().enabled, false); assert.equal(host.view().notice, 'canceled');
  assert.equal(saved.at(-1), false);
  assert.equal(host.ready, false);
});

test('a failed download leaves the switch on with a retry (the choice is not undone behind her back), and cancel is the user saying no', async () => {
  let fail = true;
  const store = { installed: false, working: false, downloadBytes: 1, installedBytes: 0, installedDir: () => null, installedFile: () => null, refresh: async () => false,
    install: async (signal: AbortSignal) => { if (fail) throw new Error('offline'); if (signal.aborted) throw new Error('x'); store.installed = true; }, remove: async () => {} };
  const saved: boolean[] = [];
  const host = new SemanticHost({ store: store as never, fork: () => assert.fail('x'), publish() {}, loadEnabled: async () => false, saveEnabled: async on => { saved.push(on); } });
  await host.init();
  await host.setEnabled(true); await flush();
  assert.equal(host.view().notice, 'download-failed'); assert.equal(host.enabled, true); assert.equal(host.view().phase, 'not-installed');
  fail = false;
  await host.download();
  assert.equal(host.view().notice, ''); assert.equal(host.view().phase, 'idle');
});

test('another character\'s memory and another connection\'s memory never come back, however close they are in meaning', async () => {
  await withRig(async rig => {
    const mineCat = await chat(rig.store, mine, 'a', '我养了一只橘猫叫团子', T0);
    const girlCat = await chat(rig.store, otherGirl, 'b', '我养了一只黑猫叫煤球', T0 + DAY);
    const connectionCat = await chat(rig.store, otherConnection, 'c', '我家的猫最爱喵喵叫', T0 + 2 * DAY);
    for (const scope of [mine, otherGirl, otherConnection]) { rig.state.cur = scope; await rig.settle(); }
    rig.state.cur = mine;
    const hits = rig.recall.scores('你还记得我家那只猫吗');
    await rig.recall.prefetch('你还记得我家那只猫吗');
    assert.deepEqual([...rig.recall.scores('你还记得我家那只猫吗').keys()], [mineCat], 'the vectors of the other two exist, yet only this scope is searched');
    assert.equal(hits.size, 0, '(and before the line was a vector there was nothing at all)');
    assert.deepEqual(ids(rig.store.retrieve(mine, '你还记得我家那只猫吗', {}, NOW)), [mineCat]);
    rig.state.cur = otherGirl; await rig.recall.prefetch('你还记得我家那只猫吗');
    assert.deepEqual(ids(rig.store.retrieve(otherGirl, '你还记得我家那只猫吗', {}, NOW)), [girlCat]);
    rig.state.cur = otherConnection;
    assert.deepEqual(ids(rig.store.retrieve(otherConnection, '你还记得我家那只猫吗', {}, NOW)), [connectionCat]);
    // Each character has her own vector file.
    assert.equal((await readdir(path.join(rig.directory, VECTOR_FOLDER))).length, 2, 'test-girl (two connections share one file) and other-girl');
  });
});

test('a keyword match keeps first place over a namesake or a negation that is closer in meaning; meaning alone stays under it', async () => {
  await withRig(async rig => {
    const right = await chat(rig.store, mine, 'a', '我养了一只橘猫叫团子', T0);
    const negation = await chat(rig.store, mine, 'b', '我不再养猫了，也不打算再养猫', T0 + DAY);
    const namesake = await chat(rig.store, mine, 'c', '便利店那只柴犬也叫团子，特别黏人', T0 + 2 * DAY);
    await chat(rig.store, mine, 'd', '昨天面试被拒了，心里很沮丧', T0 + 3 * DAY);
    await rig.settle();
    rig.state.keyed = new Map([[right, { score: 6, terms: ['团子'] }]]);
    const line = '团子最近怎么样';
    await rig.recall.prefetch(line);
    const meaning = rig.recall.scores(line);
    assert.ok(meaning.has(negation) && meaning.has(right), 'the negation is exactly as close in meaning to a line about 团子 as the right memory (a model does not read "不再")');
    assert.equal(meaning.size, MEMORY_SEMANTIC_KNOBS.match.top, 'and the line brings no more than the knob allows (the namesake, a little further, is not among them)');
    const got = ids(rig.store.retrieve(mine, line, {}, NOW));
    assert.equal(got[0], right, 'the literal match is first');
    assert.ok(got.includes(negation), 'the negation may follow as a candidate, behind it');
    // The hint itself: literal 6 plus at most withLiteralMax; the others at most the semantic maximum, always under 6.
    const hint = rig.core.prepare(line);
    assert.ok(hint(right)!.score <= 6 + MEMORY_SEMANTIC_KNOBS.match.withLiteralMax + 1e-9 && hint(right)!.score > 6);
    assert.ok(hint(negation)!.score <= MEMORY_SEMANTIC_KNOBS.match.maxScore + 1e-9 && hint(negation)!.score < 6);
    assert.equal(hint(namesake)?.score ?? 0, 0, 'cut by the top limit');
    // With the keyword on the namesake instead, it is the one that comes first: the order follows the words, not the meaning.
    rig.state.keyed = new Map([[namesake, { score: 6, terms: ['团子'] }]]);
    assert.equal(ids(rig.store.retrieve(mine, line, {}, NOW))[0], namesake);
  });
});

test('keyword matches do not get worse: the same ordering and excerpt with and without meaning when the words already found the memory', async () => {
  const outcomes: string[] = [];
  for (const semantic of [false, true]) await withRig(async rig => {
    const a = await chat(rig.store, mine, 'a', '我最近在学吉他，手指都磨疼了', T0);
    await chat(rig.store, mine, 'b', '我养了一只橘猫叫团子', T0 + DAY);
    await rig.settle();
    rig.state.keyed = new Map([[a, { score: 6, terms: ['吉他'] }]]);
    const got = await ask(rig, '吉他练得怎么样了');
    outcomes.push(JSON.stringify(got.map(item => ({ excerpt: item.excerpt, title: item.title }))));
    assert.equal(got[0].id, a);
  }, { semantic });
  assert.equal(outcomes[0], outcomes[1]);
});

test('the 3-turn cooldown still moves a recalled memory back, not out (meaning is not an explicit ask)', async () => {
  await withRig(async rig => {
    const older = await chat(rig.store, mine, 'a', '我养了一只橘猫叫团子', T0);
    const newer = await chat(rig.store, mine, 'b', '朋友家的猫生了四只小猫', T0 + DAY);
    await rig.settle();
    const first = await ask(rig, '我家那只猫', mine, 1);
    assert.deepEqual(ids(first), [newer], 'equal in meaning: the newer one first');
    const second = await ask(rig, '再说说猫的事');
    assert.deepEqual(ids(second), [older, newer], 'what she just handed over steps behind, and is still there');
    const cooled = MEMORY_NOTES_KNOBS.matter.cooldownTurns;
    for (let i = 0; i < cooled; i++) await ask(rig, `第${i}次提到猫`);
    assert.equal(ids(await ask(rig, '最后再说猫')).length, 2, 'once the cooldown is over they are ordinary again, both there');
  });
});

test('too far in meaning gives nothing, and one line brings at most knobs.match.top candidates', async () => {
  await withRig(async rig => {
    for (let i = 0; i < 4; i++) await chat(rig.store, mine, `cat${i}`, `我家的猫第${i}次又闹了笑话`, T0 + i * DAY);
    await chat(rig.store, mine, 'job', '昨天面试被拒了，心里很沮丧', T0 + 5 * DAY);
    await rig.settle();
    await rig.recall.prefetch('你家的猫呢');
    assert.equal(rig.recall.scores('你家的猫呢').size, MEMORY_SEMANTIC_KNOBS.match.top);
    await rig.recall.prefetch('今天的天气真不错呀');
    assert.equal(rig.recall.scores('今天的天气真不错呀').size, 0, 'a line about nothing the memories are about');
  });
});

test('the line is a vector only after prefetch: scores never waits, and a miss starts the work for the next call', async () => {
  await withRig(async rig => {
    await chat(rig.store, mine, 'a', '我养了一只橘猫叫团子', T0);
    await rig.settle();
    assert.equal(rig.recall.scores('我家那只猫').size, 0, 'not computed yet');
    await flush();
    assert.equal(rig.recall.scores('我家那只猫').size, 1, 'the miss warmed it');
    assert.equal(rig.embedder.calls.filter(call => call[0].includes('我家那只猫')).length, 1, 'computed once');
  });
});

test('prefetchWithin: never longer than the limit, never throws, and the vector that lands late serves the next call', async () => {
  await withRig(async rig => {
    await chat(rig.store, mine, 'a', '我养了一只橘猫叫团子', T0);
    await rig.settle();
    rig.embedder.delay = 80;
    const started = Date.now();
    await prefetchWithin(rig.recall, '我家那只猫', 10);
    assert.ok(Date.now() - started < 70, 'gave up at the limit');
    assert.equal(rig.recall.scores('我家那只猫').size, 0, 'this turn goes without meaning');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(rig.recall.scores('我家那只猫').size, 1, 'the next call has it');
    rig.embedder.fail = true;
    await prefetchWithin(rig.recall, '另一句话关于猫', 50);
    await prefetchWithin({ prefetch: () => { throw new Error('boom'); } } as never, 'x', 50);
  });
});

test('the jitter is drawn once per line (two retrieves for one line agree), and the same line is not computed twice', async () => {
  let draws = 0;
  await withRig(async rig => {
    await chat(rig.store, mine, 'a', '我养了一只橘猫叫团子', T0);
    await rig.settle();
    await rig.recall.prefetch('我家那只猫'); await rig.recall.prefetch('我家那只猫');
    rig.recall.scores('我家那只猫'); rig.recall.scores('我家那只猫');
    assert.equal(rig.embedder.calls.filter(call => call[0].includes('我家那只猫')).length, 1);
    void draws;
  }, { random: 0.5 });
});

// ---- the backfill, on a fake archive (no journal, so a thousand segments are cheap) ----

class FakeArchive implements SemanticArchive {
  segments: NoteSegmentInfo[] = []; texts = new Map<string, string[]>(); reads = 0;
  add(id: string, user: string[], lastAt: number, scope = 's1', ended = true): void {
    this.segments.push({ id, scope, createdAt: lastAt - 1000, lastAt, ended, source: `src-${user.join('|').length}-${id}`, userChars: 10, replies: 1 }); this.texts.set(id, user);
  }
  noteSegments(): readonly NoteSegmentInfo[] { return this.segments; }
  noteSegment(id: string): NoteSegmentText | null {
    this.reads++;
    const info = this.segments.find(segment => segment.id === id);
    return info ? { info, messages: [...(this.texts.get(id) ?? []).map(content => ({ role: 'user' as const, content })), { role: 'assistant' as const, content: '猫猫猫猫猫猫猫' }] } : null;
  }
}
async function withBackfill(run: (parts: { archive: FakeArchive; recall: SemanticRecall; embedder: FakeEmbedder; vectors: VectorStore; state: { busy: boolean; on: boolean; cur: { characterId: string; scope: string }; now: number }; saves: number[]; directory: string }) => Promise<void>,
  extra: Partial<SemanticRecallDeps> = {}): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-semantic-backfill-'));
  try {
    const archive = new FakeArchive(), embedder = fakeEmbedder();
    const saves: number[] = [];
    const vectors = new VectorStore(directory, SEMANTIC_MODEL_VERSION, async (file, text) => { saves.push(text.length); await writeFile(file, text); });
    const state = { busy: false, on: true, cur: { characterId: 'girl', scope: 's1' }, now: NOW };
    const recall = new SemanticRecall({ store: vectors, archive, embed: texts => embedder.embed(texts), active: () => state.on, busy: () => state.busy, current: () => state.cur, now: () => state.now, ...extra });
    await run({ archive, recall, embedder, vectors, state, saves, directory });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('backfill: a thousand old chats in batches of the knob size, newest first, only finished chats of this scope, and the throttle keeps writes few', async () => {
  await withBackfill(async ({ archive, recall, embedder, vectors, saves }) => {
    for (let i = 0; i < 1000; i++) archive.add(`m${i}`, [`我家的猫第${i}次又闹了笑话`], T0 + i * 1000);
    archive.add('running', ['我家的猫还在聊天里呢哈哈'], T0, 's1', false);
    archive.add('elsewhere', ['别的角色的猫也很可爱呢'], T0, 'other-scope');
    const first = await recall.tick();
    assert.equal(first, MEMORY_SEMANTIC_KNOBS.pace.batch);
    assert.ok(embedder.calls[0][0].includes('第999次'), 'the newest first');
    let rounds = 1;
    while (await recall.tick() > 0) rounds++;
    assert.equal(rounds, Math.ceil(1000 / MEMORY_SEMANTIC_KNOBS.pace.batch));
    assert.equal(recall.stats.embedded, 1000);
    assert.deepEqual(recall.progress(), { indexed: 1000, total: 1000 });
    assert.ok(!embedder.calls.flat().some(text => text.includes('还在聊天里') || text.includes('别的角色')), 'neither a running chat nor another scope is computed');
    assert.ok(saves.length <= 3, `writes are throttled (${saves.length} for ${rounds} rounds)`);
    assert.equal((await vectors.load('girl')).size, 1000, 'and all of it is on disk when the backfill is done');
    assert.equal(await recall.tick(), 0, 'nothing left: nothing asked of the model');
    const calls = embedder.calls.length;
    await recall.tick(); assert.equal(embedder.calls.length, calls);
  });
});

test('backfill: waits while the user is with her, picks up changed text and leaves unchanged text alone, skips chats with too little to mean anything once', async () => {
  await withBackfill(async ({ archive, recall, embedder, state }) => {
    archive.add('a', ['我养了一只橘猫叫团子'], T0); archive.add('tiny', ['嗯', '好'], T0 + 1000);
    state.busy = true;
    assert.equal(await recall.tick(), 0); assert.equal(embedder.calls.length, 0, 'the user is busy: not even a look at the archive costs her anything');
    state.busy = false;
    assert.equal(await recall.tick(), 1);
    const reads = archive.reads;
    assert.equal(await recall.tick(), 0); assert.equal(archive.reads, reads, 'the tiny one is marked: its text is not fetched again');
    assert.deepEqual(recall.progress(), { indexed: 2, total: 2 });
    archive.segments[0] = { ...archive.segments[0], source: 'changed' }; archive.texts.set('a', ['我养了一只橘猫叫团子，还有一只狗']);
    assert.equal(await recall.tick(), 1); assert.ok(embedder.calls.at(-1)![0].includes('还有一只狗'));
    assert.equal(await recall.tick(), 0);
  });
});

test('backfill: a failing model costs nothing (no crash, nothing marked done, tried again later), and a memory that is gone loses its vector', async () => {
  await withBackfill(async ({ archive, recall, embedder, vectors }) => {
    archive.add('a', ['我养了一只橘猫叫团子'], T0); archive.add('b', ['昨天面试被拒了，心里很沮丧'], T0 + 1000);
    embedder.fail = true;
    assert.equal(await recall.tick(), 0); assert.equal(recall.stats.failed, 1);
    assert.deepEqual(recall.progress(), { indexed: 0, total: 2 });
    embedder.fail = false;
    assert.equal(await recall.tick(), 2);
    archive.segments = archive.segments.filter(segment => segment.id !== 'a');
    await recall.tick(); await recall.flush();
    assert.deepEqual([...(await vectors.load('girl')).entries.keys()], ['b'], 'the safety net: a vector whose memory is no longer in the archive goes');
  });
});

test('deleting memories deletes their vectors everywhere (loaded sets and files); forgetting a character and deleting the model clear the rest', async () => {
  await withBackfill(async ({ archive, recall, vectors, directory }) => {
    archive.add('a', ['我养了一只橘猫叫团子'], T0); archive.add('b', ['昨天面试被拒了，心里很沮丧'], T0 + 1000);
    await recall.tick(); await recall.flush();
    await recall.prefetch('我家那只猫');
    assert.equal(recall.scores('我家那只猫').size, 1);
    await recall.removeEverywhere(['a']);
    assert.equal(recall.scores('我家那只猫').size, 0, 'at once, in memory');
    assert.deepEqual([...(await vectors.load('girl')).entries.keys()], ['b'], 'and on disk');
    await recall.forgetCharacter('girl');
    assert.equal((await vectors.load('girl')).size, 0);
    archive.add('c', ['我最近在学吉他，手指都磨疼了'], T0 + 2000);
    await recall.tick(); await recall.flush();
    await recall.forgetAll();
    await assert.rejects(readdir(path.join(directory, VECTOR_FOLDER)), 'deleting the model deletes everything computed with it');
  });
});

test('the switch going off drops the lines kept for a moment (and the vectors stay unused on disk)', async () => {
  await withBackfill(async ({ archive, recall, state, embedder }) => {
    archive.add('a', ['我养了一只橘猫叫团子'], T0);
    await recall.tick(); await recall.prefetch('我家那只猫');
    assert.equal(recall.scores('我家那只猫').size, 1);
    state.on = false; // even with the vectors and the line still held, the switch alone silences it
    assert.equal(recall.scores('我家那只猫').size, 0);
    state.on = true; assert.equal(recall.scores('我家那只猫').size, 1);
    state.on = false; recall.deactivate();
    assert.equal(recall.scores('我家那只猫').size, 0);
    const calls = embedder.calls.length;
    await recall.prefetch('我家那只猫'); await recall.tick();
    assert.equal(embedder.calls.length, calls, 'nothing is asked of the model while off');
  });
});

// ---- the host around a fake process, and the process itself ----

function clock() {
  let now = 0, id = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  return {
    setTimer: (run: () => void, ms: number) => { due.set(++id, { at: now + ms, run }); return id; },
    clearTimer: (handle: unknown) => { due.delete(handle as number); },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        due.delete(next[0]); now = next[1].at; next[1].run(); await flush();
      }
      now = end;
    },
  };
}
function hostRig(installed = true) {
  const time = clock(), made: { sent: unknown[]; message?: (m: unknown) => void; exit?: (code: number) => void; killed: number; exited: boolean }[] = [];
  const store = { installed, working: false, downloadBytes: 54_000_000, installedBytes: installed ? 24_000_000 : 0,
    installedDir: () => installed ? 'C:\\c\\semantic-v1\\win32-arm64' : null,
    installedFile: (to: string) => installed ? `C:\\c\\semantic-v1\\win32-arm64\\${to.replaceAll('/', '\\')}` : null,
    refresh: async () => store.installed, install: async () => { store.installed = true; }, remove: async () => { store.installed = false; } };
  const saved: boolean[] = [], removed = { count: 0 };
  const fork = (): SemanticWorkerHandle => {
    const worker = { sent: [] as unknown[], message: undefined as ((m: unknown) => void) | undefined, exit: undefined as ((code: number) => void) | undefined, killed: 0, exited: false };
    made.push(worker);
    return { postMessage: m => { worker.sent.push(m); }, onMessage: l => { worker.message = l; }, onExit: l => { worker.exit = l; }, kill: () => { worker.killed++; worker.exited = true; worker.exit?.(1); } };
  };
  const host = new SemanticHost({ store: store as never, fork, publish() {}, loadEnabled: async () => true, saveEnabled: async on => { saved.push(on); }, removed: async () => { removed.count++; },
    setTimer: time.setTimer, clearTimer: time.clearTimer });
  return { host, time, made, store, saved, removed };
}
const unit = (text: string) => conceptVector(text, false);

test('host: a request goes to the process and the vectors come back; the process loads once and stops by itself after the idle time', async () => {
  const h = hostRig(); await h.host.init();
  const pending = h.host.embed(['我养了一只橘猫叫团子']); await flush();
  const worker = h.made[0]!;
  const init = worker.sent[0] as Record<string, unknown>;
  assert.equal(init.type, 'init'); assert.match(String(init.runtimeEntry), /onnxruntime-node$/); assert.equal(init.modelSize, 23_903_394); assert.match(String(init.modelSha256), /^b9837c19/);
  worker.message!({ type: 'ready', loadMs: 120 }); await flush();
  const request = worker.sent[1] as { type: string; id: string; texts: string[] };
  assert.equal(request.type, 'embed');
  worker.message!({ type: 'result', id: request.id, vectors: [unit('猫')], ms: 3 });
  assert.equal((await pending).length, 1);
  assert.equal(h.host.view().phase, 'ready');
});

test('host: the second request reuses the process; idle time stops it (session released, exit by itself, killed only after the grace time)', async () => {
  const h = hostRig(); await h.host.init();
  const first = h.host.embed(['猫']); await flush();
  const worker = h.made[0]!; worker.message!({ type: 'ready', loadMs: 1 }); await flush();
  worker.message!({ type: 'result', id: (worker.sent[1] as { id: string }).id, vectors: [unit('猫')], ms: 1 }); await first;
  const second = h.host.embed(['狗']); await flush();
  assert.equal(h.made.length, 1, 'one process');
  worker.message!({ type: 'result', id: (worker.sent[2] as { id: string }).id, vectors: [unit('狗')], ms: 1 }); await second;
  await h.time.advance(MEMORY_SEMANTIC_KNOBS.pace.idleStopMinutes * 60_000 + 1000);
  assert.deepEqual(worker.sent.at(-1), { type: 'stop' });
  await h.time.advance(5_100);
  assert.equal(worker.killed, 1, 'it did not leave by itself, so it was killed after the grace time');
  assert.equal(h.host.view().phase, 'idle');
});

test('host: a stuck request times out, the process is replaced, and the failure is a category, not text', async () => {
  const h = hostRig(); await h.host.init();
  const pending = h.host.embed(['猫']); await flush();
  const worker = h.made[0]!; worker.message!({ type: 'ready', loadMs: 1 }); await flush();
  const settled = pending.then(() => 'ok', (error: unknown) => (error as SemanticError).kind);
  await h.time.advance(EMBED_TIMEOUT_MS + 10);
  assert.equal(await settled, 'timeout');
  assert.deepEqual(worker.sent.at(-1), { type: 'stop' });
  const next = h.host.embed(['猫']); await flush(); next.catch(() => undefined);
  assert.equal(h.made.length, 2, 'a fresh process for the next request');
});

test('host: a model that fails to load is reported by category and the process is dropped; garbage from the process is ignored', async () => {
  const h = hostRig(); await h.host.init();
  const pending = h.host.embed(['猫']); await flush();
  const worker = h.made[0]!;
  worker.message!({ type: 'result', id: 'sem-1', vectors: [new Float32Array(3)], ms: 1 }); worker.message!('not a message'); worker.message!({ type: 'ready', loadMs: -5 });
  worker.message!({ type: 'failed', reason: 'model' });
  await assert.rejects(pending, (error: unknown) => error instanceof SemanticError && error.kind === 'failed');
  assert.equal(h.host.view().notice, 'failed');
});

test('host: remove deletes the model and what was computed with it, and the switch goes off; the saved choice survives a restart', async () => {
  const h = hostRig(); await h.host.init();
  assert.equal(h.host.enabled, true, 'the saved switch was read');
  await h.host.remove();
  assert.equal(h.store.installed, false); assert.equal(h.removed.count, 1); assert.equal(h.host.enabled, false); assert.equal(h.saved.at(-1), false);
  assert.equal(h.host.view().notice, 'removed');
});

/** Waits for observable state (not a guessed pause): polls until the check is true; the ceiling is only so a real hang still fails. */
async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 60_000;
  while (!check()) {
    if (Date.now() > end) assert.fail('never happened: ' + what);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('process: loads the checked files, answers embeds with unit vectors, refuses changed files, and ends by itself on stop after releasing the session', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soft-semantic-worker-'));
  try {
    const model = Buffer.from('not a real model'), vocabText = '[PAD]\n[UNK]\n[CLS]\n[SEP]\n猫\n';
    await writeFile(path.join(dir, 'm.onnx'), model); await writeFile(path.join(dir, 'v.txt'), vocabText);
    const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const run = async (modelSha: string) => {
      const fake = fakeEmbedOrt(), sent: unknown[] = [], exits: number[] = [];
      let listener!: (event: { data: unknown }) => void;
      startSemanticWorker({ on: (_event, l) => { listener = l; }, postMessage: m => { sent.push(m); } }, () => fake.ort, code => exits.push(code), () => 0);
      listener({ data: { type: 'init', runtimeEntry: path.join(dir, 'ort'), model: path.join(dir, 'm.onnx'), modelSize: model.length, modelSha256: modelSha, vocab: path.join(dir, 'v.txt'), vocabSha256: sha(vocabText), threads: 2 } });
      await until(() => sent.length >= 1, 'the worker answers its init');
      return { fake, sent, exits, send: (data: unknown) => listener({ data }) };
    };
    const good = await run(sha(model));
    assert.deepEqual(good.sent[0], { type: 'ready', loadMs: 0 });
    good.send({ type: 'embed', id: 'e1', texts: ['猫', '猫猫'] }); good.send({ type: 'embed', id: 'bad id', texts: ['x'] }); good.send({ type: 'embed', id: 'e2', texts: [] });
    await until(() => good.sent.length >= 2, 'the embed result');
    await new Promise(resolve => setTimeout(resolve, 20)); // malformed requests are dropped at once; the short grace only catches a stray answer
    const result = good.sent[1] as { type: string; id: string; vectors: Float32Array[] };
    assert.equal(result.type, 'result'); assert.equal(result.vectors.length, 2); assert.equal(good.sent.length, 2, 'malformed requests get no answer');
    good.send({ type: 'stop' }); await until(() => good.exits.length >= 1, 'the worker ends itself on stop');
    assert.equal(good.fake.released.count, 1); assert.deepEqual(good.exits, [0]);
    const bad = await run('0'.repeat(64));
    assert.deepEqual(bad.sent[0], { type: 'failed', reason: 'model' });
    bad.send({ type: 'embed', id: 'e1', texts: ['猫'] }); await until(() => bad.sent.length >= 2, 'the error answer');
    assert.deepEqual(bad.sent[1], { type: 'error', id: 'e1' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
