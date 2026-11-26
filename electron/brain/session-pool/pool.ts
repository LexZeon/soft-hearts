// I-186 step 0: one warm Claude Code chat process per
// character. Each slot is today's PersistentClaudeChat (electron/brain/claude-session.ts) with everything it already does (its own idle
// timer, spare, prewarm, budget, call hold, close reasons in the log); the pool only chooses the slot and decides which slots are seen.
//
// - A slot is keyed by character + connection scope + model (sessionSlotKey). A turn goes to the slot of the character it was accepted
//   for (`turn`), never to whoever happens to be on stage; a turn accepted for an older context is refused ('closed') instead of being
//   allowed to close a warm process it does not belong to.
// - Inside a slot the session key is the chat key (character, connection, conversation; chatSessionKey), without the companion's context
//   generation, so switching away and back finds the same process. A persona, a model or an opening change still closes it (they are in
//   the session's own key), and so does any context change of the character on stage (close('context'), below).
// - Idle per slot: the one on stage follows the companion window (seen 10 minutes, not seen 3); a slot switched away counts as not seen,
//   from the moment of the switch (3 minutes). seenElsewhere (out in full-screen) counts only for the one on stage.
// - At most maxWarm slots hold a process (knobs.ts, 3); one more closes the least recently used, never the speaking one or a busy one.
// - Stop, interrupt and the cut note act on the process of the turn they belong to (the slot's own stream), so another character's process
//   never sees them. A call holds the slot on stage; its turn cap (session.maxTurns) counts in that slot only.
// - Without `turn` (tests, measuring scripts, a plain build): one slot, exactly today's PersistentClaudeChat.
import { createHash } from 'node:crypto';
import type { ChatMessage } from '../../../shared/foundation/chat';
import type { StreamEvent } from '../../../shared/brain/stream-event';
import type { SpareWhy } from '../../../shared/brain/journal-entries';
import { ClaudeTurnError } from '../claude-process';
import { PersistentClaudeChat, persistentClaudeEnabled, type ClaudeTurnControl, type ClaudeTurnOutcome, type CompanionClaudeTask, type PersistentClaudeOptions } from '../claude-session';
import { SESSION_POOL_KNOBS } from './knobs';

type Emit = (type: StreamEvent['type'], text: string) => void;

/** The turn being sent: whose it is, and the keys the app accepted it under (read when the turn reaches the pool). */
export interface PoolTurnIdentity {
  characterId: string;
  providerScope: string;
  /** What the app accepted the turn under (the companion's speech scope): a task whose session.key differs is from an older context. */
  accepted: string;
  /** chatSessionKey for this character's current conversation: the session key inside her slot. */
  chat: string;
}

/** Who is on stage (the active card and the connection), also while a context change is still committing. */
export interface PoolStage { characterId: string; providerScope: string }

export interface ClaudeSessionPoolOptions extends PersistentClaudeOptions {
  /** The turn's character and keys (`owner`: the task's session.owner, I-209 step 2; unset: the desktop companion's); unset: one slot, today's behaviour. */
  turn?: (owner?: string) => PoolTurnIdentity | null;
  /** Who is on stage now; read at a context change (close('context')) and the first time a slot is needed. */
  stage?: () => PoolStage | null;
  /** At most this many slots hold a process (SESSION_POOL_KNOBS.maxWarm). */
  maxWarm?: number;
}

export function sessionSlotKey(characterId: string, providerScope: string, model: string): string {
  return JSON.stringify([characterId, providerScope, model]);
}

/** The session key inside a character's slot: her, the connection and the conversation; no context generation. */
export function chatSessionKey(characterId: string, providerScope: string, conversationId: string): string {
  return createHash('sha256').update(JSON.stringify([characterId, providerScope, conversationId])).digest('hex');
}

/**
 * Where the app's pool reads who a turn belongs to and who is on stage (electron/wiring/brain-wiring.ts). I-209 step 2: `owner` is the turn's
 * own character (the task's session.owner); unset is the desktop companion's, read as before.
 */
