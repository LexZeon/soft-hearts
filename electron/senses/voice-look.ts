import type { Attachment } from '../../shared/foundation/chat';
import { CALL_LOOK, spokenLookText } from '../../shared/senses/call-look';
import type { LookHint } from './look-turns';
import type { LookRequestOptions, TurnFrames } from './look-attachments';

/**
 * I-161 (chose "A 像视频通话"): the frames of one voice or
 * call segment. Before, every segment went out with no picture at all (electron/voice/voice-chat-host.ts `attachments: []`,
 * `imageDataUrls: []`), so with the screen and the camera on she said her side was dark.
 *
 * The typed chat's rules, unchanged, in the typed chat's order (electron/senses/look-attachments.ts):
 *  - the segment's recognized words (shared/senses/call-look.ts spokenLookText) go through the same decision a typed message does
 *    (LookAttachments.request → LookTurns.decide → shared/senses/look-request.ts); a frame is taken only after it said yes;
 *  - every frame taken gets a ticket and goes through the same `admit`; what the segment sends is asked again where Claude's message is
 *    written (the `imageDataUrls` getter): a source turned off, a new opening, a cleared vision context or a "别看" said meanwhile drops it;
 *  - with 「发图片」 on, every segment carries the small camera frame the host already keeps (CALL_LOOK.glanceEveryTurn), unless a "别看"
 *    holds it, exactly as a typed message did before text first.
 *
 * One look per segment, never shared: `drop` (the host calls it when the segment ends, whatever the end) forgets its frames for good, so a
 * superseded, cancelled or finished segment's frame cannot go with another segment or another call.
 */
export interface VoiceLookPorts {
  /** LookAttachments.request: the decision, then the capture (throws when a wanted frame could not be taken). */
  request(hint: LookHint, options: LookRequestOptions): Promise<Attachment[]>;
  /** LookAttachments.admit: the frames' tickets, used up here. */
  admit(attachments: readonly Attachment[]): TurnFrames;
  /** The segment's private line about its pictures (shared/brain/call-frame-note.ts callFrameNote, in her language). */
  note(frames: { screen: boolean; curious: boolean; camera: boolean; glance: boolean; missed: boolean; screenSmall?: boolean }): string;
  /** I-166: her one paragraph about the small frames and her closer look, read with the note ('' while no sense gives pictures). */
  seeAndSay?(): string;
  /** I-161 A: the line for a call process that already holds earlier small frames (shared/brain/call-frame-note.ts callPastGlancesNote). */
  past?(now: boolean): string;
  /** I-161 item 5: ms from the segment's words to its frames being ready, only for a segment that asked for a clear frame (else null). */
  looked?(ms: number | null): void;
  now?(): number;
  /** Tests only: the 「发图片」 frame on every segment, instead of CALL_LOOK.glanceEveryTurn. */
  glanceEveryTurn?: boolean;
}

/** One segment's look, started at once; the host awaits `ready` before it writes the segment for Claude. */
export interface VoiceLegLook {
  /** Settles when the decision and any capture are done (never rejects). */
  readonly ready: Promise<void>;
  /** The frames this segment may send right now (asked again on every read). */
  dataUrls(): string[];
  /** Its private line, for the frames it may send right now ('' for none). */
  note(): string;
  /** ms from the words to the frames (a segment that asked for a clear frame), else null; null until ready. */
  readonly lookMs: number | null;
  /** The segment ended: its frames are forgotten for good. */
  drop(): void;
  /** I-161 A: every frame it may send now is a small 「发图片」 frame (electron/brain/call-glances.ts CallGlanceMark). */
  glanceOnly(): boolean;
  /** I-161 A: a check that those small frames may still be seen; it outlives drop() and holds no picture. */
  glanceStill(): () => boolean;
  /** I-161 A: the line for a process that already holds earlier small frames ('' without the port). */
  pastNote(now: boolean): string;
  /** The senses the phrase rules already asked a clear frame of (known at once): the semantic look (sense router) leaves them out. */
  covered(): ('screen' | 'camera')[];
}

export function voiceLegLook(ports: VoiceLookPorts, text: string): VoiceLegLook {
  const now = ports.now ?? (() => performance.now());
  const started = now();
  let frames: TurnFrames | null = null, taken: Attachment[] = [], dropped = false, lookMs: number | null = null;
  let wanted = { screen: false, camera: false };
  const ready = (async () => {
    try {
      taken = await ports.request({ text: spokenLookText(text) }, { glanceEveryTurn: ports.glanceEveryTurn ?? CALL_LOOK.glanceEveryTurn, decided: value => { wanted = value; } });
      frames = ports.admit(taken); // the tickets are used up even when the segment already ended
      if (dropped) frames = null;
    } catch { frames = null; /* nothing taken, or nothing kept: the segment goes as text (its line says so when it asked) */ }
    if (wanted.screen || wanted.camera) lookMs = Math.max(0, Math.round(now() - started));
    try { ports.looked?.(lookMs); } catch { /* timing only */ }
  })();
  // What may go is what `admit` still lets through right now, never the frames as they came back from the capture (`taken`).
  const current = (): Attachment[] => (dropped || !frames ? [] : frames.current());
  return {
    ready,
    dataUrls: () => current().map(frame => frame.dataUrl),
    note: () => {
      if (dropped) return '';
      const left = current();
      const screen = left.some(frame => frame.source === 'screen');
      const camera = !!frames && frames.cameraVia() !== null, glance = !!frames && frames.cameraGlance();
      const missed = (wanted.screen && !screen) || (wanted.camera && !camera);
      const screenSmall = screen && !!frames && frames.screenGlance();
      let line = '';
      try { line = ports.note({ screen, curious: screen && frames?.screenVia() === 'curious', camera, glance, missed, screenSmall }); } catch { line = ''; }
      try { line += ports.seeAndSay?.() ?? ''; } catch { /* the paragraph is optional */ }
      return line;
    },
    get lookMs() { return lookMs; },
    drop: () => { dropped = true; frames = null; taken = []; },
    glanceOnly: () => !dropped && !!frames && frames.glanceOnly(),
    glanceStill: () => (dropped || !frames ? () => false : frames.glanceStill()),
    pastNote: now => { try { return ports.past?.(now) ?? ''; } catch { return ''; } },
    covered: () => [...(wanted.screen ? ['screen' as const] : []), ...(wanted.camera ? ['camera' as const] : [])],
  };
}
