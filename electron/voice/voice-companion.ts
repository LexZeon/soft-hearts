import { buildCompanionPersona } from '../brain';
import type { CardLanguage } from '../../shared/foundation/character-card';
import { RHYTHM_LINE, i139Text } from '../../shared/brain';
import { recallLateCheck } from '../memory';
import { MoodReplyProtocol } from '../mood/mood-chat';
import type { MoodAppraisal, SettingProposalOption } from '../mood';
import type { OpeningMode } from '../brain';
import { asksForEnglish, chatLooksChinese, speakersFromPersona } from '../brain';
import type { MemoryStore } from '../memory';
import type { MoodHost } from '../mood';
import type { UserStateStore } from '../senses';
import type { RelationshipHost } from '../memory';
import type { UserStateJudgment } from '../../shared/senses';
import type { MemoryScope, MemoryRecall } from '../../shared/memory';
import type { SpeechMood } from '../mood';
import type { VoiceTextLeg, VoiceTextCompletion, VoiceTextSettlement } from './voice-text-continuation';

export interface VoiceCompanionOptions {
  id: string; scope: MemoryScope; recordId: string; persona: string; initialText: string;
  memory: MemoryStore; mood: MoodHost; expressionToken: string;
  /** Her read of how the user is (electron/senses/user-state.ts); optional so a group can run without it. */
  userState?: UserStateStore;
  /** 熟悉度: a finished voice exchange counts as a chat round for the day (electron/memory/relationship/host.ts). */
  relationship?: Pick<RelationshipHost, 'noteRound'>;
  current(): boolean;
  recall(text: string): MemoryRecall[];
  /** MemoryStore.recallRevision: with it, a leg's memories are checked again where its message is written (withCurrentRecall). */
  recallRevision?(): string;
  /** I-046: each leg asks for an opening marker and shows only what follows it (CompanionService.setReplyOpening). */
  opening?: boolean | OpeningMode;
  closed(): void;
  /** I-071: her language now (default Chinese): English mode is not "an English reply in a Chinese chat" to the draft guard. */
  language?(): CardLanguage;
  /** I-139 (the switch, read by CompanionService when the group starts): the light mood line and the rhythm sentence, as in typed chat. */
  relaxed?: boolean;
}
export interface VoiceCompanionLeg {
  readonly persona: string;
  /** Where this leg's text starts in the one archived reply of its utterance (what earlier legs archived, and the line break a merged leg begins with). */
  readonly base: number;
  /** Like CompanionTurn.withCurrentRecall (the late window, Codex T-222 E04): `persona` as it may go out now. */
  withCurrentRecall(persona: string): string;
  push(text: string): void;
  /** The private setting block of this leg (after a complete finish), for the call card; null when none. */
  settingProposal(): string | null;
  /**
   * I-197: drops what this leg wrote while its archive was held (her voice had not started) and returns how many characters that
   * was. Nothing of it is ever archived; later text of this leg is not archived either.
   */
  discard(): number;
  /** I-197: her voice started (or the wait ended): what this leg held back is archived now, in order. No-op after `discard`. */
  commit(): void;
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
   * ordinary chat reply (electron/brain/companion.ts) the utterance is a failed reply: archived once as 'error', no appraisal
   * candidate, no reward, nothing read aloud.
   */
  private emptied = false;
  /** I-197: the newest leg's "archive what you held back" (VoiceCompanionLeg.commit); settling or ending the group runs it last. */
  private commitHeld: (() => void) | null = null;

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
  /**
   * `extra.holdArchive` (I-197, a call): while it answers true (her voice has not started for this leg), what the leg writes is shown
   * but kept back from the archive; it is written in order as soon as it answers false or the leg finishes, unless `discard` dropped it.
   */
  async beginLeg(leg: VoiceTextLeg, emit: (text: string) => void, extra: { settingProposal?: SettingProposalOption; holdArchive?: () => boolean } = {}): Promise<VoiceCompanionLeg> {
    this.assertOpen();
    if (leg.groupId !== this.id || this.active || leg.canonicalUserText !== this.text)
      throw Error('Invalid host voice leg.');
    this.candidate = undefined; this.emptied = false;
    let bodyLength = 0;
    // R33: the previous reply was cut off to merge these sentences; in the one
    // archived reply this leg starts on its own line instead of mid-sentence.
    let separator = leg.merged && this.archivedReply > 0;
    const base = this.archivedReply + (separator ? 1 : 0);
    let held: string[] = [], discarded = false;
    const write = (archived: string) => {
      this.archivedReply += archived.length;
      this.enqueue(async () => {
        if (!await this.options.memory.appendAssistant(this.scope, this.id, archived, Date.now()))
          throw Error('Voice reply archive is no longer open.');
      });
    };
    const release = () => { const out = held; held = []; for (const archived of out) write(archived); };
    const commit = () => { if (!discarded) release(); };
    this.commitHeld = commit;
    const holding = () => { try { return extra.holdArchive?.() === true; } catch { return false; } };
    const protocol = new MoodReplyProtocol(text => {
      if (!text || !this.current() || this.ended || discarded) return; // I-197: a dropped leg says nothing more, anywhere
      if (bodyLength + text.length > 128000) throw Error('Voice reply exceeds its bound.');
      bodyLength += text.length;
      const archived = separator ? '\n' + text : text;
      separator = false;
      if (holding()) held.push(archived); else { release(); write(archived); }
      emit(text);
    }, { speakers: speakersFromPersona(this.options.persona), chineseChat: chatLooksChinese(this.text, this.options.persona, this.options.language?.()), englishAsked: asksForEnglish(this.text, this.options.language?.()),
      ...(extra.settingProposal ? { settingProposal: extra.settingProposal } : {}),
      ...(this.options.opening ? { opening: this.options.opening, userText: this.text } : {}) });
    const text = this.text, revision = this.options.recallRevision?.(), memories = this.options.recall(text);
    const relaxed = this.options.relaxed === true ? { language: this.options.language?.() ?? null } : null;
    const persona = buildCompanionPersona({ persona: this.options.persona,
      stateContext: relaxed ? this.options.mood.chatContext({ relaxed: true, language: relaxed.language }) : this.options.mood.chatContext(), userState: this.options.userState?.chatContext(this.scope.characterId),
      memories,
      protocolInstruction: protocol.instruction(), ...(relaxed ? { replyInstruction: i139Text(RHYTHM_LINE, relaxed.language) } : {}) });
    const withCurrentRecall = revision === undefined ? (value: string) => value
      : recallLateCheck({ recalled: memories, revision, currentRevision: () => this.options.recallRevision?.() ?? '', recallNow: () => this.options.recall(text) });
    let finishing: Promise<VoiceTextCompletion> | undefined, closed = false;
    const coveredThrough = leg.throughSeq;
    const turn: VoiceCompanionLeg = { persona, withCurrentRecall, base,
      settingProposal: () => protocol.settingProposal(),
      push: text => {
        if (closed || !this.current() || this.ended) return;
        protocol.push(text);
      },
      discard: () => { discarded = true; const chars = held.reduce((sum, text) => sum + text.length, 0); held = []; return chars; },
      commit,
      finish: status => {
        if (finishing) { commit(); return finishing; } // a second finish (the host's stop or error after waiting): nothing stays held
        closed = true;
        const valid = status === 'complete' && this.current() && !this.ended && !discarded;
        const appraisal = protocol.finish(valid);
        // I-197: what was held for her voice is archived now, in order (a stop keeps it, as before); a complete leg still waiting for
        // her voice keeps it until the host commits or discards it (the group commits it at the latest when it settles or ends).
        if (status !== 'complete' || !holding()) commit();
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
    this.commitHeld?.(); // I-197: nothing a kept reply wrote stays out of the archive
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
        this.commitHeld?.(); // I-197: a stopped utterance keeps what it showed, as before
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
