import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { DEFAULT_TTS_CONFIG, type TtsConfig, type TtsStreamEvent } from '../shared/voice/tts';
import { validateSpeechDiagnosticRecord, type SpeechDiagnosticRecord } from '../shared/voice/speech-diagnostics';
import { StreamingVoicePlayer } from '../src/voice/EmotionalVoice';
import { VoiceOutput, type VoiceOutputEvent } from '../src/voice/VoiceOutput';
import { SharedAudioOutput } from '../src/voice/audio-output';
import { OutputWake, startWakeTone, type WakeSignal } from '../src/voice/output-wake/wake';
import { KEEP_AFTER_MS, WAKE_COLD_AFTER_MS, WAKE_LEAD_MS, WAKE_LEVEL } from '../src/voice/output-wake/knobs';
import type { SpeechFaceCue } from '../src/voice/speech-face/cues';
import { ReadingJournal } from '../electron/memory/journal/extras';
import { buildJournalEntry, describeJournalEntry, readJournalLine, type JournalInput } from '../shared/memory/journal';
import { flush, pcm, world } from './helpers/r02-audio-world';

/*
 * I-150. The dev journal showed the program played everything on a running context; the
 * opening was eaten by the Bluetooth headset waking after Chromium had stopped the silent output stream. The program now wakes
 * the output with an inaudible tone before she speaks (src/voice/output-wake/wake.ts). Fake clocks, fake devices, no audio.
 */
const LIMIT = { timeout: 60_000 };

// ---------------------------------------------------------------- 1. the pure scheduling, at the real knob values

function pure(options: { lead?: number } = {}) {
  let now = 10_000, handles = 0;
  const due: { id: number; at: number; callback: () => void }[] = [];
  const timers = {
    set(callback: () => void, ms: number) { const id = ++handles; due.push({ id, at: now + Math.max(0, ms), callback }); return id; },
    clear(handle: unknown) { const index = due.findIndex(item => item.id === handle); if (index >= 0) due.splice(index, 1); },
  };
  const tones: { startedAt: number; stoppedAt: number | null }[] = [];
  let contextTime = 5;
  const context = {} as AudioContext;
  const wake = new OutputWake({ now: () => now, timers, ...(options.lead ? { leadMs: options.lead } : {}),
    start: () => { const tone = { startedAt: contextTime, stoppedAt: null as number | null }; tones.push(tone); return { startedAt: tone.startedAt, stop: () => { tone.stoppedAt = now; } }; } });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      due.sort((a, b) => a.at - b.at);
      const next = due[0];
      if (!next || next.at > end) break;
      due.shift(); contextTime += (next.at - now) / 1000; now = next.at; next.callback();
    }
    contextTime += (end - now) / 1000; now = end;
  };
  return { wake, tones, context, advance, now: () => now, contextTime: () => contextTime };
}

test('wake (pure): the first request on a cold output holds her first sound for the lead after the tone starts', () => {
  const p = pure();
  p.wake.request(true); // the context reads "running", but nothing has sounded on it yet
  p.wake.running(p.context);
  assert.equal(p.tones.length, 1);
  assert.equal(p.wake.readyAt(p.context), p.tones[0].startedAt + WAKE_LEAD_MS / 1000);
  assert.equal(p.wake.holdMs(), WAKE_LEAD_MS);
  p.advance(300);
  assert.equal(p.wake.holdMs(), WAKE_LEAD_MS - 300);
  p.advance(600);
  assert.equal(p.wake.holdMs(), 0, 'past the lead nothing waits');
  assert.equal(p.wake.readyAt({} as AudioContext), -Infinity, 'another context is never held by this tone');
});

