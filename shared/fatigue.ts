/**
 * Product simulation, not a physiological measurement. Pure, host-owned and character-scoped.
 * Her rhythm (I-022, shared/behaviors/sleep-rhythm/): time off screen counts as rest, and the night's sleep comes easier and goes
 * deeper. Its parameters are fields here; their default values come from that folder's knobs.ts and nowhere else.
 */
import { wakeRateArcsValid, prepareSleepRhythm, sleepRhythmParameters } from './behaviors/sleep-rhythm/rhythm';
import type { SleepRules } from './behaviors/sleep-rhythm/interface';

export type FatiguePhase = 'awake' | 'light-drowsy' | 'drowsy' | 'falling-asleep' | 'asleep' | 'micro-awake';
export interface FatigueClock { readonly monotonicMs: number; readonly localMinute: number }
export interface FatigueChannels { readonly D: number; readonly O: number; readonly E: number; readonly N: number; readonly C: number }
export interface SleepEntryBlockers { readonly chat: boolean; readonly tts: boolean; readonly manualMotion: boolean }
export interface FatigueInput {
  readonly clock: FatigueClock;
  readonly channels: FatigueChannels;
  readonly baseline: FatigueChannels;
  readonly blockers: SleepEntryBlockers;
  readonly mode: 'active' | 'offline';
}
export interface FatigueParameters {
  readonly wakeTauMs: number; readonly restTauMs: number; readonly wakeDecayTauMs: number;
  readonly smoothingTauMs: number; readonly maxFChangePerSecond: number;
  readonly maxActiveGapMs: number; readonly maxOfflineMs: number;
  readonly offlineVirtualRest: boolean; readonly offlineRestQuality: number;
  readonly maxPhaseCorrectionPerSecond: number; readonly nightPeakMinute: number;
  readonly pressureWeight: number; readonly clockWeight: number; readonly wakeWeight: number;
  readonly hormoneCap: number; readonly activityCap: number;
  readonly physicalPulse: number; readonly chatPulse: number; readonly explicitPulse: number;
  readonly maxW: number; readonly enoughWakeW: number;
  readonly wakeEventMaxAgeMs: number; readonly eventRefractoryMs: number;
  readonly interactionHoldMs: number; readonly explicitWakeHoldMs: number;
  readonly lightEnter: number; readonly lightExit: number;
  readonly drowsyEnter: number; readonly drowsyExit: number;
  readonly sleepEnter: number; readonly sleepExit: number;
  readonly lightDwellMs: number; readonly drowsyDwellMs: number; readonly sleepDwellMs: number;
  readonly minAwakeResidenceMs: number; readonly minDrowsyResidenceMs: number;
  readonly fallingDurationMs: number; readonly microDurationMs: number;
  readonly recoveredA: number; readonly recoveredF: number; readonly recoveryDwellMs: number;
  readonly minSleepResidenceMs: number;
  /**
   * I-022 (shared/behaviors/sleep-rhythm/knobs.ts): off-screen rest quality inside the night window (`offlineRestQuality` is the
   * day's), the rest speed of a night's sleep, the night entry thresholds that apply once the user has been away `nightQuietMs`,
   * and how low A must fall before she wakes on her own inside the night window.
   */
  readonly offlineNightRestQuality: number; readonly nightRestScale: number;
  readonly nightSleepEnter: number; readonly nightSleepExit: number;
  readonly nightQuietMs: number; readonly nightRecoveredA: number;
  /**
   * I-043 (shared/behaviors/sleep-rhythm/knobs.ts `wake`): the clock no longer adds sleepiness by itself
   * (`clockSleepWeight` 0; `clockWeight` now only sizes the night window, see nightWindow); it sets how fast sleep pressure A
   * builds while she is awake: × wakeRateDay in the day, rising from wakeRateRiseMinute to × wakeRateNight at
   * wakeRateNightMinute, × wakeRateNight until wakeRateFallMinute, falling back to the day rate by wakeRateDayMinute.
   */
  readonly clockSleepWeight: number;
  readonly wakeRateDay: number; readonly wakeRateNight: number;
  readonly wakeRateRiseMinute: number; readonly wakeRateNightMinute: number;
  readonly wakeRateFallMinute: number; readonly wakeRateDayMinute: number;
}
export const DEFAULT_FATIGUE_PARAMETERS: Readonly<FatigueParameters> = Object.freeze({
  wakeTauMs: 18 * 3_600_000, restTauMs: 3 * 3_600_000, wakeDecayTauMs: 45_000,
  smoothingTauMs: 60_000, maxFChangePerSecond: 0.002,
  maxActiveGapMs: 60_000,
  maxPhaseCorrectionPerSecond: 0.5,
  pressureWeight: 0.88, clockWeight: 0.12, wakeWeight: 0.22,
  hormoneCap: 0.08, activityCap: 0.25,
  physicalPulse: 0.08, chatPulse: 0.12, explicitPulse: 0.15,
  maxW: 0.6, enoughWakeW: 0.30,
  wakeEventMaxAgeMs: 2_000, eventRefractoryMs: 1_000,
  interactionHoldMs: 30_000, explicitWakeHoldMs: 60_000,
  lightEnter: 0.38, lightExit: 0.30, drowsyEnter: 0.58, drowsyExit: 0.48,
  sleepEnter: 0.72, sleepExit: 0.60,
  lightDwellMs: 30_000, drowsyDwellMs: 45_000, sleepDwellMs: 60_000,
  minAwakeResidenceMs: 60_000, minDrowsyResidenceMs: 90_000,
  fallingDurationMs: 30_000, microDurationMs: 12_000,
  recoveredA: 0.18, recoveredF: 0.42, recoveryDwellMs: 60_000,
  minSleepResidenceMs: 300_000,
  // I-043: the clock adds no sleepiness of its own (it sets how fast A builds instead: the wake rate fields, from the knobs).
  clockSleepWeight: 0,
  // I-022: maxOfflineMs, offlineVirtualRest, offlineRestQuality, nightPeakMinute and the night fields, from the knobs.
  ...sleepRhythmParameters(),
});
const phases: readonly FatiguePhase[] = ['awake', 'light-drowsy', 'drowsy', 'falling-asleep', 'asleep', 'micro-awake'];
const channels = ['D', 'O', 'E', 'N', 'C'] as const;
const DAY_MS = 86_400_000, STEP_MS = 1_000, MAX_SEEN = 128;
const clamp = (v: number, low = 0, high = 1) => Math.max(low, Math.min(high, v));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const time = (v: unknown): v is number => finite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER - DAY_MS;
const wrap = (v: number) => ((v % DAY_MS) + DAY_MS) % DAY_MS;
const sleeping = (p: FatiguePhase) => p === 'asleep' || p === 'micro-awake';
function clockValid(c: FatigueClock): void {
  if (!c || !time(c.monotonicMs) || !finite(c.localMinute) || c.localMinute < 0 || c.localMinute >= 1440) throw new TypeError('Invalid fatigue clock');
}
function parameters(p: Readonly<FatigueParameters>): void {
  const defaults = DEFAULT_FATIGUE_PARAMETERS;
  if (!p || Object.keys(p).length !== Object.keys(defaults).length) throw new TypeError('Incomplete fatigue parameters');
  for (const k of Object.keys(defaults) as (keyof FatigueParameters)[]) {
    const v = p[k];
    if (k === 'offlineVirtualRest' ? typeof v !== 'boolean' : !finite(v) || v < 0) throw new TypeError(`Invalid fatigue parameter ${k}`);
  }
  if (p.wakeTauMs < 60_000 || p.restTauMs < 60_000 || p.wakeDecayTauMs < 1_000 || p.smoothingTauMs < 1_000
    || p.maxFChangePerSecond <= 0 || p.maxFChangePerSecond > 0.01 || p.maxActiveGapMs > 300_000
    || p.maxOfflineMs > DAY_MS || p.offlineRestQuality > 1 || p.maxPhaseCorrectionPerSecond > 1
    || p.nightPeakMinute >= 1440 || p.pressureWeight > 1 || p.clockWeight > 0.3 || p.clockSleepWeight > 0.3 || p.wakeWeight > 0.5
    || p.wakeRateDay <= 0 || p.wakeRateDay > 10 || p.wakeRateNight <= 0 || p.wakeRateNight > 10 || !wakeRateArcsValid(p)
    || p.hormoneCap > 0.15 || p.pressureWeight-p.hormoneCap<=p.sleepEnter || p.activityCap > 0.5 || p.maxW > 1 || p.maxW <= 0
    || p.enoughWakeW <= 0 || p.enoughWakeW > p.maxW
    || [p.physicalPulse,p.chatPulse,p.explicitPulse].some(v => v <= 0 || v > 0.2)
    || !(0 <= p.lightExit && p.lightExit < p.lightEnter && p.lightEnter < p.drowsyEnter
      && p.lightExit < p.drowsyExit && p.drowsyExit < p.drowsyEnter && p.drowsyEnter < p.sleepEnter
      && p.drowsyExit < p.sleepExit && p.sleepExit < p.sleepEnter && p.sleepEnter <= 1)
    || p.recoveredA > 1 || p.recoveredF > p.sleepExit
    || p.offlineNightRestQuality > 1 || p.nightRestScale < 0.5 || p.nightRestScale > 3 || p.nightQuietMs > DAY_MS
    || !(p.drowsyEnter < p.nightSleepEnter && p.nightSleepEnter <= p.sleepEnter
      && p.drowsyExit < p.nightSleepExit && p.nightSleepExit < p.nightSleepEnter && p.recoveredF <= p.nightSleepExit)
    || p.nightRecoveredA > p.recoveredA) throw new TypeError('Unsafe fatigue parameter bounds');
}
export interface FatigueState {
  readonly version: 1; readonly A: number; readonly F: number; readonly W: number;
  readonly phase: FatiguePhase; readonly monotonicMs: number; readonly localPhaseMs: number;
  readonly phaseAgeMs: number; readonly candidate: FatiguePhase | null; readonly candidateAgeMs: number;
  readonly wakeHoldMs: number; readonly sleepEntryBlocked: boolean;
  readonly lastWakeAt: number | null; readonly dedupWatermark: number;
  readonly seen: readonly Readonly<{ id: string; at: number }>[];
  /**
   * I-022: since when the user has left her alone (monotonic): her last accepted wake event, or when she came on screen.
   * Only the night entry thresholds read it (nightQuietMs); memory only, never saved.
   */
  readonly quietSinceMs: number;
}
function seal(s: FatigueState): Readonly<FatigueState> {
  return Object.freeze({ ...s, seen: Object.freeze(s.seen.map(v => Object.freeze({ ...v }))) });
}
function stateValid(s: FatigueState): void {
  if (!s || s.version !== 1 || !phases.includes(s.phase) || !time(s.monotonicMs)
    || [s.A,s.F,s.W].some(v => !finite(v) || v < 0 || v > 1)
    || !finite(s.localPhaseMs) || s.localPhaseMs < 0 || s.localPhaseMs >= DAY_MS
    || [s.phaseAgeMs,s.candidateAgeMs,s.wakeHoldMs].some(v => !time(v))
    || s.candidate !== null && !phases.includes(s.candidate)
    || typeof s.sleepEntryBlocked !== 'boolean' || s.lastWakeAt !== null && !time(s.lastWakeAt)
    || !finite(s.dedupWatermark) || s.dedupWatermark < -1 || !Array.isArray(s.seen) || s.seen.length > MAX_SEEN || !time(s.quietSinceMs))
    throw new TypeError('Invalid fatigue state');
}
export function createFatigue(clock: FatigueClock,
  initial: { readonly A?: number; readonly F?: number; readonly W?: number; readonly phase?: FatiguePhase } = {},
  p: Readonly<FatigueParameters> = DEFAULT_FATIGUE_PARAMETERS): Readonly<FatigueState> {
  parameters(p); clockValid(clock);
  const s: FatigueState = { version: 1, A: initial.A ?? 0.25, F: initial.F ?? 0.25, W: initial.W ?? 0,
    phase: initial.phase ?? 'awake', monotonicMs: clock.monotonicMs, localPhaseMs: clock.localMinute * 60_000,
    phaseAgeMs: 0, candidate: null, candidateAgeMs: 0, wakeHoldMs: 0, sleepEntryBlocked: false,
    lastWakeAt: null, dedupWatermark: -1, seen: [], quietSinceMs: clock.monotonicMs };
  stateValid(s); if (s.W > p.maxW) throw new TypeError('Initial W exceeds configured cap');
  return seal(s);
}
function channelEffect(input: FatigueInput, p: Readonly<FatigueParameters>): number {
  const n = {} as Record<keyof FatigueChannels, number>;
  for (const k of channels) {
    const v = input.channels?.[k], b = input.baseline?.[k];
    if (!finite(v) || v < 0 || v > 100 || !finite(b) || b < 5 || b > 95) throw new TypeError(`Invalid fatigue channel ${k}`);
    n[k] = clamp((v - b) / (v >= b ? 100 - b : b), -1, 1);
  }
  // Bounded product affect: relative alertness vs settled/tension presentation.
  return clamp(-0.020*n.D + 0.015*n.O - 0.015*n.E - 0.035*n.N + 0.025*n.C, -p.hormoneCap, p.hormoneCap);
}
/**
 * The two non-pressure terms of F's target at this moment (体验记录 only, nothing reads them back): `clock` = what the body clock adds
 * (clockWeight × the time-of-day need, 0–0.12), `mood` = what her mood channels add (−hormoneCap…hormoneCap).
 */
