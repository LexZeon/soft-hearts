// I-139 A2: the small seams her own-voice one-off calls share (docs/claude/2026-11-15-i139-her-voice.md). Pure.
// The switch is read at the app edge (the model/adapter modules and the writers) with herVoiceRelaxed(); the prompt builders themselves take
// an explicit `relaxed` flag so tests and tools can call both versions.
import { getPromptSwitches } from '../brain/prompt-switches';
import { HER_VOICE_FORMAT_JSON, HER_VOICE_OPENING, HER_VOICE_TECH, i139Text, type I139Language } from '../foundation/i139-texts';

/** I-139 is on (electron/main.ts has already ANDed the switch with speak-only when it set it). */
export function herVoiceRelaxed(): boolean { return getPromptSwitches().relaxed === true; }

/**
 * The system prompt of an own-voice one-off call under the switch: who she is and that this is her own life, the technical half
 * (no tools, format only, the "用户" bridge), then the call's own format sentence. Her situation comes with the message.
 */
export function herVoiceSystem(format: { zh: string; en: string }, language?: I139Language | null): string {
  const glue = language === 'en' ? ' ' : '';
  return [HER_VOICE_OPENING, HER_VOICE_TECH, format].map(text => i139Text(text, language)).join(glue);
}

/**
 * The system prompt of the ambient comment and the listening line (both answer {"comment": …}) as a task patch: `{}` while the switch is
 * off (the call then keeps the chat's default system prompt, as before), `{ systemPrompt }` under it. electron/main.ts spreads it.
 */
export function ambientCallSystem(): { systemPrompt?: string } {
  return herVoiceRelaxed() ? { systemPrompt: herVoiceSystem(HER_VOICE_FORMAT_JSON) } : {};
}

/** Replaces the word the stored records use for this person in an existing rule line (used where one rule line is reused, not rewritten). */
export function thisPerson(text: string): string { return text.replaceAll('用户', '这个人'); }
