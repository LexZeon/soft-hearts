// I-144b 回收站 in the windows (docs/claude/2026-11-16-i144-recycle-bin.md): every single delete goes into the bin, and each panel shows
// 「最近删除的」 next to its delete controls. Kind texts, dates and counts, and the panels' own lists (current character, own kinds only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { RecentlyDeleted, recycleEntryLine, recycleKeepNote, recycleKindText, recycleWhat, type RecycleApi } from '../src/foundation/recently-deleted';
import { TextMemorialPanel } from '../src/memory/TextMemorialPanel';
import { OurThingsPanel } from '../src/memory/OurThingsPanel';
import { AmbientTranscriptHistory } from '../src/senses/AmbientTranscriptHistory';
import { ProfileViewGate } from '../src/memory/ProfileViewGate';
import * as uiLanguage from '../src/foundation/ui-language';
import { registerUiMessages, setUiLanguage } from '../shared/foundation/ui-language';
import { ENGLISH_RECYCLE_UI_COPY } from '../shared/foundation/ui-copy.recycle.en';
import { RECYCLE_ASSISTANT_OWNER, type RecycleBinView, type RecycleEntryKind, type RecycleSummary } from '../shared/foundation/recycle-bin';
import type { TextMemorialView } from '../shared/memory/text-memorials';

