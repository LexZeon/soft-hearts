// I-208 角色档案 step 1 (docs/claude/2026-11-24-i208-archive-step1.md): one character's archive, read only. Real stores and files (the conversion's fixture),
// synthetic words. What must hold: only the asked character's data is ever read or shown; a request is bounded and paged; the search finds across kinds in
// Chinese and English; nothing is written; nothing here reaches a prompt; the window draws empty states in Chinese and a milestone only for a card that declares one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CharacterArchiveReader, type ArchivePorts } from '../electron/memory';
import { userProfileScopeId } from '../electron/memory/user-profile';
import { MEMORY_NOTES_FILE } from '../electron/memory/memory-notes/store';
import { archiveSection, type RawArchiveItem } from '../electron/memory/archive/search';
import { registerCharacterArchive } from '../electron/wiring/character-archive-wiring';
import { ARCHIVE_KINDS, ARCHIVE_LIMITS, parseArchiveRequest, type CharacterArchiveView } from '../shared/memory/archive';
import { memoryProviderScope } from '../electron/brain/companion';
import { forgettableProviderScopes } from '../electron/cards/character-forget';
import { CharacterArchivePanel } from '../src/cards/CharacterArchive';
import { setUiLanguage } from '../shared/foundation/ui-language';
import { daysAgoKey, filesOf, makeFixture, provider, providerScope, withDirectory, type Fixture } from './helpers/convert-fixture';

const MILESTONE = { name: '这一单', notYet: '还没签收', reached: '已签收' };

/** The conversion fixture's character 阿澄 (diary of three days, two notes, one fact, familiarity, two nicknames) plus a second one whose words are all marked. */
async function twoCharacters(directory: string): Promise<{ fixture: Fixture; other: string; reader: CharacterArchiveReader; ports: ArchivePorts; touched: string[] }> {
  const fixture = await makeFixture(directory);
  await fixture.cards.save({ name: 'Gene', description: 'a courier', personality: 'cheerful', scenario: '', greeting: 'hi', examples: '', systemPrompt: '' });
  const other = fixture.cards.publicState().cards.find(card => card.name === 'Gene')!.id;
  // her profile, diary (one day), and a birthday the user told her
  const { profiles, companion } = fixture;
  await profiles.activate({ characterId: other, providerScope }); profiles.setEnabled(true);
  const text = 'B-SECRET-FACT 我的生日是3月5日';
  const ticket = profiles.beginObservation(profiles.acceptUserMessage({ requestId: 'b-fact', messageId: 'b-m', source: 'text', text, acceptedAt: Date.now() }));
  await profiles.completeObservation(ticket!, 'b-fact', [{ kind: 'fact', quoteStart: 0, quoteEnd: text.length }]);
  await profiles.saveDiary(profiles.diaryTicket()!, daysAgoKey(1), 'B-SECRET-DIARY Gene delivered a parcel', 'B-SECRET-MEME');
  // her chat and a note
  const persona = 'Gene persona';
  await companion.context(other, provider, persona);
  const turn = await companion.begin('b-chat', 'B-SECRET-CHAT parcels', persona, () => {}, {});
  turn.push('delta', 'ok'); await turn.finish('complete');
  const segment = companion.memory.noteSegments(Date.now()).find(item => item.scope === companion.memory.noteScope({ characterId: other, providerScope }))!;
  const file = path.join(directory, MEMORY_NOTES_FILE), data = JSON.parse(readFileSync(file, 'utf8'));
  data.notes.push({ recordId: segment.id, source: 'b.x', segmentAt: segment.createdAt, writtenAt: Date.now(),
    body: { title: 'B-SECRET-NOTE parcels', summary: 'The user asked about a parcel to Mars.', people: ['Mars Post'], things: ['parcel'], mood: 'curious', plans: ['send the parcel'], tags: ['Courier', 'Mars'] } });
  await writeFile(file, JSON.stringify(data));
  await companion.relationship.seed(other, { version: 1, metDate: daysAgoKey(5), days: [daysAgoKey(5)], qualityDays: [], today: { date: daysAgoKey(0), rounds: 1, touched: false },
    backfilled: [], nickname: 'B-SECRET-NICK', herNickname: null, nicknameAsked: true, milestones: [] });
  await Promise.all([companion.flush(), companion.relationship.flush()]);
  await profiles.settled?.();
  const touched: string[] = [];
  const ports: ArchivePorts = {
    profileDirectory: directory,
    card: id => { touched.push(`card:${id}`); const card = fixture.cards.publicState().cards.find(item => item.id === id); return card ? { milestone: id === other ? MILESTONE : undefined } : undefined; },
    providerScopes: id => { touched.push(`scopes:${id}`); return [...new Set([...forgettableProviderScopes(provider, memoryProviderScope), ...companion.memory.providerScopesOf(id)])]; },
    noteScope: scope => companion.memory.noteScope(scope), noteSegments: now => companion.memory.noteSegments(now),
    relationship: id => companion.relationship.snapshot(id), now: () => Date.now(),
  };
  return { fixture, other, reader: new CharacterArchiveReader(ports), ports, touched };
}
const section = (view: CharacterArchiveView, kind: string) => view.sections.find(item => item.kind === kind)!;
const texts = (view: CharacterArchiveView, kind: string) => section(view, kind).items.map(item => `${item.title}|${item.text}`).join('\n');

