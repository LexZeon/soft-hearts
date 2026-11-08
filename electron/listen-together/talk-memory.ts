// 2026-11-07 (docs/claude/2026-11-07-listen-talk-memory.md): the words of "just talk" (narration, a call, a class: shared/listen-kind.ts
// 'talk') live here and only here: in memory, the latest LISTEN_LIMITS.talkMemoryMs, per character, never written to disk, never noted,
// never part of a segment or her long-term memory. They go to a chat turn only when the user asks about what is playing now
// (shared/listen-ask.ts `speech`). Cleared when 一起听 goes off, the character changes, the user clears the listening data, and by quit
// (the process ends; the host's dispose clears it too). `epoch` moves on every clear so a turn composed earlier can tell its text went.

import { LISTEN_LIMITS } from '../../shared/listen-together';

interface Held { characterId: string; heardAt: number; text: string }
export interface TalkView { text: string; startedAt: number; endedAt: number; epoch: number }

export class TalkMemory {
  private held: Held[] = [];
  epoch = 0;
  constructor(private readonly ttl: number = LISTEN_LIMITS.talkMemoryMs, private readonly maxChars: number = LISTEN_LIMITS.talkMemoryChars) {}

  add(characterId: string, text: string, now: number): void {
    const clean = text.trim();
    if (!clean || !characterId) return;
    this.held = this.held.filter(h => h.characterId === characterId);
    this.held.push({ characterId, heardAt: now, text: clean });
    this.prune(now);
  }

  /** What was heard in the last ttl for this character; null for none. Older pieces are dropped on the way. */
  view(characterId: string | null, now: number, sinceMs: number = Infinity): TalkView | null {
    this.prune(now);
    const mine = characterId ? this.held.filter(h => h.characterId === characterId && now - h.heardAt <= sinceMs) : [];
    if (!mine.length) return null;
    return { text: mine.map(h => h.text).join('\n'), startedAt: mine[0]!.heardAt, endedAt: mine.at(-1)!.heardAt, epoch: this.epoch };
  }

  /** Everything goes (switch off, another character, the user's clear, quit). */
  clear(): boolean {
    const had = this.held.length > 0;
    this.held = []; this.epoch++;
    return had;
  }
  get size(): number { return this.held.length; }

  private prune(now: number): void {
    this.held = this.held.filter(h => now - h.heardAt <= this.ttl && now - h.heardAt >= -5_000);
    let chars = this.held.reduce((n, h) => n + h.text.length, 0);
    while (chars > this.maxChars && this.held.length > 1) chars -= this.held.shift()!.text.length;
  }
}
