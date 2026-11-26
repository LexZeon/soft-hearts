// I-098 speak-only (electron/brain/speak-only/rules.ts): the things electron/main.ts hands over. Off (the stable channel, SPEAK_ONLY_STABLE)
// both are empty, so the conversation process keeps its default system prompt and the companion asks no judge.
import { claudeSessionSystemPrompt } from '../claude-session-prompt';
import { SPEAK_ONLY_STABLE } from './rules';
import type { SpeakOnlyAsk, SpeakOnlyJudgeOptions } from './judge-host';
import { speakOnlyRoute, type SpeakOnlyWarmPort } from './route';

/** PersistentClaudeChat's options: on, the fixed system prompt without the settings catalog (D); off, nothing (its default). */
export function speakOnlySessionOptions(on: boolean = SPEAK_ONLY_STABLE): { systemPrompt?: string } {
  return on ? { systemPrompt: claudeSessionSystemPrompt({ settingsCatalog: false }) } : {};
}

/** CompanionService.setSpeakOnly's argument: on, the judge with this call; off, null. */
export function speakOnlyJudgeOptions(ask: SpeakOnlyAsk, on: boolean = SPEAK_ONLY_STABLE): SpeakOnlyJudgeOptions | null {
  return on ? { ask } : null;
}

/**
 * The app's judge (electron/main.ts): the second step on the reactions' warm haiku when it is there, else the one-off call
 * (electron/initiative/inner-loop/model.ts quickLineWithClaude). Off: null.
 */
export function speakOnlyAppJudge(on: boolean, oneShot: (prompt: string, systemPrompt: string, signal: AbortSignal) => Promise<string>,
  warm: () => SpeakOnlyWarmPort | null): SpeakOnlyJudgeOptions | null {
  return speakOnlyJudgeOptions(speakOnlyRoute({ oneShot, warm }), on);
}
