/**
 * 通用骨架 (universal skeleton), step 1 of docs/claude/2026-11-06-universal-skeleton-plan.md: the ONE place that says what
 * the standard body is (I-020 "想改哪里只改一处"). The model profile (shared/model-profile.ts), the motion conversion
 * (shared/motion-retarget.ts), the fit check (shared/motion-fit.ts), the action table (shared/her-actions.ts) and the
 * capability card (shared/model-capability.ts, shared/model-adaptation.ts) all read it from here; none keeps its own copy.
 *
 * Three parts:
 * - The standard part table: the standard bones and their name aliases, the finger joints (MMD numbering), the standard face
 *   slots and their aliases, the named face shapes the actions use (cheekPuff, tongueOut, …), and every part in the user's
 *   words (the skip notes and the card).
 * - The standard rest pose: the bundled Gene's skeleton (shared/retarget-gene-source.json). Every library motion was made and
 *   reviewed on Gene, so Gene's rest pose IS the standard pose; a separate canonical pose would only add one more conversion.
 * - The ruler: lengths in head sizes (chin to crown). Gene's body and face amounts in head units are the reference every
 *   other model is measured against (morph calibration, the structure check's drift, the model lab's comparisons).
 *
 * Pure data and small pure functions: no Three, no I/O, nothing here reads or changes a model file.
 */
import standardPoseData from './retarget-gene-source.json';

/** Model-space point (Three's MMDLoader coordinates: +y up, face toward +z, model's left at +x). */
export type Vec3 = [number, number, number];

// ---------------------------------------------------------------- the standard part table: names

/** NFKC, case-folded, separators removed: "Leg IK_L", "leg_ik.l" and "ＬｅｇＩＫ_Ｌ" compare equal. */
export function normalizeProfileName(name: string): string {
  return String(name ?? '').normalize('NFKC').trim().toLowerCase().replace(/[\s_.\-・]+/gu, '');
}

