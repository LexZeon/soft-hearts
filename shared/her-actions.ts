/**
 * 她的动作 (docs/claude/2026-11-04-codex-actions.md): the closed set of one-shot actions Codex made for soft hearts next
 * (T-211, 2026-11-04) and the project ships in assets/bundled/soft-hearts-next/soft-hearts-actions. Pure data and checks: no
 * Electron, no Three, no I/O.
 *
 * - Only an action id crosses between the windows and the host; the host turns it into a short-lived cue, and the stage
 *   resolves the cue to the one pinned VMD (sha256 below, checked again by the host against the bytes).
 * - Two ways of composing, as Codex made them:
 *     arms  — absolute local rotations of the arm chain and fingers (from Gene's Stand, back to it at the end); the stage
 *             blends the live arm toward them by a weight sized by the angle (R29f), so a base that is not the Stand
 *             still starts and ends smoothly;
 *     delta — head / neck / upper-body rotations that start and end at identity; the stage multiplies them onto the live
 *             pose (base · delta), so gaze, breathing and the idle keep running underneath.
 *     face  — (T-215, 2026-11-05) morph-only face shapes on the mouth or the eyelids (鼓腮、撅嘴、眨一只眼、吐舌头). They share
 *             vertices with the phonemes, the blink and the eye smile, so the stage plays them as a short exclusive request
 *             (src/stage/face-exclusive.ts): the whole conflicting morph group is written once, speech and blinks hand over
 *             smoothly. No bone tracks.
 * - `required` are the standard bones (shared/model-profile.ts) a model must have for the action; without one of them the
 *   action is skipped and the note says which part is missing. Fingers are optional except where the hand shape is the
 *   action (the heart). A face action names its morphs instead (`face.morphs`): a model without a required one skips it.
 */
import { profileBoneState, profileFingerCount, type ModelProfile } from './model-profile';
import { HAND_FINGER_WORDS, MORPH_ALIASES, NAMED_FACE_SHAPES, STANDARD_PART_WORDS, fingerPartOfName, type MorphSlot, type StandardBone } from './universal-skeleton';
import { resolveFaceMorphs, type FaceApproximation } from './face-morphs';

export const HER_ACTION_PACK = 'soft-hearts-actions' as const;
export const HER_ACTIONS = ['hello-wave', 'goodbye-wave', 'nod', 'shake', 'tilt', 'lean', 'cover-face', 'hide-laugh', 'open-arms', 'air-hug',
  'clap', 'cheer', 'bow', 'apology-bow', 'two-hand-heart', 'point', 'hands-on-hips', 'cover-yawn', 'eat-mime',
  'cheek-puff', 'pout', 'wink', 'tongue-out'] as const;
export type HerActionId = typeof HER_ACTIONS[number];
export type HerActionMode = 'arms' | 'delta' | 'face';
/** The body actions (her-action.ts plays these); `face` goes to the face exclusive instead. */
export type HerBodyMode = Exclude<HerActionMode, 'face'>;
/** T-215: which face channel a face action holds for its short while. Never the gaze (eye bones, head). */
export type HerFaceScope = 'mouth' | 'eyelids';
export interface HerFaceMorph {
  /** The morph name in the VMD (the bundled Gene's own name). */
  readonly track: string;
  /** The model profile's slot for it (a vertex-checked index), or null: found by `track` and `aliases`. */
  readonly slot: MorphSlot | null;
  /** Other names for it on other models (compared NFKC, lower case, without spaces, "_", "-" and "."). */
  readonly aliases: readonly string[];
  /** Without it the action is skipped (the note names `part`); an optional one is simply left out. */
  readonly required: boolean;
  /** The part in the user's words (the skip note). */
  readonly part: string;
  /**
   * Skeleton step 2: what stands in when this model lacks the morph (null: nothing). Every required part must be there;
   * then the action plays as an approximation and the card says so. Neither the morph nor its stand-in: the morph is missing.
   */
  readonly standIn: readonly HerFaceStandIn[] | null;
}
/** One of the model's own shapes standing in for a missing face morph, driven by a clip track's keys times `gain`. */
export interface HerFaceStandIn {
  /** Found like a face morph: the profile slot, else this name and the aliases. */
  readonly track: string;
  readonly slot: MorphSlot | null;
  readonly aliases: readonly string[];
  /** The clip track whose keys drive it. */
  readonly from: string;
  /** Times the clip's value (below 1: lighter than the real shape). */
  readonly gain: number;
  readonly required: boolean;
  /** In the user's words (the card's 近似 line, the missing note). */
  readonly words: string;
  /** Not added when these clip morphs are on the model already (they write the same thing); its words still count. */
  readonly unless: readonly string[];
}
export interface HerFaceSpec { readonly scope: HerFaceScope; readonly morphs: readonly HerFaceMorph[] }

