// 体验记录 (E2) 第一批新记录项 (docs/claude/2026-11-06-journal-batch1.md): reading time, voice timing, capture numbers, blush, her small
// action, sleepiness phase, topmost repairs, launch time, draft filter, and the first-character split. Each one: written while the
// switch is on, silent while it is off, only numbers and closed categories (no text), and the fixed Chinese reason has an English line.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { ChatActionHost } from '../electron/chat-actions-host';
import { FatigueHost } from '../electron/fatigue-host';
import {
  BlushJournal, JournalExtras, ReadingJournal, VoiceTimeJournal, blushMomentInput, blushStageInput, draftFilterInput, fatiguePhaseInput, gestureAnswerOf,
  herGestureInput, topmostFixInput, wavSeconds, READING_IDLE_MS, type BlushMoment,
} from '../electron/journal/extras';
import { MoodHost } from '../electron/mood';
import { PetTopmostGuard, type TopmostWindow } from '../electron/pet-topmost';
import { buildJournalEntry, describeJournalEntry, readJournalLine, type JournalEntry, type JournalInput } from '../shared/journal';
import { ENGLISH_UI_COPY } from '../shared/ui-copy.en';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import { BlushSeen } from '../src/stage/blush-seen';
import { VoiceCaptureStats } from '../src/ui/voice-capture-stats';

// ---------------------------------------------------------------- helpers

/** What the real writer does with the switch (electron/journal/writer.ts): keep a built line while on, nothing while off. */
async function writerOn(_t: TestContext) {
  const on = { value: true }, entries: JournalEntry[] = [];
  const writer = { record: (input: JournalInput) => { if (!on.value) return null; const entry = buildJournalEntry(input, Date.now()); if (entry) entries.push(entry); return entry; },
    accepting: () => on.value, recent: () => [...entries] };
  return { writer, on };
}
/** A sink that only keeps what the real writer would keep (the switch), as built entries. */
const types = (writer: { recent(): JournalEntry[] }) => writer.recent().map(entry => entry.type);
const timers = () => {
  const queue: Array<{ at: number; callback: () => void; id: number }> = []; let now = 0, ids = 0;
  return { set: (callback: () => void, ms: number) => { const id = ++ids; queue.push({ at: now + ms, callback, id }); return id; },
    clear: (handle: unknown) => { const i = queue.findIndex(item => item.id === handle); if (i >= 0) queue.splice(i, 1); },
    advance: (ms: number) => { now += ms; for (const item of queue.filter(entry => entry.at <= now)) { queue.splice(queue.indexOf(item), 1); item.callback(); } } };
};
const segment = (index: number | null, outcome: 'ended' | 'cancelled' | 'error', extra: Partial<{ playbackStart: number; request: number; provider: 'system' | 'bailian'; textLength: number }> = {}) => ({
  kind: 'reply' as const, provider: extra.provider ?? 'system', segmentIndex: index, textLength: extra.textLength ?? 10, outcome,
  t: { ...(extra.request === undefined ? {} : { request: extra.request }), ...(extra.playbackStart === undefined ? {} : { playbackStart: extra.playbackStart }) },
});
const FORBIDDEN_TEXT = /你好|hello world|SECRET-TEXT/;
const english = (source: string, ...values: readonly unknown[]) => (ENGLISH_UI_COPY[source] ?? source).replace(/\{(\d+)\}/g, (_m, i) => String(values[Number(i)]));
const chinese = (source: string, ...values: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_m, i) => String(values[Number(i)]));

// ---------------------------------------------------------------- the whitelist and the fixed reasons