const sides = (left: string[], right: string[]) => ({ left, right });
const BONE_ALIASES = {
  root: ['全ての親', 'master', 'root', 'mother', '全亲骨'],
  center: ['センター', 'center', 'centre', '中心'],
  groove: ['グルーブ', 'groove'],
  waist: ['腰', 'waist'],
  lowerBody: ['下半身', 'lowerbody', 'hips', 'hip', 'pelvis'],
  upperBody: ['上半身', 'upperbody', 'spine'],
  upperBody2: ['上半身2', 'upperbody2', 'chest', 'spine1'],
  neck: ['首', 'neck', '颈', '頸', '脖子'],
  head: ['頭', 'head', '头'],
  eyes: ['両目', '両眼', 'eyes', 'botheyes', '双眼', '双目'],
  ...pair('eye', sides(['左目', '左眼', 'lefteye', 'eyel', 'leye', 'eyeleft'], ['右目', '右眼', 'righteye', 'eyer', 'reye', 'eyeright'])),
  ...pair('shoulder', sides(['左肩', 'leftshoulder', 'shoulderl', 'lshoulder'], ['右肩', 'rightshoulder', 'shoulderr', 'rshoulder'])),
  ...pair('arm', sides(['左腕', 'leftarm', 'leftupperarm', 'arml', 'upperarml', 'lupperarm', '左上臂', '左大臂'],
    ['右腕', 'rightarm', 'rightupperarm', 'armr', 'upperarmr', 'rupperarm', '右上臂', '右大臂'])),
  ...pair('armTwist', sides(['左腕捩', 'leftarmtwist', 'armtwistl', '左臂扭转'], ['右腕捩', 'rightarmtwist', 'armtwistr', '右臂扭转'])),
  ...pair('elbow', sides(['左ひじ', '左肘', 'leftelbow', 'leftforearm', 'leftlowerarm', 'elbowl', 'forearml', 'lowerarml', '左小臂', '左前臂'],
    ['右ひじ', '右肘', 'rightelbow', 'rightforearm', 'rightlowerarm', 'elbowr', 'forearmr', 'lowerarmr', '右小臂', '右前臂'])),
  ...pair('wristTwist', sides(['左手捩', 'leftwristtwist', 'wristtwistl', 'handtwistl', '左手扭转'], ['右手捩', 'rightwristtwist', 'wristtwistr', 'handtwistr', '右手扭转'])),
  ...pair('wrist', sides(['左手首', 'leftwrist', 'lefthand', 'wristl', 'handl', 'lhand', '左手腕'], ['右手首', 'rightwrist', 'righthand', 'wristr', 'handr', 'rhand', '右手腕'])),
  ...pair('leg', sides(['左足', 'leftleg', 'leftupperleg', 'legl', 'upperlegl', 'thighl', 'lthigh', '左腿', '左大腿'],
    ['右足', 'rightleg', 'rightupperleg', 'legr', 'upperlegr', 'thighr', 'rthigh', '右腿', '右大腿'])),
  ...pair('knee', sides(['左ひざ', '左膝', 'leftknee', 'leftlowerleg', 'kneel', 'lowerlegl', 'calfl', 'lcalf', '左小腿'],
    ['右ひざ', '右膝', 'rightknee', 'rightlowerleg', 'kneer', 'lowerlegr', 'calfr', 'rcalf', '右小腿'])),
  ...pair('ankle', sides(['左足首', 'leftankle', 'leftfoot', 'anklel', 'footl', 'lfoot', '左脚踝', '左踝'], ['右足首', 'rightankle', 'rightfoot', 'ankler', 'footr', 'rfoot', '右脚踝', '右踝'])),
  ...pair('toe', sides(['左つま先', '左足先', 'lefttoe', 'lefttoes', 'toel', 'toesl', '左脚尖'], ['右つま先', '右足先', 'righttoe', 'righttoes', 'toer', 'toesr', '右脚尖'])),
  ...pair('legIk', sides(['左足IK', 'leftlegik', 'leftfootik', 'legikl', 'footikl', '左腿IK', '左脚IK'], ['右足IK', 'rightlegik', 'rightfootik', 'legikr', 'footikr', '右腿IK', '右脚IK'])),
  ...pair('toeIk', sides(['左つま先IK', 'lefttoeik', 'toeikl', '左脚尖IK'], ['右つま先IK', 'righttoeik', 'toeikr', '右脚尖IK'])),
};
function pair<K extends string>(key: K, value: { left: string[]; right: string[] }) {
  return { [`${key}Left`]: value.left, [`${key}Right`]: value.right } as Record<`${K}Left` | `${K}Right`, string[]>;
}
export type StandardBone = keyof typeof BONE_ALIASES;
export const STANDARD_BONES = Object.freeze(Object.keys(BONE_ALIASES) as StandardBone[]);
/** Each standard bone's curated, ordered name aliases (MMD Japanese first). */
export const STANDARD_BONE_ALIASES: Readonly<Record<StandardBone, readonly string[]>> = BONE_ALIASES;
let aliasIndex: Map<string, StandardBone> | null = null;
/** The standard bone a name is an alias of (first listed wins), or null. */
export function standardBoneOfName(name: string): StandardBone | null {
  if (!aliasIndex) {
    aliasIndex = new Map();
    for (const key of STANDARD_BONES) for (const alias of BONE_ALIASES[key]) { const normalized = normalizeProfileName(alias); if (!aliasIndex.has(normalized)) aliasIndex.set(normalized, key); }
  }
  return aliasIndex.get(normalizeProfileName(name)) ?? null;
}
// ---------------------------------------------------------------- fingers (T-213)

/**
 * Finger joints in MMD numbering, the way the library's motions (authored on Gene) name them: the thumb 0–2 (0 is the
 * metacarpal), the other fingers 1–3. Tips (先, tip, end, nub) carry no motion and are not joints here.
 */
export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'] as const;
export type Finger = typeof FINGERS[number];
export const FINGER_JOINTS: Readonly<Record<Finger, readonly number[]>> = Object.freeze({ thumb: [0, 1, 2], index: [1, 2, 3], middle: [1, 2, 3], ring: [1, 2, 3], little: [1, 2, 3] });
export type FingerSlot = `${Finger}${0 | 1 | 2 | 3}${'Left' | 'Right'}`;
export const FINGER_SLOTS: readonly FingerSlot[] = Object.freeze((['Left', 'Right'] as const).flatMap(side =>
  FINGERS.flatMap(finger => FINGER_JOINTS[finger].map(joint => `${finger}${joint}${side}` as FingerSlot))));
