/**
 * I-154 follow-up, batch D (docs/claude/2026-11-21-unbound-full-D.md): who she looks at out in full-screen Unbound, and where you are.
 * (her look at you and her reactions to you, with the pose readings forwarded).
 *
 * The companion's rules (I-081, src/senses/gaze-attention-stage.ts): the same chooser (shared/behaviors/gaze-attention/choose.ts GazeAttention:
 * when she starts looking at you, eye contact, a shy look away, when she lets go) on the same reading (where pose sensing says you are; the
 * host sends it only while camera pose sensing runs, null the moment it stops: electron/unbound/sense-bridge.ts). The reading lives in memory
 * 3 s of this page's clock, as on the companion window; nothing is stored, nothing asked.
 *
 * What differs, on purpose: the companion window is flat, so it turns only part of the way toward where you are (a face on a screen looking
 * straight out seems to look at whoever looks at it). Here the world camera is your eye (the off-axis frustum is built from it), so "you"
 * is a point in her world: the viewer's eye (camera.ts), moved to where pose says your head is. I-167 (docs/claude/2026-11-21-gaze-at-user.md):
 * left / right and up / down (the reading's point on the screen plane) and how far out (the reading's distance, from your face's size),
 * keyed like the companion's cursor (pointer-keys.ts), `fullAim` of the way (knobs.ts, default all of it). Her look toward you is the
 * full direction from her head to that point, in her own frame, and the figure's eye-head coordinator splits it (eyes for small looks, the
 * head for wider ones; it lets go when you are behind her). Whether your head points at her decides eye contact and the shy look-away
 * (looking.ts). Without a reading you are the viewer's eye: her own look-at-you moments (procedural life, her reactions' attention) look
 * there instead of straight ahead.
 * Pure apart from the camera it reads (three.js math only; no DOM).
 */
import { Vector3, type Camera } from 'three';
import { PointerKeys, dampCritical } from '../../stage';
import { GAZE_ATTENTION_KNOBS, GazeAttention, LookingAtHer, gazeMoodFrom, parseUserGazeReading, type GazeAttentionEvent, type GazeAttentionKnobs,
  type GazeReadout, type UserGazePoint, type UserGazeReading } from '../../../shared/senses';
import type { MoodView } from '../../../shared/mood';
import { UNITS_PER_M } from '../figure';
import { toHerFrame, type V3 } from '../motion/lens-align';
import { WINDOW_LOOK } from '../window-mode/window-life';

/** How long a reading is used after it came (s of this page's clock), as the companion's stage. */
export const OUT_GAZE_FRESH_S = 3;
type GazeAttentionFrame = ReturnType<GazeAttention['frame']>;
export interface Look { yaw: number; pitch: number }

export interface OutGazeInput {
  dt: number;
  /** She may look around (awake: the fatigue frame's gazeAllowed). */
  allowed: boolean;
  thinking: boolean; speaking: boolean;
  mood: MoodView | null;
  /** Her head (m, world) and heading (rad), from her body's sense; null head: no look this frame. */
  head: V3 | null; heading: number;
  /** The world camera (the viewer's eye; scene units). */
  camera: Camera;
}
export interface OutGazeFrame {
  /** The look from her head toward you (rad, her frame: yaw + = her left, pitch + = down). */
  toUser: Look;
  /** The chooser's weights this frame, or null when it is not engaged and settled (she looks exactly as before). */
  choice: Pick<GazeAttentionFrame, 'user' | 'mouse' | 'away' | 'awayX' | 'awayY'> | null;
}

/** The look from `head` (m, world) toward `point` (m, world) in her frame (yaw + = her left, pitch + = down), as the lens look is aimed. */
export function lookToward(head: V3, point: V3, heading: number): Look {
  const d = toHerFrame({ x: point.x - head.x, y: point.y - head.y, z: point.z - head.z }, heading);
  return { yaw: Math.atan2(d.x, d.z), pitch: Math.atan2(-d.y, Math.hypot(d.x, d.z)) };
}

