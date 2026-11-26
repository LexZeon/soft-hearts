/**
 * 物理调参台 (R01, docs/claude/2026-11-17-physics-lab.md): per-model physics overrides the user made in the lab. Saved by the host in
 * its own sidecar (physics-tuning.json in the profile), keyed by the model's content hash; never in the PMX, never in a portable
 * character card. With none, the companion's physics is exactly what it was. Every number is a multiplier or a bounded knob, clamped here,
 * so a stored or sent value can never ask Bullet or the spring solver for something unbounded.
 *
 * Group ids are `hair:<n>` / `chest:<n>` (n = the group's lowest PMX body index, src/stage/physics-lab/groups.ts): stable for the
 * same model bytes, and they carry no bone name. `rig` is the model's body/joint/bone counts: a tuning made for one model is never
 * applied to another one that happens to load during a switch.
 */
import type { PhysicsPart } from "./model-physics";
import { normalizeJellyTuning, type JellyTuning } from "./jelly-tuning";

export type PhysicsEngine = "ammo" | "spring";

/** Ammo (the model's own rigid bodies): multipliers on what the model authored. */
export interface AmmoGroupTuning {
  damping: number;
  spring: number;
  angleLimit: number;
  gravity: number;
  mass: number;
}

/** The spring-bone solver (per bone, every rendered frame): absolute knobs in the style of game secondary motion. */
export interface SpringBoneTuning {
  /** 0..1: how quickly a bone springs back (0.4 Hz .. 6 Hz). */
  elastic: number;
  /** 0..1: damping ratio (0 bounces forever, 1 settles without overshoot). */
  damping: number;
  /** Degrees a bone may leave its animated direction. */
  angleLimit: number;
  /** 0..1 of MMD gravity. */
  gravity: number;
  /** 0..1: how much of the parent's movement the tail lags behind (1: all of it). */
  inertia: number;
}

export interface PhysicsGroupTuning {
  enabled: boolean;
  /** Output blend for this group; null keeps the part's strength from the settings. */
  strength: number | null;
  engine: PhysicsEngine;
  ammo: AmmoGroupTuning;
  springBone: SpringBoneTuning;
}

export interface PhysicsCollisionTuning {
  /** The arms collide with the chest (off since a0c532d: a talking hand shook the chest). */
  chestArms: boolean;
  /** Hair collides with the body's collision shapes (on: as authored). */
  hairBody: boolean;
}

export interface ModelPhysicsTuning {
  version: 1;
  /** `<bodies>/<joints>/<bones>` of the model the tuning was made for. */
  rig: string;
  /** Ammo fixed step rate (Hz); 65 is MMD's. */
  substepHz: number;
  collisions: PhysicsCollisionTuning;
  groups: Record<string, PhysicsGroupTuning>;
  /** I-147 全身果冻 layers 2 and 3 (shared/stage/jelly-tuning.ts); absent: both off. Never part of the physics signature. */
  jelly?: JellyTuning;
}

export const MAX_TUNED_GROUPS = 64;
export const DEFAULT_SUBSTEP_HZ = 65;

export const AMMO_TUNING_DEFAULT: Readonly<AmmoGroupTuning> = Object.freeze({ damping: 1, spring: 1, angleLimit: 1, gravity: 1, mass: 1 });
/** Starting points when a group is switched to the spring solver (not defaults of the companion: nothing runs it unless chosen). */
export const SPRING_TUNING_START: Readonly<Record<PhysicsPart, Readonly<SpringBoneTuning>>> = Object.freeze({
  hair: Object.freeze({ elastic: 0.3, damping: 0.45, angleLimit: 50, gravity: 0.35, inertia: 0.85 }),
  chest: Object.freeze({ elastic: 0.6, damping: 0.35, angleLimit: 10, gravity: 0.1, inertia: 0.5 }),
});
export const COLLISIONS_DEFAULT: Readonly<PhysicsCollisionTuning> = Object.freeze({ chestArms: false, hairBody: true });

/** Bounds of every knob (the lab's sliders use the same). */
export const TUNING_BOUNDS = Object.freeze({
  strength: [0, 1], damping: [0, 4], spring: [0, 4], angleLimit: [0.25, 3], gravity: [0, 3], mass: [0.1, 10],
  elastic: [0, 1], springDamping: [0, 1], springAngle: [1, 90], springGravity: [0, 1], inertia: [0, 1], substepHz: [30, 240],
} as const);

const GROUP_ID = /^(hair|chest):\d{1,5}$/;
const RIG = /^\d{1,5}\/\d{1,5}\/\d{1,5}$/;

