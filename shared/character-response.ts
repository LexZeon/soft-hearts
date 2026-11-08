import type { MoodContext, MoodLabel, MoodParameters, MoodPhase, MoodSnapshot, MoodTendency } from './mood';
import { MOOD_LABELS } from './mood-runtime';

/** M006's host contact phase; cheek-hover remains renderer-only. */
export type CharacterResponsePhase = MoodPhase | 'cheek';
export type CharacterResponseIntensity = keyof MoodParameters['intensity'];
export type CharacterResponseSnapshot = Omit<MoodSnapshot, 'phase'> & { phase: CharacterResponsePhase };

export const MAX_CHARACTER_RESPONSE_RULES = 24;
export const CHARACTER_RESPONSE_MOODS = Object.freeze(Object.keys(MOOD_LABELS) as MoodLabel[]);
export const CHARACTER_RESPONSE_PHASES = ['idle', 'rua', 'food-wait', 'food-ready', 'food-eating', 'cheek'] as const satisfies readonly CharacterResponsePhase[];
export const CHARACTER_RESPONSE_CONTEXTS = ['neutral', 'positive', 'support', 'concern', 'disappointment', 'offense'] as const satisfies readonly MoodContext[];
export const CHARACTER_RESPONSE_TENDENCIES = ['playful', 'close', 'comfortable', 'cautious'] as const satisfies readonly MoodTendency[];
export const CHARACTER_RESPONSE_INTENSITIES = ['expression', 'gaze', 'posture', 'playful', 'text'] as const satisfies readonly CharacterResponseIntensity[];

export interface CharacterResponseWhen {
  mood: MoodLabel;
  /** Absence means every implemented host phase. */
  phase?: CharacterResponsePhase;
  /** Absence means every existing semantic context. */
  context?: MoodContext;
}
export interface CharacterResponseRule {
  when: CharacterResponseWhen;
  tendencyScale: Record<MoodTendency, number>;
  intensityScale: Record<CharacterResponseIntensity, number>;
}
/** Portable expression preferences only; never current values, clocks or history. */
export interface CharacterResponseProfile {
  version: 1;
  rules: CharacterResponseRule[];
}
/** Host-owned editor state; it is not a portable card or saved interaction state. */
export interface CharacterResponseState {
  characterId: string;
  revision: number;
  profile: CharacterResponseProfile;
  storageError?: string;
  /** Unsaved retry/editor data only; never used by effective snapshot playback. */
  pendingProfile?: CharacterResponseProfile;
  notice?: string;
}

export function defaultCharacterResponseProfile(): CharacterResponseProfile {
  return { version: 1, rules: [] };
}

export function defaultCharacterResponseRule(when: CharacterResponseWhen): CharacterResponseRule {
  return validateRule({
    when,
    tendencyScale: { playful: 1, close: 1, comfortable: 1, cautious: 1 },
    intensityScale: { expression: 1, gaze: 1, posture: 1, playful: 1, text: 1 },
  }, 'rule');
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new Error(`Invalid character response ${location}`);
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], location: string): void {
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !Object.hasOwn(value, key))
    || keys.some(key => typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))))
    throw new Error(`Unknown or missing character response field ${location}`);
  if (keys.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor || !Object.hasOwn(descriptor, 'value');
  })) throw new Error(`Character response fields must contain data only: ${location}`);
}

function scales<K extends string>(value: unknown, keys: readonly K[], maximum: number, location: string): Record<K, number> {
  const input = record(value, location);
  fields(input, keys, [], location);
  const result = {} as Record<K, number>;
  for (const key of keys) {
    const scale = input[key];
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0 || scale > maximum)
      throw new Error(`Character response scale out of range: ${location}.${key}`);
    result[key] = scale === 0 ? 0 : scale;
  }
  return result;
}

function validateRule(value: unknown, location: string): CharacterResponseRule {
  const rule = record(value, location);
  fields(rule, ['when', 'tendencyScale', 'intensityScale'], [], location);
  const input = record(rule.when, `${location}.when`);
  fields(input, ['mood'], ['phase', 'context'], `${location}.when`);
  if (typeof input.mood !== 'string' || !Object.hasOwn(MOOD_LABELS, input.mood))
    throw new Error(`Invalid character response mood: ${location}`);
  const when: CharacterResponseWhen = { mood: input.mood as MoodLabel };
  if (Object.hasOwn(input, 'phase')) {
    if (typeof input.phase !== 'string' || !(CHARACTER_RESPONSE_PHASES as readonly string[]).includes(input.phase))
      throw new Error(`Invalid character response phase: ${location}`);
    when.phase = input.phase as CharacterResponsePhase;
  }
  if (Object.hasOwn(input, 'context')) {
    if (typeof input.context !== 'string' || !(CHARACTER_RESPONSE_CONTEXTS as readonly string[]).includes(input.context))
      throw new Error(`Invalid character response context: ${location}`);
    when.context = input.context as MoodContext;
  }
  return {
    when,
    tendencyScale: scales(rule.tendencyScale, CHARACTER_RESPONSE_TENDENCIES, 4, `${location}.tendencyScale`),
    intensityScale: scales(rule.intensityScale, CHARACTER_RESPONSE_INTENSITIES, 2, `${location}.intensityScale`),
  };
}

