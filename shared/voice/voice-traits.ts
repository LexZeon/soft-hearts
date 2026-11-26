// I-162 step 1: what a voice should sound like, read from a character's 声音描述 and her card (rule based, no model call), and what the
// known voices sound like (Bailian's four presets, the common system voices by name). Pure; used by shared/voice/character-voice-resolver.ts
// (which voice speaks) and src/voice/voice-language.ts (which system voice). docs/claude/2026-11-19-character-voice-step1.md.

export type VoiceGender = 'female' | 'male';
export type VoiceAge = 'child' | 'young' | 'adult' | 'mature';
export interface VoiceTraits {
  gender: VoiceGender;
  /** Where the gender came from: her 声音描述, her card's own text, or the default (every companion here is "她" unless her card says otherwise). */
  genderFrom: 'description' | 'card' | 'default';
  age?: VoiceAge;
  /** Timbre words found (sweet, soft, bright, gentle, deep, husky, lively, cool, calm), in a fixed order. */
  timbre: string[];
}

// A negated mention ("不要男声", "not a male voice") says nothing about what she is.
const NEGATED = /(?:不要|不是|不用|别用|别|非|避免|不像|\bnot\s+(?:a\s+)?|\bno\s+|\bnever\s+|\bavoid\s+)\s*\S{0,3}?(?:男|女|male|female|man|woman|boy|girl|guy|lady)\S*/giu;
const FEMALE_WORDS = /女|少女|姑娘|御姐|萝莉|妹妹|大小姐|\bgirl\b|\bwoman\b|\bfemale\b|\blady\b/giu;
const MALE_WORDS = /男|少年|小伙|大叔|正太|哥哥|\bboy\b|\bman\b|\bmale\b|\bguy\b|\bgentleman\b/giu;
const EXPLICIT_GENDER = /(?:性别|gender|sex)\s*[:：]\s*(女|男|female|male|f(?![a-z])|m(?![a-z]))/iu;
const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;

function genderIn(text: string): VoiceGender | null {
  const explicit = EXPLICIT_GENDER.exec(text)?.[1]?.toLowerCase();
  if (explicit) return explicit === '女' || explicit === 'female' || explicit === 'f' ? 'female' : 'male';
  const plain = text.replace(NEGATED, ' ');
  const female = count(plain, FEMALE_WORDS), male = count(plain, MALE_WORDS);
  if (female > male) return 'female';
  if (male > female) return 'male';
  return null;
}

/**
 * Her card's gender. Biased to female, on purpose: every companion here is "她" unless the card clearly says otherwise, and a male voice on a
 * female character is the failure the user saw. Male needs an explicit "性别：男" or male words outnumbering female ones together with "他"
 * outnumbering "她" (a card often calls the user "他", so pronouns alone never make her male).
 */
function cardGender(text: string): VoiceGender | null {
  const explicit = EXPLICIT_GENDER.exec(text)?.[1]?.toLowerCase();
  if (explicit) return explicit === '女' || explicit === 'female' || explicit === 'f' ? 'female' : 'male';
  const plain = text.replace(NEGATED, ' ');
  const female = count(plain, FEMALE_WORDS) + count(plain, /她|\bshe\b|\bher\b/giu);
  const male = count(plain, MALE_WORDS), he = count(plain, /他|\bhe\b|\bhis\b|\bhim\b/giu), she = count(plain, /她|\bshe\b|\bher\b/giu);
  if (male > count(plain, FEMALE_WORDS) && he > she) return 'male';
  return female > 0 ? 'female' : null;
}

const AGES: readonly [VoiceAge, RegExp][] = [
  ['child', /小孩|孩子|童声|萝莉|正太|小学生|\bchild\b|\bkid\b|\blittle girl\b/iu],
  ['mature', /成熟|御姐|大叔|中年|三十|四十|阿姨|熟女|\bmature\b|\bmiddle-aged\b|\bolder\b/iu],
  ['young', /少女|少年|学生|二十|十几|十八|十九|年轻|元气|\byoung\b|\bteen/iu],
];
const TIMBRE: readonly [string, RegExp][] = [
  ['sweet', /甜|奶|\bsweet\b|\bcute\b/iu],
  ['soft', /软|轻|柔|气声|\bsoft\b|\bgentle voice\b|\bbreathy\b/iu],
  ['bright', /亮|清脆|清亮|\bbright\b|\bclear\b/iu],
  ['gentle', /温柔|温和|亲切|\bgentle\b|\bwarm\b|\bkind\b/iu],
  ['deep', /低沉|低音|沉稳|\bdeep\b|\blow\b/iu],
  ['husky', /沙哑|烟嗓|磁性|\bhusky\b|\braspy\b/iu],
  ['lively', /活泼|元气|欢快|俏皮|\blively\b|\bcheerful\b|\bplayful\b/iu],
  ['cool', /冷|高冷|清冷|淡淡|\bcool\b|\baloof\b/iu],
  ['calm', /平静|安静|慢|困|懒|\bcalm\b|\bsleepy\b|\bslow\b/iu],
];

