// 2026-11-24 12:26 and 12:34 (dev app, voice input + Fish voice, full-screen Unbound; docs/claude/2026-11-24-voice-bubble-1226-1234.md).
//  12:26 "没读出来，字直接全部输出了": a reply (journal: 60 characters streamed 20:25:58.5 to 20:26:00.4) was shown and never read: no reading row,
//        no mouth row at the next send, the microphone that opened right after it was never paused. Nothing said which road dropped it.
//  12:34 "gene 有朗读，没有字泡": the bubble half (electron/unbound/bubble-hold.ts pause) is in tests/bubble-hold-read-pause.test.ts.
// Here: the promise that a reply shown while read-aloud is on is read, or has a reading row that says why not. No Claude, no network, no Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { CompanionService } from '../electron/brain/companion';
import { VoiceChatHost } from '../electron/voice/voice-chat-host';
import { JournalExtras } from '../electron/memory/journal/extras';
import { ReadingLedger } from '../electron/voice/reading-ledger';
import { handoverVerdict } from '../electron/voice/speech-handover';
import { encodeWav } from '../src/senses/MediaInput';
import { reportReadingDropped, speechDropWhy } from '../src/voice/reading-dropped';
import { buildJournalEntry, type JournalEntry, type JournalInput } from '../shared/memory/journal';
import { READING_CANCEL_BYS } from '../shared/voice';

// ---------------------------------------------------------------- the journal side: a fake clock and a recording sink

function journal() {
  const rows: JournalEntry[] = [];
  const timers = new Map<number, { at: number; fn: () => void }>();
  let now = 0, next = 0;
  const extras = new JournalExtras({
    sink: { record: (input: JournalInput) => { const e = buildJournalEntry(input, 1); if (e) rows.push(e); return e; }, accepting: () => true } as never,
    characterId: () => 'c1', engine: () => 'local', uptimeMs: () => 0,
    timers: { set: (fn: () => void, ms: number) => { const id = ++next; timers.set(id, { at: now + ms, fn }); return id; }, clear: (id: unknown) => { timers.delete(id as number); } },
  } as never);
  const advance = (ms: number) => { const end = now + ms; for (;;) { const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; timers.delete(due[0]); now = due[1].at; due[1].fn(); } now = end; };
  return { extras, rows, advance, reading: () => rows.filter(r => r.type === 'reading-time') as Array<Extract<JournalEntry, { type: 'reading-time' }>> };
}

/** The promise: a row that says a reply was not read always says why (a reason word for 'cancelled', a cause word for every cancelled one). */
function assertUnreadHasCause(rows: ReturnType<ReturnType<typeof journal>['reading']>): void {
  for (const row of rows) {
    if (row.result !== 'unread') continue;
    assert.ok(row.why !== null, 'an unread reply has a reason');
    if (row.why === 'cancelled') assert.ok(row.cancelBy && (READING_CANCEL_BYS as readonly string[]).includes(row.cancelBy), 'a cancelled reading names who cancelled it, from the closed list');
  }
}

test('12:26: a reply handed to her voice that the voice never asks for becomes a row, "not-asked", after the journal\'s idle time', () => {
  const h = journal();
  h.extras.readingLedger.expect('reply-a'); // the host sent the 'speech' event for the 60-character reply
  h.advance(14_000);
  assert.equal(h.reading().length, 0, 'the voice may still be starting');
  h.advance(2_000);
  assert.equal(h.reading().length, 1, 'no reading row, no mouth row, no cause: now it has one');
  assert.deepEqual([h.reading()[0].result, h.reading()[0].why, h.reading()[0].cancelBy], ['unread', 'cancelled', 'not-asked']);
  assertUnreadHasCause(h.reading());
});

test('a reply her voice does ask for leaves no extra row (the ordinary reading row is the record)', () => {
  const h = journal();
  h.extras.readingLedger.expect('reply-b');
  h.extras.readNotes.numberOf('reply-b'); // her voice asked for the first sentence: the host numbers the reply here
  h.advance(60_000);
  assert.equal(h.reading().length, 0);
  assert.equal(h.extras.readingLedger.waiting, 0);
});

