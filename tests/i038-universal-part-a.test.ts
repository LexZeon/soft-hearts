/**
 * I-038 part A (docs/claude/2026-11-06-i038-universal-part-a.md): three presentations that only the reviewed Gene had, now on
 * any model through the universal skeleton — the mood's body motions, 害羞 / 惊喜 as whole performances (with the reaction
 * system's strength), and the personal pose and brow/eye picks. Measured on Gene, a renamed Gene and Gene-derived bodies
 * (tests/helpers/body-variants.ts, hand-variants.ts; gene-stage-harness restEditSkin / renameBones). Gene's own data only: no
 * other model, nothing of the user's, no PMX or VMD bytes written.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { BEHAVIOR_RECIPES } from '../shared/behavior-recipes';
import type { BodyRecipeId } from '../shared/body-motion';
import { bodyPoseBinding } from '../shared/personalize-body-bindings';
import { VISUAL_GENE_SHA } from '../shared/personalize-visual';
import { EXPRESSION_GENE_SHA, EXPRESSION_MASK, EXPRESSION_QUALIFICATION, validateExpressionRecipe } from '../shared/expression-composition';
import { applyBodyHeadTweak, applyBodyRightTweak, applyBodyTorsoTweak } from '../electron/personalize-body-tweak';
import { showSample } from '../src/stage/expression-show';
import { ShowCarry, StrengthEase, showRequest } from '../src/stage/show-blend';
import { playUniversalShy, playUniversalSurprise } from '../src/stage/shy-show';
import { bodyMotionTarget, universalTarget } from '../src/stage/universal-target';
import { personalizePose, universalPoseProperties } from '../src/stage/universal-pose';
import { BehaviorMotionPlayer } from '../src/stage/behavior-motion';
import { StageModelProfile } from '../src/stage/model-profile';
import { StageMotionRetarget } from '../src/stage/motion-retarget';
import { geneStage, steps, surprises, TRACKED_BONES, type GeneStage, type ShownFrame } from './helpers/gene-stage-harness';
import { BODY_VARIANTS, meshFollows } from './helpers/body-variants';
import { tPoseRolled, type EditableBone } from './helpers/hand-variants';

const DEG = 180 / Math.PI;
/** English names for the body (the step 5 set, plus the torso), as a model exported from another tool might have them. */
export const ENGLISH: Readonly<Record<string, string>> = Object.freeze({
  上半身: 'Spine', 上半身2: 'Chest', 首: 'Neck', 頭: 'Head', 左肩: 'LeftShoulder', 右肩: 'RightShoulder',
  左腕: 'LeftUpperArm', 右腕: 'RightUpperArm', 左ひじ: 'LeftForeArm', 右ひじ: 'RightForeArm', 左手首: 'LeftHand', 右手首: 'RightHand',
});
type Body = { label: string; options: Record<string, unknown> };
const BODIES: readonly Body[] = [
  { label: 'English bone names', options: { renameBones: ENGLISH } },
  ...Object.entries(BODY_VARIANTS).map(([label, edit]) => ({ label, options: { restEditSkin: meshFollows(edit as (bones: EditableBone[]) => void) } })),
  { label: 'T pose, palms forward', options: { restEditSkin: meshFollows(tPoseRolled) } },
];
/** The body recipes the stage's controller admits from an idle-scheduler plan (the others are review-only and close on Gene too). */
const BODY_RECIPES: readonly BodyRecipeId[] = ['idle.neutral', 'idle.proud'];

const worst = (rows: number[][]) => Math.max(0, ...rows.flat());
const worstIn = (frames: readonly ShownFrame[], from: number, to: number, fn: (f: readonly ShownFrame[]) => number[][]) => worst(fn(frames.slice(Math.max(0, from), to)));

// ------------------------------------------------------------------ 1. the mood's body motions

