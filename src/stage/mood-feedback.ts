import { clamp, damp, dampCritical } from './procedural';
import { getBlushAmount, type MoodBlushSnapshot, type MoodChannel, type MoodContext, type MoodEventSnapshot } from '../../shared/mood';
import type { CheekPinchFeedback } from '../ui/CheekPinch';
import { IdleGesturePerformer } from '../../shared/behaviors/idle-gesture/perform';
import type { IdleGestureStage, IdleGestureView } from '../../shared/behaviors/idle-gesture/interface';
import { FeedEatPerformer } from '../../shared/behaviors/feed-cue/perform';
import type { FeedCueView, FeedEatStage } from '../../shared/behaviors/feed-cue/interface';

export interface MoodContact {
  contact: boolean;
  /** Local pre-contact progress only; never an accepted host interaction. */
  hover?: number;
  feeding: boolean;
  prepared: boolean;
  /** Feeding only: how close the snack is to the mouth (0 far .. 1 at the mouth). */
  near?: number;
  /** Feeding only: the snack was accepted (the bite); she chews with a nearly closed "mm" mouth. */
  accepted?: boolean;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  speed: number;
  pinch?: CheekPinchFeedback;
}
export interface StageMoodState {
  mood: string;
  phase: string;
  expressive: boolean;
  face: number;
  posture: number;
  playful: number;
  gaze?: number;
  attention?: boolean;
  /** #11: how she does this look or small motion (MoodView.idleGesture); absent: the old light sway. */
  gesture?: IdleGestureView | null;
  /** A brief host-owned acknowledgement, independent of channel saturation. */
  responding: boolean;
  /** Main mood stays in `mood`; a companion only modifies its rendering. */
  companion?: string | null;
  context?: MoodContext;
  trend?: Partial<Record<MoodChannel, number>>;
  fast?: Partial<Record<MoodChannel, 'up' | 'down' | 'steady'>>;
  fastThreshold?: number;
  trendResponse?: number;
  event?: MoodEventSnapshot | null;
  blush?: MoodBlushSnapshot | null;
  /** #32: how she eats the snack being fed now (MoodView.feedCue); absent: exactly the old mouth, chew and head. */
  feed?: FeedCueView | null;
}
export const EMPTY_CONTACT: MoodContact = { contact: false, feeding: false, prepared: false, x: 0, y: 0, velocityX: 0, velocityY: 0, speed: 0 };

/**
 * B05: how long a pat survives the pointer briefly leaving the scalp (s). A
 * stroke regularly overshoots the hit ellipse or crosses its edge while the
 * head itself moves; each such exit used to drop the enjoyed eye closure to
 * zero and back, which read as trembling eyelids.
 */
export const PAT_HOLD = 0.35;
/** B06: fully prepared mouth opening, and the share shown while the snack approaches. */
export const FEED_OPEN = 0.85;
export const FEED_ANTICIPATION = 0.55;
/** B06 eating: a nearly closed "mm" mouth that chews a little (peak opening, chews per second). */
export const CHEW_OPEN = 0.14;
export const CHEW_RATE = 2.6;
/**
 * R29 (docs/claude/2026-11-06-reunion-brow-jump.md): the mood face's troubled brow (困る) follows its target critically
 * damped at this ω (1/s) instead of stepping to it. 16 is the fastest whose first frame at 30 fps is at most ~10% of the
 * way (1 - (1 + ω/30)·e^(-ω/30) ≈ 0.10; 60 fps ≈ 3%); 90% of the way after ≈ 3.89 / ω ≈ 0.24 s at any frame rate, no overshoot.
 */
export const MOOD_BROW_OMEGA = 16;
/** Below this distance (and speed) the brow lands exactly on its target, so a released brow is exactly 0 (the drowsy brow waits for it). */
const BROW_LAND = 1e-4;
const smoothstep = (value: number) => { const t = Math.min(1, Math.max(0, value)); return t * t * (3 - 2 * t); };
/** Adds a layer that is exactly 0 when idle without touching the other value at all (bit-identical frames, -0 included). */
const plus = (value: number, layer: number) => layer === 0 ? value : value + layer;

