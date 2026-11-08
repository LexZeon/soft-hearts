import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_TTS_CONFIG, type TtsConfig, type TtsStreamEvent } from '../shared/tts';
import { FEED_CUE_INSTRUCTION, FEED_CUE_MAX_BYTES, FEED_CUE_TEXT, FEED_SOUND_IDS, type FeedCueKind } from '../shared/feed-cue';
import { FeedCueSynth } from '../electron/feed-cue';
import { SpeechRuntime } from '../electron/speech-runtime';
import { FEED_CUE_DEADLINE_MS, FEED_CUE_WAIT_MS, FEED_RESUME_DELAY_MS, FeedSpeechPause, type FeedCuePort } from '../src/ui/feed-speech-pause';
import { FeedCuePlayer, decodeCue } from '../src/ui/feed-cue-player';
import { SharedAudioOutput } from '../src/ui/audio-output';
import { CANCEL_SETTLE_MS, SpeechOutput } from '../src/ui/speech';
import { VoiceOutput } from '../src/ui/VoiceOutput';
import { CHEW_OPEN, EMPTY_CONTACT, MoodFeedback } from '../src/stage/mood-feedback';
import { flush } from './helpers/r02-audio-world';
import { pausableEngine, pauseAudioWorld } from './helpers/feed-pause-audio';

/*
 * B06 cues.
 */
const voice = { ...DEFAULT_SETTINGS.voice, enabled: true };
const atMouth = { feeding: true, prepared: false, near: 1 };
const prepared = { feeding: true, prepared: true, near: 1 };
const bite = { feeding: true, prepared: true, accepted: true };
const gone = { feeding: false, prepared: false };

function machine(t: TestContext, options: { ready?: boolean; cueMs?: number; shares?: boolean; voiceOn?: boolean; hang?: boolean } = {}) {
  const e = pausableEngine(t);
  const log: string[] = [], sent: unknown[] = [];
  let stops = 0;
  const cues: FeedCuePort = {
    prepare: () => log.push(`prepare@${e.now()}`),
    async play(kind, deadline) {
      log.push(`cue:${kind}@${e.now()}≤${deadline}`);
      if (options.ready === false) return null;
      return { ended: options.hang ? new Promise<void>(() => {}) : new Promise<void>(resolve => e.timers.set(() => { log.push(`end:${kind}@${e.now()}`); resolve(); }, options.cueMs ?? 500)) };
    },
    stop: () => { stops++; },
    sharesEngine: () => options.shares ?? false,
  };
  const pause = new FeedSpeechPause({
    targets: [{ pause: release => log.push(`pause${release ? '(release)' : ''}@${e.now()}`), resume: () => log.push(`resume@${e.now()}`) }],
    broadcast: message => sent.push(message), cues, voiceOn: () => options.voiceOn ?? true, timers: e.timers, now: e.now,
  });
  return { e, log, sent, pause, get stops() { return stops; } };
}

test('B06 cues: approach → "啊" with the pause, delivered → "嗯", then she goes on after the cue and the bite', async t => {
  const m = machine(t, { shares: true });
  m.pause.feedback({ feeding: true, prepared: false, near: 0.4 });
  m.pause.feedback(atMouth);
  assert.deepEqual(m.log, ['prepare@0', 'pause(release)@0', `cue:ah@0≤${FEED_CUE_DEADLINE_MS.ah}`], 'pause and "啊" together; a system-voice cue makes the reply release the engine');
  assert.deepEqual(m.sent, [{ paused: true, release: true }]);
  await m.e.advance(650); m.pause.feedback(prepared); m.pause.feedback(bite);
  assert.equal(m.pause.state, 'eating');
  assert.equal(m.log.at(-1), `cue:mm@650≤${FEED_CUE_DEADLINE_MS.mm}`);
  await m.e.advance(900); m.pause.feedback(gone); // the accepted phase ends after 900 ms
  await m.e.advance(FEED_RESUME_DELAY_MS + 200);
  assert.deepEqual(m.log.filter(item => item.startsWith('resume')), [`resume@${1550 + FEED_RESUME_DELAY_MS}`], 'not before the natural beat after the bite');
  assert.deepEqual(m.sent.at(-1), { paused: false });
});

test('B06 cues: taken away without delivery → no "嗯"; she continues once "啊" has ended', async t => {
  const m = machine(t, { cueMs: 600 });
  m.pause.feedback(atMouth);
  await m.e.advance(100); m.pause.feedback({ feeding: true, prepared: false, near: 0.3 });
  await m.e.advance(2000);
  assert.ok(!m.log.some(item => item.startsWith('cue:mm')));
  assert.deepEqual(m.log.filter(item => item.startsWith('end') || item.startsWith('resume')), ['end:ah@600', 'resume@750'],
    'after "啊" ends (plus a small gap), since that is later than the 0.4 s beat');
  m.pause.feedback(atMouth); await m.e.advance(50); m.pause.feedback(gone);
  await m.e.advance(1000);
  assert.equal(m.log.filter(item => item.startsWith('pause')).length, 2, 'a drag cancelled at the mouth pauses and resumes too');
  assert.equal(m.log.at(-1), 'resume@2850', 'again after its "啊" (2100–2700) plus the gap');
});

