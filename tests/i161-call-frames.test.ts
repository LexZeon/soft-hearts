// I-161 (chose "A 像视频通话"): voice input and call segments carry frames by the typed chat's
// own rules. Before, every segment went out with `imageDataUrls: []` (with the screen and the camera on she said her side was dark).
// Real pieces: the voice host (electron/voice/voice-chat-host.ts), her companion service, the media switches (MediaRuntime), the look
// decision and the frame tickets (LookTurns, LookAttachments), the small-frame keeper (CameraGlance), the segment look
// (electron/senses/voice-look.ts) and its line (shared/brain/call-frame-note.ts), wired as electron/wiring/senses-voice-input-wiring.ts
// wires them. Fake: the recognizer (it returns the words given), the screen and camera captures, and Claude (it reads the task's
// persona and frames where the real session writes the message). No window, no screen, no camera, no microphone, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CALL_LOOK } from '../shared/senses/call-look';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { VOICE_CALL_SPOKEN_STYLE } from '../shared/voice/voice-call';
import { CALL_NO_FRAME_NOTE_EN, CALL_NO_FRAME_NOTE_ZH, callFrameNote } from '../shared/brain/call-frame-note';
import { CURIOUS_SCREEN_LINE, GLANCE_LINE, SCREEN_LOOK_LINE } from '../shared/brain/perception-rule';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { CompanionService } from '../electron/brain/companion';
import { VoiceChatHost } from '../electron/voice/voice-chat-host';
import { LookTurns } from '../electron/senses/look-turns';
import { LookAttachments } from '../electron/senses/look-attachments';
import { CameraGlance } from '../electron/senses/camera-glance';
import { MediaRuntime, type CameraPolicy } from '../electron/senses/media-runtime';
import { voiceLegLook } from '../electron/senses/voice-look';
import { CallLookTime, JournalExtras } from '../electron/memory/journal/extras';
import { encodeWav } from '../src/senses/MediaInput';

const SCREEN = (n: number) => `data:image/jpeg;base64,/9j/screen${n}AA==`;
const CLEAR = (n: number) => `data:image/jpeg;base64,/9j/clear${n}AA==`;
const SMALL = (n: number) => `data:image/jpeg;base64,/9j/small${n}AA==`;
const tr = (text: string, ...args: unknown[]) => args.reduce<string>((out, arg, i) => out.replace(`{${i}}`, String(arg)), text);
const wait = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

interface Sent { text: string; images: string[]; persona: string }

