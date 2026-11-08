/**
 * 每轮的自我感知补充（docs/claude/2026-11-07-turn-awareness.md，真实聊天分析第二批 6、7、10）。
 * 都是跟在这一轮【此刻的感知】后面的短句，纯函数、不调用模型、不开任何感知：
 *  - 困意：每一轮都照实说她现在的阶段，包括"清醒"（以前只有不清醒的阶段才进心情说明，而且心情说明本身有时整段不带）；
 *  - 上一句没读出来：朗读出错或桌宠窗口没显示时，下一轮说一次；
 *  - 用户问一首歌或一个视频、而她既没开"和她一起听"也没开屏幕共享：照实说听不到看不到，告诉用户去哪里打开。
 * 只有诚实和隐私（不说没感知到的事、不替用户开感知）写死；句子很短，只是事实，说不说、怎么说由她决定。
 */
import type { FatiguePhase } from './fatigue';

/** 她自己的说法（不是模型内部的阶段名）。 */
export const FATIGUE_WORDS: Readonly<Record<FatiguePhase, string>> = {
  awake: '清醒', 'light-drowsy': '有点困', drowsy: '很困', 'falling-asleep': '快睡着了', asleep: '睡着了（被叫醒）', 'micro-awake': '半梦半醒',
};
const isPhase = (value: unknown): value is FatiguePhase => typeof value === 'string' && Object.prototype.hasOwnProperty.call(FATIGUE_WORDS, value);

/** 这一轮她困不困，一句话；阶段不明时不说（不猜）。 */
export function fatigueTurnLine(phase: unknown): string {
  if (!isPhase(phase)) return '';
  return phase === 'awake'
    ? '你现在的困意：清醒。你不困，别说自己困或想睡。'
    : `你现在的困意：${FATIGUE_WORDS[phase]}。这是真的，措辞和节奏可以自然带一点，也可以顺口提一句，但不必每句都说。`;
}

/** 朗读没成功的原因（给她看的话）。被用户停掉、朗读关着都不算没读出来。 */
export type UnreadReason = 'failed' | 'partial' | 'hidden';
const UNREAD_WORDS: Readonly<Record<UnreadReason, string>> = { failed: '朗读出错', partial: '只读出了一部分，朗读中途出错', hidden: '桌宠窗口没显示' };
export function unreadTurnLine(reason: UnreadReason | null | undefined): string {
  return reason && UNREAD_WORDS[reason] ? `上一句没能读出来（原因：${UNREAD_WORDS[reason]}）；和用户有关时可以自然提一句，没关系就不用提。` : '';
}

/** 用户的话在问一首歌或一个视频（"这首歌怎么样""这个视频好看吗""你听听这个""看看这个视频"）。漏判只是这一轮没带那句话。 */
const MEDIA_WORD = '(?:歌|歌曲|曲子|音乐|旋律|bgm|mv|视频|片子|电影|剧|番|直播)';
const POINTING = new RegExp(`(?:这|那|刚才的?|刚刚的?|现在的?)[^，。！？!?\\n]{0,4}${MEDIA_WORD}`, 'iu');
const JUDGING = /怎么样|咋样|如何|好听|好看|喜欢|觉得|评价|感觉|听听|看看|听一下|听一听|看一下|看一眼|听完|看完|品品/u;
const LISTEN_LOOK = new RegExp(`(?:听听|听一下|听一听|看看|看一下|看一眼)[^，。！？!?\\n]{0,6}${MEDIA_WORD}|${MEDIA_WORD}[^，。！？!?\\n]{0,4}(?:听听|看看)`, 'iu');
export function asksAboutSongOrVideo(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const head = text.slice(0, 500);
  return (POINTING.test(head) && JUDGING.test(head)) || LISTEN_LOOK.test(head);
}

/** 「和她一起听」是设置/托盘里的真实名字（shared/listen-together.ts、shared/ui-copy.listen.en.ts）。 */
export const LISTEN_TOGETHER_LABEL = '和她一起听';
export const CANNOT_PERCEIVE_MEDIA_LINE = `用户在问一首歌或一个视频，但你现在听不到也看不到；如实说，告诉用户打开「${LISTEN_TOGETHER_LABEL}」你就能一起听（视频想让你看，要用户开屏幕共享或叫你看）。你不会替用户打开。`;

/**
 * 同一段对话里这句话只带一次（不唠叨）。"一段"= 调用方给的 scope（谈话范围加感知开关的版本，开关一变就是新的一段）；
 * 同一个 scope 里隔了 MEDIA_EXPLAIN_GAP_MS 没再问，再问时当作新的一段（兜底：scope 可以很长）。最近的 32 段。
 */
export const MEDIA_EXPLAIN_GAP_MS = 20 * 60_000;
export class MediaExplainTold {
  private readonly told = new Map<string, number>();
  /** True when this stretch was already told; otherwise remembers it and returns false. */
  repeat(scope: string, now = 0): boolean {
    if (!scope) return false;
    const at = this.told.get(scope);
    this.told.delete(scope); this.told.set(scope, now);
    while (this.told.size > 32) this.told.delete(this.told.keys().next().value!);
    return at !== undefined && now - at < MEDIA_EXPLAIN_GAP_MS;
  }
}

export interface TurnAwarenessInput {
  /** shared/fatigue.ts 的阶段（electron/fatigue-host.ts 的 view().phase）。 */
  phase: unknown;
  /** 上一句没读出来的原因；null = 读了、没开朗读、被用户停掉，或已经说过。 */
  unread: UnreadReason | null;
  /** 用户这一条消息。 */
  text: unknown;
  /** 她现在听得到电脑或麦克风的声音（「和她一起听」或麦克风律动开着）。 */
  listening: boolean;
  /** 屏幕共享开着。 */
  screenSharing: boolean;
  scope: string;
  now?: number;
}

/** 这一轮要补到【此刻的感知】后面的短句，空串 = 没有。 */
export function turnAwarenessText(input: TurnAwarenessInput, told: MediaExplainTold): string {
  const parts = [fatigueTurnLine(input.phase), unreadTurnLine(input.unread)];
  if (!input.listening && !input.screenSharing && asksAboutSongOrVideo(input.text) && !told.repeat(input.scope, input.now ?? 0)) parts.push(CANNOT_PERCEIVE_MEDIA_LINE);
  return parts.filter(Boolean).join('');
}
