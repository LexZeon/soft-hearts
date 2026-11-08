import type { MoodContext, MoodLabel } from '../shared/mood';
import type { FatiguePhase } from '../shared/fatigue';
import { isChatGestureIntent, type ChatGestureIntent } from '../shared/chat-gesture';
import { TTS_EMOTIONS, type TtsConfig } from '../shared/tts';
import { ttsInstruction, TtsError } from './tts';
import { SPEECH_PERSONA_LIMIT } from './speech-persona';
import { speechToneFor, type SpeechTone } from '../shared/speech-mood-tone';

/** Only validated host semantics; no reply text, instructions, paths or credentials. */
export interface SpeechMood { context: MoodContext; primary: MoodLabel; gesture?: ChatGestureIntent }
export type SpeechEmotion = 'calm' | 'happy' | 'comfort' | 'sad' | 'firm' | 'focused';
export const SPEECH_EMOTION_INSTRUCTIONS: Readonly<Record<SpeechEmotion, string>> = Object.freeze({
  calm: '平静自然，语调稳定放松，表达清楚。',
  happy: '开心和欣喜，自然带笑，语调有起伏。',
  comfort: '关心、支持或安慰，语气柔和，认真共情。',
  sad: '低落与失落，语气克制柔软。',
  firm: '认真坚定，有分寸地表达不满和边界。',
  focused: '专注、清楚、利落地解释，耐心并有重点。',
});

const contexts: readonly string[] = ['neutral', 'positive', 'support', 'concern', 'disappointment', 'offense'];
const labels: readonly string[] = ['calm', 'close', 'content', 'happy', 'excited', 'concerned', 'disappointed', 'upset', 'longing', 'sad', 'relieved', 'tense-expectation'];
function validatedMood(value: SpeechMood): SpeechMood {
  if (!value || typeof value !== 'object' || !contexts.includes(value.context) || !labels.includes(value.primary)
    || (value.gesture !== undefined && !isChatGestureIntent(value.gesture))) throw new TtsError('本轮语音情绪无效。');
  return { context: value.context, primary: value.primary, gesture: value.gesture ?? 'none' };
}

export function selectSpeechEmotion(value: SpeechMood): SpeechEmotion {
  const mood = validatedMood(value);
  // Current conversational meaning takes precedence over a lingering positive state.
  if (mood.context === 'concern' || mood.context === 'support') return 'comfort';
  if (mood.context === 'offense') return 'firm';
  if (mood.context === 'disappointment') return 'sad';
  if (mood.context === 'positive' || mood.gesture === 'upbeat') return 'happy';
  if (mood.primary === 'concerned') return 'comfort';
  if (['sad', 'disappointed', 'longing'].includes(mood.primary)) return 'sad';
  if (mood.primary === 'upset') return 'firm';
  if (['happy', 'excited', 'relieved'].includes(mood.primary)) return 'happy';
  if (mood.gesture === 'consider' || mood.gesture === 'explain' || mood.primary === 'tense-expectation') return 'focused';
  return 'calm';
}

/** Officially verified for this native HTTP model; never switch a user's paid model. */
export const supportsTurnSpeechEmotion = (model: string) => model === 'qwen-audio-3.1-tts-flash';

export const TURN_SPEECH_INSTRUCTION_LIMIT = 1000;

/** A host snapshot only; no renderer text, numeric fatigue state or persistence. */
export interface SpeechFatigueFeeling { readonly phase: FatiguePhase }
export const SPEECH_FATIGUE_FEELING_LIMIT = 120;
const FATIGUE_FEELINGS: Readonly<Record<FatiguePhase, string>> = Object.freeze({
  awake: '',
  'light-drowsy': '有一点困意，语气稍慢、放松，吐字清楚，保持原有性格和当轮情绪。',
  drowsy: '明显困倦，语气柔和、稍慢，停顿自然且表达清楚；保留角色性格和当轮情绪，不反复喊困。',
  'falling-asleep': '接近入睡，声音更轻、更慢，句意仍清楚完整；保留角色口吻和当前感受，不改变正文或省略回答。',
  asleep: '受到招呼时带着睡意轻声回应，缓慢而清楚；不声称已醒透，不制造打鼾或呻吟，不省略正文。',
  'micro-awake': '刚被轻轻唤醒，短暂迷糊、语气轻柔，吐字仍清楚；保留角色性格与当轮情绪，不声称疲倦已清空。',
});
function fatigueFeelingText(fatigue: Readonly<SpeechFatigueFeeling> | undefined): string {
  if (fatigue === undefined) return '';
  if (!fatigue || typeof fatigue !== 'object' || Array.isArray(fatigue)
    || Reflect.ownKeys(fatigue).length !== 1 || !Object.hasOwn(fatigue, 'phase'))
    throw new TtsError('本轮疲倦语气无效。');
  const phase = fatigue.phase;
  if (typeof phase !== 'string' || !Object.hasOwn(FATIGUE_FEELINGS, phase)) throw new TtsError('本轮疲倦语气无效。');
  const text = FATIGUE_FEELINGS[phase];
  if (text.length > SPEECH_FATIGUE_FEELING_LIMIT) throw new TtsError('本轮疲倦语气无效。');
  return text;
}

