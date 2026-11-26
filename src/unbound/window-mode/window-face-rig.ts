/**
 * I-154 batch 2: which of the model's own expressions her face in the window uses (docs/claude/2026-11-20-unbound-window-batch2.md).
 *
 * Resolved once per model, the companion's way: an MMD model through its profile's vertex-checked slots (StageModelProfile, the same
 * slots and calibration scales the companion's stage writes), a VRM on the engine's standard face by the universal names. The figure's
 * expression slots (intent-layer.ts: one eased spring per slot) are bound to exactly these morphs, so every face below eases in and out.
 * Pure: three.js types only, no DOM.
 */
import type { Bone, AnimationClip, SkinnedMesh } from 'three';
import { MORPH_ALIASES, MORPH_SLOTS, type MorphSlot } from '../../../shared/actions';
import { profileDrowsyTargets, resolveDrowsyTargets, selectBlushChannel, type StageModelProfile } from '../../stage';
import type { ModelCapabilities } from '../../../shared/stage';
import { standardCapabilities } from '../model/standard-face';
import type { StandardBody } from '../model/standard-body';

export type SlotIndices = Readonly<Partial<Record<MorphSlot, number>>>;

export interface WindowFaceRig {
  /** Slot → the model's morph (only the slots it has). */
  readonly slots: SlotIndices;
  /** The mood smile's slot (the companion's: smile eyes, else a mouth smile), or null when the model has neither. */
  readonly smile: MorphSlot | null;
  /** Morph → calibration scale (the profile's; empty for the reviewed Gene and for a VRM). */
  readonly scales: ReadonlyMap<number, number>;
  /** The reviewed public Gene (the host said so): its reviewed eyelids, drowsy face and painted blush. */
  readonly reviewed: boolean;
  /** The drowsy face's troubled brow and half lids on this model, as slots (null: neither found). */
  readonly drowsy: { readonly brow: boolean; readonly eye: boolean } | null;
  /** Every morph that is a mouth shape (lip-sync, vowels, a mouth smile, a pucker): a speaking accent never writes one. */
  readonly mouthShapes: readonly number[];
  /** The model's own blush: the card's (its `shy` slot) and the old vertex-checked channel (Gene's 赤み); -1 when none. */
  readonly shy: number;
  readonly blushChannel: number;
  /** The profile the capability card is derived from until the host sends one (null for a VRM). */
  readonly profile: StageModelProfile['profile'];
  /**
   * I-164 (docs/claude/2026-11-20-vrm-gaps.md): a VRM's card from its own expressions and humanoid bones (no host record exists for one),
   * what blush, tears, tired lids, the drowsy face and sleep follow on it. Absent for an MMD model (its card comes from the profile).
   */
  readonly card?: ModelCapabilities | null;
}

/** The mouth-shape slots: they belong to lip-sync while she speaks (speech-face hard rule 1). */
export const MOUTH_SLOTS: readonly MorphSlot[] = Object.freeze(['a', 'i', 'u', 'e', 'o', 'mouthSmile', 'mouthPucker'] as MorphSlot[]);

/**
 * `profile`: the MMD model's profile (null for a VRM: its standard face is found by the universal names). `head`: the bone the
 * reviewed Gene's drowsy structure is checked against.
 */
export function windowFaceRig(mesh: SkinnedMesh, profile: StageModelProfile | null, reviewed: boolean, head: Bone | null,
  standard: Pick<StandardBody, 'has' | 'model'> | null = null): WindowFaceRig {
  const count = mesh.morphTargetInfluences?.length ?? 0;
  const usable = (index: unknown): index is number => typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < count;
  const slots: Partial<Record<MorphSlot, number>> = {};
  const dictionary = mesh.morphTargetDictionary ?? {}, keys = Object.keys(dictionary);
  for (const slot of MORPH_SLOTS) {
    let index: number | undefined;
    if (profile?.profile) index = profile.profile.morphs[slot]?.index;
    else for (const alias of MORPH_ALIASES[slot]) { const key = keys.find(k => k.toLowerCase() === alias.toLowerCase()); if (key) { index = dictionary[key]; break; } }
    if (usable(index)) slots[slot] = index;
  }
  const smile: MorphSlot | null = slots.smileEyes !== undefined ? 'smileEyes' : slots.mouthSmile !== undefined ? 'mouthSmile' : null;
  const legacyMouth = profile?.indices.mouth ?? -1;
  const mouthShapes = [...new Set([legacyMouth, ...MOUTH_SLOTS.map(slot => slots[slot] ?? -1)].filter(index => index >= 0))];
  let drowsy: WindowFaceRig['drowsy'] = null;
  if (head) {
    // The reviewed Gene: its audited structure (困る 68, じと目 95) and its own slots must agree; any other model: its sad / jitome slots.
    const gene = reviewed ? resolveDrowsyTargets(mesh, head, true) : null;
    if (gene) drowsy = { brow: slots.sad === gene.brow, eye: slots.jitome === gene.eye };
    else if (!reviewed) {
      const found = profileDrowsyTargets(mesh, head, { sad: slots.sad ?? -1, jitome: slots.jitome ?? -1, blink: slots.blink ?? -1 });
      if (found) drowsy = { brow: found.brow >= 0, eye: found.eye >= 0 };
    }
    if (drowsy && !drowsy.brow && !drowsy.eye) drowsy = null;
  }
  let blushChannel = -1;
  try { blushChannel = selectBlushChannel(mesh.morphTargetDictionary, mesh.geometry)?.index ?? -1; } catch { blushChannel = -1; }
  return { slots, smile, scales: profile?.scales ?? new Map(), reviewed, drowsy, mouthShapes, shy: slots.shy ?? -1, blushChannel,
    profile: profile?.profile ?? null, ...(standard ? { card: standardCapabilities(standard) } : {}) };
}

