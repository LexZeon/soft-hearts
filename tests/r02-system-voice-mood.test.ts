import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_TTS_CONFIG, type ApprovedReplySpeechSegment } from '../shared/tts';
import type { MoodContext, MoodLabel } from '../shared/mood';
import type { FatiguePhase } from '../shared/fatigue';
import { DEFAULT_MOOD_VOICE_INFLUENCE, SPEECH_TONE_RANGE, speechToneFor, systemVoiceScale, validSpeechTone, type SpeechTone } from '../shared/speech-mood-tone';
import { validateSpeechDiagnosticRecord, type SpeechDiagnosticRecord } from '../shared/speech-diagnostics';
import { ReplySpeechStyles, freezeTurnSpeechStyle } from '../electron/speech-emotion';
import { validateSettings } from '../electron/validation';
import { VoiceOutput } from '../src/ui/VoiceOutput';
import { SpeechOutput } from '../src/ui/speech';
import { CompletedReplySpeechQueue } from '../src/ui/completed-reply-speech-queue';
import { flush } from './helpers/r02-audio-world';
import { pausableEngine } from './helpers/feed-pause-audio';

/*
 * R02. The reply's frozen mood becomes a bounded nudge on
 * the user's own rate and on pitch; 0 % turns it off; Bailian is unaffected.
 */
const labels: MoodLabel[] = ['calm', 'close', 'content', 'happy', 'excited', 'concerned', 'disappointed', 'upset', 'longing', 'sad', 'relieved', 'tense-expectation'];
const contexts: MoodContext[] = ['neutral', 'positive', 'support', 'concern', 'disappointment', 'offense'];
const fatigues: (FatiguePhase | undefined)[] = [undefined, 'awake', 'light-drowsy', 'drowsy', 'falling-asleep', 'asleep', 'micro-awake'];
const neutral = (primary: MoodLabel, fatigue?: FatiguePhase) => speechToneFor({ primary, context: 'neutral' }, fatigue);

test('R02 mood tone: happy/excited faster and higher, sad/tired slower and lower, calm neutral, nervous a little faster', () => {
  assert.deepEqual(neutral('calm'), { rate: 0, pitch: 0 });
  const excited = neutral('excited'), happy = neutral('happy'), sad = neutral('sad'), nervous = neutral('tense-expectation');
  assert.ok(excited.rate > happy.rate && happy.rate > 0 && excited.pitch > happy.pitch && happy.pitch > 0);
  assert.ok(sad.rate < 0 && sad.pitch < 0);
  assert.ok(neutral('disappointed').rate < 0 && neutral('longing').pitch < 0);
  assert.ok(nervous.rate > 0, 'nervous: slightly faster');
  assert.ok(neutral('concerned').rate > 0, 'stress without a support context reads as nervous');
  const comforting = speechToneFor({ primary: 'concerned', context: 'concern' });
  assert.ok(comforting.rate < 0 && comforting.pitch < 0, 'comforting the user: gentler and slower');
  assert.ok(speechToneFor({ primary: 'calm', context: 'positive' }).rate > 0, 'a positive moment lifts even a calm label');
  const tired = neutral('calm', 'drowsy'), sleepy = neutral('calm', 'falling-asleep');
  assert.ok(tired.rate < 0 && sleepy.rate < tired.rate && sleepy.pitch < tired.pitch, 'tired: slower and lower, more so when sleepier');
  assert.ok(neutral('happy', 'drowsy').rate < happy.rate, 'fatigue is added on top of the mood');
});

