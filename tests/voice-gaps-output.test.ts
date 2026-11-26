// 2026-11-24 有一句话没读出来 (docs/claude/2026-11-24-voice-gaps.md), item 2 in the companion window: every reading the window cancels writes a closed
// cause on its record, whichever of the stop paths cancelled it; a path that gave none says "unlogged" instead of leaving the field out.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { DEFAULT_TTS_CONFIG, type TtsConfig } from '../shared/voice/tts';
import { READING_CANCEL_BYS, validateSpeechDiagnosticRecord, type SpeechDiagnosticRecord } from '../shared/voice';
import { StreamingVoicePlayer } from '../src/voice/EmotionalVoice';
import { VoiceOutput, type VoiceOutputEvent } from '../src/voice/VoiceOutput';
import { SharedAudioOutput } from '../src/voice/audio-output';
import { flush, world } from './helpers/r02-audio-world';

const voice = { ...DEFAULT_SETTINGS.voice, enabled: true };

function cloud(t: TestContext) {
  const w = world(t, {});
  const records: SpeechDiagnosticRecord[] = [];
  let listener: ((event: VoiceOutputEvent) => void) | null = null;
  const config: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'x', apiKey: 'k' };
  const audio = new SharedAudioOutput({ createContext: w.createContext, now: w.now, timers: w.timers });
  let ids = 0;
  const output = new VoiceOutput({
    getTtsConfig: () => config, getVoiceConfig: () => voice,
    api: { async synthesizeSpeech() {}, async cancelSpeech() {}, async releaseSpeech() {}, onSpeechEvent(cb) { listener = cb; return () => { listener = null; }; },
      async recordSpeechDiagnostic(record) { records.push(record); } },
    onSpeaking: () => {}, onError: () => {}, onState: () => {}, createId: () => `id-${++ids}`, audio, now: w.now,
    createPlayer: callbacks => new StreamingVoicePlayer({ ...callbacks, now: w.now, timers: w.timers }),
  });
  t.after(() => { output.dispose(); audio.dispose(); });
  void listener;
  return { w, output, records };
}
async function cancelled(t: TestContext, how: (h: ReturnType<typeof cloud>) => void | Promise<void>): Promise<SpeechDiagnosticRecord> {
  const h = cloud(t);
  const spoken = h.output.speak('你好。', voice, { replyId: 'r' }).catch(() => {});
  await flush(); await h.w.advance(100);
  await how(h);
  await flush(); await spoken;
  const record = h.records.find(r => r.outcome === 'cancelled');
  assert.ok(record, 'a cancelled record was written');
  assert.deepEqual(validateSpeechDiagnosticRecord(JSON.parse(JSON.stringify(record))), record, 'the host accepts it unchanged');
  return record!;
}

test('a stop that gives a cause writes it; one noted by the facade beforehand writes it; one with none says "unlogged"', async t => {
  assert.equal((await cancelled(t, h => h.output.stop('hidden'))).cancelBy, 'hidden');
  assert.equal((await cancelled(t, h => { h.output.noteStop('voice-input'); h.output.stop(); })).cancelBy, 'voice-input');
  assert.equal((await cancelled(t, h => h.output.stop())).cancelBy, 'unlogged', 'never an absent field');
});

test('a new reading that replaces a playing one cancels it as "superseded"; dispose cancels as "window"', async t => {
  const replaced = await cancelled(t, h => { void h.output.speak('第二句。', voice, { replyId: 'r2' }).catch(() => {}); });
  assert.equal(replaced.cancelBy, 'superseded');
  const gone = await cancelled(t, h => h.output.dispose());
  assert.equal(gone.cancelBy, 'window');
});

test('every closed cause is accepted by the host\'s check and a stop with a noted cause forgets it afterwards', async t => {
  assert.ok(READING_CANCEL_BYS.length >= 12);
  const h = cloud(t);
  h.output.noteStop('stop'); h.output.noteStop(null);
  const spoken = h.output.speak('你好。', voice, { replyId: 'r' }).catch(() => {});
  await flush(); await h.w.advance(100); h.output.stop(); await flush(); await spoken;
  assert.equal(h.records.find(r => r.outcome === 'cancelled')?.cancelBy, 'unlogged', 'a noted cause that was withdrawn is not used');
});
