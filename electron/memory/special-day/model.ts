import os from 'node:os';
import { streamClaude, type ClaudeTask, type ClaudeUsage } from '../../brain';
import type { SpecialKind } from '../../../shared/memory/special-day';
import type { CardLanguage } from '../../../shared/foundation/character-card';
import { HER_VOICE_FORMAT_LINE, SPECIAL_DAY_LABELS_RELAXED, proactiveContextText, specialDaySituationRelaxed } from '../../../shared/brain';
import { herVoiceRelaxed, herVoiceSystem } from '../../../shared/voice';

/**
 * I-059, brain interface (docs/claude/brain-interface.md): the one short line she writes for the user's special day when the user has not
 * talked to her yet. One tool-less call with the chat model setting ('' = Opus: I-222), its own system prompt, no session and
 * no history. The persona and mood come in as plain text; the answer is one short line (cleaned in shared/memory/special-day.ts cleanSpokenLine).
 */
export type SpecialLineStream = (task: ClaudeTask, signal: AbortSignal, emit: (type: string, text: string) => void) => Promise<ClaudeUsage | null>;
const MAX_TEXT = 2_000;

export const SPECIAL_DAY_SYSTEM_PROMPT = '你在扮演下面这个角色，现在要主动对用户说一句话。只输出这一句话本身：一行，不加引号、标签、说明或表情代码，30个字以内。用角色自己的口气，不要套话，不要说“记录”“提醒”“系统”。';

/** I-071: the same instruction for a character who speaks English (the line she writes is then English). */
export const SPECIAL_DAY_SYSTEM_PROMPT_EN = 'You are playing the character below, and you are about to say one thing to the user on your own. Output only that one line: a single line, no quotation marks, labels, explanations or emoji codes, at most 15 words. Speak in the character\'s own voice, no stock phrases, and do not say "record", "reminder" or "system".';

/** I-178: `chat` is the recent-chat block (shared/foundation/proactive-context.ts, '' when none); the spoken-words-only sentence is always added. */
export function specialLinePrompt(input: { persona: string; moodWords: string; kind: SpecialKind; language?: CardLanguage; relaxed?: boolean; chat?: string }): string {
  return `${specialLineBody(input)}\n\n${proactiveContextText(input.chat, input.language)}`;
}

function specialLineBody(input: { persona: string; moodWords: string; kind: SpecialKind; language?: CardLanguage; relaxed?: boolean }): string {
  if (input.relaxed === true) { // I-139 her-voice: her situation, "这个人"
    const en = input.language === 'en', labels = SPECIAL_DAY_LABELS_RELAXED[en ? 'en' : 'zh'], gap = en ? ' ' : '';
    return `${labels.persona}\n${input.persona}\n\n${labels.mood}${gap}${input.moodWords}\n\n${labels.situation}${gap}${specialDaySituationRelaxed(input.kind, en ? 'en' : null)}`;
  }
  if (input.language === 'en') {
    const dayEn = input.kind === 'birthday' ? "Today is the user's birthday (they told you themselves)" : 'Today is your anniversary (the user told you about it)';
    return `[Character]\n${input.persona}\n\n[Mood right now] ${input.moodWords}\n\n[Situation] ${dayEn}. The user has not come to talk to you yet, and you feel like speaking first. It can be a wish, a small kind word, or just a light mention; you decide by your own personality.`;
  }
  const day = input.kind === 'birthday' ? '今天是用户的生日（用户自己告诉过你）' : '今天是你们的纪念日（用户告诉过你）';
  return `【角色】\n${input.persona}\n\n【此刻的心情】${input.moodWords}\n\n【情况】${day}。用户还没来找你说过话，你想先开口说一句。可以是祝福、一句小小的心意，也可以只是轻轻提一下，由你按自己的性格定。`;
}

export async function specialLineWithClaude(prompt: string, model: string, signal: AbortSignal, stream: SpecialLineStream = streamClaude, language: CardLanguage = 'zh-CN'): Promise<string> {
  let text = '', overflow = false;
  await stream({ kind: 'chat', model, workingDirectory: os.tmpdir(), writable: false, prompt, imageDataUrls: [], systemPrompt: herVoiceRelaxed() ? herVoiceSystem(HER_VOICE_FORMAT_LINE, language === 'en' ? 'en' : null)
      : language === 'en' ? SPECIAL_DAY_SYSTEM_PROMPT_EN : SPECIAL_DAY_SYSTEM_PROMPT }, signal, (type, value) => {
    if (type !== 'delta' || overflow) return;
    if (text.length + value.length > MAX_TEXT) { overflow = true; return; }
    text += value;
  });
  return overflow ? '' : text;
}