/** A body motion on this body, as the stage would load it for a model that is not the reviewed Gene (bodyTargetSupported false). */
async function bodyRun(options: Record<string, unknown>, recipe: BodyRecipeId, fps: number, asGene: boolean) {
  const h = await geneStage({ fps, body: { recipe }, ...options, notReviewed: !asGene } as never);
  const tracks = (h.stage.bodyMotion.getState().trackNames as string[]).length;
  const seconds = BEHAVIOR_RECIPES[recipe].durationMs / 1000;
  h.run(seconds + 1);
  return Object.assign(h, { tracks });
}

for (const fps of [60, 30] as const) test(`(1) body motions at ${fps} fps: every body recipe plays on the renamed Gene and the Gene-derived bodies, steps as on Gene, the guard catches nothing`, async t => {
  const lines: string[] = [], failures: string[] = [];
  for (const recipe of BODY_RECIPES) {
    const gene = await bodyRun({}, recipe, fps, true);
    const g = { step: worst(steps(gene.shown)), surprise: worst(surprises(gene.shown)), start: worstIn(gene.shown, 0, 6, surprises), guard: gene.shown.at(-1)!.guardJumps, tracks: gene.tracks };
    gene.close();
    lines.push(`${fps} fps Gene ${recipe}: ${g.tracks} tracks, step ${g.step.toFixed(2)}°, unexpected ${g.surprise.toFixed(2)}° (first frames ${g.start.toFixed(3)}°), guard ${g.guard}`);
    for (const body of BODIES) {
      let h: GeneStage & { tracks: number };
      try { h = await bodyRun(body.options, recipe, fps, false); }
      catch (error) { failures.push(`${body.label} ${recipe}: ${(error as Error).message}`); continue; }
      try {
        const fit = h.stage.motionRetarget?.fitOf(BEHAVIOR_RECIPES[recipe].sha256);
        const r = { step: worst(steps(h.shown)), surprise: worst(surprises(h.shown)), start: worstIn(h.shown, 0, 6, surprises), guard: h.shown.at(-1)!.guardJumps };
        lines.push(`${fps} fps ${body.label} ${recipe}: fit ${fit?.status ?? '?'}, ${h.tracks} tracks, step ${r.step.toFixed(2)}°, unexpected ${r.surprise.toFixed(2)}° (first frames ${r.start.toFixed(3)}°), guard ${r.guard}`);
        if (h.tracks !== g.tracks) failures.push(`${body.label} ${recipe}: ${h.tracks} of Gene's ${g.tracks} tracks (the mask misses renamed bones)`);
        if (fit?.status === 'hidden') failures.push(`${body.label} ${recipe}: the fit check holds it back (${fit.issues.join('; ')})`);
        // The natural end of an idle body motion trips the guard once on Gene itself (a kink in the head's speed as the base takes
        // back over, recorded in the I-038 note as a finding, not changed here): the bodies may not add any.
        if (r.guard > g.guard) failures.push(`${body.label} ${recipe}: the guard caught ${r.guard} (${h.shown.at(-1)!.guardLast}), Gene ${g.guard}`);
        if (!(r.step <= g.step * 1.25 + 0.3)) failures.push(`${body.label} ${recipe}: step ${r.step.toFixed(2)}°, Gene ${g.step.toFixed(2)}°`);
        if (!(r.surprise <= g.surprise * 1.25 + 0.3)) failures.push(`${body.label} ${recipe}: unexpected ${r.surprise.toFixed(2)}°, Gene ${g.surprise.toFixed(2)}°`);
      } finally { h.close(); }
    }
  }
  t.diagnostic(lines.join('\n'));
  assert.deepEqual(failures, []);
});

test('(1) a model nothing maps onto, or a motion the fit check holds back: nothing starts, and the controller says why', async () => {
  // Not the reviewed Gene and no retarget plan (no profile could be made): the controller reports the target as unsupported.
  await assert.rejects(geneStage({ notReviewed: true, body: { recipe: 'idle.neutral' } } as never), /unsupported-target/);
  // A plan, but this motion does not suit the model: its clip is refused before it starts (MmdStage.loadBodyMotionClip).
  await assert.rejects(geneStage({ renameBones: ENGLISH, notReviewed: true, body: { recipe: 'idle.neutral' },
    beforeLayers: (stage: { motionRetarget: { fitOf(sha: string): unknown } }) => { stage.motionRetarget.fitOf = () => ({ status: 'hidden', issues: [] }); } } as never),
  /不适合当前模型|did not start/);
  const target = bodyMotionTarget(false, null);
  assert.deepEqual(target, { supported: false });
  assert.deepEqual(bodyMotionTarget(true, null), { supported: true }, 'the reviewed Gene as before: no name mapping at all');
});

