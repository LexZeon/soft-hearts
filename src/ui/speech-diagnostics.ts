import { summarizeSpeechStages, type SpeechDiagnosticRecord, type SpeechDiagnosticStage, type SpeechStageSummary } from "../../shared/speech-diagnostics";

/**
 * R02 per-stage speech timing on ONE clock (the renderer's `now()`), one
 * timeline per utterance or reply segment. The host decides whether a finished
 * record is written (developer mode); this side never holds text.
 */
export interface SpeechTimelineInit {
  provider: SpeechDiagnosticRecord["provider"];
  voice: string;
  kind: SpeechDiagnosticRecord["kind"];
  segmentIndex: number | null;
  textLength: number;
  /** Groups the segments of one reply for gap and send→audio; never recorded. */
  replyId?: string;
  at: number;
}

/** Stages that keep their latest value; every other stage keeps its first. */
const LATEST: ReadonlySet<SpeechDiagnosticStage> = new Set(["lipSyncStop"]);
const SEND_MARK_MAX_AGE_MS = 10 * 60_000;

export class SpeechTimeline {
  readonly origin: number;
  readonly init: Readonly<SpeechTimelineInit>;
  private readonly at: Partial<Record<SpeechDiagnosticStage, number>> = {};
  hostFirstAudioMs: number | null = null;
  baseLatencyMs: number | null = null;
  outputLatencyMs: number | null = null;
  clockLagMs: number | null = null;
  startLeadMs: number | null = null;
  deviceColdStartMs: number | null = null;
  errorCode: string | null = null;
  stalls = 0;
  quickEnd = false;
  closed = false;
  /** B06 feed pauses while this record was playing, their total length, and system-voice pause fallbacks. */
  feedPauses = 0;
  feedPausedMs = 0;
  pauseFallbacks = 0;
  private pausedSince: number | null = null;
  /** System voice: the reply's frozen mood multipliers on rate and pitch (null: not applied). */
  rateScale: number | null = null;
  pitchScale: number | null = null;
  constructor(init: SpeechTimelineInit) {
    this.init = Object.freeze({ ...init });
    this.origin = init.at;
    this.at.queued = init.at;
  }
  mark(stage: SpeechDiagnosticStage, at: number): void {
    if (this.closed || !Number.isFinite(at)) return;
    if (this.at[stage] === undefined || LATEST.has(stage)) this.at[stage] = at;
  }
  time(stage: SpeechDiagnosticStage): number | undefined { return this.at[stage]; }
  feedPause(at: number): void {
    if (this.closed || this.pausedSince !== null || !Number.isFinite(at)) return;
    this.feedPauses++; this.pausedSince = at;
  }
  feedResume(at: number): void {
    if (this.pausedSince === null || !Number.isFinite(at)) return;
    this.feedPausedMs += Math.max(0, at - this.pausedSince); this.pausedSince = null;
  }
  /** Stage → ms since `queued`. */
  relative(): SpeechDiagnosticRecord["t"] {
    const t: SpeechDiagnosticRecord["t"] = {};
    for (const [stage, at] of Object.entries(this.at) as [SpeechDiagnosticStage, number][]) t[stage] = Math.max(0, Math.round(at - this.origin));
    return t;
  }
  summary(): SpeechStageSummary {
    return summarizeSpeechStages({ t: this.relative(), hostFirstAudioMs: this.hostFirstAudioMs,
      outputLatencyMs: this.outputLatencyMs, baseLatencyMs: this.baseLatencyMs });
  }
}

export interface SpeechDiagnosticsOptions {
  now(): number;
  /** Finished records; errors are swallowed (diagnostics never affect playback). */
  sink?(record: SpeechDiagnosticRecord): void | Promise<void>;
}

export class SpeechDiagnostics {
  private sendAt: number | null = null;
  private lastEnd: { replyId: string; at: number } | null = null;
  constructor(private readonly options: SpeechDiagnosticsOptions) {}

  /** The user sent a chat: the next reply's first audio is measured from here. */
  noteSend(at = this.options.now()): void { this.sendAt = at; }

  open(init: Omit<SpeechTimelineInit, "at"> & { at?: number }): SpeechTimeline {
    return new SpeechTimeline({ ...init, voice: String(init.voice ?? "").replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 160),
      textLength: Math.max(0, Math.min(6000, Math.round(init.textLength) || 0)), at: init.at ?? this.options.now() });
  }

  /** Finish a timeline once; returns the record that was handed to the sink. */
  close(timeline: SpeechTimeline | null | undefined, outcome: SpeechDiagnosticRecord["outcome"], at = this.options.now()): SpeechDiagnosticRecord | null {
    if (!timeline || timeline.closed) return null;
    timeline.feedResume(at);
    timeline.mark(outcome, at);
    if (timeline.time("lipSyncStart") !== undefined && timeline.time("lipSyncStop") === undefined) timeline.mark("lipSyncStop", at);
    timeline.closed = true;
    const { replyId, segmentIndex } = timeline.init;
    const audible = timeline.time("playbackStart");
    let sendToFirstAudioMs: number | null = null, interSegmentGapMs: number | null = null;
    if (replyId && (segmentIndex === null || segmentIndex === 0) && timeline.init.kind === "reply" && this.sendAt !== null) {
      if (audible !== undefined && audible >= this.sendAt && audible - this.sendAt <= SEND_MARK_MAX_AGE_MS) sendToFirstAudioMs = audible - this.sendAt;
      this.sendAt = null;
    }
    if (replyId && segmentIndex !== null && segmentIndex > 0 && this.lastEnd?.replyId === replyId && audible !== undefined)
      interSegmentGapMs = Math.max(0, audible - this.lastEnd.at);
    if (replyId) this.lastEnd = outcome === "ended" ? { replyId, at: timeline.time("ended") ?? at } : null;
    const code = timeline.errorCode ?? (outcome === "error" ? "failed" : null);
    const round = (value: number | null) => value === null || !Number.isFinite(value) ? null : Math.round(value);
    const record: SpeechDiagnosticRecord = {
      v: 1, provider: timeline.init.provider, voice: timeline.init.voice, kind: timeline.init.kind,
      segmentIndex, textLength: timeline.init.textLength, outcome,
      errorCode: code === null ? null : code.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").slice(0, 40) || "failed",
      t: timeline.relative(), hostFirstAudioMs: round(timeline.hostFirstAudioMs), baseLatencyMs: round(timeline.baseLatencyMs),
      outputLatencyMs: round(timeline.outputLatencyMs), clockLagMs: round(timeline.clockLagMs), startLeadMs: round(timeline.startLeadMs),
      deviceColdStartMs: round(timeline.deviceColdStartMs), sendToFirstAudioMs: round(sendToFirstAudioMs),
      interSegmentGapMs: round(interSegmentGapMs), stalls: timeline.stalls, quickEnd: timeline.quickEnd,
      // Optional numbers, present only when they apply (records stay unchanged otherwise).
      ...(timeline.feedPauses || timeline.pauseFallbacks ? { feedPauses: timeline.feedPauses, feedPausedMs: Math.round(timeline.feedPausedMs),
        pauseFallbacks: timeline.pauseFallbacks } : {}),
      ...(timeline.rateScale !== null && timeline.pitchScale !== null
        ? { rateScale: Math.round(timeline.rateScale * 1000) / 1000, pitchScale: Math.round(timeline.pitchScale * 1000) / 1000 } : {}),
    };
    try { void Promise.resolve(this.options.sink?.(record)).catch(() => {}); } catch { /* Diagnostics are best effort. */ }
    return record;
  }
}
