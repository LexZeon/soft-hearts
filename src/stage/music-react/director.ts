/**
 * I-077 step 1 ("听歌时她有反应，不只是踩拍子"; plan docs/claude/2026-11-11-music-reactions-plan.md, record
 * docs/claude/2026-11-11-i077-music-reactions.md): turns what she hears (hearing.ts) into what she does, sparsely.
 *
 *  - The style while she moves (continuous, not an event): plucky and bright → a lighter, bouncier dance; sustained and soft → a slow
 *    four-beat sway; heavy bass → a firmer nod. A modulation of the existing dance / nod (music-dance.ts `setShape`), eased over seconds.
 *  - The song's mood on her face (continuous): a bright upbeat song a faint smile in the eyes; a slow dark one softly lowered lids.
 *  - Reactions (events): a section lift or fall becomes an intent (lift, settle, enjoy, moved); she may let it pass (choose.ts); at most
 *    `choice.perSong` per song, at least `minGap` (plus a random part) apart, never the same variant twice in a row; a long song
 *    without sections may get one spontaneous "enjoy" or "moved". No fixed cadence: they follow the song and her temper.
 *  - Timing: on the next group-of-four start of the beat clock when the beat is clear; otherwise at the section change, gentler.
 *  - Back to mood: each reaction that starts is reported once (the stage tells the host; shared/foundation/mood-moments.ts gates and scales it).
 *
 * Step 2 (docs/claude/2026-11-11-i077-step2.md): her music taste (the card's trait) scales how engaged she is (taste.ts: the chance, the size,
 * the dance, the mood moment; exactly 1 when neutral); the song's fingerprint (fingerprint.ts) is measured from the intro, handed out as
 * `ask` (the stage looks it up in the memory) and, at the song's end, as `learn`; `recognized` brings back "this is a song she knows",
 * which may become a small reaction of its own ("recognize": not counted in the per-song budget, not every time, never twice for one song
 * within `repeatSeconds`).
 *
 * Only while she chooses for herself: with "让她一直跟着跳" (the user-confirmed R15) nothing here acts, the shape stays exactly neutral.
 * Nothing while not music, asleep, or with automatic expression paused. Pure apart from the injected random source.
 */
import { envelope } from '../../voice';
import type { DispositionTemper, HormoneTemper } from '../../voice';
import { dampCritical } from '../procedural';
import { SeededRandom } from '../life-noise';
import { MusicHearing, type SectionEvent } from './hearing';
import { MUSIC_REACT_KNOBS } from './knobs';
import { chooseMusic, intentFor, type MusicPick } from './choose';
import { keysEnd, type MusicIntent, type MusicVariant } from './recipes';
import { foldPeriod } from './beat-clock';
import type { MusicEnergySample } from '../music-dance';
import type { MusicTaste } from '../../../shared/foundation/character-card';
import type { SongSketch } from '../../../shared/senses';
import { SONG_MEMORY_KNOBS } from '../../../shared/senses';
import { SongProfiler } from './fingerprint';
import { tasteGains, tasteLiking, NEUTRAL_GAINS, type SongFeel } from './taste';

/** Multipliers (1 = unchanged), the slow-sway share (0..1) and head offsets (rad) for the dance and the nod. */
export interface DanceShape { sway: number; bounce: number; nod: number; slow: number; headX: number; headZ: number }
export const NEUTRAL_SHAPE: Readonly<DanceShape> = Object.freeze({ sway: 1, bounce: 1, nod: 1, slow: 0, headX: 0, headZ: 0 });
export const isNeutralShape = (s: DanceShape) => s.sway === 1 && s.bounce === 1 && s.nod === 1 && s.slow === 0 && s.headX === 0 && s.headZ === 0;
/** Bounds of the shape whatever the style and reactions ask (the dance's own limits still clamp the pose). */
export const SHAPE_LIMITS = Object.freeze({ gain: [0.5, 1.3] as const, headX: 0.04, headZ: 0.03, energy: [-0.4, 0.2] as const });

