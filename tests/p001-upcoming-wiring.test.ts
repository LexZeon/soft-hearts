/**
 * P-001 step 1, end to end on made-up conversations (fake clock, fake haiku, temporary folders; no real Claude, no real profile):
 * the real chat archive, notebook, profile file and plan memory together. Wednesday 23:50 "明天下午面试" ends up as Thursday 18:00 in
 * the character's profile file; the "may record" mark follows the switch for the whole segment; turning the switch off by hand deletes
 * every list and every mark; deleting a memory or its note takes the plan with it; the journal only gets closed events and counts.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryStore } from '../electron/memory/memory';
import { MemoryNotes } from '../electron/memory/memory-notes/host';
import { ProfileUpcomingBook } from '../electron/memory/upcoming/book';
import { UpcomingHost } from '../electron/memory/upcoming/host';
import { UPCOMING_MARKS_FILE, UpcomingMarks } from '../electron/memory/upcoming/marks';
import { UpcomingStore } from '../electron/memory/upcoming/store';
import { UserProfileStore, userProfileScopeId, type UserProfileScope } from '../electron/memory/user-profile';
import { UserProfileManagement } from '../electron/memory/user-profile-management';
import { buildJournalEntry, journalReason } from '../shared/memory/journal';
import type { MemoryScope } from '../shared/memory/memory';
import { MEMORY_NOTES_KNOBS } from '../shared/memory/memory-notes/knobs';
import { FakeNoteWriter, fakeNoteBody } from '../shared/memory/memory-notes/fake';

const HOUR = 3_600_000, DAY = 24 * HOUR;
/** Wednesday 2026-11-11 23:50 local time. */
const WED = new Date(2026, 10, 11, 23, 50).getTime();
const scopeA: MemoryScope = { characterId: 'char-a', providerScope: 'p' };
const scopeB: MemoryScope = { characterId: 'char-b', providerScope: 'p' };
const dirNames = async (dir: string): Promise<string[]> => readdir(dir).catch(() => []);
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

const INTERVIEW = { user: '我明天下午有个面试，好紧张', her: '别紧张，我陪着你。' };
const FRIEND = { user: '我朋友明天下午有个面试，我有点替他紧张', her: '你真好，会一直替朋友着想。' };
const answer = (upcoming: unknown) => JSON.stringify({ ...fakeNoteBody({ title: '一段聊天', things: [], plans: [], tags: ['聊天', '面试', '心情'] }), keywords: [], upcoming });