export const fingerSlotSide = (slot: FingerSlot): 'left' | 'right' => slot.endsWith('Left') ? 'left' : 'right';

const JAPANESE_FINGERS: Readonly<Record<string, Finger>> = Object.freeze({
  親指: 'thumb', 拇指: 'thumb', 大拇指: 'thumb', 人指: 'index', 人差指: 'index', 人差し指: 'index', 食指: 'index',
  中指: 'middle', 薬指: 'ring', 無名指: 'ring', 无名指: 'ring', 小指: 'little',
});
const ENGLISH_FINGERS: Readonly<Record<string, Finger>> = Object.freeze({ thumb: 'thumb', index: 'index', pointer: 'index', middle: 'middle',
  ring: 'ring', little: 'little', pinky: 'little', pinkie: 'little' });
const JAPANESE_FINGER = new RegExp(`^(左|右)(?:手)?(${Object.keys(JAPANESE_FINGERS).sort((a, b) => b.length - a.length).join('|')})(\\d)?(先)?$`, 'u');
const TIP_WORDS = new Set(['tip', 'end', 'nub', 'top', '先']);
const SIDE_WORDS: Readonly<Record<string, 'left' | 'right'>> = Object.freeze({ left: 'left', l: 'left', right: 'right', r: 'right' });
/** proximal / intermediate / distal / metacarpal: the conventions disagree on which MMD joint they are, so they are never mapped. */
const JOINT_WORDS = new Set(['proximal', 'intermediate', 'distal', 'metacarpal']);

/** A finger bone by its name: side, finger, the written joint number (null: none or a word), and whether it is a tip. */
export interface FingerPart { side: 'left' | 'right'; finger: Finger; joint: number | null; tip: boolean }
/**
 * Reads a finger bone's name: MMD Japanese (右人指１, 左親指０, 右人指先), Chinese (左手食指1) and common English
 * (RightIndex1, Index1_R, LeftHandThumb1, J_Bip_L_Index1, thumb_l). NFKC first, so full- and half-width digits are the same.
 * Never guesses a joint from a word (proximal/intermediate/distal) or shifts a number: those come back with joint null.
 */
export function fingerPartOfName(name: string): FingerPart | null {
  const text = String(name ?? '').normalize('NFKC').trim();
  const japanese = JAPANESE_FINGER.exec(text);
  if (japanese) return { side: japanese[1] === '左' ? 'left' : 'right', finger: JAPANESE_FINGERS[japanese[2]], joint: japanese[3] ? Number(japanese[3]) : null, tip: !!japanese[4] };
  const tokens = text.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/([\x21-\x7e])([^\x00-\x7f])/gu, '$1 $2').replace(/([^\x00-\x7f])([\x21-\x7e])/gu, '$1 $2')
    .toLowerCase().split(/[\s_.\-:|]+/u).filter(Boolean);
  const sides = new Set(tokens.map(token => SIDE_WORDS[token]).filter(Boolean)), fingers = new Set(tokens.map(token => ENGLISH_FINGERS[token]).filter(Boolean));
  if (sides.size !== 1 || fingers.size !== 1) return null;
  const digits = tokens.filter(token => /^\d$/.test(token)), words = tokens.filter(token => JOINT_WORDS.has(token));
  const tip = tokens.some(token => TIP_WORDS.has(token));
  return { side: [...sides][0]!, finger: [...fingers][0]!, joint: digits.length === 1 && !words.length ? Number(digits[0]) : null, tip };
}

/** Missing any of these changes how motions and interactions can map (shown first in summaries). */
export const CORE_BONES: readonly StandardBone[] = Object.freeze(['center', 'upperBody', 'neck', 'head', 'armLeft', 'armRight',
  'elbowLeft', 'elbowRight', 'wristLeft', 'wristRight', 'legLeft', 'legRight', 'kneeLeft', 'kneeRight', 'ankleLeft', 'ankleRight']);

export const MORPH_SLOTS = ['a', 'i', 'u', 'e', 'o', 'blink', 'blinkLeft', 'blinkRight', 'smileEyes', 'mouthSmile',
  'sad', 'angry', 'surprise', 'shy', 'jitome', 'browUp', 'mouthPucker'] as const;