test('B06 cues: not ready in time → skipped, never late, and the resume does not wait for it', async t => {
  const m = machine(t, { ready: false });
  m.pause.feedback(atMouth);
  await m.e.advance(700); m.pause.feedback(bite);
  await m.e.advance(900); m.pause.feedback(gone);
  await m.e.advance(FEED_RESUME_DELAY_MS);
  assert.equal(m.log.at(-1), `resume@${1600 + FEED_RESUME_DELAY_MS}`);
  const hung = machine(t, { hang: true });
  hung.pause.feedback(atMouth); await hung.e.advance(10); hung.pause.feedback(gone);
  await hung.e.advance(FEED_CUE_WAIT_MS + 200);
  assert.equal(hung.log.at(-1), `resume@${10 + FEED_CUE_WAIT_MS + 150}`, 'a cue that never reports its end holds speech at most a bounded time');
});

test('B06 cues: read-aloud off → no cue at all, but the pause still happens; a cancel drops the cue in flight', async t => {
  const quiet = machine(t, { voiceOn: false, shares: true });
  quiet.pause.feedback(atMouth); quiet.pause.feedback(bite);
  assert.deepEqual(quiet.log.filter(item => !item.startsWith('prepare')), ['pause@0'], 'no cue and no engine release without read-aloud');
  const m = machine(t, { cueMs: 2000 });
  m.pause.feedback(atMouth); await m.e.advance(700); m.pause.feedback(bite); await m.e.advance(900); m.pause.feedback(gone);
  await m.e.advance(100);
  m.pause.cancelCues(); // e.g. the reply was stopped or the character switched
  assert.equal(m.stops, 1);
  await m.e.advance(FEED_RESUME_DELAY_MS);
  assert.equal(m.log.at(-1), `resume@${1700 + FEED_RESUME_DELAY_MS}`, 'resume no longer waits for the dropped "嗯"');
});

test('B06 cues: approach → deliver while nothing was speaking still cues; speech afterwards is untouched', async t => {
  const e = pausableEngine(t);
  const output = new VoiceOutput({
    getTtsConfig: () => ({ ...DEFAULT_TTS_CONFIG, provider: 'system' }), getVoiceConfig: () => voice,
    api: { async synthesizeSpeech() {}, async cancelSpeech() {}, onSpeechEvent: () => () => {} },
    onSpeaking: () => {}, onError: message => assert.fail(message), now: e.now,
    createSystem: (callback, hooks) => new SpeechOutput(callback, { ...hooks, timers: e.timers, now: e.now }),
  });
  t.after(() => output.dispose());
  const kinds: FeedCueKind[] = [];
  const pause = new FeedSpeechPause({ targets: [output], timers: e.timers, now: e.now, voiceOn: () => true,
    cues: { async play(kind) { kinds.push(kind); return { ended: Promise.resolve() }; }, stop() {}, sharesEngine: () => true } });
  pause.feedback(atMouth); await e.advance(700); pause.feedback(bite); await e.advance(900); pause.feedback(gone);
  await e.advance(FEED_RESUME_DELAY_MS + 10);
  assert.deepEqual(kinds, ['ah', 'mm']);
  assert.equal(output.paused, false);
  const speech = output.speak('之后的一句。', voice);
  await flush();
  assert.deepEqual(e.queued.map(item => item.text), ['之后的一句。'], 'nothing stale was queued, the next reply speaks at once');
  e.start(e.queued[0]); e.end(e.queued[0]); await speech;
});

test('B06 cues on the system voice: release mode gives the engine up at the last word; the reply continues from there', async t => {
  const e = pausableEngine(t);
  const output = new SpeechOutput(() => {}, { timers: e.timers, now: e.now });
  const text = '我们一起去看看吧。';
  const speech = output.speak(text, voice);
  e.start(e.queued[0]); e.boundary(e.queued[0], 4);
  output.pause(true);
  assert.ok(!e.log.some(item => item.startsWith('pause')), 'no speechSynthesis.pause(): a paused engine would hold the cue back');
  assert.equal(e.log.at(-1), 'cancel@0');
  output.resume(); await e.advance(CANCEL_SETTLE_MS);
  assert.deepEqual(e.queued.map(item => item.text), [text, text.slice(4)]);
  e.start(e.queued[1]); e.end(e.queued[1]); await speech;
  // A natively paused utterance that the engine ends from outside (another window's cue) is continued, not lost.
  const again = output.speak(text, voice);
  await e.advance(CANCEL_SETTLE_MS);
  const utterance = e.queued[2];
  e.start(utterance); e.boundary(utterance, 2);
  output.pause(); await e.advance(400);
  e.end(utterance);
  output.resume(); await e.advance(CANCEL_SETTLE_MS);
  assert.equal(e.queued.at(-1)!.text, text.slice(2));
  e.start(e.queued.at(-1)!); e.end(e.queued.at(-1)!); await again;
});

