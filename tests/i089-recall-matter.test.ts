/**
 * I-089 item 1 「回忆有轻重」 (docs/claude/2026-11-12-i089-items-4-1.md). Synthetic segments and notes only (a temporary folder each, no
 * real profile, no model). What it pins: among memories that all match what the user said, the one that mattered more (strong feeling,
 * a plan not done, brought up again and again) goes first and trivia is the one left out; the feeling eases over time, slower when
 * strong; what was just handed over steps back for a few of the user's lines (not for an explicit "还记得"); nothing that did not match
 * ever shows; a note without the new field behaves exactly as before; the new field is optional in the note file and in the model's answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../electron/memory/memory';
import { validateMemoryNotesFile } from '../electron/memory/memory-notes/store';
import { DEFAULT_MEMORY_CONFIG, type MemoryScope } from '../shared/memory/memory';
import type { MemoryNoteHint, MemoryNoteTraits, MemoryRecallHints } from '../shared/memory/memory-notes/interface';
import { MEMORY_NOTES_KNOBS } from '../shared/memory/memory-notes/knobs';
import { RecallCooldown, matterBonus, recallMatter } from '../shared/memory/memory-notes/matter';
import { MEMORY_NOTE_SYSTEM_PROMPT, parseMemoryNote } from '../shared/memory/memory-notes/note';
import { fakeNoteBody } from '../shared/memory/memory-notes/fake';

const DAY = 86_400_000;
const T0 = 1_800_000_000_000;
const scope: MemoryScope = { characterId: 'test-girl', providerScope: 'claude:test-model' };
const K = MEMORY_NOTES_KNOBS.matter;

async function withStore(run: (store: MemoryStore) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-recall-matter-test-'));
  try { const store = new MemoryStore(directory); await store.load(); await run(store); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function chat(store: MemoryStore, id: string, user: string, at: number): Promise<string> {
  const handle = await store.beginTurn(scope, { id, userText: user, at, conversationId: `c-${id}` });
  await store.appendAssistant(scope, id, '嗯嗯', at + 1_000);
  await store.finishTurn(scope, id, 'complete', at + 2_000);
  return handle.recordId;
}
/** Every id in `ids` matches with the same score (so only the weighing decides the order). */
function hintsFor(ids: readonly string[], traits: Record<string, MemoryNoteTraits> = {}): MemoryRecallHints {
  const hint: MemoryNoteHint = { score: 5, explicit: false, terms: [], title: '' };
  return { prepare: () => id => (ids.includes(id) ? hint : null), traits: id => traits[id] ?? null };
}
const ids = (recalls: readonly { id: string }[]) => recalls.map(recall => recall.id);

test('the one that mattered comes first and trivia is what is left out', async () => {
  for (const marked of [false, true]) await withStore(async store => {
    // The felt one is the OLDEST: by recency alone it would be the fourth and not shown (three fit).
    const felt = await chat(store, 'a', '合成事件甲，我超级难过', T0);
    const trivia = [await chat(store, 'b', '合成事件乙', T0 + DAY), await chat(store, 'c', '合成事件丙', T0 + 2 * DAY), await chat(store, 'd', '合成事件丁', T0 + 3 * DAY)];
    store.setRecallHints(hintsFor([felt, ...trivia], marked ? { [felt]: { felt: 3, openPlans: false, at: T0 } } : {}));
    const got = ids(store.retrieve(scope, '那件事', {}, T0 + 4 * DAY));
    if (!marked) { assert.ok(!got.includes(felt), 'without the feeling mark it is not among the three (the old behavior)'); return; }
    assert.equal(got[0], felt, 'the strong feeling goes first');
    assert.equal(got.length, 3);
    assert.ok(!got.includes(trivia[0]), 'the oldest trivia is the one that gives way');
  });
});

test('a plan not yet done floats up for a while, then is an ordinary memory', async () => {
  await withStore(async store => {
    const plan = await chat(store, 'a', '合成计划甲', T0);
    const others = [await chat(store, 'b', '合成事件乙', T0 + DAY), await chat(store, 'c', '合成事件丙', T0 + 2 * DAY), await chat(store, 'd', '合成事件丁', T0 + 3 * DAY)];
    const traits = { [plan]: { felt: null, openPlans: true, at: T0 } };
    store.setRecallHints(hintsFor([plan, ...others], traits));
    assert.equal(ids(store.retrieve(scope, '后来怎么样', {}, T0 + 4 * DAY))[0], plan);
    store.setRecallHints(hintsFor([plan, ...others], traits));
    const late = ids(store.retrieve(scope, '后来怎么样呢', {}, T0 + (K.planDays + 5) * DAY));
    assert.ok(!late.includes(plan), 'past planDays it no longer gets the lift: the newest three');
  });
});