async function harness(options: { language?: 'zh-CN' | 'en'; screenFails?: boolean; glanceEveryTurn?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'i161-frames-'));
  const service = new CompanionService(directory, () => {});
  await service.load();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider.kind = 'claude'; settings.provider.model = 'haiku';
  await service.context('fixture-character', settings.provider, '公开原创角色');
  // The switches: voice input on in the control window; screen sharing and 「发图片」 are turned on per test.
  const policy: CameraPolicy = { mode: () => 'share', blocked: () => 'needs-component' };
  const media = new MediaRuntime(undefined, policy);
  media.update({ voiceInput: true }, 'controls');
  let generation = 0, screenShots = 0, cameraShots = 0, screenGate: Promise<void> | null = null;
  const glanceKeeper = new CameraGlance({ frame: () => media.cameraAttachment(), poseOn: () => false, signal: () => null, opening: () => media.openings.camera });
  const look = new LookAttachments(new LookTurns(() => 0), {
    noteActivity: () => { generation++; },
    state: () => ({ screen: media.state.screenSharing, camera: media.sharesCameraFrames() && !!media.state.cameraOwner, scope: `c|${media.revision}`,
      screenOpening: media.openings.screen, cameraHeld: media.state.cameraHeld === true }),
    sharesCameraFrames: () => media.sharesCameraFrames(),
    revision: () => media.revision, generation: () => generation, opening: source => media.openings[source],
    captureScreen: async () => { screenShots++; if (screenGate) await screenGate; return options.screenFails ? null : { source: 'screen', dataUrl: SCREEN(screenShots) }; },
    captureCamera: async () => { cameraShots++; return media.sharesCameraFrames() && !media.state.cameraHeld ? { source: 'camera', dataUrl: CLEAR(cameraShots) } : null; },
    glance: () => glanceKeeper.take(), seenCamera: () => glanceKeeper.seen(),
    holdCamera: held => { media.holdCamera(held); },
    textFirst: () => true, // the shipped default (shared/behaviors/text-first/knobs.ts)
  });
  const looked: (number | null)[] = [];
  const sent: Sent[] = [], tasks: { imageDataUrls?: string[] }[] = [];
  let beforeWrite: (() => void | Promise<void>) | null = null;
  const pending = new Set<string>(), asr: string[] = [];
  const host = new VoiceChatHost({
    broadcast() {}, memoryChanged() {}, windowVisible: () => true, media: () => media.state, turnOffVoiceInput() {},
    speechScope: () => 'scope', settings: () => settings,
    companion: () => ({ beginVoiceGroup: (...args: Parameters<CompanionService['beginVoiceGroup']>) => service.beginVoiceGroup(...args) }),
    ambient: () => null, reserveChat: id => { if (pending.size) return false; pending.add(id); return true; }, releaseChat: id => { pending.delete(id); },
    userTurn() {}, activityChanged() {}, cancelProactive() {}, callStyle: () => VOICE_CALL_SPOKEN_STYLE,
    // As claude-session.ts does: the persona and the frames are read where the message is written (after a process start or a drain).
    claude: { stream: async (task, _signal, emit) => {
      tasks.push(task);
      if (beforeWrite) { const run = beforeWrite; beforeWrite = null; await run(); }
      sent.push({ text: task.session!.messages.at(-1)!.content, images: [...(task.imageDataUrls ?? [])], persona: task.session!.persona });
      emit('delta', '嗯嗯。'); return { superseded: false, output: '嗯嗯。' };
    } },
    languageProfile: () => null, chatDirectory: () => directory, tempDirectory: () => directory,
    transcribe: async () => asr.shift() ?? '', stopReading() {}, prepareSpeech() {},
    // electron/wiring/senses-voice-input-wiring.ts `look`
    look: text => voiceLegLook({ request: (hint, opts) => look.request(hint, opts), admit: frames => look.admit(frames),
      note: frames => callFrameNote(frames, options.language), looked: ms => { looked.push(ms); },
      ...(options.glanceEveryTurn !== undefined ? { glanceEveryTurn: options.glanceEveryTurn } : {}) }, text),
  });
  let binding = host.open(77, 'controls'), seq = 0;
  /** One spoken utterance: the recognizer returns `text`, the user stops; waits until it settled. */
  const say = async (text: string) => {
    asr.push(text);
    host.pipeline.submit(77, { captureSessionId: binding.captureSessionId, captureSeq: ++seq, wav: encodeWav(new Float32Array(4096).fill(0.1)) });
    host.pipeline.finishSpeaking(77, binding.captureSessionId);
    const before = sent.length;
    for (let i = 0; i < 400 && sent.length === before; i++) await wait();
    for (let i = 0; i < 400 && pending.size; i++) await wait();
    await host.drain();
  };
  const reopen = () => { binding = host.open(77, 'controls'); seq = 0; };
  const dispose = async () => { host.dispose(); await host.drain(); await service.flush(); await rm(directory, { recursive: true, force: true }); };
  return { host, media, look, sent, tasks, looked, say, reopen, dispose, pending, asr,
    shots: () => ({ screen: screenShots, camera: cameraShots }),
    gateScreen: (gate: Promise<void> | null) => { screenGate = gate; },
    beforeWrite: (run: () => void | Promise<void>) => { beforeWrite = run; },
    keepSmall: (n: number) => media.publishCamera('controls', SMALL(n)),
    submit: (text: string) => { asr.push(text); host.pipeline.submit(77, { captureSessionId: binding.captureSessionId, captureSeq: ++seq, wav: encodeWav(new Float32Array(4096).fill(0.1)) }); host.pipeline.finishSpeaking(77, binding.captureSessionId); } };
}

