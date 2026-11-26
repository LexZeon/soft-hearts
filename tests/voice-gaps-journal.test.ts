// 2026-11-24 每一句话都停 / 有一句话没读出来 (docs/claude/2026-11-24-voice-gaps.md): items 2 (a cancel always has a cause), 3 (per-sentence timing),
// 4 (where a reply's text stopped arriving) and 5 (a first-char row says when a timer wrote it). Numbers and closed words only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplyLatencyProbe, type ReplyLatencyRecord } from '../electron/brain/reply-latency';
import { StreamGapProbe, pendingOf, streamGapsInput } from '../electron/brain/stream-gaps';
import { JournalExtras, ReadingJournal } from '../electron/memory/journal/extras';
import { ReadCancelCauses } from '../electron/voice/read-cancel-cause';
import { ReadNotes } from '../electron/voice/read-notes';
import { SegmentTimings, segmentTiming } from '../electron/voice/segment-timings';
import { buildJournalEntry, describeJournalEntry, readJournalLine, type JournalEntry, type JournalInput } from '../shared/memory/journal';
import { READING_CANCEL_BYS, validateSpeechDiagnosticRecord } from '../shared/voice';
import { ENGLISH_UI_COPY } from '../shared/foundation/ui-copy.en';

const plain = (s: string, ...v: readonly unknown[]) => s.replace(/\{(\d+)\}/g, (_m, i) => String(v[Number(i)]));
function reading(extra: { causes?: ReadCancelCauses; notes?: ReadNotes } = {}) {
  if (extra.causes && !extra.notes) extra.notes = new ReadNotes(() => extra.causes!.clear());
  const written: JournalEntry[] = [];
  const sink = { record: (input: JournalInput) => { const e = buildJournalEntry(input, 1); if (e) written.push(e); return e; }, accepting: () => true };
  const journal = new ReadingJournal(sink as never, () => 'c1', { set: () => 0, clear: () => {} }, undefined, extra.causes, extra.notes);
  return { journal, written, rows: <T extends JournalEntry['type']>(type: T) => written.filter(e => e.type === type) as Array<Extract<JournalEntry, { type: T }>> };
}
const rec = (index: number | null, outcome: 'ended' | 'cancelled' | 'error', more: Record<string, unknown> = {}) =>
  ({ kind: 'reply' as const, provider: 'fish' as const, segmentIndex: index, textLength: 11, outcome, t: {}, ...more });

// ---------------------------------------------------------------- 2. every cancelled reading says who cancelled it

test('a cancelled reading always has a cause: the host\'s note first, then the window\'s own, and "unlogged" when no path gave one', () => {
  const causes = new ReadCancelCauses();
  const h = reading({ causes });
  h.journal['notes']!.numberOf('r1'); // the reply began; a cancel noted now (even before its first record arrives) belongs to it
  causes.note('interrupt');
  h.journal.segment(rec(0, 'cancelled', { cancelBy: 'voice-input' })); h.journal.flush();
  h.journal.segment(rec(0, 'cancelled', { cancelBy: 'voice-input' })); h.journal.flush();
  h.journal.segment(rec(0, 'cancelled')); h.journal.flush();
  assert.deepEqual(h.rows('reading-time').map(r => [r.why, r.cancelBy]), [['cancelled', 'interrupt'], ['cancelled', 'voice-input'], ['cancelled', 'unlogged']],
    'host note beats the window\'s word; a window word beats nothing; nothing is "unlogged", never an absent field');
  assert.ok(h.rows('reading-time').every(r => r.cancelBy !== undefined), 'no cancelled row is written without a cause');
  assert.match(describeJournalEntry(h.rows('reading-time')[2], plain), /有一条取消的路没记原因/);
});

test('the cancelled record from the window carries a closed cause only, and only when it was cancelled', () => {
  const base = { v: 1, provider: 'fish', voice: 'v', kind: 'reply', segmentIndex: 0, textLength: 5, outcome: 'cancelled', errorCode: null, t: { queued: 0 }, hostFirstAudioMs: null, baseLatencyMs: null,
    outputLatencyMs: null, clockLagMs: null, startLeadMs: null, deviceColdStartMs: null, sendToFirstAudioMs: null, interSegmentGapMs: null, stalls: 0, quickEnd: false };
  for (const word of READING_CANCEL_BYS) assert.equal(validateSpeechDiagnosticRecord({ ...base, cancelBy: word })?.cancelBy, word);
  assert.equal(validateSpeechDiagnosticRecord({ ...base, cancelBy: '我想停下来' }), null, 'a word outside the list rejects the record');
  assert.equal(validateSpeechDiagnosticRecord({ ...base, outcome: 'ended', cancelBy: 'stop' }), null, 'a reading that was not cancelled has no cancel cause');
  assert.equal(validateSpeechDiagnosticRecord(base)?.cancelBy, undefined, 'an old window\'s record still validates');
});

