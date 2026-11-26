// 2026-11-25 只有插话会打断她 (docs/claude/2026-11-25-no-interrupt.md): ticking 「发图片」 cut One off mid-reply. Only the user cutting in (a new message,
// a real spoken barge-in, a stop control, read-aloud off, another character, quitting, a call) ends her reply or its voice. Every other settings or
// perception change applies from her next reply, or waits until she is done. Data-driven: each switch below is toggled while she speaks.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { DEFAULT_TTS_CONFIG, type TtsConfig } from '../shared/voice/tts';
import { buildVoiceJournalEntry, settingsSaveCutsReading, SETTING_DEFERRALS, DEFERRED_WHILES, type SpeechDiagnosticRecord, type DeferredWhile } from '../shared/voice';
import { SettleWhenQuiet } from '../electron/voice/settle-when-quiet';
import { FrozenReadingVoices } from '../electron/voice/frozen-reading-voices';
import { visionContextChange, visionContextKey, type VisionContextParts } from '../electron/senses/vision-context';
import { StreamingVoicePlayer } from '../src/voice/EmotionalVoice';
import { VoiceOutput, type VoiceOutputEvent } from '../src/voice/VoiceOutput';
import { SharedAudioOutput } from '../src/voice/audio-output';
import { flush, pcm, world } from './helpers/r02-audio-world';

// ---- 1. the settings save: only another model ends her reading
const base = structuredClone(DEFAULT_SETTINGS);
const changes: Array<[string, (s: typeof base) => void, boolean]> = [
  ['volume', s => { s.voice.volume = 0.2; }, false],
  ['rate', s => { s.voice.rate = 1.4; }, false],
  ['system voice', s => { s.voice.voiceURI = 'another'; }, false],
  ['mood influence', s => { s.voice.moodInfluence = 10; }, false],
  ['first chunk', s => { s.voice.firstChunk = 'comma'; }, false],
  ['pause and talk', s => { s.voice.pauseTalk = true; }, false],
  ['tts provider', s => { s.tts = { ...(s.tts ?? DEFAULT_TTS_CONFIG), provider: 'fish' } as typeof s.tts; }, false],
  ['tts voice', s => { s.tts = { ...(s.tts ?? DEFAULT_TTS_CONFIG), voice: 'other' } as typeof s.tts; }, false],
  ['claude provider', s => { s.provider = { ...s.provider, model: 'another' } as typeof s.provider; }, false],
  ['persona text', s => { s.persona = 'a new card text'; }, false],
  ['camera framing', s => { s.camera = { ...s.camera, distance: 9 } as typeof s.camera; }, false],
  ['always on top', s => { s.pet.alwaysOnTop = !s.pet.alwaysOnTop; }, false], // no-pet-ok: the settings field of her window
  ['another model', s => { s.model = { ...(s.model ?? { name: 'm', url: 'u' }), path: 'C:/other/model.pmx' } as typeof s.model; }, true],
];
for (const [name, change, cuts] of changes) {
  test(`a settings save that changes ${name} ${cuts ? 'ends' : 'does not end'} her reading`, () => {
    const next = structuredClone(base); change(next);
    assert.equal(settingsSaveCutsReading(base, next), cuts);
  });
}

