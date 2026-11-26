// I-059: the user's birthday or an anniversary, she says something herself even with 「她的文件夹」 off.
// Fake clock, made-up profile entries, fake Claude (a function that answers a line); never the real profile, never a real model.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { SpecialDayHost, combineTellPorts, joinHintLines } from '../electron/memory/special-day/host';
import { MoodReplyProtocol } from '../electron/mood/mood-chat';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { SPECIAL_DAY_LIMITS, cleanSpokenLine, datesToday, mentionsDay, readBook, specialDayHintLine } from '../shared/memory/special-day';
const plain = (source: string, ...items: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_, i: string) => String(items[Number(i)]));

const temps: string[] = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'sh-i059-')); temps.push(dir); return dir; };
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

const at = (hour: number, minute = 0, day = 10) => new Date(2026, 10, day, hour, minute).getTime();
const BIRTHDAY = ['我喜欢喝热可可', '我的生日是11月10日'];
const ANNIVERSARY = ['我们的纪念日是11月10日'];

type Event = { characterId: string | null; event: string; kind: string; first: string | null };
function rig(over: { texts?: readonly string[] | null; folderOn?: boolean; now?: number; dir?: string; answer?: string | (() => string); calm?: boolean; withAsk?: boolean } = {}) {
  const dir = over.dir ?? temp();
  const state = { now: over.now ?? at(9), texts: over.texts === undefined ? BIRTHDAY : over.texts, folderOn: over.folderOn ?? false, calm: over.calm ?? true, asks: 0,
    answer: over.answer ?? '生日快乐呀，今天想吃蛋糕吗' };
  const journal: Event[] = [];
  const host = new SpecialDayHost({
    file: () => path.join(dir, 'special-day.json'), characterId: () => 'c1', folderOn: () => state.folderOn, recordingTexts: () => state.texts,
    journal: input => journal.push(input), calm: () => state.calm, now: () => state.now,
    ...(over.withAsk === false ? {} : { ask: async () => { state.asks++; return typeof state.answer === 'function' ? state.answer() : state.answer; } }),
  });
  return { host, state, journal, dir };
}
const REPLY_TOUCHES = '早呀，今天是你的生日呢，生日快乐！';
const REPLY_PLAIN = '早呀，今天想先喝点什么？';

test('the first daytime turn of the day carries one private line; she decides; her shown reply that touches the day ends it', async () => {
  const { host, journal } = rig();
  const turn = host.beginHint('早上好');
  assert.ok(turn);
  assert.equal(turn!.line, specialDayHintLine('birthday'));
  assert.match(turn!.line, /生日/u); assert.match(turn!.line, /心情(?:不好|明显很差)/u); assert.doesNotMatch(turn!.line, /记录了|已记录|提醒你/u);
  // I-064 K11 let a small model skip the day twice; the day is the point of this turn now.
  assert.doesNotMatch(turn!.line, /可选|别硬凑/u);
  assert.equal(host.hintDone(turn, REPLY_TOUCHES), true);
  assert.equal(host.beginHint('我想吃面'), null, 'done for today: later turns are ordinary');
  assert.deepEqual(journal.map(e => [e.event, e.first]), [['hinted', null], ['said', 'her']]);
});

test('a reply that does not touch it leaves up to two more chances that day, then it expires; later turns are ordinary', () => {
  const { host, journal } = rig();
  for (let i = 0; i < SPECIAL_DAY_LIMITS.maxHints; i++) {
    const turn = host.beginHint(`第${i}句`);
    assert.ok(turn, `turn ${i}`);
    assert.equal(host.hintDone(turn, REPLY_PLAIN), false);
  }
  assert.equal(host.beginHint('还有吗'), null);
  assert.deepEqual(journal.map(e => e.event), ['hinted', 'hinted', 'hinted', 'expired']);
  assert.equal(journal.at(-1)!.first, null, 'nobody spoke of it');
});

test('the user says it first: noted as theirs, nothing is added to her prompt, no second mention', () => {
  const { host, journal } = rig();
  assert.equal(host.beginHint('今天是我生日，你猜我几岁'), null);
  assert.equal(host.beginHint('哈哈'), null);
  assert.deepEqual(journal.map(e => [e.event, e.first]), [['user-first', 'user']]);
});

