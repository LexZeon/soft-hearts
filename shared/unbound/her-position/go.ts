/**
 * I-193: a "go where" word becomes a spot she can walk to (her own spot space: across 0..1 of the screen width and, since I-212, her size on the
 * screen: her height as a share of the usable height; shared/unbound/life/action.ts LifeSpot). She decides whether and where by writing the word;
 * this only picks the spot inside the word's band with a bit of her mood in it (a warm mood steps closer, a tense one keeps its distance; a lively
 * one walks a little faster and stays a shorter while), never the same spot she stands on, and never a spot that would put her over a window that
 * must stay clear (`covers`).
 *
 * I-212: steps are relative changes of her size (nearer: bigger by a factor),
 * so "走近一步" looks about the same on a laptop and a 27" screen. The host converts the spot to metres for this screen and her height
 * (shared/unbound/screen-terms); her walking speed stays in m/s (her feet must match the floor), so the nearer she is, the faster she seems
 * to cross the screen, as a real person does.
 *
 * The result is only a goal: the body walks there with the gait it has (plan.walk of the life player: steps, planted feet, braking), so she never
 * teleports; the floor rules stay the page's (the U-shaped floor): a small step stays where her whole body fits (nearestSize), so she does not
 * walk to where her feet would sink under the taskbar. The framed walks go nearer through the framing bands: come-near to the user's place, then
 * (I-193) one step at a time up to "only the face" (`nearestLimit`, reach.ts); and `go` with numbers (⟦go 30% 1.2m⟧,
 * converted by the host through screen-terms) to any spot between go-far's farthest and that limit (out of range: the edge).
 * Pure: the caller gives the random numbers.
 */
import type { LifeSpot } from '../life/action';
import { HER_POSITION_KNOBS, type HerPositionKnobs } from './knobs';
import type { GoWord } from './ask';
import type { GoStayWhy } from './journal';

/** Her spots stay inside the screen with a margin (shared/unbound/life/place-record.ts SAVED_PLACE_RANGES.across). */
export const GO_ACROSS: readonly [number, number] = Object.freeze([0.05, 0.95] as const);
/**
 * The sizes a walk may end at: the far end is the pull's (0.327, the old 12.5 m); the near end the glass (the old 0.6 m behind it; the host
 * keeps her inside her world's depth range anyway).
 */
export const GO_SIZE: readonly [number, number] = Object.freeze([0.327, 3.7] as const);

