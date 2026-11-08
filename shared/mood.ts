/** Deterministic experimental Gene rules. All time inputs are Unix milliseconds. */
import { speechIntervalAfterUnanswered } from './behaviors/busy-chat/unanswered';
export const MOOD_CHANNELS = ["D", "O", "E", "N", "C"] as const;
export type MoodChannel = (typeof MOOD_CHANNELS)[number];
export type MoodValues = Record<MoodChannel, number>;
export type MoodPhase = "idle" | "rua" | "cheek" | "food-wait" | "food-ready" | "food-eating";
export type MoodContext = "neutral" | "positive" | "support" | "concern" | "disappointment" | "offense";
export type MoodTendency = "playful" | "close" | "comfortable" | "cautious";
export type MoodLabel = "calm" | "close" | "content" | "happy" | "excited" | "concerned" | "disappointed" | "upset" | "longing" | "sad" | "relieved" | "tense-expectation";
export type MoodAttention = "look" | "motion" | "speech";
/** Host-issued identity of an accepted final audio observation, never a renderer request. */
export interface AmbientSpeechObservation { kind: 'ambient'; sessionId: string; observationId: string }
export interface MoodBlushParameters { enabled: boolean; intensity: number; size: number; riseMs: number; holdMs: number; fadeMs: number; cooldownMs: number }
export interface MoodBlushCue { id: string; at: number; until: number; strength: number; reason: "semantic" | "closeness";
  /** I-037: a blush the reaction table chose peaks at least this deep (0–1, times `strength`) even when the card's intensity is gentler; absent for the mood's own blush. */
  floor?: number }
export interface MoodBlushSnapshot extends MoodBlushCue { ageMs: number; amount: number; profile: MoodBlushParameters }
export interface MoodEventSnapshot { id: string; at: number; ageMs: number; context: MoodContext; delta: MoodValues }

export interface MoodParameters {
  baseline: MoodValues;
  halfLifeMs: MoodValues;
  sensitivity: MoodValues;
  freshness: { retention: number; floor: number; ruaMs: number; foodMs: number; chatMs: number; quietMs: number };
  fastWindowMs: number;
  fastThreshold: number;
  boredom: { graceMs: number; perMinute: number; lookAt: number; motionAt: number; speechAt: number };
  longing: { graceMs: number; perHour: number; longingAt: number; sadAt: number; cryAt: number; cryCooldownMs: number; cryDurationMs: number };
  frequency: { motionIntervalMs: number; speechIntervalMs: number; speechPerHour: number; speechWithoutReply: number };
  weights: Record<MoodTendency, number>;
  evidence: { level: number; trend: number };
  intensity: { expression: number; gaze: number; posture: number; playful: number; text: number };
  interaction: { ruaDoseMs: number; ruaBoredomRelief: number; foodBoredomRelief: number; chatBoredomRelief: number; afterglowMs: number; reunionMs: number; attentionMs: number };
  blush: MoodBlushParameters;
}

export type MoodEvent =
  | { type: "rua"; id: string; effectiveMs: number; reason?: string }
  | { type: "food"; id: string; reason?: string }
  | { type: "chat"; id: string; delta?: Partial<MoodValues>; context?: MoodContext; topic?: string; reason?: string }
  | { type: "appraisal"; id: string; responseTo: string; delta: Partial<MoodValues>; context?: MoodContext; topic?: string; reason?: string }
  | { type: "phase"; id: string; phase: MoodPhase }
  | { type: "attention"; id: string; kind: MoodAttention; source?: AmbientSpeechObservation; claimed?: ClaimedAttention; force?: true };
/**
 * An attention opportunity the host already accepted (and charged) as cue `id`, then handed to the
 * inner loop. A look or small motion that realizes it skips the boredom threshold but still counts
 * in that kind's interval; it never creates a new speech opportunity.
 */
export interface ClaimedAttention { id: string; kind: "motion" | "speech"; at: number }
/** The inner loop decides within one bounded request; an older claim cannot be realized later. */
export const CLAIMED_ATTENTION_MS = 120_000;

interface FreshnessState { doses: number; lastEventAt: number; recoveredAt: number }
interface TrendSample { at: number; delta: MoodValues; id: string; context: MoodContext }
export interface MoodCue { id: string; kind: "satisfied" | "reunion" | "look" | "motion" | "speech"; at: number; until: number; source?: AmbientSpeechObservation }
export interface MoodState {
  version: 1;
  values: MoodValues;
  updatedAt: number;
  lastInteractionAt: number | null;
  onlineIdleMs: number;
  boredom: number;
  longing: number;
  freshness: Record<string, FreshnessState>;
  trend: TrendSample[];
  recentEventIds: string[];
  recentChatIds: string[];
  appraisedChatIds: string[];
  phase: MoodPhase;
  lastRuaAt: number | null;
  reason: { text: string; at: number; context: MoodContext; eventId: string } | null;
  reunion: { id: string; at: number; longing: number; crying: boolean } | null;
  cue: MoodCue | null;
  lastCryingAt: number | null;
  lastLookAt: number | null;
  lastMotionAt: number | null;
  lastSpeechAt: number | null;
  speechTimes: number[];
  unansweredSpeech: number;
  /** A transient expression tied to an accepted event, never another mood channel. */
  blushCue: MoodBlushCue | null;
  lastBlushAt: number | null;
}

