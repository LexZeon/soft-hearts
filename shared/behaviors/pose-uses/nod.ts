// I-189 #3: a nod or a head shake from the 17 body points, and whether her last line asked a yes/no
// question. Pure, no clock of its own. The answer itself (sent as the user's turn) is the host's (electron/senses/pose-uses/host.ts).
//
// Recognition: the nose relative to the middle of the shoulders, in shoulder widths (so leaning or the body swaying does not count),
// over the last `spanMs`. Each axis is read as a zigzag: a leg is a move of at least `step` against the last turning point.
//  - nod:   at least `nodSwings` vertical legs, vertical range >= nodRange, sideways range <= crossRatio x vertical range;
//  - shake: at least `shakeSwings` sideways legs, sideways range >= shakeRange, vertical range <= crossRatio x sideways range.
// A frame without the nose or a shoulder, a gap of more than half a second, or a person too small in the frame clears what was seen.
import type { PosePoint } from '../../senses/pose-signals';
import { POSE_USES_KNOBS, type PoseUsesKnobs } from './knobs';

export type HeadGesture = 'nod' | 'shake';

interface Sample { t: number; x: number; y: number; mx: number; my: number }

/** Legs of a zigzag with threshold `step`, and the range covered. */
export function zigzag(values: readonly number[], step: number): { legs: number; range: number } {
  if (!values.length) return { legs: 0, range: 0 };
  let pivot = values[0], ext = values[0], dir = 0, legs = 0, low = values[0], high = values[0];
  for (const v of values) {
    low = Math.min(low, v); high = Math.max(high, v);
    if (dir === 0) {
      if (v - pivot >= step) { dir = 1; ext = v; legs = 1; } else if (pivot - v >= step) { dir = -1; ext = v; legs = 1; }
    } else if (dir === 1) {
      if (v > ext) ext = v; else if (ext - v >= step) { dir = -1; ext = v; legs++; }
    } else if (v < ext) ext = v; else if (v - ext >= step) { dir = 1; ext = v; legs++; }
  }
  return { legs, range: high - low };
}

export class HeadGestureDetector {
  private samples: Sample[] = [];
  private quietUntil = -Infinity;

  constructor(private readonly knobs: PoseUsesKnobs['nod'] = POSE_USES_KNOBS.nod) {}

  /** One frame's body points (COCO order, 0..1 of the frame) at `at` ms. Returns a gesture the moment one completes. */
  push(points: readonly (PosePoint | null)[] | null | undefined, at: number): HeadGesture | null {
    const k = this.knobs, nose = points?.[0], left = points?.[5], right = points?.[6];
    if (!Number.isFinite(at) || !nose || !left || !right) { this.samples = []; return null; }
    const sw = Math.hypot(left.x - right.x, left.y - right.y);
    if (!(sw >= k.minShoulder)) { this.samples = []; return null; }
    const last = this.samples.at(-1);
    if (last && (at <= last.t || at - last.t > 500)) this.samples = [];
    const mx = (left.x + right.x) / 2, my = (left.y + right.y) / 2;
    this.samples.push({ t: at, x: (nose.x - mx) / sw, y: (nose.y - my) / sw, mx: mx / sw, my: my / sw });
    while (this.samples.length > 1 && at - this.samples[0].t > k.spanMs) this.samples.shift();
    if (this.samples.length > 64) this.samples.splice(0, this.samples.length - 64);
    if (at < this.quietUntil) return null;
    // The whole body moving (shifting in the chair, leaning in, turning) is not a nod, whatever the nose does against the shoulders.
    if (bodyMove(this.samples) > k.maxBodyMove) return null;
    const gesture = headGestureOf(this.samples, k);
    if (gesture) { this.samples = []; this.quietUntil = at + 1_500; }
    return gesture;
  }

  reset(): void { this.samples = []; this.quietUntil = -Infinity; }
}

/** How far the middle of the shoulders wandered over these samples, in shoulder widths (the larger of the two axes). */
export function bodyMove(samples: readonly { mx: number; my: number }[]): number {
  let lx = Infinity, hx = -Infinity, ly = Infinity, hy = -Infinity;
  for (const s of samples) { lx = Math.min(lx, s.mx); hx = Math.max(hx, s.mx); ly = Math.min(ly, s.my); hy = Math.max(hy, s.my); }
  return Math.max(hx - lx, hy - ly);
}