export function composeSpeechConfig(config: TtsConfig, mood: SpeechMood, persona = '', fatigue?: Readonly<SpeechFatigueFeeling>): TtsConfig {
  const feeling = fatigueFeelingText(fatigue);
  if (!supportsTurnSpeechEmotion(config.model)) return { ...config };
  const current = SPEECH_EMOTION_INSTRUCTIONS[selectSpeechEmotion(mood)];
  const reference = persona.trim().slice(0, SPEECH_PERSONA_LIMIT);
  const parts = [
    ...(reference ? [`角色口吻参考：\n${reference}`] : []),
    `本轮语气：${current}`,
    ...(feeling ? [`当前困倦感受：${feeling}`] : []),
    '按此角色口吻表达当前感受，心情不覆盖人格；只朗读正文。',
  ];
  // Leave room for persona and the current feeling before the optional static
  // preference. Never rely on validateTtsConfig silently truncating the result.
  const prefix = '面板常态声音习惯：';
  const room = Math.max(0, TURN_SPEECH_INSTRUCTION_LIMIT - parts.join('\n').length - prefix.length - 1);
  const preference = ttsInstruction(config).trim(), preferenceLimit = Math.min(180, room);
  const boundary = [...preference.slice(0, preferenceLimit).matchAll(/[。！？.!?；;\n]/gu)].at(-1)?.index;
  const base = preference.length <= preferenceLimit ? preference : boundary === undefined ? '' : preference.slice(0, boundary + 1).trim();
  if (base) parts.splice(reference ? 1 : 0, 0, `${prefix}${base}`);
  return { ...config, emotion: 'custom', instruction: parts.join('\n') };
}

/**
 * R02: the voice of a streamed Claude turn, frozen when the turn is accepted:
 * persona as the base tone plus the companion's current mood (calm/neutral if
 * that snapshot is not a valid speech mood). Never throws into the chat path.
 */
export function freezeTurnSpeechStyle(styles: ReplySpeechStyles, input: {
  owner: number; replyId: string; scope: string; config: TtsConfig; persona: string;
  mood: { primary?: unknown; context?: unknown } | undefined; fatigue?: Readonly<SpeechFatigueFeeling>;
}): boolean {
  let mood: SpeechMood;
  try { mood = validatedMood({ primary: input.mood?.primary, context: input.mood?.context } as SpeechMood); }
  catch { mood = { context: 'neutral', primary: 'calm', gesture: 'none' }; }
  try {
    let style: TtsConfig;
    try { style = composeSpeechConfig(input.config, mood, input.persona, input.fatigue); }
    catch { style = composeSpeechConfig(input.config, mood, input.persona); }
    // The system voice's rate/pitch nudge comes from the same frozen snapshot (mood + fatigue).
    let tone: SpeechTone;
    try { tone = speechToneFor(mood, fatigueFeelingText(input.fatigue) ? input.fatigue!.phase : undefined); }
    catch { tone = speechToneFor(mood); }
    return styles.freeze(input.owner, input.replyId, input.scope, mood, { instruction: style.instruction, emotion: style.emotion }, tone);
  } catch { return false; }
}

type SpeechStyle = Pick<TtsConfig, 'instruction' | 'emotion'>;
const validStyle = (style: SpeechStyle): boolean => typeof style.instruction === 'string' && style.instruction.length <= TURN_SPEECH_INSTRUCTION_LIMIT
  && !style.instruction.includes('\0') && TTS_EMOTIONS.some(item => item.id === style.emotion);
interface ReplyStyle { owner: number; replyId: string; scopeKey: string; expiresAt: number; mood: SpeechMood | null; style: SpeechStyle | null;
  /** System voice rate/pitch direction, frozen with the mood (shared/speech-mood-tone.ts). */
  tone?: SpeechTone;
  /** R02: frozen when the turn was accepted, so speech can start while the reply still streams. */
  frozenEarly?: boolean; finalized?: boolean }
