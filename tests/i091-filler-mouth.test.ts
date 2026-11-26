// 2026-11-20: her short sounds in a call move her mouth for exactly as long as they sound, on every stage.
// No audio, no Electron, no paid voice: fake speech engine, fake mouth morph array, synthetic frames at 60 and 30 fps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CALL_FILLER_IDS, type CallFillerId } from '../shared/voice/voice-call';
import { FILLER_MOUTH_KIND, FILLER_MOUTH_SCALE, MouthScale, fillerMouthScale, sanitizeFillerShape } from '../shared/behaviors/voice-call/mouth';
import { SpeakingSources } from '../src/voice/speaking-sources';
import { FillerMouthSignal } from '../src/voice/voice-call/filler-mouth';
import { CallFillerScheduler } from '../src/voice/voice-call/filler-scheduler';
import { CallControls } from '../src/voice/voice-call/call-controls';
import { FILLER_STUCK_S, UnboundMouth } from '../src/unbound/mouth';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('every short sound has a mouth class: 啊 哦 诶 open, 嗯 唔 hum; the ranges never meet and no two sounds repeat the same value', () => {
  assert.deepEqual(Object.keys(FILLER_MOUTH_KIND).sort(), [...CALL_FILLER_IDS].sort());
  assert.equal(FILLER_MOUTH_KIND.oh, 'open'); assert.equal(FILLER_MOUTH_KIND.eh, 'open'); assert.equal(FILLER_MOUTH_KIND.ahmm, 'open');
  for (const id of ['mm', 'mmmm', 'en', 'wu'] as CallFillerId[]) assert.equal(FILLER_MOUTH_KIND[id], 'hum');
  assert.ok(FILLER_MOUTH_SCALE.hum[1] < FILLER_MOUTH_SCALE.open[0], 'a hum is never as wide as a vowel');
  for (const id of CALL_FILLER_IDS) for (const random of [0, 0.3, 0.7, 1]) {
    const [low, high] = FILLER_MOUTH_SCALE[FILLER_MOUTH_KIND[id]], value = fillerMouthScale(id, () => random);
    assert.ok(value >= low - 1e-9 && value <= high + 1e-9, `${id} ${random} ${value}`);
  }
  // Not the same mouth twice in a row: a pick too close to the last one is taken again.
  const rolls = [0.5, 0.9]; let at = 0;
  assert.ok(Math.abs(fillerMouthScale('oh', () => rolls[at++ % 2], 0.825) - 0.825) > 0.04);
  assert.equal(sanitizeFillerShape(null), null); assert.equal(sanitizeFillerShape('x'), null); assert.equal(sanitizeFillerShape(Infinity), null);
  assert.equal(sanitizeFillerShape(0), null); assert.equal(sanitizeFillerShape(7), 1); assert.equal(sanitizeFillerShape(0.4), 0.4);
});

test('a short sound is a source of its own: a reply never clears it and it never clears a reply', () => {
  const sources = new SpeakingSources();
  assert.equal(sources.set('filler', true), true); assert.equal(sources.reply, false);
  assert.equal(sources.set('local', true), true); assert.equal(sources.reply, true);
  assert.equal(sources.set('filler', false), true, 'the filler ended while the reply speaks: still speaking');
  assert.equal(sources.set('local', false), false);
});

test('the old window stage\'s sources carry the scale: a hum is small, a reply is 1, and the filler ending does not grow the closing mouth', () => {
  const sources = new SpeakingSources();
  sources.set('filler', true, 0.25);
  assert.equal(sources.scale.frame(1 / 60, 0), 0.25);
  sources.set('filler', false);
  assert.equal(sources.scale.frame(1 / 60, 0.1), 0.25, 'the mouth is shutting: the scale stays');
  sources.set('local', true);
  const eased = sources.scale.frame(1 / 60, 0.1);
  assert.ok(eased > 0.25 && eased < 0.4, `a reply takes the open mouth over by easing (${eased})`);
  sources.clear();
  assert.equal(sources.scale.frame(1 / 60, 0), 1);
});

