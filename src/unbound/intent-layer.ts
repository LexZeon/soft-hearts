/**
 * Unbound U2, layer 3 for generated motion (docs/claude/2026-11-12-unbound-peek.md): PoseTargets from a generator (layer 2) are
 * goals; this turns them into her body through the dynamics layer's springs (dynamics.ts), "只给目标，不写骨头":
 *
 *  - posture: the head (1.6 Hz), the neck (1.3 Hz), the upper body last (0.85 Hz), from the per-group table (MOTION_GROUPS). Where she
 *    looks (`targets.eyes`) is not applied here: E1 (docs/claude/2026-11-14-eye-head-fix.md) hands it to the figure's eye-head
 *    coordinator (src/stage/eye-head.ts), which splits it between her eyes, head and upper body;
 *  - hips (2.2 Hz) and her toes (the contact owner's own eased spring, gait.ts setTiptoe): her feet stay planted throughout;
 *  - face cues through a soft spring, blinks crisp (a keyframed value, never filtered);
 *  - a tempo retunes the springs from now on (value and velocity kept): brisk for the first notice, a short startle with a little
 *    overshoot when you move the mouse in the middle of it, calm otherwise.
 *
 * U2 E2 (docs/claude/2026-11-14-unbound-night-e2-autonomy.md): the arms. `arms.raise` (0..1, through an eased arms-group spring)
 * blends each arm chain (腕, ひじ, 手首) from the motion's pose toward straight up overhead (a little outward and forward), so the
 * stretch lifts the arms out of whatever the motion has them doing and gives them back the same way.
 *
 * Writes residuals on top of whatever the motion has (bones post-multiplied in their own frame; morphs as max(motion, cue)) and
 * restores them before the mixer's next update, like every residual in figure.ts.
 *
 * I-175 (shared/behaviors/part-mix/mouth.ts, docs/claude/2026-11-22-i175-part-mixer.md): while lip-sync owns the opening (`setMouthTalk`, the
 * mouth's eased weight), every expression's mouth parts are written by their role: a shape (pucker, smile, corners) stays as the base, the
 * opening (vowels, jaw) and closed-mouth shapes (cheek puff) give way. `mouthBase` is this frame's base, read before anything gives way, for
 * the flap's amplitude and vowel. Both Unbound stages write their faces here, so the one rule holds in the window and in full-screen.
 */
import { Quaternion, Vector3, type Bone, type SkinnedMesh } from 'three';
import { MOTION_GROUPS, RotationSpring, Spring, type SpringSpec } from './dynamics';
import { REST_TARGETS, type PoseTargets, type Rot, type Tempo } from './motion/generator';
import { figureBone } from './model/figure-bones';
import { LimbResidual } from './limb-residual'; // motion-model spike round 2: hips and arms (only idle sources ask for them)
import { MORPH_ALIASES, type MorphSlot } from '../../shared/foundation/universal-skeleton'; // direct, not via the actions page: the Unbound window does not take that page (docs/claude/2026-11-16-overhaul-parts-4.md)
import { NO_MOUTH_BASE, mouthBaseOf, mouthRoleOfName, mouthRoleOfSlot, talkFade } from '../../shared/behaviors/part-mix/mouth';
import { lidsUnderCeiling } from '../../shared/behaviors/part-mix/lids-head';
import type { MouthBase, MouthRole } from '../../shared/behaviors/part-mix/interface';

/** Showcase expression slots (docs/claude/2026-11-14-lapwing-showcase.md): one eased spring each; the performer shapes onsets itself. */
const SLOT_SPRING: SpringSpec = { hz: 3, eased: true };

