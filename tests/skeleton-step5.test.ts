/**
 * Universal skeleton step 5, the acceptance (docs/claude/2026-11-06-skeleton-step5.md): the five body actions and the two face
 * shapes she may now pick herself, on Gene and on the Gene-derived bodies of steps 2–4 (tests/helpers/body-variants.ts,
 * hand-variants.ts: other shoulders and arm lengths, a T pose, hands rolled, other finger rests, English bone names, renamed
 * face shapes). Gene's own data only: no other model, nothing of the user's, no PMX or VMD bytes written.
 *
 * Two halves: the conversion as the stage loads it (does the clap meet, the heart close, the fit check pass), and the real
 * stage frame loop at 60 and 30 fps (R29: eases in and out, steps about as on Gene, the display guard catches nothing, back to
 * idle). The numbers print as diagnostics; the record's table is copied from them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildModelProfile } from '../shared/stage/model-profile';
import { STANDARD_SOURCE_RIG, evaluatePose, tracksOnRig, vlength, vscale, vsub, vadd, type Pose, type RetargetRig, type VmdLike } from '../shared/actions/motion-retarget';
import { HER_ACTION_PACK, HER_ACTION_SPECS, type HerActionId } from '../shared/actions/her-actions';
import { CHAT_ACTION_OF, CHAT_ACTION_WORDS } from '../shared/brain/chat-actions';
import { sha256Hex } from '../shared/foundation/sha256-sync';
import type { Vec3 } from '../shared/foundation/universal-skeleton';
import { StageMotionRetarget, clearRetargetCache } from '../src/actions/motion-retarget';
import { readGene } from './helpers/bundled-motions';
import { BODY_VARIANTS } from './helpers/body-variants';
import { reshapeFingers, rollHands, tPoseRolled, type EditableBone } from './helpers/hand-variants';
import { profileInput, toThreeMesh, type ModelData } from './helpers/model-fixtures';
import { readVmdLite } from './helpers/vmd-lite';
import { TRACKED_BONES, catalogMotionFile, type ShownFrame } from './helpers/frame-stats';

const GENE = readGene();
const HEAD = buildModelProfile(profileInput({ ...GENE, morphs: [] })).proportions.headSize;
const BODY = CHAT_ACTION_WORDS.map(word => CHAT_ACTION_OF[word]).filter(id => HER_ACTION_SPECS[id].mode !== 'face');
const FACE = CHAT_ACTION_WORDS.map(word => CHAT_ACTION_OF[word]).filter(id => HER_ACTION_SPECS[id].mode === 'face');
const english = (bones: EditableBone[]) => bones.forEach(bone => {
  const finger = /^(左|右)(親指|人指|中指|薬指|小指)(.*)$/.exec(bone.name.normalize('NFKC'));
  if (finger) bone.name = `${finger[1] === '左' ? 'Left' : 'Right'}${{ 親指: 'Thumb', 人指: 'Index', 中指: 'Middle', 薬指: 'Ring', 小指: 'Little' }[finger[2]]}${finger[3]}`;
  const arm = /^(左|右)(腕|ひじ|手首|手捩)$/.exec(bone.name);
  if (arm) bone.name = `${arm[1] === '左' ? 'Left' : 'Right'}${{ 腕: 'UpperArm', ひじ: 'ForeArm', 手首: 'Hand', 手捩: 'WristTwist' }[arm[2]]}`;
  const head = { 首: 'Neck', 頭: 'Head' }[bone.name];
  if (head) bone.name = head;
});
/** The bodies, as the stage's rest edit (restEdit) where it can be shown; English names only through the conversion. */
const BODIES: Record<string, { edit: ((bones: EditableBone[]) => void) | null; shown: boolean }> = {
  Gene: { edit: null, shown: true },
  'English bone names': { edit: english, shown: false },
  ...Object.fromEntries(Object.entries(BODY_VARIANTS).map(([label, edit]) => [label, { edit, shown: true }])),
  'T pose, palms forward': { edit: tPoseRolled, shown: true },
  'hands rolled 90°': { edit: rollHands, shown: true },
  'other finger rests': { edit: reshapeFingers, shown: true },
};
function geneVariant(edit: ((bones: EditableBone[]) => void) | null): ModelData {
  const bones = GENE.bones.map(bone => ({ ...bone, position: [...bone.position] as Vec3, ...(bone.grant ? { grant: { ...bone.grant } } : {}) }));
  edit?.(bones);
  return { positions: GENE.positions, skinBone: GENE.skinBone, bones, morphs: [] };
}
const actionBytes = (id: HerActionId) => new Uint8Array(readFileSync(catalogMotionFile(HER_ACTION_PACK, id)));
const actionVmd = (id: HerActionId): VmdLike => readVmdLite(actionBytes(id));
const SIDE = (name: string, side: '左' | '右', isEnglish: boolean) => {
  if (!isEnglish) return `${side}${name}`;
  const finger = /^(親指|人指|中指|薬指|小指)(.*)$/.exec(name);
  if (finger) return `${side === '左' ? 'Left' : 'Right'}${{ 親指: 'Thumb', 人指: 'Index', 中指: 'Middle', 薬指: 'Ring', 小指: 'Little' }[finger[1]]}${finger[2].normalize('NFKC')}`;
  return `${side === '左' ? 'Left' : 'Right'}${{ 手首: 'Hand' }[name] ?? name}`;
};
const mean = (points: readonly Vec3[]): Vec3 => vscale(points.reduce((a, b) => vadd(a, b), [0, 0, 0] as Vec3), 1 / points.length);
const PALM = ['手首', '人指１', '中指１', '薬指１', '小指１'];
/** The touches (step 4): the clap's three closings, the heart's hold. */
const TOUCH = { clap: [55, 56, 57, 58, 82, 83, 84, 85, 109, 110, 111, 112], 'two-hand-heart': Array.from({ length: 28 }, (_, k) => 75 + k) } as const;
function at(rig: RetargetRig, pose: Pose, name: string): Vec3 {
  const index = rig.bones.findIndex(bone => bone.name === name);
  assert.ok(index >= 0, name);
  return pose.wp[index];
}
interface Touch { closest: number; offGene: number }
/** Head sizes. clap: the palm centres' distance; heart: the thumb tips' and the index tips' (the larger), at the touch frames. */
function touches(id: 'clap' | 'two-hand-heart', rig: RetargetRig, vmd: VmdLike, isEnglish: boolean): { distances: number[]; gaps: Vec3[] } {
  const tracks = tracksOnRig(vmd, rig), distances: number[] = [], gaps: Vec3[] = [];
  for (const frame of TOUCH[id]) {
    const pose = evaluatePose(rig, tracks, frame);
    const point = (side: '左' | '右', names: readonly string[]) => mean(names.map(name => at(rig, pose, SIDE(name, side, isEnglish))));
    if (id === 'clap') { const gap = vsub(point('左', PALM), point('右', PALM)); gaps.push(gap); distances.push(vlength(gap) / HEAD); }
    else {
      const thumb = vsub(point('左', ['親指先']), point('右', ['親指先'])), index = vsub(point('左', ['人指先']), point('右', ['人指先']));
      gaps.push(vscale(vadd(thumb, index), 0.5)); distances.push(Math.max(vlength(thumb), vlength(index)) / HEAD);
    }
  }
  return { distances, gaps };
}