// ---------------------------------------------------------------- 3. per-sentence timing

test('one row per reply lists each sentence\'s synthesis time, the silence before it played and its provider; no text', () => {
  const notes = new ReadNotes(); notes.numberOf('reply-x');
  const h = reading({ notes });
  h.journal.segment(rec(0, 'ended', { t: { request: 10, firstPacket: 430, playbackStart: 500 }, hostFirstAudioMs: 380, interSegmentGapMs: null }));
  h.journal.segment(rec(1, 'ended', { t: { request: 5000, firstPacket: 14400, playbackStart: 14500 }, hostFirstAudioMs: 9000, interSegmentGapMs: 8100 }));
  h.journal.segment(rec(2, 'cancelled', { t: {}, interSegmentGapMs: null, cancelBy: 'stop' }));
  h.journal.flush();
  const [row] = h.rows('reading-segments');
  assert.equal(row.reply, 1);
  assert.deepEqual(row.segments, [
    { synthMs: 420, silenceMs: null, provider: 'fish', outcome: 'ended' },
    { synthMs: 9400, silenceMs: 8100, provider: 'fish', outcome: 'ended' },
    { synthMs: null, silenceMs: null, provider: 'fish', outcome: 'cancelled' }]);
  assert.match(describeJournalEntry(row, plain), /第 2 句 Drama 3 合成 9\.40 秒、前面空了 8\.10 秒/);
  assert.equal(h.rows('reading-time')[0].reply, 1, 'the reading row carries the same reply number');
  assert.doesNotMatch(JSON.stringify(h.written), /reply-x|句要读/);
});

test('timings: the host\'s own number stands in when the window\'s stages are missing; the system voice measures nothing and writes no row', () => {
  assert.equal(segmentTiming({ provider: 'bailian', outcome: 'ended', t: {}, hostFirstAudioMs: 250 }).synthMs, 250);
  const quiet = reading();
  quiet.journal.segment({ ...rec(0, 'ended'), provider: 'system' as never, t: { playbackStart: 300 } }); quiet.journal.flush();
  assert.equal(quiet.rows('reading-segments').length, 0);
  const many = new SegmentTimings();
  for (let i = 0; i < 100; i++) many.add({ provider: 'fish', outcome: 'ended', t: { request: 0, firstPacket: 10 } });
  assert.equal(many.take(null)!.segments.length, 64, 'a row lists at most 64 sentences');
  assert.equal(many.take(null), null, 'taken once');
  assert.equal(buildJournalEntry({ type: 'reading-segments', characterId: 'c', segments: [{ synthMs: 1, silenceMs: 2, provider: 'fish', outcome: 'perhaps' }] } as never, 1), null, 'a word outside the lists rejects the row');
});

// ---------------------------------------------------------------- 4. where a reply's text stopped arriving

test('stream gaps: the largest gap between raw chunks and between the deltas that left the host, where it fell, and what was pending', () => {
  let now = 0;
  const probe = new StreamGapProbe(() => now);
  const chunk = (at: number, text: string, shown: number) => { now = at; probe.raw(text, shown); };
  chunk(0, '[开心]你', 0); chunk(100, '好，我们', 2); chunk(24_200, '一起去（', 6); // 24.1 s of silence after "好，我们"
  chunk(24_300, '看看）。', 8);
  now = 100; probe.shown(2); now = 120; probe.shown(4); now = 24_210; probe.shown(3);
  const r = probe.result()!;
  assert.deepEqual([r.chunks, r.rawGapMs, r.rawGapAt, r.shownGapMs, r.shownGapAt], [4, 24_100, 9, 24_090, 6]);
  assert.equal(r.rawPending, 'held', 'something the protocol had not let through yet (the opening marker) was pending');
  const entry = buildJournalEntry(streamGapsInput('c1', probe)!, 1) as Extract<JournalEntry, { type: 'stream-gaps' }>;
  assert.match(describeJournalEntry(entry, plain), /24\.10 秒/);
  assert.doesNotMatch(JSON.stringify(entry), /好|开心|看看/, 'no text');
  assert.equal(pendingOf('我们一起（', 0), 'open-tag'); assert.equal(pendingOf('这是**', 0), 'emphasis'); assert.equal(pendingOf('好了。', 0), 'none'); assert.equal(pendingOf('好了。', 3), 'held');
  assert.equal(new StreamGapProbe(() => 0).result(), null, 'a reply with no chunk writes nothing');
  const single = new StreamGapProbe(() => 5); single.raw('一', 0);
  assert.deepEqual(single.result(), { chunks: 1, rawGapMs: null, shownGapMs: null });
});

