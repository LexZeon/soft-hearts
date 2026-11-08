// C2 角色页：一点就换 (docs/claude/2026-11-03-character-page-plan.md, user-confirmed 2026-11-03): the card wall's data,
// pictures that stay on this computer, "换成她" waiting for her current line, deleting that keeps memories unless
// ticked, the four ways to add a character, and exports without pictures or paths. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { CharacterAvatarStore, avatarBytesFromDataUrl, findModelPreview, validateAvatarPng } from '../electron/character-avatars';
import { CharacterCardStore } from '../electron/character-cards';
import { forgetCharacterMemories, forgettableProviderScopes } from '../electron/character-forget';
import { buildCharacterRoster, type RosterCard } from '../electron/character-roster';
import { CharacterSwitchGate } from '../electron/character-switch';
import { CompanionService, memoryProviderScope } from '../electron/companion';
import { RpsStore } from '../electron/rps/store';
import { UserProfileStore } from '../electron/user-profile';
import { localDateKey } from '../electron/diary/diary-dates';
import { BUNDLED_CHARACTER_MODEL, defaultCharacterMoodTemplate, type CharacterCardState } from '../shared/character-cards';
import { characterTagline, type CharacterRosterEntry, type CharacterRosterView } from '../shared/character-roster';
import { uniqueCharacterName } from '../shared/character-model';
import { registerUiMessages, setUiLanguage } from '../shared/ui-language';
import { ENGLISH_CHARACTER_UI_COPY } from '../shared/ui-copy.character.en';
import { CharacterPage, lastChatText, type CharacterPageApi } from '../src/ui/CharacterPage';

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-character-page-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
/** A real, tiny PNG (1 transparent pixel scaled to width × height). */
function png(width = 4, height = 4): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes: Uint8Array) => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
    view.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length))); return out;
  };
  const header = new Uint8Array(13), hv = new DataView(header.buffer);
  hv.setUint32(0, width); hv.setUint32(4, height); header.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (1 + width * 4));
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
const dataUrl = (bytes: Uint8Array) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
const ID = (n: number) => `0000000${n}-0000-4000-8000-000000000000`.slice(-36).replace(/^.{8}/, `0000000${n}`.slice(-8));

// ---- host: pictures ----

test('pictures stay on this computer: only small PNGs are kept, per card id, and they can be removed', async () => withDirectory(async directory => {
  const avatars = new CharacterAvatarStore(directory), id = ID(1);
  assert.equal(await avatars.read(id), null);
  await avatars.save(id, png(192, 192));
  assert.equal(await avatars.read(id), dataUrl(png(192, 192)));
  assert.equal((await readFile(path.join(directory, 'character-avatars', `${id}.png`))).length, png(192, 192).length);
  assert.throws(() => validateAvatarPng(new TextEncoder().encode('GIF89a not a png at all, at least 33 bytes long')), /PNG/);
  assert.throws(() => validateAvatarPng(png(1024, 8)), /尺寸/);
  assert.throws(() => avatarBytesFromDataUrl('data:image/jpeg;base64,AAAA'), /PNG/);
  assert.throws(() => avatarBytesFromDataUrl('file:///C:/secret.png'), /PNG/);
  assert.deepEqual(avatarBytesFromDataUrl(dataUrl(png())), png());
  await assert.rejects(avatars.save('../escape', png()), /编号/);
  await avatars.remove(id);
  assert.equal(await avatars.read(id), null);
}));

test('a model folder\'s own preview picture is found by name; textures are never taken for it', async () => withDirectory(async directory => {
  const folder = path.join(directory, 'Alice'); await mkdir(folder);
  const model = path.join(folder, 'alice.pmx'); await writeFile(model, 'pmx');
  await writeFile(path.join(folder, 'face.png'), png()); await writeFile(path.join(folder, 'hair.png'), png());
  assert.equal(await findModelPreview(model), null, 'textures are not previews');
  await writeFile(path.join(folder, 'alice.jpg'), 'jpg');
  assert.equal(await findModelPreview(model), path.join(folder, 'alice.jpg'), 'the model file\'s own name');
  await writeFile(path.join(folder, 'preview.png'), png());
  assert.equal(await findModelPreview(model), path.join(folder, 'alice.jpg'));
  assert.equal(await findModelPreview('relative/alice.pmx'), null);
}));

// ---- host: the card wall ----

