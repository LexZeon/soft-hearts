// I-158: a turn whose words came from speech recognition (voice input and calls) gets one private line saying
// so, in her language; the user's own words in the chat and the archive are untouched; no Claude, no microphone, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { SPEECH_RECOGNITION_NOTE_EN, SPEECH_RECOGNITION_NOTE_ZH, speechRecognitionNote } from '../shared/voice/speech-recognition-note';
import { VOICE_CALL_SPOKEN_STYLE } from '../shared/voice/voice-call';
import { CompanionService } from '../electron/brain/companion';
import { VoiceChatHost } from '../electron/voice/voice-chat-host';
import { encodeWav } from '../src/senses/MediaInput';

const APPROVED_ZH = '（这条是用户说的话，经语音识别转成文字，可能有同音错字、断句不对或漏字。按最可能的意思理解，不要纠正，也不要提"识别错了"；实在听不懂，就像打电话时那样自然地问一句。）';

async function voiceHost(options: { language?: 'zh-CN' | 'en'; withNote?: boolean; call?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'i158-note-'));
  const service = new CompanionService(directory, () => {});
  await service.load();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider.kind = 'claude'; settings.provider.model = 'haiku';
  await service.context('fixture-character', settings.provider, '公开原创角色');
  const media = { voiceInput: true, voiceOwner: 'controls' as const };
  const personas: string[] = [], shown: string[] = [], asr: string[] = [];
  const pending = new Set<string>();
  const host = new VoiceChatHost({
    broadcast: event => { if ('text' in event && typeof event.text === 'string') shown.push(event.text); },
    memoryChanged() {}, windowVisible: () => true, media: () => media, turnOffVoiceInput() {}, speechScope: () => 'scope', settings: () => settings,
    companion: () => ({ beginVoiceGroup: (...args: Parameters<CompanionService['beginVoiceGroup']>) => service.beginVoiceGroup(...args) }),
    ambient: () => null, reserveChat: id => { if (pending.size) return false; pending.add(id); return true; }, releaseChat: id => { pending.delete(id); },
    userTurn() {}, activityChanged() {}, cancelProactive() {},
    claude: { stream: async (task, _signal, emit) => { personas.push(task.session!.persona); emit('delta', '嗯嗯。'); return { superseded: false, output: '嗯嗯。' }; } },
    languageProfile: () => null, chatDirectory: () => directory, tempDirectory: () => directory,
    transcribe: async () => asr.shift() ?? '', stopReading() {}, prepareSpeech() {},
    ...(options.call ? { callStyle: () => VOICE_CALL_SPOKEN_STYLE } : {}),
    ...(options.withNote === false ? {} : { speechNote: () => speechRecognitionNote(options.language) }),
  });
  const binding = host.open(77, 'controls');
  let seq = 0;
  const say = async (text: string) => {
    asr.push(text);
    host.pipeline.submit(77, { captureSessionId: binding.captureSessionId, captureSeq: ++seq, wav: encodeWav(new Float32Array(4096).fill(0.1)) });
    host.pipeline.finishSpeaking(77, binding.captureSessionId);
    const before = personas.length;
    for (let i = 0; i < 400 && personas.length === before; i++) await new Promise(resolve => setTimeout(resolve, 5));
    for (let i = 0; i < 400 && pending.size; i++) await new Promise(resolve => setTimeout(resolve, 5));
    await host.drain();
  };
  const archive = async () => { await service.flush(); let all = ''; for (const name of await readdir(directory, { recursive: true })) { try { all += await readFile(path.join(directory, name), 'utf8'); } catch { /* a folder */ } } return all; };
  const dispose = async () => { host.dispose(); await host.drain(); await service.flush(); await rm(directory, { recursive: true, force: true }); };
  return { personas, shown, say, archive, dispose };
}

test('the Chinese line is the sentence the user approved, one line, nothing of the user\'s words', () => {
  assert.equal(SPEECH_RECOGNITION_NOTE_ZH, '\n' + APPROVED_ZH);
  assert.equal(speechRecognitionNote('zh-CN'), SPEECH_RECOGNITION_NOTE_ZH);
  assert.equal(speechRecognitionNote(undefined), SPEECH_RECOGNITION_NOTE_ZH);
  assert.equal(speechRecognitionNote('en'), SPEECH_RECOGNITION_NOTE_EN);
  assert.match(SPEECH_RECOGNITION_NOTE_EN, /speech recognition/);
  assert.match(SPEECH_RECOGNITION_NOTE_EN, /homophone mistakes, wrong breaks or missing words/);
  assert.match(SPEECH_RECOGNITION_NOTE_EN, /do not correct it or mention recognition errors/);
  assert.match(SPEECH_RECOGNITION_NOTE_EN, /phone call/);
  assert.ok(!/[一-鿿]/.test(SPEECH_RECOGNITION_NOTE_EN), 'the English card is not given Chinese');
});

test('a voice-input turn carries the line; the chat and the archive keep only what the user said', async () => {
  const h = await voiceHost();
  try {
    await h.say('今天天汽真好');
    assert.ok(h.personas[0].includes(APPROVED_ZH));
    assert.ok(!h.shown.some(text => text.includes('语音识别')), 'never shown in the chat');
    const kept = await h.archive();
    assert.ok(kept.includes('今天天汽真好'), 'the user\'s words are kept');
    assert.ok(!kept.includes('语音识别转成文字'), 'the line is not written to the saved chat');
    await h.say('再说一句');
    assert.equal(h.personas[1].split('语音识别转成文字').length - 1, 1, 'one line per request, not piled up');
  } finally { await h.dispose(); }
});

test('a call turn carries the line together with the call\'s spoken-style line', async () => {
  const h = await voiceHost({ call: true });
  try {
    await h.say('你在干嘛呢');
    assert.ok(h.personas[0].includes(APPROVED_ZH));
    assert.ok(h.personas[0].includes(VOICE_CALL_SPOKEN_STYLE));
  } finally { await h.dispose(); }
});

test('an English card gets the English line and no Chinese one', async () => {
  const h = await voiceHost({ language: 'en' });
  try {
    await h.say('how is the weather');
    assert.ok(h.personas[0].includes(SPEECH_RECOGNITION_NOTE_EN));
    assert.ok(!h.personas[0].includes('语音识别转成文字'));
  } finally { await h.dispose(); }
});

test('a host without the line (or one that fails) adds nothing and the reply still goes out', async () => {
  const h = await voiceHost({ withNote: false });
  try { await h.say('你好'); assert.ok(!h.personas[0].includes('语音识别转成文字')); assert.equal(h.personas.length, 1); } finally { await h.dispose(); }
});
