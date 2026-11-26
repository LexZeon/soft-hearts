// 体验记录 (E2) 第一批新记录项 (2026-11-06, docs/claude/2026-11-06-journal-batch1.md): the hosts' moments that were never written down
// (a reply's reading, a spoken sentence's recognition, a blush that did or did not happen, the small action she chose, ...).
// Every converter copies numbers and closed categories only; shared/memory/journal.ts checks them again before a line is made. Nothing here
// reads a word of chat, an audio sample or a device/app name. A source writes nothing while the user's switch is off (the sink says).
import type { FatiguePhase } from '../../../shared/mood';
import { sendHeldBy, type ChatActionWord, type SendHeld, type SendWaits } from '../../../shared/brain';
import { validateSpeechDiagnosticRecord, type CallLookFields, type SpeechDiagnosticRecord } from '../../../shared/voice';
import type {
  BlushBlock, BlushSource, GestureAnswer, JournalInput, ReadingCancelBy, ReadingProvider, ReadingWhy, TopmostFixOutcome, VoiceTimeResult,
} from '../../../shared/memory/journal';
import type { DraftDrop, DraftKind } from '../../brain';
import type { ReplyCheck } from '../../mood';
import type { FirstCharReuse } from '../../../shared/memory/journal';
import type { JournalSink } from './sources';
import { LastReplyReading, ReadCancelCauses, ReadNotes, ReadingLedger, SegmentTimings } from '../../voice';

const safely = (sink: JournalSink | null | undefined, input: JournalInput) => { try { sink?.record(input); } catch { /* Keeping a record never blocks her. */ } };
const accepting = (sink: JournalSink): boolean => { try { return sink.accepting ? sink.accepting() === true : true; } catch { return false; } };

// ---------------------------------------------------------------- 1. 她的朗读时间

/** After this long without another segment of the reply, its reading is over (a reply's segments follow each other within seconds). */
export const READING_IDLE_MS = 15_000;

interface PendingReading {
  provider: ReadingProvider; chars: number; firstAudioMs: number | null; waitMs: number | null;
  ended: number; cancelled: number; failed: number; heard: boolean;
  /** I-150: the first sound waited this long for the headphones' wake (part of firstAudioMs). */
  wakeHoldMs?: number;
  /** 2026-11-24: the first cancelled sentence's own reason (the window says it), the reply's number, and each sentence's timing. */
  cancelBy?: ReadingCancelBy; reply: number | null; timings: SegmentTimings;
  /** I-209 stage voice: whose reply this is (someone else on the full-screen stage: hers), taken when its first record arrives. */
  characterId: string | null;
}