test('the wall shows each card\'s model (preinstalled, there, gone, none), picture by priority and no paths', async () => withDirectory(async directory => {
  const present = path.join(directory, 'Present', 'present.pmx'); await mkdir(path.dirname(present)); await writeFile(present, 'pmx');
  await writeFile(path.join(directory, 'Present', 'preview.png'), png());
  const gone = path.join(directory, 'Gone', 'gone.pmx');
  const cards: RosterCard[] = [
    { id: 'gene', name: 'Gene', description: '', personality: '温和、自然。喜欢轻松的小互动。', modelPath: BUNDLED_CHARACTER_MODEL, modelName: 'Gene' },
    { id: 'present', name: 'Present', description: '一位住在桌面上的朋友。', personality: '', modelPath: present, modelName: 'present.pmx' },
    { id: 'gone', name: 'Gone', description: '', personality: '', modelPath: gone, modelName: 'gone.pmx' },
    { id: 'plain', name: '小雪', description: '', personality: '' },
  ];
  const view = await buildCharacterRoster({ cards: () => cards, activeId: () => 'present', revision: () => 7, presetGeneId: async () => 'gene',
    avatar: async id => id === 'gene' ? 'data:image/png;base64,SNAPSHOT' : null, previewImage: async () => 'data:image/png;base64,PREVIEW',
    knownDay: async id => id === 'present' ? 12 : null, lastChatAt: id => id === 'present' ? 1_700_000_000_000 : null, pendingSwitchId: () => null });
  const by = (id: string) => view.entries.find(entry => entry.id === id)!;
  assert.deepEqual(view.entries.map(entry => entry.model.state), ['bundled', 'ok', 'missing', 'none']);
  assert.equal(by('gene').preset, true);
  assert.deepEqual(by('gene').avatar, { kind: 'snapshot', dataUrl: 'data:image/png;base64,SNAPSHOT', initial: 'G' });
  assert.deepEqual(by('present').avatar, { kind: 'preview', dataUrl: 'data:image/png;base64,PREVIEW', initial: 'P' });
  assert.deepEqual(by('plain').avatar, { kind: 'initial', dataUrl: null, initial: '小' });
  assert.equal(by('gone').model.name, 'gone.pmx');
  assert.equal(by('present').active, true);
  assert.equal(by('present').knownDay, 12);
  assert.equal(by('gene').tagline, '温和、自然。');
  assert.equal(by('present').tagline, '一位住在桌面上的朋友。');
  assert.doesNotMatch(JSON.stringify(view), new RegExp(directory.replace(/[\\]/g, '\\\\\\\\').slice(0, 20)), 'no local path reaches the page');
  assert.doesNotMatch(JSON.stringify(view), /Present[\\/]|Gone[\\/]/);
  assert.equal(characterTagline({ personality: 'x'.repeat(60) }).length, 40);
  assert.equal(uniqueCharacterName('Gene', ['Gene', 'Gene 2']), 'Gene 3');
}));

// ---- host: "换成她" waits for her current line ----

test('"换成她" waits while she is talking, then switches; the latest choice wins; it never waits forever', async () => {
  let busy = true, clock = 0;
  const activated: string[] = [], waiting: (string | null)[] = [];
  const gate = new CharacterSwitchGate<string>({ busy: () => busy, activate: async id => { activated.push(id); return id; },
    waiting: id => waiting.push(id), now: () => clock, wait: async ms => { clock += ms; await new Promise(resolve => setImmediate(resolve)); }, maxWaitMs: 10_000, pollMs: 100 });
  const first = gate.request('alice');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(activated, [], 'no switch while she is mid-line');
  assert.equal(gate.pending, 'alice');
  const second = gate.request('bob'); // The user changes their mind while waiting.
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  busy = false; // Her line ends.
  assert.equal(await first, null, 'the older choice is overtaken');
  assert.equal(await second, 'bob');
  assert.deepEqual(activated, ['bob']);
  assert.equal(gate.pending, null);
  assert.deepEqual(waiting.at(-1), null);
  // Not talking: immediate.
  assert.equal(await gate.request('carol'), 'carol');
  // A turn that never ends: after the cap the switch goes ahead (the activation then stops the turn).
  busy = true; clock = 0;
  assert.equal(await gate.request('dana'), 'dana');
  assert.ok(clock >= 10_000);
});

// ---- host: deleting keeps her memories unless ticked ----

