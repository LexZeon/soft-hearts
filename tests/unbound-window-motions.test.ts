/**
 * I-154 batch 5 (docs/claude/2026-11-20-unbound-window-batch5.md): rows 30 聊天手势, 31 她的动作, 32 自动身体动作, 34 对你动作的反应 and 38
 * 惊喜 / 害羞 on the window engine. The gates (the old stage's), her answers to a test command, and one long scene on the real Gene frame loop
 * at 60 and 30 fps through the code the stage runs (WindowMotions, WindowClips, WindowLiveliness, WindowReactions), measured per frame:
 * step and unexpected step (R29c) of her upper body and arms, against her own idle and against the same motions on the old stage's real
 * frame loop (tests/helpers/gene-stage-harness.ts). WINDOW_BATCH5_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Scene } from 'three';
import catalog from '../shared/actions/motion-catalog.json';
import { BEHAVIOR_RECIPES, BODY_START_AGE_MS, type BodyMotionCue, type BodyMotionPlan } from '../shared/actions';
import { HER_ACTION_CUE_MS, HER_ACTION_DETAILS, HER_ACTION_PACK, HER_ACTION_SPECS, type HerActionCue, type HerActionId, type HerActionOutcome } from '../shared/actions/her-actions';
import { WindowMotions, type WindowMotionEnv } from '../src/unbound/window-mode/window-motions';
import { WindowReactions } from '../src/unbound/window-mode/window-reactions';
import { withReaction } from '../src/unbound/window-mode/window-liveliness';
import { WindowLiveliness } from '../src/unbound/window-mode/window-liveliness';
import { WindowFace } from '../src/unbound/window-mode/window-face';
import { NO_MOTION_BLOCKS, motionBlocks, NO_FACE_BLOCKS, slotBindings, windowFaceRig } from '../src/unbound/window-mode/window-face-rig';
import { withoutGrants } from '../src/unbound/window-mode/window-clips';
import type { WindowStageHost } from '../src/unbound/window-mode/host-ports';
import { isChatGestureTrack, loadLivelinessForEngine, type ShowCapabilities } from '../src/stage';
import { StageModelProfile } from '../src/stage/model-profile';
import { card, faceView } from './helpers/window-face-fixture';
import { frameSteps, surprises, windowGene, WINDOW } from './helpers/unbound-window';
import { max, standClip } from './helpers/unbound-gene';
import { catalogMotionFile, TRACKED_BONES } from './helpers/frame-stats';
import { settledVmdBytes } from './helpers/settled-vmd';

const REPORT = process.env.WINDOW_BATCH5_REPORT === '1';
/** Batch 6: how long each VMD read takes on purpose (ms; WINDOW_SLOW_READ_MS to try another): the scene must not depend on it. */
const SLOW_READ_MS = Number(process.env.WINDOW_SLOW_READ_MS ?? 25);
const DEG = 180 / Math.PI;

// ---- the gates (pure) ---------------------------------------------------------------------------------------------------------
const baseEnv = (): WindowMotionEnv => ({ shown: true, typing: false, behaviorBlocked: false, inputBlocked: false, adjusting: false, pat: false, feeding: false,
  hover: false, pinch: false, pulled: false, asleep: false, rps: false, give: false, hands: false, speaking: false, preparing: false, thinking: false,
  view: faceView(), blocks: NO_MOTION_BLOCKS, showing: false, reacting: false, lidsHeld: 0, blink: 0, mouthOff: false, eyesOff: false });
const reports: HerActionOutcome[] = [];
const recordingHost = (over: Partial<WindowStageHost> = {}): WindowStageHost => ({ isBehaviorModelSupported: async () => true,
  resolveChatGesture: async () => { throw Error('none'); }, resolveHerAction: async () => { throw Error('none'); },
  reportHerAction: async outcome => { reports.push(outcome); }, getBehaviorBodyPlan: async () => ({ mode: 'closed', reason: 'normal-pool-closed', cue: null }) as BodyMotionPlan,
  resolveBehaviorBody: async () => { throw Error('none'); }, resolveBehaviorMotion: async () => { throw Error('none'); },
  resolveHerLifeMotion: async () => { throw Error('none'); }, ...over });

