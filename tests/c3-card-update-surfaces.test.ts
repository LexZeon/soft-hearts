// C3 用角色卡文件原地更新: the two ways in. The agent channel's update_character_card (confirm tier: the dialog names the
// file, its place, her and what changes; deny, timeout, a file changed after the OK and a channel closed before the commit
// all change nothing; the audit keeps no path or text) and the 角色页's "用角色卡文件更新…" (asks on her tile, flags a
// different name, updates only on OK). Real card stores and the real tool, bridge and host actions; synthetic cards only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore } from '../electron/character-cards';
import { CharacterResponseStore } from '../electron/character-response';
import { CharacterCardUpdater } from '../electron/character-card-update';
import { MutationQueue } from '../electron/mutation-queue';
import { AgentToolRegistry, AGENT_CHANNEL_CLOSED, type AgentAuditEntry, type AgentConfirmRequest } from '../electron/agent-channel/registry';
import { createAppTools, type CommitResult } from '../electron/agent-channel/app-tools';
import { createHostBridge, type IpcHandler } from '../electron/agent-channel/bridge';
import { agentHostActions, type AgentHostActionPorts } from '../electron/agent-channel/host-actions';
import type { FileSystemPort } from '../electron/agent-channel/validate';
import { AGENT_TOOLS } from '../shared/agent-channel';
import { CHARACTER_CARD_FORMAT, defaultCharacterMoodTemplate, type CharacterCardState } from '../shared/character-cards';
import { planCharacterCardUpdate, type CharacterCardUpdatePreview } from '../shared/character-card-update';
import { defaultCharacterResponseProfile } from '../shared/character-response';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { registerUiMessages, setUiLanguage } from '../shared/ui-language';
import { ENGLISH_CHARACTER_UI_COPY } from '../shared/ui-copy.character.en';
import { CharacterPage, type CharacterPageApi } from '../src/ui/CharacterPage';
import type { CharacterRosterView } from '../shared/character-roster';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out waiting'); await tick(); }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const text = (name: string, personality = '') => ({ name, description: '', personality, scenario: '', greeting: '', examples: '', systemPrompt: '' });
const v2File = (name: string, personality: string) => JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 2, card: { ...text(name, personality), mood: defaultCharacterMoodTemplate() } });

// ---- the agent channel ----

async function agentFixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-card-update-agent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cards = new CharacterCardStore(directory, 'legacy persona');
  await cards.load();
  await cards.save({ ...text('阿澄', '安静'), mood: defaultCharacterMoodTemplate() });
  const id = cards.publicState().cards.find(card => card.name === '阿澄')!.id;
  const responses = new CharacterResponseStore(directory, () => cards.publicState().cards.map(card => card.id));
  await responses.load();
  const updater = new CharacterCardUpdater({ cards, responses, directory });
  const mutations = new MutationQueue();
  const log: string[] = [];
  const unused = async (): Promise<never> => { throw new Error('unused'); };
  const saved: CommitResult = { persistence: 'saved', presentation: 'applied' };
  const ports: AgentHostActionPorts = {
    mutations, registerAsset: unused, noteModelSelection: () => {}, persistModel: unused, sync: () => {}, importCharacterCard: unused,
    // main.ts updateCharacterCardContent: queued synchronously on the host's one mutation queue.
    updateCharacterCard: (cardId, content, expected) => mutations.run(async () => {
      log.push('update');
      const result = await updater.update(cardId, content, expected);
      return { state: result.state, summary: result.summary };
    }),
    commitPetBoolean: async () => saved, commitReadoutVolume: async () => saved, commitBreath: async () => saved,
  };
  const window = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id: 7, isDestroyed: () => false, send: () => {} } };
  const operations = new Map<string, IpcHandler>([['getSettings', () => structuredClone(DEFAULT_SETTINGS)], ['getCharacterCards', () => cards.publicState()]]);
  const bridge = createHostBridge({ version: () => 'test', controls: () => window, pet: () => window, operations, replyLatency: () => [], broadcast: () => {},
    planCharacterCardUpdate: (cardId, content) => updater.plan(cardId, content), ...agentHostActions(ports) });
  const file = { size: 300, mtimeMs: 1, content: v2File('阿澄', '安静，也会撒娇'), shiftAfterReads: Infinity, reads: 0 };
  const fs: FileSystemPort = { realpath: async value => value, stat: async () => {
    file.reads++;
    return { isFile: () => true, size: file.size, mtimeMs: file.reads > file.shiftAfterReads ? file.mtimeMs + 1 : file.mtimeMs };
  } };
  const tools = createAppTools(bridge, { fs, platform: 'win32', readText: async () => file.content });
  const audit: AgentAuditEntry[] = [], asked: AgentConfirmRequest[] = [], answers: Array<(value: boolean) => void> = [];
  let enabled = true;
  const registry = new AgentToolRegistry(tools, { enabled: () => enabled, confirmTimeoutMs: 300, audit: entry => audit.push(entry),
    confirm: request => { asked.push(request); return new Promise<boolean>(resolve => answers.push(resolve)); } });
  const stored = () => readFile(path.join(directory, 'characters.json'));
  return { directory, cards, id, registry, audit, asked, answers, file, log, mutations, stored, close: () => { enabled = false; registry.revoke(); } };
}
const PATH = 'C:\\cards\\阿澄 new.json';

