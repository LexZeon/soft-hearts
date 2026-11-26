/**
 * P-001 step 1, "两分钟先记下": a plan is captured about two quiet minutes after the user says it, not only when the
 * chat segment ends. Real chat archive, notebook, profile files and plan memory; fake clock, fake haiku, made-up conversation. No real Claude,
 * no real profile.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryStore } from '../electron/memory/memory';
import { MemoryNotes } from '../electron/memory/memory-notes/host';
import { ProfileUpcomingBook } from '../electron/memory/upcoming/book';
import { UpcomingHost } from '../electron/memory/upcoming/host';
import { UpcomingStore } from '../electron/memory/upcoming/store';
import { UserProfileStore, userProfileScopeId } from '../electron/memory/user-profile';
import { UserProfileManagement } from '../electron/memory/user-profile-management';
import { EARLY_UPCOMING_SYSTEM_PROMPT } from '../shared/behaviors/upcoming/prompt';
import { UPCOMING_KNOBS, type UpcomingKnobs } from '../shared/behaviors/upcoming/knobs';
import { buildJournalEntry } from '../shared/memory/journal';
import type { MemoryScope } from '../shared/memory/memory';
import { FakeNoteWriter, fakeNoteBody } from '../shared/memory/memory-notes/fake';
import { MEMORY_NOTES_KNOBS } from '../shared/memory/memory-notes/knobs';

const SECOND = 1000, MINUTE = 60_000, DAY = 24 * 3_600_000;
/** Wednesday 2026-11-11 10:00 local time. */
const T0 = new Date(2026, 10, 11, 10, 0).getTime();
const scopeA: MemoryScope = { characterId: 'char-a', providerScope: 'p' };
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const early = (upcoming: unknown) => JSON.stringify({ upcoming });
const noteAnswer = (upcoming: unknown) => JSON.stringify({ ...fakeNoteBody({ title: '一段聊天', things: [], plans: [], tags: ['聊天', '面试', '心情'] }), keywords: [], upcoming });
const INTERVIEW = '我明天下午有个面试，好紧张';

async function withRig(run: (rig: Rig) => Promise<void>, knobs?: UpcomingKnobs): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sh-p001-early-'));
  try {
    const rig = await makeRig(dir, knobs);
    try { await run(rig); } finally { await rig.close(); }
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}

async function makeRig(dir: string, knobs?: UpcomingKnobs) {
  const clock = { t: T0, activity: null as number | null };
  const gates = { userBusy: false, modelBusy: false };
  const profileDir = path.join(dir, 'user-profiles');
  const upcomingStore = new UpcomingStore(profileDir, { now: () => clock.t, recording: (): boolean => management.get()?.enabled === true });
  const profiles = new UserProfileStore(profileDir, { now: () => clock.t, upcoming: upcomingStore });
  const management: UserProfileManagement = new UserProfileManagement(profiles, () => {}, () => ({ characterId: scopeA.characterId, providerScope: scopeA.providerScope }),
    (_scope, reason) => { if (reason === 'recording-off') void host.recordingOff(); });
  await management.activate(scopeA);
  const memory = new MemoryStore(dir);
  await memory.load();
  const journal: [string, number, string | undefined][] = [];
  const book = new ProfileUpcomingBook(upcomingStore, () => management.get()?.scopeId ?? null, () => clock.t, (() => { let n = 0; return () => `item-${++n}`; })());
  const earlyWriter = new FakeNoteWriter(early([])).when('牙', early([{ what: '去看牙', when: '周五下午' }])).when('面试', early([{ what: '去面试', when: '明天下午' }]));
  const host: UpcomingHost = new UpcomingHost({ directory: profileDir, book, recording: () => management.get()?.enabled === true,
    scopeOf: key => { const owner = memory.ownerOfScope(key); return owner ? userProfileScopeId(owner) : null; },
    journal: (event, count, via) => { journal.push([event, count, via]); }, now: () => clock.t,
    early: { archive: memory, write: earlyWriter.write, userBusy: () => gates.userBusy, modelBusy: () => gates.modelBusy, lastActivityAt: () => clock.activity, ...(knobs ? { knobs } : {}) } });
  await host.start();
  memory.onTurnBegun(info => host.turnBegun(info));
  const noteWriter = new FakeNoteWriter(noteAnswer([])).when('面试', noteAnswer([{ what: '参加面试', when: '明天下午' }])).when('牙', noteAnswer([{ what: '去看牙', when: '周五下午' }]));
  const notes = new MemoryNotes({ directory: dir, archive: memory, write: noteWriter.write, userBusy: () => false, modelBusy: () => false, lastActivityAt: () => clock.activity,
    scope: () => scopeA, now: () => clock.t, tickMs: 3_600_000, upcoming: host.hooks() });
  await notes.start();
  clock.t += MEMORY_NOTES_KNOBS.pace.startDelaySeconds * 1000;

  let turn = 0;
  /** One exchange in the (still running, unsealed) conversation; the user's last word is now. */
  const say = async (user: string, her = '嗯嗯。', conversation = 'talk') => {
    const id = `t-${++turn}`;
    const handle = await memory.beginTurn(scopeA, { id, userText: user, at: clock.t, conversationId: conversation });
    await memory.appendAssistant(scopeA, id, her, clock.t + 1_000);
    await memory.finishTurn(scopeA, id, 'complete', clock.t + 2_000);
    clock.activity = clock.t + 2_000;
    return handle.recordId;
  };
  const after = async (ms: number) => { clock.t = (clock.activity ?? clock.t) + ms; const started = host.early!.tick(); await settle(); await upcomingStore.settled(); return started; };
  const turnOn = async (on: boolean) => {
    const view = management.get()!;
    await management.setEnabled({ scopeId: view.scopeId, generation: view.generation, revision: view.revision, enabled: on });
    await profiles.settled(); await upcomingStore.settled(); await host.marks.flush();
  };
  const list = () => book.list();
  const upcomingFile = async () => readFile(path.join(profileDir, `upcoming-${userProfileScopeId(scopeA)}.json`), 'utf8').catch(() => '');
  const close = async () => { await notes.dispose(); await host.dispose(); management.dispose(); };
  return { dir, profileDir, clock, gates, memory, book, host, notes, earlyWriter, noteWriter, journal, say, after, turnOn, list, upcomingFile, upcomingStore, management, close };
}
type Rig = Awaited<ReturnType<typeof makeRig>>;

