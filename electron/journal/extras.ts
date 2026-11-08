// 体验记录 (E2) 第一批新记录项 (2026-11-06, docs/claude/2026-11-06-journal-batch1.md): the hosts' moments that were never written down
// (a reply's reading, a spoken sentence's recognition, a blush that did or did not happen, the small action she chose, ...).
// Every converter copies numbers and closed categories only; shared/journal.ts checks them again before a line is made. Nothing here
// reads a word of chat, an audio sample or a device/app name. A source writes nothing while the user's switch is off (the sink says).
import type { FatiguePhase } from '../../shared/fatigue';
import type { ChatActionWord } from '../../shared/chat-actions';
import { validateSpeechDiagnosticRecord, type SpeechDiagnosticRecord } from '../../shared/speech-diagnostics';
import type {
  BlushBlock, BlushSource, GestureAnswer, JournalInput, ReadingProvider, ReadingWhy, TopmostFixOutcome, VoiceTimeResult,
} from '../../shared/journal';
import type { DraftDrop, DraftKind } from '../reply-draft-guard';
import type { ReplyCheck } from '../mood-chat';
import type { JournalSink } from './sources';
import { LastReplyReading } from '../last-reply-reading';

const safely = (sink: JournalSink | null | undefined, input: JournalInput) => { try { sink?.record(input); } catch { /* Keeping a record never blocks her. */ } };
const accepting = (sink: JournalSink): boolean => { try { return sink.accepting ? sink.accepting() === true : true; } catch { return false; } };

// ---------------------------------------------------------------- 1. 她的朗读时间

/** After this long without another segment of the reply, its reading is over (a reply's segments follow each other within seconds). */
export const READING_IDLE_MS = 15_000;

interface PendingReading {
  provider: ReadingProvider; chars: number; firstAudioMs: number | null; waitMs: number | null;
  ended: number; cancelled: number; failed: number; heard: boolean;
}

/**
 * One line per reply, from the per-segment timing records the pet window already sends (src/ui/speech-diagnostics.ts), plus the
 * replies that were not read at all (voice off, pet window hidden). A new reply starts at its first segment; the last one is written
 * after READING_IDLE_MS of quiet (or when the next reply starts, or on quit).
 */
export class ReadingJournal {
  private pending: PendingReading | null = null;
  private timer: unknown = null;
  private lines = 0;
  constructor(private readonly sink: JournalSink, private readonly characterId: () => string | null,
    private readonly timers: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void } = {
      set: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; }, clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
    /** Second batch item 7: the same records also tell her whether the last reply was read (kept even while the journal is off). */
    private readonly last?: LastReplyReading) {}

  /** A validated segment record (kind 'reply' only; previews and other speech are not replies). */
  segment(record: Pick<SpeechDiagnosticRecord, 'kind' | 'provider' | 'segmentIndex' | 'textLength' | 'outcome' | 't'>): void {
    try { this.last?.segment(this.characterId(), record); } catch { /* never blocks speech */ }
    try {
      if (record.kind !== 'reply' || !accepting(this.sink)) return;
      if (record.segmentIndex === null || record.segmentIndex === 0) { this.flush(); this.pending = null; }
      if (!this.pending) {
        if (record.segmentIndex !== null && record.segmentIndex > 0) return; // the start of this reply was not seen (the switch was off)
        this.pending = { provider: record.provider, chars: 0, firstAudioMs: record.t.playbackStart ?? null, waitMs: record.t.request ?? null,
          ended: 0, cancelled: 0, failed: 0, heard: false };
      }
      const p = this.pending;
      p.chars += record.textLength;
      if (record.t.playbackStart !== undefined) p.heard = true;
      if (record.outcome === 'ended') p.ended++; else if (record.outcome === 'cancelled') p.cancelled++; else p.failed++;
      this.rearm();
    } catch { /* never blocks speech */ }
  }

  /** A reply that was never handed to the voice: reading off, or the pet window not shown. */
  unread(why: 'off' | 'hidden'): void {
    try { this.last?.unread(this.characterId(), why); } catch { /* same */ }
    try {
      this.flush();
      if (!accepting(this.sink)) return;
      this.write({ provider: 'system', chars: 0, firstAudioMs: null, waitMs: null, ended: 0, cancelled: 0, failed: 0, heard: false }, why);
    } catch { /* same */ }
  }

  /** Writes the reply in progress now (the next reply started, or quitting). */
  flush(): void {
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
    const p = this.pending;
    this.pending = null;
    if (p && accepting(this.sink)) this.write(p, null);
  }

  private rearm(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => { this.timer = null; this.flush(); }, READING_IDLE_MS);
  }

  private write(p: PendingReading, unread: 'off' | 'hidden' | null): void {
    let why: ReadingWhy | null = unread;
    let result: 'played' | 'partial' | 'unread';
    if (unread) result = 'unread';
    else if (p.cancelled === 0 && p.failed === 0 && p.ended > 0) result = 'played';
    else { result = p.heard || p.ended > 0 ? 'partial' : 'unread'; why = p.failed > 0 ? 'failed' : 'cancelled'; }
    safely(this.sink, { type: 'reading-time', characterId: this.characterId(), firstAudioMs: p.firstAudioMs, waitMs: p.waitMs, chars: p.chars,
      provider: p.provider, result, why, firstSinceStart: this.lines++ === 0 });
  }
}

