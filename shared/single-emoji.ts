import type { MoodLabel } from './mood';

/** Local system glyphs only. IDs never resolve a path, URL or model output. */
const SYSTEM_EMOJIS = [
  { id: 'smile', glyph: '😊', label: '微笑', hints: ['calm', 'content', 'happy'] },
  { id: 'laugh', glyph: '😆', label: '开心', hints: ['happy', 'excited'] },
  { id: 'sparkle', glyph: '🤩', label: '期待', hints: ['excited'] },
  { id: 'heart', glyph: '❤️', label: '爱心', hints: ['close', 'longing'] },
  { id: 'wave', glyph: '👋', label: '招手', hints: ['close', 'relieved'] },
  { id: 'thinking', glyph: '🤔', label: '思考', hints: ['calm', 'tense-expectation'] },
  { id: 'surprise', glyph: '😮', label: '惊讶', hints: ['tense-expectation'] },
  { id: 'concern', glyph: '😟', label: '担心', hints: ['concerned'] },
  { id: 'sad', glyph: '😢', label: '难过', hints: ['sad', 'disappointed'] },
  { id: 'upset', glyph: '😠', label: '生气', hints: ['upset'] },
  { id: 'relief', glyph: '😌', label: '安心', hints: ['relieved', 'content'] },
  // No current primary label proves sleepiness. Available for explicit preview,
  // but a calm mood alone must not become a sleep cue.
  { id: 'sleepy', glyph: '😴', label: '困倦', hints: [] },
] as const satisfies readonly { id: string; glyph: string; label: string; hints: readonly MoodLabel[] }[];

export type EmojiId = (typeof SYSTEM_EMOJIS)[number]['id'];
export interface EmojiEntry {
  readonly id: EmojiId;
  readonly glyph: string;
  readonly label: string;
  readonly hints: readonly string[];
}
export const EMOJI_CATALOG: readonly EmojiEntry[] = SYSTEM_EMOJIS;

export interface EmojiSettings {
  version: 1;
  enabled: boolean;
  source: 'system';
  selected: EmojiId[];
}

export function getEmoji(id: unknown): EmojiEntry | undefined {
  return typeof id === 'string' ? EMOJI_CATALOG.find(entry => entry.id === id) : undefined;
}

/** Consumers edit a readEmojiSettings/structuredClone copy, never this default. */
export const DEFAULT_EMOJI_SETTINGS: EmojiSettings = {
  version: 1,
  enabled: false,
  source: 'system',
  selected: EMOJI_CATALOG.map(entry => entry.id),
};
Object.freeze(DEFAULT_EMOJI_SETTINGS.selected);
Object.freeze(DEFAULT_EMOJI_SETTINGS);
for (const entry of EMOJI_CATALOG) { Object.freeze(entry.hints); Object.freeze(entry); }
Object.freeze(EMOJI_CATALOG);

/** A complete strict setting; invalid persisted or IPC data is never repaired. */
export function readEmojiSettings(value: unknown): EmojiSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error('表情符号设置必须是完整对象。');
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (keys.length !== 4 || keys.some(key => typeof key !== 'string' || !['version', 'enabled', 'source', 'selected'].includes(key))
    || !['version', 'enabled', 'source', 'selected'].every(key => Object.hasOwn(record, key))
    || record.version !== 1 || typeof record.enabled !== 'boolean' || record.source !== 'system'
    || !Array.isArray(record.selected) || record.selected.length < 1 || record.selected.length > EMOJI_CATALOG.length
    || Reflect.ownKeys(record.selected).length !== record.selected.length + 1
    || [...record.selected].some(id => !getEmoji(id)) || new Set(record.selected).size !== record.selected.length)
    throw new Error('表情符号设置包含不支持或不完整的内容。');
  return { version: 1, enabled: record.enabled, source: 'system', selected: [...record.selected] as EmojiId[] };
}