export interface HerActionSpec {
  readonly id: HerActionId;
  /** What the user calls it (test commands, notes). */
  readonly name: string;
  readonly mode: HerActionMode;
  /** The catalog motion's pinned content hash (shared/motion-catalog.json, pack soft-hearts-actions). */
  readonly sha256: string;
  /** Last keyframe index at 30 fps (the catalog's durationFrames). */
  readonly durationFrames: number;
  readonly required: readonly StandardBone[];
  /** The finger tracks are the action itself (the heart, the pointing index finger): a model without them on that hand skips it. */
  readonly needsFingers: false | 'right' | 'both';
  /**
   * Played together with an existing face-and-head reaction on the same clock: 'yawn' is the P1 yawn (pose-reaction-stage.ts:
   * the small-o mouth, narrowed lids, chin) that the hand covers. The stage offers it as one local cue; its own owners decide.
   */
  readonly companion: 'yawn' | null;
  /**
   * Played slower than authored (≤ 1; its peak angular acceleration scales by rate²) and/or smaller (strength ≤ 1), only where the
   * real 24 fps window caught it: the shake's quick reversals left the display guard a jump on a late frame (pretrial 2026-11-04).
   */
  readonly rate: number;
  readonly strength: number;
  /** Which body parts move, in the user's words. */
  readonly parts: string;
  /** T-215: a face action's channel and morphs (null for the body actions). */
  readonly face: HerFaceSpec | null;
}

const RIGHT_ARM: readonly StandardBone[] = ['armRight', 'elbowRight', 'wristRight'];
const BOTH_ARMS: readonly StandardBone[] = ['armLeft', 'elbowLeft', 'wristLeft', ...RIGHT_ARM];
const HEAD: readonly StandardBone[] = ['neck', 'head'];
const BOW: readonly StandardBone[] = ['upperBody', 'upperBody2', 'neck', 'head'];

const spec = (id: HerActionId, name: string, mode: HerBodyMode, sha256: string, durationFrames: number, required: readonly StandardBone[],
  parts: string, needsFingers: HerActionSpec['needsFingers'] = false, companion: HerActionSpec['companion'] = null, rate = 1, strength = 1): HerActionSpec =>
  Object.freeze({ id, name, mode, sha256, durationFrames, required: Object.freeze([...required]), needsFingers, companion, rate, strength, parts, face: null });
const morph = (track: string, slot: MorphSlot | null, required: boolean, part: string, aliases: readonly string[] = [],
  standIn: readonly HerFaceStandIn[] | null = null): HerFaceMorph =>
  Object.freeze({ track, slot, required, part, aliases: Object.freeze([...aliases]), standIn: standIn ? Object.freeze([...standIn]) : null });
const standIn = (track: string, slot: MorphSlot | null, from: string, gain: number, required: boolean, words: string, aliases: readonly string[] = [],
  unless: readonly string[] = []): HerFaceStandIn =>
  Object.freeze({ track, slot, from, gain, required, words, aliases: Object.freeze([...aliases]), unless: Object.freeze([...unless]) });
/**
 * Skeleton step 2: 撅嘴 without a 嘟嘴 shape is the model's own "う" driven by the pucker's keys at this gain (0.9 → 0.54: above
 * the clip's own う at 0.42, lighter than a real pucker), plus both mouth corners down when the model has no frowns of its own.
 */
export const POUT_STAND_IN_GAIN = 0.6;
const face = (id: HerActionId, name: string, sha256: string, durationFrames: number, scope: HerFaceScope, parts: string, morphs: readonly HerFaceMorph[]): HerActionSpec =>
  Object.freeze({ id, name, mode: 'face', sha256, durationFrames, required: Object.freeze([]), needsFingers: false, companion: null, rate: 1, strength: 1, parts,
    face: Object.freeze({ scope, morphs: Object.freeze([...morphs]) }) });