const SAMPLES: JournalInput[] = [
  { type: 'reading-time', characterId: 'gene', firstAudioMs: 620, waitMs: 40, chars: 22, provider: 'system', result: 'played', why: null, firstSinceStart: true },
  { type: 'reading-time', characterId: 'gene', firstAudioMs: null, waitMs: null, chars: 0, provider: 'bailian', result: 'unread', why: 'hidden', firstSinceStart: false },
  { type: 'voice-time', characterId: 'gene', ms: 1800, recognizeMs: 1400, seconds: 3.2, result: 'text', engine: 'local' },
  { type: 'voice-time', characterId: 'gene', ms: null, recognizeMs: null, seconds: null, result: 'no-sound', engine: 'compatible' },
  { type: 'voice-capture', characterId: 'gene', end: 'no-sound', chunks: 94, peak: 0, rms: 0, threshold: 0.0029, sampleRate: 48000, device: 'default', pausedAtStart: true, pausedMs: 2300, seconds: 8.1 },
  { type: 'blush', characterId: 'gene', outcome: 'fired', source: 'words', dO: 4, dE: 2, dN: 0.5 },
  { type: 'blush', characterId: 'gene', outcome: 'blocked', source: 'pat', why: 'cooldown', dO: 1, dE: 0, dN: 0, total: 3, threshold: 6 },
  { type: 'blush', characterId: 'gene', outcome: 'stage', source: null, stage: 'no-cheek' },
  { type: 'her-gesture', characterId: 'gene', gesture: 'wink', answer: 'played', waited: false },
  { type: 'her-gesture', characterId: 'gene', gesture: 'none', answer: null, waited: false },
  { type: 'fatigue-phase', characterId: 'gene', from: 'awake', to: 'light-drowsy', A: 0.71, F: 0.52, W: 0, clock: 0.09, mood: -0.02 },
  { type: 'topmost-fix', characterId: 'gene', outcome: 'forced', visible: true, nth: 2 },
  { type: 'launch-time', characterId: 'gene', ms: 8123 },
  { type: 'draft-filter', characterId: 'gene', english: 1, plan: 2, format: 0, garbled: 0, chars: 140, whole: false },
  { type: 'first-char', characterId: 'gene', ms: 900, pauseTalk: false, carried: false, contentMs: 700, bubbleMs: 760, sinceStartMs: 600_000, sinceLastMs: 45_000 },
];

test('every new line is built from closed values, reads back, has a Chinese reason and an English line for each fixed phrase', () => {
  for (const sample of SAMPLES) {
    const entry = buildJournalEntry(sample, 1_000);
    assert.ok(entry, `${sample.type} builds`);
    assert.deepEqual(readJournalLine(JSON.stringify(entry)), entry, `${sample.type} reads back`);
    assert.ok(entry!.reason.length > 0);
    const zh = describeJournalEntry(entry!, chinese), en = describeJournalEntry(entry!, english);
    assert.match(zh, /[\u4e00-\u9fff]/);
    assert.doesNotMatch(en.replace(/^\d\d:\d\d /, ''), /[\u4e00-\u9fff]/, `English line of ${sample.type}: ${en}`);
  }
});

test('new lines refuse values outside their closed sets; extra keys and free text never reach the line', () => {
  const bad: unknown[] = [
    { type: 'reading-time', characterId: 'gene', firstAudioMs: 1, waitMs: 1, chars: 1, provider: 'somewhere', result: 'played', why: null },
    { type: 'reading-time', characterId: 'gene', firstAudioMs: 1, waitMs: 1, chars: 1, provider: 'system', result: 'played', why: 'cancelled' },
    { type: 'reading-time', characterId: 'gene', firstAudioMs: 1, waitMs: 1, chars: 1, provider: 'system', result: 'unread', why: null },
    { type: 'voice-time', characterId: 'gene', ms: 1, recognizeMs: 1, seconds: 1, result: 'maybe', engine: 'local' },
    { type: 'voice-capture', characterId: 'gene', end: 'stopped', chunks: 1, peak: 0, rms: 0, threshold: 0.01, sampleRate: 16000, device: 'Realtek(R) Audio', pausedAtStart: false, pausedMs: 0, seconds: 1 },
    { type: 'blush', characterId: 'gene', outcome: 'blocked', source: 'pat' },
    { type: 'blush', characterId: 'gene', outcome: 'fired', source: 'pat', why: 'cooldown' },
    { type: 'her-gesture', characterId: 'gene', gesture: 'dance', answer: 'played', waited: false },
    { type: 'her-gesture', characterId: 'gene', gesture: 'wave', answer: null, waited: false },
    { type: 'fatigue-phase', characterId: 'gene', from: 'awake', to: 'awake', A: 0, F: 0, W: 0, clock: 0, mood: 0 },
    { type: 'topmost-fix', characterId: 'gene', outcome: 'maybe', visible: true, nth: 1 },
    { type: 'launch-time', characterId: 'gene', ms: -1 },
  ];
  for (const input of bad) assert.equal(buildJournalEntry(input, 1), null, JSON.stringify(input));
  const sneaky = buildJournalEntry({ type: 'draft-filter', characterId: 'gene', english: 1, plan: 0, format: 0, garbled: 0, chars: 5, whole: true, text: 'SECRET-TEXT 你好', foreground: 'chrome.exe' }, 1)!;
  assert.doesNotMatch(JSON.stringify(sneaky), /SECRET-TEXT|chrome|你好/);
  const gesture = buildJournalEntry({ type: 'her-gesture', characterId: 'gene', gesture: 'wave', answer: 'played', waited: false, reply: 'hello world' }, 1)!;
  assert.doesNotMatch(JSON.stringify(gesture), FORBIDDEN_TEXT);
});

