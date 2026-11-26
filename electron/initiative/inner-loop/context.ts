import { buildInnerLoopPrompt, innerLoopQuiet, innerLoopTimeOfDay, type InnerLoopFocus, type InnerLoopQuiet } from '../../../shared/initiative/inner-loop';
import { HER_LIFE_TABLE } from '../../../shared/stage';
import { withSpeechLanguage } from '../../../shared/brain';
import type { CardLanguage } from '../../../shared/foundation/character-card';
import { herVoiceRelaxed } from '../../../shared/voice';
import { slipLine, styleLine, topicLine, type SlipKind, type TopicKind } from '../../../shared/behaviors/impulse/expression';
import { DEFAULT_FATIGUE_PARAMETERS, type FatigueParameters, type FatiguePhase } from '../../../shared/mood';
import type { MoodParameters } from '../../../shared/foundation/mood';
import { isHerLifeActivity, type HerLifeActivity, type HerLifeSwitchOffer } from '../../../shared/stage';
import { SYSTEM_FATIGUE_CLOCK } from '../../mood';
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
  /**
   * The active card's language (cardLanguageOf). An English card's prompt ends with the one line that makes everything she says English
   * (shared/brain/chat-language.ts withSpeechLanguage); absent or throwing: Chinese, the prompt as it always was.
   */
  cardLanguage?(): CardLanguage;
  /** MoodHost.chatContext(). */
  mood(): string;
  /** I-178: the last few turns of her current conversation as a data block (electron/brain/proactive-chat.ts), '' when there is none. Absent: none. */
  recentChat?(): string;
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
   * P1 第二阶段: PoseReactionHost.innerLoopLine (shared/mood/pose-reactions.ts poseInnerLoopLine), '' while local camera sensing is off.
   * Abstract words only (in front of the computer, how long, what the user just did); the inner loop still never gets an image.
   */
  pose?(): string;
  /** F6: "更真实的情绪" on the current card (shared/mood/realer-emotions.ts). Absent or throwing: off. */
  realer?(): boolean;
  /**
   * I-017: what she hears and what her body does to it (electron/mood/her-state-host.ts innerLoopLine), '' while she hears nothing.
   * Only "is it there, what is it"; never a level, a picture or a transcript (that stays the audio reading's own block).
   */
  hearing?(): string;
  /** I-006 第 1 步: the one sentence about whether the user is absorbed (shared/behaviors/user-activity/effects.ts userActivitySentence), '' when unknown. */
  userActivity?(): string;
  /** I-085 step 2 (electron/initiative/self-look/host.ts openingLine): the line from the look she took before speaking first, '' when none. */
  look?(): string;
  /** I-039: how many of her own lines the user has not answered (MoodHost.unansweredSpeech); 0 or absent: nothing is written. */
  unanswered?(): number;
  /**
   * I-086: for focus 'give' only, what she is about to hand the user and why, in plain words (electron/initiative/give/host.ts promptLine): never a
   * line of hers, never the user's words. '' or absent: the focus says nothing extra (she may still choose none, look or motion).
   */
  give?(characterId: string): string;
  /**
   * I-136: for focus 'touch' only, what the user did a moment ago and what she showed (electron/mood/touch/brain.ts promptLine), one short
   * sentence of facts. '' or absent: the focus says nothing extra.
   */
  touch?(characterId: string): string;
  /**
   * Unbound step 4: for focus 'touch' too (the same claimant slot), what she noticed the user do while she was out
   * (electron/unbound/history-host.ts promptLine); used only when there is no touch line. '' or absent: nothing extra.
   */
  noticed?(characterId: string): string;
  /** I-188: for focus 'moment' only, what the app noticed (electron/initiative/moments/host.ts promptLine): information, never a reaction. */
  moment?(characterId: string): string;
  /**
   * 松绑 (electron/initiative/impulse/host.ts ImpulseHost.expression): on an opportunity where she may really speak on her own, which real topic
   * to offer among the available ones (or none), a rare small slip, and how her last few own lines opened. Absent: none of these lines.
   */
  expression?(characterId: string, available: readonly TopicKind[]): { topic: TopicKind | null; slip: SlipKind | null; openings: readonly string[] };
  /** 松绑: her mood's recent reason when it was a good or warm moment ('' otherwise; never a let-down). */
  recentEvent?(): string;
  /** P-001 step 3 (ImpulseHost.duePlan): the words of a plan the user told her whose time has come and who she may open with, '' when none. */
  duePlan?(characterId: string): string;
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
  const profile = profileOn ? read(() => sources.profilePoints()) : '', diary = profileOn ? read(sources.diaryPoints) : '';
  const expression = innerLoopExpression(sources, claim, allowSpeech, quiet, focus, { activity, profile, diary, localMinute: innerLoopLocalMinute(sources, now) });
  const language = (() => { try { return sources.cardLanguage?.() ?? 'zh-CN'; } catch { return 'zh-CN'; } })();
  return withSpeechLanguage(buildInnerLoopPrompt({
    ...expression,
    persona: sources.persona(), language: read(() => sources.language()), mood: read(() => sources.mood()),
    weights: p.weights, intensity: p.intensity,
    localMinute: innerLoopLocalMinute(sources, now),
    minutesSinceInteraction: last === null || !Number.isFinite(last) ? null : Math.max(0, (now - last) / 60_000),
    cue: claim.kind, allowSpeech, quiet: { ...quiet },
    userState: read(sources.userState),
    pose: read(sources.pose),
    hearing: read(sources.hearing),
    userActivity: read(sources.userActivity),
    look: claim.kind === 'speech' && allowSpeech ? read(sources.look) : '',
    unanswered: (() => { try { return sources.unanswered?.() ?? 0; } catch { return 0; } })(),
    activity,
    need: claim.kind === 'speech' && allowSpeech && !quiet.quiet && focus !== 'play' && focus !== 'touch' && focus !== 'moment' ? read(sources.need) : '',
    profile, diary,
    ambient: audioOn ? read(() => sources.ambientText()) : '',
    herLife: claim.kind === 'motion' && herLife ? { ...herLife, choices: [...herLife.choices] } : null,
    play: claim.kind === 'speech' && play === true,
    ...(claim.kind === 'speech' && play === true && focus === 'play' ? { inviteOnly: true } : {}),
    ...(realer ? { realer: true } : {}),
    ...(herVoiceRelaxed() ? { relaxed: true } : {}), // I-139
    speechLanguage: language, // I-178
    ...(claim.kind === 'speech' && allowSpeech ? { recentChat: read(sources.recentChat) } : {}), // I-178: what you two talked about lately
    ...(claim.kind === 'speech' && allowSpeech && focus === 'give' ? { give: read(() => sources.give?.(claim.characterId) ?? '') } : {}),
    ...(claim.kind === 'speech' && allowSpeech && focus === 'touch' ? { touch: read(() => sources.touch?.(claim.characterId) ?? '') } : {}),
    ...(claim.kind === 'speech' && allowSpeech && focus === 'touch' && sources.noticed ? { noticed: read(() => sources.noticed?.(claim.characterId) ?? '') } : {}),
    ...(claim.kind === 'speech' && allowSpeech && focus === 'moment' ? { moment: read(() => sources.moment?.(claim.characterId) ?? '') } : {}), // I-188
  }), language);
}

