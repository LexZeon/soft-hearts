/**
 * 体验记录 (脸红, docs/claude/2026-11-06-journal-batch1.md): when a NEW blush cue reaches the pet's stage, could the stage show it,
 * and if not, why. Told once per cue (the cue's id), as a closed category; nothing else leaves the stage. The mood model decides
 * whether she blushes at all; this only reports what the stage did with it.
 */
export type BlushStageState = 'shown' | 'no-cheek' | 'face-busy' | 'off' | 'size-zero';

export interface BlushSeenFacts {
  /** The stage's blush path now: the procedural cheeks, the model's own morph, or none (cheeks not found / model unsupported). */
  path: 'procedural' | 'morph' | 'none';
  /** A motion owns the face (the stage skips the blush then). */
  faceBlocked: boolean;
  /** The character page turned 能脸红 off. */
  off: boolean;
  /** The card's blush size (0 draws nothing). */
  size: number;
}

export class BlushSeen {
  private last: string | null = null;
  /** The category for a cue the first time it is seen; null for no cue, or one already told. */
  observe(cueId: string | null | undefined, facts: BlushSeenFacts): BlushStageState | null {
    if (!cueId) return null;
    if (cueId === this.last) return null;
    this.last = cueId;
    if (facts.off) return 'off';
    if (facts.size === 0) return 'size-zero';
    if (facts.faceBlocked) return 'face-busy';
    return facts.path === 'none' ? 'no-cheek' : 'shown';
  }
}