test('first-char keeps working without the split (older callers) and with it', () => {
  const plain = buildJournalEntry({ type: 'first-char', characterId: 'gene', ms: 900, pauseTalk: true, carried: false }, 1) as JournalEntry & { contentMs?: number };
  assert.equal(plain.contentMs, undefined);
  const split = buildJournalEntry({ type: 'first-char', characterId: 'gene', ms: 900, pauseTalk: true, carried: false, contentMs: 700, bubbleMs: 800, sinceStartMs: 5000, sinceLastMs: -3 }, 1) as Extract<JournalEntry, { type: 'first-char' }>;
  assert.deepEqual([split.contentMs, split.bubbleMs, split.sinceStartMs, split.sinceLastMs], [700, 800, 5000, undefined], 'a negative span is dropped');
});

// ---------------------------------------------------------------- 1. reading time

test('reading: one line per reply with first-sound time, wait, characters, voice kind and how it ended', async t => {
  const { writer, on } = await writerOn(t);
  const fake = timers();
  const reading = new ReadingJournal(writer, () => 'gene', fake);
  reading.segment(segment(0, 'ended', { request: 30, playbackStart: 640, provider: 'bailian', textLength: 12 }));
  reading.segment(segment(1, 'ended', { textLength: 20, provider: 'bailian' }));
  assert.equal(writer.recent().length, 0, 'the reply is not over yet');
  fake.advance(READING_IDLE_MS + 1);
  const line = writer.recent()[0] as Extract<JournalEntry, { type: 'reading-time' }>;
  assert.deepEqual([line.type, line.firstAudioMs, line.waitMs, line.chars, line.provider, line.result, line.why, line.firstSinceStart], ['reading-time', 640, 30, 32, 'bailian', 'played', null, true]);
  // A reply cut off after something was heard is partial; one cut before any sound is unread; an error is a failure.
  reading.segment(segment(0, 'ended', { playbackStart: 500 })); reading.segment(segment(1, 'cancelled')); reading.flush();
  reading.segment(segment(0, 'cancelled')); reading.flush();
  reading.segment(segment(0, 'error')); reading.flush();
  const rest = writer.recent().slice(1) as Array<Extract<JournalEntry, { type: 'reading-time' }>>;
  assert.deepEqual(rest.map(e => [e.result, e.why, e.firstSinceStart]), [['partial', 'cancelled', false], ['unread', 'cancelled', false], ['unread', 'failed', false]]);
  // Not read at all: reading off / pet window hidden.
  reading.unread('off'); reading.unread('hidden');
  assert.deepEqual((writer.recent().slice(4) as typeof rest).map(e => [e.result, e.why, e.chars]), [['unread', 'off', 0], ['unread', 'hidden', 0]]);
  // Off: nothing at all, and nothing from the off time appears after switching on.
  on.value = false;
  reading.segment(segment(0, 'ended', { playbackStart: 1 })); reading.unread('off');
  on.value = true; reading.flush(); // a reply heard while off must not turn into a line once the switch is on
  on.value = false; reading.segment(segment(0, 'ended', { playbackStart: 1 })); on.value = true; reading.flush();
  assert.equal(writer.recent().length, 6);
  assert.doesNotMatch(JSON.stringify(writer.recent()), FORBIDDEN_TEXT);
});

