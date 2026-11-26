// 感知的隐私关口 (wiring rewrite step 4c, docs/claude/2026-11-16-wiring-step-4c.md): the checks in the wiring that keep what she sees and
// hears closed while a switch is off, held ("别看") or refused, and that keep a window that is not the owner (or not on the screen) out.
// Each test evaluates the wiring's actual text (tests/helpers/wiring-source.ts: across electron/main.ts and electron/wiring/*.ts, so it
// follows the code when it moves) over fakes, and checks the closed case does nothing. Before this file none of these 42 checks had a
// test that failed when the check was removed (the mutation table in the record).
// Reads as text (test-affected selects this test when they change): 'electron/main.ts'.
import { screenCaptures } from '../electron/senses/screen-capture';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { callGlancesRevoked, cameraImagesRevoked } from '../electron/senses/media-runtime';
import { WIRING_PRELUDE, wiringArgument, wiringCallArguments, wiringDeclaration, wiringFunction, wiringHandler, wiringOption } from './helpers/wiring-source';

/** Evaluates `body` (statements ending in a return) with the prelude and `env`'s names in scope. */
function evaluate<T>(body: string, env: Record<string, unknown>): T {
  const code = ts.transpileModule(`${WIRING_PRELUDE}\n${body}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env)) as T;
}
const expression = <T>(text: string, env: Record<string, unknown>): T => evaluate<T>(`return (${text});`, env);
const declared = <T>(text: string, name: string, env: Record<string, unknown>): T => evaluate<T>(`${text}\nreturn ${name};`, env);

interface FakeWindow { webContents: { id: number; send(channel: string, ...args: unknown[]): void }; isDestroyed(): boolean; isVisible(): boolean; isMinimized(): boolean; getBounds(): object }
function fakeWindow(id: number, world: { visible: boolean; minimized?: boolean }, sent: unknown[] = []): FakeWindow {
  return { webContents: { id, send: (...args: unknown[]) => { sent.push(args); } }, isDestroyed: () => false, isVisible: () => world.visible,
    isMinimized: () => world.minimized === true, getBounds: () => ({ x: 0, y: 0, width: 400, height: 560 }) };
}
const onScreen = (win: FakeWindow) => !win.isDestroyed() && win.isVisible() && !win.isMinimized();
/** The camera, microphone and screen switches (electron/senses/media-runtime.ts MediaRuntime), as the gates read them. */
function fakeMedia(state: Record<string, unknown>, shares = () => state.cameraSharing === true && state.cameraLocal !== true) {
  return { state, revision: 1, openings: { screen: 1, camera: 1 }, sharesCameraFrames: shares, cameraAttachment: () => null as null | { dataUrl: string } };
}

// ---------------------------------------------------------------- 看: the camera

test('publishCameraSample: only the camera owner window, on the screen (her held window while she is out counts), while frames may be shared and not held', () => {
  const petWorld = { visible: true, minimized: false };
  const pet = fakeWindow(1, petWorld), controls = fakeWindow(2, { visible: true });
  const state = { cameraSharing: true, cameraOwner: 'pet' as string | null, cameraHeld: false };
  let shares = true, out = false; const accepted: unknown[] = [], refused: unknown[] = [];
  // electron/wiring/stage-window-wiring.ts onScreen: shown, or the companion window held hidden while she is out in Unbound.
  const heldOnScreen = (win: FakeWindow) => onScreen(win) || (win.webContents.id === 1 && out);
  const handler = expression<(sender: number, id: unknown, frame: unknown) => boolean>(wiringHandler('publishCameraSample'), {
    windows: () => [controls, pet], ownerFor: (id: number) => id === 1 ? 'pet' : 'controls', media: fakeMedia(state, () => shares), onScreen: heldOnScreen,
    cameraSamples: { accept: (...args: unknown[]) => { accepted.push(args); return true; }, refuse: (...args: unknown[]) => { refused.push(args); } } });
  assert.equal(handler(1, 's1', 'frame'), true, 'the owner, shown');
  assert.equal(handler(2, 's2', 'frame'), false, 'another window is not the owner');
  petWorld.visible = false; assert.equal(handler(1, 's3', 'frame'), false, 'the owner window is hidden');
  out = true; assert.equal(handler(1, 's3b', 'frame'), true, 'hidden because she is out in full-screen Unbound: the frame she was asked for is taken');
  state.cameraHeld = true; assert.equal(handler(1, 's3c', 'frame'), false, 'a "别看" said meanwhile wins');
  state.cameraHeld = false; out = false;
  petWorld.visible = true; petWorld.minimized = true; assert.equal(handler(1, 's4', 'frame'), false, 'the owner window is minimized');
  petWorld.minimized = false; shares = false; assert.equal(handler(1, 's5', 'frame'), false, 'local pose sensing: no frame is shared');
  assert.equal(accepted.length, 2);
  assert.deepEqual(refused.map(args => (args as unknown[])[1]), ['s2', 's3', 's3c', 's4', 's5'], 'each refusal ends its own request at once (camera-sample.ts refuse)');
});

test('the camera sample request goes only to an owner window that is on the screen', () => {
  const world = { visible: false }, sent: unknown[] = [];
  const pet = fakeWindow(1, world, sent);
  const ask = expression<(owner: number, id: string) => void>(wiringArgument('cameraSamples', 0), { windows: () => [pet], onScreen });
  assert.throws(() => ask(1, 'a'), /Camera owner unavailable/);
  assert.equal(sent.length, 0, 'a hidden window is never asked for a frame');
  world.visible = true; ask(1, 'b');
  assert.deepEqual(sent, [['desk:camera-sample', 'b']]);
});

test('I-040 sense router: the camera only while frames are shared and not held; the screen not while "别看" holds', async () => {
  const state = { cameraSharing: true, cameraOwner: 'pet', cameraHeld: false, cameraLocal: false, screenSharing: true };
  const world = { refused: false };
  const sampled: unknown[] = [], cameraCaptures: unknown[] = [];
  const pet = fakeWindow(1, { visible: true });
  const env = { media: fakeMedia(state), lookTurns: { refusedIn: () => world.refused }, lookState: () => ({}), listenTogether: null, listenWordsOn: () => false,
    audioReading: null, screenSnapshots: { sampleOnce: async () => { sampled.push(1); return { dataUrl: 'screen' }; } }, windows: () => [pet], ownerFor: () => 'pet',
    captureSharedCamera: async (...args: unknown[]) => { cameraCaptures.push(args); return { dataUrl: 'camera' }; },
    // I-166: the app passes these senses through judgedSenses (with SEE_AND_SAY.haikuLook off camera and screen never reach the judgment;
    // tests/i166-see-and-say.test.ts). The gates below stay for when it is turned back on, so here it passes them through.
    judgedSenses: <T>(senses: T) => senses };
  const on = expression<() => { camera: boolean; screen: boolean }>(wiringOption('senseRouter', 'on'), env);
  const capture = expression<(sense: string, signal: AbortSignal) => Promise<string | null>>(wiringOption('senseRouter', 'capture'), env);
  assert.deepEqual([on().camera, on().screen], [true, true]);
  state.cameraHeld = true; assert.equal(on().camera, false, '"别看" holds the camera');
  state.cameraHeld = false; state.cameraLocal = true; assert.equal(on().camera, false, 'local pose sensing shares no frame');
  assert.equal(await capture('camera', new AbortController().signal), null);
  assert.equal(cameraCaptures.length, 0, 'local pose sensing: no camera capture');
  world.refused = true;
  assert.equal(on().screen, false, '"别看" holds the screen');
  assert.equal(await capture('screen', new AbortController().signal), null);
  assert.equal(sampled.length, 0, 'no screen frame while "别看" holds');
});

test('I-085 her own look: frames only while shared, and the held state reaches her', () => {
  const state = { cameraSharing: true, cameraOwner: 'pet', cameraHeld: false, cameraLocal: false };
  const camera = expression<() => { frames: boolean; held: boolean }>(wiringOption('selfLook', 'camera'), { media: fakeMedia(state) });
  assert.deepEqual(camera(), { frames: true, held: false });
  state.cameraHeld = true; assert.equal(camera().held, true);
  state.cameraLocal = true; assert.equal(camera().frames, false, 'local pose sensing: no frame for her own look');
});

test('the look state says camera only while frames are shared', () => {
  const state = { cameraSharing: true, cameraOwner: 'pet', cameraHeld: false, cameraLocal: false, screenSharing: false };
  const lookState = declared<() => { camera: boolean }>(wiringDeclaration('lookState'), 'lookState', { media: fakeMedia(state), lookScope: () => 'scope' });
  assert.equal(lookState().camera, true);
  state.cameraLocal = true; assert.equal(lookState().camera, false);
});

test('her visual self lists the camera as a source only while frames are shared', () => {
  const state = { cameraSharing: true, cameraOwner: 'pet', cameraHeld: false, cameraLocal: false, screenSharing: false };
  const snapshots: { sources: { kind: string }[] }[] = [];
  const pet = fakeWindow(1, { visible: true });
  const env = { media: fakeMedia(state), pet, windows: () => [pet], ownerFor: () => 'pet', onScreen, speechScope: () => 'scope',
    companion: { mood: { get: () => ({ token: 't' }) } }, nativeVisibility: () => ({ visible: true, windowId: 1, revision: 1 }),
    characterCards: { getActive: () => ({ id: 'card', name: 'Gene' }) }, store: { current: { model: null } }, screen: { getDisplayMatching: () => ({ id: 7 }) },
    createHash: (algorithm: string) => { const hash = { update: () => hash, digest: () => algorithm }; return hash; },
    visualSelfRuntime: { setContext: (snapshot: { sources: { kind: string }[] }) => { snapshots.push(snapshot); return true; }, clear: () => {} } };
  const refresh = evaluate<(scope?: string, displayId?: string | null) => void>(
    `let visualSelfIdentity = '', visualSelfRevision = 0, visualSelfScreenSourceId = null, visualSelfCameraOwnerId = null;\n${wiringFunction('refreshVisualSelfContext')}\nreturn refreshVisualSelfContext;`, env);
  refresh('scope', '7');
  assert.deepEqual(snapshots.at(-1)!.sources.map(source => source.kind), ['camera']);
  state.cameraLocal = true; refresh('scope', '7');
  assert.deepEqual(snapshots.at(-1)!.sources.map(source => source.kind), [], 'local pose sensing: the camera is not a source');
});

test('the camera permission the session grants is the control window\'s switch, and video goes through the media owner check', () => {
  assert.equal(wiringCallArguments('guardSession')[1], '() => cameraEnabled', 'the permission handler reads the switch at each request');
  const permission = evaluate<{ set(value: unknown): void; get(): boolean }>(`let cameraEnabled = false;\nconst set = ${wiringHandler('setCameraPermission')};\nreturn { set, get: () => cameraEnabled };`, {});
  permission.set('yes'); assert.equal(permission.get(), false, 'only true turns it on');
  permission.set(true); assert.equal(permission.get(), true);
  permission.set(undefined); assert.equal(permission.get(), false);
  const asked: unknown[] = [];
  const allows = declared<(owner: string, kind: 'audio' | 'video', manual?: boolean) => boolean>(wiringFunction('allowsOwnedMedia'), 'allowsOwnedMedia', {
    media: { allowsMedia: (...args: unknown[]) => { asked.push(args); return false; } }, audioCapture: null });
  assert.equal(allows('pet', 'video', true), false);
  assert.deepEqual(asked, [['pet', 'video', true]]);
});

// ---------------------------------------------------------------- 看: the screen

test('屏幕只读大概: the gates that read "别看" (her rough look, watching along, 你现在方便吗) and 和她一起看', () => {
  const state = { screenSharing: true };
  const world = { refused: false, words: false };
  const env = { media: fakeMedia(state), lookTurns: { refusedIn: () => world.refused }, lookState: () => ({}), chatAvailability: { isAvailable: () => true },
    listenTogether: {}, listenWordsOn: () => world.words, audioReading: { getView: () => ({}) }, screenGlance: { watching: () => 'video' } };
  const mayLook = expression<() => boolean>(wiringOption('screenGlance', 'mayLook'), env);
  const refused = expression<() => boolean>(wiringOption('watchAlong', 'refused'), env);
  const watching = expression<() => boolean>(wiringOption('lookAttachments', 'watchingTogether'), env);
  const presence = declared<() => { screen: { on(): boolean } }>(wiringFunction('presencePorts'), 'presencePorts', { ...env, companion: null, poseSensing: null,
    captureGlanceThumbnail: async () => null, appJournal: { record() {} }, journalCharacterId: () => null });
  assert.deepEqual([mayLook(), refused(), presence().screen.on()], [true, false, true]);
  world.refused = true;
  assert.deepEqual([mayLook(), refused(), presence().screen.on()], [false, true, false], '"别看" closes each');
  assert.equal(watching(), false, 'sharing on alone: an ordinary message takes no picture (屏幕只读大概)');
  world.words = true; assert.equal(watching(), true, 'only 和她一起看 (一起听 on) takes the screen with every message');
  state.screenSharing = false; assert.equal(watching(), false);
});

test('the glance thumbnail: nothing while sharing is off, nothing if sharing went off while it was taken', async () => {
  const state = { screenSharing: false };
  const media = fakeMedia(state); let calls = 0;
  const thumbnail = { isEmpty: () => false, getSize: () => ({ width: 320, height: 200 }), resize: () => thumbnail, toJPEG: () => Buffer.from('jpeg') };
  const pet = fakeWindow(1, { visible: true });
  // I-174: the read lives in electron/wiring/senses-screen-capture.ts (moved out of the look wiring unchanged); tested on the real module.
  // no-pet-ok: the test's existing window variable
  const captures = screenCaptures({ media: media as never, companion: () => pet as never, onScreen: onScreen as never, displayOf: () => ({ id: 7 }), intervalSeconds: () => 5,
    visualSelf: () => ({ runtime: {} as never, sourceId: null }),
    capturer: { getSources: async () => { calls++; state.screenSharing = turnOff ? false : state.screenSharing; return [{ display_id: '7', thumbnail }] as never; } } });
  let turnOff = false;
  const capture = (signal: AbortSignal) => captures.glance(signal);
  assert.equal(await capture(new AbortController().signal), null);
  assert.equal(calls, 0, 'sharing off: the screen is not read');
  state.screenSharing = true;
  assert.match((await capture(new AbortController().signal))!, /^data:image\/jpeg;base64,/);
  turnOff = true;
  assert.equal(await capture(new AbortController().signal), null, 'sharing went off while the thumbnail was taken: it is dropped');
});

test('a shared screen frame: refused before the screen is read while sharing is off', async () => {
  let calls = 0;
  const captures = screenCaptures({ media: fakeMedia({ screenSharing: false }) as never, companion: () => null, onScreen: () => true, displayOf: () => ({ id: 7 }), intervalSeconds: () => 5,
    visualSelf: () => ({ runtime: {} as never, sourceId: null }), capturer: { getSources: async () => { calls++; return []; } } });
  const capture = (sourceId: string, signal: AbortSignal) => captures.shared(sourceId, signal);
  await assert.rejects(capture('7', new AbortController().signal), /Screen sharing off/);
  assert.equal(calls, 0);
});

test('「截取画面」: only a source the user just picked, within a minute', async () => {
  let calls = 0; let now = 1_000_000;
  const env = { Date: { now: () => now }, desktopCapturer: { getSources: async () => { calls++; return [{ id: 'screen:1', thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from('j') } }]; } } };
  const world = evaluate<{ pick(ids: string[]): void; capture(id: unknown): Promise<unknown> }>(
    `let sourceSelection = { at: 0, ids: new Set() };\nconst capture = ${wiringHandler('captureScreen')};\nreturn { pick(ids) { sourceSelection = { at: Date.now(), ids: new Set(ids) }; }, capture };`, env);
  await assert.rejects(world.capture('screen:1'), /请重新选择/, 'nothing picked');
  world.pick(['screen:2']);
  await assert.rejects(world.capture('screen:1'), /请重新选择/, 'not the one picked');
  world.pick(['screen:1']); now += 60_001;
  await assert.rejects(world.capture('screen:1'), /请重新选择/, 'picked more than a minute ago');
  assert.equal(calls, 0, 'the screen is never read for a refused capture');
  world.pick(['screen:1']);
  assert.ok(await world.capture('screen:1'));
  await assert.rejects(world.capture('screen:1'), /请重新选择/, 'one pick, one capture');
});

test('I-081 where you are: only the pet window gets it', () => {
  let reads = 0;
  const pet = fakeWindow(1, { visible: true });
  const gaze = expression<(sender: number) => unknown>(wiringHandler('userGaze'), { pet, screen: { getDisplayMatching: () => ({ bounds: {} }) },
    userGaze: { read: () => { reads++; return { x: 0, y: 0 }; } } });
  assert.equal(gaze(2), null); assert.equal(reads, 0);
  assert.deepEqual(gaze(1), { x: 0, y: 0 });
});

test('R10 her proactive look: only while the screen or the camera frames are shared', () => {
  const state = { screenSharing: false, cameraSharing: false };
  const eligible = declared<() => boolean>(wiringFunction('visionEligible'), 'visionEligible', {
    companion: { mood: { get: () => ({ snapshot: { phase: 'idle' } }) } }, store: {}, proactiveVisionEnabled: true, media: fakeMedia(state),
    herOnScreen: () => true, petWindowDrag: null, userInputUntil: 0, pending: new Map() });
  assert.equal(eligible(), false);
  state.screenSharing = true; assert.equal(eligible(), true);
});

// ---------------------------------------------------------------- 看: a switch changes (mediaChanged)

test('a switch off: voice and recognition stop, the face check stops, the small frame and her own look are dropped', () => {
  const calls: string[] = [];
  const previous = { voiceInput: true, voiceOwner: 'pet', screenSharing: false, cameraSharing: true, cameraImages: true, cameraLocal: false, cameraOwner: 'pet' };
  const next = { ...previous, voiceInput: false, cameraSharing: false, cameraImages: false };
  const note = (name: string) => () => { calls.push(name); };
  const changed = declared<(previous: object) => void>(wiringFunction('mediaChanged'), 'mediaChanged', {
    media: { state: next, sharesCameraFrames: () => false }, broadcast: () => {}, revokeVoice: (reason: string) => calls.push(`revokeVoice ${reason}`),
    asrTask: { controller: { abort: note('asr abort') } }, cameraImagesRevoked, clearVisionContext: note('clearVisionContext'), sightOff: note('clearVisionContext'), pending: new Map(), // I-221: sightOff is clearVisionContext keeping her reply and the page
    screenSnapshots: { state: { enabled: false }, setOptions: note('snapshots') }, screenGlance: { setSharing: () => {} }, refreshVisionContext: () => {},
    poseSensing: { syncCamera: note('pose sync') }, faceCheck: { host: { cameraChanged: note('face stop') } }, cameraGlance: { reset: note('glance reset') },
    cameraEye: { images: () => {} }, selfLook: { mediaChanged: note('self look') }, localAsr: { setWanted: (on: boolean) => calls.push(`asr wanted ${on}`) },
    voiceRoute: { engine: 'local' }, publishVisionState: () => {}, publishSenses: () => {}, voiceCall: { check: () => {} },
    callGlancesRevoked, forgetCallFrames: note('forget call frames'), relayCameraHeld: (held: boolean) => calls.push(`full-screen held ${held}`),
    see: { smallScreens: { forget: note('small screen forget') } } }); // I-166: the screen's small frame kept in memory goes too
  changed(previous);
  for (const expected of ['revokeVoice voice-off', 'asr abort', 'clearVisionContext', 'pose sync', 'face stop', 'glance reset', 'self look', 'asr wanted false', 'forget call frames', 'small screen forget'])
    assert.ok(calls.includes(expected), `${expected}: ${calls.join(', ')}`);
});

// I-161 A holds the camera without a new opening or a cleared context; a call's small frames still go at once.
test('I-161 A: "别看" (the camera held) drops a call\'s small frames from her process at once; an unrelated change does not', () => {
  const run = (previous: Record<string, unknown>, next: Record<string, unknown>) => {
    const calls: string[] = [];
    const changed = declared<(previous: object) => void>(wiringFunction('mediaChanged'), 'mediaChanged', {
      media: { state: next, sharesCameraFrames: () => next.cameraImages === true }, broadcast: () => {}, revokeVoice: () => {}, asrTask: null, cameraImagesRevoked,
      clearVisionContext: () => calls.push('clearVisionContext'), sightOff: () => calls.push('clearVisionContext'), pending: new Map(), screenSnapshots: { state: { enabled: false }, setOptions: () => {} },
      screenGlance: { setSharing: () => {} }, refreshVisionContext: () => {}, poseSensing: null, faceCheck: null, cameraGlance: { reset: () => {} },
      cameraEye: { images: () => {} }, selfLook: { mediaChanged: () => {} }, localAsr: null, voiceRoute: { engine: 'compatible' }, publishVisionState: () => {},
      publishSenses: () => {}, voiceCall: { check: () => {} }, callGlancesRevoked, forgetCallFrames: () => calls.push('forget call frames'),
      relayCameraHeld: () => {}, see: { smallScreens: { forget: () => calls.push('small screen forget') } } }); // batch D: her full-screen page's "别看" (tests/unbound-full-senses.test.ts)
    changed(previous);
    return calls;
  };
  const on = { voiceInput: true, voiceOwner: 'controls', screenSharing: false, cameraSharing: true, cameraImages: true, cameraLocal: false, cameraOwner: 'controls' };
  assert.deepEqual(run(on, { ...on, cameraHeld: true }), ['forget call frames', 'small screen forget'], '"别看": no new opening, no cleared context, the frames still go');
  assert.deepEqual(run(on, { ...on, voiceInput: false }), [], 'voice input off alone is the call\'s own hang-up (holdWarm), not this');
});

test('I-161 A: forgetCallFrames reaches her chat\'s Claude process, and is harmless before it exists', () => {
  let forgotten = 0;
  const forget = declared<() => void>(wiringFunction('forgetCallFrames'), 'forgetCallFrames', { claudeChat: { forgetFrames: () => { forgotten++; } } });
  forget();
  assert.equal(forgotten, 1);
  const early = declared<() => void>(wiringFunction('forgetCallFrames'), 'forgetCallFrames', {});
  assert.doesNotThrow(() => early());
});

test('I-161 A: which switch changes drop a call\'s small frames (callGlancesRevoked)', () => {
  const on = { voiceInput: true, voiceOwner: 'controls' as const, screenSharing: true, cameraSharing: true, cameraImages: true, cameraLocal: false, cameraOwner: 'controls' as const };
  assert.equal(callGlancesRevoked(on, { ...on, cameraHeld: true }), true, '"别看"');
  assert.equal(callGlancesRevoked(on, { ...on, screenSharing: false }), true, 'the screen off');
  assert.equal(callGlancesRevoked(on, { ...on, cameraSharing: false, cameraImages: false }), true, 'the camera off');
  assert.equal(callGlancesRevoked(on, { ...on, cameraImages: false }), true, '「发图片」 off');
  assert.equal(callGlancesRevoked({ ...on, cameraImages: false, cameraLocal: true }, { ...on, cameraImages: false, cameraLocal: true, cameraSharing: false }), true, 'the camera off (pose only)');
  assert.equal(callGlancesRevoked({ ...on, cameraHeld: true }, { ...on }), false, '"你看看我" lifts the hold: nothing to drop');
  assert.equal(callGlancesRevoked(on, { ...on, voiceInput: false }), false);
  assert.equal(callGlancesRevoked(on, { ...on, cameraLocal: true }), false, 'adding pose sensing changes nothing');
});

// ---------------------------------------------------------------- 感知窗口: the face check

test('I-135 face check: the pose frame only while local pose sensing owns the camera', () => {
  const state = { cameraLocal: true, cameraSharing: false, cameraHeld: false, cameraOwner: 'pet' };
  let mode = 'local';
  const frames = expression<{ poseOn(): boolean; imagesOn(): boolean }>(wiringOption('faceCheck', 'frames'), {
    media: fakeMedia(state), poseSensing: { cameraMode: () => mode, supervisor: { tap: async () => null } }, windows: () => [], ownerFor: () => 'pet', cameraSamples: {} });
  assert.equal(frames.poseOn(), true);
  mode = 'share'; assert.equal(frames.poseOn(), false, 'the pose process does not own the camera');
  mode = 'local'; state.cameraLocal = false; assert.equal(frames.poseOn(), false, '「姿势识别」 off');
  assert.equal(frames.imagesOn(), false);
});

// ---------------------------------------------------------------- 听

test('the computer\'s sound: only the pet window, on the screen, turns it on; a capture only after the display-media grant', () => {
  const petWorld = { visible: true };
  const pet = fakeWindow(1, petWorld);
  let sharing = 0, confirmed = 0, granted = false;
  const env = { pet, onScreen, broadcast: () => {}, publishSenses: () => {},
    systemAudio: { setSharing: () => { sharing++; return {}; }, displayStreams: () => granted }, ambientAudio: { confirmCapture: () => { confirmed++; } } };
  const share = expression<(sender: number, enabled: unknown) => unknown>(wiringHandler('setSystemAudioSharing'), env);
  assert.throws(() => share(2, true), /只有桌宠窗口/);
  petWorld.visible = false; assert.throws(() => share(1, true), /请先显示桌宠/);
  assert.equal(sharing, 0);
  petWorld.visible = true; share(1, true); assert.equal(sharing, 1);
  const confirm = expression<(sender: number, sessionId: unknown) => void>(wiringHandler('confirmAmbientAudioCapture'), env);
  assert.throws(() => confirm(1, 's'), /尚未授权/); assert.equal(confirmed, 0);
  granted = true; confirm(1, 's'); assert.equal(confirmed, 1);
});

test('old ambient listening starts only from the visible pet, and transcribes only while the computer\'s sound is on', () => {
  const petWorld = { visible: true };
  const pet = fakeWindow(1, petWorld);
  const world = { active: false };
  const env = { process: { platform: 'win32' }, pet, onScreen: (win: { isVisible(): boolean }) => win.isVisible(), ambientAsr: { ready: () => true }, asrTask: null, foregroundAsr: { busy: false }, systemAudio: { state: world } };
  const canStart = expression<(owner: number) => boolean>(wiringOption('ambientAudio', 'canStart'), env);
  const canTranscribe = expression<() => boolean>(wiringOption('ambientAudio', 'canTranscribe'), env);
  assert.equal(canStart(1), true);
  assert.equal(canStart(2), false, 'another window');
  petWorld.visible = false; assert.equal(canStart(1), false, 'the pet is hidden');
  assert.equal(canTranscribe(), false, 'the computer\'s sound is off');
  world.active = true; assert.equal(canTranscribe(), true);
});

test('audio capture is available only to a window on the screen', () => {
  const petWorld = { visible: false }, controlWorld = { visible: true };
  const available = expression<(owner: string) => boolean>(wiringOption('audioCapture', 'available'), { pet: fakeWindow(1, petWorld), controls: fakeWindow(2, controlWorld), onScreen });
  assert.equal(available('pet'), false);
  assert.equal(available('controls'), true);
  controlWorld.visible = false; assert.equal(available('controls'), false);
});

test('voice input: only the window that turned it on opens a capture, sends audio or asks for recognition', async () => {
  const state = { voiceInput: true, voiceOwner: 'pet' as string };
  let opened = 0; let current: (() => boolean) | null = null;
  const env = { media: { state }, ownerFor: (id: number) => id === 1 ? 'pet' : 'controls', pending: new Map(), VOICE_OPEN_AFTER_REPLY: 'after reply',
    revokeVoice: () => {}, asrTask: null, voiceHost: { capture: null as null | { sender: number }, open: () => { opened++; return {}; } },
    foregroundAsr: { busy: false, run: (_owner: string, _wav: unknown, _signal: unknown, isCurrent: () => boolean) => { current = isCurrent; return Promise.resolve('words'); } },
    voiceCurrent: () => true, voicePipeline: { submit: () => true } };
  const open = expression<(sender: number) => unknown>(wiringHandler('openVoiceCapture'), env);
  assert.throws(() => open(2), /未开启语音输入/); assert.equal(opened, 0);
  open(1); assert.equal(opened, 1);
  const transcribe = expression<(sender: number, wav: unknown) => Promise<string>>(wiringHandler('transcribeAudio'), env);
  assert.throws(() => transcribe(2, new ArrayBuffer(8)), /未开启语音输入/);
  await transcribe(1, new ArrayBuffer(8));
  assert.equal(current!(), true);
  state.voiceInput = false; assert.equal(current!(), false, 'voice input off: the recognition in flight is no longer current');
  state.voiceInput = true;
  env.voiceHost.capture = { sender: 1 };
  const submit = expression<(sender: number, value: unknown) => unknown>(wiringHandler('submitVoicePcm'), env);
  assert.throws(() => submit(2, { captureSeq: 1, captureSessionId: 's', wav: new ArrayBuffer(8) }), /上下文已改变/);
  assert.equal(submit(1, { captureSeq: 1, captureSessionId: 's', wav: new ArrayBuffer(8) }), true);
});

test('the audio dance sample reaches only a visible pet', () => {
  const petWorld = { visible: false }, sent: unknown[] = [];
  const submit = expression<(sender: number, value: unknown) => boolean>(wiringHandler('submitAudioDanceSample'), {
    audioCapture: { acceptDanceSample: () => ({ energy: 0.5 }) }, ownerFor: () => 'pet', pet: fakeWindow(1, petWorld, sent), relayDance: () => {} }); // batch F: her full-screen page (tests/unbound-full-senses.test.ts)
  assert.equal(submit(1, {}), false); assert.equal(sent.length, 0);
  petWorld.visible = true; assert.equal(submit(1, {}), true); assert.equal(sent.length, 1);
});
