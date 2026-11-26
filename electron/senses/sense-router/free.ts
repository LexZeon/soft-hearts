/**
 * 2026-11-21 (docs/claude/2026-11-21-unbound-out-look-line.md): when her short line after a semantic look may be said, and where it goes.
 * Pure: the wiring (electron/wiring/initiative-look-wiring.ts, ports-wiring.ts) reads the facts and hands them over.
 *
 * "Free" means she can be seen and heard right now: on screen in her companion window OR out in full-screen Unbound with her bubble able to show
 * (one predicate, herOnScreen), and nothing else of hers going on. It used to ask for the companion window itself, so while she was out the line
 * was never said ("看到了，还没来得及说；她一直没空说").
 */
import type { SenseLineMessage } from '../../../shared/senses/sense-router';

export interface SenseFreeFacts {
  /** herOnScreen(): the companion window shown, or her Unbound bubble able to show. */
  herOnScreen: boolean;
  dragging: boolean;
  replySpeechBusy: boolean;
  ambientSpeaking: boolean;
  proactiveBusy: boolean;
  chatPending: boolean;
  gameActive: boolean;
  userInputUntil: number;
  now: number;
}

/** She may say the follow-up line now (the same list as before, with "shown" read as herOnScreen). */
export function senseLineFree(facts: SenseFreeFacts): boolean {
  return facts.herOnScreen && !facts.dragging && !facts.replySpeechBusy && !facts.ambientSpeaking
    && !facts.proactiveBusy && !facts.chatPending && !facts.gameActive && facts.now >= facts.userInputUntil;
}

export interface SenseLineRoute {
  /** The companion window is shown: the line goes there as always. */
  homeShown(): boolean;
  /** Out in Unbound: the line into her full-screen bubble (read aloud there); false: the bubble could not take it. */
  hold(id: string, text: string): boolean;
  /** To the companion window: `held` true means only for her history and her voice, never shown there. */
  sendCompanion(message: SenseLineMessage, held: boolean): boolean;
  /** The line is in her bubble: the router's wait for the companion's report ends (once). */
  shownOut(id: string): void;
}

/**
 * Where her line goes: at home, the companion window (as before); out, her Unbound bubble once, with the companion window told only to
 * remember it and read it aloud (it never shows it, so no duplicate). False: it could not be delivered anywhere; 'out': it went to the bubble
 * (the journal says "delivered out").
 */
export function deliverSenseLine(route: SenseLineRoute, message: SenseLineMessage): boolean | 'out' {
  if (route.homeShown()) return route.sendCompanion(message, false);
  if (!route.hold(message.id, message.text)) return false;
  try { route.sendCompanion(message, true); } catch { /* the bubble is up; only her history and voice miss it */ }
  route.shownOut(message.id);
  return 'out';
}
