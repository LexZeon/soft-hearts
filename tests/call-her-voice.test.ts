// (rule): in a call the interruption gate
// did not know she was reading, so a short "嗯" / "对" became a turn and the call's streaming speech cancelled the reading. Now her call
// reading (text reaching the plan, or the plan / the window still playing after the text finished) counts as "she is speaking", with no
// clock; and the journal says who cut a reading, the gate's overHer on an interrupt, and keeps a call's end reason.
// Synthetic clips, fake plan state, no microphone, no Claude, no Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CompletedReplySpeech } from '../electron/voice/completed-reply-speech';
import { CallStreamingSpeech } from '../electron/voice/voice-call/streaming-speech';
import { VoiceCallHost, type VoiceCallJournalInput } from '../electron/voice/voice-call/host';
import { ReadCancelCauses } from '../electron/voice/read-cancel-cause';
import { ReadNotes } from '../electron/voice/read-notes';
import { callPlaying } from '../electron/voice/voice-call/playing';
import { gateClip, herVoiceFrom, type UtteranceGatePorts } from '../electron/voice/utterance-gate';
import { ReadingJournal } from '../electron/memory/journal/extras';
import { buildJournalEntry, describeJournalEntry, readJournalLine, type JournalEntry, type JournalInput } from '../shared/memory/journal';
import { DEFAULT_TTS_CONFIG } from '../shared/voice/tts';
import { encodeWav } from '../src/senses/MediaInput';

const OWNER = 41, SCOPE = 'scope';

function clip(seconds: number, amplitude: number): ArrayBuffer {
  const samples = new Float32Array(Math.round((seconds + 0.4) * 16_000));
  for (let i = 3_200; i < 3_200 + seconds * 16_000; i++) samples[i] = amplitude * Math.sin(i / 4) * (0.6 + 0.4 * Math.sin(i / 900));
  return encodeWav(samples);
}
const SHORT = clip(0.5, 0.3), CLEAR = clip(1.6, 0.3);

/** A call with a real plan and streaming speech; `sound.on` stands for the window's audio / the playback lease (no clock anywhere). */
function call(options: { planCounts?: boolean } = {}) {
  const plan = new CompletedReplySpeech();
  const sound = { on: false }, journal: VoiceCallJournalInput[] = [], causes = new ReadCancelCauses();
  const speech: CallStreamingSpeech = new CallStreamingSpeech({ plan, active: () => true, voice: () => ({ provider: 'system' }), freeze() {}, started: id => host.noteSpeech(id),
    playing: () => sound.on || (options.planCounts !== false && plan.busy), cancelled: by => causes.note(by) });
  const host: VoiceCallHost = new VoiceCallHost({ now: () => 0, timers: { set: () => 0, clear() {} }, media: () => ({ voiceInput: true, voiceOwner: 'controls' }),
    turnOnVoice: () => true, turnOffVoice() {}, windowShown: () => true, asleep: () => false, ttsConfig: () => ({ ...structuredClone(DEFAULT_TTS_CONFIG), provider: 'system' }),
    characterId: () => 'c1', mood: () => ({}), keepWarm() {}, broadcast() {}, journal: entry => journal.push(entry), directory: () => null,
    cancelReading: id => { causes.note('interrupt'); speech.cancelAll(); if (id) plan.cancel(OWNER, id); }, synthesize: async () => {} });
  const turns: string[] = [];
  const ports: UtteranceGatePorts = { herVoice: () => host.on && herVoiceFrom(new Set(), { busy: false }, speech), herText: () => speech.readingText(),
    continuous: owner => host.on && host.controller.owner === owner, held: (kind, overHer, owner) => host.held(kind, overHer, owner),
    interrupted: (owner, by, overHer) => { host.heardOverHer(owner, by, overHer); } };
  /** What the voice host does with a recognized clip: a held clip is no turn; anything else is delivered (a turn, which begins a new reply). */
  const hear = (text: string, wav: ArrayBuffer) => {
    const verdict = gateClip(ports, 'controls', text, wav);
    if (verdict.pass) { turns.push(text); speech.begin({ owner: 'controls', sender: OWNER, replyId: `r${turns.length + 1}`, scope: SCOPE, userText: text }); }
    return verdict;
  };
  return { plan, sound, journal, causes, speech, host, hear, turns };
}

