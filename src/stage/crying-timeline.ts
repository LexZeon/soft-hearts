import type { MoodSnapshot } from '../../shared/mood';

export type CryingSnapshot = Pick<MoodSnapshot, 'reunion' | 'cryingCandidate' | 'lastInteractionAt' | 'event'>;
export interface CryingTimelineInput {
  /** Character/provider context from the host, never a renderer-created reward ID. */
  token: string;
  /** Stable host character identity survives token/model invalidation. */
  characterId: string;
  nowMs: number;
  snapshot: CryingSnapshot | null;
  durationMs: number;
  reunionMs: number;
  expressionIntensity: number;
  allowed: boolean;
  visible: boolean;
  supported: boolean;
  faceBlocked: boolean;
}
export interface CryingFrame {
  id: string | null;
  phase: 'idle' | 'rise' | 'hold' | 'fade';
  amount: number;
  elapsedMs: number;
  durationMs: number;
  comforted: boolean;
}

interface CryingCue {
  key: string;
  token: string;
  id: string;
  at: number;
  elapsedMs: number;
  durationMs: number;
  intensity: number;
  riseMs: number;
  fadeMs: number;
  settleAt: number | null;
  settleDurationMs: number;
  comforted: boolean;
}

const FRESH_START_MS = 1_500;
const RETAINED_CUES = 64;
const idle = (): CryingFrame => ({ id: null, phase: 'idle', amount: 0, elapsedMs: 0, durationMs: 0, comforted: false });
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const smooth = (fraction: number) => { const t = clamp(fraction, 0, 1); return t * t * (3 - 2 * t); };
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * One bounded presentation clock per stage. Consuming a cue never writes back to
 * the host: the host already owns the accepted event, M and crying cooldown.
 */
export class CryingTimeline {
  private active: CryingCue | null = null;
  private token: string | null = null;
  private characterId: string | null = null;
  private readonly consumed = new Set<string>();
  private latestCueAt = -1;
  private nowWatermark = 0;

  /** Immediate lifecycle cancellation deliberately retains consumed identities. */
  cancel(): void { this.active = null; }

