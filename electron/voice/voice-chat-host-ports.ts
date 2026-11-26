/**
 * The voice host's ports and capture shape (electron/voice/voice-chat-host.ts), moved out of that file on 2026-11-23 (I-197) so it stays
 * under the 40 KB file limit. The declarations are the ones it had; voice-chat-host.ts exports them again.
 */
import type { AppSettings } from '../../shared/foundation/settings';
import type { ChatMessage } from '../../shared/foundation/chat';
import type { MemoryScope } from '../../shared/memory';
import type { CutRecord } from '../../shared/foundation/reply-cut';
import type { LanguageProfile } from '../../shared/cards';
import type { VoiceCaptureBinding } from '../../shared/voice/voice-segments';
import type { VoiceInputFailure } from '../../shared/voice/speech-failure';
import type { UserTone } from '../../shared/senses';
import type { VoiceConversationEvent } from '../../shared/voice/voice-conversation';
import type { ReadingCancelBy } from '../../shared/voice';
import type { PersistentClaudeChat } from '../brain/claude-session';
import type { VoiceSegmentSenses } from '../senses';
import type { CompanionService } from '../brain'; // the brain page (type only)
import type { MediaOwner } from '../../shared/foundation/runtime-state';
import type { SpeechMood } from '../mood';
import type { CallOfferTurn } from './call-offers';
import type { RelaxedChat } from '../brain';
import type { UtteranceGatePorts } from './utterance-gate';
import type { CallBeatPorts } from './voice-call/beats';
import type { CallAddOn } from './voice-call/add-on';

/** One opened microphone capture: the window, its consent owner and the context it was opened in. */
export interface VoiceAppCapture {
  sender: number; owner: MediaOwner; binding: VoiceCaptureBinding; scope: string; settings: AppSettings; asrFailure?: string;
  /** Why recognition failed for this capture, by closed category (electron/senses/asr/voice-route.ts): both windows say it. */
  asrCategory?: VoiceInputFailure;
}

