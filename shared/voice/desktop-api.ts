// 声音 (voice): this part's slice of the window↔host API. DesktopAPI (shared/contracts.ts) extends every part's slice.
// A new window↔host call of this part goes here, and electron/safety/preload.ts gets the matching typed entry; never a generic invoke.
// The members came over verbatim from shared/contracts.ts in their old order (docs/claude/2026-11-16-contracts-split.md).
import type { CueKind, FeedCueClip } from '../initiative';
import type {
  ApprovedReplySpeechSegment, AudioReadingAck, AudioReadingIntent, AudioReadingView, SpeechDiagnosticRecord, SpeechRequestContext, SpeechWireEvent,
  VoiceCaptureBinding, VoiceConversationEvent, VoiceInputSignal, VoicePcmReceipt, VoicePcmSubmission,
} from '../voice';
import type { AudioReadingRefusal } from '../foundation/runtime-state';

export interface VoiceDesktopAPI {
  synthesizeSpeech(id: string, text: string, context?: SpeechRequestContext): Promise<void>;
  beginSpeechPlaybackActivity(playbackId: string): Promise<string | null>;
  endSpeechPlaybackActivity(playbackId: string, lease: string): Promise<void>;
  prepareCharacterSpeechPreview(): Promise<SpeechRequestContext>;
  cancelSpeech(id: string): Promise<void>;
  releaseSpeech(id: string): Promise<void>;
  /** R02 dev diagnostics: one timing record (no text); written only in developer mode. */
  recordSpeechDiagnostic(record: SpeechDiagnosticRecord): Promise<void>;
  /** B06 feeding cue ("啊"/"嗯") in the character's Bailian voice; null when unavailable. Fixed host text, never a reply. */
  synthesizeFeedCue(kind: CueKind): Promise<FeedCueClip | null>;
  /** Dev-only 保存她念出来的声音 (controls only; the host answers { available: false } on a stable or packaged build, and null where it is not registered). */
  voiceKeep?(request: import('./voice-keep').VoiceKeepRequest): Promise<import('./voice-keep').VoiceKeepView | null>;
  nextReplySpeechSegment(replyId: string, completedIndex?: number): Promise<ApprovedReplySpeechSegment | null>;
  acknowledgeReplySpeechReady(replyId: string): Promise<boolean>;
  cancelReplySpeech(replyId: string): Promise<void>;
  /**
   * I-165: the window reading reply `replyId` aloud says its sentence `segmentIndex` became audible ('start'), finished ('end') or had
   * nothing to say ('skip'), or that the reading is over ('over', any index). Full-screen Unbound's bubble shows each sentence then.
   */
  noteReplySpeechHeard(replyId: string, segmentIndex: number, phase: 'start' | 'end' | 'skip' | 'over'): Promise<void>;
  onReplySpeechSegment(callback: (segment: ApprovedReplySpeechSegment) => void): () => void;
  onReplySpeechCancelled(callback: (replyId: string) => void): () => void;
  onSpeechEvent(callback: (event: SpeechWireEvent) => void): () => void;
  openTtsConsole(): Promise<void>;
  openTtsGuide(): Promise<void>;
  /** I-070 Drama 3 (electron/voice/fish-voice-host.ts): this month's spending, numbers only. Both windows. */
  getTtsBudget(): Promise<import('../voice').FishBudgetView>;
  onTtsBudget(callback: (view: import('../voice').FishBudgetView) => void): () => void;
  /** Opens fish.audio's API key page or its API billing page (two fixed addresses). Control window only. */
  openFishApiKeys(): Promise<void>;
  openFishBilling(): Promise<void>;
  openVoiceCapture(): Promise<VoiceCaptureBinding>;
  submitVoicePcm(value: VoicePcmSubmission): Promise<VoicePcmReceipt>;
  signalVoiceCapture(captureSessionId: string, signal: VoiceInputSignal): Promise<boolean>;
  onVoiceConversation(callback: (event: VoiceConversationEvent) => void): () => void;
  /** 'sentence': finish the sentence being read, read nothing more of that reply (the microphone was turned on). */
  onVoiceReadingStop(callback: (mode?: 'sentence') => void): () => void;
  /** I-091 像打语音电话一样和她聊天 (shared/voice/voice-call.ts): the call state, starting (this window's own button) and hanging up. */
  getVoiceCall(): Promise<import('../voice').VoiceCallView>;
  setVoiceCall(on: boolean): Promise<import('../voice').VoiceCallView>;
  onVoiceCall(callback: (view: import('../voice').VoiceCallView) => void): () => void;
  /**
   * I-177 batch 2: Claude's judgement (haiku, the user's own Claude) of a NEW set of audio devices: owner-stripped names and kinds only,
   * one ask per set, never awaited by a call. Back: the verdict cut to the names sent and three kinds, or null (not asked, failed, unusable).
   */
  callDevicesAsk(devices: { inputs: string[]; outputs: string[] }): Promise<import('../voice').CallDeviceJudgement | null>;
  /** I-091 step 2: her pick of a short sound for this pause (null: none this time), and the clips of her current voice. */
  voiceCallFiller(last: import('../voice').CallFillerId | null): Promise<import('../voice').CallFillerPick | null>;
  voiceCallFillerClips(): Promise<import('../voice').CallFillerClips | null>;
  /** I-091 step 2: a paid voice's clips are made only after this window showed the spending notice for `voiceKey`. */
  prepareVoiceCallFillers(voiceKey: string): Promise<{ generated: number; failed: number }>;
  /**
   * I-099: in a call, the call's own window asks the local Silero VAD about one microphone chunk (16 kHz float samples,
   * `reset`: a new call's stream). Back: one speech probability per 32 ms window, or null (go by loudness). Nothing is kept.
   */
  voiceCallVad(pcm: Float32Array, reset: boolean): Promise<number[] | null>;
  /**
   * I-099/I-100: in a call, the call's own window asks the local Smart Turn model whether the user's current turn sounds finished
   * (the last 8 s of it, 16 kHz float samples). Back: the probability that it is complete, or null (go by silence). Nothing is kept.
   */
  voiceCallTurn(pcm: Float32Array): Promise<number | null>;
  getAudioReadingView(): Promise<AudioReadingView>;
  setAudioReadingIntent(value: AudioReadingIntent): Promise<AudioReadingAck>;
  onAudioReadingView(callback: (value: AudioReadingView) => void): () => void;
  /** Only to the window whose listening/watching switch was refused (the local recognizer is not ready or not chosen): why, in her words. */
  onAudioReadingRefused(callback: (reason: AudioReadingRefusal) => void): () => void;
}
