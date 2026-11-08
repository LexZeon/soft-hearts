import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { FatiguePhase } from '../../shared/fatigue';
import type { HerLifeActivity } from '../../shared/her-life';
import type { MoodEvent, MoodParameters, MoodSnapshot, MoodValues } from '../../shared/mood';
import { RPS_TIMING, readRpsResponse, readRpsThrow, type RpsFace, type RpsHand, type RpsInputSource, type RpsView } from '../../shared/rps';
import { RpsMatch, type RpsMatchEnd } from '../../shared/rps-match';
import { resolveRpsStyle, rpsAnswer, rpsChatContext, rpsInviteVerdict, rpsPlayfulness, scanRpsRefusal, scanRpsRequest, type RpsAnswer } from '../../shared/rps-personality';
import type { RouterDecision, RouterVerdict } from '../../shared/module-router/interface';
import { RPS_VOICE_LATE_MS, rpsSayHoldMs, type RpsMoment } from '../../shared/rps-voice';
import { rpsDiaryLine, rpsHabits } from '../../shared/rps-memory';
import type { RpsStore } from './store';
import { RpsVoice, type RpsLine, type RpsVoiceOptions } from './voice';
import type { InteractionBudget } from '../../shared/behaviors/interaction-budget/interface';

/** The active character as the host sees it at one moment. */
export interface RpsCharacterState {
  id: string;
  /** compileCharacterPersona(card): her words are asked with it. */
  persona: string;
  parameters: MoodParameters;
  snapshot: Pick<MoodSnapshot, 'primary' | 'values'>;
  fatigue: FatiguePhase | null | undefined;
  /** 她自己的生活: what she is doing now, and its chat words ("想事情"). */
  herLife: HerLifeActivity | null | undefined;
  herLifeChat?: string;
}
export interface RpsTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
export interface RpsHostOptions {
  store: RpsStore;
  character(): RpsCharacterState | null;
  /** The pet window is shown (a hidden pet never starts or keeps a game). */
  visible(): boolean;
  /** The user profile's "允许记录" for the current scope: only then are the user's hands kept. */
  recording(): boolean;
  localDate(ms: number): string;
  publish(view: RpsView | null): void;
  /** The existing mood event when a match ends (electron/mood.ts: a positive chat event with its own topic, so repeats fade). */
  mood(event: { id: string; delta: Partial<MoodValues>; reason: string }, characterId: string): void;
  /** A chat turn is in flight: the mood event waits (a chat event in between would cost that reply its appraisal). */
  chatBusy(): boolean;
  /** Her voice is still reading a reply (either voice): a game she agreed to starts after she finishes. Omitted: never. */
  speaking?(): boolean;
  /** She turns to the user (her-life). */
  interacted?(characterId: string): void;
  /** Her words at a moment of the game: the small model's one short call (electron/rps/voice.ts). Omitted: only remembered lines. */
  quick?: RpsVoiceOptions['quick'];
  available?(): boolean;
  /** Her language habits for the active card (personalize-language context), or ''. */
  language?(): string;
  /**
   * A line is about to be shown with id `sayId`: freeze its voice style now (mood and persona, as for her other lines),
   * so the Bailian voice reads it like the rest of what she says.
   */
  speechStyle?(sayId: string): void;
  /** The camera gesture input is on (not yet: point 7 chose MediaPipe for later). Default: clicks only. */
  cameraInput?(): boolean;
  clock?: () => number;
  random?: () => number;
  /** Whether she speaks and which remembered line: its own stream, so it never shifts her sealed picks. */
  voiceRandom?: () => number;
  nonce?: () => string;
  createId?: () => string;
  timers?: RpsTimers;
  timing?: Partial<typeof RPS_TIMING>;
  /** 体验记录 (shared/journal.ts "rps"): invitations, answers and each match's numbers (never the hands, never her words). */
  journal?(characterId: string, entry: RpsJournalEntry): void;
  /**
   * I-023 haiku 调度台 (electron/module-router/): haiku's reading of message `requestId` for 猜拳, asked once her reply is done
   * (it ran in parallel with Opus). Only for a message the local words did not recognise (nor as a refusal). Omitted: local words only.
   */
  routed?(requestId: string): Promise<RouterVerdict>;
  /** I-023: who decided for this message and what she did (the developer panel's "为什么"). */
  decided?(requestId: string, decision: RouterDecision): void;
  /**
   * I-010 互动余额 (electron/interaction-budget/host.ts), read each time it is needed: when she may invite again is counted in the
   * user's interactions since her last invitation and the last game (not 2 hours, 1 hour and 2 a day); whether she says something in
   * a game is pressed by the budget's room (not by "lines today"), and a line she says spends from it. Omitted or null: the old rules.
   */
  budget?(): Pick<InteractionBudget, 'credit' | 'room' | 'spend' | 'interactionsSince' | 'againAfter'> | null;
}