/** The pinned table. A test keeps it equal to the catalog; the host checks the bytes against `sha256` again. */
export const HER_ACTION_SPECS: Readonly<Record<HerActionId, HerActionSpec>> = Object.freeze({
  'hello-wave': spec('hello-wave', '打招呼', 'arms', '054535602c51b9c515ec0d4c5ae1a9d91cff5a521083bd2e855ae7523df2befd', 112, RIGHT_ARM, '右臂和右手'),
  'goodbye-wave': spec('goodbye-wave', '说再见', 'arms', '8171c5bace8761512c06dffde3cd8bde90ac4689937348980669d8a110a9f046', 143, RIGHT_ARM, '右臂和右手'),
  nod: spec('nod', '点头', 'delta', '8a718296679017ae0af40644886bc859ade3130f7cabc3c55c4101af3bc66bde', 28, HEAD, '脖子和头'),
  shake: spec('shake', '摇头', 'delta', 'a55953ab28436a0cb8d17e6236273aac13320dff7ad460accf149ff08047d82e', 40, HEAD, '脖子和头', false, null, 0.8, 0.75),
  tilt: spec('tilt', '歪头', 'delta', '3356a4a8666b03598662ff6722cb740cade63ecf7e70f9fe2ed74992c425635c', 43, HEAD, '脖子和头'),
  lean: spec('lean', '凑近看', 'delta', 'da847b5de91fa62a6a66e6baccab91318bfc1b4890e1c43f5985d71c3b6f96ba', 47, BOW, '上身、脖子和头'),
  'cover-face': spec('cover-face', '捂脸', 'arms', '4ba363e0c35f6f6a585bd61c1efb8ad5b57207aba042ddcec451f6a1c51f6e93', 123, BOTH_ARMS, '双臂和双手'),
  'hide-laugh': spec('hide-laugh', '遮嘴笑', 'arms', 'ab928f4a14a5d326409cc0a7127f6cbe0a3f52e18896683753b41759b432e852', 96, RIGHT_ARM, '右臂和右手'),
  'open-arms': spec('open-arms', '张开手臂', 'arms', 'dc7a5a3be7f4c8c080a605484a4bfe592a49d826f6a5bf175d3f032b4b481e4b', 89, BOTH_ARMS, '双臂和双手'),
  'air-hug': spec('air-hug', '抱抱', 'arms', '2ca5d8d38d81f1769e96c57a4544d4a7d3d25051902e3b2e1cade1420b5782a2', 116, BOTH_ARMS, '双臂和双手'),
  // Batch 009 revision (2026-11-05): opens wide and claps three times (near at f56, f83, f110; open again f123; Stand at f163).
  // The old 96-frame length would cut the third clap and the way back: catalog, this table and the host duration move together.
  clap: spec('clap', '鼓掌', 'arms', '852bbcfd502172fd7f9a9801540ec43580c633f0287d6191527a7950b9c5f576', 163, BOTH_ARMS, '双臂和双手'),
  cheer: spec('cheer', '欢呼', 'arms', 'bcbfb63009abbd0911f74dbb5263cbcdd96ddc332453e2ef463ec7e9798ad297', 120, BOTH_ARMS, '双臂和双手'),
  bow: spec('bow', '鞠躬', 'delta', '679bb6313111408d0e5081c4e5f12f19ca4f1dd6a65ae2489b648e1cb525f1ed', 66, BOW, '上身、脖子和头'),
  'apology-bow': spec('apology-bow', '道歉', 'delta', '6fd170fbd0d1acb02d4c0f3d404b0ecedd2c2e40e28a958857f3f9820efb3aae', 48, BOW, '上身、脖子和头'),
  'two-hand-heart': spec('two-hand-heart', '比心', 'arms', 'ca14e77390e7dc5efb4ffc1ab48ca40a3ce7cf6ea6208c616c5bb83edb15b643', 177, BOTH_ARMS, '双臂和双手（手指比出心形）', 'both'),
  // Batch 005 (Codex, dev cbab48c), revised in batch 009 (2026-11-05): the elbow bends down and the wrist comes in so the hand stays
  // in a half-body frame; the pointing direction is still the same fixed synthetic one, not anything on the screen.
  point: spec('point', '指一指', 'arms', '120729f343ce1b9f3e411e46ace5fb80314ce6e123df1247726e800f88b94751', 109, RIGHT_ARM, '右臂和右手（伸出食指）', 'right'),
  'hands-on-hips': spec('hands-on-hips', '叉腰', 'arms', '88e959e290a64c334851e3d94f875fcf8d03461fc57945a05db41fc166fb92fa', 141, BOTH_ARMS, '双臂和双手'),
  'cover-yawn': spec('cover-yawn', '哈欠捂嘴', 'arms', 'bd2130f26d81a374e0660af1ac90bdf23015ca5602aefa3a8d1367257eeb7990', 138, RIGHT_ARM,
    '右手捂嘴，嘴和眼睛是原来的哈欠', false, 'yawn'),
  // Batch 007: the hand only; no food, no mouth, no reward (Codex's ball and chewing were only in its own render scene).
  'eat-mime': spec('eat-mime', '拿着吃', 'arms', '71e0c8ec630abe4bf57951fb08ebeab52b0613b9e366d44518e67bd19d116c3e', 174, RIGHT_ARM, '右臂和右手（只有手的动作，没有食物也不张嘴）'),
  // T-215 (2026-11-05): Codex's morph-only face shapes, T-211 batches 006 and 007, bytes as delivered.
  'cheek-puff': face('cheek-puff', '鼓腮', 'f88f34af4a5a5c1d944144d75349bacb4eeee7c632cb757efb1e0a672c460c5a', 55, 'mouth', '脸颊（嘴的一部分）', [
    morph('cheekPuff', null, true, '鼓腮的表情（cheekPuff）', NAMED_FACE_SHAPES.cheekPuff),
  ]),
  // Codex's second round: mouthPucker alone read too weak, so う and both mouth corners come with it (one mouth shape).
  pout: face('pout', '撅嘴', '9d4bf07743ec0d63975c60568ec0792173f2aaedf5c76c1a97b60dd77d434450', 62, 'mouth', '嘴', [
    // Skeleton step 2: a vertex-checked slot; without it, "う" plus the mouth corners stand in (lighter; the card says 近似).
    morph('mouthPucker', 'mouthPucker', true, '嘟嘴的表情（mouthPucker）', MORPH_ALIASES.mouthPucker, [
      standIn('う', 'u', 'mouthPucker', POUT_STAND_IN_GAIN, true, '口型“う”'),
      standIn('mouthCornersDown', null, 'mouthFrownLeft', 1, false, '嘴角下压的表情', NAMED_FACE_SHAPES.mouthCornersDown, ['mouthFrownLeft', 'mouthFrownRight']),
    ]),
    morph('う', 'u', false, '口型“う”'),
    morph('mouthFrownLeft', null, false, '左嘴角下压', NAMED_FACE_SHAPES.mouthFrownLeft),
    morph('mouthFrownRight', null, false, '右嘴角下压', NAMED_FACE_SHAPES.mouthFrownRight),
  ]),
  // The model's +X eye (on screen: her left eye, the right one in the picture). The other eye and both eyeballs keep moving.
  wink: face('wink', '眨一只眼', '39c5e05375d1824a923488d2a28fb22a02545bc4c8d2ed286a51a0377ef2a7d0', 16, 'eyelids', '一侧眼皮', [
    // Skeleton step 2: no wink of that eye of its own: the other eye's (the model's right) stands in, as authored.
    morph('ウィンク', 'blinkLeft', true, '单眼闭眼的表情（ウィンク）', [], [standIn('ウィンク右', 'blinkRight', 'ウィンク', 1, true, '右眼单独闭的表情（ウィンク右）')]),
  ]),
  // Opens the mouth first, then the tongue; the tongue goes back before the mouth closes: one mouth request, never two.
  'tongue-out': face('tongue-out', '吐舌头', '30f463f4a925d4f0613b0b84458cd6eede31c937737d0fb5fc5a2b3bbdb42342', 36, 'mouth', '嘴和舌头', [
    morph('あ', 'a', true, '张嘴口型（あ）'),
    morph('tongueOut', null, true, '吐舌的表情（tongueOut）', NAMED_FACE_SHAPES.tongueOut),
  ]),
});
/** The body actions (her-action.ts), in table order. */
export const HER_BODY_ACTIONS = HER_ACTIONS.filter(id => HER_ACTION_SPECS[id].mode !== 'face');
/** T-215: the face actions (face-exclusive.ts), in table order. */
export const HER_FACE_ACTIONS = HER_ACTIONS.filter(id => HER_ACTION_SPECS[id].mode === 'face');