test('every other turn is byte-identical: no date today, recording off, someone else\'s birthday, a date that is not today', () => {
  const plain = new MoodReplyProtocol(() => {}).instruction();
  const noNonce = (text: string) => text.replace(/sh-state-[0-9a-f]+/gu, 'sh-state-N');
  const cases: [string, Parameters<typeof rig>[0]][] = [
    ['recording off', { texts: null }],
    ['no date at all', { texts: ['我喜欢喝热可可', '周末想去爬山'] }],
    ['someone else', { texts: ['我朋友的生日是11月10日', '妈妈生日11月10日', '同事生日是11月10日'] }],
    ['another day', { texts: ['我的生日是3月2日'] }],
    ['a guess, not a date', { texts: ['他好像快过生日了'] }],
  ];
  for (const [name, options] of cases) {
    const { host, journal } = rig(options);
    const turn = host.beginHint('早上好') as { line: string } | null;
    assert.equal(turn === null, true, name);
    const hint = joinHintLines(undefined, turn?.line);
    assert.equal(hint, undefined, name);
    assert.equal(noNonce(new MoodReplyProtocol(() => {}, { ...(hint ? { folderHint: hint } : {}) }).instruction()), noNonce(plain), name);
    assert.deepEqual(journal, [], name);
  }
  // and on the day itself the hint turn is exactly the ordinary prompt plus one line
  const { host } = rig();
  const turn = host.beginHint('早上好')!;
  assert.ok(turn);
  const hinted = new MoodReplyProtocol(() => {}, { folderHint: joinHintLines(undefined, turn.line) }).instruction();
  assert.equal(noNonce(hinted), noNonce(`${plain}\n${turn.line}`));
  assert.equal(joinHintLines('甲', undefined, '乙'), '甲\n乙');
});

test('with her folder on this path is silent: no hint, no line of her own, no journal, nothing asked', async () => {
  const { host, journal, state } = rig({ folderOn: true });
  assert.equal(host.beginHint('早上好'), null);
  await host.tick();
  assert.equal(host.peek('c1'), null);
  assert.equal(state.asks, 0);
  assert.deepEqual(journal, []);
});

test('deep night (00:00 to 06:00): no hint and no line of her own; the first daytime turn still gets it', async () => {
  const { host, state, journal } = rig({ now: at(3, 30) });
  assert.equal(host.beginHint('睡不着'), null);
  await host.tick();
  assert.equal(state.asks, 0); assert.equal(host.peek('c1'), null);
  state.now = at(5, 59); assert.equal(host.beginHint('还醒着'), null);
  state.now = at(6, 0);
  assert.ok(host.beginHint('早'), 'six o\'clock is the morning');
  assert.deepEqual(journal.map(e => e.event), ['hinted']);
});

test('once per day and character, also across a restart; the next day starts clean (and a missed day expires once)', async () => {
  const first = rig();
  const turn = first.host.beginHint('早')!;
  first.host.hintDone(turn, REPLY_TOUCHES);
  await first.host.idle();
  const again = rig({ dir: first.dir });
  await again.host.load();
  assert.equal(again.host.beginHint('我回来了'), null, 'the day is remembered');
  // a day whose chances were left unused: one expired line the next time anything looks, never twice
  const missed = rig();
  missed.host.hintDone(missed.host.beginHint('早')!, REPLY_PLAIN);
  missed.state.now = at(9, 0, 11);
  missed.host.beginHint('第二天');
  missed.host.beginHint('第二天又来');
  assert.deepEqual(missed.journal.map(e => e.event), ['hinted', 'expired']);
});

test('who spoke first: her line before the user\'s message is hers; the user\'s own word first is theirs', async () => {
  // hers: a line of her own before the user talked
  const a = rig();
  await a.host.tick();
  assert.equal(a.host.peek('c1'), 'tell');
  assert.equal(a.host.line({ id: 'cue-1', characterId: 'c1' }), '生日快乐呀，今天想吃蛋糕吗');
  a.host.noteDelivered('cue-1');
  assert.deepEqual(a.journal.map(e => [e.event, e.first]), [['said', 'her']]);
  assert.equal(a.host.beginHint('谢谢你'), null, 'the day is done');
  assert.equal(a.host.peek('c1'), null);
  // hers: the hinted reply spoke of it before any message of the user's did
  const b = rig();
  b.host.hintDone(b.host.beginHint('早')!, REPLY_TOUCHES);
  assert.equal(b.journal.at(-1)!.first, 'her');
  // theirs: the user spoke of it, then her reply: no hint was needed, and she is not recorded as first
  const c = rig();
  c.host.beginHint('今天我生日！');
  assert.equal(c.journal.at(-1)!.first, 'user');
  // a reply that only answers (user first) on a later hinted turn keeps 'user' as the first
  const d = rig();
  const t1 = d.host.beginHint('早')!;
  d.host.hintDone(t1, REPLY_PLAIN);
  d.host.beginHint('对了今天生日');
  assert.equal(d.journal.at(-1)!.event, 'user-first'); assert.equal(d.journal.at(-1)!.first, 'user');
});