export interface PoolIdentitySources {
  /** The owner's committed scope (companion.ownerScope(owner): throws while a context change commits, or when she is not on stage). */
  scope(owner?: string): { characterId: string; providerScope: string };
  conversationId(owner?: string): string;
  /** What a turn of hers is accepted under (the companion's: the voice part's speechScope, with the context generation in it). */
  accepted(owner?: string): string;
  /** The active card and the saved connection's scope: already the new ones while a context change commits. */
  activeCharacter(): string;
  providerScope(): string;
}

/** `turn` from the companion (the turn's own context); `stage` from the active card and the saved connection (right at a context change). */
export function poolIdentity(sources: PoolIdentitySources): Required<Pick<ClaudeSessionPoolOptions, 'turn' | 'stage'>> {
  return {
    turn: owner => {
      try {
        const scope = sources.scope(owner);
        return { characterId: scope.characterId, providerScope: scope.providerScope, accepted: sources.accepted(owner),
          chat: chatSessionKey(scope.characterId, scope.providerScope, sources.conversationId(owner)) };
      } catch { return null; }
    },
    stage: () => { try { return { characterId: sources.activeCharacter(), providerScope: sources.providerScope() }; } catch { return null; } },
  };
}

export interface CapCandidate { readonly lastUsed: number; readonly warm: boolean; readonly busy: boolean }

/**
 * Which slots the cap closes so that at most maxWarm hold a process, counting `keep` (the speaking one) as one of them: the least recently
 * used first; never `keep`, never a busy one, never one that holds nothing.
 */
export function capVictims<T extends CapCandidate>(slots: readonly T[], keep: T, maxWarm: number): T[] {
  const others = slots.filter(slot => slot !== keep && slot.warm);
  const over = others.length - Math.max(0, Math.floor(maxWarm) - 1);
  return over > 0 ? others.filter(slot => !slot.busy).sort((a, b) => a.lastUsed - b.lastUsed).slice(0, over) : [];
}

interface Slot extends CapCandidate {
  readonly key: string;
  readonly characterId: string;
  readonly providerScope: string;
  readonly model: string;
  readonly chat: PersistentClaudeChat;
  lastUsed: number;
  onStage: boolean;
}

const REMEMBERED_REPLIES = 64;

export class ClaudeSessionPool {
  private readonly slotMap = new Map<string, Slot>();
  /** Which slot ran a reply (continueReply and regroup act on that process). */
  private readonly replies = new Map<string, Slot>();
  private stageNow: PoolStage | null = null;
  private visible = true;
  private held = false;
  private chatted = false;
  private disposed = false;
  /** Two failures in a row in any slot: every turn goes per message through that slot for the rest of the run. */
  private degraded: Slot | null = null;
  private plain: PersistentClaudeChat | null = null;
  private tick = 0;
  private readonly enabled: boolean;
  private readonly single: Slot | null;

  constructor(private readonly options: ClaudeSessionPoolOptions = {}) {
    this.enabled = options.enabled ?? persistentClaudeEnabled();
    this.single = options.turn ? null : this.slot('', null, '', true);
  }

  /** Whether the next ordinary chat turn would use a persistent process. */
  get active(): boolean { return this.enabled && !this.degraded && !this.disposed; }

  /** What each slot holds (the measuring script and tests; no text). */
  slots(): { characterId: string; providerScope: string; model: string; warm: boolean; busy: boolean; onStage: boolean; lastUsed: number }[] {
    return [...this.slotMap.values()].map(slot => ({ characterId: slot.characterId, providerScope: slot.providerScope, model: slot.model, warm: slot.warm,
      busy: slot.busy, onStage: slot.onStage, lastUsed: slot.lastUsed }));
  }

