import { randomUUID } from 'node:crypto';
import type { AppSettings, ChatMessage } from '../shared/contracts';
import type { LanguageProfile } from '../shared/personalize-language';
import type { VoiceCaptureBinding, VoiceCancelReason } from '../shared/voice-segments';
import type { VoiceInputFailure } from '../shared/speech-failure';
import { voiceUtteranceMessages, type VoiceConversationEvent, type VoiceConversationPayload } from '../shared/voice-conversation';
import type { PersistentClaudeChat } from './claude-session';
import { wavSamples } from './asr/features';
import { memoryProviderScope, type CompanionService } from './companion';
import { buildCodexChatPrompt } from './conversation-context';
import type { MediaOwner } from './runtime';
import type { SpeechMood } from './speech-emotion';
import { validateChatRequest } from './validation';
import type { VoiceCompanionGroup, VoiceCompanionLeg } from './voice-companion';
import { VoiceInputPipeline } from './voice-input-pipeline';
import type { VoiceTextCompletion, VoiceTextLeg } from './voice-text-continuation';

/** Words, as opposed to the punctuation-only text a recognizer returns for noise. */
const HAS_WORDS = /[\p{L}\p{N}]/u;

/** One opened microphone capture: the window, its consent owner and the context it was opened in. */
export interface VoiceAppCapture {
  sender: number; owner: MediaOwner; binding: VoiceCaptureBinding; scope: string; settings: AppSettings; asrFailure?: string;
  /** Why recognition failed for this capture, by closed category (electron/asr/voice-route.ts): both windows say it. */
  asrCategory?: VoiceInputFailure;
}
interface VoiceAppGroup {
  turn: VoiceCompanionGroup; capture: VoiceAppCapture; text: string; replyId: string; allowSpeech: boolean;
  /** The provider window for the next leg: what Claude has been told, sentence by sentence. */
  messages: ChatMessage[];
  /** The chat window this utterance started from. */
  base: ChatMessage[];
  /** Every leg the provider answered (stopped ones included), with the text it showed. */
  answered: { replyId: string; text: string }[];
}

/** What the voice host needs from the app. electron/main.ts wires the real ones; tests pass fakes. */
export interface VoiceChatHostPorts {
  /** Sends one event to every window ('desk:voice-conversation'). */
  broadcast(event: VoiceConversationEvent): void;
  /** The archive changed ('desk:memory-changed'). */
  memoryChanged(): void;
  /** The window with this webContents id exists, is visible and is not minimised. */
  windowVisible(sender: number): boolean;
  media(): { voiceInput: boolean; voiceOwner?: MediaOwner | null };
  /** Withdraws this window's voice-input consent (the host turned it off). */
  turnOffVoiceInput(owner: MediaOwner): void;
  speechScope(): string;
  settings(): AppSettings;
  companion(): Pick<CompanionService, 'beginVoiceGroup'>;
  ambient(): { acceptUserTurn(id: string, text: string): Promise<void> | void } | null | undefined;
  /** Takes the single chat slot for this reply; false while another chat reply is still running. */
  reserveChat(replyId: string, controller: AbortController, owner: number): boolean;
  releaseChat(replyId: string): void;
  /** A human voice turn was accepted: older command choices are void; activity changed. */
  userTurn(): void;
  activityChanged(): void;
  /** Proactive speech yields to the user. */
  cancelProactive(): void;
  /** The conversation-scoped Claude chat (electron/claude-session.ts). */
  claude: Pick<PersistentClaudeChat, 'stream'> & Partial<Pick<PersistentClaudeChat, 'regroup'>>;
  languageProfile(): LanguageProfile | null | undefined;
  chatDirectory(): string;
  tempDirectory(): string;
  /** The shared foreground recognizer (microphone audio only). */
  transcribe(owner: MediaOwner, wav: ArrayBuffer, signal: AbortSignal, current: () => boolean): Promise<string>;
  /** A clip came back with no words (journal note; the windows are told by an 'unheard' event). `peakDb`: its loudest level. */
  unheard?(failure: 'empty', peakDb?: number): void;
  /**
   * Stops any reading aloud now. 'sentence': the microphone is being opened — the sentence she is reading
   * finishes and the rest is not read; its bubbles still show.
   */
  stopReading(mode?: 'sentence'): void;
  /** Freezes the reading voice for a settled utterance's final reply, just before its 'speech' event. */
  prepareSpeech(capture: VoiceAppCapture, replyId: string, mood: SpeechMood): void;
}

