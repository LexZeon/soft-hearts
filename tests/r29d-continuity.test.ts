/**
 * R29d (docs/claude/2026-11-02-R29b-continuity.md, "R29d"): the one-frame
 * changes R29c left, the X-089 review items and selected motions that do not
 * suit the current model, measured on the real Stage frame loop with the
 * bundled Gene (gene-stage-harness), at 60 and 30 fps.
 *
 * - Bones: the R29b surprise measure (a frame's step vs repeating the previous
 *   one) may not exceed 1.25x the reference's own largest, floor 0.15 deg at
 *   60 fps. The floor is an angular acceleration (0.15 deg per frame^2 at 60 fps
 *   = 540 deg/s^2), so at 30 fps it is 0.6 deg: the same smooth hand-off shows
 *   4x the per-frame change at half the frame rate. For a switch to another
 *   motion the reference is the larger of the motion before and the motion
 *   after (each has its own rhythm).
 * - "Caught": hand-offs the display guard had to absorb (a one-frame cut in the
 *   composed target). A bridge that covers a hand-off leaves nothing to catch.
 * R29_REPORT=1 prints the numbers recorded in the R29d section.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { BEHAVIOR_RECIPES } from '../shared/behavior-recipes';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot } from '../shared/mood';
import { EMPTY_CONTACT } from '../src/stage/mood-feedback';
import { StageMotionRetarget, type MotionFitEntry } from '../src/stage/motion-retarget';
import { EYELID_RELEASE_HOLD } from '../src/stage/channel-compositors';
import { dampCritical, damp } from '../src/stage/procedural';
import {
  between, catalogAsset, catalogSha, geneStage, measureHandoff, patContact, pointAtScalp, surprises, TRACKED_BONES,
  type BoneHandoff, type GeneStage, type GeneStageOptions, type HandoffScript, type ShownFrame,
} from './helpers/gene-stage-harness';

const FLOOR = 0.15;
const floorAt = (fps: number) => FLOOR * (60 / fps) ** 2;
const REPORT = !!process.env.R29_REPORT;
const f3 = (value: number) => value.toFixed(3);
const worst = (bones: BoneHandoff[], key: 'startSurprise' | 'endSurprise' = 'startSurprise', n = 3) =>
  [...bones].sort((a, b) => b[key] - a[key]).slice(0, n).map(v => `${v.bone} ${f3(v[key])} (source ${f3(v.sourceSurprise)})`).join(', ');
function noTeleport(bones: BoneHandoff[], label: string, reference: (bone: BoneHandoff) => number = bone => bone.sourceSurprise,
  ends: { start?: boolean; end?: boolean } = { start: true }, fps = 60): void {
  for (const bone of bones) {
    const limit = Math.max(reference(bone) * 1.25, floorAt(fps));
    if (ends.start) assert.ok(bone.startSurprise <= limit, `${label}: ${bone.bone} jumps at the start (${f3(bone.startSurprise)} > ${f3(limit)} deg)`);
    if (ends.end) assert.ok(bone.endSurprise <= limit, `${label}: ${bone.bone} jumps at the end (${f3(bone.endSurprise)} > ${f3(limit)} deg)`);
  }
}
/** Largest surprise per tracked bone in a window of one run (the "own rhythm" of whatever plays there). */
function ownSurprise(frames: readonly ShownFrame[], set: 'world' | 'derived' = 'world'): number[] {
  return surprises(frames, set).map(values => Math.max(0, ...values));
}

// ------------------------------------------------------------------ 1. X-089: base-source trust (real loop)

for (const fps of [60, 30]) {
  test(`R29d X-089: a backward seek of the playing dance is a hand-off the guard catches, not trusted playback (${fps} fps)`, async () => {
    const dance = catalogAsset('fnoji-dances', 'split-dance');
    const seek = (h: GeneStage) => { const action = h.stage.animation.getBehaviorBodyBindings().baseActions()[0]; action.time = Math.max(0, action.time - 0.5); };
    const m = await measureHandoff({ fps, stand: false }, { t0: 3, hold: 0.8, after: 0.5,
      // The real selected-layer path (loadMotions) puts the dance on the pose layer for both runs.
      prepare: h => h.stage.loadMotions({ pose: dance, gesture: null, expression: null }, false),
      start: seek, end: () => {} });
    if (REPORT) console.log(`[${fps} fps] dance seek -0.5 s: ${worst(m.bones)} | caught ${JSON.stringify(m.caughtAtStart)} | undisturbed caught ${m.caughtUndisturbed.jumps}`);
    assert.ok(m.caughtAtStart.jumps > 0, 'the seek is caught as a base hand-off');
    noTeleport(m.bones, `dance seek ${fps}`, undefined, undefined, fps);
  });
}

