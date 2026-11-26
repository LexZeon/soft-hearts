import { SeededRandom } from '../../stage';
import { choose, hormoneTemper, NEUTRAL_DISPOSITIONS, NEUTRAL_TEMPER, type Choice, type DispositionTemper, type HormoneTemper, type Skip } from './choose';
import { turnOf, type SpeechFaceCue } from './cues';
import { splitClauses, type Clause } from './intent';
import type { SpeechIntent } from './intent-table';
import { SPEECH_FACE_KNOBS } from './knobs';
import { duration, envelope, peakTime, type Variant } from './recipes';
import { LevelTrack } from './timing';

/**
 * I-073 part 3 ("她说话时脸也在演"): sparse accents on the universal face sliders while she speaks, and the one entry point
 * (`perform`) other features can call later (reactions, her small actions, "挑个眉" over the internal channel).
 *
 * Layers (docs/claude/2026-11-11-i073-speaking-expressions-plan.md, each replaceable on its own):
 *   intent (intent.ts, data tables) → recipe (recipes.ts, data) → her pick (choose.ts, hormones relative to her baseline and
 *   her tendencies) → timing (here + timing.ts: a loud point of the voice, a real pause, or the clause's start) → sliders
 *   (procedural-life.ts adds `out` on top of her mood face, under the face's and the head's owners) → the model (missing
 *   sliders are skipped before she picks).
 *
 * The four fixed rules (everything else floats inside ranges):
 *  1. Mouth and jaw stay with lip-sync: there is no mouth channel here at all, and procedural life refuses a face slider
 *     whose morph is a mouth shape (LifeAccentSlots).
 *  2. Spacing: eye/brow starts ≥ faceGap s apart and ≤ faceWindowCount per rolling 10 s; head ≥ headGap s and ≤
 *     headWindowCount per 10 s (so a nod and a tilt never overlap); blush ≤ 1 per sentence and ≥ blushGap s apart; per
 *     clause at most one eye/brow event and one head event.
 *  3. Caps on what is added (hard.caps), applied to the output whatever a recipe or a caller asks for.
 *  4. Interruption (a stop, a new reply), a drag or touch, or her own face/head action: what is pending is dropped and never
 *     played later; what shows eases back from where it is (value and speed continuous, hard.releaseSeconds).
 * Accents tied to the voice start only while the voice is heard (the held "speaking" flag: a stream's short stall is not a
 * pause, a long one drops what falls in it). Too late for an accent = no accent: the voice is never delayed for the face.
 */
/** eyeWide and lidSoft: only the music reactions (I-077, `performPick`) use them; speech never does. */
export type AccentChannel = 'smileEyes' | 'browUp' | 'jitome' | 'blush' | 'headX' | 'headZ' | 'eyeWide' | 'lidSoft';
const CHANNELS: readonly AccentChannel[] = ['smileEyes', 'browUp', 'jitome', 'blush', 'headX', 'headZ', 'eyeWide', 'lidSoft'];
type Family = Variant['family'];
const FAMILY_OF: Readonly<Record<AccentChannel, Family>> = { smileEyes: 'face', browUp: 'face', jitome: 'face', blush: 'blush', headX: 'head', headZ: 'head', eyeWide: 'face', lidSoft: 'face' };
/** What an accent is for: a speech intent, or a music reaction (I-077, `music-<intent>`). */
export type AccentIntent = SpeechIntent | `music-${string}`;
const DEG = Math.PI / 180;

