import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '../../shared/foundation/chat';
import type { MemoryScope } from '../../shared/memory';
import { shiftCut, type CutRecord } from '../../shared/foundation/reply-cut';
import type { VoiceCaptureBinding, VoiceCancelReason } from '../../shared/voice/voice-segments';
import { turnTone, userToneLine } from '../../shared/senses/user-tone';
import type { UserTone } from '../../shared/senses';
import { voiceUtteranceMessages, type VoiceConversationEvent, type VoiceConversationPayload } from '../../shared/voice/voice-conversation';
import { wavSamples } from '../senses';
import { memoryProviderScope } from '../foundation/memory-provider-scope';
import { buildCodexChatPrompt } from '../brain';
import type { MediaOwner } from '../../shared/foundation/runtime-state';
import { validateChatRequest } from '../settings';
import type { CallOfferTurn } from './call-offers';
import type { RelaxedChat } from '../brain';
import type { VoiceCompanionGroup, VoiceCompanionLeg } from './voice-companion';
import { VoiceInputPipeline } from './voice-input-pipeline';
import { gateClip } from './utterance-gate';
import type { VoiceTextCompletion, VoiceTextLeg } from './voice-text-continuation';
import { CallBeats } from './voice-call/beats'; // 边说边演: her markers never reach a spoken leg; in a call the beats are played too
import { voiceAddOnNote, voiceContinuationNote, voiceMergedNote } from './voice-notes';
import type { VoiceAppCapture, VoiceChatHostPorts, VoiceSegmentLook } from './voice-chat-host-ports';
import { handoverVerdict } from './speech-handover'; // 2026-11-24: a reply not handed to her voice says why
export type { VoiceAppCapture, VoiceChatHostPorts, VoiceSegmentLook }; // the ports moved to ./voice-chat-host-ports.ts (size limit)

/** Words, as opposed to the punctuation-only text a recognizer returns for noise. */
const HAS_WORDS = /[\p{L}\p{N}]/u;
interface VoiceAppGroup {
  turn: VoiceCompanionGroup; capture: VoiceAppCapture; text: string; replyId: string; allowSpeech: boolean;
  /** The provider window for the next leg: what Claude has been told, sentence by sentence. */
  messages: ChatMessage[];
  /** The chat window this utterance started from. */
  base: ChatMessage[];
  /** Every leg the provider answered (stopped ones included), with the text it showed. */
  answered: { replyId: string; text: string }[];
  /** I-134: the window came from her archive (longChatHistory), so it is not cut to the renderer's 24 messages. */
  long?: boolean;
  /** I-197: the last leg was dropped for an add-on; the next one carries the add-on line instead of R33's merge line. */
  addOn?: boolean;
}


/** The fault event for a capture: only a recognizer failure carries its sanitized, capture-bound diagnostic. */
export function voiceFaultEvent(capture: Pick<VoiceAppCapture, 'asrFailure' | 'asrCategory'>, stage: string): Extract<VoiceConversationPayload, { type: 'fault' }> {
  return { type: 'fault', ...(stage === 'asr-failed' && capture.asrFailure ? { message: capture.asrFailure } : {}),
    ...(stage === 'asr-failed' && capture.asrCategory ? { failure: capture.asrCategory } : {}) };
}