function cuePlayer(t: TestContext, config: TtsConfig, clip: () => Promise<{ pcm: string } | null>) {
  const w = pauseAudioWorld(t);
  const calls: string[] = []; // any cue kind (X1 added "think")
  let current = config;
  const audio = new SharedAudioOutput({ createContext: w.createContext, now: w.now, timers: w.timers });
  const player = new FeedCuePlayer({ api: { async synthesizeFeedCue(kind) { calls.push(kind); return clip(); } },
    getTtsConfig: () => current, getVoiceConfig: () => voice, audio, timers: w.timers, now: w.now });
  t.after(() => { player.dispose(); audio.dispose(); });
  return { w, player, calls, setConfig(next: TtsConfig) { current = next; } };
}
const pcm = (ms: number) => Buffer.alloc(Math.round(ms * 24) * 2).toString('base64');
const bailian: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'synthetic', apiKey: 'k' };

test('B06 cue player (Bailian): an uncached clip is skipped and fetched; a cached one starts at once; a new voice never plays the old clip', async t => {
  const c = cuePlayer(t, bailian, async () => ({ pcm: pcm(400) }));
  assert.equal(await c.player.play('ah', 250), null, 'not ready: skipped rather than late');
  await c.w.advance(5);
  // #32: once she is being fed, every feeding sound is fetched for this voice (the one asked for first), each once.
  assert.equal(c.calls[0], 'ah', 'the missing one first');
  assert.deepEqual([...c.calls].sort(), [...FEED_SOUND_IDS].sort(), 'every feeding sound is fetched for this voice');
  const started = await c.player.play('ah', 250);
  assert.ok(started, 'cached: plays');
  const source = c.w.contexts[0].sources.at(-1)!;
  assert.ok(Math.abs(source.buffer!.duration - 0.4) < 1e-9);
  let ended = false; void started!.ended.then(() => { ended = true; });
  await c.w.advance(450);
  assert.equal(ended, true);
  c.setConfig({ ...bailian, voice: 'another-voice' });
  assert.equal(await c.player.play('mm', 350), null, 'another character/voice: the old clip is never used');
  c.calls.length = 0;
  let release!: (value: { pcm: string }) => void;
  const slow = cuePlayer(t, bailian, () => new Promise(resolve => { release = resolve; }));
  slow.player.prepare(); await slow.w.advance(1);
  slow.setConfig({ ...bailian, voice: 'switched' });
  release({ pcm: pcm(300) }); await slow.w.advance(1);
  slow.setConfig(bailian);
  assert.equal(await slow.player.play('ah', 250), null, 'a clip that arrived after a switch was dropped');
});

test('B06 cue player: decoding is strict and bounded', () => {
  assert.equal(decodeCue({ pcm: pcm(100) })!.length, 2400);
  assert.equal(decodeCue({ pcm: Buffer.alloc(FEED_CUE_MAX_BYTES + 2).toString('base64') }), null, 'longer than a cue');
  assert.equal(decodeCue({ pcm: '' }), null);
  assert.equal(decodeCue({ pcm: 'not base64!' }), null);
});

test('B06 cue player (system voice): "啊" is spoken after the settle gap, and skipped if the engine does not start it in time', async t => {
  const e = pausableEngine(t);
  const player = new FeedCuePlayer({ api: {}, getTtsConfig: () => ({ ...DEFAULT_TTS_CONFIG, provider: 'system' }), getVoiceConfig: () => voice, timers: e.timers, now: e.now });
  t.after(() => player.dispose());
  assert.equal(player.sharesEngine(), true);
  const first = player.play('ah', 250);
  await e.advance(CANCEL_SETTLE_MS);
  assert.deepEqual(e.queued.map(item => item.text), [FEED_CUE_TEXT.ah]);
  assert.ok(e.queued[0].pitch > 1, 'a touch brighter than her reply voice');
  e.start(e.queued[0]);
  const started = await first;
  assert.ok(started);
  e.end(e.queued[0]); await started!.ended;
  const late = player.play('mm', 250);
  await e.advance(CANCEL_SETTLE_MS + 250);
  assert.equal(await late, null);
  assert.equal(e.log.at(-1), `cancel@${CANCEL_SETTLE_MS + 250}`, 'withdrawn at its deadline, counted from the moment it was asked for');
  e.start(e.queued[1]); // the engine starting it later changes nothing
  assert.equal(e.queued.length, 2);
});