/** One 猜拳 moment for the 体验记录: counts only. */
export interface RpsJournalEntry {
  event: 'invite' | 'accept' | 'decline' | 'expired' | 'start' | 'result';
  origin?: 'her' | 'user'; rounds?: number; herWins?: number; userWins?: number; draws?: number; result?: 'her' | 'user' | 'none'; end?: RpsMatchEnd;
  /** How many lines she said in that match. */
  spoke?: number;
}

/**
 * The existing mood event for a played match: a positive chat event with its own topic, so it lifts her mood and
 * playing again soon after gives less (shared/mood.ts doseGain). Also counts as an interaction (lastInteractionAt).
 */
export function rpsMoodEvent(event: { id: string; delta: Partial<MoodValues>; reason: string }): MoodEvent {
  return { type: 'chat', id: event.id, delta: { ...event.delta }, context: 'positive', topic: 'rps', reason: event.reason };
}

/** A crypto-backed uniform number in [0, 1). */
export const cryptoRandom = () => randomInt(0, 2 ** 32) / 2 ** 32;
const START_DELAY_MS = 700;
/** While a chat turn still runs at the start's deadline (her reply task wraps up), look again this often… */
const START_RETRY_MS = 250;
/** …and drop the start if the chat is still not free this long after her reply: a game never opens late. */
const START_GIVE_UP_MS = 5_000;
/** Her voice still reading the reply in which she agreed: the game waits for her at most this long, then starts anyway. */
const START_TALK_MS = 20_000;
/** After her line was read, a short breath before the game goes on. */
const SAID_BREATH_MS = 450;
/** The developer panel's words for her answer (I-023 "最后谁说了算"). */
const RPS_ANSWER_ACTION: Readonly<Record<RpsAnswer, string>> = { accept: '答应，回复说完开局', sleepy: '困了，推一推，不开局', busy: '在忙自己的事，推一推，不开局' };

interface Invite { id: string; characterId: string; at: number }
interface Pending { requestId: string; characterId: string; answer: RpsAnswer }
/**
 * I-023: a message the local words did not recognise, waiting for its reply to finish, then for haiku's verdict. `invited`:
 * her invitation was open when it came (she asked first, so a yes from haiku is an accept).
 */
interface Routed { requestId: string; invited: boolean; characterId: string | null }
/** The accepted request's start, owned by its timer: any newer message, a cancel or disposal revokes it. */
interface Starting { characterId: string; until: number; talkUntil: number; handle: unknown }
/** Her line for the round in play, asked as soon as both hands were in (host only until the reveal). */
interface Prepared { matchId: string; round: number; moment: RpsMoment; line: RpsLine | null }
/** The moment on show waits for its line (until `until`, then it is dropped). */
interface Waiting { line: RpsLine; key: string; until: number }
/** Her line on show: the window reads it, then answers `said` (or `skipped` when it could not show it). */
interface Saying { id: string; text: string; key: string; tease: RpsHand | null; teaseUntil: number }
/** A line handed to the window and not answered yet: counted as said only when the window says it showed it. */
interface Sent { line: RpsLine; matchId: string | null; round: number }
const SENT_KEPT = 16;

/**
 * G1 猜拳, host side: one match at a time, owned here so the window never sees her hand before the reveal.
 * One timer, set to the match's next deadline. Starts from her invitation (the inner loop's "邀请玩猜拳") or the
 * user's request in chat; ends by itself, by the user's ×, by a chat message, hiding or a character switch.
 * Her words go to the pet window as `say` (the ordinary chat bubble and voice, src/ui/rps-speech.ts); the game waits
 * for them while she talks. Nothing she says in a game is archived as chat: the match itself is kept as counts.
 */
export class RpsHost {
  private match: RpsMatch | null = null;
  private matchCharacter = '';
  private invite: Invite | null = null;
  /** Her answer to "下次吧", outside a match: shown only once its line is there. */
  private aside: { id: string; until: number } | null = null;
  private pending: Pending | null = null;
  /** I-023: the message whose reply is still running (slow path). */
  private routed: Routed | null = null;
  /** I-023: her reply is done and haiku's verdict is awaited; any newer message, cancel() or dispose() revokes it. */
  private routeWait: Routed | null = null;
  private starting: Starting | null = null;
  private cueKey = '';
  private prepared: Prepared | null = null;
  private waiting: Waiting | null = null;
  private saying: Saying | null = null;
  private readonly sent = new Map<string, Sent>();
  private teaseShown = false;
  private faceOverride: RpsFace | null = null;
  private saidThisMatch = 0;
  private spokeAtRound = 0;
  private sayCount = 0;
  private revision = 0;
  private timer: unknown = null;
  private moodQueue: { id: string; delta: Partial<MoodValues>; reason: string; until: number; characterId: string } | null = null;
  private disposed = false;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly timers: RpsTimers;
  private readonly voice: RpsVoice;
  private published: RpsView | null = null;
  /** Diagnostics for tests and the record (counts only). */
  readonly stats = { matches: 0, linesSaid: 0 };

