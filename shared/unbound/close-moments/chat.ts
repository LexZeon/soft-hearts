/**
 * I-185 (2026-11-22, about the close moments): she wrote ⟦kiss⟧ or ⟦hug⟧ in a reply. In full-screen
 * Unbound the page asks the host when the word is reached; the host answers 'play' (the family's own performance: she walks up to the lens,
 * the same plan and curves as I-184) or 'lighter' (the page plays the lighter word in place: CLOSE_BEAT_LIGHTER). No chooser: she chose it
 * by writing it. The family's gates still hold, except "she is speaking" (she is, by definition; the pucker itself waits for a pause on the
 * page, PuckerGate): not shown, asleep, a call (only for the words in CHAT_CLOSE_CALL_BLOCKS: none now), you typing now (recent keystrokes in her
 * box, not the box being open), a pull now, another moment already on; a hug never while a game, an offer or her reach holds her arms.
 * NO cooldown of any kind: what she
 * writes in her reply is blocked only by what cannot happen now. Her own unprompted ones (chooser.ts) keep their cooldowns. Pure.
 */
import type { CloseGates } from './chooser';

export type ChatCloseKind = 'kiss' | 'hug';
/**
 * Why a kiss or a hug she wrote did not walk up (the journal's closed words). 'cooldown' is kept only so older rows still read: nothing returns it
 * since 2026-11-23. 'unready': the host could not plan it (her mood not read yet). 'unreached' (T-264): it walked up but her face never got into the window.
 */
export const CHAT_CLOSE_BLOCKS = ['not-shown', 'asleep', 'call', 'typing', 'pulled', 'busy', 'arms', 'cooldown', 'unready', 'unreached', 'waited'] as const;
export type ChatCloseBlock = (typeof CHAT_CLOSE_BLOCKS)[number];
export type ChatCloseAnswer = 'play' | 'lighter';

/**
 * The chat words a call turns away (the 'call' block). Empty since 2026-11-22: she walks over in a call too. To undo:
 * ['kiss', 'hug'] here and in SPEECH_BEAT_CALL_WORDS (shared/behaviors/speech-beats/availability.ts: the per-turn line). Her own chosen
 * moments (chooser.ts closeBlock) keep their call gate.
 */
export const CHAT_CLOSE_CALL_BLOCKS: readonly ChatCloseKind[] = Object.freeze([]);

/**
 * 2026-11-25 (her reply asked for a hug while her own hand was out toward the user's mouse): what holds her arms
 * when a kiss or a hug of her reply comes. 'game': a game or something she holds out (a hug cannot, as before); 'hand': only her own reach for
 * your hand (offered or held): what she wrote wins: the hand lets go first (smoothly, back through its own reach) and she walks over.
 */
export type CloseArms = 'free' | 'hand' | 'game';
/** Who holds her arms now, from the three things that can (a game, an offer of hers, her reach for your hand). */
export function closeArmsOf(on: { game: boolean; give: boolean; hand: boolean }): CloseArms {
  if (on.game || on.give) return 'game';
  return on.hand ? 'hand' : 'free';
}
/** Her written kiss / hug walks up over her hand reach: the hand lets go (true) — never over a game or what she holds out. */
export const handYieldsTo = (kind: ChatCloseKind | string, arms: CloseArms | null | undefined): boolean => (kind === 'kiss' || kind === 'hug') && arms === 'hand';

/**
 * Why a kiss or a hug from her reply cannot walk up now (the first reason), or null: it may. `busy`: a peek or a moment is on. `arms`
 * (2026-11-25): who holds her arms; only her own hand reach ('hand') never blocks a hug she wrote (it lets go instead: handYieldsTo).
 */
export function chatCloseBlock(input: { kind: ChatCloseKind; gates: Omit<CloseGates, 'speaking'> & { speaking?: boolean }; busy: boolean; arms?: CloseArms | null }): ChatCloseBlock | null {
  const g = input.gates;
  if (!g.shown) return 'not-shown';
  if (g.asleep) return 'asleep';
  if (g.inCall && CHAT_CLOSE_CALL_BLOCKS.includes(input.kind)) return 'call';
  if (g.typing) return 'typing';
  if (g.pulled) return 'pulled';
  if (input.busy) return 'busy';
  if (input.kind === 'hug' && g.armsHeld && !handYieldsTo(input.kind, input.arms)) return 'arms';
  return null;
}

// ---- 2026-11-25: one journal row per kiss / hug she wrote (in full-screen), once its fate is known ---------------------------------------------

/** How a kiss / hug she wrote ended: it landed (her lips on, her arms round: the hold was reached) or it did not. */
export const CLOSE_BEAT_OUTCOMES = ['played', 'not-played'] as const;
export type CloseBeatOutcome = (typeof CLOSE_BEAT_OUTCOMES)[number];
/**
 * Why it did not: a block word (it never walked up: CHAT_CLOSE_BLOCKS) or how the walk-up ended without the hold: pulled away, her face could not
 * reach ('unreached'), a game started ('game'), the peek's own timeout, a full-screen program, or it ended with no reason given ('left': she left
 * full-screen, a newer one replaced it).
 */
export const CLOSE_BEAT_ENDS = ['pulled-away', 'game', 'timeout', 'input', 'reply', 'fullscreen', 'left'] as const;
export type CloseBeatEnd = (typeof CLOSE_BEAT_ENDS)[number];
export type CloseBeatWhy = ChatCloseBlock | CloseBeatEnd;
/** One row: which, how it ended, why not (null when it played); `arms: 'still'` a hug whose arms could not move on this model (her face came). */
export interface CloseBeatFate { kind: ChatCloseKind; outcome: CloseBeatOutcome; why: CloseBeatWhy | null; arms?: 'still' }
/** The peek's cancel reason of a walk-up that never reached its hold, as the row's word. */
export function closeEndWhy(reason: string | null | undefined): CloseBeatWhy {
  switch (reason) {
    case 'pull': return 'pulled-away';
    case 'play': return 'game';
    case 'unreached': return 'unreached';
    case 'timeout': case 'input': case 'reply': case 'fullscreen': return reason;
    default: return 'left';
  }
}

/** The page's question (only these keys, only these words). */
export interface CloseBeatAsk { closeBeat: ChatCloseKind }
export function parseCloseBeatAsk(value: unknown): CloseBeatAsk | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 1 || (v.closeBeat !== 'kiss' && v.closeBeat !== 'hug')) return null;
  return { closeBeat: v.closeBeat };
}
export const isChatCloseAnswer = (value: unknown): value is ChatCloseAnswer => value === 'play' || value === 'lighter';
