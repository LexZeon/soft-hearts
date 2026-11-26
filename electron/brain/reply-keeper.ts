// Keeps her reply bubble where it is while the reply is on screen. Two rules, both pure, so tests can hold them:
// - The side is decided once per reply, from the full-size bubble (never from the small "……"), and locked until the reply is gone:
//   her head swaying, her walking or the "……" turning into text never flips the bubble to the other side. When the locked side runs short the
//   bubble keeps its minimum width and slides back inside the display (electron/brain/reply-layout.ts lockSide); only a control window that
//   cannot be avoided any other way (electron/brain/reply-avoid.ts LOCK_PENALTY) still moves it across.
// - The bubble stays put while her mouth drifts less than REPLY_SETTLE_DIP from where the placement was made and nothing else changed
//   (display, window size, small or full bubble, the rectangle to keep clear). A drag or a real step moves it, to a place that is
//   again inside the display. Nothing here is stored: the memory lives in the reply window object.
import { layoutReply, validReplyBounds, type ReplyAnchor, type ReplyBounds, type ReplySide } from './reply-layout';
import { chooseReplyPlacement, type AvoidChoice, type AvoidMemory } from './reply-avoid';

/** How far her mouth may drift (DIP) before the bubble is placed again. Small enough that a dragged window takes the bubble along. */
export const REPLY_SETTLE_DIP = 28;

type Avoid = ReplyBounds | readonly ReplyBounds[] | null | undefined;
const rectKey = (r: ReplyBounds | null | undefined) => validReplyBounds(r) ? `${r.x},${r.y},${r.width},${r.height}` : '-';
const inside = (inner: ReplyBounds, outer: ReplyBounds) => inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

export class ReplyPlacementKeeper {
  private lockedSide: ReplySide | undefined;
  private held: { sig: string; mouth: { x: number; y: number }; choice: AvoidChoice } | null = null;
  private memory: AvoidMemory | null = null;
  /** The side this reply is locked to, undefined before it has been placed. */
  get side(): ReplySide | undefined { return this.lockedSide; }
  /** The reply is gone (hidden, replaced by a new one): the next one chooses its own side. */
  release(): void { this.lockedSide = undefined; this.held = null; this.memory = null; }
  /** The rectangle to keep clear changed its source: forget the temporary place chosen for the old one. */
  forgetAvoid(): void { this.memory = null; this.held = null; }

  /** `rememberedSide` is the side the last reply took (a first choice only); once placed, the reply's own side rules. */
  place(owner: ReplyBounds, anchor: ReplyAnchor, area: ReplyBounds, rememberedSide: ReplySide | undefined, compact: boolean, avoid: Avoid): AvoidChoice {
    const mouth = { x: owner.x + Math.max(0, Math.min(owner.width, anchor.x)), y: owner.y + Math.max(0, Math.min(owner.height, anchor.y)) };
    const avoidKey = (Array.isArray(avoid) ? avoid : [avoid]).map(r => rectKey(r as ReplyBounds | null | undefined)).join('|');
    const sig = [owner.width, owner.height, rectKey(area), compact ? 'c' : 'f', avoidKey, anchor.visible ? 'v' : 'h', anchor.radius ?? ''].join(';');
    const held = this.held;
    if (this.lockedSide && held && held.sig === sig && held.choice.layout && inside(held.choice.layout.bounds, area)
      && Math.hypot(mouth.x - held.mouth.x, mouth.y - held.mouth.y) <= REPLY_SETTLE_DIP) return held.choice;
    // The side comes from the full-size bubble, so a small "……" at a crowded edge cannot pick the side the text would be squeezed on.
    if (!this.lockedSide) this.lockedSide = layoutReply(owner, anchor, area, rememberedSide, false)?.side ?? rememberedSide;
    const choice = chooseReplyPlacement(owner, anchor, area, this.lockedSide, compact, avoid, this.memory, this.lockedSide !== undefined);
    this.memory = choice.memory;
    if (choice.layout) { this.held = { sig, mouth, choice }; if (!this.lockedSide) this.lockedSide = choice.baseSide ?? choice.layout.side; }
    else this.held = null;
    return choice;
  }
}