test('wake (pure): an output that had sound within the cold window is warm and never holds', () => {
  const p = pure();
  p.wake.use(true); p.advance(4000); p.wake.use(false); // a reading played and ended
  p.advance(WAKE_COLD_AFTER_MS - 1000);
  p.wake.request(true);
  p.wake.running(p.context);
  assert.equal(p.wake.readyAt(p.context), -Infinity);
  assert.equal(p.wake.holdMs(), 0);
  // A context that had to be resumed is cold however recent the sound was.
  const q = pure();
  q.wake.use(true); q.wake.use(false); q.advance(100);
  q.wake.request(false);
  q.wake.running(q.context);
  assert.ok(Number.isFinite(q.wake.readyAt(q.context)));
});

test('wake (pure): the tone keeps going while the output is held and stops KEEP_AFTER after the last use', () => {
  const p = pure();
  p.wake.request(true); p.wake.running(p.context);
  p.wake.use(true);
  p.advance(KEEP_AFTER_MS * 3);
  assert.equal(p.tones[0].stoppedAt, null, 'never stops while she is speaking');
  p.wake.use(false);
  const ended = p.now();
  p.advance(KEEP_AFTER_MS - 1);
  assert.equal(p.tones[0].stoppedAt, null);
  p.advance(2);
  assert.equal(p.tones[0].stoppedAt, ended + KEEP_AFTER_MS, 'stopped KEEP_AFTER after the last audio');
  assert.equal(p.wake.active, false);
  // A request with no audio after it (a reply that failed) also lets go after KEEP_AFTER.
  p.advance(60_000);
  p.wake.request(true); p.wake.running(p.context);
  const asked = p.now();
  p.advance(KEEP_AFTER_MS + 1);
  assert.equal(p.tones[1].stoppedAt, asked + KEEP_AFTER_MS);
  // Use alone never starts a tone (a feeding cue is not a request).
  p.wake.use(true); p.wake.use(false); p.advance(KEEP_AFTER_MS * 2);
  assert.equal(p.tones.length, 2);
});

test('wake (pure): halt stops at once; a tone that cannot start holds nothing', () => {
  const p = pure();
  p.wake.request(true); p.wake.running(p.context); p.wake.halt();
  assert.equal(p.tones[0].stoppedAt, p.now());
  const none = new OutputWake({ now: () => 0, timers: { set: () => 1, clear: () => {} }, start: () => null });
  none.request(false); none.running({} as AudioContext);
  assert.equal(none.holdMs(), 0);
  assert.equal(none.readyAt({} as AudioContext), -Infinity);
});

test('wake tone: a very low tone faded in and out on the destination, never on a context without oscillators', () => {
  const calls: string[] = [];
  const param = (name: string) => ({ value: 0, setValueAtTime: (v: number, t: number) => calls.push(`${name} set ${v} @${t}`),
    linearRampToValueAtTime: (v: number, t: number) => calls.push(`${name} ramp ${v} @${t}`), cancelScheduledValues: () => calls.push(`${name} cancel`) });
  const destination = { name: 'destination' };
  let connectedTo: unknown = null;
  const context = {
    currentTime: 2, destination,
    createGain: () => ({ gain: param('gain'), connect: (target: unknown) => { connectedTo = target; }, disconnect() {} }),
    createOscillator: () => ({ frequency: { value: 0 }, connect() {}, disconnect() {}, start: (t: number) => calls.push(`start @${t}`), stop: (t: number) => calls.push(`stop @${t}`), onended: null }),
  } as unknown as AudioContext;
  const tone = startWakeTone(context)!;
  assert.equal(tone.startedAt, 2);
  assert.equal(connectedTo, destination, 'straight to the destination, not through any voice player');
  assert.ok(calls.includes('gain set 0 @2') && calls.some(call => call.startsWith(`gain ramp ${WAKE_LEVEL} @`)), 'fades in from 0 (no click)');
  tone.stop();
  assert.ok(calls.some(call => call.startsWith('gain ramp 0 @')) && calls.some(call => call.startsWith('stop @')), 'fades out, then stops');
  assert.ok(WAKE_LEVEL > 0 && WAKE_LEVEL <= 0.001, 'far below audibility, but not 0 (0 is what the browser treats as silence)');
  assert.equal(startWakeTone({ currentTime: 0 } as unknown as AudioContext), null);
});

