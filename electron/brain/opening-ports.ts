// The opening choice's ports (split out of electron/brain/opening-host.ts on 2026-11-22 so the host stays under the 40 KB file limit; no change
// in what they say). electron/brain/opening-host.ts re-exports every name, so existing imports keep working.
import type { MoodCue } from '../../shared/foundation/mood';
import type { InnerLoopFocus, InnerLoopQuiet } from '../../shared/initiative';
import type { OpeningCandidateId, OpeningChoiceHost, OpeningNow } from '../../shared/behaviors/opening-choice/interface';
import type { PresenceView } from '../../shared/senses';
import type { MoodTendency } from '../../shared/foundation/mood';
import type { SpeechCueOutcome, SpeechCueReason } from '../../shared/voice';
/** The inner loop surface the opening choice uses (electron/initiative/inner-loop/inner-loop.ts InnerLoop). */
export interface OpeningLoop {
  offerOpportunity(cue: unknown, focus?: InnerLoopFocus): boolean;
  canTake(cue: unknown, focus?: InnerLoopFocus): boolean;
  claims(cueId: unknown): boolean;
  asleep(): boolean;
  silence(cue: unknown): boolean;
  restReminderDue(): boolean;
  quietNow(): InnerLoopQuiet;
}

/** What electron/main.ts supplies for one cue. Each is a plain check on what already exists: no capture, no recording, no model call. */
export interface OpeningClaimants {
  /** Her own memorial invitation (TextMemorials.offerOpportunity): takes the cue when she has one to ask. */
  memorial?(cue: MoodCue): boolean;
  /** R20 (off by default): takes the cue as before, right after the memorial. */
  r20?(cue: MoodCue): boolean;
  /** Look, don't take: the screen chat could take this generic speech cue (its switch and a shared screen or camera are on). */
  vision?(cue: MoodCue): boolean;
  /** Look, don't take: a sound line (一起听's pause point, or 声音理解) could take this source cue. */
  ambient?(cue: MoodCue): boolean;
  /** This source cue went to something else: the pause-point candidate is dropped (nothing was spent there). */
  ambientPassed?(cue: MoodCue): void;
  /**
   * I-136 (electron/mood/touch/brain.ts claims): this speech cue is the one she just asked for to answer a touch (she decided locally). It goes
   * to the inner loop with focus 'touch', before her own candidates and without the interaction-budget roll (she is answering the user).
   */
  touch?(cue: MoodCue): boolean;
  /**
   * I-188 (electron/initiative/moments/host.ts claims): this speech cue is the one a recognised moment just asked for (a late night, something
   * on the screen, a promised reminder, out of a full-screen program, today's first meeting, her goodnight). It goes to the inner loop with
   * focus 'moment'; `budget` rolls the interaction budget first (a promised reminder does not); `put` says how it went. Null: not a moment's cue.
   */
  moment?(cue: MoodCue): { readonly budget: boolean; put(outcome: 'inner' | 'quiet' | 'budget' | 'held'): void } | null;
}

/** I-010 互动余额, as the opening choice uses it (electron/initiative/interaction-budget/host.ts through electron/main.ts). */
export interface OpeningBudget {
  /** How much room she has to speak now (0..1) and one line for the developer "why". */
  room(characterId: string, mood: string): { readonly factor: number; readonly words: string };
  /** She took this cue to speak (`candidate`): spend once per cue id. */
  spend(characterId: string, cueId: string, candidate: Exclude<OpeningCandidateId, 'quiet'>): void;
  /** That cue ended unspoken: give it back (once). */
  refund(characterId: string, cueId: string): void;
}

export interface OpeningHostOptions {
  loop: OpeningLoop;
  /** I-010: omitted, nothing about the budget happens (exactly as before). */
  budget?: OpeningBudget;
  /** The budget's one roll per opportunity (tests inject a seeded random). */
  random?: () => number;
  /** Replaceable as a whole (tests inject a seeded random or the fixed-order fake). */
  chooser?: OpeningChoiceHost;
  /** App setting `innerLoop` and "自动表现": off, there is no small-feeling or invite candidate (#13: no fixed lines either). */
  innerOn(): boolean;
  /** Look, don't take (G1 RpsHost.inviteEligible): an invite to play would be offered now. */
  play?(characterId: string, quiet: boolean): boolean;
  /** I-006: the user is absorbed in something now (UserActivityView.state === 'busy'); she leans toward 这次不说. Omitted: never. */
  busy?(): boolean;
  /** Look, don't take (HerNeedsHost.hasSpeechChance): she has a small need she could speak about now. */
  need?(characterId: string): boolean;
  /**
   * I-050 她的文件夹 (electron/initiative/her-folder/keepsake.ts). Omitted: no keepsake candidate. `peek` looks without taking; `write` starts the
   * quiet writing for this cue; `counts` is one counts-only line for the developer "why".
   */
  keepsake?: {
    peek(characterId: string): 'write' | 'tell' | null;
    write(characterId: string, cue: { readonly id: string; readonly at: number }): boolean;
    counts?(characterId: string): string;
  };
  /**
   * I-086 她也照顾你 (electron/initiative/give/host.ts). Omitted: no "递给你点东西" candidate. `peek` looks without taking: null when she would not
   * offer anything now (today's offers used up, too soon, nothing to hand over), else the reasons read from her hormones and mood
   * values (giveLean) that weigh the candidate. Chosen, the inner loop takes the cue with focus 'give' (her own line, same quota).
   */
  give?: { peek(characterId: string): { readonly leans: readonly { readonly text: string; readonly factor: number }[] } | null };
  /**
   * 松绑 (electron/initiative/impulse/host.ts ImpulseHost.leans): each candidate's factor from her urge (the same hormones and mood values for all),
   * merged with any lean the candidate already has. Omitted or null: exactly as before.
   */
  leans?(characterId: string): OpeningNow['leans'] | null;
  /** A speech cue that ends without anyone speaking returns its hourly and unanswered quota (MoodHost.releaseSpeech; cooldown stays). */
  releaseSpeech(cue: { readonly id: string; readonly at: number }, characterId: string): void;
  /**
   * I-066 你现在方便吗 (shared/behaviors/user-activity/presence.ts through electron/senses/user-activity.ts). Omitted: exactly as before.
   *  - view: the shared judgment; 'no' → she does not speak and no model is called: the intent (a kind, never words) is held;
   *  - look: the judgment wants a screen look (sharing on, unsure): start one in the background;
   *  - characterId: the current character (a held intent of another one is dropped);
   *  - personality: the card's weights, for the greeting chance on return;
   *  - welcome: ask the mood clock for one speech opportunity now (its hourly quota and interval as always; only the boredom threshold
   *    is not waited for). Used once per return from a long absence when nothing is held and the greeting roll says yes.
   */
  presence?: {
    /** null: not known yet (before the app is ready): as before, no gate. */
    view(): PresenceView | null;
    look?(): boolean;
    characterId?(): string;
    personality?(): Partial<Record<MoodTendency, number>> | null;
    welcome?(): boolean;
  };
  /** I-066 体验记录: one closed line per speech cue that did not reach the inner loop, and what became of a held intent. Never any words. */
  journal?(entry: { characterId: string; outcome: SpeechCueOutcome; why: SpeechCueReason }): void;
  developerMode(): boolean;
  /** The developer view changed (a new "why" line). */
  changed?(): void;
  clock?(): number;
}
