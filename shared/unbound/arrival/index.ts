/**
 * I-192 arrival targets (到达位置) in full-screen Unbound: an action says where a part of her must arrive in viewer space and how long she stays;
 * the motion layer walks her there, leans her and closes the last centimetres every frame. The public page of the part (README.md).
 */
export { ARRIVAL_KNOBS, ARRIVAL_KNOB_RANGES, type ArrivalKnobs } from './knobs';
export { FACE_PER_EYE_SPAN, MOUTH_SHARE, eyeClearDistance, faceAim, faceDistance, faceSpanM, fallbackFace, reachAhead, turnHead, usableFace, type FaceDistance, type FaceGeometry } from './face';
export {
  ARRIVAL_LIMITS, alongAxis, axisPlace, facingAxis, intoHerFrame, leanHeadPoint, leanPoint, reachLean, solveHeadArrival, standUnder, windowPoint,
  type ArrivalLens, type ArrivalSolve, type V3, type WindowPerM,
} from './solve';
export { ARRIVAL_LOOP, ArrivalLoop, type LoopError, type LoopLimits } from './loop';
export { alongToFit, frameWorst, headNow, inWindow, nearestAlong, settledShift, type ArrivalWindow, type FramedLens } from './frame';
export { HoldClock, arrivalHoldS, holdBaseS, holdGoesOn, type HoldKind, type HoldReading, type HoldState } from './hold';
// I-203: the end frames written as where her face sits on the screen (the kiss storyboard, the hug's last frame).
export {
  earOffset, faceTurnSeen, headAxes, headPointNow, headWidthM, hugFrame, kissFrame, shareDistance, windowPerM,
  type HeadOffset, type HugFrame, type KissFrame, type ScreenSpot,
} from './screen-frame';