  constructor(private readonly options: RpsHostOptions) {
    this.clock = options.clock ?? Date.now;
    this.random = options.random ?? cryptoRandom;
    this.timers = options.timers ?? {
      set: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
      clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.voice = new RpsVoice({ quick: options.quick, available: options.available, language: options.language, store: options.store,
      localDate: options.localDate, clock: this.clock, random: options.voiceRandom ?? cryptoRandom, timers: this.timers });
  }

  private now(): number { return this.clock(); }
  private id(): string { return (this.options.createId ?? (() => randomUUID().replace(/-/gu, '')))(); }
  private nonce(): string { return (this.options.nonce ?? (() => randomBytes(16).toString('hex')))(); }
  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }

  get active(): boolean { return this.match !== null && !this.match.over; }
  /** The voice's counts (tests, the record). */
  get voiceStats(): Readonly<RpsVoice['stats']> { return this.voice.stats; }
  /** The window's current view (desk:rpsGet after a reload). */
  view(): RpsView | null { return this.published ? structuredClone(this.published) : null; }

  // ------------------------------------------------------------ invitations (inner loop)

  /** Whether the inner loop may offer "邀请玩猜拳" on this speech opportunity. Never calls a model. */
  inviteEligible(characterId: string, quiet: boolean): boolean {
    if (this.disposed || this.invite || this.active || !this.safe(() => this.options.visible(), false)) return false;
    const character = this.safe(() => this.options.character(), null);
    if (!character || character.id !== characterId) return false;
    const now = this.now(), invites = this.options.store.invites(), lastGameAt = this.options.store.lastGameAt();
    const verdict = rpsInviteVerdict({ now, today: this.options.localDate(now), playfulness: rpsPlayfulness(character.snapshot, character.parameters),
      quiet, herLife: character.herLife, gameActive: this.active, invites, lastGameAt, ...this.counted(characterId, invites, lastGameAt) });
    return verdict === 'ok';
  }

  /** I-010: the interactions since her last invitation and the last game, and how many she waits for; nothing without a budget. */
  private counted(characterId: string, invites: readonly { at: number }[], lastGameAt: number | null): { interactions?: { sinceInvite: number | null; sinceGame: number | null; needed: number } } {
    const budget = this.safe(() => this.options.budget?.() ?? null, null);
    if (!budget) return {};
    try {
      const lastInvite = invites.reduce<number | null>((latest, invite) => Number.isFinite(invite.at) && (latest === null || invite.at > latest) ? invite.at : latest, null);
      const since = (at: number | null) => at === null ? null : budget.interactionsSince(characterId, at);
      const needed = Math.max(budget.againAfter(characterId, 'invite'), lastGameAt !== null ? budget.againAfter(characterId, 'game') : 0);
      return { interactions: { sinceInvite: since(lastInvite), sinceGame: since(lastGameAt), needed } };
    } catch { return {}; }
  }

  /** I-010: the budget's room for one of her game lines now (null: no budget, the old "lines today" press). */
  private lineRoom(character: RpsCharacterState): number | null {
    const budget = this.safe(() => this.options.budget?.() ?? null, null);
    if (!budget) return null;
    try { const room = budget.room(character.id, 'gameLine', { mood: character.snapshot.primary }); return Number.isFinite(room.factor) ? room.factor : null; } catch { return null; }
  }

  /** Her invitation line was shown (and committed): the two buttons appear beside her. */
  invited(characterId: string): void {
    const character = this.safe(() => this.options.character(), null);
    if (this.disposed || this.active || !character || character.id !== characterId || !this.safe(() => this.options.visible(), false)) return;
    const now = this.now();
    this.options.store.noteInvite(now, this.options.localDate(now));
    this.dropAside();
    this.invite = { id: this.id(), characterId, at: now };
    this.note(characterId, { event: 'invite' });
    this.publish();
  }

  /**
   * Developer test command (electron/test-commands/): her invitation buttons right now. Like `invited` but spends no
   * invitation quota (the day's invitation count is untouched), so testing does not make her shy for real.
   */
  testInvite(): boolean {
    const character = this.safe(() => this.options.character(), null);
    if (this.disposed || this.active || !character || !this.safe(() => this.options.visible(), false)) return false;
    this.dropAside();
    this.invite = { id: this.id(), characterId: character.id, at: this.now() };
    this.publish();
    return true;
  }