test('brought up again and again: a reinforced memory goes ahead of equally matching ones', async () => {
  await withStore(async store => {
    const loved = await chat(store, 'a', '合成事件甲', T0);
    const others = [await chat(store, 'b', '合成事件乙', T0 + DAY), await chat(store, 'c', '合成事件丙', T0 + 2 * DAY), await chat(store, 'd', '合成事件丁', T0 + 3 * DAY)];
    for (let i = 0; i < 4; i++) await store.reinforce(scope, loved, { eventId: `e${i}`, episodeId: `p${i}`, at: T0 + 4 * DAY + i });
    // The others match a little better (6 against 5): by score alone they win. Brought up four times, she holds it dearer (about +1.3).
    const better: MemoryNoteHint = { score: 6, explicit: false, terms: [], title: '' }, plain: MemoryNoteHint = { score: 5, explicit: false, terms: [], title: '' };
    store.setRecallHints({ prepare: () => id => (id === loved ? plain : others.includes(id) ? better : null) });
    const now = T0 + 4 * DAY + 100;
    assert.equal(ids(store.retrieve(scope, '那个', {}, now))[0], loved);
  });
});

test('an old memory (no note traits, starting weight) is ordered exactly as before: the newest of equals first', async () => {
  for (const withTraitsMethod of [true, false]) await withStore(async store => {
    const all = [await chat(store, 'a', '合成事件甲', T0), await chat(store, 'b', '合成事件乙', T0 + DAY), await chat(store, 'c', '合成事件丙', T0 + 2 * DAY), await chat(store, 'd', '合成事件丁', T0 + 3 * DAY)];
    // a hint object that has traits() answering "no note", and one that has no traits() at all (an older notebook)
    store.setRecallHints(withTraitsMethod ? hintsFor(all) : { prepare: () => id => (all.includes(id) ? { score: 5, explicit: false, terms: [], title: '' } : null) });
    assert.deepEqual(ids(store.retrieve(scope, '那个', {}, T0 + 4 * DAY)), [all[3], all[2], all[1]]);
  });
});

test('weighing orders only: a memory that did not match never shows, however much it mattered', async () => {
  await withStore(async store => {
    const strong = await chat(store, 'a', '合成事件甲', T0);
    const match = await chat(store, 'b', '合成事件乙', T0 + DAY);
    store.setRecallHints(hintsFor([match], { [strong]: { felt: 3, openPlans: true, at: T0 } }));
    assert.deepEqual(ids(store.retrieve(scope, '那个', {}, T0 + 2 * DAY)), [match]);
    assert.ok(matterBonus(1) < MEMORY_NOTES_KNOBS.recall.person && matterBonus(1) < MEMORY_NOTES_KNOBS.recall.longTerm, 'smaller than a name or a longer word matching');
    assert.equal(matterBonus(5), K.maxBonus);
    assert.equal(matterBonus(-1), 0);
  });
});

test('what she just handed over steps back for a few of the user\'s lines; an explicit ask is not held back', async () => {
  await withStore(async store => {
    const a = await chat(store, 'a', '合成事件甲', T0), b = await chat(store, 'b', '合成事件乙', T0 + DAY);
    store.setRecallHints(hintsFor([a, b]));
    const now = T0 + 2 * DAY;
    assert.equal(ids(store.retrieve(scope, '第一句', { maxRecords: 1 }, now))[0], b, 'the newer of two equals');
    assert.equal(ids(store.retrieve(scope, '第一句', { maxRecords: 1 }, now))[0], b, 'the same message again is the same turn: not held back');
    assert.equal(ids(store.retrieve(scope, '第二句', { maxRecords: 1 }, now))[0], a, 'the next line: the other one goes first');
    assert.equal(ids(store.retrieve(scope, '第三句', { maxRecords: 1 }, now))[0], b, 'and back again');
    // no other choice: it is still given
    store.setRecallHints(hintsFor([b]));
    store.retrieve(scope, '第四句', { maxRecords: 1 }, now);
    assert.deepEqual(ids(store.retrieve(scope, '第五句', { maxRecords: 1 }, now)), [b]);
    // an explicit match is not demoted: it stays first although it was just shown
    const explicit: MemoryRecallHints = { prepare: () => id => (id === b ? { score: 5, explicit: true, terms: [], title: '' } : id === a ? { score: 5, explicit: false, terms: [], title: '' } : null) };
    store.setRecallHints(explicit);
    store.retrieve(scope, '先提一次', { maxRecords: 1 }, now);
    assert.equal(ids(store.retrieve(scope, '还记得吗', { maxRecords: 1 }, now))[0], b);
  });
});