const scratch = new Vector3();
/** Where the reading's point (her window's -1..1, y up) meets the screen plane (z = 0), in metres; null when the ray does not reach it. */
export function screenPointM(point: { x: number; y: number }, camera: Camera): V3 | null {
  camera.updateMatrixWorld();
  const eye = camera.position, ray = scratch.set(point.x, point.y, 0.5).unproject(camera).sub(eye);
  if (!(Math.abs(ray.z) > 1e-9)) return null;
  const t = -eye.z / ray.z;
  if (!(t > 0) || !Number.isFinite(t)) return null;
  return { x: (eye.x + ray.x * t) / UNITS_PER_M, y: (eye.y + ray.y * t) / UNITS_PER_M, z: 0 };
}

/** Half the screen plane's width (m) as this camera's frustum frames it: the reading's distance is in these half widths (I-167). */
export function halfWidthM(camera: Camera): number | null {
  const a = screenPointM({ x: -1, y: 0 }, camera), b = screenPointM({ x: 1, y: 0 }, camera);
  const half = a && b ? (b.x - a.x) / 2 : NaN;
  return half > 0 && Number.isFinite(half) ? half : null;
}

/**
 * Her look with the chooser on top (the companion's blend): her own look (`base`; null: where she faces) for the chooser's free share, you for
 * its share, and its look-away aside from you. An owner that asks for a look keeps it: the caller does not compose then.
 */
export function composeLook(base: Look | null, frame: OutGazeFrame): Look | null {
  const c = frame.choice;
  if (!c) return base;
  const b = base ?? { yaw: 0, pitch: 0 }, u = frame.toUser;
  // The look-away offset is in the companion's gaze units (x right as you see her = her left; y up): one unit is WINDOW_LOOK's turn.
  const awayYaw = u.yaw + c.awayX * WINDOW_LOOK.yawPerUnit, awayPitch = u.pitch - c.awayY * WINDOW_LOOK.pitchPerUnit;
  return { yaw: c.mouse * b.yaw + c.user * u.yaw + c.away * awayYaw, pitch: c.mouse * b.pitch + c.user * u.pitch + c.away * awayPitch };
}

/** Her look toward you as the companion's gaze units (procedural life's look-at-you moments add it times their share). */
export const glanceUnits = (look: Look): { x: number; y: number } => ({ x: look.yaw / WINDOW_LOOK.yawPerUnit, y: -look.pitch / WINDOW_LOOK.pitchPerUnit });

export class HerOutGaze {
  private readonly chooser: GazeAttention;
  private held: { reading: UserGazeReading; at: number } | null = null;
  private t = 0;
  /** Where your head is (m, world), keyed from the readings (I-167); how much of it is known (0: the viewer's eye). */
  private readonly you = { x: 0, y: 0, z: 0 };
  private readonly place = new PointerKeys();
  private readonly depth = new PointerKeys();
  private readonly lookingAt: LookingAtHer;
  private known = 0;
  private readonly velocity = { known: 0 };
  private lastEvent: string | null = null;
  /** I-169: the newest reading's point (a reference; only the developer readout reads it). */
  private heard: UserGazePoint | null = null;
  /** A reading came once: from then on the chooser runs every frame (as the companion's does), so it lets go by its own easing. */
  private everSeen = false;

  constructor(private readonly onEvent: (event: GazeAttentionEvent) => void = () => {}, random: () => number = Math.random,
    private readonly knobs: GazeAttentionKnobs = GAZE_ATTENTION_KNOBS) {
    this.chooser = new GazeAttention(random, knobs);
    this.lookingAt = new LookingAtHer(knobs.looking);
  }