test('update_character_card asks with the file, its place, her name and what changes; only an OK updates her, in place', async t => {
  const f = await agentFixture(t);
  f.file.content = v2File('菲菲', '安静，也会撒娇');
  const call = f.registry.call('update_character_card', { id: f.id, path: PATH });
  await until(() => f.asked.length === 1);
  const { title, detail } = f.asked[0];
  assert.match(title, /名字不一样/);
  assert.match(detail, /要更新的角色：阿澄（原地更新，还是同一个她）/);
  assert.match(detail, /文件：阿澄 new\.json/); assert.match(detail, /位置：C:\\cards/);
  assert.match(detail, /⚠ 名字不一样：文件里叫「菲菲」，现在叫「阿澄」/);
  assert.match(detail, /会换成文件里的：性格与说话方式。/);
  assert.match(detail, /她的聊天、日记、画像、熟悉度和昵称都会保留/);
  assert.equal(f.log.length, 0, 'nothing happens before the OK');
  f.answers[0](true);
  const result = await call;
  assert.equal(result.ok, true, JSON.stringify(result));
  const value = (result as { result: any }).result;
  assert.deepEqual(value.updated, { id: f.id, name: '菲菲' });
  assert.equal(value.nameChanged, true);
  assert.deepEqual(value.changedFields, ['name', 'personality']);
  assert.equal(f.cards.publicState().cards.length, 2, 'no new card');
  assert.equal(f.cards.publicState().cards.find(card => card.id === f.id)!.personality, '安静，也会撒娇');
  assert.equal((await readdir(f.directory)).filter(name => name.startsWith('characters.before-update-')).length, 1);
  // The audit has the tool and the outcome only: no path, file name, persona text or card name.
  assert.deepEqual(f.audit.map(entry => [entry.tool, entry.tier, entry.outcome]), [['update_character_card', 'confirm', 'allowed']]);
  const audit = JSON.stringify(f.audit);
  for (const forbidden of ['cards', 'new.json', '阿澄', '菲菲', '撒娇', f.id]) assert.ok(!audit.includes(forbidden), forbidden);
});