test('her own line: only when calm, before the user talked, daytime, recording on; checked again after the model answers', async () => {
  const notCalm = rig({ calm: false });
  await notCalm.host.tick(); assert.equal(notCalm.state.asks, 0);
  const off = rig({ texts: null });
  await off.host.tick(); assert.equal(off.state.asks, 0);
  const spoke = rig();
  spoke.host.beginHint('早'); await spoke.host.tick(); assert.equal(spoke.state.asks, 0, 'the user already talked: the hint path has it');
  // the user talks while she is still writing: the line is dropped
  const race = rig();
  let release!: () => void;
  const host = new SpecialDayHost({ file: () => path.join(race.dir, 'x.json'), characterId: () => 'c1', folderOn: () => false, recordingTexts: () => BIRTHDAY, journal: () => {},
    now: () => race.state.now, ask: () => new Promise<string>(resolve => { release = () => resolve('生日快乐'); }) });
  const ticking = host.tick();
  host.beginHint('早');
  release(); await ticking;
  assert.equal(host.peek('c1'), null);
  // folder turned on while she wrote
  const folder = rig({ answer: () => { folder.state.folderOn = true; return '生日快乐'; } });
  await folder.host.tick(); assert.equal(folder.host.peek('c1'), null);
  // a failed or unusable answer gives no line, and she tries at most twice
  const bad = rig({ answer: '<b>x</b> C:\\Users\\a' });
  await bad.host.tick(); await bad.host.tick(); await bad.host.tick();
  assert.equal(bad.state.asks, 2); assert.equal(bad.host.peek('c1'), null);
  // the line is never written to disk
  const keep = rig();
  await keep.host.tick(); keep.host.line({ id: 'c', characterId: 'c1' }); keep.host.noteDelivered('c'); await keep.host.idle();
  assert.ok(!readFileSync(path.join(keep.dir, 'special-day.json'), 'utf8').includes('蛋糕'));
});

test('the port is off with the inner loop setting; the keepsake\'s own line goes first, this one next', () => {
  const { host } = rig();
  const off = host.port(() => false);
  assert.equal(off.peek('c1'), null);
  type Claim = { readonly id: string; readonly characterId: string };
  const keepsake = { peek: (_id: string): 'write' | 'tell' | null => 'tell', write: (_id: string, _cue: { readonly id: string; readonly at: number }) => false, line: (_claim: Claim): string | null => '留了东西', counts: (_id: string) => 'k' };
  const none = { peek: (_id: string): 'write' | 'tell' | null => null, write: (_id: string, _cue: { readonly id: string; readonly at: number }) => true, line: (_claim: Claim): string | null => null, counts: (_id: string) => '' };
  const special = { peek: (_id: string): 'tell' | null => 'tell', line: (_claim: Claim): string | null => '生日快乐', counts: (_id: string) => 's' };
  assert.equal(combineTellPorts(keepsake, special).line({ id: 'a', characterId: 'c1' }), '留了东西');
  assert.equal(combineTellPorts(none, special).peek('c1'), 'tell');
  assert.equal(combineTellPorts(none, special).line({ id: 'a', characterId: 'c1' }), '生日快乐');
  assert.equal(combineTellPorts(none, { ...special, peek: () => null }).peek('c1'), null);
  assert.equal(combineTellPorts(none, special).write('c1', { id: 'a', at: 1 }), true);
  assert.equal(combineTellPorts(keepsake, special).counts('c1'), 'k；s');
});