// ---------------------------------------------------------------- 2. 语音输入时间

/** The clip's length in seconds from its WAV header (a number, never audio); null when it does not read as a WAV. */
export function wavSeconds(wav: ArrayBuffer): number | null {
  try {
    if (!(wav instanceof ArrayBuffer) || wav.byteLength < 44) return null;
    const view = new DataView(wav);
    if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) return null; // "RIFF" ... "WAVE"
    const byteRate = view.getUint32(28, true);
    if (!(byteRate > 0)) return null;
    let at = 12;
    while (at + 8 <= wav.byteLength) {
      const size = view.getUint32(at + 4, true);
      if (view.getUint32(at, false) === 0x64617461) return Math.min(wav.byteLength - at - 8, size) / byteRate; // "data"
      at += 8 + size + (size & 1);
    }
    return (wav.byteLength - 44) / byteRate;
  } catch { return null; }
}

const HAS_WORDS = /[\p{L}\p{N}]/u;

/**
 * 语音输入时间: wraps the recognition of one spoken clip. `ms` runs from the end of the user's speech (the window's `endpoint`
 * signal, when one came just before the clip) to the text, `recognizeMs` from handing the clip in to the text, so a slow hand-over
 * and a slow recognizer can be told apart. The text itself is only tested for "has any letter or digit", never kept.
 */
export class VoiceTimeJournal {
  private endpointAt: number | null = null;
  constructor(private readonly sink: JournalSink, private readonly characterId: () => string | null, private readonly engine: () => 'local' | 'compatible',
    private readonly clock: () => number = Date.now) {}

  /** The window said the user stopped speaking. */
  endpoint(): void { this.endpointAt = this.clock(); }
  /** The window found a microphone that gives only silence. */
  noSound(): void { safely(this.sink, { type: 'voice-time', characterId: this.characterId(), ms: null, recognizeMs: null, seconds: null, result: 'no-sound', engine: this.engine() }); }

  async measure(wav: ArrayBuffer, run: () => Promise<string>): Promise<string> {
    const handedAt = this.clock(), endpointAt = this.endpointAt, engine = this.engine();
    this.endpointAt = null;
    const finish = (result: VoiceTimeResult) => {
      try {
        const now = this.clock();
        const fromEnd = endpointAt !== null && endpointAt <= handedAt && handedAt - endpointAt <= 20_000 ? now - endpointAt : now - handedAt;
        safely(this.sink, { type: 'voice-time', characterId: this.characterId(), ms: fromEnd, recognizeMs: now - handedAt, seconds: wavSeconds(wav), result, engine });
      } catch { /* never blocks recognition */ }
    };
    try {
      const text = await run();
      finish(typeof text === 'string' && HAS_WORDS.test(text) ? 'text' : 'no-words');
      return text;
    } catch (error) { finish('failed'); throw error; }
  }
}

// ---------------------------------------------------------------- 3. 脸红

export interface BlushMoment {
  characterId: string;
  event: { type: string; context?: string };
  /** The blush state before the event (the mood model's own cue and last-blush time) and the event's time. */
  before: { cue: { until: number } | null; lastBlushAt: number | null; now: number };
  /** The blush parameters this event ran with (the prepared profile). */
  profile: { enabled: boolean; intensity: number; cooldownMs: number };
  /** The expressions switch, or this event being kept from showing (an ambient/other-character event). */
  gated: boolean;
  /** The mood model's new cue for this event exists. */
  raised: boolean;
  /** What the event moved (the last trend sample of this event). */
  applied: { O: number; E: number; N: number } | null;
  /** Closeness gained inside the fast window, and the card's threshold for it. */
  total: number;
  threshold: number;
}

