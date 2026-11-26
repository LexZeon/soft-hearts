import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { CALL_DUCK_KNOBS } from '../shared/behaviors/call-duck/knobs';
import { VOICE_CALL_KNOBS } from '../shared/behaviors/voice-call/knobs';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { DEFAULT_TTS_CONFIG } from '../shared/voice/tts';
import { VoiceCallHost, type VoiceCallJournalInput } from '../electron/voice/voice-call/host';
import { OutputBus, smoothstep } from '../src/voice/output-bus';
import { CallDuck, callKnobsFor, dbToGain, type DuckEnd } from '../src/voice/voice-call/call-duck';
import { CallControls } from '../src/voice/voice-call/call-controls';
import { BargeInDetector } from '../src/voice/voice-call/barge-in';
import { chunk, mic, RATE } from './helpers/call-mic';

/*
 * I-177 batch 2, item 4 "先侧耳听，再判断" (docs/claude/2026-11-22-i177-batch2.md). The rule that
 * stays (11-19): only a clear, complete sentence interrupts. Her voice ducks while the user starts talking over her; only a clear sentence
 * or a stop word stops her. Fake clocks, fake audio params, a synthetic microphone: no audio, no Claude.
 */

// ---------------------------------------------------------------- item 4: 先侧耳听，再判断

function duckWorld(can = true) {
  let now = 0, id = 0;
  const due: { id: number; at: number; fn: () => void }[] = [];
  const levels: [number, number][] = [], ends: [DuckEnd, number][] = [];
  const duck = new CallDuck({ level: (t, ms) => levels.push([t, ms]), canDuck: () => can, now: () => now,
    timers: { set: (fn, ms) => { due.push({ id: ++id, at: now + ms, fn }); return id; }, clear: h => { const i = due.findIndex(d => d.id === h); if (i >= 0) due.splice(i, 1); } },
    ended: (how, ms) => ends.push([how, ms]) });
  const advance = (ms: number) => { const end = now + ms; for (;;) { due.sort((a, b) => a.at - b.at); const next = due[0]; if (!next || next.at > end) break; due.shift(); now = next.at; next.fn(); } now = end; };
  return { duck, levels, ends, advance };
}
const DUCKED = dbToGain(CALL_DUCK_KNOBS.duckDb);

test('duck: the user starts talking over her → her voice eases down (never to silence) and holds; a filler brings it back, she goes on', () => {
  const w = duckWorld();
  w.duck.overHer();
  assert.deepEqual(w.levels, [[DUCKED, CALL_DUCK_KNOBS.downMs]]);
  assert.ok(DUCKED > 0.2 && DUCKED < 0.3, `-12 dB ≈ a quarter (${DUCKED.toFixed(3)}), not silence`);
  w.duck.overHer(); // the VAD again: no second duck
  w.advance(900);
  w.duck.clipEnded(true); // the clip went to recognition
  w.advance(400);
  w.duck.held(); // the host held it: "嗯" / a fragment / her echo
  assert.deepEqual(w.levels.at(-1), [1, CALL_DUCK_KNOBS.upMs], 'back to her normal volume, eased');
  assert.deepEqual(w.ends, [['resume', 1300]]);
  assert.equal(w.duck.ducked, false);
});

test('duck: a clear sentence or a stop word → her reading is stopped (by the host, as before) and the level is ready for her next words', () => {
  const w = duckWorld();
  w.duck.overHer(); w.advance(600); w.duck.clipEnded(true); w.advance(500);
  w.duck.stopped(); // the window's reading-stop: the words reached her
  assert.deepEqual(w.ends, [['stop', 1100]]);
  assert.deepEqual(w.levels.at(-1), [1, CALL_DUCK_KNOBS.upMs]);
  w.duck.held(); w.duck.stopped();
  assert.equal(w.ends.length, 1, 'one duck ends once');
});

test('duck: nothing collected → back now; no verdict in time → back anyway; never ducked when it cannot (read-aloud off, system voice)', () => {
  const a = duckWorld();
  a.duck.overHer(); a.advance(1500); a.duck.clipEnded(false);
  assert.deepEqual(a.ends, [['resume', 1500]]);
  const b = duckWorld();
  b.duck.overHer(); b.advance(CALL_DUCK_KNOBS.maxHoldMs - 1);
  assert.equal(b.ends.length, 0);
  b.advance(1);
  assert.deepEqual(b.ends, [['timeout', CALL_DUCK_KNOBS.maxHoldMs]], 'never stuck quiet');
  const c = duckWorld();
  c.duck.overHer(); c.advance(500); c.duck.clipEnded(true); c.advance(CALL_DUCK_KNOBS.verdictWaitMs);
  assert.deepEqual(c.ends, [['timeout', 500 + CALL_DUCK_KNOBS.verdictWaitMs]]);
  const off = duckWorld(false);
  off.duck.overHer(); off.duck.held(); off.duck.stopped();
  assert.deepEqual(off.levels, [], 'no duck at all');
  assert.deepEqual(off.ends, []);
});

