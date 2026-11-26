/**
 * I-154 follow-up, batch B (docs/claude/2026-11-21-unbound-full-BG.md): her games out in full-screen Unbound, exactly the companion window's.
 * The host's G1 match, I-086 offer and I-087 reach stay where they are (electron/initiative/); while she is out the wiring sends their views
 * here instead of to the hidden companion window (shared/unbound/games.ts playSurface), and this takes the Unbound page's answers.
 *
 * The rules (the host's `handle` has already checked the request came from the current Unbound window's own top frame):
 *  - only the window she is shown in may answer, and only while she is out;
 *  - your own acts (a throw, accepting, taking what she holds out, touching her hand, asking for her hand) only while that window is visible
 *    and she can be touched there (not forced click-through by a peek; a full-screen program never hides her, I-199), as for a touch;
 *  - an ending (her line shown or skipped, declined, quit, untaken, interrupted, let go) needs only the window she is shown in, so a game she
 *    can no longer play still closes (shared/unbound/games.ts isPlayEnding);
 *  - the value goes to the same host method the companion window's request goes to, which parses it as it does for that window;
 *  - without the ports (tests, an older wiring) every request is refused, and nothing is sent.
 */
import { UNBOUND_GAME_EVENTS, UNBOUND_GAME_REQUESTS, isPlayEnding, type UnboundGameKind } from '../../shared/unbound/games';

/** The game hosts' own methods (electron/initiative/rps, give, hands): the companion window's requests call the same ones. */
export interface UnboundGamesPorts {
  rps?: { view(): unknown; throwHand(value: unknown): unknown; respond(value: unknown): unknown };
  give?: { answer(value: unknown): unknown };
  hands?: { answer(value: unknown): unknown; request(value: unknown): unknown };
}
export interface GamesBridgeWindow { isVisible(): boolean; isDestroyed?(): boolean }
export interface GamesBridgeHost<W extends GamesBridgeWindow> {
  /** The window she is shown in now (null while entering, leaving or at home). */
  shown(): W | null;
  /** She is out (the companion window is held hidden). */
  out(): boolean;
  /** She may be touched there now: not forced click-through by a peek (a full-screen program never hides her, I-199). */
  touchable(): boolean;
  send(win: W, channel: string, value: unknown): void;
}
type Handle<W> = (channel: string, operation: (win: W, ...args: unknown[]) => unknown) => void;

export class UnboundGamesBridge<W extends GamesBridgeWindow> {
  /** The requests `register` handles (the host removes them when it quits). */
  readonly channels: readonly string[] = Object.values(UNBOUND_GAME_REQUESTS);
  /** `ports` is read when a request comes (the initiative wiring connects it after the host was made). */
  constructor(private readonly ports: () => UnboundGamesPorts | undefined, private readonly host: GamesBridgeHost<W>) {}

  /** She is out and shown: her games can be played here now (the wiring's "visible" while she is out). */
  canPlay(): boolean {
    const win = this.host.shown();
    return this.host.out() && !!win && win.isDestroyed?.() !== true && win.isVisible() && this.host.touchable();
  }

  /** One game event to the window she is shown in (false when there is none: the host treats it as not delivered). */
  send(kind: UnboundGameKind, value: unknown): boolean {
    const win = this.host.out() ? this.host.shown() : null;
    if (!win || win.isDestroyed?.() === true) return false;
    this.host.send(win, UNBOUND_GAME_EVENTS[kind], value);
    return true;
  }

  /** Whether `request` with `value` from `win` is taken now (exported for the test of each rule). */
  accepts(win: W, request: string, value: unknown): boolean {
    if (!this.host.out() || this.host.shown() !== win) return false;
    if (isPlayEnding(request, value)) return true;
    return win.isVisible() && this.host.touchable();
  }

  register(handle: Handle<W>): void {
    const R = UNBOUND_GAME_REQUESTS;
    const port = <K extends keyof UnboundGamesPorts>(key: K): NonNullable<UnboundGamesPorts[K]> => {
      const value = this.ports()?.[key];
      if (!value) throw new Error('游戏尚未接入。');
      return value as NonNullable<UnboundGamesPorts[K]>;
    };
    const answer = (request: string, run: (value: unknown) => unknown) => handle(request, (win, value) => {
      if (!this.accepts(win, request, value)) return false;
      return run(value);
    });
    handle(R.rpsGet, win => { const rps = port('rps'); return this.host.out() && this.host.shown() === win ? rps.view() : null; });
    answer(R.rpsThrow, value => port('rps').throwHand(value));
    answer(R.rpsRespond, value => port('rps').respond(value));
    answer(R.giveAnswer, value => port('give').answer(value));
    answer(R.handsAnswer, value => port('hands').answer(value));
    answer(R.handsRequest, value => port('hands').request(value));
  }
}