export const isHerActionId = (value: unknown): value is HerActionId => typeof value === 'string' && (HER_ACTIONS as readonly string[]).includes(value);
/** Playback length (ms): the clip's frames at 30 fps, slowed by its rate. */
export const herActionDurationMs = (id: HerActionId): number => HER_ACTION_SPECS[id].durationFrames / 30 * 1_000 / HER_ACTION_SPECS[id].rate;

/** A standard bone in the user's words (the skip note): the universal skeleton's table (shared/universal-skeleton.ts). */
export const HER_ACTION_PART_NAMES = STANDARD_PART_WORDS;
/** The finger parts in the skip note (T-213: which hand, so the note says exactly what this model lacks). */
export const HER_ACTION_FINGER_PARTS = HAND_FINGER_WORDS;

/** Why the stage did not start it (busy) or could not play it (failed); fixed copy, so the note can be translated. */
export const HER_ACTION_DETAILS = Object.freeze({
  hidden: '桌宠现在没显示', contact: '你正在摸她或喂她', adjusting: '正在调整窗口或镜头', game: '她正在和你猜拳', music: '她正在听音乐',
  manual: '动作库里手选的动作优先', preview: '正在预览别的动作', previous: '她还在做上一个动作',
  noModel: '还没有载入模型', resource: '动作资源不对', noTracks: '这个模型没有能播放的动作轨', load: '动作没能载入',
  // T-215 face actions: the mouth and the eyelids have owners above a short face shape.
  speaking: '她正在说话', eyesClosed: '她正闭着眼', blinking: '她正在眨眼', reaction: '她正在做别的表情', manualFace: '手选的表情优先',
  mouthOff: '角色页关了“有口型”', eyesOff: '角色页关了“能闭眼”', previousFace: '她还在做上一个表情',
  /** Skeleton step 2, with 'played': the model lacks the shape, so it was built from its own near ones (the card says which). */
  approximate: '近似',
  /** T-213: the fit check found a body part hanging elsewhere in this skeleton than in the standard one (the parts are in `missing`). */
  structure: '骨架层级和标准不同',
} as const);

