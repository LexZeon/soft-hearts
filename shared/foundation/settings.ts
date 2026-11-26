// Foundation (docs/claude/2026-11-15-overhaul-plan.md section 8, docs/claude/2026-11-16-overhaul-foundation.md): the settings vocabulary (AppSettings and what it is made of), moved out of shared/contracts.ts,
// which re-exports it. ProactiveTalk and the crisis regions moved here from their parts for the same reason (those files re-export them).
// Types and fixed data only; it imports no part, so every part, the contract (shared/contracts.ts) and the wiring may use it.

import type { TtsConfig } from './tts-config';

/** 设置里「她主动找你说话」的三档；缺省、认不出的值都当作 'normal'。 (shared/behaviors/inner-rhythm/knobs.ts reads it) */
export type ProactiveTalk = 'less' | 'normal' | 'more';
/** The three steps and the reading of a stored value (moved here from shared/behaviors/inner-rhythm/knobs.ts, which re-exports them; wiring rewrite step 1). */
export const PROACTIVE_TALK_VALUES: readonly ProactiveTalk[] = Object.freeze(['less', 'normal', 'more'] as const);
export function proactiveTalk(value: unknown): ProactiveTalk { return value === 'less' || value === 'more' ? value : 'normal'; }

/** I-117 the regions the safety card knows (shared/safety/crisis-lines.ts has the lines and the guess). */
export const CRISIS_REGIONS = ['US', 'CA', 'CN', 'TW', 'HK', 'other'] as const;
export type CrisisRegion = typeof CRISIS_REGIONS[number];
/** The setting 「所在地区（求助信息用）」: 'auto' guesses from the system time zone (and the locale when the zone says nothing). */
export const CRISIS_REGION_PREFERENCES = ['auto', ...CRISIS_REGIONS] as const;
export type CrisisRegionPreference = typeof CRISIS_REGION_PREFERENCES[number];

/**
 * Claude-only edition. Settings saved with the retired
 * "openai" / "ollama" kinds, or the Codex edition's "codex", load as "claude"
 * (electron/settings/validation.ts validateProvider); their old encrypted key is never decrypted.
 */
export type ProviderKind = "claude";
export interface ProviderConfig {
  kind: ProviderKind;
  /** Unused by Claude Code; kept only because it is part of the stored chat-memory scope. */
  baseUrl: string;
  /** Claude Code model alias or id; empty follows Claude Code's own default. */
  model: string;
}
export interface VoiceInputConfig {
  baseUrl: string; model: string; language: string; apiKey?: string;
  /**
   * 识别方式: 'local' = the app's own recognizer on this computer (default, electron/senses/asr/);
   * 'compatible' = the OpenAI-compatible transcription address above. A saved setting without it is migrated in
   * electron/settings/validation.ts: still the default address → 'local'; an address the user changed → 'compatible'.
   */
  engine?: VoiceInputEngine;
}
export type VoiceInputEngine = 'local' | 'compatible';
export interface CameraConfig {
  yaw: number;
  pitch: number;
  distance: number;
  targetY: number;
  targetX: number;
  targetZ?: number;
  fov: number;
}
// What a window saw of the model and motion when it loaded settings; saveSettings sends it back so a stale clear is not applied
// (moved here from shared/settings/desktop-api.ts 2026-11-17: the settings part and the actions part's motion layers both use it).
export interface AssetSaveBaseline {
  model: string | null;
  motion: string | null;
  motionLayers?: { gesture: string | null; expression: string | null };
}

export interface AssetRef {
  path: string;
  url: string;
  name: string;
}
export interface AppSettings {
  /** 2 since R29f (the default render rate moved to 60 fps; a version-1 file on the old default 30 moves once). */
  version: 1 | 2;
  model: AssetRef | null;
  motion: AssetRef | null;
  motionLayers?: { gesture: AssetRef | null; expression: AssetRef | null };
  camera: CameraConfig;
  provider: ProviderConfig;
  persona: string;
  pet: {
    visible: boolean;
    alwaysOnTop: boolean;
    clickThrough: boolean;
    followMouse: boolean;
    fps: number;
    breath: number;
    scale?: number;
    size?: { width: number; height: number };
  };
  /**
   * `moodInfluence`: 0–100 % (default 50) of the reply mood's small rate/pitch nudge on the system voice (R02).
   * `firstChunk` (I-029): where a streaming Claude reply's first read-aloud piece ends: 'sentence' (default, the first whole
   * sentence) or 'comma' (may end at a comma inside the first sentence; shared/voice/first-speech-chunk.ts). Both voices.
   * `pauseTalk` (F7 停停说说, default off = absent): haiku decides, from her mood and character, where her bubbles after the first
   * pause and whether she stops to wait for the user (shared/behaviors/pause-talk/); the first sentence never waits.
   */
  voice: { enabled: boolean; voiceURI: string; rate: number; volume: number; moodInfluence?: number; firstChunk?: 'sentence' | 'comma'; pauseTalk?: boolean };
  tts?: TtsConfig;
  voiceInput?: VoiceInputConfig;
  agent: { workingDirectory: string; model: string; writable: boolean };
  /** Inner loop (L1): she decides by herself at mood opportunities. Default on; host-owned intent (setInnerLoop). */
  innerLoop: boolean;
  /**
   * 她主动找你说话: 'less' | 'normal' (default, = today) | 'more'. Scales how often her own moments come
   * (shared/behaviors/inner-rhythm/); the card's speech caps are not touched. Absent in older files: 'normal'.
   */
  proactiveTalk?: ProactiveTalk;
  /**
   * I-085 她自己看一眼: with 「发图片」 on, she may take a look at the user herself when her mood makes
   * her want to (electron/initiative/self-look/): one haiku call each, at most 4 an hour. Default on; it never turns a sense on. Absent: on.
   */
  selfLook?: boolean;
  /**
   * 体验记录 (E2, "保留体验记录（只存本机）"): default off; host-owned intent (setExperienceJournal), never a stale form field.
   * On: `<profile>/journal/<local date>.jsonl` (electron/memory/journal/writer.ts).
   */
  experienceJournal?: boolean;
  /**
   * I-117 「所在地区（求助信息用）」: which region's help line the safety card shows first. 'auto' (and absent in older files): guessed
   * from the system time zone (shared/safety/crisis-lines.ts guessCrisisRegion).
   */
  crisisRegion?: CrisisRegionPreference;
}