class Node {
  children: Node[] = []; textContent = ''; className = ''; id = ''; hidden = false; disabled = false; checked = false; type = ''; title = ''; src = ''; alt = '';
  value = ''; maxLength = 0; min = ''; max = ''; step = ''; rows = 0;
  dataset: Record<string, string> = {}; attributes: Record<string, string> = {}; onclick: (() => void) | null = null; onchange: (() => void) | null = null; oninput: (() => void) | null = null;
  onkeydown: ((event: unknown) => void) | null = null;
  readonly classList = { add: (...names: string[]) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); } };
  constructor(readonly tagName: string, readonly ownerDocument: unknown = doc) {}
  append(...children: Node[]) { this.children.push(...children); }
  replaceChildren(...children: Node[]) { this.children = [...children]; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener() {} removeEventListener() {} focus() {}
}
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const doc = { createElement: (tag: string) => new Node(tag) };
function withDom<T>(run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  return run().finally(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
}
const texts = (root: Node) => all(root).map(node => node.textContent).filter(Boolean);
const button = (root: Node, label: string) => { const found = all(root).find(node => node.tagName === 'button' && node.textContent === label); assert.ok(found, label); return found; };

const NOW = Date.UTC(2026, 10, 16, 12);
const DAY10 = new Date(2026, 10, 10, 12).getTime();
const entry = (id: string, characterId: string, part: RecycleEntryKind, extra: Partial<RecycleSummary> = {}): RecycleSummary => ({
  id, characterId, characterName: characterId === 'a' ? '小桃' : characterId === RECYCLE_ASSISTANT_OWNER ? 'Claude 助手' : '小雨', part, count: 1, label: '中文标签LABEL',
  deletedAt: NOW - 1000, expiresAt: NOW + 6 * 86_400_000 + 3600_000, ...extra });
const view = (entries: RecycleSummary[], days = 7): RecycleBinView => ({ days, entries, ready: true });
function fakeBin(initial: RecycleBinView) {
  let current = initial; const listeners = new Set<(v: RecycleBinView) => void>(); const calls: string[] = [];
  const api = {
    getRecycleBin: async () => structuredClone(current),
    restoreRecycleEntry: async (id: string) => { calls.push(`restore:${id}`); current = { ...current, entries: current.entries.filter(e => e.id !== id) };
      for (const listener of listeners) listener(current); return { view: structuredClone(current), failed: false, replaced: false }; },
    onRecycleBin: (listener: (v: RecycleBinView) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { api: api as unknown as RecycleApi, calls, listeners };
}
const rows = (root: Node) => all(root).filter(node => node.dataset.recycleEntry).map(node => node.dataset.recycleEntry);
const restoreButton = (root: Node, id: string) => all(all(root).find(node => node.dataset.recycleEntry === id)!).find(node => node.dataset.recycle === 'restore')!;
const NEW_KINDS: RecycleEntryKind[] = ['chat-record', 'ambient-transcript', 'listen-raw', 'song-memory', 'profile-entry', 'diary-day', 'diary-all', 'review', 'plan', 'plans-all',
  'nickname', 'text-memorial', 'our-thing', 'assistant-chat'];

test('every new kind is named in plain words, never with the host label, and the line says what and when', () => {
  for (const kind of NEW_KINDS) {
    const text = recycleKindText(entry('e', 'a', kind)), line = recycleEntryLine(entry('e', 'a', kind), false, NOW);
    assert.ok(text.length > 1 && text !== '一项记录', kind);
    assert.doesNotMatch(line, /LABEL|中文标签/, kind);
    assert.match(line, / · 删除于 .+ · 还能留 7 天$/, kind);
  }
  assert.equal(recycleKindText(entry('e', 'a', 'chat-record')), '一段聊天记录');
  assert.equal(recycleKindText(entry('e', 'a', 'nickname')), '她叫你的称呼');
  assert.equal(recycleKindText(entry('e', 'a', 'our-thing')), '我们的小东西里的一件');
  assert.equal(recycleWhat(entry('e', 'a', 'text-memorial'), true), '「小桃」的一条文字纪念');
  assert.equal(recycleKeepNote(7), '会放进回收站，7 天内能在旁边的「最近删除的」找回。');
});

test('itemAt puts the date in the words; bulk kinds show their count; the assistant has no name', () => {
  assert.equal(recycleKindText(entry('e', 'a', 'diary-day', { itemAt: DAY10 })), '11月10日的日记');
  assert.equal(recycleKindText(entry('e', 'a', 'diary-day')), '一天的日记');
  assert.equal(recycleKindText(entry('e', 'a', 'chat-record', { itemAt: DAY10 })), '一段聊天记录（11月10日）');
  assert.equal(recycleKindText(entry('e', 'a', 'review', { itemAt: DAY10 })), '一段回顾（11月10日）');
  assert.equal(recycleKindText(entry('e', 'a', 'diary-all', { count: 12 })), '全部日记（12 天）');
  assert.equal(recycleKindText(entry('e', 'a', 'song-memory', { count: 3 })), '她记得的歌（3 首）');
  assert.equal(recycleKindText(entry('e', 'a', 'listen-raw', { count: 5 })), '一起听攒着的原文（5 段）');
  assert.equal(recycleKindText(entry('e', 'a', 'plans-all', { count: 4 })), '她记得的全部计划（4 件）');
  assert.equal(recycleKindText(entry('e', 'a', 'assistant-chat', { count: 10 })), '和 Claude 助手的对话（10 条）');
  assert.equal(recycleKindText(entry('e', 'a', 'diary-all', { count: 0 })), '全部日记');
  // The existing kinds keep their words even when the host sends a date or a count.
  assert.equal(recycleKindText(entry('e', 'a', 'memory-note', { itemAt: DAY10, count: 3 })), '一条聊天笔记');
  const assistant = entry('e', RECYCLE_ASSISTANT_OWNER, 'assistant-chat', { count: 10 });
  assert.equal(recycleWhat(assistant, true), '和 Claude 助手的对话（10 条）');
  assert.doesNotMatch(recycleEntryLine(assistant, true, NOW), /「/);
  assert.match(recycleEntryLine(entry('e', 'a', 'diary-day', { itemAt: DAY10 }), true, NOW), /^「小桃」的11月10日的日记 · 删除于 /);
});

test('English copy exists for the new words', () => {
  registerUiMessages({ en: { ...ENGLISH_RECYCLE_UI_COPY }, 'zh-CN': {} }); setUiLanguage('en');
  try {
    assert.equal(recycleKindText(entry('e', 'a', 'diary-all', { count: 12 })), 'the whole diary (12 days)');
    assert.match(recycleKindText(entry('e', 'a', 'diary-day', { itemAt: DAY10 })), /^diary of November 10$/);
    assert.equal(recycleKeepNote(7), 'It goes into the recycle bin and can be brought back from “Recently deleted” beside it within 7 days.');
    for (const kind of NEW_KINDS) assert.doesNotMatch(recycleKindText(entry('e', 'a', kind)), /[一-龥]/, kind);
  } finally { setUiLanguage('zh-CN'); }
});

const memorialView = (): TextMemorialView => ({ scopeId: 'A', generation: 1, revision: 0, entries: [{ id: 'one', text: '原文', purpose: '回忆', createdAt: 1, updatedAt: 1 }] });
const settle = async () => { await flush(); };

test('文字纪念: 「最近删除的」 lists only this character\'s text memorials, 「找回」 asks the host and re-reads, and the delete confirm says the bin', async () => withDom(async () => {
  const bin = fakeBin(view([entry('m1', 'a', 'text-memorial', { itemAt: DAY10 }), entry('m2', 'b', 'text-memorial'), entry('m3', 'a', 'our-thing')]));
  let reads = 0, changed = 0; const errors: string[] = [];
  const panel = new TextMemorialPanel({ onTextMemorialsChanged: () => () => {}, getTextMemorials: async () => { reads++; return memorialView(); },
    editTextMemorial: async () => { throw Error('unused'); }, deleteTextMemorial: async () => { throw Error('unused'); } }, () => { changed++; },
    bin.api, () => 'a', message => errors.push(message));
  panel.open(); await settle();
  let root = panel.render(doc as unknown as Document) as unknown as Node; await settle();
  root = panel.render(doc as unknown as Document) as unknown as Node;
  assert.deepEqual(rows(root), ['m1'], 'this character, this kind');
  assert.ok(texts(root).some(line => line?.startsWith('一条文字纪念（11月10日） · 删除于')));
  button(root, '删除纪念').onclick!(); root = panel.render(doc as unknown as Document) as unknown as Node;
  assert.ok(texts(root).includes('会放进回收站，7 天内能在旁边的「最近删除的」找回。'), 'the confirm says it goes into the bin');
  const before = reads;
  restoreButton(root, 'm1').onclick!(); await settle();
  assert.deepEqual(bin.calls, ['restore:m1']);
  assert.ok(reads > before, 'it reads what it shows again');
  panel.dispose(); assert.equal(bin.listeners.size, 0);
  assert.deepEqual(errors, []);
}));

test('我们的小东西: 「最近删除的」 lists only this character\'s things, 「找回」 re-reads the list', async () => withDom(async () => {
  const bin = fakeBin(view([entry('t1', 'a', 'our-thing'), entry('t2', 'b', 'our-thing'), entry('t3', 'a', 'text-memorial')]));
  let reads = 0; const root = new Node('div'), errors: string[] = [];
  new OurThingsPanel(root as unknown as HTMLElement, { get: async () => { reads++; return { items: [] } as never; }, picture: async () => null, remove: async () => ({ items: [] }) as never,
    save: async () => true, changed: () => () => {}, error: message => errors.push(message), recycle: bin.api, currentCharacterId: () => 'a' });
  await settle();
  assert.deepEqual(rows(root), ['t1']);
  const before = reads;
  restoreButton(root, 't1').onclick!(); await settle();
  assert.deepEqual(bin.calls, ['restore:t1']);
  assert.ok(reads > before);
  assert.deepEqual(errors, []);
}));

const transcript = { id: 'r1', sessionId: 's', mode: 'movie', startedAt: 1, endedAt: 2, createdAt: 3, source: 'system-audio', title: 'T', tags: [], language: { status: 'unknown', source: 'unverified' }, text: 'full' };
test('听到的声音文字: 「最近删除的」 lists only this character\'s, 「找回」 reads the list again, the two-step confirm says the bin', async () => withDom(async () => {
  const bin = fakeBin(view([entry('x1', 'a', 'ambient-transcript'), entry('x2', 'b', 'ambient-transcript'), entry('x3', 'a', 'chat-record')]));
  let lists = 0; const root = new Node('div'), errors: string[] = [];
  const history = new AmbientTranscriptHistory(root as unknown as HTMLElement, {
    list: async query => { lists++; return { records: [{ ...transcript, excerpt: 'full', totalCharacters: 4 }], tags: [], offset: query.offset ?? 0, limit: 24, total: 1 } as never; },
    read: async () => transcript as never, comments: async () => [], remove: async () => ({ deleted: true, invalidatedCandidateIds: [] }), onError: message => errors.push(message),
    recycle: bin.api, currentCharacterId: () => 'a' });
  await history.init(); await settle();
  assert.deepEqual(rows(root), ['x1']);
  all(root).find(node => node.dataset.recordId === 'r1')!.onclick!(); await settle();
  const remove = all(root).find(node => node.id === 'ambient-transcript-delete')!;
  assert.ok(!texts(root).includes('会放进回收站，7 天内能在旁边的「最近删除的」找回。') || all(root).every(node => node.textContent !== '会放进回收站，7 天内能在旁边的「最近删除的」找回。' || node.hidden));
  remove.onclick!();
  assert.equal(remove.textContent, '确认删除原文及关联评论');
  const note = all(root).find(node => node.textContent === '会放进回收站，7 天内能在旁边的「最近删除的」找回。');
  assert.ok(note && !note.hidden, 'the confirm says it goes into the bin');
  const before = lists;
  restoreButton(root, 'x1').onclick!(); await settle();
  assert.deepEqual(bin.calls, ['restore:x1']);
  assert.ok(lists > before, 'the list is read again');
  history.dispose(); assert.equal(bin.listeners.size, 0);
  assert.deepEqual(errors, []);
}));

test('画像面板: 「最近删除的」 lists only this character\'s profile kinds, 「找回」 re-reads the profile and the nickname, every confirm says the bin', async () => withDom(async () => {
  const raw = readFileSync(new URL('../src/memory/UserProfilePanel.ts', import.meta.url), 'utf8').replace(/^import .*;\s*$/gm, '').replace('export class UserProfilePanel', 'class UserProfilePanel');
  const js = transformSync(raw, { loader: 'ts', target: 'es2022' }).code;
  const { uiText, uiHtml, uiMarkup, uiTemplate } = uiLanguage as unknown as Record<string, unknown>;
  const Panel = new Function('uiText', 'uiHtml', 'uiMarkup', 'uiTemplate', 'ProfileViewGate', 'RecentlyDeleted', 'recycleKeepNote', `${js};return UserProfilePanel`)
    .call(null, uiText, uiHtml, uiMarkup, uiTemplate, ProfileViewGate, RecentlyDeleted, recycleKeepNote);
  const bin = fakeBin(view([entry('p1', 'a', 'diary-day', { itemAt: DAY10 }), entry('p2', 'b', 'diary-day'), entry('p3', 'a', 'review'), entry('p4', 'a', 'text-memorial'),
    entry('p5', 'a', 'nickname')]));
  const profile = { scopeId: 'A', generation: 1, revision: 0, enabled: true, entries: [{ id: 'e1', kind: 'fact', text: '喜欢茶', source: { quote: '我喜欢茶' } }],
    diary: [{ date: '2026-11-10', text: '今天' }], reviews: [{ kind: 'week', key: '2026-11-03', text: '这一周' }],
    upcoming: [{ id: 'u1', what: '面试', said: '明天', dueAt: NOW, state: 'waiting' }] };
  let reads = 0, nicknameReads = 0; const errors: string[] = [];
  const api = { onUserProfileChanged: () => () => {}, getUserProfile: async () => { reads++; return structuredClone(profile); }, setUserProfileEnabled: async () => profile, editUserProfile: async () => profile,
    deleteUserProfile: async () => profile, editUserDiary: async () => profile, deleteUserDiary: async () => profile, clearUserDiary: async () => profile,
    deleteUserUpcoming: async () => profile, clearUserUpcoming: async () => profile, editUserReview: async () => profile, deleteUserReview: async () => profile,
    getRelationshipNickname: async () => { nicknameReads++; return null; }, setRelationshipNickname: async () => null };
  const root = new Node('section'), trigger = new Node('button'); root.hidden = true;
  const panel = new Panel(root, trigger, api, (message: string) => errors.push(message), () => {}, bin.api, () => 'a');
  panel.open(); await settle();
  assert.deepEqual(rows(root), ['p1', 'p3', 'p5'], 'only profile kinds of this character');
  const keep = '会放进回收站，7 天内能在旁边的「最近删除的」找回。';
  const confirms: [string, string][] = [['删除', '确认删除'], ['清空全部日记', '确认清空全部日记'], ['删除这天的日记', '确认删除这天的日记'], ['删除这段回顾', '确认删除这段回顾'],
    ['删除这件事', '确认删除这件事'], ['清空她记得的事', '确认清空她记得的事']];
  for (const [first, second] of confirms) {
    const before = texts(root).filter(line => line === keep).length;
    button(root, first).onclick!();
    button(root, second);
    assert.equal(texts(root).filter(line => line === keep).length, before + 1, `${second} says the bin`);
    button(root, '取消').onclick!();
  }
  const beforeReads = reads, beforeNick = nicknameReads;
  restoreButton(root, 'p1').onclick!(); await settle();
  assert.deepEqual(bin.calls, ['restore:p1']);
  assert.ok(reads > beforeReads && nicknameReads > beforeNick, 'the profile and the nickname are read again');
  panel.dispose(); assert.equal(bin.listeners.size, 0);
  assert.deepEqual(errors, []);
}));
