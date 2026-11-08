import { createHash, randomUUID } from "node:crypto";
import { validateWav } from "./asr";
import type { FinalVoiceSegment, VoiceCancelReason, VoiceCaptureBinding, VoiceGroupSeal, VoicePcmReceipt, VoicePcmSubmission } from "../shared/voice-segments";

interface Capture extends VoiceCaptureBinding { owner: number; lastCaptureSeq: number; faulted: boolean; }
interface Group {
  id: string; epoch: string; pending: number; finalSeq: number; textLength: number;
  seal?: VoiceGroupSeal["reason"]; frozen: boolean;
}
interface Job {
  capture: Capture; group: Group; segmentId: string; captureSeq: number;
  wav: ArrayBuffer | null; controller: AbortController;
}
interface Remembered {
  hash: string; settled: boolean;
  receipt: Extract<VoicePcmReceipt, { state: "queued" | "duplicate" }>;
}
export interface VoiceSegmentRuntimeOptions {
  transcribe(wav: ArrayBuffer, signal: AbortSignal): Promise<string>;
  final(value: FinalVoiceSegment): void;
  seal(value: VoiceGroupSeal): void;
  cancel(value: { groupId: string; epoch: string; reason: VoiceCancelReason | "asr-failed" | "delivery-failed" | "text-overflow" }): void;
  fault(value: { reason: "asr-failed" | "delivery-failed" | "text-overflow"; unpublishedText?: string }): void;
  speechStarted(): void;
  id?(): string;
}

/** Three bounded PCM jobs, one recognizer request; no device/provider ownership. */
export class VoiceSegmentRuntime {
  private capture?: Capture;
  private currentGroup?: Group;
  private groups = new Map<string, Group>();
  private remembered = new Map<number, Remembered>();
  private queue: Job[] = [];
  private inFlight?: Job;
  private running = false;
  private readonly id: () => string;

  constructor(private readonly options: VoiceSegmentRuntimeOptions) { this.id = options.id ?? randomUUID; }

  open(owner: number, epoch: string): VoiceCaptureBinding {
    if (!Number.isSafeInteger(owner) || owner <= 0 || typeof epoch !== "string" || !epoch || epoch.length > 128) throw Error("Invalid host voice scope.");
    this.cancel("scope-change");
    this.capture = { owner, epoch, captureSessionId: this.id(), lastCaptureSeq: 0, faulted: false };
    return { captureSessionId: this.capture.captureSessionId, epoch };
  }

  submit(owner: number, value: VoicePcmSubmission): VoicePcmReceipt {
    const capture = this.capture;
    if (!capture || capture.owner !== owner || value?.captureSessionId !== capture.captureSessionId) return { state: "rejected", reason: "wrong-scope" };
    if (capture.faulted) return { state: "rejected", reason: "unavailable" };
    if (!Number.isSafeInteger(value.captureSeq) || value.captureSeq < 1) return { state: "rejected", reason: "gap" };
    let wav: ArrayBuffer;
    try {
      wav = validateWav(value.wav);
      // The existing renderer emits canonical WAV. Fifteen seconds including
      // its header bounds the owned queue to 3 × 480044 bytes.
      if (wav.byteLength > 480044) return { state: "rejected", reason: "invalid-audio" };
      wav = wav.slice(0);
    } catch { return { state: "rejected", reason: "invalid-audio" }; }
    const hash = createHash("sha256").update(new Uint8Array(wav)).digest("hex");
    const previous = this.remembered.get(value.captureSeq);
    if (previous) return previous.hash === hash ? { ...previous.receipt, state: "duplicate" } : { state: "rejected", reason: "conflict" };
    if (value.captureSeq <= capture.lastCaptureSeq) return { state: "rejected", reason: "stale" };
    if (value.captureSeq !== capture.lastCaptureSeq + 1) return { state: "rejected", reason: "gap" };
    if (this.queue.length + (this.inFlight ? 1 : 0) >= 3) return { state: "rejected", reason: "overflow" };
    const group = this.group(capture);
    // An ordinary endpoint may be extended while accepted PCM is draining.
    // Explicit finish already detached currentGroup and can never reopen it.
    group.seal = undefined;
    const receipt = { state: "queued" as const, groupId: group.id, segmentId: this.id(), captureSeq: value.captureSeq };
    this.remembered.set(value.captureSeq, { hash, receipt, settled: false });
    capture.lastCaptureSeq = value.captureSeq; group.pending++;
    this.queue.push({ capture, group, segmentId: receipt.segmentId, captureSeq: value.captureSeq, wav, controller: new AbortController() });
    void this.pump();
    return { ...receipt };
  }

  endpoint(owner: number, sessionId: string): boolean { return this.requestSeal(owner, sessionId, "host-endpoint"); }
  finishSpeaking(owner: number, sessionId: string): boolean { return this.requestSeal(owner, sessionId, "finish-speaking"); }

