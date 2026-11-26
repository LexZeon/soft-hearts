/**
 * When the pose process sends a signal to the host (moved out of engine.ts for I-167, docs/claude/2026-11-21-gaze-at-user.md).
 * Pure: the engine hands it the time, what it sent last and the signal it would send now.
 *
 * I-167: while the user is here and facing the screen (the tracker's `attending`), a small move of the face or a turn of the head goes
 * out at once (no sooner than every 80 ms), so her look follows within a frame or two of the pose rate; otherwise the old rule (a clear
 * face move at most every 150 ms, else every half second).
 */
import type { PoseHead, PosePoint, PoseSignal } from '../../../shared/senses/pose-signals';

export const POSE_EMIT = Object.freeze({
  /** A clear face move is sent no sooner than this after the last signal (ms) and only when it moved this far (frame share). */
  moveGapMs: 150, moveMin: 0.03,
  /** I-167: the same while attending (one rounding step of the face position; a head turn of turnMinDeg degrees counts too). */
  attendGapMs: 80, attendMoveMin: 0.01, turnMinDeg: 2,
  /** Otherwise a signal goes at least this often (ms) while somebody is there / while nobody is. */
  presentMs: 500, absentMs: 2_000,
});

export interface PoseEmitState {
  readonly t: number;
  readonly lastEmit: number;
  readonly lastFace: PosePoint | null;
  readonly lastPresent: boolean;
  /** I-167: the head reading last sent (absent: not known). */
  readonly lastHead?: PoseHead | null;
  /** I-167: the user is here and facing the screen (the tracker's attending). */
  readonly attending: boolean;
}

/** True when `signal` should go now. */
export function poseEmitDue(state: PoseEmitState, signal: PoseSignal): boolean {
  const k = POSE_EMIT, t = state.t, attending = state.attending && !!signal.face;
  const gap = attending ? k.attendGapMs : k.moveGapMs, min = attending ? k.attendMoveMin : k.moveMin;
  const faceMoved = !!signal.face && (!state.lastFace || Math.hypot(signal.face.x - state.lastFace.x, signal.face.y - state.lastFace.y) >= min - 1e-9);
  const last = state.lastHead ?? null, head = signal.head ?? null;
  const turned = attending && !!head && (!last || Math.abs(head.yaw - last.yaw) >= k.turnMinDeg || Math.abs(head.pitch - last.pitch) >= k.turnMinDeg);
  const moved = !!signal.face && t - state.lastEmit >= gap && (faceMoved || turned);
  const changed = signal.present !== state.lastPresent || signal.events.length > 0 || moved;
  return changed || t - state.lastEmit >= (signal.present ? k.presentMs : k.absentMs);
}
