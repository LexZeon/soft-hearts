/**
 * I-154 batch 7, row 42 体检卡「试一下」 (docs/claude/2026-11-19-unbound-in-window.md; the old stage's src/stage/mmd/capabilities.ts):
 * the character page asks the companion to show one capability once; on the window engine the same envelopes (src/stage/capability-preview.ts,
 * each a smooth rise, hold and fall on the stage's own clock) feed the window's own writers:
 *  - 能闭眼: an enjoyed closure on her lids (window-face.ts); the sleep preview's eyes too when the card can close them;
 *  - 能脸红: the blush at the envelope's amount (unless 能脸红 is off), painted or her own morph;
 *  - 有口型: あ through the snack mouth's channel (value and owner follow the envelope, so a speaking mouth hands over without a jump);
 *  - 能做睡姿: the sleep pose's phase held at asleep (rate 2) for 3 s, then the real phase takes over and she wakes by its own springs;
 *  - 能做手势: one small wave, offered to the pose reactions as one cue over the host's view (the wave batch 5 left for this row);
 *  - 困的脸: the drowsy phase held (F 0.9) for 2.5 s; the drowsy face eases in and back out by itself;
 *  - 能流泪: the tears at the envelope's amount on their own clock, unless a real cry shows more.
 * The gates are the old stage's: an id the card turns off, no model drawn yet, hidden, or the part owned now (a picked expression owns her
 * face, the mouth or the head; she is not free for the wave) answer false, and nothing starts. Asking again while it shows keeps it
 * going (no restart, nothing drops to zero). A new model or hiding the window drops them (a 试一下 nobody saw is not played later).
 */
import { CapabilityPreviews, NO_CAPABILITY_PREVIEW, isModelCapabilityId, type CapabilityPreviewFrame } from '../../stage';
import { capabilityEnabled, type ModelCapabilities, type ModelCapabilityId } from '../../../shared/stage';

/** What the stage has and holds now, for each capability (the old stage's capabilityPreviewPossible inputs). */
export interface WindowCapabilityContext {
  /** Drawn: not disposed, shown, a model rendered and faded in at least once. */
  ready: boolean;
  card: ModelCapabilities | null;
  /** A picked expression motion owns her face / her mouth (window-face-rig.ts faceBlocks). */
  faceBlocked: boolean;
  mouthBlocked: boolean;
  /** The model has a blink slot / a mouth (あ) she opens. */
  lids: boolean;
  mouth: boolean;
  /** A mood view (her face's blush and tears answer through it). */
  mood: boolean;
  /** The blush can be shown (painted on her face, or her own morph). */
  blush: boolean;
  /** She has a head bone, and nothing owns it now (a picked head motion, a pull, the game's head). */
  head: boolean;
  headOwned: boolean;
  /** The drowsy face may show (the card or the reviewed Gene, expressions on, its brow or lids found on this model). */
  drowsy: boolean;
  /** The tear surface is on her face. */
  tears: boolean;
  /** She is free for the wave: expressive, the user not here, not asleep, nothing higher owns her body, no game, offer, hand or reaction. */
  free: boolean;
}

/** Whether `id` can be shown now (the old stage's capabilityPreviewPossible, on the window's state). */
export function windowCapabilityPossible(id: ModelCapabilityId, ctx: WindowCapabilityContext): boolean {
  switch (id) {
    case 'closeEyes': return ctx.lids && !ctx.faceBlocked;
    case 'mouth': return ctx.mouth && !ctx.mouthBlocked;
    case 'blush': return ctx.mood && !ctx.faceBlocked && ctx.blush;
    case 'sleepPose': return ctx.head && !ctx.headOwned;
    case 'drowsyFace': return ctx.drowsy && !ctx.faceBlocked;
    case 'tears': return ctx.mood && !ctx.faceBlocked && ctx.tears;
    case 'gesture': return ctx.free;
  }
  return false;
}

export class WindowCapabilityPreviews {
  private readonly previews = new CapabilityPreviews();
  private t = 0;
  private last: CapabilityPreviewFrame = NO_CAPABILITY_PREVIEW;

  /** 试一下: true when it plays now (or already does); false when the card says no, she is not drawn, or the part is owned now. */
  start(id: unknown, owner: object | null, ctx: WindowCapabilityContext, wallMs = Date.now()): boolean {
    if (!isModelCapabilityId(id) || !owner || !ctx.ready || !capabilityEnabled(ctx.card, id)) return false;
    if (this.previews.showing(id)) return true;
    if (!windowCapabilityPossible(id, ctx)) return false;
    return this.previews.start(id, this.t, owner, wallMs);
  }

  /** This frame's amounts on the stage's own clock (a new owner, i.e. model, drops what ran). */
  frame(dt: number, owner: object | null): CapabilityPreviewFrame {
    this.t += Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
    this.last = this.previews.frame(this.t, owner);
    return this.last;
  }

  /** The amounts of the last frame (NO_CAPABILITY_PREVIEW when none). */
  get now(): CapabilityPreviewFrame { return this.last; }
  get active(): boolean { return this.previews.active; }
  /** Hidden or the model gone: nothing resumes later. */
  clear(): void { this.previews.clear(); this.last = NO_CAPABILITY_PREVIEW; }
}

/** The lids the previews ask for: 能闭眼, and the eyes of the sleep preview when the card can close them (the old stage's previewClosure). */
export function previewClosure(frame: CapabilityPreviewFrame, card: ModelCapabilities | null): number {
  return Math.max(frame.closure, capabilityEnabled(card, 'closeEyes') ? frame.sleepEyes : 0);
}

/** 有口型: あ as the snack mouth's channel; the owner follows the envelope (peak 0.7), so a speaking mouth hands over smoothly. */
export function previewMouth(frame: CapabilityPreviewFrame, snack: { value: number; owner: number } | null | undefined): { value: number; owner: number } | null {
  if (!(frame.mouth > 0)) return snack ?? null;
  const owner = Math.min(1, frame.mouth / 0.7);
  if (snack && snack.owner >= owner && snack.value >= frame.mouth) return snack;
  return { value: Math.max(frame.mouth, snack?.value ?? 0), owner: Math.max(owner, snack?.owner ?? 0) };
}

/** 能做手势: the pose reactions' view with the preview's wave over what the host sent (the old stage's poseReactionView). */
export function withWave(view: unknown, wave: CapabilityPreviewFrame['wave'], read: (value: unknown) => { attention?: number; boost?: number } | null): unknown {
  if (!wave) return view;
  const real = read(view);
  return { attention: real?.attention ?? 0, boost: real?.boost ?? 1, cue: { id: wave.id, kind: 'wave', source: 'own', at: wave.at, strength: 1 } };
}
