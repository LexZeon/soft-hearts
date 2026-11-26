// The ambient (系统音频) comment's prompt, moved out of electron/senses/ambient-comments.ts so both versions can be tested. `relaxed` is I-139
// (shared/foundation/i139-texts.ts): her situation and the freedom to stay quiet, "这个人"; the external-audio data block (built by the caller,
// with its own injection-defence header) is passed in unchanged.
import { AMBIENT_FORMAT_RELAXED, AMBIENT_SITUATION_RELAXED, i139Text, proactiveContextText, type I139Language } from '../brain';

/**
 * I-178: `context.chat` is the recent-chat block (shared/foundation/proactive-context.ts, '' when none); the spoken-words-only sentence is always
 * there, in `context.language` (kept apart from `language`, which picks the twin of the texts above and was never passed by the caller).
 */
export function ambientCommentPrompt(persona: string, moodText: string, contextText: string, relaxed = false, language?: I139Language | null, context?: { chat?: string; language?: I139Language | null }): string {
  const ctx = proactiveContextText(context?.chat, context?.language);
  if (relaxed) return `${persona}\n${moodText}${contextText}\n${i139Text(AMBIENT_SITUATION_RELAXED, language)}\n${ctx}\n${i139Text(AMBIENT_FORMAT_RELAXED, language)}`;
  return `${persona}\n${moodText}${contextText}
${ctx}
用户开启了背景音频理解；每条材料的来源和音乐/看剧用途以上述字段为准。
当前发言意愿已由应用的同一主动发言冷却和配额允许。按你的性格和现在的感受，决定是否值得说一句相关、克制的评论。
不逐句复述、不当作用户在对你说话、不编造未观察到的画面，不要求用户回答。可以保持安静。
只输出JSON对象 {"comment":"一句最多160字的评论，或空字符串保持安静"}，不添加其他字段或工具调用。`;
}