test('a window that dropped the reading before it began tells why, and that word is the cause (the generic one only when nobody said)', () => {
  const h = journal();
  assert.equal(h.extras.fact('reading-dropped', { why: 'not-shown' }, false), true);
  h.extras.readingLedger.expect('reply-c');
  h.advance(16_000);
  assert.equal(h.reading()[0].cancelBy, 'not-shown');
  assert.equal(h.extras.fact('reading-dropped', { why: 'rm -rf' }, false), false, 'only the closed words');
  assert.equal(h.extras.fact('reading-dropped', 'chat-busy', false), false);
  assertUnreadHasCause(h.reading());
});

test('a reply the host decides not to hand over is written at once with its reason', () => {
  const h = journal();
  h.extras.readingLedger.notHanded('newer-line');
  h.extras.readingLedger.notHanded('no-appraisal');
  assert.deepEqual(h.reading().map(r => [r.result, r.why, r.cancelBy]), [['unread', 'cancelled', 'newer-line'], ['unread', 'cancelled', 'no-appraisal']]);
  assertUnreadHasCause(h.reading());
});

test('with the journal off nothing is written and nothing breaks', () => {
  const written: unknown[] = [];
  const extras = new JournalExtras({ sink: { record: (input: unknown) => { written.push(input); return null; }, accepting: () => false } as never, characterId: () => null, engine: () => 'local', uptimeMs: () => 0,
    timers: { set: () => 0, clear: () => {} } } as never);
  extras.readingLedger.notHanded('newer-line');
  extras.readingLedger.expect('x');
  assert.deepEqual(written, []);
});

test('the ledger never waits for more than eight replies: the oldest is settled when a ninth comes', () => {
  const lines: string[] = [];
  const ledger = new ReadingLedger({ timers: { set: () => 1, clear: () => {} }, idleMs: 15_000, write: by => { lines.push(by); } });
  for (let i = 0; i < 9; i++) ledger.expect(`r${i}`);
  assert.equal(ledger.waiting, 8);
  assert.deepEqual(lines, ['not-asked']);
});

test('the noted cause is taken once: it is not filed on a second reply', () => {
  const h = journal();
  h.extras.readCancel.note('stop');
  h.extras.readingLedger.expect('one'); h.advance(16_000);
  h.extras.readingLedger.expect('two'); h.advance(16_000);
  assert.deepEqual(h.reading().map(r => r.cancelBy), ['stop', 'not-asked']);
});

// ---------------------------------------------------------------- the handover list, as one answer

test('handoverVerdict names the first thing that stopped a reply from being handed to her voice', () => {
  const ok = { status: 'complete' as const, allowSpeech: true, mood: { tone: 1 }, appraisalReplyId: null, replyId: 'r', text: '嗯嗯。' };
  assert.equal(handoverVerdict(ok), 'hand');
  assert.equal(handoverVerdict({ ...ok, text: '  ' }), null, 'nothing to read, nothing to say');
  assert.equal(handoverVerdict({ ...ok, status: 'partial' }), 'not-complete');
  assert.equal(handoverVerdict({ ...ok, allowSpeech: false }), 'newer-line');
  assert.equal(handoverVerdict({ ...ok, mood: null }), 'no-appraisal');
  assert.equal(handoverVerdict({ ...ok, appraisalReplyId: 'other' }), 'superseded');
  assert.equal(handoverVerdict({ ...ok, appraisalReplyId: 'r' }), 'hand');
});

// ---------------------------------------------------------------- the window's roads

test('the window says why a reading was dropped before it began (the order the checks are made in), and only closed words', async () => {
  assert.equal(speechDropWhy({ chatBusy: true, shown: false, voiceOn: false }), 'chat-busy');
  assert.equal(speechDropWhy({ chatBusy: false, shown: false, voiceOn: false }), 'not-shown');
  assert.equal(speechDropWhy({ chatBusy: false, shown: true, voiceOn: false }), 'switch');
  assert.equal(speechDropWhy({ chatBusy: false, shown: true, voiceOn: true }), null);
  const sent: unknown[] = [];
  reportReadingDropped({ noteJournalFact: async (kind, value) => { sent.push([kind, value]); return true; } }, 'not-ready');
  assert.deepEqual(sent, [['reading-dropped', { why: 'not-ready' }]]);
  assert.doesNotThrow(() => reportReadingDropped({ noteJournalFact: () => { throw new Error('closed'); } }, 'switch'));
  assert.doesNotThrow(() => reportReadingDropped(null, 'switch'));
});

// ---------------------------------------------------------------- the real voice host: settlement hands the reply over, or says why not

