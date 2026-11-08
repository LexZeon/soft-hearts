import type { SpeechTone } from "./speech-mood-tone";

export type TtsProvider = "system" | "bailian";
export type TtsEmotion = "custom" | "gentle" | "cheerful" | "calm" | "focused" | "sad";

/** An accepted chat identity only; its transient style is resolved by the host. */
export interface SpeechRequestContext { replyId: string; segmentIndex?: number }

/** Text and offsets are derived from a completed host reply, never supplied by a renderer. */
export interface ApprovedReplySpeechSegment {
  replyId: string;
  index: number;
  text: string;
  visibleText: string;
  context: SpeechRequestContext;
  /** The reply's frozen mood direction for the system voice's rate and pitch; Bailian ignores it. */
  tone?: SpeechTone;
  /** F7 developer listening trial only: silence before this (later) sentence on the system voice; absent = none. Bailian ignores it. */
  pauseBeforeMs?: number;
}

export interface TtsStyleBinding {
  characterId: string;
  modelPath: string;
  voice: string;
  instruction: string;
  emotion: TtsEmotion;
  rate: number;
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
  styleBindings?: TtsStyleBinding[];
}

export const DEFAULT_TTS_INSTRUCTION = "";
export const DEFAULT_TTS_CONFIG: Readonly<TtsConfig> = Object.freeze({
  provider: "system",
  apiHost: "",
  region: "",
  model: "qwen-audio-3.1-tts-flash",
  voice: "longanlingxin_v3.1",
  instruction: DEFAULT_TTS_INSTRUCTION,
  emotion: "custom",
  rate: 1,
  apiKey: "",
  introduced: false,
  styleBindings: [],
});

export const TTS_EMOTIONS: readonly Readonly<{ id: TtsEmotion; label: string; instruction: string }>[] = Object.freeze([
  { id: "custom", label: "自然 / 自定义", instruction: DEFAULT_TTS_INSTRUCTION },
  { id: "gentle", label: "温柔", instruction: "温柔、亲切，声音放松，语调自然，句间停顿紧凑。" },
  { id: "cheerful", label: "轻快", instruction: "轻快、开心，声音明亮自然，适度起伏，不夸张喊叫。" },
  { id: "calm", label: "平静", instruction: "平静、舒缓，节奏稳定自然，表达清晰，避免夸张。" },
  { id: "focused", label: "工作 / 利落", instruction: "专注、利落，表达清晰直接，句间停顿紧凑，自然不过分生硬。" },
  { id: "sad", label: "低落", instruction: "略显低落，语气克制柔和，节奏自然稍慢，避免夸张哭腔。" },
]);

export type TtsStreamEvent =
  | { type: "audio"; data: string; format: "pcm_s16le"; sampleRate: 24000; channels: 1; firstAudioMs?: number }
  | { type: "done"; firstAudioMs: number; audioBytes: number; requestId?: string };

export type SpeechWireEvent =
  | (TtsStreamEvent & { id: string })
  | { id: string; type: "error"; message: string; cancelled?: boolean };

export interface TtsSynthesisResult {
  /** Request dispatch to the first decoded nonempty PCM bytes, not physical speaker latency. */
  firstAudioMs: number;
  audioBytes: number;
  requestId?: string;
}

/** Resolve a private style without changing the shared provider, host or credentials. */
export function effectiveTtsConfig(config: TtsConfig, characterId: string, modelPath: string): TtsConfig {
  const binding = config.styleBindings?.find(item => item.characterId === characterId && item.modelPath === modelPath);
  return binding ? { ...config, voice: binding.voice, instruction: binding.instruction, emotion: binding.emotion, rate: binding.rate } : { ...config };
}