test('screen sharing on: a segment that asks her to look (unpunctuated) carries one fresh screen frame and the typed turn\'s words for it', async () => {
  const h = await harness();
  try {
    h.media.update({ screenSharing: true }, 'controls');
    await h.say('你看看我屏幕上这个报错是什么意思');
    assert.deepEqual(h.shots(), { screen: 1, camera: 0 });
    assert.deepEqual(h.sent[0].images, [SCREEN(1)]);
    assert.ok(h.sent[0].persona.includes('【此刻的感知】' + SCREEN_LOOK_LINE), 'the same words a typed turn gets for a screen frame');
    assert.ok(h.sent[0].persona.includes(VOICE_CALL_SPOKEN_STYLE));
    assert.equal(typeof h.looked[0], 'number', 'the look time is measured for a segment that asked');
  } finally { await h.dispose(); }
});

test('decided "no": an ordinary segment takes no frame, carries none, and gets no extra line (screen on, nothing asked)', async () => {
  const h = await harness();
  try {
    h.media.update({ screenSharing: true }, 'controls');
    for (const text of ['今天好累啊', '我看看这个怎么弄', '他说你看看这个']) await h.say(text);
    assert.deepEqual(h.shots(), { screen: 0, camera: 0 });
    assert.deepEqual(h.sent.map(turn => turn.images), [[], [], []]);
    assert.ok(h.sent.every(turn => !turn.persona.includes('【此刻的感知】') && !turn.persona.includes('没有画面')));
    assert.deepEqual(h.looked, [null, null, null]);
  } finally { await h.dispose(); }
});

test('a source the user has not turned on is never taken: screen off and 「发图片」 off, "看我屏幕" and "你看看我" take nothing', async () => {
  const h = await harness();
  try {
    await h.say('看我屏幕');
    await h.say('你看看我');
    h.media.update({ cameraImages: true }, 'controls'); // the camera on, the screen still off
    await h.say('你看一眼电脑');
    assert.equal(h.shots().screen, 0);
    assert.equal(h.shots().camera, 0);
    assert.ok(h.sent.every(turn => !turn.images.some(image => image.includes('screen'))));
    assert.deepEqual(h.sent.slice(0, 2).map(turn => turn.images), [[], []]);
  } finally { await h.dispose(); }
});

// 2026-11-19: first "先只在请她看时" (glanceEveryTurn false); after I-161 A (the warm process keeps small frames) the user saw the numbers and
// said "打开": the shipped value is true (pinned below). The only-when-asked path stays tested with the knob off.
test('the shipped knob: a small frame every call segment (after I-161 A)', () => {
  assert.equal(CALL_LOOK.glanceEveryTurn, true);
  assert.equal(CALL_LOOK.glanceStaysInCall, true);
});

test('「发图片」 on with the knob off (only when asked): an ordinary segment carries no frame and no line; "你看看我" takes a clear one; "别看" holds it', async () => {
  const h = await harness({ glanceEveryTurn: false });
  try {
    h.media.update({ cameraImages: true }, 'controls');
    h.keepSmall(1);
    await h.say('你好呀');
    assert.deepEqual(h.sent[0].images, [], 'no small frame on an ordinary segment');
    assert.ok(!h.sent[0].persona.includes(GLANCE_LINE));
    assert.equal(h.shots().camera, 0);
    await h.say('你看看我');
    assert.equal(h.shots().camera, 1);
    assert.deepEqual(h.sent[1].images, [CLEAR(1)]);
    await h.say('别看我');
    await h.say('你看看我');
    assert.deepEqual(h.sent[3].images, [CLEAR(2)], 'asked again after a no: a clear one again');
  } finally { await h.dispose(); }
});

