/**
 * I-135: comparing face embeddings and judging how clear a face is. Pure functions over numbers.
 */
import type { Landmarks5 } from './align';

export const EMBEDDING_SIZE = 128;

export function l2normalize(values: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i] * values[i];
  const norm = Math.sqrt(sum);
  const out = new Float32Array(values.length);
  if (!(norm > 1e-12)) return out;
  for (let i = 0; i < values.length; i++) out[i] = values[i] / norm;
  return out;
}

/** Cosine similarity (SFace's FR_COSINE); 0 for a zero vector or mismatched lengths. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denominator = Math.sqrt(na) * Math.sqrt(nb);
  return denominator > 1e-12 ? dot / denominator : 0;
}

/** Best similarity of one embedding against the enrolled set; null when nothing is enrolled. */
export function bestSimilarity(embedding: ArrayLike<number>, enrolled: readonly ArrayLike<number>[]): number | null {
  if (!enrolled.length) return null;
  let best = -1;
  for (const stored of enrolled) best = Math.max(best, cosine(embedding, stored));
  return best;
}

/**
 * Which enrolled set is the closest (1-based) and its similarity; null when nothing is enrolled. The best of the sets, not the average:
 * the sets are the user at different moments (light, angle), so a new frame needs to resemble one of them, not all.
 */
export function bestMatch(embedding: ArrayLike<number>, enrolled: readonly ArrayLike<number>[]): { similarity: number; which: number } | null {
  if (!enrolled.length) return null;
  let best = { similarity: -1, which: 1 };
  enrolled.forEach((stored, index) => { const similarity = cosine(embedding, stored); if (similarity > best.similarity) best = { similarity, which: index + 1 }; });
  return best;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * 0..1, 1 = looking straight at the camera. From the five landmarks in the eye-line frame (so head roll does not count):
 * yaw from how far the nose sits off the middle of the eyes, pitch from where the nose sits between eyes and mouth.
 */
export function frontalness(landmarks: Landmarks5): number {
  const [re, le, nose, rm, lm] = landmarks;
  const ex = le.x - re.x, ey = le.y - re.y;
  const eyeDistance = Math.hypot(ex, ey);
  if (!(eyeDistance > 1e-6)) return 0;
  const cos = ex / eyeDistance, sin = ey / eyeDistance;
  const local = (p: { x: number; y: number }) => ({ x: (p.x - re.x) * cos + (p.y - re.y) * sin, y: -(p.x - re.x) * sin + (p.y - re.y) * cos });
  const n = local(nose), r = local(rm), l = local(lm);
  const eyeMidX = eyeDistance / 2;
  const yaw = Math.abs(n.x - eyeMidX) / eyeDistance;
  const mouthY = (r.y + l.y) / 2;
  if (!(mouthY > 1e-6)) return 0; // mouth not below the eyes: not a face seen from the front
  const pitchRatio = n.y / mouthY; // about 0.5 from the front (SFace reference points: 0.49)
  const yawScore = clamp01(1 - yaw / 0.3);
  const pitchScore = clamp01(1 - Math.max(0, Math.abs(pitchRatio - 0.5) - 0.15) / 0.25);
  return yawScore * pitchScore;
}

/** Variance of the 4-neighbour Laplacian over the inner part of a square grey image (higher = sharper). */
export function sharpness(grey: Float32Array, size: number): number {
  let sum = 0, sumSq = 0, count = 0;
  const margin = Math.max(1, Math.round(size * 0.1));
  for (let y = margin; y < size - margin; y++) {
    for (let x = margin; x < size - margin; x++) {
      const at = y * size + x;
      const lap = grey[at - 1] + grey[at + 1] + grey[at - size] + grey[at + size] - 4 * grey[at];
      sum += lap; sumSq += lap * lap; count++;
    }
  }
  if (!count) return 0;
  const mean = sum / count;
  return Math.max(0, sumSq / count - mean * mean);
}

/** Mean grey level of the inner part of the crop (0..255). */
export function brightness(grey: Float32Array, size: number): number {
  let sum = 0, count = 0;
  const margin = Math.max(1, Math.round(size * 0.15));
  for (let y = margin; y < size - margin; y++) for (let x = margin; x < size - margin; x++) { sum += grey[y * size + x]; count++; }
  return count ? sum / count : 0;
}