test('acceptance, conversion: the five body actions on every body — the clap meets, the heart closes, nothing is held back or goes through the body', t => {
  clearRetargetCache();
  const gene = Object.fromEntries((['clap', 'two-hand-heart'] as const).map(id => [id, touches(id, STANDARD_SOURCE_RIG, actionVmd(id), false)]));
  const lines: string[] = [`Gene reference: clap palms closest ${Math.min(...gene.clap.distances).toFixed(3)} heads; heart tips farthest ${Math.max(...gene['two-hand-heart'].distances).toFixed(3)} heads`];
  const failures: string[] = [];
  for (const [label, body] of Object.entries(BODIES)) {
    if (!body.edit) continue;
    const data = geneVariant(body.edit), isEnglish = label === 'English bone names';
    const stage = new StageMotionRetarget(toThreeMesh(data), buildModelProfile(profileInput(data)), { reviewed: false });
    const cells: string[] = [];
    for (const id of BODY) {
      const bytes = actionBytes(id);
      const vmd = stage.transform!(actionVmd(id), bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      const fit = stage.fitOf(sha256Hex(bytes));
      assert.ok(fit, `${label} ${id}: scored`);
      const through = fit!.issues.filter(issue => issue.startsWith('penetration'));
      let touch = '';
      if (id === 'clap' || id === 'two-hand-heart') {
        const mine = touches(id, stage.rig!, vmd, isEnglish), ref = gene[id];
        const off = Math.max(...mine.gaps.map((gap, k) => vlength(vsub(gap, ref.gaps[k])) / HEAD));
        touch = id === 'clap' ? ` palms ${Math.min(...mine.distances).toFixed(3)} (Gene ${Math.min(...ref.distances).toFixed(3)}), ${off.toFixed(3)} off`
          : ` tips ${Math.max(...mine.distances).toFixed(3)} (Gene ${Math.max(...ref.distances).toFixed(3)}), ${off.toFixed(3)} off`;
        if (!(off < 0.02)) failures.push(`${label} ${id}: the hands are ${off.toFixed(3)} heads from where they meet on Gene`);
      }
      cells.push(`${id} ${fit!.status}${fit!.adjustments.length ? ` (${fit!.adjustments.join('; ')})` : ''}${touch}${through.length ? ` THROUGH ${through.join('; ')}` : ''}`);
      if (fit!.status === 'hidden') failures.push(`${label} ${id}: held back (${fit!.issues.join('; ')})`);
      if (through.length) failures.push(`${label} ${id}: ${through.join('; ')}`);
    }
    lines.push(`${label}: ${cells.join(' | ')}`);
  }
  t.diagnostic(lines.join('\n'));
  assert.deepEqual(failures, []);
});

// ---------------------------------------------------------------- R29: the real stage frame loop

const ARM = ['左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首', '右人指１', '右人指２', '左人指１', '右親指１', '左親指１', '右中指２', '左中指２'] as const;
const DEG = 180 / Math.PI;
/** World rotations watched: the tracked torso, neck and head bones, then the arm chain and a few fingers. */
const rotations = (frame: ShownFrame) => [...frame.world, ...frame.extra];
const WATCHED = [...TRACKED_BONES, ...ARM];
const FINGER = (name: string) => /(親指|人指|中指|薬指|小指)/.test(name);
/** The largest per-frame turn of a watched rotation (body bones or finger joints), and which bone. */
const step = (a: ShownFrame, b: ShownFrame, fingers: boolean): [number, string] => rotations(a).reduce<[number, string]>((best, q, k) => {
  if (FINGER(WATCHED[k]) !== fingers) return best;
  const angle = q.angleTo(rotations(b)[k]) * DEG;
  return angle > best[0] ? [angle, WATCHED[k]] : best;
}, [0, '']);
/**
 * A body whose finger rests differ (reshapeFingers): at idle her fingers keep this model's own rest (the stand does not write
 * every joint), while the converted clip's first frame has them shaped as on Gene, tens of degrees away. So the fade-in is sized
 * to its longest (0.9 s instead of Gene's 0.25 s); the clip already moves while the weight is low and the hand catches up, and
 * the fastest wrist and finger frames are about a third quicker than on Gene. Not a jump: the unexpected step and the guard are
 * as on Gene. Every other body keeps the step-4 bound (1.25 × Gene + 0.3°), for every bone.
 */
const FINGER_REST_STEP = 1.4;
function surprise(frames: readonly ShownFrame[]): number {
  let best = 0;
  for (let i = 2; i < frames.length; i++) {
    const q = rotations(frames[i]), p = rotations(frames[i - 1]), o = rotations(frames[i - 2]);
    for (let k = 0; k < q.length; k++) best = Math.max(best, q[k].clone().multiply(p[k].clone().invert()).angleTo(p[k].clone().multiply(o[k].clone().invert())) * DEG);
  }
  return best;
}
interface Run { stepBone: string; step: number; fingerBone: string; finger: number; surprise: number; opening: number; closing: number; back: number; guard: number }

/** Face shapes: Gene, and a Gene whose 嘟嘴 and its own wink go by names nothing recognises (approximated from her other shapes). */
const RENAMED = { mouthPucker: 'lips_unknown', ウィンク: 'eye_unknown_l' } as const;
