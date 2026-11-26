// I-071 v2 第三步: a profile folder with a Chinese character who has synthetic memories of every kind the conversion carries
// (chat segments with notes, a profile line, three diary days with an in-joke, familiarity, two nicknames, a voice binding with a
// Bailian style text, a Drama 3 voice id and acting style), built with the real stores, plus a fake Claude for the translations.
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore } from '../../electron/cards/character-cards';
import { CompanionService, memoryProviderScope } from '../../electron/brain/companion';
import { forgettableProviderScopes } from '../../electron/cards/character-forget';
import { UserProfileStore } from '../../electron/memory/user-profile';
import { localDateKey } from '../../electron/memory/diary/diary-dates';
import { MEMORY_NOTES_FILE } from '../../electron/memory/memory-notes/store';
import { createConversion, type ConversionWiring } from '../../electron/cards/character-convert/electron-wiring';
import type { ConversionService } from '../../electron/cards/character-convert/service';
import type { ConversionModel } from '../../electron/cards/character-convert/translate';
import { compileCharacterPersona } from '../../shared/cards/character-cards';
import { DEFAULT_TTS_CONFIG, type TtsConfig } from '../../shared/voice/tts';
import type { AppSettings } from '../../shared/foundation/settings';
import type { ConversionJobView } from '../../shared/cards/character-convert';
import { asciiPunctuation } from '../../shared/foundation/fullwidth-punctuation';

export const provider = { kind: 'claude' as const, baseUrl: 'https://convert.invalid/v1', model: 'fixture' };
export const providerScope = memoryProviderScope(provider);
export const DAY = 86_400_000;
/**
 * The local date `back` calendar days ago, stepped from today's noon. Subtracting `back * DAY` from now put two steps on one
 * date between 23:00 and midnight for weeks after the clocks went back (2026-11-01 has 25 hours), so a fixture of 20 items had 19.
 */
export const daysAgoKey = (back: number): string => { const noon = new Date(); noon.setHours(12, 0, 0, 0); noon.setDate(noon.getDate() - back); return localDateKey(noon.getTime()); };

export async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-convert-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}

/** Every file under the folder, by relative path (bytes). */
export async function filesOf(directory: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files.set(path.relative(directory, full).split(path.sep).join('/'), await readFile(full));
  }
  return files;
}

const sentences = ['我最喜欢下雨天去书店，尤其是老城区那家', '周五我要去面试，有点紧张', '昨天我们一起看了猫咪视频，笑了好久'];

export interface Fixture {
  directory: string;
  cards: CharacterCardStore;
  companion: CompanionService;
  profiles: UserProfileStore;
  sourceId: string;
  modelPath: string;
  settings: { current: AppSettings };
  registered: Map<string, (...args: any[]) => unknown>;
  sent: string[];
  views: ConversionJobView[];
  wiring: ConversionWiring;
  service: ConversionService;
  /** Swappable: the conversion calls this. */
  model: { current: ConversionModel; calls: { system: string; prompt: string }[] };
}

/** The names the fixture's character uses and what the user chooses for them (ALL_KEPT): a faithful fake applies the glossary. */
export const FIXTURE_TERMS: readonly [string, string][] = [['阿澄', 'Cheng'], ['小雨', 'Rainy']];

/**
 * The fake's stand-in for transliteration: each Chinese character becomes one Latin letter picked by its code point, so no Chinese
 * is left, the result is deterministic and as long as the original (recall excerpts are cut by length).
 */
export const romanize = (text: string) => text.replace(/\p{Script=Han}/gu, ch => String.fromCharCode(97 + ch.codePointAt(0)! % 26));
/** What the fake makes of one source string: glossary pairs applied, names kept as they are left alone, the rest romanized, "EN " in front. */
export function fakeEnglish(text: string, pairs: readonly [string, string][] = FIXTURE_TERMS, kept: readonly string[] = []): string {
  if (!text) return text;
  // Fix 4: where a name left for later was taken out, a faithful model writes the person plainly (never the mark).
  const swapped = pairs.reduce((out, [from, to]) => out.split(from).join(to), text.replace(/〔[^〕]*〕/gu, 'them'));
  const keep = kept.filter(Boolean);
  const pieces = keep.length ? swapped.split(new RegExp(`(${keep.map(name => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})`, 'u')) : [swapped];
  // Fix 8: a faithful English translation has ASCII punctuation (the conversion now also cleans any full-width mark it is given).
  return asciiPunctuation(`EN ${pieces.map(piece => keep.includes(piece) ? piece : romanize(piece)).join('')}`);
}

