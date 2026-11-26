/**
 * I-081 第 2 步：从"你在镜头画面里的位置"算出她该往哪儿看。纯计算，没有时钟、没有 I/O。
 * I-167（docs/claude/2026-11-21-gaze-at-user.md）：你离摄像头多远按脸的大小估（head-pose.ts），不再是一个固定值；你的头朝哪也算出来。
 *
 * 假设（旋钮在 knobs.ts 的 camera）：摄像头在她所在那块屏幕的上方正中，朝着你；屏幕一个逻辑像素约 mmPerPx 毫米。
 * 摄像头拍到的画面没有镜像（electron/senses/pose/sensor-preload.ts 原样画进画布）：你往屏幕右边挪，在画面里是往左边去。
 *
 * 两步：
 *  1. host（electron/senses/user-gaze.ts）：画面位置 + 距离 → 你的头在屏幕前的位置，换成和鼠标一样的单位（以她窗口中心为 0、
 *     半个窗口宽/高为 1，右、上为正）：x、y 是你的头正对着屏幕上的哪一点，dx、dy 是你离屏幕多远（同一单位）。
 *  2. 舞台（每帧）：从她眼睛（她头的骨头投到屏幕上的位置）到你的头连一条线，这条线的角度乘 aim，换成视线用的单位
 *     （procedural.ts gazeTargets：1 ≈ 头转 0.48 / 0.28 弧度；小角度只动眼睛，大角度头跟着转，和跟鼠标一样）。
 */
import type { PoseHead, PosePoint } from '../../senses/pose-signals';
import { GAZE_ATTENTION_KNOBS, type GazeAttentionKnobs } from './knobs';

export interface ScreenRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
/** The user in the pointer's units relative to her window (x right, y up), and the viewing distance in the same units. */
export interface UserGazePoint { readonly x: number; readonly y: number; readonly dx: number; readonly dy: number }
/** I-167: which way the user's head points, in degrees (x + = toward the screen's right as the user sees it, y + = up: the pointer's sense). */
export interface UserTurn { readonly x: number; readonly y: number }

/** gazeTargets: one unit of x is 0.48 rad of yaw, one unit of y is 0.28 rad of pitch (src/stage/procedural.ts). */
export const GAZE_YAW_PER_UNIT = 0.48;
export const GAZE_PITCH_PER_UNIT = 0.28;
const LIMIT = 8;
const round2 = (value: number) => Math.round(value * 100) / 100;
const finiteRect = (rect: ScreenRect | null | undefined): rect is ScreenRect => !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
  && rect.width > 0 && rect.height > 0;

/** I-167: the viewing distance in metres: the face-size estimate when there is one, else the prior, kept between near and far. */
export function viewingDistanceM(head: Pick<PoseHead, 'distance'> | null | undefined, knobs: GazeAttentionKnobs['camera'] = GAZE_ATTENTION_KNOBS.camera): number {
  const measured = head && Number.isFinite(head.distance) && head.distance > 0 ? head.distance : knobs.distance;
  return Math.min(Math.max(knobs.near, knobs.far), Math.max(Math.min(knobs.near, knobs.far), measured));
}

/**
 * Step 1 (host): where the user's head is in front of the screen, in her window's pointer units, and the viewing distance.
 * `head`: the pose signal's head reading (its distance; I-167), or null for the prior distance. null when anything is missing or not finite.
 */
export function userGazePoint(face: PosePoint | null | undefined, display: ScreenRect | null | undefined, pet: ScreenRect | null | undefined,
  knobs: GazeAttentionKnobs['camera'] = GAZE_ATTENTION_KNOBS.camera, head: Pick<PoseHead, 'distance'> | null = null): UserGazePoint | null {
  if (!face || !Number.isFinite(face.x) || !Number.isFinite(face.y) || !finiteRect(display) || !finiteRect(pet) || !(knobs.mmPerPx > 0)) return null;
  // The ray from the camera to the face (x = screen right, y = down, per unit of depth), then the head along it at the measured distance.
  // Not mirrored: the right of the camera's picture is the user's left, which is the left of the screen as the user sees it.
  const a = (0.5 - Math.min(1, Math.max(0, face.x))) * 2 * Math.tan((knobs.hfov * Math.PI) / 360);
  const b = (Math.min(1, Math.max(0, face.y)) - 0.5) * 2 * Math.tan((knobs.vfov * Math.PI) / 360);
  const depth = viewingDistanceM(head, knobs) * 1000 / knobs.mmPerPx / Math.hypot(1, a, b); // px
  const screenX = display.x + display.width / 2 + a * depth, screenY = display.y + b * depth;
  const halfW = pet.width / 2, halfH = pet.height / 2;
  const x = (screenX - (pet.x + halfW)) / halfW, y = -(screenY - (pet.y + halfH)) / halfH;
  const point = { x: round2(Math.max(-LIMIT, Math.min(LIMIT, x))), y: round2(Math.max(-LIMIT, Math.min(LIMIT, y))),
    dx: round2(Math.max(0.05, Math.min(LIMIT * 4, depth / halfW))), dy: round2(Math.max(0.05, Math.min(LIMIT * 4, depth / halfH))) };
  return Object.values(point).every(Number.isFinite) ? point : null;
}

/** I-167: the head's direction for the reading (degrees, the pointer's sense: y up), or null without a head reading. */
export function userTurn(head: Pick<PoseHead, 'yaw' | 'pitch'> | null | undefined): UserTurn | null {
  if (!head || !Number.isFinite(head.yaw) || !Number.isFinite(head.pitch)) return null;
  return { x: Math.round(Math.max(-90, Math.min(90, head.yaw))) || 0, y: Math.round(Math.max(-90, Math.min(90, -head.pitch))) || 0 };
}

/** The look from the user's head (`point`) toward a spot on the screen (the pointer's units), as angles in degrees (x right, y up). */
export function angleToward(point: UserGazePoint, spotX: number, spotY: number): { x: number; y: number } {
  const deg = 180 / Math.PI;
  return { x: Math.atan2(spotX - point.x, Math.max(0.05, point.dx)) * deg, y: Math.atan2(spotY - point.y, Math.max(0.05, point.dy)) * deg };
}

/**
 * Step 2 (stage, every frame): where to look from her eyes (origin, the pointer's units) toward the user, in gazeTargets' units,
 * turned only `aim` of the way (a face on a screen that looks straight out seems to look at whoever looks at it).
 */
export function userAim(point: UserGazePoint, originX: number, originY: number, aim = GAZE_ATTENTION_KNOBS.camera.aim): { x: number; y: number } {
  const ox = Number.isFinite(originX) ? originX : 0, oy = Number.isFinite(originY) ? originY : 0;
  const yaw = Math.atan2(point.x - ox, Math.max(0.05, point.dx)), pitch = Math.atan2(point.y - oy, Math.max(0.05, point.dy));
  const k = Number.isFinite(aim) ? Math.max(0, Math.min(1, aim)) : 0;
  return { x: (yaw / GAZE_YAW_PER_UNIT) * k, y: (pitch / GAZE_PITCH_PER_UNIT) * k };
}