  /** 2026-11-26: the model id Claude Code reported for her current chat process (the one on stage first, else the latest used); null when none. A model id is not private. */
  reportedModel(): string | null {
    const slots = [...this.slotMap.values()].filter(slot => slot.chat.reportedModel !== null);
    slots.sort((a, b) => Number(b.onStage) - Number(a.onStage) || b.lastUsed - a.lastUsed);
    return slots[0]?.chat.reportedModel ?? null;
  }

  async stream(task: CompanionClaudeTask, signal: AbortSignal, emit: Emit, control?: ClaudeTurnControl): Promise<ClaudeTurnOutcome> {
    const { chat, routed, slot } = this.route(task, signal);
    if (slot && task.replyId) this.remember(task.replyId, slot);
    try { return await chat.stream(routed, signal, emit, control); }
    finally { if (slot) this.noteDegraded(slot); }
  }

  /** I-166: her closer look continues on the process that ran the reply; null when none did (or it is gone). */
  async continueReply(task: CompanionClaudeTask, signal: AbortSignal, emit: Emit): Promise<ClaudeTurnOutcome | null> {
    if (this.disposed) return null;
    const slot = (task.replyId ? this.replies.get(task.replyId) : undefined) ?? this.single;
    return slot ? slot.chat.continueReply(task, signal, emit) : null;
  }

  /** R33: the voice turns are regrouped in the process that ran them. */
  regroup(replyIds: readonly string[], shown: readonly ChatMessage[]): boolean {
    const slot = (replyIds.length ? this.replies.get(replyIds[0]) : undefined) ?? this.single;
    return !!slot && slot.chat.regroup(replyIds, shown);
  }

  /**
   * Spawn a spare for the one on stage, if this user chats with Claude and none is ready: spawn only, nothing is written to it, so no
   * request and no usage (docs/claude/2026-11-22-prewarm-free.md). Asked when the app is ready ('start'), another character comes on
   * stage ('switch'), her window is seen again ('visible'), full-screen Unbound opens ('fullscreen') or a call starts ('call'); with
   * no chat yet in this run too (the single slot of a plain build keeps today's "after a chat" gate). Never while disposed; a slot that
   * already holds a process or one starting starts no second.
   */
  prewarm(why: SpareWhy = 'start'): void {
    if (!this.active) return;
    const slot = this.stageSlot(true);
    if (!slot) return;
    slot.chat.prewarm(why);
    this.enforceCap(slot);
  }

  /** The companion window shown/restored (true) or hidden/minimised (false): it is how the one on stage is seen. */
  noteVisible(visible: boolean): void {
    if (this.disposed) return;
    this.visible = visible;
    const slot = this.stageSlot(visible);
    if (!slot) return;
    slot.chat.noteVisible(visible); // seen again: a spare (why 'visible') when the process was closed for idle
    if (visible) this.enforceCap(slot);
  }

  /**
   * reason 'context' is the companion's context change (electron/wiring/brain-wiring.ts attachChatWindows): the one now on stage is read
   * (`stage`); another character came on stage → nobody's process closes (the one switched away is not seen from now on); the same
   * character (her persona, a new conversation, a deleted chat) → her processes close; another connection or model → every process of
   * the old one closes. Without `stage`, or when either side is unknown, every slot closes as before. Any other reason closes every slot.
   */
  close(reason = 'context'): void {
    if (this.disposed) return;
    if (this.single) { this.single.chat.close(reason); return; }
    if (reason !== 'context') { for (const slot of this.slotMap.values()) slot.chat.close(reason); return; }
    const previous = this.stageNow;
    let next: PoolStage | null = null;
    try { next = this.options.stage?.() ?? null; } catch { next = null; }
    this.stageNow = next;
    this.refreshStage(); // first, so a slot leaving the stage starts no spare while it closes
    for (const slot of [...this.slotMap.values()]) {
      const sameCharacter = !!previous && !!next && previous.characterId === next.characterId && previous.providerScope === next.providerScope;
      if (!previous || !next || slot.providerScope !== next.providerScope || (sameCharacter && slot.characterId === next.characterId)) slot.chat.close('context');
    }
    // A spare for the next message of the one on stage, also when nothing was chatted before in this run (her first reply after a switch was cold)
    this.prewarm(!previous ? 'start' : previous.characterId === next?.characterId && previous.providerScope === next?.providerScope ? 'context' : 'switch');
  }

