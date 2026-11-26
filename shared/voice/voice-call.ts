/**
 * I-091 像打语音电话一样和她聊天 (steps 1 and 2).
 *
 * A call is a mode on top of voice input: while it is on, the owner window's microphone listens without the T key, she can be
 * interrupted while she reads aloud, the end of what the user said is decided after a shorter silence, and she fills the gap
 * before her reply with a very short sound in her own voice. Starting a call opens the microphone (privacy); ending it is
 * always direct. Nothing here is audio: only states, closed reasons, fixed filler texts and numbers.
 */
import type { TtsConfig } from '../foundation/tts-config';

export type VoiceCallOwner = 'pet' | 'controls';
/** How a call was started: the window's own button, her chat card, the user's own Claude (always with the dialog). */
export type VoiceCallVia = 'button' | 'chat' | 'channel' | 'name';
/** Why a call ended. */
export const VOICE_CALL_END_REASONS = ['user', 'silence', 'voice-off', 'asleep', 'hidden', 'quit'] as const;
export type VoiceCallEndReason = typeof VOICE_CALL_END_REASONS[number];

/**
 * The short sounds she may make while her reply is coming (≤ 8 per voice; fixed host texts, never model-written).
 * Only sounds, no words: 'here' (嗯，我在听) was removed;
 * tests/i091-voice-call.test.ts keeps every text to interjection sounds and punctuation.
 */
export const CALL_FILLER_IDS = ['mm', 'mmmm', 'eh', 'en', 'oh', 'wu', 'ahmm'] as const;
export type CallFillerId = typeof CALL_FILLER_IDS[number];
export const CALL_FILLER_TEXT: Readonly<Record<CallFillerId, string>> = Object.freeze({
  mm: '嗯……', mmmm: '嗯嗯', eh: '诶？', en: '嗯？', oh: '哦——', wu: '唔……', ahmm: '啊，嗯',
});
/** The tone a model that takes an instruction (Bailian) is given for every filler. */
export const CALL_FILLER_TONE = '轻声、自然，像打电话时听对方说完、自己正要开口前的一声应答，很短，不要拖长。';
export function isCallFillerId(value: unknown): value is CallFillerId {
  return typeof value === 'string' && (CALL_FILLER_IDS as readonly string[]).includes(value);
}

export type CallVoiceProvider = TtsConfig['provider'];
/** The filler clips for the current voice: system voice needs none (free, local); a paid voice needs them generated once. */
export interface CallFillerStatus {
  provider: CallVoiceProvider;
  paid: boolean;
  /** Every clip of the current voice is cached locally (always true for the system voice). */
  ready: boolean;
  /** How many clips are missing (each one is one paid synthesis call). */
  missing: number;
  /** Identifies the current voice; the window hands it back when it asks for generation after showing the notice. */
  voiceKey: string;
}

export interface VoiceCallView {
  on: boolean;
  owner: VoiceCallOwner | null;
  /** Unix ms when it started (null when off). */
  since: number | null;
  /** The last end's reason, for the window's status line (null before any call or while on). */
  ended: VoiceCallEndReason | null;
  fillers: CallFillerStatus | null;
  /**
   * Unbound v1 step 3: the call goes on while she is out in Unbound (her companion window hidden only because she is out). Her bubble
   * there is what shows her reply; the call's own window keeps its microphone and reads her reply from there (only on while on).
   */
  out?: true;
  /**
   * Unbound v1 step 3: no call, but she is out listening for her name in this window (the user's microphone, the voiceprint in use,
   * local recognition). The window listens as in a call; only words with her name start one (electron/senses/voiceprint/gate.ts).
   */
  wake?: VoiceCallOwner;
}
export const VOICE_CALL_OFF: Readonly<VoiceCallView> = Object.freeze({ on: false, owner: null, since: null, ended: null, fillers: null });

/**
 * Unbound v1 step 3: may this window read the call's replies although its page is hidden? Only the call's own window, only while
 * the call says she is out (the host still reads a sentence only after her Unbound bubble proved it painted).
 */
export function callReadsOut(view: Pick<VoiceCallView, 'on' | 'owner' | 'out'> | null | undefined, windowKind: VoiceCallOwner): boolean {
  return !!view && view.on === true && view.owner === windowKind && view.out === true;
}

/** What the window needs to keep her voice: one clip per filler (base64 PCM16 mono 24 kHz), or none for the system voice. */
export interface CallFillerClips { voiceKey: string; provider: CallVoiceProvider; clips: Partial<Record<CallFillerId, string>> }
/** The host's pick for this pause: which sound and how long after the user's last voiced moment (null: no sound this time). */
export interface CallFillerPick { id: CallFillerId; delayMs: number; /** The voice it is for (the window's clips must match). */ voiceKey?: string }

/** The two words shown with the call button. */
export const VOICE_CALL_TEXT = Object.freeze({
  start: '打电话', stop: '挂断', listening: '通话中 · 在听', speaking: '通话中', title: '像打电话一样聊天：不用按 T，直接说话；她说话时你一开口她就停下来听。',
  ended: Object.freeze<Record<VoiceCallEndReason, string>>({
    user: '已挂断。', silence: '很久没说话，已自动挂断。', 'voice-off': '语音输入关了，通话已挂断。', asleep: '她睡着了，通话已挂断。',
    hidden: '桌宠不在屏幕上，通话已挂断。', quit: '已挂断。',
  }),
});

/**
 * The notice shown before a paid voice generates the filler clips (no silent spending). `missing` clips are each one short
 * synthesis call, made once for this voice and kept on this computer.
 */
export function callFillerPaidNotice(provider: CallVoiceProvider, missing: number): string {
  const name = provider === 'fish' ? 'Drama 3（Fish Audio）' : '百炼';
  return `通话里，她会在回答前先用自己的声音轻轻"嗯"一下。这几声要用${name}现在的声音生成一次：约 ${missing} 次很短的朗读调用（会产生少量费用），之后存在这台电脑上反复用，换声音时才重新生成。通话本身每句回复的朗读也照常计费。`;
}

/**
 * Step 4: the few private lines every call turn gets (never the stable prompt prefix: they ride with the turn's own context).
 * It says what the user is doing and hears — never "a phone call", which made Sonnet and Haiku claim they could not hear
 * (docs/claude/2026-11-12-i091-experiment-1.md).
 */
export const VOICE_CALL_SPOKEN_STYLE = '\n（此刻用户正在用声音和你说话，你说的每一句他都会直接听到。像开口说话那样回答：用短的口语句子，第一句特别短（几个字，比如先应一声再往下说），可以带语气词；不要列表，不要括号和动作描写，不要 markdown。）';
