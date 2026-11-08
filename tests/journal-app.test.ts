// 体验记录 (E2) in the app: the switch (default off, its own intent), the agent channel's reversible setting, the IPC handlers,
// the music tier from the pet window and the start/quit lines (electron/journal/app-journal.ts).
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { AppJournal, readBuildCommit, registerJournalIpc } from '../electron/journal/app-journal';
import { createAppTools, settingViews, type AgentAppBridge } from '../electron/agent-channel/app-tools';
import { AGENT_HOST_OPERATIONS, createHostBridge } from '../electron/agent-channel/bridge';
import { AgentToolRegistry } from '../electron/agent-channel/registry';
import { chatSettingsSystemText, parseChatSettingProposal } from '../electron/chat-settings';
import { validateSettings } from '../electron/validation';
import { AGENT_SETTINGS, AGENT_TOOLS, agentSetting, validateAgentSettingValue } from '../shared/agent-channel';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { AppSettings } from '../shared/contracts';
import type { JournalView } from '../shared/journal';

async function profile(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sh-journal-app-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const lines = async (directory: string) => {
  const names = await readdir(path.join(directory, 'journal')).catch(() => []);
  const all = await Promise.all(names.map(name => readFile(path.join(directory, 'journal', name), 'utf8')));
  return all.join('').split('\n').filter(Boolean).map(line => JSON.parse(line));
};

test('the setting is off by default, comes only from the stored file, and the agent channel lists it as reversible', () => {
  assert.equal(DEFAULT_SETTINGS.experienceJournal, false);
  const old = structuredClone(DEFAULT_SETTINGS) as Partial<AppSettings>; delete old.experienceJournal;
  assert.equal(validateSettings(old).experienceJournal, false, 'an older settings file gets off');
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, experienceJournal: true }).experienceJournal, true);
  for (const value of ['true', 1, {}, null]) assert.equal(validateSettings({ ...DEFAULT_SETTINGS, experienceJournal: value }).experienceJournal, false, String(value));
  const spec = agentSetting('experience_journal')!;
  assert.equal(spec.tier, 'reversible'); assert.equal(spec.kind, 'boolean');
  assert.equal(validateAgentSettingValue(spec, true), true);
  assert.throws(() => validateAgentSettingValue(spec, 'on'));
  const tool = AGENT_TOOLS.find(item => item.name === 'set_setting')!;
  assert.deepEqual((tool.inputSchema.properties.id as { enum: string[] }).enum, AGENT_SETTINGS.map(item => item.id), 'the schema lists every catalog setting');
  assert.equal(settingViews({ ...DEFAULT_SETTINGS, experienceJournal: true }).find(view => view.id === 'experience_journal')?.value, true);
  assert.equal(settingViews(DEFAULT_SETTINGS).find(view => view.id === 'experience_journal')?.value, false);
  // The agent channel only: the pet's own chat never offers it (her system prompt stays byte for byte the same).
  assert.ok(!chatSettingsSystemText().includes('experience_journal'));
  assert.equal(parseChatSettingProposal(JSON.stringify({ id: 'experience_journal', value: true }), () => false), null);
  assert.ok(AGENT_HOST_OPERATIONS.includes('setExperienceJournal'));
});

test('set_setting reaches only setExperienceJournal and reports the change once, with where it came from', async () => {
  const settings = { ...DEFAULT_SETTINGS, experienceJournal: false };
  const calls: boolean[] = [], changes: unknown[][] = [];
  const bridge = {
    version: () => 't', settings: () => settings, characters: () => ({ cards: [], activeId: '' }), windows: () => ({ pet: null, controls: null }),
    activateCharacter: async () => {}, bindCurrentModel: async () => {}, setPetVisible: async () => {}, saveSettings: async () => { throw new Error('never the whole form'); },
    commitPetBoolean: async () => ({ persistence: 'saved', presentation: '' }), commitReadoutVolume: async () => ({ persistence: 'saved', presentation: '' }),
    commitBreath: async () => ({ persistence: 'saved', presentation: '' }), importCharacterCard: async () => ({ cards: [], activeId: '' }), loadModel: async () => ({ name: 'm' }),
    rendererAction: () => true, diagnostics: () => ({ replyLatency: [], petWindow: { enabled: false, entries: 0 } }),
    setExperienceJournal: async (value: boolean) => { calls.push(value); settings.experienceJournal = value; },
    settingChanged: (...args: unknown[]) => { changes.push(args); },
  } as unknown as AgentAppBridge;
  for (const via of ['agent', 'chat'] as const) {
    const tools = createAppTools(bridge, via === 'chat' ? { settingVia: 'chat' } : {});
    const registry = new AgentToolRegistry(tools.filter(tool => tool.name === 'set_setting'), { enabled: () => true, confirm: async () => { throw new Error('reversible: no dialog'); } });
    const result = await registry.call('set_setting', { id: 'experience_journal', value: via === 'agent' }) as { ok: boolean; result: { previous: unknown; value: unknown } };
    assert.equal(result.ok, true, via);
    const bad = await registry.call('set_setting', { id: 'experience_journal', value: 'yes' }) as { ok: boolean };
    assert.equal(bad.ok, false);
  }
  assert.deepEqual(calls, [true, false]);
  assert.deepEqual(changes, [['experience_journal', false, true, 'agent'], ['experience_journal', true, false, 'chat']]);
});