/** A candidate blush moment as a journal input, or null when the event was no candidate (not warm words, not a pat, not applied). */
export function blushMomentInput(m: BlushMoment): JournalInput | null {
  const type = m.event.type, context = m.event.context;
  const source: BlushSource | null = type === 'rua' ? 'pat' : (type === 'chat' || type === 'appraisal') && (context === 'support' || context === 'positive') ? 'words' : null;
  if (!source || !m.applied) return null;
  const numbers = { dO: m.applied.O, dE: m.applied.E, dN: m.applied.N, ...(source === 'pat' ? { total: m.total, threshold: m.threshold } : {}) };
  if (m.raised) return { type: 'blush', characterId: m.characterId, outcome: 'fired', source, ...numbers };
  let why: BlushBlock;
  if (m.gated || !m.profile.enabled || m.profile.intensity === 0) why = 'off';
  else if (m.before.cue && m.before.cue.until > m.before.now) why = 'showing';
  else if (m.before.lastBlushAt !== null && m.before.now - m.before.lastBlushAt < m.profile.cooldownMs) why = 'cooldown';
  else why = 'threshold';
  return { type: 'blush', characterId: m.characterId, outcome: 'blocked', source, why, ...numbers };
}

/** A blocked moment of the same kind within this long of the last one written is not written again (a long pat is many events). */
export const BLUSH_BLOCKED_GAP_MS = 20_000;

/** The pet window's answer to a new blush cue: could the stage show it, and if not why (see src/stage/blush-seen.ts). */
export function blushStageInput(characterId: string, stage: unknown): JournalInput | null {
  const allowed = ['shown', 'no-cheek', 'face-busy', 'off', 'size-zero'];
  return typeof stage === 'string' && allowed.includes(stage) ? { type: 'blush', characterId, outcome: 'stage', source: null, stage: stage as 'shown' } : null;
}

/** Writes blush moments: every firing, and a blocked one at most once per source and reason per BLUSH_BLOCKED_GAP_MS. */
export class BlushJournal {
  private readonly last = new Map<string, number>();
  constructor(private readonly sink: JournalSink, private readonly clock: () => number = Date.now) {}
  moment(input: JournalInput | null): void {
    try {
      if (!input || input.type !== 'blush' || !accepting(this.sink)) return;
      if (input.outcome === 'blocked') {
        const key = `${input.characterId}|${input.source}|${input.why}`, now = this.clock(), before = this.last.get(key);
        if (before !== undefined && now - before < BLUSH_BLOCKED_GAP_MS) return;
        this.last.set(key, now);
      }
      safely(this.sink, input);
    } catch { /* same */ }
  }
}

// ---------------------------------------------------------------- 4. 她选的小动作 / 5. 困倦阶段 / 6. 置顶 / 7. 启动 / 草稿过滤

export function herGestureInput(characterId: string | null, gesture: ChatActionWord | null, answer: GestureAnswer | null, waited = false): JournalInput {
  return { type: 'her-gesture', characterId, gesture: gesture ?? 'none', answer: gesture ? answer ?? 'failed' : null, waited };
}

/** The word of a stage answer (shared/her-actions.ts HerActionPlayResult.status) as the journal's closed answer. */
export function gestureAnswerOf(status: string): GestureAnswer {
  switch (status) {
    case 'played': return 'played';
    case 'missing': case 'unfit': return 'cannot';
    case 'busy': return 'busy';
    default: return 'failed';
  }
}

export interface FatiguePhaseChange { characterId: string; from: FatiguePhase; to: FatiguePhase; A: number; F: number; W: number; clock: number; mood: number }
export function fatiguePhaseInput(change: FatiguePhaseChange): JournalInput {
  return { type: 'fatigue-phase', ...change };
}

export function topmostFixInput(characterId: string | null, outcome: TopmostFixOutcome, visible: boolean, nth: number): JournalInput {
  return { type: 'topmost-fix', characterId, outcome, visible, nth };
}

export function launchTimeInput(characterId: string | null, ms: number): JournalInput {
  return { type: 'launch-time', characterId, ms };
}

const DRAFT_GROUP: Readonly<Record<DraftKind, 'english' | 'plan' | 'format' | 'garbled'>> = {
  'english-note': 'english', 'mixed-note': 'english',
  'protocol-talk': 'plan', 'draft-block': 'plan', 'speaker-label': 'plan',
  'wrapper-tag': 'format', 'stray-symbol': 'format',
  'garbled-start': 'garbled', 'stray-letter': 'garbled', mojibake: 'garbled',
  'before-open': 'plan', 'internal-words': 'plan',
};
/** What the draft filter cut from one reply: counts per group and the characters cut, never the text. Null when it cut nothing. */
export function draftFilterInput(characterId: string | null, drops: readonly DraftDrop[], whole: boolean, filled = false): JournalInput | null {
  if (!drops.length) return null;
  const counts = { english: 0, plan: 0, format: 0, garbled: 0 };
  let chars = 0;
  for (const drop of drops) { counts[DRAFT_GROUP[drop.kind] ?? 'format']++; chars += Math.max(0, drop.chars); }
  return { type: 'draft-filter', characterId, ...counts, chars, whole, ...(filled ? { filled: true } : {}) };
}

