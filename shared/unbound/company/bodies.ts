/**
 * I-209 step 3 (同时启动三个全屏额外加功能"做"): each character on stage is her own full-screen Unbound (her own window and page). What
 * the pages share goes through the stage coordinator in the host (electron/unbound/company/stage.ts); this file is the pure half:
 *
 *  - a body as a page reports it (where her root stands on the shared floor, how wide she is, how she moves, whether she is being pulled
 *    or plays a close moment) and as the coordinator hands it to the others;
 *  - one floor (2026-11-25): every window
 *    frames HER OWN body against the one floor line all the windows share (the work area's bottom), exactly as she is framed alone
 *    (src/unbound/company/stage-page.ts camera). Nothing about the camera is shared at run time, so pulling one nearer moves only her;
 *    step 3's shared eye (the nearest one's eye height for every window) moved everyone else up and down and is gone;
 *  - which window is in front (`stackOrder`): the nearer one's window is above, re-sorted only when the order really changed;
 *  - never through each other (`keepApart`): a walk, a pull or a close moment toward someone stops where the two touch;
 *  - the one approached steps aside first (`asideGoal`); when she cannot (the screen's edge, someone else), it returns null and the one
 *    coming stops at contact by `keepApart` on her own page.
 * Floor coordinates are metres on her floor: x across (right +), z toward you (z = −depth), as the page's root (UnboundFigure.rootM).
 */
import { COMPANY_ID, COMPANY_MAX_PRESENT } from './presence';

/** One body as her page reports it (metres; speeds in m/s). */
export interface StageBody {
  /** Her root on the floor: x across, depth behind the screen. */
  xM: number; depthM: number;
  /** Half her width round her root, hair and hands at rest included (m): two bodies touch at the sum of their radii. */
  radiusM: number;
  /** Her height and her face's height above her floor (m), and the close-up eye's dip now (m). */
  heightM: number; faceM: number; dipM: number;
  /** How her root moves now (m/s): the others predict where she is between reports. */
  vxM: number; vdM: number;
  /** You are pulling her. */
  pulled: boolean;
  /** A close moment of hers plays (the peek, a kiss, a hug): the others step out of her way sooner. */
  closing: boolean;
  /** She may step aside now (standing, nothing of hers or yours moving her). */
  free: boolean;
  /** Where she is walking to now (her goal on the floor: x across, depth), when it is away from her root: the way she is going. */
  goal?: { xM: number; depthM: number };
}
export interface StageOther extends StageBody { id: string }
/** What the coordinator tells each page. */
export interface StageView {
  /** How many are on stage (1: alone, the page does exactly what it did before step 3). */
  present: number;
  /** Her own id on this stage. */
  self: string;
  /** Everyone else on stage, as last reported. */
  others: StageOther[];
  /** She is being sent back: she walks out of the screen, then her window closes. */
  leave?: boolean;
  /** The one you are with (the last one you clicked: her id on this stage); her page draws at full rate when it is herself (extra-pace.ts). Absent: not known, she draws at full rate. */
  focus?: string;
}

export const STAGE_BODY_KNOBS = Object.freeze({
  /** Room kept between two bodies on top of their radii (m): they touch, never overlap. */
  marginM: 0.03,
  /** A walk stops this far short of contact (m), so her braking never carries her into it. */
  stopShortM: 0.02,
  /** Predict the others this far ahead at most (s): the report's age and the IPC on top of it. */
  leadMaxS: 0.25,
  /** Someone this close to touching (m beyond contact) and coming nearer, or pulled toward her: she steps aside. */
  asideNearM: 0.35,
  /** How much room she leaves when she steps aside (m beyond contact). */
  asideRoomM: 0.3,
  /** Coming nearer faster than this (m/s) counts as approaching. */
  approachMps: 0.05,
  /** Depths closer than this (m) keep the window order they had (no flicker when two stand side by side). */
  stackHysteresisM: 0.08,
});
export type StageBodyKnobs = typeof STAGE_BODY_KNOBS;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const within = (value: unknown, lo: number, hi: number): value is number => finite(value) && value >= lo && value <= hi;

