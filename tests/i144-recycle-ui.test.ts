// I-144 回收站 in the windows (docs/claude/2026-11-16-recycle-bin-plan.md): 「最近删除的」 next to where things are deleted, and the
// 回收站 tile at the end of the character wall. Fake DOM, fake host; the host side is covered by the recycle-bin tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RecentlyDeleted, recycleDaysLeft, recycleEntryLine, recycleRestoreNote, type RecycleApi } from '../src/foundation/recently-deleted';
import { CharacterPage, type CharacterPageApi } from '../src/cards/CharacterPage';
import type { RecycleBinView, RecycleSummary } from '../shared/foundation/recycle-bin';
import type { CharacterRosterView } from '../shared/cards/character-roster';
import { registerUiMessages, setUiLanguage } from '../shared/foundation/ui-language';
import { ENGLISH_CHARACTER_UI_COPY } from '../shared/foundation/ui-copy.character.en';
import { ENGLISH_RECYCLE_UI_COPY } from '../shared/foundation/ui-copy.recycle.en';

class Node {
  children: Node[] = []; textContent = ''; className = ''; id = ''; hidden = false; disabled = false; checked = false; type = ''; title = ''; src = ''; alt = '';
  value = ''; min = ''; max = ''; step = '';
  dataset: Record<string, string> = {}; attributes: Record<string, string> = {}; onclick: (() => void) | null = null; onchange: (() => void) | null = null;
  constructor(readonly tagName: string) {}
  append(...children: Node[]) { this.children.push(...children); }
  replaceChildren(...children: Node[]) { this.children = [...children]; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  scrollIntoView() {}
}
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const doc = { createElement: (tag: string) => new Node(tag) };
function withDom<T>(run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  return run().finally(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
}

const NOW = Date.UTC(2026, 10, 16, 12);
const entry = (id: string, characterId: string, part: RecycleSummary['part'], extra: Partial<RecycleSummary> = {}): RecycleSummary => ({
  id, characterId, characterName: characterId === 'a' ? '小桃' : '小雨', part, count: 1, label: '中文标签', deletedAt: NOW - 1000, expiresAt: NOW + 6 * 86_400_000 + 3600_000, ...extra });
const view = (entries: RecycleSummary[], days = 7): RecycleBinView => ({ days, entries, ready: true });

function fakeBin(initial: RecycleBinView) {
  let current = initial; const listeners = new Set<(v: RecycleBinView) => void>(); const calls: string[] = [];
  let restore: (id: string) => { failed: boolean; replaced: boolean } = () => ({ failed: false, replaced: false });
  const publish = (next: RecycleBinView) => { current = next; for (const listener of listeners) listener(next); };
  const api = {
    getRecycleBin: async () => structuredClone(current),
    restoreRecycleEntry: async (id: string) => { calls.push(`restore:${id}`); const outcome = restore(id);
      if (!outcome.failed) current = { ...current, entries: current.entries.filter(e => e.id !== id) };
      return { view: structuredClone(current), ...outcome }; },
    deleteRecycleEntryForGood: async (id: string) => { calls.push(`delete:${id}`); current = { ...current, entries: current.entries.filter(e => e.id !== id) }; return structuredClone(current); },
    setRecycleBinDays: async (days: number) => { calls.push(`days:${days}`); current = { ...current, days }; return structuredClone(current); },
    onRecycleBin: (listener: (v: RecycleBinView) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { api, calls, publish, setRestore: (fn: typeof restore) => { restore = fn; }, listeners };
}

test('days left are rounded up and never below one; the line names the thing in plain words, with no host label', () => {
  assert.equal(recycleDaysLeft({ expiresAt: NOW + 6 * 86_400_000 + 3600_000 }, NOW), 7);
  assert.equal(recycleDaysLeft({ expiresAt: NOW + 60_000 }, NOW), 1);
  assert.equal(recycleDaysLeft({ expiresAt: NOW - 5 }, NOW), 1);
  const line = recycleEntryLine(entry('e', 'a', 'chat'), true, NOW);
  assert.match(line, /^「小桃」的聊天记忆 · 删除于 .+ · 还能留 7 天$/);
  assert.doesNotMatch(line, /中文标签/);
  assert.match(recycleEntryLine(entry('e', 'a', 'character', { memories: true }), true, NOW), /^「小桃」（角色卡和她的全部记忆）/);
  assert.match(recycleEntryLine(entry('e', 'a', 'character'), true, NOW), /^「小桃」（角色卡和模型关联）/);
  assert.match(recycleEntryLine(entry('e', 'a', 'moving-memory'), false, NOW), /^最打动她的那一件 · /);
  assert.equal(recycleRestoreNote({ failed: true, replaced: true }), '有一部分没能找回，回收站里还留着，可以再试一次。 之后新记下的已经换进回收站，没有丢。');
  assert.equal(recycleRestoreNote({ failed: false, replaced: false }), '');
});

test('「最近删除的」: only this character and these kinds, newest first, hidden when empty, 「找回」 asks the host and tells what happened', async () => withDom(async () => {
  const bin = fakeBin(view([entry('old', 'a', 'memory-note', { deletedAt: NOW - 5000 }), entry('new', 'a', 'chat', { deletedAt: NOW - 1000 }),
    entry('other', 'b', 'chat'), entry('kind', 'a', 'listen-note')]));
  let current = 'a'; const restored: string[] = [], errors: string[] = [];
  const root = new Node('div');
  const list = new RecentlyDeleted(root as unknown as HTMLElement, { api: bin.api as unknown as RecycleApi, kinds: ['chat', 'profile', 'memory-note'], characterId: () => current,
    onRestored: () => restored.push('restored'), onError: message => errors.push(message), doc: doc as unknown as Document });
  assert.equal(root.hidden, true, 'nothing yet');
  await list.init();
  assert.equal(root.hidden, false);
  assert.deepEqual(list.entries().map(e => e.id), ['new', 'old'], 'this character, these kinds, newest first');
  const rows = () => all(root).filter(node => node.dataset.recycleEntry);
  assert.deepEqual(rows().map(node => node.dataset.recycleEntry), ['new', 'old']);
  assert.ok(all(root).some(node => node.textContent === '最近删除的'));
  const button = (id: string) => all(rows().find(node => node.dataset.recycleEntry === id)!).find(node => node.dataset.recycle === 'restore')!;
  bin.setRestore(() => ({ failed: true, replaced: false }));
  button('new').onclick!(); await flush();
  assert.deepEqual(restored, [], 'a part that did not come back is not reported as done');
  assert.ok(all(root).some(node => node.textContent === '有一部分没能找回，回收站里还留着，可以再试一次。'));
  assert.equal(rows().length, 2, 'it stays so it can be tried again');
  bin.setRestore(() => ({ failed: false, replaced: true }));
  button('new').onclick!(); await flush();
  assert.deepEqual(bin.calls, ['restore:new', 'restore:new']);
  assert.deepEqual(restored, ['restored']);
  assert.deepEqual(rows().map(node => node.dataset.recycleEntry), ['old']);
  assert.ok(all(root).some(node => node.textContent === '之后新记下的已经换进回收站，没有丢。'));
  // The host pushes a change (another place deleted something), and switching character switches the list.
  bin.publish(view([entry('fresh', 'a', 'profile')]));
  assert.deepEqual(rows().map(node => node.dataset.recycleEntry), ['fresh']);
  current = 'b'; bin.publish(view([entry('fresh', 'a', 'profile')]));
  assert.equal(rows().length, 0);
  list.dispose();
  assert.equal(bin.listeners.size, 0, 'unsubscribed');
  assert.deepEqual(errors, []);
}));

const rosterEntry = (id: string, name: string, active: boolean) => ({ id, name, tagline: '', active, preset: false, model: { state: 'ok' as const, name: `${id}.pmx` },
  avatar: { kind: 'initial' as const, dataUrl: null, initial: name[0] }, knownDay: null, lastChatAt: null });

function pageFixture(bin: ReturnType<typeof fakeBin> | null) {
  const calls: unknown[][] = [];
  let roster: CharacterRosterView = { entries: [rosterEntry('gene', 'Gene', true), rosterEntry('alice', 'Alice', false)], activeId: 'gene', revision: 1, pendingSwitchId: null };
  let rosterReads = 0;
  const state = () => ({ activeId: roster.activeId, revision: 2, cards: roster.entries.map(value => ({ id: value.id, name: value.name, description: '', personality: '',
    scenario: '', greeting: '', examples: '', systemPrompt: '' })) });
  const api = {
    getCharacterRoster: async () => { rosterReads++; return structuredClone(roster) as never; },
    switchCharacter: async () => state(), createCharacterForCurrentModel: async () => state(), bindCharacterModelFile: async () => state(), bindCharacterModel: async () => state(),
    deleteCharacter: async (id: string, options: unknown) => { calls.push(['delete', id, options]); return state(); },
    importCharacterCard: async () => state(), exportCharacterCard: async () => true, selectAsset: async () => null, saveCharacterCard: async () => state(),
    copyCharacterResponse: async () => { throw Error('unused'); }, getCharacterCards: async () => state(), onCharacterRoster: () => () => {}, saveCharacterAvatar: async () => true,
    previewCharacterCardUpdate: async () => null, applyCharacterCardUpdate: async () => state(), discardCharacterCardUpdate: async () => {},
    ...(bin ? bin.api : {}),
  } as unknown as CharacterPageApi;
  const root = new Node('div');
  const page = new CharacterPage(root as unknown as HTMLElement, { api, onError: message => calls.push(['error', message]), captureDelayMs: 0 });
  const find = (name: string, value: string) => all(root).find(node => (node.dataset as Record<string, string>)[name] === value)!;
  return { root, page, calls, find, reads: () => rosterReads, setRoster: (next: CharacterRosterView) => { roster = next; } };
}

test('角色页: the last tile is 「回收站（N）」 and shows even when empty; opening it lists everything with 找回 and a two-step 永久删除; days can be set', async () => withDom(async () => {
  const bin = fakeBin(view([entry('c1', 'a', 'character', { memories: true }), entry('c2', 'b', 'chat')]));
  const f = pageFixture(bin);
  await f.page.init();
  const tiles = all(f.root).filter(node => node.className.startsWith('character-tile '));
  assert.ok(tiles.at(-1)!.className.includes('character-recycle-tile'), 'after the 新增角色 tile');
  assert.ok(tiles.at(-2)!.className.includes('character-add'));
  assert.ok(all(tiles.at(-1)!).some(node => node.textContent === '回收站（2）'));
  const open = f.find('recycle', 'open');
  assert.equal(open.dataset.characterAction, 'recycle-bin');
  const panel = all(f.root).find(node => node.id === 'character-recycle-panel')!;
  assert.equal(panel.hidden, true);
  open.onclick!();
  assert.equal(panel.hidden, false);
  const rows = () => all(panel).filter(node => node.dataset.recycleEntry);
  assert.deepEqual(rows().map(node => node.dataset.recycleEntry), ['c1', 'c2'], 'every character, every kind');
  assert.ok(all(rows()[0]).some(node => /^「小桃」（角色卡和她的全部记忆）/.test(node.textContent)));
  assert.ok(all(rows()[1]).some(node => /^「小雨」的聊天记忆/.test(node.textContent)));
  assert.ok(all(panel).some(node => node.textContent === '删掉的东西在回收站里留'));
  const days = all(panel).find(node => node.dataset.recycle === 'days')!;
  assert.equal(days.value, '7'); assert.equal(days.min, '1'); assert.equal(days.max, '30');
  days.value = '14'; days.onchange!(); await flush();
  days.value = '0'; days.onchange!(); await flush();
  days.value = '2.5'; days.onchange!(); await flush();
  assert.deepEqual(bin.calls, ['days:14'], 'only whole days from 1 to 30 are sent');
  // 永久删除 asks again: the first press only changes the button.
  const forGood = (id: string) => all(rows().find(node => node.dataset.recycleEntry === id)!).find(node => node.dataset.recycle === 'delete-for-good')!;
  forGood('c2').onclick!();
  assert.equal(forGood('c2').textContent, '确认永久删除（不能撤回）');
  assert.deepEqual(bin.calls, ['days:14'], 'nothing deleted yet');
  forGood('c2').onclick!(); await flush();
  assert.deepEqual(bin.calls, ['days:14', 'delete:c2']);
  assert.deepEqual(rows().map(node => node.dataset.recycleEntry), ['c1']);
  assert.ok(all(f.root).some(node => node.textContent === '回收站（1）'));
  // 找回 puts a character back and the wall reads again; she does not become the current one.
  const before = f.reads();
  all(rows()[0]).find(node => node.dataset.recycle === 'restore')!.onclick!(); await flush();
  assert.deepEqual(bin.calls.slice(-1), ['restore:c1']);
  assert.ok(f.reads() > before, 'the wall re-reads');
  assert.equal(f.page.roster!.activeId, 'gene');
  assert.ok(!f.calls.some(call => call[0] === 'switch'));
  assert.ok(all(f.root).some(node => node.textContent === '回收站（0）'), 'empty still shows, so the days can be set');
  f.page.dispose();
  assert.equal(bin.listeners.size, 0);
}));

test('角色页: the delete question names the days and the recycle bin; the box lists what goes; the status says where it went', async () => withDom(async () => {
  const bin = fakeBin(view([], 9));
  const f = pageFixture(bin);
  await f.page.init();
  const tile = all(f.root).find(node => node.dataset.characterId === 'alice')!;
  f.find('characterAction', 'delete');
  const confirm = all(tile).find(node => node.className === 'character-tile-confirm')!;
  const question = all(confirm).find(node => node.tagName === 'p')!;
  assert.equal(question.textContent, '删除「Alice」？会先放进回收站，留 9 天，期间可以完整找回；到期才真正删除。默认只删这张角色卡和模型关联，她的聊天记忆、日记和画像都会留着。');
  const box = all(confirm).find(node => node.dataset.characterAction === 'forget-memories')!;
  const label = all(confirm).find(node => node.className === 'character-tile-forget')!;
  assert.equal(all(label).find(node => node.tagName === 'span')!.textContent,
    '同时删除她的记忆（聊天记录、日记和画像、熟悉度和昵称、她记得的计划和笔记、一起听一起看、我们的小东西、特别的日子等，一起放进回收站）');
  bin.publish(view([], 3));
  assert.match(question.textContent, /留 3 天/, 'follows the days when they change');
  const confirmButton = all(confirm).find(node => node.dataset.characterAction === 'confirm-delete')!;
  confirmButton.onclick!(); await flush();
  assert.deepEqual(f.calls.at(-1), ['delete', 'alice', { forgetMemories: false }]);
  assert.equal(all(f.root).find(node => node.className === 'character-page-status')!.textContent, '角色卡已放进回收站，她的记忆还留着。');
  box.checked = true; confirmButton.onclick!(); await flush();
  assert.equal(all(f.root).find(node => node.className === 'character-page-status')!.textContent, '已放进回收站：角色卡和她的记忆，3 天内可以在「回收站」里找回。');
  f.page.dispose();
}));

test('角色页 without the bin methods shows no 回收站 tile; in English no Chinese fixed text is left', async () => withDom(async () => {
  const plain = pageFixture(null);
  await plain.page.init();
  assert.ok(!all(plain.root).some(node => node.dataset.recycle === 'open'));
  plain.page.dispose();
  registerUiMessages({ en: { ...ENGLISH_CHARACTER_UI_COPY, ...ENGLISH_RECYCLE_UI_COPY }, 'zh-CN': {} }); setUiLanguage('en');
  try {
    const bin = fakeBin(view([entry('c1', 'a', 'character', { memories: true }), entry('c2', 'a', 'moving-memory'), entry('c3', 'a', 'listen-note'), entry('c4', 'a', 'profile'), entry('c5', 'a', 'memory-note')]));
    const f = pageFixture(bin);
    await f.page.init();
    f.find('recycle', 'open').onclick!();
    bin.publish(view(bin.api ? (await bin.api.getRecycleBin()).entries : []));
    f.find('characterAction', 'delete');
    const texts = all(f.root).flatMap(node => [node.textContent, node.title, ...Object.values(node.attributes)]).filter(Boolean);
    assert.deepEqual(texts.filter(text => /[㐀-鿿]/u.test(text.replace(/「?(Gene|Alice)」?|小桃/g, ''))), []);
    f.page.dispose();
  } finally { setUiLanguage('zh-CN'); }
}));
