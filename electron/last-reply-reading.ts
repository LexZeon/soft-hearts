/**
 * 上一句有没有读出来（真实聊天分析第二批 7，docs/claude/2026-11-07-turn-awareness.md）。
 * 用户开了朗读、有些回复没出声（电脑睡了、引擎出错、桌宠窗口没显示），她以前不知道，也就没法自然地提一句。
 * 这里按角色记"最近一条回复"读得怎么样（只记次数和结果，不记文字），下一轮的【此刻的感知】里说一次。
 * 和体验记录（electron/journal/extras.ts ReadingJournal）喂同一份分段记录，但体验记录关着时这里照样记。
 * 朗读关着、被用户停掉、读完了：什么都不说。
 */
import type { UnreadReason } from '../shared/turn-awareness';

interface Reading { ended: number; cancelled: number; failed: number; heard: boolean; hidden: boolean; told: boolean }
const fresh = (): Reading => ({ ended: 0, cancelled: 0, failed: 0, heard: false, hidden: false, told: false });
const KEEP = 8;

export class LastReplyReading {
  private readonly byCharacter = new Map<string, Reading>();
  private current(characterId: string): Reading {
    let reading = this.byCharacter.get(characterId);
    if (!reading) {
      reading = fresh(); this.byCharacter.set(characterId, reading);
      while (this.byCharacter.size > KEEP) this.byCharacter.delete(this.byCharacter.keys().next().value!);
    }
    return reading;
  }

  /** A per-segment record of a reply (kind 'reply' only); a first segment starts a new reply. */
  segment(characterId: string | null, record: { kind: string; segmentIndex: number | null; outcome: string; t?: { playbackStart?: number } }): void {
    try {
      if (!characterId || record.kind !== 'reply') return;
      if (record.segmentIndex === null || record.segmentIndex === 0) this.byCharacter.set(characterId, fresh());
      else if (!this.byCharacter.has(characterId)) return; // the start of this reply was not seen
      const reading = this.current(characterId);
      if (record.t?.playbackStart !== undefined) reading.heard = true;
      if (record.outcome === 'ended') reading.ended++; else if (record.outcome === 'cancelled') reading.cancelled++; else reading.failed++;
    } catch { /* never blocks speech */ }
  }

  /** A reply that was never handed to the voice. Only 'hidden' (reading on, pet window not shown) is worth saying; 'off' is the user's choice. */
  unread(characterId: string | null, why: 'off' | 'hidden'): void {
    try {
      if (!characterId) return;
      this.byCharacter.set(characterId, { ...fresh(), hidden: why === 'hidden' });
    } catch { /* same */ }
  }

  /** What to tell her now, once for the latest reply of this character; null when there is nothing to say. */
  take(characterId: string | null): UnreadReason | null {
    try {
      const reading = characterId ? this.byCharacter.get(characterId) : undefined;
      if (!reading || reading.told) return null;
      const reason: UnreadReason | null = reading.hidden ? 'hidden'
        : reading.failed > 0 ? (reading.heard || reading.ended > 0 ? 'partial' : 'failed') : null;
      if (reason) reading.told = true;
      return reason;
    } catch { return null; }
  }
}
