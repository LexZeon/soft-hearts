import {
  CHARACTER_CARD_FORMAT, CHARACTER_CARD_VERSION, CHARACTER_TEXT_LIMITS,
  validateCharacterDraft,
} from './character-cards';
import {
  defaultCharacterResponseProfile, validateCharacterResponseProfile,
  type CharacterResponseProfile,
} from './character-response';

export const CHARACTER_RESPONSE_CARD_VERSION = 3;
const MAX_CARD_BYTES = 1_000_000;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('角色卡 JSON 格式不正确。');
  return value as Record<string, unknown>;
};
const only = (value: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(value).some(key => !keys.includes(key)))
    throw new Error('角色卡包含未支持字段；不能导入路径、连接、权限或私人状态。');
};
function parse(text: string): Record<string, unknown> {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_CARD_BYTES)
    throw new Error('导入角色卡必须是 1 MB 以内的 JSON 文字。');
  try { return object(JSON.parse(text.replace(/^\uFEFF/, ''))); }
  catch { throw new Error('角色卡 JSON 无法解析。'); }
}
function baseCard(value: unknown, allowResponse: boolean) {
  const card = object(value);
  // 熟悉度: "关系慢慢升温" is a card setting and travels with the card (it was missing here, so a card with it on
  // could not be exported through the app, and a version 3 file with it could not be imported).
  // F6 "更真实的情绪" likewise travels when on; importing never turns it on (electron/character-cards.ts parseCharacterCardText).
  // I-018 理解说明 is persona text and travels the same way.
  only(card, [...Object.keys(CHARACTER_TEXT_LIMITS), 'mood', 'slowWarmUp', 'realerEmotions', 'understandingNotes', ...(allowResponse ? ['responseProfile'] : [])]);
  if (!Object.hasOwn(card, 'mood'))
    throw new Error('数值角色卡需要完整的 version 1 心情模板。');
  const { responseProfile: _response, ...base } = card;
  return validateCharacterDraft(base);
}

export interface CharacterResponseImport {
  /** Passed to the existing strict card importer; it alone creates the new ID. */
  baseText: string;
  profile: CharacterResponseProfile;
}

/** A v3 envelope only adds pure response parameters; the legacy importer stays strict. */
export function parseCharacterResponseImport(text: string): CharacterResponseImport {
  const parsed = parse(text);
  if (parsed.format !== CHARACTER_CARD_FORMAT || parsed.version !== CHARACTER_RESPONSE_CARD_VERSION)
    return { baseText: text, profile: defaultCharacterResponseProfile() };
  only(parsed, ['format', 'version', 'card']);
  const card = object(parsed.card);
  if (!Object.hasOwn(card, 'responseProfile')) throw new Error('version 3 角色卡缺少反应细调模板。');
  const profile = validateCharacterResponseProfile(card.responseProfile);
  const base = baseCard(card, true);
  return {
    baseText: JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: CHARACTER_CARD_VERSION, card: base }),
    profile,
  };
}

/** Empty response profiles keep the exact v2 export, including its formatting. */
export function exportCharacterWithResponse(baseText: string, value: unknown): string {
  const profile = validateCharacterResponseProfile(value);
  const parsed = parse(baseText);
  only(parsed, ['format', 'version', 'card']);
  if (parsed.format !== CHARACTER_CARD_FORMAT || parsed.version !== CHARACTER_CARD_VERSION)
    throw new Error('反应细调导出需要当前应用生成的 version 2 基础卡。');
  const card = baseCard(parsed.card, false);
  if (!profile.rules.length) return baseText;
  return JSON.stringify({
    format: CHARACTER_CARD_FORMAT,
    version: CHARACTER_RESPONSE_CARD_VERSION,
    card: { ...card, responseProfile: profile },
  }, null, 2);
}
