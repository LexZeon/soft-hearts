/**
 * May she be touched now (a pat, a pinch, a snack, a click on her)? I-174 item 7 (docs/claude/2026-11-21-i174-parity-fixes.md): the rule was
 * written twice, in the companion window's wiring (src/wiring/mood-wiring.ts) and on the full-screen page (src/unbound/her/out-page.ts), and
 * still agreed; one rule now, each surface naming what it has:
 *  - a model is there, the surface is on screen (the window shown; full-screen: her presence at least half faded in), the page not hidden;
 *  - nothing of the surface owns the pointer: the window's camera edit, an input method composing, the window's own interaction block;
 *    full-screen: a peek forcing click-through.
 */
export interface TouchableState {
  model: boolean;
  shown: boolean;
  hidden: boolean;
  /** Something of this surface owns the pointer now. */
  blocked: boolean;
}

export function touchable(state: TouchableState): boolean {
  return state.model && state.shown && !state.hidden && !state.blocked;
}

/** The companion window's names for it (the mood companion's canInteract). */
export function windowTouchable(s: { model: boolean; hostVisible: boolean; hidden: boolean; cameraEditing: boolean; interactionBlocked: boolean; composing: boolean }): boolean {
  return touchable({ model: s.model, shown: s.hostVisible, hidden: s.hidden, blocked: s.cameraEditing || s.interactionBlocked || s.composing });
}

/** Full-screen's names for it (her shown enough to see, a peek not forcing click-through; her model is checked by the page beside it). */
export function fullTouchable(s: { peekForcing: boolean; presence: number; hidden: boolean }): boolean {
  return touchable({ model: true, shown: s.presence >= 0.5, hidden: s.hidden, blocked: s.peekForcing });
}