/**
 * The figure's slot bindings: every slot to the model's morph, or -1 (none: the engine's name fallback must not guess another), and
 * `shy` to the blush morph this model shows (the card's own, else the old channel) or -1 while the blush is painted or off.
 */
export function slotBindings(rig: WindowFaceRig, blushMorph: number): Partial<Record<MorphSlot, number>> {
  const out: Partial<Record<MorphSlot, number>> = {};
  for (const slot of MORPH_SLOTS) out[slot] = rig.slots[slot] ?? -1;
  out.shy = blushMorph;
  return out;
}

export interface FaceBlocks {
  /** A picked expression motion moves her face: the mood face steps aside (the companion's moodFaceBlocked). */
  face: boolean;
  /** It moves her mouth (moodMouthBlocked). */
  mouth: boolean;
  /** A picked pose or gesture moves her head (moodHeadBlocked): the mood's head motion steps aside. */
  head: boolean;
}
export const NO_FACE_BLOCKS: FaceBlocks = Object.freeze({ face: false, mouth: false, head: false });

/**
 * Batch 5: what the picked motions hold for her own motions (the companion's commitMotionLayers flags, src/stage/mmd/pose.ts): a picked
 * gesture, or a picked pose (not the reviewed default stand) that moves the chat gesture's bones, keeps chat gestures and arm actions out;
 * a picked pose or gesture holds the automatic body motions back. `reviewedDefault`: the pose is the reviewed bundled stand.
 */
export interface MotionBlocks extends FaceBlocks {
  chatGesture: boolean; manualPose: boolean; manualGesture: boolean; dynamicPose: boolean;
}
export const NO_MOTION_BLOCKS: MotionBlocks = Object.freeze({ ...NO_FACE_BLOCKS, chatGesture: false, manualPose: false, manualGesture: false, dynamicPose: false });
export function motionBlocks(clips: { pose: AnimationClip | null; gesture: AnimationClip | null }, reviewedDefault: boolean, face: FaceBlocks,
  isGestureTrack: (name: string) => boolean): MotionBlocks {
  const { pose, gesture } = clips;
  const chatGesture = Boolean(gesture) || (!reviewedDefault && Boolean(pose?.tracks.some(track => {
    if (!isGestureTrack(track.name) || track.times.length < 2) return false;
    const width = track.getValueSize();
    for (let index = width; index < track.values.length; index++) if (Math.abs(track.values[index] - track.values[index % width]) > 0.0001) return true;
    return false;
  })));
  return { ...face, chatGesture, manualPose: Boolean(pose) && !reviewedDefault, manualGesture: Boolean(gesture), dynamicPose: !reviewedDefault && chatGesture };
}

/** Batch 5 (row 38): what of the 惊喜 / 害羞 show this model can show, from its face slots and the parts the stage has. */
export function showCapabilitiesOf(rig: WindowFaceRig | null, parts: { head: boolean; upperBody: boolean; eyes: boolean; blush: boolean }) {
  const slots = rig?.slots, has = (value: number | undefined) => typeof value === 'number' && value >= 0;
  return { ...parts, lids: has(slots?.blink), browUp: has(slots?.browUp), browSad: has(slots?.sad), eyeWide: has(slots?.surprise), smileEyes: has(slots?.smileEyes),
    mouthSmile: has(slots?.mouthSmile), mouthOpen: has(slots?.o) && slots?.o !== slots?.a };
}

/** The companion's rules (src/stage/mmd/pose.ts), on the clips the figure plays. */
export function faceBlocks(clips: { pose: AnimationClip | null; gesture: AnimationClip | null; expression: AnimationClip | null }, legacy: boolean,
  mesh: Pick<SkinnedMesh, 'morphTargetDictionary'>, mouthIndex: number, headName: string | null): FaceBlocks {
  const facial = legacy ? clips.pose : clips.expression;
  const face = !!facial?.tracks.some(track => /^\.morphTargetInfluences\[/.test(track.name) || /(?:目|眼|口|眉|jaw|eye|lip)/i.test(track.name));
  const mouths = new Set([mouthIndex]);
  for (const [name, index] of Object.entries(mesh.morphTargetDictionary ?? {}))
    if (/^(?:あ|い|う|え|お|ん|a|i|u|e|o|aa|ih|ou|ee|oh)$/i.test(name.normalize('NFKC')) || /(?:口|唇|あご|顎|jaw|mouth|lip)/i.test(name)) mouths.add(index);
  const mouth = !!facial?.tracks.some(track => {
    const morph = /^\.morphTargetInfluences\[(\d+)\]$/.exec(track.name);
    return morph ? mouths.has(Number(morph[1])) : /(?:口|唇|あご|顎|jaw|mouth|lip)/i.test(track.name);
  });
  const head = !!headName && [clips.pose, clips.gesture].some(clip => clip?.tracks.some(track => {
    if (!track.name.startsWith(`.bones[${headName}]`) || track.times.length < 2) return false;
    const width = track.getValueSize();
    for (let i = width; i < track.values.length; i++) if (Math.abs(track.values[i] - track.values[i % width]) > 0.0001) return true;
    return false;
  }));
  return { face, mouth, head };
}