export interface AccentAvailability { smileEyes: boolean; browUp: boolean; jitome: boolean; blush: boolean; head: boolean; eyeWide?: boolean; lidSoft?: boolean }
export interface AccentGates {
  /** The face's owners leave it to the mood face this frame (no touch, preview, picked expression, her own face action...). */
  face: boolean;
  /** The head's owners leave the small head motion to procedural life (no drag, no body motion owning the head...). */
  head: boolean;
  /** The held "she is speaking" flag (speech-hold.ts owner answer). */
  speaking: boolean;
  available: AccentAvailability;
}
export type PerformTiming = { at: 'now' } | { at: 'in'; seconds: number } | { at: 'peak'; seconds: number };
export interface AccentRecord {
  at: number; turn: string; intent: AccentIntent; family: Family; variant: string | null;
  timing: 'peak' | 'boundary' | 'onset' | 'perform';
  outcome: 'started' | 'skipped' | 'dropped' | 'released'; reason?: string; startAt?: number; peakAt?: number; amp?: number;
}

export interface Planned {
  family: Family; variant: Variant; amp: number; timeScale: number; side: number; startAt: number; turn: string; segment: string;
  voiced: boolean; intent: AccentIntent; timing: AccentRecord['timing'];
}
interface ClauseState { clause: Clause; from: number; to: number; families: Map<Family, Choice | 'done'> }
interface Segment { key: string; turn: string; start: number; voiced: boolean; chars: number; clauses: ClauseState[]; blushed: boolean }
interface Release { v0: number; m0: number; t0: number; T: number }

const PERFORM_TURN = '(perform)';
const MUSIC_TURN = '(music)';
const FAMILIES: readonly Family[] = ['face', 'head', 'blush'];
const clamp = (x: number, lo: number, hi: number) => Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : 0;

export class SpeechFace {
  /** This frame's additions: morph weights (0..cap) and head angles in rad (±cap). */
  readonly out: Record<AccentChannel, number> = { smileEyes: 0, browUp: 0, jitome: 0, blush: 0, headX: 0, headZ: 0, eyeWide: 0, lidSoft: 0 };
  /** I-077: the song's mood on her face (continuous, already eased by its owner), added under the same caps; zero when no song. */
  private readonly tint = { smileEyes: 0, lidSoft: 0 };
  /** The last accents (bounded), for diagnostics and tests. */
  readonly ledger: AccentRecord[] = [];
  private now = 0;
  private random: () => number;
  private turn = '';
  private segment: Segment | null = null;
  private readonly levels = new LevelTrack();
  private pending: Planned[] = [];
  private active: (Planned & { started: number })[] = [];
  private readonly starts: Record<Family, number[]> = { face: [], head: [], blush: [] };
  private readonly last: Record<Family, string | null> = { face: null, head: null, blush: null };
  private readonly releases: Partial<Record<AccentChannel, Release>> = {};
  private temper: HormoneTemper = NEUTRAL_TEMPER;
  private dispositions: DispositionTemper = NEUTRAL_DISPOSITIONS;
  private available: AccentAvailability = { smileEyes: true, browUp: true, jitome: true, blush: true, head: true };
  private blocked = false;
  private shown: { key: string; text: string } | null = null;

  constructor(random?: () => number, seed = 0x5eec4fa) {
    const rng = new SeededRandom(seed);
    this.random = random ?? (() => rng.next());
  }

  /** Seconds on the layer's own clock (advanced by `frame`). */
  get clock(): number { return this.now; }