test('reading: previews and other speech are not replies; a reply whose start was missed writes nothing', async t => {
  const { writer } = await writerOn(t);
  const reading = new ReadingJournal(writer, () => 'gene', timers());
  reading.segment({ ...segment(null, 'ended'), kind: 'preview' });
  reading.segment({ ...segment(null, 'ended'), kind: 'speech' });
  reading.segment(segment(3, 'ended')); reading.flush();
  assert.deepEqual(types(writer), []);
});

// ---------------------------------------------------------------- 2. voice timing

function wav(seconds: number, rate = 16000): ArrayBuffer {
  const data = Math.round(seconds * rate * 2), buffer = new ArrayBuffer(44 + data), view = new DataView(buffer);
  view.setUint32(0, 0x52494646, false); view.setUint32(4, 36 + data, true); view.setUint32(8, 0x57415645, false);
  view.setUint32(12, 0x666d7420, false); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461, false); view.setUint32(40, data, true);
  return buffer;
}

test('voice timing: end of speech to text, the recognition alone, the clip length, the result; no words kept', async t => {
  const { writer, on } = await writerOn(t);
  const clock = { now: 10_000 };
  const voice = new VoiceTimeJournal(writer, () => 'gene', () => 'local', () => clock.now);
  voice.endpoint(); clock.now += 300;
  assert.equal(await voice.measure(wav(2.5), async () => { clock.now += 1200; return '你好 SECRET-TEXT'; }), '你好 SECRET-TEXT');
  await assert.rejects(voice.measure(wav(1), async () => { clock.now += 50; throw new Error('boom 你好'); }), /boom/);
  await voice.measure(wav(1), async () => { clock.now += 50; return '…'; });
  voice.noSound();
  const lines = writer.recent() as Array<Extract<JournalEntry, { type: 'voice-time' }>>;
  assert.deepEqual(lines.map(l => [l.result, l.ms, l.recognizeMs, l.seconds]), [['text', 1500, 1200, 2.5], ['failed', 50, 50, 1], ['no-words', 50, 50, 1], ['no-sound', null, null, null]]);
  assert.doesNotMatch(JSON.stringify(lines), FORBIDDEN_TEXT);
  on.value = false;
  await voice.measure(wav(1), async () => 'x'); voice.noSound();
  assert.equal(writer.recent().length, 4);
  assert.equal(wavSeconds(wav(3)), 3);
  assert.equal(wavSeconds(new ArrayBuffer(10)), null);
});

// ---------------------------------------------------------------- the capture numbers (user: "只显示正在聆听，提示没有声音")

test('capture numbers: chunks, peak, RMS, gate, sample rate, device kind and the speaking pause; nothing else', async t => {
  const stats = new VoiceCaptureStats();
  stats.begin(true);
  stats.chunk(new Float32Array(4800), 48000);            // digital silence
  stats.chunk(Float32Array.from([0.5, -0.5, 0.5, -0.5]), 48000);
  stats.paused(2.3);
  const report = stats.report('no-sound', 0.0029)!;
  assert.deepEqual([report.chunks, report.peak, report.rms, report.threshold, report.sampleRate, report.device, report.pausedAtStart, report.pausedMs],
    [2, 0.5, 0.5, 0.0029, 48000, 'default', true, 2300]);
  assert.equal(stats.report('stopped', 0.01), null, 'the silent-microphone report already told this capture');
  const quiet = new VoiceCaptureStats(); quiet.begin(false);
  assert.equal(quiet.report('stopped', 0.01), null, 'a capture that heard nothing and never failed says nothing');
  assert.equal(quiet.report('failed', 0.01)?.chunks, 0, 'a failed capture is always told');
  // Through the host: only the pet or any window, numbers only; a bad value is dropped; the switch decides.
  const { writer, on } = await writerOn(t);
  const extras = new JournalExtras({ sink: writer, characterId: () => 'gene', engine: () => 'local', uptimeMs: () => 5000, blushStage: () => {} });
  assert.equal(extras.fact('voice-capture', report, false), true);
  assert.equal(extras.fact('voice-capture', { ...report, device: 'Microphone (Realtek)' }, false), false, 'a device name is refused');
  on.value = false;
  assert.equal(extras.fact('voice-capture', report, false), false, 'off: nothing');
  assert.equal(writer.recent().length, 1);
  const line = writer.recent()[0] as Extract<JournalEntry, { type: 'voice-capture' }>;
  assert.deepEqual([line.end, line.chunks, line.peak, line.device], ['no-sound', 2, 0.5, 'default']);
});