// ------------------------------------------------------------------ 2. X-089: a manual mouth beats lip-sync

/** The mouth (あ) shown over a span with a manual expression selected through the real loadMotions, speaking or not. */
async function mouthRun(expression: string | null, speaking: boolean, fps = 60, clearAt?: number) {
  const h = await geneStage({ fps });
  try {
    h.stage.nextBlink = Infinity;
    h.run(0.5);
    if (expression) await h.stage.loadMotions({ pose: catalogAsset('gene', 'stand'), gesture: null, expression: catalogAsset('gene', expression) }, false);
    if (speaking) h.stage.setSpeaking(true);
    const shown: number[] = [];
    const frames = Math.round(2.5 * fps);
    for (let i = 0; i < frames; i++) {
      if (clearAt !== undefined && i === Math.round(clearAt * fps)) await h.stage.loadMotions({ pose: catalogAsset('gene', 'stand'), gesture: null, expression: null }, false);
      h.tick(); shown.push(h.shown.at(-1)!.mouth);
    }
    return { shown, blocked: h.stage.moodMouthBlocked as boolean, faceBlocked: h.stage.moodFaceBlocked as boolean };
  } finally { h.close(); }
}

test('R29d X-089: a selected expression with mouth tracks owns the mouth; speech no longer lifts it to the lip-sync value', async () => {
  // annoyed-smile drives あ itself (up to 0.6); unexpected drives お and leaves あ to nobody.
  for (const expression of ['annoyed-smile', 'unexpected']) {
    const quiet = await mouthRun(expression, false), talking = await mouthRun(expression, true);
    assert.equal(talking.blocked, true, `${expression}: a mouth track was detected`);
    const settled = Math.round(0.6 * 60);
    const lift = Math.max(...talking.shown.slice(settled).map((value, i) => value - quiet.shown[settled + i]));
    if (REPORT) console.log(`manual mouth ${expression}: speech lifts the shown あ by at most ${lift.toFixed(4)} (quiet max ${Math.max(...quiet.shown).toFixed(3)}, talking max ${Math.max(...talking.shown).toFixed(3)})`);
    assert.ok(lift <= 1e-6, `${expression}: speech lifts the manual mouth by ${lift.toFixed(4)}`);
    const steps = talking.shown.slice(1).map((value, i) => Math.abs(value - talking.shown[i]));
    assert.ok(Math.max(...steps) <= 0.12, `${expression}: lip-sync hands the mouth over without a one-frame cut (${Math.max(...steps).toFixed(3)})`);
  }
});

test('R29d X-089: a selected eye/brow-only expression keeps lip-sync independent (no mouth track, nothing taken)', async () => {
  const plain = await mouthRun(null, true), eyes = await mouthRun('little-smile', true);
  assert.equal(eyes.faceBlocked, true); assert.equal(eyes.blocked, false);
  const gap = Math.max(...eyes.shown.map((value, i) => Math.abs(value - plain.shown[i])));
  assert.ok(Math.max(...plain.shown) > 0.3, 'lip-sync is shown');
  assert.ok(gap <= 1e-6, `the eye/brow expression leaves the lip-sync mouth unchanged (${gap})`);
});

test('R29d X-089: clearing the manual mouth while speaking hands the mouth back to lip-sync smoothly', async () => {
  const run = await mouthRun('unexpected', true, 60, 1);
  const from = Math.round(1 * 60), window = run.shown.slice(from - 1, from + 30);
  const steps = window.slice(1).map((value, i) => Math.abs(value - window[i]));
  if (REPORT) console.log(`manual mouth released while speaking: largest one-frame change ${Math.max(...steps).toFixed(3)}`);
  assert.ok(Math.max(...steps) <= 0.12, `no one-frame cut when lip-sync returns (${Math.max(...steps).toFixed(3)})`);
  assert.ok(Math.max(...run.shown.slice(from + 30)) > 0.3, 'lip-sync is back');
});

