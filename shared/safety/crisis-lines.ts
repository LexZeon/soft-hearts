/**
 * I-117: the real-life help lines the safety card shows, by region (decision 3: the guessed region's line first and prominent, the
 * other regions below, folded). Public numbers only, fixed in the app (no network lookup). Every line carries the official source it
 * was checked against and the date: docs/claude/2026-11-13-crisis-lines-verified.md. Recheck before shipping and about every three
 * months; change `verifiedAt` with the page.
 *
 * Mainland China's 12356 cannot be reached from outside the mainland, so it is never offered to anyone whose region is not 'CN'
 * (crisisCardModel; tests pin it). A region without a verified line gets only "当地的紧急电话".
 */
// The region lists live in shared/foundation/settings.ts (the setting 「所在地区（求助信息用）」 is part of AppSettings; 2026-11-16).
import { CRISIS_REGIONS, CRISIS_REGION_PREFERENCES, type CrisisRegion, type CrisisRegionPreference } from '../foundation/settings';
export { CRISIS_REGIONS, CRISIS_REGION_PREFERENCES, type CrisisRegion, type CrisisRegionPreference };
export const isCrisisRegion = (value: unknown): value is CrisisRegion => typeof value === 'string' && (CRISIS_REGIONS as readonly string[]).includes(value);
export const crisisRegionPreference = (value: unknown): CrisisRegionPreference =>
  typeof value === 'string' && (CRISIS_REGION_PREFERENCES as readonly string[]).includes(value) ? value as CrisisRegionPreference : 'auto';

type Words = Readonly<{ zh: string; en: string }>;
export interface CrisisLine {
  readonly region: Exclude<CrisisRegion, 'other'>;
  readonly name: Words;
  readonly number: string;
  /** How to reach it and when, in a few words. */
  readonly how: Words;
  /** Immediate danger. */
  readonly emergency: string;
  readonly source: string;
  readonly verifiedAt: string;
}

export const CRISIS_REGION_NAMES: Readonly<Record<CrisisRegion, Words>> = Object.freeze({
  US: { zh: '美国', en: 'United States' }, CA: { zh: '加拿大', en: 'Canada' }, CN: { zh: '中国大陆', en: 'Mainland China' },
  TW: { zh: '台湾', en: 'Taiwan' }, HK: { zh: '香港', en: 'Hong Kong' }, other: { zh: '其他地区', en: 'Elsewhere' },
});

export const CRISIS_LINES: readonly CrisisLine[] = Object.freeze([
  { region: 'US', name: { zh: '988 自杀与危机生命线', en: '988 Suicide & Crisis Lifeline' }, number: '988',
    how: { zh: '打电话或发短信 988，也可以在 988lifeline.org 网上聊天；24 小时；打电话时可以要中文口译。', en: 'Call or text 988, or chat at 988lifeline.org; 24/7; interpreters available by phone.' },
    emergency: '911', source: 'https://988lifeline.org/faq/calling-the-988-lifeline/faq-is-the-988-lifeline-available-in-other-languages-for-non-english-speakers/', verifiedAt: '2026-11-13' },
  { region: 'CA', name: { zh: '9-8-8 自杀危机求助热线', en: '9-8-8: Suicide Crisis Helpline' }, number: '9-8-8',
    how: { zh: '打电话或发短信 988；24 小时；英语、法语。', en: 'Call or text 988; 24/7; English and French.' },
    emergency: '911', source: 'https://www.canada.ca/en/public-health/news/2023/11/9-8-8-suicide-crisis-helpline.html', verifiedAt: '2026-11-13' },
  { region: 'CN', name: { zh: '全国统一心理援助热线', en: 'National psychological assistance hotline' }, number: '12356',
    how: { zh: '打电话 12356；每天至少 18 小时（不一定 24 小时）。', en: 'Call 12356; at least 18 hours a day (not always 24).' },
    emergency: '120 / 110', source: 'https://www.news.cn/politics/20250508/b45e439c15bb4732858ad5c7640e9ba9/c.html', verifiedAt: '2026-11-13' },
  { region: 'TW', name: { zh: '安心专线', en: 'Taiwan Mental Health Hotline (安心專線)' }, number: '1925',
    how: { zh: '打电话 1925；24 小时，免费。', en: 'Call 1925; 24/7, free.' },
    emergency: '119 / 110', source: 'https://mohw.gov.tw/cp-16-50587-1.html', verifiedAt: '2026-11-13' },
  { region: 'HK', name: { zh: '“情绪通”精神健康支援热线', en: 'Mental Health Support Hotline (18111)' }, number: '18111',
    how: { zh: '打电话 18111（也有 WhatsApp）；24 小时；粤语、普通话、英语等。', en: 'Call 18111 (WhatsApp too); 24/7; Cantonese, Mandarin, English and more.' },
    emergency: '999', source: 'https://news.gov.hk/eng/2023/12/20231227/20231227_162155_701.html', verifiedAt: '2026-11-13' },
]);