function own(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}
function clamp(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
function bool(value: unknown, fallback: boolean): boolean { return typeof value === "boolean" ? value : fallback; }

export function groupPart(id: string): PhysicsPart { return id.startsWith("chest:") ? "chest" : "hair"; }

export function defaultGroupTuning(part: PhysicsPart): PhysicsGroupTuning {
  return { enabled: true, strength: null, engine: "ammo", ammo: { ...AMMO_TUNING_DEFAULT }, springBone: { ...SPRING_TUNING_START[part] } };
}

export function normalizeGroupTuning(input: unknown, part: PhysicsPart): PhysicsGroupTuning {
  const base = defaultGroupTuning(part), b = TUNING_BOUNDS;
  const ammo = own(input, "ammo"), spring = own(input, "springBone"), strength = own(input, "strength");
  return {
    enabled: bool(own(input, "enabled"), true),
    strength: strength === null || strength === undefined ? null : clamp(strength, b.strength, 0.5),
    engine: own(input, "engine") === "spring" ? "spring" : "ammo",
    ammo: {
      damping: clamp(own(ammo, "damping"), b.damping, 1), spring: clamp(own(ammo, "spring"), b.spring, 1),
      angleLimit: clamp(own(ammo, "angleLimit"), b.angleLimit, 1), gravity: clamp(own(ammo, "gravity"), b.gravity, 1),
      mass: clamp(own(ammo, "mass"), b.mass, 1),
    },
    springBone: {
      elastic: clamp(own(spring, "elastic"), b.elastic, base.springBone.elastic),
      damping: clamp(own(spring, "damping"), b.springDamping, base.springBone.damping),
      angleLimit: clamp(own(spring, "angleLimit"), b.springAngle, base.springBone.angleLimit),
      gravity: clamp(own(spring, "gravity"), b.springGravity, base.springBone.gravity),
      inertia: clamp(own(spring, "inertia"), b.inertia, base.springBone.inertia),
    },
  };
}

/**
 * Validates and clamps a tuning from a file, the renderer or the lab. Unknown fields are dropped; a bad group id or rig signature
 * makes the whole tuning (or that group) invalid rather than guessed. Returns null when nothing usable is left.
 */
export function normalizeModelPhysicsTuning(input: unknown): ModelPhysicsTuning | null {
  if (own(input, "version") !== 1) return null;
  const rig = own(input, "rig");
  if (typeof rig !== "string" || !RIG.test(rig)) return null;
  const groups: Record<string, PhysicsGroupTuning> = {};
  const raw = own(input, "groups");
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const id of Object.keys(raw).slice(0, MAX_TUNED_GROUPS)) {
      if (GROUP_ID.test(id)) groups[id] = normalizeGroupTuning((raw as Record<string, unknown>)[id], groupPart(id));
    }
  }
  const collisions = own(input, "collisions"), jelly = own(input, "jelly");
  const out: ModelPhysicsTuning = {
    version: 1, rig, substepHz: Math.round(clamp(own(input, "substepHz"), TUNING_BOUNDS.substepHz, DEFAULT_SUBSTEP_HZ)),
    collisions: { chestArms: bool(own(collisions, "chestArms"), COLLISIONS_DEFAULT.chestArms), hairBody: bool(own(collisions, "hairBody"), COLLISIONS_DEFAULT.hairBody) },
    groups,
  };
  if (jelly !== undefined && jelly !== null) out.jelly = normalizeJellyTuning(jelly);
  return out;
}

/** True when a tuning changes nothing in the hair/chest physics (its physics then runs exactly as without one; `jelly` is separate). */
export function isNeutralTuning(tuning: ModelPhysicsTuning | null | undefined): boolean {
  if (!tuning) return true;
  if (tuning.substepHz !== DEFAULT_SUBSTEP_HZ || tuning.collisions.chestArms !== COLLISIONS_DEFAULT.chestArms
    || tuning.collisions.hairBody !== COLLISIONS_DEFAULT.hairBody) return false;
  return Object.values(tuning.groups).every(group => group.enabled && group.strength === null && group.engine === "ammo"
    && Object.entries(AMMO_TUNING_DEFAULT).every(([key, value]) => group.ammo[key as keyof AmmoGroupTuning] === value));
}

/** A stable string for "did the tuning change" (the stage rebuilds its worlds only then). */
export function tuningSignature(tuning: ModelPhysicsTuning | null | undefined): string {
  if (!tuning || isNeutralTuning(tuning)) return "";
  const { jelly: _jelly, ...physics } = tuning; // the jelly layers never rebuild the physics worlds
  return JSON.stringify(physics);
}