async function withRig(run: (rig: Rig) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sh-p001-wire-'));
  try {
    const rig = await makeRig(dir);
    try { await run(rig); } finally { await rig.close(); }
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}

async function makeRig(dir: string) {
  const clock = { t: WED };
  const profileDir = path.join(dir, 'user-profiles');
  const shown = { scope: scopeA };
  const upcomingStore = new UpcomingStore(profileDir, { now: () => clock.t, recording: (): boolean => management.get()?.enabled === true });
  const profiles = new UserProfileStore(profileDir, { now: () => clock.t, upcoming: upcomingStore });
  const management: UserProfileManagement = new UserProfileManagement(profiles, () => {}, () => ({ characterId: shown.scope.characterId, providerScope: shown.scope.providerScope }),
    (_scope, reason) => { if (reason === 'recording-off') void host.recordingOff(); });
  await management.activate(shown.scope);
  const memory = new MemoryStore(dir);
  await memory.load();
  const journal: [string, number][] = [];
  const changes = { count: 0 };
  const recording = () => management.get()?.enabled === true;
  const book = new ProfileUpcomingBook(upcomingStore, () => management.get()?.scopeId ?? null, () => clock.t, (() => { let n = 0; return () => `item-${++n}`; })());
  const host: UpcomingHost = new UpcomingHost({ directory: profileDir, book,
    recording, scopeOf: key => { const owner = memory.ownerOfScope(key); return owner ? userProfileScopeId(owner) : null; }, changed: () => { changes.count++; }, journal: (event, count) => { journal.push([event, count]); }, now: () => clock.t });
  await host.start();
  memory.onTurnBegun(info => host.turnBegun(info));
  const writer = new FakeNoteWriter(answer([])).when('面试', answer([{ what: '去面试', when: '明天下午' }]));
  const notes = new MemoryNotes({ directory: dir, archive: memory, write: writer.write, userBusy: () => false, modelBusy: () => false, lastActivityAt: () => null,
    scope: () => shown.scope, now: () => clock.t, tickMs: 3_600_000, upcoming: host.hooks() });
  await notes.start();
  clock.t += MEMORY_NOTES_KNOBS.pace.startDelaySeconds * 1000;

  let turn = 0;
  const chat = async (scope: MemoryScope, user: string, her: string, { conversation = `c-${++turn}`, seal = true, at = clock.t }: { conversation?: string; seal?: boolean; at?: number } = {}) => {
    const id = `t-${++turn}`;
    const handle = await memory.beginTurn(scope, { id, userText: user, at, conversationId: conversation });
    await memory.appendAssistant(scope, id, her, at + 1_000);
    await memory.finishTurn(scope, id, 'complete', at + 2_000);
    if (seal) await memory.seal(scope);
    return handle.recordId;
  };
  const tick = async (rounds = 3) => {
    for (let i = 0; i < rounds; i++) { clock.t += MEMORY_NOTES_KNOBS.pace.spacingSeconds * 1000; notes.core.tick(); await settle(); }
    await notes.core.flush(); await profiles.settled(); await upcomingStore.settled(); await host.marks.flush();
  };
  const turnOn = async (on: boolean) => {
    const view = management.get()!;
    await management.setEnabled({ scopeId: view.scopeId, generation: view.generation, revision: view.revision, enabled: on });
    await profiles.settled(); await upcomingStore.settled(); await host.marks.flush();
  };
  const profileText = async (scope: UserProfileScope = shown.scope) => readFile(path.join(profileDir, `profile-${userProfileScopeId(scope)}.json`), 'utf8');
  const upcomingText = async (scope: UserProfileScope = shown.scope) => readFile(path.join(profileDir, `upcoming-${userProfileScopeId(scope)}.json`), 'utf8');
  const everything = async () => {
    let text = '';
    for (const name of await readdir(profileDir)) text += `\n#${name}\n` + await readFile(path.join(profileDir, name), 'utf8');
    return text;
  };
  const close = async () => { await notes.dispose(); await host.dispose(); management.dispose(); };
  return { dir, profileDir, clock, shown, profiles, upcomingStore, book, upcomingText, management, memory, host, notes, writer, journal, changes, chat, tick, turnOn, profileText, everything, close };
}
type Rig = Awaited<ReturnType<typeof makeRig>>;
const list = (rig: Rig) => rig.book.list();

test('Wednesday 23:50 "明天下午有个面试" becomes a plan due Thursday 18:00, kept as a short form and the time words only', () => withRig(async rig => {
  await rig.turnOn(true);
  const record = await rig.chat(scopeA, INTERVIEW.user, INTERVIEW.her);
  assert.equal(rig.host.marks.has(record), true, 'the whole segment was recorded');
  await rig.tick();
  const [item] = list(rig);
  assert.ok(item);
  assert.equal(item.what, '去面试');
  assert.equal(item.said, '明天下午');
  assert.equal(item.state, 'waiting');
  const due = new Date(item.dueAt);
  assert.deepEqual([due.getMonth() + 1, due.getDate(), due.getHours(), due.getMinutes()], [11, 12, 18, 0]);
  const text = await rig.upcomingText();
  assert.ok(!text.includes('好紧张') && !text.includes('我陪着你'), 'not a word of the conversation is in the list file');
  assert.equal(JSON.parse(text).upcoming.items.length, 1);
  assert.ok(!(await rig.profileText()).includes('upcoming'), 'the profile file itself is exactly what it was before this feature');
  assert.deepEqual(rig.journal, [['recorded', 1]]);
  assert.ok(rig.changes.count > 0, 'the panel is told');
  assert.equal(rig.management.get()?.upcoming?.[0].what, '去面试', 'and it is in what the panel gets');
}));

test('with the switch off nothing is marked, the note prompt has no extra question, no list is written and the file has no such key', () => withRig(async rig => {
  const before = await rig.profileText().catch(() => null);
  const record = await rig.chat(scopeA, INTERVIEW.user, INTERVIEW.her);
  assert.equal(rig.host.marks.has(record), false);
  await rig.tick();
  assert.equal(rig.writer.calls.length, 1, 'the note is still written (the notebook is not the switch\'s business)');
  assert.ok(!rig.writer.calls[0].systemPrompt.includes('upcoming'));
  assert.deepEqual(list(rig), []);
  const after = await rig.profileText().catch(() => null);
  assert.equal(after, before, 'the profile file is not even touched');
  assert.ok(!(await dirNames(rig.profileDir)).some(name => /^upcoming-[0-9a-f]{64}.json$/u.test(name)), 'no list file');
  await assert.rejects(stat(path.join(rig.profileDir, UPCOMING_MARKS_FILE)), 'no marks file');
  assert.deepEqual(rig.journal, []);
}));

test('a segment is marked only if the switch was on for all of it', () => withRig(async rig => {
  // first message on, a later message off: the mark goes
  await rig.turnOn(true);
  const first = await rig.chat(scopeA, INTERVIEW.user, INTERVIEW.her, { conversation: 'one', seal: false });
  assert.equal(rig.host.marks.has(first), true);
  rig.host.turnBegun({ recordId: first, first: false }); // a later message with the switch still on: stays marked
  assert.equal(rig.host.marks.has(first), true);
  // a later message arrives while the host sees the switch off (no ready profile, say): the mark goes
  rig.shown.scope = scopeB; // the profile shown is not ready for a moment: recording() is false
  const off = new UpcomingHost({ directory: rig.profileDir, book: rig.book, recording: () => false, scopeOf: () => null }, rig.host.marks);
  off.turnBegun({ recordId: first, first: false });
  assert.equal(rig.host.marks.has(first), false, 'a message came in while recording was off');
  // the first message came while off, the switch is on for the rest: never marked
  rig.shown.scope = scopeA;
  const unmarked = 'segment-started-while-off';
  off.turnBegun({ recordId: unmarked, first: true });
  rig.host.turnBegun({ recordId: unmarked, first: false });
  assert.equal(rig.host.marks.has(unmarked), false);
  await rig.host.marks.flush();
}));

test('turning the switch off by hand deletes every character\'s list and every mark at once', () => withRig(async rig => {
  await rig.turnOn(true);
  const record = await rig.chat(scopeA, INTERVIEW.user, INTERVIEW.her);
  await rig.tick();
  assert.equal(list(rig).length, 1);
  // another character has a list in her own profile file too
  rig.shown.scope = scopeB;
  await rig.management.activate(scopeB);
  assert.equal(await rig.host.testAdd(), 'ok');
  await rig.profiles.settled();
  assert.ok((await rig.upcomingText(scopeB)).includes('"upcoming"'));
  rig.shown.scope = scopeA;
  await rig.management.activate(scopeA);
  assert.equal(rig.host.marks.has(record), true);
  assert.ok((await dirNames(rig.profileDir)).filter(name => /^upcoming-[0-9a-f]{64}.json$/u.test(name)).length === 2, 'one list file each');
  await stat(path.join(rig.profileDir, UPCOMING_MARKS_FILE));

  await rig.turnOn(false);
  const rest = await rig.everything();
  assert.ok(!rest.includes('upcoming'), 'no list file, no block mark, no marks file');
  assert.ok((await dirNames(rig.profileDir)).filter(name => name.startsWith('profile-')).length >= 1, 'the profiles themselves are untouched');
  assert.ok(!rest.includes('去面试') && !rest.includes('明天下午'));
  await assert.rejects(stat(path.join(rig.profileDir, UPCOMING_MARKS_FILE)), 'the marks file is deleted, not emptied');
  assert.equal(rig.host.marks.has(record), false);
  assert.deepEqual(list(rig), []);
  assert.deepEqual(rig.management.get()?.upcoming, []);
  // turn it on again: it starts from nothing, and an empty list is not written
  await rig.turnOn(true);
  assert.deepEqual(list(rig), []);
  assert.ok(!(await dirNames(rig.profileDir)).some(name => /^upcoming-[0-9a-f]{64}.json$/u.test(name)), 'an empty list is not written');
  await rig.tick();
  assert.deepEqual(list(rig), [], 'the old segment is not marked any more, so its (re)written note adds nothing');
}));

test('someone else\'s plan, a supposition and a joke are not recorded even in a marked segment', () => withRig(async rig => {
  await rig.turnOn(true);
  await rig.chat(scopeA, FRIEND.user, FRIEND.her);
  await rig.chat(scopeA, '假如明天下午有个面试，我该怎么准备呢，随便想想', '先想想你最擅长什么吧。');
  await rig.chat(scopeA, '我明天下午要去面试当总统，开玩笑的啦', '哈哈，那我给你投票。');
  await rig.tick(6);
  assert.equal(rig.writer.calls.length, 3, 'all three were noted (and the haiku said yes to each)');
  assert.deepEqual(list(rig), []);
  assert.deepEqual(rig.journal, []);
}));

test('a sensitive plan (health, ids, secrets) is not recorded; an unresolvable time word is not recorded', () => withRig(async rig => {
  rig.writer.when('诊断', answer([{ what: '拿结果', when: '明天' }])).when('旅游', answer([{ what: '去旅游', when: '过阵子' }]));
  await rig.turnOn(true);
  await rig.chat(scopeA, '我明天要去医院拿诊断结果，有点怕', '我陪你。');
  await rig.chat(scopeA, '我过阵子想去旅游，还没想好去哪里', '好呀，慢慢想。');
  await rig.tick(6);
  assert.deepEqual(list(rig), []);
}));

test('a plan goes to the character the chat segment belonged to, even when another character is shown by the time the note is written', () => withRig(async rig => {
  await rig.turnOn(true);
  await rig.chat(scopeA, INTERVIEW.user, INTERVIEW.her);
  rig.shown.scope = scopeB; // the shown character changed before the note was written
  await rig.management.activate(scopeB);
  await rig.tick();
  assert.equal(rig.writer.calls.length, 1);
  assert.deepEqual(list(rig), [], 'not in the shown character\'s list');
  assert.equal(JSON.parse(await rig.upcomingText(scopeA)).upcoming.items[0].what, '去面试', 'but in hers');
  rig.shown.scope = scopeA;
  await rig.management.activate(scopeA);
  assert.equal(list(rig).length, 1, 'and it is there when she is shown again');
}));

test('deleting a chat memory takes its plan and its mark; deleting just the note does the same', () => withRig(async rig => {
  await rig.turnOn(true);
  const one = await rig.chat(scopeA, INTERVIEW.user, INTERVIEW.her);
  await rig.tick();
  assert.equal(list(rig).length, 1);
  assert.equal(await rig.memory.delete(scopeA, one), true);
  await rig.tick(1);
  assert.deepEqual(list(rig), []);
  assert.equal(rig.host.marks.has(one), false);
  await assert.rejects(stat(path.join(rig.profileDir, `upcoming-${userProfileScopeId(scopeA)}.json`)), 'nothing left: the file is gone');

  rig.writer.when('看牙', answer([{ what: '去看牙', when: '周五下午' }]));
  const two = await rig.chat(scopeA, '我周五下午要去看牙，有点怕疼', '加油。');
  await rig.tick();
  assert.equal(list(rig).length, 1);
  await rig.notes.deleteNote(two);
  await rig.upcomingStore.settled();
  assert.deepEqual(list(rig), []);
  assert.equal(rig.host.marks.has(two), false);
}));

test('a plan the user deleted is not added again by the same segment\'s rewritten note; clear-all blocks the segments too', () => withRig(async rig => {
  await rig.turnOn(true);
  const record = await rig.chat(scopeA, INTERVIEW.user, INTERVIEW.her, { conversation: 'long', seal: false });
  rig.clock.t += 20 * 60_000; // quiet long enough: the segment counts as finished
  await rig.tick();
  assert.equal(list(rig).length, 1);
  const view = rig.management.get()!;
  const id = view.upcoming![0].id;
  const after = await rig.management.deleteUpcoming({ scopeId: view.scopeId, generation: view.generation, revision: view.revision, id });
  assert.deepEqual(after.upcoming, []);
  assert.equal(after.revision, view.revision, 'the profile itself did not change');
  // the same segment's note is written again (its text grew) and says the same plan once more
  rig.host.hooks().noted({ recordId: record, scope: rig.memory.noteScope(scopeA), at: WED, raw: answer([{ what: '去面试', when: '明天下午' }]),
    messages: [{ role: 'user', content: INTERVIEW.user }, { role: 'assistant', content: INTERVIEW.her }] });
  await settle(); await rig.upcomingStore.settled();
  assert.deepEqual(list(rig), [], 'but the deleted plan did not come back');
  assert.equal(rig.host.marks.has(record), true);
  assert.deepEqual(JSON.parse(await rig.upcomingText()).upcoming.blockedFrom, [record]);

  // clear all
  rig.writer.when('聚餐', answer([{ what: '去聚餐', when: '周五晚上' }]));
  const other = await rig.chat(scopeA, '周五晚上还要去聚餐', '好的。');
  await rig.tick();
  assert.equal(list(rig).length, 1);
  const v2 = rig.management.get()!;
  const cleared = await rig.management.clearUpcoming({ scopeId: v2.scopeId, generation: v2.generation, revision: v2.revision });
  assert.deepEqual(cleared.upcoming, []);
  assert.ok(JSON.parse(await rig.upcomingText()).upcoming.blockedFrom.includes(other));
}));

test('a stale or wrong request cannot delete: the panel must pass the view it saw', () => withRig(async rig => {
  await rig.turnOn(true);
  await rig.chat(scopeA, INTERVIEW.user, INTERVIEW.her);
  await rig.tick();
  const view = rig.management.get()!;
  await assert.rejects(rig.management.deleteUpcoming({ scopeId: view.scopeId, generation: view.generation, revision: view.revision + 5, id: view.upcoming![0].id }));
  await assert.rejects(rig.management.deleteUpcoming({ scopeId: view.scopeId, generation: view.generation, revision: view.revision, id: 'nope' }));
  await assert.rejects(rig.management.deleteUpcoming({ scopeId: view.scopeId, generation: view.generation, revision: view.revision, id: 3 }));
  await assert.rejects(rig.management.deleteUpcoming({ scopeId: view.scopeId, generation: view.generation, revision: view.revision, id: view.upcoming![0].id, extra: 1 }));
  assert.equal(list(rig).length, 1);
}));

test('plans nobody asked about expire after three days and leave four days later; the journal gets only closed events and counts', () => withRig(async rig => {
  await rig.turnOn(true);
  await rig.chat(scopeA, INTERVIEW.user, INTERVIEW.her);
  await rig.tick();
  const due = list(rig)[0].dueAt;
  rig.clock.t = due + 3 * DAY - 1;
  rig.host.settle(); await settle(); await rig.upcomingStore.settled();
  assert.equal(list(rig)[0].state, 'waiting');
  rig.clock.t = due + 3 * DAY + 1;
  rig.host.settle(); await settle(); await rig.upcomingStore.settled();
  assert.equal(list(rig)[0].state, 'expired');
  assert.deepEqual(rig.journal, [['recorded', 1], ['expired', 1]]);
  rig.clock.t += 7 * DAY + 1;
  rig.host.settle(); await settle(); await rig.upcomingStore.settled();
  assert.deepEqual(list(rig), []);
  assert.ok(!(await dirNames(rig.profileDir)).some(name => /^upcoming-[0-9a-f]{64}.json$/u.test(name)), 'nothing left, so the file is gone');
  // the journal line: the type is closed, the event is closed, the count is a number; anything else makes no line
  const entry = buildJournalEntry({ type: 'upcoming', characterId: 'char-a', event: 'expired', count: 1 }, rig.clock.t);
  assert.ok(entry);
  assert.match(journalReason(entry!), /过期/u);
  for (const bad of [{ event: '去面试' }, { event: 'recorded', count: 0 }, { event: 'recorded', count: 'x' }, { event: 'recorded', count: Number.NaN }]) {
    assert.equal(buildJournalEntry({ type: 'upcoming', characterId: 'char-a', count: 1, ...bad } as never, 1), null, JSON.stringify(bad));
  }
  const smuggled = JSON.stringify(buildJournalEntry({ type: 'upcoming', characterId: 'char-a', event: 'recorded', count: 1, what: '去面试', said: '明天下午', text: '我明天下午有个面试' } as never, 1));
  assert.ok(!/面试|明天下午/u.test(smuggled), smuggled);
}));

test('the developer commands go through the same switch: nothing is added with it off, and the earliest waiting plan can be made due', () => withRig(async rig => {
  assert.equal(await rig.host.testAdd(), 'recording-off');
  assert.equal(await rig.host.testDue(), 'recording-off');
  await rig.turnOn(true);
  assert.equal(await rig.host.testDue(), 'nothing', 'no plan waiting yet');
  assert.equal(await rig.host.testAdd(), 'ok');
  assert.equal(await rig.host.testAdd(), 'nothing', 'the same made-up plan is not added twice');
  assert.equal(list(rig).length, 1);
  assert.equal(list(rig)[0].dueAt > rig.clock.t, true);
  assert.equal(await rig.host.testDue(), 'ok');
  assert.equal(list(rig)[0].dueAt < rig.clock.t, true, 'due now');
  // it survives the archive check (no chat segment stands behind it)
  rig.notes.core.reconcile();
  await rig.upcomingStore.settled();
  assert.equal(list(rig).length, 1);
}));

test('MemoryStore tells a listener about each archived user message once: which segment, and whether it began it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sh-p001-turn-'));
  try {
    const store = new MemoryStore(dir); await store.load();
    const seen: { recordId: string; first: boolean }[] = [];
    store.onTurnBegun(info => { seen.push(info); });
    const a = await store.beginTurn(scopeA, { id: 't1', userText: '第一句', at: WED, conversationId: 'c' });
    await store.appendAssistant(scopeA, 't1', '好', WED + 1); await store.finishTurn(scopeA, 't1', 'complete', WED + 2);
    const b = await store.beginTurn(scopeA, { id: 't2', userText: '第二句', at: WED + 3, conversationId: 'c' });
    await store.beginTurn(scopeA, { id: 't2', userText: '第二句', at: WED + 3, conversationId: 'c' }); // a retry of the same turn
    assert.deepEqual(seen, [{ recordId: a.recordId, first: true }, { recordId: b.recordId, first: false }]);
    store.onTurnBegun(() => { throw new Error('a listener never changes what is archived'); });
    await store.appendAssistant(scopeA, 't2', '好', WED + 4); await store.finishTurn(scopeA, 't2', 'complete', WED + 5);
    await store.beginTurn(scopeA, { id: 't3', userText: '第三句', at: WED + 6, conversationId: 'c' });
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test('the marks file holds ids only, is capped, and an unreadable one means no marks', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sh-p001-marks-'));
  try {
    const marks = new UpcomingMarks(dir);
    marks.add('seg-1'); marks.add('seg-2'); await marks.flush();
    const text = await readFile(path.join(dir, UPCOMING_MARKS_FILE), 'utf8');
    assert.deepEqual(JSON.parse(text), { version: 1, ids: ['seg-1', 'seg-2'] });
    const again = new UpcomingMarks(dir); await again.load();
    assert.equal(again.has('seg-2'), true);
    again.keepOnly(new Set(['seg-2'])); again.remove(['nope']); await again.flush();
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, UPCOMING_MARKS_FILE), 'utf8')).ids, ['seg-2']);
    await again.wipe();
    await assert.rejects(stat(path.join(dir, UPCOMING_MARKS_FILE)));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, UPCOMING_MARKS_FILE), '{broken');
    const broken = new UpcomingMarks(dir); await broken.load();
    assert.equal(broken.size, 0);
    marks.dispose(); again.dispose(); broken.dispose();
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});