// ---------------------------------------------------------------- 2. the real output, player and VoiceOutput on a fake device

const KEEP = 3_000, COLD = 3_500; // shorter than the real knobs so the 1 ms fake clock stays quick; the lead is the real one
const bailian: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'synthetic', apiKey: 'k' };

interface FakeTone { startAt: number; stopAt: number | null; context: unknown }

function harness(t: TestContext, options: { provider?: 'bailian' | 'system'; warm?: boolean } = {}) {
  const w = world(t, { deviceStartMs: 50 });
  const tones: FakeTone[] = [];
  // The fake device grows oscillators and automatable gains, so the real startWakeTone runs on it.
  const createContext = () => {
    const context = w.createContext() as unknown as Record<string, unknown> & { currentTime: number; destination: unknown };
    const param = () => ({ value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} });
    context.createGain = () => ({ gain: param(), connect() {}, disconnect() {} });
    context.createOscillator = () => {
      const tone: FakeTone = { startAt: -1, stopAt: null, context };
      tones.push(tone);
      return { frequency: { value: 0 }, connect() {}, disconnect() {}, onended: null, start: (at: number) => { tone.startAt = at; }, stop: (at: number) => { tone.stopAt = at; } };
    };
    return context as unknown as AudioContext;
  };
  const audio = new SharedAudioOutput({ createContext, now: w.now, timers: w.timers, visibility: null, wake: { keepAfterMs: KEEP, coldAfterMs: COLD } });
  if (options.warm !== false) audio.warm();
  let listener: ((event: VoiceOutputEvent) => void) | null = null;
  let ids = 0;
  const voice = { ...DEFAULT_SETTINGS.voice, enabled: true };
  const config: TtsConfig = options.provider === 'system' ? { ...DEFAULT_TTS_CONFIG, provider: 'system' } : bailian;
  const requests: string[] = [], records: SpeechDiagnosticRecord[] = [], faces: SpeechFaceCue[] = [], heard: string[] = [], spokenAt: number[] = [];
  const speaking: { value: boolean; contextTime: number }[] = [];
  const output = new VoiceOutput({
    getTtsConfig: () => config, getVoiceConfig: () => voice,
    api: {
      async synthesizeSpeech(id) { requests.push(id); },
      async cancelSpeech() {}, async releaseSpeech() {},
      async beginSpeechPlaybackActivity() { return 'lease'; }, async endSpeechPlaybackActivity() {},
      onSpeechEvent(callback) { listener = callback; return () => { listener = null; }; },
      async recordSpeechDiagnostic(record) { records.push(record); },
    },
    onSpeaking: value => speaking.push({ value, contextTime: w.contexts[0]?.currentTime ?? -1 }), onError: () => {},
    onSpeechFace: cue => faces.push(cue), onSegmentHeard: fact => heard.push(`${fact.segmentIndex}:${fact.phase}`),
    createId: () => `wake-${++ids}`, audio, now: w.now,
    wait: ms => new Promise<void>(resolve => w.timers.set(resolve, ms)),
    createPlayer: callbacks => new StreamingVoicePlayer({ ...callbacks, now: w.now, timers: w.timers }),
    createSystem: () => ({ voices: () => [], speak: () => { spokenAt.push(w.now()); return new Promise<void>(resolve => w.timers.set(resolve, 300)); }, stop() {} }),
  });
  t.after(() => { output.dispose(); audio.dispose(); });
  const emit = (id: string, event: TtsStreamEvent) => listener?.({ id, ...event } as VoiceOutputEvent);
  const chunk = (first = false): TtsStreamEvent => ({ type: 'audio', data: pcm(), format: 'pcm_s16le', sampleRate: 24000, channels: 1, ...(first ? { firstAudioMs: 300 } : {}) });
  const device = () => w.contexts[0];
  const starts = () => w.contexts.flatMap(context => context.sources).filter(source => source.startAt >= 0).map(source => source.startAt);
  /** One synthesized reading: first PCM after `networkMs`, two chunks, done; then it plays out. */
  async function synthesize(networkMs = 300) {
    await flush();
    const id = requests.at(-1)!;
    await w.advance(networkMs);
    const scheduledFrom = device().currentTime;
    emit(id, chunk(true)); emit(id, chunk());
    await w.advance(1);
    emit(id, { type: 'done', firstAudioMs: 300, audioBytes: 19200 });
    return { scheduledFrom };
  }
  return { w, audio, output, voice, tones, requests, records, faces, heard, speaking, spokenAt, emit, device, starts, synthesize };
}

