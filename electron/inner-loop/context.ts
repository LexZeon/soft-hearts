import { buildInnerLoopPrompt, innerLoopQuiet, type InnerLoopFocus, type InnerLoopQuiet } from '../../shared/inner-loop';
import { DEFAULT_FATIGUE_PARAMETERS, type FatigueParameters, type FatiguePhase } from '../../shared/fatigue';
import type { MoodParameters } from '../../shared/mood';
import { isHerLifeActivity, type HerLifeActivity, type HerLifeSwitchOffer } from '../../shared/her-life';
import { SYSTEM_FATIGUE_CLOCK } from '../fatigue-host';
import type { InnerLoopClaim } from './inner-loop';

/**
 * Host readers for one decision. Optional sources are read only while their own switch is on:
 * the user profile (and the future diary, which follows the profile's consent) and audio reading.
 * There is deliberately no screen or camera reader: the inner loop never captures or sends images.
 */
export interface InnerLoopContextSources {
  now(): number;
  localMinute?(wallMs: number): number;
  /** compileCharacterPersona(current card). */
  persona(): string;
  /** personalizeLanguageContext(...) ('' when none). */
  language(): string;
  /** MoodHost.chatContext(). */
  mood(): string;
  parameters(): MoodParameters;
  lastInteractionAt(): number | null;
  /** CompanionService.userState.innerLoopContext(...): her unfaded read of how the user is now, '' when none. Memory only, not tied to the profile switch. */
  userState?(): string;
  /**
   * HerNeedsHost.speechChance: the one speech chance for a small feeling she has now, '' when there is none. Read (and so used up)
   * only on a speech opportunity that may speak and is not quiet.
   */
  need?(): string;
  /**
   * P1 第二阶段: PoseReactionHost.innerLoopLine (shared/pose-reactions.ts poseInnerLoopLine), '' while local camera sensing is off.
   * Abstract words only (in front of the computer, how long, what the user just did); the inner loop still never gets an image.
   */
  pose?(): string;
  /** F6: "更真实的情绪" on the current card (shared/realer-emotions.ts). Absent or throwing: off. */
  realer?(): boolean;
  /**
   * I-017: what she hears and what her body does to it (electron/her-state-host.ts innerLoopLine), '' while she hears nothing.
   * Only "is it there, what is it"; never a level, a picture or a transcript (that stays the audio reading's own block).
   */
  hearing?(): string;
  /** I-006 第 1 步: the one sentence about whether the user is absorbed (shared/behaviors/user-activity/effects.ts userActivitySentence), '' when unknown. */
  userActivity?(): string;
  /** I-039: how many of her own lines the user has not answered (MoodHost.unansweredSpeech); 0 or absent: nothing is written. */
  unanswered?(): number;
  /** I-017: what she is doing on her own right now (HerLifeHost.view), for the opportunities without a "换件事做" offer. */
  activity?(): { activity: HerLifeActivity; since: number } | null;
  profileEnabled(): boolean;
  /** selectUserProfileContext points as the store's data block; called only when the profile is on. */
  profilePoints(): string;
  /** Reserved for the diary line; called only when the profile is on. */
  diaryPoints?: () => string;
  audioReading(): boolean;
  /** Recent transcript (ambientContextText of ambientStore.context); called only when audio reading is on. */
  ambientText(): string;
}

export function innerLoopLocalMinute(sources: Pick<InnerLoopContextSources, 'localMinute'>, wallMs: number): number {
  return (sources.localMinute ?? SYSTEM_FATIGUE_CLOCK.localMinute)(wallMs);
}

/** Quiet rules from the fatigue view and the night window of the (current) fatigue parameters. */
export function innerLoopQuietAt(phase: FatiguePhase | null | undefined, localMinute: number,
  parameters: Readonly<FatigueParameters> = DEFAULT_FATIGUE_PARAMETERS): InnerLoopQuiet {
  return innerLoopQuiet({ phase: phase ?? null, localMinute, parameters });
}

/**
 * `focus` (I-020 #10): 'play' narrows the call to the invite (no ordinary line, so her small need is not read and stays unspent);
 * 'mood' and 'rest' change nothing here (the invite option is simply not offered for them).
 */
export function innerLoopPrompt(sources: InnerLoopContextSources, claim: Readonly<InnerLoopClaim>, allowSpeech: boolean, quiet: Readonly<InnerLoopQuiet>,
  herLife?: Readonly<HerLifeSwitchOffer> | null, play?: boolean, focus?: InnerLoopFocus): string {
  const now = sources.now(), p = sources.parameters();
  const last = sources.lastInteractionAt();
  const read = (reader: (() => string) | undefined) => { try { return reader?.() ?? ''; } catch { return ''; } };
  const profileOn = (() => { try { return sources.profileEnabled() === true; } catch { return false; } })();
  const audioOn = (() => { try { return sources.audioReading() === true; } catch { return false; } })();
  const realer = (() => { try { return sources.realer?.() === true; } catch { return false; } })();
  const activity = (() => {
    try {
      const view = sources.activity?.();
      return view && isHerLifeActivity(view.activity) && Number.isFinite(view.since) ? { current: view.activity, minutes: Math.max(0, (now - view.since) / 60_000) } : null;
    } catch { return null; }
  })();
  return buildInnerLoopPrompt({
    persona: sources.persona(), language: read(() => sources.language()), mood: read(() => sources.mood()),
    weights: p.weights, intensity: p.intensity,
    localMinute: innerLoopLocalMinute(sources, now),
    minutesSinceInteraction: last === null || !Number.isFinite(last) ? null : Math.max(0, (now - last) / 60_000),
    cue: claim.kind, allowSpeech, quiet: { ...quiet },
    userState: read(sources.userState),
    pose: read(sources.pose),
    hearing: read(sources.hearing),
    userActivity: read(sources.userActivity),
    unanswered: (() => { try { return sources.unanswered?.() ?? 0; } catch { return 0; } })(),
    activity,
    need: claim.kind === 'speech' && allowSpeech && !quiet.quiet && focus !== 'play' ? read(sources.need) : '',
    profile: profileOn ? read(() => sources.profilePoints()) : '',
    diary: profileOn ? read(sources.diaryPoints) : '',
    ambient: audioOn ? read(() => sources.ambientText()) : '',
    herLife: claim.kind === 'motion' && herLife ? { ...herLife, choices: [...herLife.choices] } : null,
    play: claim.kind === 'speech' && play === true,
    ...(claim.kind === 'speech' && play === true && focus === 'play' ? { inviteOnly: true } : {}),
    ...(realer ? { realer: true } : {}),
  });
}
