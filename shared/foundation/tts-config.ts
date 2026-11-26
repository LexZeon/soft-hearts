// Foundation (docs/claude/2026-11-15-overhaul-plan.md section 8, docs/claude/2026-11-16-overhaul-foundation.md): the read-aloud settings types, moved out of shared/voice/tts.ts and shared/voice/fish-voice.ts (which re-export them) so that
// AppSettings can name them without the foundation depending on the voice part.
// Types and fixed data only; it imports no part, so every part, the contract (shared/contracts.ts) and the wiring may use it.
import type { ReadingEntry } from './character-voice-reading';

/**
 * The reply's frozen mood, reduced to what Drama 3 can act. The first six are the Bailian choice of the same snapshot
 * (electron/mood/speech-emotion.ts selectSpeechEmotion); `sleepy` is her fatigue phase when she is drowsy or falling asleep.
 */
export const FISH_MOODS = ['calm', 'happy', 'comfort', 'sad', 'firm', 'focused', 'sleepy'] as const;
export type FishMood = (typeof FISH_MOODS)[number];

/** "fish": Fish Audio's Drama 3 (I-070), paid per UTF-8 byte; off unless the user picks it. */
export type TtsProvider = "system" | "bailian" | "fish";
export type TtsEmotion = "custom" | "gentle" | "cheerful" | "calm" | "focused" | "sad";

export interface TtsStyleBinding {
  characterId: string;
  modelPath: string;
  voice: string;
  instruction: string;
  emotion: TtsEmotion;
  rate: number;
  /** I-070 step 2: this character + model's Drama 3 voice id; absent = fall back to the global `fishVoiceId`. */
  fishVoiceId?: string;
  /** I-070 step 2: this character + model's Drama 3 acting style (≤300 characters); absent = none. */
  fishActingStyle?: string;
  /**
   * I-091 / I-070: this character + model's own read-aloud provider. Absent = follow the global one exactly as before. It is only
   * a choice: keys and the API host stay global and encrypted in the host, so it carries no secret and no path.
   */
  provider?: TtsProvider;
}

export interface TtsConfig {
  provider: TtsProvider;
  /** The real API Host copied from the user's console, without an API path. */
  apiHost: string;
  /** User-selected location label; never used to invent or switch the API Host. */
  region: string;
  model: string;
  voice: string;
  instruction: string;
  emotion: TtsEmotion;
  rate: number;
  apiKey?: string;
  introduced?: boolean;
  /** Private local character/model associations; these grant no asset access. */
  /** At most MAX_TTS_STYLE_BINDINGS, for every character together. */
  styleBindings?: TtsStyleBinding[];
  /** I-070 Drama 3: its own key, encrypted apart from Bailian's (electron/settings/settings.ts); never crosses the internal channel. */
  fishApiKey?: string;
  /** Drama 3 fixed voice (Fish `reference_id`); empty = the model's own default voice. */
  fishVoiceId?: string;
  /**
   * Drama 3 acting style of the current character (I-070 step 2): resolved from the character's binding by effectiveTtsConfig,
   * never a shared setting; it only changes the bracket in the request text.
   */
  fishActingStyle?: string;
  /** Drama 3 spending limit per calendar month, in US dollars; when reached she reads in the system voice until next month. */
  fishMonthlyCapUsd?: number;
  /**
   * Host-only, never persisted: the reply's frozen mood for Drama 3's acting direction (electron/mood/speech-emotion.ts).
   * validateTtsConfig drops it; electron/voice/speech-runtime.ts reads it beside the validated config.
   */
  speechMood?: FishMood;
  /**
   * Derived by effectiveTtsConfig, never persisted: the provider this character chose for itself (even when it cannot be used
   * yet because its key is missing), so a window can show the choice next to the global one. `provider` is what is really used.
   */
  ownProvider?: TtsProvider;
  /**
   * I-162, derived by the character-voice resolver (shared/voice/character-voice-resolver.ts), never persisted: which voice she asked for,
   * which one really speaks and why, and what the system voice must be (her gender; her own voiceURI). validateTtsConfig drops it.
   */
  voicePlan?: VoicePlan;
}

/** I-162: the resolver's account of one character's voice (derived, never stored). */
export interface VoicePlan {
  /** The provider her default voice asks for, and the one really used. */
  wanted: TtsProvider;
  used: TtsProvider;
  /** Her gender for choosing a voice (her 声音描述, else her card, else female). A known voice of the other gender is never used. */
  gender: 'female' | 'male';
  age?: 'child' | 'young' | 'adult' | 'mature';
  /** For the system voice: her own voiceURI when the system voice is her choice; '' = choose one by her gender. */
  systemVoiceURI: string;
  /** Why another voice than hers speaks (null: hers). */
  fallback: null | 'no-key' | 'no-voice-id' | 'wrong-gender';
  /** One line for the control window when there is a fallback. */
  notice?: string;
  /** The same line in English (the control window shows it with an English interface). */
  noticeEn?: string;
  /** Her own pace and pitch when the system voice is hers (the window multiplies them onto the global ones); absent = normal. */
  rate?: number;
  pitch?: number;
  /** I-164 读法: her reading map's entries for the provider that really speaks (shared/voice/reading-map.ts readingFor); absent = read as shown. validateTtsConfig drops it like the rest of the plan. */
  reading?: ReadingEntry[];
}
