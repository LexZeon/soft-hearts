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
import { buildModelProfile } from '../shared/model-profile';
import { STANDARD_SOURCE_RIG, evaluatePose, tracksOnRig, vlength, vscale, vsub, vadd, type Pose, type RetargetRig, type VmdLike } from '../shared/motion-retarget';
import { HER_ACTION_DETAILS, HER_ACTION_PACK, HER_ACTION_SPECS, herActionDurationMs, type HerActionId } from '../shared/her-actions';
import { CHAT_ACTION_OF, CHAT_ACTION_WORDS } from '../shared/chat-actions';
import { sha256Hex } from '../shared/sha256-sync';
import type { Vec3 } from '../shared/universal-skeleton';
import { StageMotionRetarget, clearRetargetCache } from '../src/stage/motion-retarget';
import { readGene } from './helpers/bundled-motions';
import { TRACKED_BONES, catalogMotionFile, geneStage, type GeneStage, type ShownFrame } from './helpers/gene-stage-harness';
import { BODY_VARIANTS, meshFollows } from './helpers/body-variants';
import { reshapeFingers, rollHands, tPoseRolled, type EditableBone } from './helpers/hand-variants';
import { profileInput, toThreeMesh, type ModelData } from './helpers/model-fixtures';
import { readVmdLite } from './helpers/vmd-lite';

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
function lockstep(a: GeneStage, b: GeneStage, seconds: number) { for (let i = 0, n = Math.round(seconds * a.rate); i < n; i++) { a.tick(); b.tick(); } }
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
const apart = (a: GeneStage, b: GeneStage, from: number, to: number) => {
  let best = 0;
  for (let i = from; i < to; i++) { const x = rotations(a.shown[i]), y = rotations(b.shown[i]); for (let k = 0; k < x.length; k++) best = Math.max(best, x[k].angleTo(y[k]) * DEG); }
  return best;
};
interface Run { stepBone: string; step: number; fingerBone: string; finger: number; surprise: number; opening: number; closing: number; back: number; guard: number }

for (const fps of [60, 30] as const) test(`acceptance, R29 at ${fps} fps: the five body actions on Gene and six bodies ease in and out, step about as on Gene, the guard catches nothing`, async t => {
  const lines: string[] = [], runs: Record<string, Run> = {}, failures: string[] = [];
  for (const [label, body] of Object.entries(BODIES)) {
    if (!body.shown) continue;
    const options = { herActions: true, fps, extraBones: ARM, ...(body.edit ? { restEditSkin: meshFollows(body.edit) as never } : {}) } as const;
    const h = await geneStage(options), idle = await geneStage(options);
    try {
      lockstep(h, idle, 1.0);
      for (const id of BODY) {
        const seconds = herActionDurationMs(id) / 1000, jumps = h.shown.at(-1)!.guardJumps, start = h.shown.length;
        const report = await h.playAction(id);
        if (report?.status !== 'played') { failures.push(`${label} ${id}: ${JSON.stringify(report)} ${JSON.stringify(h.stage.motionRetarget?.fitOf(HER_ACTION_SPECS[id].sha256))}`); continue; }
        lockstep(h, idle, seconds + 0.6);
        const end = h.shown.length, frames = h.shown.slice(start - 1, end), finish = start + Math.round(seconds * h.rate);
        let biggest: [number, string] = [0, ''], finger: [number, string] = [0, ''];
        for (let i = 1; i < frames.length; i++) {
          const value = step(frames[i], frames[i - 1], false), joint = step(frames[i], frames[i - 1], true);
          if (value[0] > biggest[0]) biggest = value;
          if (joint[0] > finger[0]) finger = joint;
        }
        const run: Run = { step: biggest[0], stepBone: biggest[1], finger: finger[0], fingerBone: finger[1], surprise: surprise(frames), opening: apart(h, idle, start, start + 2), closing: apart(h, idle, finish - 2, finish + 2),
          back: apart(h, idle, end - 3, end), guard: h.shown.at(-1)!.guardJumps - jumps };
        runs[`${label} ${id}`] = run;
        lines.push(`${fps} fps ${label} ${id}: step ${run.step.toFixed(2)}° (${run.stepBone}), fingers ${run.finger.toFixed(2)}° (${run.fingerBone || '–'}), unexpected ${run.surprise.toFixed(2)}°, opening ${run.opening.toFixed(3)}°, closing ${run.closing.toFixed(3)}°, back ${run.back.toFixed(3)}°, guard ${run.guard}`);
        if (run.guard) failures.push(`${label} ${id}: the display guard caught ${run.guard} (${h.shown.at(-1)!.guardLast})`);
        if (!(run.opening < (fps === 60 ? 0.5 : 1))) failures.push(`${label} ${id} eases in: ${run.opening.toFixed(3)}°`);
        if (!(run.closing < 1)) failures.push(`${label} ${id} eases out: ${run.closing.toFixed(3)}°`);
        if (!(run.back < 1)) failures.push(`${label} ${id}: back in its idle (${run.back.toFixed(3)}°)`);
        lockstep(h, idle, 0.4);
      }
    } finally { idle.close(); h.close(); }
  }
  for (const [key, run] of Object.entries(runs)) {
    const id = key.split(' ').at(-1)!, gene = runs[`Gene ${id}`];
    const bound = key.startsWith('other finger rests') ? FINGER_REST_STEP : 1.25;
    if (!(run.step <= gene.step * bound + 0.3)) failures.push(`${key}: steps ${run.step.toFixed(2)}° (${run.stepBone}), Gene ${gene.step.toFixed(2)}° (${gene.stepBone})`);
    if (!(run.finger <= gene.finger * bound + 0.3)) failures.push(`${key}: finger steps ${run.finger.toFixed(2)}° (${run.fingerBone}), Gene ${gene.finger.toFixed(2)}°`);
    if (!(run.surprise <= gene.surprise * 1.25 + 0.3)) failures.push(`${key}: unexpected step ${run.surprise.toFixed(2)}°, Gene ${gene.surprise.toFixed(2)}°`);
  }
  t.diagnostic(lines.join('\n'));
  assert.deepEqual(failures, []);
});