const FACE_SPRING: SpringSpec = { hz: 2.5, zeta: 1 };
/** Per tempo, per group: [hz, zeta]. Calm is the table's own. Exported for generators that predict where a group will be (procedural.ts, address). */
export const TEMPO: Readonly<Record<Tempo, { torso: SpringSpec; neck: SpringSpec; head: SpringSpec; pelvis: SpringSpec; face: SpringSpec }>> = {
  calm: { torso: MOTION_GROUPS.chest, neck: MOTION_GROUPS.neck, head: MOTION_GROUPS.head, pelvis: MOTION_GROUPS.pelvis, face: FACE_SPRING },
  brisk: { torso: { hz: 1.2, zeta: 1.05 }, neck: { hz: 1.9, zeta: 1 }, head: { hz: 2.4, zeta: 0.95 }, pelvis: MOTION_GROUPS.pelvis, face: { hz: 4, zeta: 1 } },
  startle: { torso: { hz: 1.6, zeta: 0.85 }, neck: { hz: 2.6, zeta: 0.8 }, head: { hz: 3.2, zeta: 0.72 }, pelvis: { hz: 3, zeta: 0.9 }, face: { hz: 7, zeta: 1 } },
  // E3 (docs/claude/2026-11-14-unbound-night-e3-speech.md): turning to you before she speaks, and the small nod. Only head and neck
  // are quicker (critically damped: no bounce); her upper body stays brisk-slow, so the shoulders come last.
  address: { torso: { hz: 1.2, zeta: 1.05 }, neck: { hz: 3.2, zeta: 1 }, head: { hz: 4, zeta: 1 }, pelvis: MOTION_GROUPS.pelvis, face: { hz: 4, zeta: 1 } },
};

/** Morph names per cue, first found wins (the model's own; missing ones are skipped). Weight = how much of the morph a full cue uses. */
const FACE_MORPHS: Record<'blink' | 'curious' | 'smile' | 'smileBrow' | 'startle', { names: readonly string[]; weight: number }> = {
  blink: { names: ['まばたき', 'eyeBlink', '瞬き', 'blink', 'Blink'], weight: 1 },
  curious: { names: ['eyeWide', '見開き', 'びっくり'], weight: 0.35 },
  smile: { names: ['mouthSmile', 'にっこり口(総', '口わらい', 'にやり', 'smile', 'Smile'], weight: 0.6 },
  smileBrow: { names: ['にこり'], weight: 0.4 },
  startle: { names: ['びっくり', 'eyeWide', '見開き', '驚き'], weight: 0.7 },
};

const IDENTITY = new Quaternion();
/** Exact names first, then the standard part they stand for (I-152 step 2, model/figure-bones.ts). */
const find = (mesh: SkinnedMesh, names: readonly string[]) => figureBone(mesh, names);

export class IntentLayer {
  private readonly torso = new RotationSpring({ ...MOTION_GROUPS.chest, eased: true });
  private readonly neckSpring = new RotationSpring({ ...MOTION_GROUPS.neck, eased: true });
  private readonly headSpring = new RotationSpring({ ...MOTION_GROUPS.head, eased: true });
  private readonly pelvisSprings = { lateral: new Spring(MOTION_GROUPS.pelvis), forward: new Spring(MOTION_GROUPS.pelvis), vertical: new Spring(MOTION_GROUPS.pelvis) };
  private readonly faceSprings = { curious: new Spring(FACE_SPRING), smile: new Spring(FACE_SPRING), startle: new Spring(FACE_SPRING) };
  private readonly breathSpring = new Spring({ hz: 0.6 }, 1);
  /** Showcase: expression slot → its spring (made on first use) and the slot's morph (by the universal aliases, or as the page says). */
  private readonly slotSprings = new Map<MorphSlot, Spring>();
  private slotMorphs: Partial<Record<MorphSlot, number>> | null = null;
  private readonly namedSprings = new Map<string, Spring>();
  private readonly armRaise = new Spring({ ...MOTION_GROUPS.arms, eased: true }, 0);
  /** Each arm chain and the upper arm's overhead rotation (its rest direction turned to up, in its parent's frame). */
  private readonly armChains: { arm: Bone; elbow: Bone | null; wrist: Bone | null; up: Quaternion }[] = [];
  private readonly limbs: LimbResidual;
  private targets: PoseTargets = { ...REST_TARGETS };
  private tempo: Tempo = 'calm';
  private readonly upper: Bone | null; private readonly upper2: Bone | null;
  private readonly neck: Bone | null; private readonly head: Bone | null;
  private readonly morphs: Record<keyof typeof FACE_MORPHS, { index: number; weight: number } | null>;
  private readonly savedMorphs = new Map<number, number>();
  private readonly q = new Quaternion();
  /** I-175: how much lip-sync owns the opening now (0..1, eased by the mouth), each named shape's mouth role, and this frame's base. */
  private mouthTalk = 0;
  private readonly namedRoles = new Map<string, MouthRole | null>();
  private base: MouthBase = NO_MOUTH_BASE;