/** One request, host → every window. Lives a few seconds; a window plays each id at most once. */
export interface HerActionCue { id: string; action: HerActionId; at: number; expiresAt: number }
/** What the stage gets for a cue (the host checked the bytes against the pinned hash). */
export interface HerActionResource { cueId: string; action: HerActionId; packId: typeof HER_ACTION_PACK; motionId: HerActionId; url: string; sha256: string; durationMs: number }
/** The pet stage's answer, stage → host (the test note says what happened). */
export type HerActionStatus = 'played' | 'missing' | 'unfit' | 'busy' | 'failed';
export interface HerActionOutcome { cueId: string; status: HerActionStatus; missing: string[]; detail: string }
/** What a test command gets back: the pet's answer, or that no pet window was there, or no answer in time. */
export interface HerActionPlayResult { status: HerActionStatus | 'no-window' | 'no-answer'; missing: string[]; detail: string }
/** How long a cue may wait for the stage, and how long the host waits for the pet's answer. */
export const HER_ACTION_CUE_MS = 8_000;

const CUE_ID = /^[a-zA-Z0-9_-]{1,160}$/;
export function isHerActionCue(value: unknown): value is HerActionCue {
  if (!value || typeof value !== 'object') return false;
  const cue = value as Record<string, unknown>;
  return Object.keys(cue).every(key => ['id', 'action', 'at', 'expiresAt'].includes(key)) && typeof cue.id === 'string' && CUE_ID.test(cue.id)
    && isHerActionId(cue.action) && typeof cue.at === 'number' && typeof cue.expiresAt === 'number' && Number.isFinite(cue.at)
    && Number.isFinite(cue.expiresAt) && cue.expiresAt > cue.at && cue.expiresAt - cue.at <= HER_ACTION_CUE_MS;
}
/** The stage's answer as the host accepts it: closed status, a few short part names, a short detail. */
export function readHerActionOutcome(value: unknown): HerActionOutcome | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.cueId !== 'string' || !CUE_ID.test(row.cueId) || !['played', 'missing', 'unfit', 'busy', 'failed'].includes(row.status as string)) return null;
  const missing = Array.isArray(row.missing) ? row.missing.filter((part): part is string => typeof part === 'string' && part.length > 0 && part.length <= 24).slice(0, 8) : [];
  const detail = typeof row.detail === 'string' ? row.detail.slice(0, 120) : '';
  return { cueId: row.cueId, status: row.status as HerActionStatus, missing, detail };
}

/**
 * The parts this model lacks for the action: a required standard bone it does not have, one whose name another bone shares
 * (`has` says 'duplicate': a motion track names its bone, so it cannot bind either), or one the (retargeted) clip does not
 * reach. `bound(slot)` says whether the clip moves it (omit before the clip is loaded). Fingers count when the action needs
 * them and a hand has fewer than `minFingers` finger joints (before loading: the profile's; after: the ones the clip binds).
 */
