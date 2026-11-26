import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { HerNoteStore } from '../electron/memory/her-note/store';
import { HerNoteWriter, HER_NOTE_MAX_CALLS_PER_DAY, type HerNoteAskInput, type HerNoteEvent } from '../electron/memory/her-note/writer';
import { FIRST_NOTE_INSTRUCTION, REWRITE_NOTE_INSTRUCTION } from '../electron/memory/her-note/prompt';
import { userProfileScopeId, type UserProfileScope } from '../electron/memory/user-profile';
import type { Timed } from '../electron/brain/long-chat/history';

const scope: UserProfileScope = { characterId: 'akiko', providerScope: 'claude' };
const ticket = Object.freeze({ scopeId: userProfileScopeId(scope), scopeEpoch: 1, enableEpoch: 1 });
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'her-note-'));
// Waits for the writer to finish its call (observable state), not for a guessed number of milliseconds.
const settle = async (writer: { readonly busy: boolean }) => { while (writer.busy) await new Promise<void>(resolve => setImmediate(resolve)); };

/** 12 plain messages on day 10 between 10:00 and 11:00. */
function chat(day: number, count = 12, hour = 10): Timed[] {
  return Array.from({ length: count }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `line ${day}-${i}`, createdAt: at(day, hour, i) }) as Timed);
}

function rig(options: { messages?: Timed[]; consent?: boolean; enabled?: boolean; lastChatAt?: number | null; answers?: (string | Error)[]; now: { value: number } }) {
  const dir = tmp();
  const store = new HerNoteStore(dir);
  const state = { consent: options.consent ?? true, enabled: options.enabled ?? true, messages: options.messages ?? chat(10), lastChatAt: options.lastChatAt ?? null as number | null };
  const asks: HerNoteAskInput[] = [];
  const events: HerNoteEvent[] = [];
  const answers = options.answers ?? [];
  const writer = new HerNoteWriter({
    enabled: () => state.enabled,
    profiles: { diaryTicket: () => state.consent ? ticket : null, diaryTicketValid: t => state.consent && t === ticket },
    store,
    scope: () => scope,
    messages: (_scope, start, end) => state.messages.filter(m => m.createdAt >= start && m.createdAt < end),
    character: () => ({ persona: 'PERSONA-TEXT' }),
    model: () => 'sonnet',
    ask: async input => { asks.push(input); const next = answers.shift() ?? '我的笔记：你累了会说"没事"。'; if (next instanceof Error) throw next; return next; },
    lastChatAt: () => state.lastChatAt,
    now: () => options.now.value,
    report: event => events.push(event),
  });
  return { dir, store, state, asks, events, writer, tickAndWait: async () => { writer.tick(); await settle(writer); } };
}

test('consent off or switch off: nothing is asked or written', async () => {
  const now = { value: at(11, 5) };
  const off = rig({ consent: false, now });
  await off.tickAndWait();
  assert.equal(off.asks.length, 0);
  const switchOff = rig({ enabled: false, now });
  await switchOff.tickAndWait();
  assert.equal(switchOff.asks.length, 0);
  assert.equal(switchOff.store.current(scope), null);
  assert.deepEqual(readdirSync(switchOff.dir), []);
});

test('first note: all messages, markers, no leaked drafts, persona as voice reference; written once per local day from 04:00', async () => {
  const now = { value: at(11, 3, 30) }; // before 04:00: still day 10
  const messages = [...chat(10), { role: 'assistant' as const, content: 'The user wants a short reply, so I will respond briefly in a warm tone.', createdAt: at(10, 11, 30) }, { role: 'user' as const, content: 'late', createdAt: at(10, 21, 0) }];
  const r = rig({ messages, now });
  await r.tickAndWait();
  assert.equal(r.asks.length, 1);
  const ask = r.asks[0]!;
  assert.equal(ask.system, FIRST_NOTE_INSTRUCTION);
  assert.match(ask.prompt, /PERSONA-TEXT/);
  assert.ok(!ask.prompt.includes('The user wants a short reply'), 'leaked draft left out');
  assert.match(ask.prompt, /【11月10日 21:00】late/, 'a time marker after a long gap');
  assert.equal(r.store.current(scope)?.cutoffAt, at(10, 21, 0));
  assert.deepEqual(r.events.map(e => e.type), ['call', 'written']);
  // Same day, later: nothing more.
  now.value = at(11, 3, 59);
  await r.tickAndWait();
  assert.equal(r.asks.length, 1);
  // 04:00 starts the next day, but there are no new messages: skipped without a call.
  now.value = at(11, 4, 0);
  await r.tickAndWait();
  assert.equal(r.asks.length, 1);
  assert.deepEqual(r.events.at(-1), { type: 'skipped', why: 'few-messages' });
});

test('waits while the user is chatting, then writes', async () => {
  const now = { value: at(11, 9) };
  const r = rig({ now, lastChatAt: at(11, 8, 55) });
  await r.tickAndWait();
  assert.equal(r.asks.length, 0);
  now.value = at(11, 9, 6);
  await r.tickAndWait();
  assert.equal(r.asks.length, 1);
});