test('the signal: clip starts the mouth at once, ends it with the sound; the system voice only when the engine starts', async () => {
  const log: (number | null)[] = [];
  const signal = new FillerMouthSignal(shape => log.push(shape), () => 0.5);
  const clip = deferred();
  signal.attach('oh', { ended: clip.promise }); await tick();
  assert.equal(log.length, 1); assert.ok(log[0]! >= FILLER_MOUTH_SCALE.open[0], 'an open vowel'); assert.equal(signal.active, true);
  clip.resolve(); await tick();
  assert.deepEqual(log.slice(1), [null]); assert.equal(signal.active, false);

  log.length = 0;
  const began = deferred(), ended = deferred();
  signal.attach('mm', { began: began.promise, ended: ended.promise }); await tick();
  assert.deepEqual(log, [], 'the engine has not started: no mouth yet');
  began.resolve(); await tick();
  assert.equal(log.length, 1); assert.ok(log[0]! <= FILLER_MOUTH_SCALE.hum[1], '嗯 is a hum');
  ended.resolve(); await tick();
  assert.equal(log.at(-1), null);

  log.length = 0;
  const never = deferred(), over = deferred();
  signal.attach('wu', { began: never.promise, ended: over.promise }); over.resolve(); await tick(); never.resolve(); await tick();
  assert.deepEqual(log, [], 'a sound that failed before it began never moves the mouth');
});

test('the signal: a newer sound replaces an older one; the older end never clears it; release clears at once; a throwing sink is ignored', async () => {
  const log: (number | null)[] = [];
  const signal = new FillerMouthSignal(shape => log.push(shape), () => 0.5);
  const first = deferred(), second = deferred();
  signal.attach('mm', { ended: first.promise }); await tick();
  signal.attach('oh', { ended: second.promise }); await tick();
  assert.equal(log.length, 3); assert.equal(log[1], null); assert.ok(log[2]! > 0.5);
  first.resolve(); await tick();
  assert.equal(signal.active, true, 'the first sound ending late does not close the second one\'s mouth');
  signal.release(); assert.equal(log.at(-1), null); assert.equal(signal.active, false);
  const broken = new FillerMouthSignal(() => { throw new Error('stage gone'); });
  broken.attach('oh', { ended: Promise.resolve() }); await tick(); broken.release();
});

test('scheduler + signal: the mouth is up for the sound, and her reply, a barge-in or a hang-up take it down at once', async () => {
  for (const stopBy of ['ended', 'replySounding', 'reset'] as const) {
    const log: (number | null)[] = [];
    const signal = new FillerMouthSignal(shape => log.push(shape), () => 0.2);
    const sound = deferred();
    const scheduler = new CallFillerScheduler({
      choose: async () => ({ id: 'eh', delayMs: 0 }),
      player: { play: async id => { const started = { ended: sound.promise }; signal.attach(id, started); return started; }, stop: () => { signal.release(); } },
      replyBusy: () => false,
      timers: { set: callback => { callback(); return 1; }, clear: () => {} },
    });
    scheduler.paused(0); await tick(); await tick();
    assert.equal(log.length, 1, `${stopBy}: up`); assert.ok(log[0]! > 0.5);
    if (stopBy === 'ended') sound.resolve(); else if (stopBy === 'replySounding') scheduler.replySounding(); else scheduler.reset();
    await tick();
    assert.equal(log.at(-1), null, `${stopBy}: down`);
    assert.equal(signal.active, false);
  }
});

/** The real CallControls with a fake speech engine: the system voice's own start and end drive the mouth. */
async function callWithFakeVoice(id: CallFillerId) {
  const log: (number | null)[] = [], spoken: { onstart?: () => void; onend?: () => void; onerror?: () => void }[] = [];
  const g = globalThis as Record<string, unknown>, saved = { u: g.SpeechSynthesisUtterance, s: g.speechSynthesis };
  g.SpeechSynthesisUtterance = class { voice: unknown = null; lang = ''; rate = 1; volume = 1; onstart?: () => void; onend?: () => void; onerror?: () => void; constructor(readonly text: string) {} };
  g.speechSynthesis = { getVoices: () => [], speak: (u: { onstart?: () => void; onend?: () => void }) => { spoken.push(u); }, cancel: () => {} };
  let viewCallback: ((view: unknown) => void) | null = null;
  const view = (on: boolean) => ({ on, owner: 'controls', since: 1, ended: on ? null : 'user', fillers: { provider: 'system', paid: false, ready: true, missing: 0, voiceKey: 'k' } });
  const controls = new CallControls({
    windowKind: 'controls',
    api: {
      getVoiceCall: async () => view(true) as never, setVoiceCall: async () => view(true) as never, onVoiceCall: callback => { viewCallback = callback as never; return () => {}; },
      voiceCallFiller: async () => ({ id, delayMs: 0, voiceKey: undefined }), voiceCallFillerClips: async () => null, prepareVoiceCallFillers: async () => ({ generated: 0, failed: 0 }),
      noteJournalFact: async () => undefined,
    },
    audio: { acquire: async () => { throw new Error('no audio in this test'); } } as never,
    voice: () => ({ enabled: true, rate: 1, volume: 1, voiceURI: '' }) as never,
    media: () => ({ setCall: () => {}, setEchoGuard: () => {} }),
    replyBusy: () => false, notify: () => {}, mouth: shape => log.push(shape),
  });
  await controls.init(null);
  const restore = () => { g.SpeechSynthesisUtterance = saved.u; g.speechSynthesis = saved.s; };
  return { controls, log, spoken, restore, hangUp: () => viewCallback?.(view(false)) };
}