export interface GoDrives { tense: number; warm: number; energy: number; sleepy: number }
export interface GoInput {
  word: GoWord;
  here: LifeSpot;
  /** The pointer's place across the screen (0..1); only go-cursor reads it. null: not known (go-cursor does not walk). */
  cursorAcross?: number | null;
  random(): number;
  drives?: GoDrives | null;
  /** True when she would stand over a window that must stay clear (the one you are using) at this spot. The app has no such reading today: absent. */
  covers?(spot: LifeSpot): boolean;
  /**
   * Where "come-near" ends (a size): the user's default place's, or the chest-up size for her height (near.ts); null: not known.
   * With knobs.comeNearToPlace on she walks all the way there and never closer; she stays when she already is that near.
   */
  nearSize?: number | null;
  /**
   * I-193: the nearest she walks to by herself, "only the face" (reach.ts nearestWalkSize). A come-near from the place
   * size or nearer steps on up to it; a go target is clamped to it. null: not known (come-near stops at the place; a go target at GO_SIZE).
   */
  nearestLimit?: number | null;
  /** I-193 numbers: ⟦go 30% 1.2m⟧ converted by the host (across 0..1, size through the screen formula); either part may be absent. Only `go` reads it. */
  target?: { across?: number; size?: number } | null;
  knobs?: HerPositionKnobs;
}
export interface GoResult { spot: LifeSpot; speedMps: number; stayMinutes: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp(t, 0, 1);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The largest size a small step nearer may end at: where her whole body still fits. */
export function nearestGoSize(knobs: HerPositionKnobs = HER_POSITION_KNOBS): number { return knobs.nearestSize; }

/** Candidate spots for the word, best first (several tries with her own random numbers, so a blocked one has others). */
function candidates(input: GoInput, k: HerPositionKnobs): LifeSpot[] {
  const { word, here } = input, random = () => clamp(input.random(), 0, 1), d = input.drives ?? { tense: 0, warm: 0, energy: 0.5, sleepy: 0 };
  const across = (min: number, max: number) => clamp(lerp(min, max, random()), GO_ACROSS[0], GO_ACROSS[1]);
  const keepSize = clamp(here.size, GO_SIZE[0], GO_SIZE[1]);
  const nearest = nearestGoSize(k);
  const limit = finite(input.nearestLimit) && input.nearestLimit > 0 ? input.nearestLimit : null;
  const out: LifeSpot[] = [];
  for (let i = 0; i < 6; i++) {
    switch (word) {
      case 'go': { // I-193 numbers: the host converted them (screen-terms); kept on her floor between the farthest and "only the face"
        const t = input.target;
        if (!t || (!finite(t.across) && !finite(t.size))) return [];
        out.push({ across: finite(t.across) ? clamp(t.across, GO_ACROSS[0], GO_ACROSS[1]) : here.across,
          size: finite(t.size) ? clamp(t.size, k.farthestSize, limit ?? GO_SIZE[1]) : here.size });
        break;
      }
      case 'go-left': out.push({ across: across(k.leftMin, k.leftMax), size: keepSize }); break;
      case 'go-right': out.push({ across: across(k.rightMin, k.rightMax), size: keepSize }); break;
      case 'go-middle': out.push({ across: across(k.middleMin, k.middleMax), size: keepSize }); break;
      case 'come-near': {
        const place = k.comeNearToPlace && finite(input.nearSize) && input.nearSize > 0 ? clamp(input.nearSize, GO_SIZE[0], GO_SIZE[1]) : null;
        // A warm mood steps a little further in, a tense one a little less (the step's own factor, raised to the mood's power).
        const factor = lerp(k.nearStepMin, k.nearStepMax, random()) ** clamp(1 + 0.4 * d.warm - 0.4 * d.tense, 0.6, 1.4);
        if (place !== null) { // first to the place the user chose (never walking back out from nearer than it)
          if (here.size < place * (1 - k.sameSize)) out.push({ across: here.across, size: place });
          // I-193: already that near: one more step nearer, up to "only the face" (`limit`); at the limit she stays.
          else if (limit !== null && here.size < limit * (1 - k.sameSize)) out.push({ across: here.across, size: Math.min(here.size * factor, limit) });
          break;
        }
        out.push({ across: here.across, size: clamp(here.size * factor, GO_SIZE[0], Math.max(nearest, here.size)) });
        break;
      }
      case 'go-far': {
        const factor = lerp(k.farStepMin, k.farStepMax, random()) ** clamp(1 + 0.4 * d.tense - 0.4 * d.warm, 0.6, 1.4);
        out.push({ across: here.across, size: clamp(here.size * factor, Math.min(k.farthestSize, here.size), GO_SIZE[1]) });
        break;
      }
      case 'go-corner': {
        const left = here.across < 0.5, edge = lerp(k.cornerMin, k.cornerMax, random());
        out.push({ across: clamp(left ? edge : 1 - edge, GO_ACROSS[0], GO_ACROSS[1]), size: clamp(lerp(k.cornerSizeMin, k.cornerSizeMax, random()), GO_SIZE[0], GO_SIZE[1]) });
        break;
      }
      case 'go-cursor': {
        const at = input.cursorAcross;
        if (!finite(at)) return [];
        // Beside the pointer, on the side with more room (the other side when the first is blocked), never right behind it.
        const gap = lerp(k.besideMin, k.besideMax, random()), roomRight = 1 - at >= at, side = (i % 2 === 0) === roomRight ? 1 : -1;
        out.push({ across: clamp(at + side * gap, GO_ACROSS[0], GO_ACROSS[1]), size: keepSize });
        break;
      }
    }
  }
  return out;
}

/** She is already there: not worth a walk (across within sameSpot of the screen width, her size within sameSize of it). */
export function alreadyThere(here: LifeSpot, spot: LifeSpot, knobs: HerPositionKnobs = HER_POSITION_KNOBS): boolean {
  return Math.abs(here.across - spot.across) < knobs.sameSpot && Math.abs(spot.size / here.size - 1) < knobs.sameSize;
}

/** Where she walks for the word, with her pace and how long she stays put afterwards; null: nowhere (already there, the pointer is not known, every spot is blocked). */
export function goSpot(input: GoInput): GoResult | null {
  const decided = goDecide(input);
  return 'spot' in decided ? decided : null;
}

/** goSpot with the reason when she stays (a closed word for the journal): 'no-place' (her place is not known), 'cursor-stale', 'already-there', 'covered'. */
export function goDecide(input: GoInput): GoResult | { why: GoStayWhy } {
  const k = input.knobs ?? HER_POSITION_KNOBS, d = input.drives ?? { tense: 0, warm: 0, energy: 0.5, sleepy: 0 };
  if (!finite(input.here?.across) || !finite(input.here?.size) || input.here.size <= 0) return { why: 'no-place' };
  const all = candidates(input, k);
  if (!all.length) return { why: input.word === 'go-cursor' ? 'cursor-stale' : input.word === 'go' ? 'no-place' : 'already-there' }; // go: its numbers could not be converted
  const apart = all.filter(spot => !alreadyThere(input.here, spot, k));
  if (!apart.length) return { why: 'already-there' };
  const spot = apart.find(candidate => !(input.covers?.(candidate) ?? false));
  if (!spot) return { why: 'covered' };
  const energy = clamp(d.energy, 0, 1), sleepy = clamp(d.sleepy, 0, 1);
  return {
    spot,
    speedMps: lerp(0.45, 0.6, energy) * (1 - 0.15 * sleepy), // the pace of her own "换个地方站" (shared/unbound/life/actions/place.ts); m/s, as her feet need
    stayMinutes: lerp(k.stayMinutesMax, k.stayMinutesMin, energy * clamp(input.random(), 0, 1) + (1 - energy) * 0.25),
  };
}