const zones = (list: string): ReadonlySet<string> => new Set(list.split(/\s+/u).filter(Boolean));
/** IANA zones of the United States (states only; territories are not mapped yet) and their old aliases. */
const US_ZONES = zones(`America/New_York America/Chicago America/Denver America/Los_Angeles America/Phoenix America/Anchorage America/Juneau
  America/Sitka America/Metlakatla America/Yakutat America/Nome America/Adak America/Boise America/Detroit America/Menominee
  America/Indiana/Indianapolis America/Indiana/Knox America/Indiana/Marengo America/Indiana/Petersburg America/Indiana/Tell_City
  America/Indiana/Vevay America/Indiana/Vincennes America/Indiana/Winamac America/Kentucky/Louisville America/Kentucky/Monticello
  America/North_Dakota/Beulah America/North_Dakota/Center America/North_Dakota/New_Salem America/Indianapolis America/Louisville
  America/Fort_Wayne America/Knox_IN Pacific/Honolulu US/Eastern US/Central US/Mountain US/Pacific US/Alaska US/Hawaii US/Arizona
  US/East-Indiana US/Indiana-Starke US/Michigan US/Aleutian`);
const CA_ZONES = zones(`America/Toronto America/Vancouver America/Edmonton America/Winnipeg America/Halifax America/St_Johns America/Regina
  America/Moncton America/Glace_Bay America/Goose_Bay America/Whitehorse America/Dawson America/Dawson_Creek America/Fort_Nelson
  America/Creston America/Iqaluit America/Rankin_Inlet America/Resolute America/Cambridge_Bay America/Inuvik America/Swift_Current
  America/Atikokan America/Blanc-Sablon America/Nipigon America/Thunder_Bay America/Rainy_River America/Yellowknife America/Pangnirtung
  America/Montreal America/Coral_Harbour Canada/Atlantic Canada/Central Canada/Eastern Canada/Mountain Canada/Newfoundland
  Canada/Pacific Canada/Saskatchewan Canada/Yukon`);
const CN_ZONES = zones('Asia/Shanghai Asia/Chongqing Asia/Chungking Asia/Harbin Asia/Urumqi Asia/Kashgar PRC');
const TW_ZONES = zones('Asia/Taipei ROC');
const HK_ZONES = zones('Asia/Hong_Kong Hongkong');

/** A zone that says nothing about where the user is (UTC, Etc/*): then the locale's region may decide. */
const silentZone = (zone: string): boolean => !zone || /^(?:utc|gmt|uct|zulu|universal|etc\/.*)$/iu.test(zone);

/**
 * The default for 'auto': the system time zone first (America/* split into the United States and Canada by the lists above; Macau and
 * every other zone are 'other'), then, only when the zone says nothing, the locale's region (en-US, fr-CA, zh-CN, zh-TW, zh-HK…).
 */
