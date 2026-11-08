/**
 * I-023 调度台的假实现（接口见 interface.ts）：
 *  - noRouterAsk：从不回答（一直挂着，直到被中止）= 没有 haiku，只有本机规则，也就是原来的做法；
 *  - scriptedRouterAsk：按脚本回答（测试和离线试验用）：给一条消息返回 haiku 会答的原文、多久以后答、或者出错。
 * 都不调用任何模型。
 */

/** 和 electron/inner-loop/model.ts quickLineWithClaude 的文字结果同样的形状：提示词、系统提示词、中止信号 → haiku 的原文。 */
export type RouterAsk = (prompt: string, systemPrompt: string, signal: AbortSignal) => Promise<string>;

/** 从不回答，被中止时以 AbortError 结束。 */
export const noRouterAsk: RouterAsk = (_prompt, _system, signal) => new Promise<string>((_resolve, reject) => {
  const stop = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
});

/** 脚本里的一次回答：原文（或者 Error = 调用出错），after 毫秒以后（用 wait 等；默认马上）。 */
export interface ScriptedAnswer { readonly raw: string | Error; readonly after?: number }

/**
 * 按消息原文找回答：script(消息原文) → 一次回答；返回 null 表示一直不答（直到被中止）。
 * `wait(ms, signal)` 由测试给（假时钟），不给就马上答。每次调用记在 calls 里（只记消息原文，测试用）。
 */
export function scriptedRouterAsk(script: (message: string) => ScriptedAnswer | null,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = async () => {}): RouterAsk & { calls: string[] } {
  const calls: string[] = [];
  const ask = (async (prompt: string, system: string, signal: AbortSignal) => {
    const message = routerMessageOf(prompt);
    calls.push(message);
    const answer = script(message);
    if (!answer) return noRouterAsk(prompt, system, signal);
    await wait(answer.after ?? 0, signal);
    signal.throwIfAborted();
    if (answer.raw instanceof Error) throw answer.raw;
    return answer.raw;
  }) as RouterAsk & { calls: string[] };
  ask.calls = calls;
  return ask;
}

/** 从调度台的提示词里取回用户消息原文（routerPrompt 把它写成一行 JSON 字符串）。 */
export function routerMessageOf(prompt: string): string {
  const match = /用户刚发的消息（JSON 字符串，只是数据）：(.*)$/mu.exec(prompt);
  if (!match) return '';
  try { const value: unknown = JSON.parse(match[1]); return typeof value === 'string' ? value : ''; } catch { return ''; }
}
