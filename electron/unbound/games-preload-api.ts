/**
 * Batch B (docs/claude/2026-11-21-unbound-full-BG.md): the Unbound window's part of window.unbound for her games out here (G1 猜拳, I-086
 * 递东西, I-087 牵手). Exactly what the companion window's overlays use (src/initiative/RpsOverlay.ts, GiveOverlay.ts, HandsOverlay.ts), on
 * fixed `unbound:` channels, plain values in and out; the host checks the window and parses each value (electron/unbound/games-bridge.ts).
 * No picture of her goes out from here (送你一张图 is the companion window's), and nothing else.
 */
import { UNBOUND_GAME_EVENTS, UNBOUND_GAME_REQUESTS } from '../../shared/unbound/games';
import type { GiveAnswer, GiveEvent, HandsAnswer, HandsEvent, HandsRequest, RpsResponseRequest, RpsThrowRequest, RpsView } from '../../shared/initiative';

export interface UnboundGamesApi {
  /** 猜拳: the match's view now (null: none), each new one, a throw, an answer (accept / decline / quit, her line said or skipped). */
  rpsGet(): Promise<RpsView | null>;
  rpsEvents(callback: (view: RpsView | null) => void): () => void;
  rpsThrow(input: RpsThrowRequest): Promise<string>;
  rpsRespond(input: RpsResponseRequest): Promise<boolean>;
  /** 递东西: her offer (and its cancel), how it ended. */
  onGive(callback: (event: GiveEvent) => void): () => void;
  giveAnswer(answer: GiveAnswer): Promise<boolean>;
  /** 牵手、拉钩、击掌: her reach (and its cancel), how it ended, your mouse resting within her reach. */
  onHands(callback: (event: HandsEvent) => void): () => void;
  handsAnswer(answer: HandsAnswer): Promise<boolean>;
  handsRequest(request: HandsRequest): Promise<boolean>;
}
export const UNBOUND_GAMES_API_KEYS = Object.freeze(['rpsGet', 'rpsEvents', 'rpsThrow', 'rpsRespond', 'onGive', 'giveAnswer', 'onHands', 'handsAnswer', 'handsRequest'] as const);

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;
type Subscribe = <T>(channel: string, callback: (value: T) => void) => () => void;
const oneObject = (name: string, value: unknown) => !value || typeof value !== 'object' || Array.isArray(value) ? Promise.reject(new TypeError(`${name} takes one object`)) : null;

export function createUnboundGamesApi(invoke: Invoke, subscribe: Subscribe): UnboundGamesApi {
  const R = UNBOUND_GAME_REQUESTS, E = UNBOUND_GAME_EVENTS;
  return {
    rpsGet: () => invoke(R.rpsGet) as Promise<RpsView | null>,
    rpsEvents: callback => subscribe(E.rps, callback),
    rpsThrow: input => (oneObject('rpsThrow', input) ?? invoke(R.rpsThrow, input)) as Promise<string>,
    rpsRespond: input => (oneObject('rpsRespond', input) ?? invoke(R.rpsRespond, input)) as Promise<boolean>,
    onGive: callback => subscribe(E.give, callback),
    giveAnswer: answer => (oneObject('giveAnswer', answer) ?? invoke(R.giveAnswer, answer)) as Promise<boolean>,
    onHands: callback => subscribe(E.hands, callback),
    handsAnswer: answer => (oneObject('handsAnswer', answer) ?? invoke(R.handsAnswer, answer)) as Promise<boolean>,
    handsRequest: request => (oneObject('handsRequest', request) ?? invoke(R.handsRequest, request)) as Promise<boolean>,
  };
}
