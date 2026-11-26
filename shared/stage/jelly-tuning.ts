/**
 * I-147 全身果冻 (docs/claude/2026-11-17-whole-body-jelly.md): the two experimental layers' knobs, saved inside a model's lab tuning
 * (`ModelPhysicsTuning.jelly`, shared/stage/physics-tuning.ts; same sidecar, same content-hash key, never in a card or the PMX).
 * - follow: layer 2, follow-through on the main skeleton (src/stage/jelly/follow-through.ts).
 * - soft:   layer 3, soft-region vertex jelly (src/stage/jelly/soft-jelly.ts).
 * Absent, or a layer's `enabled` false: that layer does nothing at all (no bone, material or geometry is touched).
 * Every number is clamped here (the host, the renderer and the lab all pass through this), so a stored or sent value can never ask
 * for an unbounded rotation or displacement. Amplitudes are small by default; the bounds stay modest on purpose.
 */

export const FOLLOW_REGIONS = ["spine", "neck", "head", "shoulders", "arms"] as const;
export type FollowRegion = typeof FOLLOW_REGIONS[number];
export const SOFT_REGIONS = ["belly", "hips", "thighs", "upperArms", "cheeks", "chest"] as const;
export type SoftRegion = typeof SOFT_REGIONS[number];

/** One damped spring: natural frequency (Hz) and damping ratio (0 rings forever, 1 settles without overshoot). */
export interface FollowRegionTuning {
  hz: number;
  damping: number;
  /** Largest rotation this layer may add to one bone, degrees (a soft limit: it is approached, never passed). */
  maxDeg: number;
}

export interface SoftRegionTuning {
  enabled: boolean;
  hz: number;
  damping: number;
  /** Largest displacement, as a fraction of the region's own size (its radius). */
  maxOffset: number;
  /** Radius of the region, as a multiple of the size measured from the model's vertices. */
  radius: number;
  /** Falloff exponent from the centre to the edge (1 linear, higher: only the middle moves). */
  falloff: number;
  /** How strongly the body's acceleration pushes this region (1: physical, higher: more jelly). */
  gain: number;
}

export interface FollowTuning { enabled: boolean; regions: Record<FollowRegion, FollowRegionTuning> }
export interface SoftTuning { enabled: boolean; regions: Record<SoftRegion, SoftRegionTuning> }
/**
 * I-136 step 5d「碰了才软」: the touched soft region dents and springs back (layer 3's regions and caps, only where and while touched).
 * `enabled` null: the channel's default (the host decides: development and source runs on, stable off until the user tries it).
 */
export interface TouchSoftTuning { enabled: boolean | null; strength: number }
export interface JellyTuning { follow: FollowTuning; soft: SoftTuning; touch?: TouchSoftTuning }
export const TOUCH_SOFT_STRENGTH: readonly [number, number] = [0, 2];

/** The switch the windows get (the host resolves a null against the channel). */
export function resolveTouchSoft(tuning: JellyTuning | null | undefined, channelDefault: boolean): { enabled: boolean; strength: number } {
  const touch = tuning?.touch;
  return { enabled: typeof touch?.enabled === "boolean" ? touch.enabled : channelDefault, strength: touch ? touch.strength : 1 };
}

export const JELLY_BOUNDS = Object.freeze({
  hz: [0.5, 8], damping: [0.05, 1.5], maxDeg: [0, 10],
  maxOffset: [0, 0.3], radius: [0.25, 2.5], falloff: [0.25, 4], gain: [0, 4],
} as const);

/** Starting points (tasteful, small): about 0.3 s to settle; 3° on the trunk and head, 5° on the arms. */
export const FOLLOW_DEFAULTS: Readonly<Record<FollowRegion, Readonly<FollowRegionTuning>>> = Object.freeze({
  spine: Object.freeze({ hz: 3, damping: 0.6, maxDeg: 3 }),
  neck: Object.freeze({ hz: 3.5, damping: 0.5, maxDeg: 3 }),
  head: Object.freeze({ hz: 3.5, damping: 0.45, maxDeg: 3 }),
  shoulders: Object.freeze({ hz: 3, damping: 0.55, maxDeg: 3 }),
  arms: Object.freeze({ hz: 2.5, damping: 0.5, maxDeg: 5 }),
});