/** Her first reply is written and read: the text finished streaming, the reading goes on. */
function readingFirstReply(world: ReturnType<typeof call>) {
  assert.equal(world.speech.begin({ owner: 'controls', sender: OWNER, replyId: 'r1', scope: SCOPE, userText: '开始' }), true);
  world.speech.delta('r1', '好的，我先给你讲讲今天的事情。然后再说别的。');
  assert.equal(world.speech.complete('r1'), true, 'the text finished streaming');
  world.sound.on = true;
  world.causes.clear(); // the reply's first segment arrived (the journal clears an older cause there)
}

test('signal: her call reading counts as speaking while text reaches the plan and after the text finished, with no clock', () => {
  const world = call({ planCounts: false });
  assert.equal(world.speech.reading(), false, 'before any reply');
  world.speech.begin({ owner: 'controls', sender: OWNER, replyId: 'r1', scope: SCOPE, userText: '开始' });
  assert.equal(world.speech.reading(), false, 'a reply is coming, nothing reached the plan and nothing sounds');
  world.speech.delta('r1', '好的，我先给你讲讲。');
  assert.equal(world.speech.reading(), true, 'text reached the plan');
  world.speech.complete('r1');
  assert.equal(world.speech.reading(), false, 'the text finished and nothing is queued or audible');
  world.sound.on = true;
  assert.equal(world.speech.reading(), true, 'the text finished but the window still plays');
  world.sound.on = false;
  assert.equal(world.speech.reading(), false, 'over');
  const queued = call();
  queued.speech.begin({ owner: 'controls', sender: OWNER, replyId: 'r1', scope: SCOPE, userText: '开始' });
  queued.speech.delta('r1', '好的，我先给你讲讲。'); queued.speech.complete('r1');
  assert.equal(queued.speech.reading(), true, 'the text finished but the plan still holds sentences to read (the wiring counts the plan and the playback lease)');
  queued.plan.cancel(OWNER, 'r1');
  assert.equal(queued.speech.reading(), false);
});

test('signal: herVoiceFrom adds the call reading to the windows and the runtime; a throwing call changes nothing', () => {
  assert.equal(herVoiceFrom(new Set(), { busy: false }, { reading: () => true }), true);
  assert.equal(herVoiceFrom(new Set(), { busy: false }, { reading: () => false }), false);
  assert.equal(herVoiceFrom(new Set([1]), { busy: false }, { reading: () => { throw Error('x'); } }), true);
  assert.equal(herVoiceFrom(new Set(), { busy: false }, { reading: () => { throw Error('x'); } }), false);
});

test('call: a "嗯", a "对" or a fragment over her reading is held; the reading goes on, no new turn, nothing counted as an interruption', async () => {
  const world = call();
  await world.host.set('controls', true);
  readingFirstReply(world);
  for (const [text, kind] of [['嗯', 'filler'], ['对', 'fragment'], ['嗯嗯', 'filler'], ['是吗', 'fragment']] as const) { // I-204: under three characters
    const verdict = world.hear(text, SHORT);
    assert.equal(verdict.pass, false, text);
    assert.equal((verdict as { held: string }).held, kind, text);
  }
  assert.deepEqual(world.turns, [], 'none of them is a turn');
  assert.equal(world.speech.reading(), true, 'the reading still plays');
  assert.equal(world.plan.busy, true, 'the plan was not cancelled');
  assert.equal(world.causes.take(), null, 'nobody cancelled the reading');
  assert.equal(world.host.view().on, true);
  const held = world.journal.filter(entry => entry.event === 'held');
  assert.equal(held.length, 4);
  for (const entry of held) assert.equal((entry as { overHer: boolean }).overHer, true, 'the journal knows she was speaking');
  assert.equal(world.journal.some(entry => entry.event === 'interrupt'), false);
  world.host.set('controls', false);
});

