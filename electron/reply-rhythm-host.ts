// 说话节奏 (F7) in the host: one pace per accepted reply, frozen from the same mood snapshot as the reply's voice
// (electron/speech-emotion.ts freezeTurnSpeechStyle). It goes to the windows with the reply's id, to the developer panel,
// and as one line of numbers and categories to the experience journal (E2). Nothing here reads or stores a message's text
// beyond its shape at the moment it arrives (shared/reply-rhythm.ts UserPaceTracker), and nothing here touches a prompt.
import type { FatiguePhase } from '../shared/fatigue';
import type { JournalInput } from '../shared/journal';
import type { MoodSnapshot } from '../shared/mood';
import {
  REPLY_RHYTHM_FALLBACK_ENABLED, UserPaceTracker, replyRhythmFor, type ReplyRhythmCue, type ReplyRhythmPacing, type ReplyRhythmView,
} from '../shared/reply-rhythm';

/** A blush this faint no longer reads as shy. */
const SHY_MIN_AMOUNT = 0.05;

export interface ReplyRhythmHostOptions {
  clock?: () => number;
  /** 兜底，待定: whether the bubbles use the pace (default REPLY_RHYTHM_FALLBACK_ENABLED, off). Off, it is only shown in the developer panel. */
  applied?: boolean;
  /** To every window: this reply's pace (id, multiplier, shy only). */
  send?: (pacing: ReplyRhythmPacing) => void;
  /** 体验记录 (E2): one line per reply. The writer drops it while the switch is off. */
  journal?: (input: JournalInput) => void;
  /** The developer panel shows the latest pace (electron/mood.ts republishes in developer mode). */
  changed?: (characterId: string) => void;
}

export interface ReplyRhythmTurn {
  replyId: string;
  characterId: string;
  /** The mood snapshot the reply's voice is frozen from (companion.mood.get().snapshot). */
  snapshot: Pick<MoodSnapshot, 'primary' | 'context' | 'companion' | 'blush' | 'intensity'>;
  fatigue?: FatiguePhase | null;
  /** The user's new message: only its shape is looked at, here and now. */
  userText: string;
  /** Her current read of the user (F2), when she has one. */
  userState?: string | null;
  developerMode: boolean;
}

export class ReplyRhythmHost {
  private latest: { replyId: string; characterId: string; cue: ReplyRhythmCue; at: number } | null = null;
  private voiceTrial = false;
  private readonly pace = new UserPaceTracker();
  private readonly clock: () => number;
  private readonly applied: boolean;
  constructor(private readonly options: ReplyRhythmHostOptions = {}) { this.clock = options.clock ?? Date.now; this.applied = options.applied ?? REPLY_RHYTHM_FALLBACK_ENABLED; }

  /**
   * Once per reply: a second call for the same reply returns the frozen cue unchanged (her mood may have moved since).
   * `input` may be a closure, so reading the mood or the user's state can never throw into the chat (main.ts passes one).
   */
  freeze(input: ReplyRhythmTurn | (() => ReplyRhythmTurn)): ReplyRhythmCue | null {
    let turn: ReplyRhythmTurn;
    try { turn = typeof input === 'function' ? input() : input; } catch { return null; }
    if (!turn || typeof turn.replyId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(turn.replyId)) return null;
    if (this.latest?.replyId === turn.replyId) return this.latest.cue;
    let cue: ReplyRhythmCue;
    try {
      const at = this.clock(), snapshot = turn.snapshot;
      const user = this.pace.note(at, turn.userText, turn.userState);
      cue = replyRhythmFor({
        mood: { primary: snapshot.primary, context: snapshot.context, companion: snapshot.companion },
        fatigue: turn.fatigue ?? null, shy: !!snapshot.blush && snapshot.blush.amount >= SHY_MIN_AMOUNT,
        textIntensity: snapshot.intensity?.text, user, voiceTrial: turn.developerMode && this.voiceTrial,
      });
      this.latest = { replyId: turn.replyId, characterId: turn.characterId, cue, at };
    } catch { return null; }
    // Presentation, journal and panel never disturb the chat. While the fallback is off only the panel sees the pace.
    if (this.applied) try { this.options.send?.({ id: turn.replyId, multiplier: cue.multiplier, shy: cue.shy }); } catch { /* A closed window misses it. */ }
    if (this.applied) try {
      this.options.journal?.({ type: 'reply-rhythm', characterId: turn.characterId, multiplier: cue.multiplier, mood: cue.mood,
        fatigue: cue.fatigue, tendency: cue.tendency, shy: cue.shy, user: cue.user });
    } catch { /* The journal is optional. */ }
    try { this.options.changed?.(turn.characterId); } catch { /* Same. */ }
    return cue;
  }

  /** The frozen cue of `replyId`, if it is the latest reply. */
  cue(replyId: string): ReplyRhythmCue | null { return this.latest?.replyId === replyId ? this.latest.cue : null; }

  /** Developer panel (developer mode only): the latest reply's pace for this character, and the trial switch. */
  view(characterId: string): ReplyRhythmView {
    const latest = this.latest && this.latest.characterId === characterId ? this.latest : null;
    return { cue: latest?.cue ?? null, at: latest?.at ?? null, applied: this.applied, voiceTrial: this.voiceTrial };
  }

  /**
   * Developer listening trial (this run only, never saved): a slow reply's later system-voice sentences start after a short
   * silence. Off by default and outside developer mode; it applies from the next reply.
   */
  setVoiceTrial(on: boolean, developerMode: boolean): boolean {
    this.voiceTrial = developerMode && on === true;
    return this.voiceTrial;
  }
  get voiceTrialOn(): boolean { return this.voiceTrial; }

  /** An approved speech segment of the latest reply, with the trial's silence before every sentence after the first. */
  withGap<T extends { replyId: string; index: number }>(segment: T): T & { pauseBeforeMs?: number } {
    const cue = this.latest?.replyId === segment?.replyId ? this.latest.cue : null;
    return cue && cue.voiceGapMs > 0 && Number.isInteger(segment.index) && segment.index > 0 ? { ...segment, pauseBeforeMs: cue.voiceGapMs } : segment;
  }
}
