// I-048 §3: is this frame different enough from the last one described to be worth describing? Works on small grayscale thumbnails
// (for example 32x18 bytes); making the thumbnail from a screenshot is the caller's job. Pure: the clock is passed in.

import { WATCH_TIMELINE_KNOBS, type WatchTimelineKnobs } from './knobs';

export type FrameVerdict =
  | { readonly describe: true; readonly share: number }
  | { readonly describe: false; readonly reason: 'invalid' | 'too-soon' | 'same-as-before' | 'small-change'; readonly share: number };

/** Share (0..1) of points that moved by more than `pixelDelta`. Different sizes count as a full change. */
export function changedShare(before: Uint8Array, after: Uint8Array, pixelDelta: number): number {
  if (before.length !== after.length) return 1;
  if (!after.length) return 0;
  let moved = 0;
  for (let index = 0; index < after.length; index++) if (Math.abs(before[index] - after[index]) > pixelDelta) moved++;
  return moved / after.length;
}

/** Two independent 32-bit FNV-style hashes plus the length: plenty for "the same thumbnail" (shared/ stays free of node modules). */
function digest(thumb: Uint8Array): string {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let index = 0; index < thumb.length; index++) {
    a = Math.imul(a ^ thumb[index], 0x01000193) >>> 0;
    b = Math.imul(b + thumb[index] + index, 0x85ebca6b) >>> 0;
    b ^= b >>> 13;
  }
  return `${thumb.length}:${a.toString(16)}:${b.toString(16)}`;
}

/**
 * `check` says whether to describe; `commit` records that the frame was (or is being) described. Compared with the last described
 * frame, not the last seen one, so a slow fade adds up until it counts. A frame whose thumbnail is byte-identical to one of the
 * recent described ones is never described again.
 */
export class FrameGate {
  private last: Uint8Array | null = null;
  private lastAt: number | null = null;
  private seen: string[] = [];

  constructor(private readonly knobs: WatchTimelineKnobs['frame'] = WATCH_TIMELINE_KNOBS.frame) {}

  check(thumb: Uint8Array, now: number): FrameVerdict {
    if (!(thumb instanceof Uint8Array) || !thumb.length) return { describe: false, reason: 'invalid', share: 0 };
    if (this.seen.includes(digest(thumb))) return { describe: false, reason: 'same-as-before', share: 0 };
    if (this.lastAt !== null && now - this.lastAt < this.knobs.minGapSeconds * 1000) return { describe: false, reason: 'too-soon', share: 0 };
    if (!this.last) return { describe: true, share: 1 };
    const share = changedShare(this.last, thumb, this.knobs.pixelDelta);
    return share >= this.knobs.changedShare ? { describe: true, share } : { describe: false, reason: 'small-change', share };
  }

  commit(thumb: Uint8Array, now: number): void {
    this.last = Uint8Array.from(thumb);
    this.lastAt = now;
    this.seen.push(digest(thumb));
    if (this.seen.length > Math.max(1, this.knobs.remembered)) this.seen.shift();
  }

  /** Watch turned off or a new show: the next frame is a first frame again. */
  reset(): void {
    this.last = null; this.lastAt = null; this.seen = [];
  }
}