export type MorphSlot = typeof MORPH_SLOTS[number];
/** amplitude: displacement-calibrated; closure: an eyelid amount (1 = closed); overlay: a visibility layer such as blush. */
export type SlotPolicy = 'amplitude' | 'closure' | 'overlay';

/** Curated, ordered aliases: MMD Japanese first, then common English (incl. VRoid/ARKit/VRChat), Chinese, romaji. */
export const MORPH_ALIASES: Readonly<Record<MorphSlot, readonly string[]>> = Object.freeze({
  a: ['あ', 'ア', 'あ2', 'a', 'aa', 'mouth_a', 'mth_a', 'fcl_mth_a', 'vrc.v_aa', 'v_aa', '啊', '口開け', 'mouthopen', 'jawopen'],
  i: ['い', 'イ', 'い2', 'i', 'ih', 'mouth_i', 'mth_i', 'fcl_mth_i', 'vrc.v_ih', 'v_ih', '咿', '衣'],
  u: ['う', 'ウ', 'う2', 'u', 'ou', 'mouth_u', 'mth_u', 'fcl_mth_u', 'vrc.v_ou', 'v_ou', '呜', '乌'],
  e: ['え', 'エ', 'え2', 'e', 'ee', 'mouth_e', 'mth_e', 'fcl_mth_e', 'vrc.v_ee', 'v_ee', '诶', '额'],
  o: ['お', 'オ', 'お2', 'o', 'oh', 'mouth_o', 'mth_o', 'fcl_mth_o', 'vrc.v_oh', 'v_oh', '哦', '喔'],
  blink: ['まばたき', '瞬き', 'まばたき2', '目閉じ', 'とじ目', '閉じ目', 'blink', 'blink_both', 'eyeblink', 'eye_blink',
    'eyeclose', 'eye_close', 'eyesclosed', 'close_eyes', 'fcl_eye_close', 'mabataki', '眨眼', '闭眼', '閉眼'],
  blinkLeft: ['ウィンク', 'ウインク', 'まばたき左', 'まば左', '左まばたき', '左目閉じ', 'wink', 'wink_l', 'winkleft', 'blink_l',
    'blinkleft', 'eyeblinkleft', 'eyeblink_l', 'fcl_eye_close_l', '左眨眼', '左闭眼', '眨眼左'],
  blinkRight: ['ウィンク右', 'ウインク右', 'まばたき右', 'まば右', '右まばたき', '右目閉じ', 'wink_r', 'winkright', 'blink_r',
    'blinkright', 'eyeblinkright', 'eyeblink_r', 'fcl_eye_close_r', '右眨眼', '右闭眼', '眨眼右'],
  smileEyes: ['笑い', '笑い目', 'にこにこ', 'ニコ目', 'eye_smile', 'eyesmile', 'smile_eye', 'smileeyes', 'happy_eyes', 'fcl_eye_joy', 'warai', '笑眼', '眯眼笑'],
  mouthSmile: ['にっこり', 'にやり', '口角上げ', 'ニコ口', 'mouth_smile', 'mouthsmile', 'smile', 'fcl_mth_joy', 'fcl_mth_fun', '微笑', '笑口', '嘴角上扬'],
  sad: ['困る', '困り', '悲しい', 'しょんぼり', 'sad', 'troubled', 'brow_sad', 'sorrow', 'fcl_brw_sorrow', 'komaru', '难过', '悲伤', '伤心', '困扰'],
  angry: ['怒り', '怒', 'angry', 'anger', 'mad', 'brow_angry', 'fcl_brw_angry', 'ikari', '生气', '愤怒'],
  surprise: ['びっくり', '驚き', '見開き', 'surprise', 'surprised', 'eye_wide', 'eyewide', 'fcl_eye_surprised', 'fcl_brw_surprised', 'bikkuri', '惊讶', '吃惊'],
  shy: ['赤み', '頬照り', '照れ', '赤面', '頬染め', '頬赤', 'てれ', 'blush', 'cheek_blush', 'cheekblush', 'shy', 'embarrassed', 'tere', '害羞', '脸红', '臉紅', '红晕', '紅暈'],
  jitome: ['じと目', 'ジト目', '半目', 'jitome', 'half_closed', 'halfclosed', 'eyes_half', 'half_eye', '眯眼', '半闭眼', '死鱼眼'],
  browUp: ['上', '眉上', '眉上げ', 'まゆ上', '眉あげ', 'brow_up', 'browup', 'brows_up', 'browsup', 'browinnerup', 'brow_raise', 'browraise', 'eyebrow_up', 'eyebrowup',
    'fcl_brw_surprised', '挑眉', '抬眉', '扬眉', '眉毛上扬', '眉毛上挑'],
  // Skeleton step 2: 嘟嘴, a slot like the others (a name is a candidate; the lips must really move forward and draw in,
  // shared/model-profile.ts). Names only: haiku is not asked about it (plan question 3, no quota agreed;
  // shared/model-capability-check.ts FACE_ACTION_HAIKU_SLOTS is where it would go).
  mouthPucker: ['mouthpucker', 'pucker', 'mouth_pucker', 'mouthkiss', 'kiss', '口すぼめ', 'すぼめ', 'ちゅー', 'ちゅ', '嘟嘴', '噘嘴', '撅嘴'],
});

