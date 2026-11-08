// C1: everything she remembers is kept per character id, so switching cards switches all of it and nothing leaks:
// chat memory, the diary and profile (one file per character + chat connection), familiarity and nickname, and
// G1's match counts. Also the G1 privacy fix: the match counts go when the user clears the diary or turns
// "允许记录" off. Real stores in a temporary folder; synthetic ids and text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService, memoryProviderScope } from '../electron/companion';
import { RpsStore } from '../electron/rps/store';
import { UserProfileManagement } from '../electron/user-profile-management';
import { UserProfileStore, type UserProfileScope } from '../electron/user-profile';
import { localDateKey } from '../electron/diary/diary-dates';
import type { RpsGameRecord } from '../shared/rps-memory';

const provider = { kind: 'claude' as const, baseUrl: 'https://scope.invalid/v1', model: 'fixture' };
const providerScope = memoryProviderScope(provider);

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-scope-isolation-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
async function chat(service: CompanionService, id: string, text: string, persona: string) {
  const turn = await service.begin(id, text, persona, () => {}, {});
  turn.push('delta', `${persona} 记住了。`);
  await turn.finish('complete');
}
const game = (at: number): RpsGameRecord => ({ at, origin: 'user', result: 'user', rounds: [{ her: 'rock', user: 'paper', outcome: 'user' }] });

test('switching cards switches chat memory, familiarity and nickname; switching back finds them again', async () => withDirectory(async directory => {
  const service = new CompanionService(directory, () => {});
  try {
    await service.load();
    await service.context('card-gene', provider, 'Gene');
    await chat(service, 'g1', '只告诉 Gene 的秘密：我喜欢蓝色', 'Gene');
    await service.relationship.setNickname('card-gene', '小蓝');
    await service.relationship.flush();
    const geneScope = { characterId: 'card-gene', providerScope };
    assert.equal(service.memory.list(geneScope).records.length, 1);

    await service.context('card-alice', provider, 'Alice');
    const aliceScope = service.currentScope();
    assert.equal(aliceScope.characterId, 'card-alice');
    assert.equal(service.memory.list(aliceScope).records.length, 0, 'Alice sees none of Gene\'s chats');
    assert.deepEqual(service.memory.retrieve(aliceScope, '蓝色'), [], 'nor recalls them');
    await service.relationship.ensure('card-alice');
    assert.equal(service.relationship.nickname('card-alice'), null, 'nor Gene\'s nickname for the user');
    await chat(service, 'a1', '告诉 Alice 的事：我在学钢琴', 'Alice');
    await service.relationship.flush();

    await service.context('card-gene', provider, 'Gene');
    const records = service.memory.list(geneScope).records;
    assert.equal(records.length, 1, 'Gene\'s chats are back, and only hers');
    assert.match(JSON.stringify(service.memory.read(geneScope, records[0].id)), /蓝色/);
    assert.doesNotMatch(JSON.stringify(service.memory.read(geneScope, records[0].id)), /钢琴/);
    assert.equal(service.relationship.nickname('card-gene'), '小蓝');
    // One relationship file per character.
    const gene = JSON.parse(await readFile(path.join(directory, 'relationship', 'card-gene.json'), 'utf8'));
    const alice = JSON.parse(await readFile(path.join(directory, 'relationship', 'card-alice.json'), 'utf8'));
    assert.equal(gene.nickname, '小蓝');
    assert.equal(alice.nickname, null);
  } finally { await service.flush().catch(() => {}); }
}));

test('the diary and profile follow the card: another card opens its own, empty file', async () => withDirectory(async directory => {
  const store = new UserProfileStore(path.join(directory, 'user-profiles'));
  const gene: UserProfileScope = { characterId: 'card-gene', providerScope }, alice: UserProfileScope = { characterId: 'card-alice', providerScope };
  const day = localDateKey(Date.now() - 86_400_000);
  await store.activate(gene); store.setEnabled(true);
  assert.equal(await store.saveDiary(store.diaryTicket()!, day, 'Gene 写的日记'), true);
  await store.activate(alice); store.setEnabled(true);
  assert.deepEqual(store.view().diary, [], 'Alice opens her own empty diary');
  assert.equal(store.recentDiaryPoints(alice, Date.now(), 300), '');
  await store.activate(gene); store.setEnabled(true);
  assert.equal(store.view().diary[0]?.text, 'Gene 写的日记');
  store.dispose();
}));

test('G1 match counts are per character, and go when the diary is cleared or "允许记录" is turned off', async () => withDirectory(async directory => {
  const rps = new RpsStore({ file: () => path.join(directory, 'rps.json') });
  await rps.load();
  const now = Date.now();
  rps.finish('card-gene', game(now - 1000), true);
  rps.finish('card-alice', game(now - 500), true);
  assert.equal(rps.games('card-gene').length, 1);
  assert.equal(rps.games('card-alice').length, 1);

  const profiles = new UserProfileStore(path.join(directory, 'user-profiles'));
  let current: UserProfileScope = { characterId: 'card-gene', providerScope };
  const forgotten: string[] = [];
  const management = new UserProfileManagement(profiles, () => {}, () => current, (scope, reason) => { forgotten.push(`${scope.characterId}:${reason}`); rps.forget(scope.characterId); });
  const expected = () => { const view = management.get()!; return { scopeId: view.scopeId, generation: view.generation, revision: view.revision }; };

  // Turning recording on keeps them; clearing Gene's diary clears only Gene's counts.
  await management.activate(current);
  management.setEnabled({ ...expected(), enabled: true });
  assert.equal(rps.games('card-gene').length, 1);
  await management.clearDiary(expected());
  assert.deepEqual(rps.games('card-gene'), []);
  assert.equal(rps.games('card-alice').length, 1, 'another character keeps hers');

  // Turning "允许记录" off for Alice clears Alice's.
  current = { characterId: 'card-alice', providerScope };
  await management.activate(current);
  management.setEnabled({ ...expected(), enabled: true });
  management.setEnabled({ ...expected(), enabled: false });
  assert.deepEqual(rps.games('card-alice'), []);
  assert.deepEqual(forgotten, ['card-gene:diary-cleared', 'card-alice:recording-off']);
  await rps.flush();
  const saved = JSON.parse(await readFile(path.join(directory, 'rps.json'), 'utf8'));
  assert.deepEqual(saved.characters, {}, 'the file no longer holds them either');
  assert.equal(saved.lastGameAt, now - 500, 'her own pacing stays');
  management.dispose();
}));
