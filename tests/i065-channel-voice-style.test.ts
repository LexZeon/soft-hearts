// I-065: the user's own Claude can take them to a page of the control window (open_control_page, her 「带我去」)
// and set Bailian's model, voice and style (set_voice_style). The key, the API host and the region never move through either.
// The real createHostBridge and registry over fake IPC handlers, as the control window's main frame; no window, no profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { AppSettings } from '../shared/foundation/settings';
import { AGENT_TOOLS } from '../shared/safety/agent-channel';
import { TAKE_ME_THERE_IDS } from '../shared/initiative/take-me-there';
import { AgentToolRegistry } from '../electron/safety/agent-channel/registry';
import { createAppTools } from '../electron/safety/agent-channel/app-tools';
import { AGENT_HOST_OPERATIONS, createHostBridge, type IpcHandler } from '../electron/safety/agent-channel/bridge';

const CARD = '0f8fad5b-d9cb-469f-a165-70867728950e', OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const KEY = 'saved-key-marker';

function host() {
  let settings: AppSettings = { ...structuredClone(DEFAULT_SETTINGS), model: { path: 'C:\\m\\aoi.pmx', url: 'local://aoi', name: 'aoi.pmx' } as any,
    tts: { ...structuredClone(DEFAULT_SETTINGS.tts ?? {}), provider: 'bailian', apiHost: 'https://dashscope.example', region: 'cn-beijing', apiKey: KEY,
      model: 'qwen-audio-3.1-tts-flash', voice: 'longanlingxin_v3.1', instruction: '', emotion: 'custom', rate: 1,
      styleBindings: [{ characterId: OTHER, modelPath: 'C:\\m\\other.pmx', voice: 'other_voice', instruction: '别人的', emotion: 'calm', rate: 0.9 }] } as any };
  const cards = { activeId: CARD, cards: [{ id: CARD, name: '小桃', modelName: 'aoi.pmx' } as any] };
  const calls: Array<[string, ...unknown[]]> = [], senders = new Set<number>();
  const handlers: Record<string, (...args: any[]) => unknown> = {
    getSettings: () => structuredClone(settings),
    saveSettings: next => { calls.push(['saveSettings']); settings = structuredClone(next); return settings; },
    getCharacterCards: () => structuredClone(cards),
    openControls: (...args: unknown[]) => { calls.push(['openControls', ...args]); },
  };
  const operations = new Map<string, IpcHandler>(Object.entries(handlers).map(([name, run]) =>
    [name, (event: any, ...args: unknown[]) => { senders.add(event.sender.id); return run(...args); }]));
  const window = (id: number) => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id, isDestroyed: () => false, send() {} } });
  const bridge = createHostBridge({ version: () => '0', controls: () => window(11), pet: () => window(12), operations,
    admit: (guard, run) => { guard(); return run(); }, importCharacterCard: async () => { throw new Error('x'); },
    loadModel: async () => { throw new Error('x'); }, commitPetBoolean: async () => { throw new Error('x'); },
    commitReadoutVolume: async () => { throw new Error('x'); }, commitBreath: async () => { throw new Error('x'); },
    replyLatency: () => [], broadcast: () => {}, interconnected: () => true });
  let undo: { label: string; run(guard: () => void): unknown } | undefined;
  const registry = new AgentToolRegistry(createAppTools(bridge), { enabled: () => true, interconnect: () => true,
    confirm: async () => true, notice: () => {}, called: (_summary, offer) => { undo = offer; } });
  return { call: (name: string, args: unknown): Promise<any> => registry.call(name, args), calls, senders, settings: () => settings,
    set: (next: AppSettings) => { settings = next; }, undo: () => undo };
}