export interface MusicReactContext {
  /** Her own choice is on (not "一直跟着跳"), she hears, automatic expression is on. */
  on: boolean;
  /** The music layer says this is music. */
  music: boolean;
  /** She dances or nods and it is shown (not yielding); false: she only listens (face-only reactions). */
  moving: boolean;
  speaking: boolean;
  temper: HormoneTemper;
  dispositions: DispositionTemper;
  /** The music layer's beat period (s) and how clear its beat is (0..1). */
  period: number;
  beatScore: number;
  /** Step 2: the card's music taste (absent or neutral: no effect at all). */
  taste?: Readonly<MusicTaste> | null;
  /** Step 2: a song memory is available (the stage can look songs up and learn them). */
  memory?: boolean;
}
export interface FaceRequest { id: string; slider: NonNullable<MusicVariant['face']>['slider']; amp: number; keys: NonNullable<MusicVariant['face']>['keys']; style: NonNullable<MusicVariant['face']>['style']; timeScale: number }
export interface MusicReactFrame {
  shape: DanceShape; tint: { smileEyes: number; lidSoft: number }; face: FaceRequest[]; moments: MusicIntent[];
  /** Per moment (same order): the factor her taste puts on its mood moment (1 = none; the host holds it to its own range). */
  scales: number[];
  /** Step 2: the intro's fingerprint to look up in the memory (this frame only), with the song's token for `recognized`. */
  ask: SongSketch | null; askToken: number;
  /** Step 2: a song that ended and was heard long enough: learn it. */
  learn: SongSketch | null;
}
export interface MusicReactRecord {
  /** Director clock (s) and the sample clock (s) when it happened. */
  at: number; sampleAt: number;
  outcome: 'scheduled' | 'started' | 'skipped' | 'dropped';
  trigger: 'lift' | 'fall' | 'spontaneous' | 'recognized';
  intent?: MusicIntent; variant?: string; reason?: string;
  /** For scheduled / started: the planned start on the sample clock, and whether it sat on the beat clock's group start. */
  startAt?: number; aligned?: boolean; period?: number; size?: number;
}

interface Active { pick: MusicPick; t0: number; beat: number; moving: boolean }
interface Pending { pick: MusicPick; startAt: number; aligned: boolean; beat: number; trigger: MusicReactRecord['trigger'] }

const clamp = (x: number, lo = 0, hi = 1) => Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;
/** A smooth limit between lo < 0 < hi: x itself near 0, approaching (never reaching) lo or hi; value and speed continuous; 0 stays exactly 0. */
export function softLimit(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x) || x === 0) return 0;
  return x > 0 ? hi * Math.tanh(x / hi) : lo * Math.tanh(x / lo);
}

export class MusicReact {
  readonly hearing = new MusicHearing();
  readonly ledger: MusicReactRecord[] = [];
  private readonly random: () => number;
  private clock = 0;
  private sampleClockAt = Number.NaN;
  private song: { start: number; reactions: number; spontaneousAt: number; spontaneousDone: boolean; off: number; token: number; asked: boolean } | null = null;
  private readonly profile = new SongProfiler();
  private songs = 0;
  private recognizedId: string | null = null;
  private readonly recognizedAt = new Map<string, number>();
  /** How much she likes this song (-1..1), followed slowly; exactly 0 without a taste. */
  private like = 0;
  private readonly likeV = { like: 0 };
  /** The liking her choices use: what the song's numbers say right now in the first seconds of a song, then the followed value (so no jump later). */
  private effective = 0;
  private nextAllowed = -Infinity;
  private last: string | null = null;
  private pending: Pending | null = null;
  private active: Active[] = [];
  private readonly shape: DanceShape = { ...NEUTRAL_SHAPE };
  private readonly style = { sway: 1, bounce: 1, nod: 1, slow: 0 };
  private readonly styleV = { sway: 0, bounce: 0, nod: 0, slow: 0 };
  private readonly tint = { smileEyes: 0, lidSoft: 0 };
  private readonly tintV = { smileEyes: 0, lidSoft: 0 };
  private readonly out: MusicReactFrame = { shape: this.shape, tint: this.tint, face: [], moments: [], scales: [], ask: null, askToken: 0, learn: null };

  constructor(random?: () => number, seed = 0x1077) {
    const rng = new SeededRandom(seed);
    this.random = random ?? (() => rng.next());
  }

  /** Seconds on the director's own clock (advanced by `frame`; the ledger's `at`). */
  get clockSeconds(): number { return this.clock; }

