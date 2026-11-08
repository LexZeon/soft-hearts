// I-048 §1: the watch timeline, in memory only. Heard lines, frame descriptions (put in at the moment the frame was captured, with a
// placeholder until haiku has written it) and summaries of older stretches. Pure: the caller passes every time; no timers, no I/O.

import type { SeenTicket, TimelineEntry } from './interface';
import { WATCH_TIMELINE_KNOBS, type WatchTimelineKnobs } from './knobs';

/** What a compaction call was shown. Hand it back to `applySummary` with the summary text. */
export interface CompactPlan {
  readonly generation: number;
  /** Everything at or before this time goes into the summary. */
  readonly upTo: number;
  /** The entries to summarize, oldest first (earlier summaries come first). */
  readonly entries: readonly TimelineEntry[];
}

export interface RenderedTimeline {
  /** The lines for her turn, oldest first. '' when there is nothing. */
  readonly text: string;
  readonly heard: number;
  readonly seen: number;
  readonly pending: number;
  readonly summaries: number;
  readonly chars: number;
}

const length = (value: string) => Array.from(value).length;
function clip(value: string, max: number): string {
  const chars = Array.from(value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim());
  return chars.length > max ? chars.slice(0, Math.max(1, max - 1)).join('') + '…' : chars.join('');
}
function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}秒前` : `${Math.floor(seconds / 60)}分${seconds % 60}秒前`;
}
const LABEL = { heard: '听到', seen: '看到', summary: '概要' } as const;

export class WatchTimeline {
  private entries: TimelineEntry[] = [];
  private nextId = 1;
  private gen = 1;

  constructor(private readonly knobs: WatchTimelineKnobs['timeline'] = WATCH_TIMELINE_KNOBS.timeline) {}

  /** Moves on whenever pending work must be forgotten (watch off, screen off, a refusal): older tickets and plans stop working. */
  get generation(): number { return this.gen; }
  get size(): number { return this.entries.length; }
  snapshot(): readonly TimelineEntry[] { return this.entries.slice(); }

  private insert(kind: TimelineEntry['kind'], at: number, text: string, pending: boolean): TimelineEntry {
    const entry: TimelineEntry = { id: this.nextId++, kind, at, text, pending };
    let index = this.entries.length;
    while (index > 0 && this.entries[index - 1].at > at) index--;
    this.entries.splice(index, 0, entry);
    return entry;
  }

  /** Forget what left the window, and placeholders that waited too long. */
  prune(now: number): void {
    const oldest = now - this.knobs.windowMinutes * 60_000, stuck = now - this.knobs.pendingSeconds * 1000;
    this.entries = this.entries.filter(entry => entry.at >= oldest && !(entry.pending && entry.at < stuck));
  }

  /** A transcript segment with its own time. Empty text is nothing. */
  addHeard(text: string, at: number): boolean {
    const clean = clip(text, this.knobs.entryChars);
    if (!clean) return false;
    this.insert('heard', at, clean, false);
    this.prune(at);
    return true;
  }

  /** A frame was captured at `at`: take its place now, fill it when haiku has written the description. */
  reserveSeen(at: number): SeenTicket {
    const entry = this.insert('seen', at, '', true);
    return { id: entry.id, generation: this.gen, at };
  }

  /**
   * The description arrived. It goes into the place taken at capture time, only if that is still the same watch (generation) and
   * the slot is still in the window. Otherwise it is dropped (false). An empty description removes the placeholder.
   */
  fillSeen(ticket: SeenTicket, text: string, now: number): boolean {
    this.prune(now);
    const index = this.entries.findIndex(entry => entry.id === ticket.id);
    if (ticket.generation !== this.gen || index < 0 || !this.entries[index].pending) return false;
    const clean = clip(text, this.knobs.entryChars);
    if (!clean) { this.entries.splice(index, 1); return false; }
    this.entries[index] = { ...this.entries[index], text: clean, pending: false };
    return true;
  }

  /** The description failed: the placeholder goes away. */
  failSeen(ticket: SeenTicket): void {
    if (ticket.generation !== this.gen) return;
    this.entries = this.entries.filter(entry => entry.id !== ticket.id);
  }

  /** Screen off or a refusal: waiting descriptions are forgotten and any that still arrive are dropped. What was filled stays. */
  cancelPending(): void {
    this.gen++;
    this.entries = this.entries.filter(entry => !entry.pending);
  }

  /** Watch off: everything goes. */
  reset(): void {
    this.gen++;
    this.entries = [];
  }

  /** The stretch old enough to be written up as a summary, or null when there is not enough yet. Stops before the first placeholder. */
  compactPlan(now: number): CompactPlan | null {
    this.prune(now);
    const limit = now - this.knobs.compactAfterSeconds * 1000;
    const firstPending = this.entries.find(entry => entry.pending)?.at ?? Infinity;
    const old = this.entries.filter(entry => entry.at <= limit && entry.at < firstPending);
    if (old.filter(entry => entry.kind !== 'summary').length < this.knobs.compactMinEntries) return null;
    return { generation: this.gen, upTo: old[old.length - 1].at, entries: old };
  }

  /** The summary came back: it replaces the stretch it covers (earlier summaries too). False when the watch changed meanwhile. */
  applySummary(plan: CompactPlan, text: string, now: number): boolean {
    const clean = clip(text, this.knobs.entryChars * 2);
    if (plan.generation !== this.gen || !clean) return false;
    this.entries = this.entries.filter(entry => entry.pending || entry.at > plan.upTo);
    this.insert('summary', plan.upTo, clean, false);
    this.prune(now);
    return true;
  }

  /**
   * The block for her turn: the last `recentSeconds` of heard and seen lines first, then the summaries, then older lines that are not
   * summarized yet, newest first while the character budget lasts. Shown oldest first. A placeholder shows as "画面描述中".
   */
  render(now: number, options: { heard?: boolean } = {}): RenderedTimeline {
    this.prune(now);
    const wantHeard = options.heard !== false;
    const budget = this.knobs.blockChars, recentFrom = now - this.knobs.recentSeconds * 1000;
    const line = (entry: TimelineEntry) => {
      const label = LABEL[entry.kind];
      return `${ago(now - entry.at)} ${label}：${entry.pending ? '（画面描述中）' : entry.text}`;
    };
    const groups = [
      this.entries.filter(entry => entry.kind !== 'summary' && entry.at >= recentFrom && (wantHeard || entry.kind !== 'heard')),
      this.entries.filter(entry => entry.kind === 'summary'),
      this.entries.filter(entry => entry.kind !== 'summary' && entry.at < recentFrom && !entry.pending && (wantHeard || entry.kind !== 'heard')),
    ];
    const chosen: TimelineEntry[] = [];
    let used = 0;
    for (const group of groups) {
      for (let index = group.length - 1; index >= 0; index--) {
        const size = length(line(group[index])) + 1;
        if (used + size > budget) { if (chosen.length) break; continue; }
        chosen.push(group[index]); used += size;
      }
    }
    chosen.sort((a, b) => a.at - b.at || a.id - b.id);
    const count = (kind: TimelineEntry['kind']) => chosen.filter(entry => entry.kind === kind).length;
    const text = chosen.map(line).join('\n');
    return { text, heard: count('heard'), seen: chosen.filter(e => e.kind === 'seen' && !e.pending).length,
      pending: chosen.filter(e => e.pending).length, summaries: count('summary'), chars: length(text) };
  }
}