/**
 * "Translates" by applying the glossary pairs, leaving names the prompt keeps as they are, romanizing every other Chinese character
 * and prefixing EN (the shape stays; tags are lowercased by the reader). Like a faithful model, it leaves no Chinese behind.
 */
export function makeTranslator(pairs: readonly [string, string][], tweak: (value: any, kind: string, key: string, call: number) => unknown = value => value): ConversionModel {
  let call = 0;
  return async (prompt, system) => {
    call++;
    const between = (open: string, close: string) => prompt.slice(prompt.indexOf(open) + open.length, prompt.lastIndexOf(close)).trim();
    const kept = [...prompt.matchAll(/"([^"\n]+)" stays exactly "/gu)].map(match => match[1]!);
    const en = (value: unknown): unknown => typeof value === 'string' ? fakeEnglish(value, pairs, kept) : Array.isArray(value) ? value.map(en)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, en(item)])) : value;
    if (system.includes('character card')) return JSON.stringify(en(JSON.parse(between('<card>', '</card>'))));
    const { items } = JSON.parse(between('<items>', '</items>')) as { items: { k: string; kind: string; v: unknown }[] };
    return `Here you go:\n\`\`\`json\n${JSON.stringify({ items: items.map(item => ({ k: item.k, v: tweak(en(item.v), item.kind, item.k, call) })) })}\n\`\`\``;
  };
}
export const prefixTranslation: ConversionModel = makeTranslator(FIXTURE_TERMS);