/** The fault event for a capture: only a recognizer failure carries its sanitized, capture-bound diagnostic. */
export function voiceFaultEvent(capture: Pick<VoiceAppCapture, 'asrFailure' | 'asrCategory'>, stage: string): Extract<VoiceConversationPayload, { type: 'fault' }> {
  return { type: 'fault', ...(stage === 'asr-failed' && capture.asrFailure ? { message: capture.asrFailure } : {}),
    ...(stage === 'asr-failed' && capture.asrCategory ? { failure: capture.asrCategory } : {}) };
}

/**
 * R33: the earlier
 * sentences are the user's own words. A different addition is the user changing
 * their mind (never her mishearing); the same content again is not a correction.
 */
const additionGuidance = '前文是用户的原话。补充和前文不一样时，是用户改了主意或说得更具体了，就按补充来，不要说成是你听错、记错或理解错了；'
  + '补充和前文内容相同、只是重复或接着往下说，就当同一件事，不要当成纠正或改口。';
export const voiceContinuationNote = (prior: string) => `\n以下是同一段发言中已处理的前文，仅作上下文，不是另一条新输入：\n${prior}\n本次是用户对这段发言的继续补充。${additionGuidance}`;
/** R33: the previous reply was stopped so these sentences could be merged in. */
export const voiceMergedNote = (prior: string) => `\n以下是同一段发言中你已经收到的前文，仅作上下文，不是另一条新输入：\n${prior}\n`
  + '你上一条回复还没说完就停下了，因为用户在同一段话里接着说了下面的补充。已经显示出来的部分用户看到了，不要假装没说过，也不要从头重复；把补充和前文合起来理解，自然地接着回应。'
  + additionGuidance;

/**
 * R33 continuous voice on the Claude build: the microphone capture scope, the
 * per-sentence dispatch over the conversation-scoped Claude process, merging an
 * addition into a reply that is still being generated, and the one archive /
 * appraisal / reading per utterance. Moved out of electron/main.ts so it can be
 * tested by import.
 *
 * Merging: Claude Code never folds a message written mid-turn into that turn
 * (2.1.316 queues it as a whole new turn; docs/claude/2026-11-02-R33-continuous-voice.md).
 * So when more of the utterance arrives while a reply is being generated, the
 * reply is stopped with Claude Code's own interrupt (ClaudeChatProcess.supersede):
 * what it already showed stays on screen, in the archive and in Claude's context,
 * nothing of it is read aloud, and only the new sentences go out as the next turn
 * on the same warm process. A reply that had already finished gets an explicit
 * continuation instead. Either way each sentence is sent once and the utterance
 * is archived and rewarded once, from its final reply.
 */
export class VoiceChatHost {
  readonly pipeline: VoiceInputPipeline;
  /** The last completed chat window (text or voice) for its scope/provider; a new utterance starts from it. */
  history: { scope: string; providerScope: string; messages: ChatMessage[] } | null = null;
  private captureValue: VoiceAppCapture | undefined;
  private readonly groups = new Map<string, VoiceAppGroup>();
  private readonly drafts = new Map<string, { capture: VoiceAppCapture; text: string }>();
  private readonly merges = new Map<string, { capture: VoiceAppCapture; supersede: () => boolean }>();
  private effects: Promise<void> = Promise.resolve();
  /** Inside open(): a reading stop requested now lets the current sentence finish. */
  private opening = false;

