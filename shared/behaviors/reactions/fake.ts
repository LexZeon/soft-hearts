/**
 * I-037 的假 haiku：按脚本回答，数调用次数，记下每次的提示词。守约测试（tests/i037-reactions.test.ts）和别的测试用它代替真 haiku。
 * `script` 可以是固定的原文、一个按提示词算答案的函数，或者抛错 / 永不回答（测失败和超时）。
 */
import type { ReactionAsk } from './interface';

export type FakeReactionScript = string | ((prompt: string, system: string) => string | Promise<string>) | { readonly fail: true } | { readonly hang: true };

export class FakeReactionJudge {
  calls = 0;
  readonly prompts: string[] = [];
  readonly systems: string[] = [];
  constructor(public script: FakeReactionScript) {}
  readonly ask: ReactionAsk = async (prompt, system, signal) => {
    this.calls++;
    this.prompts.push(prompt);
    this.systems.push(system);
    const script = this.script;
    if (typeof script === 'string') return script;
    if (typeof script === 'function') return script(prompt, system);
    if ('fail' in script) throw new Error('fake haiku failed');
    return new Promise<string>((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  };
}

/** A script that picks the first candidate of `event` from the prompt (the line "event（…）：id label score、…"). */
export function pickFirstOf(event: string, level = 'mid', delta: Record<string, number> = { O: 2 }): (prompt: string) => string {
  return prompt => {
    const line = prompt.split('\n').find(item => item.startsWith(`${event}（`)) ?? '';
    const first = /：([a-z][a-z0-9-]*) /u.exec(line)?.[1];
    return JSON.stringify({ event, reactions: first ? [{ id: first, level }] : [], delta, confidence: 0.9 });
  };
}
