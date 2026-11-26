/**
 * 心情第二批 (docs/claude/2026-11-11-mood-batch2.md): the host side of shared/foundation/mood-moments.ts. MoodHost owns one; the places where a
 * moment happens call it (a return, a real sleep that ended, a dance or a song she nodded to, her special-day line, a keepsake, a
 * diary entry, a blush, a reply without a usable tail). Each one: the gate (cooldown and per-day count, per character and family),
 * the amount read relative to the card's baseline, then MoodHost.lift with an id of its own family. Never throws into the caller.
 */
import {
  BackWatch, MOOD_MOMENTS, MOOD_MOMENT_KNOBS, MOOD_MOMENT_REASONS, MOOD_TAILLESS, MOOD_TAILLESS_BY_LABEL, MoodMomentGate, MusicWatch, SleepWatch,
  relativeMomentDelta, type MoodMomentKind, type MoodMomentSpec,
} from '../../shared/foundation/mood-moments';
import type { MoodContext, MoodLabel, MoodValues } from '../../shared/foundation/mood';

export interface MoodMomentLift { id: string; delta: Partial<MoodValues>; reason: string; context?: MoodContext; keepReason?: boolean; longingEase?: number }
export interface MoodMomentsPort {
  clock(): number;
  /** The current character ('' when none). */
  current(): string;
  /** Her values, the card's baseline and evidence, and her label now; null when this character is not known. */
  state(characterId: string): { values: MoodValues; baseline: MoodValues; evidence: number; primary: MoodLabel } | null;
  /** MoodHost.lift; true when it changed her mood (the id was new and something moved). */
  lift(lift: MoodMomentLift, characterId: string): boolean;
}
export interface MoodMomentNote { kind: MoodMomentKind; characterId: string; applied: boolean; why?: 'gate' | 'nothing' | 'unknown' }

const safeId = (value: string) => value.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 100) || 'x';

export class MoodMoments {
  private readonly gate = new MoodMomentGate();
  private readonly sleep = new SleepWatch();
  private readonly music = new MusicWatch();
  private readonly back = new BackWatch();
  private seq = 0;
  /** The last few moments (developer checks and tests; memory only). */
  readonly recent: MoodMomentNote[] = [];
  constructor(private readonly port: MoodMomentsPort) {}

  /** One moment of `kind` for `characterId` (default: the current one). `key` makes the id (a message id, a date…). */
  note(kind: Exclude<MoodMomentKind, 'tailless'>, characterId = this.current(), key?: string): boolean {
    return this.apply(kind, MOOD_MOMENTS[kind], null, characterId, key);
  }

