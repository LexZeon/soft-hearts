/**
 * VRM's own maps onto the app's standard tables (I-152 原样载入): humanoid bones → standard bones, expressions → expression slots.
 * Read at run time by the stage's native VRM loading (src/stage/model-adapter/vrm.ts); the file is never changed. Pure data.
 */
import type { FingerSlot, MorphSlot, StandardBone } from '../../foundation/universal-skeleton';
import type { HumanBone } from './vrm-read';

/**
 * VRM humanoid bone → the standard bone it is (the same correspondence the VRM → PMX converter's MMD names follow:
 * hips 下半身, spine 上半身, chest 上半身2…). VRM has no center/groove/root bones: the stage's "center" is the hips.
 */
export const VRM_STANDARD_BONES: Readonly<Partial<Record<HumanBone, StandardBone>>> = Object.freeze({
  hips: 'lowerBody', spine: 'upperBody', chest: 'upperBody2', neck: 'neck', head: 'head',
  leftEye: 'eyeLeft', rightEye: 'eyeRight',
  leftShoulder: 'shoulderLeft', leftUpperArm: 'armLeft', leftLowerArm: 'elbowLeft', leftHand: 'wristLeft',
  rightShoulder: 'shoulderRight', rightUpperArm: 'armRight', rightLowerArm: 'elbowRight', rightHand: 'wristRight',
  leftUpperLeg: 'legLeft', leftLowerLeg: 'kneeLeft', leftFoot: 'ankleLeft', leftToes: 'toeLeft',
  rightUpperLeg: 'legRight', rightLowerLeg: 'kneeRight', rightFoot: 'ankleRight', rightToes: 'toeRight',
});

/**
 * The VRM humanoid bones a standard slot may come from, best first. Slots whose own bone a VRM may lack fall back the way the
 * stage's MMD names do: the stage's "chest" (upperBody2) is chest, else upperChest, else spine; "center" is the hips.
 */
export const STANDARD_FROM_VRM: Readonly<Partial<Record<StandardBone, readonly HumanBone[]>>> = Object.freeze({
  ...Object.fromEntries(Object.entries(VRM_STANDARD_BONES).map(([human, standard]) => [standard, [human as HumanBone]])),
  upperBody2: ['chest', 'upperChest', 'spine'],
  center: ['hips'],
});

/**
 * Finger joint (MMD numbering, the way the library's motions name them) → the VRM humanoid finger (1.0 names; vrm-read renames
 * 0.x thumbs). The MMD thumb 0–2 is VRM's metacarpal, proximal, distal; the other fingers 1–3 are proximal, intermediate, distal.
 */
export const VRM_FINGER_BONES: Readonly<Record<FingerSlot, HumanBone>> = Object.freeze(Object.fromEntries((['Left', 'Right'] as const).flatMap(side => {
  const s = side === 'Left' ? 'left' : 'right';
  const thumb = [['thumb0', 'ThumbMetacarpal'], ['thumb1', 'ThumbProximal'], ['thumb2', 'ThumbDistal']];
  const others = (['index', 'middle', 'ring', 'little'] as const).flatMap(finger => {
    const vrm = finger === 'index' ? 'Index' : finger === 'middle' ? 'Middle' : finger === 'ring' ? 'Ring' : 'Little';
    return [[`${finger}1`, `${vrm}Proximal`], [`${finger}2`, `${vrm}Intermediate`], [`${finger}3`, `${vrm}Distal`]];
  });
  return [...thumb, ...others].map(([joint, bone]) => [`${joint}${side}`, `${s}${bone}`]);
})) as Record<FingerSlot, HumanBone>);

/** Expression slot → the VRM expressions (1.0 preset names; 0.x presets are renamed by vrm-read) it is, best first. */
export const VRM_EXPRESSION_SLOTS: Readonly<Record<MorphSlot, readonly string[]>> = Object.freeze({
  a: ['aa'], i: ['ih'], u: ['ou'], e: ['ee'], o: ['oh'],
  blink: ['blink'], blinkLeft: ['blinkLeft'], blinkRight: ['blinkRight'],
  smileEyes: ['happy'], mouthSmile: [], sad: ['sad'], angry: ['angry'], surprise: ['surprised'],
  shy: [], jitome: [], browUp: [], mouthPucker: [],
});