export const SOFT_DEFAULTS: Readonly<Record<SoftRegion, Readonly<SoftRegionTuning>>> = Object.freeze({
  belly: Object.freeze({ enabled: true, hz: 3, damping: 0.35, maxOffset: 0.06, radius: 1, falloff: 1.5, gain: 1 }),
  hips: Object.freeze({ enabled: true, hz: 2.5, damping: 0.35, maxOffset: 0.06, radius: 1, falloff: 1.5, gain: 1 }),
  thighs: Object.freeze({ enabled: true, hz: 3, damping: 0.4, maxOffset: 0.05, radius: 1, falloff: 1.5, gain: 1 }),
  upperArms: Object.freeze({ enabled: true, hz: 3.5, damping: 0.4, maxOffset: 0.05, radius: 1, falloff: 1.5, gain: 1 }),
  cheeks: Object.freeze({ enabled: true, hz: 4.5, damping: 0.35, maxOffset: 0.06, radius: 1, falloff: 1.5, gain: 1 }),
  chest: Object.freeze({ enabled: true, hz: 2.5, damping: 0.3, maxOffset: 0.08, radius: 1, falloff: 1.2, gain: 1 }),
});

function own(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}
function clamp(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function defaultJellyTuning(): JellyTuning {
  const follow = {} as Record<FollowRegion, FollowRegionTuning>, soft = {} as Record<SoftRegion, SoftRegionTuning>;
  for (const region of FOLLOW_REGIONS) follow[region] = { ...FOLLOW_DEFAULTS[region] };
  for (const region of SOFT_REGIONS) soft[region] = { ...SOFT_DEFAULTS[region] };
  return { follow: { enabled: false, regions: follow }, soft: { enabled: false, regions: soft } };
}

/** Validates and clamps; unknown fields dropped; anything missing takes the default (and a layer without a real `true` stays off). */
export function normalizeJellyTuning(input: unknown): JellyTuning {
  const out = defaultJellyTuning(), b = JELLY_BOUNDS;
  const follow = own(input, "follow"), soft = own(input, "soft");
  out.follow.enabled = own(follow, "enabled") === true;
  out.soft.enabled = own(soft, "enabled") === true;
  for (const region of FOLLOW_REGIONS) {
    const raw = own(own(follow, "regions"), region), base = FOLLOW_DEFAULTS[region];
    out.follow.regions[region] = { hz: clamp(own(raw, "hz"), b.hz, base.hz), damping: clamp(own(raw, "damping"), b.damping, base.damping),
      maxDeg: clamp(own(raw, "maxDeg"), b.maxDeg, base.maxDeg) };
  }
  const touch = own(input, "touch");
  if (touch !== undefined) {
    const enabled = own(touch, "enabled");
    out.touch = { enabled: typeof enabled === "boolean" ? enabled : null, strength: clamp(own(touch, "strength"), TOUCH_SOFT_STRENGTH, 1) };
  }
  for (const region of SOFT_REGIONS) {
    const raw = own(own(soft, "regions"), region), base = SOFT_DEFAULTS[region], enabled = own(raw, "enabled");
    out.soft.regions[region] = { enabled: typeof enabled === "boolean" ? enabled : base.enabled,
      hz: clamp(own(raw, "hz"), b.hz, base.hz), damping: clamp(own(raw, "damping"), b.damping, base.damping),
      maxOffset: clamp(own(raw, "maxOffset"), b.maxOffset, base.maxOffset), radius: clamp(own(raw, "radius"), b.radius, base.radius),
      falloff: clamp(own(raw, "falloff"), b.falloff, base.falloff), gain: clamp(own(raw, "gain"), b.gain, base.gain) };
  }
  return out;
}

/** True when neither layer is on (then nothing of this file has any effect anywhere). */
export function jellyOff(tuning: JellyTuning | null | undefined): boolean {
  return !tuning || (!tuning.follow.enabled && !tuning.soft.enabled);
}

/**
 * 「碰了才软」 as the windows get it, with the user's own switch in settings (shared/foundation/channel-defaults.ts) in the order the user
 * would expect: a choice the user saved in settings wins; else the lab's saved choice; else the channel's default.
 */
export function resolveTouchSoftWithGate(tuning: JellyTuning | null | undefined, savedChoice: boolean | null, channelDefault: boolean): { enabled: boolean; strength: number } {
  const resolved = resolveTouchSoft(tuning, channelDefault);
  return typeof savedChoice === "boolean" ? { ...resolved, enabled: savedChoice } : resolved;
}