  /** I-066: the presence judgment each second; its first 'back' after a real absence is the return. */
  presence(view: { presence?: string; awayMinutes?: number; pretended?: boolean } | null | undefined): boolean {
    let away: number | null = null;
    try { away = this.back.see(view); } catch { away = null; }
    return away !== null && this.note('back', this.current(), `away${away}`);
  }
  /** The camera saw the user arrive after `awayMs` away (pose sensing); null = not known (a developer simulation): no moment. */
  arrive(characterId: string, awayMs: number | null): boolean {
    if (awayMs === null || !Number.isFinite(awayMs) || awayMs < MOOD_MOMENT_KNOBS.backAwayMinutes * 60_000) return false;
    return this.note('back', characterId, 'pose');
  }
  /**
   * Her real sleep phase after each fatigue step (never the developer's test look). `woken` (I-078 第 2 步, electron/mood/fatigue-host.ts):
   * the user ended this sleep. Woken while her sleep pressure was still above restedA is "没睡够" (the woken lift, from
   * wokenMinSleepMs of sleep); otherwise (her own waking, or woken once rested) the ordinary wake lift (from wakeMinSleepMs).
   */
  fatigue(characterId: string, phase: string, phaseAgeMs: number, woken?: { readonly A: number } | null): boolean {
    let slept: number | null = null;
    try { slept = this.sleep.see(characterId, phase, phaseAgeMs, this.port.clock()); } catch { slept = null; }
    if (slept === null) return false;
    const early = !!woken && Number.isFinite(woken.A) && woken.A > MOOD_MOMENT_KNOBS.restedA;
    if (early) return slept >= MOOD_MOMENT_KNOBS.wokenMinSleepMs && this.note('woken', characterId);
    return slept >= MOOD_MOMENT_KNOBS.wakeMinSleepMs && this.note('wake', characterId);
  }
  /**
   * I-078 第 2 步: a gentle pat while she slept that did not wake her (she sleeps more soundly). `contact` is the accepted touch's
   * identity, so one pat is one moment (the gate's cooldown and the lift id both hold it to once).
   */
  sleepSoothed(characterId: string, contact: string): boolean { return this.note('sleep-soothed', characterId, contact); }
  /** I-081: an eye contact the companion window saw while pose sensing says you face her (electron/senses/user-gaze.ts checks that first). */
  eyeContact(characterId = this.current()): boolean { return !!characterId && this.note('eye-contact', characterId); }
  /** The companion window's music tier (none / nod / dance), as the journal gets it. */
  musicTier(value: unknown, characterId = this.current()): boolean {
    if (!characterId || !value || typeof value !== 'object') return false;
    const tier = (value as { tier?: unknown }).tier;
    if (tier !== 'none' && tier !== 'nod' && tier !== 'dance') return false;
    let ended: { kind: 'dance' | 'song' } | null = null;
    try { ended = this.music.see(characterId, tier, this.port.clock()); } catch { ended = null; }
    return !!ended && this.note(ended.kind, characterId);
  }
  /**
   * I-077: a reaction she had while listening, from the companion window's stage (src/stage/music-react/). Only `{ intent }` with a closed
   * intent is taken; each kind has its own gate (enjoy shares the dance / song group: one moment, never two for one song).
   */
  musicReaction(value: unknown, characterId = this.current()): boolean {
    if (!characterId || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'intent' && key !== 'scale')) return false;
    const { intent, scale } = value as { intent?: unknown; scale?: unknown };
    const kind = intent === 'lift' ? 'music-lift' : intent === 'settle' ? 'music-settle' : intent === 'enjoy' ? 'music-enjoy' : intent === 'moved' ? 'music-moved'
      : intent === 'recognize' ? 'music-recognize' : null;
    if (kind === null) return false;
    // I-077 step 2: her taste scales the one moment (a liked song lifts a little more, one she does not care for a little less); never a second moment.
    if (scale === undefined) return this.note(kind, characterId);
    if (typeof scale !== 'number' || !Number.isFinite(scale)) return false;
    const factor = Math.min(MOOD_MOMENT_KNOBS.tasteScale[1], Math.max(MOOD_MOMENT_KNOBS.tasteScale[0], scale)), spec = MOOD_MOMENTS[kind];
    return this.apply(kind, { ...spec, delta: Object.fromEntries(Object.entries(spec.delta).map(([channel, amount]) => [channel, (amount as number) * factor])) }, null, characterId);
  }
  /** A blush cue was raised (the mood's own or the reaction table's). */
  shy(characterId: string, cueId: string): boolean { return this.note('shy', characterId, cueId); }
  /** A complete reply whose tail could not be used: a tiny lift by her label now (one per message). */
  tailless(characterId: string, messageId: string): boolean {
    const state = this.read(characterId);
    if (!state) return this.done('tailless', characterId, false, 'unknown');
    return this.apply('tailless', { ...MOOD_TAILLESS, delta: MOOD_TAILLESS_BY_LABEL[state.primary] ?? MOOD_TAILLESS_BY_LABEL.calm }, state, characterId, messageId);
  }

  private current(): string { try { return this.port.current() || ''; } catch { return ''; } }
  private read(characterId: string) { try { return characterId ? this.port.state(characterId) : null; } catch { return null; } }
  private apply(kind: MoodMomentKind, spec: MoodMomentSpec, known: ReturnType<MoodMomentsPort['state']>, characterId: string, key?: string): boolean {
    const state = known ?? this.read(characterId);
    if (!state) return this.done(kind, characterId, false, 'unknown');
    const delta = relativeMomentDelta(spec.delta, state.values, state.baseline, state.evidence);
    if (!Object.keys(delta).length && !spec.longingEase) return this.done(kind, characterId, false, 'nothing');
    let now: number;
    try { now = this.port.clock(); } catch { return this.done(kind, characterId, false, 'unknown'); }
    if (!this.gate.take(characterId, spec, now)) return this.done(kind, characterId, false, 'gate');
    const id = `moment-${kind}-${safeId(key ?? `${now}-${++this.seq}`)}`.slice(0, 160);
    let applied = false;
    try {
      applied = this.port.lift({ id, delta, reason: MOOD_MOMENT_REASONS[kind], ...(spec.context && !spec.keepReason ? { context: spec.context } : {}),
        ...(spec.keepReason ? { keepReason: true } : {}), ...(spec.longingEase ? { longingEase: spec.longingEase } : {}) }, characterId);
    } catch { applied = false; }
    return this.done(kind, characterId, applied);
  }
  private done(kind: MoodMomentKind, characterId: string, applied: boolean, why?: MoodMomentNote['why']): boolean {
    this.recent.push({ kind, characterId, applied, ...(why ? { why } : {}) });
    if (this.recent.length > 20) this.recent.shift();
    return applied;
  }
}
