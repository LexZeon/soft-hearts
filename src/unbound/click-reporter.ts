/**
 * Unbound v1 step 2: from the mouse on her window to one report "the user clicked her (this part, this side)"
 * (docs/claude/2026-11-15-unbound-v1-step2-typing.md). The page only says what happened; the host reports the touch and opens the
 * box, and what she does about it is hers. No scripted reaction lives here.
 *
 * A press counts when it lands on her silhouette (the nearest capsule, within a few pixels); the part comes from the name of that
 * capsule's bone and its ancestors (shared/mood/touch-part.ts). Ports keep it free of three.js so tests drive it.
 */
import { ClickClassifier } from '../../shared/unbound/click';
import { touchOfBoneChain } from '../../shared/mood';
import type { HeadSpot, UnboundTouchReport } from '../../shared/unbound/typing';

/** The press must land within this many pixels of her silhouette's edge to count as on her (the hit test's own edge is 0). */
export const CLICK_MARGIN_PX = 4;

export interface ClickReporterPorts {
  /** The silhouette piece nearest to the point (its bone and the signed distance, ≤ 0 inside), or null. */
  nearest(x: number, y: number): { bone: number | undefined; distance: number } | null;
  /** Names of that bone and its ancestors, the bone first. */
  names(bone: number): string[];
  head(): HeadSpot | null;
  /** She can be clicked now (the window is taking the mouse, no peek is playing, she is on screen). */
  eligible(): boolean;
  send(report: UnboundTouchReport): void;
  clock(): number;
}

export class ClickReporter {
  private readonly classifier = new ClickClassifier();
  private hit: { bone: number | undefined } | null = null;
  constructor(private readonly ports: ClickReporterPorts) {}

  down(x: number, y: number): void {
    const near = this.ports.eligible() ? this.ports.nearest(x, y) : null;
    const onHer = !!near && near.distance <= CLICK_MARGIN_PX;
    this.hit = onHer ? { bone: near!.bone } : null;
    this.classifier.down(x, y, this.ports.clock(), onHer);
  }

  /** The release. True when it was a click and was reported (once). */
  up(x: number, y: number): boolean {
    const hit = this.hit;
    this.hit = null;
    if (!this.classifier.up(x, y, this.ports.clock()) || !hit || !this.ports.eligible()) return false;
    const { part, side } = hit.bone === undefined ? { part: 'other' as const, side: null } : touchOfBoneChain(this.ports.names(hit.bone));
    this.ports.send({ part, side, head: this.ports.head() });
    return true;
  }

  /** I-190: a right press on her opens the input box with the senses panel (reported once; not a touch). True when reported. */
  menu(x: number, y: number): boolean {
    const near = this.ports.eligible() ? this.ports.nearest(x, y) : null;
    if (!near || near.distance > CLICK_MARGIN_PX) return false;
    const { part, side } = near.bone === undefined ? { part: 'other' as const, side: null } : touchOfBoneChain(this.ports.names(near.bone));
    this.ports.send({ part, side, head: this.ports.head(), menu: true });
    return true;
  }

  /** I-194: the press that began on her was held still (shared/unbound/pull-stick/press.ts): one touch report with `hold`, no box. True when reported. */
  hold(): boolean {
    const hit = this.hit;
    this.cancel();
    if (!hit || !this.ports.eligible()) return false;
    const { part, side } = hit.bone === undefined ? { part: 'other' as const, side: null } : touchOfBoneChain(this.ports.names(hit.bone));
    this.ports.send({ part, side, head: this.ports.head(), hold: true });
    return true;
  }

  cancel(): void { this.hit = null; this.classifier.cancel(); }
}