test('her archive gathers what her memory holds, by kind, newest first, with dates; nothing is written', async () => withDirectory(async directory => {
  const { fixture, reader } = await twoCharacters(directory);
  const before = await filesOf(directory);
  const view = await reader.read({ characterId: fixture.sourceId });
  assert.deepEqual(view.sections.map(item => item.kind), [...ARCHIVE_KINDS]);
  const diary = section(view, 'diary');
  assert.equal(diary.total, 3);
  assert.deepEqual(diary.items.map(item => item.date), [daysAgoKey(1), daysAgoKey(2), daysAgoKey(3)], 'newest first');
  assert.equal(diary.items[0]!.title, '抢不到的布丁', 'the in-joke of that day');
  assert.match(texts(view, 'notes'), /下雨天的书店[\s\S]*周五面试|周五面试[\s\S]*下雨天的书店/u);
  assert.equal(section(view, 'notes').total, 2);
  assert.match(texts(view, 'portrait'), /钢琴/u);
  assert.equal(section(view, 'portrait').items[0]!.tag, 'fact');
  const familiarity = section(view, 'familiarity').items;
  assert.deepEqual(familiarity.map(item => item.tag), ['met', 'days', 'effective', 'quality', 'nickname', 'herNickname']);
  assert.equal(familiarity.find(item => item.tag === 'nickname')!.text, '小雨');
  assert.equal(familiarity.find(item => item.tag === 'days')!.text, '2');
  assert.equal(section(view, 'plans').total, 0); assert.equal(section(view, 'anniversaries').total, 0);
  assert.equal(view.milestone, null, 'a card that declares none has no milestone section');
  assert.equal(section(view, 'milestone').total, 0);
  const after = await filesOf(directory);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file was made or removed');
  for (const [file, bytes] of before) assert.ok(bytes.equals(after.get(file)!), `${file} was not changed`);
}));

