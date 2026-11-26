// Codex X-495 (R03, from C-270): five recall contracts written as drafts against eae4020d, made runnable here.
// They pin what "moves back, not out" means: a repeated identical line is the same turn; the next different line puts the
// other equal candidate first; the only candidate is still given (both results non-empty); two explicit matches are not
// demoted; the cooldown is three logical turns and a repeated begin does not count. Synthetic texts only; a fresh temp
// folder per contract; no real profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../electron/memory/memory';
import { memoryRecallMatch, type MemoryRecall, type MemoryScope } from '../shared/memory/memory';
import type { MemoryRecallHints } from '../shared/memory/memory-notes/interface';
import { MEMORY_NOTES_KNOBS } from '../shared/memory/memory-notes/knobs';
import { RecallCooldown } from '../shared/memory/memory-notes/matter';

const T = 1_900_000_000_000;
const scope: MemoryScope = { characterId: 'R03-fictional', providerScope: 'r03-no-provider' };
const USER = '紫铜纸鲸是本例虚构的折纸书签。';
const REPLY = '合成回应：把折纸书签夹在蓝色封面里。';
const q0 = 'r03queryalpha', q1 = 'r03querybeta';
const options = { maxRecords: 1, maxChars: 3000 };

async function withStore(run: (store: MemoryStore) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-x495-recall-'));
  try { const store = new MemoryStore(directory); await store.load(); await run(store); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function record(store: MemoryStore, id: string, at: number): Promise<string> {
  const handle = await store.beginTurn(scope, { id, userText: USER, at, conversationId: `c-${id}` });
  await store.appendAssistant(scope, id, REPLY, at + 100);
  await store.finishTurn(scope, id, 'complete', at + 200);
  return handle.recordId;
}
function hints(ids: ReadonlySet<string>, explicit: boolean): MemoryRecallHints {
  return { prepare: () => id => (ids.has(id) ? { score: 5, explicit, terms: ['紫铜纸鲸'], title: '合成书签' } : null), traits: () => null };
}
/** The fixture's premises: the expected records, and neither query matches them literally (so only the hints decide). */
function premises(store: MemoryStore, expected: readonly string[]): void {
  const page = store.list(scope, { limit: 50 }, T);
  assert.equal(page.total, expected.length, 'fixture: record count');
  assert.deepEqual(new Set(page.records.map(row => row.id)), new Set(expected), 'fixture: record identities');
  for (const summary of page.records) for (const q of [q0, q1]) assert.deepEqual(memoryRecallMatch(q, summary), { score: 0, explicit: false }, `fixture: ${q} is not a literal match`);
}
/** Exactly one non-empty recall with this id (two empty results can never pass). */
function expectOne(rows: MemoryRecall[], expectedId: string, label: string): void {
  assert.equal(rows.length, 1, `${label}: one row`);
  assert.equal(typeof rows[0].id, 'string');
  assert.ok(rows[0].id.length > 0);
  assert.equal(rows[0].id, expectedId, label);
  assert.equal(typeof rows[0].excerpt, 'string');
  assert.ok(rows[0].excerpt.trim().length > 0, `${label}: an excerpt`);
}
async function pair(store: MemoryStore, explicit: boolean): Promise<{ older: string; newer: string }> {
  const older = await record(store, 'older', T - 30_000), newer = await record(store, 'newer', T - 20_000);
  store.setRecallHints(hints(new Set([older, newer]), explicit));
  premises(store, [older, newer]);
  return { older, newer };
}

test('MC01: the same raw line twice is one turn: the newer of two equals both times', async () => {
  await withStore(async store => {
    const { newer } = await pair(store, false);
    expectOne(store.retrieve(scope, q0, options, T), newer, 'first');
    expectOne(store.retrieve(scope, q0, options, T), newer, 'repeated');
  });
});

test('MC02: the same candidates, not explicit, equal: the next different line puts the other one first', async () => {
  await withStore(async store => {
    const { older, newer } = await pair(store, false);
    const first = store.retrieve(scope, q0, options, T), next = store.retrieve(scope, q1, options, T);
    expectOne(first, newer, 'first');
    expectOne(next, older, 'next');
    assert.notEqual(first[0].id, next[0].id);
  });
});

test('MC03: the only candidate is still given on the next line: both results non-empty, the same id', async () => {
  await withStore(async store => {
    const only = await record(store, 'only', T - 30_000);
    store.setRecallHints(hints(new Set([only]), false));
    premises(store, [only]);
    const first = store.retrieve(scope, q0, options, T), next = store.retrieve(scope, q1, options, T);
    expectOne(first, only, 'first');
    expectOne(next, only, 'next');
    assert.equal(first[0].id, next[0].id);
  });
});

test('MC04: both candidates explicit: neither is demoted, the newer stays first', async () => {
  await withStore(async store => {
    const { newer } = await pair(store, true);
    expectOne(store.retrieve(scope, q0, options, T), newer, 'first');
    expectOne(store.retrieve(scope, q1, options, T), newer, 'next');
  });
});

test('MC05: the cooldown is three logical turns; a repeated begin of the same line does not count', () => {
  assert.equal(MEMORY_NOTES_KNOBS.matter.cooldownTurns, 3);
  assert.equal(MEMORY_NOTES_KNOBS.matter.cooldownPenalty, 4);
  const cooldown = new RecallCooldown();
  cooldown.begin('message-0');
  cooldown.shownNow(['r03-only']);
  cooldown.begin('message-0');
  assert.equal(cooldown.cooling('r03-only'), false, 'the same turn');
  cooldown.begin('message-1');
  assert.equal(cooldown.cooling('r03-only'), true, '+1');
  cooldown.begin('message-1');
  assert.equal(cooldown.cooling('r03-only'), true, '+1 again, not +2');
  cooldown.begin('message-2');
  assert.equal(cooldown.cooling('r03-only'), true, '+2');
  cooldown.begin('message-3');
  assert.equal(cooldown.cooling('r03-only'), true, '+3');
  cooldown.begin('message-4');
  assert.equal(cooldown.cooling('r03-only'), false, '+4: free again');
});
