/**
 * #32 的假实现：每一份点心都是原来的"啊～""嗯～"、照常的吃法（= 原来的做法）。
 * 守约测试（tests/feed-cue.test.ts）拿它和真实现跑同一组约定；以后接新实现，先拿它对一遍。
 */
import type { TouchFeedLandingId } from '../touch-feed-effect/knobs';
import { FEED_CUE_VIEW_AFTER_BITE_MS, FEED_CUE_VIEW_BEFORE_BITE_MS } from './choose';
import type { FeedCueHost, FeedCueNow, FeedCueView, FeedCueWhy } from './interface';

export class FixedFeedCue implements FeedCueHost {
  private readonly sessions = new Map<string, { view: FeedCueView; at: number; biteAt: number | null }>();
  /** How many snacks began (tests). */
  started = 0;

  open(characterId: string, sessionId: string, at: number, now: () => FeedCueNow | null): void {
    void now;
    if (!characterId || !sessionId || this.sessions.get(characterId)?.view.sessionId === sessionId) return;
    this.started++;
    this.sessions.set(characterId, { at, biteAt: null,
      view: { sessionId, open: { id: `${sessionId}:open`, sound: 'ah', mouth: { rate: 1, size: 1 }, shake: null } } });
  }

  bite(characterId: string, sessionId: string, at: number, landing: TouchFeedLandingId | null, now: () => FeedCueNow | null): void {
    void landing;
    if (!characterId || !sessionId) return;
    if (this.sessions.get(characterId)?.view.sessionId !== sessionId) this.open(characterId, sessionId, at, now);
    const s = this.sessions.get(characterId)!;
    if (s.view.eat) return;
    s.view = { ...s.view, eat: { id: `${sessionId}:eat`, sound: 'mm', chew: { rate: 1, size: 1 } } };
    s.biteAt = at;
  }

  view(characterId: string, at: number): FeedCueView | null {
    const s = this.sessions.get(characterId);
    if (!s || at - (s.biteAt ?? s.at) > (s.biteAt === null ? FEED_CUE_VIEW_BEFORE_BITE_MS : FEED_CUE_VIEW_AFTER_BITE_MS)) return null;
    return structuredClone(s.view);
  }

  recent(characterId: string): readonly FeedCueWhy[] {
    const s = this.sessions.get(characterId);
    if (!s) return [];
    return [{ at: s.at, open: { sound: '啊～', why: ['假实现：原来的那一声'], weights: '' },
      ...(s.view.eat ? { eat: { sound: '嗯～', why: ['假实现：原来的那一声'], weights: '' } } : {}),
      manner: { label: '照常', why: ['假实现：照常吃'], numbers: '和原来一样' } }];
  }
}