  constructor(private readonly mesh: SkinnedMesh) {
    this.upper = find(mesh, ['上半身', 'spine', 'Spine']);
    this.upper2 = find(mesh, ['上半身2', 'chest', 'Chest']);
    this.neck = find(mesh, ['首', 'neck', 'Neck']);
    this.head = find(mesh, ['頭', 'head', 'Head']);
    for (const side of ['左', '右'] as const) {
      const arm = find(mesh, [`${side}腕`]), elbow = find(mesh, [`${side}ひじ`]), wrist = find(mesh, [`${side}手首`]);
      if (!arm || !elbow || elbow.position.lengthSq() < 1e-12) continue;
      // Bones rest at identity: the elbow's offset is the upper arm's direction in its parent's frame. Overhead: up, 18° out, 7° forward.
      const rest = elbow.position.clone().normalize(), out = Math.sign(rest.x) || (side === '左' ? 1 : -1);
      const up = new Vector3(out * Math.sin(18 * Math.PI / 180), Math.cos(18 * Math.PI / 180), Math.sin(7 * Math.PI / 180)).normalize();
      this.armChains.push({ arm, elbow, wrist, up: new Quaternion().setFromUnitVectors(rest, up) });
    }
    this.limbs = new LimbResidual(mesh);
    const dictionary = mesh.morphTargetDictionary ?? {};
    const pick = (names: readonly string[], weight: number) => { const name = names.find(n => dictionary[n] !== undefined); return name ? { index: dictionary[name], weight } : null; };
    this.morphs = Object.fromEntries(Object.entries(FACE_MORPHS).map(([cue, spec]) => [cue, pick(spec.names, spec.weight)])) as IntentLayer['morphs'];
  }

  /** The bones it can move (for the developer view / tests). */
  get breath(): number { return this.breathSpring.value; }
  get tiptoe(): number { return this.targets.tiptoe; }
  /** The arms' raise as realized now (0..1). */
  get armsRaised(): number { return this.armRaise.value; }
  get hasArms(): boolean { return this.armChains.length === 2; }
  get pelvis(): { lateral: number; forward: number; vertical: number } {
    return { lateral: this.pelvisSprings.lateral.value, forward: this.pelvisSprings.forward.value, vertical: this.pelvisSprings.vertical.value };
  }
  /** True when every residual is exactly at rest at zero (the layer writes nothing). */
  get idle(): boolean {
    const springs = [...Object.values(this.pelvisSprings), ...Object.values(this.faceSprings)];
    return this.torso.idle && this.neckSpring.idle && this.headSpring.idle && this.targets.blink === 0
      && this.armRaise.value === 0 && this.armRaise.target === 0
      && springs.every(s => s.value === 0 && s.target === 0 && s.velocity.v === 0) && [...this.slotSprings.values()].every(s => s.value === 0 && s.target === 0) && this.limbs.idle;
  }