test('chat gesture gates (the old stage\'s): typing, a window or camera move, a touch, a pull, an offer, her reach, a picked gesture, asleep: it gives way', () => {
  const motions = new WindowMotions(recordingHost(), baseEnv);
  assert.equal(motions.chatBlocked(baseEnv()), false);
  for (const key of ['typing', 'behaviorBlocked', 'adjusting', 'pat', 'feeding', 'hover', 'pulled', 'give', 'hands', 'asleep'] as const)
    assert.equal(motions.chatBlocked({ ...baseEnv(), [key]: true }), true, key);
  assert.equal(motions.chatBlocked({ ...baseEnv(), blocks: { ...NO_MOTION_BLOCKS, chatGesture: true } }), true, 'a picked gesture');
  assert.equal(motions.chatBlocked({ ...baseEnv(), view: faceView({ expressions: false }) }), true, '自动表现 off');
  assert.equal(motions.chatBlocked({ ...baseEnv(), inputBlocked: true }), false, 'input focus alone does not hand a gesture back (old stage)');
});

test('her action gates (the old stage\'s): who holds her, in the note\'s words; arms and head each by their own owners', () => {
  const motions = new WindowMotions(recordingHost(), baseEnv);
  assert.equal(motions.actionBusy('arms', baseEnv()), '');
  assert.equal(motions.actionBusy('arms', { ...baseEnv(), shown: false }), HER_ACTION_DETAILS.hidden);
  for (const key of ['pat', 'feeding', 'pinch', 'hover', 'pulled'] as const) assert.equal(motions.actionBusy('arms', { ...baseEnv(), [key]: true }), HER_ACTION_DETAILS.contact, key);
  assert.equal(motions.actionBusy('delta', { ...baseEnv(), adjusting: true }), HER_ACTION_DETAILS.adjusting);
  assert.equal(motions.actionBusy('delta', { ...baseEnv(), rps: true }), HER_ACTION_DETAILS.game);
  assert.equal(motions.actionBusy('arms', { ...baseEnv(), blocks: { ...NO_MOTION_BLOCKS, chatGesture: true } }), HER_ACTION_DETAILS.manual);
  assert.equal(motions.actionBusy('delta', { ...baseEnv(), blocks: { ...NO_MOTION_BLOCKS, chatGesture: true } }), '', 'a nod is not held by a picked gesture');
  assert.equal(motions.actionBusy('delta', { ...baseEnv(), blocks: { ...NO_MOTION_BLOCKS, head: true, manualPose: true } }), HER_ACTION_DETAILS.manual);
  assert.equal(motions.actionBusy('arms', { ...baseEnv(), showing: true }), HER_ACTION_DETAILS.preview);
  assert.equal(motions.faceBusy('mouth', { ...baseEnv(), speaking: true }), HER_ACTION_DETAILS.speaking);
  assert.equal(motions.faceBusy('eyelids', { ...baseEnv(), speaking: true }), '', 'speech holds the mouth, not the lids');
  assert.equal(motions.faceBusy('eyelids', { ...baseEnv(), lidsHeld: 0.5 }), HER_ACTION_DETAILS.eyesClosed);
  assert.equal(motions.faceBusy('mouth', { ...baseEnv(), reacting: true }), HER_ACTION_DETAILS.reaction);
  assert.equal(motions.faceBusy('mouth', { ...baseEnv(), blocks: { ...NO_MOTION_BLOCKS, mouth: true } }), HER_ACTION_DETAILS.manualFace);
});

test('her answer reaches the host for every cue (the stub never answered and the host waited it out); no model: failed', async () => {
  reports.length = 0;
  const motions = new WindowMotions(recordingHost(), baseEnv);
  const at = Date.now(), cue: HerActionCue = { id: 'w5a', action: 'nod', at, expiresAt: at + HER_ACTION_CUE_MS };
  await motions.playHerAction(cue);
  assert.deepEqual(reports, [{ cueId: 'w5a', status: 'failed', missing: [], detail: HER_ACTION_DETAILS.noModel }]);
  await motions.playHerAction(cue);
  assert.equal(reports.length, 1, 'once per id');
  await motions.playHerAction({ ...cue, id: 'w5b', action: 'wink' });
  assert.equal(reports.at(-1)?.status, 'failed', 'a face shape too');
  await motions.playHerAction({ id: 'bad', action: 'nod' });
  assert.equal(reports.length, 2, 'not a cue: nothing');
});

