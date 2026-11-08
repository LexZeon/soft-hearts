import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { IncrementalReplySegments } from '../shared/incremental-reply-segments';
import type { ReplySurfaceObserver } from './reply-window';
import type { ClaudeTimingInfo, ClaudeTimingObserver } from './claude-session';

/**
 * R27 developer-mode latency probe for ordinary chat. Records timings and
 * counts only: never reply text, prompts, ids, paths or provider settings.
 * All "...Ms" values are milliseconds from the user's send (the renderer's
 * wall-clock `sentAt`) when reported, otherwise from host receipt of the chat
 * request (`origin` says which).
 */
export interface ReplyLatencyRecord {
  at: string;
  provider: string;
  status: 'complete' | 'stopped' | 'error' | 'superseded';
  origin: 'renderer-send' | 'host-receipt';
  /** Renderer send → host receipt (settings save, attachment check, IPC). */
  sendToHostMs: number | null;
  /** Timing 1: send → first reply content arriving from the provider stream. */
  firstContentMs: number | null;
  /** Send → first complete sentence in the provider stream. */
  firstSentenceContentMs: number | null;
  /** Send → first reply text handed to the pet's native bubble window. */
  firstBubbleMs: number | null;
  /** Timing 2: send → first reply text actually painted visible (native two-frame paint receipt). */
  firstVisibleMs: number | null;
  /** Send → first complete sentence painted visible. */
  firstSentenceVisibleMs: number | null;
  /** Send → provider stream finished. */
  streamEndMs: number | null;
  /** Send → the whole reply painted visible. */
  allVisibleMs: number | null;
  chars: number;
  deltas: number;
  /**
   * Claude Code transport, present only for Claude chat replies: per-message
   * spawn vs the conversation's persistent process, and whether that process
   * was cold (spawned for this turn), prewarmed (spawned earlier) or warm
   * (reused after a turn). `dispatchMs`: send → user message handed to Claude
   * Code; `firstDeltaMs`: send → first raw text delta from Claude Code.
   */
  claude?: ClaudeTimingInfo & { dispatchMs: number | null; firstDeltaMs: number | null };
  /**
   * F7 停停说说 (present when the chat handler gave it): whether the switch was on for this reply, and whether this turn carried
   * the earlier reply's unsaid part as background. Flags only.
   */
  pauseTalk?: boolean;
  carried?: boolean;
}

/** F7: what the chat handler says about a reply when it starts (flags only). */
export interface ReplyLatencyTags { pauseTalk: boolean; carried: boolean }

export interface ReplyLatencyOptions {
  /**
   * Checked when a reply starts; nothing is tracked otherwise. Developer mode, and (F7) the experience journal, which records each
   * reply's first visible character as a number.
   */
  enabled(): boolean;
  /** F7: every finished record (numbers and flags only), e.g. for the journal and the developer panel. Never throws into a reply. */
  onRecord?(record: ReplyLatencyRecord): void;
  /** JSON-lines log file, or null for memory/console only. */
  file(): string | null;
  /** The pet's current native reply surface, observed while a reply is measured. */
  surface?(): Surface | null;
  now?(): number;
  wallNow?(): number;
  write?(file: string, line: string): Promise<void>;
  log?(line: string): void;
  settleMs?: number;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
}

interface Surface { setObserver(observer: ReplySurfaceObserver | null): void }
type Sample = [at: number, length: number];
interface Active {
  id: string; provider: string; startedAt: number; wallAt: number; sendToHost: number | null;
  stream: string; overflow: boolean; deltas: number; parser: IncrementalReplySegments | null;
  firstContent?: number; firstSentenceEnd?: number; firstSentenceContent?: number;
  rendered: Sample[]; painted: Sample[]; completed: boolean; ended?: number;
  status?: ReplyLatencyRecord['status']; timer?: unknown;
  claude?: { info: ClaudeTimingInfo; dispatch: number; firstDelta?: number };
  tags?: ReplyLatencyTags;
}

const MAX_STREAM = 100_000, MAX_SAMPLES = 512, MAX_RECORDS = 20, MAX_LOG_BYTES = 256 * 1024;

/** Append one JSON line, rotating the file once it passes 256 KB (developer logs only). */
export async function appendBounded(file: string, line: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  try { if ((await stat(file)).size > MAX_LOG_BYTES) await rename(file, file.replace(/\.jsonl$/u, '') + '.old.jsonl'); } catch { /* New log. */ }
  await appendFile(file, line, 'utf8');
}

export class ReplyLatencyProbe implements ReplySurfaceObserver {
  private active: Active | null = null;
  private readonly records: ReplyLatencyRecord[] = [];
  constructor(private readonly options: ReplyLatencyOptions) {}

  private now(): number { return this.options.now?.() ?? performance.now(); }
  private wallNow(): number { return this.options.wallNow?.() ?? Date.now(); }

  /** Last few records, newest last (developer inspection only). */
  recent(): ReplyLatencyRecord[] { return this.records.map(record => ({ ...record })); }

  begin(id: string, provider: string, sentAt?: number, tags?: ReplyLatencyTags): void {
    this.finalize();
    let enabled = false;
    try { enabled = this.options.enabled(); } catch { enabled = false; }
    if (!enabled) return;
    const wall = this.wallNow(), lag = typeof sentAt === 'number' ? wall - sentAt : NaN;
    this.active = { id, provider: String(provider).slice(0, 16), startedAt: this.now(), wallAt: wall,
      sendToHost: Number.isFinite(lag) && lag >= 0 && lag <= 120_000 ? lag : null,
      stream: '', overflow: false, deltas: 0, parser: new IncrementalReplySegments({ maxReplyChars: MAX_STREAM, maxSegments: MAX_STREAM }),
      rendered: [], painted: [], completed: false,
      ...(tags ? { tags: { pauseTalk: tags.pauseTalk === true, carried: tags.carried === true } } : {}) };
    try { this.options.surface?.()?.setObserver(this); } catch { /* Timing never affects presentation. */ }
  }

