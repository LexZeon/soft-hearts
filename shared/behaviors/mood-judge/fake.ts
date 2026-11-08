/**
 * I-027 心情调整员的假 haiku（接口见 interface.ts）。都不调用任何模型：
 *  - neverAsked：一被调用就让测试失败（"默认关 = 一次都不问"、各种安静时段用它）；
 *  - scriptedMoodJudge：按脚本回答，记下每次的提示词（测试和离线试验用）：一个 JSON 原文、多久以后答、一直不答、或者出错。
 */
import type { MoodJudgeAsk } from './interface';

/** 脚本里的一次回答：原文（或者 Error = 调用出错），after 毫秒以后（用 wait 等；默认马上）；null = 一直不答，直到被中止。 */
export interface MoodJudgeScripted { readonly raw: string | Error; readonly after?: number }

const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

/** 一直不答，被中止时以 AbortError 结束。 */
export const hangingMoodJudge: MoodJudgeAsk = (_prompt, _system, signal) => new Promise<string>((_resolve, reject) => {
  if (signal.aborted) reject(aborted()); else signal.addEventListener('abort', () => reject(aborted()), { once: true });
});

/**
 * 按第几次调用找回答：script(第几次, 提示词) → 一次回答，或 null（一直不答）。`wait(ms, signal)` 由测试给（假时钟），不给就马上答。
 * calls 里记每次的提示词和系统提示词（只给测试看）。
 */
export function scriptedMoodJudge(script: (call: number, prompt: string) => MoodJudgeScripted | null,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = async () => {}): MoodJudgeAsk & { calls: { prompt: string; system: string }[] } {
  const calls: { prompt: string; system: string }[] = [];
  const ask = (async (prompt: string, system: string, signal: AbortSignal) => {
    calls.push({ prompt, system });
    const answer = script(calls.length, prompt);
    if (!answer) return hangingMoodJudge(prompt, system, signal);
    await wait(answer.after ?? 0, signal);
    if (signal.aborted) throw aborted();
    if (answer.raw instanceof Error) throw answer.raw;
    return answer.raw;
  }) as MoodJudgeAsk & { calls: { prompt: string; system: string }[] };
  ask.calls = calls;
  return ask;
}

/** 测试用：一被调用就抛错并记下来（证明某条路一次都没问 haiku）。 */
export function neverAsked(): MoodJudgeAsk & { calls: number } {
  const ask = (async (): Promise<string> => { ask.calls++; throw new Error('mood judge must not ask haiku here'); }) as unknown as MoodJudgeAsk & { calls: number };
  ask.calls = 0;
  return ask;
}

/** 一条合规的回答原文（测试用）。 */
export const judgeAnswer = (delta: Record<string, number>, options: { fits?: boolean; why?: string; confidence?: number } = {}): string =>
  JSON.stringify({ delta, fits: options.fits ?? false, why: options.why ?? 'too-little', confidence: options.confidence ?? 0.85 });
