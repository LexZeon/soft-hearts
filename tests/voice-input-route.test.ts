// A + B: 识别方式 and its migration, the voice switch refused
// with a reason when the local recognizer is missing, recognition failures by category with one journal line, and
// fixed lines in her words for both windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSettings, validateVoiceInput, voiceInputEngine } from '../electron/validation';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { MediaRuntime } from '../electron/runtime';
import { VoiceRoute, engineOf, voiceFailureOf } from '../electron/asr/voice-route';
import { LocalAsrError } from '../electron/asr/host';
import { AsrError, transcribeWav } from '../electron/asr';
import { voiceFaultEvent } from '../electron/voice-chat-host';
import { NOTICE_ACTIONS, voiceFailureAction, voiceRefusalAction } from '../src/notice-policy';
import { buildJournalEntry, type JournalInput } from '../shared/journal';
import { VOICE_INPUT_FAILURES } from '../shared/speech-failure';
import { encodeWav } from '../src/ui/MediaInput';
import type { VoiceInputConfig } from '../shared/contracts';
import { localAsrDetailsText, localAsrPromptText, localAsrStatusText } from '../src/ui/LocalAsrPanel';

test('识别方式 migration: the untouched default address moves to the local recognizer, a changed address stays compatible', () => {
  assert.equal(DEFAULT_SETTINGS.voiceInput!.engine, 'local');
  const old = { baseUrl: 'http://127.0.0.1:8000/v1', model: 'whisper-1', language: 'zh', apiKey: '' };
  assert.deepEqual(validateVoiceInput(old), { ...old, engine: 'local' }, 'nothing else changes');
  assert.equal(validateVoiceInput({ ...old, baseUrl: 'http://127.0.0.1:8000/v1/' }).engine, 'local');
  const custom = { baseUrl: 'http://192.168.1.20:9000/v1', model: 'sensevoice', language: 'zh', apiKey: 'k' };
  assert.deepEqual(validateVoiceInput(custom), { ...custom, engine: 'compatible' });
  assert.equal(validateVoiceInput({ ...custom, engine: 'local' }).engine, 'local', 'a choice the user made is kept');
  assert.equal(validateVoiceInput({ ...old, engine: 'compatible' }).engine, 'compatible');
  assert.equal(voiceInputEngine('cloud', old.baseUrl), 'local');
  // A whole stored settings file from before: only voiceInput.engine appears.
  const { engine: _engine, ...legacyVoice } = DEFAULT_SETTINGS.voiceInput!;
  const stored = { ...structuredClone(DEFAULT_SETTINGS), voiceInput: legacyVoice, voice: { ...DEFAULT_SETTINGS.voice, rate: 1.3 } };
  const loaded = validateSettings(stored);
  assert.equal(loaded.voiceInput!.engine, 'local');
  assert.equal(loaded.voice.rate, 1.3);
});

test('the voice switch: refused with a reason (only to the window that asked, nothing broadcast); allowed when ready', () => {
  let refusal: 'needs-component' | 'preparing' | 'unavailable' | null = 'needs-component';
  const changes: unknown[] = [];
  const media = new MediaRuntime(state => changes.push(state), undefined, { blocked: () => refusal });
  const reply = media.update({ voiceInput: true }, 'pet');
  assert.equal(reply.voiceRefused, 'needs-component');
  assert.equal(reply.voiceInput, false);
  assert.equal(media.state.voiceInput, false);
  assert.equal('voiceRefused' in media.state, false);
  assert.deepEqual(changes, []);
  refusal = null;
  const on = media.update({ voiceInput: true }, 'pet');
  assert.equal(on.voiceInput, true); assert.equal(on.voiceOwner, 'pet'); assert.equal(on.voiceRefused, undefined);
  refusal = 'preparing';
  assert.equal(media.update({ voiceInput: false }, 'pet').voiceInput, false, 'turning off is never refused');
  // Several switches at once: the others still apply.
  const mixed = media.update({ voiceInput: true, screenSharing: true }, 'controls');
  assert.equal(mixed.voiceRefused, 'preparing'); assert.equal(mixed.voiceInput, false); assert.equal(mixed.screenSharing, true);
});

function route(engine: VoiceInputConfig['engine'], local: { blocked?: ReturnType<VoiceRoute['policy']['blocked']>; text?: string; error?: unknown } = {}) {
  const journal: JournalInput[] = [], calls: string[] = [];
  const config: VoiceInputConfig = { ...DEFAULT_SETTINGS.voiceInput!, engine };
  const value = new VoiceRoute({
    config: () => config,
    local: () => ({ voiceBlocked: () => local.blocked ?? null,
      transcribe: async (_wav, language) => { calls.push(`local ${language}`); if (local.error) throw local.error; return local.text ?? ''; } }),
    compatible: async () => { calls.push('compatible'); return 'compatible text'; },
    journal: input => journal.push(input), characterId: () => 'gene',
  });
  return { value, journal, calls };
}