/**
 * The ruler for faces: near-max displacement / head size at weight 1, measured on the bundled Gene
 * (gene.pmx sha256 0ef63a75…, this algorithm). These anchor calibration: a
 * model whose mouth opens like Gene's gets 1.0; twice as far gets 0.5.
 */
export const REFERENCE_AMPLITUDE: Readonly<Partial<Record<MorphSlot, number>>> = Object.freeze({
  a: 0.1336, i: 0.02361, u: 0.1009, e: 0.04396, o: 0.1336, mouthSmile: 0.01390, sad: 0.05919, angry: 0.07370, surprise: 0.02519, browUp: 0.03675,
});

// ---------------------------------------------------------------- skeleton shape

/** Each mapped standard bone's nearest standard ancestor (walking through any other bones); null at the top. */
export function standardParents(bones: readonly { parent: number }[], slots: Partial<Record<StandardBone, number>>): Partial<Record<StandardBone, StandardBone | null>> {
  const slotOf = new Map<number, StandardBone>();
  for (const key of STANDARD_BONES) { const index = slots[key]; if (index !== undefined && !slotOf.has(index)) slotOf.set(index, key); }
  const out: Partial<Record<StandardBone, StandardBone | null>> = {};
  for (const key of STANDARD_BONES) {
    const index = slots[key];
    if (index === undefined || slotOf.get(index) !== key) continue;
    let parent: StandardBone | null = null;
    for (let at = bones[index]?.parent ?? -1, steps = 0; at >= 0 && steps <= bones.length; at = bones[at]?.parent ?? -1, steps++)
      if (slotOf.has(at)) { parent = slotOf.get(at)!; break; }
    out[key] = parent;
  }
  return out;
}

/**
 * The body chain whose place in the hierarchy decides where a motion carries it. Eyes (grants or hierarchy, by convention),
 * IK targets and toes vary between well-made models and are left out.
 */
export const STRUCTURE_BONES: readonly StandardBone[] = Object.freeze(['center', 'groove', 'waist', 'lowerBody', 'upperBody', 'upperBody2', 'neck', 'head',
  'shoulderLeft', 'shoulderRight', 'armLeft', 'armRight', 'armTwistLeft', 'armTwistRight', 'elbowLeft', 'elbowRight', 'wristTwistLeft', 'wristTwistRight',
  'wristLeft', 'wristRight', 'legLeft', 'legRight', 'kneeLeft', 'kneeRight', 'ankleLeft', 'ankleRight'] as StandardBone[]);
export interface StructureDifference { bone: StandardBone; expected: StandardBone | null; actual: StandardBone | null }
/**
 * T-213: body bones that hang somewhere else than in the reference skeleton. Only bones both skeletons have are compared, and
 * each side's nearest ancestor is the nearest one the other skeleton also has: a bone one model simply lacks (no 上半身2, no
 * 腰) is not a difference (the retarget folds its motion), a head moved from under the neck to under the center is.
 */