// ---------------------------------------------------------------- 3. blush

const moment = (over: Partial<BlushMoment> = {}): BlushMoment => ({ characterId: 'gene', event: { type: 'chat', context: 'support' }, before: { cue: null, lastBlushAt: null, now: 1_000_000 },
  profile: { enabled: true, intensity: 35, cooldownMs: 60_000 }, gated: false, raised: false, applied: { O: 0.4, E: 0.2, N: 0 }, total: 0.4, threshold: 6, ...over });

test('blush: fired, and every way it can be held back', () => {
  const kind = (m: BlushMoment) => { const i = blushMomentInput(m) as Extract<JournalInput, { type: 'blush' }> | null; return i && [i.outcome, i.source, i.why]; };
  assert.deepEqual(kind(moment({ raised: true })), ['fired', 'words', undefined]);
  assert.deepEqual(kind(moment()), ['blocked', 'words', 'threshold']);
  assert.deepEqual(kind(moment({ before: { cue: { until: 1_000_500 }, lastBlushAt: 999_000, now: 1_000_000 } })), ['blocked', 'words', 'showing']);
  assert.deepEqual(kind(moment({ before: { cue: null, lastBlushAt: 970_000, now: 1_000_000 } })), ['blocked', 'words', 'cooldown']);
  assert.deepEqual(kind(moment({ profile: { enabled: true, intensity: 0, cooldownMs: 60_000 } })), ['blocked', 'words', 'off']);
  assert.deepEqual(kind(moment({ gated: true })), ['blocked', 'words', 'off']);
  assert.deepEqual(kind(moment({ event: { type: 'rua' } })), ['blocked', 'pat', 'threshold']);
  assert.equal(kind(moment({ event: { type: 'chat', context: 'neutral' } })), null, 'not a candidate');
  assert.equal(kind(moment({ applied: null })), null, 'the event was not applied');
  const pat = blushMomentInput(moment({ event: { type: 'rua' }, total: 4.5 })) as Extract<JournalInput, { type: 'blush' }>;
  assert.deepEqual([pat.dO, pat.dE, pat.total, pat.threshold], [0.4, 0.2, 4.5, 6]);
});

test('blush: a held-back moment of the same kind is written at most once per 20 s; firings and stage answers always', async t => {
  const { writer, on } = await writerOn(t);
  const clock = { now: 0 }, journal = new BlushJournal(writer, () => clock.now);
  const blocked = () => journal.moment(blushMomentInput(moment({ event: { type: 'rua' } })));
  blocked(); clock.now += 5_000; blocked(); clock.now += 16_000; blocked();
  journal.moment(blushMomentInput(moment({ raised: true }))); journal.moment(blushMomentInput(moment({ raised: true })));
  journal.moment(blushStageInput('gene', 'no-cheek')); journal.moment(blushStageInput('gene', 'not-a-state'));
  assert.deepEqual(writer.recent().map(e => e.type === 'blush' && [e.outcome, e.stage ?? e.why ?? null]), [['blocked', 'threshold'], ['blocked', 'threshold'], ['fired', null], ['fired', null], ['stage', 'no-cheek']]);
  on.value = false; journal.moment(blushMomentInput(moment({ raised: true })));
  assert.equal(writer.recent().length, 5);
});