test('update_character_card: deny, no answer for the time limit, and a file changed after the OK all change nothing', async t => {
  const f = await agentFixture(t);
  const before = await f.stored();
  const denied = f.registry.call('update_character_card', { id: f.id, path: PATH });
  await until(() => f.asked.length === 1); f.answers[0](false);
  assert.equal(((await denied) as any).error.code, 'denied_by_user');
  const timedOut = await f.registry.call('update_character_card', { id: f.id, path: PATH });
  assert.equal((timedOut as any).error.code, 'confirm_timeout', '60 s in the app (300 ms here) without an answer is a no');
  f.answers[1]?.(true); await tick();
  // Changed on disk between the dialog and the update (its stat is read again after the OK).
  f.file.shiftAfterReads = f.file.reads + 1;
  const raced = f.registry.call('update_character_card', { id: f.id, path: PATH });
  await until(() => f.asked.length === 3); f.answers[2](true);
  const racedResult = await raced as any;
  assert.equal(racedResult.error.code, 'unavailable');
  assert.match(racedResult.error.message, /确认之后被改动/);
  assert.deepEqual(await f.stored(), before);
  assert.deepEqual(f.log, []);
  assert.equal(f.cards.publicState().cards.find(card => card.id === f.id)!.personality, '安静');
});

test('update_character_card: closing the channel abandons an approved update still waiting for its turn; nothing is written', async t => {
  const f = await agentFixture(t);
  const before = await f.stored();
  const busy = deferred();
  const userWork = f.mutations.run(() => busy.promise); // e.g. the user's own card edit still saving
  const call = f.registry.call('update_character_card', { id: f.id, path: PATH });
  await until(() => f.asked.length === 1);
  f.answers[0](true);
  await tick(); await tick();
  f.close();
  busy.resolve(); await userWork;
  assert.deepEqual(await call, { ok: false, error: { code: 'channel_off', message: AGENT_CHANNEL_CLOSED } });
  assert.deepEqual(f.log, [], 'the queued update never started');
  assert.deepEqual(await f.stored(), before);
  assert.deepEqual((await readdir(f.directory)).filter(name => name.includes('before-update')), [], 'not even a backup');
});

test('update_character_card refuses bad arguments, unknown cards, bad or identical files and big files before any dialog', async t => {
  const f = await agentFixture(t);
  const code = async (args: unknown) => ((await f.registry.call('update_character_card', args)) as any).error?.code;
  for (const args of [{ id: f.id }, { path: PATH }, { id: 'abc', path: PATH }, { id: f.id, path: 'cards\\a.json' }, { id: f.id, path: '\\\\server\\a.json' },
    { id: f.id, path: 'C:\\cards\\a.txt' }, { id: f.id, path: PATH, extra: 1 }])
    assert.equal(await code(args), 'invalid_input', JSON.stringify(args));
  assert.equal(await code({ id: '0f8fad5b-d9cb-469f-a165-70867728950e', path: PATH }), 'invalid_input', 'not one of her cards');
  f.file.content = '{"name":';
  assert.equal(await code({ id: f.id, path: PATH }), 'invalid_input');
  f.file.content = JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 2, card: { ...text('阿澄'), mood: defaultCharacterMoodTemplate(), modelPath: 'C:\\x.pmx' } });
  const refused = await f.registry.call('update_character_card', { id: f.id, path: PATH }) as any;
  assert.equal(refused.error.code, 'invalid_input'); assert.match(refused.error.message, /不能导入路径/);
  f.file.content = v2File('阿澄', '安静');
  const same = await f.registry.call('update_character_card', { id: f.id, path: PATH }) as any;
  assert.equal(same.error.code, 'unavailable'); assert.match(same.error.message, /一模一样/);
  f.file.content = v2File('阿澄', '新的'); f.file.size = 2_000_000;
  assert.equal(await code({ id: f.id, path: PATH }), 'invalid_input');
  assert.equal(f.asked.length, 0, 'no dialog for any of them');
  assert.deepEqual(f.log, []);
});