// ------------------------------------------------------------------ 3. X-089: eyelid hold is scoped

async function closedByPat(fps = 60) {
  const h = await geneStage({ fps }); // content (满足): a pat is enjoyed with gently closed eyes
  h.stage.nextBlink = Infinity;
  h.run(1);
  pointAtScalp(h);
  h.run(1.5, time => h.stage.setMoodContact(patContact(time)));
  return h;
}
const blinkShown = (h: GeneStage) => h.shown.at(-1)!.blink;
const view = (h: GeneStage, token: string) => ({ characterId: 'gene', token, revision: 1, developerMode: false, expressions: true,
  parameters: structuredClone(DEFAULT_MOOD_PARAMETERS), snapshot: { ...getMoodSnapshot(createMoodState(0)), primary: 'calm' }, gesture: null });

test('R29d X-089: an eyelid closure held for one scope does not come back in the next one (invalidated scope)', async () => {
  const h = await closedByPat();
  try {
    const closed = blinkShown(h);
    assert.ok(closed > 0.2, `the pat closes the lids (${closed})`);
    h.stage.invalidateMoodScope();
    h.run(0.3); // the stage shows the natural blink without a mood view
    const open = blinkShown(h);
    h.stage.setMood(view(h, 'next_token'));
    const after: number[] = [];
    h.run(0.5, () => after.push(h.shown.at(-1)!.blink));
    after.push(blinkShown(h));
    const reopened = Math.max(...after) - open;
    if (REPORT) console.log(`eyelid across an invalidated scope: closed ${closed.toFixed(3)}, open ${open.toFixed(3)}, largest after the new scope ${Math.max(...after).toFixed(3)}`);
    assert.ok(reopened <= 0.02, `the old closure is not shown again in the new scope (+${reopened.toFixed(3)})`);
  } finally { h.close(); }
});

test('R29d X-089: a context change releases the old closure from what is shown at once (no hold for the old scope), without a cut', async () => {
  const h = await closedByPat();
  try {
    const closed = blinkShown(h);
    h.stage.setMood(view(h, 'next_token')); // a new token: the contact and its request belong to the old context
    const shown: number[] = [closed];
    h.run(0.8, () => shown.push(h.shown.at(-1)!.blink));
    shown.push(blinkShown(h));
    const steps = shown.slice(1).map((value, i) => value - shown[i]);
    const holdFrames = Math.floor(EYELID_RELEASE_HOLD * 60) - 1;
    if (REPORT) console.log(`eyelid on a context change: closed ${closed.toFixed(3)}, after ${holdFrames} frames ${shown[holdFrames].toFixed(3)}, largest one-frame drop ${(-Math.min(...steps)).toFixed(3)}`);
    assert.ok(shown[holdFrames] < closed * 0.6, `the old scope's closure is not held (${shown[holdFrames].toFixed(3)} of ${closed.toFixed(3)})`);
    assert.ok(Math.max(...steps) <= 1e-9, 'it only opens');
    assert.ok(-Math.min(...steps) <= closed * 0.15, `no one-frame cut (${(-Math.min(...steps)).toFixed(3)})`);
    assert.ok(shown.at(-1)! < 0.02, 'open after the release');
  } finally { h.close(); }
});

// ------------------------------------------------------------------ 4. selected motions that do not suit the model

/** A real StageMotionRetarget on an unverified copy of Gene (identity plan, playback unchanged) whose check reports `unfit` as hidden. */
function unfitRetarget(target: GeneStage | GeneStage['stage'], unfit: Set<string>): StageMotionRetarget {
  const stage = 'stage' in target ? target.stage : target;
  // The same wiring as loadModel: the Stage hears every fit change.
  const retarget = new StageMotionRetarget(stage.mesh, stage.modelProfile.profile, { reviewed: false, onChange: value => stage.motionFitChanged(value) });
  const real = retarget.fitOf.bind(retarget);
  retarget.fitOf = (sha: string): MotionFitEntry | undefined => {
    const entry = real(sha);
    return unfit.has(sha) ? { ...(entry ?? { packId: '', motionId: '', name: '', issues: [], adjustments: [], basis: 'sampled' as const, samples: 0, lost: [] }), status: 'hidden' } : entry;
  };
  stage.motionRetarget = retarget;
  return retarget;
}

