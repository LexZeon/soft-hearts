/**
 * #5 的假实现：守约测试（tests/reply-linger.test.ts）拿它和真实现跑同一组约定；以后接新实现，先拿它对一遍。
 * 不看字、不看心情：每次都留同样久（夹进旋钮的 range），并记下被问了什么。
 */
import type { ReplyLingerBubble, ReplyLingerHost, ReplyLingerMood, ReplyLingerWhy } from './interface';
import { safeLingerMs } from './perform';

export class FakeReplyLingerHost implements ReplyLingerHost {
  readonly asked: { characterId: string; bubble: ReplyLingerBubble; mood: ReplyLingerMood | null }[] = [];
  private readonly log: (ReplyLingerWhy & { characterId: string })[] = [];
  constructor(private readonly ms = 5000, private readonly clock: () => number = Date.now) {}

  decide(characterId: string, bubble: ReplyLingerBubble, mood: ReplyLingerMood | null): number {
    this.asked.push({ characterId, bubble, mood });
    const ms = safeLingerMs(this.ms);
    if (characterId) this.log.unshift({ characterId, at: this.clock(), ms, why: ['假实现：固定时长'] });
    return ms;
  }

  recent(characterId: string): readonly ReplyLingerWhy[] {
    return this.log.filter(entry => entry.characterId === characterId).slice(0, 8).map(({ characterId: _, ...entry }) => ({ ...entry, why: [...entry.why] }));
  }
}