export function fatigueTerms(state: FatigueState, input: FatigueInput, p: Readonly<FatigueParameters> = DEFAULT_FATIGUE_PARAMETERS): { clock: number; mood: number } {
  const timeNeed = (1+Math.cos(2*Math.PI*(state.localPhaseMs/60_000-p.nightPeakMinute)/1440))/2;
  return { clock: p.clockSleepWeight*timeNeed, mood: channelEffect(input,p) };
}
/** `rules`: this step's thresholds from the rhythm (in the day exactly p.sleepEnter, p.sleepExit and p.recoveredA). */
function transition(s: FatigueState, dt: number, blocked: boolean, p: Readonly<FatigueParameters>, rules: SleepRules): FatigueState {
  let next: FatiguePhase | null = null, dwell = 0;
  switch (s.phase) {
    case 'awake': if (s.F >= p.lightEnter && s.phaseAgeMs >= p.minAwakeResidenceMs) { next='light-drowsy'; dwell=p.lightDwellMs; } break;
    case 'light-drowsy':
      if (s.F <= p.lightExit) { next='awake'; dwell=p.lightDwellMs; }
      else if (s.F >= p.drowsyEnter) { next='drowsy'; dwell=p.drowsyDwellMs; } break;
    case 'drowsy':
      if (s.F <= p.drowsyExit) { next='light-drowsy'; dwell=p.drowsyDwellMs; }
      else if (s.F >= rules.sleepEnter && !blocked && s.W < p.enoughWakeW / 2 && s.phaseAgeMs >= p.minDrowsyResidenceMs) { next='falling-asleep'; dwell=p.sleepDwellMs; } break;
    case 'falling-asleep':
      if (blocked || s.F <= rules.sleepExit) return { ...s, phase:'drowsy', phaseAgeMs:0, candidate:null, candidateAgeMs:0 };
      if (s.phaseAgeMs >= p.fallingDurationMs) { next='asleep'; dwell=0; } break;
    case 'asleep':
      if (s.A <= rules.recoveredA && s.F <= p.recoveredF && s.phaseAgeMs >= p.minSleepResidenceMs) { next='light-drowsy'; dwell=p.recoveryDwellMs; } break;
    case 'micro-awake': if (s.phaseAgeMs >= p.microDurationMs) { next='asleep'; dwell=0; } break;
  }
  const age = next === s.candidate ? s.candidateAgeMs + dt : dt;
  if (next && age >= dwell) return { ...s, phase:next, phaseAgeMs:0, candidate:null, candidateAgeMs:0 };
  return { ...s, candidate:next, candidateAgeMs:next ? Math.min(age, DAY_MS) : 0 };
}
export function advanceFatigue(state: FatigueState, input: FatigueInput,
  p: Readonly<FatigueParameters> = DEFAULT_FATIGUE_PARAMETERS): Readonly<FatigueState> {
  parameters(p); stateValid(state); clockValid(input?.clock);
  if (!input || !['active','offline'].includes(input.mode) || !input.blockers
    || ['chat','tts','manualMotion'].some(k => typeof input.blockers[k as keyof SleepEntryBlockers] !== 'boolean')) throw new TypeError('Invalid fatigue advance');
  const effect = channelEffect(input,p), raw = input.clock.monotonicMs - state.monotonicMs;
  // Rollback never lowers the high-water mark or accrues a second copy of time.
  const elapsed = clamp(raw,0,input.mode === 'offline' ? p.maxOfflineMs : p.maxActiveGapMs);
  const externalBlocked = input.blockers.chat || input.blockers.tts || input.blockers.manualMotion;
  const offline = input.mode === 'offline', rhythm = prepareSleepRhythm(p), end = Math.max(state.monotonicMs,input.clock.monotonicMs);
  let s: FatigueState = { ...state, monotonicMs:end };
  for (let left = elapsed; left > 0;) {
    const dt = Math.min(STEP_MS,left); left -= dt;
    const predicted = wrap(s.localPhaseMs+dt), desired = input.clock.localMinute*60_000 - left;
    const difference = wrap(desired-predicted+DAY_MS/2)-DAY_MS/2;
    const localPhaseMs = wrap(predicted+clamp(difference,-dt*p.maxPhaseCorrectionPerSecond,dt*p.maxPhaseCorrectionPerSecond));
    // I-022: off screen she rests (offlineVirtualRest) at that moment's sleep speed × quality; the night's sleep goes deeper.
    // In the day `rules` is exactly the day thresholds with restScale 1 (× 1 is exact), so the day's numbers are unchanged.
    const night = rhythm.night(localPhaseMs), rules = rhythm.rules(night, end-left-s.quietSinceMs);
    const rest = offline ? p.offlineVirtualRest : sleeping(s.phase);
    const quality = offline ? rhythm.offlineQuality(night) : 1;
    const activity = clamp(1-effect*3,1-p.activityCap,1+p.activityCap);
    const A = offline && !rest ? s.A : rest ? s.A*Math.exp(-dt*quality*rules.restScale/p.restTauMs) : 1-(1-s.A)*Math.exp(-dt*activity*rhythm.wakeRate(localPhaseMs)/p.wakeTauMs);
    const W = s.W*Math.exp(-dt/p.wakeDecayTauMs);
    const timeNeed = (1+Math.cos(2*Math.PI*(localPhaseMs/60_000-p.nightPeakMinute)/1440))/2;
    const target = clamp(p.pressureWeight*A+p.clockSleepWeight*timeNeed+effect-p.wakeWeight*W);
    const change = (target-s.F)*(1-Math.exp(-dt/p.smoothingTauMs));
    const F = offline && !rest ? s.F : clamp(s.F+clamp(change,-p.maxFChangePerSecond*dt/1000,p.maxFChangePerSecond*dt/1000));
    const wakeHoldMs = Math.max(0,s.wakeHoldMs-dt), blocked = externalBlocked || wakeHoldMs>0;
    s = { ...s,A,F,W,localPhaseMs,wakeHoldMs,phaseAgeMs:Math.min(DAY_MS,s.phaseAgeMs+dt),sleepEntryBlocked:blocked };
    // Offline never decides that the character entered or left a visible sleep pose.
    if (!offline) s=transition(s,dt,blocked,p,rules);
  }
  s = { ...s,sleepEntryBlocked:externalBlocked || s.wakeHoldMs>0 };
  // Off screen never starts a transition. Resting off screen while asleep counts toward her sleep residence (so she can stir and
  // wake soon after coming back rested); every other phase restarts its residence. Coming back on screen is the user arriving.
  if (offline) s={...s,candidate:null,candidateAgeMs:0,phaseAgeMs:p.offlineVirtualRest && sleeping(s.phase) ? s.phaseAgeMs : 0,
    quietSinceMs:Math.max(s.quietSinceMs,end)};
  // Even between ticks, a blocker prevents completing a falling-asleep presentation.
  if (s.phase==='falling-asleep' && s.sleepEntryBlocked) s={...s,phase:'drowsy',phaseAgeMs:0,candidate:null,candidateAgeMs:0};
  return seal(s);
}
export interface WakeEvent { readonly id: string; readonly kind: 'physical' | 'direct-chat' | 'explicit-wake'; readonly acceptedAtMonotonicMs: number }
export function acceptWakeEvent(state: FatigueState, event: WakeEvent,
  p: Readonly<FatigueParameters> = DEFAULT_FATIGUE_PARAMETERS): Readonly<FatigueState> {
  parameters(p); stateValid(state);
  if (!event || Object.keys(event).length!==3 || typeof event.id!=='string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(event.id)
    || !['physical','direct-chat','explicit-wake'].includes(event.kind) || !time(event.acceptedAtMonotonicMs)) throw new TypeError('Invalid host wake event');
  const at=event.acceptedAtMonotonicMs;
  if (at>state.monotonicMs || state.monotonicMs-at>p.wakeEventMaxAgeMs || at<=state.dedupWatermark
    || state.seen.some(v=>v.id===event.id) || state.lastWakeAt!==null && at<state.lastWakeAt
    || event.kind!=='explicit-wake' && state.lastWakeAt!==null && at-state.lastWakeAt<p.eventRefractoryMs) return state;
  const pulse=event.kind==='physical'?p.physicalPulse:event.kind==='direct-chat'?p.chatPulse:p.explicitPulse;
  const W=Math.min(p.maxW,state.W+pulse), seen=[...state.seen,{id:event.id,at}];
  let watermark=state.dedupWatermark;
  if (seen.length>MAX_SEEN) watermark=Math.max(watermark,seen.shift()!.at);
  const full=event.kind==='explicit-wake' || sleeping(state.phase) && W>=p.enoughWakeW;
  const phase: FatiguePhase=full?'awake':sleeping(state.phase)?'micro-awake':state.phase==='falling-asleep'?'drowsy':state.phase;
  return seal({...state,W,seen,dedupWatermark:watermark,lastWakeAt:at,phase,quietSinceMs:Math.max(state.quietSinceMs,at),
    wakeHoldMs:Math.max(state.wakeHoldMs,full?p.explicitWakeHoldMs:p.interactionHoldMs),sleepEntryBlocked:true,
    phaseAgeMs:phase===state.phase?state.phaseAgeMs:0,candidate:null,candidateAgeMs:0});
}
export function fatigueSnapshot(s: FatigueState) {
  stateValid(s);
  return Object.freeze({version:1 as const,A:s.A,F:s.F,W:s.W,phase:s.phase,
    sleeping:sleeping(s.phase),gazeAllowed:!sleeping(s.phase),sleepEntryBlocked:s.sleepEntryBlocked,
    fatigueIntensity:s.F});
}
