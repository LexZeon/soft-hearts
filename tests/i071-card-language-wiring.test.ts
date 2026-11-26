/**
 * I-071 v2 step 1: where the card's language reaches: the session opening line, the channel's list_characters and card update, the system voice.
 * Real createHostBridge / createAppTools over fake IPC handlers; no Claude.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { AppSettings } from '../shared/foundation/settings';
import { ENGLISH_SESSION_LINE, chatLanguageSessionLine } from '../shared/brain/chat-language';
import { AgentToolRegistry } from '../electron/safety/agent-channel/registry';
import { createAppTools } from '../electron/safety/agent-channel/app-tools';
import { createHostBridge, type IpcHandler } from '../electron/safety/agent-channel/bridge';
import { NEUTRAL_TENDENCIES, relationshipOpeningText, todayLine } from '../shared/memory/relationship';
import { RelationshipHost } from '../electron/memory/relationship/host';
import { effectiveTtsConfig, DEFAULT_TTS_CONFIG } from '../shared/voice/tts';
import { pickSystemVoice, fallbackUtteranceLang, setSpeechLanguage, speechLanguage } from '../src/voice/voice-language';
import { cardLanguageOf } from '../shared/foundation/character-card';

function host(cards: { activeId: string; cards: any[] }) {
  const settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
  const handlers: Record<string, (...args: any[]) => unknown> = { getSettings: () => structuredClone(settings), saveSettings: next => next, getCharacterCards: () => structuredClone(cards) };
  const operations = new Map<string, IpcHandler>(Object.entries(handlers).map(([name, run]) => [name, (_event: any, ...args: unknown[]) => run(...args)]));
  const window = (id: number) => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id, isDestroyed: () => false, send() {} } });
  const bridge = createHostBridge({ version: () => '0', controls: () => window(11), pet: () => window(12), operations,
    admit: (guard, run) => { guard(); return run(); }, importCharacterCard: async () => { throw new Error('x'); },
    loadModel: async () => { throw new Error('x'); },
    commitPetBoolean: async () => { throw new Error('x'); }, commitReadoutVolume: async () => { throw new Error('x'); }, commitBreath: async () => { throw new Error('x'); },
    replyLatency: () => [], broadcast: () => {}, interconnected: () => true });
  const tools = createAppTools({ ...bridge, now: () => 0 });
  const registry = new AgentToolRegistry(tools, { enabled: () => true, interconnect: () => true, confirm: async () => true, notice: () => {}, called: () => {} });
  return { call: (name: string, args: unknown): Promise<any> => registry.call(name, args) };
}

test('session line: an English card only; it says she always answers in English and that her memories are English, never Chinese ones', () => {
  assert.equal(chatLanguageSessionLine('en'), ENGLISH_SESSION_LINE);
  assert.match(ENGLISH_SESSION_LINE, /always answer in English/);
  assert.ok(!/Chinese/.test(ENGLISH_SESSION_LINE), 'no invitation to use Chinese memories');
  assert.equal(chatLanguageSessionLine('zh-CN'), '', 'a Chinese card adds nothing');
  const base = { dayNumber: 12, slowWarmUp: false } as const;
  const date = todayLine(new Date(2026, 10, 10, 15).getTime());
  const chinese = relationshipOpeningText({ ...base, dateLine: date });
  assert.equal(relationshipOpeningText({ ...base, dateLine: date, languageLine: '' }), chinese);
  assert.equal(relationshipOpeningText({ ...base, dateLine: date, languageLine: ENGLISH_SESSION_LINE }), `${chinese}\n${ENGLISH_SESSION_LINE}`);
});

test('the relationship host adds the line only for an English card, and a broken source is Chinese', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i071-rel-'));
  try {
    const rel = new RelationshipHost({ directory, now: () => new Date(2026, 10, 10, 15).getTime(), developerMode: () => false, diagnosticsWrite: async () => {} });
    rel.setCardSource(() => ({ slowWarmUp: false, tendencies: { ...NEUTRAL_TENDENCIES } }));
    await rel.prepare({ characterId: 'gene', providerScope: 'model-a' }, () => ({ first: null, rounds: new Map<string, number>() }));
    const chinese = rel.opening('gene', { firstTurn: false })?.text ?? '';
    assert.ok(chinese.length > 0 && !chinese.includes(ENGLISH_SESSION_LINE));
    rel.setLanguageSource(() => 'en');
    const english = rel.opening('gene', { firstTurn: false })?.text ?? '';
    assert.ok(english.endsWith(`\n${ENGLISH_SESSION_LINE}`));
    assert.ok(english.includes('[Today] Tuesday, 10 November, afternoon.') && !english.includes('【今天】'));
    rel.setLanguageSource(() => { throw new Error('boom'); });
    assert.equal(rel.opening('gene', { firstTurn: false })?.text, chinese);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test("list_characters reports each card's language, without card text", async () => {
  const A = '0f8fad5b-d9cb-469f-a165-70867728950e', B = '7c9e6679-7425-40de-944b-e07fc1f90ae7', C = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
  const h = host({ activeId: A, cards: [
    { id: A, name: 'Gene (English)', description: 'private words', language: 'en' },
    { id: B, name: '小桃', description: 'more private words' },
    { id: C, name: '小满', description: 'x', language: 'zh-CN' },
  ] });
  const result = (await h.call('list_characters', {})).result;
  assert.deepEqual(result.characters.map((item: any) => [item.id, item.language]), [[A, 'en'], [B, 'zh-CN'], [C, 'zh-CN']]);
  assert.ok(!JSON.stringify(result).includes('private words'));
});

test('the channel catalog says update_character_card can set the language, and the old settings/args are gone', () => {
  const catalog = JSON.parse(readFileSync(path.join(process.cwd(), 'shared/safety/agent-channel-catalog.json'), 'utf8'));
  const update = catalog.tools.find((tool: any) => tool.name === 'update_character_card');
  assert.match(update.description, /language/);
  assert.ok(catalog.tools.find((tool: any) => tool.name === 'list_characters').description.includes('language'));
  assert.ok(!catalog.settings.some((setting: any) => setting.id === 'chat_language'), 'no chat_language setting');
  const voice = catalog.tools.find((tool: any) => tool.name === 'set_voice_style');
  assert.ok(!('language' in voice.inputSchema.properties), 'no per-language voice');
});

test('voice: no per-language overlay; the effective config is exactly what it was', () => {
  const config = structuredClone(DEFAULT_TTS_CONFIG) as any;
  assert.equal(effectiveTtsConfig.length, 3, 'three parameters, as on main');
  assert.deepEqual(effectiveTtsConfig(config, 'c1', 'm.pmx'), { ...config });
  assert.ok(!('providerByLanguage' in config));
});

test("system voice by the card's language: Chinese exactly as before; English keeps an English chosen voice, else the first English one", () => {
  const voices = [{ voiceURI: 'zh-a', lang: 'zh-CN' }, { voiceURI: 'en-a', lang: 'en-US' }, { voiceURI: 'en-b', lang: 'en-GB' }];
  // Chinese (the default): the chosen voice even if it is English, else the first Chinese one, else nothing.
  assert.equal(pickSystemVoice(voices, 'en-b', 'zh-CN')?.voiceURI, 'en-b');
  assert.equal(pickSystemVoice(voices, 'missing', 'zh-CN')?.voiceURI, 'zh-a');
  assert.equal(pickSystemVoice([{ voiceURI: 'en-a', lang: 'en-US' }], 'missing', 'zh-CN'), null);
  // English.
  assert.equal(pickSystemVoice(voices, 'en-b', 'en')?.voiceURI, 'en-b');
  assert.equal(pickSystemVoice(voices, 'zh-a', 'en')?.voiceURI, 'en-a', 'a Chinese voice is not used for an English card');
  assert.equal(pickSystemVoice(voices, 'missing', 'en')?.voiceURI, 'en-a');
  assert.equal(pickSystemVoice([{ voiceURI: 'zh-a', lang: 'zh-CN' }], 'zh-a', 'en')?.voiceURI, 'zh-a', 'no English voice at all: the chosen one rather than silence');
  assert.equal(fallbackUtteranceLang('en'), 'en-US');
  assert.equal(fallbackUtteranceLang('zh-CN'), 'zh-CN');
  assert.equal(speechLanguage(), 'zh-CN');
  setSpeechLanguage('en'); assert.equal(speechLanguage(), 'en'); assert.equal(pickSystemVoice(voices, 'zh-a')?.voiceURI, 'en-a');
  setSpeechLanguage(cardLanguageOf(undefined)); assert.equal(speechLanguage(), 'zh-CN');
});