/** A page's report (anything malformed or out of range: null, never guessed). */
export function parseStageBody(value: unknown): StageBody | null {
  if (!record(value)) return null;
  const v = value;
  if (!within(v.xM, -60, 60) || !within(v.depthM, -2, 30) || !within(v.radiusM, 0.05, 1.5) || !within(v.heightM, 0.05, 20) || !within(v.faceM, 0, 20)) return null;
  if (!within(v.dipM, 0, 1) || !within(v.vxM, -20, 20) || !within(v.vdM, -20, 20)) return null;
  return { xM: v.xM, depthM: v.depthM, radiusM: v.radiusM, heightM: v.heightM, faceM: v.faceM, dipM: v.dipM, vxM: v.vxM, vdM: v.vdM,
    pulled: v.pulled === true, closing: v.closing === true, free: v.free === true,
    ...(record(v.goal) && within(v.goal.xM, -60, 60) && within(v.goal.depthM, -2, 30) ? { goal: { xM: v.goal.xM, depthM: v.goal.depthM } } : {}) };
}

/** The coordinator's view as a page reads it (malformed: null; at most COMPANY_MAX_PRESENT − 1 others). */
export function parseStageView(value: unknown): StageView | null {
  if (!record(value) || !Number.isInteger(value.present) || (value.present as number) < 1 || (value.present as number) > COMPANY_MAX_PRESENT) return null;
  if (typeof value.self !== 'string' || !COMPANY_ID.test(value.self) || !Array.isArray(value.others)) return null;
  const others: StageOther[] = [];
  for (const raw of value.others) {
    if (others.length >= COMPANY_MAX_PRESENT - 1 || !record(raw) || typeof raw.id !== 'string' || !COMPANY_ID.test(raw.id)) continue;
    const body = parseStageBody(raw);
    if (body) others.push({ id: raw.id, ...body });
  }
  const focus = typeof value.focus === 'string' && COMPANY_ID.test(value.focus) ? value.focus : undefined;
  return { present: value.present as number, self: value.self, others, ...(value.leave === true ? { leave: true } : {}), ...(focus ? { focus } : {}) };
}

/** Where two bodies touch (centre to centre, m). */
export const contactM = (a: Pick<StageBody, 'radiusM'>, b: Pick<StageBody, 'radiusM'>, k: StageBodyKnobs = STAGE_BODY_KNOBS) => a.radiusM + b.radiusM + k.marginM;

/**
 * The windows from the farthest to the nearest (the last one drawn on top). Starts from the order they had and moves one past another only
 * when it is clearly nearer (beyond the hysteresis), so two standing at about the same depth never make the windows swap back and forth.
 */
export function stackOrder(bodies: ReadonlyMap<string, Pick<StageBody, 'depthM'>>, previous: readonly string[] = [], k: StageBodyKnobs = STAGE_BODY_KNOBS): string[] {
  const order = [...previous.filter(id => bodies.has(id)), ...[...bodies.keys()].filter(id => !previous.includes(id))];
  const nearer = (a: string, b: string) => bodies.get(a)!.depthM < bodies.get(b)!.depthM - k.stackHysteresisM; // a is clearly nearer than b
  for (let i = 1; i < order.length; i++) {
    for (let j = i; j > 0 && nearer(order[j - 1]!, order[j]!); j--) [order[j - 1], order[j]] = [order[j]!, order[j - 1]!];
  }
  return order;
}

export interface FloorPoint { x: number; z: number }
/** Another body on the floor (x, z = −depth), with its contact distance to her. */
export interface Obstacle extends FloorPoint { reachM: number }

/** Where someone else will be `leadS` from her last report (a short prediction; she may be walking or pulled). */
export function predicted(other: StageBody, leadS: number, k: StageBodyKnobs = STAGE_BODY_KNOBS): FloorPoint {
  const lead = Math.min(k.leadMaxS, Math.max(0, finite(leadS) ? leadS : 0));
  return { x: other.xM + other.vxM * lead, z: -(other.depthM + other.vdM * lead) };
}

/**
 * Her walk from `root` toward `goal` stops where it would touch anyone (minus `stopShortM`). Already touching someone: only a goal that takes
 * her farther from them is kept (she can always step back out). Returns the goal unchanged when nothing is in the way.
 */
export function keepApart(root: FloorPoint, goal: FloorPoint, obstacles: readonly Obstacle[], k: StageBodyKnobs = STAGE_BODY_KNOBS): FloorPoint {
  const dx = goal.x - root.x, dz = goal.z - root.z, length = Math.hypot(dx, dz);
  if (!(length > 1e-6)) return goal;
  let t = 1;
  for (const o of obstacles) {
    const rx = root.x - o.x, rz = root.z - o.z, inside = Math.hypot(rx, rz) < o.reachM;
    if (inside) { // only straight out of it, never deeper (nor through her middle to the far side)
      if (dx * rx + dz * rz < 0) t = 0;
      continue;
    }
    // Where the segment root + s·(goal − root) first meets the circle |p − o| = reachM.
    const a = dx * dx + dz * dz, b = 2 * (rx * dx + rz * dz), c = rx * rx + rz * rz - o.reachM * o.reachM;
    const disc = b * b - 4 * a * c;
    if (disc < 0) continue;
    const s = (-b - Math.sqrt(disc)) / (2 * a);
    if (s >= 0 && s <= 1) t = Math.min(t, Math.max(0, s - k.stopShortM / length));
  }
  return t >= 1 ? goal : { x: root.x + dx * t, z: root.z + dz * t };
}

