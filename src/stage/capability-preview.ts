import { MODEL_CAPABILITY_IDS, type ModelCapabilityId } from '../../shared/model-capability';

/**
 * I-024 "试一下" (docs/claude/2026-11-04-i024-stage.md): the character page asks the pet to show one capability
 * once. Pure timing: each preview has a smooth envelope on the stage's own clock (seconds), and the stage reads
 * the amounts per frame through its existing writers (eyelid compositor, mouth, blush, sleep-pose layer, the
 * pose-reaction wave, the drowsy face, the tears surface). Several previews may overlap; asking again for one still showing does not restart it,
 * so nothing jumps back to zero. Every amount ends at exactly 0: the program layer then restores the base.
 */

/** Rise, hold-until and fall (s) of each envelope; the preview is over after hold + fall. */
const SHAPES: Readonly<Record<ModelCapabilityId, { rise: number; hold: number; fall: number; peak: number }>> = Object.freeze({
  closeEyes: { rise: 0.25, hold: 1.2, fall: 0.3, peak: 1 },
  blush: { rise: 0.4, hold: 1.5, fall: 0.5, peak: 0.75 },
  mouth: { rise: 0.12, hold: 0.45, fall: 0.15, peak: 0.7 },
  /** The eyes close while the sleep pose holds; the stage's sleep phase override lasts until `hold`. */
  sleepPose: { rise: 0.6, hold: 3, fall: 0.5, peak: 0.98 },
  /** The wave is one pose-reaction cue: it only needs to be offered for a moment, then plays on its own. */
  gesture: { rise: 0, hold: 0.5, fall: 0, peak: 1 },
  /** The drowsy face's own easing does the shape; this only holds the phase override (then it eases back out by itself). */
  drowsyFace: { rise: 0, hold: 2.5, fall: 0, peak: 1 },
  tears: { rise: 0.5, hold: 3.5, fall: 0.8, peak: 0.85 },
});
export const capabilityPreviewSeconds = (id: ModelCapabilityId): number => SHAPES[id].hold + SHAPES[id].fall;

const smoothstep = (value: number) => { const t = Math.min(1, Math.max(0, value)); return t * t * (3 - 2 * t); };

/** 0 outside the preview; smooth rise to `peak`, hold, smooth fall back to 0. */
export function previewEnvelope(id: ModelCapabilityId, t: number): number {
  const shape = SHAPES[id];
  if (!shape || !Number.isFinite(t) || t < 0 || t >= shape.hold + shape.fall) return 0;
  const rise = shape.rise > 0 ? smoothstep(t / shape.rise) : 1;
  const fall = t <= shape.hold ? 1 : shape.fall > 0 ? 1 - smoothstep((t - shape.hold) / shape.fall) : 0;
  return shape.peak * Math.min(rise, fall);
}

export interface CapabilityPreviewFrame {
  /** Eyelid closure request (closeEyes, and the eyes of the sleep preview). */
  closure: number;
  /** The sleep preview's own eyes (shown only when the model can close its eyes). */
  sleepEyes: number;
  blush: number;
  mouth: number;
  /** The sleep phase override is on (the pose settles; afterwards the real phase takes over and she wakes). */
  sleep: boolean;
  /** The wave cue to offer this frame (gesture), or null. */
  wave: { id: string; at: number } | null;
  /** The drowsy-face phase override is on. */
  drowsy: boolean;
  /** Tear amount, and ms since the tears preview began (the trail grows with it). */
  tears: number;
  tearsMs: number;
}
export const NO_CAPABILITY_PREVIEW: CapabilityPreviewFrame = Object.freeze({ closure: 0, sleepEyes: 0, blush: 0, mouth: 0, sleep: false, wave: null,
  drowsy: false, tears: 0, tearsMs: 0 });

export const isModelCapabilityId = (value: unknown): value is ModelCapabilityId =>
  typeof value === 'string' && (MODEL_CAPABILITY_IDS as readonly string[]).includes(value);

export class CapabilityPreviews {
  private owner: object | null = null;
  private readonly running = new Map<ModelCapabilityId, { start: number; cue: { id: string; at: number } | null }>();
  private serial = 0;

  /** Starts one preview at `now` (stage seconds). false when it is already showing (it keeps going, unchanged). */
  start(id: ModelCapabilityId, now: number, owner: object | null, wallMs = Date.now()): boolean {
    if (owner !== this.owner) { this.owner = owner; this.running.clear(); }
    if (this.running.has(id)) return false;
    this.running.set(id, { start: now, cue: id === 'gesture' ? { id: `capability-preview-${++this.serial}`, at: wallMs } : null });
    return true;
  }
  showing(id: ModelCapabilityId): boolean { return this.running.has(id); }
  get active(): boolean { return this.running.size > 0; }
  clear(): void { this.running.clear(); }

  /** This frame's amounts; finished previews are dropped (a model change drops all). */
  frame(now: number, owner: object | null): CapabilityPreviewFrame {
    if (owner !== this.owner) { this.owner = owner; this.running.clear(); }
    if (!this.running.size) return NO_CAPABILITY_PREVIEW;
    const out = { closure: 0, sleepEyes: 0, blush: 0, mouth: 0, sleep: false, wave: null as CapabilityPreviewFrame['wave'], drowsy: false, tears: 0, tearsMs: 0 };
    for (const [id, entry] of [...this.running]) {
      const t = now - entry.start;
      if (!(t < capabilityPreviewSeconds(id))) { this.running.delete(id); continue; }
      const value = previewEnvelope(id, t);
      if (id === 'closeEyes') out.closure = Math.max(out.closure, value);
      else if (id === 'blush') out.blush = value;
      else if (id === 'mouth') out.mouth = value;
      else if (id === 'sleepPose') { out.sleepEyes = value; out.sleep = t < SHAPES.sleepPose.hold; }
      else if (id === 'gesture') out.wave = entry.cue;
      else if (id === 'drowsyFace') out.drowsy = true;
      else if (id === 'tears') { out.tears = value; out.tearsMs = t * 1000; }
    }
    return out;
  }
}
