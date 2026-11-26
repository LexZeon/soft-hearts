/**
 * Unbound U1 part 2: live numbers about her body for the developer line and the preview script (docs/claude/2026-11-12-unbound-u1-part2.md).
 * Fed once per shown frame with what the figure reported; meters in, centimetres out. Cheap (a few vector sums per frame).
 *
 * - drift: over every interval a foot stays planted, how far its toe (the point that is always down) gets from where it was;
 * - rootStep / rootSurprise: her place's largest per-frame move and how far a frame's move departs from the previous one;
 * - comMargin: the smallest COM margin seen while she stood on both feet (not walking).
 */
export interface MeterFrame {
  root: { x: number; y: number; z: number };
  feet: readonly { planted: boolean; toe: { x: number; y: number; z: number } | null }[];
  standing: boolean;
  comMargin: number | null;
}
export interface MeterSummary { frames: number; driftCm: number; rootStepCm: number; rootSurpriseCm: number; standingComMarginCm: number | null }

const distance = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export class BodyMeter {
  private anchors: ({ x: number; y: number; z: number } | null)[] = [null, null];
  private last: { x: number; y: number; z: number } | null = null;
  private lastStep: { x: number; y: number; z: number } | null = null;
  private summary: MeterSummary = { frames: 0, driftCm: 0, rootStepCm: 0, rootSurpriseCm: 0, standingComMarginCm: null };

  reset(): void {
    this.anchors = [null, null]; this.last = this.lastStep = null;
    this.summary = { frames: 0, driftCm: 0, rootStepCm: 0, rootSurpriseCm: 0, standingComMarginCm: null };
  }

  add(frame: MeterFrame): void {
    const s = this.summary;
    s.frames++;
    frame.feet.forEach((foot, i) => {
      if (!foot.planted || !foot.toe) { this.anchors[i] = null; return; }
      const anchor = this.anchors[i] ??= { ...foot.toe };
      s.driftCm = Math.max(s.driftCm, distance(foot.toe, anchor) * 100);
    });
    if (this.last) {
      const step = { x: frame.root.x - this.last.x, y: frame.root.y - this.last.y, z: frame.root.z - this.last.z };
      s.rootStepCm = Math.max(s.rootStepCm, Math.hypot(step.x, step.y, step.z) * 100);
      if (this.lastStep) s.rootSurpriseCm = Math.max(s.rootSurpriseCm, distance(step, this.lastStep) * 100);
      this.lastStep = step;
    }
    this.last = { ...frame.root };
    if (frame.standing && frame.comMargin !== null && Number.isFinite(frame.comMargin))
      s.standingComMarginCm = Math.min(s.standingComMarginCm ?? Infinity, frame.comMargin * 100);
  }

  get value(): MeterSummary { return { ...this.summary }; }
}