/** The traits wanted for a character: her 声音描述 first; for gender, her card's text next; female when neither says. */
export function voiceTraits(description: string | undefined, cardText: string): VoiceTraits {
  const words = (description ?? '').trim();
  const fromDescription = words ? genderIn(words) : null;
  const fromCard = fromDescription ? null : cardGender(cardText);
  const gender = fromDescription ?? fromCard ?? 'female';
  const ageText = words || cardText;
  const age = AGES.find(([, pattern]) => pattern.test(ageText))?.[0];
  return { gender, genderFrom: fromDescription ? 'description' : fromCard ? 'card' : 'default', ...(age ? { age } : {}),
    timbre: words ? TIMBRE.filter(([, pattern]) => pattern.test(words)).map(([name]) => name) : [] };
}

/** The card text the gender and age are read from (never sent anywhere). */
export function cardVoiceText(card: { name?: string; description?: string; personality?: string; scenario?: string; systemPrompt?: string; understandingNotes?: string }): string {
  return [card.name, card.description, card.personality, card.understandingNotes, card.scenario, card.systemPrompt].filter(Boolean).join('\n').slice(0, 20000);
}

export interface KnownVoice { id: string; gender: VoiceGender; age: VoiceAge; timbre: readonly string[] }
/**
 * Bailian's presets the voice panel offers (src/voice/EmotionalVoice.ts BAILIAN_VOICE_CHOICES). 龙安灵心 is the product default and the voice
 * the user's listening rounds called "同一位女声" (handbook/ideas.md); 许南川 is a man's name. 龙安风悦's sound is not checked yet, so it is
 * left out: a voice whose gender is unknown is never picked for someone else.
 */
export const BAILIAN_KNOWN_VOICES: readonly KnownVoice[] = Object.freeze([
  { id: 'longanlingxin_v3.1', gender: 'female', age: 'young', timbre: ['gentle', 'soft', 'sweet'] },
  { id: 'longanhuan_v3.1', gender: 'female', age: 'young', timbre: ['lively', 'bright'] },
  { id: 'xunanchuan_v3.1', gender: 'male', age: 'adult', timbre: ['calm', 'deep'] },
]);
export function bailianVoiceGender(id: string): VoiceGender | null {
  return BAILIAN_KNOWN_VOICES.find(voice => voice.id === id)?.gender ?? null;
}
/** Bailian's closest known voice for these traits: right gender always (both genders are in the list), then age, then shared timbre words. */
export function closestBailianVoice(traits: VoiceTraits): KnownVoice {
  const score = (voice: KnownVoice) => (voice.age === traits.age ? 2 : 0) + voice.timbre.filter(word => traits.timbre.includes(word)).length;
  const same = BAILIAN_KNOWN_VOICES.filter(voice => voice.gender === traits.gender);
  return [...same].sort((a, b) => score(b) - score(a))[0] ?? BAILIAN_KNOWN_VOICES[0];
}

// The system voices by name (Windows desktop and OneCore, Edge natural voices, macOS). Anything else has an unknown gender.
const SYSTEM_FEMALE = /\b(huihui|yaoyao|xiaoxiao|xiaoyi|xiaohan|xiaomo|xiaorui|xiaoxuan|xiaoyan|xiaobei|xiaoni|xiaochen|xiaomeng|xiaoqiu|xiaoshuang|xiaozhen|hsiaochen|hsiaoyu|hanhan|hiugaai|hiumaan|tracy|danni|zira|aria|jenny|ava|emma|michelle|samantha|libby|sonia|hazel|susan|karen|moira|tessa|fiona|victoria|allison|catherine|heera|ana|jane|nancy|sara|ting-?ting|mei-?jia|sin-?ji|yu-?shu|lili|li-?na|ayumi|haruka|nanami|sayaka|female)\b|女/iu;
const SYSTEM_MALE = /\b(kangkang|yunxi|yunjian|yunyang|yunxia|yunze|yunhao|yunfeng|yunye|yunjhe|wanlung|zhiwei|danny|david|mark|guy|andrew|brian|christopher|eric|roger|steffan|alex|daniel|fred|tom|oliver|ryan|thomas|george|james|richard|ravi|li-?mu|ichiro|keita|male)\b|男/iu;
/** A system voice's gender from its name (or voiceURI); null when the name says nothing known. */
export function systemVoiceGender(voice: { name?: string; voiceURI?: string }): VoiceGender | null {
  const name = `${voice.name ?? ''} ${voice.voiceURI ?? ''}`;
  const female = SYSTEM_FEMALE.test(name), male = SYSTEM_MALE.test(name);
  return female === male ? null : female ? 'female' : 'male';
}
