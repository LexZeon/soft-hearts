/**
 * #21 的假实现：卡上的值原样用，每次都一样（= 原来的做法：摸头每 5 秒亲近 +10、舒适 +4，点心期待 +12、舒适 +6，卡上的"腻"）。
 * 守约测试（tests/touch-feed-effect.test.ts）拿它和真实现跑同一组约定；别的测试要固定的心情算术时也用它。以后接新实现，先拿它对一遍。
 */
import type { TouchFeedEffect, TouchFeedEffectHost, TouchFeedEvent, TouchFeedFreshness, TouchFeedNow, TouchFeedWhy } from './interface';
import type { TouchFeedKind } from './knobs';

export class FixedTouchFeedEffect implements TouchFeedEffectHost {
  private readonly sessions = new Map<string, TouchFeedWhy & { sessionId: string }>();
  /** How many interactions began (tests). */
  started = 0;

  effect(characterId: string, event: Readonly<TouchFeedEvent>, card: Readonly<TouchFeedFreshness>, now: () => TouchFeedNow | null): TouchFeedEffect {
    void now;
    const key = `${characterId}\u0000${event.kind as TouchFeedKind}`, current = this.sessions.get(key);
    if (!current || current.sessionId !== event.sessionId) {
      this.started++;
      this.sessions.set(key, { sessionId: event.sessionId, at: event.at, kind: event.kind, contact: event.contact, landing: '卡上的值', scale: 1,
        why: ['假实现：卡上的值原样用，每次都一样'], fresh: { first: 100, last: 100 }, doses: 0, weights: '' });
    }
    const session = this.sessions.get(key)!;
    session.sessionId = event.sessionId;
    this.sessions.set(key, { ...session, doses: Math.round((session.doses + (Number.isFinite(event.doses) ? event.doses : 0)) * 100) / 100 });
    return { scale: 1, retention: card.retention, floor: card.floor };
  }

  recent(characterId: string): readonly TouchFeedWhy[] {
    return [...this.sessions.entries()].filter(([key]) => key.startsWith(`${characterId}\u0000`))
      .map(([, { sessionId: _, ...entry }]) => ({ ...entry, why: [...entry.why], fresh: { ...entry.fresh } })).sort((a, b) => b.at - a.at);
  }
}