// ---- 2. a change that must restart something waits for her
function gate(t: TestContext) {
  let busy: DeferredWhile | null = 'replying';
  let tick: (() => void) | null = null, stopped = 0, now = 0;
  const notes: Array<[string, string]> = [], ran: string[] = [];
  const g = new SettleWhenQuiet({ busy: () => busy, note: (what, during) => notes.push([what, during]), now: () => now, capMs: 1000,
    every: (_ms, run) => { tick = run; return () => { tick = null; stopped++; }; } });
  return { g, notes, ran, set: (b: DeferredWhile | null) => { busy = b; }, tick: () => tick?.(), alive: () => tick !== null, advance: (ms: number) => { now += ms; }, stopped: () => stopped };
}
test('a restart waits while she replies or speaks, then runs once; the journal row has closed words only', async t => {
  const h = gate(t);
  void h.g.run('connection', () => { h.ran.push('connection'); });
  void h.g.run('connection', () => { h.ran.push('connection again'); }); // the same kind: the later one replaces it
  void h.g.run('persona', () => { h.ran.push('persona'); });
  assert.deepEqual(h.ran, [], 'nothing ran while she replies');
  h.tick();
  assert.deepEqual(h.ran, [], 'still replying');
  h.set('speaking'); h.tick();
  assert.deepEqual(h.ran, [], 'her voice is still reading');
  h.set(null); h.tick(); await h.g.flush(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.ran, ['connection again', 'persona']);
  assert.equal(h.alive(), false, 'the poll stops');
  assert.deepEqual(h.notes, [['connection', 'replying'], ['persona', 'replying']]);
  for (const [what, during] of h.notes) assert.ok(SETTING_DEFERRALS.includes(what as never) && DEFERRED_WHILES.includes(during as never));
});
test('a restart runs at once when she is quiet; you cutting in (flush) runs what waited; the cap ends a wait that never ends', async t => {
  const quiet = gate(t); quiet.set(null);
  void quiet.g.run('connection', () => { quiet.ran.push('now'); });
  assert.deepEqual(quiet.ran, ['now']); assert.deepEqual(quiet.notes, []);
  const cut = gate(t);
  void cut.g.run('connection', () => { cut.ran.push('a'); });
  await cut.g.flush();
  assert.deepEqual(cut.ran, ['a'], 'a new message of yours: what waited goes first');
  const long = gate(t);
  void long.g.run('persona', () => { long.ran.push('late'); });
  long.advance(1500); long.tick(); await long.g.flush(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(long.ran, ['late'], 'a turn that never ends does not hold it for ever');
});
test('a change that waits by itself (the page clears after her reply) writes its row once per busy stretch', async t => {
  const h = gate(t);
  assert.equal(h.g.waitsFor('sight-off'), true); assert.equal(h.g.waitsFor('sight-off'), true);
  assert.deepEqual(h.notes, [['sight-off', 'replying']], 'asked twice by the same save: one row');
  h.set(null);
  assert.equal(h.g.waitsFor('sight-off'), false, 'quiet: it may go now');
  h.set('speaking'); assert.equal(h.g.waitsFor('sight-off'), true);
  assert.equal(h.notes.length, 2);
});
test('the deferred row is built from closed words and nothing else', () => {
  const ok = buildVoiceJournalEntry('setting-deferred', { characterId: 'c', what: 'connection', during: 'speaking', note: 'free text' }, 'c');
  assert.ok(ok && JSON.stringify(ok).includes('connection') && !JSON.stringify(ok).includes('free text'));
  assert.equal(buildVoiceJournalEntry('setting-deferred', { what: 'my words', during: 'speaking' }, null), null);
  assert.equal(buildVoiceJournalEntry('setting-deferred', { what: 'persona', during: 'whenever' }, null), null);
});

// ---- 3. perception switches: a source turned on clears nothing; turned off waits for her; another conversation or window is a switch
const parts = (over: Partial<VisionContextParts> = {}): VisionContextParts => ({ speech: 's', scope: 's:1', visible: true, display: 1, screen: false, camera: false, cameraOwner: null, ...over });
const perception: Array<[string, VisionContextParts, VisionContextParts, string]> = [
  ['pictures (camera) on, nothing was on', parts(), parts({ camera: true, cameraOwner: 'desk' }), 'none'],
  ['camera on while the screen is on', parts({ screen: true }), parts({ screen: true, camera: true, cameraOwner: 'desk' }), 'grew'],
  ['screen on while the camera is on', parts({ camera: true, cameraOwner: 'desk' }), parts({ camera: true, cameraOwner: 'desk', screen: true }), 'grew'],
  ['camera off', parts({ camera: true, cameraOwner: 'desk' }), parts(), 'off'],
  ['screen off, camera stays', parts({ screen: true, camera: true, cameraOwner: 'desk' }), parts({ camera: true, cameraOwner: 'desk' }), 'off'],
  ['camera moves to another window', parts({ camera: true, cameraOwner: 'desk' }), parts({ camera: true, cameraOwner: 'controls' }), 'off'],
  ['only her mood token turns', parts({ screen: true }), parts({ screen: true, scope: 's:2' }), 'mood'],
  ['another character (a switch)', parts({ screen: true }), parts({ screen: true, speech: 'other', scope: 'other:1' }), 'seeing'],
  ['her window leaves the screen', parts({ screen: true }), parts({ screen: true, visible: false }), 'seeing'],
];
for (const [name, before, after, expected] of perception) {
  test(`vision context: ${name} -> ${expected}`, () => {
    assert.equal(visionContextChange(visionContextKey(before), visionContextKey(after)), expected);
  });
}

// ---- 4. a reply keeps the voice it started in
test('a reply keeps the voice it started in; the next reply gets the new one; only recent replies are remembered', () => {
  const frozen = new FrozenReadingVoices<string>(2);
  let current = 'one';
  assert.equal(frozen.of('r1', () => current), 'one');
  current = 'two';
  assert.equal(frozen.of('r1', () => current), 'one', 'the same reply: the same voice');
  assert.equal(frozen.of('r2', () => current), 'two', 'her next reply: the new voice');
  frozen.of('r3', () => current);
  assert.equal(frozen.of('r1', () => 'three'), 'three', 'only the last two are kept');
});

// ---- 5. the window's output: a changed voice never stops a reply that is playing; read-aloud off and a preview change still do
function cloud(t: TestContext) {
  const w = world(t, {});
  const records: SpeechDiagnosticRecord[] = [];
  let listener: ((event: VoiceOutputEvent) => void) | null = null;
  const requested: string[] = [];
  const config: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'x', apiKey: 'k' };
  const voice = { ...DEFAULT_SETTINGS.voice, enabled: true };
  const audio = new SharedAudioOutput({ createContext: w.createContext, now: w.now, timers: w.timers });
  let ids = 0;
  const output = new VoiceOutput({
    getTtsConfig: () => config, getVoiceConfig: () => voice,
    api: { async synthesizeSpeech(request) { requested.push(String((request as { id?: string }).id)); }, async cancelSpeech() {}, async releaseSpeech() {}, onSpeechEvent(cb) { listener = cb; return () => { listener = null; }; },
      async recordSpeechDiagnostic(record) { records.push(record); } },
    onSpeaking: () => {}, onError: () => {}, onState: () => {}, createId: () => `id-${++ids}`, audio, now: w.now,
    createPlayer: callbacks => new StreamingVoicePlayer({ ...callbacks, now: w.now, timers: w.timers }),
  });
  t.after(() => { output.dispose(); audio.dispose(); });
  /** An event for every id the output made: the one that is the request's reaches `continue`. */
  const poke = async () => { for (let i = 1; i <= ids + 1; i++) listener?.({ id: `id-${i}`, type: 'audio', data: pcm(480), format: 'pcm_s16le', sampleRate: 24000, channels: 1, firstAudioMs: 5 } as unknown as VoiceOutputEvent); await flush(); };
  return { w, output, records, config, voice, poke };
}
test('changing the voice, the rate or the provider while a reply plays does not stop it', async t => {
  const h = cloud(t);
  const spoken = h.output.speak('你好。', h.voice, { replyId: 'r' }).catch(() => {});
  await flush(); await h.w.advance(100);
  h.config.voice = 'another-voice'; h.config.rate = 1.5; h.voice.rate = 1.5;
  await h.poke(); await h.w.advance(100); await h.poke();
  assert.equal(h.records.filter(r => r.outcome === 'cancelled').length, 0, 'nothing was cancelled');
  h.output.stop('stop'); await flush(); await spoken;
  assert.equal(h.records.find(r => r.outcome === 'cancelled')?.cancelBy, 'stop', 'a stop of yours still stops her');
});
test('read-aloud turned off while a reply plays still stops its voice', async t => {
  const h = cloud(t);
  const spoken = h.output.speak('你好。', h.voice, { replyId: 'r' }).catch(() => {});
  await flush(); await h.w.advance(100);
  h.voice.enabled = false;
  await h.poke(); await flush(); await spoken;
  assert.ok(h.records.some(r => r.outcome === 'cancelled' && r.cancelBy === 'switch'), 'the voice stopped');
});
