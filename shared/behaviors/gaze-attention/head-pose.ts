/**
 * I-167 (docs/claude/2026-11-21-gaze-at-user.md): how far away the user's head is and which way it is turned, from five keypoints of the
 * pose model (COCO-17: 0 nose, 1 left eye, 2 right eye, 3 left ear, 4 right ear — the person's own left and right). Pure; runs inside the
 * pose process on one frame's full-precision keypoints, before anything is rounded.
 *
 * A small fixed head model (an average adult; the numbers are below): the nose tip sits in front of the eyes and below them, the ears
 * behind. The picture is first turned so the head sits on the lens axis (a virtual camera looking straight at the head; this removes
 * the slant of a head off to one side or below the camera), and each point is put back at its own depth (the nose is nearer, the ears
 * further). Then:
 *  - distance: the eye span against the model's 6.3 cm (a turned head shows a shorter span; the turn is taken out);
 *  - yaw: the nose sideways against the eyes, and against the ears when both are seen (about four times as clear: a longer lever);
 *  - pitch: the nose up or down against the eyes (and the ears) — the weakest of the three; a different nose shifts it by several degrees.
 *
 * Angles are in the camera's frame (the screen's frame: the camera sits in the screen, looking out): yaw + = the head points toward the
 * screen's right as the user sees it, pitch + = down; 0, 0 = pointing straight at the screen, square to it.
 */

/** The head model, in metres (an average adult; first guesses, checked on synthetic heads only). */
export const HEAD_MODEL = Object.freeze({
  /** Between the eye centres. */
  eyeSpanM: 0.063,
  /** Between the ear points. */
  earSpanM: 0.145,
  /** The nose tip in front of the eyes / below them. */
  noseAheadM: 0.028, noseBelowM: 0.04,
  /** The ear points behind the eyes / below them. */
  earBehindM: 0.08, earBelowM: 0.01,
});
export type HeadModel = typeof HEAD_MODEL;

export interface HeadPose {
  /** rad, + = the head points toward the screen's right (as the user sees it). */
  readonly yaw: number;
  /** rad, + = down. */
  readonly pitch: number;
  /** m, from the camera to the eyes. */
  readonly distance: number;
}

const MAX_YAW = (75 * Math.PI) / 180;
const MAX_PITCH = (60 * Math.PI) / 180;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * One frame: `kpts` [17×2] pixels of a `width` × `height` picture (square pixels), `scores` [17], `seen` the score a point needs,
 * `hfovDeg` the camera's horizontal view angle. null when the nose and both eyes are not all seen, or the eyes are crossed over.
 */
