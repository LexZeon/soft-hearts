/**
 * Unbound showcase, layer 1 in the page (docs/claude/2026-11-14-lapwing-showcase.md): plays a choreography that Claude writes live
 * (shared/unbound/showcase.ts beats), frame by frame, as 'showcase' intents for layer 2. It decides only what and when; how the
 * body gets there is the springs', the gait's and the arm reach's.
 *
 *  - Channels add up (a lean, a tilt, a smile and a hand can all be on at once); within one channel the later beat takes over,
 *    and every change is a new goal the springs walk to, never a jump.
 *  - Before the first segment arrives she is in her own world (the opening covers the wait for Claude); segments can be appended
 *    while she plays ("边演边写下一段"). A late segment is shifted so none of it lands in the past.
 *  - Blinks: a rate per style (docs/claude/2026-11-14-liveliness-research.md rule 3: ~17/min at rest, more when lively, fewer and
 *    slower when sleepy), right-skewed intervals (log-normal, not uniform), and a blink at the start of a big change of gaze.
 *  - Expressions: a quick confirm smile rises in ~0.3 s; a warm smile in ~1.2 s and does not hold its peak (rule 8).
 *  - Nothing here is random without a seed: the same choreography and seed play the same.
 */
import type { HandPose, HandTarget, HandTargets } from '../arm-reach';
import type { ShowcaseFace, ShowcaseGaze, ShowcaseIntent, Tempo } from '../motion/generator';
import { blushAt, SLOW_BLUSH } from './blush-envelope';
import type { LensView } from '../motion/lens-align';
import { QuietHeadEvents } from './quiet-events';
import type { ShowcaseBeat, ShowcaseBlinkStyle, ShowcaseExpression, ShowcaseKind } from '../../../shared/unbound/showcase';

const DEG = Math.PI / 180;
const S5 = (u: number) => { const x = Math.min(1, Math.max(0, u)); return x * x * x * (10 + x * (-15 + 6 * x)); };

/** Body sizes (first picks; read against the lapwing frames, not measured on people). */
export const SHOWCASE_BODY = Object.freeze({
  awayYawDeg: 52, awayUpDeg: -9, awayDownDeg: 14, wanderDeg: 3.5, wanderHz: 0.11,
  approachM: 0.42, retreatM: 0.1, leanRad: 0.26, walkMps: 0.22,
  glanceYawDeg: 20, glanceDownDeg: 14, glanceUpDeg: -9,
  waveHz: { big: 2.1, small: 2.5 },
  nodRad: 6 * DEG, nodS: 0.65,
});
/** Expression timing (s): rise, release; warm smiles decay to `afterglow` of their peak after `peakS`. */
export const EXPRESSION_TIMING: Readonly<Record<ShowcaseExpression, { quick: number; slow: number; release: number }>> = {
  'confirm-smile': { quick: 0.3, slow: 0.6, release: 0.7 }, 'warm-smile': { quick: 0.9, slow: 1.2, release: 1.2 }, laugh: { quick: 0.35, slow: 0.7, release: 0.9 },
  pout: { quick: 0.35, slow: 0.7, release: 0.6 }, shy: { quick: 0.5, slow: 0.9, release: 1.0 }, surprise: { quick: 0.12, slow: 0.3, release: 0.8 }, sly: { quick: 0.4, slow: 0.8, release: 0.9 },
  content: { quick: 0.5, slow: 0.8, release: 0.9 }, yawn: { quick: 0.6, slow: 0.9, release: 0.8 },
};
export const WARM = Object.freeze({ peakS: 1.6, afterglow: 0.7, decayS: 1.5 });
/** Blink styles: mean interval (s), log-normal spread, and the blink's own close / hold / open (s). */
const BLINKS: Record<ShowcaseBlinkStyle, { mean: number; sigma: number; close: number; hold: number; open: number }> = {
  calm: { mean: 3.5, sigma: 0.55, close: 0.09, hold: 0.04, open: 0.15 },
  lively: { mean: 2.8, sigma: 0.5, close: 0.08, hold: 0.03, open: 0.13 },
  sleepy: { mean: 5.0, sigma: 0.5, close: 0.14, hold: 0.1, open: 0.26 },
  soft: { mean: 4.0, sigma: 0.5, close: 0.11, hold: 0.06, open: 0.2 },
};
/** Round 4 decision (iteration log): the mouth follows the line's pinyin only when this is on. */
export let SPOKEN_MOUTH = false;
export function setSpokenMouth(on: boolean): void { SPOKEN_MOUTH = on; }
/** Round 9: livelier quiet moments (mood-steeper idle knob and the small quick head events). Off: round 8's quiet holds, for a comparison. */
export let LIVELIER_QUIET = true;
export function setLivelierQuiet(on: boolean): void { LIVELIER_QUIET = on; }
/** Round 10: still windows in quiet holds (still, then a quick move, then still). Off: round 9's, for a comparison. */
export let STILL_WINDOWS = true;
export function setStillWindows(on: boolean): void { STILL_WINDOWS = on; }
const GAZE_BLINK_DEG = 25, MIN_BLINK_GAP_S = 0.7, GAZE_BLINK_GAP_S = 0.35;