test('open_control_page opens one 「带我去」 page through openControls as the control window, and changes nothing else', async () => {
  assert.ok(AGENT_HOST_OPERATIONS.includes('openControls'));
  const catalog = AGENT_TOOLS.find(tool => tool.name === 'open_control_page')!;
  assert.deepEqual((catalog.inputSchema as any).properties.page.enum, TAKE_ME_THERE_IDS, 'the catalog lists exactly the 「带我去」 pages');
  const h = host(), before = structuredClone(h.settings());
  const result = await h.call('open_control_page', { page: 'bailian-key' });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.result.title, '百炼语音');
  assert.deepEqual(h.calls, [['openControls', 'bailian-key']]);
  assert.deepEqual([...h.senders], [11]);
  assert.deepEqual(h.settings(), before);
  for (const bad of [{ page: 'settings-everything' }, { page: 'bailian-key', key: 'x' }, {}]) {
    const refused = await h.call('open_control_page', bad);
    assert.equal(refused.ok, false, JSON.stringify(bad));
  }
  assert.equal(h.calls.length, 1);
});

test('set_voice_style writes the model (shared) and this character + model\'s voice and style; the key, host and region stay', async () => {
  const h = host();
  const result = await h.call('set_voice_style', { model: 'qwen-tts-x', voice: 'longxiaochun_v2', emotion: 'gentle', instruction: '  轻声一点，像在耳边说  ', rate: 1.234 });
  assert.ok(result.ok, JSON.stringify(result));
  const tts = h.settings().tts as any;
  assert.equal(tts.model, 'qwen-tts-x');
  assert.deepEqual([tts.provider, tts.apiHost, tts.region, tts.apiKey], ['bailian', 'https://dashscope.example', 'cn-beijing', KEY]);
  assert.deepEqual([tts.voice, tts.instruction, tts.emotion, tts.rate], ['longanlingxin_v3.1', '', 'custom', 1], 'the defaults stay for other characters');
  const mine = tts.styleBindings.find((b: any) => b.characterId === CARD);
  assert.deepEqual(mine, { characterId: CARD, modelPath: 'C:\\m\\aoi.pmx', voice: 'longxiaochun_v2', instruction: '轻声一点，像在耳边说', emotion: 'gentle', rate: 1.23 });
  assert.ok(tts.styleBindings.some((b: any) => b.characterId === OTHER && b.voice === 'other_voice'), 'another character keeps its own');
  assert.equal(JSON.stringify(result.result).includes(KEY), false, 'the answer never carries the key');
  // A partial change keeps the rest of this binding.
  assert.ok((await h.call('set_voice_style', { rate: 0.8 })).ok);
  assert.equal((h.settings().tts as any).styleBindings.find((b: any) => b.characterId === CARD).voice, 'longxiaochun_v2');
});

test('set_voice_style can be undone while nobody changed it since, and refuses bad input without saving', async () => {
  const h = host();
  assert.ok((await h.call('set_voice_style', { voice: 'longxiaochun_v2' })).ok);
  await h.undo()!.run(() => {});
  assert.equal((h.settings().tts as any).styleBindings.find((b: any) => b.characterId === CARD).voice, 'longanlingxin_v3.1');
  // Changed again by hand after the call: the undo of that call does not overwrite it.
  assert.ok((await h.call('set_voice_style', { voice: 'aaa' })).ok);
  const stale = h.undo()!;
  const now = structuredClone(h.settings()); (now.tts as any).styleBindings.find((b: any) => b.characterId === CARD).voice = 'set_by_hand'; h.set(now);
  await assert.rejects(Promise.resolve(stale.run(() => {})), /又改过了/);
  const saves = h.calls.length;
  for (const bad of [{}, { voice: 'has space' }, { model: 'x/../y' }, { emotion: 'angry' }, { rate: 3 }, { rate: '1' }, { instruction: 'a\u0007b' },
    { instruction: 'x'.repeat(1001) }, { apiKey: 'sk-123' }, { apiHost: 'https://evil.example' }, { region: 'x' }]) {
    const refused = await h.call('set_voice_style', bad);
    assert.equal(refused.ok, false, JSON.stringify(bad));
  }
  assert.equal(h.calls.length, saves, 'nothing saved for refused input');
});