test('call: a clear sentence over her reading interrupts (counted), stops the reading and starts the next reply; a stop command too', async () => {
  const world = call();
  await world.host.set('controls', true);
  readingFirstReply(world);
  const verdict = world.hear('你先听我说一下好不好', CLEAR);
  assert.deepEqual([verdict.pass, (verdict as { interrupt: string }).interrupt], [true, 'chars']);
  assert.deepEqual(world.turns, ['你先听我说一下好不好']);
  assert.equal(world.speech.has('r2'), true, 'the next reply began (her old reading was cut by the interrupt, not left to play)');
  const interrupt = world.journal.find(entry => entry.event === 'interrupt') as Extract<VoiceCallJournalInput, { event: 'interrupt' }>;
  assert.deepEqual([interrupt.by, interrupt.overHer, interrupt.call], ['chars', true, true]);
  assert.equal(world.causes.take(), 'interrupt', 'the cut reading says who cut it (the interrupt, not the next reply)');
  assert.equal(world.host.controller.view().on, true);
  assert.equal(world.host.turnNote().length > 0, true, 'the next turn knows she was cut off');
  const ended = world.host.set('controls', false);
  const end = world.journal.find(entry => entry.event === 'end') as Extract<VoiceCallJournalInput, { event: 'end' }>;
  void ended;
  assert.equal(end.bargeIns, 1, 'the interruption is counted');
  // A stop word, in a fresh call reading.
  const second = call();
  await second.host.set('controls', true);
  readingFirstReply(second);
  assert.deepEqual([second.hear('等一下', clip(0.4, 0.3)).pass, second.turns], [true, ['等一下']]);
  assert.equal((second.journal.find(entry => entry.event === 'interrupt') as { by: string }).by, 'chars');
});

test('call: after the reading ends the old not-speaking rules apply (a long loud "嗯" is an answer, a short one is held as noise)', async () => {
  const world = call();
  await world.host.set('controls', true);
  readingFirstReply(world);
  world.plan.cancel(OWNER, 'r1'); world.sound.on = false;
  assert.equal(world.speech.reading(), false);
  assert.equal(world.hear('嗯。', clip(1.0, 0.3)).pass, true, 'her question was answered with a "嗯"');
  assert.deepEqual(world.turns, ['嗯。']);
  const quiet = call();
  await quiet.host.set('controls', true);
  assert.equal(quiet.hear('嗯', clip(0.2, 0.3)).pass, false, 'noise heard as "嗯" is still held');
  assert.equal((quiet.journal.find(entry => entry.event === 'held') as { overHer: boolean }).overHer, false);
});

test('call: a new reply that begins while her reading still plays says it cut that reading ("new-reply"), and an old cause does not carry over', () => {
  const world = call();
  readingFirstReply(world);
  world.speech.begin({ owner: 'controls', sender: OWNER, replyId: 'r2', scope: SCOPE, userText: '下一句' });
  assert.equal(world.causes.take(), 'new-reply');
  world.causes.note('error'); world.causes.note('stop');
  assert.equal(world.causes.take(), 'error', 'the first cause since the last take wins (the outer cause is not overwritten by the inner cancel)');
  world.causes.note('not-a-cause'); assert.equal(world.causes.take(), null, 'only the closed words');
  world.causes.note('superseded'); world.causes.clear(); assert.equal(world.causes.take(), null, 'a new reply starts clean');
  world.speech.cancel('r2');
  assert.equal(world.causes.take(), 'superseded', 'a reply cancelled for a merge or an error');
});

// ---------------------------------------------------------------- the journal

const entryOf = (input: JournalInput): JournalEntry => buildJournalEntry(input, 1_700_000_000_000)!;
const reading = { type: 'reading-time', characterId: 'c', firstAudioMs: 500, waitMs: 20, chars: 30, provider: 'system', result: 'partial', why: 'cancelled', firstSinceStart: false } as const;

test('journal: a reading cancelled by someone carries the closed word; only with why "cancelled"; unknown words are dropped', () => {
  const line = entryOf({ ...reading, cancelBy: 'interrupt' });
  assert.equal((line as { cancelBy?: string }).cancelBy, 'interrupt');
  assert.match(describeJournalEntry(line, (text, ...values) => text.replace(/\{(\d+)\}/g, (_m, i) => String(values[Number(i)]))), /被取消：你打断了她/);
  assert.equal((entryOf({ ...reading, cancelBy: 'new-reply' }) as { cancelBy?: string }).cancelBy, 'new-reply');
  assert.equal('cancelBy' in entryOf({ ...reading, cancelBy: 'because I said so' as never }), false);
  assert.equal('cancelBy' in entryOf({ ...reading, result: 'partial', why: 'failed', cancelBy: 'stop' }), false, 'a failure is not a cancel');
  assert.equal('cancelBy' in entryOf({ ...reading, result: 'played', why: null, cancelBy: 'stop' }), false);
});

