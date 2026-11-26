import type { Attachment } from '../../../shared/foundation/chat';
import type { MoodView } from '../../../shared/mood';
import type { SelfLookMoment, SelfLookMoodInput, SelfLookTag } from '../../../shared/initiative/self-look';
import { TEXT_FIRST_KNOBS } from '../../../shared/brain';
import { chatSelfLookWanted } from '../../../shared/senses/see-and-say/words';
import { senseAskWithClaude } from '../../senses/sense-router/model';
import { SelfLookHost, type SelfLookCamera, type SelfLookPorts, type SelfLookRow } from './host';

/** What electron/main.ts supplies: closures read only when needed. */
export interface SelfLookWiring {
  /** AppSettings.selfLook (absent: on). */
  enabled(): boolean;
  /** 「发图片」 on with its window (electron/senses/media-runtime.ts sharesCameraFrames) and whether a "别看" holds it (cameraHeld). */
  camera(): { frames: boolean; held: boolean };
  characterId(): string | null;
  conversationId(): string | null;
  mood(): MoodView | null;
  present(): boolean;
  typing(): boolean;
  idleSeconds(): number | null;
  capture(signal: AbortSignal): Promise<string | null>;
  journal?(row: SelfLookRow): void;
  /** Step 4a: she really looked; light the little eye mark in the companion window (no content goes with it). */
  eye?(): void;
  /** Step 4b: one mood moment from the look's closed tag (companion.mood.moments.note). */
  moment?(kind: SelfLookMoment): void;
  /** I-089 item 5: the look's closed tag, for the day's read of the user. */
  tag?(tag: SelfLookTag | null): void;
  /** Tests only. */
  ports?: Partial<SelfLookPorts>;
}

/** Her mood as the want reads it: the five channels, the card's baseline and evidence, B, M and fatigue. */
export function selfLookMood(view: MoodView | null): SelfLookMoodInput | null {
  if (!view?.snapshot || !view.parameters) return null;
  const fatigue = view.fatigue;
  return {
    values: view.snapshot.values, baseline: view.parameters.baseline, evidence: view.parameters.evidence?.level,
    boredom: view.snapshot.boredom, longing: view.snapshot.longing,
    fatigue: fatigue ? { F: fatigue.F, phase: fatigue.phase, sleeping: fatigue.sleeping } : null,
  };
}

/** The camera as the host reads it: on, held by a "别看", or off (「姿势识别」 alone is off: it never gives chat a picture). */
export function selfLookCamera(state: { frames: boolean; held: boolean }): SelfLookCamera {
  return state.frames !== true ? 'off' : state.held === true ? 'held' : 'on';
}

/** Whether the turn carries a clear camera picture (asked for), not only 「发图片」's small one. */
export function carriesClearCamera(attachments: readonly Attachment[] | undefined, glance: boolean): boolean {
  return !glance && (attachments ?? []).some(item => item.source === 'camera');
}

/**
 * I-085 第 1 步 for the app: the host on a minute clock and its brain call (one haiku call with one picture, the same as I-040's
 * look: electron/senses/sense-router/model.ts senseAskWithClaude, over stdin, nothing on disk).
 */
export function createSelfLook(wiring: SelfLookWiring) {
  const scope = (): string => { try { const id = wiring.characterId(); return id ? `${id}|${wiring.conversationId() ?? ''}` : ''; } catch { return ''; } };
  const host = new SelfLookHost({
    enabled: wiring.enabled,
    camera: () => selfLookCamera(wiring.camera()),
    scope,
    mood: () => selfLookMood(wiring.mood()),
    present: wiring.present,
    typing: wiring.typing,
    lastInteractionAt: () => { const at = wiring.mood()?.snapshot?.lastInteractionAt; return typeof at === 'number' && Number.isFinite(at) ? at : null; },
    idleSeconds: wiring.idleSeconds,
    capture: wiring.capture,
    ask: (prompt, systemPrompt, images, signal) => senseAskWithClaude(prompt, systemPrompt, images, signal),
    journal: wiring.journal,
    eye: wiring.eye,
    moment: wiring.moment,
    tag: wiring.tag,
    // Numbers and closed names only: never the line or anything seen.
    log: entry => { if (entry.result) try { console.info('[soft hearts] self look', JSON.stringify(entry)); } catch { /* Best effort. */ } },
    ...wiring.ports,
  });
  return {
    host,
    start: () => host.start(),
    /**
     * '' or "\n\n" + her one line. Never throws into her chat. Text first (I-085 第 3 步, TEXT_FIRST_KNOBS.enabled): with every
     * message while it is fresh; off: once, as in step 1.
     */
    hint: (text: unknown, attachments: readonly Attachment[] | undefined, glance: boolean, repeat: boolean = TEXT_FIRST_KNOBS.enabled === true): string => {
      try { return host.hint(text, carriesClearCamera(attachments, glance), repeat); } catch { return ''; }
    },
    /**
     * I-085 第 5 节: the user just sent her a message (electron/main.ts, right after `hint` for this very turn): maybe one look in the
     * background for her next turn. Only with text first on: without it every message carries 「发图片」's small picture already. Never
     * waits, never throws.
     */
    afterMessage: (text: unknown, attachments: readonly Attachment[] | undefined, glance: boolean, textFirst: boolean = TEXT_FIRST_KNOBS.enabled === true): boolean => {
      // I-166: a turn that already carried a small camera frame needs no second look (shared/senses/see-and-say/words.ts chatSelfLookWanted).
      try { return chatSelfLookWanted(textFirst, glance) && host.afterMessage(text, carriesClearCamera(attachments, glance)); } catch { return false; }
    },
    /** Step 2 (electron/initiative/impulse/host.ts lookFirst): one look before she speaks first; resolves when it is done or late. Never throws. */
    beforeSpeaking: (): Promise<boolean> => host.beforeSpeaking().catch(() => false),
    /** Step 2: the fresh line as the proactive line's context ('' when none). */
    openingLine: (): string => { try { return host.openingLine(); } catch { return ''; } },
    mediaChanged: () => { try { host.mediaChanged(); } catch { /* Best effort. */ } },
    cancel: () => { try { host.cancel(); } catch { /* Best effort. */ } },
    dispose: () => host.dispose(),
  };
}