export function guessCrisisRegion(input: { timeZone?: string | null; locale?: string | null }): CrisisRegion {
  const zone = String(input.timeZone ?? '').trim();
  if (!silentZone(zone)) {
    if (US_ZONES.has(zone)) return 'US';
    if (CA_ZONES.has(zone)) return 'CA';
    if (CN_ZONES.has(zone)) return 'CN';
    if (TW_ZONES.has(zone)) return 'TW';
    if (HK_ZONES.has(zone)) return 'HK';
    return 'other';
  }
  const region = /^[a-z]{2,3}(?:[-_][a-z]{4})?[-_]([a-z]{2})\b/iu.exec(String(input.locale ?? '').trim())?.[1]?.toUpperCase();
  return region === 'US' || region === 'CA' || region === 'CN' || region === 'TW' || region === 'HK' ? region : 'other';
}

/** The system's own zone and locale (Intl; works in the main process and in the windows). */
export function systemCrisisRegion(): CrisisRegion {
  try {
    const options = Intl.DateTimeFormat().resolvedOptions();
    return guessCrisisRegion({ timeZone: options.timeZone, locale: options.locale });
  } catch { return 'other'; }
}

export function resolveCrisisRegion(preference: unknown, guess: () => CrisisRegion = systemCrisisRegion): CrisisRegion {
  const chosen = crisisRegionPreference(preference);
  return chosen === 'auto' ? guess() : chosen;
}

export type CardLanguage = 'zh' | 'en';
export interface CrisisCardEntry {
  readonly region: CrisisRegion;
  readonly regionName: string;
  /** null for 'other': no verified line, only the local emergency number. */
  readonly name: string | null;
  readonly number: string | null;
  readonly how: string;
  readonly emergency: string;
}
export interface CrisisCardModel {
  readonly sentence: string;
  readonly primary: CrisisCardEntry;
  /** The other regions, folded under the primary one. Never mainland China's line unless the region is 'CN'. */
  readonly others: readonly CrisisCardEntry[];
  readonly othersLabel: string;
  readonly safe: string;
  readonly close: string;
  readonly title: string;
}

/** The card's one sentence: not preachy, not her voice (decision 2 of the plan; the user may reword it). */
export const SAFETY_CARD_SENTENCE: Words = Object.freeze({
  zh: '如果你现在很难受，这里有能在现实里接住你的人。',
  en: 'If things feel really hard right now, here are people who can be there for you in real life.',
});
const LOCAL_EMERGENCY: Words = Object.freeze({ zh: '当地的紧急电话', en: 'your local emergency number' });

function entry(region: CrisisRegion, language: CardLanguage): CrisisCardEntry {
  const line = CRISIS_LINES.find(item => item.region === region);
  const regionName = CRISIS_REGION_NAMES[region][language];
  if (!line) return { region, regionName, name: null, number: null,
    how: language === 'zh' ? '有立即的危险时，请打当地的紧急电话。' : 'If you are in immediate danger, call your local emergency number.', emergency: LOCAL_EMERGENCY[language] };
  return { region, regionName, name: line.name[language], number: line.number, how: line.how[language],
    emergency: language === 'zh' ? `有立即的危险：${line.emergency}` : `Immediate danger: ${line.emergency}` };
}

/** What the card shows for this region: its line first, then the others (mainland China's only for 'CN'). */
export function crisisCardModel(region: CrisisRegion, language: CardLanguage = 'zh'): CrisisCardModel {
  const others = CRISIS_LINES.filter(line => line.region !== region && (line.region !== 'CN' || region === 'CN')).map(line => entry(line.region, language));
  return {
    title: language === 'zh' ? 'soft hearts · 现实中的帮助' : 'soft hearts · Help in real life',
    sentence: SAFETY_CARD_SENTENCE[language],
    primary: entry(region, language),
    others,
    othersLabel: language === 'zh' ? '其他地区' : 'Other regions',
    safe: language === 'zh' ? '我现在安全' : 'I am safe now',
    close: language === 'zh' ? '关闭' : 'Close',
  };
}