  /** Her body is back upright and on her heels (within a hair): what "settled" means for the director. Eyes and face may still move. */
  get settled(): boolean {
    const small = (v: { x: number; y: number; z: number }) => Math.abs(v.x) < 2e-3 && Math.abs(v.y) < 2e-3 && Math.abs(v.z) < 2e-3;
    const p = this.pelvis;
    return small(this.torso.value) && small(this.neckSpring.value) && small(this.headSpring.value) && small({ x: p.lateral, y: p.vertical, z: p.forward }) && this.targets.tiptoe < 1e-3
      && Math.abs(this.armRaise.value) < 2e-3 && this.armRaise.target === 0;
  }
  /** The only input: the generator's targets for this frame. */
  set(targets: PoseTargets): void {
    this.targets = targets;
    if (targets.tempo !== this.tempo) { this.tempo = targets.tempo; this.retune(TEMPO[targets.tempo]); }
    const rot = (spring: RotationSpring, r: Rot) => spring.target(r.pitch, r.yaw, -r.roll);
    rot(this.torso, targets.torso); rot(this.neckSpring, targets.neck); rot(this.headSpring, targets.head);
    this.pelvisSprings.lateral.target = targets.pelvis.lateral; this.pelvisSprings.forward.target = targets.pelvis.forward; this.pelvisSprings.vertical.target = targets.pelvis.vertical;
    this.faceSprings.curious.target = targets.face.curious; this.faceSprings.smile.target = targets.face.smile; this.faceSprings.startle.target = targets.face.startle;
    this.breathSpring.target = Math.min(1.4, Math.max(0, targets.breath));
    this.limbs.set(targets);
    const raise = targets.arms?.raise;
    this.armRaise.target = raise !== undefined && Number.isFinite(raise) ? Math.min(1, Math.max(0, raise)) : 0;
    // Showcase expression slots: a slot not named this frame eases back to 0.
    const expr = targets.expr;
    for (const spring of this.slotSprings.values()) spring.target = 0;
    for (const spring of this.namedSprings.values()) spring.target = 0;
    if (targets.exprNamed) for (const [names, value] of Object.entries(targets.exprNamed)) {
      if (!Number.isFinite(value)) continue;
      let spring = this.namedSprings.get(names);
      if (!spring) this.namedSprings.set(names, spring = new Spring(SLOT_SPRING));
      spring.target = Math.min(1, Math.max(0, value));
    }
    if (expr) for (const [slot, value] of Object.entries(expr) as [MorphSlot, number][]) {
      if (!Number.isFinite(value)) continue;
      let spring = this.slotSprings.get(slot);
      if (!spring) this.slotSprings.set(slot, spring = new Spring(SLOT_SPRING));
      spring.target = Math.min(1, Math.max(0, value));
    }
  }
  /** Showcase: the hand reach goals of this frame (the figure's arm reach reads them). */
  get hands(): PoseTargets['hands'] { return this.targets.hands; }
  /** Showcase: slot → morph index as the page's model profile verified them (otherwise the universal aliases, by name). */
  setSlotMorphs(map: Partial<Record<MorphSlot, number>> | null): void { this.slotMorphs = map; }
  /** I-175: lip-sync owns the opening by `talk` (0..1, eased by the mouth): expression openings and closed-mouth shapes give way by it. */
  setMouthTalk(talk: number): void { this.mouthTalk = Number.isFinite(talk) ? Math.min(1, Math.max(0, talk)) : 0; }
  /** I-175: the mouth's base shape on the last frame written (before anything gave way to lip-sync). */
  get mouthBase(): MouthBase { return this.base; }
  private slotMorph(slot: MorphSlot): number | null {
    const known = this.slotMorphs?.[slot];
    if (known !== undefined) return known >= 0 ? known : null;
    const dictionary = this.mesh.morphTargetDictionary ?? {}, keys = Object.keys(dictionary);
    for (const alias of MORPH_ALIASES[slot]) { const key = keys.find(k => k.toLowerCase() === alias.toLowerCase()); if (key) return dictionary[key]; }
    return null;
  }

  /** One sub-step (1/120 s). */
  advance(h: number): void {
    this.torso.advance(h); this.neckSpring.advance(h); this.headSpring.advance(h);
    for (const s of Object.values(this.pelvisSprings)) s.advance(h);
    for (const s of Object.values(this.faceSprings)) s.advance(h);
    this.breathSpring.advance(h);
    for (const spring of [...this.slotSprings.values(), ...this.namedSprings.values()]) { spring.advance(h); if (spring.target === 0 && !spring.moving(1e-5)) spring.reset(0); }
    if (this.armRaise.value !== 0 || this.armRaise.target !== 0) {
      this.armRaise.advance(h);
      if (this.armRaise.target === 0 && !this.armRaise.moving(1e-6)) this.armRaise.reset(0); // exactly at rest: writes nothing
    }
    this.limbs.advance(h);
  }

