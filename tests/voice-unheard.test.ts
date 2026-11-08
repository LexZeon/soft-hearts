import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaInput } from '../src/ui/MediaInput';
import { VoiceChatHost } from '../electron/voice-chat-host';
import { VoiceRoute } from '../electron/asr/voice-route';
import { encodeWav } from '../src/ui/MediaInput';
import { VOICE_INPUT_FAILURES } from '../shared/speech-failure';
import { NOTICE_ACTIONS, voiceFailureAction } from '../src/notice-policy';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { VoiceConversationEvent } from '../shared/voice-conversation';
import type { JournalInput } from '../shared/journal';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const room = (rms: number, length = 4096) => new Float32Array(length).fill(rms);

async function withMedia(run: (value: { media: MediaInput; signals: string[]; submitted: number[]; statuses: string[]; unheard: string[]; errors: string[] }) => Promise<void>) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const signals: string[] = [], submitted: number[] = [], statuses: string[] = [], unheard: string[] = [], errors: string[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { desktop: {
    openVoiceCapture: async () => ({ captureSessionId: 'capture', epoch: 'epoch' }),
    signalVoiceCapture: async (_id: string, signal: string) => { signals.push(signal); return true; },
    submitVoicePcm: async (value: { captureSeq: number }) => { submitted.push(value.captureSeq); return { state: 'queued', groupId: 'g', segmentId: 's', captureSeq: value.captureSeq }; },
  } } });
  const media = new MediaInput({ windowKind: 'controls', onTranscript() {}, onError: message => errors.push(message),
    onVoiceStatus: text => statuses.push(text), onUnheard: failure => unheard.push(failure) });
  try {
    await media.applyRuntime({ voiceInput: true, voiceOwner: 'controls', screenSharing: false, cameraSharing: false, cameraOwner: null });
    media.microphoneReady(true);
    await run({ media, signals, submitted, statuses, unheard, errors });
  } finally {
    media.dispose();
    if (saved) Object.defineProperty(globalThis, 'window', saved); else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('a quiet voice on a quiet laptop microphone is sent to recognition (it was silently never sent)', async () => {
  await withMedia(async ({ media, submitted, errors }) => {
    for (let index = 0; index < 60; index++) media.pushVoicePcm(room(0.0008), 16000); // about 15 s of room, the gate learns it
    for (let index = 0; index < 5; index++) media.pushVoicePcm(room(0.006), 16000); // about 1.3 s of speech at -44 dBFS
    for (let index = 0; index < 4; index++) media.pushVoicePcm(room(0.0008), 16000);
    await tick(); await tick();
    assert.deepEqual(submitted, [1]);
    assert.deepEqual(errors, []);
  });
});

test('a microphone that only delivers silence says so once, to her windows and to the host', async () => {
  await withMedia(async ({ media, signals, unheard, statuses }) => {
    for (let index = 0; index < 60; index++) media.pushVoicePcm(room(0), 16000); // about 15 s
    await tick();
    assert.deepEqual(unheard, ['no-sound']);
    assert.equal(signals.filter(signal => signal === 'no-sound').length, 1);
    media.pushVoicePcm(room(0), 16000);
    assert.ok(/听不到|没有声音|麦克风/.test(statuses.at(-1) ?? ''), `status: ${statuses.at(-1)}`);
  });
});

test('a working microphone in a quiet room does not trigger the silence notice', async () => {
  await withMedia(async ({ media, unheard }) => {
    for (let index = 0; index < 120; index++) media.pushVoicePcm(room(0.0012), 16000);
    assert.deepEqual(unheard, []);
  });
});

test('when the host heard speech but got no words, the status line says so and keeps saying it for a moment', async () => {
  await withMedia(async ({ media, statuses, unheard }) => {
    media.noteUnheard('empty');
    assert.deepEqual(unheard, ['empty']);
    const said = statuses.at(-1) ?? '';
    assert.ok(/没听清|再说/.test(said), said);
    media.pushVoicePcm(room(0.0005), 16000);
    media.pushVoicePcm(room(0.0005), 16000);
    assert.equal(statuses.at(-1), said, 'the next quiet chunk does not wipe the sentence at once');
  });
});

test('the new categories have wording in her voice and are known to the notice policy', () => {
  for (const failure of ['no-sound', 'empty'] as const) {
    assert.ok((VOICE_INPUT_FAILURES as readonly string[]).includes(failure));
    assert.equal(voiceFailureAction(failure), `voice-${failure}`);
    assert.ok(NOTICE_ACTIONS[`voice-${failure}`].length > 10);
  }
});

const SETTINGS = DEFAULT_SETTINGS;
function hostWith(text: string, unheard: string[], events: VoiceConversationEvent[]) {
  return new VoiceChatHost({
    broadcast: event => { events.push(event); }, memoryChanged() {}, windowVisible: () => true,
    media: () => ({ voiceInput: true, voiceOwner: 'controls' }), turnOffVoiceInput() {},
    speechScope: () => 'scope', settings: () => SETTINGS, companion: () => ({ beginVoiceGroup: async () => assert.fail('no words, no group') }) as never,
    ambient: () => null, reserveChat: () => true, releaseChat() {}, userTurn() {}, activityChanged() {}, cancelProactive() {},
    claude: { stream: async () => assert.fail('no words, no request') } as never, languageProfile: () => null, chatDirectory: () => '.', tempDirectory: () => '.',
    transcribe: async () => text, stopReading() {}, prepareSpeech() {},
    unheard: failure => { unheard.push(failure); },
  });
}

test('recognition that returns nothing, or only punctuation, is reported and journaled instead of dropped', async () => {
  for (const text of ['', '   ', '。', '…？']) {
    const unheard: string[] = [], events: VoiceConversationEvent[] = [];
    const host = hostWith(text, unheard, events);
    const binding = host.open(5, 'controls');
    const receipt = host.pipeline.submit(5, { captureSessionId: binding.captureSessionId, captureSeq: 1, wav: encodeWav(room(0.1, 16000)) });
    assert.equal(receipt.state, 'queued');
    await tick(); await tick(); await tick();
    assert.deepEqual(unheard, ['empty'], JSON.stringify(text));
    assert.ok(events.some(event => event.type === 'unheard'), 'the owner window is told');
    assert.ok(!events.some(event => event.type === 'fault' || event.type === 'revoked'), 'voice input stays on');
  }
});

test('journal: the voice route writes the two categories as notes, not as a switch-off', () => {
  const lines: JournalInput[] = [];
  const route = new VoiceRoute({ config: () => ({ engine: 'local', language: 'zh', baseUrl: '', model: '' }) as never, local: () => null,
    compatible: async () => '', journal: input => { lines.push(input); }, characterId: () => 'c1' });
  route.heard('no-sound'); route.heard('empty');
  assert.deepEqual(lines.map(line => line.type === 'voice-input' ? [line.failure, line.stopped] : null), [['no-sound', false], ['empty', false]]);
});

test('she words each note in more than one way, never the same way twice in a row, and not again within 20 s', async () => {
  const { voiceUnheardLine } = await import('../src/notice-policy');
  const said: string[] = [];
  let now = 1_000_000;
  for (let round = 0; round < 6; round++) { const line = voiceUnheardLine('empty', now, () => 0); assert.ok(line); said.push(line!); now += 25_000; }
  assert.ok(new Set(said).size >= 2);
  said.forEach((line, index) => { if (index) assert.notEqual(line, said[index - 1]); });
  assert.equal(voiceUnheardLine('empty', now - 24_000, () => 0.9), null, 'the same note within 20 s is not said again');
  assert.ok(voiceUnheardLine('no-sound', now - 24_000, () => 0.9), 'a different note still is');
});