/**
 * 松绑 (shared/behaviors/impulse/expression.ts): the topic, style and slip lines, only where she may really speak on her own (a speech
 * opportunity that may speak, not quiet, and not one narrowed to the invite, the rest reminder, a keepsake or handing something over).
 * A topic is offered only when its real source is in this very prompt (her activity, a warm recent moment, the profile or diary points);
 * the time of day and her own mood are always real.
 */
export function innerLoopExpression(sources: Pick<InnerLoopContextSources, 'expression' | 'recentEvent' | 'duePlan'>, claim: Readonly<InnerLoopClaim>, allowSpeech: boolean,
  quiet: Readonly<InnerLoopQuiet>, focus: InnerLoopFocus | undefined,
  real: { activity: { current: HerLifeActivity; minutes: number } | null; profile: string; diary: string; localMinute: number }): { topic?: string; style?: string; slip?: string } {
  if (!sources.expression || claim.kind !== 'speech' || !allowSpeech || quiet.quiet || quiet.restReminder === true
    || focus === 'play' || focus === 'rest' || focus === 'keepsake' || focus === 'give' || focus === 'touch' || focus === 'moment') return {};
  let event = '';
  try { event = String(sources.recentEvent?.() ?? '').replace(/\s+/g, ' ').trim().slice(0, 40); } catch { event = ''; }
  let plan = '';
  try { plan = String(sources.duePlan?.(claim.characterId) ?? '').replace(/\s+/g, ' ').trim().slice(0, 160); } catch { plan = ''; }
  const doing = real.activity && real.activity.current !== 'company' ? HER_LIFE_TABLE[real.activity.current].chat : '';
  const available: TopicKind[] = [...(doing ? ['doing' as const] : []), ...(event ? ['event' as const] : []),
    ...(real.profile.trim() ? ['you' as const] : []), ...(real.diary.trim() ? ['diary' as const] : []), 'time', 'mood', ...(plan ? ['plan' as const] : [])];
  try {
    const chosen = sources.expression(claim.characterId, available);
    const time = innerLoopTimeOfDay(real.localMinute).split(' ')[0];
    return { topic: topicLine(chosen.topic, { doing, event, time, plan }), style: styleLine(chosen.openings ?? []), slip: slipLine(chosen.slip) };
  } catch { return {}; }
}