test('wake: her own line on a cold output starts with the tone already running and is held for the lead (counted in first audio)', LIMIT, async t => {
  const h = harness(t);
  await h.w.advance(COLD + 500); // warm()'s device has been quiet longer than the cold window
  assert.equal(h.tones.length, 0, 'no tone until speech is coming');
  const done = h.output.speak('你好，我在这里。', h.voice, { replyId: 'line-1', segmentIndex: 0 });
  await flush();
  assert.equal(h.tones.length, 1, 'the tone starts the moment she is about to speak');
  const toneAt = h.tones[0].startAt;
  const { scheduledFrom } = await h.synthesize(300);
  const first = Math.min(...h.starts());
  assert.ok(Math.abs(first - (toneAt + WAKE_LEAD_MS / 1000)) < 0.002, `her first sound waits for the lead: ${first} vs tone ${toneAt}`);
  assert.ok(first > scheduledFrom + 0.1 + 0.3, 'later than the usual 0.1 s jitter lead');
  // The mouth, the face and her bubble see only her sound, never the tone.
  await h.w.advance(300);
  assert.equal(h.speaking.some(item => item.value), false, 'the mouth stays shut while only the tone plays');
  assert.equal(h.faces.some(cue => cue.kind === 'start'), false);
  assert.deepEqual(h.heard, []);
  await h.w.advance(1500);
  await done;
  const opened = h.speaking.find(item => item.value)!;
  assert.ok(opened.contextTime >= first - 0.001, `the mouth opened at her held sound (${opened.contextTime}), not at the tone`);
  assert.equal(h.heard[0], '0:start');
  const record = h.records.find(item => item.kind === 'reply')!;
  assert.ok(record.wakeHoldMs! >= 350 && record.wakeHoldMs! <= 450, `the hold is recorded (${record.wakeHoldMs} ms)`);
  assert.ok(record.t.playbackStart! >= WAKE_LEAD_MS, `first audio counts the hold (${record.t.playbackStart} ms)`);
  assert.deepEqual(validateSpeechDiagnosticRecord(record), record, 'the host accepts the record with its hold');
});

test('wake: a reply after the user sends a message starts with no extra wait', LIMIT, async t => {
  const h = harness(t);
  await h.w.advance(COLD + 500);
  h.output.prewarm(); // chat sent: the tone starts here
  await flush();
  assert.equal(h.tones.length, 1);
  await h.w.advance(2000); // Claude writes; her reply arrives about 2 s later
  const playback = h.output.openReply(h.voice, 'reply-1')!;
  void playback.append('好呀。', { replyId: 'reply-1', segmentIndex: 0 });
  const closed = playback.close();
  const { scheduledFrom } = await h.synthesize(300);
  assert.equal(h.tones.length, 1, 'the same tone, still running');
  const first = Math.min(...h.starts());
  assert.ok(Math.abs(first - (scheduledFrom + 0.1)) < 0.003, `only the usual 0.1 s lead: ${first - scheduledFrom}`);
  await h.w.advance(1500);
  await closed;
  const record = h.records.find(item => item.kind === 'reply')!;
  assert.equal(record.wakeHoldMs, undefined, 'nothing held');
});

