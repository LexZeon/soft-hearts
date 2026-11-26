/**
 * Motion-model spike, group C (docs/claude/2026-11-14-motion-model-spike.md): the small trained idle model, run live in plain
 * TypeScript (no runtime, no native code). It is the decoder of an autoregressive conditional VAE trained on CPU
 * (scripts/ml/train_idle_vae.py): from the last few frames, the liveliness knob and a latent z it predicts the next `chunk` frames
 * (30 Hz; 1 = frame by frame, 15 = half a second) as offsets from the last frame. It streams: a chunk is ready long before it is
 * shown (one decoder call, well under a millisecond), and Resampled30 plays the frames at the display rate.
 *
 * Round 2: z comes from a learned prior p(z | history, knob) when the weights have one (else N(0, I)); the noise that picks z inside
 * that prior walks slowly from chunk to chunk (AR(1)), which makes the same knob give different but continuous idles. Per-channel
 * output gains (`gain`, from the training script's calibration against the people's spread) scale only what is shown, never the
 * model's own history, so the dynamics stay the model's.
 *
 * The weights are data (a JSON the training script writes under .local/ml/, never shipped); a guard keeps every output bounded.
 */
import { IDLE_DIM, gaussian, seededRandom, type IdleSource } from './idle-channels';

type DenseJson = { weight: number[][]; bias: number[] }[];
export interface IdleModelWeights {
  kind: 'idle-ar-cvae';
  history: number;
  /** Frames per decoder call (absent: 1). */
  chunk?: number;
  latent: number;
  hidden: number;
  dim: number;
  std: number[];
  /** AR(1) coefficient of the z noise per chunk the model was checked with (absent: 0.9 per frame). */
  zMemoryPerChunk?: number;
  /** Per-channel output gains (absent: 1). */
  gain?: number[];
  layers: DenseJson;
  /** The learned prior's layers: concat(history, knob) → (mu, logvar) of z. */
  prior?: DenseJson;
  parity?: { history: number[][]; z: number[]; activity: number; out: number[]; priorMu?: number[]; priorLogvar?: number[] };
}

interface Dense { w: Float32Array; b: Float32Array; inputs: number; outputs: number }
const elu = (v: number) => (v > 0 ? v : Math.expm1(v));

/** A small ELU MLP (the last layer linear), run in place. */
class Mlp {
  private readonly layers: Dense[];
  private readonly buffers: Float32Array[];
  readonly parameters: number;
  constructor(json: DenseJson) {
    this.layers = json.map(l => ({ w: Float32Array.from(l.weight.flat()), b: Float32Array.from(l.bias), inputs: l.weight[0].length, outputs: l.weight.length }));
    this.buffers = [new Float32Array(this.layers[0].inputs), ...this.layers.map(l => new Float32Array(l.outputs))];
    this.parameters = this.layers.reduce((n, l) => n + l.w.length + l.b.length, 0);
  }
  get inputs(): number { return this.layers[0].inputs; }
  get outputs(): number { return this.layers.at(-1)!.outputs; }
  get input(): Float32Array { return this.buffers[0]; }
  run(): Float32Array {
    for (let l = 0; l < this.layers.length; l++) {
      const { w, b, inputs, outputs } = this.layers[l], input = this.buffers[l], output = this.buffers[l + 1], last = l === this.layers.length - 1;
      for (let o = 0; o < outputs; o++) {
        let s = b[o];
        const row = o * inputs;
        for (let i = 0; i < inputs; i++) s += w[row + i] * input[i];
        output[o] = last ? s : elu(s);
      }
    }
    return this.buffers[this.layers.length];
  }
}

export class IdleModel {
  readonly history: number;
  readonly chunk: number;
  readonly latent: number;
  readonly std: Float32Array;
  readonly gain: Float32Array;
  readonly zMemoryPerChunk: number;
  private readonly decoder: Mlp;
  private readonly priorNet: Mlp | null;
  readonly parameters: number;

  constructor(weights: IdleModelWeights) {
    if (weights.kind !== 'idle-ar-cvae' || weights.dim !== IDLE_DIM) throw new Error('Not an idle model for these channels.');
    this.history = weights.history; this.latent = weights.latent; this.chunk = Math.max(1, Math.round(weights.chunk ?? 1));
    this.zMemoryPerChunk = weights.zMemoryPerChunk ?? 0.9 ** this.chunk;
    this.std = Float32Array.from(weights.std);
    this.gain = Float32Array.from({ length: IDLE_DIM }, (_, c) => { const g = weights.gain?.[c] ?? 1; return Number.isFinite(g) ? Math.max(0, Math.min(3, g)) : 1; });
    this.decoder = new Mlp(weights.layers);
    if (this.decoder.inputs !== this.latent + this.history * IDLE_DIM + 1 || this.decoder.outputs !== this.chunk * IDLE_DIM) throw new Error('Idle model shapes do not match.');
    this.priorNet = weights.prior ? new Mlp(weights.prior) : null;
    if (this.priorNet && (this.priorNet.inputs !== this.history * IDLE_DIM + 1 || this.priorNet.outputs !== 2 * this.latent)) throw new Error('Idle model prior shapes do not match.');
    this.parameters = this.decoder.parameters + (this.priorNet?.parameters ?? 0);
  }

  get hasPrior(): boolean { return !!this.priorNet; }