/** Face shapes: Gene, and a Gene whose 嘟嘴 and its own wink go by names nothing recognises (approximated from her other shapes). */
const RENAMED = { mouthPucker: 'lips_unknown', ウィンク: 'eye_unknown_l' } as const;
for (const fps of [60, 30] as const) test(`acceptance, face shapes at ${fps} fps: 眨一只眼 and 撅嘴 on Gene and on renamed shapes play, step smoothly, the guard catches nothing, back to idle`, async t => {
  const lines: string[] = [];
  for (const [label, rename] of [['Gene', undefined], ['renamed shapes', RENAMED]] as const) {
    const options = { herActions: true, fps, recordAll: true, ...(rename ? { renameMorphs: rename } : {}) } as const;
    const h = await geneStage(options), idle = await geneStage(options);
    try {
      lockstep(h, idle, 0.7);
      for (const id of FACE) {
        const start = h.shown.length, jumps = h.shown.at(-1)!.guardJumps;
        const report = await h.playAction(id);
        assert.equal(report?.status, 'played', `${label} ${id}: ${JSON.stringify(report)}`);
        const targets: number[] = [...new Set<number>(h.stage.faceExclusive.getState()[HER_ACTION_SPECS[id].face!.scope].targets)];
        const group: number[] = h.stage.faceExclusive.conflictGroup(targets);
        lockstep(h, idle, HER_ACTION_SPECS[id].durationFrames / 30 + 0.6);
        let biggest = 0, peak = 0;
        for (let k = start; k < h.shown.length; k++) for (const i of group) biggest = Math.max(biggest, Math.abs(h.shown[k].all![i] - h.shown[k - 1].all![i]));
        for (let k = start; k < h.shown.length; k++) for (const i of targets) peak = Math.max(peak, h.shown[k].all![i]);
        let back = 0;
        for (const k of [h.shown.length - 2, h.shown.length - 1]) for (let i = 0; i < h.shown[k].all!.length; i++) back = Math.max(back, Math.abs(h.shown[k].all![i] - idle.shown[k].all![i]));
        const guard = h.shown.at(-1)!.guardJumps - jumps;
        lines.push(`${fps} fps ${label} ${id}: ${report!.detail || 'own shape'}, written ${targets.map(i => Object.entries(h.mesh.morphTargetDictionary!).find(([, v]) => v === i)?.[0]).join('+')}, peak ${peak.toFixed(2)}, largest group step ${biggest.toFixed(3)}/frame, guard ${guard}, afterwards ${back.toExponential(1)} from idle`);
        assert.equal(guard, 0, `${label} ${id}: the guard caught ${guard}`);
        assert.ok(biggest < (fps === 60 ? 0.2 : 0.4), `${label} ${id}: smooth (${biggest})`);
        assert.ok(back < 1e-9, `${label} ${id}: afterwards exactly idle (${back})`);
        if (rename && id === 'pout') assert.equal(report!.detail, HER_ACTION_DETAILS.approximate, `${label} ${id}: the card's 近似`);
        lockstep(h, idle, 0.5);
      }
    } finally { idle.close(); h.close(); }
  }
  t.diagnostic(lines.join('\n'));
});