  /** Every capture sample (cheap; see hearing.ts). */
  hear(sample: MusicEnergySample): void {
    this.hearing.update(sample);
    if (Number.isFinite(this.hearing.time)) this.sampleClockAt = this.clock;
    this.profile.add(sample, this.hearing.tally);
  }

  /** The stage's answer to `ask`: the song with this token is one she knows (an old token, or none, is ignored). */
  recognized(token: number, id: string): void {
    if (this.song && this.song.token === token && typeof id === 'string') this.recognizedId = id;
  }

  /** The sample clock now (the last sample's time plus the frames since). */
  private sampleNow(): number { const t = this.hearing.time; return Number.isFinite(t) ? t + (this.clock - this.sampleClockAt) : Number.NaN; }

  frame(deltaSeconds: number, ctx: MusicReactContext): MusicReactFrame {
    const dt = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? Math.min(deltaSeconds, 0.25) : 0;
    this.clock += dt;
    const out = this.out; out.face = []; out.moments = []; out.scales = []; out.ask = null; out.learn = null;
    this.hearing.setPeriod(ctx.music && ctx.beatScore >= 0.4 ? ctx.period : 0);
    const now = this.sampleNow();
    // The song: from music recognized (while she chooses) to 3 s without it.
    const listening = ctx.on && ctx.music && ctx.temper.sleepy < 1;
    if (listening) {
      if (!this.song) { this.song = { start: this.clock, reactions: 0, spontaneousAt: this.clock + MUSIC_REACT_KNOBS.choice.spontaneousAfter + 15 * this.random(), spontaneousDone: false, off: 0, token: ++this.songs, asked: false }; this.recognizedId = null; }
      this.song.off = 0;
      this.profile.markMusic();
    } else if (this.song && (this.song.off += dt) >= 3) { this.song = null; this.recognizedId = null; }
    const events = this.hearing.takeEvents();
    for (const event of events) this.profile.noteSection(event.at);
    this.stepMemory(ctx, listening);
    this.stepTaste(dt, ctx, listening);
    if (listening && Number.isFinite(now) && this.song && this.clock - this.song.start >= 2) {
      for (const event of events) this.onEvent(event, ctx, now);
      if (!this.song.spontaneousDone && this.clock >= this.song.spontaneousAt) { this.song.spontaneousDone = true; if (!this.song.reactions) this.consider('spontaneous', ctx, now); }
    }
    if (this.recognizedId !== null) {
      const id = this.recognizedId; this.recognizedId = null;
      if (listening && Number.isFinite(now) && this.song && !ctx.speaking) this.consider('recognized', ctx, now, id);
    }
    this.startDue(ctx, now);
    this.composeShape(dt, ctx);
    this.composeTint(dt, ctx);
    return out;
  }

  private record(entry: MusicReactRecord): void { this.ledger.push(entry); if (this.ledger.length > 400) this.ledger.splice(0, this.ledger.length - 400); }

  private onEvent(event: SectionEvent, ctx: MusicReactContext, now: number): void {
    // An event confirmed long ago (frames stalled) is not acted on late.
    if (now - event.detectedAt > 1.5) { this.record({ at: this.clock, sampleAt: now, outcome: 'skipped', trigger: event.kind, reason: 'late' }); return; }
    this.consider(event.kind, ctx, now);
  }