  /** Decoder: offsets of the next `chunk` frames from the last one (std units, frame-major), from z, the history (oldest first) and the knob. */
  delta(z: ArrayLike<number>, history: ArrayLike<number>, activity: number, out = new Float32Array(this.chunk * IDLE_DIM)): Float32Array {
    const x = this.decoder.input;
    let k = 0;
    for (let i = 0; i < this.latent; i++) x[k++] = z[i];
    for (let i = 0; i < this.history * IDLE_DIM; i++) x[k++] = history[i];
    x[k] = activity;
    out.set(this.decoder.run());
    return out;
  }

  /** The prior of z given the history and the knob: writes mu and logvar (N(0, I) when the weights have no prior). */
  prior(history: ArrayLike<number>, activity: number, mu: Float32Array, logvar: Float32Array): void {
    if (!this.priorNet) { mu.fill(0); logvar.fill(0); return; }
    const x = this.priorNet.input;
    for (let i = 0; i < this.history * IDLE_DIM; i++) x[i] = history[i];
    x[this.history * IDLE_DIM] = activity;
    const y = this.priorNet.run();
    for (let i = 0; i < this.latent; i++) { mu[i] = y[i]; logvar[i] = Math.max(-8, Math.min(4, y[this.latent + i])); }
  }
}

export interface ModelIdleOptions {
  seed: number;
  /** AR(1) coefficient of the z noise per decoder call (default: the model's own). */
  zMemory?: number;
  /** Spread of the z noise against the prior's. */
  zScale: number;
  /** Use the calibration gains (default true). */
  calibrated: boolean;
  /**
   * Leash (s; 0 = off): every frame the model makes is pulled back toward her own stand pose with this time constant, and the model
   * continues from the pulled frame. Over minutes a free-running model wanders off (round 2: a 30° head offset after two minutes);
   * people stay around their posture. A guard, not learned: reported as such.
   */
  leashS: number;
}
export const MODEL_IDLE_DEFAULTS: Readonly<ModelIdleOptions> = Object.freeze({ seed: 11, zScale: 1, calibrated: true, leashS: 12 });

/** The model as an idle source (std units inside, channel units out). */
export class ModelIdle implements IdleSource {
  readonly id = 'model';
  private readonly options: ModelIdleOptions;
  private random: () => number;
  private readonly hist: Float32Array;
  private readonly eps: Float32Array;
  private readonly z: Float32Array;
  private readonly mu: Float32Array;
  private readonly logvar: Float32Array;
  private readonly pending: Float32Array;
  private pendingAt: number;
  private readonly out = new Float32Array(IDLE_DIM);
  /** Frames where the guard had to pull a channel back (should stay 0), and decoder calls so far. */
  guarded = 0;
  calls = 0;

  constructor(readonly model: IdleModel, options: Partial<ModelIdleOptions> = {}) {
    this.options = { ...MODEL_IDLE_DEFAULTS, ...options };
    this.random = seededRandom(this.options.seed);
    this.hist = new Float32Array(model.history * IDLE_DIM);
    this.eps = new Float32Array(model.latent); this.z = new Float32Array(model.latent);
    this.mu = new Float32Array(model.latent); this.logvar = new Float32Array(model.latent);
    this.pending = new Float32Array(model.chunk * IDLE_DIM);
    this.pendingAt = model.chunk;
  }

  reset(seed = this.options.seed): void { this.random = seededRandom(seed); this.hist.fill(0); this.eps.fill(0); this.pendingAt = this.model.chunk; this.guarded = 0; this.calls = 0; }

  next(activity: number): Float32Array {
    const H = this.model.history, last = (H - 1) * IDLE_DIM;
    if (this.pendingAt >= this.model.chunk) {
      const a = Math.max(0, Math.min(1, Number.isFinite(activity) ? activity : 0.5));
      const memory = this.options.zMemory ?? this.model.zMemoryPerChunk, fresh = Math.sqrt(Math.max(0, 1 - memory * memory));
      for (let i = 0; i < this.eps.length; i++) this.eps[i] = memory * this.eps[i] + fresh * this.options.zScale * gaussian(this.random);
      this.model.prior(this.hist, a, this.mu, this.logvar);
      for (let i = 0; i < this.z.length; i++) this.z[i] = this.mu[i] + Math.exp(0.5 * this.logvar[i]) * this.eps[i];
      this.model.delta(this.z, this.hist, a, this.pending);
      // Absolute frames, each pulled toward her stand pose by the leash for the time since the last frame shown.
      const keep = this.options.leashS > 0 ? Math.exp(-1 / 30 / this.options.leashS) : 1;
      for (let k = 0, pull = keep; k < this.model.chunk; k++, pull *= keep) for (let c = 0; c < IDLE_DIM; c++) this.pending[k * IDLE_DIM + c] = (this.pending[k * IDLE_DIM + c] + this.hist[last + c]) * pull;
      this.pendingAt = 0;
      this.calls++;
    }
    const base = this.pendingAt++ * IDLE_DIM, gain = this.options.calibrated ? this.model.gain : null;
    let pulled = false;
    this.hist.copyWithin(0, IDLE_DIM);
    for (let c = 0; c < IDLE_DIM; c++) {
      let v = this.pending[base + c];
      // Guard: never beyond 4 spreads (a person's idle stays well inside; a runaway model would not).
      if (!Number.isFinite(v)) { v = 0; pulled = true; } else if (Math.abs(v) > 4) { v = Math.sign(v) * 4; pulled = true; }
      this.hist[last + c] = v;
      this.out[c] = v * this.model.std[c] * (gain ? gain[c] : 1);
    }
    if (pulled) this.guarded++;
    return this.out;
  }
}