test('say a plan: nothing at 119 s, one call at 121 s, and the plan is on the list (journal: counts and via only)', () => withRig(async rig => {
  await rig.turnOn(true);
  await rig.say(INTERVIEW, '别紧张，我陪着你。');
  assert.equal(await rig.after(119 * SECOND), false);
  assert.equal(rig.earlyWriter.calls.length, 0);
  assert.equal(await rig.after(121 * SECOND), true);
  await settle(); await rig.upcomingStore.settled();
  assert.equal(rig.earlyWriter.calls.length, 1);
  assert.equal(rig.earlyWriter.calls[0].systemPrompt, EARLY_UPCOMING_SYSTEM_PROMPT);
  assert.equal(rig.noteWriter.calls.length, 0, 'the segment has not ended: no note yet');
  const [item] = rig.list();
  assert.ok(item);
  assert.equal(item.what, '去面试');
  assert.equal(item.said, '明天下午');
  const due = new Date(item.dueAt);
  assert.deepEqual([due.getMonth() + 1, due.getDate(), due.getHours()], [11, 12, 18]);
  assert.deepEqual(rig.journal, [['recorded', 1, 'early']]);
  const entry = buildJournalEntry({ type: 'upcoming', characterId: 'char-a', event: 'recorded', count: 1, via: 'early' }, T0);
  assert.ok(entry && JSON.stringify(entry).includes('"early"'));
  assert.equal(buildJournalEntry({ type: 'upcoming', characterId: 'char-a', event: 'recorded', count: 1, via: 'whatever' } as never, T0), null, 'via is a closed list');
  assert.equal(rig.host.early!.started, 1);
  // the same messages are never looked at twice
  assert.equal(await rig.after(10 * MINUTE), false);
  assert.equal(rig.earlyWriter.calls.length, 1);
}));

test('the call sees only the messages not examined yet (plus a little context), and not the earlier ones twice', () => withRig(async rig => {
  await rig.turnOn(true);
  await rig.say('今天天气真好啊，我们去散散步', '好呀。');
  await rig.say('随便聊聊吧，最近有点累', '那就慢慢聊。');
  await rig.say(INTERVIEW, '别紧张。');
  await rig.after(121 * SECOND);
  assert.equal(rig.earlyWriter.calls.length, 1);
  assert.ok(rig.earlyWriter.calls[0].prompt.includes('面试'));
  // a second plan later in the same segment gets its own look after its own quiet 120 s; the first plan's words are context only
  rig.clock.t += 5 * MINUTE;
  await rig.say('周五下午我还要去看牙', '加油。');
  assert.equal(await rig.after(100 * SECOND), false);
  assert.equal(await rig.after(121 * SECOND), true);
  await settle(); await rig.upcomingStore.settled();
  assert.equal(rig.earlyWriter.calls.length, 2);
  assert.ok(rig.earlyWriter.calls[1].prompt.includes('看牙'));
  assert.deepEqual(rig.list().map(item => item.what).sort(), ['去看牙', '去面试']);
}));