test('routing: the local recognizer or the compatible address; only the local one can refuse the switch', async () => {
  const local = route('local', { text: '你好' });
  assert.equal(await local.value.transcribe(new ArrayBuffer(8), new AbortController().signal), '你好');
  assert.deepEqual(local.calls, ['local zh']);
  const compatible = route('compatible', { blocked: 'needs-component' });
  assert.equal(compatible.value.policy.blocked('pet'), null);
  assert.equal(await compatible.value.transcribe(new ArrayBuffer(8), new AbortController().signal), 'compatible text');
  const refused = route('local', { blocked: 'needs-component' });
  assert.equal(refused.value.policy.blocked('pet'), 'needs-component');
  assert.deepEqual(refused.journal, [{ type: 'voice-input', characterId: 'gene', engine: 'local', failure: 'needs-component', stopped: false }]);
  assert.equal(engineOf(undefined), 'local');
});

test('a failure keeps its category on the capture and writes one journal line with no words; local messages stay in the host', () => {
  const r = route('local');
  type Capture = { asrFailure?: string; asrCategory?: (typeof VOICE_INPUT_FAILURES)[number] };
  const capture: Capture = {};
  r.value.failed(capture, new LocalAsrError('local-failed', 'recognizer model failed'));
  assert.deepEqual(capture, { asrCategory: 'local-failed' });
  const line = JSON.stringify(buildJournalEntry(r.journal[0], 1));
  assert.ok(line.includes('"failure":"local-failed"') && line.includes('"stopped":true'));
  const compatible = route('compatible'), other: Capture = {};
  compatible.value.failed(other, new AsrError('无法连接语音识别服务（http://127.0.0.1:8000, ECONNREFUSED）。', 'unreachable'));
  assert.equal(other.asrCategory, 'unreachable');
  assert.match(other.asrFailure!, /ECONNREFUSED/);
  assert.equal(voiceFailureOf(new Error('x')), 'other');
  // The fault event carries the category to every window.
  assert.deepEqual(voiceFaultEvent(other, 'asr-failed'), { type: 'fault', message: other.asrFailure, failure: 'unreachable' });
  assert.deepEqual(voiceFaultEvent(other, 'delivery-failed'), { type: 'fault' });
});

test('the compatible address: nothing listening is "unreachable", a server error is "service"', async () => {
  const config = { ...DEFAULT_SETTINGS.voiceInput!, engine: 'compatible' as const };
  const wav = encodeWav(new Float32Array(8000).fill(0.1));
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }) as typeof fetch;
    await assert.rejects(transcribeWav(config, wav, new AbortController().signal), (error: unknown) => error instanceof AsrError && error.failure === 'unreachable');
    globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof fetch;
    await assert.rejects(transcribeWav(config, wav, new AbortController().signal), (error: unknown) => error instanceof AsrError && error.failure === 'service');
  } finally { globalThis.fetch = realFetch; }
});

test('the control window question says the size, that it runs only here, and what each phase means', () => {
  const view = { phase: 'not-installed' as const, prompt: true, downloadBytes: 270_161_561, installedBytes: 0, progress: null, componentVersion: 1, notice: '' as const };
  assert.match(localAsrPromptText(view), /约 270 MB/);
  assert.match(localAsrPromptText(view), /声音不会离开这台电脑/);
  assert.match(localAsrStatusText({ ...view, phase: 'downloading', progress: 0.42 }), /42%/);
  assert.match(localAsrStatusText({ ...view, phase: 'downloading', progress: 0.1, fallback: true, downloadBytes: 355_013_368 }), /355 MB/);
  assert.match(localAsrStatusText({ ...view, phase: 'ready' }), /不保存、不上传/);
  assert.match(localAsrDetailsText({ ...view, phase: 'idle', installedBytes: 313_698_939 }), /SenseVoiceSmall.*FunASR/);
});

test('her lines: every refusal and every failure category has one, in both windows', () => {
  for (const reason of ['needs-component', 'preparing', 'unavailable'] as const) {
    const action = voiceRefusalAction({ voiceRefused: reason });
    assert.ok(action && NOTICE_ACTIONS[action], reason);
  }
  for (const failure of VOICE_INPUT_FAILURES) {
    const action = voiceFailureAction(failure);
    assert.ok(action && NOTICE_ACTIONS[action], failure);
  }
  assert.equal(voiceRefusalAction({ voiceInput: true }), null);
  assert.equal(voiceFailureAction('something else'), null);
  assert.match(NOTICE_ACTIONS['voice-needs-component'], /下载/);
  assert.match(NOTICE_ACTIONS['voice-unreachable'], /连不上/);
  assert.match(NOTICE_ACTIONS['voice-unreachable'], /本机自带识别/);
});
