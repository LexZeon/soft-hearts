// I-179: the mood part's journal lines carry the
// whole mood state (A, F, B, M beside D/O/E/N/C), the id of the turn a chat-caused change belongs to, and a snapshot every five
// minutes. Every line here is made up; none comes from a real journal.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { MoodHost } from '../electron/mood/mood';
import { moodJournalEvent } from '../electron/mood/journal-change';
import { MOOD_SNAPSHOT_EVERY_MS, withMoodNow } from '../electron/memory/journal/mood-snapshots';
import { MoodJournal, type MoodJournalEvent } from '../electron/memory/journal/sources';
import { DEFAULT_MOOD_PARAMETERS, KEEP_SPEECH_INTERVAL, createMoodState } from '../shared/foundation/mood';
import { buildJournalEntry, describeJournalEntry, readJournalLine, type JournalInput } from '../shared/memory/journal';
import type { MoodView } from '../shared/mood/mood-runtime';

const AT = Date.UTC(2026, 10, 22, 8, 0, 0);
const MOOD = { D: 50, O: 52, E: 51, N: 40, C: 12 };
const AFTER = { ...MOOD, O: 58 };
const tr = (source: string, ...values: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_, i) => String(values[Number(i)]));
const sink = () => { const inputs: JournalInput[] = []; return { inputs, accepting: () => on.value, record: (input: JournalInput) => { inputs.push(input); } }; };
const on = { value: true };

const aux = { A: 0.31, F: 0.4, phase: 'light-drowsy', B: { before: 12, after: 0 }, M: { before: 3, after: 0 } };
const event = (extra: Record<string, unknown> = {}) => ({ type: 'mood-event', characterId: 'gene', source: 'chat', before: MOOD, after: AFTER, labelBefore: 'calm', labelAfter: 'close', ...extra });

function view(characterId: string, extra: { activity?: string; fatigue?: boolean } = {}): MoodView {
  return { characterId, parameters: DEFAULT_MOOD_PARAMETERS, snapshot: { primary: 'calm', values: { ...MOOD }, boredom: 4, longing: 1 },
    ...(extra.fatigue ? { fatigue: { A: 0.3, F: 0.2, phase: 'awake' } } : {}), ...(extra.activity ? { herLife: { activity: extra.activity } } : {}) } as unknown as MoodView;
}

test('the new fields are written in a closed shape; lines written before them still read the same', () => {
  const old = buildJournalEntry(event(), AT)!;
  assert.ok(old);
  assert.equal('aux' in old, false); assert.equal('turn' in old, false);
  assert.deepEqual(readJournalLine(JSON.stringify(old)), old);
  const full = buildJournalEntry(event({ aux, turn: 'req-12_ab' }), AT)!;
  assert.deepEqual((full as { aux: unknown }).aux, aux);
  assert.equal((full as { turn: string }).turn, 'req-12_ab');
  assert.deepEqual(readJournalLine(JSON.stringify(full)), full);
  const judge = buildJournalEntry({ type: 'mood-judge', characterId: 'gene', why: 'warmer', before: MOOD, after: AFTER, labelBefore: 'calm', labelAfter: 'close', aux }, AT)!;
  assert.deepEqual((judge as { aux: unknown }).aux, aux);
  const now = { values: MOOD, label: 'calm', A: 0.3, F: 0.2, phase: 'awake', B: 4, M: 1 };
  const book = buildJournalEntry({ type: 'mood-book', characterId: 'gene', by: 'tail', outcome: 'judged', delta: { O: 2 }, now, turn: 'req-12_ab' }, AT)!;
  assert.deepEqual((book as { now: unknown }).now, now);
  assert.equal(readJournalLine(JSON.stringify(book)) !== null, true);
});

