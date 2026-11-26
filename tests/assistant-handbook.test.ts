// I-071 v2 (2026-11-11: the assistant should know every manual, including future ones, so that questions about the software can be answered and acted on):
// read_handbook also reads every manual that ships with the app, found by folder (a page written later
// is in without editing a list), by id (never a path), and finds handbook items and manual sections for a question.
// The ten "怎么……" questions check the facts are reachable; whether the model answers well is the real smoke's job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppTools, handbookRequest } from '../electron/safety/agent-channel/app-tools';
import type { AgentAppBridge } from '../electron/safety/agent-channel/app-tools';
import { handbookDocsReader, type HandbookDocs } from '../electron/safety/assistant/docs';
import { USER_MANUALS, handbookDocFor, handbookDocSpec, queryTerms, readDocPage, splitDoc } from '../shared/safety/handbook-docs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = { signal: new AbortController().signal, check: () => {}, offerUndo: () => {} };
const handbook = (docs: HandbookDocs = handbookDocsReader(root)) => {
  const tool = createAppTools({} as AgentAppBridge, { docs }).find(item => item.name === 'read_handbook')!;
  return async (args: unknown) => tool.run(await (tool.prepare?.(tool.validate(args)) ?? tool.validate(args)), context) as Promise<any>;
};