test('deleting a card keeps her memories by default; "同时删除她的记忆" removes only hers', async () => withDirectory(async directory => {
  const provider = { kind: 'claude' as const, baseUrl: 'http://127.0.0.1:11434/v1', model: 'sonnet' };
  const providerScope = memoryProviderScope(provider);
  const service = new CompanionService(directory, () => {});
  const profiles = new UserProfileStore(path.join(directory, 'user-profiles'));
  const rps = new RpsStore({ file: () => path.join(directory, 'rps.json') }); await rps.load();
  try {
    await service.load();
    for (const id of ['card-doomed', 'card-kept']) {
      await service.context(id, provider, id);
      const turn = await service.begin(`${id}-t`, `给 ${id} 的话`, id, () => {}, {});
      turn.push('delta', '好。'); await turn.finish('complete');
      await service.relationship.setNickname(id, '小蓝');
      await profiles.activate({ characterId: id, providerScope }); profiles.setEnabled(true);
      await profiles.saveDiary(profiles.diaryTicket()!, localDateKey(Date.now() - 86_400_000), `${id} 的日记`);
      rps.finish(id, { at: Date.now(), origin: 'user', result: 'her', rounds: [{ her: 'rock', user: 'scissors', outcome: 'her' }] }, true);
    }
    await service.relationship.flush();
    const scope = (characterId: string) => ({ characterId, providerScope });
    // Default delete: only the card goes (CharacterCardStore.remove); nothing of hers is touched.
    assert.equal(service.memory.list(scope('card-doomed')).records.length, 1);
    const forgotten = await forgetCharacterMemories('card-doomed', { providerScopes: () => forgettableProviderScopes(provider, memoryProviderScope),
      memory: service.memory, profiles, relationship: service.relationship, rps });
    assert.deepEqual(forgotten.failed, []);
    assert.equal(forgotten.records, 1);
    assert.equal(forgotten.profiles, 1);
    assert.equal(service.memory.list(scope('card-doomed')).records.length, 0);
    assert.equal(service.memory.list(scope('card-kept')).records.length, 1, 'another character keeps hers');
    assert.deepEqual(rps.games('card-doomed'), []);
    assert.equal(rps.games('card-kept').length, 1);
    await assert.rejects(readFile(path.join(directory, 'relationship', 'card-doomed.json')), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(path.join(directory, 'relationship', 'card-kept.json'), 'utf8')).nickname, '小蓝');
    await profiles.activate({ characterId: 'card-doomed', providerScope }); assert.deepEqual(profiles.view().diary, []);
    await profiles.activate({ characterId: 'card-kept', providerScope }); assert.equal(profiles.view().diary.length, 1);
    // The journal no longer holds the deleted text at all.
    assert.doesNotMatch(await readFile(path.join(directory, 'memories.jsonl'), 'utf8'), /给 card-doomed 的话/);
    assert.ok(forgettableProviderScopes(provider, memoryProviderScope).includes(memoryProviderScope({ ...provider, model: '' })));
  } finally { await service.flush().catch(() => {}); profiles.dispose(); }
}));

test('an exported card carries no picture, model path or local folder', async () => withDirectory(async directory => {
  const cards = new CharacterCardStore(directory, 'legacy');
  await cards.load({ preinstalledGene: true, freshProfile: true });
  await cards.save({ name: 'Alice', description: 'd', personality: 'p', scenario: '', greeting: '', examples: '', systemPrompt: '', mood: defaultCharacterMoodTemplate() });
  const alice = cards.publicState().cards.find(card => card.name === 'Alice')!;
  const model = path.join(directory, 'models', 'Alice', 'alice.pmx');
  await cards.bindModel(alice.id, model, 'alice.pmx');
  await new CharacterAvatarStore(directory).save(alice.id, png(192, 192));
  const exported = cards.export(alice.id);
  assert.doesNotMatch(exported, /modelPath|modelName|alice\.pmx|avatar|data:image|character-avatars/);
  assert.doesNotMatch(exported, new RegExp(path.basename(directory)));
}));

// ---- the page ----

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

