// Which pictures her proactive "look and speak" topic (R10, electron/proactive-vision.ts) may take, as a module of its own so it can be
// tested against the real media switches (I-036 follow-up, docs/claude/2026-11-06-small-gaps.md). No Electron import.
import type { Attachment } from '../shared/contracts';

export interface CameraSwitches { sharesCameraFrames(): boolean; state: { cameraHeld?: boolean; cameraOwner?: string | null } }

/** May a camera frame be taken at all: 「发图片」 on, and not held by a "别看" (then her proactive topics take nothing either). */
export function cameraFrameAllowed(media: CameraSwitches): boolean {
  return media.sharesCameraFrames() && media.state.cameraHeld !== true;
}

export interface ProactiveCaptureDeps {
  screenOn: () => boolean;
  screen: (signal: AbortSignal) => Promise<Attachment | null>;
  media: CameraSwitches;
  /** The window request for the camera (main.ts: captureSharedCamera, which checks cameraFrameAllowed again at the call). */
  camera: (signal: AbortSignal) => Promise<Attachment | null>;
}

export async function captureProactiveFrames(deps: ProactiveCaptureDeps, signal: AbortSignal): Promise<Attachment[]> {
  const frames: Attachment[] = [];
  if (deps.screenOn()) { const frame = await deps.screen(signal); if (frame) frames.push(frame); }
  signal.throwIfAborted();
  if (cameraFrameAllowed(deps.media) && deps.media.state.cameraOwner) {
    const frame = await deps.camera(signal);
    if (frame) frames.push(frame);
  }
  return frames;
}