/** Local, bounded offsets. Never changes a VMD, camera, window or internal mood. */
export class MoodFeedback {
  private angle = { x: 0, y: 0, z: 0 };
  private velocity = { x: 0, y: 0, z: 0 };
  private smile = 0;
  private eyelids = 0;
  private mouth = 0;
  private mouthOwner = 0;
  /** R29: the troubled brow as shown, and its speed (MOOD_BROW_OMEGA). */
  private sadness = 0;
  private readonly sadnessVelocity = { brow: 0 };
  /** Seconds of the current bite (B06 chewing); 0 when not eating. */
  private chew = 0;
  private chewWeight = 0;
  private contactAttention = 0;
  private feedingAttention = 0;
  /** R29f: the attention weights follow critically damped (speed carried), see frame(). */
  private readonly attentionVelocity = { contact: 0, feeding: 0 };
  /** Time since the last real (non-feeding) contact; the pat's last pointer position eases out. */
  private patGap = Infinity;
  private patX = 0;
  private patY = 0;
  private elapsed = 0;
  private eventId = '';
  private eventAgeMs = 0;
  private blushId = '';
  private blushAgeMs = 0;
  private mutedBlushId = '';
  /**
   * #11: the stage side of the idle gesture (shared/behaviors/idle-gesture/perform.ts); #32: the stage side of how she eats
   * (shared/behaviors/feed-cue/perform.ts). Both injectable for their contract tests.
   */
  constructor(private readonly idle: IdleGestureStage = new IdleGesturePerformer(), private readonly eat: FeedEatStage = new FeedEatPerformer()) {}

  get attentionWeight(): number { return clamp(Math.max(this.contactAttention, this.feedingAttention), 0, 1); }
  /** A pat is on, or within its PAT_HOLD grace: owners that yield to contact keep yielding through a brief exit. */
  get patHolding(): boolean { return this.patGap <= PAT_HOLD; }
  get eyelidWeight(): number { return this.eyelids; }

  reset(): void {
    this.angle = { x: 0, y: 0, z: 0 };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.smile = this.eyelids = this.mouth = this.mouthOwner = this.elapsed = this.chew = this.chewWeight = this.sadness = 0;
    this.sadnessVelocity.brow = 0;
    this.contactAttention = this.feedingAttention = 0;
    this.attentionVelocity.contact = this.attentionVelocity.feeding = 0;
    this.patGap = Infinity; this.patX = this.patY = 0;
    this.eventId = this.blushId = this.mutedBlushId = '';
    this.eventAgeMs = this.blushAgeMs = 0;
    this.idle.reset();
    this.eat.reset();
  }