test('R29d fit: a selected layer that does not suit the model is held (kept selected, not played), with the existing wording', async () => {
  const h = await geneStage({ stand: false });
  try {
    const unfit = new Set([catalogSha('100style-idles', 'arms-folded-idle')]);
    unfitRetarget(h, unfit);
    h.run(1);
    await h.stage.loadMotions({ pose: catalogAsset('100style-idles', 'arms-folded-idle'), gesture: null, expression: catalogAsset('gene', 'smile') }, false);
    h.run(0.5);
    const times = h.stage.animation.getLayerTimes();
    assert.equal(times.pose, null, 'the unfit pose layer is not played');
    assert.notEqual(times.expression, null, 'the suitable expression layer still plays');
    assert.ok(h.statuses.includes('这个动作不适合当前模型'), `the hint reuses the existing wording: ${h.statuses.join(' / ')}`);
    assert.equal(h.stage.bodyManualPose, false, 'a held pose does not count as a selected manual pose on this model');
  } finally { h.close(); }
});

for (const fps of [60, 30]) {
  test(`R29d fit: a playing selected layer whose check turns unfit is handed back smoothly, and returns smoothly when it suits again (${fps} fps)`, async () => {
    const unfit = new Set<string>(), sha = catalogSha('100style-idles', 'arms-folded-idle');
    const playing: (number | null)[] = [];
    // Arms folded is the selected pose from the start (both runs); the check turns at t0 and back at t0 + hold.
    const m = await measureHandoff({ fps, layers: { pose: ARMS_FOLDED, gesture: null, expression: null }, beforeLayers: stage => unfitRetarget(stage, unfit) },
      { t0: 3, hold: 1.5, after: 1.6,
        start: h => { unfit.add(sha); h.stage.motionFitChanged(h.stage.motionRetarget.view()); playing.push(h.stage.animation.getLayerTimes().pose); },
        end: h => { unfit.clear(); h.stage.motionFitChanged(h.stage.motionRetarget.view()); },
        afterwards: h => { playing.push(h.stage.animation.getLayerTimes().pose); } });
    // The breathing idle it hands to, on its own: part of the reference for the start.
    const idle = await geneStage({ fps, stand: false });
    let own: number[] = [];
    try { idle.run(3); own = ownSurprise(between(idle.shown, 1, 3)); } finally { idle.close(); }
    if (REPORT) console.log(`[${fps} fps] fit turns unfit / suits again: ${worst(m.bones)} | end ${worst(m.bones, 'endSurprise')} | derived ${worst(m.derived)} | caught ${JSON.stringify(m.caughtAtStart)}`);
    assert.equal(playing[0], null, 'the unfit layer stops being played at once (ownership)');
    assert.notEqual(playing.at(-1), null, 'it plays again once it suits');
    assert.equal(m.caughtAtStart.jumps, 0, 'nothing left for the guard to catch (grant and IK bones are bridged too)');
    noTeleport(m.bones, `unfit ${fps}`, bone => Math.max(bone.sourceSurprise, own[TRACKED_BONES.indexOf(bone.bone as typeof TRACKED_BONES[number])]),
      { start: true, end: true }, fps);
    noTeleport(m.derived, `unfit ${fps} derived`, bone => bone.sourceSurprise, { start: true, end: true }, fps);
  });
}

// Face (behavior) motions: tests/stage-behavior-motion.test.ts (suits / recheck on the real player).
test('R29d fit: an automatic body motion is not started when its motion does not suit the model', async () => {
  const h = await geneStage({});
  try {
    const unfit = new Set([catalogSha('100style-idles', 'neutral-idle')]);
    unfitRetarget(h, unfit);
    const body = { cueId: 'c', recipeId: 'idle.neutral', packId: '100style-idles', motionId: 'neutral-idle', sha256: catalogSha('100style-idles', 'neutral-idle'),
      maskId: BEHAVIOR_RECIPES['idle.neutral'].mask, durationMs: BEHAVIOR_RECIPES['idle.neutral'].durationMs, url: catalogAsset('100style-idles', 'neutral-idle').url };
    await assert.rejects(h.stage.loadBodyMotionClip(body, h.mesh), /不适合当前模型/);
    unfit.clear();
    await assert.doesNotReject(h.stage.loadBodyMotionClip(body, h.mesh));
  } finally { h.close(); }
});