test('「测试：今天是生日」 follows the same switches and starts today over', async () => {
  const off = rig({ texts: null }); assert.equal(off.host.testPretend('birthday'), 'recording-off');
  const folder = rig({ texts: ['喜欢可可'], folderOn: true }); assert.equal(folder.host.testPretend('birthday'), 'folder-on');
  const { host, journal } = rig({ texts: ['喜欢可可'] });
  assert.equal(host.beginHint('早'), null, 'no date known: nothing');
  assert.equal(host.testPretend('anniversary'), 'ok');
  const turn = host.beginHint('早');
  assert.ok(turn); assert.match(turn!.line, /纪念日/u);
  host.hintDone(turn, '纪念日快乐');
  assert.equal(host.beginHint('嗯'), null);
  assert.equal(host.testPretend('anniversary'), 'ok', 'tried again');
  assert.ok(host.beginHint('再来一次'));
  assert.deepEqual(journal.map(e => e.kind), ['anniversary', 'anniversary', 'anniversary']);
});

test('the date source is I-050\'s: the user\'s own entries only, a clear month and day, never a guess', () => {
  assert.equal(datesToday(at(9), BIRTHDAY).length, 1);
  assert.equal(datesToday(at(9), ANNIVERSARY)[0].kind, 'anniversary');
  assert.deepEqual(datesToday(at(9), null), []);
  assert.deepEqual(datesToday(at(9), ['我的生日在十一月']), []);
  assert.deepEqual(datesToday(at(9), BIRTHDAY, 'anniversary').map(d => d.kind).sort(), ['anniversary', 'birthday']);
  assert.equal(mentionsDay('birthday', '生日快乐'), true); assert.equal(mentionsDay('birthday', '今天天气好'), false);
  assert.equal(mentionsDay('anniversary', 'Happy anniversary'), true);
});

test('the journal line holds closed values only, reads back, and says who was first in plain words', () => {
  const secret = '我的生日是11月10日，蛋糕在冰箱';
  const entry = buildJournalEntry({ type: 'special-day', characterId: 'c1', event: 'said', kind: 'birthday', first: 'her', text: secret, reply: secret } as never, at(9))!;
  assert.ok(entry);
  const line = JSON.stringify(entry);
  assert.ok(!line.includes('蛋糕') && !line.includes('11月10日') && !line.includes('text'));
  assert.equal(describeJournalEntry(entry, plain), '09:00 她说起了你的特别的日子（生日，她先提起的）');
  assert.match(describeJournalEntry(buildJournalEntry({ type: 'special-day', characterId: 'c1', event: 'user-first', kind: 'anniversary', first: 'user' }, at(9))!, plain), /你先提起的/u);
  assert.equal(buildJournalEntry({ type: 'special-day', characterId: 'c1', event: 'said', kind: 'birthday', first: 'someone' } as never, at(9)), null);
  assert.equal(buildJournalEntry({ type: 'special-day', characterId: 'c1', event: 'chat', kind: 'birthday', first: null } as never, at(9)), null);
});

test('the day book and her own line are read strictly', () => {
  assert.deepEqual(readBook('nope', at(9)).records, {});
  const book = readBook({ v: 1, records: {
    [`c1|2026-11-10`]: { kind: 'birthday', hints: 99, spoke: true, done: false, first: 'her', closed: false },
    [`c1|2026-01-01`]: { kind: 'birthday', hints: 1 }, ['c1|bad']: { kind: 'birthday' }, [`c1|2026-11-10x`]: { kind: 'x' }, ['c2|2026-11-10']: { kind: 'dinner' },
  } }, at(9));
  assert.deepEqual(Object.keys(book.records), ['c1|2026-11-10']);
  assert.equal(book.records['c1|2026-11-10'].hints, SPECIAL_DAY_LIMITS.maxHints);
  assert.equal(cleanSpokenLine('“生日快乐呀”\n（后面还有一句）'), '生日快乐呀');
  assert.equal(cleanSpokenLine('一'.repeat(SPECIAL_DAY_LIMITS.lineMaxChars + 1)), '');
  assert.equal(cleanSpokenLine('看 https://x.y'), ''); assert.equal(cleanSpokenLine(''), ''); assert.equal(cleanSpokenLine(5), '');
});

test('nothing is created on disk on an ordinary day', async () => {
  const { host, dir } = rig({ texts: ['喜欢可可'] });
  host.beginHint('早'); await host.tick(); await host.idle();
  assert.equal(existsSync(path.join(dir, 'special-day.json')), false);
  void settle;
});