  constructor(private readonly ports: VoiceChatHostPorts) {
    this.pipeline = new VoiceInputPipeline({
      transcribe: (wav, signal) => {
        const capture = this.captureValue;
        if (!capture || !this.current(capture)) return Promise.reject(Error('语音输入已停止。'));
        return ports.transcribe(capture.owner, wav, signal, () => this.current(capture)).then(text => {
          // a clip that came back with no words used to vanish here. Say so (the capture stays open) and note it.
          if (HAS_WORDS.test(text) || !this.current(capture) || signal.aborted) return text;
          let peakDb: number | undefined;
          try { let peak = 0; for (const sample of wavSamples(wav)) peak = Math.max(peak, Math.abs(sample)); peakDb = peak > 0 ? 20 * Math.log10(peak) : -120; } catch { /* the note goes without a level */ }
          try { ports.unheard?.('empty', peakDb); } catch { /* a note never changes voice input */ }
          this.event(capture, { type: 'unheard', failure: 'empty' });
          return '';
        });
      },
      dispatch: (leg, signal, emit) => this.dispatch(leg, signal, emit),
      merge: leg => this.merge(leg),
      progress: value => {
        const capture = this.captureValue;
        if (capture && capture.binding.epoch === value.epoch && this.current(capture)) this.event(capture,
          { type: 'continuation', groupId: value.groupId, replyId: value.replyId, state: value.state });
        return undefined;
      },
      userRow: value => {
        const capture = this.captureValue;
        if (capture && value.epoch === capture.binding.epoch && this.current(capture)) {
          if (!this.drafts.has(value.groupId) && this.drafts.size >= 4) throw Error('语音原文缓冲已满。');
          this.drafts.set(value.groupId, { capture, text: value.canonicalUserText });
          this.event(capture, { type: 'row', groupId: value.groupId, seq: value.seq, text: value.canonicalUserText });
        }
        return undefined;
      },
      reply: value => {
        const capture = this.captureValue;
        if (value.type === 'terminal') {
          const group = this.groups.get(value.groupId);
          if (group?.replyId === value.replyId) group.allowSpeech = value.allowSpeech;
        }
        if (capture && value.epoch === capture.binding.epoch && this.current(capture)) this.event(capture,
          value.type === 'delta' ? { type: 'delta', groupId: value.groupId, replyId: value.replyId, text: value.text }
            : { type: 'terminal', groupId: value.groupId, replyId: value.replyId,
                complete: value.completion.status === 'complete', superseded: value.completion.status === 'superseded' });
        return undefined;
      },
      settlement: value => {
        const group = this.groups.get(value.groupId);
        if (!group || group.capture.binding.epoch !== value.epoch) return undefined;
        // How the chat shows this utterance from now on (renderer and session alike).
        const shown = voiceUtteranceMessages(value.canonicalUserText, group.answered.map(leg => leg.text));
        // The Claude session heard it sentence by sentence; regroup its record now, before the next message can
        // arrive, so that message stays on the warm process. Only a complete utterance: after a partial one the
        // chat shows sentences Claude never received, and the next message must open a fresh session instead.
        if (value.status === 'complete' && this.current(group.capture))
          try { ports.claude.regroup?.(group.answered.map(leg => leg.replyId), shown); } catch { /* Then it simply reopens. */ }
        const effect = group.turn.extend(value.canonicalUserText).then(() => group.turn.settle(value)).then(() => {
          if (!this.current(group.capture)) return;
          this.event(group.capture, { type: 'continuation', groupId: value.groupId, replyId: group.replyId,
            state: value.status === 'complete' ? 'settled' : 'partial' });
          if (value.status === 'partial') this.event(group.capture, { type: 'draft', groupId: value.groupId, text: value.canonicalUserText });
          if (value.status === 'complete') this.history = { scope: group.capture.scope,
            providerScope: memoryProviderScope(group.capture.settings.provider), messages: [...group.base, ...shown] };
          const mood = group.turn.speechMood();
          if (value.status === 'complete' && group.allowSpeech && mood
            && (value.appraisalReplyId === null || group.replyId === value.appraisalReplyId) && group.text.trim()) {
            ports.prepareSpeech(group.capture, group.replyId, mood);
            this.event(group.capture, { type: 'speech', groupId: value.groupId, replyId: group.replyId, text: group.text });
          }
        }).then(() => { this.drafts.delete(value.groupId); }).finally(() => {
          if (this.groups.get(value.groupId) === group) this.groups.delete(value.groupId);
          ports.memoryChanged();
        });
        this.track(group.capture, effect);
        return undefined;
      },
      stopTts: () => {
        for (const group of this.groups.values()) group.allowSpeech = false;
        ports.stopReading(this.opening ? 'sentence' : undefined);
        return undefined;
      },
      cancelled: value => {
        const draft = this.drafts.get(value.groupId);
        const group = this.groups.get(value.groupId);
        if (group) this.track(group.capture, group.turn.finish('stopped').finally(() => {
          if (this.groups.get(value.groupId) === group) this.groups.delete(value.groupId);
        }));
        if (draft) {
          this.drafts.delete(value.groupId);
          this.event(draft.capture, { type: 'draft', groupId: value.groupId, text: draft.text });
        }
        if (group) this.event(group.capture, { type: 'cancelled', groupId: value.groupId, replyId: value.activeReplyId });
        return undefined;
      },
      rejectedDraft: value => {
        if (this.captureValue) this.event(this.captureValue, { type: 'draft', groupId: value.groupId, text: value.text });
        return undefined;
      },
      fault: value => {
        const capture = this.captureValue;
        if (capture) this.event(capture, voiceFaultEvent(capture, value.stage));
        return undefined;
      },
    });
  }

  get capture(): VoiceAppCapture | undefined { return this.captureValue; }
  /** An utterance's archive or settlement work is still open. */
  get busy(): boolean { return this.groups.size > 0; }

