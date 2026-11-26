/**
 * 边说边演第 2 步：她以后几轮看到的"自己说过的话"怎么写（方案 docs/claude/2026-11-19-per-reply-choreo-plan.md，任务单第 2 步）。
 *
 * 气泡里删掉的括号动作是有意删的，所以她的历史里永远不出现"（害羞地笑了）"这种写成文字的动作：
 *  - 开关开着：她自己的话原样还给她，标记插回原来的位置（她本来就是这么写的），只演不说的那条就是几个标记；
 *  - 开关关着：普通回复给干净的字；只演不说的那条不进她的历史（null）。
 * 显示历史的地方（聊天页、另一个窗口同步过来的历史、回复全文阅读框）一律先过 speechBeatShownText，标记从不显示。
 * 纯的，不碰时钟。
 */
import { SPEECH_BEAT_CLOSE, SPEECH_BEAT_OPEN, beatGoToOf, beatHowOf, describeBeats, filterSpeechBeats, isSpeechBeatWord } from './choose';
import { goToText } from './go-to';
import type { SpeechBeat } from './interface';

/** 把拍子插回显示的字里（at 是显示的字里的位置）；位置不对、词不在词表里的拍子跳过。 */
export function withSpeechBeatMarkers(text: string, beats: readonly SpeechBeat[]): string {
  const sorted = beats.filter(beat => isSpeechBeatWord(beat.word) && Number.isSafeInteger(beat.at) && beat.at >= 0 && beat.at <= text.length)
    .map((beat, index) => ({ beat, index })).sort((a, b) => a.beat.at - b.beat.at || a.index - b.index).map(item => item.beat);
  let out = '', from = 0;
  // I-175: her "how long" goes back as she wrote it (⟦pout once⟧), so her history matches her own words; I-193: so do go's numbers (⟦go 30% 1.2m⟧).
  for (const beat of sorted) { out += text.slice(from, beat.at) + SPEECH_BEAT_OPEN + beat.word + ((how => how ? ` ${how}` : '')(beatHowOf(beat.word, beat.how))) + goToText(beatGoToOf(beat.word, beat.goTo)) + SPEECH_BEAT_CLOSE; from = beat.at; }
  return out + text.slice(from);
}

/** 这一轮进她历史的字：开关开着带标记，关着是干净的字；关着时只演不说的那条不进历史（null）。 */
export function speechBeatHistoryText(input: { text: string; beats: readonly SpeechBeat[]; performanceOnly: boolean; on: boolean }): string | null {
  if (input.on) return withSpeechBeatMarkers(input.text, input.beats);
  return input.performanceOnly ? null : input.text;
}

/** 历史里的一条她的话，显示前：去掉标记；只演不说的那条显示灰色小字（performed 是那行字，text 为空）。 */
export function speechBeatShownText(content: string): { text: string; performed: string | null } {
  if (typeof content !== 'string' || (!content.includes(SPEECH_BEAT_OPEN) && !/[[【〖]/u.test(content))) return { text: typeof content === 'string' ? content : '', performed: null };
  const summary = filterSpeechBeats(content);
  return summary.performanceOnly ? { text: '', performed: describeBeats(summary.beats) } : { text: summary.text, performed: null };
}