test('duck stage: an eased curve (speed continuous, no jump), a new target mid-way starts where the level is', () => {
  const curves: { values: number[]; at: number; seconds: number }[] = [];
  const param = { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, setValueCurveAtTime(values: Float32Array, at: number, seconds: number) { curves.push({ values: [...values], at, seconds }); } };
  const context = { currentTime: 10, destination: {}, createGain: () => ({ gain: param, connect() {}, disconnect() {} }) } as unknown as AudioContext;
  const bus = new OutputBus();
  bus.input(context);
  bus.set(DUCKED, CALL_DUCK_KNOBS.downMs);
  const down = curves[0];
  assert.equal(down.values[0], 1); assert.ok(Math.abs(down.values.at(-1)! - DUCKED) < 1e-6);
  const steps = down.values.slice(1).map((v, i) => Math.abs(v - down.values[i]));
  const largest = Math.max(...steps), first = steps[0], last = steps.at(-1)!;
  assert.ok(first < largest / 10 && last < largest / 10, `eased at both ends (first ${first.toFixed(5)}, last ${last.toFixed(5)}, largest ${largest.toFixed(5)})`);
  const average = Math.abs(1 - DUCKED) / (down.values.length - 1);
  assert.ok(largest <= average * 1.55, `no jump: the largest step is ${(largest / average).toFixed(2)}× the average (smoothstep peaks at 1.5×), ${down.values.length} points over ${down.seconds * 1000} ms`);
  assert.ok(down.values.every((v, i) => i === 0 || v <= down.values[i - 1]), 'always down, never back and forth');
  (context as { currentTime: number }).currentTime = 10 + CALL_DUCK_KNOBS.downMs / 2000; // half way down
  const mid = bus.levelAt(context.currentTime);
  assert.ok(Math.abs(mid - (1 + (DUCKED - 1) * smoothstep(0.5))) < 1e-9);
  bus.set(1, CALL_DUCK_KNOBS.upMs);
  assert.ok(Math.abs(curves[1].values[0] - mid) < 1e-6, 'back up from where it was, no jump');
});

test('call: barge-in ducks a cloud voice; a held clip brings it back; a reading stop ends it; system voice and read-aloud off never duck', async () => {
  const run = async (fillers: unknown, voice = DEFAULT_SETTINGS.voice) => {
    const ducks: [number, number][] = [];
    const api = new Proxy({}, { get: (_t, name) => (..._args: unknown[]) => name === 'getVoiceCall' ? Promise.resolve({ on: true, owner: 'controls', since: 1, ended: null, fillers })
      : name === 'onVoiceCall' ? () => {} : Promise.resolve(null) });
    const controls = new CallControls({ windowKind: 'controls', api: api as never, audio: { duck: (t: number, ms: number) => ducks.push([t, ms]), sinkChanged() {} } as never,
      voice: () => voice, media: () => ({ setCall() {}, setEchoGuard() {} }), replyBusy: () => true, notify() {} });
    await controls.init(null);
    controls.heard({ type: 'barge-in' });
    return { controls, ducks };
  };
  const paid = { paid: true, ready: true, provider: 'fish', voiceKey: 'k', missing: [] };
  const a = await run(paid);
  assert.deepEqual(a.ducks, [[DUCKED, CALL_DUCK_KNOBS.downMs]]);
  a.controls.overHerHeld();
  assert.deepEqual(a.ducks.at(-1), [1, CALL_DUCK_KNOBS.upMs]);
  a.controls.heard({ type: 'barge-in' }); a.controls.readingStopped();
  assert.deepEqual(a.controls.duck.counts, { ducks: 2, stop: 1, resume: 1, timeout: 0 });
  a.controls.duck.reset();
  assert.deepEqual((await run({ paid: false, ready: true, provider: 'system', voiceKey: 's', missing: [] })).ducks, [], 'the system voice cannot be ducked');
  assert.deepEqual((await run(paid, { ...DEFAULT_SETTINGS.voice, enabled: false })).ducks, [], 'read-aloud off: no duck');
  assert.deepEqual((await run(paid, { ...DEFAULT_SETTINGS.voice, volume: 0 })).ducks, [], 'volume 0: no duck');
});

