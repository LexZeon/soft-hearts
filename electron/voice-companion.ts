import { buildCompanionPersona } from './conversation-context';
import { recallLateCheck } from './recall-late-check';
import { MoodReplyProtocol, type MoodAppraisal } from './mood-chat';
import type { OpeningMode } from './reply-opening';
import { asksForEnglish, chatLooksChinese, speakersFromPersona } from './reply-draft-guard';
import type { MemoryStore } from './memory';
import type { MoodHost } from './mood';
import type { UserStateStore } from './user-state';
import type { RelationshipHost } from './relationship/host';
import type { UserStateJudgment } from '../shared/user-state';
import type { MemoryScope, MemoryRecall } from '../shared/memory';
import type { SpeechMood } from './speech-emotion';
import type { VoiceTextLeg, VoiceTextCompletion, VoiceTextSettlement } from './voice-text-continuation';

export interface VoiceCompanionOptions {
  id: string; scope: MemoryScope; recordId: string; persona: string; initialText: string;
  memory: MemoryStore; mood: MoodHost; expressionToken: string;
  /** Her read of how the user is (electron/user-state.ts); optional so a group can run without it. */
  userState?: UserStateStore;
  /** 熟悉度: a finished voice exchange counts as a chat round for the day (electron/relationship/host.ts). */
  relationship?: Pick<RelationshipHost, 'noteRound'>;
  current(): boolean;
  recall(text: string): MemoryRecall[];
  /** MemoryStore.recallRevision: with it, a leg's memories are checked again where its message is written (withCurrentRecall). */
  recallRevision?(): string;
  /** I-046: each leg asks for an opening marker and shows only what follows it (CompanionService.setReplyOpening). */
  opening?: boolean | OpeningMode;
  closed(): void;
}
export interface VoiceCompanionLeg {
  readonly persona: string;
  /** Like CompanionTurn.withCurrentRecall (the late window, Codex T-222 E04): `persona` as it may go out now. */
  withCurrentRecall(persona: string): string;
  push(text: string): void;
  finish(status: 'complete' | 'stopped' | 'error'): Promise<VoiceTextCompletion>;
}

/** One accepted user event/archive and one final appraisal across provider legs.
 * Only the host session chooses the final candidate. No renderer appraisal API. */
export class VoiceCompanionGroup {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly recordId: string;
  private text: string;
  private archive: Promise<void> = Promise.resolve();
  private archiveFailure = false;
  private revoked = false;
  private ended = false;
  private closing?: Promise<void>;
  private active?: VoiceCompanionLeg;
  private candidate?: { replyId: string; throughSeq: number; appraisal: MoodAppraisal; userState: UserStateJudgment | null };
  private completedMood: SpeechMood | null = null;
  /** Reply text archived so far for this utterance (all legs). */
  private archivedReply = 0;
  /**
   * F4: the last leg finished complete and current, but the draft filter removed everything it said. Like an emptied
   * ordinary chat reply (electron/companion.ts) the utterance is a failed reply: archived once as 'error', no appraisal
   * candidate, no reward, nothing read aloud.
   */
  private emptied = false;