test('automatic body motion gates: typing and input focus block new ones, a pull is direct contact, the QA stand is not here', () => {
  const motions = new WindowMotions(recordingHost(), baseEnv);
  assert.equal(motions.bodyGates(baseEnv()).ready, false, 'no model: closed');
  const blocks = motionBlocks({ pose: null, gesture: null }, false, NO_FACE_BLOCKS, isChatGestureTrack);
  assert.deepEqual(blocks, NO_MOTION_BLOCKS, 'nothing picked: nothing held');
  const life = motions.lifeGates({ ...baseEnv(), typing: true });
  assert.equal(life.engaged, true, 'typing: the user is here (her reactions to your pose wait)');
  assert.equal(motions.lifeGates({ ...baseEnv(), asleep: true }).asleep, true);
});

test('hidden (nothing drawn): what plays stops at once, nothing is kept to resume later', () => {
  const motions = new WindowMotions(recordingHost(), () => ({ ...baseEnv(), shown: false }));
  let stopped = 0;
  motions.clips = { moving: true, behavior: null, stopAll: () => { stopped++; } } as never;
  motions.notShown();
  assert.equal(stopped, 1);
  motions.clips = { moving: false, behavior: null, stopAll: () => { stopped++; } } as never;
  motions.notShown();
  assert.equal(stopped, 1, 'nothing playing: nothing to stop');
});

test('the action player gets no grant table here: the figure solves the grants after it (no child turns twice)', () => {
  const mesh = { skeleton: { bones: [] }, geometry: { userData: { MMD: { grants: [{ index: 1, parentIndex: 0, ratio: 1, affectRotation: true, isLocal: false }] } } } };
  const view = withoutGrants(mesh as never) as unknown as typeof mesh;
  assert.equal(view.skeleton, mesh.skeleton);
  assert.equal((view.geometry.userData as { MMD?: unknown }).MMD, undefined);
});

test('the figure overlay: the sleep body first, then a pose reaction (either may be absent)', () => {
  const order: string[] = [];
  const sleep = () => { order.push('sleep'); }, reaction = () => { order.push('reaction'); };
  assert.equal(withReaction(null, null), null);
  assert.equal(withReaction(sleep, null), sleep);
  withReaction(null, reaction)!(() => {}, 0); withReaction(sleep, reaction)!(() => {}, 0);
  assert.deepEqual(order, ['reaction', 'sleep', 'reaction']);
});

const ALL: ShowCapabilities = { head: true, upperBody: true, eyes: true, lids: true, browUp: true, browSad: true, eyeWide: true, smileEyes: true, mouthSmile: true,
  mouthOpen: true, blush: true };
test('惊喜 / 害羞: what the model can show; procedural life off says why; a repeat while it holds keeps it; the shy reaction plays; it ends on its clock', () => {
  const reactions = new WindowReactions(), owner = {};
  const support = (recipe: 'surprise' | 'shy') => WindowReactions.support(recipe, ALL, true, 'off');
  assert.equal(reactions.playExpression('wave', 1, support, owner), null, 'only the two recipes');
  assert.equal(reactions.playExpression('surprise', 1, support, null)?.usable, true, 'no model: support only, nothing starts');
  assert.equal(reactions.showing, false);
  assert.equal(WindowReactions.support('shy', ALL, false, '开发者面板关着').usable, false, 'procedural life off: not usable');
  assert.equal(WindowReactions.support('shy', ALL, false, '开发者面板关着').reason, '开发者面板关着');
  assert.equal(WindowReactions.support('shy', null, true, 'x').usable, false, 'no model');
  assert.equal(reactions.playExpression('shy', 0.6, support, owner)?.usable, true);
  assert.equal(reactions.showing, true);
  const input = { owner: owner as never, pose: null, yawn: null, sleepCue: () => null, gates: null, game: false, proxy: null, fullBody: true, cover: () => {}, nowMs: 0 };
  reactions.frame(1 / 60, input, null); const first = reactions.preview()!;
  assert.equal(first.clip, 'show:shy');
  for (let i = 0; i < 60; i++) reactions.frame(1 / 60, input, null);
  const held = reactions.preview()!.elapsedMs;
  reactions.playExpression('shy', 1, support, owner);
  assert.ok(reactions.preview()!.elapsedMs >= held && reactions.preview()!.strength === 1, 'kept going, at the higher strength');
  assert.equal(reactions.playReaction({ kind: 'shy', level: 'mid', id: 'r1' }, support, owner), reactions.playReaction({ kind: 'shy', level: 'mid', id: 'r1' }, support, owner));
  for (let i = 0; i < 60 * 8; i++) { reactions.frame(1 / 60, input, null); reactions.preview(); }
  assert.equal(reactions.showing, false, 'over on its own clock');
});

