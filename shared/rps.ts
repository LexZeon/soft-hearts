/**
 * G1 和她玩猜拳 (handbook/ideas.md I-004; plan docs/claude/2026-11-03-rps-plan.md, record docs/claude/2026-11-03-rps.md).
 * The primitives every side shares: the three hands, who wins, her sealed choice (a commitment the window can check
 * after the reveal), the "what I threw" input port (clicks today, camera gestures later), the window's view and the
 * timing of one round. Pure: no timer, no I/O, no clock.
 */
import { sha256Hex } from './sha256-sync';

export const RPS_HANDS = ['rock', 'scissors', 'paper'] as const;
export type RpsHand = typeof RPS_HANDS[number];
export const isRpsHand = (value: unknown): value is RpsHand => typeof value === 'string' && (RPS_HANDS as readonly string[]).includes(value);
/** Chinese names used in her lines ({手}) and the diary material. */
export const RPS_HAND_WORDS: Readonly<Record<RpsHand, string>> = Object.freeze({ rock: '石头', scissors: '剪刀', paper: '布' });

/** `a` beats `b`. */
export function rpsBeats(a: RpsHand, b: RpsHand): boolean {
  return (a === 'rock' && b === 'scissors') || (a === 'scissors' && b === 'paper') || (a === 'paper' && b === 'rock');
}
export type RpsOutcome = 'her' | 'user' | 'draw';
export function rpsJudge(her: RpsHand, user: RpsHand): RpsOutcome {
  return her === user ? 'draw' : rpsBeats(her, user) ? 'her' : 'user';
}
/** The hand that beats `hand`, and the one that loses to it. */
export const rpsWinnerAgainst = (hand: RpsHand): RpsHand => RPS_HANDS.find(h => rpsBeats(h, hand))!;
export const rpsLoserAgainst = (hand: RpsHand): RpsHand => RPS_HANDS.find(h => rpsBeats(hand, h))!;

// ---------------------------------------------------------------- her sealed choice

/** fair: a uniform pick. soft: she lets the user win (loses to the hand she expects). read: she plays against the user's known habit. */
export type RpsIntent = 'fair' | 'soft' | 'read';
export const isRpsIntent = (value: unknown): value is RpsIntent => value === 'fair' || value === 'soft' || value === 'read';
/** What she decided, kept by the host until the reveal. */
export interface RpsSecret { hand: RpsHand; intent: RpsIntent; nonce: string }
/** What the window sees before the reveal: only a digest of the secret. */
export interface RpsCommitment { gameId: string; round: number; committedAt: number; digest: string }

export function rpsDigest(gameId: string, round: number, committedAt: number, secret: RpsSecret): string {
  return sha256Hex(`soft-hearts-rps/v1|${gameId}|${round}|${committedAt}|${secret.hand}|${secret.intent}|${secret.nonce}`);
}
export function rpsCommit(gameId: string, round: number, committedAt: number, secret: RpsSecret): RpsCommitment {
  return { gameId, round, committedAt, digest: rpsDigest(gameId, round, committedAt, secret) };
}
/** The window (or a test) checks that the revealed hand is the one sealed before any input was accepted. */
export function rpsVerify(commitment: RpsCommitment, secret: RpsSecret): boolean {
  return isRpsHand(secret.hand) && isRpsIntent(secret.intent) && typeof secret.nonce === 'string'
    && rpsDigest(commitment.gameId, commitment.round, commitment.committedAt, secret) === commitment.digest;
}

// ---------------------------------------------------------------- "what I threw": the input port

/** Today the three buttons; later the camera's hand-gesture reader (MediaPipe, ideas I-004 point 7). */
export type RpsInputSource = 'click' | 'camera';
export const RPS_INPUT_SOURCES: readonly RpsInputSource[] = ['click', 'camera'];
/**
 * One source of the user's hand. `start` begins listening for this round and returns how to stop. The source only
 * reports a hand; it never sees her choice (the host keeps it sealed until both hands are in).
 */
export interface RpsHandInput {
  readonly source: RpsInputSource;
  start(onHand: (hand: RpsHand) => void): () => void;
}
/** The renderer → host message for one throw. */
export interface RpsThrowRequest { gameId: string; round: number; hand: RpsHand; source: RpsInputSource }
export function readRpsThrow(value: unknown): RpsThrowRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !['gameId', 'round', 'hand', 'source'].includes(key))) return null;
  if (typeof v.gameId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(v.gameId) || !Number.isSafeInteger(v.round) || (v.round as number) < 1
    || !isRpsHand(v.hand) || !(RPS_INPUT_SOURCES as readonly unknown[]).includes(v.source)) return null;
  return { gameId: v.gameId, round: v.round as number, hand: v.hand, source: v.source as RpsInputSource };
}
/**
 * accept / decline her invitation, quit the match; said: the pet window showed (and read) her line `id`; skipped: it
 * did not show it (a chat reply ran or the user was typing), so it does not count as said (Codex T-112 round 028).
 */