export interface MoodSnapshot {
  values: MoodValues;
  trend: MoodValues;
  fast: Record<MoodChannel, "up" | "down" | "steady">;
  boredom: number;
  longing: number;
  primary: MoodLabel;
  companion: MoodTendency | "wistful" | null;
  tendencies: Record<MoodTendency, number>;
  phase: MoodPhase;
  reason: string;
  lastInteractionAt: number | null;
  reunion: MoodState["reunion"];
  cryingCandidate: boolean;
  cue: MoodCue | null;
  attentionCandidate: MoodAttention | null;
  intensity: MoodParameters["intensity"];
  context: MoodContext;
  event: MoodEventSnapshot | null;
  blush: MoodBlushSnapshot | null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_IDS = 256;
const MAX_TRENDS = 128;
const MAX_SOURCES = 32;
const MAX_DOSES = 64;
const values = (n = 0): MoodValues => ({ D: n, O: n, E: n, N: n, C: n });
const clamp = (n: number, low = 0, high = 100) => Math.min(high, Math.max(low, n));
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export const DEFAULT_MOOD_PARAMETERS: MoodParameters = {
  baseline: values(50),
  halfLifeMs: { D: 8 * MINUTE, O: 40 * MINUTE, E: 25 * MINUTE, N: 3 * MINUTE, C: 20 * MINUTE },
  sensitivity: values(1),
  freshness: { retention: 0.6, floor: 0.2, ruaMs: 5 * MINUTE, foodMs: 30 * MINUTE, chatMs: 15 * MINUTE, quietMs: 1_000 },
  fastWindowMs: 10_000,
  fastThreshold: 6,
  boredom: { graceMs: 5 * MINUTE, perMinute: 2, lookAt: 30, motionAt: 55, speechAt: 75 },
  longing: { graceMs: 12 * HOUR, perHour: 1.5, longingAt: 30, sadAt: 60, cryAt: 85, cryCooldownMs: DAY, cryDurationMs: 8_000 },
  frequency: { motionIntervalMs: 5 * MINUTE, speechIntervalMs: 30 * MINUTE, speechPerHour: 2, speechWithoutReply: 1 },
  weights: { playful: 1, close: 1, comfortable: 1, cautious: 1 },
  evidence: { level: 1, trend: 1 },
  intensity: { expression: 50, gaze: 50, posture: 50, playful: 50, text: 50 },
  interaction: { ruaDoseMs: 5_000, ruaBoredomRelief: 20, foodBoredomRelief: 15, chatBoredomRelief: 20, afterglowMs: 4_000, reunionMs: 12_000, attentionMs: 3_000 },
  blush: { enabled: true, intensity: 35, size: 50, riseMs: 450, holdMs: 1_200, fadeMs: 1_800, cooldownMs: MINUTE },
};

export function createMoodState(now: number, parameters: MoodParameters = DEFAULT_MOOD_PARAMETERS): MoodState {
  requireTime(now);
  validateMoodParameters(parameters);
  return { version: 1, values: { ...parameters.baseline }, updatedAt: now, lastInteractionAt: null,
    onlineIdleMs: 0, boredom: 0, longing: 0, freshness: {}, trend: [], recentEventIds: [], recentChatIds: [], appraisedChatIds: [], phase: "idle", lastRuaAt: null,
    reason: null, reunion: null, cue: null, lastCryingAt: null, lastLookAt: null, lastMotionAt: null,
    lastSpeechAt: null, speechTimes: [], unansweredSpeech: 0, blushCue: null, lastBlushAt: null };
}

function requireTime(now: number) {
  if (!finite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER) throw new Error("Invalid mood time");
}

export function validateAmbientSpeechObservation(value: unknown): AmbientSpeechObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ambient speech observation');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 3 || Object.keys(input).some(key => !['kind', 'sessionId', 'observationId'].includes(key))
    || input.kind !== 'ambient' || typeof input.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(input.sessionId)
    || typeof input.observationId !== 'string' || input.observationId.length > 128 || !input.observationId.startsWith(input.sessionId + ':'))
    throw new Error('Invalid ambient speech observation');
  const sequence = input.observationId.slice(input.sessionId.length + 1);
  if (!/^[1-9][0-9]{0,19}$/u.test(sequence) || !Number.isSafeInteger(Number(sequence))) throw new Error('Invalid ambient speech observation');
  return { kind: 'ambient', sessionId: input.sessionId, observationId: input.observationId };
}