test('talking again before 120 s resets the wait', () => withRig(async rig => {
  await rig.turnOn(true);
  await rig.say(INTERVIEW);
  rig.clock.t = (rig.clock.activity ?? 0) + 100 * SECOND;
  await rig.say('对了，你今天在做什么呀', '在陪你。');
  assert.equal(await rig.after(119 * SECOND), false);
  assert.equal(rig.earlyWriter.calls.length, 0);
  assert.equal(await rig.after(121 * SECOND), true);
  await settle(); await rig.upcomingStore.settled();
  assert.equal(rig.earlyWriter.calls.length, 1, 'one call for both messages');
  assert.equal(rig.list().length, 1);
}));

test('no call for an unmarked segment, with recording off, without a time word, or while busy', () => withRig(async rig => {
  // recording off for the whole segment: it is not marked
  await rig.say(INTERVIEW);
  assert.equal(await rig.after(200 * SECOND), false);
  // switch on now: a new segment is marked, but nothing in it names a time
  await rig.turnOn(true);
  await rig.say('好无聊啊，不知道做点什么好', '陪你聊聊。', 'other');
  assert.equal(await rig.after(200 * SECOND), false);
  assert.equal(rig.earlyWriter.calls.length, 0);
  // a time word in a marked segment, but the user is busy / another call runs: wait; and nothing is lost by waiting
  await rig.say(INTERVIEW, '嗯。', 'third');
  rig.gates.userBusy = true;
  assert.equal(await rig.after(200 * SECOND), false);
  rig.gates.userBusy = false; rig.gates.modelBusy = true;
  assert.equal(await rig.after(200 * SECOND), false);
  rig.gates.modelBusy = false;
  assert.equal(await rig.after(200 * SECOND), true);
  await settle(); await rig.upcomingStore.settled();
  assert.equal(rig.earlyWriter.calls.length, 1);
  // switched off by the time it would run: no call
  await rig.turnOn(false);
  await rig.turnOn(true);
  await rig.say(INTERVIEW, '嗯。', 'fourth');
  await rig.turnOn(false);
  assert.equal(await rig.after(200 * SECOND), false);
  assert.equal(rig.earlyWriter.calls.length, 1);
}));

test('the later note does not list the same plan again (different wording of "what" included); a plan only the note finds is added', () => withRig(async rig => {
  await rig.turnOn(true);
  const record = await rig.say(INTERVIEW);
  await rig.after(121 * SECOND);
  assert.equal(rig.list().length, 1);
  // the segment ends; its note asks the same question and says it differently
  rig.clock.t += 20 * MINUTE;
  rig.notes.core.tick(); await settle(); await rig.upcomingStore.settled();
  assert.equal(rig.noteWriter.calls.length, 1, 'the note is still written, as before');
  assert.ok(rig.noteWriter.calls[0].systemPrompt.includes('upcoming'), 'and still asks the question');
  assert.equal(rig.list().length, 1, 'not twice');
  assert.equal(rig.list()[0].what, '去面试', 'the first one stays');
  // a plan the early look missed and the note found
  rig.host.hooks().noted({ recordId: record, scope: rig.memory.noteScope(scopeA), at: T0, raw: noteAnswer([{ what: '参加面试', when: '明天下午' }, { what: '去面试', when: '明天下午' }]),
    messages: [{ role: 'user', content: INTERVIEW }, { role: 'assistant', content: '嗯。' }] });
  await settle(); await rig.upcomingStore.settled();
  assert.equal(rig.list().length, 1);
  const missed = await rig.say('周五下午我要去看牙，会痛吧', '加油。', 'second');
  await rig.after(30 * SECOND);
  rig.host.hooks().noted({ recordId: missed, scope: rig.memory.noteScope(scopeA), at: rig.clock.t, raw: noteAnswer([{ what: '看牙', when: '周五下午' }]),
    messages: [{ role: 'user', content: '周五下午我要去看牙，会痛吧' }] });
  await settle(); await rig.upcomingStore.settled();
  assert.equal(rig.list().length, 2);
  assert.deepEqual(rig.journal.map(entry => [entry[0], entry[2]]), [['recorded', 'early'], ['recorded', 'note']]);
}));