/**
 * One line per reply, from the per-segment timing records the companion window already sends (src/voice/speech-diagnostics.ts), plus the
 * replies that were not read at all (voice off, companion window hidden). A new reply starts at its first segment; the last one is written
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
    private readonly last?: LastReplyReading,
    /** who cancelled a reading (the host notes it where it cancels; closed words only). */
    private readonly causes?: ReadCancelCauses,
    /** 2026-11-24: the reply's number and whether a failure came after a retry (electron/voice/read-notes.ts). */
    private readonly notes?: ReadNotes) {}

  /** A validated segment record (kind 'reply' only; previews and other speech are not replies). */
  segment(record: Pick<SpeechDiagnosticRecord, 'kind' | 'provider' | 'segmentIndex' | 'textLength' | 'outcome' | 't' | 'wakeHoldMs'> & Partial<Pick<SpeechDiagnosticRecord, 'hostFirstAudioMs' | 'interSegmentGapMs' | 'cancelBy'>>): void {
    const starts = record.segmentIndex === null || record.segmentIndex === 0, who = starts || !this.pending ? this.whose() : this.pending.characterId;
    try { this.last?.segment(who, record); } catch { /* never blocks speech */ }
    try {
      if (record.kind !== 'reply' || !accepting(this.sink)) return;
      if (record.segmentIndex === null || record.segmentIndex === 0) { this.flush(); this.pending = null; }
      if (!this.pending) {
        if (record.segmentIndex !== null && record.segmentIndex > 0) return; // the start of this reply was not seen (the switch was off)
        this.pending = { provider: record.provider, chars: 0, firstAudioMs: record.t.playbackStart ?? null, waitMs: record.t.request ?? null,
          ended: 0, cancelled: 0, failed: 0, heard: false, ...(record.wakeHoldMs ? { wakeHoldMs: record.wakeHoldMs } : {}), reply: this.notes?.latest() ?? null, timings: new SegmentTimings(), characterId: who };
      }
      const p = this.pending;
      p.chars += record.textLength;
      if (record.t.playbackStart !== undefined) p.heard = true;
      if (record.outcome === 'ended') p.ended++; else if (record.outcome === 'cancelled') { p.cancelled++; p.cancelBy ??= record.cancelBy ?? 'unlogged'; } else p.failed++;
      p.timings.add(record);
      this.rearm();
    } catch { /* never blocks speech */ }
  }

  /** A reply that was never handed to the voice: reading off, or the companion window not shown. */
  unread(why: 'off' | 'hidden'): void {
    try { this.last?.unread(this.whose(), why); } catch { /* same */ }
    try {
      this.flush();
      if (!accepting(this.sink)) return;
      this.write({ provider: 'system', chars: 0, firstAudioMs: null, waitMs: null, ended: 0, cancelled: 0, failed: 0, heard: false, reply: null, timings: new SegmentTimings(), characterId: this.whose() }, why);
    } catch { /* same */ }
  }

  /**
   * 2026-11-24 (12:26, a reply shown and never read): one 'unread' row for a reply that never got as far as a sentence record, with the cause
   * (a closed word). `preferNoted`: a cause a window noted since (the user stopped her, a drop the renderer told) wins over `by`.
   */
  notRead(by: ReadingCancelBy, preferNoted: boolean, replyId?: string): void {
    try { // not flush(): a reading in progress belongs to another reply
      if (!accepting(this.sink)) return;
      const noted = this.causes?.take() ?? null;
      safely(this.sink, { type: 'reading-time', characterId: this.notes?.ownerOf(replyId) ?? this.characterId(), firstAudioMs: null, waitMs: null, chars: 0, provider: 'system', result: 'unread', why: 'cancelled',
        firstSinceStart: this.lines++ === 0, cancelBy: preferNoted ? noted ?? by : by });
    } catch { /* same */ }
  }

  /** Writes the reply in progress now (the next reply started, or quitting). */
  flush(): void {
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
    const p = this.pending;
    this.pending = null;
    if (p && accepting(this.sink)) this.write(p, null);
  }

  /** I-209 stage voice: the reply the voice was last offered is someone else's on stage: her id; else the desktop companion's (as before). */
  private whose(): string | null { let owner: string | null = null; try { owner = this.notes?.latestOwner() ?? null; } catch { owner = null; } return owner ?? this.characterId(); }

  private rearm(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => { this.timer = null; this.flush(); }, READING_IDLE_MS);
  }

  private write(p: PendingReading, unread: 'off' | 'hidden' | null): void {
    let why: ReadingWhy | null = unread;
    let cancelBy: ReadingCancelBy | null = null;
    let result: 'played' | 'partial' | 'unread';
    if (unread) result = 'unread';
    else if (p.cancelled === 0 && p.failed === 0 && p.ended > 0) result = 'played';
    else { result = p.heard || p.ended > 0 ? 'partial' : 'unread'; why = p.failed > 0 ? 'failed' : 'cancelled'; if (why === 'cancelled') cancelBy = this.causes?.take() ?? p.cancelBy ?? 'unlogged'; }
    safely(this.sink, { type: 'reading-time', characterId: p.characterId, firstAudioMs: p.firstAudioMs, waitMs: p.waitMs, chars: p.chars,
      provider: p.provider, result, why, firstSinceStart: this.lines++ === 0, ...(cancelBy ? { cancelBy } : {}), ...(p.wakeHoldMs ? { wakeHoldMs: p.wakeHoldMs } : {}),
      ...(why === 'failed' && this.notes?.takeRetriedFailure(p.reply) ? { afterRetry: true as const } : {}), ...(p.reply === null ? {} : { reply: p.reply }) });
    const timings = p.timings.take(p.reply); // 2026-11-24: one more row per reply: each sentence's synthesis time and the silence before it played
    if (timings) safely(this.sink, { type: 'reading-segments', characterId: p.characterId, ...timings });
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

/** The companion window's answer to a new blush cue: could the stage show it, and if not why (see src/stage/blush-seen.ts). */
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

/** The word of a stage answer (shared/actions/her-actions.ts HerActionPlayResult.status) as the journal's closed answer. */
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
  'before-open': 'plan', 'internal-words': 'plan', 'role-ack': 'plan',
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

/**
 * I-161 item 5: how long the latest voice segment's look took (the decision, the capture and the tickets; ms), only for a segment that asked
 * for a clear frame (null otherwise). The next call-turn line takes it once; older than two minutes it is not that turn's. Memory only.
 */
export class CallLookTime {
  private value: { ms: number | null; at: number } | null = null;
  constructor(private readonly clock: () => number = Date.now) {}
  note(ms: number | null): void { this.value = { ms: typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : null, at: this.clock() }; }
  take(): number | null {
    const value = this.value; this.value = null;
    return value && this.clock() - value.at <= 120_000 ? value.ms : null;
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
  /** The companion window's answer to a new blush cue (electron/brain/companion.ts noteBlushStage). */
  blushStage(stage: unknown): void;
  /** I-077: a reaction she had while listening (electron/mood/mood-moments.ts musicReaction checks it); true when it moved her mood. */
  musicReaction?(value: unknown): boolean;
  /** I-081: her attention to you (electron/senses/user-gaze.ts checks it, journals it and turns an eye contact into a gated mood moment). */
  gaze?(value: unknown): boolean;
  /** I-091: a call is on (a call turn's timing is kept only then). */
  callTurn?(): boolean;
  timers?:ConstructorParameters<typeof ReadingJournal>[2];
}

/** Everything main.ts needs for this batch, behind a few calls. Each call is safe to make whether or not the journal is on. */
export class JournalExtras {
  /** Whether the latest reply was read aloud (shared/brain/turn-awareness.ts), for the next turn's perception line. */
  readonly lastReading = new LastReplyReading();
  readonly reading: ReadingJournal;
  /** Where the host says who cancelled a reading (electron/voice/read-cancel-cause.ts); the reading-time line takes it. */
  readonly readCancel = new ReadCancelCauses();
  /** 2026-11-24: a number per reply and the retried-failure note (electron/voice/read-notes.ts), shared with the speech row's writer. */
  readonly readNotes = new ReadNotes(replyId => { this.readCancel.clear(); this.readingLedger.asked(replyId); });
  /** 2026-11-24: every reply handed to her voice ends in a reading row or a row that says why not (electron/voice/reading-ledger.ts). */
  readonly readingLedger: ReadingLedger;
  readonly voiceTime: VoiceTimeJournal;
  readonly replyClock: ReplyClock;
  /** I-161: the latest voice segment's look time, for the next call-turn line. */
  readonly callLook = new CallLookTime();
  /** I-161: one line for a voice segment that considered a look (closed words; shared/voice/call-look-journal.ts). Safe with the journal off. */
  callLookLine(fields: CallLookFields): void {
    try { this.ports.sink.record({ type: 'voice-call', characterId: this.ports.characterId(), event: 'look', ...fields } as JournalInput); } catch { /* journal only */ }
  }
  private launched = false;
  constructor(private readonly ports: JournalExtrasPorts) {
    this.reading = new ReadingJournal(ports.sink, ports.characterId, ports.timers, this.lastReading, this.readCancel, this.readNotes);
    this.readingLedger = new ReadingLedger({ timers: ports.timers ?? { set: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; }, clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
      idleMs: READING_IDLE_MS, write: (by, preferNoted, replyId) => this.reading.notRead(by, preferNoted, replyId) });
    this.voiceTime = new VoiceTimeJournal(ports.sink, ports.characterId, ports.engine);
    this.replyClock = new ReplyClock(Date.now() - ports.uptimeMs());
  }

  /** A per-segment speech timing record from the companion window (validated here; main.ts hands it over untouched). */
  speechRecord(value: unknown): void {
    const record = validateSpeechDiagnosticRecord(value);
    if (record) this.reading.segment(record);
  }

  /**
   * The first-character line's extra numbers (ms from the send; the two spans are read once per reply). First-char measuring
   * (2026-11-09, docs/claude/2026-11-09-first-char-drift.md): for a Claude reply also whether its process was new, the turn inside
   * it, when Claude's first delta came, how many characters this turn sent and what the process had counted before. Numbers only.
   */
  firstChar(record: { endedBy?: 'settle-timeout'; firstContentMs: number | null; firstBubbleMs: number | null; origin?: 'renderer-send' | 'host-receipt'; sendToHostMs?: number | null; sendWaits?: SendWaits;
    claude?: { process: 'cold' | 'prewarmed' | 'warm'; sessionTurn: number; firstDeltaMs: number | null; inputChars?: number; sessionChars?: number; reuse?: FirstCharReuse; image?: boolean; model?: string } }):
    { endedBy?: 'settle-timeout'; contentMs?: number; bubbleMs?: number; sendMs?: number; held?: SendHeld; heldMs?: number; sinceStartMs: number; sinceLastMs?: number; process?: 'cold' | 'prewarmed' | 'warm'; turn?: number; deltaMs?: number; inputChars?: number; sessionChars?: number; reuse?: FirstCharReuse; image?: boolean; model?: string } {
    const c = record.claude;
    // 2026-11-22 (a first reply at 12 s, ≥4 s of it before the host had the message): the send → host span (settings save, the look, IPC).
    // And which of the window's waits held it longest (docs/claude/2026-11-22-typed-line-drops.md), so a slow turn names its cause.
    const send = record.origin === 'renderer-send' && typeof record.sendToHostMs === 'number' ? { sendMs: record.sendToHostMs, ...(sendHeldBy(record.sendToHostMs, record.sendWaits) ?? {}) } : {};
    return { ...(record.endedBy === 'settle-timeout' ? { endedBy: record.endedBy } : {}), ...(record.firstContentMs === null ? {} : { contentMs: record.firstContentMs }), ...(record.firstBubbleMs === null ? {} : { bubbleMs: record.firstBubbleMs }), ...send,
      ...this.replyClock.take(),
      ...(c ? { process: c.process, turn: c.sessionTurn, ...(c.firstDeltaMs === null ? {} : { deltaMs: c.firstDeltaMs }),
        ...(c.inputChars === undefined ? {} : { inputChars: c.inputChars }), ...(c.sessionChars === undefined ? {} : { sessionChars: c.sessionChars }),
        ...(c.reuse === undefined ? {} : { reuse: c.reuse }), ...(c.image === undefined ? {} : { image: c.image }), ...(c.model === undefined ? {} : { model: c.model }) } : {}) };
  }

  /** A fact from a window. `fromPet`: the sender is the companion window (only it may tell about the stage and the launch). */
  fact(kind: unknown, value: unknown, fromPet: boolean): boolean {
    try {
      if (kind === 'voice-capture') {
        const v = value && typeof value === 'object' ? value as Record<string, unknown> : null;
        if (!v) return false;
        return !!this.ports.sink.record({ type: 'voice-capture', characterId: this.ports.characterId(), end: v.end, chunks: v.chunks, peak: v.peak, rms: v.rms, threshold: v.threshold,
          sampleRate: v.sampleRate, device: v.device, pausedAtStart: v.pausedAtStart, pausedMs: v.pausedMs, seconds: v.seconds } as JournalInput);
      }
      if (kind === 'voice-call-turn') { // I-091: one call turn's timing from the window that owns the call; shared/memory/journal.ts keeps numbers only
        const v = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
        if (!v || this.ports.callTurn?.() !== true) return false;
        return !!this.ports.sink.record({ type: 'voice-call', characterId: this.ports.characterId(), event: 'turn', endpointMs: v.endpointMs, handInMs: v.handInMs,
          textMs: v.textMs, fillerMs: v.fillerMs, firstCharMs: v.firstCharMs, firstSoundMs: v.firstSoundMs, soundAfterCharMs: v.soundAfterCharMs, earlyRead: v.earlyRead, bargeIn: v.bargeIn,
          endToSoundMs: v.endToSoundMs, vad: v.vad, endBy: v.endBy, smartTurnOff: v.smartTurnOff, lookMs: this.callLook.take() } as JournalInput); // I-161: the host's own number, never the window's
      }
      if (kind === 'reading-dropped') { // 2026-11-24: a window dropped a reply's reading before it began; the word is the cause the ledger files if the voice is never asked (src/voice/reading-dropped.ts)
        const why = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).why : null;
        if (why !== 'not-shown' && why !== 'chat-busy' && why !== 'not-ready' && why !== 'switch') return false;
        this.readCancel.note(why); return true;
      }
      if (kind === 'send-dropped') { // 2026-11-22: a typed line that did not go out (either window); shared/brain/journal-entries.ts keeps only the closed words and a number
        const v = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
        return !!v && !!this.ports.sink.record({ type: 'send-dropped', characterId: this.ports.characterId(), why: v.why, from: v.from, waitMs: v.waitMs } as JournalInput);
      }
      if (!fromPet) return false;
      if (kind === 'music-verdict') { // I-053: numbers and a closed reason; shared/memory/journal.ts rebuilds the line from checked fields only
        const v = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
        if (!v) return false;
        return !!this.ports.sink.record({ type: 'music-verdict', characterId: this.ports.characterId(), music: v.music, score: v.score, beat: v.beat, speech: v.speech, soundS: v.soundS,
          ...(v.music === false ? { why: v.reason } : {}) } as JournalInput);
      }
      if (kind === 'blush-stage') { this.ports.blushStage(value); return true; }
      if (kind === 'mouth-reading') { // 2026-11-22 嘴型记录: closed words and numbers per stretch; shared/stage/journal-entries.ts rebuilds the line from checked fields only
        const v = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
        return !!v && !!this.ports.sink.record({ type: 'mouth-reading', characterId: this.ports.characterId(), sentences: v.sentences } as JournalInput);
      }
      if (kind === 'music-reaction') return this.ports.musicReaction?.(value) === true; // I-077: the host gates and scales it; the moment journals itself
      if (kind === 'gaze') return this.ports.gaze?.(value) === true; // I-081: closed words only; never a position
      if (kind === 'launch' && !this.launched) {
        this.launched = true;
        return !!this.ports.sink.record(launchTimeInput(this.ports.characterId(), this.ports.uptimeMs()));
      }
    } catch { /* never blocks the window */ }
    return false;
  }
}