test('journal: the reading-time line takes the cause the host noted, once, and a new reply clears an old one', () => {
  const lines: JournalInput[] = [], causes = new ReadCancelCauses(), notes = new ReadNotes(() => causes.clear());
  const sink = { record: (input: JournalInput) => { lines.push(input); return null; }, accepting: () => true };
  const journal = new ReadingJournal(sink as never, () => 'c', { set: () => 1, clear() {} }, undefined, causes, notes);
  const seg = (index: number, outcome: 'ended' | 'cancelled') => ({ kind: 'reply' as const, provider: 'system' as const, segmentIndex: index, textLength: 10, outcome, t: { playbackStart: 100 } });
  journal.segment(seg(0, 'ended')); journal.segment(seg(1, 'cancelled'));
  causes.note('hang-up');
  journal.flush();
  assert.equal((lines[0] as { cancelBy?: string }).cancelBy, 'hang-up');
  causes.note('stop'); // noted for a reading that is not over; the next reply's start (the host's first sentence request) clears it
  notes.numberOf('next-reply');
  journal.segment(seg(0, 'ended')); journal.segment(seg(1, 'cancelled')); journal.flush();
  assert.equal((lines[1] as { cancelBy?: string }).cancelBy, 'unlogged', 'a stale cause does not carry over; a cancel with no cause says so (2026-11-24)');
  journal.segment(seg(0, 'ended')); journal.flush();
  assert.equal((lines[2] as { why: unknown }).why, null);
  assert.equal('cancelBy' in lines[2]!, false, 'a reading that played has no cause');
});

test('journal: an interrupt carries overHer; a held clip carries kind and overHer; a call\'s end keeps its reason word and the note is its own field', () => {
  const interrupt = entryOf({ type: 'voice-call', characterId: 'c', event: 'interrupt', by: 'sentence', overHer: true, call: true });
  assert.deepEqual([(interrupt as { overHer?: boolean }).overHer, (interrupt as { by?: string }).by], [true, 'sentence']);
  assert.equal((entryOf({ type: 'voice-call', characterId: 'c', event: 'interrupt', by: 'command', overHer: false, call: false }) as { overHer?: boolean }).overHer, false);
  const held = entryOf({ type: 'voice-call', characterId: 'c', event: 'held', kind: 'filler', overHer: true, call: true });
  assert.deepEqual([(held as { kind?: string }).kind, (held as { overHer?: boolean }).overHer], ['filler', true]);
  const end = entryOf({ type: 'voice-call', characterId: 'c', event: 'end', reason: 'silence', seconds: 90, turns: 3, bargeIns: 1 });
  assert.equal(end.reason, 'silence', 'the reason word is not overwritten');
  assert.equal(end.note, '一通电话挂断了', 'the plain-language note has its own field');
  assert.match(describeJournalEntry(end, (text, ...values) => text.replace(/\{(\d+)\}/g, (_m, i) => String(values[Number(i)]))), /一通电话挂断了（很久没人说话，自动挂断，打了 90 秒，3 轮，打断她 1 次）/);
  const back = readJournalLine(JSON.stringify(end));
  assert.ok(back, 'the written line reads back (before, the Chinese note replaced the word and the whitelist dropped the line)');
  assert.equal(back!.reason, 'silence');
  const other = entryOf({ type: 'voice-call', characterId: 'c', event: 'start', via: 'button' });
  assert.equal(other.note, undefined, 'entries without a reason word of their own keep the old shape');
  assert.equal(other.reason, '开始了一通电话');
});

test('signal: the wiring\'s playing check is only for a call, and any of the plan, the runtime or the playback lease keeps it true', () => {
  const state = { call: true, holding: false, playback: false };
  const playing = callPlaying({ call: () => state.call, holding: () => state.holding, playback: () => state.playback });
  assert.equal(playing(), false);
  state.holding = true; assert.equal(playing(), true, 'a sentence is queued or being read');
  state.holding = false; state.playback = true; assert.equal(playing(), true, 'the window\'s playback lease is open');
  state.call = false; assert.equal(playing(), false, 'no call: this is not the call reading');
  const broken = callPlaying({ call: () => true, holding: () => { throw Error('x'); }, playback: () => true });
  assert.equal(broken(), true, 'a failing port is not "speaking", the others still count');
});
