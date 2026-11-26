/**
 * P-001 step 1: the extra question in the I-021 note call, only for a segment marked "may record". Fake clock, fake archive, fake haiku,
 * synthetic conversations; no real Claude, no real profile.
 *  - unmarked segment: the note prompts are byte-for-byte what they were before this feature (hashes taken from the build before it);
 *  - marked segment: one more question and one more answer field; the plans in it are read strictly;
 *  - a very short marked segment with a day or a time in it still gets a note; an unmarked one does not.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { MemoryNotesCore } from '../electron/memory/memory-notes/core';
import { FakeNoteArchive, FakeNoteWriter, fakeNoteBody } from '../shared/memory/memory-notes/fake';
import { MEMORY_NOTE_SYSTEM_PROMPT, memoryNotePrompt, parseMemoryNote } from '../shared/memory/memory-notes/note';
import { UPCOMING_FIELD_PROMPT, extractUpcoming, ownPlanClause, withUpcomingQuestion } from '../shared/behaviors/upcoming/prompt';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
// Taken from the build just before P-001 (git c9d0dd34): the writer's system prompt and the user prompt of a two-line conversation.
// I-089 item 1 added the optional felt field to the system prompt (new hash); what this test pins is that marking or not marking a segment changes nothing else.
// I-089 item 2 added the optional changes field to the system prompt (hash updated on purpose, again only the system prompt changed).
const SYSTEM_PROMPT_BEFORE = '535bff87bf6445a470b3f8a4c47065e784a5799bf03ae06d3beded828267e637';
const NOTE_PROMPT_BEFORE = '0788317ba625e05e960d9b671915b747b9b6facafeeb765c2d1d22442bbbda79';
const CONVERSATION = [{ role: 'user' as const, content: '我明天下午有个面试，好紧张' }, { role: 'assistant' as const, content: '别紧张，我陪着你。' }];
const T0 = new Date(2026, 10, 11, 23, 50).getTime();
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('an unmarked segment sees the note prompts byte for byte as before', () => {
  assert.equal(sha(MEMORY_NOTE_SYSTEM_PROMPT), SYSTEM_PROMPT_BEFORE);
  assert.equal(sha(withUpcomingQuestion(MEMORY_NOTE_SYSTEM_PROMPT, false)), SYSTEM_PROMPT_BEFORE);
  assert.equal(sha(memoryNotePrompt(CONVERSATION)), NOTE_PROMPT_BEFORE);
  const marked = withUpcomingQuestion(MEMORY_NOTE_SYSTEM_PROMPT, true);
  assert.ok(marked.startsWith(MEMORY_NOTE_SYSTEM_PROMPT + '\n'), 'the writer\'s own prompt is untouched, the question comes after it');
  assert.ok(marked.endsWith(UPCOMING_FIELD_PROMPT));
  for (const word of ['upcoming', '照原文抄', '别人的打算', '假设', '玩笑', '角色扮演', '别记']) assert.ok(marked.includes(word), word);
});

function coreWith(archive: FakeNoteArchive, writer: FakeNoteWriter, over: Partial<ConstructorParameters<typeof MemoryNotesCore>[0]> = {}) {
  const clock = { t: T0 + 3 * 3_600_000 };
  const landed: { recordId: string; scope: string; at: number; raw: string; messages: readonly { role: string; content: string }[] }[] = [];
  const core = new MemoryNotesCore({ archive, write: writer.write, save: async () => {}, userBusy: () => false, modelBusy: () => false, lastActivityAt: () => null,
    currentScope: () => 'mine', now: () => clock.t, upcomingNoted: info => { landed.push(info); }, ...over });
  clock.t += 200_000;
  return { core, clock, landed };
}
const answer = (upcoming: unknown, over: Record<string, unknown> = {}) => JSON.stringify({ ...fakeNoteBody(), keywords: [], upcoming, ...over });

test('the call for a marked segment carries the extra question; the call for an unmarked one does not, even when the answer has the field', async () => {
  const archive = new FakeNoteArchive()
    .add('marked', 'mine', T0, CONVERSATION)
    .add('plain', 'mine', T0 + 1, CONVERSATION.map(message => ({ ...message, content: message.content + '。' })));
  const writer = new FakeNoteWriter().when('面试', answer([{ what: '去面试', when: '明天下午' }]));
  const { core, clock, landed } = coreWith(archive, writer, { marked: id => id === 'marked' });
  for (let i = 0; i < 2; i++) { assert.equal(core.tick(), true); await settle(); clock.t += 60_000; }
  assert.equal(writer.calls.length, 2);
  const byId = (marked: boolean) => writer.calls.find(call => call.systemPrompt.includes('upcoming') === marked)!;
  assert.equal(sha(byId(false).systemPrompt), SYSTEM_PROMPT_BEFORE, 'unmarked: the system prompt is the old one');
  assert.equal(byId(true).systemPrompt, withUpcomingQuestion(MEMORY_NOTE_SYSTEM_PROMPT, true));
  assert.equal(byId(true).prompt, memoryNotePrompt(CONVERSATION), 'the conversation part is the same either way');
  assert.deepEqual(landed.map(item => item.recordId), ['marked'], 'only the marked segment\'s answer is read for plans');
  assert.equal(landed[0].scope, 'mine');
  assert.equal(landed[0].at, T0, 'time words are read from the start of the segment');
  assert.equal(core.state('plain', 'mine').status, 'written', 'the plain note is written as always');
});

test('no hooks at all: the notebook behaves as before', async () => {
  const archive = new FakeNoteArchive().add('a', 'mine', T0, CONVERSATION);
  const writer = new FakeNoteWriter().when('面试', answer([{ what: '去面试', when: '明天下午' }]));
  const { core, clock } = coreWith(archive, writer, { upcomingNoted: undefined });
  assert.equal(core.tick(), true); await settle();
  assert.equal(sha(writer.calls[0].systemPrompt), SYSTEM_PROMPT_BEFORE);
  assert.equal(core.state('a', 'mine').status, 'written');
  assert.ok(clock.t > 0);
});

test('a mark taken away while the call runs means its answer is not read for plans', async () => {
  const archive = new FakeNoteArchive().add('a', 'mine', T0, CONVERSATION);
  let release!: (value: string) => void;
  const writer = new FakeNoteWriter().when('面试', { wait: new Promise<string>(resolve => { release = resolve; }) });
  const state = { marked: true };
  const { core, landed } = coreWith(archive, writer, { marked: () => state.marked });
  assert.equal(core.tick(), true);
  state.marked = false;
  release(answer([{ what: '去面试', when: '明天下午' }])); await settle();
  assert.equal(core.state('a', 'mine').status, 'written');
  assert.deepEqual(landed, []);
});

test('a very short segment gets a note only when it is marked and the user\'s own words name a day or a time', async () => {
  const short = (text: string) => [{ role: 'user' as const, content: text }, { role: 'assistant' as const, content: '好的呀。' }];
  const archive = new FakeNoteArchive().add('dated', 'mine', T0, short('明天面试')).add('greeting', 'mine', T0 + 1, short('晚上好')).add('plain', 'mine', T0 + 2, short('周五开会'));
  const writer = new FakeNoteWriter().when('面试', answer([{ what: '去面试', when: '明天' }]));
  const { core, clock } = coreWith(archive, writer, { marked: id => id !== 'plain' });
  assert.equal(core.state('dated', 'mine').status, 'waiting');
  assert.equal(core.state('greeting', 'mine').status, 'none', 'marked but nothing dated: still too short');
  assert.equal(core.state('plain', 'mine').status, 'none', 'unmarked: too short, as today');
  assert.deepEqual(core.progress('mine'), { noted: 0, waiting: 1 });
  assert.equal(core.tick(), true); await settle(); clock.t += 60_000;
  assert.equal(core.tick(), false, 'only the dated one');
  assert.equal(core.state('dated', 'mine').status, 'written');
  assert.equal(writer.calls.length, 1);
});

test('the note itself is unaffected by the extra field (and an old reader of the note format still reads it)', () => {
  const note = parseMemoryNote(answer([{ what: '去面试', when: '明天下午' }]));
  assert.ok(note);
  assert.deepEqual(Object.keys(note!).sort(), ['mood', 'people', 'plans', 'summary', 'tags', 'things', 'title']);
  assert.equal(parseMemoryNote(answer([], { surprise: 1 })), null, 'any other extra field is still refused');
});

// ---- reading the plans out of the answer ----

const user = (content: string) => ({ role: 'user', content });
const her = (content: string) => ({ role: 'assistant', content });
const read = (messages: { role: string; content: string }[], upcoming: unknown, reject?: (text: string) => boolean) =>
  extractUpcoming(answer(upcoming), messages, { at: T0, reject });

test('the user\'s own plan with time words copied from what they said is kept, with its due time', () => {
  const found = read([user('我明天下午有个面试，好紧张'), her('别紧张')], [{ what: '去面试', when: '明天下午' }]);
  assert.equal(found.length, 1);
  assert.equal(found[0].what, '去面试');
  assert.equal(found[0].said, '明天下午');
  assert.equal(new Date(found[0].dueAt).getDate(), 12);
  assert.equal(new Date(found[0].dueAt).getHours(), 18);
  assert.deepEqual(found.map(item => Object.keys(item).sort()), [['dueAt', 'said', 'what']], 'not a word of the user\'s sentence is kept');
});

test('what is not the user\'s own real plan is not kept', () => {
  const rows: [string, { role: string; content: string }[], string][] = [
    ['someone else\'s plan', [user('我朋友明天面试，我有点替他紧张')], '明天'],
    ['someone else, family', [user('我妈明天手术')], '明天'],
    ['a supposition', [user('假如明天下雨，我就不出门了')], '明天'],
    ['a joke', [user('我明天要上天，开玩笑的')], '明天'],
    ['asked not to keep', [user('我周五去体检，别记这个')], '周五'],
    ['role-play', [user('我们来角色扮演吧，你是老师，明天交作业')], '明天'],
    ['said by her, not by the user', [her('你明天下午不是有面试吗？'), user('嗯')], '明天下午'],
    ['time words the user never said', [user('我要去面试')], '明天下午'],
    ['words that name no moment', [user('我过阵子想去旅游')], '过阵子'],
    ['in the past', [user('我昨天下午去面试了')], '昨天下午'],
    ['changed words (not copied)', [user('我明天下午有个面试')], '明天午后'],
  ];
  for (const [name, messages, when] of rows) assert.deepEqual(read(messages, [{ what: '这件事', when }]), [], name);
  // a friend in the sentence is fine when it is the user's own plan
  assert.equal(read([user('我和朋友明天去看电影')], [{ what: '看电影', when: '明天' }]).length, 1);
  // a plan said in a message that is not the user's own words in two clauses: the clause with the time words decides
  assert.equal(read([user('我朋友人很好，我明天去看他的展')], [{ what: '看展', when: '明天' }]).length, 0, 'he is in the same clause chain only through 他');
  assert.equal(read([user('我朋友人很好。我明天下午去面试')], [{ what: '去面试', when: '明天下午' }]).length, 1);
});

test('the profile\'s sensitive words and credentials are not kept (the host passes them as `reject`)', () => {
  const reject = (text: string) => /体检|药|sk-/u.test(text);
  assert.deepEqual(read([user('我明天去医院拿药')], [{ what: '拿药', when: '明天' }], reject), []);
  assert.deepEqual(read([user('我明天去体检')], [{ what: '去医院', when: '明天' }], reject), [], 'the clause itself carries it');
  assert.equal(read([user('我明天去面试')], [{ what: '去面试', when: '明天' }], reject).length, 1);
});

test('bad shapes are dropped, never repaired; the answer without the field gives nothing', () => {
  const messages = [user('我明天下午有个面试，周五还要交报告')];
  assert.deepEqual(extractUpcoming('not json', messages, { at: T0 }), []);
  assert.deepEqual(extractUpcoming(JSON.stringify(fakeNoteBody()), messages, { at: T0 }), []);
  assert.deepEqual(read(messages, 'x'), []);
  assert.deepEqual(read(messages, [null, 3, 'x', [], { what: 1, when: '明天下午' }, { what: '去面试' }, { when: '明天下午' }, { what: '', when: '明天下午' },
    { what: '去面试', when: '明天下午明天下午明天下午明天下午明天下午' }, { what: '带\u0000控制符', when: '明天下午' }]), []);
  const two = read(messages, [{ what: '去面试', when: '明天下午' }, { what: '交报告', when: '周五' }]);
  assert.deepEqual(two.map(item => item.what), ['去面试', '交报告']);
  assert.equal(read(messages, [{ what: '去面试', when: '明天下午' }, { what: '去面试', when: '明天下午' }]).length, 1, 'the same plan twice');
  assert.equal(read(messages, [1, 2, 3, 4].map(i => ({ what: `事${i}`, when: '明天下午' }))).length <= 3, true);
  const long = read(messages, [{ what: '一二三四五六七八九十一二三四五六七八九十一二三', when: '明天下午' }]);
  assert.equal(Array.from(long[0].what).length, 20, 'a little too long is cut to twenty');
  assert.deepEqual(read(messages, [{ what: 'x'.repeat(80), when: '明天下午' }]), [], 'far too long is dropped');
});

test('time words are found whatever the width or spacing', () => {
  assert.equal(read([user('我 明天 下午 有个面试')], [{ what: '去面试', when: '明天下午' }]).length, 1);
  assert.equal(read([user('我明天３点开会')], [{ what: '开会', when: '明天3点' }]).length, 1);
});

test('the clause check on its own', () => {
  for (const clause of ['我明天下午面试', '我和朋友周五去玩', '周五我要交报告', '明天去看牙']) assert.equal(ownPlanClause(clause), true, clause);
  for (const clause of ['他明天面试', '她周五过生日', '我朋友明天面试', '朋友明天来', '假如明天下雨', '如果周五放假', '开玩笑的，我明天不去', '这个别记，周五的事', '我同事周五出差']) assert.equal(ownPlanClause(clause), false, clause);
});