  current(capture: VoiceAppCapture): boolean {
    try {
      const media = this.ports.media(), settings = this.ports.settings();
      return this.captureValue === capture && this.ports.windowVisible(capture.sender)
        && media.voiceInput && media.voiceOwner === capture.owner
        && this.ports.speechScope() === capture.scope && JSON.stringify(settings.provider) === JSON.stringify(capture.settings.provider)
        && JSON.stringify(settings.voiceInput) === JSON.stringify(capture.settings.voiceInput);
    } catch { return false; }
  }

  /** Opens a fresh capture scope for this window (the caller checked consent and that no chat reply is running). */
  open(sender: number, owner: MediaOwner): VoiceCaptureBinding {
    // Opening the microphone ends the reading after the sentence being read, never mid-sentence.
    let binding: VoiceCaptureBinding;
    this.opening = true;
    try {
      this.revoke('scope-change', true);
      this.effects = this.effects.catch(() => {}); // Preserve actual prior release before a new dispatch.
      binding = this.pipeline.open(sender, randomUUID());
    } finally { this.opening = false; }
    const capture: VoiceAppCapture = { sender, owner, binding, scope: this.ports.speechScope(), settings: structuredClone(this.ports.settings()) };
    this.captureValue = capture;
    if (!this.current(capture)) { this.revoke('hide'); throw Error('语音窗口当前不可用。'); }
    return { ...binding };
  }

  revoke(reason: VoiceCancelReason, preserveConsent = false): void {
    const capture = this.captureValue;
    if (!capture) return;
    try { this.pipeline.cancel(capture.sender, capture.binding.captureSessionId, reason); }
    finally {
      if (this.captureValue === capture) this.captureValue = undefined;
      try { this.event(capture, { type: 'revoked' }); }
      finally {
        const media = this.ports.media();
        if (!preserveConsent && media.voiceInput && media.voiceOwner === capture.owner) this.ports.turnOffVoiceInput(capture.owner);
      }
    }
  }

  /** Resolves when accepted archive / settlement effects have finished (teardown, tests). */
  drain(): Promise<void> { return this.effects.then(() => {}, () => {}); }

  dispose(): void {
    try { this.revoke('teardown'); }
    finally { this.pipeline.dispose(); }
  }

  private event(capture: VoiceAppCapture, event: VoiceConversationPayload): void {
    this.ports.broadcast({ ...event, epoch: capture.binding.epoch, owner: capture.owner } as VoiceConversationEvent);
  }

  private track(capture: VoiceAppCapture, effect: Promise<void>): void {
    this.effects = Promise.all([this.effects, effect]).then(() => {});
    void this.effects.catch(() => {
      if (this.current(capture)) {
        try {
          for (const [groupId, draft] of this.drafts) if (draft.capture === capture) this.event(capture, { type: 'draft', groupId, text: draft.text });
          this.event(capture, { type: 'fault' });
        } finally { this.revoke('stop-generation'); }
      }
    }).catch(() => {}); // A closed renderer cannot turn cleanup notification into an unhandled rejection.
  }

  /** The session asks to merge more sentences into this leg's reply: stop it early (one request per leg). */
  private merge(leg: VoiceTextLeg): boolean {
    const entry = this.merges.get(leg.replyId);
    if (!entry || !this.current(entry.capture)) return false;
    try { return entry.supersede(); } catch { return false; }
  }