function pageFixture(overrides: Partial<CharacterPageApi> = {}) {
  const calls: unknown[][] = [];
  const entry = (id: string, name: string, extra: Partial<CharacterRosterEntry> = {}): CharacterRosterEntry => ({ id, name, tagline: '', active: false, preset: false, model: { state: 'ok' as const, name: `${id}.pmx` },
    avatar: { kind: 'initial' as const, dataUrl: null, initial: name[0] }, knownDay: null, lastChatAt: null, ...extra });
  let view: CharacterRosterView = { entries: [entry('gene', 'Gene', { active: true, preset: true, model: { state: 'bundled', name: 'Gene' }, knownDay: 3 }), entry('alice', 'Alice'),
    entry('gone', 'Gone', { model: { state: 'missing', name: 'gone.pmx' } })], activeId: 'gene', revision: 1, pendingSwitchId: null };
  const state = (activeId = view.activeId): CharacterCardState => ({ activeId, revision: 2, cards: view.entries.map(value => ({ id: value.id, name: value.name, description: '', personality: '',
    scenario: '', greeting: '', examples: '', systemPrompt: '', mood: defaultCharacterMoodTemplate() })) });
  const api: CharacterPageApi = {
    getCharacterRoster: async () => structuredClone(view) as never,
    switchCharacter: async id => { calls.push(['switch', id]); view = { ...view, activeId: id, entries: view.entries.map(value => ({ ...value, active: value.id === id })) }; return state(id); },
    createCharacterForCurrentModel: async () => { calls.push(['create-current']); return state(); },
    bindCharacterModelFile: async id => { calls.push(['bind-file', id]); return state(); },
    bindCharacterModel: async (id, enabled) => { calls.push(['bind', id, enabled]); return state(); },
    deleteCharacter: async (id, options) => { calls.push(['delete', id, options]); return state(); },
    importCharacterCard: async () => { calls.push(['import']); return state(); },
    exportCharacterCard: async id => { calls.push(['export', id]); return true; },
    selectAsset: async kind => { calls.push(['select', kind]); return null; },
    saveCharacterCard: async draft => { calls.push(['save', draft.name]); return state(); },
    copyCharacterResponse: async () => { throw Error('unused'); },
    getCharacterCards: async () => state(),
    onCharacterRoster: () => () => {},
    saveCharacterAvatar: async (id, url, image) => { calls.push(['avatar', id, url, image]); return true; },
    // C3 (tests/c3-card-update-in-place.test.ts covers these).
    previewCharacterCardUpdate: async id => { calls.push(['preview-update', id]); return null; },
    applyCharacterCardUpdate: async token => { calls.push(['apply-update', token]); return state(); },
    discardCharacterCardUpdate: async token => { calls.push(['discard-update', token]); },
    ...overrides,
  };
  const root = new Node('div');
  const blank: string[] = [], edits: string[] = [];
  const page = new CharacterPage(root as unknown as HTMLElement, { api, onError: message => calls.push(['error', message]), onBlank: () => blank.push('blank'), onEdit: id => edits.push(id),
    capture: async url => `data:image/png;base64,${Buffer.from(url).toString('base64')}`, modelUrl: () => 'mmd-asset://x/gene.pmx', captureDelayMs: 0 });
  const tile = (id: string) => all(root).find(node => node.dataset.characterId === id)!;
  const action = (id: string, name: string) => all(tile(id)).find(node => node.dataset.characterAction === name)!;
  const add = (name: string) => all(root).find(node => node.dataset.characterAdd === name)!;
  return { root, page, calls, tile, action, add, blank, edits, setView: (next: CharacterRosterView) => { view = next; } };
}
function withDom<T>(run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Node(tag) } });
  return run().finally(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
}

test('the wall: the current one is highlighted "正在陪着你"; "换成她" switches at once without asking', async () => withDom(async () => {
  const f = pageFixture();
  await f.page.init();
  assert.ok(f.tile('gene').className.includes('active'));
  assert.ok(all(f.tile('gene')).some(node => node.textContent === '正在陪着你'));
  assert.equal(f.action('gene', 'switch').disabled, true);
  assert.ok(all(f.tile('gene')).some(node => node.textContent === '认识第 3 天 · 还没聊过'));
  assert.ok(all(f.tile('alice')).some(node => node.className === 'character-tile-initial' && node.textContent === 'A'));
  // The preinstalled Gene cannot be linked to another model.
  assert.equal(f.action('gene', 'bind-file').disabled, true);
  assert.equal(f.action('alice', 'bind-file').disabled, false);
  // A model file that is gone asks to be chosen again.
  f.action('gone', 'rebind').click(); await flush();
  assert.deepEqual(f.calls.at(-1), ['bind-file', 'gone']);
  f.action('alice', 'switch').click(); await flush();
  assert.deepEqual(f.calls.filter(call => call[0] === 'switch'), [['switch', 'alice']]);
  assert.ok(f.tile('alice').className.includes('active'));
  // A switch waiting for her line shows on the tile it will bring in.
  const cards = (await f.page.roster)!.entries;
  f.page.applyCardState({ activeId: 'alice', revision: 2, cards: cards.map(card => ({ id: card.id, name: card.name, description: '', personality: '', scenario: '',
    greeting: '', examples: '', systemPrompt: '' })), switchingTo: 'gene' });
  assert.ok(all(f.tile('gene')).some(node => node.textContent === '等她说完这一句就换…'));
  f.page.applyCardState({ activeId: 'alice', revision: 2, cards: cards.map(card => ({ id: card.id, name: card.name, description: '', personality: '', scenario: '',
    greeting: '', examples: '', systemPrompt: '' })) });
  assert.ok(!all(f.tile('gene')).some(node => node.textContent === '等她说完这一句就换…'), 'gone once she switched');
  f.page.dispose();
}));