  /**
   * Her chats were deleted (one record, a whole scope, her memories with her card): her processes close even when she is not on stage, so
   * nothing deleted stays in a warm process. null: the archive cannot say whose: every process closes.
   */
  forgetCharacter(characterId: string | null): void {
    if (this.disposed) return;
    for (const slot of this.slotMap.values()) if (characterId === null || slot.characterId === characterId || this.single) slot.chat.close('context');
  }

  dispose(): void {
    if (this.disposed) return;
    for (const slot of this.slotMap.values()) slot.chat.dispose();
    this.plain?.dispose();
    this.disposed = true;
  }

  /** I-161 A (a switch off, a cleared vision context, hang-up): every process drops the small frames it holds. */
  forgetFrames(): void { for (const slot of this.slotMap.values()) slot.chat.forgetFrames(); }

  /** I-091: a call holds the process of the one on stage warm (moved along if the stage changes). */
  holdWarm(on: boolean): void {
    if (this.disposed) return;
    this.held = on;
    const stage = this.stageSlot(on);
    for (const slot of this.slotMap.values()) if (slot.onStage) slot.chat.holdWarm(on);
    if (stage && on) this.enforceCap(stage);
  }

  private route(task: CompanionClaudeTask, signal: AbortSignal): { chat: PersistentClaudeChat; routed: CompanionClaudeTask; slot: Slot | null } {
    if (this.degraded) return { chat: this.degraded.chat, routed: task, slot: this.degraded };
    if (this.single) return { chat: this.single.chat, routed: task, slot: this.single };
    if (!this.active) return { chat: this.plain ??= new PersistentClaudeChat({ ...this.options, enabled: false }), routed: task, slot: null };
    if (!task.session) {
      const slot = this.stageSlot(true);
      return slot ? { chat: slot.chat, routed: task, slot } : { chat: this.plain ??= new PersistentClaudeChat({ ...this.options, enabled: false }), routed: task, slot: null };
    }
    signal.throwIfAborted();
    let identity: PoolTurnIdentity | null;
    try { identity = this.options.turn?.(task.session.owner) ?? null; } catch { identity = null; } // I-209 step 2: her own slot, never whoever is on stage
    // Accepted for an older context (another character, a new conversation, a persona since): it never reaches anyone's process.
    if (!identity || identity.accepted !== task.session.key) throw new ClaudeTurnError('这轮聊天所属的角色或对话已改变。', 'closed');
    const model = this.modelName(this.options.selectModel?.(task) ?? task.model);
    const slot = this.slot(sessionSlotKey(identity.characterId, identity.providerScope, model), identity, model, true)!;
    slot.lastUsed = ++this.tick;
    this.chatted = true; // a character switched to later prewarms, as today's close('context') did after any chat
    this.enforceCap(slot);
    const session = Object.create(task.session, { key: { value: identity.chat, enumerable: true } }) as NonNullable<CompanionClaudeTask['session']>;
    return { chat: slot.chat, routed: Object.create(task, { session: { value: session, enumerable: true } }) as CompanionClaudeTask, slot };
  }

  private modelName(value: string): string { return value.trim().slice(0, 160); }

  private stage(): PoolStage | null {
    if (!this.stageNow) { try { this.stageNow = this.options.stage?.() ?? null; } catch { this.stageNow = null; } }
    return this.stageNow;
  }