test('a field that does not fit is dropped, not the line; text never gets through as a turn id or anywhere else', () => {
  const secret = '我今天被老板骂了，秘密口令是蓝色长颈鹿';
  const entry = buildJournalEntry(event({ aux: { A: 7, phase: 'bogus', B: { before: 'x', after: 1 }, M: { before: 5, after: 6 }, text: secret }, turn: secret, text: secret, message: secret }), AT)!;
  assert.ok(entry, 'the line itself stays');
  assert.deepEqual((entry as { aux: unknown }).aux, { A: 1, M: { before: 5, after: 6 } });
  assert.equal('turn' in entry, false);
  const line = JSON.stringify(entry);
  for (const word of ['老板', '蓝色长颈鹿', 'text', 'message']) assert.ok(!line.includes(word), word);
  const book = buildJournalEntry({ type: 'mood-book', characterId: 'gene', by: 'tail', outcome: 'judged', delta: {}, turn: secret, now: { values: MOOD, label: 'bogus', B: 1, M: 1 } }, AT)!;
  assert.equal('turn' in book, false); assert.equal('now' in book, false);
  assert.ok(!JSON.stringify(book).includes('老板'));
});

test('a snapshot needs the character, the whole mood and a closed time word; it reads as one panel line', () => {
  const body = { type: 'mood-snapshot', characterId: 'gene', when: 'tick', values: MOOD, label: 'calm', B: 3, M: 0, A: 0.3, activity: 'daydream' };
  const entry = buildJournalEntry(body, AT)!;
  assert.ok(entry);
  assert.deepEqual(readJournalLine(JSON.stringify(entry)), entry);
  assert.match(describeJournalEntry(entry, tr), /心情快照.*D 50 O 52 E 51 N 40 C 12.*无聊 3 想念 0.*A 0.3/u);
  const smuggled = JSON.stringify(buildJournalEntry({ ...body, text: '我今天被老板骂了', message: '蓝色长颈鹿', path: 'C:\\x' }, AT));
  for (const word of ['老板', '蓝色长颈鹿', 'text', 'message', 'path']) assert.ok(!smuggled.includes(word), word);
  for (const bad of [{ characterId: null }, { when: 'now' }, { label: 'bogus' }, { values: { D: 1 } }, { B: NaN }, { M: undefined }, { activity: 'x' }])
    assert.equal(buildJournalEntry({ ...body, ...bad }, AT), null, JSON.stringify(bad));
});

test('snapshots: one at the start, one at a character switch, then one every five minutes; none while the switch is off', () => {
  const out = sink(), clock = { now: 0 };
  on.value = true;
  const journal = new MoodJournal(out, () => clock.now);
  const snaps = () => out.inputs.filter(input => input.type === 'mood-snapshot') as Extract<JournalInput, { type: 'mood-snapshot' }>[];
  journal.view(view('gene', { activity: 'daydream', fatigue: true }));
  assert.deepEqual(snaps().map(s => [s.when, s.characterId]), [['start', 'gene']]);
  assert.equal(snaps()[0]!.activity, 'daydream'); assert.equal(snaps()[0]!.A, 0.3);
  for (let i = 0; i < 280; i++) { clock.now += 1000; journal.view(view('gene')); }
  assert.equal(snaps().length, 1, 'four minutes and forty seconds: still the first one');
  clock.now += 20_000; journal.view(view('gene'));
  assert.deepEqual(snaps().map(s => s.when), ['start', 'tick']);
  clock.now += 1000; journal.view(view('akiko'));
  assert.deepEqual(snaps().map(s => s.when), ['start', 'tick', 'switch']);
  on.value = false;
  clock.now += MOOD_SNAPSHOT_EVERY_MS * 3; journal.view(view('akiko'));
  assert.equal(snaps().length, 3, 'switch off: nothing is written or queued');
  on.value = true;
  clock.now += 1000; journal.view(view('akiko'));
  assert.equal(snaps().length, 4, 'one when it is turned on again, not three');
  assert.ok(!JSON.stringify(out.inputs).includes('"text"'));
});