test('R02 mood multipliers: always bounded, monotonic in the setting, and 0 % is exactly the user\'s own voice', () => {
  for (const primary of labels) for (const context of contexts) for (const fatigue of fatigues) {
    const tone = speechToneFor({ primary, context }, fatigue);
    assert.ok(Math.abs(tone.rate) <= 1 && Math.abs(tone.pitch) <= 1);
    let previous = systemVoiceScale(tone, 0);
    assert.deepEqual(previous, { rate: 1, pitch: 1 }, '0 % = off');
    for (let influence = 10; influence <= 100; influence += 10) {
      const scale = systemVoiceScale(tone, influence);
      assert.ok(scale.rate >= 1 - SPEECH_TONE_RANGE.rate - 1e-9 && scale.rate <= 1 + SPEECH_TONE_RANGE.rate + 1e-9, `rate ${scale.rate}`);
      assert.ok(scale.pitch >= 1 - SPEECH_TONE_RANGE.pitch - 1e-9 && scale.pitch <= 1 + SPEECH_TONE_RANGE.pitch + 1e-9, `pitch ${scale.pitch}`);
      assert.ok(Math.sign(scale.rate - previous.rate) * Math.sign(tone.rate) >= 0 && Math.sign(scale.pitch - previous.pitch) * Math.sign(tone.pitch) >= 0,
        'more influence only moves further in the mood\'s own direction');
      previous = scale;
    }
  }
  const order = (['sad', 'disappointed', 'calm', 'happy', 'excited'] as MoodLabel[]).map(label => systemVoiceScale(neutral(label), 100));
  for (let i = 1; i < order.length; i++) assert.ok(order[i].rate >= order[i - 1].rate && order[i].pitch > order[i - 1].pitch, 'sad < calm < happy < excited');
  assert.deepEqual(systemVoiceScale(neutral('excited'), 100), { rate: 1.1, pitch: 1.08 });
  assert.deepEqual(systemVoiceScale(neutral('excited'), undefined), systemVoiceScale(neutral('excited'), DEFAULT_MOOD_VOICE_INFLUENCE), 'default 50 %');
  assert.deepEqual(systemVoiceScale(neutral('excited'), 500), systemVoiceScale(neutral('excited'), 100));
  assert.deepEqual(systemVoiceScale(null, 100), { rate: 1, pitch: 1 });
  assert.equal(validSpeechTone({ rate: Infinity, pitch: 0 }), null);
  assert.deepEqual(validSpeechTone({ rate: 7, pitch: -3 }), { rate: 1, pitch: -1 });
});

test('R02 mood tone is frozen by the host with the reply (mood + fatigue) and carried only on its own segments', () => {
  const styles = new ReplySpeechStyles(), owner = 3, scope = 'scope';
  const segment = Object.freeze({ replyId: 'r', index: 0, text: '好呀。', visibleText: '好呀。', context: { replyId: 'r', segmentIndex: 0 } });
  styles.begin(owner, 'r', scope);
  assert.equal(freezeTurnSpeechStyle(styles, { owner, replyId: 'r', scope, config: { ...DEFAULT_TTS_CONFIG }, persona: '',
    mood: { primary: 'happy', context: 'positive' }, fatigue: { phase: 'drowsy' } }), true);
  const toned = styles.withTone(owner, 'r', scope, segment);
  assert.deepEqual(toned.tone, speechToneFor({ primary: 'happy', context: 'positive' }, 'drowsy'));
  // The completed reply reports a different final mood: the frozen voice does not change mid-reply.
  assert.equal(styles.complete(owner, 'r', scope, { primary: 'sad', context: 'disappointment' }), true);
  assert.deepEqual(styles.withTone(owner, 'r', scope, segment).tone, toned.tone);
  assert.equal(styles.withTone(owner, 'other', scope, segment), segment, 'another reply gets nothing');
  styles.begin(owner, 'calm', scope);
  styles.complete(owner, 'calm', scope, { primary: 'calm', context: 'neutral' });
  const plain = { ...segment, replyId: 'calm' };
  assert.equal(styles.withTone(owner, 'calm', scope, plain), plain, 'a neutral tone changes nothing and is left out');
});

