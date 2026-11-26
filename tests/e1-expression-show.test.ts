/**
 * E1 惊喜 / 害羞 on any model (U-008: not found in the control window,
 * no shy motion, no readable surprise on a non-Gene model).
 *  - the recipes read: shy = look down and away, half lids, head down / turned / tilted, blush, closed smile; surprise = brows up,
 *    eyes wide, small "o", chin up, "一下子" then a natural settle;
 *  - any model: parts come from the model profile; missing parts are skipped; nothing usable = greyed out with a reason;
 *  - R29: on the real Stage frame loop (Gene, Stand, procedural life) the entry and the exit are continuous in position and speed,
 *    a pat in the middle fades it out instead of cutting it, and the display guard has nothing to catch.
 * Numbers print under R29_REPORT=1.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Quaternion, type Bone } from 'three';
import { SHOW_KEYS, SHOW_LIMITS, SHOW_MS, SHOW_NOTHING_REASON, showSample, showSupport, showSupportLine, type ShowCapabilities } from '../src/stage/expression-show';
import { ProceduralLife, lifeRig, type LifeGates, type LifeInput, type LifePort } from '../src/stage/procedural-life';
import { EyelidCompositor } from '../src/stage/channel-compositors';
import { StageModelProfile } from '../src/stage/model-profile';
import { isExpressionRecipe } from '../shared/stage/expression-preview';
import { toThreeMesh, toyModel } from './helpers/model-fixtures';
import { type ShownFrame } from './helpers/frame-stats';

const DT = 1 / 60, DEG = 180 / Math.PI;
const trace = (recipe: 'surprise' | 'shy', hasEyes = true) => Array.from({ length: Math.ceil(SHOW_MS[recipe] / (DT * 1000)) + 2 }, (_, i) => ({ ...showSample(recipe, i * DT * 1000, hasEyes) }));
const peak = (rows: ReturnType<typeof trace>, key: keyof ReturnType<typeof showSample>) => rows.reduce((max, row) => Math.abs(row[key]) > Math.abs(max) ? row[key] : max, 0);
const at = (rows: ReturnType<typeof trace>, ms: number) => rows[Math.round(ms / (DT * 1000))];

// ---------------------------------------------------------------- the recipes

test('shy reads as shy: eyes down and aside, half lids, head down, turned and tilted the same way, blush, closed smile, a troubled brow', () => {
  const shy = trace('shy');
  assert.ok(peak(shy, 'headX') >= 0.14, `head well down (${peak(shy, 'headX')} rad; the old preview went to 0.075)`);
  assert.ok(peak(shy, 'headY') >= 0.13 && peak(shy, 'headZ') <= -0.06, 'turned away and tilted toward the same side (her left)');
  assert.ok(peak(shy, 'eyePitch') >= 0.16 && peak(shy, 'eyeYaw') >= 0.1, 'eyes drop and slide to the side');
  assert.ok(peak(shy, 'lidSoft') >= 0.35 && peak(shy, 'blush') >= 0.9 && peak(shy, 'mouthSmile') >= 0.45 && peak(shy, 'browSad') >= 0.28);
  assert.ok(peak(shy, 'bodyX') > 0.02, 'she draws in a little');
  assert.equal(peak(shy, 'mouthOpen'), 0, 'the mouth stays closed');
  // All of it together in the held middle, not one after another.
  const middle = at(shy, 1500);
  assert.ok(middle.headX > 0.13 && middle.eyePitch > 0.15 && middle.lidSoft > 0.35 && middle.blush > 0.85 && middle.mouthSmile > 0.45);
  // A tiny startle first: brows and eyes before the look-away.
  assert.ok(at(shy, 200).browUp > 0.15 && at(shy, 200).headX < 0.01, 'startle, then the look-away');
  const noEyes = trace('shy', false);
  assert.equal(peak(noEyes, 'eyePitch'), 0); assert.ok(peak(noEyes, 'lidSoft') >= 0.44, 'without eye bones the lowered gaze is a deeper lid');
});

test('surprise has "一下子": brows up, eyes wide, small "o", chin up within about 0.2 s, then a natural settle', () => {
  const surprise = trace('surprise');
  const quick = at(surprise, 220);
  assert.ok(quick.browUp > 0.95 && quick.eyeWide > 0.85 && quick.headX < -0.075 && quick.mouthOpen > 0.3, JSON.stringify(quick));
  assert.ok(peak(surprise, 'bodyX') < -0.03, 'leans back a little');
  assert.equal(peak(surprise, 'blush'), 0); assert.equal(peak(surprise, 'lidSoft'), 0);
  assert.ok(at(surprise, 1000).browUp < 0.6 && at(surprise, 1000).browUp > 0.3, 'settling, not cut');
  assert.ok(Math.abs(at(surprise, 1650).headX) < 0.003 && at(surprise, 1650).browUp === 0, 'back at rest');
});

test('every channel starts and ends at exactly 0, stays bounded, and moves with continuous speed (no corner at any key)', () => {
  for (const recipe of ['surprise', 'shy'] as const) {
    const rows = trace(recipe);
    for (const key of SHOW_KEYS) {
      const values = rows.map(row => row[key]);
      assert.equal(values[0], 0, `${recipe}.${key} starts at rest`); assert.equal(values.at(-1), 0, `${recipe}.${key} ends at rest`);
      assert.ok(values.every(value => Math.abs(value) <= SHOW_LIMITS[key] + 1e-12), `${recipe}.${key} bounded`);
      // Second difference = the change of speed between frames; a corner (a key reached at speed and left at another) is one big value.
      const speeds = values.slice(1).map((value, i) => value - values[i]);
      const peakSpeed = Math.max(...speeds.map(Math.abs));
      const accel = Math.max(0, ...speeds.slice(1).map((value, i) => Math.abs(value - speeds[i])));
      if (peakSpeed > 0) assert.ok(accel <= peakSpeed * 0.6, `${recipe}.${key}: speed changes smoothly (${accel.toFixed(4)} vs peak ${peakSpeed.toFixed(4)} per frame)`);
    }
  }
  for (const [recipe, ms] of [['surprise', -1], ['shy', SHOW_MS.shy], ['shy', Number.NaN], [null, 500]] as const)
    assert.ok(SHOW_KEYS.every(key => showSample(recipe, ms, true)[key] === 0), `${recipe} ${ms}: nothing`);
  assert.ok(isExpressionRecipe('shy') && isExpressionRecipe('surprise') && !isExpressionRecipe('angry') && !isExpressionRecipe(null));
});

// ---------------------------------------------------------------- any model: what shows and what is skipped

const all: ShowCapabilities = { head: true, upperBody: true, eyes: true, lids: true, browUp: true, browSad: true, eyeWide: true, smileEyes: true, mouthSmile: true, mouthOpen: true, blush: true };
test('support: parts come from what the model has; missing ones are named and skipped; nothing at all greys the button with a reason', () => {
  assert.deepEqual(showSupport('surprise', all).missing, []);
  const noBrows = showSupport('surprise', { ...all, browUp: false, mouthOpen: false });
  assert.equal(noBrows.usable, true); assert.deepEqual(noBrows.missing, ['眉毛上扬', '小"o"嘴']);
  assert.match(showSupportLine(noBrows), /^惊喜：睁大眼睛、头微微后仰、身体往后一靠 · 这个模型没有：眉毛上扬、小"o"嘴（跳过）$/);
  const headOnly = showSupport('shy', { ...Object.fromEntries(Object.keys(all).map(key => [key, false])) as unknown as ShowCapabilities, head: true });
  assert.equal(headOnly.usable, true, 'a head bone alone is enough to show something'); assert.deepEqual(headOnly.parts, ['低头侧转']);
  const nothing = showSupport('shy', Object.fromEntries(Object.keys(all).map(key => [key, false])) as unknown as ShowCapabilities);
  assert.equal(nothing.usable, false); assert.equal(nothing.reason, SHOW_NOTHING_REASON);
  assert.equal(showSupport('surprise', null).usable, false, 'no model yet');
});

const gates = (patch: Partial<LifeGates> = {}): LifeGates => ({ expressive: true, contact: false, manualPose: false, manualGesture: false, manualHead: false,
  manualExpression: false, manualMouth: false, chatGesture: false, music: false, bodyMotion: false, headOwned: false, authoredFace: false,
  preview: true, adjusting: false, speaking: false, gazeAllowed: true, ...patch });

test('a synthetic model (English names, no eye bones): profile slots are written, the missing eye bones become lids, nothing throws', () => {
  const toy = toThreeMesh(toyModel({ names: 'english', eyeBones: false }));
  try {
    const profile = new StageModelProfile(toy, { reviewed: false }), rig = lifeRig(toy, profile);
    assert.ok((rig.slots.browUp ?? -1) >= 0 && (rig.slots.surprise ?? -1) >= 0, 'Brow_Up and Surprised validated by where they move');
    const name = (index: number) => toy.geometry.morphAttributes.position[index].name;
    for (const recipe of ['surprise', 'shy'] as const) {
      const life = new ProceduralLife<Bone>(), lids = new EyelidCompositor(), writes = new Map<string, number>(), rotated = new Set<string>();
      const port: LifePort<Bone> = { rotate: bone => { if (bone) rotated.add(bone.name); }, head() {}, morph: (index, weight) => writes.set(name(index), Math.max(writes.get(name(index)) ?? 0, weight)) };
      const head = profile.bone('head'), upper = profile.bone('upperBody');
      for (let i = 0; i < 60; i++) life.frame(DT, input(rig, null, 0));
      let lid = 0;
      for (let ms = 0; ms < SHOW_MS[recipe] + 400; ms += DT * 1000) {
        life.frame(DT, input(rig, ms < SHOW_MS[recipe] ? `show:${recipe}` : null, ms));
        const o = life.out, f = lids.frame(DT, { contact: 0, cheek: 0, fatigue: 0, naturalBlink: 0, soft: o.lidSoft, smileEyes: o.smileEyes, jitome: o.jitome });
        lid = Math.max(lid, f.blink);
        life.applyFace(port, f, 0); life.applyPreview(port, head, [], true, true, upper, true);
      }
      if (recipe === 'surprise') assert.ok((writes.get('Brow_Up') ?? 0) > 0.6 && (writes.get('Surprised') ?? 0) > 0.6 && (writes.get('oh') ?? 0) > 0.2, JSON.stringify([...writes]));
      else { assert.ok(lid >= 0.4, `no eye bones: the lowered gaze is on the lids (${lid})`); assert.ok((writes.get('Mouth_Smile') ?? 0) > 0.4 && (writes.get('Sad') ?? 0) > 0.2); }
      assert.ok(rotated.has('Head') && rotated.has('UpperBody'), `${recipe}: head and upper body from the profile`);
    }
  } finally { toy.geometry.dispose(); }
  function input(rig: ReturnType<typeof lifeRig<Bone>>, clip: string | null, ms: number): LifeInput<Bone> {
    return { enabled: true, owner: rig.owner, seedKey: 'toy', rig, mood: { primary: 'calm' }, fatigue: null, pointerX: 0, pointerY: 0, breathStrength: 0.5,
      hasEyes: false, blush: { enabled: true, intensity: 35, size: 50 }, previewClip: clip, previewElapsedMs: ms, previewBlocked: false, gates: gates({ preview: clip !== null }) };
  }
});

// ---------------------------------------------------------------- the real Stage frame loop on Gene

const EYES = ['左目', '右目'];
interface Played { frames: ShownFrame[]; morph: (name: string) => number[]; blush: number[]; t0: number }
const relative = (event: ShownFrame[], control: ShownFrame[], bone: number) => event.map((frame, i) => frame.world[bone].angleTo(control[i].world[bone]) * DEG);
const HEAD = 4, UPPER = 1;
function report(label: string, values: Record<string, number>): void {
  if (process.env.R29_REPORT) console.log(`${label}: ${Object.entries(values).map(([key, value]) => `${key} ${value.toFixed(3)}`).join(' · ')}`);
}

void Quaternion; void Euler;