// ------------------------------------------------------------------ 2. 害羞 / 惊喜 as whole performances, at a strength

const HEAD = TRACKED_BONES.indexOf('頭');
/** Two stages side by side, frame for frame (the second never shows anything). */
const lockstep = (a: GeneStage, b: GeneStage, seconds: number) => { const n = Math.round(seconds * a.rate); for (let i = 0; i < n; i++) { a.tick(); b.tick(); } };
/** Largest head difference (degrees) between two lockstepped stages over shown frames [from, to). */
const headApart = (a: GeneStage, b: GeneStage, from: number, to: number) => {
  let best = 0;
  for (let i = from; i < Math.min(to, a.shown.length, b.shown.length); i++) best = Math.max(best, a.shown[i].world[HEAD].angleTo(b.shown[i].world[HEAD]) * DEG);
  return best;
};
const headSurprise = (frames: readonly ShownFrame[]) => Math.max(0, ...surprises(frames)[HEAD]);
const SHOW_BODIES: readonly Body[] = [{ label: 'Gene', options: {} }, BODIES[0], BODIES.find(body => body.label.startsWith('T pose'))!];
const showOptions = (fps: number, body: Body) => ({ fps, ...body.options, ...(body.label === 'Gene' ? {} : { notReviewed: true }) }) as never;

test('(2) showRequest: a repeat while the show comes in or holds keeps it; later, or the other recipe, starts again; ShowCarry eases out', () => {
  assert.equal(showRequest(null, 'shy'), 'start');
  assert.equal(showRequest({ recipe: 'shy', elapsedMs: 300 }, 'shy'), 'keep');
  assert.equal(showRequest({ recipe: 'shy', elapsedMs: 2_000 }, 'shy'), 'keep');
  assert.equal(showRequest({ recipe: 'shy', elapsedMs: 2_400 }, 'shy'), 'start');
  assert.equal(showRequest({ recipe: 'shy', elapsedMs: 300 }, 'surprise'), 'start');
  assert.equal(showRequest({ recipe: 'surprise', elapsedMs: 100 }, 'surprise'), 'keep');
  assert.equal(showRequest({ recipe: 'surprise', elapsedMs: 900 }, 'surprise'), 'start');
  // The replaced show keeps playing on its clock, fading by smoothstep: its first frame is where it would have been.
  const carry = new ShowCarry(), dt = 1 / 60, smooth = (x: number) => x * x * (3 - 2 * x);
  carry.capture('shy', 1500, true, 1, 1); carry.step(dt);
  assert.ok(Math.abs(carry.at('headX') - showSample('shy', 1500 + 1000 * dt, true).headX * smooth(1 - dt / 0.5)) < 1e-12);
  let previous = carry.at('headX'), biggest = 0;
  for (let i = 0; i < 60; i++) { carry.step(dt); const value = carry.at('headX'); biggest = Math.max(biggest, Math.abs(value - previous)); previous = value; }
  assert.equal(carry.at('headX'), 0); assert.equal(carry.active, false);
  assert.ok(biggest < showSample('shy', 1500, true).headX * 0.06, `eases out (largest step ${biggest})`);
  const ease = new StrengthEase(); ease.reset(0.6);
  const values = Array.from({ length: 40 }, () => ease.step(1, dt));
  assert.equal(values.at(-1), 1); assert.ok(values[0] - 0.6 < 0.005, 'starts without a kink'); assert.ok(values.every((value, i) => i === 0 || value >= values[i - 1]));
});