test('B06 cue host: fixed text in the character voice, one bounded clip per voice and kind, beside the reply speech', async () => {
  const requests: { text: string; config: TtsConfig }[] = [];
  let fail = false, chunks = 2;
  const synth = new FeedCueSynth(async (config, text, _signal, emit) => {
    requests.push({ text, config });
    if (fail) throw new Error('network');
    for (let i = 0; i < chunks; i++) await emit({ type: 'audio', data: pcm(150), format: 'pcm_s16le', sampleRate: 24000, channels: 1 } as TtsStreamEvent);
    await emit({ type: 'done', firstAudioMs: 1, audioBytes: chunks * 7200 });
    return { firstAudioMs: 1, audioBytes: chunks * 7200 };
  }, () => 0);
  await assert.rejects(synth.clip('啊', bailian), /种类/);
  assert.equal(await synth.clip('ah', { ...bailian, provider: 'system' }), null);
  const [a, b] = await Promise.all([synth.clip('ah', bailian), synth.clip('ah', bailian)]);
  assert.equal(requests.length, 1, 'one request for concurrent asks');
  assert.equal(Buffer.from(a!.pcm, 'base64').length, 2 * 7200);
  assert.deepEqual(a, b);
  assert.equal(requests[0].text, FEED_CUE_TEXT.ah);
  assert.equal(requests[0].config.instruction, FEED_CUE_INSTRUCTION);
  assert.equal(requests[0].config.voice, bailian.voice, 'her own voice');
  await synth.clip('ah', bailian);
  assert.equal(requests.length, 1, 'cached');
  await synth.clip('ah', { ...bailian, voice: 'other' });
  assert.equal(requests.length, 2, 'another voice is its own clip');
  chunks = 40;
  assert.equal(await synth.clip('mm', bailian), null, 'a stream longer than a cue is refused');
  fail = true;
  assert.equal(await synth.clip('mm', { ...bailian, voice: 'x' }), null);
  const count = requests.length;
  assert.equal(await synth.clip('mm', { ...bailian, voice: 'x' }), null);
  assert.equal(requests.length, count, 'a failed voice is not asked again right away');
  // The reply runtime is separate: a cue never cancels or replaces reply speech.
  const events: unknown[] = [];
  let finish!: () => void;
  const runtime = new SpeechRuntime(() => bailian, (_owner, event) => events.push(event), () => new Promise<void>(resolve => { finish = resolve; }));
  const reply = runtime.speak(1, 'reply-transport', '回复', { replyId: 'r' });
  await new FeedCueSynth(async (_c, _t, _s, emit) => { await emit({ type: 'audio', data: pcm(100), format: 'pcm_s16le', sampleRate: 24000, channels: 1 }); }).clip('mm', bailian);
  assert.equal(runtime.busy, true); assert.deepEqual(events, [], 'no cancellation reached the reply');
  finish(); await reply;
});

test('B06 eating: after the bite she chews with a nearly closed "mm" mouth for as long as the bite lasts', () => {
  const layer = new MoodFeedback();
  const mood = { mood: 'happy', phase: 'food-ready', expressive: true, face: 50, posture: 50, playful: 50, responding: false };
  for (let i = 0; i < 40; i++) layer.frame(1 / 30, { ...EMPTY_CONTACT, feeding: true, prepared: true, near: 1 }, mood);
  const mouths: number[] = [], owners: number[] = [];
  for (let i = 0; i < 27; i++) { const out = layer.frame(1 / 30, { ...EMPTY_CONTACT, ...bite }, mood); mouths.push(out.mouth); owners.push(out.mouthOwner); }
  const chewing = mouths.slice(12);
  assert.ok(Math.max(...chewing) <= CHEW_OPEN + 0.1 && Math.max(...chewing) - Math.min(...chewing) > 0.03, `small rhythmic chewing (${Math.min(...chewing).toFixed(3)}–${Math.max(...chewing).toFixed(3)})`);
  assert.ok(owners.at(-1)! > 0.9, 'feeding keeps the mouth (speech is paused anyway)');
  for (let i = 1; i < mouths.length; i++) assert.ok(Math.abs(mouths[i] - mouths[i - 1]) < 0.2, 'no snap');
  let out = layer.frame(1 / 30, EMPTY_CONTACT, mood);
  for (let i = 0; i < 60; i++) out = layer.frame(1 / 30, EMPTY_CONTACT, mood);
  assert.ok(out.mouth < 0.01 && out.mouthOwner < 0.01, 'the mouth returns to speech after the bite');
});