export async function makeFixture(directory: string, options: { model?: ConversionModel; description?: string; wiring?: (wiring: ConversionWiring) => ConversionWiring } = {}): Promise<Fixture> {
  const cards = new CharacterCardStore(directory, 'legacy persona');
  await cards.load({ preinstalledGene: true, freshProfile: true });
  await cards.save({ name: '阿澄', description: options.description ?? '在海边长大的女孩', personality: '安静，爱笑，有点困', scenario: '', greeting: '你来啦', examples: '', systemPrompt: '她叫用户小雨。' });
  const sourceId = cards.publicState().cards.find(card => card.name === '阿澄')!.id;
  const modelPath = path.join(directory, 'models', 'acheng.pmx');
  await cards.bindModel(sourceId, modelPath, 'acheng.pmx');
  await cards.activate(sourceId);
  const companion = new CompanionService(directory, () => {});
  await companion.load();
  const persona = compileCharacterPersona(cards.getActive());
  await companion.context(sourceId, provider, persona);
  // Three chat segments (sealed by starting a new conversation in between).
  for (const [index, text] of sentences.entries()) {
    if (index) await companion.newConversation();
    const turn = await companion.begin(`chat-${index}`, text, persona, () => {}, {});
    turn.push('delta', '嗯，我记住了。'); await turn.finish('complete');
  }
  const scopeKey = companion.memory.noteScope({ characterId: sourceId, providerScope });
  const segments = companion.memory.noteSegments(Date.now()).filter(segment => segment.scope === scopeKey);
  // Her notes for the first two segments.
  const notes = segments.slice(0, 2).map((segment, index) => ({ recordId: segment.id, source: segment.id.slice(0, 8) + '.x', segmentAt: segment.createdAt, writtenAt: Date.now(),
    body: index === 0
      ? { title: '下雨天的书店', summary: '用户说最喜欢下雨天去老城区的书店。', people: [], things: ['书店', '下雨天'], mood: '开心', plans: [], tags: ['书店', '下雨', '老城区'] }
      : { title: '周五面试', summary: '用户周五要去面试，有点紧张，她给他打气。', people: ['小王'], things: ['面试'], mood: '紧张', plans: ['周五面试'], tags: ['面试', '周五', '紧张'] } }));
  await writeFile(path.join(directory, MEMORY_NOTES_FILE), JSON.stringify({ version: 1, notes, deleted: [], parked: [], failed: [], calls: { day: '', count: 0 } }));
  // Familiarity and the two nicknames.
  const today = localDateKey(Date.now());
  await companion.relationship.seed(sourceId, { version: 1, metDate: daysAgoKey(20), days: [daysAgoKey(20), daysAgoKey(2)],
    qualityDays: [daysAgoKey(2)], today: { date: today, rounds: 1, touched: false }, backfilled: [], nickname: null, herNickname: null, nicknameAsked: false, milestones: [] });
  await companion.relationship.setNickname(sourceId, '小雨');
  await companion.relationship.noteHerNickname(sourceId, '澄澄');
  // Her profile and three diary days (one with an in-joke).
  const profiles = new UserProfileStore(path.join(directory, 'user-profiles'));
  await profiles.activate({ characterId: sourceId, providerScope }); profiles.setEnabled(true);
  const body = '我在学钢琴。';
  const ticket = profiles.beginObservation(profiles.acceptUserMessage({ requestId: 'fact-1', messageId: 'm-1', source: 'text', text: body, acceptedAt: Date.now() }));
  await profiles.completeObservation(ticket!, 'fact-1', [{ kind: 'fact', quoteStart: 0, quoteEnd: body.length }]);
  for (const back of [3, 2, 1]) await profiles.saveDiary(profiles.diaryTicket()!, daysAgoKey(back), `第${back}天：今天和小雨聊了书店和面试。`, back === 1 ? '抢不到的布丁' : undefined);
  await Promise.all([companion.flush(), companion.relationship.flush()]);
  await profiles.settled?.();
  // A voice of her own: Bailian style text, a Drama 3 voice id and acting style; keys and the monthly cap must never be touched.
  const tts: TtsConfig = { ...structuredClone(DEFAULT_TTS_CONFIG) as TtsConfig, provider: 'fish', apiKey: '••••', fishApiKey: '••••', fishMonthlyCapUsd: 7,
    styleBindings: [{ characterId: sourceId, modelPath, voice: 'longanlingxin_v3.1', instruction: '温柔，有点困，句尾拖一点', emotion: 'gentle', rate: 1.1,
      fishVoiceId: 'privatevoice123', fishActingStyle: '平时一直有点困的语气' }] };
  const settings = { current: { tts, model: { path: modelPath } } as unknown as AppSettings };
  const model = { current: options.model ?? prefixTranslation, calls: [] as { system: string; prompt: string }[] };
  const registered = new Map<string, (...args: any[]) => unknown>();
  const sent: string[] = [];
  const views: ConversionJobView[] = [];
  let wiring: ConversionWiring = {
    characterCards: () => cards,
    addCard: (id, draft, link) => cards.addConverted(id, draft, link),
    removeCard: id => cards.remove(id),
    memory: () => companion.memory, relationship: () => companion.relationship, profiles: () => profiles,
    providerScopes: () => forgettableProviderScopes(provider, memoryProviderScope), currentProviderScope: () => providerScope,
  };
  if (options.wiring) wiring = options.wiring(wiring);
  const service = createConversion({ profileDirectory: directory, wiring, settings: () => structuredClone(settings.current),
    saveSettings: async next => { settings.current = structuredClone(next); }, modelChoice: () => ({ model: 'sonnet', effort: 'low' }),
    emit: view => views.push(view), register: (name, run) => registered.set(name, run), send: async text => { sent.push(text); return null; }, uiLanguage: () => 'zh-CN',
  }, (prompt, system, signal) => { model.calls.push({ system, prompt }); return model.current(prompt, system, signal); });
  return { directory, cards, companion, profiles, sourceId, modelPath, settings, registered, sent, views, wiring, service, model };
}

export const ALL_KEPT = [{ id: 'her-name' as const, to: 'Cheng' }, { id: 'her-nickname' as const, to: '澄澄' }, { id: 'user-nickname' as const, to: 'Rainy' }];