/** The gesture these samples (already in shoulder widths, relative to the shoulders) show, or null. */
export function headGestureOf(samples: readonly { x: number; y: number }[], knobs: PoseUsesKnobs['nod'] = POSE_USES_KNOBS.nod): HeadGesture | null {
  if (samples.length < 3) return null;
  const v = zigzag(samples.map(s => s.y), knobs.step), h = zigzag(samples.map(s => s.x), knobs.step);
  const nod = v.legs >= knobs.nodSwings && v.range >= knobs.nodRange && h.range <= knobs.crossRatio * v.range;
  const shake = h.legs >= knobs.shakeSwings && h.range >= knobs.shakeRange && v.range <= knobs.crossRatio * h.range;
  return nod === shake ? null : nod ? 'nod' : 'shake';
}

// ---------------------------------------------------------------- her yes/no question (closed rules on her own text)

const ZH_A_NOT_A = /(要不要|好不好|行不行|可不可以|能不能|会不会|是不是|对不对|有没有|想不想|愿不愿意|喜不喜欢|需不需要|用不用|在不在|累不累|饿不饿|困不困|冷不冷|热不热|去不去|来不来|吃不吃|听不听|看不看|玩不玩)/u;
const ZH_ENDING = /(吗|么|吧|嘛|对吧|好吧|是吧|行吧|可以吗)[~～呀呢啦哦噢嘛]*$/u;
const ZH_WH = /(什么|怎么|为什么|为啥|哪|谁|几|多少|多久|啥|如何|咋)/u;
const ZH_CHOICE = /还是/u;
const EN_AUX = /^(?:(?:so|hey|um|uh|well|oh|and|but|okay|ok)[,\s]+)*(do|does|did|are|is|was|were|am|can|could|would|will|shall|should|have|has|had|may|might|want|wanna|need|don't|doesn't|didn't|aren't|isn't|won't|wouldn't|can't|couldn't|shouldn't|haven't)\b/iu;
const EN_TAG = /,\s*(right|okay|ok|yeah|yes|no|huh)\s*$|\bor not\s*$/iu;
const EN_WH = /^(?:(?:so|hey|um|uh|well|oh|and|but|okay|ok)[,\s]+)*(what|why|how|where|who|whom|whose|when|which)\b/iu;

/** The last question sentence of her line (up to its question mark), or '' when the line does not end on a question. */
export function lastQuestion(text: unknown): string {
  const line = String(text ?? '').slice(-600).replace(/[\u0000-\u001f\u007f]/gu, ' ');
  const at = Math.max(line.lastIndexOf('？'), line.lastIndexOf('?'));
  if (at < 0) return '';
  // After the question mark only a little may follow: closing marks, a tilde, an emoji, a short bracketed action.
  const tail = line.slice(at + 1).replace(/[（(][^（()）]{0,12}[)）]/gu, '').replace(/[\s"'”’」』)）~～!！.。…\p{Extended_Pictographic}️]/gu, '');
  if (tail.length > 0) return '';
  const head = line.slice(0, at);
  const start = Math.max(...['。', '！', '!', '？', '?', '\n', '…', '；', ';', '. '].map(mark => { const i = head.lastIndexOf(mark); return i < 0 ? -1 : i + mark.length; }));
  return head.slice(Math.max(0, start)).trim();
}

/** Her line ends on a question that a yes or a no answers ("要不要……？", "……好吗？", "Do you …?", "…, right?"). */
export function asksYesNo(text: unknown): boolean {
  const q = lastQuestion(text).replace(/[（(][^（()）]{0,12}[)）]/gu, '').replace(/[\s"'“”‘’「」『』]+/gu, ' ').trim();
  if (!q || q.length > 120) return false;
  if (/[㐀-鿿]/u.test(q)) {
    if (ZH_CHOICE.test(q)) return false;
    if (ZH_A_NOT_A.test(q)) return true;
    return ZH_ENDING.test(q.replace(/\s+/gu, '')) && !ZH_WH.test(q);
  }
  if (/\bor\b/iu.test(q) && !/\bor not\s*$/iu.test(q)) return false;
  if (EN_WH.test(q) && !EN_TAG.test(q)) return false;
  return EN_AUX.test(q) || EN_TAG.test(q);
}
