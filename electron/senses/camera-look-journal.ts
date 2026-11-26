import { scanLookRequest } from '../../shared/senses/look-request';
import { asksCamera } from '../../shared/senses/look-at-you';
import {
  cameraLookFirst, cameraLookLater, type CameraLookDetail, type CameraLookLine, type CameraLookMiss, type CameraLookVia, type SenseCameraResult,
} from '../../shared/senses/camera-look';

/**
 * I-084: the experience journal's camera line, one per chat turn while 「发图片」 is on (shared/senses/camera-look.ts has the words and the
 * pure decisions). electron/main.ts calls `turn` once per ordinary chat message (after the I-040 router took it) and the router's port
 * calls `sensed` when its turn ends. A turn waiting on the router is kept by id only (a few at most); nothing of the chat is kept.
 */
export interface CameraLookTurnInput {
  /** 「发图片」 is on (electron/senses/media-runtime.ts sharesCameraFrames); off: no line at all. */
  frames: boolean;
  /** The clear camera picture this turn carries and how it was asked for (electron/senses/look-attachments.ts TurnFrames.cameraVia). */
  via: CameraLookVia | null;
  /** Only the small 「发图片」 picture went (TurnFrames.cameraGlance). */
  small: boolean;
  /** 「发图片」 is held by a "别看" now. */
  held: boolean;
  screenSharing: boolean;
  /** 2026-11-21: why the clear picture the words asked for did not come (TurnFrames.cameraMiss; closed words). */
  miss?: CameraLookMiss | null;
  /** The user's words (read here only for whether they asked her to look at the user; never kept). */
  text: unknown;
}

/** Turns waiting on her own look, at most this many (an older one is written as cut short). */
export const CAMERA_LOOK_OPEN_MAX = 8;

export class CameraLookJournal {
  private readonly open = new Map<string, { small: boolean }>();
  constructor(private readonly write: (line: CameraLookLine) => void) {}

  /** `sensed`: the I-040 router took this turn (it reports through `sensed` when the turn ends); false: no look will follow. */
  turn(id: string, input: CameraLookTurnInput, sensed: boolean): void {
    if (!input.frames || typeof id !== 'string' || !id) return;
    const target = input.via || input.held ? null : scanLookRequest(input.text, { appearance: true });
    const asked = asksCamera(target); // 2026-11-21: "this" with the screen on asks for the camera too (look-at-you.ts lookWants)
    const first = cameraLookFirst({ via: input.via, small: input.small, held: input.held, asked, miss: input.miss ?? null });
    if ('line' in first) { this.emit(first.line); return; }
    if (!sensed) { this.emit(cameraLookLater(first.waits.small, 'untaken')); return; }
    this.open.set(id, first.waits);
    for (const [older, waits] of this.open) {
      if (this.open.size <= CAMERA_LOOK_OPEN_MAX) break;
      this.open.delete(older);
      this.emit(cameraLookLater(waits.small, 'cut-short'));
    }
  }

  /** The router's turn `id` ended with this camera result (unknown ids: a turn without 「发图片」, or one already written). */
  sensed(id: string, result: SenseCameraResult, detail: CameraLookDetail = {}): void {
    const waits = this.open.get(id);
    if (!waits) return;
    this.open.delete(id);
    this.emit(cameraLookLater(waits.small, result, detail));
  }

  /** Turns still waiting (tests). */
  get waiting(): number { return this.open.size; }

  private emit(line: CameraLookLine): void {
    try { this.write(line); } catch { /* The journal is best effort; chat is never affected. */ }
  }
}