test('wake: warm readings are never held, and the tone stops KEEP_AFTER after the last audio', LIMIT, async t => {
  const h = harness(t);
  await h.w.advance(COLD + 500);
  const one = h.output.speak('第一句。', h.voice, { replyId: 'a', segmentIndex: 0 });
  await h.synthesize(300);
  await h.w.advance(1500);
  await one;
  // Warm: the tone is still on (within KEEP_AFTER of her last sound).
  await h.w.advance(1000);
  assert.equal(h.audio.waking, true);
  const two = h.output.speak('第二句。', h.voice, { replyId: 'b', segmentIndex: 0 });
  let ended = -1;
  void two.then(() => { ended = h.w.now(); }); // her last audio played out here (the player let the output go)
  const second = await h.synthesize(300);
  assert.ok(Math.abs(Math.min(...h.starts().slice(2)) - (second.scheduledFrom + 0.1)) < 0.003, 'not held');
  await h.w.advance(1500);
  await two;
  assert.ok(ended > 0);
  await h.w.advance(ended + KEEP - 20 - h.w.now());
  assert.equal(h.audio.waking, true, 'still on just before KEEP_AFTER');
  assert.equal(h.tones[0].stopAt, null);
  await h.w.advance(40);
  assert.equal(h.audio.waking, false, `stopped KEEP_AFTER after her last audio (ended at ${ended})`);
  assert.notEqual(h.tones[0].stopAt, null, 'faded out and stopped on the device');
  // Shortly after the tone stopped the stream is still up: warm, a new tone but no hold.
  await h.w.advance(300);
  const three = h.output.speak('第三句。', h.voice, { replyId: 'c', segmentIndex: 0 });
  const third = await h.synthesize(300);
  assert.equal(h.tones.length, 2);
  assert.ok(Math.abs(Math.min(...h.starts().slice(4)) - (third.scheduledFrom + 0.1)) < 0.003, 'not held');
  await h.w.advance(1500);
  await three;
  assert.deepEqual(h.records.map(record => record.wakeHoldMs ?? 0).slice(1), [0, 0], 'only the cold first reading was held');
  assert.ok(h.records[0].wakeHoldMs! > 0);
});

test('wake: the tone alone never counts as speaking (mouth, lip-sync levels, bubble)', LIMIT, async t => {
  const h = harness(t);
  await h.w.advance(COLD + 500);
  h.output.prewarm();
  await h.w.advance(KEEP + 500);
  assert.equal(h.tones.length, 1);
  assert.notEqual(h.tones[0].stopAt, null, 'started and let go again');
  assert.deepEqual(h.speaking.filter(item => item.value), [], 'no mouth');
  assert.deepEqual(h.faces, [], 'no levels, no speaking face');
  assert.deepEqual(h.heard, [], 'no sentence heard');
  assert.equal(h.device().sources.length, 0, 'nothing went through her voice player');
});

test('wake: read-aloud off or volume 0 starts nothing; without a built context nothing is built for it', LIMIT, async t => {
  const h = harness(t);
  await h.w.advance(COLD + 500);
  await h.output.speak('不读。', { ...h.voice, enabled: false });
  h.voice.volume = 0;
  h.output.prewarm();
  h.output.wakeForReply();
  void h.output.speak('静音。', h.voice);
  await h.w.advance(500);
  assert.equal(h.tones.length, 0, 'no tone with read-aloud off or the volume at 0');
  h.output.stop();
  // A window that never built its context (system voice at start): waking does not build one (building froze her, 2026-11-05).
  const cold = harness(t, { warm: false });
  cold.audio.wake();
  await cold.w.advance(200);
  assert.equal(cold.w.contexts.length, 0);
  assert.equal(cold.audio.builds, 0);
});