  /** One visible (protocol-filtered) provider delta of this reply. */
  delta(id: string, text: string): void {
    const a = this.active;
    if (!a || a.id !== id || a.ended !== undefined || typeof text !== 'string' || !text) return;
    const at = this.now();
    a.deltas++;
    if (a.overflow || a.stream.length + text.length > MAX_STREAM) { a.overflow = true; a.parser = null; }
    else a.stream += text;
    if (a.firstContent === undefined && text.trim()) a.firstContent = at;
    if (a.parser && a.firstSentenceEnd === undefined) {
      try {
        const first = a.parser.push(text)[0];
        if (first) { a.firstSentenceEnd = first.end; a.firstSentenceContent = at; a.parser.cancel(); a.parser = null; }
      } catch { a.parser = null; }
    }
  }

  complete(id: string): void { if (this.active?.id === id) this.active.completed = true; }

  /** Hooks for the Claude chat transport (electron/claude-session.ts); timings only. */
  claudeTiming(): ClaudeTimingObserver {
    return {
      dispatched: (id, info) => {
        const a = this.active;
        if (!a || a.id !== id || a.ended !== undefined) return;
        // A transparent restart dispatches again; keep the latest attempt.
        a.claude = { info: { mode: info.mode, process: info.process, sessionTurn: Math.max(0, Math.floor(info.sessionTurn)) }, dispatch: this.now() };
      },
      firstDelta: id => {
        const a = this.active;
        if (a?.id === id && a.ended === undefined && a.claude && a.claude.firstDelta === undefined) a.claude.firstDelta = this.now();
      },
    };
  }

  end(id: string, aborted: boolean): void {
    const a = this.active;
    if (!a || a.id !== id || a.ended !== undefined) return;
    a.ended = this.now();
    a.status = a.completed ? 'complete' : aborted ? 'stopped' : 'error';
    if (a.firstSentenceEnd === undefined && a.completed && a.stream.trim() && !a.overflow) {
      // A reply without any sentence boundary completes its first sentence at the end.
      let end = a.stream.length;
      try { end = a.parser?.finish()[0]?.end ?? end; } catch { /* Keep the whole reply. */ }
      a.firstSentenceEnd = end; a.firstSentenceContent = a.ended;
    }
    a.parser?.cancel(); a.parser = null;
    if (this.settled(a)) { this.finalize(); return; }
    const timers = this.options.timers ?? { set: (callback: () => void, ms: number) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; }, clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
    a.timer = timers.set(() => { if (this.active === a) this.finalize(); }, this.options.settleMs ?? 15_000);
  }

  rendered(text: string): void { this.sample(text, 'rendered'); }
  painted(text: string): void { this.sample(text, 'painted'); }

  private sample(text: string, kind: 'rendered' | 'painted'): void {
    const a = this.active;
    if (!a || typeof text !== 'string' || !text.trim() || !a.stream.startsWith(text)) return;
    const list = a[kind];
    if (list.length < MAX_SAMPLES) list.push([this.now(), text.length]);
    if (this.settled(a)) this.finalize();
  }

  private settled(a: Active): boolean {
    return a.ended !== undefined && !!a.stream && a.painted.some(([, length]) => length >= a.stream.length);
  }

  private finalize(): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    if (a.timer !== undefined) (this.options.timers ?? { clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) }).clear(a.timer);
    const since = (at?: number) => at === undefined ? null : Math.max(0, Math.round((a.sendToHost ?? 0) + at - a.startedAt));
    const first = (list: Sample[], length = 1) => list.find(([, value]) => value >= length)?.[0];
    const record: ReplyLatencyRecord = {
      at: new Date(a.wallAt).toISOString(), provider: a.provider, status: a.ended === undefined ? 'superseded' : a.status!,
      origin: a.sendToHost === null ? 'host-receipt' : 'renderer-send', sendToHostMs: a.sendToHost === null ? null : Math.round(a.sendToHost),
      firstContentMs: since(a.firstContent), firstSentenceContentMs: since(a.firstSentenceContent),
      firstBubbleMs: since(first(a.rendered)), firstVisibleMs: since(first(a.painted)),
      firstSentenceVisibleMs: a.firstSentenceEnd === undefined ? null : since(first(a.painted, a.firstSentenceEnd)),
      streamEndMs: since(a.ended), allVisibleMs: a.ended === undefined || !a.stream || a.overflow ? null : since(first(a.painted, a.stream.length)),
      chars: a.stream.length, deltas: a.deltas,
      ...(a.claude ? { claude: { ...a.claude.info, dispatchMs: since(a.claude.dispatch), firstDeltaMs: since(a.claude.firstDelta) } } : {}),
      ...(a.tags ? { pauseTalk: a.tags.pauseTalk, carried: a.tags.carried } : {}),
    };
    this.records.push(record);
    try { this.options.onRecord?.({ ...record }); } catch { /* The journal and the panel never disturb a reply. */ }
    while (this.records.length > MAX_RECORDS) this.records.shift();
    const line = JSON.stringify(record);
    try { (this.options.log ?? (value => console.info('[soft hearts] R27 reply latency', value)))(line); } catch { /* Logging is best effort. */ }
    let file: string | null = null;
    try { file = this.options.file(); } catch { file = null; }
    if (file) void (this.options.write ?? appendBounded)(file, line + '\n').catch(() => {});
  }
}
