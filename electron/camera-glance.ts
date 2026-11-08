import type { Attachment } from '../shared/contracts';
import { GLANCE_BLIND_MS } from '../shared/camera-glance';
import type { PoseSignal } from '../shared/pose-signals';

/**
 * I-036 「发图片」 + 「姿势识别」 both on: which of the user's
 * messages carry the small camera frame. With only 「发图片」 on, every message does. With both on she already gets the local pose
 * signals (present, facing, posture, movement), so a small frame goes only when they changed meaningfully since the last frame
 * that went, or when none went for GLANCE_BLIND_MS (she does not go blind); otherwise the message carries no picture.
 *
 * "Changed meaningfully" (the rule, small enough to test):
 *  - somebody came or left (`present`), turned (`facing`), or changed posture (`posture`);
 *  - the amount of movement moved to another band (still < 0.2 ≤ moving < 0.55 ≤ lively);
 *  - a one-shot event (wave, stretch, yawn) happened since the last frame that went;
 *  - no signal at all yet (sensing still starting) counts as changed: no reason to hold the picture back.
 * The frame itself comes from MediaRuntime.cameraAttachment (kept ready, never captured here).
 */
export type MovementBand = 'still' | 'moving' | 'lively';
export function movementBand(energy: number): MovementBand {
  return energy < 0.2 ? 'still' : energy < 0.55 ? 'moving' : 'lively';
}

/** The part of a pose signal that decides whether a new picture is worth sending. */
export interface PoseGist { present: boolean; facing: PoseSignal['facing']; posture: PoseSignal['posture']; band: MovementBand }
export function poseGist(signal: PoseSignal): PoseGist {
  return { present: signal.present, facing: signal.facing, posture: signal.posture, band: movementBand(signal.energy) };
}
export function gistChanged(before: PoseGist, now: PoseGist): boolean {
  return before.present !== now.present || before.facing !== now.facing || before.posture !== now.posture || before.band !== now.band;
}

export interface CameraGlancePorts {
  /** The kept small frame (null: none fresh, 「发图片」 off or held). */
  frame(): Attachment | null;
  /** 「姿势识别」 is on now. */
  poseOn(): boolean;
  /** The latest pose signal while sensing runs (null: not running yet). */
  signal(): PoseSignal | null;
  /** Which opening of the camera this is (electron/runtime.ts openings.camera): a new opening starts the rule over. */
  opening(): number;
  now?(): number;
}

export class CameraGlance {
  private sent: { opening: number; at: number; gist: PoseGist | null } | null = null;
  /** One-shot events seen since the last frame that went (the signal that carried one is gone by the next tick). */
  private eventSince = false;
  constructor(private readonly ports: CameraGlancePorts) {}

  /** Every pose signal passes here (electron/main.ts onSignal). Nothing is kept but whether an event happened. */
  noteSignal(signal: PoseSignal): void { if (signal.events.length) this.eventSince = true; }

  /** Whether the next message would carry a small frame by the rule (tests and the developer panel); takes nothing. */
  due(): boolean {
    if (!this.ports.poseOn()) return true;
    const opening = this.ports.opening(), now = this.ports.now?.() ?? Date.now();
    const signal = this.ports.signal();
    const sent = this.sent;
    if (!sent || sent.opening !== opening || !signal || !sent.gist) return true;
    if (now - sent.at >= GLANCE_BLIND_MS || now < sent.at) return true;
    return this.eventSince || gistChanged(sent.gist, poseGist(signal));
  }

  /** The small frame this message carries, or null. A frame handed out counts as sent (the next one compares with it). */
  take(): Attachment | null {
    if (!this.due()) return null;
    const frame = this.ports.frame();
    if (!frame) return null;
    this.seen();
    return frame;
  }

  /** A clear frame went (the user asked her to look): the next small frame compares with what she saw then. */
  seen(): void {
    const signal = this.ports.signal();
    this.sent = { opening: this.ports.opening(), at: this.ports.now?.() ?? Date.now(), gist: signal ? poseGist(signal) : null };
    this.eventSince = false;
  }

  /** The camera was turned off or the vision context cleared: start over. */
  reset(): void { this.sent = null; this.eventSince = false; }
}