test('blush on the real MoodHost: warm words fire once, then the next ones are held back for the real reason', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sh-blush-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { now: Date.UTC(2026, 10, 6, 15, 0, 0) }, seen: Array<ReturnType<typeof blushMomentInput>> = [];
  const host = new MoodHost(directory, () => {}, () => clock.now);
  await host.load();
  host.activate('gene', structuredClone(DEFAULT_MOOD_PARAMETERS));
  host.setBlushJournal(m => seen.push(blushMomentInput(m)));
  const warm = (id: string) => host.event({ type: 'chat', id, delta: { O: 4, E: 2 }, context: 'support', reason: '收到用户聊天' });
  warm('warm-1'); clock.now += 2_000; host.tick(true); warm('warm-2'); clock.now += 10_000; host.tick(true); warm('warm-3');
  clock.now += 10 * 60_000; host.tick(true);
  host.event({ type: 'chat', id: 'plain-1', delta: { O: 1 }, context: 'neutral', reason: '收到用户聊天' });
  const rows = seen.map(i => i && i.type === 'blush' ? [i.outcome, i.why ?? null] : null);
  assert.deepEqual(rows[0], ['fired', null]);
  assert.deepEqual(rows[1], ['blocked', 'showing']);
  assert.deepEqual(rows[2], ['blocked', 'cooldown']);
  assert.equal(rows.length, 3, 'a neutral message is no candidate');
  await host.flush().catch(() => {});
});

// ---------------------------------------------------------------- 4. her small action

test('her small action: the word and the stage answer, a pick that waited, a dropped one, none, and a mood hold', () => {
  const lines: Array<[string | null, string | null, boolean]> = [];
  const fake = timers();
  let speaking = false;
  const host = new ChatActionHost({ modelPath: () => 'm', read: async () => null, play: async () => ({ status: 'played', missing: [], detail: '' }), speaking: () => speaking,
    timers: fake, journal: (word, answer, waited) => { lines.push([word, answer, waited]); } });
  host.request('wink');
  return Promise.resolve().then(() => Promise.resolve()).then(() => {
    assert.deepEqual(lines, [['wink', 'played', false]]);
    speaking = true; host.request('pout');
    host.request('wink'); // replaces the waiting pick: the waiting one is dropped
    assert.deepEqual(lines.slice(1)[0], ['pout', 'dropped', true]);
    host.noted(null, null); host.noted('nod', 'held');
    assert.deepEqual(lines.slice(-2), [[null, null, false], ['nod', 'held', false]]);
    assert.equal(gestureAnswerOf('missing'), 'cannot'); assert.equal(gestureAnswerOf('busy'), 'busy'); assert.equal(gestureAnswerOf('no-window'), 'failed');
    const none = buildJournalEntry(herGestureInput('gene', null, null), 1) as Extract<JournalEntry, { type: 'her-gesture' }>;
    assert.deepEqual([none.gesture, none.answer], ['none', null]);
  });
});

// ---------------------------------------------------------------- 5. sleepiness phase

test('sleepiness phase: from -> to with A, F, W and the clock and mood terms, once per change', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sh-fatigue-journal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let mono = 0, wall = 1_790_000_000_000;
  await writeFile(path.join(dir, 'fatigue-state.json'), JSON.stringify({ version: 1, profiles: [{ characterId: 'gene', A: 0.97, F: 0.8, W: 0, phase: 'awake', wallMs: wall }] }));
  const host = new FatigueHost(dir, { monotonicMs: () => mono, wallMs: () => wall, localMinute: () => 1400 });
  await host.load();
  const channels = { D: 50, O: 50, E: 50, N: 50, C: 50 };
  const changes: Array<Parameters<typeof fatiguePhaseInput>[0]> = [];
  host.setPhaseObserver(change => changes.push(change));
  host.activate('gene', channels, channels);
  for (let i = 0; i < 400 && !changes.length; i++) { mono += 5_000; wall += 5_000; host.update('gene', channels, channels); }
  assert.equal(changes.length, 1, 'one change');
  const c = changes[0];
  assert.equal(c.characterId, 'gene'); assert.notEqual(c.from, c.to);
  assert.ok(c.clock >= 0 && c.clock <= 0.12, `clock term ${c.clock}`); assert.ok(Math.abs(c.mood) <= 0.08, `mood term ${c.mood}`);
  for (const n of [c.A, c.F, c.W]) assert.ok(n >= 0 && n <= 1);
  const entry = buildJournalEntry(fatiguePhaseInput(c), 1) as Extract<JournalEntry, { type: 'fatigue-phase' }>;
  assert.ok(entry, 'the line builds');
  assert.equal(entry.A, Math.round(c.A * 100) / 100, 'two decimals');
});