test('the manuals are the pages on the user-manuals list: development pages, records and replaced process pages stay out', async () => {
  const docs = handbookDocsReader(root);
  const ids = (await docs.list()).map(doc => doc.id);
  for (const id of ['character-card-guide', 'character-cards', 'knobs', 'voice-design-guide', 'touching-her', 'data-map', 'release-notes/v0.1.0', 'release-notes/v0.2.0'])
    assert.ok(ids.includes(id), id);
  assert.equal(ids.length, USER_MANUALS.size, 'every page on the list is there, and nothing else');
  for (const id of ['requested-work', 'chat-handoff', 'public-claude', 'crying-implementation', 'mood/implementation-log', 'architecture', 'brainstorm-context',
    'handbook/README', 'handbook/features', 'handbook/roadmap', 'handbook/how-we-work', 'handbook/ideas', 'mood/README']) assert.ok(!ids.includes(id), id);
  assert.ok(ids.every(id => !id.startsWith('claude/') && !id.startsWith('archive/')), 'dated records are never searched');
  assert.equal(handbookDocFor('docs/claude/2026-11-11-x.md'), null);
  assert.equal(handbookDocFor('docs/archive/x.md'), null);
  assert.equal(handbookDocFor('docs/x.json'), null);
  assert.equal(handbookDocFor('docs/new-guide.md'), null, 'a page that is not on the list is not a manual (so it is not shipped either)');
  assert.equal(handbookDocFor('handbook/ideas.md'), null, 'the project handbook is not shipped');
  assert.deepEqual(handbookDocFor('docs/knobs.md'), { id: 'knobs', kind: 'guide' });
  assert.deepEqual(handbookDocFor('docs/release-notes/v0.2.0.md'), { id: 'release-notes/v0.2.0', kind: 'guide' });
  const list = new Map<string, 'guide' | 'design' | 'handbook'>([['docs/sleep-guide.md', 'guide'], ['handbook/features.md', 'handbook'], ['handbook/later.md', 'handbook'], ['docs/../x.md', 'guide']]);
  assert.deepEqual(handbookDocFor('handbook/new-page.md', new Map([['handbook/new-page.md', 'handbook']])), { id: 'handbook/new-page', kind: 'handbook' });
  assert.equal(handbookDocFor('docs/../x.md', list), null, 'a listed name with .. is never a manual');
  // Only listed pages are read, and one written later shows up once it is listed (in a copy of the layout; the real folders are not touched).
  const temp = await mkdtemp(path.join(os.tmpdir(), 'soft-assistant-docs-'));
  try {
    await mkdir(path.join(temp, 'docs', 'claude'), { recursive: true }); await mkdir(path.join(temp, 'handbook'));
    await writeFile(path.join(temp, 'docs', 'sleep-guide.md'), '<!-- 生成 -->\n# 她睡觉的样子\n\n> 状态：试用中\n\n她困了会找地方躺下，你可以叫醒她。\n');
    await writeFile(path.join(temp, 'docs', 'claude', 'record.md'), '# 记录\n');
    await writeFile(path.join(temp, 'docs', 'unlisted.md'), '# 没在名单里\n\n不会被读。\n');
    await writeFile(path.join(temp, 'handbook', 'features.md'), '# 功能与状态\n\n每个功能现在的状态。\n');
    let clock = 0;
    const reader = handbookDocsReader(temp, {}, () => clock, list);
    assert.deepEqual((await reader.list()).map(doc => [doc.id, doc.kind, doc.title]), [['sleep-guide', 'guide', '她睡觉的样子'], ['handbook/features', 'handbook', '功能与状态']]);
    assert.equal((await reader.list())[0].about, '状态：试用中', 'the first plain line describes the page');
    await writeFile(path.join(temp, 'handbook', 'later.md'), '# 以后写的\n\n新的一页。\n');
    clock = 61_000;
    assert.ok((await reader.list()).some(doc => doc.id === 'handbook/later'), 'a listed page written later is found on the next listing');
    await assert.rejects(reader.read('claude/record'), /unknown doc/);
    await assert.rejects(reader.read('unlisted'), /unknown doc/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('the packaged app ships only the pages on the user-manuals list, and every one of them is a build input', async () => {
  const build = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).build;
  const shipped = build.extraResources.filter((entry: { to: string }) => entry.to.startsWith('assistant-docs/'));
  assert.deepEqual(shipped.map((entry: { from: string; to: string }) => [entry.from, entry.to]), [['docs', 'assistant-docs/docs']], 'the project handbook is not bundled');
  assert.ok(shipped.every((entry: { filter: string[] }) => entry.filter.every(pattern => !pattern.includes('*'))), 'named files only, never a pattern');
  assert.deepEqual([...shipped[0].filter].sort(), [...USER_MANUALS.keys()].map(file => file.slice('docs/'.length)).sort(), 'package.json filter = the list');
  const updater = '../scripts/update-desktop.mjs'; // an untyped script: its one export is described here
  const { runtimeInputs } = await import(updater) as { runtimeInputs: { fixed: readonly string[]; folders: readonly string[] } };
  for (const doc of await handbookDocsReader(root).list())
    assert.ok(runtimeInputs.fixed.includes(doc.file) || runtimeInputs.folders.some((folder: string) => doc.file.startsWith(`${folder}/`)), `${doc.file} is frozen with the build`);
  const voice = handbookDocSpec('docs/voice-design-guide.md', await readFile(path.join(root, 'docs/voice-design-guide.md'), 'utf8'))!;
  assert.match(voice.title, /声音/);
});

test('read_handbook arguments: one of category / doc / find; section and part only with doc; never a path', () => {
  assert.deepEqual(handbookRequest(undefined), { kind: 'index' });
  assert.deepEqual(handbookRequest({ category: 'chat' }), { kind: 'category', category: 'chat' });
  assert.deepEqual(handbookRequest({ doc: 'knobs', section: 4 }), { kind: 'doc', doc: 'knobs', section: 4 });
  assert.deepEqual(handbookRequest({ find: ' 脸红 ' }), { kind: 'find', find: '脸红' });
  assert.deepEqual(handbookRequest({ doc: 'handbook/features' }), { kind: 'doc', doc: 'handbook/features' });
  assert.deepEqual(handbookRequest({ doc: 'handbook/features', find: ' 睡着 ' }), { kind: 'find', find: '睡着', doc: 'handbook/features' }, 'find inside one page');
  assert.throws(() => handbookRequest({ doc: 'handbook/features', find: '睡着', section: 3 }), /section/);
  assert.throws(() => handbookRequest({ category: 'chat', doc: 'knobs' }));
  for (const bad of [{ doc: 'C:/Windows/win.ini' }, { doc: '../CLAUDE' }, { doc: 'handbook/README.md' }, { doc: 'docs/claude/x/y' }, { doc: '/etc/passwd' }, { doc: 'knobs', path: 'x' }, { category: 'chat', find: 'x' },
    { section: 1 }, { doc: 'knobs', section: -1 }, { doc: 'knobs', section: 1.5 }, { find: '' }, { find: 'x'.repeat(101) }])
    assert.throws(() => handbookRequest(bad), JSON.stringify(bad));
});

test('a guide reads as contents plus one section at a time, long sections in parts, each with a citation', async () => {
  const read = handbook();
  const first = await read({ doc: 'character-card-guide' });
  assert.ok(first.contents.length >= 8);
  assert.equal(first.section, 0);
  assert.match(first.cite, /^《角色卡和她的数值怎么写》/);
  const faq = first.contents.find((item: { heading: string }) => item.heading === '常见问题');
  const page = await read({ doc: 'character-card-guide', section: faq.section });
  assert.equal(page.heading, '常见问题');
  assert.equal(page.cite, '《角色卡和她的数值怎么写》「常见问题」');
  await assert.rejects(read({ doc: 'character-cards', section: 99 }), /只有/);
  const long = readDocPage(handbookDocSpec('docs/x.md', '# X', new Map([['docs/x.md', 'guide']]))!, `## 长\n${'字'.repeat(20_000)}`, 0, 2);
  assert.equal(long.part, 2);
  assert.equal(long.parts, 3);
  assert.equal(splitDoc('# T\n```\n## not a heading\n```\n## Real').map(item => item.heading).join('|'), '开头|Real');
  // The index names every manual, grouped by kind, and stays well under the channel's 48 KB limit.
  const index = await read({});
  const listed = index.docs.flatMap((group: { docs: Array<{ doc: string }> }) => group.docs.map(doc => doc.doc));
  assert.deepEqual([...listed].sort(), (await handbookDocsReader(root).list()).map(doc => doc.id).sort());
  assert.deepEqual(index.docs.map((group: { kind: string }) => group.kind.slice(0, 4)), ['说明文档'], 'the shipped manuals are all guides; no project-handbook group');
  assert.doesNotMatch(index.docsHow, /handbook\/features|项目手册/u, 'the index does not point at pages that are not shipped');
  assert.ok(Buffer.byteLength(JSON.stringify(index)) < 40_000, `index is ${Buffer.byteLength(JSON.stringify(index))} bytes`);
  await assert.rejects(read({ doc: 'requested-work' }), /没有这份文档/);
  await assert.rejects(read({ doc: 'claude/2026-11-11-x' }), /没有这份文档/);
  // A page that cannot be read is said plainly, never guessed.
  const none = handbook({ list: async () => [handbookDocSpec('docs/knobs.md', '# 旋钮')!], read: () => Promise.reject(new Error('gone')) });
  await assert.rejects(none({ doc: 'knobs' }), /读不出来/);
  const touching = await read({ doc: 'touching-her' });
  assert.match(touching.cite, /^《怎么摸她的头/);
});

test('ten common "怎么……" questions reach the right handbook item or guide section', async () => {
  const read = handbook();
  const cases: Array<[string, string]> = [
    ['怎么让她更常主动说话', 'item:proactive_talk'],
    ['怎么写角色卡的人设', 'doc:character-card-guide'],
    ['怎么导入角色卡', 'item:character_import'],
    ['脸红多久会再红', 'doc:knobs'],
    ['怎么关掉朗读', 'item:read_aloud'],
    ['删除的记忆怎么找回', 'item:restore_memories'],
    ['怎么让她跟着鼠标看', 'item:follow_mouse'],
    ['怎么调她的声音的音色和风格', 'item:tts_voice_style'],
    ['反应倾向是什么', 'item:reaction_dispositions'],
    ['怎么打开摄像头', 'item:camera_sharing'],
  ];
  for (const [question, expected] of cases) {
    const found = await read({ find: question });
    const top = [...found.handbookItems.slice(0, 3).map((item: { id: string }) => `item:${item.id}`), ...found.docs.slice(0, 3).map((doc: { doc: string }) => `doc:${doc.doc}`)];
    assert.ok(top.includes(expected), `${question}: ${top.join(', ')}`);
  }
  assert.deepEqual(queryTerms('怎么写什么'), [], 'question words alone are not a search');
  // The shipped manuals are all guides: no project-handbook or design hits, and a guide list that stays short.
  const sleep = await read({ find: '睡觉 睡姿 叫醒' });
  assert.equal(sleep.handbookDocs.length, 0);
  assert.equal(sleep.designDocs.length, 0);
  assert.ok(sleep.docs.length <= 5);
  assert.doesNotMatch(sleep.how, /handbook\/features|项目手册/u);
});

test('one section per page, a search inside one page finds the row, and a question the manuals cannot answer says so', async () => {
  const read = handbook();
  const general = await read({ find: '怎么摸她的头、捏脸' });
  for (const list of [general.docs, general.designDocs, general.handbookDocs]) assert.equal(new Set(list.map((hit: { doc: string }) => hit.doc)).size, list.length, 'one section per page');
  assert.ok(general.docs.some((hit: { doc: string }) => hit.doc === 'touching-her'), 'the touch guide is found by its own words');
  const inside = await read({ doc: 'touching-her', find: '嘴边 松开' });
  assert.equal(inside.doc, 'touching-her');
  assert.ok(inside.hits.length >= 1 && inside.hits.length <= 6);
  const none = await read({ doc: 'touching-her', find: 'zzqx' });
  assert.equal(none.hits.length, 0);
  assert.match(none.how, /换一两个说法/u);
  await assert.rejects(read({ doc: 'requested-work', find: '睡' }), /没有这份文档/u);
  await assert.rejects(read({ doc: 'handbook/features', find: '睡' }), /没有这份文档/u, 'the project handbook is not shipped, so it cannot be read');
});

test('a reader that does list project-handbook pages (a development checkout that adds them) still gets the status hint; the shipped list does not', async () => {
  const features = handbookDocSpec('handbook/features.md', '# 功能与状态\n\n睡觉：I-078 已做。\n', new Map([['handbook/features.md', 'handbook']]))!;
  const read = handbook({ list: async () => [features], read: async () => '# 功能与状态\n\n## 睡觉\n\n睡觉：I-078 已做。\n' });
  const found = await read({ find: '睡觉' });
  assert.match(found.how, /handbook\/features/u, 'the status hint appears when such a page is listed');
  assert.ok(found.handbookDocs.length > 0);
  const index = await read({});
  assert.match(index.docsHow, /handbook\/features/u);
});