  update(input: CryingTimelineInput, deltaSeconds = 0): CryingFrame {
    const validToken = typeof input.token === 'string' && input.token.length > 0 && input.token.length <= 2_048;
    const validCharacter = typeof input.characterId === 'string' && input.characterId.length > 0 && input.characterId.length <= 160;
    const changedContext = (this.token !== null && this.token !== input.token) ||
      (this.characterId !== null && this.characterId !== input.characterId);
    if (changedContext || !validToken || !validCharacter) this.cancel();
    this.token = validToken ? input.token : null;
    this.characterId = validCharacter ? input.characterId : null;

    const validNow = time(input.nowMs);
    if (validNow) this.nowWatermark = Math.max(this.nowWatermark, input.nowMs);
    const now = this.nowWatermark;
    const reunion = input.snapshot?.reunion;
    const validReunion = !!reunion && reunion.crying && typeof reunion.id === 'string' && reunion.id.length > 0 &&
      reunion.id.length <= 160 && time(reunion.at);
    // Only the accepted host event identifies this presentation. A resent or
    // corrected timestamp may shorten eligibility, never mint a second cue.
    const key = validCharacter && validReunion ? JSON.stringify([input.characterId, reunion.id]) : null;
    const unseen = key !== null && !this.consumed.has(key);
    const previousCueAt = this.latestCueAt;
    // Observe before eligibility checks: hidden, unsupported and manually blocked
    // cues must not start later when their blocking condition disappears.
    if (unseen) {
      this.consumed.add(key);
      if (this.consumed.size > RETAINED_CUES) this.consumed.delete(this.consumed.values().next().value!);
      if (validNow && reunion!.at <= now) this.latestCueAt = Math.max(this.latestCueAt, reunion!.at);
    }

    const allowed = validToken && validCharacter && validNow && input.allowed && input.visible && input.supported && !input.faceBlocked &&
      Number.isFinite(input.expressionIntensity) && input.expressionIntensity > 0;
    if (!allowed) { this.cancel(); return idle(); }

    const deltaMs = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds * 1_000 : 0;
    if (this.active) this.active.elapsedMs = Math.max(this.active.elapsedMs + deltaMs, now - this.active.at);

    const validDuration = Number.isFinite(input.durationMs) && input.durationMs >= 1_000 && input.durationMs <= 120_000 &&
      Number.isFinite(input.reunionMs) && input.reunionMs >= 0 && input.reunionMs <= 120_000;
    // The host expires reunion state at this earlier deadline. Freeze both
    // clocks at admission so parameter edits cannot lengthen a running cue.
    const durationMs = Math.min(input.durationMs, input.reunionMs);
    const age = validReunion ? now - reunion!.at : Infinity;
    if (unseen && !changedContext && input.snapshot!.cryingCandidate && validDuration && age >= 0 && age <= FRESH_START_MS &&
      reunion!.at <= input.nowMs && age < durationMs && reunion!.at >= previousCueAt) {
      this.active = {
        key: key!, token: input.token, id: reunion!.id, at: reunion!.at, elapsedMs: age,
        durationMs, intensity: clamp(input.expressionIntensity / 50, 0, 1),
        riseMs: Math.min(650, durationMs * 0.18), fadeMs: Math.min(1_800, durationMs * 0.3),
        settleAt: null, settleDurationMs: 0, comforted: false,
      };
    }

    const cue = this.active;
    if (!cue) return idle();
    if (cue.elapsedMs >= cue.durationMs) { this.cancel(); return idle(); }

    const snapshot = input.snapshot;
    const subsequentResponse = time(snapshot?.lastInteractionAt) && snapshot.lastInteractionAt > cue.at && snapshot.lastInteractionAt <= now;
    const event = snapshot?.event;
    const explicitSupport = !!event && event.id !== cue.id && event.context === 'support' && time(event.at) && event.at >= cue.at && event.at <= now;
    const sourceEnded = !snapshot?.reunion || key !== cue.key || !snapshot.cryingCandidate;
    if (subsequentResponse || explicitSupport) cue.comforted = true;
    if ((cue.comforted || sourceEnded) && cue.settleAt === null) {
      // Keep the initial response perceptible even when continuing rua produces
      // a second accepted dose quickly; comfort then shortens, never extends it.
      cue.settleAt = Math.max(cue.elapsedMs, Math.min(800, cue.durationMs * 0.2));
      cue.settleDurationMs = Math.min(1_200, cue.durationMs - cue.settleAt);
    }

    if (cue.settleAt !== null && cue.elapsedMs >= cue.settleAt) {
      const fadeAge = cue.elapsedMs - cue.settleAt;
      if (fadeAge >= cue.settleDurationMs) { this.cancel(); return idle(); }
      return {
        id: cue.id, phase: 'fade', amount: this.envelope(cue, cue.settleAt) * (1 - smooth(fadeAge / cue.settleDurationMs)),
        elapsedMs: cue.elapsedMs, durationMs: cue.durationMs, comforted: cue.comforted,
      };
    }
    return {
      id: cue.id, phase: cue.elapsedMs < cue.riseMs ? 'rise' : cue.elapsedMs >= cue.durationMs - cue.fadeMs ? 'fade' : 'hold',
      amount: this.envelope(cue, cue.elapsedMs), elapsedMs: cue.elapsedMs, durationMs: cue.durationMs, comforted: cue.comforted,
    };
  }

  private envelope(cue: CryingCue, elapsedMs: number): number {
    return smooth(elapsedMs / cue.riseMs) * (1 - smooth((elapsedMs - cue.durationMs + cue.fadeMs) / cue.fadeMs)) * cue.intensity;
  }
}