// ---------------------------------------------------------------- 6. topmost, 7. launch, draft filter

test('topmost repairs: one line per repair that put the style back, with the count; nothing for a window that is fine', () => {
  const calls: Array<[string, boolean, number]> = [];
  class Win implements TopmostWindow {
    top = true; isDestroyed() { return false; } isVisible() { return true; } isMinimized() { return false; } isAlwaysOnTop() { return this.top; }
    setAlwaysOnTop(flag: boolean) { this.top = flag; } moveTop() {}
  }
  const win = new Win();
  const guard = new PetTopmostGuard({ window: () => win, wanted: () => true, journal: (outcome, visible, nth) => { calls.push([outcome, visible, nth]); } });
  guard.check(); assert.deepEqual(calls, []);
  win.top = false; guard.check(); win.top = false; guard.check();
  assert.deepEqual(calls, [['applied', true, 1], ['applied', true, 2]]);
  assert.ok(buildJournalEntry(topmostFixInput('gene', 'applied', true, 2), 1));
});

test('launch time is told once, only by the pet window', async t => {
  const { writer } = await writerOn(t);
  const extras = new JournalExtras({ sink: writer, characterId: () => 'gene', engine: () => 'local', uptimeMs: () => 7777, blushStage: () => {} });
  assert.equal(extras.fact('launch', null, false), false);
  assert.equal(extras.fact('launch', null, true), true);
  assert.equal(extras.fact('launch', null, true), false);
  assert.deepEqual(writer.recent().map(e => e.type === 'launch-time' && e.ms), [7777]);
});

test('draft filter: counts per group and the whole-reply flag, nothing when nothing was cut', () => {
  assert.equal(draftFilterInput('gene', [], false), null);
  const input = draftFilterInput('gene', [{ kind: 'english-note', chars: 40 }, { kind: 'mixed-note', chars: 10 }, { kind: 'draft-block', chars: 90 }, { kind: 'wrapper-tag', chars: 8 }, { kind: 'mojibake', chars: 3 }], true)!;
  const entry = buildJournalEntry(input, 1) as Extract<JournalEntry, { type: 'draft-filter' }>;
  assert.deepEqual([entry.english, entry.plan, entry.format, entry.garbled, entry.chars, entry.whole], [2, 1, 1, 1, 151, true]);
});

// ---------------------------------------------------------------- the pet window's blush stage state, and the first-character split

test('stage state of a blush cue is told once per cue, with the reason it cannot be shown', () => {
  const seen = new BlushSeen(), base = { path: 'procedural' as const, faceBlocked: false, off: false, size: 50 };
  assert.equal(seen.observe(null, base), null);
  assert.equal(seen.observe('a', base), 'shown');
  assert.equal(seen.observe('a', base), null);
  assert.equal(seen.observe('b', { ...base, path: 'none' }), 'no-cheek');
  assert.equal(seen.observe('c', { ...base, faceBlocked: true }), 'face-busy');
  assert.equal(seen.observe('d', { ...base, off: true }), 'off');
  assert.equal(seen.observe('e', { ...base, size: 0 }), 'size-zero');
});

test('first-character split: content and bubble times from the record, the time since start and since the last reply', async t => {
  const { writer } = await writerOn(t);
  const extras = new JournalExtras({ sink: writer, characterId: () => 'gene', engine: () => 'local', uptimeMs: () => 90_000, blushStage: () => {} });
  const first = extras.firstChar({ firstContentMs: 700, firstBubbleMs: null });
  assert.equal(first.contentMs, 700); assert.equal(first.bubbleMs, undefined); assert.ok(first.sinceStartMs >= 90_000 - 5); assert.equal(first.sinceLastMs, undefined);
  const second = extras.firstChar({ firstContentMs: 650, firstBubbleMs: 700 });
  assert.ok(second.sinceLastMs !== undefined && second.sinceLastMs >= 0);
});