for (const fps of [60, 30] as const) test(`(2) 害羞 / 惊喜 at ${fps} fps: the whole show plays on Gene, the renamed Gene and the T pose body; half strength is half; ease in and out; the guard catches nothing`, async t => {
  const lines: string[] = [], failures: string[] = [];
  const reference: Record<string, { apart: number; surprise: number; guard: number; back: number }> = {};
  for (const body of SHOW_BODIES) for (const recipe of ['shy', 'surprise'] as const) for (const strength of [1, 0.5]) {
    const h = await geneStage(showOptions(fps, body)), idle = await geneStage(showOptions(fps, body));
    try {
      lockstep(h, idle, 1);
      const start = h.shown.length, jumps = h.shown.at(-1)!.guardJumps;
      const outcome = recipe === 'shy' ? playUniversalShy(h.stage, strength) : playUniversalSurprise(h.stage, strength);
      lockstep(h, idle, 5);
      const apart = headApart(h, idle, start, h.shown.length), surprise = headSurprise(h.shown.slice(start - 2)), idleSurprise = headSurprise(idle.shown.slice(start - 2));
      const guard = h.shown.at(-1)!.guardJumps - jumps, back = headApart(h, idle, h.shown.length - 3, h.shown.length);
      lines.push(`${fps} fps ${body.label} ${recipe} ×${strength}: played ${outcome.played} (missing: ${outcome.support?.missing.join('、') || '–'}), head off idle up to ${apart.toFixed(2)}°, unexpected ${surprise.toFixed(3)}° (idle ${idleSurprise.toFixed(3)}°), guard ${guard}, back ${back.toFixed(3)}°`);
      if (!outcome.played) failures.push(`${body.label} ${recipe}: ${outcome.reason}`);
      const key = `${body.label} ${recipe}`, gene = reference[`Gene ${recipe}`];
      // On Gene itself the full 惊喜 trips the guard once at 30 fps (びっくり rises "一下子"), and after the shy show the head
      // settles back within a few tenths of a degree (procedural life's own follow): the other bodies may not add to either.
      if (body.label !== 'Gene' && guard > (gene?.guard ?? 0)) failures.push(`${key} ×${strength}: the guard caught ${guard} (${h.shown.at(-1)!.guardLast})`);
      if (!(back < 0.5) || (gene && !(back <= gene.back + 0.05))) failures.push(`${key} ×${strength}: not back (${back.toFixed(3)}°)`);
      if (strength === 1) {
        reference[key] = { apart, surprise, guard, back };
        if (!(apart > (recipe === 'shy' ? 8 : 3))) failures.push(`${key}: the head barely moves (${apart.toFixed(2)}°)`);
        if (gene && !(surprise <= gene.surprise * 1.25 + 0.05)) failures.push(`${key}: unexpected ${surprise.toFixed(3)}°, Gene ${gene.surprise.toFixed(3)}°`);
      } else {
        const ratio = apart / reference[key].apart;
        if (!(ratio > 0.4 && ratio < 0.6)) failures.push(`${key} ×0.5: ${ratio.toFixed(2)} of the full show`);
      }
    } finally { idle.close(); h.close(); }
  }
  t.diagnostic(lines.join('\n'));
  assert.deepEqual(failures, []);
});