  /** Developer test command: a match right away, as if the user had asked and she had agreed. */
  testStart(): boolean {
    const character = this.safe(() => this.options.character(), null);
    if (this.disposed || !character) return false;
    return this.start('user', character.id);
  }

  respond(value: unknown): boolean {
    const input = readRpsResponse(value);
    if (!input || this.disposed) return false;
    if (input.action === 'said' || input.action === 'skipped') return this.said(input.id, input.action === 'said');
    if (this.invite && input.id === this.invite.id && input.action !== 'quit') {
      const invite = this.invite;
      this.invite = null;
      this.note(invite.characterId, { event: input.action === 'accept' ? 'accept' : 'decline' });
      // I-010: "来！" or "下次吧" answers her invitation (a click, not a mood event, so it is counted here, once per invitation).
      try { this.options.budget?.()?.credit(invite.characterId, 'answer', `rps-answer:${invite.id}`); } catch { /* Bookkeeping only. */ }
      if (input.action === 'accept') return this.start('her', invite.characterId);
      this.publish(); // The buttons go at once; her answer, if she has one, follows.
      this.declined(invite.characterId);
      return true;
    }
    if (this.match && input.id === this.match.id && input.action === 'quit') {
      this.match.stop(this.now(), 'quit');
      this.cueChanged();
      this.publish();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ the user asks in chat

  /**
   * At the start of a chat turn, on the user's literal text. A request to play returns this turn's private context
   * (she agrees or puts it off by her character); any other message ends an open invitation or match ("玩完就散").
   * I-023: a message the local words do not recognise (and that is not a refusal) is kept for haiku's verdict after her
   * reply (chatDone → awaitRoute); the local fast path never waits for haiku.
   */
  chatTurn(requestId: string, text: unknown): string | null {
    if (this.disposed) return null;
    this.revokeStart(); // A newer message changes the context: an earlier "yes" no longer opens a game.
    this.routed = null; this.routeWait = null; // …and an earlier message's haiku verdict no longer counts (I-023).
    const asks = scanRpsRequest(text);
    if (!asks) {
      const invited = !!this.invite;
      this.leave();
      // I-023 slow path: the local words did not recognise it. Unless they recognise a refusal ("别玩了", which wins),
      // haiku's verdict (asked in parallel with Opus) decides after her reply whether this was a request to play.
      if (this.options.routed) {
        if (scanRpsRefusal(text)) this.decide(requestId, { by: 'refusal', action: '你说了不玩，不开局' });
        else this.routed = { requestId, invited, characterId: this.safe(() => this.options.character()?.id ?? null, null) };
      }
      return null;
    }
    if (this.active) { this.decide(requestId, { by: 'local', action: '正在玩，不变' }); return null; } // Typing the game's name mid-match changes nothing.
    const character = this.safe(() => this.options.character(), null);
    if (!character) return null;
    const answer = this.invite ? 'accept' : rpsAnswer({ fatigue: character.fatigue, herLife: character.herLife, weights: character.parameters.weights, random: this.random });
    this.invite = null;
    this.dropAside();
    this.pending = { requestId, characterId: character.id, answer };
    this.decide(requestId, { by: 'local', action: RPS_ANSWER_ACTION[answer] });
    return rpsChatContext(answer, character.herLifeChat);
  }

  /**
   * The chat turn ended; an accepted request starts the match right after her reply (START_DELAY_MS), and after her voice
   * has finished reading it. The start is one owned timer: a newer message (chatTurn), cancel() or dispose() revokes it,
   * and when it fires it checks again that it is still the current start, that no chat turn is running and (start) the
   * character and the window.
   */
  chatDone(requestId: string, completed: boolean): void {
    const pending = this.pending;
    if (pending?.requestId === requestId) this.pending = null;
    const routed = this.routed?.requestId === requestId ? this.routed : null;
    if (routed) this.routed = null;
    this.flushMood();
    if (routed && completed && !this.disposed) this.awaitRoute(routed);
    if (!pending || pending.requestId !== requestId || !completed || pending.answer !== 'accept' || this.disposed) return;
    this.beginStart(pending.characterId);
  }

  /** An accepted request: the match starts START_DELAY_MS from now (after her voice has read the reply, see startDue). */
  private beginStart(characterId: string): void {
    this.revokeStart();
    const now = this.now();
    const starting: Starting = { characterId, until: now + START_GIVE_UP_MS, talkUntil: now + START_TALK_MS, handle: null };
    this.starting = starting;
    this.armStart(starting, START_DELAY_MS);
  }

  /**
   * I-023 slow path: her reply to a message the local words did not recognise is done; haiku read it in parallel. If it was
   * a request to play, she answers it now by her character (rpsAnswer, as in the fast path): she plays (the match starts
   * like an accepted request, with its own opening: her arm comes up and she calls 石头——剪刀——布) or puts it off (no match).
   * Opus already answered without knowing; nothing is added to what she said.
   */
  private awaitRoute(routed: Routed): void {
    this.routeWait = routed;
    let verdict: Promise<RouterVerdict>;
    try { verdict = Promise.resolve(this.options.routed!(routed.requestId)); } catch { this.routeWait = null; return; }
    void verdict.then(value => this.routeArrived(routed, value), () => { if (this.routeWait === routed) this.routeWait = null; });
  }

  private routeArrived(routed: Routed, verdict: RouterVerdict): void {
    if (this.routeWait !== routed || this.disposed) return; // A newer message, a cancel or disposal: this verdict is void.
    this.routeWait = null;
    if (verdict.kind === 'not-called') { this.decide(routed.requestId, { by: 'nobody', action: '不是在叫她玩，不开局' }); return; }
    if (verdict.kind !== 'called') return; // Unknown (error, timeout, late…): the local words stand, nothing happens.
    if (this.active) { this.decide(routed.requestId, { by: 'haiku', action: '正在玩，不变' }); return; }
    const character = this.safe(() => this.options.character(), null);
    // Hidden, or another character by now (the message was said to the one before): no game.
    if (!character || character.id !== routed.characterId || !this.safe(() => this.options.visible(), false)) { this.decide(routed.requestId, { by: 'haiku', action: '她不在，不开局' }); return; }
    const answer: RpsAnswer = routed.invited ? 'accept'
      : rpsAnswer({ fatigue: character.fatigue, herLife: character.herLife, weights: character.parameters.weights, random: this.random });
    this.decide(routed.requestId, { by: 'haiku', action: RPS_ANSWER_ACTION[answer] });
    if (answer === 'accept') this.beginStart(character.id);
  }

  private decide(requestId: string, decision: RouterDecision): void {
    try { this.options.decided?.(requestId, decision); } catch { /* The panel line never changes the game. */ }
  }

  private armStart(starting: Starting, ms: number): void {
    starting.handle = this.timers.set(() => this.startDue(starting), ms);
  }

  private startDue(starting: Starting): void {
    if (this.starting !== starting) return; // Revoked (or replaced): a late callback changes nothing.
    starting.handle = null;
    if (this.disposed || this.active) { this.starting = null; return; }
    const now = this.now();
    if (this.safe(() => this.options.chatBusy(), true)) {
      // Her reply task is still wrapping up: look again shortly, never past the give-up time.
      if (now + START_RETRY_MS <= starting.until) this.armStart(starting, START_RETRY_MS);
      else this.starting = null;
      return;
    }
    // Her voice is still reading what she said: the "石头——剪刀——布" waits for her (at most START_TALK_MS).
    if (this.safe(() => this.options.speaking?.() === true, false) && now + START_RETRY_MS <= starting.talkUntil) {
      starting.until = Math.max(starting.until, now + START_RETRY_MS); // Talking is not a stuck chat.
      this.armStart(starting, START_RETRY_MS);
      return;
    }
    this.starting = null;
    this.start('user', starting.characterId);
  }

  private revokeStart(): void {
    const starting = this.starting;
    this.starting = null;
    if (starting?.handle != null) this.timers.clear(starting.handle);
  }

  // ------------------------------------------------------------ the match

  private start(origin: 'her' | 'user', characterId: string): boolean {
    const character = this.safe(() => this.options.character(), null);
    if (this.active || !character || character.id !== characterId || !this.safe(() => this.options.visible(), false)) return false;
    this.revokeStart(); // One match at a time: an earlier start still waiting is not played after this one.
    const recording = this.safe(() => this.options.recording(), false);
    const habits = recording ? rpsHabits(this.options.store.games(character.id)) : null;
    const now = this.now();
    this.dropAside(); this.invite = null;
    this.match = new RpsMatch({ id: this.id(), origin, random: this.random, nonce: () => this.nonce(),
      style: resolveRpsStyle(null, character.parameters), habits, timing: this.options.timing }, now);
    this.matchCharacter = character.id;
    this.stats.matches++;
    this.saidThisMatch = 0; this.spokeAtRound = 0; this.cueKey = ''; this.prepared = null;
    this.note(character.id, { event: 'start', origin });
    this.cueChanged();
    try { this.options.interacted?.(character.id); } catch { /* Her-life bookkeeping never blocks the game. */ }
    this.publish();
    return true;
  }

  /** The user's hand from one input source ("我出了什么"). Clicks only until the camera input exists. */
  throwHand(value: unknown): 'accepted' | 'duplicate' | 'stale' | 'closed' | 'invalid' {
    const input = readRpsThrow(value), match = this.match;
    if (!input || this.disposed) return 'invalid';
    if (!this.allowed(input.source)) return 'invalid';
    if (!match || match.over || input.gameId !== match.id) return 'closed';
    const now = this.now();
    if (match.advance(now)) this.cueChanged(); // A deadline that already passed is applied first, exactly as the timer would have.
    if (match.over) { this.finishMatch(); return 'closed'; }
    const result = match.throwHand({ round: input.round, hand: input.hand, source: input.source }, now);
    if (result === 'accepted') this.prepare();
    this.cueChanged();
    this.publish();
    return result;
  }

  private allowed(source: RpsInputSource): boolean {
    return source === 'click' || (source === 'camera' && this.safe(() => this.options.cameraInput?.() === true, false));
  }

  /** The existing one-second mood tick: a hidden pet or another character ends the game or the invitation at once. */
  sweep(): void {
    if (this.disposed || (!this.match && !this.invite && !this.aside)) return;
    const visible = this.safe(() => this.options.visible(), false), character = this.safe(() => this.options.character(), null);
    const owner = this.match && !this.match.over ? this.matchCharacter : this.invite?.characterId;
    if (!visible || (owner !== undefined && character?.id !== owner)) this.cancel();
  }

  /** Hidden, character switch, quit: everything goes away now (a partial match still counts for her mood). */
  cancel(): void {
    this.pending = null;
    this.routed = null; this.routeWait = null;
    this.revokeStart();
    this.leave();
  }

  private leave(): void {
    const had = this.invite || this.aside || this.match;
    this.invite = null;
    this.dropAside();
    if (this.match && !this.match.over) { this.match.stop(this.now(), 'abandoned'); this.finishMatch(); }
    else if (had) this.publish();
  }

  // ------------------------------------------------------------ her words

  /** Both hands are in: ask for her words now (they show at the reveal). A pretend cheat she will not say becomes a plain loss. */
  private prepare(): void {
    const match = this.match, facts = match?.facts();
    if (!match || !facts || (this.prepared?.matchId === match.id && this.prepared.round === facts.round)) return;
    const character = this.safe(() => this.options.character(), null);
    const moment: RpsMoment = { kind: facts.last ? 'final' : 'round', earlier: facts.earlier, score: facts.score,
      round: { her: facts.her, user: facts.user, outcome: facts.outcome, intent: facts.intent, reaction: facts.reaction.kind, tease: facts.reaction.tease },
      ...(facts.last ? { result: facts.last } : {}), ...(facts.reaction.kind === 'habit' ? { habit: facts.user } : {}) };
    const line = character && character.id === this.matchCharacter
      ? this.voice.plan({ character, moment, saidThisMatch: this.saidThisMatch, spokeLastRound: facts.round > 1 && this.spokeAtRound === facts.round - 1, room: this.lineRoom(character) })
      : null;
    if (!line && facts.reaction.tease) match.cancelTease();
    this.prepared = { matchId: match.id, round: facts.round, moment, line };
  }

  /** A new phase of the match: the previous moment's line stops holding it; the reveal or an early end may bring a line. */
  private cueChanged(): void {
    const match = this.match;
    if (!match) return;
    const key = `${match.id}:${match.currentPhase}:${match.roundNumber}`;
    if (key === this.cueKey) return;
    this.cueKey = key;
    this.endMoment();
    if (match.currentPhase === 'reveal') {
      const prepared = this.prepared?.matchId === match.id && this.prepared.round === match.roundNumber ? this.prepared : null;
      this.prepared = null;
      if (prepared?.line) this.lineAt(prepared.line, key);
    } else if (match.currentPhase === 'end' && (match.end === 'quit' || match.end === 'timeout')) {
      const character = this.safe(() => this.options.character(), null);
      const record = match.record(this.now()), score = { her: record.rounds.filter(r => r.outcome === 'her').length, user: record.rounds.filter(r => r.outcome === 'user').length };
      const line = character && character.id === this.matchCharacter
        ? this.voice.plan({ character, moment: { kind: match.end, earlier: record.rounds, score }, saidThisMatch: this.saidThisMatch, spokeLastRound: false, room: this.lineRoom(character) }) : null;
      if (line) this.lineAt(line, key);
    }
  }

  /** The moment `key` is on show with `line`: say it now, or hold the moment until it comes (a late one is dropped). */
  private lineAt(line: RpsLine, key: string): void {
    if (line.settled) { this.startSaying(line, key); return; }
    const until = this.now() + RPS_VOICE_LATE_MS, waiting: Waiting = { line, key, until };
    this.waiting = waiting;
    this.match?.hold(until);
    if (this.aside) this.aside.until = Math.max(this.aside.until, until);
    line.onSettled(() => {
      if (this.waiting !== waiting || this.disposed) return; // That moment is over.
      this.waiting = null;
      if (this.now() > until || this.cueKey !== key) return;
      this.startSaying(line, key);
      this.publish();
    });
  }

  private startSaying(line: RpsLine, key: string): void {
    const text = line.text, match = this.match, now = this.now();
    if (!text) {
      // She has nothing to say this time: the moment runs on (a pretend cheat she did not say is just a loss).
      if (line.moment.round?.reaction === 'tease') this.faceOverride = 'pout';
      if (match && !match.over) match.hold(null);
      else if (this.aside) this.aside.until = now;
      return;
    }
    const id = `${match && !match.over ? match.id : this.aside?.id ?? this.id()}l${++this.sayCount}`;
    try { this.options.speechStyle?.(id); } catch { /* Read with the plain voice. */ }
    const tease = line.moment.round?.reaction === 'tease' ? line.moment.round.tease : null;
    this.saying = { id, text, key, tease, teaseUntil: tease ? now + (this.options.timing?.teaseMs ?? RPS_TIMING.teaseMs) : 0 };
    if (tease) this.teaseShown = true;
    // Not said yet: handed to the window, which may have to skip it (round 028). Counted when it answers `said`.
    this.sent.set(id, { line, matchId: match && !match.over ? match.id : null, round: line.moment.round && match ? match.roundNumber : 0 });
    while (this.sent.size > SENT_KEPT) this.sent.delete(this.sent.keys().next().value!);
    if (match && !match.over) match.hold(now + rpsSayHoldMs(text));
    else if (this.aside) this.aside.until = now + rpsSayHoldMs(text);
  }

  /**
   * The window finished showing (and reading) her line, or could not show it: the game goes on after a breath. Only a
   * shown line counts as said (this match's and today's counts press her later lines down, a live one is kept); a shown
   * line whose answer comes after its moment is over still counts, without touching the game.
   */
  private said(id: string, shown: boolean): boolean {
    const sent = this.sent.get(id), saying = this.saying?.id === id ? this.saying : null;
    if (!sent && !saying) return false;
    this.sent.delete(id);
    if (sent && shown) {
      if (sent.matchId && this.match?.id === sent.matchId) { this.saidThisMatch++; if (sent.round) this.spokeAtRound = sent.round; }
      this.stats.linesSaid++;
      this.voice.said(sent.line);
      // I-010: a line she really said draws from the interaction budget (once per line id).
      const characterId = this.safe(() => this.options.character()?.id ?? '', '');
      if (characterId) { try { this.options.budget?.()?.spend(characterId, 'gameLine', `rps-line:${id}`); } catch { /* Bookkeeping never holds the game. */ } }
    }
    if (!saying) return true;
    this.saying = null;
    const now = this.now();
    if (this.match && !this.match.over) this.match.hold(now + SAID_BREATH_MS);
    else if (this.aside) this.aside.until = now;
    this.publish();
    return true;
  }

  /** The moment is over: its line no longer holds anything, one still coming is dropped. */
  private endMoment(): void {
    this.waiting?.line.abort();
    this.waiting = null; this.saying = null; this.teaseShown = false; this.faceOverride = null;
  }

  /** Her answer to "下次吧" (no match): shown when its line is there, gone after it was read. */
  private declined(characterId: string): void {
    const character = this.safe(() => this.options.character(), null);
    if (!character || character.id !== characterId) return;
    const line = this.voice.plan({ character, moment: { kind: 'decline', earlier: [], score: { her: 0, user: 0 } }, saidThisMatch: 0, spokeLastRound: false, room: this.lineRoom(character) });
    if (!line) return;
    this.aside = { id: this.id(), until: this.now() };
    this.cueKey = `aside:${this.aside.id}`;
    this.endMoment();
    this.lineAt(line, this.cueKey);
    if (this.saying) this.publish(); else this.schedule();
  }

  private dropAside(): void {
    if (!this.aside) return;
    this.aside = null;
    if (this.cueKey.startsWith('aside:')) { this.endMoment(); this.cueKey = ''; }
  }

  // ------------------------------------------------------------ time

  private tick(): void {
    this.timer = null;
    const match = this.match, now = this.now();
    if (this.invite && now - this.invite.at >= (this.options.timing?.inviteMs ?? RPS_TIMING.inviteMs)) { this.note(this.invite.characterId, { event: 'expired' }); this.invite = null; this.publish(); }
    if (this.aside && now >= this.aside.until) { this.dropAside(); this.publish(); }
    if (match && !match.over) {
      match.advance(now);
      this.cueChanged();
      if (match.over) { this.finishMatch(); return; }
      this.publish();
      return;
    }
    if (this.saying?.teaseUntil) this.publish();
    else this.schedule();
  }

  private finishMatch(): void {
    const match = this.match;
    if (!match) return;
    const now = this.now(), record = match.record(now), characterId = this.matchCharacter;
    this.match = null; this.cueKey = '';
    this.prepared?.line?.abort(); this.prepared = null;
    this.endMoment();
    const recording = this.safe(() => this.options.recording(), false);
    this.options.store.finish(characterId, record, recording);
    const wins = (who: string) => record.rounds.filter(round => round.outcome === who).length;
    this.note(characterId, { event: 'result', origin: record.origin, rounds: record.rounds.length, herWins: wins('her'), userWins: wins('user'), draws: wins('draw'),
      result: record.result, ...(match.end ? { end: match.end } : {}), spoke: this.saidThisMatch });
    if (record.rounds.length) {
      const delta = record.result === 'her' ? { D: 6, O: 3, E: 4 } : record.result === 'user' ? { D: 4, O: 4, E: 4 } : { D: 2, O: 2, E: 1 };
      this.moodQueue = { id: `rps-${match.id}`, delta, reason: '和用户玩了猜拳', until: now + 60_000, characterId };
      this.flushMood();
    }
    this.publish();
  }

  private note(characterId: string, entry: RpsJournalEntry): void {
    try { this.options.journal?.(characterId, entry); } catch { /* Keeping a record never changes the game. */ }
  }

  private flushMood(): void {
    const queued = this.moodQueue;
    if (!queued) return;
    if (this.now() > queued.until) { this.moodQueue = null; return; }
    if (this.safe(() => this.options.chatBusy(), true)) { this.schedule(); return; }
    this.moodQueue = null;
    try { this.options.mood({ id: queued.id, delta: queued.delta, reason: queued.reason }, queued.characterId); } catch { /* A refused event changes nothing else. */ }
  }

  private compose(): RpsView | null {
    const now = this.now(), saying = this.saying, say = saying ? { id: saying.id, text: saying.text } : null;
    if (this.match && !this.match.over) {
      const view: RpsView = { ...this.match.view(now, null), revision: 0, say };
      const reaction = this.match.reaction();
      if (view.phase === 'reveal' && reaction?.tease) {
        // The pretend cheat: the fake hand only while she says it, then her owning up.
        if (saying?.tease && now < saying.teaseUntil) { view.tease = saying.tease; view.face = 'tease'; }
        else if (this.teaseShown) view.face = 'happy';
      }
      if (view.phase === 'reveal' && this.faceOverride) view.face = this.faceOverride;
      return view;
    }
    const base = { score: { her: 0, user: 0 }, firstTo: 2, accepting: false, commitment: null, revealed: null, userHand: null,
      outcome: null, tease: null, beatMs: this.options.timing?.beatMs ?? RPS_TIMING.beatMs, result: null, round: 0, line: null };
    if (this.invite) return { ...base, id: this.invite.id, revision: 0, phase: 'invite', face: 'expectant',
      phaseMs: this.options.timing?.inviteMs ?? RPS_TIMING.inviteMs, elapsedMs: Math.max(0, now - this.invite.at) };
    if (this.aside && say) return { ...base, id: this.aside.id, revision: 0, phase: 'aside', face: 'happy', say,
      phaseMs: Math.max(0, this.aside.until - now), elapsedMs: 0 };
    return null;
  }

  private publish(): void {
    const view = this.compose();
    if (view) view.revision = ++this.revision;
    else if (this.published) this.revision++;
    const changed = !!view || !!this.published;
    this.published = view;
    if (changed) { try { this.options.publish(view ? structuredClone(view) : null); } catch { /* A closed window just misses this frame. */ } }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
    if (this.disposed) return;
    const now = this.now(), times: number[] = [];
    if (this.match && !this.match.over) {
      const deadline = this.match.deadline();
      if (deadline !== null) times.push(deadline);
    }
    if (this.saying?.teaseUntil && this.saying.teaseUntil > now) times.push(this.saying.teaseUntil);
    if (this.invite) times.push(this.invite.at + (this.options.timing?.inviteMs ?? RPS_TIMING.inviteMs));
    if (this.aside) times.push(this.aside.until);
    if (this.moodQueue) times.push(now + 2_000);
    if (!times.length) return;
    this.timer = this.timers.set(() => { this.tick(); this.flushMood(); }, Math.max(0, Math.min(...times) - now));
  }

  /** The day's diary material ('' while nothing was recorded or they did not play). */
  diaryLine(characterId: string, start: number, end: number): string {
    const games = this.options.store.games(characterId);
    return rpsDiaryLine(games.filter(game => game.at >= start && game.at < end), rpsHabits(games));
  }

  dispose(): void {
    this.disposed = true;
    this.routed = null; this.routeWait = null;
    this.revokeStart();
    this.prepared?.line?.abort(); this.prepared = null;
    this.endMoment();
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null; this.match = null; this.invite = null; this.aside = null;
  }
}
