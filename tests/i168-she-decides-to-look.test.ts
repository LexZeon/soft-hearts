// I-168.
// What is tested here, the switch gates first:
//  - the switches are the only lock: 「发图片」 or screen sharing off → no small frame, no clear frame, her marker does nothing, and the warm
//    process holding frames of that sense is replaced before anything more is written;
//  - "别看" changes nothing the app sends (the app's LookTurns holds nothing): small frames go on, her marker takes a clear frame, "看看我" too;
//  - clear frames ("看看我", her closer look) stay in the warm process like small ones (no retire after use), each with its own check;
//  - her paragraph carries one clause about "别看", only while a sense gives pictures, in her card language;
//  - the app's wiring passes the knobs (holdOnNo false, keepClearFrames true).
// Real: LookTurns, LookAttachments, MediaRuntime, CameraGlance, LookContinuation, PersistentClaudeChat + ClaudeChatProcess, wireSeeAndSay.
// Fake: Claude Code (tests/helpers/fake-claude-stream.ts), the captures. No camera, no screen, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import ts from 'typescript';
import type { ChatMessage } from '../shared/foundation/chat';
import { SEE_AND_SAY } from '../shared/senses/see-and-say/knobs';
import { seeAndSayLine } from '../shared/senses/see-and-say/words';
import { stripLookMarkers } from '../shared/senses/see-and-say/marker';
import { buildCodexChatPrompt } from '../electron/brain/conversation-context';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../electron/brain/claude-session';
import { LookContinuation, type CloserLookEntry } from '../electron/brain/look-continuation';
import { LookTurns } from '../electron/senses/look-turns';
import { LookAttachments, type TurnFrames } from '../electron/senses/look-attachments';
import { CameraGlance } from '../electron/senses/camera-glance';
import { MediaRuntime, type CameraPolicy } from '../electron/senses/media-runtime';
import { wireSeeAndSay } from '../electron/wiring/see-and-say-wiring';
import { fakeClaudeStream } from './helpers/fake-claude-stream';
import { WIRING_PRELUDE, wiringDeclaration } from './helpers/wiring-source';

const jpeg = (n: number) => 'data:image/jpeg;base64,' + Buffer.from([255, 216, 255, 224, n, 7, 7, 7, 7]).toString('base64');

/** The app's look kit: LookTurns as the app makes it (holds: SEE_AND_SAY.holdOnNo) and the keep-clear port as see-and-say's wiring gives it. */
function lookKit(over: { holds?: boolean; keepClear?: boolean } = {}) {
  const policy: CameraPolicy = { mode: () => 'share', blocked: () => 'needs-component' };
  const media = new MediaRuntime(undefined, policy);
  media.update({ cameraImages: true, screenSharing: true }, 'controls');
  let shots = 0;
  const captured: string[] = [];
  const turns = new LookTurns(() => 0, () => {}, { holds: over.holds ?? SEE_AND_SAY.holdOnNo });
  const keeper = new CameraGlance({ frame: () => media.cameraAttachment(), poseOn: () => false, signal: () => null, opening: () => media.openings.camera });
  const state = () => ({ screen: media.state.screenSharing, camera: media.sharesCameraFrames() && !!media.state.cameraOwner, scope: `c|${media.revision}`,
    screenOpening: media.openings.screen, cameraHeld: media.state.cameraHeld === true });
  const look = new LookAttachments(turns, {
    noteActivity() {}, state, sharesCameraFrames: () => media.sharesCameraFrames(), revision: () => media.revision, generation: () => 0, opening: source => media.openings[source],
    captureScreen: async () => { captured.push('screen'); return { source: 'screen', dataUrl: jpeg(200 + ++shots % 50) }; },
    captureCamera: async () => { captured.push('camera'); return { source: 'camera', dataUrl: jpeg(150 + ++shots % 50) }; },
    glance: everyTurn => keeper.take(everyTurn), seenCamera: () => keeper.seen(), holdCamera: held => { media.holdCamera(held); }, textFirst: () => true,
    seeAndSay: () => true, smallWaitMs: () => 200,
    smallScreen: async () => (media.state.screenSharing ? { source: 'screen', dataUrl: jpeg(90 + ++shots % 50) } : null),
    keepClearFrames: () => over.keepClear ?? SEE_AND_SAY.keepClearFrames,
  });
  media.publishCamera('controls', jpeg(1));
  const seeing = () => ({ camera: media.sharesCameraFrames() && media.state.cameraHeld !== true, screen: media.state.screenSharing && !turns.refusedIn(state()) });
  const turn = async (text: string) => look.admit(await look.request({ text }));
  return { media, look, turns, turn, captured, seeing };
}

