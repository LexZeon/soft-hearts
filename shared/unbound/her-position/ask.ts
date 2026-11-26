/**
 * I-193: her "go where" words (the speak-along markers go-left, go-right, go-middle, come-near, go-far, go-corner, go-cursor) and the page's question to
 * the host when she reaches one. The list here and SPEECH_BEAT_GO_WORDS (shared/behaviors/speech-beats/interface.ts) are one decision; a test holds
 * them equal (the two parts do not import each other).
 *
 * "到你正在用的窗口旁边" is NOT a word: the app has no reading of the window you are using (no real window source exists; adding one is a new sense that
 * needs your say-so, shared/unbound/surfaces/windows.ts). The cursor is different: the full-screen page already sees it move (hover and hair), so
 * "到你鼠标旁边" keeps working from what the page knows, and only its horizontal place leaves the page, for this one decision.
 */
export const GO_WORDS = ['go-left', 'go-right', 'go-middle', 'come-near', 'go-far', 'go-corner', 'go-cursor', 'go'] as const;
export type GoWord = typeof GO_WORDS[number];
export const isGoWord = (value: unknown): value is GoWord => (GO_WORDS as readonly unknown[]).includes(value);

/**
 * I-193 numbers (plan decision 2 "米加横向百分比"): ⟦go 30% 1.2m⟧ carries where across the
 * screen (0–100%, her centre) and how far from the user in told metres (the same ruler as her turn's distance), either one or both. Raw as she wrote
 * them; the host clamps them to where she can stand (an out-of-range number walks to the edge).
 */
export interface GoTarget { percent?: number; metres?: number }
/** The largest numbers a go marker's target may carry (the filter's digits already bound them; the host clamps further). */
export const GO_TARGET_MAX = Object.freeze({ percent: 999, metres: 999.9 });
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** A target as kept: a whole percent 0..999 and metres 0..999.9 with one decimal; null when neither part is usable. */
export function goTargetOf(value: unknown): GoTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const percent = finite(v.percent) && Number.isInteger(v.percent) && v.percent >= 0 && v.percent <= GO_TARGET_MAX.percent ? v.percent : undefined;
  const metres = finite(v.metres) && v.metres >= 0 && v.metres <= GO_TARGET_MAX.metres ? Math.round(v.metres * 10) / 10 : undefined;
  if (percent === undefined && metres === undefined) return null;
  return { ...(percent !== undefined ? { percent } : {}), ...(metres !== undefined ? { metres } : {}) };
}

/** The page's question (only these keys): the word, for go-cursor where the pointer is across the screen (0..1), for go its target's numbers. */
export interface GoBeatAsk extends GoTarget { goBeat: GoWord; cursorAcross?: number }
/** 'go': she walks (the host started it or queued it behind a small move); 'stay': not now (a gate, already there, nowhere to go). */
export type GoBeatAnswer = 'go' | 'stay';
export const isGoBeatAnswer = (value: unknown): value is GoBeatAnswer => value === 'go' || value === 'stay';

const ASK_KEYS: ReadonlySet<string> = new Set(['goBeat', 'cursorAcross', 'percent', 'metres']);
export function parseGoBeatAsk(value: unknown): GoBeatAsk | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !ASK_KEYS.has(key)) || !isGoWord(v.goBeat)) return null;
  // Numbers ride only on `go`, and `go` needs at least one usable number.
  const numbers = v.percent !== undefined || v.metres !== undefined;
  if (v.goBeat === 'go') {
    const target = goTargetOf(v);
    if (!target || v.cursorAcross !== undefined || (v.percent !== undefined && target.percent === undefined) || (v.metres !== undefined && target.metres === undefined)) return null;
    return { goBeat: 'go', ...target };
  }
  if (numbers) return null;
  if (v.cursorAcross === undefined) return { goBeat: v.goBeat };
  if (typeof v.cursorAcross !== 'number' || !Number.isFinite(v.cursorAcross) || v.cursorAcross < 0 || v.cursorAcross > 1) return null;
  return { goBeat: v.goBeat, cursorAcross: v.cursorAcross };
}
