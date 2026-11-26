// Unbound v1 step 3, sub-step 2 (docs/claude/2026-11-17-unbound-step3.md): the nickname table. Names the user calls her are added (never
// overwritten), only when the user really said them; the user can add and remove; what counts as "calling her" is her real name and those.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HER_NICKNAMES_MAX, cleanHerNicknames, nameHeard, saidInText, wakeNames, withHerNickname, withoutHerNickname,
} from '../shared/memory/nickname-table';
import { validateRelationship } from '../electron/memory/relationship/store';
import { RelationshipHost } from '../electron/memory/relationship/host';
import { createNicknameRoute } from '../electron/memory/relationship/nickname-route';

test('the list grows: a new name is added at the end, the same one again only moves, the oldest leaves past the cap', () => {
  let list: string[] = [];
  list = withHerNickname(list, '小艾'); list = withHerNickname(list, '宝'); list = withHerNickname(list, '小艾');
  assert.deepEqual(list, ['宝', '小艾']);
  assert.deepEqual(withHerNickname(list, '  '), list, 'not a name: unchanged');
  assert.deepEqual(withHerNickname(list, '<b>x</b>'), list);
  for (let i = 0; i < HER_NICKNAMES_MAX + 3; i++) list = withHerNickname(list, `名字${i}`);
  assert.equal(list.length, HER_NICKNAMES_MAX); assert.equal(list.at(-1), `名字${HER_NICKNAMES_MAX + 2}`);
  assert.deepEqual(withoutHerNickname(['宝', '小艾'], '小艾'), ['宝']);
  assert.deepEqual(cleanHerNicknames(['宝', '小艾']), ['宝', '小艾']);
  assert.equal(cleanHerNicknames(['宝', '宝']), null, 'a stored list with a duplicate is not one');
  assert.equal(cleanHerNicknames('宝'), null);
});

test('only what was really said: the name must appear in the user\'s own words', () => {
  assert.equal(saidInText('小艾', '以后就叫你小艾啦'), true);
  assert.equal(saidInText('小艾', '以后就叫你 小 艾！'), true, 'spaces and punctuation do not matter');
  assert.equal(saidInText('Fifi', '你就叫 fifi 吧'), true);
  assert.equal(saidInText('小艾艾', '以后就叫你小艾啦'), false, 'a name the model made up is not added');
  assert.equal(saidInText('小艾', ''), false);
});

test('what counts as calling her: her real name and what the user calls her, two characters or more, as written', () => {
  const names = wakeNames({ herName: '艾琳', herNicknames: ['宝', '小艾', '艾琳'] });
  assert.deepEqual(names, ['艾琳', '小艾'], 'a single character is never listened for; duplicates once');
  assert.equal(nameHeard('小艾你看这个', names), '小艾');
  assert.equal(nameHeard('艾琳，在吗？', names), '艾琳');
  assert.equal(nameHeard('今天天气不错', names), null);
  assert.equal(nameHeard('飞鸥你', names), null, 'no sound-alikes (that needs a pinyin table, not downloaded)');
});

test('the relationship file keeps the list; older files have none, a broken list leaves the file alone', () => {
  const base = { version: 1, metDate: '2026-11-01', days: [], qualityDays: [], today: { date: '2026-11-17', rounds: 0, touched: false }, backfilled: [], nickname: null, herNickname: '小艾', nicknameAsked: false, milestones: [] };
  assert.equal(validateRelationship(base).herNicknames, undefined, 'older file: no list (her one name is still herNickname)');
  assert.deepEqual(validateRelationship({ ...base, herNicknames: ['宝贝', '小艾'] }).herNicknames, ['宝贝', '小艾']);
  assert.throws(() => validateRelationship({ ...base, herNicknames: ['宝贝', 3] }));
});

async function hostIn(dir: string) {
  return new RelationshipHost({ directory: dir, developerMode: () => false, now: () => Date.parse('2026-11-17T12:00:00') });
}

test('host: the chat adds names (never overwrites), the user adds and removes, removal hands back what goes to the bin', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nick-table-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = await hostIn(dir);
  await host.ensure('c1');
  assert.equal(await host.noteHerNickname('c1', '小艾'), 'saved');
  assert.equal(await host.noteHerNickname('c1', '宝贝'), 'saved');
  assert.deepEqual(host.herNicknames('c1'), ['小艾', '宝贝'], 'the older name stays');
  assert.equal(host.herNickname('c1'), '宝贝', 'the newest is still the one her opening line uses');
  assert.equal(await host.addHerNickname('c1', '菲菲'), 'saved');
  assert.deepEqual(host.herNicknames('c1'), ['小艾', '宝贝', '菲菲']);
  assert.equal(await host.removeHerNickname('c1', '宝贝'), '宝贝');
  assert.deepEqual(host.herNicknames('c1'), ['小艾', '菲菲']);
  assert.equal(host.herNickname('c1'), '菲菲');
  assert.equal(await host.removeHerNickname('c1', '菲菲'), '菲菲');
  assert.equal(host.herNickname('c1'), '小艾', 'the removed newest one is not used any more: the one before it is');
  assert.equal(await host.removeHerNickname('c1', '没有这个'), null);
  await host.restoreHerNickname('c1', '菲菲');
  await host.restoreHerNickname('c1', '宝贝', 1);
  assert.deepEqual(host.herNicknames('c1'), ['小艾', '宝贝', '菲菲'], 'back from the bin, each where it was');
  assert.equal(host.herNickname('c1'), '菲菲');
  const file = JSON.parse(await readFile(path.join(dir, 'relationship', 'c1.json'), 'utf8'));
  assert.deepEqual(file.herNicknames, ['小艾', '宝贝', '菲菲'], 'kept in the relationship file only');
});

test('the nickname route adds a name for her only when the user really said it', async () => {
  const added: string[] = [];
  const route = createNicknameRoute({
    verdict: async (_id, module) => module === 'nickname-her' ? { kind: 'called', name: '小艾菲' } as never : { kind: 'none' } as never,
    relationship: { noteUserNickname: async () => undefined, noteHerNickname: async (_c, name) => { added.push(String(name)); } },
  });
  route('r1', 'c1', '以后叫你小艾吧');
  route('r2', 'c1', '以后叫你小艾菲吧');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(added, ['小艾菲'], 'only the message where the name appears');
});