// ---------------------------------------------------------------- what a model cannot do: skipped quietly, nothing moves

test('a cue for a shape this model lacks (no wink at all): the stage says "missing", writes nothing, and the frames stay exactly idle', async () => {
  const none = { ウィンク: 'x1', ウィンク右: 'x2', ウィンク２: 'x3', ｳｨﾝｸ２右: 'x4', まば左: 'x5', まば右: 'x6', eyeBlinkLeft: 'x7', eyeBlinkRight: 'x8', eye_wink_geo_L: 'x9', eye_wink_geo_R: 'x10',
    eye_close_geo_L: 'x11', eye_close_geo_R: 'x12' } as const;
  const h = await geneStage({ herActions: true, fps: 30, recordAll: true, renameMorphs: none }), idle = await geneStage({ herActions: true, fps: 30, recordAll: true, renameMorphs: none });
  try {
    lockstep(h, idle, 0.7);
    const start = h.shown.length;
    const report = await h.playAction('wink');
    assert.equal(report?.status, 'missing', JSON.stringify(report));
    assert.ok(report!.missing.length > 0);
    lockstep(h, idle, 1.5);
    for (let k = start; k < h.shown.length; k++) assert.deepEqual(h.shown[k].all, idle.shown[k].all, `frame ${k} as idle`);
    assert.equal(h.stage.faceExclusive.active('eyelids'), false);
  } finally { idle.close(); h.close(); }
});

/**
 * Gene's own reviewed actions, frame by frame, are what they were before this step (it adds no stage code): every shown frame of
 * the seven at 60 fps (the watched rotations and every morph), rounded, hashed, pinned. If it changes, the stage changed.
 */
test('Gene: the seven actions frame by frame are pinned', async () => {
  const h = await geneStage({ herActions: true, fps: 60, extraBones: ARM, recordAll: true });
  try {
    h.run(1.0);
    const hashes: string[] = [];
    for (const id of CHAT_ACTION_WORDS.map(word => CHAT_ACTION_OF[word])) {
      const start = h.shown.length;
      assert.equal((await h.playAction(id))?.status, 'played', id);
      h.run(herActionDurationMs(id) / 1000 + 0.6);
      const round = (value: number) => Math.round(value * 1e5) / 1e5 || 0;
      hashes.push(`${id}:${sha256Hex(JSON.stringify(h.shown.slice(start).map(frame => [...rotations(frame).map(q => [q.x, q.y, q.z, q.w].map(round)), ...Array.from(frame.all!.slice(0, h.mesh.morphTargetInfluences!.length), round)]))).slice(0, 12)}`);
    }
    assert.deepEqual(hashes, ['hello-wave:8ffaf174b16f', 'nod:c3a0ecf6e84a', 'tilt:223a5aa6b3e0', 'two-hand-heart:40e6c38d6e1d', 'clap:740a13a1a552',
      'wink:810323bc5b9e', 'pout:64b226401971']);
  } finally { h.close(); }
});
