// Foundation (docs/claude/2026-11-15-overhaul-plan.md section 8, docs/claude/2026-11-16-overhaul-foundation.md): the character card types,
// which cards, the response style, chat, memory, voice and the agent channel all read. Split out of shared/cards/character-cards.ts (validators,
// limits and the persona compiler stay there, in the cards part, which re-exports these). MusicTaste and CardSlips moved here from
// shared/senses/music-taste.ts and shared/cards/card-slips.ts (which re-export them) because a card draft names them.
import type { MoodParameters } from './mood';
import type { CharacterVoice } from './character-voice';
export type { CharacterVoice };

/** I-077 step 2: her music taste, three 0..100 whole numbers, 50 = no preference (shared/senses/music-taste.ts validates and explains it). */
export interface MusicTaste { tempo: number; brightness: number; energy: number }
/** 小毛病 (shared/cards/card-slips.ts): how often her small slips happen when she reaches out first. */
export const CARD_SLIPS = ['off', 'less', 'more'] as const;
export type CardSlips = (typeof CARD_SLIPS)[number];

/**
 * I-207 里程碑 (shared/cards/card-milestone.ts): one thing a card says can happen between her and the user once (Gene: name 这一单, notYet 还没签收,
 * reached 已签收). Only the words travel with the card; whether it happened is per-character state in the relationship file, never exported.
 */
export interface CardMilestone { name: string; notYet: string; reached: string }
/**
 * I-208 step 3 物件 (shared/cards/card-objects.ts): one thing she owns with fixed entries (Gene: 《地球投递须知》). Only the name and the entries travel with
 * the card; the margin notes she writes herself are per-character state in the relationship file, never exported.
 */
export interface CardObjectEntry { page: number; text: string; source?: string }
export interface CardObject { name: string; entries: CardObjectEntry[] }

export interface CharacterTextDraft {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  greeting: string;
  examples: string;
  systemPrompt: string;
}
export type CharacterTextField = keyof CharacterTextDraft;
/** Portable template parameters only. Current values, B/M and private history never belong here. */
export interface CharacterMoodTemplate { version: 1; parameters: MoodParameters }
/** I-071 v2: the one language a card speaks. A card made before it, or imported without one, is 'zh-CN'. */
export type CardLanguage = 'zh-CN' | 'en';
export const CARD_LANGUAGES: readonly CardLanguage[] = ['zh-CN', 'en'];
/** Anything unknown (an older card has none) reads as Chinese. */
export function cardLanguageOf(card: { language?: unknown } | null | undefined): CardLanguage { return card?.language === 'en' ? 'en' : 'zh-CN'; }
/** 慢慢熟悉 is on unless the card explicitly saved it off. The one place that default lives. */
export function slowWarmUpOf(card: { slowWarmUp?: unknown } | null | undefined): boolean { return card?.slowWarmUp !== false; }
export interface CharacterDraft extends CharacterTextDraft {
  /** I-071 v2: the language this card speaks in (persona headings, her small templates, draft guard, default voice). Absent = 'zh-CN'. */
  language?: CardLanguage;
  mood?: CharacterMoodTemplate;
  /**
   * 熟悉度 (docs/claude/2026-11-02-familiarity-plan.md): "慢慢熟悉". On by default and when missing: not that familiar at first, easier as the days add up; a slow-to-warm card
   * takes longer. Only an explicit `false` (the user turned it off for this character) means familiar from the first
   * day. Read it through slowWarmUpOf, never `=== true`. It is a card setting, so it is exported; the numbers are not.
   */
  slowWarmUp?: boolean;
  /**
   * F6 "更真实的情绪" (shared/mood/realer-emotions.ts): off by default and when missing (older cards). It only turns on after the
   * user saw what it does and agreed (the host's dialog); the card editor's save, import and the in-place update never turn it on.
   */
  realerEmotions?: boolean;
  /**
   * I-018 理解说明 (docs/claude/2026-11-03-character-understanding.md): how the words on this card are meant, as the user
   * confirmed in the discussion with Claude (a title is a post, not a profession; what not to play it as). Optional and
   * absent when empty, so a card without it compiles, stores and exports exactly as before. It is persona text, so it
   * travels with the card; the discussion itself never does.
   */
  understandingNotes?: string;
  /**
   * I-078 第 3 步 睡相 (docs/claude/2026-11-11-i078-sleep-step2-3.md): how she sleeps, a whole number 0 (安安静静) … 50 (the middle)
   * … 100 (爱翻身、抱枕头). Absent = the middle, so a card without it stores, exports and sleeps exactly as before. A card setting:
   * it travels with the card (export, import, an in-place update from a file that has it).
   */
  sleepHabit?: number;
  /**
   * I-077 step 2: her music taste (tempo, brightness, energy; 0..100, 50 = no preference). Absent when neutral, so a card without it stores,
   * exports and compiles exactly as before. A card setting, so it is exported; what she has heard and recognised never is.
   */
  musicTaste?: MusicTaste;
  /**
   * 小毛病 (docs/claude/2026-11-12-loosen.md, shared/cards/card-slips.ts): how often her small slips happen when she reaches out first,
   * 'off' | 'less' | 'more'. Absent = the default (what every card did before), so a card without it stores, exports and behaves
   * exactly as before. A card setting, so it is exported.
   */
  slips?: CardSlips;
  /**
   * I-162 her default voice (shared/foundation/character-voice.ts): provider, that provider's voice, pace and a 声音描述. Absent = she has
   * none of her own yet and reads with the default for new characters. A card setting: it travels with the card, without any key.
   */
  voice?: CharacterVoice;
  /**
   * I-207 里程碑: the one thing this card declares can happen once (words only). Absent = nothing about it anywhere (not a byte in her prompt).
   * A card setting: it travels with the card (export, import, an in-place update from a file that has it); the reached state never does.
   */
  milestone?: CardMilestone;
  /**
   * I-208 物件: the one thing this card says she owns (words and fixed entries only). Absent = nothing about it anywhere (not a byte in her prompt).
   * A card setting: it travels with the card (export, import, an in-place update from a file that has it); her margin notes never do.
   */
  object?: CardObject;
}
export interface CharacterCard extends CharacterDraft {
  id: string;
  modelName?: string;
  /**
   * I-112 B, local state of "更真实的情绪" (shared/mood/realer-duration.ts): the time (epoch ms) it turns itself off; absent while on =
   * "一直开". Never part of a draft, never exported, never imported.
   */
  realerEmotionsUntil?: number;
  /** I-112 B: it ran out by itself (the editor says so until the user changes the switch again). */
  realerEmotionsExpired?: true;
}
export interface CharacterCardState {
  cards: CharacterCard[];
  activeId: string;
  notice?: string;
  /** C1: an informational line (which card a loaded model went with); never an error. */
  hint?: string;
  /** C2: a "换成她" waiting for her current line to finish (the card it will bring in). */
  switchingTo?: string;
  revision?: number;
}