/** At most one accepted reply, scoped to its original window and conversation. */
export class ReplySpeechStyles {
  private latest: ReplyStyle | null = null;
  constructor(private readonly now = () => performance.now()) {}
  begin(owner: number, replyId: string, scopeKey: string): void {
    if (!Number.isSafeInteger(owner) || owner <= 0 || !/^[A-Za-z0-9_-]{1,100}$/.test(replyId)
      || typeof scopeKey !== 'string' || !scopeKey || scopeKey.length > 8192) throw new TtsError('语音所属回合无效。');
    this.latest = { owner, replyId, scopeKey, mood: null, style: null, expiresAt: this.now() + 15 * 60_000 };
  }
  /**
   * R02: freeze this turn's voice (persona base tone + the mood current when the
   * turn was accepted) before the reply streams, so its first sentence can speak
   * at once. The completion is accepted once: with a valid style it replaces the
   * voice for the sentences not synthesized yet (the reply's own mood, R02 2026-11-03).
   */
  freeze(owner: number, replyId: string, scopeKey: string, mood: SpeechMood, style: SpeechStyle, tone?: SpeechTone): boolean {
    const slot = this.match(owner, replyId, scopeKey);
    if (!slot || slot.mood) return false;
    if (!this.complete(owner, replyId, scopeKey, mood, style, tone)) return false;
    slot.frozenEarly = true;
    return true;
  }
  complete(owner: number, replyId: string, scopeKey: string, mood: SpeechMood, style?: SpeechStyle, tone?: SpeechTone): boolean {
    const slot = this.match(owner, replyId, scopeKey);
    if (slot?.frozenEarly && !slot.finalized) {
      const ownMood = validatedMood(mood); slot.finalized = true;
      // R02: the early freeze used the mood from
      // before this turn; the reply's own appraisal arrives with its tail. Sentences not
      // synthesized yet speak in it (the first ones already spoke). The system voice tone
      // stays frozen (the renderer freezes it at the first sentence anyway).
      if (style && validStyle(style)) { slot.style = Object.freeze({ instruction: style.instruction, emotion: style.emotion }); slot.mood = Object.freeze(ownMood); }
      return true;
    }
    if (!slot || slot.mood) return false;
    const acceptedMood = validatedMood(mood);
    if (style && !validStyle(style)) throw new TtsError('本轮角色语音风格无效。');
    slot.style = style ? Object.freeze({ instruction: style.instruction, emotion: style.emotion }) : null;
    slot.mood = Object.freeze(acceptedMood);
    slot.tone = Object.freeze({ ...(tone ?? speechToneFor(acceptedMood)) });
    return true;
  }
  resolve(owner: number, replyId: string, scopeKey: string): SpeechMood {
    const slot = this.match(owner, replyId, scopeKey);
    if (!slot?.mood) throw new TtsError('这轮语音已结束或角色、模型、连接已切换。');
    return { ...slot.mood };
  }
  /** Final composed text only; no card, source text, credentials or live mood. */
  resolveStyle(owner: number, replyId: string, scopeKey: string): SpeechStyle {
    const slot = this.match(owner, replyId, scopeKey);
    if (!slot?.mood || !slot.style) throw new TtsError('这轮角色语音已结束或尚未就绪。');
    return { ...slot.style };
  }
  /**
   * An approved segment of this exact reply carries its frozen system-voice
   * tone (numbers only). A neutral tone changes nothing and is left out, so
   * the segment stays the very object the host approved and broadcast.
   */
  withTone<T extends object>(owner: number, replyId: string, scopeKey: string, segment: T): T & { tone?: SpeechTone } {
    const tone = this.match(owner, replyId, scopeKey)?.tone;
    return tone && (tone.rate || tone.pitch) ? { ...segment, tone: { rate: tone.rate, pitch: tone.pitch } } : segment;
  }
  clear(): void { this.latest = null; }
  dropOwner(owner: number): void { if (this.latest?.owner === owner) this.clear(); }
  cancel(replyId: string): boolean {
    if (this.latest?.replyId !== replyId) return false;
    this.clear(); return true;
  }
  private match(owner: number, replyId: string, scopeKey: string): ReplyStyle | null {
    const slot = this.latest;
    if (slot && this.now() >= slot.expiresAt) this.clear();
    return this.latest && this.latest.owner === owner && this.latest.replyId === replyId && this.latest.scopeKey === scopeKey ? this.latest : null;
  }
}