test('the bridge calls the host\'s own setExperienceJournal operation as the control window, under the call guard', async () => {
  const seen: unknown[][] = [];
  const operations = new Map<string, (event: any, ...args: any[]) => unknown>([['setExperienceJournal', (event, ...args) => { seen.push([event.sender.id, ...args]); }]]);
  const window = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id: 7, isDestroyed: () => false, send: () => {} } };
  const bridge = createHostBridge({ version: () => '1', controls: () => window, pet: () => window, operations, admit: (_guard, run) => run(),
    importCharacterCard: async () => ({ cards: [], activeId: '' }) as never, loadModel: async () => ({ name: 'm' } as never),
    commitPetBoolean: async () => ({ persistence: 'saved', presentation: '' }), commitReadoutVolume: async () => ({ persistence: 'saved', presentation: '' }),
    commitBreath: async () => ({ persistence: 'saved', presentation: '' }), replyLatency: () => [], broadcast: () => {} });
  await bridge.setExperienceJournal!(true, () => {});
  assert.deepEqual(seen, [[7, true]]);
  await assert.rejects(bridge.setExperienceJournal!(false, () => { throw new Error('closed'); }), /closed/);
  assert.equal(seen.length, 1);
});

test('the IPC switch: off writes its last line first, on writes its first line, nothing changes for a wrong value', async t => {
  const directory = await profile(t), state = { on: false }, handlers = new Map<string, (...args: any[]) => unknown>(), published: JournalView[] = [];
  const journal = new AppJournal({ profileDirectory: () => directory, enabled: () => state.on, characters: () => ({ cards: [{ id: 'gene', name: 'Gene' }] as never }),
    publish: view => published.push(view), publishDelayMs: 0 });
  let queue = Promise.resolve();
  registerJournalIpc((method, operation) => handlers.set(method, operation), { journal, enabled: () => state.on, characterId: () => 'gene',
    mutate: run => { const next = queue.then(run); queue = next.then(() => {}, () => {}); return next; }, persist: async value => { state.on = value; } });
  await assert.rejects(handlers.get('setExperienceJournal')!('on') as Promise<unknown>, /开关不正确/);
  assert.equal(state.on, false);
  journal.record({ type: 'mood-label', characterId: 'gene', from: 'calm', to: 'happy' });
  const onView = await handlers.get('setExperienceJournal')!(true) as JournalView;
  assert.equal(onView.enabled, true);
  journal.record({ type: 'mood-label', characterId: 'gene', from: 'calm', to: 'happy' });
  await handlers.get('setExperienceJournal')!(true);
  const offView = await handlers.get('setExperienceJournal')!(false) as JournalView;
  assert.equal(offView.enabled, false); assert.deepEqual(offView.entries, []);
  journal.record({ type: 'mood-label', characterId: 'gene', from: 'calm', to: 'happy' });
  await journal.flush();
  assert.deepEqual((await lines(directory)).map(entry => [entry.type, entry.event ?? entry.to]), [['journal', 'on'], ['mood-label', 'happy'], ['journal', 'off']]);
  assert.deepEqual((handlers.get('getJournal')!() as JournalView).characters, [{ id: 'gene', name: 'Gene' }]);
  assert.ok(published.length >= 2);
});

test('music tier from the pet: a closed tier and a score, a repeat or a burst is ignored; start and quit once each', async t => {
  const directory = await profile(t), clock = { now: 1_000_000 };
  const journal = new AppJournal({ profileDirectory: () => directory, enabled: () => true, characters: () => null, publish: () => {}, clock: () => clock.now, publishDelayMs: 0 });
  assert.equal(journal.musicTier({ tier: 'dance', score: 0.8 }, null), false, 'no character');
  for (const bad of [null, 'dance', { tier: 'jump' }, { tier: 'dance', score: 1, path: 'x' }, ['dance']]) assert.equal(journal.musicTier(bad, 'gene'), false);
  assert.equal(journal.musicTier({ tier: 'nod', score: 0.42 }, 'gene'), true);
  assert.equal(journal.musicTier({ tier: 'nod', score: 0.5 }, 'gene'), false, 'the same tier again');
  assert.equal(journal.musicTier({ tier: 'dance', score: 0.9 }, 'gene'), false, 'sooner than a second');
  clock.now += 1_500;
  assert.equal(journal.musicTier({ tier: 'dance', score: 7 }, 'gene'), true);
  journal.appStarted('0.1.0', 'b74e371', 'gene');
  journal.appQuitting('0.1.0', 'b74e371', 'gene'); journal.appQuitting('0.1.0', 'b74e371', 'gene');
  journal.setting('fps', 60, 60, 'agent', 'gene');
  await journal.flush();
  const written = await lines(directory);
  assert.deepEqual(written.map(entry => [entry.type, entry.tier ?? entry.event, entry.score ?? null]), [['music', 'nod', 0.42], ['music', 'dance', 1], ['app', 'start', null], ['app', 'quit', null]]);
  assert.equal(written[2].commit, 'b74e371');
});

test('the build commit comes from build-info.json and is dropped when it is not a commit', async t => {
  const directory = await profile(t), file = path.join(directory, 'build-info.json');
  assert.equal(readBuildCommit(file), null);
  await writeFile(file, JSON.stringify({ commit: 'b74e3710aa', builtAt: 'x' }));
  assert.equal(readBuildCommit(file), 'b74e3710aa');
  await writeFile(file, JSON.stringify({ commit: 'main; rm -rf /' }));
  assert.equal(readBuildCommit(file), null);
  const build = await readFile(new URL('../scripts/build-electron.mjs', import.meta.url), 'utf8');
  assert.match(build, /dist-electron\/build-info\.json/);
});