test('another character\'s diary, notes, portrait, nicknames and plans never appear, in either direction', async () => withDirectory(async directory => {
  const { fixture, other, reader } = await twoCharacters(directory);
  const upcoming = (characterId: string, what: string) => ({ version: 1, scopeId: userProfileScopeId({ characterId, providerScope }), upcoming: { blockedFrom: [], items: [
    { id: `plan-${what}`, from: 'rec', what, said: '周五', dueAt: Date.now() + 86_400_000, expiresAt: Date.now() + 5 * 86_400_000, state: 'waiting', createdAt: Date.now(), changedAt: Date.now() }] } });
  await writeFile(path.join(directory, 'user-profiles', `upcoming-${userProfileScopeId({ characterId: other, providerScope })}.json`), JSON.stringify(upcoming(other, 'B-SECRET-PLAN')));
  await writeFile(path.join(directory, 'user-profiles', `upcoming-${userProfileScopeId({ characterId: fixture.sourceId, providerScope })}.json`), JSON.stringify(upcoming(fixture.sourceId, 'A-PLAN')));
  const mine = JSON.stringify(await reader.read({ characterId: fixture.sourceId }));
  assert.doesNotMatch(mine, /B-SECRET|Mars|Gene delivered/u, 'the other character\'s words');
  assert.match(mine, /A-PLAN/u);
  const hers = await reader.read({ characterId: other });
  const text = JSON.stringify(hers);
  assert.doesNotMatch(text, /书店|面试|钢琴|布丁|小雨|A-PLAN/u, 'none of 阿澄\'s words');
  for (const word of ['B-SECRET-DIARY', 'B-SECRET-NOTE', 'B-SECRET-FACT', 'B-SECRET-NICK', 'B-SECRET-PLAN', 'B-SECRET-MEME']) assert.ok(text.includes(word), `${word} is hers`);
  assert.equal(section(hers, 'anniversaries').items.length, 1, 'the birthday the user told her');
  assert.deepEqual(section(hers, 'anniversaries').items[0]!.text, '3-5');
  assert.equal(section(hers, 'anniversaries').items[0]!.tag, 'birthday');
  assert.equal(section(hers, 'plans').items[0]!.tag, 'waiting');
  assert.match(section(hers, 'plans').items[0]!.text, /B-SECRET-PLAN（周五）/u);
}));

test('a character id that is not one of her cards opens no file and answers empty', async () => withDirectory(async directory => {
  const { reader, touched, fixture } = await twoCharacters(directory);
  touched.length = 0;
  const view = await reader.read({ characterId: 'nobody-by-that-name' });
  assert.ok(view.sections.every(item => item.total === 0 && item.items.length === 0));
  assert.equal(view.milestone, null);
  assert.deepEqual(touched, ['card:nobody-by-that-name'], 'her connections were never even listed');
  assert.equal((await reader.read({ characterId: fixture.sourceId })).sections.length, ARCHIVE_KINDS.length);
}));