test('wake: the system voice waits for the lead on a cold output and starts at once on a warm one', LIMIT, async t => {
  const h = harness(t, { provider: 'system' });
  await h.w.advance(COLD + 500);
  const asked = h.w.now();
  const one = h.output.speak('系统语音。', h.voice);
  await h.w.advance(1200);
  assert.equal(h.tones.length, 1, 'the tone runs on the window\'s existing output');
  assert.equal(h.spokenAt.length, 1);
  assert.ok(h.spokenAt[0] - asked >= WAKE_LEAD_MS - 5 && h.spokenAt[0] - asked <= WAKE_LEAD_MS + 5, `spoken ${h.spokenAt[0] - asked} ms after it was asked`);
  await one;
  await h.w.advance(500);
  const again = h.w.now();
  const two = h.output.speak('又一句。', h.voice);
  await h.w.advance(50);
  assert.equal(h.spokenAt.length, 2);
  assert.ok(h.spokenAt[1] - again < 10, 'warm: no wait');
  await h.w.advance(500);
  await two;
});

test('wake: an idle suspend halts the tone, and a wake on a suspended output resumes it and counts as cold', LIMIT, async t => {
  const w = world(t, { deviceStartMs: 50 });
  const started: WakeSignal[] = [];
  let stopped = 0;
  const audio = new SharedAudioOutput({ createContext: w.createContext, now: w.now, timers: w.timers, visibility: null, idleMs: 1_000,
    wake: { keepAfterMs: 60_000, start: context => { const signal = { startedAt: context.currentTime, stop: () => { stopped++; } }; started.push(signal); return signal; } } });
  t.after(() => audio.dispose());
  audio.warm();
  await w.advance(100);
  audio.wake();
  await w.advance(50);
  assert.equal(started.length, 1);
  await w.advance(1_100);
  assert.equal(w.contexts[0].state, 'suspended', 'idle suspended the device');
  assert.equal(stopped, 1, 'and halted the tone with it');
  audio.wake();
  await w.advance(100);
  assert.equal(w.contexts[0].state, 'running', 'the wake resumed the same context');
  assert.equal(w.contexts.length, 1);
  assert.equal(started.length, 2);
  assert.ok(Number.isFinite(audio.wakeReadyAt(w.contexts[0] as unknown as AudioContext)), 'a resumed output is cold: her first sound waits');
});

test('wake: the journal\'s reading-time line says the first sound waited for the headphones (inside first audio), only when it did', () => {
  const lines: JournalInput[] = [];
  const sink = { record: (input: JournalInput) => { lines.push(input); return null; }, accepting: () => true };
  const journal = new ReadingJournal(sink as never, () => 'c', { set: () => 1, clear() {} });
  journal.segment({ kind: 'reply', provider: 'fish', segmentIndex: 0, textLength: 8, outcome: 'ended', t: { request: 1, playbackStart: 820 }, wakeHoldMs: 410 });
  journal.flush();
  journal.segment({ kind: 'reply', provider: 'fish', segmentIndex: 0, textLength: 8, outcome: 'ended', t: { request: 1, playbackStart: 420 } });
  journal.flush();
  const held = buildJournalEntry(lines[0], 1_700_000_000_000)!, plain = buildJournalEntry(lines[1], 1_700_000_000_000)!;
  assert.deepEqual([(held as { firstAudioMs?: number }).firstAudioMs, (held as { wakeHoldMs?: number }).wakeHoldMs], [820, 410]);
  assert.equal('wakeHoldMs' in plain, false);
  const tr = (text: string, ...args: unknown[]) => text.replace(/\{(\d)\}/g, (_, index: string) => String(args[Number(index)]));
  assert.match(describeJournalEntry(held, tr), /出声用了 0\.82 秒、其中等耳机醒 0\.41 秒/);
  assert.doesNotMatch(describeJournalEntry(plain, tr), /耳机/);
  assert.deepEqual(readJournalLine(JSON.stringify(held)), held, 'the line reads back through the whitelist');
  assert.equal('wakeHoldMs' in buildJournalEntry({ ...lines[0], wakeHoldMs: -5 } as never, 1)!, false, 'a bad number is dropped');
});
