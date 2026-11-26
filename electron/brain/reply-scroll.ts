// The reply page keeps the newest sentence in view (record: docs/claude/2026-11-21-bubble-placement.md). The body is a fixed-height,
// overflow-hidden box that follows arriving text to its bottom. The old code did that only when the text changed; a placement that changed
// the width (the bubble narrower near a screen edge) made the text taller with the scroll position left behind, so the last sentences sat
// below the cut ("后面最后几句聊天泡不出来了"). A body that was at the bottom stays at the bottom.

/** The three numbers of a scrollable box the page reads (the real element, or a stand-in in tests). */
export interface ScrollBox { scrollTop: number; clientHeight: number; scrollHeight: number }

/** Within this many pixels of the end counts as at the end (rounding, a bubble's entry animation). */
export const BOTTOM_SLACK = 4;

export const atBottom = (box: ScrollBox): boolean => box.scrollTop + box.clientHeight >= box.scrollHeight - BOTTOM_SLACK;

/** Read before the text or the width changes: was the page showing its newest line? A page with nothing yet counts as at the end. */
export const wasFollowing = (box: ScrollBox, hadBody: boolean): boolean => !hadBody || atBottom(box);

/** After the new text and width are applied: arriving text scrolls to its end (to the top for the first text); a page that was following keeps following. */
export function settleScroll(box: ScrollBox, step: { hadBody: boolean; changedText: boolean; following: boolean }): void {
  if (step.changedText) box.scrollTop = step.hadBody ? box.scrollHeight : 0;
  else if (step.following && step.hadBody) box.scrollTop = box.scrollHeight;
}