const kinds = (frames: TurnFrames) => frames.current().map(frame => `${frame.source}-${frames.cameraGlance() && frame.source === 'camera' ? 'small' : frames.screenGlance() && frame.source === 'screen' ? 'small' : 'clear'}`).sort();

// ---------------------------------------------------------------- the switches are the only lock

test('the knobs: "别看" holds nothing, clear frames stay; the app makes its LookTurns and see-and-say ports with them', () => {
  assert.equal(SEE_AND_SAY.holdOnNo, false);
  assert.equal(SEE_AND_SAY.keepClearFrames, true);
  const env = { LookTurns, Date, broadcast: () => {}, SEE_AND_SAY };
  const made = new Function(...Object.keys(env), ts.transpileModule(`${WIRING_PRELUDE}\n${wiringDeclaration('lookTurns')}\nreturn lookTurns;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...Object.values(env)) as LookTurns;
  assert.equal(made.holds, false, 'the app\'s own LookTurns holds nothing on a no');
  assert.equal(new LookTurns().holds, true, 'LookTurns alone keeps the rule before (the knob\'s undo)');
  const see = wireSeeAndSay({ seeing: () => ({ camera: true, screen: true }), screenKey: () => 'k', thumbnail: async () => null, sampleCamera: async () => null,
    language: () => 'zh-CN', fromDataURL: () => { throw new Error('unused'); }, journal: () => {} });
  assert.equal(see.lookPorts.keepClearFrames(), true, 'see-and-say\'s wiring hands LookAttachments the keep-clear port');
});

test('switch off: no small frame, no clear frame, her closer look takes nothing ("别看" or not)', async () => {
  const k = lookKit();
  k.media.update({ cameraImages: false, screenSharing: false }, 'controls');
  assert.deepEqual((await k.turn('今天好累')).current(), [], 'no small frames');
  assert.deepEqual((await k.turn('你看看我')).current(), [], '"看看我" takes nothing either');
  assert.equal(await k.look.closer('camera', new AbortController().signal), null, 'her marker: no camera');
  assert.equal(await k.look.closer('screen', new AbortController().signal), null, 'her marker: no screen');
  assert.deepEqual(k.captured, [], 'nothing was even captured');
  // Only one off: the other still gives pictures.
  const half = lookKit();
  half.media.update({ screenSharing: false }, 'controls');
  assert.deepEqual(kinds(await half.turn('嗨')), ['camera-small']);
  assert.equal(await half.look.closer('screen', new AbortController().signal), null);
});

test('"别看" changes nothing the app sends: the small frames go on (that turn and after), her marker still takes a clear frame', async () => {
  const k = lookKit();
  for (const text of ['先别看我', '别看我屏幕', '你别盯着我看了', '我们聊点别的吧']) {
    assert.deepEqual(kinds(await k.turn(text)), ['camera-small', 'screen-small'], text);
  }
  assert.equal(k.media.state.cameraHeld, undefined, 'the camera is never held');
  assert.equal(k.turns.refusedIn({ screen: true, camera: true, scope: '', screenOpening: k.media.openings.screen }), false, 'nor the screen');
  const clear = await k.look.closer('camera', new AbortController().signal);
  assert.ok(clear && clear.dataUrls().length === 1, 'her marker during a "别看": a clear camera frame');
  assert.ok((await k.look.closer('screen', new AbortController().signal))?.dataUrls().length === 1, 'and the screen');
  assert.ok(kinds(await k.turn('你看看我')).includes('camera-clear'), '"看看我" still takes a clear one');
  // The knob's undo: holds on is the rule before.
  const before = lookKit({ holds: true });
  assert.deepEqual(kinds(await before.turn('别看我')).filter(kind => kind.startsWith('camera')), [], 'holdOnNo true: the camera holds');
});

test('her paragraph: one clause about "别看", only while a sense gives pictures, in her card language', () => {
  assert.equal(seeAndSayLine({ camera: false, screen: false }, 'zh-CN'), '', 'no sense: no paragraph at all (nothing added to the turn)');
  const zh = seeAndSayLine({ camera: true, screen: false }, 'zh-CN');
  assert.match(zh, /用户叫你别看时，看不看、提不提由你决定，看了也不用瞒着/u);
  const en = seeAndSayLine({ camera: false, screen: true }, 'en');
  assert.match(en, /If the user asks you not to look, whether you look or say so is yours to decide; if you do look, do not hide it\./u);
  assert.ok(!/[一-鿿]/u.test(en));
});

// ---------------------------------------------------------------- the warm process (the real session)

async function world(over: { keepClear?: boolean } = {}) {
  const claude = await fakeClaudeStream();
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [claude.script], provider: () => ({ kind: 'claude', model: 'haiku' }),
    chattedBefore: () => true, interruptGraceMs: 300, log: () => {}, callGlances: { stays: true, cap: 40, outside: true } });
  const kit = lookKit({ keepClear: over.keepClear });
  const messages: ChatMessage[] = [];
  let n = 0;
  const entries: CloserLookEntry[] = [];
  const continuation = new LookContinuation({ senses: kit.seeing, capture: (sense, signal) => kit.look.closer(sense, signal),
    note: (sense, seen) => `CONTINUE-${sense}-${seen ? 'seen' : 'missed'}`, journal: entry => entries.push(entry),
    knobs: { closerLook: true, closerTimeoutMs: 2000, dots: '……', keepClearFrames: over.keepClear ?? SEE_AND_SAY.keepClearFrames } });
  /** One typed turn as electron/wiring/brain-chat-wiring.ts sends it (the turn's frames and glance mark; her closer look around the stream). */
  const say = async (text: string) => {
    const frames = kit.look.admit(await kit.look.request({ text }));
    messages.push({ role: 'user', content: text });
    const window = [...messages], base = '你是测试角色小桃。';
    let shown = '';
    const task: CompanionClaudeTask = { kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(base, window); },
      get imageDataUrls() { return frames.current().map(frame => frame.dataUrl); }, replyId: `r${++n}`,
      session: { key: 'typed', basePersona: base, persona: base, messages: window, data: () => null, shown: () => shown }, // the reply as shown (the app's beatTurn.historyText)
      callGlance: { glanceOnly: () => frames.glanceOnly(), still: () => frames.glanceStill(), past: () => '' } };
    await continuation.stream(chat, task, new AbortController().signal, (type, delta) => { if (type === 'delta') shown += delta; });
    messages.push({ role: 'assistant', content: shown });
    return { frames: kinds(frames), shown };
  };
  const inputs = async () => (await claude.inputs()).filter(input => input.user !== undefined);
  const pidOf = async (text: string) => (await inputs()).find(input => input.user === text)?.pid;
  return { kit, chat, say, inputs, pidOf, entries, dispose: async () => { chat.dispose(); await claude.cleanup(); } };
}

test('clear frames stay in the warm process: "看看我", her closer look during a "别看", and the turns after them, all on one process', async () => {
  const w = await world();
  try {
    await w.say('今天好累');
    assert.deepEqual((await w.say('你看看我')).frames, ['camera-clear', 'screen-small']);
    await w.say('先别看我');
    const looked = await w.say('我现在什么表情⟦look-camera⟧'); // the fake echoes the user text: she writes the marker
    assert.ok(!looked.shown.includes('⟦') && looked.shown.includes('CONTINUE-camera-seen'), looked.shown);
    assert.deepEqual(w.entries.map(entry => entry.outcome), ['taken'], 'her look during a "别看" was taken');
    await w.say('然后呢');
    const pids = await Promise.all(['今天好累', '你看看我', '先别看我', '我现在什么表情⟦look-camera⟧', 'CONTINUE-camera-seen', '然后呢'].map(w.pidOf));
    assert.equal(new Set(pids).size, 1, `one warm process, no retire after a clear frame: ${pids}`);
    const continued = (await w.inputs()).find(input => input.user === 'CONTINUE-camera-seen');
    assert.equal(continued?.images?.length, 1, 'the continuation carried the clear frame');
  } finally { await w.dispose(); }
});

test('a switch off replaces the warm process before anything more is written, and the new one never sees a frame of before', async () => {
  // A kept clear frame has its own check: the screen's clear frame alone (with the camera's small one) still goes when sharing goes off.
  const only = await world();
  try {
    assert.deepEqual((await only.say('看看屏幕上这个')).frames, ['camera-small', 'screen-clear']);
    only.kit.media.update({ screenSharing: false }, 'controls');
    await only.say('嗯');
    const [shown, after] = await Promise.all(['看看屏幕上这个', '嗯'].map(only.pidOf));
    assert.notEqual(after, shown, 'the clear screen frame\'s check fails: a new process');
  } finally { await only.dispose(); }
  const w = await world();
  try {
    await w.say('你看看我');
    await w.say('看看屏幕上这个');
    const old = (await w.inputs()).flatMap(input => input.images ?? []);
    w.kit.media.publishCamera('controls', jpeg(2)); // a new small camera frame (the old one is part of before)
    w.kit.media.update({ screenSharing: false }, 'controls'); // the screen only: the camera's frames could keep it, the screen's clear frame must not
    await w.say('嗯');
    const [first, after] = await Promise.all(['你看看我', '嗯'].map(w.pidOf));
    assert.notEqual(after, first, 'the screen off: a new process');
    const seen = (await w.inputs()).filter(input => input.pid === after).flatMap(input => input.images ?? []);
    for (const frame of old) assert.ok(!seen.includes(frame), 'no frame of before reaches the new process');
    w.kit.media.update({ cameraImages: false }, 'controls');
    await w.say('好吧');
    assert.notEqual(await w.pidOf('好吧'), after, '「发图片」 off: a new process again');
    assert.deepEqual((await w.inputs()).filter(input => input.user === '好吧').flatMap(input => input.images ?? []), [], 'and no pictures at all');
  } finally { await w.dispose(); }
});

test('her marker with the sense off does nothing; the marker never shows; keepClearFrames off is I-161 A\'s rule (a clear frame retires after use)', async () => {
  const off = await world();
  try {
    off.kit.media.update({ cameraImages: false }, 'controls');
    const reply = await off.say('你在吗⟦look-camera⟧');
    assert.ok(!reply.shown.includes('⟦'), reply.shown);
    assert.deepEqual(off.entries.map(entry => entry.outcome), ['off']);
    assert.equal((await off.inputs()).some(input => input.user?.startsWith('CONTINUE')), false, 'nothing taken, nothing sent');
  } finally { await off.dispose(); }
  assert.equal(stripLookMarkers('嗯⟦look-screen⟧').text, '嗯');
  const before = await world({ keepClear: false });
  try {
    await before.say('你看看我');
    await before.say('然后呢');
    const [asked, next] = await Promise.all(['你看看我', '然后呢'].map(before.pidOf));
    assert.notEqual(next, asked, 'keepClearFrames false: the process retires after the clear frame');
    await before.say('再看看⟦look-camera⟧');
    await before.say('嗯嗯');
    const [looked, after] = await Promise.all(['CONTINUE-camera-seen', '嗯嗯'].map(before.pidOf));
    assert.notEqual(after, looked, 'and after her closer look\'s clear frame');
  } finally { await before.dispose(); }
});