export type RpsResponseAction = 'accept' | 'decline' | 'quit' | 'said' | 'skipped';
export interface RpsResponseRequest { id: string; action: RpsResponseAction }
export function readRpsResponse(value: unknown): RpsResponseRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => key !== 'id' && key !== 'action')) return null;
  if (typeof v.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(v.id) || !['accept', 'decline', 'quit', 'said', 'skipped'].includes(v.action as string)) return null;
  return { id: v.id, action: v.action as RpsResponseAction };
}

// ---------------------------------------------------------------- timing

export interface RpsTiming {
  /** Before the first round: the arm comes up, she gets ready (a little nervous). */
  readyMs: number;
  /** Before every later round. */
  nextMs: number;
  /**
   * The count: her fist starts its first stroke at 0 and lands 石头 at leadMs, 剪刀 at leadMs + beatMs and
   * 布 (the reveal) at leadMs + 2 × beatMs. The lead keeps the first stroke whole (it starts from rest).
   */
  leadMs: number;
  beatMs: number;
  /** After 布 without the user's hand: she holds her fist and waits this long, then lets it go. */
  waitMs: number;
  /** Her reaction after a reveal (longer while she says something: the host holds the phase until her line is done). */
  reactMs: number;
  /** A pretend cheat: how long the fake hand stays up once her line starts. */
  teaseMs: number;
  /** After the match is decided (her line, if any, was said at the last reveal), then the arm comes down. */
  endMs: number;
  /** Her invitation's buttons stay this long, then quietly go away. */
  inviteMs: number;
}
export const RPS_TIMING: Readonly<RpsTiming> = Object.freeze({ readyMs: 1800, nextMs: 1100, leadMs: 300, beatMs: 620, waitMs: 15_000, reactMs: 2300, teaseMs: 1700, endMs: 2400, inviteMs: 90_000 });
/** When 布 lands, from the start of the count. */
export const rpsRevealAfterMs = (timing: Pick<RpsTiming, 'leadMs' | 'beatMs'>) => timing.leadMs + 2 * timing.beatMs;
/** Best of three: first to two round wins; draws replay; a match never runs past this many throws. */
export const RPS_FIRST_TO = 2;
export const RPS_MAX_ROUNDS = 7;

// ---------------------------------------------------------------- what the windows see

/** The face she makes (src/stage/rps-performance.ts turns it into the procedural face). */
export type RpsFace = 'neutral' | 'nervous' | 'expectant' | 'smug' | 'pout' | 'gentle' | 'tease' | 'surprised' | 'happy';
export const RPS_FACES: readonly RpsFace[] = ['neutral', 'nervous', 'expectant', 'smug', 'pout', 'gentle', 'tease', 'surprised', 'happy'];
export type RpsPhase = 'invite' | 'ready' | 'count' | 'wait' | 'reveal' | 'end' | 'aside';

export interface RpsView {
  /** The match (or invitation) id. */
  id: string;
  /** Increases with every published change. */
  revision: number;
  phase: RpsPhase;
  /** Which throw this is (draws count), 0 for an invitation or an aside. */
  round: number;
  score: { her: number; user: number };
  firstTo: number;
  /** Buttons accept a hand. */
  accepting: boolean;
  /** This round's sealed choice (digest only) while it is still hidden; null otherwise. */
  commitment: RpsCommitment | null;
  /** Her hand and its seal opener, only once the round is revealed. */
  revealed: RpsSecret | null;
  /** The user's hand this round, once given. */
  userHand: RpsHand | null;
  outcome: RpsOutcome | null;
  /** Unused since 2026-11-03 (her words go to the ordinary chat bubble as `say`); always null. Kept for older windows. */
  line: string | null;
  face: RpsFace;
  /** A pretend cheat: the hand she pretends she showed (the score never changes). */
  tease: RpsHand | null;
  beatMs: number;
  /** How long this phase lasts (ms; 0 = until the user acts) and how far into it the view is. */
  phaseMs: number;
  elapsedMs: number;
  /** The match is decided: who won, or null while it is still going. */
  result: 'her' | 'user' | null;
  /**
   * What she says now, once per id: the pet window shows it in the ordinary chat bubble and reads it with the ordinary
   * voice (src/ui/rps-speech.ts), then answers `said`. Absent or null: she is quiet.
   */
  say?: RpsSay | null;
}
/** One line of hers in a game (docs/claude/2026-11-03-rps-five-fixes.md): a fresh id for every line. */
export interface RpsSay { id: string; text: string }