  private consider(trigger: MusicReactRecord['trigger'], ctx: MusicReactContext, now: number, songId?: string): void {
    const song = this.song!, c = MUSIC_REACT_KNOBS.choice, known = trigger === 'recognized';
    const skip = (reason: string, intent?: MusicIntent) => this.record({ at: this.clock, sampleAt: now, outcome: 'skipped', trigger, reason, ...(intent ? { intent } : {}) });
    // Knowing the song is its own small reaction: not part of the per-song budget, but it keeps the same spacing and never repeats for one song.
    if (known && songId !== undefined) { const before = this.recognizedAt.get(songId); if (before !== undefined && this.clock - before < c.repeatSeconds) return skip('again'); this.recognizedAt.set(songId, this.clock); if (this.recognizedAt.size > 200) this.recognizedAt.delete(this.recognizedAt.keys().next().value!); }
    if (!known && song.reactions >= c.perSong) return skip('budget');
    if (this.pending) return skip('pending');
    if (this.clock < this.nextAllowed) return skip('gap');
    const intent = intentFor(trigger, this.hearing.color, ctx.temper, this.random, this.hearing.state.bpm);
    if (!intent) return skip('no-intent');
    const base = known ? c.recognize : intent === 'settle' ? c.settle : trigger === 'spontaneous' ? c.spontaneous : c.lift;
    // A clear beat: the next start of a group of four; otherwise now, at the change, gentler.
    const clock = this.hearing.clock, group = ctx.beatScore >= 0.5 && clock.confidence(now) >= 0.6 ? clock.nextGroupStart(now + 0.12) : null, aligned = group !== null;
    const pick = chooseMusic(intent, base, ctx.temper, ctx.dispositions, this.random, { already: known ? 0 : song.reactions, last: this.last, still: !ctx.moving, gentle: !aligned, taste: this.effective === 0 ? undefined : this.gains });
    if (typeof pick === 'string') return skip(pick, intent);
    const beat = aligned ? clock.beatPeriod : foldPeriod(ctx.period) || 0.6;
    const startAt = group ?? now;
    this.pending = { pick, startAt, aligned, beat, trigger };
    this.last = pick.variant.id;
    if (!known) song.reactions++;
    this.nextAllowed = this.clock + (startAt - now) + c.minGap + 8 * this.random();
    this.record({ at: this.clock, sampleAt: now, outcome: 'scheduled', trigger, intent, variant: pick.variant.id, startAt, aligned, period: beat, size: pick.size });
  }

  private startDue(ctx: MusicReactContext, now: number): void {
    const p = this.pending;
    if (!p || !(now >= p.startAt - 1e-9)) return;
    this.pending = null;
    // Not acted on late, and not over what came since: the song stopped, she started talking, fell asleep, was paused.
    const reason = !ctx.on ? 'off' : !ctx.music ? 'not-music' : ctx.speaking ? 'speaking' : ctx.temper.sleepy >= 1 ? 'asleep' : now - p.startAt > 0.25 ? 'late' : null;
    const base = { at: this.clock, sampleAt: now, trigger: p.trigger, intent: p.pick.intent, variant: p.pick.variant.id, startAt: p.startAt, aligned: p.aligned, period: p.beat, size: p.pick.size };
    if (reason) { this.record({ ...base, outcome: 'dropped', reason }); return; }
    const v = p.pick.variant;
    // Start from the beat's own time: the envelope is already this far in (at most a frame).
    this.active.push({ pick: p.pick, t0: this.clock - Math.max(0, now - p.startAt), beat: p.beat, moving: ctx.moving });
    if (v.face) {
      const [lo, hi] = v.face.amp;
      this.out.face.push({ id: v.id, slider: v.face.slider, amp: (lo + (hi - lo) * this.random()) * p.pick.size, keys: v.face.keys, style: v.face.style,
        timeScale: clamp(p.beat / 0.5, 1, 1.6) * p.pick.slow * (p.aligned ? 1 : 1.25) });
    }
    this.out.moments.push(p.pick.intent);
    // Her taste scales the mood moment of a song she enjoys or knows (one moment, scaled; never a second one).
    this.out.scales.push(p.pick.intent === 'enjoy' || p.pick.intent === 'recognize' ? this.gains.mood : 1);
    this.record({ ...base, outcome: 'started' });
  }

  /** For her choices (how often, how big, the mood moment): by `effective`. The dance's own gain follows `like` itself (it is continuous). */
  private get gains() { return this.effective === 0 ? NEUTRAL_GAINS : tasteGains(this.effective); }

  /** The intro's fingerprint, once per song, once it is measured and she knows the song is music; and a finished song to learn. */
  private stepMemory(ctx: MusicReactContext, listening: boolean): void {
    const out = this.out, song = this.song;
    const fin = this.profile.takeFinished();
    if (fin && ctx.memory === true) out.learn = fin.sketch;
    if (!listening || !song || song.asked || ctx.memory !== true || !this.profile.ready || this.clock - song.start < 2) return;
    const bpm = this.hearing.state.bpm;
    // The tempo is part of the print: wait (a few seconds at most) for the beat clock to lock; a song with no beat is asked without one.
    if (bpm === null && this.profile.heardSeconds < SONG_MEMORY_KNOBS.recognition.skipSeconds + SONG_MEMORY_KNOBS.recognition.introSeconds + SONG_MEMORY_KNOBS.recognition.tempoWaitSeconds) return;
    song.asked = true;
    this.profile.rememberBpm(bpm);
    const sketch = this.profile.sketch(bpm);
    if (sketch) { out.ask = sketch; out.askToken = song.token; }
  }