test('「发图片」 on with a frame every segment (the switch for later): every segment carries the small kept frame (no capture), "别看" holds it for the segments after, "你看看我" takes a clear one', async () => {
  const h = await harness({ glanceEveryTurn: true });
  try {
    h.media.update({ cameraImages: true }, 'controls');
    h.keepSmall(1);
    await h.say('你好呀');
    assert.deepEqual(h.sent[0].images, [SMALL(1)]);
    assert.ok(h.sent[0].persona.includes('【此刻的感知】' + GLANCE_LINE), 'not a request to look, in the typed turn\'s words');
    assert.equal(h.shots().camera, 0, 'nothing is captured for the small frame');
    h.keepSmall(2);
    await h.say('别看我');
    await h.say('今天天气怎么样');
    assert.deepEqual(h.sent[1].images, []); assert.deepEqual(h.sent[2].images, []);
    assert.equal(h.media.state.cameraHeld, true);
    await h.say('你看看我');
    assert.equal(h.shots().camera, 1);
    assert.deepEqual(h.sent[3].images, [CLEAR(1)]);
    h.keepSmall(3);
    await h.say('嗯嗯');
    assert.deepEqual(h.sent[4].images, [SMALL(3)], 'asked to look again: the small frames come back');
  } finally { await h.dispose(); }
});

test('asked again before Claude gets it: sharing turned off after the capture drops the frame, and she is told there is no picture', async () => {
  const h = await harness();
  try {
    h.media.update({ screenSharing: true }, 'controls');
    h.beforeWrite(() => { h.media.update({ screenSharing: false }, 'controls'); });
    await h.say('你看看我屏幕');
    assert.equal(h.shots().screen, 1, 'the frame was taken');
    assert.deepEqual(h.sent[0].images, [], 'and never left: admit asked again where the message is written');
    assert.ok(!h.sent[0].persona.includes(SCREEN_LOOK_LINE));
    assert.ok(h.sent[0].persona.includes(CALL_NO_FRAME_NOTE_ZH));
  } finally { await h.dispose(); }
});

test('a "别看" said after the small frame was taken holds it too', async () => {
  const h = await harness();
  try {
    h.media.update({ cameraImages: true }, 'controls');
    h.keepSmall(1);
    h.beforeWrite(() => { h.media.holdCamera(true); });
    await h.say('你好呀');
    assert.deepEqual(h.sent[0].images, []);
    assert.ok(!h.sent[0].persona.includes(GLANCE_LINE));
  } finally { await h.dispose(); }
});

test('a capture that fails: the segment goes as text and says "no picture this turn" (Chinese and English cards)', async () => {
  for (const language of ['zh-CN', 'en'] as const) {
    const h = await harness({ screenFails: true, language });
    try {
      h.media.update({ screenSharing: true }, 'controls');
      await h.say('你看看这个报错');
      assert.deepEqual(h.sent[0].images, []);
      assert.ok(h.sent[0].persona.includes(language === 'en' ? CALL_NO_FRAME_NOTE_EN : CALL_NO_FRAME_NOTE_ZH), language);
      assert.equal(h.sent.length, 1, 'the reply still goes out');
    } finally { await h.dispose(); }
  }
  assert.ok(!/[一-鿿]/.test(CALL_NO_FRAME_NOTE_EN), 'the English card is not given Chinese');
});

test('frames never cross segments: the next segment takes its own moment (or none), and an ended segment\'s frames are gone', async () => {
  const h = await harness();
  try {
    h.media.update({ screenSharing: true }, 'controls');
    await h.say('你看看我屏幕');
    await h.say('那这个怎么办');
    await h.say('你再看看这个报错');
    assert.deepEqual(h.sent.map(turn => turn.images), [[SCREEN(1)], [], [SCREEN(2)]]);
    assert.equal(h.shots().screen, 2);
    // A task the session still held (a retry reads its getters again) gets nothing once its segment ended.
    assert.deepEqual(h.tasks[0].imageDataUrls, []);
    assert.deepEqual(h.tasks[2].imageDataUrls, []);
  } finally { await h.dispose(); }
});

