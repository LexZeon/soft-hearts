import type { SpeechTone } from "./speech-mood-tone";
import { DEFAULT_FISH_MONTHLY_CAP_USD } from "./fish-voice";

// The settings types (TtsProvider, TtsEmotion, TtsStyleBinding, TtsConfig) live in shared/foundation/tts-config.ts (2026-11-16).
import type { TtsConfig, TtsEmotion, TtsProvider, TtsStyleBinding } from "../foundation/tts-config";
export type { TtsConfig, TtsEmotion, TtsProvider, TtsStyleBinding };
/** The paid cloud voices: the host synthesizes PCM and the window plays it (the system voice is the window's own engine). */
export const isCloudTtsProvider = (provider: unknown): provider is "bailian" | "fish" => provider === "bailian" || provider === "fish";

/** An accepted chat identity only; its transient style is resolved by the host. */
export interface SpeechRequestContext { replyId: string; segmentIndex?: number }

/** Text and offsets are derived from a completed host reply, never supplied by a renderer. */
export interface ApprovedReplySpeechSegment {
  replyId: string;
  index: number;
  text: string;
  visibleText: string;
  context: SpeechRequestContext;
  /** The reply's frozen mood direction for the system voice's rate and pitch; Bailian and Drama 3 ignore it. */
  tone?: SpeechTone;
  /** F7 developer listening trial only: silence before this (later) sentence on the system voice; absent = none. Bailian ignores it. */
  pauseBeforeMs?: number;
}

/** How many character + model voice bindings the settings keep, all characters together (electron/voice/tts.ts normalizes to this). */
export const MAX_TTS_STYLE_BINDINGS = 64;


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
  fishApiKey: "",
  fishVoiceId: "",
  fishMonthlyCapUsd: DEFAULT_FISH_MONTHLY_CAP_USD,
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

/** Whether a provider has what it needs to speak: the system voice always does; a paid one needs its key (and Bailian its host). */
export function ttsProviderReady(config: Pick<TtsConfig, "apiKey" | "apiHost" | "fishApiKey">, provider: TtsProvider): boolean {
  if (provider === "bailian") return Boolean(config.apiKey?.trim() && config.apiHost?.trim());
  if (provider === "fish") return Boolean(config.fishApiKey?.trim());
  return true;
}

/**
 * The voice binding a character speaks with (2026-11-19). The exact character + model one wins; without it the same character's most
 * recently written binding on another model is used, so a model swap (or a VRM with another path) keeps her voice. None = global.
 */
export function resolveStyleBinding(config: Pick<TtsConfig, "styleBindings">, characterId: string, modelPath: string): TtsStyleBinding | undefined {
  const all = config.styleBindings ?? [];
  const exact = all.find(item => item.characterId === characterId && item.modelPath === modelPath);
  if (exact || !characterId) return exact;
  for (let i = all.length - 1; i >= 0; i--) if (all[i].characterId === characterId) return all[i];
  return undefined;
}

/**
 * Resolve a private style without changing the shared host or credentials. The provider is the character's own when it has chosen
 * one and that provider can speak; otherwise it stays the global one (never a silent failure to speak).
 */
export function effectiveTtsConfig(config: TtsConfig, characterId: string, modelPath: string): TtsConfig {
  const binding = resolveStyleBinding(config, characterId, modelPath);
  const result: TtsConfig = binding ? { ...config, voice: binding.voice, instruction: binding.instruction, emotion: binding.emotion, rate: binding.rate } : { ...config };
  // Drama 3 (I-070 step 2): the character's own voice id wins; otherwise the global one stays. The acting style is only ever the
  // character's own: none when this character has none. Configs without these fields come out exactly as before.
  if (binding?.fishVoiceId !== undefined) result.fishVoiceId = binding.fishVoiceId;
  delete result.ownProvider;
  if (binding?.provider) {
    result.ownProvider = binding.provider;
    if (ttsProviderReady(config, binding.provider)) result.provider = binding.provider;
  }
  if (characterId && modelPath) {
    if (binding?.fishActingStyle) result.fishActingStyle = binding.fishActingStyle;
    else delete result.fishActingStyle;
  }
  return result;
}
