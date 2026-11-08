import type {
  Attachment,
  CameraRefusal,
  RuntimePatch,
  RuntimeState,
  VoiceRefusal,
} from "../shared/contracts";
import { GLANCE_MAX_AGE_MS, GLANCE_MAX_CHARS } from "../shared/camera-glance";

export type MediaOwner = "controls" | "pet";
/**
 * What 「姿势识别」 may do now (electron/pose/host.ts). "local": local pose sensing can run; "blocked": the pose component is
 * missing, the switch stays off and the host asks; "share": this platform has no component package.
 * `blocked` says why; without an answer (no pose host) the switch is "unavailable".
 *
 * I-036: the camera is two independent switches, 「发图片」 (`cameraImages`, no download) and
 * 「姿势识别」 (`cameraLocal`); both, either or none. A refused 「姿势识别」 never turns 「发图片」 on instead. The old single switch
 * (`cameraSharing: true` alone: older windows, the internal channel's `camera`) means 「姿势识别」, what the camera meant before;
 * only where there is no pose component at all ("share") it means 「发图片」, as it always did there.
 */
export interface CameraPolicy { mode(): "local" | "share" | "blocked"; blocked?(owner: MediaOwner): CameraRefusal | void }
/**
 * Whether voice input may turn on now (electron/asr/host.ts, local recognizer only): null = yes; otherwise the switch
 * stays off and the window that asked learns why (never a switch that is on but cannot hear).
 */
export interface VoicePolicy { blocked(owner: MediaOwner): VoiceRefusal | null }
export const EMPTY_RUNTIME: RuntimeState = {
  voiceInput: false,
  screenSharing: false,
  cameraSharing: false,
  voiceOwner: null,
  cameraOwner: null,
};
const PATCH_KEYS = ["voiceInput", "screenSharing", "cameraSharing", "cameraImages", "cameraLocal"];

/** 「发图片」 was on and is now off, or its frames now come from another window: frames of the old opening must go (electron/main.ts). */
export function cameraImagesRevoked(previous: RuntimeState, next: RuntimeState): boolean {
  return previous.cameraImages === true && (next.cameraImages !== true || previous.cameraOwner !== next.cameraOwner);
}

