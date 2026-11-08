/**
 * F7 停停说说的假 haiku（接口见 interface.ts）。都不调用任何模型：
 *  - hangingPauseTalk：一直不答，直到被中止（= 没有 haiku，气泡照 R27 原来的公式出）；
 *  - scriptedPauseTalk：按脚本回答，记下每次的提示词（测试和离线试验用）：一个原文、多久以后答、一直不答、或者出错；
 *  - neverAskedPauseTalk：一被调用就记一次并出错（证明某条路一次都没问 haiku）。
 */
import type { PauseTalkAsk, PauseTalkPlan } from './interface';

const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

/** 一直不答，被中止时以 AbortError 结束。 */
export const hangingPauseTalk: PauseTalkAsk = (_prompt, _system, signal) => new Promise<string>((_resolve, reject) => {
  if (signal.aborted) reject(aborted()); else signal.addEventListener('abort', () => reject(aborted()), { once: true });
});

/** 脚本里的一次回答：原文（或者 Error = 调用出错），after 毫秒以后（用 wait 等；默认马上）；null = 一直不答。 */
export interface PauseTalkScripted { readonly raw: string | Error; readonly after?: number }

/**
 * 按第几次调用找回答：script(第几次, 提示词) → 一次回答，或 null（一直不答）。`wait(ms, signal)` 由测试给（假时钟），不给就马上答。
 * calls 里记每次的提示词和系统提示词（只给测试看）。
 */
export function scriptedPauseTalk(script: (call: number, prompt: string) => PauseTalkScripted | null,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = async () => {}): PauseTalkAsk & { calls: { prompt: string; system: string }[] } {
  const calls: { prompt: string; system: string }[] = [];
  const ask = (async (prompt: string, system: string, signal: AbortSignal) => {
    calls.push({ prompt, system });
    const answer = script(calls.length, prompt);
    if (!answer) return hangingPauseTalk(prompt, system, signal);
    await wait(answer.after ?? 0, signal);
    if (signal.aborted) throw aborted();
    if (answer.raw instanceof Error) throw answer.raw;
    return answer.raw;
  }) as PauseTalkAsk & { calls: { prompt: string; system: string }[] };
  ask.calls = calls;
  return ask;
}

/** 测试用：一被调用就记一次并出错。 */
export function neverAskedPauseTalk(): PauseTalkAsk & { calls: number } {
  const ask = (async (): Promise<string> => { ask.calls++; throw new Error('pause-talk must not ask haiku here'); }) as unknown as PauseTalkAsk & { calls: number };
  ask.calls = 0;
  return ask;
}

/** 一条合规的回答原文（测试用）。 */
export const pauseTalkAnswer = (plan: PauseTalkPlan): string => JSON.stringify({ pauses: plan.pauses, wait: plan.wait });
