/**
 * 2026-11-21: which words ask her to look at the USER (the camera), and which senses a request takes.
 * Split from look-request.ts (over the size limit); pure, no persona or user data. look-request.ts's clause rules call these.
 *
 * Before: "你看看我像…吗" read the object "我像…吗" as "this" ('either'), and with the screen shared 'either' took only the screen, so she
 * looked at the screen and said she could not see the user. "看看摄像头呢" asked nothing at all (no 你, no 这/那/我 after the verb).
 * Now:
 *  - an object that starts with the user themself ("我像…", "我胖了吗", "我是不是…") is the camera; "我的…" (a thing of theirs), "我这个",
 *    "我在…" (what they are doing) and screen things stay as before ("this": whichever is on);
 *  - looking at the camera itself ("看看摄像头", "瞧一眼镜头") is the camera;
 *  - "this" with both on takes both frames (lookWants): she is not made to guess which one the user meant. Only senses the user has on.
 */
import type { LookTarget } from './look-request';

/** The camera itself, as a thing to look at. */
const CAMERA_THING = '摄像头|镜头|相机|前置';
/** Anywhere in a clause: looking at the camera ("看看摄像头呢", "你瞧一眼镜头", "看下我的摄像头"); not "看到摄像头" (seen) or "关摄像头". */
const CAMERA_LOOK = new RegExp(`(?:看|瞧|瞅|瞄)(?:看|一看|一下|下|一眼)?(?:一下)?(?:我的?|这个?|我这个?)?(?:${CAMERA_THING})`, 'u');
/** After 我: a thing of theirs, a pointed-at thing, or what they are doing: not the user's own person (still "this"). */
const MINE_OR_DOING = /^我(?:的|这|那|在|正在|刚|写|做|画|弄|发|打|拍|给|跟|和|们)/u;

/** The clause asks her to look at the camera itself. */
export function looksAtCamera(clause: string): boolean { return CAMERA_LOOK.test(clause); }

/** The object of a look verb is the user (camera) or the camera itself; screen things are checked before this. */
export function objectIsYou(object: string): boolean {
  if (new RegExp(`^(?:我的?|这个?)?(?:${CAMERA_THING})`, 'u').test(object)) return true;
  return /^我/u.test(object) && !MINE_OR_DOING.test(object);
}

/**
 * Which senses a request asks for, given what is on: the screen for 'screen', the camera for 'camera', both for 'either' (whichever is on).
 * A "别看" on the camera (`cameraHeld`) wins over "this" while the screen is there to look at: only words about the user (or "this" with the
 * screen off, as before) lift it.
 */
export function lookWants(asked: LookTarget | null, on: { screen: boolean; camera: boolean; cameraHeld?: boolean }): { screen: boolean; camera: boolean } {
  const either = asked === 'either';
  return { screen: on.screen && (asked === 'screen' || either), camera: on.camera && (asked === 'camera' || (either && (!on.screen || on.cameraHeld !== true))) };
}

/** The request names the camera (alone, or "this" with both on): with 「发图片」 on and no "别看", she was asked to look at the user. */
export function asksCamera(asked: LookTarget | null): boolean { return asked === 'camera' || asked === 'either'; }