let letGo: () => void = () => {};
async function hostWorld(options: { holdFirst?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vb-1226-'));
  const service = new CompanionService(directory, () => {});
  await service.load();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider.kind = 'claude'; settings.provider.model = 'haiku';
  await service.context('fixture-character', settings.provider, '公开原创角色');
  const media = { voiceInput: true, voiceOwner: 'controls' as const };
  const events: Array<{ type: string; replyId?: string }> = [], ledger: string[] = [], pending = new Set<string>(), asr: string[] = [];
  let gate: Promise<void> | null = options.holdFirst ? new Promise<void>(resolve => { letGo = resolve; }) : null;
  const host = new VoiceChatHost({
    broadcast: event => { events.push(event as never); },
    memoryChanged() {}, windowVisible: () => true, media: () => media, turnOffVoiceInput() {}, speechScope: () => 'scope', settings: () => settings,
    companion: () => ({ beginVoiceGroup: (...args: Parameters<CompanionService['beginVoiceGroup']>) => service.beginVoiceGroup(...args) }),
    ambient: () => null, reserveChat: id => { if (pending.size) return false; pending.add(id); return true; }, releaseChat: id => { pending.delete(id); },
    userTurn() {}, activityChanged() {}, cancelProactive() {},
    claude: { stream: async (_task, _signal, emit) => { emit('delta', '嗯嗯。'); if (gate) { const g = gate; gate = null; await g; } return { superseded: false, output: '嗯嗯。' }; } },
    languageProfile: () => null, chatDirectory: () => directory, tempDirectory: () => directory,
    transcribe: async () => asr.shift() ?? '', stopReading() {}, prepareSpeech() {},
    reading: { expect: id => { ledger.push('expect'); void id; }, notHanded: by => { ledger.push(by); } },
  });
  const binding = host.open(77, 'controls');
  let seq = 0;
  const utter = (text: string) => {
    asr.push(text);
    host.pipeline.submit(77, { captureSessionId: binding.captureSessionId, captureSeq: ++seq, wav: encodeWav(new Float32Array(4096).fill(0.1)) });
    host.pipeline.finishSpeaking(77, binding.captureSessionId);
  };
  const until = async (test: () => boolean) => { for (let i = 0; i < 600 && !test(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };
  const say = async (text: string) => {
    utter(text);
    for (let i = 0; i < 600 && !events.some(e => e.type === 'terminal'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    for (let i = 0; i < 600 && pending.size; i++) await new Promise(resolve => setTimeout(resolve, 5));
    await host.drain();
  };
  return { events, ledger, say, utter, until, letGo: () => letGo(), drain: () => host.drain(), pendingChats: () => pending.size, dispose: async () => { host.dispose(); await host.drain(); await service.flush(); await rm(directory, { recursive: true, force: true }); } };
}

test('settlement: a finished voice reply is either handed to her voice (the ledger expects it) or says why it was not', async () => {
  const w = await hostWorld();
  try {
    await w.say('今天天气真好');
    const handed = w.events.some(e => e.type === 'speech');
    // Every settled voice reply has exactly one outcome on record: a 'speech' event and an expectation, or a reason word.
    if (handed) assert.deepEqual(w.ledger, ['expect'], 'handed over: the host expects her voice to ask for it');
    else assert.equal(w.ledger.length, 1, 'not handed over: one reason word on record');
    assert.ok(handed || (READING_CANCEL_BYS as readonly string[]).includes(w.ledger[0]), 'the reason is one of the closed words');
  } finally { await w.dispose(); }
});

test('12:26: a newer line of yours reaches the host while her reply is still being written: the reply is shown, not handed to her voice, and the row says why', async () => {
  const w = await hostWorld({ holdFirst: true });
  try {
    w.utter('第一句话');
    await w.until(() => w.events.some(e => e.type === 'delta'));
    w.utter('又一句话'); // a second capture's final is accepted while the first reply is still in flight
    await w.until(() => w.events.filter(e => e.type === 'row').length >= 2);
    w.letGo();
    await w.until(() => w.ledger.length >= 1 && w.pendingChats() === 0);
    await w.drain();
    const unhanded = w.ledger.filter(word => word !== 'expect');
    assert.ok(unhanded.length >= 1 && unhanded.every(word => (READING_CANCEL_BYS as readonly string[]).includes(word)), 'a reply that was shown and not handed over left a reason word: ' + JSON.stringify(w.ledger));
  } finally { await w.dispose(); }
});