const STATE_KINDS: ReadonlySet<ShowcaseKind> = new Set(['own-world', 'notice', 'hold-gaze']);
const DISTANCE_KINDS: ReadonlySet<ShowcaseKind> = new Set(['approach', 'retreat']);
/** Round 10: how long a speech nod on a stressed syllable takes (s). */
const NOD_S = 0.5;
/** Round 7: the learned idle fades in and out over about this long (s, time constant). */
const IDLE_EASE_S = 0.7;
/** Round 9: anything else going on (a glance, a hand, a tilt, words, an expression change of the head) and it is not a quiet moment. */
const QUIET_BREAKERS: ReadonlySet<string> = new Set(['glance', 'hand-face', 'wave', 'hand-sign', 'tilt', 'murmur', 'shy', 'surprise', 'laugh', 'pout', 'yawn', 'content']);

/** A small deterministic generator (mulberry32). */
export function seeded(seed: number): () => number {
  let a = (Math.floor(seed * 2 ** 31) ^ 0x9e3779b9) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** One beat's own variation (each −1..1, seeded per beat and scaled by her liveliness): no two beats of a kind play the same. */
export interface BeatVariation { amp: number; speed: number; yaw: number; pitch: number; x: number; y: number; z: number; roll: number }
export interface PlayedBeat extends ShowcaseBeat { playedAt: number; vary: BeatVariation }
export interface PerformerFrame { intent: ShowcaseIntent; beats: string[]; blinking: boolean }

export class ShowcasePerformer {
  private readonly beats: PlayedBeat[] = [];
  private t = 0;
  private offset: number | null = null;
  private readonly random: () => number;
  private nextBlink: number;
  private blinkAt = -10;
  private blinkStyle: ShowcaseBlinkStyle;
  private lastGaze: { mode: 'lens' | 'away'; yaw: number; pitch: number } | null = null;
  private readonly opener: { side: 1 | -1; pitch: number };
  private syllables: { at: number; dur: number; vowel: keyof ShowcaseFace['mouth']; peak: number; stress: boolean }[] = [];
  private syllableUntil = 0;
  private readonly biasNow = { yaw: 0, pitch: 0 };
  private readonly idleNow = { weight: 0, arms: { left: 1, right: 1 } };
  private readonly quietEvents: QuietHeadEvents;
  private readonly spoken = new Map<PlayedBeat, { at: number; dur: number; vowel: keyof ShowcaseFace['mouth'] | null; peak: number; stress: boolean }[]>();
  /** A spoken line's syllables in time (pinyin or romaji: the main vowel of each; a short pause at a comma-sized gap every few). */
  private speak(b: PlayedBeat): { at: number; dur: number; vowel: keyof ShowcaseFace['mouth'] | null; peak: number; stress: boolean }[] {
    const words = (b.pinyin ?? '').split(/\s+/u).filter(Boolean).slice(0, 40);
    const per = Math.min(0.32, Math.max(0.16, (b.dur - 0.3) / Math.max(1, words.length)));
    const out: { at: number; dur: number; vowel: keyof ShowcaseFace['mouth'] | null; peak: number; stress: boolean }[] = [];
    let at = b.playedAt + 0.12;
    for (const raw of words) {
      const stress = raw.includes('*'), w = raw.replace(/\*/gu, '').toLowerCase().replace(/[üv]/gu, 'u');
      const vowel = (['a', 'o', 'e', 'i', 'u'] as const).find(v => w.includes(v)) ?? null;
      const dur = per * (0.85 + 0.3 * this.random());
      out.push({ at, dur, vowel, peak: (stress ? 0.85 : 0.55) + 0.15 * this.random(), stress });
      at += dur;
    }
    this.spoken.set(b, out);
    return out;
  }
  private readonly home: { x: number; z: number };
  private readonly distanceScale: number;
  /** Blinks played (times, s), for the self-check. */
  readonly blinkTimes: number[] = [];

  /**
   * `home`: where she stands at rest (her floor, m). `liveliness` 0..1 (shared/unbound/showcase.ts) scales sizes and speeds.
   */
  constructor(home: { x: number; z: number }, private readonly liveliness: number, seed: number, private readonly opening: 'away' | 'standing' = 'away', fit: { distanceScale?: number; viewerM?: number } = {}) {
    const k = fit.distanceScale ?? 1, viewer = fit.viewerM ?? 0.55;
    // Round 16: the stand-off from the lens follows the head size (1 = Gene: the same numbers as before, bit for bit).
    this.home = k === 1 ? home : { x: home.x, z: viewer + k * (home.z - viewer) };
    this.distanceScale = k;
    this.random = seeded(seed);
    this.quietEvents = new QuietHeadEvents(seed, liveliness); // its own random stream: the other draws stay as they were
    this.blinkStyle = liveliness > 0.55 ? 'lively' : 'calm';
    this.nextBlink = 0.8 + this.random() * 2;
    this.opener = { side: this.random() < 0.5 ? 1 : -1, pitch: this.random() < 0.5 ? SHOWCASE_BODY.awayUpDeg * DEG : 0 };
  }

  get clock(): number { return this.t; }
  /** Round 9: the quiet moments' small head events started so far (kind and time). */
  get quietEventsStarted(): readonly { kind: string; at: number }[] { return this.quietEvents.started; }
  get played(): readonly PlayedBeat[] { return this.beats; }
  /** When the performance's own time 0 fell on this clock (null before the first segment). */
  get startOffset(): number | null { return this.offset; }
  /** The last beat's end on this clock (null before any). */
  get endsAt(): number | null { return this.beats.length ? Math.max(...this.beats.map(b => b.playedAt + b.dur)) : null; }

  /** Appends a validated segment (beats in the performance's own time). The first one starts now. Returns the beats as played. */
  append(beats: readonly ShowcaseBeat[]): PlayedBeat[] {
    if (!beats.length) return [];
    const first = Math.min(...beats.map(b => b.at));
    if (this.offset === null) this.offset = Math.max(0, this.t + 0.2 - first);
    else if (first + this.offset < this.t + 0.2) this.offset = this.t + 0.2 - first; // late: shift it so nothing is in the past
    const r = () => (this.random() * 2 - 1) * (0.7 + 0.6 * this.liveliness), offset = this.offset;
    const added: PlayedBeat[] = beats.map(b => ({ ...b, playedAt: b.at + offset, vary: { amp: r(), speed: r(), yaw: r(), pitch: r(), x: r(), y: r(), z: r(), roll: r() } }));
    this.beats.push(...added);
    this.beats.sort((a, b) => a.playedAt - b.playedAt);
    return added; // 边说边演 holds one of these by lengthening its dur (src/unbound/speech-beat-hold.ts)
  }

  frame(dt: number, lens: LensView): PerformerFrame {
    this.t += Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
    const t = this.t, g = this.liveliness, active: string[] = [];
    const started = this.beats.filter(b => b.playedAt <= t);
    const during = (b: PlayedBeat) => b.playedAt <= t && t < b.playedAt + b.dur;
    const lastOf = (kinds: ReadonlySet<ShowcaseKind>) => { for (let i = started.length - 1; i >= 0; i--) if (kinds.has(started[i].kind)) return started[i]; return null; };

    // Attention: in her own world (the opening, or an own-world beat), on you, or holding you in a quiet look.
    const state = lastOf(STATE_KINDS);
    let gaze: ShowcaseGaze, stillness = 0, tempo: Tempo = 'calm';
    const face: ShowcaseFace = { confirm: 0, warm: 0, laugh: 0, pout: 0, shy: 0, surprise: 0, sly: 0, content: 0, yawn: 0, stress: 0, closed: 0, half: 0, blush: 0, mouth: { a: 0, i: 0, u: 0, e: 0, o: 0 } };
    if ((!state && this.opening === 'away') || state?.kind === 'own-world') {
      const side = state ? (state.side === 'right' ? -1 : 1) : this.opener.side;
      const pitch = state ? (state.pitch === 'up' ? SHOWCASE_BODY.awayUpDeg : state.pitch === 'down' ? SHOWCASE_BODY.awayDownDeg : 0) * DEG : this.opener.pitch;
      const wander = SHOWCASE_BODY.wanderDeg * DEG * Math.sin(2 * Math.PI * SHOWCASE_BODY.wanderHz * t + 1.3);
      const v = state?.vary;
      gaze = { mode: 'away', yaw: side * SHOWCASE_BODY.awayYawDeg * DEG * (0.85 + 0.3 * (state?.intensity ?? 0.5)) * (1 + 0.15 * (v?.amp ?? 0)) + wander, pitch: pitch + 0.4 * wander + 4 * DEG * (v?.pitch ?? 0) };
      const eyes = state?.eyes ?? 'half', since = state ? t - state.playedAt : t;
      const ease = S5(since / 0.8);
      if (eyes === 'closed') face.closed = ease; else if (eyes === 'half') face.half = 0.8 * ease;
      if (state) active.push(state.kind);
    } else {
      gaze = { mode: 'lens', yaw: 0, pitch: 0 };
      const since = state ? t - state.playedAt : t;
      if (state && state.kind === 'notice' && since < 1.4 && state.intensity >= 0.55) tempo = 'brisk';
      if (state?.kind === 'hold-gaze') stillness = S5(since / 0.6) * (0.6 + 0.4 * state.intensity);
      if (state) active.push(state.kind);
    }

    // In her own world, a glance is a peek at you (from the side she was looking to); otherwise a glance away and back.
    if (gaze.mode === 'away') for (const b of started) if (b.kind === 'glance' && during(b)) {
      const k = 0.6 + 0.4 * b.intensity, side = Math.sign(gaze.yaw) || 1;
      gaze = { mode: 'lens', yaw: side * (6 + 6 * (1 - k) + 3 * b.vary.yaw) * DEG, pitch: (2 + 3 * b.vary.pitch) * DEG };
      active.push('glance');
    }
    if (gaze.mode === 'lens' && !active.includes('glance')) for (const b of started) if (b.kind === 'glance' && during(b)) {
      const dir = b.dir ?? 'down-left';
      const yaw = dir.includes('left') ? 1 : dir.includes('right') ? -1 : 0, pitch = dir.startsWith('down') ? SHOWCASE_BODY.glanceDownDeg : dir.startsWith('up') ? SHOWCASE_BODY.glanceUpDeg : 0;
      const k = (0.6 + 0.4 * b.intensity) * (1 + 0.25 * b.vary.amp);
      gaze = { mode: 'lens', yaw: (yaw * SHOWCASE_BODY.glanceYawDeg * k + 6 * b.vary.yaw) * DEG, pitch: (pitch * k + 4 * b.vary.pitch) * DEG };
      active.push('glance');
    }

    // Distance: where she stands and how far she leans in (a state: it holds until the next approach / retreat).
    const distance = lastOf(DISTANCE_KINDS);
    let place = { x: this.home.x, z: this.home.z }, lean = 0, walk = SHOWCASE_BODY.walkMps;
    if (distance?.kind === 'approach') {
      const v = distance.vary;
      place = { x: this.home.x + 0.04 * v.x, z: this.home.z + this.distanceScale * SHOWCASE_BODY.approachM * (0.35 + 0.65 * (distance.amount ?? 0.6)) * (1 + 0.1 * v.amp) };
      lean = SHOWCASE_BODY.leanRad * (distance.lean ?? 0.4) * (1 + 0.15 * v.z) * S5((t - distance.playedAt) / Math.max(0.4, distance.dur * (1 + 0.2 * v.speed)));
      walk = SHOWCASE_BODY.walkMps * (0.8 + 0.5 * distance.intensity) * (0.85 + 0.3 * g);
    } else if (distance?.kind === 'retreat') {
      place = { x: this.home.x + 0.03 * distance.vary.x, z: this.home.z - this.distanceScale * SHOWCASE_BODY.retreatM * (distance.amount ?? 0.5) * (1 + 0.2 * distance.vary.amp) };
      lean = -0.04 * (distance.amount ?? 0.5);
      walk = SHOWCASE_BODY.walkMps * 0.8;
    }
    if (distance) active.push(distance.kind);

    // Tilt: held for its time, then upright again (the springs ease both ways).
    let tilt = 0;
    for (const b of started) if (b.kind === 'tilt' && during(b)) { tilt = (b.side === 'right' ? -1 : 1) * Math.min(18, Math.max(10, b.deg ?? 12)) * DEG * (0.95 + 0.3 * g) * (1 + 0.2 * b.vary.amp); active.push('tilt'); }

    // Hands.
    const hands: HandTargets = { left: null, right: null };
    for (const b of started) if ((b.kind === 'hand-face' || b.kind === 'wave' || b.kind === 'hand-sign') && during(b)) {
      const since = t - b.playedAt, left = b.dur - since;
      // Hand by the face: Claude's how, or this beat's own pick (palm or back of the hand at the cheek).
      const cheek: HandPose = b.how === 'back' || (!b.how && b.vary.roll > 0.2) ? 'cheek-back' : 'cheek';
      const pose: HandPose = b.kind === 'hand-sign' ? (b.sign === 'heart' ? 'heart' : b.sign === 'point' ? 'point' : 'vsign') : b.kind === 'wave' ? (b.size === 'big' ? 'wave-big' : 'wave-small') : b.where === 'chin' ? 'chin' : b.where === 'mouth' ? 'mouth' : b.where === 'ear' ? 'tuck' : cheek;
      let wave = 0;
      if (b.kind === 'wave') {
        const hz = (b.size === 'big' ? SHOWCASE_BODY.waveHz.big : SHOWCASE_BODY.waveHz.small) * (0.9 + 0.2 * g) * (1 + 0.1 * b.vary.speed);
        const env = S5((since - 0.6) / 0.4) * S5((left - 0.15) / 0.45) * (0.6 + 0.4 * b.intensity) * (1 + 0.2 * b.vary.amp);
        wave = env * Math.sin(2 * Math.PI * hz * Math.max(0, since - 0.6));
      }
      // The hand comes down a little before the beat ends, so it is down by the time the next thing starts.
      const target: HandTarget = { weight: left > 0.5 ? 1 : 0, pose, wave, offset: { x: 0.012 * b.vary.x, y: 0.012 * b.vary.y, z: 0.01 * b.vary.z }, roll: 0.17 * b.vary.roll };
      if (b.kind === 'hand-sign') {
        // Round 11: a hand sign holds still (a small per-beat variation only); a V comes with a little tilt toward that hand,
        // pointing at you with a small lean in ("you!").
        target.offset = { x: 0.006 * b.vary.x, y: 0.006 * b.vary.y, z: 0.006 * b.vary.z }; target.roll = 0.1 * b.vary.roll;
        const held = S5((since - 0.3) / 0.7) * (1 - S5((since - (b.dur - 0.8)) / 0.6));
        if (pose === 'vsign') tilt += (b.side === 'left' ? 1 : -1) * (5 + 3 * b.intensity) * DEG * held;
        if (pose === 'point') lean += 0.06 * (0.6 + 0.4 * b.intensity) * held;
      }
      if (pose === 'tuck') {
        // Round 9, hair behind the ear: the hand reaches her temple (~1 s), slides back to behind the ear, then comes down; her
        // head tilts a little toward that hand meanwhile.
        // Round 11: at least a second for the slide (a short beat slid so fast the hand cut the corner through her hair).
        target.slide = S5((since - 0.9) / Math.max(1.0, b.dur - 2.0));
        target.offset = { x: 0.004 * b.vary.x, y: 0.006 * b.vary.y, z: 0.004 * b.vary.z }; target.roll = 0.08 * b.vary.roll;
        // Round 10: a clear tilt toward the hand, 6–10° by intensity, and her eyes go down shyly while the hand slides back.
        const held = S5(since / 0.8) * (1 - S5((since - (b.dur - 0.7)) / 0.7));
        tilt += (b.side === 'left' ? 1 : -1) * (6 + 4 * b.intensity) * DEG * held;
        if (gaze.mode === 'lens' && !active.includes('glance')) {
          const down = S5((since - 0.7) / 0.4) * (1 - S5((since - (b.dur - 1.0)) / 0.5));
          gaze = { ...gaze, pitch: gaze.pitch + (7 + 3 * b.vary.pitch) * DEG * down };
        }
      }
      if (b.side === 'left') hands.left = target; else hands.right = target;
      active.push(b.kind);
    }

    // Expressions (add up, each with its own rise and release), and a small nod with a confirm smile.
    let nod = 0, bodyTurn = 0;
    for (const b of started) if (b.kind === 'expression' && b.name) {
      const timing = EXPRESSION_TIMING[b.name], rise = (b.onset === 'slow' ? timing.slow : timing.quick) * (1 + 0.25 * b.vary.speed), release = timing.release * (1 + 0.2 * b.vary.roll);
      const since = t - b.playedAt, after = since - b.dur;
      if (after > release) continue;
      let v = S5(since / rise) * (after > 0 ? 1 - S5(after / release) : 1) * (1 + 0.12 * b.vary.amp);
      if (b.name === 'warm-smile' && since > WARM.peakS) v *= 1 - (1 - WARM.afterglow) * S5((since - WARM.peakS) / WARM.decayS);
      // Surprise: up fast, then it settles to about 60%.
      if (b.name === 'surprise') v *= 1 - 0.4 * S5((since - 0.45) / 0.6);
      // Shy: the eyes go down and away for a moment, the head dips (unless a glance already moves her eyes).
      if (b.name === 'shy' && gaze.mode === 'lens' && !active.includes('glance')) {
        const away = S5(since / 0.35) * (1 - S5((since - 1.3) / 0.5)), side = b.vary.yaw >= 0 ? 1 : -1;
        gaze = { mode: 'lens', yaw: gaze.yaw + side * (14 + 4 * b.vary.amp) * DEG * away, pitch: gaze.pitch + (13 + 3 * b.vary.pitch) * DEG * away };
        nod += 5 * DEG * S5(since / 0.5) * (after > 0 ? 1 - S5(after / release) : 1);
      }
      v *= 0.55 + 0.45 * b.intensity;
      const key = ({ 'confirm-smile': 'confirm', 'warm-smile': 'warm', laugh: 'laugh', pout: 'pout', shy: 'shy', surprise: 'surprise', sly: 'sly', content: 'content', yawn: 'yawn' } as const)[b.name];
      // Sly: chin a little down, she looks at you from under her brows. Content: chin up. A yawn: head back a little.
      if (b.name === 'sly') nod += 4 * DEG * v;
      // Pout: a small turn of the head away (her eyes stay on you from the side), chin a little up.
      if (b.name === 'pout' && gaze.mode === 'lens') { const side = b.vary.yaw >= 0 ? 1 : -1; bodyTurn += side * 9 * DEG * v; nod -= 3 * DEG * v; }
      if (b.name === 'content') nod -= 6 * DEG * v;
      if (b.name === 'yawn') nod -= 7 * DEG * v * Math.sin(Math.PI * Math.min(1, since / Math.max(0.8, b.dur)));
      face[key] = Math.min(1, face[key] + v);
      if (b.name === 'confirm-smile' && since < SHOWCASE_BODY.nodS) nod += SHOWCASE_BODY.nodRad * Math.sin(Math.PI * S5(since / SHOWCASE_BODY.nodS)) * (0.5 + 0.5 * b.intensity);
      if (v > 0.05) active.push(b.name);
    }
    // Round 15: the blush on its own slow envelope (up over 1.2–1.8 s, away over 2–3 s), whatever the expression's onset.
    face.blush = SLOW_BLUSH ? blushAt(started, t) : Math.min(1, 2 * face.shy);
    // Murmur: a soft run of mouth shapes, as if she were saying something to you (no sound).
    // Round 10: talking is brisk — the springs meet the speech nods at the brisk tempo, so they show.
    for (const b of started) if (b.kind === 'murmur' && during(b)) { nod += this.murmur(face, b, t); active.push('murmur'); tempo = 'brisk'; }

    // Blinks.
    for (const b of started) if (b.kind === 'blink-style' && b.style) this.blinkStyle = b.style;
    const blinkSpec = BLINKS[this.blinkStyle];
    const shift = this.lastGaze && (this.lastGaze.mode !== gaze.mode || Math.hypot(this.lastGaze.yaw - gaze.yaw, this.lastGaze.pitch - gaze.pitch) > GAZE_BLINK_DEG * DEG);
    this.lastGaze = { mode: gaze.mode, yaw: gaze.yaw, pitch: gaze.pitch };
    // Round 12 (QA scan): a big smile closes the eyes into arcs too (the smile-eyes shape, as showcase-motion.ts weighs it); a blink
    // on top of those arcs flicked the lids' shape for a frame or two. No new blink while the arcs hold.
    const smileEyes = 0.2 * face.confirm + 0.75 * face.warm ** 1.6 + Math.min(1, 1.25 * face.laugh) + 0.2 * face.shy;
    const eyesShut = face.closed > 0.5 || face.content > 0.5 || face.yawn > 0.5 || smileEyes > 0.55;
    // A big change of gaze carries a blink (rule 3: ~97% of shifts past 33°), even fairly soon after the last one.
    if (!eyesShut && ((shift && t - this.blinkAt > GAZE_BLINK_GAP_S && this.random() < 0.95) || (t >= this.nextBlink && t - this.blinkAt > MIN_BLINK_GAP_S))) this.startBlink(t);
    if (t >= this.nextBlink && eyesShut) this.nextBlink = t + 0.5;
    const blink = this.blinkValue(t, blinkSpec);

    // Her resting angle to you: rarely square. Each time she settles on you (notice / hold-gaze) she rests three-quarter to one
    // side, the sides alternating, 7.5–12.5° (this beat's own variation), the chin now and then up or down. The springs carry it.
    let bias = { yaw: 0, pitch: 0 };
    if (gaze.mode === 'lens' && state && state.kind !== 'own-world') {
      // The side changes each time she turns to you anew (a notice), and holds through a quiet look.
      const n = started.filter(b => b.kind === 'notice' && b.playedAt <= state.playedAt).length;
      const side = ((n + (this.opener.side > 0 ? 0 : 1)) % 2 === 0 ? 1 : -1);
      const chin = Math.abs(state.vary.pitch) > 0.45 ? Math.sign(state.vary.pitch) * 5 * DEG : 0;
      bias = { yaw: side * (8 + 2 * state.vary.amp) * DEG, pitch: chin };
    }
    // The resting angle drifts over to its new side slowly (a settling of the shoulders, ~1 s), never as a turn of the head.
    const k = 1 - Math.exp(-Math.max(0, Math.min(0.1, dt)) / 0.9);
    this.biasNow.yaw += (bias.yaw - this.biasNow.yaw) * k; this.biasNow.pitch += (bias.pitch - this.biasNow.pitch) * k;
    bias = { yaw: this.biasNow.yaw + bodyTurn, pitch: this.biasNow.pitch };
    // Resting three-quarter on you, the head takes only 70% of the held look (her eyes keep the rest, inside their soft limit); in
    // her own world or glancing far, the head takes its usual 90% so the eyes come back to the middle.
    // Round 5: a busier scene pushed the eyes past 15° (page p95 15.8); the head now keeps 80% even when resting turned.
    const gazeRecenter = Math.abs(bias.yaw) > 4 * DEG && !active.includes('glance') ? 0.8 : 0.9;
    const idle = this.idleFrame(dt, state, started.some(b => DISTANCE_KINDS.has(b.kind) && during(b)), hands, stillness);
    // Round 9: small quick head events while she quietly holds your look (quiet-events.ts; how often and how big follow her mood).
    const quiet = state?.kind === 'hold-gaze' && gaze.mode === 'lens' && idle.weight > 0.6 && !active.some(k => QUIET_BREAKERS.has(k));
    const ev = LIVELIER_QUIET ? this.quietEvents.frame(dt, quiet, STILL_WINDOWS) : { yaw: 0, pitch: 0, roll: 0, glance: { yaw: 0, pitch: 0 }, kind: null, idleScale: 1, still: false };
    // Round 10: still, then a quick move, then still — in a still window the learned idle eases down to a little of itself.
    idle.weight *= ev.idleScale;
    nod += ev.pitch; tilt += ev.roll;
    // A quick move is quick: the springs meet it at the brisk tempo (the calm one smoothed a half-second flick to a third).
    if (ev.kind === 'flick' || ev.kind === 'nod' || ev.kind === 'reglance') tempo = 'brisk';
    if (ev.glance.yaw !== 0 || ev.glance.pitch !== 0) gaze = { ...gaze, yaw: gaze.yaw + ev.glance.yaw, pitch: gaze.pitch + ev.glance.pitch };
    const intent: ShowcaseIntent = { kind: 'showcase', lens, gaze, place, walkSpeedMps: walk, lean, tilt, nod, bias, gazeRecenter, hands, face, blink, stillness, tempo, idle, headYaw: ev.yaw };
    return { intent, beats: [...new Set(active)], blinking: blink > 0.5 };
  }

  private startBlink(t: number): void {
    const spec = BLINKS[this.blinkStyle];
    this.blinkAt = t; this.blinkTimes.push(t);
    // Log-normal interval with the style's mean (right-skewed: mostly a few seconds, now and then a long gap).
    const n = Math.sqrt(-2 * Math.log(Math.max(1e-9, this.random()))) * Math.cos(2 * Math.PI * this.random());
    const mu = Math.log(spec.mean) - spec.sigma * spec.sigma / 2;
    this.nextBlink = t + Math.min(12, Math.max(0.9, Math.exp(mu + spec.sigma * n)));
  }
  private blinkValue(t: number, spec: (typeof BLINKS)[ShowcaseBlinkStyle]): number {
    const d = t - this.blinkAt;
    if (d < 0 || d > spec.close + spec.hold + spec.open) return 0;
    return d < spec.close ? S5(d / spec.close) : d < spec.close + spec.hold ? 1 : 1 - S5((d - spec.close - spec.hold) / spec.open);
  }

  /**
   * Round 7, the learned idle (laid on only when the page turned it on; see showcase-motion.ts): how much of it, eased, and how free
   * each arm is. On in a quiet look and in her own world (the opening included), never while she steps toward or away from you.
   * The knob follows her mood (liveliness) and the beat: a little livelier in her own world, calmer the stiller she holds your look.
   */
  private idleFrame(dt: number, state: PlayedBeat | null, stepping: boolean, hands: HandTargets, stillness: number): NonNullable<ShowcaseIntent['idle']> {
    const h = Math.max(0, Math.min(0.1, dt));
    const own = (!state && this.opening === 'away') || state?.kind === 'own-world';
    const quiet = !stepping && (own || state?.kind === 'hold-gaze') ? 1 : 0;
    this.idleNow.weight += (quiet - this.idleNow.weight) * (1 - Math.exp(-h / IDLE_EASE_S));
    // An arm leaves the idle quickly when a hand beat takes it, and comes back to it slowly after the hand is down.
    for (const side of ['left', 'right'] as const) {
      const free = hands[side] ? 0 : 1, tau = free < this.idleNow.arms[side] ? 0.12 : 1.2;
      this.idleNow.arms[side] += (free - this.idleNow.arms[side]) * (1 - Math.exp(-h / tau));
    }
    // Round 9: steeper with the mood — a lively mood idles near the people's livelier end, a calm or sleepy one stays low — and a
    // steady look calms only a calm mood (a lively one keeps moving while it looks at you).
    const g = Math.max(0, Math.min(1, this.liveliness));
    const activation = Math.max(0.05, Math.min(0.95, LIVELIER_QUIET
      ? 0.1 + 0.85 * g ** 1.2 + (own ? 0.1 : 0) - 0.2 * (1 - g) * stillness
      : 0.2 + 0.6 * g + (own ? 0.1 : 0) - 0.2 * stillness));
    return { weight: this.idleNow.weight, activation, arms: { ...this.idleNow.arms } };
  }

  /** Her mouth while she murmurs; returns the small nods on stressed syllables (rad), which the head carries. */
  private murmur(face: ShowcaseFace, b: PlayedBeat, t: number): number {
    // The line Claude wrote: its syllables at about 5 a second, each to its main vowel; brows lift on the stressed ones. Round 4:
    // off by default — on a 10 fps contact sheet it read no more like talking than the random mouth (iteration log), so the
    // random mouth is back; SPOKEN_MOUTH turns the pinyin mouth on again for a comparison.
    if (b.pinyin && SPOKEN_MOUTH) {
      const plan = this.spoken.get(b) ?? this.speak(b);
      const fade = S5((t - b.playedAt) / 0.2) * S5((b.playedAt + b.dur - t) / 0.2);
      for (const s of plan) if (t >= s.at && t < s.at + s.dur) {
        const shape = Math.sin(Math.PI * (t - s.at) / s.dur) * fade;
        if (s.vowel) face.mouth[s.vowel] = Math.max(face.mouth[s.vowel], s.peak * shape);
        if (s.stress) face.stress = Math.max(face.stress, shape);
      }
      return 0;
    }
    if (t >= this.syllableUntil) {
      // Round 5: a phrase of 3–8 syllables at about 4–6 a second, openness varied (some barely open, some wide), about one in four
      // stressed (brows up, a small nod: the head carries the speech as much as the mouth, Busso 2007), then a breath.
      const vowels: (keyof ShowcaseFace['mouth'])[] = ['a', 'a', 'i', 'u', 'e', 'o', 'e'];
      let at = Math.max(t, this.syllableUntil) + 0.05;
      const count = 3 + Math.floor(this.random() * 5);
      this.syllables = [];
      for (let i = 0; i < count; i++) { const dur = 0.16 + this.random() * 0.09; const stress = this.random() < 0.27; this.syllables.push({ at, dur, vowel: vowels[Math.floor(this.random() * vowels.length)], peak: stress ? 0.9 + 0.1 * this.random() : 0.35 + this.random() * 0.5, stress }); at += dur; }
      // The next phrase waits for the last stressed nod to finish (round 10: a nod is longer than its syllable).
      const lastStress = this.syllables.filter(s => s.stress).reduce((m, s) => Math.max(m, s.at + NOD_S), 0);
      this.syllableUntil = Math.max(at + 0.25 + this.random() * 0.35, lastStress);
    }
    const fade = S5((t - b.playedAt) / 0.3) * S5((b.playedAt + b.dur - t) / 0.3) * (0.7 + 0.3 * b.intensity);
    let nod = 0;
    for (const s of this.syllables) {
      if (t >= s.at && t < s.at + s.dur) {
        const shape = Math.sin(Math.PI * (t - s.at) / s.dur);
        face.mouth[s.vowel] = Math.max(face.mouth[s.vowel], s.peak * fade * shape);
        if (s.stress) face.stress = Math.max(face.stress, fade * shape);
      }
      // Round 10: the nod on a stressed syllable is a beat of the head, not a flick of the syllable: 3–5° over half a second
      // from the syllable's start (a 0.2 s bump was smoothed away by the head's springs and never showed).
      if (s.stress && t >= s.at && t < s.at + NOD_S) nod += (3 + 2 * b.intensity) * DEG * fade * Math.sin(Math.PI * S5((t - s.at) / NOD_S));
    }
    return nod;
  }
}