test('R29d fit: a playing automatic body motion whose check turns unfit is handed back smoothly (no snap)', async () => {
  const unfit = new Set<string>();
  const m = await measureHandoff({ body: { recipe: 'idle.neutral' } }, { t0: 2.5, hold: 1, after: 0.6,
    prepare: h => { unfitRetarget(h, unfit); },
    start: h => { unfit.add(catalogSha('100style-idles', 'neutral-idle')); h.stage.motionFitChanged(h.stage.motionRetarget.view()); assert.equal(h.stage.bodyMotion.getState().active, false); },
    end: () => {} });
  if (REPORT) console.log(`body motion turns unfit: ${worst(m.bones)} | caught ${JSON.stringify(m.caughtAtStart)}`);
  noTeleport(m.bones, 'body unfit');
  assert.equal(m.caughtAtStart.jumps, 0);
});

test('R29d fit: a playing chat gesture whose check turns unfit fades back to the base', async () => {
  const unfit = new Set<string>();
  const sha = catalogSha('genea-2022-gestures', 'speaking-gesture-2');
  const m = await measureHandoff({ chatGesture: { packId: 'genea-2022-gestures', motionId: 'speaking-gesture-2' } }, { t0: 3, hold: 1, after: 0.5,
    prepare: async h => { unfitRetarget(h, unfit); await playGesture(h); },
    start: h => { unfit.add(sha); h.stage.motionFitChanged(h.stage.motionRetarget.view()); assert.equal(h.stage.chatGesturePlayer.getState().active, false); },
    end: () => {} });
  noTeleport(m.bones, 'gesture unfit');
  assert.equal(m.caughtAtStart.jumps, 0);
});

// ------------------------------------------------------------------ 5. manual switch / clear: grant and IK bones

const ARMS_FOLDED = catalogAsset('100style-idles', 'arms-folded-idle');
for (const fps of [60, 30]) {
  for (const [label, layers] of [['stand -> arms folded', { pose: ARMS_FOLDED, gesture: null, expression: null }], ['clear the stand', { pose: null, gesture: null, expression: null }]] as const) {
    test(`R29d manual switch (${label}, ${fps} fps): the bridge covers grant and IK bones and is sized by the correction`, async () => {
      const t0 = 3;
      const m = await measureHandoff({ fps }, { t0, hold: 2, after: 0.5, start: h => h.stage.loadMotions(layers, false), end: () => {} });
      // The motion after the switch, on its own (from the end of the bridge): its rhythm is part of the reference.
      const after = await geneStage({ fps, stand: false, ...(layers.pose ? { layers } : {}) });
      let own: number[] = [], ownDerived: number[] = [];
      try {
        after.run(3);
        const late = between(after.shown, 1, 3); own = ownSurprise(late); ownDerived = ownSurprise(late, 'derived');
      } finally { after.close(); }
      if (REPORT) console.log(`[${fps} fps] manual ${label}: ${worst(m.bones)} | derived ${worst(m.derived)} | caught ${JSON.stringify(m.caughtAtStart)}`);
      assert.equal(m.caughtAtStart.jumps, 0, `nothing left for the guard to catch: ${m.caughtAtStart.properties.join(', ')}`);
      noTeleport(m.bones, `manual ${label}`, bone => Math.max(bone.sourceSurprise, own[TRACKED_BONES.indexOf(bone.bone as typeof TRACKED_BONES[number])]), undefined, fps);
      noTeleport(m.derived, `manual ${label} derived`, bone => Math.max(bone.sourceSurprise, ownDerived[m.derived.indexOf(bone)]), undefined, fps);
    });
  }
}

// ------------------------------------------------------------------ 6. chat gesture smooth cancel

