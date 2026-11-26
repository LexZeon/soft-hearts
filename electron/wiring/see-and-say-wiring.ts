// 感知's wiring, I-166 看到的东西直接影响她说什么. Made by electron/wiring/senses-look-wiring.ts's wireLook (kept in its own file:
// that one is at the 40 KB line).
// - Small frames: the ports LookAttachments reads for a small frame from each sense that is on, every turn (electron/senses/look-attachments.ts;
//   the screen's taken on typing, electron/senses/small-frames.ts; out in full-screen a stale camera frame taken again and shrunk).
// - Her closer look: the LookContinuation around her chat stream (electron/brain/look-continuation.ts); the typed chat turn and the voice
//   host read it through `seeAndSay` (a live binding, re-exported by senses-wiring.ts).
// Privacy: nothing here turns a sense on; `seeing` is the user's own switches with "别看" holding; the journal gets closed values only.
// No module-level side effects: nothing here runs on import.
import type { Attachment } from '../../shared/contracts';
import type { CardLanguage } from '../../shared/foundation/character-card';
import { closerLookNote, SEE_AND_SAY, seeAndSayLine, type CallGlanceMark } from '../../shared/senses';
import { callPastGlancesNote } from '../../shared/brain/call-frame-note';
import { glanceSize } from '../../shared/senses/camera-glance';
import { SmallScreenFrames, freshSmallCamera, type LookAttachments } from '../senses';
import { APP_REPLY_OPENING, FIXED_OPENING_MARKER, LookContinuation, lookStream, type CloserLookEntry, type ContinuableChat } from '../brain';

/**
 * Her closer look (`stream`: her chat stream with it), her one paragraph about what she sees, and the mark that lets a typed turn's small
 * frames stay in her warm process (their own checks: "别看", a switch off, a cleared context drop them); null until wireLook made them.
 */
export interface SeeAndSayPart {
  continuation: LookContinuation;
  line(): string;
  stream(chat: ContinuableChat): ReturnType<typeof lookStream>;
  glanceMark(frames: { glanceOnly(): boolean; glanceStill(): () => boolean }): CallGlanceMark;
}
export let seeAndSay: SeeAndSayPart | null = null;

export interface SeeAndSayDeps {
  /** Which senses give pictures right now: the user's switches, with "别看" holding them. */
  seeing(): { camera: boolean; screen: boolean };
  /** What a kept small screen frame is valid for (opening, revision, vision context); read only while the screen gives pictures. */
  screenKey(): string;
  thumbnail(signal: AbortSignal): Promise<string | null>;
  /** One camera sample from the owner window (null: none). */
  sampleCamera(signal: AbortSignal): Promise<Attachment | null>;
  language(): CardLanguage | null | undefined;
  /** Electron's nativeImage.createFromDataURL (passed in: the node tests' electron stub has no nativeImage). */
  fromDataURL(dataUrl: string): { isEmpty(): boolean; getSize(): { width: number; height: number }; resize(size: { width: number; height: number }): { toJPEG(quality: number): Buffer } };
  journal(entry: { event: 'frames'; camera: boolean; screen: boolean } | ({ event: 'closer' } & CloserLookEntry)): void;
}

/** I-166: a camera sample shrunk to the small frame's size (320×240 at most, JPEG 60, like the window's own small frames); null when unreadable. */
function shrinkCameraFrame(deps: Pick<SeeAndSayDeps, 'fromDataURL'>, dataUrl: string): string | null {
  const image = deps.fromDataURL(dataUrl);
  if (image.isEmpty()) return null;
  const fit = glanceSize(image.getSize().width, image.getSize().height);
  return fit.width ? `data:image/jpeg;base64,${image.resize(fit).toJPEG(60).toString('base64')}` : null;
}

export function wireSeeAndSay(deps: SeeAndSayDeps) {
  const smallScreens = new SmallScreenFrames({ capture: signal => deps.thumbnail(signal), key: () => (deps.seeing().screen ? deps.screenKey() : '') });
  return {
    smallScreens,
    /** The LookAttachments ports of the small frames. */
    lookPorts: {
      seeAndSay: () => SEE_AND_SAY.smallFramesEveryTurn, smallWaitMs: () => SEE_AND_SAY.smallWaitMs,
      smallScreen: (signal: AbortSignal) => (SEE_AND_SAY.screenSmall ? smallScreens.take(signal) : Promise.resolve(null)),
      freshGlance: (signal: AbortSignal) => freshSmallCamera({ sample: deps.sampleCamera, shrink: dataUrl => shrinkCameraFrame(deps, dataUrl) }, signal),
      smallFrames: (senses: { camera: boolean; screen: boolean }) => deps.journal({ event: 'frames', ...senses }),
      keepClearFrames: () => SEE_AND_SAY.keepClearFrames, // I-168: clear frames stay in her warm process like small ones
    },
    /** The user started typing: the screen's small frame is taken now, so the message does not wait for it. */
    typing: () => { if (SEE_AND_SAY.smallFramesEveryTurn && SEE_AND_SAY.screenSmall) smallScreens.prefetch(); },
    /** Once LookAttachments exists: her closer look takes its clear frames through it (LookAttachments.closer checks the switches). */
    finish(look: LookAttachments) {
      // 2026-11-21: the reply's fixed opening marker (electron/brain/reply-opening.ts), so a closer look shows at once and its continuation streams.
      const opening = APP_REPLY_OPENING === 'fixed' ? FIXED_OPENING_MARKER : '';
      const continuation = new LookContinuation({ senses: deps.seeing, capture: (sense, signal, report) => look.closer(sense, signal, report), // report: the journal's miss word and tries (2026-11-22)
        note: (sense, seen, off) => closerLookNote(sense, seen, deps.language(), opening, off === true), journal: entry => deps.journal({ event: 'closer', ...entry }), opening });
      const part: SeeAndSayPart = { continuation, line: () => (SEE_AND_SAY.smallFramesEveryTurn ? seeAndSayLine(deps.seeing(), deps.language()) : ''),
        stream: chat => lookStream(chat, part),
        glanceMark: frames => ({ glanceOnly: () => frames.glanceOnly(), still: () => frames.glanceStill(), past: now => callPastGlancesNote(now, deps.language()) }) };
      seeAndSay = part;
      return seeAndSay;
    },
  };
}