  private async dispatch(leg: VoiceTextLeg, signal: AbortSignal, emit: (text: string) => void): Promise<VoiceTextCompletion> {
    const capture = this.captureValue;
    if (!capture || leg.epoch !== capture.binding.epoch || !this.current(capture)) throw Error('语音上下文已改变。');
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    let reserved = false;
    let group = this.groups.get(leg.groupId), turn: VoiceCompanionLeg | undefined;
    try {
      await this.effects;
      signal.throwIfAborted(); if (!this.current(capture)) throw Error('语音上下文已改变。');
      if (!this.ports.reserveChat(leg.replyId, controller, capture.sender)) throw Error('上一轮回复尚未结束。');
      reserved = true;
      this.ports.userTurn(); // A new accepted human voice turn supersedes older text choices.
      if (!group) {
        const created = await this.ports.companion().beginVoiceGroup(leg.groupId, leg.canonicalUserText, capture.settings.persona);
        if (controller.signal.aborted || !this.current(capture)) { await created.finish('stopped'); throw Error('语音上下文已改变。'); }
        const history = this.history;
        const messages = history?.scope === capture.scope && history.providerScope === memoryProviderScope(capture.settings.provider)
          ? structuredClone(history.messages) : [];
        group = { turn: created, capture, text: '', replyId: leg.replyId, allowSpeech: false, messages,
          base: structuredClone(messages), answered: [] };
        this.groups.set(leg.groupId, group);
        await this.ports.ambient()?.acceptUserTurn(leg.groupId, leg.canonicalUserText);
        if (!this.current(capture)) throw Error('语音上下文已改变。');
      } else await group.turn.extend(leg.canonicalUserText);
      controller.signal.throwIfAborted(); if (!this.current(capture)) throw Error('语音上下文已改变。');
      this.ports.cancelProactive();
      const active = group;
      turn = await active.turn.beginLeg(leg, text => { active.text += text; emit(text); });
      controller.signal.throwIfAborted(); if (!this.current(capture)) throw Error('语音上下文已改变。');
      active.text = ''; active.replyId = leg.replyId; active.allowSpeech = false;
      this.event(capture, { type: 'start', groupId: leg.groupId, replyId: leg.replyId });
      const persona = turn.persona + (leg.priorUserText ? (leg.merged ? voiceMergedNote : voiceContinuationNote)(leg.priorUserText) : '');
      const request = validateChatRequest({ id: leg.replyId,
        messages: [...active.messages, { role: 'user', content: leg.inputText }], attachments: [] });
      this.event(capture, { type: 'continuation', groupId: leg.groupId, replyId: leg.replyId,
        state: leg.merged ? 'merged' : leg.kind === 'continuation' ? 'continuation' : 'request' });
      const language = this.ports.languageProfile(), live = turn;
      const outcome = await this.ports.claude.stream({
        kind: 'chat', model: capture.settings.provider.model, workingDirectory: this.ports.chatDirectory(), writable: false,
        // Read where the message is written: a note deleted while it waited for the process is not in it (Codex T-222 E04).
        get prompt() { return buildCodexChatPrompt(live.withCurrentRecall(persona), request.messages, undefined, language); }, imageDataUrls: [],
        imageTemporaryRoot: this.ports.tempDirectory(), replyId: leg.replyId,
        // Same key and fixed persona as ordinary chat, so voice continues the warm conversation process. What this leg showed
        // (kept below once it has finished) is what the session records of its reply, so a cut draft does not reopen it.
        session: { key: capture.scope, basePersona: capture.settings.persona, get persona() { return live.withCurrentRecall(persona); }, messages: request.messages, language,
          shown: () => active.answered.find(answer => answer.replyId === leg.replyId)?.text ?? null },
      }, controller.signal, (type, text) => { if (type === 'delta') live.push(text); }, {
        started: supersede => {
          if (controller.signal.aborted || !this.current(capture)) return;
          this.merges.set(leg.replyId, { capture, supersede });
          this.pipeline.turnReady(leg.replyId);
        },
      });
      this.merges.delete(leg.replyId);
      controller.signal.throwIfAborted(); if (!this.current(capture)) throw Error('语音上下文已改变。');
      const before = request.messages.slice(0, -1), user: ChatMessage = { role: 'user', content: leg.inputText };
      if (outcome.superseded) {
        // Stopped to merge the next sentences: what it showed stays (archive and
        // Claude's context alike); no appraisal, nothing is read aloud.
        await turn.finish('stopped');
        active.answered.push({ replyId: leg.replyId, text: active.text }); // After finish: held text is flushed.
        active.messages = [...before, user, ...(outcome.output ? [{ role: 'assistant' as const, content: active.text }] : [])];
        return { status: 'superseded', coveredThroughSeq: leg.throughSeq, hasAppraisal: false };
      }
      const completion = await turn.finish('complete');
      active.answered.push({ replyId: leg.replyId, text: active.text });
      active.messages = [...before, user, { role: 'assistant', content: active.text }];
      return completion;
    } catch {
      try { if (turn) await turn.finish(controller.signal.aborted ? 'stopped' : 'error'); }
      finally {
        if (this.current(capture)) {
          const draft = this.drafts.get(leg.groupId);
          this.event(capture, { type: 'draft', groupId: leg.groupId, text: draft?.text ?? leg.canonicalUserText });
          this.event(capture, { type: 'fault' });
          queueMicrotask(() => { if (this.captureValue === capture) this.revoke('stop-generation'); });
        }
      }
      return { status: controller.signal.aborted ? 'stopped' : 'error', coveredThroughSeq: 0, hasAppraisal: false };
    } finally {
      signal.removeEventListener('abort', abort);
      this.merges.delete(leg.replyId);
      if (reserved) this.ports.releaseChat(leg.replyId); // The real provider/archive promise has settled.
      this.ports.activityChanged();
    }
  }
}
