/**
 * R29b with the music rhythm on, and
 * "在聊天框开始输入时也会直接定住". Scenario tests on the real Stage frame loop
 * with the bundled Gene, its Stand VMD and the music dance (gene-stage-harness).
 *
 * Measures, per tracked bone (world rotation as displayed):
 * - surprise: how far one frame's step departs from repeating the previous
 *   step. A teleport, a dead stop or a start at full speed is one large value.
 *   A hand-off may not exceed the undisturbed run's own largest surprise by
 *   more than 25%, with a floor of 0.15 deg at 60 fps (the user-confirmed R15
 *   music-off exit itself reaches 0.33 deg on the head in this harness).
 * - held travel: total motion while the gate/event holds vs the undisturbed
 *   run in the same seconds. "Frozen" is the base still moving in the
 *   undisturbed run while the gated run barely moves.
 * Before numbers (main 5e269aa) are in docs/claude/2026-11-02-R29b-continuity.md.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_CONTACT, MoodFeedback, PAT_HOLD } from '../src/stage/mood-feedback';
import { MUSIC_RETURN_SECONDS, MUSIC_YIELD_SECONDS, MusicDance, type MusicEnergySample } from '../src/stage/music-dance';
import { applyBehaviorGates } from '../src/stage/behavior-gates';
import { geneStage, measureHandoff, patContact, pointAtScalp, type BoneHandoff, type GeneStage } from './helpers/gene-stage-harness';

const FLOOR = 0.15;
function noTeleport(bones: BoneHandoff[], label: string): void {
  for (const bone of bones) {
    const limit = Math.max(bone.sourceSurprise * 1.25, FLOOR);
    assert.ok(bone.startSurprise <= limit, `${label}: ${bone.bone} jumps at the start (${bone.startSurprise.toFixed(3)} > ${limit.toFixed(3)} deg)`);
    assert.ok(bone.endSurprise <= limit, `${label}: ${bone.bone} jumps at the end (${bone.endSurprise.toFixed(3)} > ${limit.toFixed(3)} deg)`);
  }
}
const bone = (bones: BoneHandoff[], name: string) => bones.find(value => value.bone === name)!;
/** R29_REPORT=1 prints the numbers recorded in docs/claude/2026-11-02-R29b-continuity.md. */
function report(label: string, bones: BoneHandoff[]): void {
  if (!process.env.R29_REPORT) return;
  const pick = ['センター', '上半身', '首', '頭'].map(name => bone(bones, name)), f = (value: number) => value.toFixed(3);
  console.log(`${label}\n${pick.map(v => `  ${v.bone} surprise ${f(v.startSurprise)}/${f(v.endSurprise)} (source ${f(v.sourceSurprise)}) step ${f(v.handoffStep)} (p95 ${f(v.sourceStep)}) held ${v.heldTravel.toFixed(2)}/${v.sourceTravel.toFixed(2)}`).join('\n')}`);
}
const gates = (composing: boolean) => ({ cameraEditing: false, composing, windowInteraction: false, clickThrough: false, preview: false });
const pat = {
  prepare: pointAtScalp,
  start: (h: GeneStage) => h.stage.setMoodContact(patContact(0)),
  during: (h: GeneStage, time: number) => h.stage.setMoodContact(patContact(time)),
  end: (h: GeneStage) => h.stage.setMoodContact({ ...EMPTY_CONTACT }),
};
// The chat box is focused first (both runs); the first IME keystroke fires compositionstart.
const typing = {
  prepare: (h: GeneStage) => h.stage.setBodyInputBlocked(true),
  start: (h: GeneStage) => { h.stage.setMoodContact({ ...EMPTY_CONTACT }); applyBehaviorGates(h.stage, gates(true)); },
  end: (h: GeneStage) => applyBehaviorGates(h.stage, gates(false)),
};

test('R29b a: a head pat mid-dance hands over from the shown pose and gives the dance back at its running phase', async () => {
  const levels: number[] = [], presence: number[] = [], reasons = new Set<string | null>();
  // t0 3.6 s: the nod is moving; on main the pat removed it in one frame (head 1.62 deg surprise, 1.38 deg step).
  const m = await measureHandoff({ music: true }, { t0: 3.6, hold: 1.5, after: 1.5, ...pat,
    during: (h, time) => { pat.during(h, time); levels.push(h.stage.musicDance.getState().level); reasons.add(h.stage.musicBlockReason); },
    afterwards: h => presence.push(h.stage.musicDance.getState().presence) });
  report('music + pat', m.bones);
  noTeleport(m.bones, 'music + pat');
  assert.deepEqual([...reasons], ['direct-interaction'], 'the pat still owns the presentation (priority unchanged)');
  assert.ok(levels.at(-1)! >= levels[0] * 0.95 && levels[0] > 0.05,
    `the dance keeps running underneath the pat (level ${levels[0].toFixed(3)} -> ${levels.at(-1)!.toFixed(3)})`);
  assert.ok(presence[0] < 0.05 && presence.at(-1) === 1, 'after the pat the dance comes back in, from nothing shown to fully shown');
  assert.equal(m.guard.jumps, 0, 'the display bridge had nothing to catch');
  const head = bone(m.bones, '頭');
  assert.ok(head.handoffStep <= head.sourceStep * 1.5, `no head step far above the dance's own speed (${head.handoffStep.toFixed(3)} vs p95 ${head.sourceStep.toFixed(3)})`);
});