/** Stable selector identity; array order never supplies an implicit priority. */
export function characterResponseRuleKey(when: CharacterResponseWhen): string {
  return JSON.stringify([when.mood, when.phase ?? null, when.context ?? null]);
}

export function validateCharacterResponseProfile(value: unknown): CharacterResponseProfile {
  const input = record(value, 'profile');
  fields(input, ['version', 'rules'], [], 'profile');
  if (input.version !== 1 || !Array.isArray(input.rules) || input.rules.length > MAX_CHARACTER_RESPONSE_RULES)
    throw new Error(`Character response profile requires version 1 and at most ${MAX_CHARACTER_RESPONSE_RULES} rules`);
  const keys = new Set<string>();
  const rules = Array.from(input.rules, (value, index) => {
    const rule = validateRule(value, `rules[${index}]`);
    const key = characterResponseRuleKey(rule.when);
    if (keys.has(key)) throw new Error('Duplicate character response condition');
    keys.add(key);
    return rule;
  });
  return { version: 1, rules };
}

/** Match one rule: more conditions win; a context wins a phase-only tie. */
export function matchCharacterResponseRule(
  snapshot: Pick<CharacterResponseSnapshot, 'primary' | 'phase' | 'context'>,
  profile?: CharacterResponseProfile | null,
): CharacterResponseRule | null {
  let selected: CharacterResponseRule | null = null;
  let rank = -1;
  for (const rule of profile?.rules ?? []) {
    const { when } = rule;
    if (when.mood !== snapshot.primary || (when.phase !== undefined && when.phase !== snapshot.phase)
      || (when.context !== undefined && when.context !== snapshot.context)) continue;
    const nextRank = (Number(when.phase !== undefined) + Number(when.context !== undefined)) * 2
      + Number(when.context !== undefined);
    if (nextRank > rank) { selected = rule; rank = nextRank; }
  }
  return selected;
}

export function applyMoodResponse(snapshot: MoodSnapshot, profile?: CharacterResponseProfile | null): MoodSnapshot;
export function applyMoodResponse(snapshot: CharacterResponseSnapshot, profile?: CharacterResponseProfile | null): CharacterResponseSnapshot;
/** Apply a host-validated profile to the final base snapshot, never to state or event input. */
export function applyMoodResponse(snapshot: CharacterResponseSnapshot, profile?: CharacterResponseProfile | null): CharacterResponseSnapshot {
  const rule = matchCharacterResponseRule(snapshot, profile);
  if (!rule) return snapshot;
  const tendencies = { ...snapshot.tendencies };
  const intensity = { ...snapshot.intensity };
  let tendenciesChanged = false, intensityChanged = false;
  for (const key of CHARACTER_RESPONSE_TENDENCIES) {
    // An absent base signal/disabled common weight cannot be revived by scaling.
    const next = snapshot.tendencies[key] === 0 || rule.tendencyScale[key] === 0
      ? 0 : snapshot.tendencies[key] * rule.tendencyScale[key];
    tendenciesChanged ||= next !== tendencies[key];
    tendencies[key] = next;
  }
  for (const key of CHARACTER_RESPONSE_INTENSITIES) {
    const next = Math.max(0, Math.min(100, snapshot.intensity[key] * rule.intensityScale[key]));
    intensityChanged ||= next !== intensity[key];
    intensity[key] = next;
  }
  if (!tendenciesChanged && !intensityChanged) return snapshot;
  let companion = snapshot.companion;
  if (tendenciesChanged && companion !== 'wistful') {
    let best: MoodTendency | null = null, strongest = 0;
    for (const key of CHARACTER_RESPONSE_TENDENCIES) {
      if (tendencies[key] > strongest) { strongest = tendencies[key]; best = key; }
    }
    companion = best;
  }
  return { ...snapshot, tendencies, intensity, companion };
}
