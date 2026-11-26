import { lookTurnRow, type FrameVia, type LookTurnRow, type WatchSight } from '../../shared/brain/text-first';

/** What electron/main.ts knows about one chat turn when it writes her perception line (I-085 第 3 步, text first). */
export interface TextFirstTurnInput {
  /** Text first is on (electron/senses/look-attachments.ts LookAttachments.textFirst). Off: nothing changes (no text lines, no row). */
  textFirst: boolean;
  /** 和她一起看 is on (LookAttachments.watching). */
  watching: boolean;
  /** A "别看" holds the screen (electron/senses/look-turns.ts refusedIn). */
  screenHeld: boolean;
  /** The newest screen description (electron/senses/watch-notes/session.ts sight); null: none. */
  sight: WatchSight | null;
  now: number;
  /** The turn's frames as they are now (electron/senses/look-attachments.ts TurnFrames). */
  frames: { screenVia(): FrameVia | null; cameraVia(): FrameVia | null };
  /** 「发图片」 is on (electron/senses/media-runtime.ts sharesCameraFrames) and whether a "别看" holds it. */
  cameraOn: boolean;
  cameraHeld: boolean;
  /** Her own recent look's line for this turn (electron/initiative/self-look/wiring.ts hint): '' when none goes. */
  selfSeen: string;
}

export interface TextFirstTurn {
  /** Passed on to shared/brain/perception-rule.ts perceptionTurnState. */
  glance: { watch?: { ageMs: number | null }; screenCurious?: boolean; recentLook?: boolean };
  /** The experience journal's row (type 'look-turn'), or null: neither sense on, or text first off. */
  row: LookTurnRow | null;
}

/**
 * I-085 第 3 步: the text she has instead of a picture on this turn, and the journal's row. Pure (no clock, no app state): main.ts reads
 * everything once and passes it in. A "别看" on the screen gives no watch line; on the camera her own look's line was already withheld
 * (electron/initiative/self-look/host.ts), and the perception line says why (CAMERA_HELD_LINE).
 */
export function textFirstTurn(input: TextFirstTurnInput): TextFirstTurn {
  if (!input.textFirst) return { glance: {}, row: null };
  const screenVia = input.frames.screenVia(), cameraVia = input.frames.cameraVia();
  const watchOn = input.watching && !input.screenHeld;
  const glance: TextFirstTurn['glance'] = {};
  if (watchOn && !screenVia) glance.watch = { ageMs: input.sight ? Math.max(0, input.now - input.sight.at) : null };
  if (screenVia === 'curious') glance.screenCurious = true;
  if (input.cameraOn && !input.cameraHeld && !cameraVia) glance.recentLook = input.selfSeen !== '';
  const row = lookTurnRow({
    watching: input.watching, screenHeld: input.screenHeld, screenFrame: screenVia, watchText: watchOn && !screenVia && input.sight !== null && input.sight.clear,
    cameraOn: input.cameraOn, cameraHeld: input.cameraHeld, cameraFrame: cameraVia, selfText: input.selfSeen !== '',
  });
  return { glance, row };
}
