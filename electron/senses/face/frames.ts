/**
 * I-135: where the face check's frames come from. Only from a camera the user already turned on:
 *  - 「姿势识别」 on: one copy of the hidden sensor window's next frame (PoseSupervisor.tap), ≤ 320×240;
 *  - 「发图片」 on (and the user has not said "别看"): the small picture the window keeps for messages (a new one every
 *    ~3 s), or for enrolment a fresh clear one (the same path as 「拍一张给她看」), decoded and scaled to ≤ 640×480.
 * Both off: no frame, ever. Pure apart from the injected ports (tests use fakes).
 */
import type { FaceFrame, FaceFrameSource } from './host';

export interface FaceFramePorts {
  /** 「姿势识别」 is switched on (frames exist once sensing runs). */
  poseOn(): boolean;
  poseTap(): Promise<FaceFrame | null>;
  /** 「发图片」 is on and the user has not said "别看". */
  imagesOn(): boolean;
  /** The window's latest small picture (JPEG data URL), or null. */
  latestPicture(): string | null;
  /** A fresh clear picture from the camera window (for enrolment), or null. */
  clearPicture(signal: AbortSignal): Promise<string | null>;
  decode(dataUrl: string): FaceFrame | null;
}

export function createFaceFrameSource(ports: FaceFramePorts): FaceFrameSource {
  let lastPicture: string | null = null;
  const safe = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };
  return {
    cameraOn: () => safe(() => ports.poseOn(), false) || safe(() => ports.imagesOn(), false),
    async grab(purpose, signal) {
      if (signal.aborted) return null;
      if (safe(() => ports.poseOn(), false)) {
        const frame = await ports.poseTap().catch(() => null);
        if (frame) return frame;
      }
      if (!safe(() => ports.imagesOn(), false)) return null;
      let picture: string | null = null;
      if (purpose === 'enrol') picture = await ports.clearPicture(signal).catch(() => null);
      if (!picture) {
        const latest = safe(() => ports.latestPicture(), null);
        // A continuous check never looks at the same small picture twice (a new one comes every ~3 s).
        if (latest && (purpose === 'enrol' || latest !== lastPicture)) picture = latest;
      }
      if (!picture || signal.aborted || !safe(() => ports.imagesOn(), false)) return null;
      lastPicture = picture;
      return safe(() => ports.decode(picture!), null);
    },
  };
}

/** The enrolment picture goes to the control window only: the one window that is not the companion; null when there is none. */
export function previewTarget<T>(open: readonly T[], companion: T | null): T | null { return open.find(win => win !== companion) ?? null; }

/**
 * A native bitmap (Electron `nativeImage.toBitmap()`: Skia's N32 order, BGRA on Windows, macOS and Linux desktops) → RGBA.
 */
export function bgraToRgba(bitmap: Uint8Array, width: number, height: number): Uint8Array | null {
  if (bitmap.byteLength !== width * height * 4) return null;
  const out = new Uint8Array(bitmap.byteLength);
  for (let i = 0; i < bitmap.byteLength; i += 4) {
    out[i] = bitmap[i + 2]; out[i + 1] = bitmap[i + 1]; out[i + 2] = bitmap[i]; out[i + 3] = 255;
  }
  return out;
}

/** Target size for a picture of `width`×`height`: fit inside 640×480, never enlarged. */
export function fitFaceFrame(width: number, height: number, maxWidth = 640, maxHeight = 480): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.min(maxWidth, Math.max(16, Math.round(width * scale))), height: Math.min(maxHeight, Math.max(16, Math.round(height * scale))) };
}