  /** How much she likes the song now, followed over a few seconds (exactly 0 without a taste, so nothing changes then). */
  private stepTaste(dt: number, ctx: MusicReactContext, listening: boolean): void {
    let target = 0;
    if (listening && ctx.taste && !(ctx.taste.tempo === 50 && ctx.taste.brightness === 50 && ctx.taste.energy === 50) && this.song) {
      const h = this.hearing, s = h.state;
      const feel: SongFeel = { bpm: s.bpm, brightness: h.brightness, density: s.density, pluck: s.pluck, bass: h.bass };
      target = tasteLiking(ctx.taste, feel);
    }
    this.like = dampCritical(this.like, target, 4 / MUSIC_REACT_KNOBS.taste.follow, dt, this.likeV, 'like');
    if (target === 0 && Math.abs(this.like) < 1e-6 && Math.abs(this.likeV.like) < 1e-5) { this.like = 0; this.likeV.like = 0; }
    this.effective = this.song && this.clock - this.song.start < MUSIC_REACT_KNOBS.taste.settleSeconds ? target : this.like;
  }

  private composeShape(dt: number, ctx: MusicReactContext): void {
    const st = MUSIC_REACT_KNOBS.style, h = this.hearing;
    const ready = ctx.on && ctx.music && !!this.song && this.clock - this.song.start >= st.settleSeconds;
    let sway = 1, bounce = 1, nod = 1, slow = 0;
    if (ready) {
      const pluck = h.pluck, bright = h.brightness, pb = pluck * bright, ss = (1 - pluck) * (1 - bright);
      bounce = 1 + st.bounce * (pb - ss);
      sway = 1 - 0.15 * (pb - ss);
      slow = st.slowSway * clamp((ss - 0.35) / 0.45);
      nod = 1 + st.nod * (2 * h.bass - 1);
      // Step 2: a song she likes is danced a little bigger, one she does not care for a little lighter (exactly 1 without a taste).
      const dance = this.like === 0 ? 1 : tasteGains(this.like).dance;
      if (dance !== 1) { sway *= dance; bounce *= dance; nod *= dance; }
    }
    const omega = 4 / st.follow, s = this.style, v = this.styleV;
    s.sway = dampCritical(s.sway, sway, omega, dt, v, 'sway'); s.bounce = dampCritical(s.bounce, bounce, omega, dt, v, 'bounce');
    s.nod = dampCritical(s.nod, nod, omega, dt, v, 'nod'); s.slow = dampCritical(s.slow, slow, omega, dt, v, 'slow');
    if (!ready) for (const key of ['sway', 'bounce', 'nod', 'slow'] as const) {
      const rest = key === 'slow' ? 0 : 1;
      if (Math.abs(s[key] - rest) < 1e-6 && Math.abs(v[key]) < 1e-5) { s[key] = rest; v[key] = 0; }
    }
    // Reactions on top, each on its own beat clock.
    let energy = 0, rslow = 0, hx = 0, hz = 0;
    this.active = this.active.filter(a => {
      const beats = (this.clock - a.t0) / a.beat, v = a.pick.variant;
      const end = Math.max(v.head ? keysEnd(v.head.keys) : 0, v.dance ? keysEnd(v.dance.keys) : 0);
      if (beats >= end) return false;
      const size = a.pick.size;
      if (v.dance) { const e = envelope(v.dance.keys, beats); energy += v.dance.energy * e * size; rslow = 1 - (1 - rslow) * (1 - v.dance.slow * e); }
      if (v.head) { const e = envelope(v.head.keys, beats) * size; hx += v.head.x * e; hz += v.head.z * e * a.pick.side; }
      return true;
    });
    // A reaction makes the dance at most 20 % bigger (its own per-frame motion then grows at most that much: R29's 1.25 × rule), and the
    // whole shape stays within SHAPE_LIMITS.gain. Soft limits (smooth saturation), so reaching one never puts a corner in the motion.
    energy = softLimit(energy, SHAPE_LIMITS.energy[0], SHAPE_LIMITS.energy[1]);
    const [lo, hi] = SHAPE_LIMITS.gain, shape = this.shape;
    shape.sway = 1 + softLimit(s.sway * (1 + energy) - 1, lo - 1, hi - 1); shape.bounce = 1 + softLimit(s.bounce * (1 + energy) - 1, lo - 1, hi - 1);
    shape.nod = 1 + softLimit(s.nod * (1 + energy) - 1, lo - 1, hi - 1);
    shape.slow = clamp(1 - (1 - s.slow) * (1 - rslow));
    shape.headX = clamp(hx, -SHAPE_LIMITS.headX, SHAPE_LIMITS.headX) + 0; shape.headZ = clamp(hz, -SHAPE_LIMITS.headZ, SHAPE_LIMITS.headZ) + 0;
  }

