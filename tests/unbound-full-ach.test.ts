/**
 * Batches A, C and H of full-screen Unbound (docs/claude/2026-11-21-unbound-full-ACH.md): the parts that are not the frame loop (that is
 * tests/unbound-full-ach-gene.test.ts).
 *  - A: the blush calibration and her voice's facts reach her full-screen face (host bridge: read only, checked, only to her window; the page:
 *    the bubble no longer times the accents once her voice speaks; the calibration measured on her model only).
 *  - C: her motions (host bridge: each read only for the window she is shown in, her answer counts only while she is out; the page: the
 *    window's gates with walking added; the walk mask keeps her clips off her hips and legs while she walks, eased).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { UnboundMoodBridge, SPEECH_FACE_RELAY } from '../electron/unbound/mood-bridge';
import { createUnboundApi, UNBOUND_API_KEYS, type UnboundIpc } from '../electron/unbound/preload-api';
import { UNBOUND_EVENTS, UNBOUND_REQUESTS } from '../shared/unbound/scene';
import { HerOut, VOICE_HOLDS_MS, bubbleTimesAccents, sameCalibrationModel } from '../src/unbound/her/out-page';
import { HerOutFace, lifeGates } from '../src/unbound/her/out-face';
import { loadLivelinessForEngine } from '../src/stage';
import { measureWindowModel } from '../src/unbound/window-mode/window-model';
import { sanitizeSpeechFaceCue } from '../src/voice/speech-face/cues';
import { DEFAULT_BLUSH_CALIBRATION, type BlushCalibrationView } from '../shared/mood';
import { loadPublicGeneForTargets } from './public-gene-fixture';
import { Bone, Euler, Quaternion } from 'three';
import { UnboundMotionBridge, herActionAnswerCounts, motionsOut, type UnboundMotionPorts } from '../electron/unbound/motion-bridge';
import { fullMotionEnv, herMotionHost } from '../src/unbound/her/out-motions';
import { WalkMask, isGaitBone } from '../src/unbound/her/walk-mask';
import { WindowMotions } from '../src/unbound/window-mode/window-motions';
import { NO_MOTION_BLOCKS } from '../src/unbound/window-mode/window-face-rig';
import { HER_ACTION_DETAILS } from '../shared/actions/her-actions';
import type { FigureMotionLayer } from '../src/unbound/figure';
import { faceView } from './helpers/window-face-fixture';

type Win = { isVisible(): boolean };
function bridgeFixture(ports: ConstructorParameters<typeof UnboundMoodBridge<Win>>[0], current: () => Win | null) {
  const sent: [string, unknown][] = [], handlers = new Map<string, (w: Win, ...args: unknown[]) => unknown>();
  const bridge = new UnboundMoodBridge<Win>(ports, { current, shown: current, touchable: () => true, send: (_w, channel, value) => sent.push([channel, value]) });
  bridge.register((channel, op) => handlers.set(channel, op));
  return { bridge, sent, handlers };
}

// ---- A: the host's bridge ---------------------------------------------------------------------------------------------------------

test('A bridge: the blush calibration is read only by her window and its changes relayed; without the port it is refused', async () => {
  const win = { isVisible: () => true };
  const view: BlushCalibrationView = { modelKey: 'm1', calibration: { ...DEFAULT_BLUSH_CALIBRATION, eyeOffsetY: 0.1 }, revision: 2 };
  const f = bridgeFixture(() => ({ get: () => ({}), interaction: () => ({}), blush: async () => view }), () => win);
  assert.deepEqual(await f.handlers.get(UNBOUND_REQUESTS.getBlushCalibration)!(win), view);
  f.bridge.relay('desk:blush-calibration', view);
  f.bridge.relay('desk:blush-preview', view);
  assert.deepEqual(f.sent, [[UNBOUND_EVENTS.blushCalibration, view]], 'the calibration, nothing else');
  const bare = bridgeFixture(() => ({ get: () => ({}), interaction: () => ({}) }), () => win);
  assert.throws(() => bare.handlers.get(UNBOUND_REQUESTS.getBlushCalibration)!(win), /尚未接入/);
});

test('A bridge: her voice\'s facts reach her window only well-formed (the companion\'s own check), only while there is a window, never as a broadcast', () => {
  const win = { isVisible: () => true };
  let current: Win | null = win;
  const f = bridgeFixture(() => ({ get: () => ({}), interaction: () => ({}) }), () => current);
  const start = { kind: 'start', key: 'r1#0', text: '你好呀', voiced: true }, levels = { kind: 'levels', key: 'r1#0', aheadMs: 40, stepMs: 20, levels: [0.2, 9, 'x'] };
  f.bridge.relay(SPEECH_FACE_RELAY, start);
  f.bridge.relay(SPEECH_FACE_RELAY, levels);
  f.bridge.relay(SPEECH_FACE_RELAY, { kind: 'start', key: '', text: 'x', voiced: true });
  f.bridge.relay(SPEECH_FACE_RELAY, { kind: 'levels', key: 'r1#0', aheadMs: 40, stepMs: 1, levels: [] });
  f.bridge.relay(SPEECH_FACE_RELAY, { kind: 'run', command: 'x' });
  f.bridge.relay('desk:speech-face', start);
  assert.deepEqual(f.sent, [[UNBOUND_EVENTS.speechFace, start], [UNBOUND_EVENTS.speechFace, sanitizeSpeechFaceCue(levels)]], 'two facts; the bad ones and an unknown channel dropped');
  assert.deepEqual((f.sent[1][1] as { levels: number[] }).levels, [0.2, 1, 0], 'loudness held to 0..1');
  current = null; f.bridge.relay(SPEECH_FACE_RELAY, { kind: 'stop' });
  assert.equal(f.sent.length, 2, 'no window: nothing');
});

test('A preload: the three members on fixed channels; a listener sees only the value', async () => {
  const invoked: string[] = [], listeners = new Map<string, (event: unknown, value: unknown) => void>();
  const ipc: UnboundIpc = { invoke: async channel => { invoked.push(channel); return null; }, on: (channel, listener) => { listeners.set(channel, listener); }, removeListener: () => {} };
  const api = createUnboundApi(ipc);
  for (const key of ['getBlushCalibration', 'onBlushCalibration', 'onSpeechFace']) assert.ok((UNBOUND_API_KEYS as readonly string[]).includes(key), key);
  await api.getBlushCalibration();
  assert.deepEqual(invoked, [UNBOUND_REQUESTS.getBlushCalibration]);
  const seen: unknown[][] = [];
  api.onBlushCalibration((...args: unknown[]) => seen.push(args)); api.onSpeechFace((...args: unknown[]) => seen.push(args));
  listeners.get(UNBOUND_EVENTS.blushCalibration)!({ sender: 'event' }, { modelKey: 'm' });
  listeners.get(UNBOUND_EVENTS.speechFace)!({ sender: 'event' }, { kind: 'stop' });
  assert.deepEqual(seen, [[{ modelKey: 'm' }], [{ kind: 'stop' }]]);
});

// ---- A: the page --------------------------------------------------------------------------------------------------------------------

test('A page: once her voice tells her face, the bubble no longer times the accents (the companion\'s rule with reading aloud on); later it may again', () => {
  const her = new HerOut({} as HTMLElement, null, { camera: null as never, pixels: () => 0, canTouch: () => true });
  const cues: unknown[] = [];
  her.face.speechCue = cue => { cues.push(cue); };
  her.shown({ id: 'r1', rev: 1, text: '第一句', visible: true }, false);
  assert.equal(cues.length, 1, 'no voice yet: the bubble times them (reading aloud off)');
  her.speechFace({ kind: 'start', key: 'r1#0', text: '第一句', voiced: true });
  her.shown({ id: 'r1', rev: 2, text: '第一句。第二句', visible: true }, true);
  assert.deepEqual(cues.slice(1), [{ kind: 'start', key: 'r1#0', text: '第一句', voiced: true }], 'the voice\'s fact; the bubble\'s second piece left to it');
  assert.equal(bubbleTimesAccents(1_000, 1_000 + VOICE_HOLDS_MS - 1), false);
  assert.equal(bubbleTimesAccents(1_000, 1_000 + VOICE_HOLDS_MS), true, 'her voice silent for a while: the bubble again');
  assert.equal(bubbleTimesAccents(-Infinity, 0), true);
  her.dispose();
});

test('A page: a calibration update for the model shown is used as it is; another model\'s (or the first) is read again', () => {
  const view = (modelKey: string | null): BlushCalibrationView => ({ modelKey, calibration: { ...DEFAULT_BLUSH_CALIBRATION }, revision: 1 });
  assert.equal(sameCalibrationModel(null, view('m1')), false, 'the first: read');
  assert.equal(sameCalibrationModel(view('m1'), view('m1')), true);
  assert.equal(sameCalibrationModel(view('m1'), view('m2')), false, 'another model: read again');
});

test('A face: the calibration measures her painted blush again only for her own model; the pinch\'s cheeks use it', async () => {
  const fixture = await loadPublicGeneForTargets();
  try {
    const measured = measureWindowModel(fixture.mesh, null, true);
    const face = new HerOutFace();
    face.attach({ body: { head: null, heightM: 1.6, setSlotMorphs: () => {} }, mesh: fixture.mesh, profile: measured.profile, painter: measured.painter, reviewed: true, standard: false, url: 'gene' });
    const forced: boolean[] = [], refresh = face.blush.refresh.bind(face.blush);
    face.blush.refresh = (f, bind, url, force = false) => { forced.push(force); refresh(f, bind, url, force); };
    const moved = { ...DEFAULT_BLUSH_CALIBRATION, eyeOffsetY: 0.2 };
    face.setBlushCalibration(moved, 'other-model');
    assert.deepEqual(forced, [], 'another model: kept, not measured');
    face.setBlushCalibration(moved, 'gene');
    assert.deepEqual(forced, [true], 'her model: measured again with it');
    assert.deepEqual(face.blush.calibrationFor('gene'), moved);
    face.attach(null);
  } finally { fixture.close(); }
});

// ---- C: her motions out here (the host's bridge, the page's rules, the walk mask) -----------------------------------------------------

function motionFixture(ports: UnboundMotionPorts | null, shown: () => Win | null, current: () => Win | null = shown) {
  const sent: [string, unknown][] = [], handlers = new Map<string, (w: Win, ...args: unknown[]) => unknown>();
  const bridge = new UnboundMotionBridge<Win>(() => ports, { current, shown, send: (_w, channel, value) => sent.push([channel, value]) });
  bridge.register((channel, op) => handlers.set(channel, op));
  return { bridge, sent, handlers };
}

test('C bridge: her motions\' reads only for the window she is shown in while it is visible; her answer only from that window; one of her actions relayed', () => {
  let visible = true;
  const win = { isVisible: () => visible }, other = { isVisible: () => true }, calls: string[] = [], answers: unknown[] = [];
  const ports: UnboundMotionPorts = { resolveChatGesture: (c, t) => { calls.push(`gesture ${c} ${t}`); return 'g'; }, resolveHerAction: c => { calls.push(`action ${c}`); return 'a'; },
    reportHerAction: o => { answers.push(o); }, bodyPlan: t => { calls.push(`plan ${t}`); return 'p'; }, resolveBody: c => { calls.push(`body ${c}`); return 'b'; },
    resolveBehaviorMotion: c => { calls.push(`face ${c}`); return 'f'; } };
  let shownWin: Win | null = win;
  const f = motionFixture(ports, () => shownWin, () => win);
  assert.equal(f.handlers.get(UNBOUND_REQUESTS.resolveChatGesture)!(win, 'c1', 't'), 'g');
  assert.equal(f.handlers.get(UNBOUND_REQUESTS.resolveHerAction)!(win, 'a1'), 'a');
  assert.equal(f.handlers.get(UNBOUND_REQUESTS.bodyPlan)!(win, 't', {}), 'p');
  assert.equal(f.handlers.get(UNBOUND_REQUESTS.resolveBody)!(win, 'b1', 't'), 'b');
  assert.equal(f.handlers.get(UNBOUND_REQUESTS.resolveBehaviorMotion)!(win, 'f1', 't'), 'f');
  assert.throws(() => f.handlers.get(UNBOUND_REQUESTS.resolveHerAction)!(other, 'a2'), /正在显示她/, 'another window');
  visible = false;
  assert.throws(() => f.handlers.get(UNBOUND_REQUESTS.resolveChatGesture)!(win, 'c2', 't'), /正在显示她/, 'hidden');
  f.handlers.get(UNBOUND_REQUESTS.reportHerAction)!(win, { cueId: 'a1', status: 'busy' });
  assert.deepEqual(answers, [{ cueId: 'a1', status: 'busy' }], 'an answer while hidden still counts ("hidden" is an answer)');
  f.handlers.get(UNBOUND_REQUESTS.reportHerAction)!(other, { cueId: 'a1', status: 'played' });
  assert.equal(answers.length, 1, 'another window has no say');
  shownWin = null; visible = true;
  assert.throws(() => f.handlers.get(UNBOUND_REQUESTS.bodyPlan)!(win, 't'), /正在显示她/, 'she is not shown');
  assert.equal(calls.length, 5);
  f.bridge.relay('desk:her-action', { id: 'a3', action: 'nod' }); f.bridge.relay('desk:characters', { cards: [] }); f.bridge.relay('desk:her-action', null);
  assert.deepEqual(f.sent, [[UNBOUND_EVENTS.herAction, { id: 'a3', action: 'nod' }]]);
  const bare = motionFixture(null, () => win);
  assert.throws(() => bare.handlers.get(UNBOUND_REQUESTS.resolveHerAction)!(win, 'a1'), /尚未接入/);
  assert.throws(() => bare.handlers.get(UNBOUND_REQUESTS.reportHerAction)!(win, {}), /尚未接入/);
});

test('C host: whose answer counts: out, only her full-screen window\'s; at home, only the companion window\'s', () => {
  assert.equal(herActionAnswerCounts('unbound', true), true);
  assert.equal(herActionAnswerCounts('companion', true), false, 'the hidden companion window would answer "hidden" first');
  assert.equal(herActionAnswerCounts('companion', false), true);
  assert.equal(herActionAnswerCounts('unbound', false), false);
  assert.equal(motionsOut('unbound'), true, 'out and shown: her actions and the body motion access of her window');
  for (const state of ['normal', 'entering', undefined, null]) assert.equal(motionsOut(state), false, String(state));
});

test('C preload: her motions\' seven members on fixed channels; the action listener sees only the cue', async () => {
  const invoked: [string, unknown[]][] = [], listeners = new Map<string, (event: unknown, value: unknown) => void>();
  const ipc: UnboundIpc = { invoke: async (channel, ...args) => { invoked.push([channel, args]); return null; }, on: (channel, listener) => { listeners.set(channel, listener); }, removeListener: () => {} };
  const api = createUnboundApi(ipc);
  await api.resolveChatGesture('c', 't'); await api.resolveHerAction('a'); await api.reportHerAction({ cueId: 'a', status: 'played', missing: [], detail: '' });
  await api.bodyPlan('t', undefined); await api.resolveBody('b', 't'); await api.resolveBehaviorMotion('f', 't');
  assert.deepEqual(invoked.map(([channel]) => channel), [UNBOUND_REQUESTS.resolveChatGesture, UNBOUND_REQUESTS.resolveHerAction, UNBOUND_REQUESTS.reportHerAction,
    UNBOUND_REQUESTS.bodyPlan, UNBOUND_REQUESTS.resolveBody, UNBOUND_REQUESTS.resolveBehaviorMotion]);
  const seen: unknown[][] = [];
  api.onHerAction((...args: unknown[]) => seen.push(args));
  listeners.get(UNBOUND_EVENTS.herAction)!({ sender: 'event' }, { id: 'x' });
  assert.deepEqual(seen, [[{ id: 'x' }]]);
});

test('C page rules: walking keeps a new automatic body motion from starting (not a chat gesture); her touch and a pull hold her as in the window', () => {
  const state = { shown: true, adjusting: false, pulled: false, walking: false, contact: null, speaking: false, preparing: false, thinking: false, lidsHeld: 0, blink: 0, mouthOff: false, eyesOff: false };
  const view = faceView();
  const motions = new WindowMotions(herMotionHost(null, () => true), () => fullMotionEnv(state, view, NO_MOTION_BLOCKS));
  const walking = fullMotionEnv({ ...state, walking: true }, view, NO_MOTION_BLOCKS);
  assert.equal(walking.walking, true);
  assert.equal(motions.chatBlocked(walking), false, 'a chat gesture plays on while she walks (upper body only)');
  assert.equal(motions.actionBusy('arms', walking), '', 'and her actions');
  const pat = fullMotionEnv({ ...state, contact: { contact: true } }, view, NO_MOTION_BLOCKS);
  assert.equal(pat.pat, true); assert.equal(motions.chatBlocked(pat), true, 'a pat: the gesture gives way');
  assert.equal(fullMotionEnv({ ...state, contact: { pinch: { pinching: true } } }, view, NO_MOTION_BLOCKS).pinch, true);
  assert.equal(fullMotionEnv({ ...state, contact: { hover: 0.4 } }, view, NO_MOTION_BLOCKS).hover, true);
  assert.equal(motions.actionBusy('arms', fullMotionEnv({ ...state, pulled: true }, view, NO_MOTION_BLOCKS)), HER_ACTION_DETAILS.contact, 'a pull');
  assert.equal(motions.actionBusy('delta', fullMotionEnv({ ...state, adjusting: true }, view, NO_MOTION_BLOCKS)), HER_ACTION_DETAILS.adjusting, 'a peek or her walk back');
  const asleep = fullMotionEnv(state, { ...view, fatigue: { ...view.fatigue, sleeping: true } } as never, NO_MOTION_BLOCKS);
  assert.equal(asleep.asleep, true, 'asleep: no gesture starts');
  // The automatic body motion's gate (the window's bodyGates with the walking flag; the window never sets it).
  const gates = (env: ReturnType<typeof fullMotionEnv>) => {
    const m = new WindowMotions(herMotionHost(null, () => true), () => env);
    m.clips = { chat: { getState: () => ({ active: false }) }, action: { active: false } } as never;
    (m as unknown as { model: unknown }).model = {};
    return m.bodyGates(env);
  };
  assert.equal(gates(walking).dynamicPose, true, 'walking: a new one does not start, a playing one is handed back');
  assert.equal(gates(fullMotionEnv(state, view, NO_MOTION_BLOCKS)).dynamicPose, false);
});

test('C host port: only the methods the motions call, each refused when the page has no host; her own life\'s poses are not out here yet', async () => {
  const host = herMotionHost(null, () => true);
  assert.equal(await host.isBehaviorModelSupported(), true);
  await assert.rejects(host.resolveChatGesture('c', 't'), /尚未接入/);
  await assert.rejects(host.getBehaviorBodyPlan('t'), /尚未接入/);
  await assert.rejects(host.resolveHerLifeMotion('m', 't'), /尚未接入/);
  await host.reportHerAction({ cueId: 'a', status: 'played', missing: [], detail: '' }); // nowhere to report: quiet
  const asked: string[] = [];
  const wired = herMotionHost({ resolveHerAction: async id => { asked.push(id); return {} as never; } }, () => false);
  await wired.resolveHerAction('a9');
  assert.deepEqual(asked, ['a9']);
  assert.equal(await wired.isBehaviorModelSupported(), false);
});

test('C walk mask: while she walks her clips leave her hips and legs to her gait (eased in and out, never a cut); her arms keep the clip', () => {
  const skeletonBones = ['下半身', '左足', '右ひざ', '左腕', '上半身'].map(name => Object.assign(new Bone(), { name }));
  const mesh = { skeleton: { bones: skeletonBones } } as never;
  const [hips, leg, knee, arm, chest] = skeletonBones;
  const turn = new Quaternion().setFromEuler(new Euler(0.4, 0, 0));
  const memo = new Map<Bone, Quaternion>();
  const inner: FigureMotionLayer = { armsHeld: 0.5, beforeUpdate: () => {}, restore: () => { for (const [bone, q] of memo) bone.quaternion.copy(q); memo.clear(); },
    frame: () => { for (const bone of [hips, leg, knee, arm, chest]) { memo.set(bone, bone.quaternion.clone()); bone.quaternion.multiply(turn); } } };
  const mask = new WalkMask().over(inner, mesh);
  assert.equal(mask.armsHeld, 0.5);
  const angle = (bone: Bone) => bone.quaternion.angleTo(new Quaternion()) * 180 / Math.PI;
  const frame = (walking: boolean) => { mask.restore(); mask.setWalking(walking); mask.frame(1 / 60); return { legs: Math.max(angle(hips), angle(leg), angle(knee)), arm: angle(arm), chest: angle(chest) }; };
  const standing = frame(false);
  assert.ok(standing.legs > 20 && standing.arm > 20, 'standing: the clip shows everywhere');
  const legs: number[] = [];
  for (let i = 0; i < 40; i++) { const f = frame(true); legs.push(f.legs); assert.ok(f.arm > 20 && f.chest > 20, 'her upper body keeps the clip'); }
  assert.ok(legs.at(-1)! < 1e-3, `walking: her hips and legs are what was under the clip (${legs.at(-1)!.toFixed(4)}°)`);
  const steps = legs.slice(1).map((v, i) => Math.abs(v - legs[i]));
  assert.ok(Math.max(...steps) < 2.2, `eased in (largest step ${Math.max(...steps).toFixed(2)}° per frame of 22.9°)`);
  assert.ok(legs[0] > 20, 'not a cut on the first frame');
  for (let i = 0; i < 40; i++) frame(false);
  assert.ok(frame(false).legs > 20, 'stopped: the clip shows on her legs again (eased back)');
  for (const name of ['センター', '下半身', '左足ＩＫ', '右つま先ＩＫ', 'leftUpperLeg', 'hips']) assert.equal(isGaitBone(name), true, name);
  for (const name of ['上半身', '左腕', '頭', 'leftUpperArm', 'spine']) assert.equal(isGaitBone(name), false, name);
});

// ---- H: her procedural life out here ----------------------------------------------------------------------------------------------

test('H gates: her procedural life gives way to a peek, a pull or her walk back ("adjusting"), a touch, speaking; her walk is not an owner', () => {
  const free = { contact: false, touched: false, face: false, head: false, mouth: false, gazeAllowed: true, fatigueFace: false, sleepCapable: true, feeding: false };
  const calm = { adjusting: false, speaking: false, voiced: false };
  assert.deepEqual(lifeGates(free, calm), { contact: false, face: false, head: false, mouth: false, adjusting: false, speaking: false, gazeAllowed: true, fatigueFace: false });
  assert.equal(lifeGates(free, { ...calm, adjusting: true }).adjusting, true, 'a peek, a pull, her walk back');
  assert.equal(lifeGates(free, { ...calm, voiced: true }).speaking, true, 'her voice holds her mouth');
  assert.equal(lifeGates({ ...free, contact: true }, calm).contact, true, 'a touch');
  assert.equal(lifeGates({ ...free, head: true }, calm).head, true, 'a picked head motion');
});

test('H on Gene: her procedural life moves her head standing, fades out (eased) under a peek or a pull, and comes back', async () => {
  const fixture = await loadPublicGeneForTargets();
  try {
    const measured = measureWindowModel(fixture.mesh, null, true);
    let seed = 3; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const face = new HerOutFace(random);
    face.loadLife(await loadLivelinessForEngine());
    face.attach({ body: { head: null, heightM: 1.6, setSlotMorphs: () => {} }, mesh: fixture.mesh, profile: measured.profile, painter: measured.painter, reviewed: true, standard: false, url: 'gene' });
    face.setMood(faceView({ primary: 'happy', companion: 'comfortable' }));
    const inner = { sense: null, intentIdle: null, setPoseTargets: () => {} } as never;
    // Its tilt, sway and gaze (the expression primitive keeps a tiny nod with her continuous face: the layer gates that by touch, not by a peek).
    const size = () => Math.abs(face.lifeOut.head.yaw) + Math.abs(face.lifeOut.head.roll) + Math.abs(face.lifeOut.torso.yaw) + Math.abs(face.lifeOut.torso.roll);
    const gazeSize = () => Math.abs(face.lifeOut.gaze.x) + Math.abs(face.lifeOut.gaze.y);
    const run = (seconds: number, adjusting: boolean) => { const sizes: number[] = []; for (let i = 0; i < Math.round(seconds * 60); i++) {
      face.frame(1 / 60, inner, { shown: true, adjusting, voiced: false, speaking: false, walking: false, nowMs: 1_000_000 + i * 16 }); sizes.push(size()); } return sizes; };
    const free = run(6, false);
    assert.ok(Math.max(...free) > 0.004, `standing: her head and weight move a little (${Math.max(...free).toFixed(4)} rad)`);
    const held = run(2, true);
    assert.ok(Math.max(...held.slice(-30)) < 1e-3 && gazeSize() < 1e-3, `under a peek or a pull it has faded out (${Math.max(...held.slice(-30)).toFixed(5)} rad, gaze ${gazeSize().toFixed(5)})`);
    const steps = held.slice(1).map((v, k) => Math.abs(v - held[k]));
    assert.ok(Math.max(...steps) < 0.002, `eased out, never cut (largest change ${Math.max(...steps).toFixed(5)} rad per frame)`);
    const back = run(4, false);
    assert.ok(Math.max(...back) > 0.002, 'and comes back');
    face.attach(null);
  } finally { fixture.close(); }
});