test('MoodHost reports the whole state of an applied change: B and M before and after, A, F, and the turn id for a chat and its appraisal', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sh-i179-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = { now: 1_000_000 }, events: MoodJournalEvent[] = [];
  const host = new MoodHost(root, () => {}, () => clock.now);
  await host.load(); host.activate('gene');
  host.setJournalObserver(e => events.push(e));
  host.event({ type: 'chat', id: 'turn-1', reason: '收到用户聊天' });
  host.event({ type: 'appraisal', id: 'appraisal-1', responseTo: 'turn-1', delta: { O: 5, D: 3 }, context: 'support', reason: '模型自己写的原因' });
  host.event({ type: 'food', id: 'snack-1' });
  assert.deepEqual(events.filter(e => e.type !== 'lift').map(e => [e.type, e.turn ?? null]), [['chat', 'turn-1'], ['appraisal', 'turn-1'], ['food', null]]);
  const chat = events.find(e => e.type === 'chat')!;
  assert.ok(chat.aux, 'aux is there');
  assert.equal(typeof chat.aux!.B!.before, 'number'); assert.equal(typeof chat.aux!.B!.after, 'number');
  assert.equal(typeof chat.aux!.M!.before, 'number');
  for (const e of events) assert.ok(!JSON.stringify(e).includes('老板') && e.aux !== undefined);
  // Through the writer's whitelist the same event still builds, with no reason text anywhere.
  const entry = buildJournalEntry({ ...events.find(e => e.type === 'appraisal')!, type: 'mood-event', source: 'appraisal', reason: undefined }, AT)!;
  assert.ok(entry && (entry as { turn?: string }).turn === 'turn-1');
  assert.ok(!JSON.stringify(entry).includes('模型自己写'));
  await host.flush();
});

test('a mood-book line gets her whole mood from the published view; without a mood it goes as it was', () => {
  const book = { type: 'mood-book', by: 'tail', outcome: 'judged' };
  const withNow = withMoodNow(book, view('gene', { fatigue: true })) as { now?: { B: number; label: string; A: number } };
  assert.equal(withNow.now?.B, 4); assert.equal(withNow.now?.label, 'calm'); assert.equal(withNow.now?.A, 0.3);
  assert.deepEqual(withMoodNow(book, { snapshot: null } as unknown as MoodView), book);
  assert.deepEqual(withMoodNow({ type: 'boredom' }, view('gene')), { type: 'boredom' });
});

test('B and M are read from the states before and after, A, F and the phase from the sleepiness view (nothing invented)', () => {
  const before = { ...createMoodState(0), boredom: 31, longing: 12, values: { ...MOOD }, updatedAt: 0 };
  const after = { ...before, boredom: 0, longing: 0, values: { ...AFTER } };
  const built = moodJournalEvent('gene', after, DEFAULT_MOOD_PARAMETERS, KEEP_SPEECH_INTERVAL, before, { type: 'chat', turn: 'turn-9' }, { A: 0.6, F: 0.7, phase: 'drowsy' });
  assert.deepEqual(built.aux, { A: 0.6, F: 0.7, phase: 'drowsy', B: { before: 31, after: 0 }, M: { before: 12, after: 0 } });
  assert.equal(built.turn, 'turn-9');
  assert.deepEqual(built.before, MOOD); assert.deepEqual(built.after, AFTER);
  assert.deepEqual(moodJournalEvent('gene', after, DEFAULT_MOOD_PARAMETERS, KEEP_SPEECH_INTERVAL, before, { type: 'food' }, undefined).aux, { B: { before: 31, after: 0 }, M: { before: 12, after: 0 } });
});

test('the control window list hides the 5-minute mood snapshots (they stay in the record)', async () => {
  const { journalPanelLines } = await import('../src/memory/JournalPanel');
  const snapshot = { v: 1, at: 1, time: '1970-01-01T00:00:00.001Z', type: 'mood-snapshot', characterId: 'gene', reason: '心情快照' } as never;
  const other = { v: 1, at: 2, time: '1970-01-01T00:00:00.002Z', type: 'mood-label', characterId: 'gene', from: 'calm', to: 'happy', reason: '心情变了' } as never;
  const lines = journalPanelLines({ enabled: true, entries: [snapshot, other] } as never, '', (s: string) => s);
  assert.equal(lines.length, 1);
});