test('the milestone: only a card that declares one shows it, with the card\'s words and the local date', async () => withDirectory(async directory => {
  const { other, reader, fixture, touched } = await twoCharacters(directory);
  const open = await reader.read({ characterId: other });
  assert.deepEqual(open.milestone, { ...MILESTONE, done: false, date: null });
  assert.equal(texts(open, 'milestone'), '这一单|还没签收');
  await fixture.companion.relationship.reachCardMilestone(other);
  const done = await reader.read({ characterId: other });
  assert.equal(done.milestone?.done, true);
  assert.match(done.milestone!.date!, /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(section(done, 'milestone').items[0]!.tag, 'reached');
  // the user profile page's own read asks for the milestone alone: only the card and her relationship file are read
  touched.length = 0;
  const alone = await reader.read({ characterId: other, kind: 'milestone', limit: 1 });
  assert.equal(alone.milestone?.done, true); assert.deepEqual(touched, [`card:${other}`], 'no connection list, no profile, no notes');
}));

test('the search: one box over every kind, Chinese and English, case and width folded, with the kind and date of each hit', async () => withDirectory(async directory => {
  const { reader, fixture, other } = await twoCharacters(directory);
  const zh = await reader.read({ characterId: fixture.sourceId, query: '书店' });
  assert.deepEqual(zh.sections.filter(item => item.total).map(item => item.kind), ['diary', 'notes'], '书店 is in her diary and her notes');
  assert.ok(section(zh, 'diary').items.every(item => /^\d{4}-\d{2}-\d{2}$/u.test(item.date)));
  const en = await reader.read({ characterId: other, query: 'gene' });
  assert.ok(section(en, 'diary').total === 1, 'Gene in the diary, in lower case');
  assert.equal((await reader.read({ characterId: other, query: 'ＭＡＲＳ' })).sections.filter(item => item.total).map(item => item.kind).join(), 'notes', 'a full-width word finds the plain one (people, tags: words not shown)');
  assert.equal((await reader.read({ characterId: other, query: 'courier' })).sections.find(item => item.kind === 'notes')!.total, 1, 'a tag');
  assert.deepEqual((await reader.read({ characterId: fixture.sourceId, query: '称呼' })).sections.filter(item => item.total).map(item => item.kind), ['familiarity']);
  assert.deepEqual((await reader.read({ characterId: other, query: 'birthday' })).sections.filter(item => item.total).map(item => item.kind), ['anniversaries']);
  const none = await reader.read({ characterId: fixture.sourceId, query: '没有这个词的东西' });
  assert.ok(none.sections.every(item => item.total === 0));
  assert.equal(none.query, '没有这个词的东西');
}));

test('a request is exactly one shape; limits are clamped; a section pages with `more`', () => {
  assert.deepEqual(parseArchiveRequest({ characterId: 'a' }), { characterId: 'a', query: '', kind: null, offset: 0, limit: ARCHIVE_LIMITS.pageDefault });
  assert.equal(parseArchiveRequest({ characterId: 'a', limit: 100_000 }).limit, ARCHIVE_LIMITS.pageMax);
  assert.equal(parseArchiveRequest({ characterId: 'a', query: 'x'.repeat(500) }).query.length, ARCHIVE_LIMITS.queryMax);
  for (const bad of [null, 'a', [], {}, { characterId: '' }, { characterId: 'a'.repeat(300) }, { characterId: 5 }, { characterId: 'a', path: 'C:/x' }, { characterId: 'a', kind: 'prompts' },
    { characterId: 'a', offset: -1 }, { characterId: 'a', offset: 1.5 }, { characterId: 'a', limit: 0 }, { characterId: 'a', query: {} }, { characterId: 'a\u0000b' }])
    assert.throws(() => parseArchiveRequest(bad), /档案的请求格式不正确/u);
  const raw = (n: number): RawArchiveItem[] => Array.from({ length: n }, (_, index) => ({ id: `d${index}`, date: '', title: '', text: `item ${index}`, tag: '', sort: index, words: '' }));
  const first = archiveSection('diary', raw(120), { query: '', offset: 0, limit: 50 });
  assert.equal(first.items.length, 50); assert.equal(first.total, 120); assert.equal(first.more, true); assert.equal(first.items[0]!.id, 'd119', 'newest first');
  const last = archiveSection('diary', raw(120), { query: '', offset: 100, limit: 50 });
  assert.equal(last.items.length, 20); assert.equal(last.more, false);
  assert.equal(archiveSection('diary', raw(120), { query: '', offset: 500, limit: 50 }).items.length, 0);
  assert.equal(archiveSection('diary', [{ ...raw(1)[0]!, text: 'y'.repeat(5000) }], { query: '', offset: 0, limit: 5 }).items[0]!.text.length, ARCHIVE_LIMITS.itemChars, 'one item is bounded');
});

test('a character with a long history: one answer is bounded and the next page continues where it stopped', async () => withDirectory(async directory => {
  const { reader, fixture, other } = await twoCharacters(directory);
  const diary = Array.from({ length: ARCHIVE_LIMITS.gatherMax + 200 }, (_, index) => {
    const day = new Date(Date.UTC(2020, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);
    return { date: day, text: `long-day ${index} ${'x'.repeat(2000)}`, writtenAt: 1_700_000_000_000 + index };
  });
  const file = path.join(directory, 'user-profiles', `profile-${userProfileScopeId({ characterId: other, providerScope })}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, scopeId: userProfileScopeId({ characterId: other, providerScope }), entries: [], blocked: [], diary }));
  const first = await reader.read({ characterId: other });
  const page = section(first, 'diary');
  assert.equal(page.items.length, ARCHIVE_LIMITS.pageDefault); assert.equal(page.total, ARCHIVE_LIMITS.gatherMax, 'the newest 1000 are listed'); assert.equal(page.more, true);
  assert.ok(JSON.stringify(first).length < 120_000, 'one answer stays small');
  assert.ok(page.items.every(item => item.text.length <= ARCHIVE_LIMITS.itemChars));
  const next = await reader.read({ characterId: other, kind: 'diary', offset: page.items.length });
  assert.equal(next.sections.length, 1); assert.equal(next.sections[0]!.items.length, ARCHIVE_LIMITS.pageDefault);
  assert.ok(next.sections[0]!.items[0]!.date < page.items.at(-1)!.date, 'the next page is older, never a repeat');
  assert.ok(fixture.sourceId);
}));

test('the host call: control window only, only the one request shape, the reader\'s answer back', async () => withDirectory(async directory => {
  const { fixture, ports } = await twoCharacters(directory);
  const registered: { method: string; controlOnly: boolean | undefined; run: (request: unknown) => Promise<CharacterArchiveView> }[] = [];
  registerCharacterArchive({ host: (method, run, controlOnly) => { registered.push({ method, controlOnly, run: run as never }); }, scopedHost: () => { throw new Error('not used'); } },
    { store: { directory, current: { provider } }, characterCards: { publicState: () => fixture.cards.publicState() }, companion: { memory: fixture.companion.memory, relationship: fixture.companion.relationship } } as never);
  assert.deepEqual(registered.map(item => [item.method, item.controlOnly]), [['getCharacterArchive', undefined]], 'the default is the control window only');
  const view = await registered[0]!.run({ characterId: fixture.sourceId, query: '面试' });
  assert.equal(section(view, 'notes').total, 1);
  await assert.rejects(registered[0]!.run({ characterId: fixture.sourceId, file: 'C:/Windows/win.ini' }), /档案的请求格式不正确/u);
  assert.ok(ports.profileDirectory);
}));

test('nothing but the archive and its page reaches the archive: no prompt, brain, voice or mood file mentions it', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const allowed = new Set(['electron/memory/archive/reader.ts', 'electron/memory/archive/search.ts', 'electron/memory/archive/readers.ts', 'electron/memory/index.ts', 'electron/wiring/character-archive-wiring.ts',
    'electron/wiring/memory-wiring.ts', 'electron/wiring/ipc-shells-wiring.ts', 'electron/safety/preload.ts', 'shared/memory/archive.ts', 'shared/memory/index.ts', 'shared/memory/desktop-api.ts',
    'src/cards/CharacterArchive.ts', 'src/cards/CharacterPage.ts', 'src/memory/UserProfilePanel.ts', 'electron/cards/character-convert/snapshot.ts', 'shared/cards/card-milestone.ts', 'src/memory/CardMilestoneSection.ts']);
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(path.join(root, directory))) {
      const relative = `${directory}/${name}`;
      if (statSync(path.join(root, relative)).isDirectory()) { if (!['node_modules', 'tests'].includes(name)) walk(relative); continue; }
      if (!/\.(ts|mjs|js)$/u.test(name) || allowed.has(relative)) continue;
      if (/memory\/archive|CharacterArchiveReader|getCharacterArchive|archive\/(reader|readers|search)/u.test(readFileSync(path.join(root, relative), 'utf8'))) found.push(relative);
    }
  };
  for (const directory of ['electron', 'shared', 'src']) walk(directory);
  assert.deepEqual(found, [], 'only the allowed files know the archive');
  const wiring = readFileSync(path.join(root, 'electron/wiring/character-archive-wiring.ts'), 'utf8');
  assert.doesNotMatch(wiring, /\.(write|update|set|delete|clear|save|reach|forget|adopt|seed)\w*\(/u, 'the archive\'s live end only reads');
});

// ---- the window ----

class Node {
  children: Node[] = []; textContent = ''; className = ''; id = ''; hidden = false; disabled = false; type = ''; value = ''; placeholder = '';
  dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
  onclick: (() => void) | null = null; oninput: (() => void) | null = null; onkeydown: ((event: { key: string; preventDefault(): void }) => void) | null = null;
  constructor(readonly tagName: string) {}
  append(...children: (Node | string)[]) { this.children.push(...children.map(child => typeof child === 'string' ? Object.assign(new Node('#text'), { textContent: child }) : child)); }
  replaceChildren(...children: Node[]) { this.children = [...children]; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
}
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const textOf = (node: Node): string => all(node).map(item => item.textContent).join('|');
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const doc = { createElement: (tag: string) => new Node(tag) } as unknown as Document;
const emptyView = (milestone: CharacterArchiveView['milestone'] = null): CharacterArchiveView => ({ characterId: 'a', query: '',
  sections: ARCHIVE_KINDS.map(kind => ({ kind, total: 0, items: [], more: false })), milestone, object: null });

test('the page: empty states in Chinese, no milestone section for a card without one, nothing asked until it is opened', async () => {
  setUiLanguage('zh-CN');
  const requests: unknown[] = [];
  const panel = new CharacterArchivePanel(doc, { api: async request => { requests.push(request); return emptyView(); }, onError: message => { throw new Error(message); } });
  const element = panel.element as unknown as Node;
  assert.equal(element.hidden, true); assert.deepEqual(requests, []);
  await panel.open('a', '阿澄');
  assert.deepEqual(requests, [{ characterId: 'a' }]);
  const text = textOf(element);
  for (const word of ['日记', '聊天笔记', '她眼里的你', '特别的日子', '她记得的计划', '熟悉度', '还没有日记', '还没有聊天笔记', '还没有记下关于你的事', '你还没告诉她生日或纪念日', '她还没有记下你说过的计划', '还没有聊过'])
    assert.ok(text.includes(word), word);
  assert.ok(!text.includes('她的里程碑'), 'only a card that declares one');
  assert.ok(text.includes('这里只看'), 'it says it only reads');
  assert.equal(all(element).filter(node => node.tagName === 'button' && node.dataset.archiveAction === 'more').length, 0);
  panel.close(); assert.equal(element.hidden, true);
});

test('the page: items with dates and labels, a search, more pages, a milestone section when the card declares one, and an English version', async () => {
  setUiLanguage('zh-CN');
  const requests: { characterId: string; query?: string; kind?: string; offset?: number }[] = [];
  const year = new Date().getFullYear();
  const item = (id: string, over: Partial<CharacterArchiveView['sections'][number]['items'][number]> = {}) => ({ id, date: `${year}-11-23`, title: '', text: id, tag: '', ...over });
  const answer = (request: { query?: string; kind?: string; offset?: number }): CharacterArchiveView => {
    const base = emptyView({ ...MILESTONE, done: true, date: `${year}-11-23` });
    const sections = base.sections.map(entry => {
      if (entry.kind === 'diary') return { ...entry, total: 3, items: request.offset ? [item('diary-3')] : [item('diary-1', { title: '抢不到的布丁' }), item('diary-2')], more: !request.offset };
      if (entry.kind === 'plans' && !request.query) return { ...entry, total: 1, items: [item('plan-1', { tag: 'waiting', text: '周五面试' })] };
      if (entry.kind === 'anniversaries' && !request.query) return { ...entry, total: 1, items: [item('ann', { tag: 'birthday', text: '3-5', date: '' })] };
      if (entry.kind === 'familiarity' && !request.query) return { ...entry, total: 2, items: [item('f-days', { tag: 'days', text: '12' }), item('f-nick', { tag: 'nickname', text: '小雨' })] };
      if (entry.kind === 'milestone') return { ...entry, total: 1, items: [item('milestone', { title: '这一单', text: '已签收', tag: 'reached' })] };
      return entry;
    });
    return { ...base, query: request.query ?? '', sections };
  };
  const panel = new CharacterArchivePanel(doc, { api: async request => { requests.push(request); return answer(request); }, onError: message => { throw new Error(message); }, searchDelayMs: 0, openBin: () => requests.push({ characterId: 'bin' }) });
  const element = panel.element as unknown as Node;
  await panel.open('a', '阿澄');
  let text = textOf(element);
  assert.ok(text.includes('11月23日'), 'a date'); assert.ok(text.includes('小梗：抢不到的布丁'));
  assert.ok(text.includes('等着') && text.includes('周五面试'), 'a plan with its state');
  assert.ok(text.includes('生日 · 3月5日'), 'a special day'); assert.ok(text.includes('一起聊过的天数：12') && text.includes('她叫你：小雨'));
  assert.ok(text.includes('她的里程碑') && text.includes('这一单') && text.includes('已签收'));
  assert.ok(text.includes('日记 (3)'));
  const more = all(element).find(node => node.dataset.archiveAction === 'more' && node.dataset.archiveKind === 'diary')!;
  more.onclick!(); await flush();
  assert.deepEqual(requests.at(-1), { characterId: 'a', kind: 'diary', offset: 2 });
  assert.equal(all(element).filter(node => node.dataset.archiveItem?.startsWith('diary')).length, 3, 'the next page is added after the first');
  assert.ok(!all(element).some(node => node.dataset.archiveAction === 'more'), 'no more once all are shown');
  const box = all(element).find(node => node.dataset.archiveField === 'query')!;
  box.value = ' 书店 '; box.oninput!(); await new Promise(resolve => setTimeout(resolve, 20)); await flush();
  assert.deepEqual(requests.at(-1), { characterId: 'a', query: '书店' });
  text = textOf(element);
  assert.ok(text.includes('没有找到包含「书店」的内容。'), 'an empty search says so');
  assert.ok(!text.includes('还没有日记'), 'a search that finds nothing is not "no diary yet"');
  all(element).find(node => node.dataset.archiveAction === 'open-bin')!.onclick!();
  assert.deepEqual(requests.at(-1), { characterId: 'bin' }, 'it points to the recycle bin and has no delete of its own');
  assert.ok(!all(element).some(node => /delete|remove|clear/u.test(Object.values(node.dataset).join(' '))), 'no delete control');
  setUiLanguage('en');
  const english = new CharacterArchivePanel(doc, { api: async () => answer({}), onError: message => { throw new Error(message); } });
  await english.open('a', 'Gene');
  const out = textOf(english.element as unknown as Node);
  setUiLanguage('zh-CN');
  assert.ok(out.includes('Diary (3)') && out.includes('Birthday') && out.includes('Waiting') && out.includes('She calls you: 小雨'), out);
  assert.ok(!/[\u4e00-\u9fff]/u.test(out.replace(/小雨|抢不到的布丁|周五面试|这一单|已签收|阿澄/gu, '')), 'every word of the page itself is English');
});

test('a late answer for an earlier question never lands on a later page', async () => {
  setUiLanguage('zh-CN');
  const gates: ((view: CharacterArchiveView) => void)[] = [];
  const panel = new CharacterArchivePanel(doc, { api: () => new Promise<CharacterArchiveView>(resolve => gates.push(resolve)), onError: () => {} });
  const first = panel.open('a', '阿澄'); const second = panel.open('b', 'Gene');
  const view = (id: string): CharacterArchiveView => ({ ...emptyView(), characterId: id, sections: emptyView().sections.map(entry => entry.kind === 'diary' ? { ...entry, total: 1, items: [{ id: `diary-${id}`, date: '', title: '', text: `words of ${id}`, tag: '' }] } : entry) });
  gates[1]!(view('b')); await second; gates[0]!(view('a')); await first; await flush();
  const text = textOf(panel.element as unknown as Node);
  assert.ok(text.includes('words of b') && !text.includes('words of a'));
});