test('window: listening over her that hears nothing says so (her voice comes back at once); with words it waits for the verdict', async () => {
  await mic(async m => {
    m.media.setCall(VOICE_CALL_KNOBS);
    m.feed(0.0005, 10);
    m.media.setSpeaking(true);
    for (let i = 0; i < 12; i++) m.feed(chunk(0.004, i));
    for (let i = 0; i < 6; i++) m.feed(chunk(0.12, i + 50)); // a cough-length burst over her
    for (let i = 0; i < 40; i++) m.feed(chunk(0.004, i + 90));
    await m.settle();
    assert.ok(m.events.includes('barge-in'));
    assert.ok(m.events.includes('over-her-end'), `listening over her ended: ${m.events.join(',')}`);
  });
});

/** The quietest voice (RMS) that opens listening over her, with no echo in the microphone (headphones), for a call's knobs. */
function quietestBargeIn(knobs = VOICE_CALL_KNOBS.bargeIn, room = 0.01): number {
  for (let rms = 0.004; rms < 0.1; rms += 0.001) {
    const detector = new BargeInDetector(knobs);
    for (let i = 0; i < 6; i++) detector.push(chunk(0.0008, i), RATE, room);
    let fired = false;
    for (let i = 0; i < 10 && !fired; i++) fired = detector.push(chunk(rms, i + 20), RATE, room, true);
    if (fired) return Math.round(rms * 1000) / 1000;
  }
  return Infinity;
}

test('headphones lower the talking-over-her gate (no echo); speakers keep today\'s', () => {
  assert.equal(callKnobsFor('speakers'), VOICE_CALL_KNOBS);
  assert.equal(callKnobsFor('unknown'), VOICE_CALL_KNOBS);
  assert.equal(callKnobsFor(null), VOICE_CALL_KNOBS);
  const hp = callKnobsFor('headphones');
  assert.equal(hp.bargeIn.floor, CALL_DUCK_KNOBS.headphonesFloor);
  assert.equal(hp.bargeIn.gateFactor, CALL_DUCK_KNOBS.headphonesGateFactor);
  assert.equal(hp.bargeIn.echoFactor, VOICE_CALL_KNOBS.bargeIn.echoFactor, 'the echo follower stays');
  const speakers = quietestBargeIn(VOICE_CALL_KNOBS.bargeIn), headphones = quietestBargeIn(hp.bargeIn);
  assert.ok(headphones < speakers, `quietest voice that opens listening: speakers ${speakers}, headphones ${headphones}`);
  // The detector takes the call's knobs when the call sets them (MediaInput.setCall → BargeInDetector.use).
  const d = new BargeInDetector();
  d.use(hp.bargeIn);
  assert.equal(d.gate(0), CALL_DUCK_KNOBS.headphonesFloor);
  d.use(null);
  assert.equal(d.gate(0), VOICE_CALL_KNOBS.bargeIn.floor);
});

test('host journal: a call\'s end says how the clips over her ended (cloud voice only); counts only, accepted and described', async () => {
  const run = async (provider: 'fish' | 'system') => {
    const journal: VoiceCallJournalInput[] = [];
    const host = new VoiceCallHost({ now: () => 0, timers: { set: () => 0, clear() {} }, media: () => ({ voiceInput: true, voiceOwner: 'controls' }),
      turnOnVoice: () => true, turnOffVoice() {}, windowShown: () => true, asleep: () => false, ttsConfig: () => ({ ...structuredClone(DEFAULT_TTS_CONFIG), provider }),
      characterId: () => 'c1', mood: () => ({}), keepWarm() {}, broadcast() {}, journal: entry => journal.push(entry), directory: () => null, cancelReading() {}, synthesize: async () => {} });
    await host.set('controls', true);
    host.held('filler', true, 'controls'); host.held('echo', true, 'controls'); host.held('filler', false, 'controls');
    host.heardOverHer('controls', 'chars');
    host.set('controls', false);
    return journal.find(entry => entry.event === 'end') as Extract<VoiceCallJournalInput, { event: 'end' }>;
  };
  const end = await run('fish');
  assert.deepEqual(end.ducks, { stop: 1, resume: 2 });
  const built = buildJournalEntry({ type: 'voice-call', characterId: 'c1', ...end } as never, 1_800_000_000_000)!;
  assert.deepEqual((built as { ducks?: unknown }).ducks, { stop: 1, resume: 2 });
  const line = describeJournalEntry(built, (text: string, ...args: unknown[]) => args.reduce<string>((t, a, i) => t.replace(`{${i}}`, String(a)), text));
  assert.match(line, /先放低声音 3 次：停下听你 1 次、接着说 2 次/);
  assert.equal((await run('system')).ducks, undefined, 'the system voice is never ducked: nothing to count');
  const bad = buildJournalEntry({ type: 'voice-call', characterId: 'c1', ...end, ducks: { stop: 'x', resume: 2 } } as never, 1_800_000_000_000)!;
  assert.equal((bad as { ducks?: unknown }).ducks, undefined, 'bad counts are dropped');
});