type Request = readonly [seconds: number, recipe: 'shy' | 'surprise', strength: number];
for (const fps of [60, 30] as const) test(`(2) asked again at ${fps} fps: while it holds it keeps going, later it starts again from what shows, the other recipe takes over — no pop`, async t => {
  const lines: string[] = [], failures: string[] = [];
  for (const body of SHOW_BODIES.slice(0, 2)) {
    const once = await geneStage(showOptions(fps, body));
    // One show at the strength the scripts ask for (1): a stronger show is a bigger, faster move by itself.
    once.run(1); const onceStart = once.shown.length; playUniversalShy(once.stage, 1); once.run(3.6);
    const single = headSurprise(once.shown.slice(onceStart - 2)); once.close();
    // 惊喜 is "一下子" by design: switching to it is measured against one full 惊喜 on its own.
    const jolt = await geneStage(showOptions(fps, body));
    jolt.run(1); const joltStart = jolt.shown.length; playUniversalSurprise(jolt.stage, 1); jolt.run(2.5);
    const surpriseOnce = headSurprise(jolt.shown.slice(joltStart - 2)); jolt.close();
    const scripts: readonly (readonly [string, readonly Request[]])[] = [
      ['again at 1.0 s (holding)', [[1.0, 'shy', 1]]],
      ['again at 2.6 s (letting go)', [[2.6, 'shy', 1]]],
      ['惊喜 at 1.2 s', [[1.2, 'surprise', 1]]],
      ['three times', [[0.5, 'shy', 0.8], [1.5, 'shy', 1], [2.7, 'shy', 0.7]]],
    ];
    for (const [label, script] of scripts) {
      const h = await geneStage(showOptions(fps, body));
      try {
        h.run(1);
        const start = h.shown.length, jumps = h.shown.at(-1)!.guardJumps;
        playUniversalShy(h.stage, 0.6);
        let at = 0;
        for (const [time, recipe, strength] of script) {
          h.run(time - at); at = time;
          const outcome = recipe === 'shy' ? playUniversalShy(h.stage, strength) : playUniversalSurprise(h.stage, strength);
          if (!outcome.played) failures.push(`${body.label} ${label}: ${outcome.reason}`);
        }
        h.run(4.2);
        const surprise = headSurprise(h.shown.slice(start - 2)), guard = h.shown.at(-1)!.guardJumps - jumps;
        const reference = script.some(([, recipe]) => recipe === 'surprise') ? Math.max(single, surpriseOnce) : single;
        lines.push(`${fps} fps ${body.label} ${label}: unexpected ${surprise.toFixed(3)}° (one show ${reference.toFixed(3)}°), guard ${guard}`);
        if (guard) failures.push(`${body.label} ${label}: the guard caught ${guard} (${h.shown.at(-1)!.guardLast})`);
        if (!(surprise <= reference * 1.25 + 0.05)) failures.push(`${body.label} ${label}: unexpected ${surprise.toFixed(3)}°, one show ${reference.toFixed(3)}°`);
      } finally { h.close(); }
    }
  }
  t.diagnostic(lines.join('\n'));
  assert.deepEqual(failures, []);
});

test('(2) a model with nothing to show it on: not played, and the reason says so; strength 0 does nothing', () => {
  const none = playUniversalShy({ playExpression: () => ({ recipe: 'shy', usable: false, parts: [], missing: ['低头侧转'], reason: '这个模型上找不到能用的头部骨骼和表情（眉毛、眼睛、嘴、脸红），所以没法预览。' }) }, 1);
  assert.equal(none.played, false); assert.match(none.reason, /找不到/);
  let called = 0;
  const zero = playUniversalShy({ playExpression: () => { called++; return null; } }, 0);
  assert.equal(zero.played, false); assert.equal(called, 0);
  assert.equal(playUniversalShy(null, 1).played, false);
});

// ------------------------------------------------------------------ 3. the personal pose and the brow/eye picks

