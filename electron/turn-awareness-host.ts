/**
 * 每轮【此刻的感知】后面补的短句（shared/turn-awareness.ts）：困意阶段、上一句没读出来、问歌/视频但听不到看不到。
 * electron/main.ts 只在那一行后面接一次 `line(...)`，其余都在这里，可以单独测试。读不到的来源一律当作"没有这一句"，不影响聊天。
 */
import type { LastReplyReading } from './last-reply-reading';
import { MediaExplainTold, turnAwarenessText } from '../shared/turn-awareness';

export interface TurnAwarenessSources {
  /** The active character's fatigue phase (companion.mood.get().fatigue?.phase); undefined while unknown. */
  phase(): unknown;
  characterId(): string | null;
  reading: Pick<LastReplyReading, 'take'>;
  now?(): number;
}

export function createTurnAwareness(sources: TurnAwarenessSources) {
  const told = new MediaExplainTold();
  const safely = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };
  return {
    /**
     * The sentences to put right after this turn's perception line ('' = none). Call once per turn: the unread-reply note is
     * taken (told once), so the retry path reuses the string instead of calling again.
     */
    line(input: { text: unknown; listening: boolean; screenSharing: boolean; scope: string }): string {
      return safely(() => turnAwarenessText({ ...input, phase: safely(() => sources.phase(), undefined),
        unread: safely(() => sources.reading.take(sources.characterId()), null), now: safely(() => sources.now?.() ?? Date.now(), Date.now()) }, told), '');
    },
  };
}