  constructor(private readonly options: VoiceCompanionOptions) {
    this.id = options.id; this.scope = { ...options.scope }; this.recordId = options.recordId;
    this.text = options.initialText;
  }
  speechMood(): SpeechMood | null {
    return this.current() && this.completedMood ? { ...this.completedMood } : null;
  }
  /** Called by the real dispatch before a continuation leg, with host canonical text. */
  async extend(text: string): Promise<void> {
    this.assertOpen();
    if (text === this.text) return;
    if (typeof text !== 'string' || text.length > 16000 || !text.startsWith(this.text + '\n'))
      throw Error('Invalid voice continuation original.');
    this.text = text;
    this.enqueue(async () => {
      if (!await this.options.memory.extendOpenUser(this.scope, this.id, text, Date.now()))
        throw Error('Voice archive is no longer open.');
    });
    await this.archive;
    this.assertOpen();
  }
  async beginLeg(leg: VoiceTextLeg, emit: (text: string) => void): Promise<VoiceCompanionLeg> {
    this.assertOpen();
    if (leg.groupId !== this.id || this.active || leg.canonicalUserText !== this.text)
      throw Error('Invalid host voice leg.');
    this.candidate = undefined; this.emptied = false;
    let bodyLength = 0;
    // R33: the previous reply was cut off to merge these sentences; in the one
    // archived reply this leg starts on its own line instead of mid-sentence.
    let separator = leg.merged && this.archivedReply > 0;
    const protocol = new MoodReplyProtocol(text => {
      if (!text || !this.current() || this.ended) return;
      if (bodyLength + text.length > 128000) throw Error('Voice reply exceeds its bound.');
      bodyLength += text.length;
      const archived = separator ? '\n' + text : text;
      separator = false; this.archivedReply += archived.length;
      this.enqueue(async () => {
        if (!await this.options.memory.appendAssistant(this.scope, this.id, archived, Date.now()))
          throw Error('Voice reply archive is no longer open.');
      });
      emit(text);
    }, { speakers: speakersFromPersona(this.options.persona), chineseChat: chatLooksChinese(this.text, this.options.persona), englishAsked: asksForEnglish(this.text),
      ...(this.options.opening ? { opening: this.options.opening, userText: this.text } : {}) });
    const text = this.text, revision = this.options.recallRevision?.(), memories = this.options.recall(text);
    const persona = buildCompanionPersona({ persona: this.options.persona,
      stateContext: this.options.mood.chatContext(), userState: this.options.userState?.chatContext(this.scope.characterId),
      memories,
      protocolInstruction: protocol.instruction() });
    const withCurrentRecall = revision === undefined ? (value: string) => value
      : recallLateCheck({ recalled: memories, revision, currentRevision: () => this.options.recallRevision?.() ?? '', recallNow: () => this.options.recall(text) });
    let finishing: Promise<VoiceTextCompletion> | undefined, closed = false;
    const coveredThrough = leg.throughSeq;
    const turn: VoiceCompanionLeg = { persona, withCurrentRecall,
      push: text => {
        if (closed || !this.current() || this.ended) return;
        protocol.push(text);
      },
      finish: status => {
        if (finishing) return finishing;
        closed = true;
        const valid = status === 'complete' && this.current() && !this.ended;
        const appraisal = protocol.finish(valid);
        // Everything this leg said was an internal draft: decided here, once, while it is still current (a stop, a late
        // finish or a changed context is never turned into a failure afterwards).
        const emptied = valid && protocol.emptiedByFilter();
        if (emptied) this.emptied = true;
        finishing = (async () => {
          try {
            await this.archive;
            if (this.archiveFailure) throw Error('Voice reply could not be archived.');
            if (status === 'complete' && this.current() && !this.ended) {
              // A failed leg, not a completed one: the session never continues it, settles 'partial' (the user's words come
              // back as a draft) and the renderer shows the voice failure line instead of an empty bubble.
              if (emptied) return { status: 'error', coveredThroughSeq: coveredThrough, hasAppraisal: false };
              if (appraisal) this.candidate = { replyId: leg.replyId, throughSeq: coveredThrough, appraisal, userState: protocol.userState() };
              return { status: 'complete', coveredThroughSeq: coveredThrough, hasAppraisal: !!appraisal };
            }
            return { status: status === 'complete' ? 'stopped' : status, coveredThroughSeq: 0, hasAppraisal: false };
          } finally { if (this.active === turn) this.active = undefined; }
        })();
        return finishing;
      },
    };
    this.active = turn;
    return turn;
  }
  settle(value: VoiceTextSettlement): Promise<void> {
    this.assertOpen();
    if (this.active || value.groupId !== this.id || value.canonicalUserText !== this.text)
      throw Error('Voice group is not ready to settle.');
    this.ended = true;
    const candidate = value.status === 'complete' && value.appraisalReplyId === this.candidate?.replyId
      && value.lastSeq === this.candidate?.throughSeq ? this.candidate : undefined;
    this.closing = (async () => {
      try {
        await this.archive;
        // An emptied last leg is archived as one failed reply ('error'), as in ordinary chat; only while still current.
        await this.options.memory.finishTurn(this.scope, this.id, this.archiveFailure ? 'error'
          : !this.current() ? 'stopped' : this.emptied ? 'error' : value.status === 'complete' ? 'complete' : 'stopped', Date.now());
        if (this.archiveFailure) throw Error('Voice archive failed.');
        if (!this.current()) return;
        // Never a reward for an emptied reply, even if a caller settled it as complete.
        const answered = value.status === 'complete' && !this.emptied;
        if (answered) void this.options.relationship?.noteRound(this.scope.characterId);
        if (candidate) {
          this.options.mood.event({ type: 'appraisal', id: `appraisal-${this.id}`, responseTo: this.id,
            ...candidate.appraisal }, this.scope.characterId,
          { expressions: this.options.expressionToken === this.options.mood.get().token });
          this.options.mood.requestChatGesture(this.id, candidate.appraisal, this.options.expressionToken);
          this.options.userState?.note(this.scope.characterId, candidate.userState);
        } else this.options.mood.cancelChatGesture(this.id);
        if (answered) this.completedMood = {
          context: candidate?.appraisal.context ?? 'neutral', primary: this.options.mood.get().snapshot.primary,
          gesture: candidate?.appraisal.gesture ?? 'none',
        };
      } finally { this.candidate = undefined; this.options.closed(); }
    })();
    return this.closing;
  }
  /** Revocation is synchronous, before the first archive await. */
  finish(status: 'complete' | 'stopped' | 'error'): Promise<void> {
    this.revoked = true; this.completedMood = null; this.candidate = undefined;
    this.options.mood.cancelChatGesture(this.id);
    if (this.closing) return this.closing;
    this.ended = true;
    this.closing = (async () => {
      try {
        let failure: unknown;
        try { await this.active?.finish(status === 'error' ? 'error' : 'stopped'); }
        catch (error) { failure = error; }
        await this.archive;
        try { await this.options.memory.finishTurn(this.scope, this.id,
          failure || this.archiveFailure || status === 'error' ? 'error' : 'stopped', Date.now()); }
        catch (error) { failure ??= error; }
        if (failure) throw failure;
        if (this.archiveFailure) throw Error('Voice archive failed.');
      } finally { this.options.closed(); }
    })();
    return this.closing;
  }
  private current(): boolean { return !this.revoked && this.options.current(); }
  private assertOpen(): void {
    if (!this.current() || this.ended || this.archiveFailure) throw Error('Voice group is unavailable.');
  }
  private enqueue(operation: () => Promise<void>): void {
    this.archive = this.archive.then(operation).catch(() => { this.archiveFailure = true; });
  }
}
