/**
 * Unbound v1 step 2 (step 5 reuses it for pulls, companion and Unbound): which part of her a click landed on, from the name of the bone that owns the nearest piece of her silhouette
 * (docs/claude/2026-11-15-unbound-v1-step2-typing.md). Names only, no model-specific bone numbers (I-024: uploaded models too);
 * a bone that tells nothing (a numbered helper bone) lends its parent's name, so a loose hair strand under the head is still
 * hair and an unnamed finger bone under the wrist is still the hand.
 *
 * The side is HER left or right: MMD names say it (左 / 右, and the usual _L / .R / Left / Right spellings). The chest, belly,
 * hips and skirt are all 'torso' on purpose (shared/mood/touch.ts). Anything unknown is 'other' without a side.
 */
import type { TouchPart } from './touch';

export interface BoneTouch { part: TouchPart; side: 'left' | 'right' | null }

/** Parts whose side is worth telling her (a left hand, a right twin-tail); the others never carry one. */
const SIDED: ReadonlySet<TouchPart> = new Set<TouchPart>(['hair', 'face', 'shoulder', 'arm', 'hand', 'leg', 'foot']);

/** Order matters: the first rule that matches decides (hair before head, twist before hand, ankle before leg...). */
const RULES: readonly (readonly [RegExp, TouchPart])[] = [
  [/髪|ヘア|hair|ツイン|ポニ|アホ毛|おさげ|ponytail|twintail|bangs/i, 'hair'],
  [/スカート|skirt|裙/i, 'torso'],
  [/目|眼|eye|まぶた|瞼|口|mouth|舌|tongue|顎|jaw|歯|teeth|眉|brow|顔|face/i, 'face'],
  [/頭|head/i, 'head'],
  [/^首|neck/i, 'other'], // the neck only by its own name: 手首 and 足首 are a wrist and an ankle
  [/肩|shoulder|鎖骨|clavicle/i, 'shoulder'],
  [/腕捩|手捩|腕|ひじ|肘|arm|elbow|twist/i, 'arm'],
  [/手首|手|指|hand|wrist|finger|thumb/i, 'hand'],
  [/足首|足先|つま先|爪先|足IK|foot|ankle|toe/i, 'foot'],
  [/足|ひざ|膝|もも|leg|knee|thigh/i, 'leg'],
  [/上半身|下半身|センター|グルーブ|腰|胸|腹|尻|乳|spine|chest|hips|pelvis|waist|torso|body|root|center|bust/i, 'torso'],
];

/** The side a bone's name states, or null (both or neither). */
export function sideOfBoneName(name: string): 'left' | 'right' | null {
  const n = name.normalize('NFKC');
  const left = n.includes('左') || /(^|[_.\-\s])(l|left)([_.\-\s]|$)|left|[a-z0-9][_.\-]l$/i.test(n);
  const right = n.includes('右') || /(^|[_.\-\s])(r|right)([_.\-\s]|$)|right|[a-z0-9][_.\-]r$/i.test(n);
  if (left === right) return null;
  return left ? 'left' : 'right';
}

/** What one bone's name says about the part, or null when it says nothing. */
export function partOfBoneName(name: string): TouchPart | null {
  const n = name.normalize('NFKC');
  for (const [pattern, part] of RULES) if (pattern.test(n)) return part;
  return null;
}

/**
 * The part and side for a bone, from its name and its ancestors' names (the hit bone first, the root last). The first name that
 * says a part decides; the side is the first side stated by that bone or any bone between it and the hit bone.
 */
export function touchOfBoneChain(names: readonly string[]): BoneTouch {
  let side: 'left' | 'right' | null = null;
  for (const name of names) {
    side ??= sideOfBoneName(name);
    const part = partOfBoneName(name);
    if (part) return { part, side: SIDED.has(part) ? side : null };
  }
  return { part: 'other', side: null };
}

/** Eye bones by name (the eye line a head pat is measured from); the standard skeleton and MMD spell them these ways. */
const EYE_BONE_NAME = /^(左目|右目|左眼|右眼|LeftEye|RightEye|left_?eye|right_?eye)$/i;
export const isEyeBoneName = (name: string): boolean => EYE_BONE_NAME.test(name.normalize('NFKC'));

/**
 * How far above the eye line a spot must be, in eye spacings, to be the top or side of her head (the brows are about half a spacing
 * up; the forehead and hair above them are head). A measured shape, not a count: the whole head is touched by hand, not just the
 * bone that happens to own the nearest pixel (2026-11-24 head-pat record).
 */
export const HEAD_TOP_FROM_EYES = 0.6;

/**
 * A touch on hair or face that sits on the head and above the eye line is the head for a stroke or a press: Gene's right side hair
 * is named hair (右横髪) while her left side hangs on the head bone, so the same pat was a head on one half and a hair or a face
 * on the other. Hair that hangs below the head (a twin-tail) and the cheek (below the eyes) keep their own parts.
 * `chain`: the hit bone's name first, then its ancestors; `aboveEyes`: the hit's height over the eye line in eye spacings (null: unknown).
 */
export function headTopTouch(touch: BoneTouch, chain: readonly string[], aboveEyes: number | null): BoneTouch {
  if (touch.part !== 'hair' && touch.part !== 'face') return touch;
  if (aboveEyes === null || !(aboveEyes >= HEAD_TOP_FROM_EYES)) return touch;
  if (!chain.some(name => partOfBoneName(name) === 'head')) return touch;
  return { part: 'head', side: null };
}