test('every new line has an English reading with no Chinese left in it', () => {
  const english = (s: string, ...v: readonly unknown[]) => (ENGLISH_UI_COPY[s] ?? s).replace(/\{(\d+)\}/g, (_m, i) => String(v[Number(i)]));
  const inputs: JournalInput[] = [
    { type: 'speech', characterId: 'c', provider: 'fish', failure: 'network', kind: 'network', retried: true, reply: 3, segment: 1 },
    { type: 'speech', characterId: 'c', provider: 'fish', failure: 'service', kind: 'http-5xx' },
    ...READING_CANCEL_BYS.map(cancelBy => ({ type: 'reading-time', characterId: 'c', firstAudioMs: null, waitMs: null, chars: 9, provider: 'fish', result: 'unread', why: 'cancelled', firstSinceStart: false, cancelBy, reply: 2 }) as JournalInput),
    { type: 'reading-time', characterId: 'c', firstAudioMs: null, waitMs: null, chars: 9, provider: 'fish', result: 'unread', why: 'failed', firstSinceStart: false, afterRetry: true },
    { type: 'reading-segments', characterId: 'c', reply: 2, segments: [{ synthMs: 400, silenceMs: null, provider: 'fish', outcome: 'ended' }, { synthMs: null, silenceMs: 90, provider: 'system', outcome: 'cancelled' }, { synthMs: 5, silenceMs: 6, provider: 'bailian', outcome: 'error' }] },
    { type: 'stream-gaps', characterId: 'c', chunks: 4, rawGapMs: 24_100, rawGapAt: 8, rawPending: 'emphasis', shownGapMs: 100, shownGapAt: 2 },
    { type: 'stream-gaps', characterId: 'c', chunks: 1, rawGapMs: null, shownGapMs: null },
    { type: 'first-char', characterId: 'c', ms: 1959, pauseTalk: false, carried: false, endedBy: 'settle-timeout' },
  ];
  for (const input of inputs) {
    const text = describeJournalEntry(buildJournalEntry(input, 1)!, english);
    assert.ok(!/[一-鿿]/u.test(text), text);
  }
});

// ---------------------------------------------------------------- 5. a first-char row says when the timer wrote it

function latencyFixture() {
  let now = 0; const timers = new Map<number, () => void>(); let next = 0; const lines: ReplyLatencyRecord[] = [];
  const probe = new ReplyLatencyProbe({ enabled: () => true, file: () => null, surface: () => ({ setObserver: () => {} }), now: () => now, wallNow: () => 1_800_000_000_000,
    log: () => {}, write: async () => {}, settleMs: 15_000, onRecord: record => lines.push(record),
    timers: { set: callback => { timers.set(++next, callback); return next; }, clear: handle => { timers.delete(handle as number); } } });
  return { probe, lines, at: (ms: number) => { now = ms; }, fire: () => { for (const [id, cb] of [...timers]) { timers.delete(id); cb(); } } };
}

test('first-char: a record closed by the settle timer says so; one painted in full does not; the journal line keeps the word', () => {
  const timer = latencyFixture();
  timer.at(0); timer.probe.begin('a', 'claude', 1_799_999_999_990);
  timer.at(1000); timer.probe.delta('a', '你好。'); timer.at(1100); timer.probe.painted('你好'); // the last character never gets painted
  timer.at(1500); timer.probe.complete('a'); timer.probe.end('a', false);
  timer.at(16_500); timer.fire();
  assert.equal(timer.lines[0].endedBy, 'settle-timeout');
  const whole = latencyFixture();
  whole.at(0); whole.probe.begin('b', 'claude'); whole.at(900); whole.probe.delta('b', '好。'); whole.at(950); whole.probe.painted('好。'); whole.at(1000); whole.probe.complete('b'); whole.probe.end('b', false);
  assert.equal(whole.lines[0].endedBy, undefined);
  const extras = new JournalExtras({ sink: { record: () => null } as never, characterId: () => 'c', engine: () => 'local', uptimeMs: () => 1000, blushStage: () => {} });
  const fields = extras.firstChar(timer.lines[0] as never);
  assert.equal(fields.endedBy, 'settle-timeout'); assert.equal(extras.firstChar(whole.lines[0] as never).endedBy, undefined);
  const entry = buildJournalEntry({ type: 'first-char', characterId: 'c', ms: 1959, pauseTalk: false, carried: false, ...fields }, 1)!;
  assert.equal((entry as { endedBy?: string }).endedBy, 'settle-timeout');
  assert.match(describeJournalEntry(entry, plain), /定时器收尾时写的/);
  assert.equal((buildJournalEntry({ type: 'first-char', characterId: 'c', ms: 5, pauseTalk: false, carried: false, endedBy: 'later' } as never, 1) as { endedBy?: string }).endedBy, undefined, 'only the closed word is kept');
  assert.equal(readJournalLine(JSON.stringify(entry))?.type, 'first-char');
});