  speechStarted(owner: number, sessionId: string): boolean {
    if (!this.matches(owner, sessionId)) return false;
    // A new voiced start can arrive before its PCM segment is ready.
    // Extend an ordinary draining endpoint, never an explicitly frozen group.
    if (this.currentGroup?.seal === "host-endpoint" && !this.currentGroup.frozen)
      this.currentGroup.seal = undefined;
    this.options.speechStarted(); return true;
  }

  cancel(reason: VoiceCancelReason): void {
    const groups = [...this.groups.values()];
    this.capture = undefined; this.currentGroup = undefined;
    this.inFlight?.controller.abort();
    for (const job of this.queue) { job.controller.abort(); job.wav = null; }
    this.queue = []; this.groups.clear(); this.remembered.clear();
    let failed = false, firstError: unknown;
    for (const group of groups) {
      try { this.options.cancel({ groupId: group.id, epoch: group.epoch, reason }); }
      catch (error) { if (!failed) firstError = error; failed = true; }
    }
    if (failed) throw firstError;
  }

  view(): { active: boolean; pending: number; running: boolean; faulted: boolean } {
    return { active: !!this.capture, pending: this.queue.length + (this.inFlight ? 1 : 0), running: this.running, faulted: !!this.capture?.faulted };
  }

  private matches(owner: number, sessionId: string): boolean {
    return !!this.capture && !this.capture.faulted && this.capture.owner === owner && this.capture.captureSessionId === sessionId;
  }

  private group(capture: Capture): Group {
    if (!this.currentGroup) {
      this.currentGroup = { id: this.id(), epoch: capture.epoch, pending: 0, finalSeq: 0, textLength: 0, frozen: false };
      this.groups.set(this.currentGroup.id, this.currentGroup);
    }
    return this.currentGroup;
  }

  private requestSeal(owner: number, sessionId: string, reason: VoiceGroupSeal["reason"]): boolean {
    if (!this.matches(owner, sessionId)) return false;
    const capture = this.capture!, group = this.group(capture);
    group.seal = reason;
    if (reason === "finish-speaking") { group.frozen = true; this.currentGroup = undefined; }
    try { this.maybeSeal(group); return true; }
    catch { this.fault(capture, "delivery-failed"); return false; }
  }

  private maybeSeal(group: Group): void {
    if (!group.seal || group.pending || this.capture?.faulted || !this.groups.has(group.id)) return;
    // Detach intake immediately, but retain the group until publication succeeds:
    // a failed seal must still cancel its previously published final segments.
    if (this.currentGroup === group) this.currentGroup = undefined;
    this.options.seal({ groupId: group.id, epoch: group.epoch, lastSeq: group.finalSeq, reason: group.seal });
    if (this.groups.get(group.id) === group) this.groups.delete(group.id);
  }

  private fault(capture: Capture, reason: "asr-failed" | "delivery-failed" | "text-overflow", unpublishedText?: string): void {
    if (this.capture !== capture || capture.faulted) return;
    capture.faulted = true;
    if (this.inFlight?.capture === capture) this.inFlight.controller.abort();
    const groups = [...this.groups.values()]; this.groups.clear(); this.currentGroup = undefined;
    for (const job of this.queue) { job.controller.abort(); job.wav = null; }
    this.queue = [];
    for (const group of groups) { try { this.options.cancel({ groupId: group.id, epoch: group.epoch, reason }); } catch {} }
    try { this.options.fault({ reason, ...(unpublishedText ? { unpublishedText } : {}) }); } catch {}
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!; this.inFlight = job;
        try {
          const text = await this.options.transcribe(job.wav!, job.controller.signal);
          if (this.capture !== job.capture || job.controller.signal.aborted || job.capture.faulted) continue;
          if (typeof text !== "string" || text.length > 4000 || text.includes("\0")) { this.fault(job.capture, "asr-failed"); continue; }
          if (!text.trim()) continue;
          const length = job.group.textLength + (job.group.finalSeq ? 1 : 0) + text.length;
          if (length > 16000) { this.fault(job.capture, "text-overflow", text); continue; }
          job.group.textLength = length; job.group.finalSeq++;
          try { this.options.final({ groupId: job.group.id, segmentId: job.segmentId, seq: job.group.finalSeq, epoch: job.group.epoch, text }); }
          catch { this.fault(job.capture, "delivery-failed", text); }
        } catch {
          if (!job.controller.signal.aborted) this.fault(job.capture, "asr-failed");
        } finally {
          job.wav = null; job.group.pending--;
          if (this.capture === job.capture) {
            const remembered = this.remembered.get(job.captureSeq); if (remembered) remembered.settled = true;
            while (this.remembered.size > 64) {
              const oldest = this.remembered.entries().next().value;
              if (!oldest || !oldest[1].settled) break;
              this.remembered.delete(oldest[0]);
            }
            try { this.maybeSeal(job.group); } catch { this.fault(job.capture, "delivery-failed"); }
          }
          this.inFlight = undefined;
        }
      }
    } finally { this.running = false; }
  }
}