test('RecallCooldown: a few turns, counted per distinct line', () => {
  const c = new RecallCooldown();
  c.begin('一'); c.shownNow(['x']);
  assert.equal(c.cooling('x'), false, 'same turn');
  for (let turn = 1; turn <= K.cooldownTurns; turn++) { c.begin(`第${turn}`); assert.equal(c.cooling('x'), true, `turn +${turn}`); }
  c.begin('很后面');
  assert.equal(c.cooling('x'), false, 'free again');
  c.begin('再来'); c.shownNow(['y']); c.forget(['y']); c.begin('下一句');
  assert.equal(c.cooling('y'), false);
  const small = new RecallCooldown(2); small.begin('a'); small.shownNow(['1', '2', '3']); small.begin('b');
  assert.equal(small.cooling('1'), false, 'bounded memory');
});

test('the feeling eases with age, slower when it was strong; plans and repetition combine without passing 1', () => {
  const at = T0;
  const m = (felt: 0 | 1 | 2 | 3 | null, days: number, extra: Partial<{ openPlans: boolean; weight: number }> = {}) =>
    recallMatter({ weight: extra.weight ?? DEFAULT_MEMORY_CONFIG.baseWeight, baseWeight: DEFAULT_MEMORY_CONFIG.baseWeight, traits: { felt, openPlans: extra.openPlans ?? false, at }, now: at + days * DAY });
  assert.ok(m(3, 0) > m(3, 60) && m(3, 60) > m(3, 400));
  assert.ok(m(3, 400) > 0);
  assert.ok(m(3, 0) > m(2, 0) && m(2, 0) > m(1, 0) && m(1, 0) > m(0, 0));
  assert.ok(m(3, 90) / m(3, 0) > m(1, 90) / m(1, 0), 'strong feelings fade more slowly');
  assert.equal(m(0, 0), 0);
  assert.equal(m(null, 5), 0);
  const all = m(3, 0, { openPlans: true, weight: DEFAULT_MEMORY_CONFIG.maxWeight });
  assert.ok(all <= 1 && all > m(1, 0) && m(1, 0, { openPlans: true }) > m(1, 0) && m(1, 0, { openPlans: true }) > m(0, 0, { openPlans: true }), 'reasons add up, never past 1');
  assert.equal(recallMatter({ weight: DEFAULT_MEMORY_CONFIG.baseWeight, baseWeight: DEFAULT_MEMORY_CONFIG.baseWeight, traits: null, now: T0 }), 0, 'no note, no reinforcement: nothing');
  assert.equal(recallMatter({ weight: Number.NaN, baseWeight: 20, traits: { felt: 3, openPlans: false, at: Number.NaN }, now: 1 }) >= 0, true, 'bad numbers are not trusted');
});

test('the new field is optional in the model\'s answer and in the saved file; the prompt asks for it', () => {
  const base = fakeNoteBody();
  assert.deepEqual(parseMemoryNote(JSON.stringify(base)), base, 'an answer without felt is a good note, as before');
  assert.equal(parseMemoryNote(JSON.stringify({ ...base, felt: 2 }))!.felt, 2);
  assert.equal(parseMemoryNote(JSON.stringify({ ...base, felt: 0 }))!.felt, 0);
  for (const bad of [7, -1, 1.5, '3', null, [3]]) assert.equal(parseMemoryNote(JSON.stringify({ ...base, felt: bad }))!.felt, undefined, `felt ${JSON.stringify(bad)} is read as unknown, not a failed note`);
  assert.equal(parseMemoryNote(JSON.stringify({ ...base, extra: 1 })), null, 'other unknown fields still fail');
  assert.match(MEMORY_NOTE_SYSTEM_PROMPT, /felt/u);
  const file = (body: object) => ({ version: 1, notes: [{ recordId: 'r1', source: 's', segmentAt: 1, writtenAt: 2, body }], deleted: [], parked: [], failed: [], calls: { day: '', count: 0 } });
  assert.equal(validateMemoryNotesFile(file(base))!.notes[0].body.felt, undefined, 'an old file loads');
  assert.equal(validateMemoryNotesFile(file({ ...base, felt: 3 }))!.notes[0].body.felt, 3, 'and the field survives a save and load');
  assert.equal(validateMemoryNotesFile(file({ ...base, felt: 9 }))!.notes[0].body.felt, undefined);
});