test('frames never cross calls: a call that ends before the message is written sends nothing; a capture still under way when it ends is dropped', async () => {
  const h = await harness();
  try {
    h.media.update({ screenSharing: true }, 'controls');
    h.beforeWrite(() => { h.host.revoke('stop-generation', true); });
    h.submit('你看看我屏幕');
    for (let i = 0; i < 400 && !h.sent.length; i++) await wait();
    await h.host.drain();
    assert.equal(h.shots().screen, 1);
    assert.deepEqual(h.sent[0].images, [], 'the call ended: the getter gives nothing');
    // A capture under way when the call ends: the segment is cancelled, the frame comes back later and goes nowhere.
    h.reopen();
    let release!: () => void;
    h.gateScreen(new Promise<void>(resolve => { release = resolve; }));
    h.submit('你看看这个报错');
    for (let i = 0; i < 400 && h.shots().screen < 2; i++) await wait();
    h.host.revoke('stop-generation', true);
    release(); h.gateScreen(null);
    await wait(30); await h.host.drain();
    assert.equal(h.sent.length, 1, 'the cancelled segment never reached Claude');
    h.reopen();
    await h.say('嗯嗯');
    assert.deepEqual(h.sent.at(-1)!.images, [], 'and its frame is not carried by the next call\'s segment');
  } finally { await h.dispose(); }
});

test('the look time goes with that call turn\'s line (numbers only), taken once', () => {
  const clock = { now: 1_000 };
  const time = new CallLookTime(() => clock.now);
  time.note(212.6); assert.equal(time.take(), 213); assert.equal(time.take(), null, 'once');
  time.note(50); clock.now += 121_000; assert.equal(time.take(), null, 'a stale number is not that turn\'s');
  const records: Record<string, unknown>[] = [];
  const extras = new JournalExtras({ sink: { record: (input: Record<string, unknown>) => { records.push(input); return true; } } as never, characterId: () => 'c',
    engine: () => 'local', uptimeMs: () => 0, blushStage() {}, callTurn: () => true });
  extras.callLook.note(340);
  assert.equal(extras.fact('voice-call-turn', { endpointMs: 700, handInMs: 760, textMs: 820, fillerMs: null, firstCharMs: 2000, firstSoundMs: 2600, bargeIn: false, lookMs: 99999 }, false), true);
  assert.equal(records[0].lookMs, 340, 'the host\'s own number, never the window\'s');
  const entry = buildJournalEntry(records[0] as never, 1)!;
  assert.equal((entry as { lookMs?: number }).lookMs, 340);
  assert.match(describeJournalEntry(entry, tr), /截图附图用了 0\.34 秒/);
  const plain = buildJournalEntry({ type: 'voice-call', characterId: 'c', event: 'turn', endpointMs: 1, handInMs: 1, textMs: 1, fillerMs: null, firstCharMs: null, firstSoundMs: null, bargeIn: false, lookMs: null } as never, 1)!;
  assert.equal('lookMs' in plain, false, 'a turn that did not ask to look has no look time');
  assert.doesNotMatch(describeJournalEntry(plain, tr), /截图附图/);
});

test('the call line describes frames with the very function a typed turn uses', () => {
  assert.equal(callFrameNote({ screen: false, camera: false, glance: false, missed: false }, 'zh-CN'), '');
  assert.equal(callFrameNote({ screen: true, curious: true, camera: false, glance: false, missed: false }, 'zh-CN'), '\n【此刻的感知】' + CURIOUS_SCREEN_LINE);
  assert.equal(callFrameNote({ screen: true, camera: false, glance: true, missed: false }, 'en'), '\n【此刻的感知】' + SCREEN_LOOK_LINE + GLANCE_LINE);
  assert.equal(callFrameNote({ screen: false, camera: false, glance: true, missed: true }, 'zh-CN'), '\n【此刻的感知】' + GLANCE_LINE + CALL_NO_FRAME_NOTE_ZH);
});
