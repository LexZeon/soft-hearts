/**
 * I-038 part A (docs/claude/2026-11-06-i038-universal-part-a.md): three presentations that only the reviewed Gene had, now on
 * any model through the universal skeleton — the mood's body motions, 害羞 / 惊喜 as whole performances (with the reaction
 * system's strength), and the personal pose and brow/eye picks. Measured on Gene, a renamed Gene and Gene-derived bodies
 * (tests/helpers/body-variants.ts, hand-variants.ts; gene-stage-harness restEditSkin / renameBones). Gene's own data only: no
 * other model, nothing of the user's, no PMX or VMD bytes written.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BodyRecipeId } from '../shared/actions/body-motion';
import { bodyPoseBinding } from '../shared/stage/personalize-body-bindings';
import { VISUAL_GENE_SHA } from '../shared/stage/personalize-visual';
import { applyBodyHeadTweak, applyBodyRightTweak, applyBodyTorsoTweak } from '../electron/stage/personalize-body-tweak';
import { showSample } from '../src/stage/expression-show';
import { ShowCarry, StrengthEase, showRequest } from '../src/stage/show-blend';
import { playUniversalShy } from '../src/mood/shy-show';
import { BODY_VARIANTS, meshFollows } from './helpers/body-variants';
import { tPoseRolled, type EditableBone } from './helpers/hand-variants';
import { surprises, TRACKED_BONES, type ShownFrame } from './helpers/frame-stats';

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

// ------------------------------------------------------------------ 2. 害羞 / 惊喜 as whole performances, at a strength

const HEAD = TRACKED_BONES.indexOf('頭');
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

type Request = readonly [seconds: number, recipe: 'shy' | 'surprise', strength: number];

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
/** World direction of a forearm (elbow → wrist) at a shown frame. */
const forearm = (frame: ShownFrame, side: 0 | 1) => frame.extraAt[side * 2 + 1].clone().sub(frame.extraAt[side * 2]).normalize();
const forearmsApart = (a: ShownFrame, b: ShownFrame) => Math.max(...([0, 1] as const).map(side => forearm(a, side).angleTo(forearm(b, side)) * DEG));