  private composeTint(dt: number, ctx: MusicReactContext): void {
    const f = MUSIC_REACT_KNOBS.face, color = this.hearing.color;
    const show = ctx.on && ctx.music && !!this.song && !ctx.speaking ? 1 - ctx.temper.sleepy : 0;
    const smile = show * f.smile * clamp((color - 0.1) / 0.5), soft = show * f.soft * clamp((-color - 0.2) / 0.5);
    const omega = 4 / f.follow, t = this.tint, v = this.tintV;
    t.smileEyes = Math.max(0, dampCritical(t.smileEyes, smile, omega, dt, v, 'smileEyes'));
    t.lidSoft = Math.max(0, dampCritical(t.lidSoft, soft, omega, dt, v, 'lidSoft'));
    for (const key of ['smileEyes', 'lidSoft'] as const) if ((key === 'smileEyes' ? smile : soft) === 0 && t[key] < 1e-6 && Math.abs(v[key]) < 1e-5) { t[key] = 0; v[key] = 0; }
  }

  /** Read-only state for diagnostics and the developer line. */
  getState() {
    const h = this.hearing.state, round = (x: number) => Math.round(x * 100) / 100;
    return { color: round(h.color), pluck: round(h.pluck), brightness: round(h.brightness), bass: round(h.bass), density: round(h.density), bpm: h.bpm ? Math.round(h.bpm) : null,
      beat: round(h.beat), section: round(h.section), song: this.song ? { reactions: this.song.reactions } : null, pending: this.pending?.pick.variant.id ?? null,
      active: this.active.map(a => a.pick.variant.id), shape: { ...this.shape }, tint: { ...this.tint }, like: round(this.like), last: this.ledger.at(-1) ?? null };
  }

  /** Hard cut (hide, the capture stopped, a model change): nothing is shown any more, nothing is kept. */
  reset(): void {
    this.hearing.reset(); this.profile.reset(); this.song = null; this.recognizedId = null; this.like = 0; this.likeV.like = 0; this.effective = 0; this.pending = null; this.active = []; this.last = null; this.nextAllowed = -Infinity; this.sampleClockAt = Number.NaN;
    Object.assign(this.shape, NEUTRAL_SHAPE); Object.assign(this.style, { sway: 1, bounce: 1, nod: 1, slow: 0 }); Object.assign(this.styleV, { sway: 0, bounce: 0, nod: 0, slow: 0 });
    this.tint.smileEyes = this.tint.lidSoft = this.tintV.smileEyes = this.tintV.lidSoft = 0;
  }
}

/** The developer panel's words: what she hears in the song right now. */
export function musicReactLine(state: ReturnType<MusicReact['getState']> | undefined): string {
  if (!state) return '';
  const tone = state.pluck >= 0.6 ? '一下一下弹的' : state.pluck <= 0.4 ? '拉长的' : '弹和拉长之间';
  const color = state.color >= 0.3 ? '亮而欢快' : state.color <= -0.35 ? '慢而暗' : '中间';
  const last = state.last?.outcome === 'started' ? `；刚才：${state.last.intent}（${state.last.variant}）` : '';
  return `听出来：${tone} · 情绪 ${color}（${state.color.toFixed(2)}）· 亮 ${state.brightness.toFixed(2)} · 低音 ${state.bass.toFixed(2)} · 拍子 ${state.beat.toFixed(2)}${last}`;
}
