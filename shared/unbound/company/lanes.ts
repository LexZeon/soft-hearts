/**
 * I-209 step 1: where the extras stand so nobody stands in anybody (plan v2: "互相让开"). Pure.
 *
 * Positions are spots (shared/unbound/life/place-record.ts: across 0..1 of the screen width, metres behind it), the same numbers her own
 * placement uses (placementAcross), so a spot is the same part of the screen on any screen. Two people are clear of each other when their
 * centres are at least `gapM` apart across at the nearer one's depth (side by side, a hand's room between), or one stands well behind the
 * other (`backStepM`).
 *
 * The rules that keep anyone from walking through anyone:
 *  - each extra keeps her side of the one you talk with (the side she is on now), and extras on one side keep their order outward;
 *  - so a new target is always further out on her own side, and the straight walk there never crosses anyone;
 *  - with no room left on her side (you walked her to the edge), she steps back (`backStepM` deeper) and you pass in front.
 * The one you talk with is never moved by this (her own life, your pulls and her peeks keep what they do).
 */
import { DEPTH_RANGE_M, type WorldView } from '../world';

export interface Spot { across: number; depthM: number }
type View = Pick<WorldView, 'screen' | 'viewerDistanceM'>;

export const COMPANY_KNOBS = Object.freeze({
  /** Centre to centre across, at the nearer one's depth (m): two people side by side with a hand's room. */
  gapM: 0.95,
  /** No room on her side: she steps this far back (m) and you pass in front. */
  backStepM: 1.6,
  /** Where an extra may stand (of the screen width; the saved-place range's margin). */
  across: Object.freeze([0.07, 0.93] as const),
  /** Just outside the screen: she walks in from there and back out to there (never pops in or out). */
  offAcross: Object.freeze([-0.12, 1.12] as const),
});
export type CompanyKnobs = typeof COMPANY_KNOBS;

/** How far apart across (0..1) two spots must be to stand clear side by side. */
export function needAcross(view: View, a: Spot, b: Spot, gapM: number = COMPANY_KNOBS.gapM): number {
  const d = view.viewerDistanceM, w = view.screen.widthM, near = Math.max(0, Math.min(a.depthM, b.depthM));
  return d > 0 && w > 0 ? gapM * d / (w * (d + near)) : 1;
}

/** Whether two spots stand clear of each other (side by side with room, or one well behind the other). */
export function clearOf(view: View, a: Spot, b: Spot, k: CompanyKnobs = COMPANY_KNOBS): boolean {
  return Math.abs(a.across - b.across) >= needAcross(view, a, b, k.gapM) - 1e-9 || Math.abs(a.depthM - b.depthM) >= k.backStepM * 0.9;
}

export interface ExtraLane { id: string; /** where she is now */ at: Spot; /** where she would like to be (her saved place, her own small walk) */ want: Spot }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Each extra's target: as near her wish as the others allow, on her own side, in her order outward. The one you talk with (`main`) stays
 * where she is; `ahead` is where she will be in a moment (she walks, or you pull her): the others make room for both, but which side each
 * one is on is read from where she is now (so nobody is sent across her path). Deterministic for the same input.
 */
export function arrange(view: View, main: Spot, extras: readonly ExtraLane[], k: CompanyKnobs = COMPANY_KNOBS, ahead: Spot = main): Map<string, Spot> {
  const out = new Map<string, Spot>();
  const [lo, hi] = k.across;
  const sideOf = (lane: ExtraLane): 1 | -1 => {
    const off = lane.at.across - main.across;
    if (Math.abs(off) > 1e-9) return off > 0 ? 1 : -1;
    return hi - main.across >= main.across - lo ? 1 : -1; // exactly in line: the side with more room
  };
  for (const side of [1, -1] as const) {
    const lanes = extras.filter(lane => sideOf(lane) === side).sort((a, b) => Math.abs(a.at.across - main.across) - Math.abs(b.at.across - main.across));
    let prev: Spot = side * (ahead.across - main.across) > 0 ? ahead : main;
    const front: Spot[] = [main, ahead], stepping: ExtraLane[] = [];
    for (const lane of lanes) {
      const depthM = clamp(lane.want.depthM, DEPTH_RANGE_M[0], DEPTH_RANGE_M[1]);
      const want = { across: lane.want.across, depthM };
      const edge = prev.across + side * needAcross(view, prev, want, k.gapM);
      const across = side > 0 ? Math.max(want.across, edge) : Math.min(want.across, edge);
      if (!stepping.length && across >= lo - 1e-9 && across <= hi + 1e-9) {
        const spot = { across: clamp(across, lo, hi), depthM };
        out.set(lane.id, spot);
        prev = spot; front.push(spot);
      } else stepping.push(lane); // no room on her side: she and everyone outside her step out of the way (below)
    }
    // Out of the way: a row behind everyone on her side (in front of them when that row would be past the back of the room). The outermost
    // takes the screen's edge, the next one beside her inward, so nobody's walk there crosses anybody's; inward only while she stays on her
    // side of you, past that another row. Each row is clear of everyone else by depth.
    const deepest = Math.max(...front.map(p => p.depthM)), shallowest = Math.min(...front.map(p => p.depthM));
    const nextRow = (from: number, to: number) => from + k.backStepM <= DEPTH_RANGE_M[1] ? from + k.backStepM : Math.max(DEPTH_RANGE_M[0], to - k.backStepM);
    let back: Spot | null = null;
    for (const lane of [...stepping].reverse()) {
      const inward = back ? back.across - side * needAcross(view, back, back, k.gapM) : NaN;
      const spot: Spot = back && side * (inward - main.across) > 0 ? { across: clamp(inward, lo, hi), depthM: back.depthM }
        : { across: side > 0 ? hi : lo, depthM: back ? nextRow(back.depthM, Math.min(shallowest, back.depthM)) : nextRow(deepest, shallowest) };
      out.set(lane.id, spot);
      back = spot;
    }
  }
  return out;
}

/** Where a new extra would like to stand when nothing is kept for her: beside the others on the side with more room, at your depth. */
export function firstWish(view: View, main: Spot, others: readonly Spot[], k: CompanyKnobs = COMPANY_KNOBS): Spot {
  const [lo, hi] = k.across;
  const room = (side: 1 | -1) => {
    const taken = others.filter(o => Math.sign(o.across - main.across) === side).length;
    return (side > 0 ? hi - main.across : main.across - lo) - taken * needAcross(view, main, main, k.gapM);
  };
  const side: 1 | -1 = room(1) >= room(-1) ? 1 : -1;
  const outer = [main, ...others.filter(o => Math.sign(o.across - main.across) === side)].reduce((a, b) => (side * (b.across - a.across) > 0 ? b : a));
  return { across: clamp(outer.across + side * (needAcross(view, outer, main, k.gapM) * 1.15), lo, hi), depthM: main.depthM };
}

/** Where she enters from / leaves to: just outside the screen on her side of the one you talk with. */
export function offStage(main: Spot, toward: Spot, k: CompanyKnobs = COMPANY_KNOBS): Spot {
  const right = toward.across > main.across || (toward.across === main.across && main.across <= 0.5);
  return { across: right ? k.offAcross[1] : k.offAcross[0], depthM: toward.depthM };
}