export function headPoseOf(kpts: ArrayLike<number>, scores: ArrayLike<number>, width: number, height: number, seen: number, hfovDeg: number,
  model: HeadModel = HEAD_MODEL): HeadPose | null {
  const ok = (i: number) => scores[i] >= seen && Number.isFinite(kpts[i * 2]) && Number.isFinite(kpts[i * 2 + 1]);
  if (!(width > 0) || !(height > 0) || !(hfovDeg > 1 && hfovDeg < 170) || !ok(0) || !ok(1) || !ok(2)) return null;
  const focal = width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
  // Rays in the camera's frame: x = screen right as the user sees it (the picture's left: the picture is not mirrored), y = down, z = out to the user.
  const ray = (i: number): [number, number, number] => [-(kpts[i * 2] - width / 2) / focal, (kpts[i * 2 + 1] - height / 2) / focal, 1];
  const e1 = ray(1), e2 = ray(2);
  const mx = (e1[0] + e2[0]) / 2, my = (e1[1] + e2[1]) / 2;
  // The virtual camera: yaw by atan(mx), then pitch by atan(my / hypot(1, mx)), so the eyes' middle is on its axis.
  const rayYaw = Math.atan(mx), rayPitch = Math.atan2(my, Math.hypot(1, mx));
  const cy = Math.cos(rayYaw), sy = Math.sin(rayYaw), cp = Math.cos(rayPitch), sp = Math.sin(rayPitch);
  const local = (i: number): [number, number] => {
    const [x, y, z] = ray(i);
    const x1 = x * cy - z * sy, z1 = x * sy + z * cy; // undo the yaw
    const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp; // undo the pitch
    return [x1 / z2, y2 / z2];
  };
  const p = [local(0), local(1), local(2), ok(3) ? local(3) : null, ok(4) ? local(4) : null];
  // The eye axis, from the left eye to the right eye (x + = the person's right when they face the screen).
  const spanX = p[2]![0] - p[1]![0], spanY = p[2]![1] - p[1]![1], span = Math.hypot(spanX, spanY);
  if (!(span > 1e-4) || spanX <= 0) return null;
  const ax = spanX / span, ay = spanY / span;
  const along = (x: number, y: number) => x * ax + y * ay, across = (x: number, y: number) => -x * ay + y * ax;
  const ears = !!p[3] && !!p[4] && along(p[4]![0] - p[3]![0], p[4]![1] - p[3]![1]) > span;
  // Distance and yaw together: the depth of each point depends on the turn, the turn's reading on the depth (two rounds settle it).
  let distance = model.eyeSpanM / span, yaw = 0, pitch = 0;
  for (let round = 0; round < 3; round++) {
    const cos = Math.cos(yaw) * Math.cos(pitch);
    const depthOf = (aheadM: number) => (distance - aheadM * cos) / distance;
    const nose = depthOf(model.noseAheadM), ear = depthOf(-model.earBehindM);
    // Metres beside / below the eyes' middle, in the eye span's own units (each point at its own depth).
    const n = p[0]!, noseSide = along(n[0], n[1]) * nose, noseDrop = across(n[0], n[1]) * nose;
    // Yaw +: the nose moves toward the person's right (+ along): side / span = (ahead / eyeSpan) · tan(yaw).
    const eyeLever = model.noseAheadM / model.eyeSpanM;
    let tanSum = (noseSide / span / eyeLever) * span * span, weight = span * span;
    let earSide = 0, earDrop = 0, earSpan = 0;
    if (ears) {
      const l = p[3]!, r = p[4]!;
      earSpan = along(r[0] - l[0], r[1] - l[1]) * ear;
      earSide = noseSide - along((l[0] + r[0]) / 2, (l[1] + r[1]) / 2) * ear;
      earDrop = noseDrop - across((l[0] + r[0]) / 2, (l[1] + r[1]) / 2) * ear;
      const earLever = (model.noseAheadM + model.earBehindM) / model.earSpanM;
      // Inverse-variance weights for the same pixel noise: the ears' lever is longer.
      const w = (earSpan * earLever / eyeLever) ** 2;
      tanSum += (earSide / earSpan / earLever) * w; weight += w;
    }
    yaw = clamp(Math.atan(tanSum / weight), -MAX_YAW, MAX_YAW);
    const cosYaw = Math.max(0.26, Math.cos(yaw)), facing = span / cosYaw;
    // Pitch: drop = below · cos p + ahead · sin p (metres), solved for p on the branch through 0.
    const solve = (dropM: number, below: number, ahead: number) => Math.atan2(ahead, below) - Math.acos(clamp(dropM / Math.hypot(below, ahead), -1, 1));
    let pitchSum = solve(noseDrop / facing * model.eyeSpanM, model.noseBelowM, model.noseAheadM) * facing ** 2, pitchWeight = facing ** 2;
    if (ears && earSpan > 0) {
      const earFacing = earSpan / cosYaw, lever = (model.noseAheadM + model.earBehindM) / model.earSpanM / (model.noseAheadM / model.eyeSpanM);
      const w = (earFacing * lever) ** 2;
      pitchSum += solve(earDrop / earFacing * model.earSpanM, model.noseBelowM - model.earBelowM, model.noseAheadM + model.earBehindM) * w; pitchWeight += w;
    }
    pitch = clamp(pitchSum / pitchWeight, -MAX_PITCH, MAX_PITCH);
    distance = model.eyeSpanM / facing;
  }
  // Back to the camera's frame. Facing the virtual camera means pointing back along the ray: a head to the right of the camera that
  // faces it points left. So a turn read against the ray is the screen's turn plus the ray's own slant, taken away.
  const out = { yaw: clamp(yaw - rayYaw, -MAX_YAW, MAX_YAW), pitch: clamp(pitch - rayPitch, -MAX_PITCH, MAX_PITCH), distance };
  return Number.isFinite(out.yaw) && Number.isFinite(out.pitch) && out.distance > 0 && Number.isFinite(out.distance) ? out : null;
}