test('R29b b: typing with the music on keeps her dancing; nothing jumps or freezes', async () => {
  const reasons = new Set<string | null>();
  const m = await measureHandoff({ music: true }, { t0: 3.6, hold: 2, ...typing, during: h => reasons.add(h.stage.musicBlockReason) });
  report('music + typing', m.bones);
  noTeleport(m.bones, 'music + typing');
  assert.deepEqual([...reasons], [null], 'typing does not take the music over');
  for (const name of ['センター', '上半身', '首', '頭']) {
    const value = bone(m.bones, name);
    assert.ok(value.heldTravel >= value.sourceTravel * 0.8,
      `${name} keeps moving while typing (${value.heldTravel.toFixed(2)} vs ${value.sourceTravel.toFixed(2)} deg undisturbed)`);
  }
});

test('R29b c: typing in plain idle keeps the idle life running (no adjust-mode yield)', async () => {
  const yields = new Set<string>();
  const m = await measureHandoff({ music: false }, { t0: 3.6, hold: 2, ...typing, during: h => {
    const state = h.stage.life.getState().primitives;
    for (const primitive of [state.gaze, state.tilt, state.sway]) for (const reason of primitive.yielding) yields.add(reason);
  } });
  report('idle + typing', m.bones);
  noTeleport(m.bones, 'idle + typing');
  assert.ok(!yields.has('adjusting'), `idle life does not treat typing as window/camera adjusting (${[...yields].join(',')})`);
  for (const name of ['上半身', '頭']) {
    const value = bone(m.bones, name);
    assert.ok(value.heldTravel >= value.sourceTravel * 0.9, `${name} keeps its idle motion (${value.heldTravel.toFixed(2)} vs ${value.sourceTravel.toFixed(2)})`);
  }
});

test('R29b d (control): a head pat in plain idle starts and ends without a jump', async () => {
  const m = await measureHandoff({ music: false }, { t0: 3.6, hold: 1.5, ...pat });
  report('idle + pat', m.bones);
  noTeleport(m.bones, 'idle + pat');
  assert.ok(bone(m.bones, '頭').heldTravel > bone(m.bones, '頭').sourceTravel, 'the pat really moves the head');
});

test('R29b: strokes that briefly leave the scalp keep the music yielded (one pat envelope)', async () => {
  const h = await geneStage({ music: true });
  try {
    h.run(3);
    pointAtScalp(h);
    const reasons: (string | null)[] = [];
    // 0.6 s pat, a 0.2 s stroke overshoot (< PAT_HOLD), 0.6 s pat, then a real exit.
    h.run(0.6, time => { h.stage.setMoodContact(patContact(time)); reasons.push(h.stage.musicBlockReason); });
    h.run(0.2, () => { h.stage.setMoodContact({ ...EMPTY_CONTACT }); reasons.push(h.stage.musicBlockReason); });
    h.run(0.6, time => { h.stage.setMoodContact(patContact(time)); reasons.push(h.stage.musicBlockReason); });
    assert.ok(reasons.every(reason => reason === 'direct-interaction'), 'the dance never starts coming back mid-pat');
    h.stage.setMoodContact({ ...EMPTY_CONTACT });
    h.run(PAT_HOLD + 0.1);
    assert.equal(h.stage.musicBlockReason, null, 'a real exit gives the music back after the pat hold');
  } finally { h.close(); }
});

// --------------------------------------------------------------- music-dance presence (module level)

const song = (frame: number): MusicEnergySample => {
  const kick = frame % 15 === 0;
  return { time: frame / 30, rms: kick ? 0.4 : 0.14, low: kick ? 0.8 : 0.1, mid: 0.2 + Math.sin(frame / 20) * 0.1, high: 0.1 };
};
const dancing = () => {
  const dance = new MusicDance();
  let frame = 0;
  for (; frame < 90; frame++) { dance.update(song(frame)); dance.frame(1 / 30, 0.7); }
  return { dance, next: () => frame++ };
};