async function playGesture(h: GeneStage): Promise<void> {
  const cue = { id: `g-${Math.random()}`, at: Date.now(), expiresAt: Date.now() + 60_000, intent: 'explain' as const, strength: 0.55, reason: 'test' };
  h.stage.moodView = { ...h.stage.moodView, gesture: cue };
  await h.stage.playChatGesture(cue, h.stage.moodView.token);
  assert.equal(h.stage.chatGesturePlayer.getState().active, true, `the gesture plays: ${h.stage.chatGestureError}`);
}
for (const fps of [60, 30]) {
  test(`R29d chat gesture: a smooth cancel (typing) hands back to the base; grant and IK bones are covered (${fps} fps)`, async () => {
    const m = await measureHandoff({ fps, chatGesture: { packId: 'genea-2022-gestures', motionId: 'speaking-gesture-2' } }, { t0: 3, hold: 1, after: 0.5,
      prepare: playGesture, start: h => h.stage.setTyping(true), end: h => h.stage.setTyping(false) });
    if (REPORT) console.log(`[${fps} fps] chat gesture cancelled by typing: ${worst(m.bones)} | derived ${worst(m.derived)} | caught ${JSON.stringify(m.caughtAtStart)}`);
    assert.equal(m.caughtAtStart.jumps, 0, `nothing left for the guard to catch: ${m.caughtAtStart.properties.join(', ')}`);
    noTeleport(m.bones, `chat cancel ${fps}`, undefined, undefined, fps);
    noTeleport(m.derived, `chat cancel ${fps} derived`, undefined, undefined, fps);
  });
}

// ------------------------------------------------------------------ 7. idle gaze saccades start from rest

for (const fps of [60, 30]) {
  test(`R29d gaze: idle saccades accelerate into the new target instead of starting at full speed (${fps} fps)`, async () => {
    const h = await geneStage({ fps });
    try {
      h.run(9);
      const frames = between(h.shown, 1, 9), own = ownSurprise(frames);
      const head = own[TRACKED_BONES.indexOf('頭')], neck = own[TRACKED_BONES.indexOf('首')];
      const body = Math.max(...own.filter((_, i) => TRACKED_BONES[i] !== '頭' && TRACKED_BONES[i] !== '首'));
      const saccades = JSON.parse(h.stage.renderer.domElement.dataset.proceduralLife ?? '{}')?.gaze?.saccades;
      if (REPORT) console.log(`[${fps} fps] standing 1-9 s: head ${f3(head)}, neck ${f3(neck)}, body ${f3(body)} | saccades ${saccades}`);
      // Breathing sets the body's own rhythm; the gaze on top of it should not add a kick of its own.
      assert.ok(head <= Math.max(body * 1.25, fps === 60 ? 0.1 : 0.15), `head ${f3(head)} vs body ${f3(body)}`);
    } finally { h.close(); }
  });
}

test('R29d gaze: the critically damped follow keeps the old reach and timing, starts from rest and never overshoots', () => {
  const omega = 10, dt = 1 / 60, velocity = { x: 0, y: 0 };
  let critical = 0, first = 0, reachCritical = 0, reachFirst = 0, peak = 0, firstStep = -1;
  for (let i = 1; i <= 120; i++) {
    const before = critical;
    critical = dampCritical(critical, 1, omega, dt, velocity, 'x');
    first = damp(first, 1, omega / 2, dt);
    if (firstStep < 0) firstStep = critical - before;
    peak = Math.max(peak, critical);
    if (!reachCritical && critical >= 0.9) reachCritical = i * dt;
    if (!reachFirst && first >= 0.9) reachFirst = i * dt;
  }
  assert.ok(firstStep < (1 - Math.exp(-5 * dt)) * 0.25, 'the first frame is a gentle start, not the full-speed step of first-order damping');
  assert.ok(peak <= 1 + 1e-9, 'no overshoot');
  assert.ok(Math.abs(critical - 1) < 1e-4, 'it reaches the target');
  assert.ok(Math.abs(reachCritical - reachFirst) <= 0.1, `90% at ${reachCritical.toFixed(2)} s vs ${reachFirst.toFixed(2)} s`);
  // Following a steadily moving pointer keeps the same lag as before (2 / omega = 1 / speed).
  let a = 0, b = 0; const v2 = { x: 0, y: 0 };
  for (let i = 1; i <= 300; i++) { const target = i * dt * 0.5; a = dampCritical(a, target, omega, dt, v2, 'y'); b = damp(b, target, omega / 2, dt); }
  assert.ok(Math.abs(a - b) < 0.01, `ramp lag ${(300 * dt * 0.5 - a).toFixed(3)} vs ${(300 * dt * 0.5 - b).toFixed(3)}`);
});