test('CallControls with the system voice: a filler moves her mouth from the engine\'s start to its end, with its class', async () => {
  for (const [id, kind] of [['oh', 'open'], ['mm', 'hum'], ['wu', 'hum'], ['eh', 'open']] as const) {
    const call = await callWithFakeVoice(id);
    try {
      call.controls.heard({ type: 'pause', quietMs: 0 } as never); await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(call.spoken.length, 1, `${id} was said`);
      assert.deepEqual(call.log, [], 'asked, not yet sounding: no mouth');
      call.spoken[0].onstart!(); await tick();
      assert.equal(call.log.length, 1);
      const [low, high] = FILLER_MOUTH_SCALE[kind];
      assert.ok(call.log[0]! >= low - 1e-9 && call.log[0]! <= high + 1e-9, `${id}: ${call.log[0]} in ${low}..${high}`);
      call.spoken[0].onend!(); await tick();
      assert.equal(call.log.at(-1), null, 'ended with the sound');
    } finally { call.restore(); }
  }
});

test('CallControls: her real reply taking the sound, and a hang-up, stop the filler mouth at once', async () => {
  for (const by of ['reply', 'hang-up', 'barge-in'] as const) {
    const call = await callWithFakeVoice('oh');
    try {
      call.controls.heard({ type: 'pause', quietMs: 0 } as never); await new Promise(resolve => setTimeout(resolve, 20));
      call.spoken[0].onstart!(); await tick();
      assert.equal(call.log.length, 1);
      if (by === 'reply') call.controls.replySound(true); else if (by === 'hang-up') call.hangUp(); else call.controls.heard({ type: 'barge-in' } as never);
      await tick();
      assert.equal(call.log.at(-1), null, by);
    } finally { call.restore(); }
  }
});

/** One mouth morph, one stage's per-frame step. */
function mouthRun(fps: number) {
  const influences = [0], mouth = new UnboundMouth(influences, 0), dt = 1 / fps, series: number[] = [];
  const run = (seconds: number, each?: (frame: number) => void) => {
    for (let frame = 0; frame < Math.round(seconds * fps); frame++) { each?.(frame); mouth.restore(); mouth.apply(dt); series.push(mouth.open); }
  };
  return { mouth, series, run };
}
const peak = (values: number[]) => Math.max(...values);
const maxStep = (values: number[]) => Math.max(...values.slice(1).map((value, index) => Math.abs(value - values[index])));