test('rewrite: previous note plus only newer messages; fewer than ten new messages skip the day', async () => {
  const now = { value: at(11, 5) };
  const r = rig({ now });
  await r.tickAndWait();
  assert.equal(r.store.versions(scope).length, 1);
  // Day 11 brings 4 messages only.
  r.state.messages = [...chat(10), ...chat(11, 4, 12)];
  now.value = at(12, 5);
  await r.tickAndWait();
  assert.equal(r.asks.length, 1, 'too few new messages');
  // Day 12 piles up more.
  r.state.messages = [...chat(10), ...chat(11, 4, 12), ...chat(12, 8, 12)];
  now.value = at(13, 5);
  await r.tickAndWait();
  assert.equal(r.asks.length, 2);
  const ask = r.asks[1]!;
  assert.equal(ask.system, REWRITE_NOTE_INSTRUCTION);
  assert.match(ask.prompt, /我的笔记：你累了会说/, 'previous note present');
  assert.ok(!ask.prompt.includes('line 10-'), 'old messages are not sent again');
  assert.match(ask.prompt, /line 11-0/);
  assert.match(ask.prompt, /【11月11日 12:00】/, 'marker decided on the whole sequence');
  assert.equal(r.store.versions(scope).length, 2);
});

test('bad output keeps the old version and retries after 30 minutes; at most two calls a day', async () => {
  const now = { value: at(11, 5) };
  const r = rig({ now, answers: ['这是一页。', 'x'.repeat(3001), '   ', 'I think the user is tired and I should plan my answer carefully now ok'] });
  await r.tickAndWait();
  assert.equal(r.store.current(scope)?.text, '这是一页。');
  r.state.messages = [...chat(10), ...chat(11, 12, 12)];
  now.value = at(12, 5);
  await r.tickAndWait(); // too long
  assert.equal(r.store.current(scope)?.text, '这是一页。');
  assert.equal(r.events.at(-1)?.type, 'invalid');
  now.value = at(12, 5, 29);
  await r.tickAndWait();
  assert.equal(r.asks.length, 2, 'not before the retry delay');
  now.value = at(12, 5, 31);
  await r.tickAndWait(); // empty
  assert.equal(r.asks.length, 3);
  assert.equal(r.store.versions(scope).length, 1);
  now.value = at(12, 7);
  await r.tickAndWait();
  assert.equal(r.asks.length, 3, `capped at ${HER_NOTE_MAX_CALLS_PER_DAY} calls a day`);
  now.value = at(13, 5); // next day: tried again (leaked-looking answer is refused too)
  await r.tickAndWait();
  assert.equal(r.asks.length, 4);
  assert.equal(r.store.versions(scope).length, 1);
});

test('failure retries after 30 minutes and then writes', async () => {
  const now = { value: at(11, 5) };
  const r = rig({ now, answers: [new Error('offline'), '好了。'] });
  await r.tickAndWait();
  assert.equal(r.store.current(scope), null);
  assert.equal(r.events.at(-1)?.type, 'failed');
  now.value = at(11, 5, 10);
  await r.tickAndWait();
  assert.equal(r.asks.length, 1);
  now.value = at(11, 5, 31);
  await r.tickAndWait();
  assert.equal(r.store.current(scope)?.text, '好了。');
});

test('consent turned off during the call: the late answer is not written', async () => {
  const now = { value: at(11, 5) };
  const r = rig({ now });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = (r.writer as unknown as { options: { ask: unknown } }).options;
  original.ask = async () => { await gate; return '晚到的一页'; };
  r.writer.tick();
  r.state.consent = false;
  release();
  await settle(r.writer);
  assert.equal(r.store.current(scope), null);
});

test('a slow call (150 ms of real time) is waited for by the writer state, so a busy machine cannot beat the test', async () => {
  const r = rig({ now: { value: at(11, 5) } });
  (r.writer as unknown as { options: { ask: unknown } }).options.ask = async () => { await new Promise(resolve => setTimeout(resolve, 150)); return '慢慢写的一页'; };
  await r.tickAndWait();
  assert.equal(r.store.current(scope)?.text, '慢慢写的一页');
});

test('store: versions capped at 5, newest first, rollback, clear, reload', async () => {
  const dir = tmp();
  const store = new HerNoteStore(dir);
  for (let i = 1; i <= 7; i++) assert.equal(await store.add(scope, { text: `v${i}`, writtenAt: i, cutoffAt: i * 10 }), true);
  assert.deepEqual(store.versions(scope).map(v => v.text), ['v7', 'v6', 'v5', 'v4', 'v3']);
  assert.equal(new HerNoteStore(dir).current(scope)?.text, 'v7', 'persisted');
  assert.equal(await store.rollback(scope, 2), true);
  assert.equal(store.current(scope)?.text, 'v5');
  assert.equal(store.current(scope)?.cutoffAt, 50);
  assert.equal(await store.rollback(scope, 9), false);
  assert.equal(new HerNoteStore(dir).versions(scope).length, 3);
  await store.clear(scope);
  assert.equal(store.current(scope), null);
  assert.deepEqual(readdirSync(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test('store: an unreadable file is left alone and is not a note', async () => {
  const dir = tmp();
  const store = new HerNoteStore(dir);
  const file = store.file(scope);
  writeFileSync(file, '{broken');
  assert.equal(store.current(scope), null);
  assert.equal(await store.add(scope, { text: 'x', writtenAt: 1, cutoffAt: 1 }), false);
  assert.equal(readFileSync(file, 'utf8'), '{broken');
  await store.clear(scope);
  assert.equal(await store.add(scope, { text: 'x', writtenAt: 1, cutoffAt: 1 }), true);
});

test('the report never carries text', async () => {
  const now = { value: at(11, 5) };
  const r = rig({ now, answers: ['SECRET-NOTE-TEXT'] });
  await r.tickAndWait();
  const lines = JSON.stringify(r.events);
  assert.ok(!lines.includes('SECRET') && !lines.includes('line 10'));
});