test('a plan the user deleted is not added again, by the early look or the note', () => withRig(async rig => {
  await rig.turnOn(true);
  const record = await rig.say(INTERVIEW);
  await rig.after(121 * SECOND);
  const view = rig.management.get()!;
  await rig.management.deleteUpcoming({ scopeId: view.scopeId, generation: view.generation, revision: view.revision, id: view.upcoming![0].id });
  assert.deepEqual(rig.list(), []);
  // another time word in the same segment: the early look runs, but nothing comes back
  await rig.say('明天下午那个面试我还是有点担心', '会顺利的。');
  assert.equal(await rig.after(121 * SECOND), true);
  await settle(); await rig.upcomingStore.settled();
  assert.deepEqual(rig.list(), []);
  rig.clock.t += 20 * MINUTE;
  rig.notes.core.tick(); await settle(); await rig.upcomingStore.settled();
  assert.deepEqual(rig.list(), []);
  assert.deepEqual(JSON.parse(await rig.upcomingFile()).upcoming.blockedFrom, [record]);
}));

test('turning the switch off while the early call is in flight: nothing is written afterwards', () => withRig(async rig => {
  let release!: (answer: string) => void;
  const held = new FakeNoteWriter(early([])).when('面试', { wait: new Promise<string>(resolve => { release = resolve; }) });
  (rig.host.early as unknown as { deps: { write: unknown } }).deps.write = held.write;
  await rig.turnOn(true);
  await rig.say(INTERVIEW);
  assert.equal(await rig.after(121 * SECOND), true);
  assert.equal(held.calls.length, 1);
  assert.equal(rig.host.early!.busy, true);
  await rig.turnOn(false);
  assert.equal(held.calls[0].signal.aborted, true, 'the call is abandoned');
  release(early([{ what: '去面试', when: '明天下午' }]));
  await settle(); await rig.upcomingStore.settled();
  assert.deepEqual(rig.list(), []);
  assert.equal(await rig.upcomingFile(), '', 'no list file');
  const names = await readdir(rig.profileDir);
  assert.ok(!names.some(name => name.startsWith('upcoming-')), 'and no other trace');
  assert.deepEqual(rig.journal, []);
  assert.equal(rig.host.early!.busy, false);
}));

test('a call that lands after the segment was deleted writes nothing', () => withRig(async rig => {
  let release!: (answer: string) => void;
  const held = new FakeNoteWriter(early([])).when('面试', { wait: new Promise<string>(resolve => { release = resolve; }) });
  (rig.host.early as unknown as { deps: { write: unknown } }).deps.write = held.write;
  await rig.turnOn(true);
  const record = await rig.say(INTERVIEW);
  await rig.after(121 * SECOND);
  assert.equal(await rig.memory.delete(scopeA, record), true);
  release(early([{ what: '去面试', when: '明天下午' }]));
  await settle(); await rig.upcomingStore.settled();
  assert.deepEqual(rig.list(), []);
}));

test('the daily cap holds, and a new day starts again', () => withRig(async rig => {
  await rig.turnOn(true);
  const word = ['我明天下午有个面试', '我后天下午有个面试', '我周五下午有个面试', '我下周三下午有个面试'];
  let started = 0;
  for (const user of word) {
    await rig.say(user, '嗯。');
    if (await rig.after(121 * SECOND)) started++;
  }
  assert.equal(started, 2, 'cap of 2 in this test');
  assert.equal(rig.earlyWriter.calls.length, 2);
  rig.clock.t += DAY;
  await rig.say('我大后天下午有个面试', '嗯。');
  assert.equal(await rig.after(121 * SECOND), true, 'the next day counts from zero');
}, { ...UPCOMING_KNOBS, early: { ...UPCOMING_KNOBS.early, dailyCalls: 2 } }));

test('the default knobs: 120 seconds quiet, 30 calls a day', () => {
  assert.equal(UPCOMING_KNOBS.early.quietSeconds, 120);
  assert.equal(UPCOMING_KNOBS.early.dailyCalls, 30);
});

test('a plan about someone else, a joke, or a sensitive word is dropped by the local guards in the early path too', () => withRig(async rig => {
  rig.earlyWriter.when('朋友', early([{ what: '朋友面试', when: '明天下午' }])).when('开玩笑', early([{ what: '去面试', when: '明天下午' }]));
  await rig.turnOn(true);
  await rig.say('我朋友明天下午有个面试，我有点替他紧张', '你真好。');
  await rig.after(121 * SECOND);
  await rig.say('我明天下午要去面试当总统，开玩笑的啦', '哈哈。', 'two');
  await rig.after(121 * SECOND);
  assert.equal(rig.earlyWriter.calls.length, 2);
  assert.deepEqual(rig.list(), []);
}));