export function herActionMissing(spec: HerActionSpec, has: (slot: StandardBone) => boolean | 'duplicate', bound?: (slot: StandardBone) => boolean,
  fingers?: { left: number; right: number }, minFingers = 6): string[] {
  const out: string[] = [];
  for (const slot of spec.required) {
    const state = has(slot), part = HER_ACTION_PART_NAMES[slot] ?? slot;
    if (state === 'duplicate') out.push(`${part}（有重名骨骼）`);
    else if (!state || (bound && !bound(slot))) out.push(part);
  }
  if (spec.needsFingers && fingers) {
    if (spec.needsFingers === 'both' && fingers.left < minFingers) out.push(HER_ACTION_FINGER_PARTS.left);
    if (fingers.right < minFingers) out.push(HER_ACTION_FINGER_PARTS.right);
  }
  return out;
}

/** One action on one model, before anything loads: ok, or the parts it lacks (the skip note's words). */
export interface HerActionSupport {
  id: HerActionId; ok: boolean; missing: string[];
  /** Skeleton step 2: a face action this model plays as an approximation, and what it is built from (absent: none). */
  approximate?: FaceApproximation[];
}
/**
 * T-213, the one answer to "does this model have what this action needs to bind" before anything loads: the same check the
 * stage runs first (herActionMissing over profileBoneState and the profile's finger joints). The character page lists it,
 * and the stage refuses with the same parts. After loading the clip the stage checks again on the tracks that really bound,
 * and the fit check may still hold an action back (unfit) for how it looks on this body.
 * Face actions (universal skeleton step 1): the stage's own face rule (shared/face-morphs.ts resolveFaceMorphs) on what the
 * profile found once per model: its vertex-checked slots (or haiku's checked match for a slot the names missed) and its
 * named face shapes. A shape the model lacks, or has only as a morph that moves nothing, makes the action "不能做" with
 * the same part words the stage's skip note uses.
 */
export function herActionSupport(profile: ModelProfile | null | undefined, haikuBones: Partial<Record<StandardBone, number>> = {},
  haikuMorphs: Partial<Record<MorphSlot, number>> = {}): Record<HerActionId, HerActionSupport> {
  const fingers = profileFingerCount(profile);
  // Bones haiku matched (and the vertex check passed) count as there, as on the capability card; the stage fills them in on load.
  const has = (slot: StandardBone) => { const state = profileBoneState(profile, slot); return state || (Number.isInteger(haikuBones[slot]) && haikuBones[slot]! >= 0); };
  const out = {} as Record<HerActionId, HerActionSupport>;
  for (const id of HER_ACTIONS) {
    const spec = HER_ACTION_SPECS[id];
    const face = profile && spec.face ? faceSupport(spec.face, profile, haikuMorphs) : null;
    const missing = !profile ? ['模型档案'] : face ? face.missing : herActionMissing(spec, has, undefined, fingers);
    out[id] = { id, ok: missing.length === 0, missing, ...(face?.approximations.length ? { approximate: face.approximations } : {}) };
  }
  return out;
}
/**
 * A face action on this profile: resolveFaceMorphs over the profile's slots and named face shapes (each already vertex-checked),
 * so the card says what the stage will do: missing parts, or an approximation and what it is built from.
 */
function faceSupport(face: HerFaceSpec, profile: ModelProfile, haikuMorphs: Partial<Record<MorphSlot, number>>): { missing: string[]; approximations: FaceApproximation[] } {
  const names: Record<string, number> = {};
  for (const [shape, entry] of Object.entries(profile.faceShapes ?? {})) if (entry && Number.isInteger(entry.index) && entry.index >= 0) names[shape] = entry.index;
  const count = Math.max(0, profile.counts?.morphs ?? 0);
  const slot = (name: MorphSlot) => {
    const own = profile.morphs[name]?.index ?? -1, haiku = haikuMorphs[name];
    return own >= 0 ? own : Number.isInteger(haiku) && haiku! >= 0 ? haiku! : -1;
  };
  const { missing, approximations } = resolveFaceMorphs(face, { names, count, slot, displaces: () => true });
  return { missing, approximations };
}

/**
 * Finger bones by name (MMD Japanese, full- or half-width digits, or common English): which hand, or null. The same reader
 * as the profile's finger joints (shared/model-profile.ts fingerPartOfName); tips and unnumbered joints still say their hand.
 */
export function fingerSide(name: string): 'left' | 'right' | null {
  return fingerPartOfName(name)?.side ?? null;
}