test('row 34: her own drowsy yawn (the sleep body\'s cue, batch 3 dropped it) and 哈欠捂嘴\'s yawn reach the pose reactions; nothing while she sleeps or you are here', () => {
  const free = { expressive: true, engaged: false, bodyOwned: false, asleep: false, posture: 50 };
  const run = (gates: typeof free, cues: { sleep?: boolean; yawn?: boolean }) => {
    const reactions = new WindowReactions(), owner = {};
    let reacted = false, nowMs = 10_000;
    const sleepCue = (base: unknown, at: number) => cues.sleep && at < 10_500 ? { attention: 0, boost: 1, cue: { id: 'sleep-yawn-1', kind: 'yawn', source: 'own', at: 10_000, strength: 1 } } : base;
    for (let i = 0; i < 120; i++) {
      nowMs += 1000 / 60;
      reactions.frame(1 / 60, { owner: owner as never, pose: null, yawn: cues.yawn ? { id: 'yawn-a1', at: 10_000 } : null, sleepCue, gates, game: false, proxy: null, fullBody: true,
        cover: () => {}, nowMs }, null);
      reacted ||= reactions.reacting;
    }
    return reacted;
  };
  assert.equal(run(free, {}), false, 'no cue, no pose sensing: nothing');
  assert.equal(run(free, { sleep: true }), true, 'her drowsy yawn plays');
  assert.equal(run(free, { yawn: true }), true, '哈欠捂嘴: the yawn with the hand');
  assert.equal(run({ ...free, asleep: true }, { sleep: true }), false, 'asleep: not started');
  assert.equal(run({ ...free, engaged: true }, { sleep: true }), false, 'you are here (typing, a touch, a reply): not started');
});

// ---- the real Gene: one long scene through the code the stage runs ----------------------------------------------------------------

/** Her upper body and arms (the old stage harness's tracked bones), so both engines are measured on the same bones. */
const MEASURED = [...TRACKED_BONES];

interface Ctx {
  env: WindowMotionEnv; view: ReturnType<typeof faceView>; motions: WindowMotions; reactions: WindowReactions; now: () => number; owner: object;
  play(action: HerActionId): Promise<void>;
}