export function structureDifferences(expected: Partial<Record<StandardBone, StandardBone | null>>,
  actual: Partial<Record<StandardBone, StandardBone | null>>): StructureDifference[] {
  const both = (bone: StandardBone) => bone in expected && bone in actual;
  const nearest = (parents: Partial<Record<StandardBone, StandardBone | null>>, bone: StandardBone): StandardBone | null => {
    let at = parents[bone] ?? null;
    for (let steps = 0; at !== null && !both(at) && steps < 64; steps++) at = parents[at] ?? null;
    return at !== null && both(at) ? at : null;
  };
  const out: StructureDifference[] = [];
  for (const bone of STRUCTURE_BONES) {
    if (!both(bone)) continue;
    const want = nearest(expected, bone), have = nearest(actual, bone);
    if (want !== have) out.push({ bone, expected: want, actual: have });
  }
  return out;
}

// ---------------------------------------------------------------- the standard pose (Gene's)

/** One standard bone of the standard pose: its slot, Gene's own name, its nearest standard parent (index into `bones`), its rest position. */
export interface StandardPoseBone { slot: StandardBone; name: string; parent: number; position: Vec3 }
/**
 * Skeleton step 3: one finger joint (slot) or fingertip (slot null) of the standard pose: Gene's own name, its parent as an index
 * into [...bones, ...fingers], its rest position. The hand alignment reads the palm and finger rest frames from these.
 */
export interface StandardPoseFinger { slot: FingerSlot | null; name: string; parent: number; position: Vec3 }
/** The standard pose as shipped (the compact source rig of the motion conversion, shared/motion-retarget.ts CompactRig). */
export interface StandardPose {
  version: number;
  /** "gene:<sha256 of gene.pmx>": the reviewed model this pose was read from. */
  key: string;
  bones: StandardPoseBone[];
  /** Gene's 30 finger joints and 10 fingertips (skeleton step 3). */
  fingers?: StandardPoseFinger[];
  height: number; legLength: number | null; armLength: number | null; shoulderWidth: number | null; headSize: number;
  morphSlots: Partial<Record<MorphSlot, { name: string; amplitude: number; policy: SlotPolicy }>>;
  /** Gene's fitted body capsules (validated where they are used, shared/collision-proxy.ts). */
  collision?: unknown;
}
/** Gene's rest skeleton, the pose every library motion was authored and reviewed on. Treat as read-only. */
export const STANDARD_POSE: Readonly<StandardPose> = standardPoseData as StandardPose;
/** The standard pose's slot of a bone name (Gene's own names: 左腕 → armLeft), or null. */
const STANDARD_POSE_SLOT = new Map<string, StandardBone>(STANDARD_POSE.bones.map(bone => [bone.name, bone.slot]));
/** Each standard bone's nearest standard ancestor in the standard pose (the skeleton shape every motion expects). */
export const STANDARD_PARENTS: Readonly<Partial<Record<StandardBone, StandardBone | null>>> = (() => {
  const slots: Partial<Record<StandardBone, number>> = {};
  STANDARD_POSE.bones.forEach((bone, index) => { slots[bone.slot] = index; });
  return Object.freeze(standardParents(STANDARD_POSE.bones, slots));
})();

/** A finger track's joint (MMD numbering) from its name, or null (a tip, another numbering, not a finger). */
export function fingerSlotOfName(name: string): FingerSlot | null {
  const part = fingerPartOfName(name);
  if (!part || part.tip || part.joint === null) return null;
  const slot = `${part.finger}${part.joint}${part.side === 'left' ? 'Left' : 'Right'}` as FingerSlot;
  return FINGER_SLOTS.includes(slot) ? slot : null;
}
/**
 * The standard part a library motion's track drives: a standard bone by the standard pose's name (左腕 → armLeft), else a
 * finger joint by its name (右人指１ → index1Right); null for anything else. Plain part ids, never a model's own names.
 */
export function standardPartOfTrack(name: string): StandardBone | FingerSlot | null {
  return STANDARD_POSE_SLOT.get(name) ?? fingerSlotOfName(name);
}
export const isStandardPart = (value: unknown): value is StandardBone | FingerSlot =>
  typeof value === 'string' && ((STANDARD_BONES as readonly string[]).includes(value) || (FINGER_SLOTS as readonly string[]).includes(value));

// ---------------------------------------------------------------- the ruler (head sizes)