test('deleting asks first; "同时删除她的记忆" is unticked by default; ticking it is passed on', async () => withDom(async () => {
  const f = pageFixture();
  await f.page.init();
  const confirm = () => all(f.tile('alice')).find(node => node.className === 'character-tile-confirm')!;
  assert.equal(confirm().hidden, true);
  f.action('alice', 'delete').click();
  assert.equal(confirm().hidden, false, 'a confirmation, never a direct delete');
  assert.equal(f.calls.some(call => call[0] === 'delete'), false);
  const box = all(confirm()).find(node => node.dataset.characterAction === 'forget-memories')!;
  assert.equal(box.checked, false);
  f.action('alice', 'confirm-delete').click(); await flush();
  assert.deepEqual(f.calls.at(-1), ['delete', 'alice', { forgetMemories: false }]);
  f.action('gone', 'delete').click();
  all(f.tile('gone')).find(node => node.dataset.characterAction === 'forget-memories')!.checked = true;
  f.action('gone', 'confirm-delete').click(); await flush();
  assert.deepEqual(f.calls.at(-1), ['delete', 'gone', { forgetMemories: true }]);
  f.page.dispose();
}));

test('adding a character four ways: current model, a model file, a card file, blank', async () => withDom(async () => {
  const f = pageFixture();
  await f.page.init();
  f.add('current').click(); await flush();
  f.add('file').click(); await flush();
  f.add('import').click(); await flush();
  f.add('blank').click(); await flush();
  assert.deepEqual(f.calls.filter(call => ['create-current', 'select', 'import'].includes(call[0] as string)), [['create-current'], ['select', 'model'], ['import']]);
  assert.deepEqual(f.blank, ['blank']);
  assert.deepEqual(f.edits, ['gene'], 'a card made for the current model opens in the editor');
  f.page.dispose();
}));

test('her small picture is taken once when her own model is shown, and only when she has none yet', async () => withDom(async () => {
  const f = pageFixture();
  await f.page.init();
  await f.page.modelShown('mmd-asset://x/gene.pmx');
  const avatars = f.calls.filter(call => call[0] === 'avatar');
  assert.equal(avatars.length, 1);
  assert.equal(avatars[0][1], 'gene');
  assert.equal(avatars[0][2], 'mmd-asset://x/gene.pmx');
  await f.page.modelShown('mmd-asset://x/gene.pmx');
  assert.equal(f.calls.filter(call => call[0] === 'avatar').length, 1, 'once per card and model');
  // A card without a linked model never gets a picture of someone else's model.
  const g = pageFixture();
  g.setView({ entries: [{ id: 'plain', name: '小雪', tagline: '', active: true, preset: false, model: { state: 'none', name: null },
    avatar: { kind: 'initial', dataUrl: null, initial: '小' }, knownDay: null, lastChatAt: null }], activeId: 'plain', revision: 1, pendingSwitchId: null });
  await g.page.init(); await g.page.modelShown('mmd-asset://x/other.pmx');
  assert.equal(g.calls.filter(call => call[0] === 'avatar').length, 0);
  f.page.dispose(); g.page.dispose();
}));

test('the page in English shows no Chinese fixed text (names stay as written)', async () => withDom(async () => {
  registerUiMessages({ en: ENGLISH_CHARACTER_UI_COPY, 'zh-CN': {} }); setUiLanguage('en');
  try {
    const f = pageFixture();
    await f.page.init();
    f.action('alice', 'delete').click();
    const texts = all(f.root).flatMap(node => [node.textContent, node.title, ...Object.values(node.attributes)]).filter(Boolean);
    assert.deepEqual(texts.filter(text => /[\u3400-\u9fff]/u.test(text)), []);
    assert.ok(texts.includes('Switch to her'));
    assert.ok(texts.includes('Also delete her memories (chats, diary and profile, familiarity and nickname, rock-paper-scissors record)'));
    assert.match(lastChatText(Date.now()), /^Last chat: today \d\d:\d\d$/);
    f.page.dispose();
  } finally { setUiLanguage('zh-CN'); }
}));