test('the catalog and the MCP shell list update_character_card as a confirm tool with an id and a path', async () => {
  const entry = AGENT_TOOLS.find(tool => tool.name === 'update_character_card')!;
  assert.equal(entry.tier, 'confirm');
  assert.deepEqual(entry.inputSchema.required, ['id', 'path', 'userWords']); // I-025: with 三方互通 on, the user's own words
  assert.match(entry.description, /原地更新/); assert.match(entry.description, /聊天、日记、画像、熟悉度和昵称都保留/);
  const shim = await import('../scripts/soft-hearts-mcp.mjs');
  const listed = (shim.toolList(shim.loadToolCatalog()) as any[]).find(tool => tool.name === 'update_character_card');
  assert.ok(listed, 'the shell lists it');
  // I-014 + I-025: with 三方互通 on it runs at once with the user's own words (userWords); with it off the user still clicks "允许".
  assert.match(listed.description, /三方互通.*userWords.*直接执行/);
  assert.match(listed.description, /要用户在 soft hearts 弹窗里点“允许”/);
  assert.equal(listed.annotations.readOnlyHint, false);
  assert.equal(listed.annotations.idempotentHint, false);
});

// ---- the 角色页 ----

class Node {
  children: Node[] = []; textContent = ''; className = ''; id = ''; hidden = false; disabled = false; checked = false; type = ''; title = ''; src = ''; alt = '';
  dataset: Record<string, string> = {}; attributes: Record<string, string> = {}; onclick: (() => void) | null = null;
  constructor(readonly tagName: string) {}
  append(...children: Node[]) { this.children.push(...children); }
  replaceChildren(...children: Node[]) { this.children = [...children]; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  scrollIntoView() {}
  click() { this.onclick?.(); }
}
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function withDom<T>(run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Node(tag) } });
  return run().finally(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
}
const ALICE = '0f8fad5b-d9cb-469f-a165-70867728950e';
function summaryFor(name: string, personality: string) {
  return planCharacterCardUpdate({ ...text('Alice', '安静'), mood: defaultCharacterMoodTemplate() }, defaultCharacterResponseProfile(),
    { format: 'soft-hearts-v2', draft: { ...text(name, personality), mood: defaultCharacterMoodTemplate() }, response: null }).summary;
}
function pageFixture(preview: CharacterCardUpdatePreview | null) {
  const calls: unknown[][] = [];
  const view: CharacterRosterView = { entries: [{ id: ALICE, name: 'Alice', tagline: '', active: true, preset: false, model: { state: 'ok', name: 'alice.pmx' },
    avatar: { kind: 'initial', dataUrl: null, initial: 'A' }, knownDay: 12, lastChatAt: null }], activeId: ALICE, revision: 1, pendingSwitchId: null };
  const state = (name = 'Alice'): CharacterCardState => ({ activeId: ALICE, revision: 2, cards: [{ id: ALICE, ...text(name, '新'), mood: defaultCharacterMoodTemplate() }] });
  const unused = async (): Promise<never> => { throw Error('unused'); };
  const api: CharacterPageApi = {
    getCharacterRoster: async () => structuredClone(view), switchCharacter: unused, createCharacterForCurrentModel: unused, bindCharacterModelFile: unused,
    bindCharacterModel: unused, deleteCharacter: unused, importCharacterCard: unused, exportCharacterCard: unused, selectAsset: unused, saveCharacterCard: unused,
    copyCharacterResponse: unused, getCharacterCards: async () => state(), onCharacterRoster: () => () => {}, saveCharacterAvatar: unused,
    previewCharacterCardUpdate: async id => { calls.push(['preview', id]); return structuredClone(preview); },
    applyCharacterCardUpdate: async token => { calls.push(['apply', token]); return state(preview?.summary.name.after); },
    discardCharacterCardUpdate: async token => { calls.push(['discard', token]); },
  };
  const root = new Node('div'), errors: string[] = [];
  const page = new CharacterPage(root as unknown as HTMLElement, { api, onError: message => errors.push(message), captureDelayMs: 0 });
  const find = (name: string) => all(root).find(node => node.dataset.characterAction === name)!;
  const panel = () => all(root).find(node => node.className.includes('character-tile-update'))!;
  return { root, page, calls, errors, find, panel };
}