  /** Writes the residuals (bones through `rotate`, which remembers them for the restore; morphs saved here). */
  apply(rotate: (bone: Bone, rotation: Quaternion) => void): void {
    if (!this.torso.idle) {
      const lean = this.torso.quaternion(this.q);
      if (this.upper && this.upper2) {
        // 60% at the bottom of her back, 40% higher up: a bend, not a hinge.
        rotate(this.upper, this.q.clone().slerp(new Quaternion(), 0.4));
        rotate(this.upper2, lean.clone().slerp(new Quaternion(), 0.6));
      } else if (this.upper ?? this.upper2) rotate((this.upper ?? this.upper2)!, lean);
    }
    if (!this.neckSpring.idle && this.neck) rotate(this.neck, this.neckSpring.quaternion(this.q).clone());
    if (!this.headSpring.idle && this.head) rotate(this.head, this.headSpring.quaternion(this.q).clone());
    const w = this.armRaise.value;
    if (w > 1e-5) {
      // Each bone: from the pose it has now toward its overhead pose by w (q · r = slerp(q, goal, w), so r = q⁻¹ · slerp(q, goal, w)).
      const toward = (bone: Bone | null, goal: Quaternion) => {
        if (!bone) return;
        const now = bone.quaternion, blended = now.clone().slerp(goal, w);
        rotate(bone, now.clone().invert().multiply(blended));
      };
      for (const chain of this.armChains) { toward(chain.arm, chain.up); toward(chain.elbow, IDENTITY); toward(chain.wrist, IDENTITY); }
    }
    this.limbs.apply(rotate);
    const influences = this.mesh.morphTargetInfluences;
    if (!influences) return;
    const face = this.faceSprings, cues: [keyof typeof FACE_MORPHS, number][] = [
      ['blink', this.targets.blink], ['curious', face.curious.value], ['smile', face.smile.value], ['smileBrow', face.smile.value], ['startle', face.startle.value]];
    const wanted = new Map<number, number>();
    for (const [cue, value] of cues) {
      const morph = this.morphs[cue];
      if (!morph || !(value > 1e-4)) continue;
      wanted.set(morph.index, Math.min(1, (wanted.get(morph.index) ?? 0) + value * morph.weight));
    }
    // I-175: the base is read before anything gives way; a shape stays while she speaks, the opening and closed-mouth shapes give way.
    const talk = this.mouthTalk, baseSlots: Partial<Record<string, number>> = { mouthSmile: face.smile.value * (this.morphs.smile?.weight ?? 0) };
    let baseNamed: Record<string, number> | null = null;
    for (const [slot, spring] of this.slotSprings) {
      if (!(spring.value > 1e-4)) continue;
      baseSlots[slot] = Math.max(baseSlots[slot] ?? 0, spring.value);
      const index = this.slotMorph(slot), value = spring.value * talkFade(mouthRoleOfSlot(slot), talk);
      if (index !== null && value > 1e-4) wanted.set(index, Math.min(1, (wanted.get(index) ?? 0) + value));
    }
    for (const [names, spring] of this.namedSprings) {
      if (!(spring.value > 1e-4)) continue;
      (baseNamed ??= {})[names] = spring.value;
      const dictionary = this.mesh.morphTargetDictionary ?? {}, keys = Object.keys(dictionary);
      const key = names.split('|').map(n => keys.find(k => k.toLowerCase() === n.toLowerCase())).find(Boolean);
      // The role of the morph it LANDS on (Codex T-258 C02): a pucker named 「mouthFunnel|…|う」 on a model without a funnel morph is written to う,
      // the flap's own index, so it is an opening there and yields to lip-sync; the first name's role is the fallback for a name no model has.
      let role = this.namedRoles.get(names);
      if (role === undefined) this.namedRoles.set(names, role = (key ? mouthRoleOfName(key) : null) ?? mouthRoleOfName(names));
      const value = spring.value * talkFade(role, talk);
      if (!(value > 1e-4)) continue;
      if (key) wanted.set(dictionary[key], Math.min(1, (wanted.get(dictionary[key]) ?? 0) + value));
    }
    this.base = mouthBaseOf(baseSlots, baseNamed);
    this.capLids(wanted);
    for (const [index, value] of wanted) {
      if (!this.savedMorphs.has(index)) this.savedMorphs.set(index, influences[index] ?? 0);
      influences[index] = Math.max(influences[index] ?? 0, value);
    }
  }