function systemReply(t: TestContext, moodInfluence?: number) {
  const e = pausableEngine(t);
  const records: SpeechDiagnosticRecord[] = [];
  const voice = { ...DEFAULT_SETTINGS.voice, enabled: true, rate: 1.2, ...(moodInfluence === undefined ? {} : { moodInfluence }) };
  const output = new VoiceOutput({
    getTtsConfig: () => ({ ...DEFAULT_TTS_CONFIG, provider: 'system' }), getVoiceConfig: () => voice,
    api: { async synthesizeSpeech() { assert.fail('no cloud request'); }, async cancelSpeech() {}, onSpeechEvent: () => () => {},
      async recordSpeechDiagnostic(record) { records.push(record); } },
    onSpeaking: () => {}, onError: message => assert.fail(message), now: e.now,
    createSystem: (callback, hooks) => new SpeechOutput(callback, { ...hooks, timers: e.timers, now: e.now }),
  });
  t.after(() => output.dispose());
  return { e, records, voice, output };
}
async function speakReply(r: ReturnType<typeof systemReply>, tones: (SpeechTone | undefined)[]) {
  const pieces: ApprovedReplySpeechSegment[] = tones.map((tone, index) => ({ replyId: 'r', index, text: `第${index + 1}句。`, visibleText: '',
    context: { replyId: 'r', segmentIndex: index }, ...(tone ? { tone } : {}) }));
  const queue = new CompletedReplySpeechQueue({
    async nextReplySpeechSegment(_id, completedIndex) { return pieces[completedIndex === undefined ? 0 : completedIndex + 1] ?? null; },
    async cancelReplySpeech() {},
  }, async () => assert.fail('one owner'), () => true, id => r.output.openReply({ ...r.voice }, id));
  const done = queue.speak('r');
  for (let index = 0; index < pieces.length; index++) {
    await flush(); await r.e.advance(1);
    const utterance = r.e.queued[index];
    r.e.start(utterance); await flush();
    if (index === 0) r.voice.moodInfluence = 100; // the slider moves mid-reply: this reply keeps its frozen value
    r.e.end(utterance);
  }
  await done;
}

test('R02 system voice: the reply speaks with its frozen multipliers on every segment, and records them (numbers only)', async t => {
  const r = systemReply(t);
  const happy = speechToneFor({ primary: 'happy', context: 'positive' });
  await speakReply(r, [happy, speechToneFor({ primary: 'sad', context: 'neutral' })]);
  const scale = systemVoiceScale(happy, DEFAULT_MOOD_VOICE_INFLUENCE);
  assert.ok(scale.rate > 1 && scale.pitch > 1);
  for (const utterance of r.e.queued) {
    assert.ok(Math.abs(utterance.rate - 1.2 * scale.rate) < 1e-9, 'on top of the user\'s own rate');
    assert.equal(utterance.pitch, scale.pitch, 'no per-sentence wobble: the second segment keeps the first one\'s tone');
  }
  assert.equal(r.records.length, 2);
  for (const record of r.records) {
    assert.deepEqual([record.rateScale, record.pitchScale], [scale.rate, scale.pitch]);
    assert.deepEqual(validateSpeechDiagnosticRecord(JSON.parse(JSON.stringify(record))), record);
  }
});

test('R02 system voice: 0 % leaves the user\'s voice exactly as configured', async t => {
  const r = systemReply(t, 0);
  await speakReply(r, [speechToneFor({ primary: 'excited', context: 'positive' })]);
  assert.equal(r.e.queued[0].rate, 1.2);
  assert.equal(r.e.queued[0].pitch, 1, 'the engine default pitch is never touched');
  assert.deepEqual([r.records[0].rateScale, r.records[0].pitchScale], [1, 1]);
});

test('R02 settings: the mood influence is saved as 0–100 %, default 50 %', () => {
  assert.equal(DEFAULT_SETTINGS.voice.moodInfluence, 50);
  const legacy = structuredClone(DEFAULT_SETTINGS) as typeof DEFAULT_SETTINGS;
  delete (legacy.voice as { moodInfluence?: number }).moodInfluence;
  assert.equal(validateSettings(legacy).voice.moodInfluence, 50, 'older settings get the default');
  assert.equal(validateSettings({ ...legacy, voice: { ...legacy.voice, moodInfluence: 0 } }).voice.moodInfluence, 0);
  assert.equal(validateSettings({ ...legacy, voice: { ...legacy.voice, moodInfluence: 180 } }).voice.moodInfluence, 100);
  assert.equal(validateSettings({ ...legacy, voice: { ...legacy.voice, moodInfluence: 'loud' } }).voice.moodInfluence, 50);
});