/** Accept complete JSON parameters only: unknown fields never become renderer capabilities. */
export function validateMoodParameters(input: unknown): MoodParameters {
  // M001 templates were complete except for this newly introduced expression group.
  // Do not turn this narrow migration into a partial-settings or unknown-field bridge.
  if (input && typeof input === "object" && !Array.isArray(input) && !Object.hasOwn(input, "blush"))
    input = { ...input, blush: { ...DEFAULT_MOOD_PARAMETERS.blush } };
  else if (input && typeof input === "object" && !Array.isArray(input)) {
    const old = (input as Record<string, unknown>).blush;
    if (old && typeof old === "object" && !Array.isArray(old) && !Object.hasOwn(old, "size"))
      input = { ...input, blush: { ...old, size: DEFAULT_MOOD_PARAMETERS.blush.size } };
  }
  function shape(value: unknown, template: unknown, path: string) {
    if (typeof template === "number") {
      if (!finite(value)) throw new Error(`Invalid mood parameter ${path}`);
      return;
    }
    if (typeof template === "boolean") {
      if (typeof value !== "boolean") throw new Error(`Invalid mood parameter ${path}`);
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid mood parameter ${path}`);
    const actual = value as Record<string, unknown>;
    const expected = template as Record<string, unknown>;
    if (Object.keys(actual).length !== Object.keys(expected).length || Object.keys(actual).some(key => !Object.hasOwn(expected, key))) {
      throw new Error(`Unknown or missing mood parameter ${path}`);
    }
    for (const key of Object.keys(expected)) shape(actual[key], expected[key], `${path}.${key}`);
  }
  shape(input, DEFAULT_MOOD_PARAMETERS, "parameters");
  const p = input as MoodParameters;
  const range = (n: number, low: number, high: number, name: string, integer = false) => {
    if (n < low || n > high || (integer && !Number.isInteger(n))) throw new Error(`Mood parameter out of range: ${name}`);
  };
  const halfLifeBounds: Record<MoodChannel, [number, number]> = {
    D: [10_000, 3 * HOUR], O: [30_000, DAY], E: [30_000, 12 * HOUR], N: [5_000, HOUR], C: [30_000, DAY],
  };
  for (const c of MOOD_CHANNELS) {
    range(p.baseline[c], 5, 95, `baseline.${c}`);
    range(p.halfLifeMs[c], ...halfLifeBounds[c], `halfLifeMs.${c}`);
    range(p.sensitivity[c], 0, 4, `sensitivity.${c}`);
  }
  range(p.freshness.retention, 0, 1, "freshness.retention");
  range(p.freshness.floor, 0, 1, "freshness.floor");
  range(p.freshness.ruaMs, 10_000, 2 * HOUR, "freshness.ruaMs");
  range(p.freshness.foodMs, MINUTE, DAY, "freshness.foodMs");
  range(p.freshness.chatMs, 30_000, 12 * HOUR, "freshness.chatMs");
  range(p.freshness.quietMs, 0, MINUTE, "freshness.quietMs");
  range(p.fastWindowMs, 100, MINUTE, "fastWindowMs");
  range(p.fastThreshold, 1, 30, "fastThreshold");
  range(p.boredom.graceMs, 0, 120 * MINUTE, "boredom.graceMs");
  range(p.boredom.perMinute, 0, 20, "boredom.perMinute");
  range(p.longing.graceMs, 0, 168 * HOUR, "longing.graceMs");
  range(p.longing.perHour, 0, 60, "longing.perHour");
  for (const [name, thresholds] of Object.entries({ boredom: [p.boredom.lookAt, p.boredom.motionAt, p.boredom.speechAt], longing: [p.longing.longingAt, p.longing.sadAt, p.longing.cryAt] })) {
    thresholds.forEach(n => range(n, 0, 100, `${name}.threshold`));
    if (thresholds[0] > thresholds[1] || thresholds[1] > thresholds[2]) throw new Error(`Invalid ${name} threshold order`);
  }
  range(p.longing.cryCooldownMs, MINUTE, 30 * DAY, "longing.cryCooldownMs");
  range(p.longing.cryDurationMs, 1_000, 120_000, "longing.cryDurationMs");
  range(p.frequency.motionIntervalMs, 10_000, HOUR, "frequency.motionIntervalMs");
  range(p.frequency.speechIntervalMs, 30_000, DAY, "frequency.speechIntervalMs");
  range(p.frequency.speechPerHour, 0, 30, "frequency.speechPerHour", true);
  range(p.frequency.speechWithoutReply, 0, 10, "frequency.speechWithoutReply", true);
  for (const [key, n] of Object.entries(p.weights)) range(n, 0, 4, `weights.${key}`);
  for (const [key, n] of Object.entries(p.evidence)) range(n, 0, 4, `evidence.${key}`);
  for (const [key, n] of Object.entries(p.intensity)) range(n, 0, 100, `intensity.${key}`);
  range(p.interaction.ruaDoseMs, 1_000, MINUTE, "interaction.ruaDoseMs");
  for (const key of ["ruaBoredomRelief", "foodBoredomRelief", "chatBoredomRelief"] as const) range(p.interaction[key], 0, 100, `interaction.${key}`);
  for (const key of ["afterglowMs", "reunionMs", "attentionMs"] as const) range(p.interaction[key], 0, 120_000, `interaction.${key}`);
  range(p.blush.intensity, 0, 100, "blush.intensity");
  range(p.blush.size, 0, 100, "blush.size");
  range(p.blush.riseMs, 100, 5_000, "blush.riseMs");
  range(p.blush.holdMs, 0, 20_000, "blush.holdMs");
  range(p.blush.fadeMs, 100, 10_000, "blush.fadeMs");
  range(p.blush.cooldownMs, 0, DAY, "blush.cooldownMs");
  return structuredClone(p);
}

function copy(state: MoodState): MoodState { return structuredClone(state); }
function depthCap(p: MoodParameters) {
  if (p.freshness.retention === 1 || p.freshness.floor === 1) return 1;
  if (p.freshness.retention === 0) return 1;
  return Math.min(MAX_DOSES, p.freshness.floor === 0 ? MAX_DOSES : Math.ceil(Math.log(p.freshness.floor) / Math.log(p.freshness.retention)));
}

/** Recovery, source freshness, B and M are independent of renderer frame rate. */
export function advanceMood(state: MoodState, now: number, options: { online: boolean }, p: MoodParameters = DEFAULT_MOOD_PARAMETERS): MoodState {
  requireTime(now);
  const next = copy(state);
  // A clock moving backwards cannot duplicate elapsed time or rewind private history.
  now = Math.max(now, state.updatedAt);
  const elapsed = now - state.updatedAt;
  for (const c of MOOD_CHANNELS) next.values[c] = clamp(p.baseline[c] + (state.values[c] - p.baseline[c]) * Math.pow(2, -elapsed / p.halfLifeMs[c]));
  if (options.online) {
    next.onlineIdleMs += elapsed;
    const eligible = Math.max(0, next.onlineIdleMs - p.boredom.graceMs) - Math.max(0, state.onlineIdleMs - p.boredom.graceMs);
    next.boredom = clamp(state.boredom + eligible / MINUTE * p.boredom.perMinute);
  } else {
    // Relaunch starts quietly; the unanswered-speech budget survives reopening.
    next.boredom = 0;
    next.onlineIdleMs = 0;
    next.phase = "idle";
    next.lastRuaAt = null;
    next.cue = null;
    next.reunion = null;
    next.blushCue = null;
  }
  next.longing = next.lastInteractionAt === null ? 0 : clamp(Math.max(0, now - next.lastInteractionAt - p.longing.graceMs) / HOUR * p.longing.perHour);
  for (const [source, freshness] of Object.entries(next.freshness)) {
    const recoveryMs = source === "rua" ? p.freshness.ruaMs : source === "food" ? p.freshness.foodMs : p.freshness.chatMs;
    const recovering = Math.max(0, now - Math.max(freshness.recoveredAt, freshness.lastEventAt + p.freshness.quietMs));
    freshness.doses = Math.max(0, freshness.doses - recovering / recoveryMs * depthCap(p));
    freshness.recoveredAt = now;
  }
  next.trend = next.trend.filter(sample => sample.at > now - p.fastWindowMs).slice(-MAX_TRENDS);
  next.speechTimes = next.speechTimes.filter(at => at > now - HOUR && at <= now).slice(-30);
  if (next.cue && next.cue.until <= now) next.cue = null;
  if (next.reunion && next.reunion.at + p.interaction.reunionMs <= now) next.reunion = null;
  const blush = p.blush ?? DEFAULT_MOOD_PARAMETERS.blush;
  if (next.blushCue && (next.blushCue.until <= now || !blush.enabled || blush.intensity === 0)) next.blushCue = null;
  next.updatedAt = now;
  return next;
}

function validEvent(event: MoodEvent) {
  if (!event || typeof event !== "object" || typeof event.id !== "string" || !event.id.trim() || event.id.length > 160) throw new Error("Invalid mood event id");
  if ('source' in event && event.source !== undefined) {
    if (event.type !== 'attention' || event.kind !== 'speech') throw new Error('Only speech attention may carry an observation');
    validateAmbientSpeechObservation(event.source);
  }
  if ('claimed' in event && event.claimed !== undefined) {
    const claimed = event.claimed as unknown;
    if (event.type !== 'attention' || event.kind === 'speech' || event.source !== undefined) throw new Error('Only a look or motion may realize a claimed opportunity');
    if (!claimed || typeof claimed !== 'object' || Array.isArray(claimed)) throw new Error('Invalid claimed attention');
    const value = claimed as Record<string, unknown>;
    if (Object.keys(value).length !== 3 || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 160
      || (value.kind !== 'motion' && value.kind !== 'speech') || !finite(value.at) || (value.at as number) < 0) throw new Error('Invalid claimed attention');
  }
  if ('force' in event && event.force !== undefined) {
    // Developer test command only (electron/mood.ts forceAttention): a plain look/motion/speech, never an ambient or claimed one.
    if (event.type !== 'attention' || event.force !== true || event.source !== undefined || event.claimed !== undefined) throw new Error('Invalid forced attention');
  }
  if (event.type === "rua") {
    if (!finite(event.effectiveMs) || event.effectiveMs < 0 || event.effectiveMs > 5_000) throw new Error("Invalid effective rua duration");
  } else if (event.type === "chat" || event.type === "appraisal") {
    if (event.type === "appraisal" && (typeof event.responseTo !== "string" || !event.responseTo || event.responseTo.length > 160)) throw new Error("Invalid appraisal source");
    if (event.context !== undefined && !["neutral", "positive", "support", "concern", "disappointment", "offense"].includes(event.context)) throw new Error("Invalid mood context");
    if (event.topic !== undefined && (typeof event.topic !== "string" || event.topic.length > 80)) throw new Error("Invalid mood topic");
    if (event.delta !== undefined) {
      if (!event.delta || typeof event.delta !== "object" || Array.isArray(event.delta)) throw new Error("Invalid mood delta");
      for (const [key, n] of Object.entries(event.delta)) if (!MOOD_CHANNELS.includes(key as MoodChannel) || !finite(n) || Math.abs(n) > 20) throw new Error("Mood delta must be finite and within ±20");
    }
  } else if (event.type === "phase") {
    if (!["idle", "rua", "cheek", "food-wait", "food-ready", "food-eating"].includes(event.phase)) throw new Error("Invalid mood phase");
  } else if (event.type === "attention") {
    if (!["look", "motion", "speech"].includes(event.kind)) throw new Error("Invalid mood attention");
  } else if (event.type !== "food") throw new Error("Unknown mood event");
  if ("reason" in event && event.reason !== undefined && (typeof event.reason !== "string" || event.reason.length > 200)) throw new Error("Invalid mood reason");
}

/** Integral of whole-dose diminishing returns; splitting a dose does not mint rewards. */
function doseGain(state: MoodState, source: string, amount: number, now: number, p: MoodParameters) {
  const old = state.freshness[source]?.doses ?? 0;
  let remaining = amount;
  let progress = old;
  let gain = 0;
  while (remaining > 1e-10) {
    const step = Math.min(remaining, 1 - (progress % 1) || 1);
    gain += step * Math.max(p.freshness.floor, Math.pow(p.freshness.retention, Math.floor(progress + 1e-10)));
    progress += step;
    remaining -= step;
  }
  state.freshness[source] = { doses: Math.min(depthCap(p), progress), lastEventAt: now, recoveredAt: now };
  const sources = Object.keys(state.freshness);
  if (sources.length > MAX_SOURCES) {
    const evictable = sources.filter(key => key !== "rua" && key !== "food" && key !== source).sort((a, b) => state.freshness[a].lastEventAt - state.freshness[b].lastEventAt);
    for (const key of evictable.slice(0, sources.length - MAX_SOURCES)) delete state.freshness[key];
  }
  return gain;
}

function noteResponse(state: MoodState, eventId: string, now: number, p: MoodParameters, animate = true) {
  const oldM = state.longing;
  if (oldM >= p.longing.longingAt && oldM > 0 && !state.reunion) {
    const crying = oldM >= p.longing.cryAt && (state.lastCryingAt === null || now - state.lastCryingAt >= p.longing.cryCooldownMs);
    state.reunion = { id: eventId, at: now, longing: oldM, crying };
    if (crying) state.lastCryingAt = now;
  }
  state.lastInteractionAt = now;
  state.longing = 0;
  state.onlineIdleMs = 0;
  state.unansweredSpeech = 0;
  if (state.reunion) state.cue = { id: state.reunion.id, kind: "reunion", at: state.reunion.at, until: state.reunion.at + p.interaction.reunionMs };
  else if (animate) state.cue = { id: eventId, kind: "satisfied", at: now, until: now + p.interaction.afterglowMs };
}

/** Analytic headroom saturation: event batching cannot manufacture extra gain. */
function inject(current: number, amount: number, baseline: number) {
  if (amount === 0) return current;
  if (amount > 0) {
    const linear = Math.min(amount, Math.max(0, baseline - current));
    current += linear;
    return clamp(100 - (100 - current) * Math.exp(-(amount - linear) / (100 - baseline)));
  }
  const linear = Math.min(-amount, Math.max(0, current - baseline));
  current -= linear;
  return clamp(current * Math.exp(-(-amount - linear) / baseline));
}

/** The host and renderer share one envelope; rendering never feeds it back as a reward. */
export function getBlushAmount(ageMs: number, strength: number, profile: MoodBlushParameters, floor = 0): number {
  if (!profile.enabled || !finite(ageMs) || !finite(strength) || ageMs < 0 || ![profile.intensity, profile.riseMs, profile.holdMs, profile.fadeMs].every(finite) || profile.intensity <= 0 || profile.riseMs <= 0 || profile.fadeMs <= 0 || profile.holdMs < 0) return 0;
  const total = profile.riseMs + profile.holdMs + profile.fadeMs;
  if (ageMs >= total) return 0;
  const smooth = (value: number) => { const x = clamp(value, 0, 1); return x * x * (3 - 2 * x); };
  const envelope = ageMs < profile.riseMs ? smooth(ageMs / profile.riseMs)
    : ageMs < profile.riseMs + profile.holdMs ? 1 : 1 - smooth((ageMs - profile.riseMs - profile.holdMs) / profile.fadeMs);
  return clamp(Math.max(profile.intensity / 100, finite(floor) ? clamp(floor, 0, 1) : 0) * clamp(strength, 0, 1) * envelope, 0, 1);
}

function maybeBlush(state: MoodState, event: MoodEvent, applied: MoodValues, previousO: number, now: number, p: MoodParameters) {
  const profile = p.blush ?? DEFAULT_MOOD_PARAMETERS.blush;
  if (!profile.enabled || profile.intensity === 0 || state.blushCue || (state.lastBlushAt !== null && now - state.lastBlushAt < profile.cooldownMs)) return;
  const semantic = (event.type === "chat" || event.type === "appraisal") && (event.context === "support" || event.context === "positive")
    && applied.O >= 1 && (applied.O >= 2 || applied.E >= 1);
  // A genuine new rise crossing the existing event threshold can become a candidate.
  // Static high O, food alone, every sample, and natural recovery cannot cross this gate.
  const closeness = event.type === "rua" && applied.O > 0.1 && previousO < p.fastThreshold && previousO + applied.O >= p.fastThreshold;
  if (!semantic && !closeness) return;
  const strength = semantic ? clamp(applied.O / p.fastThreshold, 0.55, 1) : clamp((previousO + applied.O) / p.fastThreshold, 0.55, 1);
  state.blushCue = { id: event.id, at: now, until: now + profile.riseMs + profile.holdMs + profile.fadeMs, strength, reason: semantic ? "semantic" : "closeness" };
  state.lastBlushAt = now;
}

/**
 * I-037: a blush the reaction table chose (shared/behaviors/reactions/), not the two gates of maybeBlush. Same cue, same envelope and
 * the same "only one at a time" rule; nothing else of the state changes. Null when the card has blush off or one is showing now.
 */
export function raiseBlushCue(state: MoodState, id: string, strength: number, now: number, p: MoodParameters = DEFAULT_MOOD_PARAMETERS, floor = 0): MoodState | null {
  const next = advanceMood(state, now, { online: true }, p);
  now = next.updatedAt;
  const profile = p.blush ?? DEFAULT_MOOD_PARAMETERS.blush;
  if (!profile.enabled || profile.intensity === 0 || next.blushCue || typeof id !== "string" || !id) return null;
  next.blushCue = { id, at: now, until: now + profile.riseMs + profile.holdMs + profile.fadeMs, strength: clamp(finite(strength) ? strength : 0.55, 0.3, 1), reason: "semantic",
    ...(finite(floor) && floor > 0 ? { floor: clamp(floor, 0, 1) } : {}) };
  next.lastBlushAt = now;
  return next;
}

export function applyMoodEvent(state: MoodState, event: MoodEvent, now: number, p: MoodParameters = DEFAULT_MOOD_PARAMETERS): MoodState {
  validEvent(event);
  const next = advanceMood(state, now, { online: true }, p);
  now = next.updatedAt;
  if (next.recentEventIds.includes(event.id)) return next;
  // A readiness attempt that fails the existing limits has not consumed an event.
  if (event.type === 'attention' && event.source && !attentionAllowed(next, event.kind, now, p, true)) return next;
  next.recentEventIds = [...next.recentEventIds, event.id].slice(-MAX_IDS);
  if (event.type === "appraisal") {
    if (next.recentChatIds.at(-1) !== event.responseTo || next.appraisedChatIds.includes(event.responseTo)) return next;
    next.appraisedChatIds = [...next.appraisedChatIds, event.responseTo].slice(-64);
  }
  if (event.type === "phase") {
    if (event.phase !== "rua" && event.phase !== "cheek") next.lastRuaAt = null;
    next.phase = event.phase;
    return next;
  }
  if (event.type === "attention") {
    if (event.claimed ? !claimedAttentionAllowed(next, event.kind, event.claimed, now, p)
      : event.force ? !forcedAttentionAllowed(next, event.kind, p) : !attentionAllowed(next, event.kind, now, p, !!event.source)) return next;
    next.cue = { id: event.id, kind: event.kind, at: now, until: now + p.interaction.attentionMs,
      ...(event.source ? { source: validateAmbientSpeechObservation(event.source) } : {}) };
    if (event.kind === "look") next.lastLookAt = now;
    if (event.kind === "motion") next.lastMotionAt = now;
    if (event.kind === "speech") {
      next.lastSpeechAt = now;
      next.speechTimes.push(now);
      next.unansweredSpeech++;
    }
    return next;
  }
  // The host validates physical input. Still enforce feeding/rua mutual exclusion here.
  if (event.type === "rua" && (event.effectiveMs === 0 || next.phase.startsWith("food-"))) return next;
  const delta = values();
  let animate = true;
  let context: MoodContext;
  let reason: string;
  if (event.type === "rua") {
    animate = next.lastRuaAt === null || now - next.lastRuaAt > p.freshness.quietMs;
    next.lastRuaAt = now;
    const dose = event.effectiveMs / p.interaction.ruaDoseMs;
    const gain = doseGain(next, "rua", dose, now, p);
    delta.O = 10 * gain;
    delta.E = 4 * gain;
    next.boredom = clamp(next.boredom - p.interaction.ruaBoredomRelief * dose);
    // Cheek releases reuse the same diminishing source without changing their
    // direct-input phase into scalp contact before the owner sends idle.
    if (next.phase !== "cheek") next.phase = "rua";
    context = "support";
    reason = event.reason ?? "有效摸头";
  } else if (event.type === "food") {
    const gain = doseGain(next, "food", 1, now, p);
    delta.D = 12 * gain;
    delta.E = 6 * gain;
    next.boredom = clamp(next.boredom - p.interaction.foodBoredomRelief);
    next.phase = "food-eating";
    context = "positive";
    reason = event.reason ?? "接受一份点心";
  } else {
    const hasDelta = event.delta && Object.values(event.delta).some(n => n !== 0);
    const gain = event.topic && hasDelta ? doseGain(next, `chat:${event.topic}`, 1, now, p) : 1;
    for (const c of MOOD_CHANNELS) delta[c] = (event.delta?.[c] ?? 0) * gain;
    if (event.type === "chat") {
      next.boredom = clamp(next.boredom - p.interaction.chatBoredomRelief);
      next.recentChatIds = [...next.recentChatIds, event.id].slice(-64);
      if (event.delta !== undefined) next.appraisedChatIds = [...next.appraisedChatIds, event.id].slice(-64);
    }
    context = event.context ?? "neutral";
    reason = event.reason ?? "收到用户回应";
  }
  const applied = values();
  const previousO = next.trend.reduce((sum, sample) => sum + sample.delta.O, 0);
  for (const c of MOOD_CHANNELS) {
    const requested = delta[c] * p.sensitivity[c];
    const updated = inject(next.values[c], requested, p.baseline[c]);
    applied[c] = updated - next.values[c];
    next.values[c] = updated;
  }
  next.trend.push({ at: now, delta: applied, id: event.id, context });
  next.trend = next.trend.slice(-MAX_TRENDS);
  next.reason = { text: reason, at: now, context, eventId: event.id };
  if (event.type !== "appraisal") noteResponse(next, event.id, now, p, animate);
  maybeBlush(next, event, applied, previousO, now, p);
  return next;
}

/**
 * A host-owned lift of the mood: she was soothed (L4, shared/her-needs.ts). The same headroom saturation and per-channel
 * sensitivity as any event, recorded as a positive event of its own (so "最近原因" and the trend show it), but it is not a
 * response from the user: no reply cue, no interaction clock, no boredom relief, no freshness dose (the pat, snack or message
 * that soothed her was already counted as an interaction by its own event). It is deliberately not a MoodEvent type: a new
 * type would need a row in BEHAVIOR_SEMANTICS and with it the personalisation pages.
 */
export function applyMoodLift(state: MoodState, lift: { id: string; delta: Partial<MoodValues>; reason: string; relief?: number; context?: MoodContext }, now: number, p: MoodParameters = DEFAULT_MOOD_PARAMETERS): MoodState {
  if (!lift || typeof lift.id !== "string" || !lift.id.trim() || lift.id.length > 160) throw new Error("Invalid mood lift id");
  if (lift.context !== undefined && !["neutral", "positive", "support", "concern", "disappointment", "offense"].includes(lift.context)) throw new Error("Invalid mood lift context");
  if (typeof lift.reason !== "string" || lift.reason.length > 200) throw new Error("Invalid mood lift reason");
  if (!lift.delta || typeof lift.delta !== "object" || Array.isArray(lift.delta)) throw new Error("Invalid mood lift");
  for (const [key, n] of Object.entries(lift.delta)) if (!MOOD_CHANNELS.includes(key as MoodChannel) || !finite(n) || Math.abs(n) > 20) throw new Error("A mood lift must be finite and within ±20");
  if (lift.relief !== undefined && (!finite(lift.relief) || lift.relief < 0 || lift.relief > 1)) throw new Error("Invalid mood lift relief");
  const next = advanceMood(state, now, { online: true }, p);
  now = next.updatedAt;
  if (next.recentEventIds.includes(lift.id)) return next;
  next.recentEventIds = [...next.recentEventIds, lift.id].slice(-MAX_IDS);
  const applied = values();
  for (const c of MOOD_CHANNELS) {
    const updated = inject(next.values[c], (lift.delta[c] ?? 0) * p.sensitivity[c], p.baseline[c]);
    applied[c] = updated - next.values[c];
    next.values[c] = updated;
  }
  // Only a pure dip is "neutral" (a small let-down raises no face of its own); anything with a gain is a positive moment.
  // A caller may name the context itself (I-027: the 心情调整员's corrections are always "neutral": no moment, no face of their own).
  const amounts = Object.values(lift.delta), context: MoodContext = lift.context ?? (amounts.some(n => n < 0) && !amounts.some(n => n > 0) ? "neutral" : "positive");
  next.trend.push({ at: now, delta: applied, id: lift.id, context });
  next.trend = next.trend.slice(-MAX_TRENDS);
  next.reason = { text: lift.reason, at: now, context, eventId: lift.id };
  // 释然 after being left unanswered (L4): the label "relieved" for the reunion window, with no tears and no reply cue. Never over a
  // real reunion (a long absence: the real one is made by the reply itself) and never over an existing one.
  if (lift.relief !== undefined && !next.reunion && next.longing < p.longing.longingAt)
    next.reunion = { id: lift.id, at: now, longing: 20 + 30 * lift.relief, crying: false };
  return next;
}

function attentionAllowed(state: MoodState, kind: MoodAttention, now: number, p: MoodParameters, ambientSpeech = false) {
  if (state.phase !== "idle" || state.cue || state.reunion) return false;
  if (kind === "look") return state.boredom >= p.boredom.lookAt && (state.lastLookAt === null || now - state.lastLookAt >= p.frequency.motionIntervalMs);
  if (kind === "motion") return state.boredom >= p.boredom.motionAt && (state.lastMotionAt === null || now - state.lastMotionAt >= p.frequency.motionIntervalMs);
  return (ambientSpeech || state.boredom >= p.boredom.speechAt)
    && p.frequency.speechPerHour > 0 && p.frequency.speechWithoutReply > 0
    && state.speechTimes.length < p.frequency.speechPerHour
    // I-039: no hard stop after unanswered lines; each one over speechWithoutReply stretches the interval instead.
    && (state.lastSpeechAt === null || now - state.lastSpeechAt >= speechIntervalAfterUnanswered(p.frequency.speechIntervalMs, state.unansweredSpeech, p.frequency.speechWithoutReply));
}

/**
 * Developer test command ("测试：给她一次说话的时机"): the same opportunity without waiting for it. It skips the boredom
 * threshold and the interval, and keeps everything else: still idle, no cue already showing, no reunion, and a speech
 * opportunity still needs the hourly and unanswered quota (which it then spends like any other).
 */
function forcedAttentionAllowed(state: MoodState, kind: MoodAttention, p: MoodParameters) {
  if (state.phase !== "idle" || state.cue || state.reunion) return false;
  if (kind !== "speech") return true;
  return p.frequency.speechPerHour > 0 && p.frequency.speechWithoutReply > 0
    && state.speechTimes.length < p.frequency.speechPerHour;
}

/**
 * The claimed cue (never shown) may be replaced by the decided look/motion. The same kind reuses the
 * interval it already charged; another kind must satisfy its own interval. Boredom thresholds are not
 * rechecked: the claimed opportunity already passed a higher one (lookAt <= motionAt <= speechAt).
 */
function claimedAttentionAllowed(state: MoodState, kind: MoodAttention, claimed: ClaimedAttention, now: number, p: MoodParameters) {
  if (kind === "speech" || state.phase !== "idle" || state.reunion) return false;
  if (state.cue && state.cue.id !== claimed.id) return false;
  if (claimed.at > now || now - claimed.at > CLAIMED_ATTENTION_MS) return false;
  if ((claimed.kind === "motion" ? state.lastMotionAt : state.lastSpeechAt) !== claimed.at) return false;
  if (kind === claimed.kind) return true;
  const last = kind === "look" ? state.lastLookAt : state.lastMotionAt;
  return last === null || now - last >= p.frequency.motionIntervalMs;
}

/**
 * A claimed speech opportunity that ended without a visible line (the inner loop chose not to speak,
 * its answer was invalid, it timed out or was cancelled) returns its hourly and unanswered quota.
 * The cooldown (lastSpeechAt) stays, so the next opportunity still waits a full speech interval.
 */
export function releaseUnspokenSpeech(state: MoodState, claimed: Pick<ClaimedAttention, "id" | "at">): MoodState {
  const next = copy(state);
  if (!claimed || !finite(claimed.at) || next.lastSpeechAt !== claimed.at) return next;
  const index = next.speechTimes.lastIndexOf(claimed.at);
  if (index < 0) return next;
  next.speechTimes.splice(index, 1);
  if (next.unansweredSpeech > 0 && (next.lastInteractionAt === null || next.lastInteractionAt < claimed.at)) next.unansweredSpeech--;
  return next;
}

/** Pure readiness only. Acceptance still rechecks and accounts atomically in applyMoodEvent. */
export function canRequestAmbientSpeech(state: MoodState, source: AmbientSpeechObservation, now = state.updatedAt, p: MoodParameters = DEFAULT_MOOD_PARAMETERS): boolean {
  try { validateAmbientSpeechObservation(source); } catch { return false; }
  const next = advanceMood(state, now, { online: true }, p);
  return attentionAllowed(next, 'speech', next.updatedAt, p, true);
}

export function getMoodAttentionCandidate(state: MoodState, now = state.updatedAt, p: MoodParameters = DEFAULT_MOOD_PARAMETERS, allowGenericSpeech = true): MoodAttention | null {
  const current = { ...state, cue: state.cue && state.cue.until > now ? state.cue : null,
    reunion: state.reunion && state.reunion.at + p.interaction.reunionMs > now ? state.reunion : null };
  for (const kind of ['speech', 'motion', 'look'] as const)
    if ((kind !== 'speech' || allowGenericSpeech) && attentionAllowed(current, kind, now, p)) return kind;
  return null;
}

export function getMoodSnapshot(state: MoodState, now = state.updatedAt, p: MoodParameters = DEFAULT_MOOD_PARAMETERS): MoodSnapshot {
  requireTime(now);
  now = Math.max(now, state.updatedAt);
  const trend = values();
  for (const sample of state.trend) if (sample.at > now - p.fastWindowMs && sample.at <= now) for (const c of MOOD_CHANNELS) trend[c] += sample.delta[c];
  const fast = {} as MoodSnapshot["fast"];
  const level = values();
  const rising = values();
  for (const c of MOOD_CHANNELS) {
    fast[c] = trend[c] >= p.fastThreshold ? "up" : trend[c] <= -p.fastThreshold ? "down" : "steady";
    const difference = state.values[c] - p.baseline[c];
    const normalized = difference / (difference >= 0 ? 100 - p.baseline[c] : p.baseline[c]);
    // Current level and event trend each have their own dimensionless evidence.
    level[c] = 50 + 50 * normalized * p.evidence.level;
    rising[c] = Math.max(0, trend[c] / p.fastThreshold) * p.evidence.trend;
  }
  const cue = state.cue && state.cue.until > now ? { ...state.cue, ...(state.cue.source ? { source: { ...state.cue.source } } : {}) } : null;
  const reunion = state.reunion && state.reunion.at + p.interaction.reunionMs > now ? { ...state.reunion } : null;
  const context = state.reason && now - state.reason.at <= Math.max(30_000, p.interaction.afterglowMs) ? state.reason.context : "neutral";
  const supportive = context === "positive" || context === "support" || (context === "neutral" && cue?.kind === "satisfied");
  const positive = (c: MoodChannel) => Math.max(0, (level[c] - 50) / 10);
  const tendencies: Record<MoodTendency, number> = {
    playful: supportive ? (positive("D") + 0.25 * rising.D + 0.25 * positive("N")) * p.weights.playful : 0,
    close: (positive("O") + 0.25 * rising.O + (reunion ? reunion.longing / 100 : 0)) * p.weights.close,
    comfortable: (positive("E") + 0.25 * rising.E) * p.weights.comfortable,
    cautious: Math.min(positive("C"), positive("N")) * p.weights.cautious,
  };
  let primary: MoodLabel = "calm";
  if (context === "concern") primary = "concerned";
  else if (context === "offense" && level.C >= 60 && level.N >= 60) primary = "upset";
  else if (context === "disappointment" && level.D <= 40) primary = "disappointed";
  else if (level.C >= 60 && level.N >= 60) primary = supportive && level.D >= 75 ? "tense-expectation" : "concerned";
  else if (reunion) primary = "relieved";
  else if (state.longing >= p.longing.sadAt && state.longing > 0) primary = "sad";
  else if (state.longing >= p.longing.longingAt && state.longing > 0) primary = "longing";
  else if (supportive && level.D >= 75 && level.N >= 60) primary = "excited";
  else if (supportive && level.D >= 60 && level.E >= 55) primary = "happy";
  else if (level.O >= 60 && level.E >= 50 && level.C < 60) primary = "close";
  else if (level.E >= 60 && level.N <= 55 && level.C <= 50) primary = "content";
  // A meaningful event still gets a small confirmation even near saturation/zero style weights.
  const sorted = (Object.entries(tendencies) as [MoodTendency, number][]).sort((a, b) => b[1] - a[1]);
  const companion: MoodSnapshot["companion"] = reunion && reunion.longing >= p.longing.sadAt
    ? "wistful" : sorted[0][1] > 0 ? sorted[0][0] : null;
  const attentionCandidate = getMoodAttentionCandidate(state, now, p);
  const sample = state.reason ? [...state.trend].reverse().find(value => value.id === state.reason!.eventId && value.at > now - p.fastWindowMs && value.at <= now) : null;
  const event = sample ? { id: sample.id, at: sample.at, ageMs: now - sample.at, context: sample.context, delta: { ...sample.delta } } : null;
  const profile = p.blush ?? DEFAULT_MOOD_PARAMETERS.blush;
  const blush = state.blushCue && state.blushCue.until > now && profile.enabled && profile.intensity > 0
    ? { ...state.blushCue, ageMs: now - state.blushCue.at, amount: getBlushAmount(now - state.blushCue.at, state.blushCue.strength, profile, state.blushCue.floor), profile: { ...profile } } : null;
  return { values: { ...state.values }, trend, fast, boredom: state.boredom, longing: state.longing,
    primary, companion, tendencies, phase: state.phase, reason: state.reason?.text ?? "安静陪伴",
    lastInteractionAt: state.lastInteractionAt, reunion,
    cryingCandidate: !!reunion?.crying && now - reunion.at < p.longing.cryDurationMs,
    cue, attentionCandidate, intensity: { ...p.intensity }, context, event, blush };
}

/** Stop optional expression playback without changing values, clocks, history or cooldowns. */
export function cancelMoodExpressions(state: MoodState): MoodState {
  const next = copy(state);
  next.cue = null;
  next.blushCue = null;
  return next;
}

/** JSON-safe private state. Live gestures and already emitted cues do not resume after launch. */
export function serializeMoodState(state: MoodState): MoodState {
  const saved = copy(state);
  saved.phase = "idle";
  saved.lastRuaAt = null;
  saved.trend = [];
  saved.cue = null;
  saved.reunion = null;
  saved.blushCue = null;
  return saved;
}

/** Validate every persisted field used by arithmetic; callers preserve malformed files for recovery. */
export function restoreMoodState(input: unknown, now: number, p: MoodParameters = DEFAULT_MOOD_PARAMETERS): MoodState {
  requireTime(now);
  p = validateMoodParameters(p);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid mood state");
  const data = input as MoodState;
  if (data.version !== 1) throw new Error("Unsupported mood state version");
  const bounded = (n: unknown, min: number, max: number) => finite(n) && n >= min && n <= max;
  const time = (n: unknown) => bounded(n, 0, Number.MAX_SAFE_INTEGER);
  const optionalTime = (n: unknown) => n === null || time(n);
  if (!time(data.updatedAt) || !data.values || !MOOD_CHANNELS.every(c => bounded(data.values[c], 0, 100))
    || !optionalTime(data.lastInteractionAt) || !bounded(data.onlineIdleMs, 0, Number.MAX_SAFE_INTEGER)
    || !bounded(data.boredom, 0, 100) || !bounded(data.longing, 0, 100)
    || ![data.lastCryingAt, data.lastLookAt, data.lastMotionAt, data.lastSpeechAt].every(optionalTime)
    || (data.lastBlushAt !== undefined && !optionalTime(data.lastBlushAt))
    || !Number.isInteger(data.unansweredSpeech) || !bounded(data.unansweredSpeech, 0, 30)
    || !Array.isArray(data.speechTimes) || data.speechTimes.length > 30 || !data.speechTimes.every(time)
    || !Array.isArray(data.recentEventIds) || data.recentEventIds.length > MAX_IDS
    || !data.recentEventIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 160)
    || !Array.isArray(data.recentChatIds) || data.recentChatIds.length > 64
    || !data.recentChatIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 160)
    || !Array.isArray(data.appraisedChatIds) || data.appraisedChatIds.length > 64
    || !data.appraisedChatIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 160)
    || !data.freshness || typeof data.freshness !== "object" || Array.isArray(data.freshness)
    || Object.keys(data.freshness).length > MAX_SOURCES) throw new Error("Invalid persisted mood state");
  for (const [source, freshness] of Object.entries(data.freshness)) {
    if (!(source === "rua" || source === "food" || (source.startsWith("chat:") && source.length <= 85))
      || !freshness || !bounded(freshness.doses, 0, MAX_DOSES) || !time(freshness.lastEventAt) || !time(freshness.recoveredAt)) throw new Error("Invalid persisted mood freshness");
  }
  if (data.reason !== null && (!data.reason || typeof data.reason.text !== "string" || data.reason.text.length > 200
    || !time(data.reason.at) || typeof data.reason.eventId !== "string" || data.reason.eventId.length > 160
    || !["neutral", "positive", "support", "concern", "disappointment", "offense"].includes(data.reason.context))) throw new Error("Invalid persisted mood reason");
  const state = createMoodState(data.updatedAt, p);
  state.values = { ...data.values };
  state.lastInteractionAt = data.lastInteractionAt;
  state.onlineIdleMs = data.onlineIdleMs;
  state.boredom = data.boredom;
  state.longing = data.longing;
  state.freshness = structuredClone(data.freshness);
  state.recentEventIds = [...data.recentEventIds];
  state.recentChatIds = [...data.recentChatIds];
  state.appraisedChatIds = [...data.appraisedChatIds];
  state.reason = data.reason ? { ...data.reason } : null;
  state.lastCryingAt = data.lastCryingAt;
  state.lastLookAt = data.lastLookAt;
  state.lastMotionAt = data.lastMotionAt;
  state.lastSpeechAt = data.lastSpeechAt;
  state.lastBlushAt = data.lastBlushAt ?? null;
  state.speechTimes = [...data.speechTimes];
  state.unansweredSpeech = data.unansweredSpeech;
  return advanceMood(state, now, { online: false }, p);
}