  /** The host's latest reading: a checked one (anything malformed is dropped), or null (sensing went off: forgotten at once). */
  set(value: unknown): void {
    const reading = value === null ? null : parseUserGazeReading(value);
    this.held = reading ? { reading, at: this.t } : null;
  }
  /** Hidden, another model, the page going: nothing of you is kept. */
  forget(): void { this.held = null; }
  /** A reading is in memory and fresh. */
  get fresh(): boolean { return !!this.held && this.t - this.held.at <= OUT_GAZE_FRESH_S; }
  /** I-169, developer mode only: the chooser's readout and where your head is on the screen (the reading's point, window units; null while not known). Read only. */
  readout(): { chosen: GazeReadout; user: UserGazePoint | null } {
    return { chosen: this.chooser.readout(), user: this.known > 0 ? this.heard : null };
  }

  frame(input: OutGazeInput): OutGazeFrame | null {
    const dt = Number.isFinite(input.dt) ? Math.min(0.1, Math.max(0, input.dt)) : 0;
    this.t += dt;
    if (!input.head) return null;
    const reading = this.fresh ? this.held!.reading : null, cam = input.camera.position, k = UNITS_PER_M;
    const eye: V3 = { x: cam.x / k, y: cam.y / k, z: cam.z / k };
    // Where your head is (I-167): the reading's point on the screen plane (left / right and up / down) and its distance out from the
    // screen (the reading's dx: half widths of this window, which is the screen), each new reading a key as the cursor's are.
    const point = reading?.present ? reading.point : null;
    const seen = point ? screenPointM(point, input.camera) : null, half = point ? halfWidthM(input.camera) : null;
    if (seen) {
      this.heard = point;
      const at = this.place.frame(dt, seen.x, seen.y), far = this.depth.frame(dt, half ? point!.dx * half : eye.z, 0);
      this.you.x = at.x; this.you.y = at.y; this.you.z = far.x;
    }
    this.known = dampCritical(this.known, seen ? 1 : 0, 5, dt, this.velocity, 'known');
    if (this.known < 1e-4 && !seen) { this.known = 0; this.velocity.known = 0; this.place.reset(); this.depth.reset(); }
    // From the viewer's eye toward where your head is, fullAim of the way, as far as it is known (no reading: the viewer's eye).
    const share = this.known * Math.max(0, Math.min(1, this.knobs.camera.fullAim));
    const you: V3 = { x: eye.x + (this.you.x - eye.x) * share, y: eye.y + (this.you.y - eye.y) * share, z: eye.z + (this.you.z - eye.z) * share };
    const toUser = lookToward(input.head, you, input.heading);
    // I-167: whether your head points at her (eye contact and the shy look-away need it): her head on this window, in its own units.
    const her = point ? scratch.set(input.head.x * k, input.head.y * k, input.head.z * k).project(input.camera) : null;
    const looking = this.lookingAt.frame(dt, point, point ? reading?.turn ?? null : null, her ? her.x : NaN, her ? her.y : NaN);
    this.everSeen ||= !!reading;
    if (!this.everSeen) return { toUser, choice: null };
    // The chooser (the companion's): no cursor out here, so its "mouse" share is her own look.
    const event = (input.mood as { snapshot?: { event?: { id?: string; context?: string; ageMs?: number } | null } } | null)?.snapshot?.event;
    const praised = !!event && typeof event.id === 'string' && event.id !== this.lastEvent && (event.context === 'positive' || event.context === 'support')
      && typeof event.ageMs === 'number' && event.ageMs < 3_000;
    if (event && typeof event.id === 'string') this.lastEvent = event.id;
    const f = this.chooser.frame({ dt, allowed: input.allowed, mouse: false, thinking: input.thinking, speaking: input.speaking,
      user: reading ? { present: reading.present, facing: reading.facing, energy: reading.energy, looking } : null, pointerMoving: 0,
      mood: gazeMoodFrom(input.mood), screen: reading?.screen ?? null, praised });
    for (const e of this.chooser.takeEvents()) { try { this.onEvent(e); } catch { /* a record never changes her look */ } }
    const engaged = f.engaged || f.mouse !== 1;
    return { toUser, choice: engaged ? { user: f.user, mouse: f.mouse, away: f.away, awayX: f.awayX, awayY: f.awayY } : null };
  }
}