  /** Her mood (the five channels and her card's baseline), fatigue and tendencies, read when she picks. Cheap; call per frame or on change. */
  setContext(context: { values?: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>> | null; baseline?: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>> | null;
    fatigue?: { phase?: string; F?: number; sleeping?: boolean } | null; dispositions?: Partial<DispositionTemper> | null; blocked?: boolean }): void {
    this.temper = hormoneTemper(context.values, context.baseline, context.fatigue);
    const d = context.dispositions;
    this.dispositions = d ? { ...NEUTRAL_DISPOSITIONS, ...Object.fromEntries(Object.entries(d).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))) } : NEUTRAL_DISPOSITIONS;
    if (context.blocked !== undefined) this.blocked = context.blocked === true;
  }

  /** Her own face action (a face shape through the face exclusive) holds the face this frame: the face accents yield (hard rule 4). */
  setBlocked(blocked: boolean): void { this.blocked = blocked === true; }

  /** A fact from the voice output or the bubble (cues.ts). */
  cue(cue: SpeechFaceCue): void {
    if (cue.kind === 'stop') { this.cancelTurn('stop'); return; }
    const turn = turnOf(cue.key);
    if (cue.kind === 'levels') {
      if (turn !== this.turn && this.turn) this.cancelTurn('new-reply');
      this.turn = turn;
      this.levels.add(cue.key, this.now + cue.aheadMs / 1000, cue.stepMs / 1000, cue.levels);
      return;
    }
    if (turn !== this.turn) { if (this.turn) this.cancelTurn('new-reply'); this.turn = turn; }
    // Voice off: the bubble shows a growing prefix; only what is new since the last cue of this key is "shown now".
    let text = cue.text;
    if (!cue.voiced) {
      const before = this.shown?.key === cue.key && text.startsWith(this.shown.text) ? this.shown.text.length : 0;
      this.shown = { key: cue.key, text };
      text = text.slice(before);
      if (!text.trim()) return;
    }
    const clauses = splitClauses(text);
    const chars = Math.max(1, text.length);
    const segment: Segment = { key: cue.key, turn, start: this.now, voiced: cue.voiced, chars, blushed: false,
      clauses: clauses.map(clause => ({ clause, from: this.now, to: this.now, families: new Map() })) };
    this.segment = segment;
    if (!cue.voiced) this.planShown(segment);
  }

  /**
   * The one entry point: do `intent` at `strength` (0..1) at `timing` (now, in N s, or with its accent N s from now).
   * Her pick still applies (she may let it pass), unless `always`; the four hard rules always apply.
   * Returns what was planned (empty when nothing).
   */
  perform(intent: SpeechIntent, strength: number, timing: PerformTiming = { at: 'now' }, options: { always?: boolean; families?: readonly Family[] } = {}): Planned[] {
    const planned: Planned[] = [];
    const weight = clamp(strength, 0, 1);
    for (const family of options.families ?? FAMILIES) {
      const pick = choose(intent, weight, family, this.temper, this.dispositions, this.random, slider => this.has(slider), this.last[family], { always: options.always });
      if (typeof pick === 'string') { this.record({ at: this.now, turn: PERFORM_TURN, intent, family, variant: null, timing: 'perform', outcome: 'skipped', reason: pick }); continue; }
      const rise = peakTime(pick.variant.keys) * pick.timeScale;
      const startAt = timing.at === 'now' ? this.now : timing.at === 'in' ? this.now + Math.max(0, timing.seconds) : this.now + timing.seconds - rise;
      if (startAt < this.now - 1e-9) { this.record({ at: this.now, turn: PERFORM_TURN, intent, family, variant: pick.variant.id, timing: 'perform', outcome: 'skipped', reason: 'late' }); continue; }
      const item = this.plan(pick, family, intent, startAt, PERFORM_TURN, '', false, 'perform', weight);
      planned.push(item);
    }
    return planned;
  }

  /**
   * I-077 (music-react/): a music reaction's face part, already picked by her (music-react/choose.ts): one slider on its envelope at
   * `timing`. The four hard rules apply as to every accent (caps, spacing, yield, never late). Returns what was planned, or null.
   */
  performPick(pick: Choice, timing: PerformTiming, tag: `music-${string}`): Planned | null {
    const family = pick.variant.family;
    if (!this.has(pick.variant.slider)) { this.record({ at: this.now, turn: MUSIC_TURN, intent: tag, family, variant: pick.variant.id, timing: 'perform', outcome: 'skipped', reason: 'unavailable' }); return null; }
    const rise = peakTime(pick.variant.keys) * pick.timeScale;
    const startAt = timing.at === 'now' ? this.now : timing.at === 'in' ? this.now + Math.max(0, timing.seconds) : this.now + timing.seconds - rise;
    if (startAt < this.now - 1e-9) { this.record({ at: this.now, turn: MUSIC_TURN, intent: tag, family, variant: pick.variant.id, timing: 'perform', outcome: 'skipped', reason: 'late' }); return null; }
    return this.plan(pick, family, tag, startAt, MUSIC_TURN, '', false, 'perform', 1);
  }

  /** I-077: the song's mood on her face this frame (smile eyes, soft lids), continuous; 0 / 0 when no song. */
  setTint(smileEyes: number, lidSoft: number): void { this.tint.smileEyes = clamp(smileEyes, 0, 1); this.tint.lidSoft = clamp(lidSoft, 0, 1); }

  /** One rendered frame. */
  frame(delta: number, gates: AccentGates): Readonly<Record<AccentChannel, number>> {
    const dt = Number.isFinite(delta) && delta > 0 ? Math.min(delta, 0.25) : 0;
    this.now += dt;
    this.available = gates.available;
    const faceFree = gates.face && !this.blocked, headFree = gates.head;
    if (!faceFree) { this.cancelFamily('face', 'yield'); this.cancelFamily('blush', 'yield'); }
    if (!headFree) this.cancelFamily('head', 'yield');
    this.planVoiced();
    this.startDue(gates.speaking, faceFree, headFree);
    this.compose();
    this.levels.prune(this.now - 15);
    return this.out;
  }

  /** Everything off now (window hidden, model changed): no release, nothing kept. */
  reset(): void {
    this.pending = []; this.active = []; this.segment = null; this.turn = ''; this.levels.clear(); this.shown = null;
    for (const channel of CHANNELS) { this.out[channel] = 0; delete this.releases[channel]; }
    this.tint.smileEyes = this.tint.lidSoft = 0;
  }

  /** Cancel everything (as an interruption): pending dropped, what shows eases back. */
  cancel(reason = 'cancel'): void { for (const family of FAMILIES) this.cancelFamily(family, reason); this.segment = null; }

  getState(): { clock: number; turn: string; pending: number; active: string[]; out: Record<AccentChannel, number>; last: AccentRecord | null } {
    const round = (x: number) => Math.round(x * 1e4) / 1e4;
    return { clock: round(this.now), turn: this.turn, pending: this.pending.length, active: this.active.map(item => item.variant.id),
      out: Object.fromEntries(CHANNELS.map(c => [c, round(this.out[c])])) as Record<AccentChannel, number>, last: this.ledger.at(-1) ?? null };
  }

  // ------------------------------------------------------------------ internals

  private has(slider: Variant['slider']): boolean {
    const a = this.available;
    return slider === 'nod' || slider === 'tilt' ? a.head : slider === 'blush' ? a.blush : a[slider] === true;
  }

  private record(entry: AccentRecord): void { this.ledger.push(entry); if (this.ledger.length > 400) this.ledger.splice(0, this.ledger.length - 400); }

  private plan(pick: Choice, family: Family, intent: AccentIntent, startAt: number, turn: string, segment: string, voiced: boolean,
    timing: AccentRecord['timing'], gain: number): Planned {
    // The envelope is scaled to fit under its cap (a clipped envelope would stop at full speed); the output clamp stays as the last guard.
    const item: Planned = { family, variant: pick.variant, amp: Math.min(pick.amp, capOf(pick.variant.slider)) * gain, timeScale: pick.timeScale, side: pick.side, startAt, turn, segment, voiced, intent, timing };
    this.pending.push(item);
    this.last[family] = pick.variant.id;
    return item;
  }

  /** Voice off: the piece just shown gets one gentle accent now, from its clearest clause. */
  private planShown(segment: Segment): void {
    let best: ClauseState | null = null;
    for (const state of segment.clauses) if (!best || state.clause.weight > best.clause.weight) best = state;
    if (!best) return;
    for (const family of FAMILIES) {
      const pick = choose(best.clause.intent, best.clause.weight, family, this.temper, this.dispositions, this.random, slider => this.has(slider), this.last[family]);
      if (typeof pick === 'string') { if (pick !== 'calm' && pick !== 'no-variant') this.skip(segment.turn, best.clause.intent, family, null, 'onset', pick); continue; }
      this.plan(pick, family, best.clause.intent, this.now, segment.turn, segment.key, false, 'onset', SPEECH_FACE_KNOBS.timing.onsetGain);
    }
    for (const state of segment.clauses) for (const family of FAMILIES) state.families.set(family, 'done');
  }

  private skip(turn: string, intent: SpeechIntent, family: Family, variant: string | null, timing: AccentRecord['timing'], reason: Skip | string): void {
    this.record({ at: this.now, turn, intent, family, variant, timing, outcome: 'skipped', reason });
  }

  /** Voice on: the current segment's clauses, as their windows come near. */
  private planVoiced(): void {
    const segment = this.segment;
    if (!segment || !segment.voiced) return;
    const knobs = SPEECH_FACE_KNOBS.timing;
    const span = this.levels.span(segment.key);
    const lang = segment.clauses[0]?.clause.lang ?? 'zh';
    const estimate = segment.chars / knobs.charsPerSecond[lang];
    const from = span ? span.from : segment.start;
    const length = Math.max(span ? span.to - from : 0, estimate);
    for (const state of segment.clauses) {
      state.from = from + length * state.clause.start / segment.chars; state.to = from + length * state.clause.end / segment.chars;
      if (state.from > this.now + knobs.lookahead) break;
      for (const family of FAMILIES) {
        const done = state.families.get(family);
        if (done === 'done') continue;
        if (family === 'blush' && segment.blushed) { state.families.set(family, 'done'); continue; }
        let pick = done;
        if (!pick) {
          const choice = choose(state.clause.intent, state.clause.weight, family, this.temper, this.dispositions, this.random, slider => this.has(slider), this.last[family]);
          if (typeof choice === 'string') { if (choice !== 'calm' && choice !== 'no-variant') this.skip(segment.turn, state.clause.intent, family, null, 'peak', choice); state.families.set(family, 'done'); continue; }
          pick = choice; state.families.set(family, pick);
        }
        const placed = this.place(segment, state, pick, span?.peak ?? 0);
        if (placed === 'wait') continue;
        state.families.set(family, 'done');
        if (typeof placed === 'string') { this.skip(segment.turn, state.clause.intent, family, pick.variant.id, span ? pick.variant.at ?? 'peak' : 'onset', placed); continue; }
        this.plan(pick, family, state.clause.intent, placed.startAt, segment.turn, segment.key, true, placed.timing, placed.gain);
        if (family === 'blush') segment.blushed = true;
      }
    }
  }

  /** Where one pick lands: on a loud point, in a real pause, or (no audio levels) at the clause's start. */
  private place(segment: Segment, state: ClauseState, pick: Choice, loudest: number):
    { startAt: number; timing: AccentRecord['timing']; gain: number } | 'wait' | 'late' | 'no-peak' | 'no-pause' {
    const knobs = SPEECH_FACE_KNOBS.timing;
    const rise = peakTime(pick.variant.keys) * pick.timeScale;
    const earliestPeak = this.now + Math.max(rise, knobs.lead);
    if (loudest <= 0) {
      // No PCM levels (system voice): a gentle accent at the clause's estimated start, never claimed to sit on a stress.
      if (state.to < this.now) return 'late';
      return { startAt: Math.max(state.from, this.now), timing: 'onset', gain: knobs.onsetGain };
    }
    if ((pick.variant.at ?? 'peak') === 'boundary') {
      const pause = this.levels.pause(segment.key, state.from + 0.5 * (state.to - state.from), state.to + 0.6, knobs.pauseLevel * loudest, knobs.minPause);
      if (pause === null) {
        const known = this.levels.span(segment.key)?.to ?? -Infinity;
        // Not known yet (PCM still arriving) and not too late: try again next frame.
        if (known < state.to + 0.6 + knobs.minPause && this.now + rise < state.to + 0.6) return 'wait';
        return 'no-pause';
      }
      const peak = pause + Math.min(0.1, knobs.minPause / 2);
      if (peak < earliestPeak - 1e-9) return 'late';
      return { startAt: peak - rise, timing: 'boundary', gain: 1 };
    }
    if (state.to < earliestPeak) return 'late';
    const peak = this.levels.loudest(segment.key, Math.max(state.from, earliestPeak), state.to, 0.3 * loudest);
    if (peak === null) {
      const known = this.levels.span(segment.key)?.to ?? -Infinity;
      if (known < state.to && this.now < state.from) return 'wait';
      return 'no-peak';
    }
    return { startAt: peak - rise, timing: 'peak', gain: 1 };
  }

  /** Starts what is due, under the hard rules; what cannot start now is dropped (never delayed). */
  private startDue(speaking: boolean, faceFree: boolean, headFree: boolean): void {
    if (!this.pending.length) return;
    const hard = SPEECH_FACE_KNOBS.hard, keep: Planned[] = [];
    for (const item of this.pending) {
      if (item.startAt > this.now + 1e-9) { keep.push(item); continue; }
      let reason: string | null = null;
      const history = this.starts[item.family];
      const lastStart = history.length ? history[history.length - 1] : -Infinity;
      const inWindow = history.filter(t => t > this.now - 10).length;
      if (this.now - item.startAt > 0.15) reason = 'late';
      else if (item.voiced && !speaking) reason = 'not-speaking';
      else if (item.family === 'head' ? !headFree : !faceFree) reason = 'owned';
      else if (!this.has(item.variant.slider)) reason = 'unavailable';
      else if (item.family === 'face' && (this.now - lastStart < hard.faceGap - 1e-9 || inWindow >= hard.faceWindowCount)) reason = 'spacing';
      else if (item.family === 'head' && (this.now - lastStart < hard.headGap - 1e-9 || inWindow >= hard.headWindowCount || this.active.some(a => a.family === 'head'))) reason = 'spacing';
      else if (item.family === 'blush' && this.now - lastStart < hard.blushGap - 1e-9) reason = 'spacing';
      if (reason) { this.record({ at: this.now, turn: item.turn, intent: item.intent, family: item.family, variant: item.variant.id, timing: item.timing, outcome: 'dropped', reason }); continue; }
      history.push(this.now); if (history.length > 32) history.shift();
      const started = Math.min(this.now, item.startAt);
      this.active.push({ ...item, started });
      this.record({ at: this.now, turn: item.turn, intent: item.intent, family: item.family, variant: item.variant.id, timing: item.timing, outcome: 'started',
        startAt: started, peakAt: started + peakTime(item.variant.keys) * item.timeScale, amp: item.amp });
    }
    this.pending = keep;
  }

  /** The value of one active accent on its channel at time t. */
  private value(item: Planned & { started: number }, t: number): number {
    const e = envelope(item.variant.keys, t - item.started, item.timeScale) * item.amp;
    return item.variant.slider === 'tilt' ? e * item.side : e;
  }
  private channelOf(item: Planned): AccentChannel {
    const s = item.variant.slider;
    return s === 'nod' ? 'headX' : s === 'tilt' ? 'headZ' : s;
  }

  private compose(): void {
    const caps = SPEECH_FACE_KNOBS.hard.caps;
    for (const channel of CHANNELS) this.out[channel] = 0;
    if (this.active.length) this.active = this.active.filter(item => this.now - item.started < duration(item.variant.keys) * item.timeScale);
    for (const item of this.active) this.out[this.channelOf(item)] += this.value(item, this.now);
    for (const channel of CHANNELS) {
      const release = this.releases[channel];
      if (release) {
        const s = (this.now - release.t0) / release.T;
        if (s >= 1) delete this.releases[channel];
        else this.out[channel] += hermite(release, s);
      }
    }
    // I-077: the song's mood, continuous (it yields with the face like the rest of this layer, in procedural life).
    if (this.tint.smileEyes) this.out.smileEyes += this.tint.smileEyes;
    if (this.tint.lidSoft) this.out.lidSoft += this.tint.lidSoft;
    // Hard rule 3: whatever a recipe or a caller asked for, never more than the caps.
    this.out.smileEyes = clamp(this.out.smileEyes, 0, caps.smileEyes); this.out.browUp = clamp(this.out.browUp, 0, caps.browUp);
    this.out.jitome = clamp(this.out.jitome, 0, caps.jitome); this.out.blush = clamp(this.out.blush, 0, caps.blush);
    this.out.headX = clamp(this.out.headX, -caps.nodDeg * DEG, caps.nodDeg * DEG); this.out.headZ = clamp(this.out.headZ, -caps.tiltDeg * DEG, caps.tiltDeg * DEG);
    const music = SPEECH_FACE_KNOBS.hard.musicCaps;
    this.out.eyeWide = clamp(this.out.eyeWide, 0, music.eyeWide); this.out.lidSoft = clamp(this.out.lidSoft, 0, music.lidSoft);
  }

  /** Hard rule 4 for one family: pending dropped, active eased back from its value and speed. */
  private cancelFamily(family: Family, reason: string): void {
    if (this.pending.some(item => item.family === family)) {
      this.pending = this.pending.filter(item => {
        if (item.family !== family) return true;
        this.record({ at: this.now, turn: item.turn, intent: item.intent, family, variant: item.variant.id, timing: item.timing, outcome: 'dropped', reason });
        return false;
      });
    }
    if (!this.active.some(item => item.family === family)) return;
    const T = SPEECH_FACE_KNOBS.hard.releaseSeconds, h = 1e-3;
    for (const channel of CHANNELS) {
      if (FAMILY_OF[channel] !== family) continue;
      const items = this.active.filter(item => item.family === family && this.channelOf(item) === channel);
      if (!items.length) continue;
      let v0 = 0, vPrev = 0;
      for (const item of items) { v0 += this.value(item, this.now); vPrev += this.value(item, this.now - h); }
      let m0 = (v0 - vPrev) / h;
      const old = this.releases[channel];
      if (old) { const s = (this.now - old.t0) / old.T; if (s < 1) { v0 += hermite(old, s); m0 += hermiteSlope(old, s); } }
      this.releases[channel] = { v0, m0, t0: this.now, T };
    }
    for (const item of this.active) if (item.family === family) this.record({ at: this.now, turn: item.turn, intent: item.intent, family, variant: item.variant.id, timing: item.timing, outcome: 'released', reason });
    this.active = this.active.filter(item => item.family !== family);
  }

  private cancelTurn(reason: string): void {
    this.cancel(reason);
    this.turn = ''; this.levels.clear();
  }
}

/** Hard rule 3's cap for one slider (morph weight, or rad for the head). */
function capOf(slider: Variant['slider']): number {
  const caps = SPEECH_FACE_KNOBS.hard.caps;
  return slider === 'nod' ? caps.nodDeg * DEG : slider === 'tilt' ? caps.tiltDeg * DEG : slider === 'eyeWide' || slider === 'lidSoft' ? SPEECH_FACE_KNOBS.hard.musicCaps[slider] : caps[slider];
}

/** Cubic Hermite from (v0, slope m0) to (0, 0) over T: continuous value and speed where the release starts. */
function hermite(r: Release, s: number): number {
  const h00 = 2 * s * s * s - 3 * s * s + 1, h10 = s * s * s - 2 * s * s + s;
  return h00 * r.v0 + h10 * r.T * r.m0;
}
function hermiteSlope(r: Release, s: number): number {
  const d00 = 6 * s * s - 6 * s, d10 = 3 * s * s - 4 * s + 1;
  return (d00 * r.v0 + d10 * r.T * r.m0) / r.T;
}