  frame(delta: number, input: MoodContact, state: StageMoodState, faceBlocked = false, automaticHeadAllowed = true, mouthBlocked = faceBlocked) {
    const dt = Number.isFinite(delta) ? clamp(delta, 0, 0.1) : 0;
    this.elapsed += dt;
    const number = (v: number, lo: number, hi: number) => Number.isFinite(v) ? clamp(v, lo, hi) : 0;
    const active = input.contact && !input.feeding;
    const hover = !input.feeding ? number(input.hover ?? 0, 0, 1) : 0;
    // One stable pat envelope (B05): a brief exit keeps it; a real exit eases it
    // out from the last touched position instead of cutting the eyes, lids and
    // head target to their untouched values in one frame.
    if (active) this.patGap = 0; else this.patGap += dt;
    const holding = !input.feeding && !active && this.patGap <= PAT_HOLD;
    const attentionTarget = active || holding ? 1 : smoothstep(hover);
    // R29f: critically damped instead of first order (contact: ω 7 keeps the old peak speed of the eased pat weight,
    // 3.5/s; feeding: ω 10, the old lag 2 / ω = 1 / 5). The first
    // frame after a change moves gently and the speed builds up, so the head the attention hands back (the pointer
    // gaze after a snack or a pat) never starts at full speed.
    this.contactAttention = dampCritical(this.contactAttention, attentionTarget, 7, dt, this.attentionVelocity, 'contact');
    this.feedingAttention = dampCritical(this.feedingAttention, input.feeding ? 1 : 0, 10, dt, this.attentionVelocity, 'feeding');
    // Eased pat weight: an S-curve over the attention ramp, both on entry and on release.
    const touching = smoothstep(this.contactAttention);
    let x = number(input.x, -1, 1), y = number(input.y, -1, 1);
    if (active || hover > 0) { this.patX = x; this.patY = y; } else { x = this.patX; y = this.patY; }
    const vx = active ? number(input.velocityX, -3, 3) : 0, vy = active ? number(input.velocityY, -3, 3) : 0;
    const posture = number(state.posture, 0, 100) / 50;
    const playful = number(state.playful, 0, 100) / 50;
    const pleasant = /^(亲近|满足|愉快|兴奋|释然|close|comfortable|comfort|happy|excited|reunion|affection|content|relieved)$/.test(state.mood);
    const serious = /^(关切|担心|紧张|失落|不满|伤感|想念|concerned|disappointed|upset|sad|longing|tense-expectation)$/.test(state.mood);
    const wistful = state.companion === 'wistful';
    const comfortable = state.companion === 'comfortable';
    const temporal = this.eventResponse(dt, state);
    const negative = temporal.negative;
    const positive = temporal.positive;
    const style = state.expressive && !serious ? playful : 0;
    const acknowledge = state.responding && (pleasant || (!serious && (state.context === 'support' || state.context === 'positive') && positive > 0));
    const automatic = automaticHeadAllowed && state.expressive;
    const attention = state.attention ? 1 : 0;
    // #11: the look or small motion she picked plays out (its own smooth curves, through the same spring below); while it
    // owns this cue, the old fixed light sway and eye lift step aside. Without a picked gesture everything is as before.
    const idle = this.idle.frame(dt, state.attention ? state.gesture ?? undefined : undefined, automatic);
    const sway = !idle.owns;
    const eventDown = serious && temporal.negative > 0 ? 0.012 * temporal.negative : 0;
    // B06 phases of a feed (used below for the mouth): after the bite (accepted locally, or the host's eating phase) she chews.
    const eating = input.feeding && (input.accepted === true || state.phase === 'food-eating') && !mouthBlocked;
    const feedingMouth = input.feeding && !eating && state.phase !== 'food-eating' && !mouthBlocked;
    // #32: how she eats this snack (her pick on the host; exactly 1 / 0 without one): a slower, smaller mouth and chew once she
    // has had a few, and now and then a small head shake as it reaches her mouth (into the same head spring below).
    const eat = this.eat.frame(dt, { feeding: input.feeding, eating,
      holding: input.feeding && input.accepted !== true && state.phase !== 'food-eating' && (input.prepared || number(input.near ?? 0, 0, 1) >= 1) },
    state.feed, automaticHeadAllowed);
    // Position layer 6 degrees; velocity and rebound share a 12 degree total cap.
    // The automatic sway hands over to the pat by the same eased weight (no switch).
    const untouched = 1 - touching;
    const target = {
      x: plus((y * 0.075 + vy * (0.014 + 0.003 * style)) * touching + (automatic ? eventDown + (wistful ? 0.004 : 0) : 0) * untouched, idle.x * posture * untouched),
      y: plus(plus((x * 0.085 + vx * 0.014) * touching, idle.y * posture * untouched), eat.yaw * untouched),
      z: plus((-x * 0.04 - vx * (0.018 + 0.004 * style)) * touching + (automatic && acknowledge && sway ? Math.sin(this.elapsed * 2) * 0.018 * posture * (1 + positive * 0.3) * (wistful ? 0.6 : 1)
        : automatic && attention && sway ? Math.sin(this.elapsed * 1.3) * 0.006 * posture : 0) * untouched, idle.z * posture * untouched),
    };
    const steps = Math.max(1, Math.ceil(dt * 120));
    for (let step = 0; step < steps; step++) {
      const h = dt / steps;
      for (const key of ['x', 'y', 'z'] as const) {
        this.velocity[key] += ((target[key] - this.angle[key]) * 100 - this.velocity[key] * 17) * h;
        this.angle[key] += this.velocity[key] * h;
      }
    }
    const length = Math.hypot(this.angle.x, this.angle.y, this.angle.z);
    const limit = Math.PI / 15;
    if (length > limit) {
      const scale = limit / length;
      for (const key of ['x', 'y', 'z'] as const) { this.angle[key] *= scale; this.velocity[key] *= scale; }
    }
    const face = state.expressive ? number(state.face, 0, 100) / 50 : 0;
    // #11: the face she picked for a look or motion sets how much of the acknowledging smile shows (1 = as before).
    const ack = idle.owns ? idle.smile : 1;
    const smileTarget = faceBlocked || serious ? 0
      : (pleasant ? (acknowledge ? (ack === 1 ? 0.27 : 0.16 + 0.11 * ack) : 0.16) : acknowledge ? 0.09 * ack : 0) * face * (1 + positive * 0.5) * (1 - negative * 0.75) * (wistful ? 0.65 : 1);
    // Enjoyment is stable throughout contact; instantaneous speed must not keep
    // reopening the lids every time it crosses the old 1.5 W/s boundary.
    // It also follows the one pat envelope above, so a stroke that leaves the scalp for a moment cannot flutter the lids.
    const eyeTarget = faceBlocked ? 0 : (pleasant ? 0.38 * (comfortable ? 1.15 : 1) : serious && comfortable ? 0.05 : 0) * face * touching;
    // A serious new topic cannot inherit the previous event's broad smile or enjoyed closed eyes.
    if (serious) { this.smile = 0; this.eyelids = Math.min(this.eyelids, eyeTarget); }
    this.smile = damp(this.smile, Math.min(0.7, smileTarget), 6, dt);
    this.eyelids = damp(this.eyelids, Math.min(0.75, eyeTarget), 6, dt);
    // B06: the mouth already opens while the snack approaches (by proximity),
    // opens fully once prepared, and closes on acceptance like a bite. Its
    // ownership weight lets the stage's mouth compositor fade lip-sync under it.
    // After the bite (accepted locally, or the host's eating phase) she chews with a nearly
    // closed mouth for as long as the bite lasts. It never depends on the read-aloud switch.
    // #32: the opening (only the opening: the bite closes as before) and the chew follow how she eats this snack; the chew's
    // clock advances by its pace, so a change of pace never jumps the chewing phase.
    const near = feedingMouth ? smoothstep(number(input.near ?? 0, 0, 1)) : 0;
    // The chew's clock keeps running while its weight fades after the bite (#32, R29): the old reset to 0 the moment the bite
    // ended dropped a mid-chew mouth by up to 0.11 in one frame.
    this.chew = eating || this.chewWeight > 1e-3 ? this.chew + dt * eat.chewRate : 0;
    this.chewWeight = damp(this.chewWeight, eating ? 1 : 0, 6, dt);
    // The bite closes like before; the small chew rides on top, so neither ever snaps.
    this.mouth = damp(this.mouth, feedingMouth ? (input.prepared ? FEED_OPEN : FEED_OPEN * FEED_ANTICIPATION * near) * eat.openSize : 0, feedingMouth ? 7 * eat.openRate : 7, dt);
    this.mouthOwner = damp(this.mouthOwner, eating ? 1 : feedingMouth ? Math.max(input.prepared ? 1 : 0, near) : 0, 8, dt);
    const chewing = this.chewWeight * CHEW_OPEN * eat.chewSize * (0.5 - 0.5 * Math.cos(2 * Math.PI * CHEW_RATE * this.chew));
    const blush = this.blushResponse(dt, state, faceBlocked);
    const sadnessTarget = !faceBlocked && state.expressive ? face * (wistful ? 0.1 : /^(sad|disappointed|伤感|失落)$/.test(state.mood) ? 0.18 : 0) : 0;
    const sadness = this.browFrame(sadnessTarget, dt);
    return {
      headX: this.angle.x, headY: this.angle.y, headZ: this.angle.z,
      smile: this.smile, eyelids: this.eyelids, mouth: Math.min(1, this.mouth + chewing), mouthOwner: this.mouthOwner, blush, sadness,
      gazeScale: 1 - this.attentionWeight,
      contact: clamp(this.contactAttention, 0, 1),
      eyeYaw: !faceBlocked && state.expressive ? plus(x * 0.025 * number(state.gaze ?? 50, 0, 100) / 50 * (serious ? 0.6 : 1) * touching, idle.eyeYaw * number(state.gaze ?? 50, 0, 100) / 50 * untouched) : 0,
      eyePitch: !faceBlocked && state.expressive ? plus((state.attention && sway ? -0.015 : 0) + (serious ? 0.008 * negative : 0) + (wistful ? 0.004 : 0), idle.eyePitch * untouched) * number(state.gaze ?? 50, 0, 100) / 50 : 0,
      playful: active && state.expressive && !serious ? Math.min(1, number(input.speed, 0, 3) / 3) * playful * (1 - negative * 0.75) : 0,
      eventPositive: positive, eventNegative: negative,
    };
  }
  /**
   * R29: the troubled brow eases toward its target (a mood, a companion, the expressions switch or a face block changing it)
   * from what it shows, with its speed carried; it used to be the raw target, a one-frame step the display guard had to catch.
   */
  private browFrame(target: number, dt: number): number {
    const velocity = this.sadnessVelocity;
    const next = Math.max(0, dampCritical(this.sadness, target, MOOD_BROW_OMEGA, dt, velocity, 'brow'));
    if (Math.abs(next - target) < BROW_LAND && Math.abs(velocity.brow) * Math.max(dt, 1 / 60) < BROW_LAND) { velocity.brow = 0; return this.sadness = target; }
    return this.sadness = next;
  }
  private eventResponse(dt: number, state: StageMoodState): { positive: number; negative: number } {
    const event = state.event;
    if (!event) { this.eventId = ''; this.eventAgeMs = 0; return { positive: 0, negative: 0 }; }
    const receivedAge = Number.isFinite(event.ageMs) ? Math.max(0, event.ageMs) : 0;
    if (this.eventId !== event.id) { this.eventId = event.id; this.eventAgeMs = receivedAge; }
    else this.eventAgeMs = Math.max(this.eventAgeMs + dt * 1000, receivedAge);
    const envelope = this.eventAgeMs > 5_000 ? 0 : Math.exp(-Math.max(0, this.eventAgeMs - 300) / 1_400);
    const threshold = Number.isFinite(state.fastThreshold) ? clamp(state.fastThreshold!, 1, 30) : 6;
    const response = Number.isFinite(state.trendResponse) ? clamp(state.trendResponse!, 0, 4) : 1;
    const value = (channel: MoodChannel) => Number.isFinite(event.delta[channel]) ? event.delta[channel] : 0;
    const evidence = (channel: MoodChannel, direction: 1 | -1) => {
      const latest = value(channel) * direction;
      if (latest <= 0) return 0;
      const window = state.trend?.[channel];
      return Math.max(latest, Number.isFinite(window) ? Math.max(0, window! * direction) * 0.5 : 0);
    };
    const fast = (channel: MoodChannel, direction: 'up' | 'down') => state.fast?.[channel] === direction ? 1.15 : 1;
    // Separate evidence keeps simultaneous expectation and pressure from cancelling.
    const positive = Math.max(0, evidence('D', 1) * fast('D', 'up'), evidence('O', 1) * fast('O', 'up'), evidence('E', 1) * fast('E', 'up'), event.context === 'support' ? evidence('C', -1) : 0);
    const pressure = event.context === 'concern' || event.context === 'offense' || /^(concerned|upset|tense-expectation|担心|不满|紧张期待)$/.test(state.mood);
    const negative = Math.max(0, evidence('D', -1) * fast('D', 'down'), evidence('O', -1) * fast('O', 'down'), evidence('E', -1) * fast('E', 'down'), pressure ? Math.max(evidence('C', 1), evidence('N', 1)) : 0);
    return { positive: clamp(positive / threshold * response, 0, 1) * envelope, negative: clamp(negative / threshold * response, 0, 1) * envelope };
  }
  private blushResponse(dt: number, state: StageMoodState, faceBlocked: boolean): number {
    const cue = state.blush;
    if (!cue) { this.blushId = ''; this.blushAgeMs = 0; return 0; }
    if (!Number.isFinite(cue.ageMs) || !Number.isFinite(cue.strength)) return 0;
    if (!state.expressive || faceBlocked || !cue.profile.enabled || cue.profile.intensity === 0) { this.mutedBlushId = cue.id; return 0; }
    if (cue.id === this.mutedBlushId) return 0;
    if (cue.id !== this.blushId) { this.blushId = cue.id; this.blushAgeMs = Math.max(0, cue.ageMs); }
    else this.blushAgeMs = Math.max(this.blushAgeMs + dt * 1000, cue.ageMs);
    return getBlushAmount(this.blushAgeMs, cue.strength, cue.profile, cue.floor);
  }
}