/** I-161: one segment's look (electron/senses/voice-look.ts VoiceLegLook): its frames, asked again on every read, and its private line. */
export interface VoiceSegmentLook { readonly ready: Promise<void>; dataUrls(): string[]; note(): string; drop(): void;
  /** I-161 A: what the call's Claude session reads to keep this segment's small 「发图片」 frames until hang-up (electron/brain/call-glances.ts). */
  glanceOnly?(): boolean; glanceStill?(): () => boolean; pastNote?(now: boolean): string; covered?(): ('screen' | 'camera')[] }

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
  /** The conversation-scoped Claude chat (electron/brain/claude-session.ts). */
  claude: Pick<PersistentClaudeChat, 'stream'> & Partial<Pick<PersistentClaudeChat, 'regroup'>>;
  languageProfile(): LanguageProfile | null | undefined;
  chatDirectory(): string;
  tempDirectory(): string;
  /** The shared foreground recognizer (microphone audio only). */
  transcribe(owner: MediaOwner, wav: ArrayBuffer, signal: AbortSignal, current: () => boolean): Promise<string>;
  /**
   * I-100: how a recognized clip sounded (laughing, crying, angry, sad, happy; null for neutral or unknown), from the local
   * recognizer's own tags. Her next voice turn gets one private line for the latest clear one (shared/senses/user-tone.ts).
   */
  toneOf?(wav: ArrayBuffer): UserTone | null;
  /** A clip came back with no words (journal note; the windows are told by an 'unheard' event). `peakDb`: its loudest level. */
  unheard?(failure: 'empty', peakDb?: number): void;
  /**
   * Unbound v1 step 3 「只认你的声音」 (electron/senses/voiceprint/gate.ts): before a clip is recognized. 'pass': as before; 'drop': clearly
   * someone else's voice, never recognized, nothing of it goes anywhere; 'taken': the user is recording their voiceprint sample, so the
   * clip is used for that and not for her chat. Absent or failing: 'pass'.
   */
  screen?(owner: MediaOwner, wav: ArrayBuffer): Promise<'pass' | 'drop' | 'taken'>;
  /**
   * Unbound v1 step 3: after a clip is recognized (words or none). True lets it go on as before; while she is out listening for her name
   * (no call on), only words with her name are let on (and the call has started), everything else is false: dropped unseen (never
   * shown, kept or sent, no "unheard" note). A failure drops the clip. Absent: true.
   */
  wake?(owner: MediaOwner, text: string): Promise<boolean>;
  /**
   * (electron/voice/utterance-gate.ts): after `wake`, a clip with words is judged. Held clips
   * (fillers, fragments, her echo while she speaks; short/quiet filler-only noise in a call) become '' and go nowhere; a clear sentence
   * or stop command while she speaks tells the call first. Absent: every clip goes on as before.
   */
  gate?: UtteranceGatePorts;
  /**
   * Stops any reading aloud now. 'sentence' (the sentence she is reading finishes, the rest is not read) was sent while the microphone opened; since opening the microphone stops nothing and this
   * host no longer sends it. The window side still understands it (src/wiring/voice-chat-wiring.ts).
   */
  stopReading(mode?: 'sentence'): void;
  /** Freezes the reading voice for a settled utterance's final reply, just before its 'speech' event. */
  prepareSpeech(capture: VoiceAppCapture, replyId: string, mood: SpeechMood): void;
  /** 2026-11-24: the reading journal's promise (electron/voice/reading-ledger.ts): a reply handed to her voice is expected to be asked for; one not handed over says why. */
  reading?: { expect(replyId: string): void; notHanded(by: ReadingCancelBy): void };
  /**
   * I-091: a private line for the first request of a new utterance (she was interrupted mid-reading in a call), taken once;
   * '' for none. Never part of the archive or the shown chat.
   */
  turnNote?(): string;
  /**
   * I-134 new chat: the window a new utterance starts from, built from her archive (electron/brain/long-chat/host.ts) without the
   * utterance itself (`groupId`, already archived as an open turn); null while new chat is off or the archive cannot be read,
   * and then the last ordinary chat window is used as before.
   */
  longChatHistory?(groupId: string): ChatMessage[] | null;
  /**
   * I-139: while its switch is on, the card's name and language (electron/brain/i139-chat.ts RelaxedChat): a voice leg's session opens with
   * layers 1 and 2 and leads follow-ups with the new header, as typed chat. null or absent: as before.
   */
  relaxedChat?(): RelaxedChat | null;
  /** I-091 step 4: the spoken-style lines of every call turn's private context ('' outside a call). */
  callStyle?(): string;
  /**
   * I-158: the private line that this voice turn's words came from speech recognition (shared/voice/speech-recognition-note.ts), in her
   * language. Every leg of a voice or call turn gets it; typed turns never pass through this host. Absent or failing: no line.
   */
  speechNote?(): string;
  /**
   * I-161: this segment's frames, decided from its recognized words exactly as a typed message's are
   * (electron/senses/voice-look.ts). Started once per segment, after the chat slot is taken; absent, null or failing: no frames, as before.
   */
  look?(text: string): VoiceSegmentLook | null;
  /** I-161 semantic look: typed chat's I-040 judgment for each utterance (electron/senses/sense-router/voice.ts). */
  senses?: VoiceSegmentSenses;
  /** 通话里的「带我去」和设置提议 (electron/voice/call-offers.ts): the same host modules typed chat uses. */
  callOffers?: { begin(userText: string): CallOfferTurn; offer(turn: CallOfferTurn, owner: number, replyId: string, settingRaw: string | null | undefined): void };
  /** 边说边演 in a call (electron/voice/voice-call/beats.ts). Absent: markers are only taken out of the words, as for any voice turn. */
  speechBeats?: CallBeatPorts;
  /** 2026-11-23/24: one reply's cut record (where and why her words stopped; offsets into the archived reply), filed beside it (electron/brain/speech-beats/cuts.ts). Absent: nothing is kept. */
  cut?(scope: MemoryScope, turnId: string, cut: CutRecord): void;
  /**
   * I-091 step 4: in a call a leg's reply is read sentence by sentence while it streams (electron/voice/voice-call/streaming-speech.ts).
   * `begin` false: not in a call, the whole reply is read at settlement as before. Only text the leg shows reaches `delta`.
   */
  callSpeech?: {
    begin(input: { owner: MediaOwner; sender: number; replyId: string; scope: string; userText: string }): boolean;
    delta(replyId: string, text: string): void;
    complete(replyId: string): boolean;
    cancel(replyId: string): void;
    /** The reply's own mood at settlement, for the sentences not synthesized yet (never starts a reading). */
    refine?(capture: VoiceAppCapture, replyId: string, mood: SpeechMood): void;
  };
  /** I-197: in a call, a line heard before her voice started joins the one before it (electron/voice/voice-call/add-on.ts). Absent: never. */
  addOn?: Pick<CallAddOn, 'handed' | 'firstChar' | 'open' | 'heard' | 'request' | 'hold' | 'absorbed' | 'dropped' | 'done' | 'settled'>;
}