const ARM = ['左ひじ', '左手首', '右ひじ', '右手首'] as const;
/** The full personal pose a card can have: the left arm's soft bend, the right arm, a head tilt and the torso's lean. */
function fullPose() {
  const base = bodyPoseBinding('body.gene-left-arm-soft-bend', VISUAL_GENE_SHA)!;
  const right = applyBodyRightTweak(base, { enabled: true, strength: 0.5, shoulderOffsetDegrees: 2, upperArmOffsetDegrees: 6, elbowOffsetDegrees: 10 }, 0.5);
  const head = applyBodyHeadTweak(right, { enabled: true, strength: 0.5, offsetDegrees: 6 }, 0.5);
  return applyBodyTorsoTweak(head, { enabled: true, strength: 0.5, offsetDegrees: 5 }, 0.5);
}
async function poseRun(options: Record<string, unknown>, fps: number, pose: boolean) {
  const h = await geneStage({ fps, extraBones: ARM, ...options } as never);
  h.stage.bodyPersonalizeConsumed ??= new Set(); // a real constructor field the harness does not set
  if (options.notReviewed !== true) h.stage.bodyTargetSupported = true; // the reviewed Gene, as the host's check would say
  h.run(0.5);
  const start = h.shown.length;
  if (pose) {
    const binding = fullPose(), view = h.stage.moodView;
    h.stage.setMood({ ...view, revision: view.revision + 1, bodyPose: { cueId: 'pose-1', expiresAt: Date.now() + 60_000, strength: binding.qualifiedStrength, modelUrl: h.stage.modelUrl, binding } });
  }
  h.run(1.5);
  return { h, start };
}
/** World direction of a forearm (elbow → wrist) at a shown frame. */
const forearm = (frame: ShownFrame, side: 0 | 1) => frame.extraAt[side * 2 + 1].clone().sub(frame.extraAt[side * 2]).normalize();
const last = (h: GeneStage) => h.shown.at(-1)!;
const forearmsApart = (a: ShownFrame, b: ShownFrame) => Math.max(...([0, 1] as const).map(side => forearm(a, side).angleTo(forearm(b, side)) * DEG));

for (const fps of [60, 30] as const) test(`(3) the personal pose at ${fps} fps on the renamed Gene and the bodies: arms and head land as on Gene (the torso lean is skipped and named), the guard adds nothing`, async t => {
  const lines: string[] = [], failures: string[] = [];
  const gene = await poseRun({}, fps, true), geneIdle = await poseRun({}, fps, false);
  const geneMoved = forearmsApart(last(gene.h), last(geneIdle.h));
  const geneSurprise = worst(surprises(gene.h.shown.slice(gene.start - 2))), geneGuard = last(gene.h).guardJumps;
  lines.push(`${fps} fps Gene: applied ${!!gene.h.stage.bodyPersonalize}, forearms moved up to ${geneMoved.toFixed(2)}°, unexpected ${geneSurprise.toFixed(3)}°, guard ${geneGuard}`);
  geneIdle.h.close();
  try {
    for (const body of BODIES) {
      const run = await poseRun({ ...body.options, notReviewed: true }, fps, true), idle = await poseRun({ ...body.options, notReviewed: true }, fps, false);
      try {
        const moved = forearmsApart(last(run.h), last(idle.h)), offGene = forearmsApart(last(run.h), last(gene.h));
        const headOff = last(run.h).world[HEAD].angleTo(last(gene.h).world[HEAD]) * DEG;
        const surprise = worst(surprises(run.h.shown.slice(run.start - 2))), guard = last(run.h).guardJumps;
        lines.push(`${fps} fps ${body.label}: applied ${!!run.h.stage.bodyPersonalize}, forearms moved up to ${moved.toFixed(2)}° (Gene ${geneMoved.toFixed(2)}°), off Gene's ${offGene.toFixed(2)}°, head off Gene's ${headOff.toFixed(2)}°, unexpected ${surprise.toFixed(3)}°, guard ${guard}`);
        if (!run.h.stage.bodyPersonalize) failures.push(`${body.label}: the pose was not applied`);
        if (!(moved > geneMoved * 0.8)) failures.push(`${body.label}: forearms moved ${moved.toFixed(2)}°, Gene ${geneMoved.toFixed(2)}°`);
        if (!(offGene < 3)) failures.push(`${body.label}: forearm ${offGene.toFixed(2)}° off Gene's`);
        if (guard > geneGuard) failures.push(`${body.label}: the guard caught ${guard} (${last(run.h).guardLast}), Gene ${geneGuard}`);
        if (!(surprise <= geneSurprise * 1.25 + 0.3)) failures.push(`${body.label}: unexpected ${surprise.toFixed(3)}°, Gene ${geneSurprise.toFixed(3)}°`);
      } finally { idle.h.close(); run.h.close(); }
    }
  } finally { gene.h.close(); }
  t.diagnostic(lines.join('\n'));
  assert.deepEqual(failures, []);
});