  private onStage(scope: { characterId: string; providerScope: string } | null): boolean {
    if (!this.options.turn) return true; // the single slot (also while the constructor makes it)
    const stage = this.stage();
    return !!scope && !!stage && scope.characterId === stage.characterId && scope.providerScope === stage.providerScope;
  }

  private stageSlot(create: boolean): Slot | null {
    if (this.single) return this.single;
    const stage = this.stage();
    let model: string;
    try { model = this.modelName(this.options.provider?.()?.model ?? ''); } catch { return null; }
    return stage ? this.slot(sessionSlotKey(stage.characterId, stage.providerScope, model), stage, model, create) : null;
  }

  private slot(key: string, scope: { characterId: string; providerScope: string } | null, model: string, create: boolean): Slot | null {
    const found = this.slotMap.get(key);
    if (found || !create || this.disposed) return found ?? null;
    const holder: { slot: Slot | null } = { slot: null };
    const chat = new PersistentClaudeChat(this.slotOptions(() => holder.slot?.onStage ?? false));
    const slot: Slot = { key, characterId: scope?.characterId ?? '', providerScope: scope?.providerScope ?? '', model, chat, lastUsed: ++this.tick,
      onStage: this.onStage(scope), get warm() { return chat.warm; }, get busy() { return chat.busy; } };
    holder.slot = slot;
    this.slotMap.set(key, slot);
    // A new PersistentClaudeChat starts as seen; only what differs is told, so a single slot starts exactly as today's.
    if (!slot.onStage) chat.noteVisible(false, true);
    else { if (!this.visible) chat.noteVisible(false); if (this.held) chat.holdWarm(true); }
    return slot;
  }

  /** A slot's options: what reads "her" (the provider for prewarming, her archive, full-screen) answers only while she is on stage. */
  private slotOptions(onStage: () => boolean): PersistentClaudeOptions {
    const o = this.options;
    return { ...o, enabled: this.enabled,
      provider: () => (onStage() ? o.provider?.() : null),
      ...(!o.turn ? {} : { chattedBefore: () => this.chatted || o.chattedBefore?.() === true, prewarmAlways: true }),
      ...(o.seenElsewhere ? { seenElsewhere: () => onStage() && o.seenElsewhere!() === true } : {}),
      ...(o.openingWindow ? { openingWindow: () => (onStage() ? o.openingWindow!() : null) } : {}),
      ...(o.startOpening ? { startOpening: () => (onStage() ? o.startOpening!() : null) } : {}),
      ...(o.openingMemory ? { openingMemory: () => (onStage() ? o.openingMemory!() : null) } : {}),
      ...(o.onNewProcess ? { onNewProcess: () => { if (onStage()) o.onNewProcess!(); } } : {}) };
  }

  /** The stage moved: the slot that left it is not seen from now on (and gives up a call's hold); the one that came on is seen as the window is. */
  private refreshStage(): void {
    for (const slot of this.slotMap.values()) {
      const on = this.onStage(slot);
      if (on === slot.onStage) continue;
      slot.onStage = on;
      if (on) { if (this.held) slot.chat.holdWarm(true); slot.chat.noteVisible(this.visible, false, 'switch'); }
      else { if (this.held) slot.chat.holdWarm(false); slot.chat.noteVisible(false, true); }
    }
  }

  private enforceCap(keep: Slot): void {
    for (const victim of capVictims([...this.slotMap.values()], keep, this.options.maxWarm ?? SESSION_POOL_KNOBS.maxWarm)) victim.chat.close('cap');
  }

  private remember(replyId: string, slot: Slot): void {
    this.replies.delete(replyId);
    this.replies.set(replyId, slot);
    while (this.replies.size > REMEMBERED_REPLIES) this.replies.delete(this.replies.keys().next().value!);
  }

  private noteDegraded(slot: Slot): void {
    if (this.degraded || this.disposed || !this.enabled || slot.chat.active) return;
    this.degraded = slot;
    for (const other of this.slotMap.values()) if (other !== slot) other.chat.close('degraded');
  }
}
