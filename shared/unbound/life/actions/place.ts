/**
 * Her own action: changing place (Unbound v1 step 4). She picks a spot from her mood and what you are doing and walks there with the
 * walk she already has (the gait: no teleport, feet planted). You busy, or a video or a game in front: further back, to the side.
 * You paused: a little closer. Sleepy: a corner. You left (the camera sees nobody): anywhere she likes. You came back: a little
 * closer (a welcome). Otherwise near where she usually stands. N up → further; E up → closer.
 * I-212: every box is in screen terms (across, and her size: her height as a share of the usable screen
 * height), converted from the old metres so that the laptop they were judged on looks as before (8 m = 0.5; shared/unbound/screen-terms).
 * Coming closer to you is the one move you can answer (the 'peek-answered' moment).
 */
import type { LifeActionSpec, LifeContext, LifeSpot } from '../action';

export type PlaceZone = 'busy' | 'paused' | 'sleepy' | 'home' | 'wander';
/** Each zone's box: across (0..1 of the screen width) and size (her height as a share of the usable height; small = far). Converted from the first metres (record). */
export const PLACE_ZONES: Readonly<Record<PlaceZone, { across: readonly [number, number]; size: readonly [number, number] }>> = Object.freeze({
  busy: { across: [0.83, 0.9], size: [0.398, 0.438] }, // 9.2-10.2 m
  paused: { across: [0.62, 0.74], size: [0.525, 0.566] }, // 7.0-7.6 m
  sleepy: { across: [0.88, 0.93], size: [0.377, 0.405] }, // 10.0-10.8 m
  home: { across: [0.74, 0.82], size: [0.467, 0.512] }, // 7.8-8.6 m
  wander: { across: [0.2, 0.9], size: [0.39, 0.524] }, // 7.6-10.4 m
});
/** Mood moves her size: N up → down to this factor (further; about 1 m back); E up → up to this factor (closer; about 0.5 m). And where her size may end up. */
export const PLACE_MOOD = Object.freeze({ tenseSmaller: 0.9, warmBigger: 1.06, size: [0.364, 0.598] as const });
/** While you are away she changes place this many times more often. */
export const WANDER_FASTER = 3;
/** She is already there when she stands within this of the zone's box. */
const NEAR = Object.freeze({ across: 0.04, size: 0.025 });

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Which zone, from what you do, her sleepiness and what she reacts to. */
export function placeZone(context: Pick<LifeContext, 'situation' | 'drives' | 'cue' | 'youLeft'>): PlaceZone {
  const s = context.situation.signals;
  if (context.drives.sleepy >= 0.6) return 'sleepy';
  if (context.cue?.kind === 'came-back') return 'paused';
  if (context.youLeft) return 'wander';
  if (s.foreground === 'video' || s.foreground === 'game') return 'busy';
  if (s.doing === 'busy') return 'busy';
  if (s.doing === 'paused') return 'paused';
  return 'home';
}

/** Inside the zone's box (with a margin): no reason to walk. */
export function insideZone(spot: LifeSpot, zone: PlaceZone): boolean {
  const z = PLACE_ZONES[zone];
  return spot.across >= z.across[0] - NEAR.across && spot.across <= z.across[1] + NEAR.across && spot.size >= z.size[0] - NEAR.size && spot.size <= z.size[1] + NEAR.size;
}

/** A spot in the zone, moved by her mood. */
export function pickSpot(zone: PlaceZone, context: Pick<LifeContext, 'drives' | 'random'>): LifeSpot {
  const z = PLACE_ZONES[zone], d = context.drives;
  const mood = PLACE_MOOD.tenseSmaller ** clamp(d.tense, 0, 1) * (zone === 'paused' || zone === 'home' ? PLACE_MOOD.warmBigger ** clamp(d.warm, 0, 1) : 1);
  return { across: lerp(z.across[0], z.across[1], context.random()), size: clamp(lerp(z.size[0], z.size[1], context.random()) * mood, PLACE_MOOD.size[0], PLACE_MOOD.size[1]) };
}

/**
 * I-205b: the spot she chose in her own reply outranks the rules (busy, paused, home, wander) while its window is open. Sleepiness is the one
 * rule that still applies (a tired corner is her body, not a reaction to you), as it does today.
 */
export function chosenSpotHolds(context: Pick<LifeContext, 'chosenSpotKept'>, zone: PlaceZone): boolean {
  return context.chosenSpotKept === true && zone !== 'sleepy';
}

export const PLACE: LifeActionSpec = {
  id: 'place', level: 'place', words: '换个地方站',
  interval: rates => rates.placeMinutes * 60,
  notNow: context => {
    const zone = placeZone(context);
    if (!context.here) return '还不知道她站在哪';
    if (chosenSpotHolds(context, zone)) return '她自己选了站的地方，先待着';
    if (zone !== 'wander' && insideZone(context.here, zone)) return '已经站在合适的地方';
    return null;
  },
  plan: context => {
    const zone = placeZone(context), spot = pickSpot(zone, context), world = context.toWorld(spot);
    if (!world) return null;
    const speedMps = lerp(0.45, 0.6, context.drives.energy) * (1 - 0.15 * context.drives.sleepy);
    const closer = !!context.here && spot.size > context.here.size * 1.035; // about 0.3 m nearer, as before
    return {
      plan: { action: 'place', level: 'place', keys: [{ t: 0 }], walk: { xM: world.xM, depthM: world.depthM, speedMps }, amplitude: context.drives.amplitude, easeS: 1, waitQuickS: 0 },
      answerable: closer && (zone === 'paused' || zone === 'home'),
    };
  },
};