  /**
   * I-175 step 4: the lids under one ceiling (shared/behaviors/part-mix/lids-head.ts, the old stage's rule): the smile eyes and the half lid
   * give way as the blink closes and the blink gets what they leave, so smile eyes plus a blink never close past shut. Only when a lid shape
   * is asked; `lids` keeps what was asked and what shows (diagnostics, tests).
   */
  private capLids(wanted: Map<number, number>): void {
    const blink = this.morphs.blink?.index ?? this.slotMorph('blink'), smile = this.slotMorph('smileEyes'), half = this.slotMorph('jitome');
    const s = smile !== null && smile !== blink ? wanted.get(smile) ?? 0 : 0, j = half !== null && half !== blink ? wanted.get(half) ?? 0 : 0;
    if (blink === null || (!(s > 0) && !(j > 0))) { this.lids.asked = this.lids.shown = Math.min(1, blink === null ? 0 : wanted.get(blink) ?? 0); return; }
    const overlap = (s > 0 && smile !== null && this.overlaps(blink, smile)) || (j > 0 && half !== null && this.overlaps(blink, half));
    const closure = wanted.get(blink) ?? 0, out = lidsUnderCeiling(closure, s, j, undefined, this.lidScratch, overlap);
    this.lids.asked = closure + Math.max(s, j); this.lids.shown = out.blink + Math.max(out.smileEyes, out.jitome);
    if (closure > 0 || out.blink > 0) wanted.set(blink, out.blink);
    if (smile !== null && s > 0) wanted.set(smile, out.smileEyes);
    if (half !== null && j > 0) wanted.set(half, out.jitome);
  }
  private readonly lidScratch = { blink: 0, smileEyes: 0, jitome: 0 };
  private readonly overlapCache = new Map<string, boolean>();
  /** Do morphs `a` and `b` move a vertex in common (read once from the geometry)? No morph geometry to read (a standard face): assume they do. */
  private overlaps(a: number, b: number): boolean {
    const key = `${a}:${b}`, known = this.overlapCache.get(key);
    if (known !== undefined) return known;
    const geometry = this.mesh.geometry, base = geometry?.getAttribute?.('position'), ma = geometry?.morphAttributes?.position?.[a], mb = geometry?.morphAttributes?.position?.[b];
    let result = true;
    if (base && ma && mb && ma.count === base.count && mb.count === base.count) {
      const relative = geometry.morphTargetsRelative === true;
      const moves = (m: typeof ma, v: number) => { const dx = m.getX(v) - (relative ? 0 : base.getX(v)), dy = m.getY(v) - (relative ? 0 : base.getY(v)), dz = m.getZ(v) - (relative ? 0 : base.getZ(v)); return dx * dx + dy * dy + dz * dz > 1e-14; };
      result = false;
      for (let v = 0; v < base.count && !result; v++) if (moves(ma, v) && moves(mb, v)) result = true;
    }
    this.overlapCache.set(key, result);
    return result;
  }
  /** I-175: the last frame's lids: the blink plus the larger lid shape as asked by her writers, and as shown under the ceiling. */
  readonly lids = { asked: 0, shown: 0 };

  /** Puts the morphs back as the motion had them (bones are restored by the figure). */
  restore(): void {
    const influences = this.mesh.morphTargetInfluences;
    if (influences) for (const [index, value] of this.savedMorphs) influences[index] = value;
    this.savedMorphs.clear();
  }

  private retune(spec: (typeof TEMPO)[Tempo]): void {
    this.torso.retune(spec.torso); this.neckSpring.retune(spec.neck); this.headSpring.retune(spec.head);
    for (const s of Object.values(this.pelvisSprings)) s.retune(spec.pelvis);
    for (const s of Object.values(this.faceSprings)) s.retune(spec.face);
  }
}