/** The others as obstacles for her (predicted `leadS` ahead), their contact distances to her radius. */
export function obstaclesFor(radiusM: number, others: readonly StageBody[], leadS: number, k: StageBodyKnobs = STAGE_BODY_KNOBS): Obstacle[] {
  return others.map(other => ({ ...predicted(other, leadS, k), reachM: contactM({ radiusM }, other, k) }));
}

/**
 * Someone is coming at her and she is free: where she steps to, sideways out of the line the other one comes along, with room beyond contact
 * (pulled across the screen through her: she steps back and lets her pass in front; pulled toward you through her: she steps aside across).
 * Null when nobody is coming, or she cannot: past the edge of where she may stand (`minX`..`maxX` across, the depths), or into someone else.
 */
export interface AsideBounds { minX: number; maxX: number; minDepthM?: number; maxDepthM?: number }
export function asideGoal(self: StageBody, others: readonly StageOther[], bounds: AsideBounds, leadS = 0, k: StageBodyKnobs = STAGE_BODY_KNOBS): FloorPoint | null {
  if (!self.free) return null;
  const me = { x: self.xM, z: -self.depthM };
  let coming: StageOther | null = null, nearest = Infinity;
  for (const other of others) {
    const at = predicted(other, leadS, k), gap = Math.hypot(at.x - me.x, at.z - me.z) - contactM(self, other, k);
    if (gap > k.asideNearM) continue;
    // Coming nearer: her speed toward me (positive), or you are pulling her (a pull may stop and go again), or her close moment walks past.
    const ux = (me.x - other.xM), uz = (me.z + other.depthM), d = Math.hypot(ux, uz) || 1;
    const toward = (other.vxM * ux + -other.vdM * uz) / d;
    if (toward < k.approachMps && !(other.pulled && gap < k.asideNearM * 0.5) && !(other.closing && gap < k.asideNearM)) continue;
    if (gap < nearest) { nearest = gap; coming = other; }
  }
  if (!coming) return null;
  const at = predicted(coming, leadS, k), reach = contactM(self, coming, k) + k.asideRoomM;
  // Out of her way: sideways to the line she comes along (the way to her goal; else her motion; standing with no goal: the line from her to me),
  // to the side of it I am already on, far enough that she passes. Right in line: the side with room, back rather than forward (she passes in front).
  let ux = coming.goal ? coming.goal.xM - at.x : 0, uz = coming.goal ? -coming.goal.depthM - at.z : 0, n = Math.hypot(ux, uz);
  if (n < 0.05) { ux = coming.vxM; uz = -coming.vdM; n = Math.hypot(ux, uz); }
  if (n < k.approachMps) { ux = me.x - at.x; uz = me.z - at.z; n = Math.hypot(ux, uz) || 1; }
  ux /= n; uz /= n;
  const wx = me.x - at.x, wz = me.z - at.z, off = ux * wz - uz * wx; // signed distance from her line (left of her way: positive)
  const need = reach - Math.abs(off);
  if (need <= 0.01) return null; // she passes by without touching
  const left = { x: -uz, z: ux }, inLine = Math.abs(off) < 0.02;
  const fits = (g: FloorPoint) => g.x >= bounds.minX && g.x <= bounds.maxX && -g.z >= (bounds.minDepthM ?? -Infinity) && -g.z <= (bounds.maxDepthM ?? Infinity);
  const toward = (side: 1 | -1, d: number) => ({ x: me.x + left.x * side * d, z: me.z + left.z * side * d });
  let side: 1 | -1 = off > 0 ? 1 : -1;
  if (inLine) side = fits(toward(1, need)) && (!fits(toward(-1, need)) || left.z <= 0) ? 1 : -1; // in line: back (z away from you) when both fit
  const goal = toward(side, need);
  if (!fits(goal)) return null; // at the edge: she stays, the one coming stops at contact
  // Never into a third one (nor through anyone on the way).
  const rest = obstaclesFor(self.radiusM, others.filter(other => other !== coming), leadS, k);
  const free = keepApart(me, goal, rest, k);
  return Math.hypot(free.x - goal.x, free.z - goal.z) < 1e-6 ? goal : null;
}