test('mouth per frame at 60 and 30 fps: 啊 opens wide, 嗯 stays nearly closed, both ease in and out; nothing happens before or after', () => {
  for (const fps of [60, 30]) {
    const open = mouthRun(fps), hum = mouthRun(fps), none = mouthRun(fps);
    open.run(0.2); open.mouth.fillerSound(0.85); open.run(0.6); open.mouth.fillerSound(null); open.run(1);
    hum.run(0.2); hum.mouth.fillerSound(0.27); hum.run(0.6); hum.mouth.fillerSound(null); hum.run(1);
    none.run(1.8);
    assert.equal(peak(none.series), 0, 'no sound, no mouth');
    assert.ok(peak(open.series) > 0.35, `${fps}: open peak ${peak(open.series)}`);
    assert.ok(peak(hum.series) < 0.2 && peak(hum.series) > 0.03, `${fps}: hum peak ${peak(hum.series)}`);
    assert.ok(peak(open.series) > peak(hum.series) * 2, 'the vowel is clearly wider than the hum');
    // Eased in and out: no frame jumps (the same easing a reply has: damped at 16 per second).
    assert.ok(maxStep(open.series) < 0.12 * (60 / fps), `${fps}: open max step ${maxStep(open.series)}`);
    assert.ok(maxStep(hum.series) < 0.05, `${fps}: hum max step ${maxStep(hum.series)}`);
    assert.ok(open.series[Math.round(fps * 0.2)] < peak(open.series) * 0.6, 'the first frame after it begins is not at its peak');
    // Closed again well within a second after the sound ended.
    assert.equal(open.series.at(-1), 0); assert.equal(hum.series.at(-1), 0);
  }
});

test('mouth per frame: the reply right after a filler takes the mouth without a jump (60 and 30 fps)', () => {
  for (const fps of [60, 30]) {
    for (const gap of [0, 0.1, 0.4]) {
      const run = mouthRun(fps);
      run.mouth.fillerSound(0.27); run.run(0.5);
      run.mouth.fillerSound(null); run.run(gap);
      run.mouth.speaking(true); run.run(1);
      const alone = mouthRun(fps); alone.run(0.5 + gap); alone.mouth.speaking(true); alone.run(1); // same clock, so the same flap phase at the onset
      const step = maxStep(run.series.slice(Math.round(fps * 0.4)));
      // The reply's own onset from a closed mouth is the biggest step there is; a filler before it never adds to it.
      assert.ok(step <= maxStep(alone.series.slice(Math.round(fps * 0.4))) + 0.005, `${fps} fps, gap ${gap}: max step ${step} vs a reply alone`);
      assert.ok(peak(run.series.slice(Math.round(fps * (0.5 + gap)))) > 0.4, 'the reply opens the mouth fully after the hum');
    }
    // A reply that sounds while the filler still does: the reply's scale wins, eased.
    const both = mouthRun(fps);
    both.mouth.fillerSound(0.27); both.run(0.4); both.mouth.speaking(true); both.mouth.fillerSound(null); both.run(1);
    assert.ok(maxStep(both.series) < 0.12 * (60 / fps), `${fps}: handover step ${maxStep(both.series)}`);
  }
});

test('mouth: a filler\'s lost "ended" report ends by itself; a reply\'s end does not clear the filler and the filler\'s end does not clear the reply', () => {
  const run = mouthRun(60);
  run.mouth.fillerSound(0.8); run.run(FILLER_STUCK_S + 2);
  assert.ok(run.series.at(-1)! < 0.002, 'a mouth that never gets its end report does not stay open');
  const mixed = mouthRun(60);
  mixed.mouth.speaking(true); mixed.mouth.fillerSound(0.3); mixed.run(0.5);
  mixed.mouth.fillerSound(null); mixed.run(0.5);
  assert.ok(peak(mixed.series.slice(-30)) > 0.3, 'the reply keeps moving when the filler ends');
  const other = mouthRun(60);
  other.mouth.fillerSound(0.9); other.run(0.4); other.mouth.speaking(true); other.mouth.speaking(false); other.run(0.1);
  assert.ok(other.mouth.isSpeaking, 'the reply ending did not clear the filler');
});

test('MouthScale: a reply is 1; the last filler\'s scale is kept while the mouth shuts; a closed mouth takes a new scale at once, an open one eases', () => {
  const scale = new MouthScale();
  scale.setFiller(0.25);
  assert.equal(scale.frame(1 / 60, 0), 0.25, 'closed mouth: at once');
  scale.setFiller(null);
  assert.equal(scale.frame(1 / 60, 0.1), 0.25, 'the filler ended, the mouth is closing: the scale stays, it never grows back');
  scale.setReply(true);
  const first = scale.frame(1 / 60, 0.1);
  assert.ok(first > 0.25 && first < 0.4, `open mouth: eased, not a jump (${first})`);
  let value = first; for (let frame = 0; frame < 120; frame++) value = scale.frame(1 / 60, 0.3);
  assert.ok(value > 0.99);
  assert.equal(scale.frame(0, 0.3), value, 'zero or bad deltas never move it');
});