/**
 * I-046 回复存档前的体检: a line only when the reply's opening marker did not go as asked, something in front of it was dropped, or
 * protocol words are still in what was shown (MoodReplyProtocol.replyCheck; with the marker off, only the last). Null otherwise, and
 * without a check (a stopped or stale turn). Names and numbers only.
 */
export function replyCheckInput(characterId: string | null, check: ReplyCheck | null, whole: boolean, filled = false): JournalInput | null {
  if (!check || ((check.marker === 'ok' || check.marker === 'off') && !check.before && !check.residue.length)) return null;
  return { type: 'reply-check', characterId, marker: check.marker, before: check.before, cut: check.cut, rules: [...check.rules], residue: [...check.residue],
    whole, ...(whole && filled ? { filled: true } : {}) };
}

/** Time since the app started / the last reply, for the first-character split. */
export class ReplyClock {
  private lastEndAt: number | null = null;
  constructor(private readonly startedAt: number, private readonly clock: () => number = Date.now) {}
  /** Call once per reply when its record is written; returns the two spans and remembers this reply's time. */
  take(): { sinceStartMs: number; sinceLastMs?: number } {
    const now = this.clock(), last = this.lastEndAt;
    this.lastEndAt = now;
    return { sinceStartMs: Math.max(0, now - this.startedAt), ...(last === null ? {} : { sinceLastMs: Math.max(0, now - last) }) };
  }
}

// ---------------------------------------------------------------- the app's wiring (electron/main.ts passes closures it already has)

export interface JournalExtrasPorts {
  sink: JournalSink;
  characterId(): string | null;
  /** The recognizer the voice route uses now. */
  engine(): 'local' | 'compatible';
  /** Milliseconds since the app's process started. */
  uptimeMs(): number;
  /** The pet window's answer to a new blush cue (electron/companion.ts noteBlushStage). */
  blushStage(stage: unknown): void;
  timers?: ConstructorParameters<typeof ReadingJournal>[2];
}

/** Everything main.ts needs for this batch, behind a few calls. Each call is safe to make whether or not the journal is on. */
export class JournalExtras {
  /** Whether the latest reply was read aloud (shared/turn-awareness.ts), for the next turn's perception line. */
  readonly lastReading = new LastReplyReading();
  readonly reading: ReadingJournal;
  readonly voiceTime: VoiceTimeJournal;
  readonly replyClock: ReplyClock;
  private launched = false;
  constructor(private readonly ports: JournalExtrasPorts) {
    this.reading = new ReadingJournal(ports.sink, ports.characterId, ports.timers, this.lastReading);
    this.voiceTime = new VoiceTimeJournal(ports.sink, ports.characterId, ports.engine);
    this.replyClock = new ReplyClock(Date.now() - ports.uptimeMs());
  }

  /** A per-segment speech timing record from the pet window (validated here; main.ts hands it over untouched). */
  speechRecord(value: unknown): void {
    const record = validateSpeechDiagnosticRecord(value);
    if (record) this.reading.segment(record);
  }

  /** The first-character line's extra numbers (ms from the send; the two spans are read once per reply). */
  firstChar(record: { firstContentMs: number | null; firstBubbleMs: number | null }): { contentMs?: number; bubbleMs?: number; sinceStartMs: number; sinceLastMs?: number } {
    return { ...(record.firstContentMs === null ? {} : { contentMs: record.firstContentMs }), ...(record.firstBubbleMs === null ? {} : { bubbleMs: record.firstBubbleMs }),
      ...this.replyClock.take() };
  }

  /** A fact from a window. `fromPet`: the sender is the pet window (only it may tell about the stage and the launch). */
  fact(kind: unknown, value: unknown, fromPet: boolean): boolean {
    try {
      if (kind === 'voice-capture') {
        const v = value && typeof value === 'object' ? value as Record<string, unknown> : null;
        if (!v) return false;
        return !!this.ports.sink.record({ type: 'voice-capture', characterId: this.ports.characterId(), end: v.end, chunks: v.chunks, peak: v.peak, rms: v.rms, threshold: v.threshold,
          sampleRate: v.sampleRate, device: v.device, pausedAtStart: v.pausedAtStart, pausedMs: v.pausedMs, seconds: v.seconds } as JournalInput);
      }
      if (!fromPet) return false;
      if (kind === 'blush-stage') { this.ports.blushStage(value); return true; }
      if (kind === 'launch' && !this.launched) {
        this.launched = true;
        return !!this.ports.sink.record(launchTimeInput(this.ports.characterId(), this.ports.uptimeMs()));
      }
    } catch { /* never blocks the window */ }
    return false;
  }
}
