/**
 * I-154 follow-up, batch B (docs/claude/2026-11-21-unbound-full-BG.md): 猜拳, 递东西 and 牵手、拉钩、击掌 out in full-screen Unbound. The
 * companion window's own games (the host's G1 match, I-086 offer, I-087 reach), only routed: while she is out, the host sends their views to
 * the Unbound window instead of the hidden companion window, and takes the page's answers on these fixed channels. Nothing new is decided
 * here or on the page: the host's game, offer and reach hosts parse every value as they do for the companion window.
 */

/** The Unbound page's requests for the games (electron/unbound/games-bridge.ts checks the window, the host parses the value). */
export const UNBOUND_GAME_REQUESTS = Object.freeze({
  /** The match's current view (after the page loads mid-game). */
  rpsGet: 'unbound:rps-get',
  /** One throw (shared/initiative/rps.ts RpsThrowRequest). */
  rpsThrow: 'unbound:rps-throw',
  /** accept / decline / quit, or her line was shown (said) or not (skipped) (RpsResponseRequest). */
  rpsRespond: 'unbound:rps-respond',
  /** How her offer ended (shared/behaviors/give/interface.ts GiveAnswer). */
  giveAnswer: 'unbound:give-answer',
  /** How her reach ended (shared/behaviors/hands/interface.ts HandsAnswer). */
  handsAnswer: 'unbound:hands-answer',
  /** Your mouse rests within her reach: may she reach (HandsRequest; the host decides by her mood). */
  handsRequest: 'unbound:hands-request',
} as const);

/** The host's game events, relayed to the Unbound window while she is out (the companion window's desk:rps / desk:give / desk:hands). */
export const UNBOUND_GAME_EVENTS = Object.freeze({ rps: 'unbound:rps', give: 'unbound:give', hands: 'unbound:hands' } as const);
export type UnboundGameKind = keyof typeof UNBOUND_GAME_EVENTS;

type GameRequest = (typeof UNBOUND_GAME_REQUESTS)[keyof typeof UNBOUND_GAME_REQUESTS];

/**
 * An answer that only stops or reports (never a start, never a reward): her line was or was not shown, you declined or quit, an offer or a
 * reach ended untaken, interrupted or let go. Those are taken from the window she is shown in even when she cannot be touched right now
 * (a full-screen program stepped her back, a peek forces click-through), so a game she can no longer play still closes ("禁止只是不开始
 * 新的动作"). Everything else (a throw, accepting, taking what she holds out, touching her hand, asking for her hand) is your own act on
 * her and needs her touchable. Anything this does not recognise is not an ending.
 */
export function isPlayEnding(request: string, value: unknown): boolean {
  const field = (key: string) => value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
  switch (request as GameRequest) {
    case UNBOUND_GAME_REQUESTS.rpsRespond: return ['said', 'skipped', 'decline', 'quit'].includes(field('action') as string);
    case UNBOUND_GAME_REQUESTS.giveAnswer: return ['not-taken', 'interrupted'].includes(field('outcome') as string);
    case UNBOUND_GAME_REQUESTS.handsAnswer: return ['not-taken', 'interrupted', 'let-go'].includes(field('outcome') as string);
    default: return false;
  }
}

/**
 * Where her games are shown now. She is out (the companion window is held hidden): the Unbound window, and only while she is shown there
 * (a full-screen program never hides her, I-199). At home: the companion window, while it is visible. Pure; the wiring reads its inputs.
 */
export function playSurface(state: { held: boolean; outShown: boolean; companionShown: boolean }): { surface: 'unbound' | 'companion'; shown: boolean } {
  if (state.held) return { surface: 'unbound', shown: state.outShown === true };
  return { surface: 'companion', shown: state.companionShown === true };
}