test('R29b music presence: yielding eases out from the shown share with zero speed at the edge, keeping level and phase', () => {
  const { dance, next } = dancing();
  const before = dance.frame(1 / 60, 0.7), level = dance.getState().level;
  dance.setSuppressed(true);
  const first = dance.frame(1 / 60, 0.7);
  assert.ok(dance.getState().presence > 0.995, 'the first yielding frame shows (almost) the whole dance: no kick');
  assert.ok(Math.abs(first.headPitch - before.headPitch) < 0.01);
  const shares: number[] = [];
  for (let i = 0; i < Math.ceil(MUSIC_YIELD_SECONDS * 60); i++) {
    assert.deepEqual(dance.update(song(next())), { active: false, pulse: false, strength: 0 }, 'yielding rejects input');
    dance.frame(1 / 60, 0.7); shares.push(dance.getState().presence);
  }
  assert.ok(shares.every((value, i) => i === 0 || value <= shares[i - 1]), 'monotone hand-over');
  assert.equal(shares.at(-1), 0);
  assert.deepEqual(dance.frame(1 / 60, 0.7), { sway: 0, bounce: 0, chestRoll: 0, headRoll: 0, headPitch: 0 }, 'fully yielded shows exactly nothing');
  assert.ok(Math.abs(dance.getState().level - level) < 1e-9, 'the level is held underneath, not reset');
});

test('R29b music presence: the return waits for fresh audible music and eases in from what is shown; a quick flicker stays continuous', () => {
  const { dance, next } = dancing();
  dance.setSuppressed(true);
  for (let i = 0; i < 6; i++) dance.frame(1 / 60, 0.7);
  const mid = dance.getState().presence;
  assert.ok(mid > 0.5 && mid < 1);
  dance.setSuppressed(false);
  for (let i = 0; i < 10; i++) dance.frame(1 / 60, 0.7);
  assert.equal(dance.getState().presence, mid, 'no fresh audible input yet: hold, do not bring back an old dance');
  dance.update({ time: 100, rms: 0, low: 0, mid: 0, high: 0 }); dance.frame(1 / 60, 0.7);
  assert.equal(dance.getState().presence, mid, 'silence is not something to come back to');
  const fresh = dance.update(song(next() + 3000));
  assert.equal(fresh.pulse, true, 'fresh input gets a fresh onset, with no old timing or backlog');
  let previous = mid;
  for (let i = 0; i < Math.ceil(MUSIC_RETURN_SECONDS * 60) + 2; i++) {
    if (i % 2 === 0) dance.update(song(next() + 3000));
    dance.frame(1 / 60, 0.7);
    const share = dance.getState().presence;
    assert.ok(share >= previous && share - previous < 0.06, 'eases in from the shown share');
    previous = share;
  }
  assert.equal(dance.getState().presence, 1);
  dance.setSuppressed(true); dance.frame(1 / 60, 0.7);
  assert.ok(dance.getState().presence > 0.99, 'yielding again right away continues from the shown share');
});

test('R29b: the pat envelope reports its hold, so owners that yield to contact keep yielding through a brief exit', () => {
  const feedback = new MoodFeedback();
  const state = { mood: '满足', phase: 'idle', expressive: true, face: 50, posture: 50, playful: 50, responding: false };
  feedback.frame(1 / 60, { ...EMPTY_CONTACT, contact: true, hover: 1 }, state);
  assert.ok(feedback.attentionWeight > 0 && feedback.attentionWeight < 0.1);
  assert.equal(feedback.patHolding, true);
  for (let i = 0; i < Math.ceil(PAT_HOLD * 60) + 1; i++) feedback.frame(1 / 60, EMPTY_CONTACT, state);
  assert.equal(feedback.patHolding, false);
});

test('R29b gates: typing pauses only new behaviour; window, camera and previews still block; click-through does not', () => {
  const calls: string[] = [];
  const stage = { setBehaviorBlocked: (value: boolean) => calls.push(`blocked:${value}`), setTyping: (value: boolean) => calls.push(`typing:${value}`) };
  applyBehaviorGates(stage, gates(true));
  assert.deepEqual(calls, ['blocked:false', 'typing:true']);
  calls.length = 0;
  applyBehaviorGates(stage, { ...gates(false), clickThrough: true });
  assert.deepEqual(calls, ['blocked:false', 'typing:false'], 'click-through keeps her moving');
  for (const key of ['cameraEditing', 'windowInteraction', 'preview'] as const) {
    calls.length = 0;
    applyBehaviorGates(stage, { ...gates(false), [key]: true });
    assert.deepEqual(calls, ['blocked:true', 'typing:false'], key);
  }
  assert.doesNotThrow(() => applyBehaviorGates(undefined, gates(true)));
});
