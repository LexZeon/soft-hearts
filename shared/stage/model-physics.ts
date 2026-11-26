import { normalizeModelPhysicsTuning, type ModelPhysicsTuning } from "./physics-tuning";

export type PhysicsPart = "hair" | "chest";
export type PhysicsQuality = "low" | "standard" | "high";

/** Compatibility names for the stage adapter; these are the same narrow types. */
export type ModelPhysicsPart = PhysicsPart;
export type ModelPhysicsQuality = PhysicsQuality;

export interface ModelPhysicsPartSettings {
  enabled: boolean;
  /** Blend of the bounded simulated result, independent of the solver budget. */
  strength: number;
}

/** Local presentation settings only; these grant no model or execution access. */
export interface ModelPhysicsSettings {
  hair: ModelPhysicsPartSettings;
  chest: ModelPhysicsPartSettings;
  quality: PhysicsQuality;
  /**
   * The current model's saved lab overrides (shared/stage/physics-tuning.ts), added by the host for the windows that show her; never
   * persisted with these switches. Absent: the physics runs exactly as without the lab.
   */
  tuning?: ModelPhysicsTuning;
  /**
   * I-136 step 5d「碰了才软」, resolved by the host for the windows (the lab's saved choice, else the channel's default); never
   * persisted with these switches. Absent: off.
   */
  touchSoft?: { enabled: boolean; strength: number };
}

/** Trial output strengths; original model springs and damping remain unchanged. */
export const DEFAULT_MODEL_PHYSICS: Readonly<{
  hair: Readonly<ModelPhysicsPartSettings>;
  chest: Readonly<ModelPhysicsPartSettings>;
  quality: PhysicsQuality;
}> = Object.freeze({
  hair: Object.freeze({ enabled: false, strength: 0.65 }),
  chest: Object.freeze({ enabled: false, strength: 0.35 }),
  quality: "standard",
});

export const DEFAULT_MODEL_PHYSICS_SETTINGS = DEFAULT_MODEL_PHYSICS;

/** Counts describe an inspected rig without exposing private names or paths. */
export interface ModelPhysicsPartSupport {
  readonly supported: boolean;
  readonly bones: number;
  readonly bodies: number;
  /** A safe explanation of an unavailable part, otherwise null. */
  readonly reason: string | null;
}

export interface ModelPhysicsSupport {
  readonly hair: ModelPhysicsPartSupport;
  readonly chest: ModelPhysicsPartSupport;
}

export type ModelPhysicsStatus =
  | "off"
  | "ready"
  | "running"
  | "hidden"
  | "unsupported"
  | "error"
  | "disposed";

/** Runtime diagnostics only; never persist these as settings or character data. */
export interface ModelPhysicsState {
  readonly support: ModelPhysicsSupport;
  /** Requested switches, including unsupported or temporarily hidden parts. */
  readonly enabled: Readonly<Record<PhysicsPart, boolean>>;
  /** Whether the current visible model is advancing an enabled supported part. */
  readonly running: boolean;
  readonly quality: PhysicsQuality;
  readonly bodyCount: number;
  readonly constraintCount: number;
  /** Cumulative solver steps for this adapter instance. */
  readonly steps: number;
  /** Live explicitly owned Ammo objects, not an estimate of heap usage. */
  readonly liveObjects: number;
  /** Measured solver time; excludes renderer and frame scheduling time. */
  readonly avgStepMs: number;
  readonly status: ModelPhysicsStatus;
}

function ownField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function strength(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function quality(value: unknown, fallback: PhysicsQuality): PhysicsQuality {
  return value === "low" || value === "standard" || value === "high" ? value : fallback;
}

function partSettings(value: unknown, fallback: Readonly<ModelPhysicsPartSettings>): ModelPhysicsPartSettings {
  const enabled = ownField(value, "enabled");
  return {
    enabled: typeof enabled === "boolean" ? enabled : fallback.enabled,
    strength: strength(ownField(value, "strength"), fallback.strength),
  };
}

/**
 * Normalize a saved value or a partial update without enabling legacy settings.
 * Missing or malformed fields retain the last valid value, then the defaults.
 * Explicit false and zero remain valid. Only finite numbers are clamped; strings
 * and truthy values are never coerced. Unknown fields are not copied or acted on.
 */
export function normalizeModelPhysicsSettings(input: unknown, previous?: unknown): ModelPhysicsSettings {
  const previousHair = partSettings(ownField(previous, "hair"), DEFAULT_MODEL_PHYSICS.hair);
  const previousChest = partSettings(ownField(previous, "chest"), DEFAULT_MODEL_PHYSICS.chest);
  const previousQuality = quality(ownField(previous, "quality"), DEFAULT_MODEL_PHYSICS.quality);
  const settings: ModelPhysicsSettings = {
    hair: partSettings(ownField(input, "hair"), previousHair),
    chest: partSettings(ownField(input, "chest"), previousChest),
    quality: quality(ownField(input, "quality"), previousQuality),
  };
  // The lab's tuning comes only with the value itself, never from the previous one: the host sends it with every update (null or
  // absent: none), so settings without one always mean "exactly as without the lab". Validated and clamped every time.
  const tuning = normalizeModelPhysicsTuning(ownField(input, "tuning"));
  if (tuning) settings.tuning = tuning;
  // I-136 5d: like the tuning, only from the value itself (the host sends it with every update).
  const touch = ownField(input, "touchSoft"), touchEnabled = ownField(touch, "enabled"), touchStrength = ownField(touch, "strength");
  if (typeof touchEnabled === "boolean") settings.touchSoft = { enabled: touchEnabled,
    strength: typeof touchStrength === "number" && Number.isFinite(touchStrength) ? Math.min(2, Math.max(0, touchStrength)) : 1 };
  return settings;
}