test('(3) what cannot land is skipped and named: the torso lean, a bone the model lacks; nothing at all keeps the pose closed', async () => {
  const h = await geneStage({ renameBones: ENGLISH, notReviewed: true } as never);
  try {
    const target = universalTarget(h.stage.motionRetarget)!;
    assert.equal(target.reviewed, false);
    const pose = universalPoseProperties(h.mesh, fullPose().properties, target);
    assert.ok(pose.skipped.includes('上半身'), `the torso lean is named (${pose.skipped})`);
    const landed = pose.properties.map(row => row.boneName);
    assert.ok(landed.includes('LeftForeArm') && landed.includes('RightForeArm') && landed.includes('Head'), JSON.stringify(landed));
    const tail = [{ boneIndex: 999, boneName: '尻尾', quaternion: [0, 0, 0.2588190451, 0.9659258263] as const }];
    assert.deepEqual(universalPoseProperties(h.mesh, tail, target), { properties: [], skipped: ['尻尾'] });
    assert.throws(() => personalizePose(h.mesh, tail, h.stage.restPose, false, h.stage.motionRetarget), /找不到.*尻尾/);
    assert.deepEqual(universalPoseProperties(h.mesh, fullPose().properties, null).properties, [], 'no plan: nothing lands');
  } finally { h.close(); }
});

test('(3) brow/eye picks on a model whose shapes have other names: the player takes it as a target and writes the renamed shapes', async () => {
  const h = await geneStage({ renameMorphs: { 笑い: 'eye_smile', 上: 'brow_up' } });
  try {
    const profile = new StageModelProfile(h.mesh, { reviewed: false }).profile, retarget = new StageMotionRetarget(h.mesh, profile, { reviewed: false });
    const make = (universal: boolean) => new BehaviorMotionPlayer(h.mesh, { targetSupported: false, ...(universal ? { universal: () => universalTarget(retarget) } : {}),
      resolve: async () => { throw Error('unused'); }, load: async () => { throw Error('unused'); } });
    const before = make(false);
    assert.equal(before.supported, false, 'as before: only the verified Gene');
    const player = make(true);
    assert.equal(player.supported, true);
    const recipe = validateExpressionRecipe({ schemaVersion: 1, id: 'semantic-text-authoring', sceneId: 'text-authoring', strategy: 'semantic-parameters', label: '笑一下',
      targetModelSha: EXPRESSION_GENE_SHA, maskId: EXPRESSION_MASK, qualification: EXPRESSION_QUALIFICATION, strength: 0.5, morphs: [{ id: 'eye_smile', weight: 0.6 }, { id: 'brow_raise', weight: 0.5 }] });
    const resource = { id: 'p1', token: 'tok_1', scope: 'personalize-expression-controls', sessionId: 's', revision: 1, recipeId: recipe.id, characterId: 'gene',
      targetModelSha: EXPRESSION_GENE_SHA, modelUrl: '', mask: EXPRESSION_MASK, expiresAt: Date.now() + 60_000, recipe, stageGeneration: 1 };
    const gates = { enabled: true, visible: true, faceBlocked: false, directContact: false, windowAdjusting: false, cameraAdjusting: false, naturalBlink: 0 };
    assert.equal(before.setComposition(resource as never, 'tok_1', gates, 0.5), false);
    assert.equal(player.setComposition(resource as never, 'tok_1', gates, 0.5), true);
    player.frame(1 / 60);
    const dictionary = h.mesh.morphTargetDictionary!, influences = h.mesh.morphTargetInfluences!;
    assert.ok(influences[dictionary.eye_smile] > 0.2 && influences[dictionary.brow_up] > 0.2, `${influences[dictionary.eye_smile]} ${influences[dictionary.brow_up]}`);
    player.restore();
    assert.equal(influences[dictionary.eye_smile], 0); assert.equal(influences[dictionary.brow_up], 0);
    before.dispose(); player.dispose();
  } finally { h.close(); }
});
