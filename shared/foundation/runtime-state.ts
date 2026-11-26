// Foundation (docs/claude/2026-11-15-overhaul-plan.md section 8, docs/claude/2026-11-16-overhaul-foundation.md): what the senses switches look like on the wire (runtime state and why a switch stayed off), moved out of
// shared/contracts.ts, which re-exports it.
// Types and fixed data only; it imports no part, so every part, the contract (shared/contracts.ts) and the wiring may use it.

/**
 * Why voice input stayed off (electron/senses/media-runtime.ts, local recognizer only): the component is missing (the control window
 * asks), still downloading or installing, or there is no local recognizer for this computer.
 */
/** Which window owns a capture (camera, voice): the host's word for it (moved here from electron/runtime.ts, now electron/senses/media-runtime.ts, which re-exports it; wiring rewrite step 2). */
export type MediaOwner = "controls" | "pet";
export type VoiceRefusal = 'needs-component' | 'preparing' | 'unavailable';
/**
 * Why 「和她一起听」 hears only the rhythm (I-016, Codex T-207): the local recognizer's reasons, or 'not-local' — 识别方式 is the
 * compatible address, and played sound is transcribed only on this computer (the approved plan: "声音只在本机，转写只在本机").
 */
export type AudioReadingRefusal = VoiceRefusal | 'not-local';
export interface RuntimeState {
  voiceInput: boolean;
  screenSharing: boolean;
  cameraSharing: boolean;
  voiceOwner: 'controls' | 'pet' | null;
  cameraOwner: 'controls' | 'pet' | null;
  /**
   * Camera switch 「姿势识别」 on (I-001 local pose sensing): frames stay in the hidden sensor window and the local inference
   * process. I-036: one of the two independent switches under 「摄像头共享」; `cameraSharing` is true while
   * either is on.
   */
  cameraLocal?: boolean;
  /**
   * Camera switch 「发图片」 on (I-036): the owner window keeps a small frame ready and each message the
   * user sends carries it (a clear one when the user asks her to look); no component download.
   */
  cameraImages?: boolean;
  /** 「发图片」 is on but the user said not to look (electron/senses/look-turns.ts): no frame is taken until the user asks her to look. */
  cameraHeld?: boolean;
  /** Only in the reply to the window that asked to turn the camera on and was refused (never in the broadcast state). */
  cameraRefused?: CameraRefusal;
  /** Only in the reply to the window that asked to turn voice input on and was refused (never in the broadcast state). */
  voiceRefused?: VoiceRefusal;
}
/**
 * Why 「姿势识别」 stayed off (electron/senses/media-runtime.ts): the local pose component is missing (the control window asks),
 * it is still downloading or installing, or local sensing could not be set up at all. None of them turns 「发图片」 on
 * instead: that is the user's own separate switch (I-036).
 */
export type CameraRefusal = 'needs-component' | 'preparing' | 'unavailable';
/**
 * `cameraImages` / `cameraLocal`: the two camera switches (I-036). `cameraSharing: false` turns both off; `cameraSharing: true`
 * alone is the old single switch and means 「姿势识别」 (what the camera meant before I-036).
 */
export interface RuntimePatch { voiceInput?: boolean; screenSharing?: boolean; cameraSharing?: boolean; cameraImages?: boolean; cameraLocal?: boolean; }
export interface SystemAudioState { active: boolean; }

/** A window's native visibility as the host reports it (moved here from shared/contracts.ts, which re-exports it; wiring rewrite step 2). */
export interface WindowVisibilityState {
  windowId: number;
  revision: number;
  /** Actual visibility of this sender's native window, including minimization. */
  visible: boolean;
  /** Host-owned requested companion visibility, independent of this window's role. */
  petVisible: boolean;
  /** I-171: the window is only minimized (a step away: the reply, the bubble and the warm process are kept), not hidden; absent means false. */
  minimized?: boolean;
}