/** A length in head sizes (chin to crown, hair included): plain division, exactly what every caller computed before. */
export const inHeads = (length: number, headSize: number): number => length / headSize;
export interface BodyInHeads { height: number; shoulderWidth: number | null; armLength: number | null; legLength: number | null }
/** A body's main lengths in its own head sizes (null where it has no such length). */
export function bodyInHeads(body: { height: number; headSize: number; shoulderWidth: number | null; armLength: number | null; legLength: number | null }): BodyInHeads {
  const ruler = (length: number | null) => length === null ? null : inHeads(length, body.headSize);
  return { height: inHeads(body.height, body.headSize), shoulderWidth: ruler(body.shoulderWidth), armLength: ruler(body.armLength), legLength: ruler(body.legLength) };
}
/** The standard body (Gene) in head sizes: the reference the other models' proportions are compared with. */
export const STANDARD_BODY_IN_HEADS: Readonly<BodyInHeads> = Object.freeze(bodyInHeads(STANDARD_POSE));

// ---------------------------------------------------------------- named face shapes

/**
 * Face shapes the library's face actions (shared/her-actions.ts) use beyond the standard face slots, by Gene's own morph name,
 * with other names for them on other models (compared NFKC, lower case, without spaces, "_", "-" and "."). The model profile
 * finds each once (by these names, then real vertex movement), so the card can say what the stage will find.
 */
export const NAMED_FACE_SHAPES = Object.freeze({
  cheekPuff: Object.freeze(['cheekpuff', 'cheek_puff', 'ぷくー', 'ぷく', '頬膨らみ', '頬膨らまし', 'ほっぺ膨らまし', '鼓腮']),
  mouthFrownLeft: Object.freeze(['mouthfrownleft', 'mouthfrown_l', 'mouth_frown_l']),
  mouthFrownRight: Object.freeze(['mouthfrownright', 'mouthfrown_r', 'mouth_frown_r']),
  tongueOut: Object.freeze(['tongueout', 'tongue_out', '舌出し', 'べー', 'ぺろっ', '吐舌']),
  // Skeleton step 2: both mouth corners down (MMD's 口角下げ / ∧): part of the stand-in for 嘟嘴 on a model without frowns.
  mouthCornersDown: Object.freeze(['口角下げ', '口角さげ', 'mouthcornersdown', 'cornersdown', 'mouthfrown', 'frown', '∧', 'へ', '嘴角下垂', '嘴角向下']),
} as const);
export type NamedFaceShape = keyof typeof NAMED_FACE_SHAPES;
export const NAMED_FACE_SHAPE_IDS = Object.freeze(Object.keys(NAMED_FACE_SHAPES) as NamedFaceShape[]);
export const isNamedFaceShape = (value: unknown): value is NamedFaceShape => typeof value === 'string' && Object.prototype.hasOwnProperty.call(NAMED_FACE_SHAPES, value);

// ---------------------------------------------------------------- parts in the user's words

/** A standard bone in the user's words (the skip notes, the card). */
export const STANDARD_PART_WORDS: Readonly<Partial<Record<StandardBone, string>>> = Object.freeze({
  armLeft: '左上臂', elbowLeft: '左前臂', wristLeft: '左手腕', armRight: '右上臂', elbowRight: '右前臂', wristRight: '右手腕',
  neck: '脖子', head: '头部', upperBody: '上半身', upperBody2: '胸（上半身2）', eyeLeft: '左眼', eyeRight: '右眼',
  center: '身体中心', groove: '重心骨', waist: '腰', lowerBody: '下半身', shoulderLeft: '左肩', shoulderRight: '右肩',
  armTwistLeft: '左上臂扭转', armTwistRight: '右上臂扭转', wristTwistLeft: '左手扭转', wristTwistRight: '右手扭转',
  legLeft: '左腿', legRight: '右腿', kneeLeft: '左膝', kneeRight: '右膝', ankleLeft: '左脚踝', ankleRight: '右脚踝',
});
/** A finger in the user's words. */
export const FINGER_WORDS: Readonly<Record<Finger, string>> = Object.freeze({ thumb: '拇指', index: '食指', middle: '中指', ring: '无名指', little: '小指' });
/** Each hand's fingers in the user's words (the skip note says exactly which hand lacks them). */
export const HAND_FINGER_WORDS = Object.freeze({ left: '左手手指', right: '右手手指' } as const);