test('角色页: "用角色卡文件更新…" asks on her tile, the different name first and flagged; it updates only on OK', async () => withDom(async () => {
  const f = pageFixture({ token: 'token-1', id: ALICE, summary: summaryFor('Mira', '新') });
  await f.page.init();
  assert.equal(f.panel().hidden, true);
  f.find('update-file').click(); await flush();
  assert.deepEqual(f.calls, [['preview', ALICE]]);
  assert.equal(f.panel().hidden, false, 'a confirmation on her tile, never a direct update');
  const lines = all(f.panel()).filter(node => node.tagName === 'p');
  assert.match(lines[0].textContent, /用这个文件更新「Alice」？还是同一个她/);
  assert.equal(lines[1].className, 'character-update-warning');
  assert.equal(lines[1].attributes.role, 'alert');
  assert.match(lines[1].textContent, /文件里叫「Mira」，现在叫「Alice」/);
  assert.ok(lines.some(line => /她的聊天、日记、画像、熟悉度和昵称都会保留/.test(line.textContent)));
  // A repaint of the wall (any card change) keeps the question open.
  await f.page.refresh();
  assert.equal(f.panel().hidden, false);
  f.find('confirm-update').click(); await flush();
  assert.deepEqual(f.calls.at(-1), ['apply', 'token-1']);
  assert.ok(all(f.root).some(node => node.textContent === '已更新「Mira」的人设；她的聊天、日记、画像和熟悉度都还在。'));
  assert.equal(f.panel().hidden, true);
  f.page.dispose();
}));

test('角色页: cancel forgets the update; an identical file needs no OK; a closed file dialog does nothing', async () => withDom(async () => {
  const f = pageFixture({ token: 'token-2', id: ALICE, summary: summaryFor('Alice', '新') });
  await f.page.init();
  f.find('update-file').click(); await flush();
  assert.ok(!all(f.panel()).some(node => node.className === 'character-update-warning'), 'same name: nothing flagged');
  f.find('cancel-update').click(); await flush();
  assert.deepEqual(f.calls, [['preview', ALICE], ['discard', 'token-2']]);
  assert.equal(f.panel().hidden, true);
  const same = pageFixture({ token: 'token-3', id: ALICE, summary: summaryFor('Alice', '安静') });
  await same.page.init();
  same.find('update-file').click(); await flush();
  assert.equal(same.panel().hidden, true);
  assert.deepEqual(same.calls, [['preview', ALICE], ['discard', 'token-3']]);
  assert.ok(all(same.root).some(node => node.textContent === '文件里的人设和她现在的一模一样，不需要更新。'));
  const closed = pageFixture(null);
  await closed.page.init();
  closed.find('update-file').click(); await flush();
  assert.deepEqual(closed.calls, [['preview', ALICE]]);
  assert.equal(closed.panel().hidden, true);
  f.page.dispose(); same.page.dispose(); closed.page.dispose();
}));

test('角色页 in English: the update question shows no Chinese fixed text (names stay as written)', async () => withDom(async () => {
  registerUiMessages({ en: ENGLISH_CHARACTER_UI_COPY, 'zh-CN': {} }); setUiLanguage('en');
  try {
    const f = pageFixture({ token: 'token-4', id: ALICE, summary: summaryFor('Mira', '新') });
    await f.page.init();
    f.find('update-file').click(); await flush();
    const texts = all(f.root).flatMap(node => [node.textContent, node.title, ...Object.values(node.attributes)]).filter(Boolean);
    assert.deepEqual(texts.filter(value => /[\u3400-\u9fff]/u.test(value)), []);
    assert.ok(texts.includes('Update from a card file…'));
    assert.ok(texts.some(value => value.startsWith('Different name: the file says “Mira”, she is “Alice” now.')));
    f.page.dispose();
  } finally { setUiLanguage('zh-CN'); }
}));
