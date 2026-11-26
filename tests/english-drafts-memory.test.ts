// 2026-11-21 (docs/claude/2026-11-21-warm-reuse-diverged.md 「后续」): an English character's own English replies are not "leaked drafts" in her
// memory either: her note (prompt and the written text), the moving-memory handoff (what can be quoted) and its prune. A Chinese character is
// judged as before (a long English line of hers is still a leak), and internal markers are dropped for every language.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { HerNoteStore } from '../electron/memory/her-note/store';
import { HerNoteWriter, type HerNoteAskInput } from '../electron/memory/her-note/writer';
import { MovingMemoryStore } from '../electron/memory/moving-memory/store';
import { MovingMemoryHandoff, judgeHandoffAnswer } from '../electron/memory/moving-memory/handoff';
import { createMovingMemory } from '../electron/memory/moving-memory/wiring';
import { userProfileScopeId, type UserProfileScope } from '../electron/memory/user-profile';
import type { Timed } from '../electron/brain/long-chat/history';

const scope: UserProfileScope = { characterId: 'one', providerScope: 'claude' };
const ticket = Object.freeze({ scopeId: userProfileScopeId(scope), scopeEpoch: 1, enableEpoch: 1 });
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'english-drafts-memory-'));
const REPLY = 'I was really glad you came back tonight and told me all about it.';
const NOTE = 'They come back late in the evening and tell me about the day, and I like hearing it all.';

const chat = (): Timed[] => [
  ...Array.from({ length: 11 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `line ${i}`, createdAt: at(10, 10, i) }) as Timed),
  { role: 'assistant', content: REPLY, createdAt: at(10, 10, 20) },
  { role: 'assistant', content: 'Fine. <sh-state-abc>x', createdAt: at(10, 10, 21) },
];

async function writeNote(english: boolean, answer: string) {
  const dir = tmp(), store = new HerNoteStore(dir), asks: HerNoteAskInput[] = [];
  const writer = new HerNoteWriter({
    enabled: () => true, profiles: { diaryTicket: () => ticket, diaryTicketValid: t => t === ticket }, store, scope: () => scope,
    messages: (_s, start, end) => chat().filter(m => m.createdAt >= start && m.createdAt < end),
    character: () => ({ persona: 'PERSONA', english }), model: () => 'sonnet',
    ask: async input => { asks.push(input); return answer; }, lastChatAt: () => null, now: () => at(11, 5),
  });
  writer.tick();
  while (writer.busy) await new Promise<void>(resolve => setImmediate(resolve));
  const text = store.current(scope)?.text ?? null;
  rmSync(dir, { recursive: true, force: true });
  return { asks, text };
}

test('her note: an English character\'s English replies reach the note prompt and her English note is kept; internal markers still dropped', async () => {
  const r = await writeNote(true, NOTE);
  assert.equal(r.asks.length, 1);
  assert.ok(r.asks[0]!.prompt.includes(REPLY), 'her reply is in the material');
  assert.ok(!r.asks[0]!.prompt.includes('sh-state'), 'the internal marker is not');
  assert.equal(r.text, NOTE, 'an English note with a long English run is not refused as a leak');
});

test('her note: a Chinese character is judged as before (a long English line of hers is a leak, so is such a note)', async () => {
  const r = await writeNote(false, NOTE);
  assert.ok(!r.asks[0]!.prompt.includes(REPLY));
  assert.equal(r.text, null, 'the old version stays: the text reads like a leaked English plan');
});

const ARCHIVE: Timed[] = [
  { role: 'user', content: 'I passed the interview today.', createdAt: at(3, 20) },
  { role: 'assistant', content: REPLY, createdAt: at(3, 21) },
];
const answer = (quote: string) => JSON.stringify({ date: '2026-11-03', quote });

test('moving memory judge: her English reply can be quoted for an English character only', () => {
  assert.equal(judgeHandoffAnswer(answer(REPLY), ARCHIVE, at(9, 9), undefined, 'en').type, 'swap');
  assert.deepEqual(judgeHandoffAnswer(answer(REPLY), ARCHIVE, at(9, 9)), { type: 'invalid', why: 'not-found' }, 'Chinese: unchanged');
  assert.deepEqual(judgeHandoffAnswer(answer('Fine. <sh-state-abc>x'), [{ role: 'assistant', content: 'Fine. <sh-state-abc>x', createdAt: at(3, 21) }], at(9, 9), undefined, 'en'), { type: 'invalid', why: 'not-found' }, 'markers: every language');
});

async function handoffPass(english: boolean) {
  const dir = tmp(), store = new MovingMemoryStore(dir), queue: (() => void)[] = [], prompts: string[] = [];
  const handoff = new MovingMemoryHandoff({ enabled: () => true, profiles: { diaryTicket: () => ticket, diaryTicketValid: t => t === ticket }, store, scope: () => scope,
    messages: () => ARCHIVE, character: () => ({ persona: '', english }), model: () => 'sonnet', ask: async input => { prompts.push(input.prompt); return answer(REPLY); },
    timers: { set: callback => { queue.push(callback); return queue.length; }, clear: () => {} }, now: () => at(9, 9) });
  handoff.noteNewProcess(); queue.splice(0).forEach(callback => callback()); await handoff.whenIdle();
  const kept = store.current(scope)?.text ?? null, offered = prompts.some(p => p.includes(REPLY));
  rmSync(dir, { recursive: true, force: true });
  return { kept, offered };
}

test('moving memory handoff: the English character keeps her own reply as the moment, a Chinese character does not', async () => {
  const en = await handoffPass(true);
  assert.equal(en.kept, REPLY); assert.equal(en.offered, true, "her English reply is in the material offered to her");
  const zh = await handoffPass(false);
  assert.equal(zh.kept, null); assert.equal(zh.offered, false);
});

async function pruneKeeps(english: boolean) {
  const dir = tmp();
  const memory = createMovingMemory(dir, { enabled: () => true, profiles: { diaryTicket: () => ticket, diaryTicketValid: () => true }, scope: () => scope,
    messages: () => ARCHIVE, character: () => ({ persona: '', english }), model: () => 'sonnet', ask: async () => '{"keep":true}', now: () => at(9, 9) });
  await memory.store.add(scope, { date: '2026-11-03', text: REPLY, quoteRef: { at: at(3, 21), role: 'assistant' }, chosenAt: at(3, 23) });
  await memory.prune(scope);
  const kept = memory.store.current(scope)?.text === REPLY;
  rmSync(dir, { recursive: true, force: true });
  return kept;
}

test('moving memory prune: a version quoting her English reply survives for an English character, goes for a Chinese one (as before)', async () => {
  assert.equal(await pruneKeeps(true), true);
  assert.equal(await pruneKeeps(false), false);
});