export { voiceContinuationNote, voiceMergedNote }; // R33's lines (and I-197's add-on line) live in ./voice-notes.ts

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
  /** Replies read while they streamed (a call): their settlement sends no whole-reply 'speech' event. */
  private readonly streamed = new Set<string>();
  /** I-197: replies dropped for an add-on before her voice started (never read, kept on screen or archived). */
  private readonly dropped = new Set<string>();
  /** Each leg's place in the archive (its utterance's scope and turn, and where its text starts in the one archived reply): for the cut record. */
  private readonly cutPlaces = new Map<string, { scope: MemoryScope; turnId: string; base: number }>();
  /** Inside open(): a reading stop requested now lets the current sentence finish. */
  private opening = false;
  /** I-100: the closed tones of the clips recognized since the last voice turn was sent (null: neutral / unknown). */
  private tones: (UserTone | null)[] = [];

  constructor(private readonly ports: VoiceChatHostPorts) {
    this.pipeline = new VoiceInputPipeline({
      transcribe: (wav, signal) => {
        const capture = this.captureValue;
        if (!capture || !this.current(capture)) return Promise.reject(Error('语音输入已停止。'));
        const screened = ports.screen ? ports.screen(capture.owner, wav).catch(() => 'pass' as const) : Promise.resolve('pass' as const);
        const recognized = screened.then(verdict => verdict !== 'pass' ? '' : ports.transcribe(capture.owner, wav, signal, () => this.current(capture)).then(async heard => {
          // Unbound v1 step 3: listening for her name (no call on): words without it are dropped here, before anything shows them.
          // (A clip with no words is dropped quietly too: no "在听但不出字" note while she only listens for her name.)
          if (ports.wake && !await ports.wake(capture.owner, heard).catch(() => false)) return '';
          const text = heard;
          // only a clear sentence (or a stop command) interrupts her; fillers, fragments and noise heard as "嗯" are held.
          if (ports.gate && HAS_WORDS.test(text) && this.current(capture) && !signal.aborted && !gateClip(ports.gate, capture.owner, text, wav).pass) { this.event(capture, { type: 'held' }); return ''; } // I-177 batch 2: the window's duck lets her go on
          if (HAS_WORDS.test(text) && this.current(capture) && !signal.aborted) {
            // I-100: this clip's tone (closed value) waits for the voice turn that carries it.
            let tone: UserTone | null = null;
            try { tone = ports.toneOf?.(wav) ?? null; } catch { tone = null; }
            this.tones.push(tone); if (this.tones.length > 16) this.tones.shift();
          }
          // a clip that came back with no words used to vanish here. Say so (the capture stays open) and note it.
          if (HAS_WORDS.test(text) || !this.current(capture) || signal.aborted) return text;
          let peakDb: number | undefined;
          try { let peak = 0; for (const sample of wavSamples(wav)) peak = Math.max(peak, Math.abs(sample)); peakDb = peak > 0 ? 20 * Math.log10(peak) : -120; } catch { /* the note goes without a level */ }
          try { ports.unheard?.('empty', peakDb); } catch { /* a note never changes voice input */ }
          this.event(capture, { type: 'unheard', failure: 'empty' });
          return '';
        }));
        // I-197: speech that began before her voice but came to no line (noise, held, refused, failed) no longer keeps the add-on window open.
        const settle = () => { try { this.ports.addOn?.settled(); } catch { /* the window's own wait ends it */ } };
        return recognized.then(text => { if (!HAS_WORDS.test(text)) settle(); return text; }, error => { settle(); throw error; });
      },
      dispatch: (leg, signal, emit) => this.dispatch(leg, signal, emit),
      merge: leg => this.merge(leg),
      addOn: leg => { const capture = this.merges.get(leg.replyId)?.capture ?? this.captureValue; return !!capture && this.current(capture) && this.ports.addOn?.heard(leg.replyId) === true; },
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
                complete: value.completion.status === 'complete', superseded: value.completion.status === 'superseded',
                ...(this.dropped.has(value.replyId) ? { dropped: true } : {}) }); // I-197: never voiced, so it is not kept on screen
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
          if (this.streamed.has(group.replyId)) {
            // Read as it streamed (a call): refine the voice's mood for what is not synthesized yet; no second, whole reading.
            if (value.status === 'complete' && mood) try { ports.callSpeech?.refine?.(group.capture, group.replyId, mood); } catch { /* voice only */ }
          } else {
            // 2026-11-24 12:26: a reply that is not handed to her voice says why (the reading journal), instead of just not being read.
            const verdict = handoverVerdict({ status: value.status, allowSpeech: group.allowSpeech, mood, appraisalReplyId: value.appraisalReplyId, replyId: group.replyId, text: group.text });
            if (verdict === 'hand') {
              ports.prepareSpeech(group.capture, group.replyId, mood!);
              try { ports.reading?.expect(group.replyId); } catch { /* journal only */ }
              this.event(group.capture, { type: 'speech', groupId: value.groupId, replyId: group.replyId, text: group.text });
            } else if (verdict) try { ports.reading?.notHanded(verdict); } catch { /* journal only */ }
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
        // 2026-11-19 (the interruption rule that only a clear, complete sentence interrupts, for voice input too; it replaces the 11-03
        // finish-the-sentence rule): opening the microphone no longer touches her reading. A recognized clear sentence or stop command does
        // (accepted words → this stop, outside opening; fillers, fragments and her echo are held by the gate before that).
        if (!this.opening) ports.stopReading();
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

  /**
   * The user's voice cut reading `replyId` (electron/voice/voice-call/host.ts onCut; `cut`'s offsets are into that leg's text): filed beside the
   * archived reply (one record, offsets moved to the utterance's whole reply). Metadata only: the reply was and is archived once, whole.
   */
  fileCut(replyId: string, cut: CutRecord): void {
    const place = this.cutPlaces.get(replyId);
    if (!place) return;
    try { this.ports.cut?.(place.scope, place.turnId, shiftCut(cut, place.base)); } catch { /* a marker only */ }
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
    // Opening the microphone leaves her reading alone; only a clear sentence or stop command stops it.
    let binding: VoiceCaptureBinding;
    this.opening = true;
    try {
      this.revoke('scope-change', true);
      this.effects = this.effects.catch(() => {}); // Preserve actual prior release before a new dispatch.
      binding = this.pipeline.open(sender, randomUUID());
    } finally { this.opening = false; }
    const capture: VoiceAppCapture = { sender, owner, binding, scope: this.ports.speechScope(), settings: structuredClone(this.ports.settings()) };
    this.captureValue = capture; this.tones = [];
    if (!this.current(capture)) { this.revoke('hide'); throw Error('语音窗口当前不可用。'); }
    return { ...binding };
  }

  revoke(reason: VoiceCancelReason, preserveConsent = false): void {
    const capture = this.captureValue;
    if (!capture) return;
    try { this.pipeline.cancel(capture.sender, capture.binding.captureSessionId, reason); }
    finally {
      if (this.captureValue === capture) this.captureValue = undefined;
      this.ports.senses?.end(capture.binding.captureSessionId); // I-161: its look and carried facts go with it
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
    // I-197: her voice has not started for this leg: it is dropped when its stream ends (a written, silent reply is released now).
    if (this.ports.addOn?.request(leg.replyId)) { try { entry?.supersede(); } catch { /* it finished: dropped all the same */ } return true; }
    if (!entry || !this.current(entry.capture)) return false;
    try { return entry.supersede(); } catch { return false; }
  }

  private async dispatch(leg: VoiceTextLeg, signal: AbortSignal, emit: (text: string) => void): Promise<VoiceTextCompletion> {
    const capture = this.captureValue;
    if (!capture || leg.epoch !== capture.binding.epoch || !this.current(capture)) throw Error('语音上下文已改变。');
    const addOn = this.ports.addOn; addOn?.handed(leg.replyId, capture.owner); // I-197: handed over; open until her voice starts (in a call)
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    let reserved = false;
    let group = this.groups.get(leg.groupId), turn: VoiceCompanionLeg | undefined, offers: CallOfferTurn | undefined, callNote = '', callStyle = '', streaming = false;
    let look: VoiceSegmentLook | null = null, beats: CallBeats | null = null, ended = 'error'; // 边说边演: made once this leg knows whether it is read in a call
    try {
      await this.effects;
      signal.throwIfAborted(); if (!this.current(capture)) throw Error('语音上下文已改变。');
      if (!this.ports.reserveChat(leg.replyId, controller, capture.sender)) throw Error('上一轮回复尚未结束。');
      reserved = true;
      this.ports.userTurn(); // A new accepted human voice turn supersedes older text choices.
      // I-161: the look starts now (decision first, then any capture) and runs while the segment is set up; awaited before it is written.
      try { look = this.ports.look?.(leg.canonicalUserText) ?? null; } catch { look = null; }
      if (!group) {
        const begun = this.ports.companion().beginVoiceGroup(leg.groupId, leg.canonicalUserText, capture.settings.persona);
        // I-161: right after the reaction judge took the words (its one haiku call carries the senses question), before anything is awaited.
        this.ports.senses?.turn({ groupId: leg.groupId, text: leg.canonicalUserText, owner: capture.owner, scope: capture.binding.captureSessionId, covered: look?.covered?.() ?? [] });
        const created = await begun;
        if (controller.signal.aborted || !this.current(capture)) { await created.finish('stopped'); throw Error('语音上下文已改变。'); }
        const history = this.history;
        let long: ChatMessage[] | null = null;
        try { long = this.ports.longChatHistory?.(leg.groupId) ?? null; } catch { long = null; }
        const messages = long ? structuredClone(long) : history?.scope === capture.scope && history.providerScope === memoryProviderScope(capture.settings.provider)
          ? structuredClone(history.messages) : [];
        group = { turn: created, capture, text: '', replyId: leg.replyId, allowSpeech: false, messages,
          base: structuredClone(messages), answered: [], ...(long ? { long: true } : {}) };
        this.groups.set(leg.groupId, group);
        await this.ports.ambient()?.acceptUserTurn(leg.groupId, leg.canonicalUserText);
        try { callNote = this.ports.turnNote?.() ?? ''; } catch { callNote = ''; }
        if (!this.current(capture)) throw Error('语音上下文已改变。');
      } else await group.turn.extend(leg.canonicalUserText);
      controller.signal.throwIfAborted(); if (!this.current(capture)) throw Error('语音上下文已改变。');
      // I-197: a line heard before this request is written joins it (one request with both lines); later ones stop it once written.
      const joined = addOn?.open(leg.replyId) ? this.pipeline.absorb(leg.replyId) : undefined;
      if (joined) { leg = joined; addOn!.absorbed(leg.replyId); await group.turn.extend(leg.canonicalUserText); controller.signal.throwIfAborted(); if (!this.current(capture)) throw Error('语音上下文已改变。'); }
      this.ports.cancelProactive();
      const active = group, absorbed = !!joined, held = () => addOn?.open(leg.replyId) === true;
      try { offers = this.ports.callOffers?.begin(leg.canonicalUserText); } catch { offers = undefined; } // a failure costs the button, never the reply
      turn = await active.turn.beginLeg(leg, text => { beats?.shown(text); this.ports.senses?.firstChar(leg.groupId); addOn?.firstChar(leg.replyId, streaming); if (streaming) this.ports.callSpeech!.delta(leg.replyId, text); active.text += text; emit(text); }, // 边说边演: the beats before these words go first
        { ...(offers?.settingProposal ? { settingProposal: offers.settingProposal } : {}), holdArchive: held }); // I-197: archived once her voice starts
      controller.signal.throwIfAborted(); if (!this.current(capture)) throw Error('语音上下文已改变。');
      active.text = ''; active.replyId = leg.replyId; active.allowSpeech = false;
      if (this.cutPlaces.size >= 64) this.cutPlaces.delete(this.cutPlaces.keys().next().value!);
      this.cutPlaces.set(leg.replyId, { scope: active.turn.scope, turnId: active.turn.id, base: turn.base }); // where this leg's text sits in the archived reply (fileCut)
      if (look) { await look.ready; controller.signal.throwIfAborted(); if (!this.current(capture)) throw Error('语音上下文已改变。'); }
      // I-091 step 4: in a call the leg is read sentence by sentence while it streams (and gets the spoken-style lines).
      try { callStyle = this.ports.callStyle?.() ?? ''; } catch { callStyle = ''; }
      const toneLine = userToneLine(turnTone(this.tones.splice(0))); // I-100: how the user's voice sounded, a hint she may ignore
      try { streaming = !!this.ports.callSpeech?.begin({ owner: capture.owner, sender: capture.sender, replyId: leg.replyId, scope: capture.scope, userText: leg.canonicalUserText }); } catch { streaming = false; }
      beats = new CallBeats(this.ports.speechBeats, streaming, speechBeats => { if (this.current(capture) && !controller.signal.aborted) this.event(capture, { type: 'beats', groupId: leg.groupId, replyId: leg.replyId, speechBeats }); });
      if (streaming) { if (this.streamed.size >= 64) this.streamed.delete(this.streamed.values().next().value!); this.streamed.add(leg.replyId); }
      this.event(capture, { type: 'start', groupId: leg.groupId, replyId: leg.replyId });
      let speechNote = ''; try { speechNote = this.ports.speechNote?.() ?? ''; } catch { speechNote = ''; }
      const personaHead = turn.persona + callNote + callStyle + speechNote + beats.sentence(); // 边说边演: the one line, only in a call and only while the switch is on
      const afterDrop = active.addOn === true && leg.merged; active.addOn = false; // I-197: one line, nothing about a shown part (nothing was heard)
      const personaTail = (offers?.note ?? '') + toneLine + (afterDrop || absorbed ? voiceAddOnNote(leg.priorUserText)
        : leg.priorUserText ? (leg.merged ? voiceMergedNote : voiceContinuationNote)(leg.priorUserText) : '');
      // I-161: the frames go only while this segment is still live in this very capture (a call that ended, a cancelled segment: none),
      // and the line about them is read with them, where the message is written, so it tells what Claude actually gets.
      const segment = look, frames = () => segment && !controller.signal.aborted && this.current(capture) ? segment.dataUrls() : [];
      const persona = () => { let note = ''; try { note = segment?.note() ?? ''; } catch { note = ''; } return personaHead + note + (this.ports.senses?.note({ replyId: leg.replyId, scope: capture.binding.captureSessionId, text: leg.inputText }) ?? '') + personaTail; }; // I-161: a finished look's facts
      // I-161 A: the session keeps this segment's frames until hang-up only when all of them are small 「发图片」 frames (electron/brain/call-glances.ts).
      const callGlance = segment?.glanceOnly && segment.glanceStill && segment.pastNote ? { glanceOnly: () => frames().length > 0 && segment.glanceOnly!(),
        still: () => segment.glanceStill!(), past: (now: boolean) => segment.pastNote!(now) } : undefined;
      // I-134: a window from her archive is already bounded by its own knobs; only the leg itself goes through the request's checks.
      const checked = validateChatRequest({ id: leg.replyId,
        messages: active.long ? [{ role: 'user', content: leg.inputText }] : [...active.messages, { role: 'user', content: leg.inputText }], attachments: [] });
      const request = active.long ? { ...checked, messages: [...active.messages, checked.messages.at(-1)!] } : checked;
      this.event(capture, { type: 'continuation', groupId: leg.groupId, replyId: leg.replyId,
        state: leg.merged ? 'merged' : leg.kind === 'continuation' ? 'continuation' : 'request' });
      const language = this.ports.languageProfile(), live = turn;
      let relaxed: RelaxedChat | null = null; // I-139: read once per leg; a failing reader counts as off
      try { relaxed = this.ports.relaxedChat?.() ?? null; } catch { relaxed = null; }
      const onceLine = relaxed ? offers?.once : undefined;
      // 边说边演 (docs/claude/2026-11-20-speech-beats-2-4.md, leftovers 2026-11-20): her warm process may write beat markers here too; they leave the stream
      // first, so the call's speech, her bubble, the archive and the echo check get clean words; in a call the beats are played (electron/voice/voice-call/beats.ts).
      const beatsIn = beats.input((_type, clean) => live.push(clean));
      const outcome = await this.ports.claude.stream({
        kind: 'chat', model: capture.settings.provider.model, workingDirectory: this.ports.chatDirectory(), writable: false,
        // Read where the message is written: a note deleted while it waited for the process is not in it (Codex T-222 E04).
        get prompt() { return buildCodexChatPrompt(live.withCurrentRecall(persona()), request.messages, undefined, language); }, get imageDataUrls() { return frames(); },
        imageTemporaryRoot: this.ports.tempDirectory(), replyId: leg.replyId, ...(callGlance ? { callGlance } : {}),
        // Same key and fixed persona as ordinary chat, so voice continues the warm conversation process. What this leg showed
        // (kept below once it has finished) is what the session records of its reply, so a cut draft does not reopen it.
        session: { key: capture.scope, basePersona: capture.settings.persona, get persona() { return live.withCurrentRecall(persona()); }, messages: request.messages, language,
          shown: () => active.answered.find(answer => answer.replyId === leg.replyId)?.text ?? null,
          ...(relaxed ? { relaxed, ...(onceLine ? { onceLines: () => [onceLine] } : {}) } : {}) },
      }, controller.signal, (type, text) => { if (type === 'delta') beatsIn('delta', text); }, {
        started: supersede => {
          if (controller.signal.aborted || !this.current(capture)) return;
          this.merges.set(leg.replyId, { capture, supersede });
          this.pipeline.turnReady(leg.replyId);
        },
      });
      this.merges.delete(leg.replyId);
      if (!controller.signal.aborted) beats.end((_type, rest) => live.push(rest)); // what the filter held for a marker that never closed
      controller.signal.throwIfAborted(); if (!this.current(capture)) throw Error('语音上下文已改变。');
      const before = request.messages.slice(0, -1), user: ChatMessage = { role: 'user', content: leg.inputText };
      // I-197: an add-on came before her voice started: this leg is dropped (never read, kept on screen or archived), the next one answers both.
      let drop = outcome.superseded && held() && await addOn!.hold(leg.replyId, controller.signal, false) === 'add-on';
      if (outcome.superseded && !drop) {
        // Stopped to merge the next sentences: what it showed stays (archive and
        // Claude's context alike); no appraisal, nothing is read aloud.
        if (streaming) this.ports.callSpeech!.cancel(leg.replyId); // a call: nothing more of it is read, not even held text flushed below
        beats.cancel(); // 边说边演: and nothing more of it is played
        await turn.finish('stopped');
        active.answered.push({ replyId: leg.replyId, text: active.text }); // After finish: held text is flushed.
        active.messages = [...before, user, ...(outcome.output ? [{ role: 'assistant' as const, content: active.text }] : [])];
        ended = 'superseded';
        return { status: 'superseded', coveredThroughSeq: leg.throughSeq, hasAppraisal: false };
      }
      const completion = drop ? null : await turn.finish('complete');
      if (completion?.status === 'complete' && held()) { // written in full, her voice not started: it counts once she speaks (or an add-on drops it)
        if (streaming) this.ports.callSpeech!.complete(leg.replyId); // its last sentence may be read now
        drop = await addOn!.hold(leg.replyId, controller.signal, streaming) === 'add-on';
        controller.signal.throwIfAborted(); if (!this.current(capture)) throw Error('语音上下文已改变。');
      }
      if (drop || !completion) {
        if (streaming) this.ports.callSpeech!.cancel(leg.replyId);
        beats.cancel();
        const chars = turn.discard();
        if (!completion) await turn.finish('stopped');
        active.text = ''; active.addOn = true; active.answered.push({ replyId: leg.replyId, text: '' });
        active.messages = [...before, user, ...(outcome.output ? [{ role: 'assistant' as const, content: '' }] : [])]; // Claude's record of it reads '' (shown)
        this.dropped.add(leg.replyId); if (this.dropped.size > 64) this.dropped.delete(this.dropped.values().next().value!);
        addOn!.dropped(leg.replyId, chars);
        ended = 'superseded';
        return { status: 'superseded', coveredThroughSeq: leg.throughSeq, hasAppraisal: false };
      }
      turn.commit();
      ended = completion.status;
      if (completion.status === 'complete') beats.complete(active.text, active.turn.scope, active.answered.length ? null : leg.groupId); else beats.cancel(); // 边说边演: filed once per utterance (the first leg's words are the ones its positions fit)
      if (streaming) { if (completion.status === 'complete') this.ports.callSpeech!.complete(leg.replyId); else this.ports.callSpeech!.cancel(leg.replyId); }
      active.answered.push({ replyId: leg.replyId, text: active.text });
      active.messages = [...before, user, { role: 'assistant', content: active.text }];
      if (offers && completion.status === 'complete') try { this.ports.callOffers!.offer(offers, capture.sender, leg.replyId, turn.settingProposal()); } catch { /* the reply stands without the button */ }
      return completion;
    } catch {
      beats?.cancel();
      if (streaming) try { this.ports.callSpeech!.cancel(leg.replyId); } catch { /* reading only */ }
      try { if (turn) await turn.finish(controller.signal.aborted ? 'stopped' : 'error'); }
      finally {
        if (this.current(capture)) {
          const draft = this.drafts.get(leg.groupId);
          this.event(capture, { type: 'draft', groupId: leg.groupId, text: draft?.text ?? leg.canonicalUserText });
          this.event(capture, { type: 'fault' });
          queueMicrotask(() => { if (this.captureValue === capture) this.revoke('stop-generation'); });
        }
      }
      ended = controller.signal.aborted ? 'stopped' : 'error';
      return { status: ended as 'stopped' | 'error', coveredThroughSeq: 0, hasAppraisal: false };
    } finally {
      signal.removeEventListener('abort', abort);
      look?.drop(); // I-161: this segment's frames are forgotten for good (never another segment's, never another call's)
      this.ports.senses?.done({ groupId: leg.groupId, replyId: leg.replyId, status: ended, text: group?.text ?? '' }); // and its carried facts
      this.merges.delete(leg.replyId); addOn?.done(leg.replyId); // I-197: this leg's window ends with it
      if (streaming) try { this.ports.callSpeech!.cancel(leg.replyId); } catch { /* no-op once completed */ }
      if (reserved) this.ports.releaseChat(leg.replyId); // The real provider/archive promise has settled.
      this.ports.activityChanged();
    }
  }
}