async function windowMotionsRun(fps: number, seconds: number, script: (t: number, c: Ctx) => void) {
  // The host's bytes, read from the bundle (the host serves the same over mmd-asset://). Batch 6: every read is slowed on purpose and each
  // frame waits until what it started has landed (helpers/settled-vmd.ts), so the scene runs the same however fast the disk is.
  const bytes = settledVmdBytes(url => {
    const match = /^mmd-asset:\/\/([abd])[abd]{31}\/(.+)\.vmd$/.exec(url), pack = match ? { a: BEHAVIOR_RECIPES['idle.neutral'].packId, b: 'genea-2022-gestures', d: HER_ACTION_PACK }[match[1] as 'a' | 'b' | 'd'] : '';
    return match ? catalogMotionFile(pack, match[2]) : new URL(url);
  }, { delayMs: SLOW_READ_MS });
  const g = await windowGene();
  let clock = 1_000_000;
  const now = () => clock;
  const outcomes: HerActionOutcome[] = [];
  const actionCues = new Map<string, HerActionCue>();
  const host: WindowStageHost = recordingHost({
    resolveChatGesture: async cueId => {
      const entry = catalog.packs.find(p => p.id === 'genea-2022-gestures')!.motions.find(m => m.id === 'speaking-gesture-2')!;
      return { cueId, intent: 'explain', packId: 'genea-2022-gestures', motionId: 'speaking-gesture-2', sha256: entry.sha256, durationMs: entry.durationFrames / 30 * 1000,
        url: `mmd-asset://${'b'.repeat(32)}/speaking-gesture-2.vmd` };
    },
    resolveHerAction: async cueId => {
      const live = actionCues.get(cueId)!;
      return { cueId, action: live.action, packId: HER_ACTION_PACK, motionId: live.action, sha256: HER_ACTION_SPECS[live.action].sha256,
        durationMs: HER_ACTION_SPECS[live.action].durationFrames / 30 * 1000, url: `mmd-asset://${'d'.repeat(32)}/${live.action}.vmd` };
    },
    reportHerAction: async outcome => { outcomes.push(outcome); },
    // The host answers an observation with the plan it has now (the one it pushed with the view).
    getBehaviorBodyPlan: async () => c.view.body ?? ({ mode: 'closed', reason: 'normal-pool-closed', cue: null } as BodyMotionPlan),
    resolveBehaviorBody: async cueId => {
      const recipe = BEHAVIOR_RECIPES['idle.neutral'];
      return { cueId, recipeId: 'idle.neutral', packId: recipe.packId, motionId: recipe.motionId, sha256: recipe.sha256, maskId: recipe.mask, durationMs: recipe.durationMs,
        url: `mmd-asset://${'a'.repeat(32)}/${recipe.motionId}.vmd` } as never;
    },
  });
  const mesh = g.fixture.mesh, profile = new StageModelProfile(mesh, { reviewed: true });
  g.figure.setClips({ pose: await standClip(mesh), gesture: null, expression: null }, false); // the bundled card's default stand
  const rig = windowFaceRig(mesh, profile, true, g.figure.head);
  const face = new WindowFace(); face.attach(rig); g.body.bindFace(slotBindings(rig, face.blushMorph()));
  face.setCard(card(['closeEyes', 'blush', 'mouth', 'drowsyFace']));
  const lively = new WindowLiveliness(() => {}, () => 0.5), scene = new Scene();
  scene.add(mesh);
  const lib = await loadLivelinessForEngine(); lively.life.load(lib); lively.sleep.load(lib);
  lively.sleep.attach({ mesh, profile, baseY: 0, hasNeck: true });
  const view = faceView({ primary: 'calm', companion: null });
  const motions = new WindowMotions(host, () => c.env, now), reactions = new WindowReactions();
  const play = (action: HerActionId) => {
    const cue: HerActionCue = { id: `w5${action.replace(/[^a-z]/g, '')}${Math.round(clock)}`, action, at: now(), expiresAt: now() + HER_ACTION_CUE_MS };
    actionCues.set(cue.id, cue); return motions.playHerAction(cue);
  };
  const c: Ctx = { view, env: { ...baseEnv(), view }, motions, reactions, now, owner: mesh, play };
  motions.attach({ figure: g.figure, mesh, reviewed: true, retarget: null, transform: undefined, profile, standard: false });
  motions.setMood(view);
  const bones = MEASURED.map(name => mesh.skeleton.bones.find(b => b.name === name)!);
  const frames: Quaternion[][] = [], log: string[] = [], states: { chat: boolean; action: boolean; body: boolean; bridge: boolean; reaction: boolean; face: boolean }[] = [];
  try {
    for (let i = 0; i <= Math.round(fps * seconds); i++) {
      const t = i / fps, dt = i ? 1 / fps : 0;
      clock += dt * 1000;
      script(t, c);
      c.env.view = c.view;
      face.setMood(c.view);
      motions.frame();
      const goals = lively.frame(dt, g.body, face, { view: c.view, rig, env: { shown: true, adjusting: false, voiced: false, speaking: false, armsHeld: false },
        pointer: { x: 0.2, y: 0.05 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: c.env.pat, breath: 0.5, pulled: false, handHeld: false, adjusting: false, thinking: false,
        camera: g.camera, lift: g.figure.floorUnits, width: WINDOW.width, height: WINDOW.height, scene,
        reactions: { activity: (base, sleepCue) => reactions.frame(dt, { owner: mesh, pose: c.view.pose ?? null, yawn: motions.yawnCue, sleepCue, gates: motions.lifeGates(c.env),
          game: false, proxy: null, fullBody: true, cover: cue => { log.push(`cover ${cue.id}`); }, nowMs: now() }, base),
          show: reactions.preview(), showBlocked: c.env.pat, overlay: reactions.overlay() } });
      c.env.lidsHeld = goals.lids; c.env.showing = reactions.showing; c.env.reacting = reactions.reacting;
      motions.afterBody(dt);
      mesh.updateMatrixWorld(true);
      frames.push(bones.map(b => b.getWorldQuaternion(new Quaternion())));
      const clips = motions.clips!;
      states.push({ chat: clips.chat.getState().active, action: clips.action.active, body: clips.bodyTracks().length > 0, bridge: clips.bridging, reaction: reactions.reacting, face: motions.faceActive });
      // The host's grants and the VMD bytes are real asynchronous steps: they land between frames, never a frame late (batch 6).
      await bytes.settle();
    }
  } finally { bytes.restore(); motions.dispose(); g.close(); }
  const span = (from: number, to: number) => frames.slice(Math.round(from * fps), Math.round(to * fps) + 1);
  const row = (from: number, to: number) => ({ step: +max(frameSteps(span(from, to))).toFixed(3), surprise: +max(surprises(span(from, to)).perFrame).toFixed(3) });
  const during = (from: number, to: number) => states.slice(Math.round(from * fps), Math.round(to * fps) + 1);
  return { frames, row, span, outcomes, log, during };
}

/**
 * The scene's timeline (s): idle; a chat gesture handed back by typing; a wave to its end; a nod; a goodbye wave cut by a pat; an automatic body
 * motion cut by typing; you wave at her (pose sensing on); 惊喜; 害羞 (the reaction cue).
 */
const T = { gesture: 2, typing: 4, typingOff: 5, wave: 6, nod: 11, wave2: 13, pat: 14.5, patOff: 15.5, body: 17, bodyTyping: 20, bodyTypingOff: 21,
  poseWave: 23, surprise: 29, shy: 32, wink: 35.5, end: 37 } as const;

function scene(): (t: number, c: Ctx) => void {
  const done = new Set<string>();
  const at = (key: keyof typeof T, t: number) => { if (t >= T[key] && !done.has(key)) { done.add(key); return true; } return false; };
  const support = (recipe: 'surprise' | 'shy') => WindowReactions.support(recipe, ALL, true, '');
  return (t, c) => {
    if (at('gesture', t)) { c.view = { ...c.view, gesture: { id: 'w5g', at: c.now(), expiresAt: c.now() + 60_000, intent: 'explain', strength: 0.55, reason: 'test' } }; c.env.view = c.view; c.motions.setMood(c.view); }
    if (at('typing', t)) { c.env.typing = true; c.motions.gatesChanged(true, true); }
    if (at('typingOff', t)) { c.env.typing = false; c.view = { ...c.view, gesture: null }; c.env.view = c.view; c.motions.setMood(c.view); c.motions.gatesChanged(false, false); }
    if (at('wave', t)) void c.play('hello-wave');
    if (at('nod', t)) void c.play('nod');
    if (at('wave2', t)) void c.play('goodbye-wave');
    if (at('pat', t)) { c.env.pat = true; c.motions.gatesChanged(true, true); }
    if (at('patOff', t)) { c.env.pat = false; c.motions.gatesChanged(false, false); }
    if (at('body', t)) {
      const recipe = BEHAVIOR_RECIPES['idle.neutral'];
      const cue: BodyMotionCue = { id: 'w5body', token: c.view.token, recipeId: 'idle.neutral', at: c.now(), expiresAt: c.now() + recipe.durationMs + BODY_START_AGE_MS,
        durationMs: recipe.durationMs, strength: 0.3 };
      c.view = { ...c.view, body: { mode: 'idle-scheduler', reason: 'idle-issued', observationEpoch: 'w5-epoch', cue } as BodyMotionPlan }; c.env.view = c.view; c.motions.setMood(c.view);
    }
    if (at('bodyTyping', t)) { c.env.typing = true; c.motions.gatesChanged(true, true); }
    if (at('bodyTypingOff', t)) { c.env.typing = false; c.view = { ...c.view, body: undefined }; c.env.view = c.view; c.motions.setMood(c.view); c.motions.gatesChanged(false, false); }
    if (at('poseWave', t)) c.view = { ...c.view, pose: { attention: 0.5, boost: 1.5, cue: { id: 'w5wave', kind: 'wave', source: 'follow', at: c.now(), strength: 1 } } as never };
    if (at('surprise', t)) assert.equal(c.reactions.playExpression('surprise', 1, support, c.owner)?.usable, true);
    if (at('shy', t)) assert.equal(c.reactions.playReaction({ kind: 'shy', level: 'mid', id: 'w5shy' }, support, c.owner), 'played');
    if (at('wink', t)) void c.play('wink'); // a face shape (T-215), through the face exclusive over every other face writer
  };
}

/**
 * The deleted old stage's unexpected steps (degrees) for the same motions, as measured on its real frame loop when the window engine was ported
 * (docs/claude/2026-11-20-unbound-window-batch5.md, the numbers in brackets). The old stage is gone (I-176 step 3); these stay as the reference.
 */
const OLD_STAGE_SURPRISE = {
  60: { gesture: 0.185, wave: 0.387, nod: 0.554, patCut: 0.392, body: 0.354, bodyCut: 0.043 },
  30: { gesture: 0.678, wave: 1.411, nod: 1.969, patCut: 1.235, body: 1.207, bodyCut: 0.171 },
} as const;

for (const fps of [60, 30] as const) {
  test(`Gene, ${fps} fps: her own motions on the window engine, every hand-over eased, the user first`, { timeout: 900_000 }, async () => {
    const r = await windowMotionsRun(fps, T.end, scene());
    const rows = {
      idle: r.row(0.5, T.gesture), gesture: r.row(T.gesture, T.typing + 1.5), wave: r.row(T.wave, T.nod), nod: r.row(T.nod, T.wave2),
      patCut: r.row(T.pat - 0.5, T.pat + 1.5), body: r.row(T.body, T.bodyTyping), bodyCut: r.row(T.bodyTyping - 0.3, T.bodyTyping + 1.5),
      poseWave: r.row(T.poseWave, T.surprise), show: r.row(T.surprise, T.end),
    };
    const spans = (key: 'chat' | 'action' | 'body' | 'bridge' | 'reaction') => {
      const all = r.during(0, T.end), out: string[] = [];
      for (let i = 0; i < all.length; i++) if (all[i][key] && !all[i - 1]?.[key]) { let j = i; while (all[j + 1]?.[key]) j++; out.push(`${(i / fps).toFixed(2)}-${(j / fps).toFixed(2)}`); }
      return out.join(' ');
    };
    if (REPORT) console.log(JSON.stringify({ fps, window: rows, outcomes: r.outcomes.map(o => `${o.status}${o.detail ? ':' + o.detail : ''}`), log: r.log,
      spans: { chat: spans('chat'), action: spans('action'), body: spans('body'), bridge: spans('bridge'), reaction: spans('reaction') } }));
    // Each one played and said so; each was really there.
    assert.deepEqual(r.outcomes.map(o => o.status), ['played', 'played', 'played', 'played'], `each action answered "played": ${JSON.stringify(r.outcomes)}`);
    assert.ok(r.during(T.wink + 0.2, T.wink + 0.4).every(s => s.face), 'the wink holds her lids for its short while');
    assert.ok(r.during(T.gesture + 0.5, T.typing - 0.05).every(s => s.chat), 'the chat gesture plays');
    assert.ok(r.during(T.typing + 0.05, T.typing + 0.2).every(s => !s.chat && s.bridge), 'typing: the gesture ends, the bridge carries what it showed');
    assert.ok(r.during(T.wave + 0.5, T.wave + 3).every(s => s.action), 'the wave plays');
    assert.ok(r.during(T.pat + 1.2, T.patOff).every(s => !s.action), 'a pat: the goodbye wave gave way');
    assert.ok(r.during(T.body + 0.5, T.bodyTyping - 0.05).every(s => s.body), 'the automatic body motion plays');
    assert.ok(r.during(T.bodyTyping + 0.05, T.bodyTyping + 0.2).every(s => !s.body && s.bridge), 'typing: it ends, handed back through the bridge');
    assert.ok(r.during(T.poseWave + 0.5, T.poseWave + 2).every(s => s.reaction), 'you waved: she waves back');
    // R29: no hand-over is a jump. The unexpected step stays within the motion's own on the old stage (recorded) and her idle, with room for the
    // engine's livelier idle (batch 4: Unbound's learned idle is livelier than the old stand).
    const ownIdle = rows.idle.surprise;
    const limit = (name: keyof typeof rows) => Math.max(fps === 60 ? 0.6 : 1.4, (OLD_STAGE_SURPRISE[fps][name as keyof (typeof OLD_STAGE_SURPRISE)[60]] ?? 0) * 1.25, ownIdle * 1.5);
    for (const name of ['gesture', 'wave', 'nod', 'patCut', 'body', 'bodyCut', 'poseWave', 'show'] as const)
      assert.ok(rows[name].surprise <= limit(name), `${name}: unexpected step ${rows[name].surprise}° ≤ ${limit(name).toFixed(3)}° (idle ${ownIdle})`);
  });
}