export class MediaRuntime {
  constructor(private readonly changed?: (state: RuntimeState) => void, private readonly cameraPolicy?: CameraPolicy,
    private readonly voicePolicy?: VoicePolicy, private readonly clock: () => number = Date.now) {}
  state: RuntimeState = { ...EMPTY_RUNTIME };
  revision = 0;
  /**
   * 关掉之后的旧帧: which opening of each source this is. It changes whenever screen sharing turns on or off, and whenever the
   * camera turns on or off or changes owner or mode (and on reset). A frame taken during one opening is never current in another,
   * so turning a source off and on again never brings an old frame back (electron/look-attachments.ts).
   */
  readonly openings = { screen: 0, camera: 0 };
  /** The latest small frame of 「发图片」 (in memory only, never written anywhere). */
  private camera: { dataUrl: string; at: number } | null = null;
  clearCamera(): void { this.camera = null; }
  update(value: unknown, owner: MediaOwner, resolveVoiceOwner?: (requested: MediaOwner) => MediaOwner): RuntimeState {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("媒体开关格式不正确。");
    const patch = value as RuntimePatch;
    const keys = Object.keys(patch);
    if (
      !keys.length ||
      keys.some(
        (key) =>
          !PATCH_KEYS.includes(key) ||
          typeof patch[key as keyof RuntimePatch] !== "boolean",
      )
    )
      throw new Error("只允许修改媒体开关。");
    const { cameraSharing, cameraImages, cameraLocal, ...rest } = patch;
    const next: RuntimeState = { ...this.state, ...rest };
    // The two camera switches (I-036).
    let images = this.state.cameraImages === true, pose = this.state.cameraLocal === true;
    if (cameraSharing === false) images = pose = false;
    let legacyOn = cameraSharing === true && cameraImages === undefined && cameraLocal === undefined && !this.state.cameraSharing;
    if (cameraImages !== undefined) images = cameraImages;
    if (cameraLocal !== undefined) pose = cameraLocal;
    let refused: CameraRefusal | undefined;
    if (legacyOn && (this.cameraPolicy?.mode() ?? "share") === "share") { images = true; legacyOn = false; }
    else if (legacyOn) pose = true;
    if (pose && this.state.cameraLocal !== true) {
      const mode = this.cameraPolicy?.mode() ?? "share";
      if (mode !== "local") {
        pose = false;
        // The window that asked learns why and shows it (2026-11-03: the pet button looked dead); the broadcast never carries it.
        refused = (mode === "blocked" ? this.cameraPolicy?.blocked?.(owner) : undefined) || "unavailable";
      }
    }
    const turnedOn = (images && this.state.cameraImages !== true) || (pose && this.state.cameraLocal !== true);
    next.cameraSharing = images || pose;
    if (images) next.cameraImages = true; else delete next.cameraImages;
    if (pose) next.cameraLocal = true; else delete next.cameraLocal;
    if (refused && !turnedOn && next.cameraSharing === this.state.cameraSharing
      && keys.every(key => key === "cameraSharing" || key === "cameraImages" || key === "cameraLocal"))
      return { ...this.state, cameraRefused: refused };
    let voiceRefused: VoiceRefusal | undefined;
    if (patch.voiceInput === true && !this.state.voiceInput) {
      const refusal = this.voicePolicy?.blocked(owner) ?? null;
      if (refusal) {
        next.voiceInput = false; voiceRefused = refusal;
        if (keys.length === 1) return { ...this.state, voiceRefused };
      }
    }
    if (patch.voiceInput !== undefined)
      next.voiceOwner = next.voiceInput ? (resolveVoiceOwner?.(owner) ?? owner) : null;
    // The window that turned a camera switch on (or the old single switch, as before) owns the camera: 「发图片」 frames come from
    // its stream. Off is nobody's.
    next.cameraOwner = !next.cameraSharing ? null : turnedOn || cameraSharing === true ? owner : this.state.cameraOwner ?? owner;
    // A "别看" holds only within this opening of 「发图片」 in this window.
    if (!next.cameraImages || next.cameraOwner !== this.state.cameraOwner) delete next.cameraHeld;
    if (!next.cameraImages || next.cameraOwner !== this.state.cameraOwner)
      this.camera = null;
    if (next.screenSharing !== this.state.screenSharing) this.openings.screen++;
    if (next.cameraSharing !== this.state.cameraSharing || next.cameraOwner !== this.state.cameraOwner
      || next.cameraLocal !== this.state.cameraLocal || next.cameraImages !== this.state.cameraImages) this.openings.camera++;
    this.state = next;
    this.revision++;
    this.changed?.({ ...next });
    return { ...next, ...(refused ? { cameraRefused: refused } : {}), ...(voiceRefused ? { voiceRefused } : {}) };
  }
  /**
   * I-036: the user said not to look (true) or asked her to look again (false) while 「发图片」 is on. Held, no small frame is
   * kept or accepted and the owner window stops drawing them (it reads `cameraHeld`). Not a new opening: the switches stay as
   * the user set them. True when the state changed (the caller broadcasts it).
   */
  holdCamera(held: boolean): boolean {
    if (this.state.cameraImages !== true || (this.state.cameraHeld === true) === held) return false;
    const next: RuntimeState = { ...this.state };
    if (held) { next.cameraHeld = true; this.camera = null; } else delete next.cameraHeld;
    this.state = next;
    this.changed?.({ ...next });
    return true;
  }
  reset(): RuntimeState {
    this.state = { ...EMPTY_RUNTIME };
    this.camera = null;
    this.openings.screen++;
    this.openings.camera++;
    this.revision++;
    this.changed?.({ ...this.state });
    return { ...this.state };
  }
  dropOwner(owner: MediaOwner): RuntimeState {
    const patch: RuntimePatch = {};
    if (this.state.screenSharing) patch.screenSharing = false;
    if (this.state.voiceOwner === owner) patch.voiceInput = false;
    if (this.state.cameraOwner === owner) patch.cameraSharing = false;
    return Object.keys(patch).length
      ? this.update(patch, owner)
      : { ...this.state };
  }
  /** 「发图片」 is on: its owner window holds the camera stream and may hand frames to the host (never for 「姿势识别」 alone). */
  sharesCameraFrames(): boolean { return this.state.cameraSharing && this.state.cameraImages === true; }
  /** The owner window's latest small frame (I-036): only while 「发图片」 is on and not held, a JPEG of at most GLANCE_MAX_CHARS. */
  publishCamera(owner: MediaOwner, value: unknown): void {
    if (!this.sharesCameraFrames() || this.state.cameraOwner !== owner)
      throw new Error("此窗口未开启摄像头共享。");
    if (this.state.cameraHeld) throw new Error("你说了先别看，摄像头画面暂不发送。");
    if (
      typeof value !== "string" ||
      value.length > GLANCE_MAX_CHARS ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value)
    )
      throw new Error("摄像头画面格式不正确或过大。");
    this.camera = { dataUrl: value, at: this.clock() };
  }
  /** The kept small frame, if it is fresh (GLANCE_MAX_AGE_MS) and 「发图片」 is on and not held; nothing is captured here. */
  cameraAttachment(now = this.clock()): Attachment | null {
    return this.sharesCameraFrames() && !this.state.cameraHeld &&
      this.camera &&
      now - this.camera.at >= 0 && now - this.camera.at < GLANCE_MAX_AGE_MS
      ? { source: "camera", dataUrl: this.camera.dataUrl }
      : null;
  }
  allowsMedia(
    owner: MediaOwner,
    type: "audio" | "video",
    manualCamera = false,
  ): boolean {
    return type === "audio"
      ? this.state.voiceInput && this.state.voiceOwner === owner
      : (this.sharesCameraFrames() && this.state.cameraOwner === owner) ||
          (owner === "controls" && manualCamera);
  }
}
