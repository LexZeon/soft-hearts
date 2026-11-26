/**
 * P-001 step 1: where the plans she remembers live: `upcoming-<scopeId>.json` beside the profile files, never inside them
 * (electron/memory/upcoming/store.ts). A previous build reads profile files strictly by name, so these files must never change a profile file
 * and never be seen by the profile store; and they are deleted wherever the user's rules say (switch off, character forgotten).
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UserProfileStore, userProfileScopeId, type UserProfileScope } from '../electron/memory/user-profile';
import { ProfileUpcomingBook } from '../electron/memory/upcoming/book';
import { UpcomingStore } from '../electron/memory/upcoming/store';

const a: UserProfileScope = { characterId: 'char-a', providerScope: 'p' };
const b: UserProfileScope = { characterId: 'char-b', providerScope: 'p' };
const T = new Date(2026, 10, 12, 8, 0).getTime();
const DAY = 86_400_000;
const idOf = (scope: UserProfileScope) => userProfileScopeId(scope);

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sh-p001-prof-'));
  try { await run(path.join(dir, 'profiles')); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
/** The profile store with the plan files wired in (as electron/main.ts does), and a book for the character shown. */
function wired(dir: string, scope: UserProfileScope = a) {
  const rec = { on: false };
  const upcoming = new UpcomingStore(dir, { now: () => T, recording: () => rec.on });
  const profiles = new UserProfileStore(dir, { now: () => T, upcoming });
  const book = new ProfileUpcomingBook(upcoming, () => idOf(scope), () => T, (() => { let n = 0; return () => `x${++n}`; })());
  return { upcoming, profiles, book, rec, async on() { rec.on = true; profiles.setEnabled(true); await profiles.settled(); }, async close() { profiles.dispose(); await upcoming.settled(); } };
}
const profileFile = (dir: string, scope = a) => path.join(dir, `profile-${idOf(scope)}.json`);
const upcomingFile = (dir: string, scope = a) => path.join(dir, `upcoming-${idOf(scope)}.json`);
const plan = { what: '去面试', said: '明天下午', dueAt: T + DAY };
const names = async (dir: string, prefix: string) => (await readdir(dir).catch(() => [] as string[])).filter(name => name.startsWith(prefix));

test('a profile file written while plans are being remembered is the same file as without the feature, in shape and in bytes', () => withDir(async dir => {
  const withFeature = wired(path.join(dir, 'new')); await withFeature.profiles.activate(a); await withFeature.on();
  await withFeature.book.add({ from: 's1', items: [plan] });
  await withFeature.book.add({ from: 's2', items: [{ ...plan, what: '交报告', said: '周五', dueAt: T + 2 * DAY }] });
  assert.equal((await names(path.join(dir, 'new'), 'upcoming-')).length, 1, 'the list is there');
  const plain = new UserProfileStore(path.join(dir, 'old'), { now: () => T }); await plain.activate(a); plain.setEnabled(true); await plain.settled();
  const fresh = JSON.parse(await readFile(profileFile(path.join(dir, 'new')), 'utf8')), classic = JSON.parse(await readFile(profileFile(path.join(dir, 'old')), 'utf8'));
  assert.deepEqual(Object.keys(fresh).sort(), ['blocked', 'entries', 'revision', 'scopeId', 'version'], 'only the keys a previous build knows');
  assert.deepEqual(fresh, classic, 'identical to what the version without this feature writes');
  assert.equal(await readFile(profileFile(path.join(dir, 'new')), 'utf8'), await readFile(profileFile(path.join(dir, 'old')), 'utf8'));
  await withFeature.close(); plain.dispose();
}));

test('a list file next to the profile files changes nothing about what the profile store loads, however odd it is', () => withDir(async dir => {
  const first = new UserProfileStore(dir, { now: () => T }); await first.activate(a); first.setEnabled(true); await first.settled();
  const shape = (view: unknown) => { const copy = { ...(view as Record<string, unknown>) }; delete copy.generation; return JSON.stringify(copy); };
  const before = shape(first.view()); first.dispose();
  for (const content of ['{broken', JSON.stringify({ version: 1, scopeId: idOf(a), upcoming: { items: [], blockedFrom: ['x'] } }), '', '[]']) {
    await writeFile(upcomingFile(dir), content);
    await writeFile(upcomingFile(dir, b), content);
    const second = new UserProfileStore(dir, { now: () => T });
    assert.equal(shape(await second.activate(a)), before, JSON.stringify(content));
    assert.ok((await second.activate(b)) !== null);
    second.dispose();
  }
  assert.equal(await readFile(profileFile(dir), 'utf8').then(text => text.includes('upcoming')), false);
}));

test('the list is only written when it has something; the file goes when the last thing goes', () => withDir(async dir => {
  const s = wired(dir); await s.profiles.activate(a); await s.on();
  assert.deepEqual(await names(dir, 'upcoming-'), [], 'nothing yet, no file');
  assert.equal(await s.book.add({ from: 's1', items: [plan] }), 1);
  const saved = JSON.parse(await readFile(upcomingFile(dir), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['scopeId', 'upcoming', 'version']);
  assert.equal(saved.scopeId, idOf(a));
  assert.equal(saved.upcoming.items[0].what, '去面试');
  assert.ok(!JSON.stringify(saved).includes('明天下午有个'), 'no sentence of the user');
  await s.book.dropSegments(['s1']);
  assert.deepEqual(await names(dir, 'upcoming-'), [], 'empty again: deleted, not left empty');
  await s.close();
}));

test('nothing is changed while recording is off, and the profile shows nothing', () => withDir(async dir => {
  const s = wired(dir); await s.profiles.activate(a);
  assert.equal(await s.book.add({ from: 's1', items: [plan] }), 0);
  assert.deepEqual(await names(dir, 'upcoming-'), []);
  assert.deepEqual(s.profiles.view().upcoming, []);
  await s.close();
}));

test('a list file that does not read is left exactly as it is and nothing is written over it', () => withDir(async dir => {
  const s = wired(dir); await s.profiles.activate(a); await s.on();
  await s.book.add({ from: 's1', items: [plan] });
  const data = JSON.parse(await readFile(upcomingFile(dir), 'utf8'));
  data.upcoming.items[0].state = 'finished';
  const damaged = JSON.stringify(data) + '\n';
  await writeFile(upcomingFile(dir), damaged);
  await s.upcoming.purgeAll(); // (clears what it had in memory too) put the damaged file back for the real check
  await writeFile(upcomingFile(dir), damaged);
  const again = wired(dir); await again.profiles.activate(a); await again.on();
  assert.deepEqual(again.book.list(), []);
  assert.equal(await again.book.add({ from: 's2', items: [{ ...plan, what: '另一件' }] }), 0, 'refused: it would overwrite what it cannot read');
  assert.equal(await readFile(upcomingFile(dir), 'utf8'), damaged);
  await s.close(); await again.close();
}));

test('turning the switch off by hand deletes every upcoming file (and only those): other characters, an unreadable one, and leaves profiles alone', () => withDir(async dir => {
  const s = wired(dir); await s.profiles.activate(a); await s.on();
  await s.book.add({ from: 's1', items: [plan] });
  await s.book.add({ from: 's2', scope: idOf(b), items: [plan] } as never);
  await writeFile(upcomingFile(dir, { characterId: 'c', providerScope: 'x' }), '{broken');
  assert.equal((await names(dir, 'upcoming-')).length, 3);
  const profileBytes = await readFile(profileFile(dir), 'utf8');
  s.rec.on = false; s.profiles.setEnabled(false); await s.profiles.settled(); await s.upcoming.settled();
  assert.deepEqual(await names(dir, 'upcoming-'), [], 'all of them');
  assert.ok((await names(dir, 'profile-')).length >= 1, 'the profile files are still there');
  assert.ok((await readFile(profileFile(dir), 'utf8')).length > 0 && profileBytes.length > 0);
  assert.deepEqual(s.profiles.view().upcoming, []);
  await s.close();
}));

test('a character whose profile is forgotten loses her list with it, and a restore does not bring it back', () => withDir(async dir => {
  const s = wired(dir); await s.profiles.activate(a); await s.on();
  await s.book.add({ from: 's1', items: [plan] });
  await s.book.add({ from: 's2', scope: idOf(b), items: [plan] } as never);
  let kept: unknown = null;
  assert.equal(await s.profiles.forgetScope(a, async stored => { kept = stored; }), true);
  await assert.rejects(stat(upcomingFile(dir)), 'her list is deleted');
  await stat(upcomingFile(dir, b));
  await s.profiles.restoreScope(a, kept, async () => {});
  await assert.rejects(stat(upcomingFile(dir)), 'a restore does not bring it back');
  assert.ok(!JSON.stringify(kept).includes('upcoming'), 'and the bin copy of the profile never had it');
  await s.close();
}));

test('the shown list carries no segment id and no sentence of the user; the panel\'s own deletes go through the store', () => withDir(async dir => {
  const s = wired(dir); await s.profiles.activate(a); await s.on();
  await s.book.add({ from: 'secret-segment-id', items: [plan] });
  const view = s.profiles.view();
  assert.deepEqual(Object.keys(view.upcoming![0]).sort(), ['dueAt', 'id', 'said', 'state', 'what']);
  assert.ok(!JSON.stringify(view).includes('secret-segment-id'));
  const after = await s.profiles.deleteUpcoming(view.upcoming![0].id, view.revision);
  assert.deepEqual(after.upcoming, []);
  assert.equal(after.revision, view.revision, 'the profile itself did not change');
  await assert.rejects(s.profiles.deleteUpcoming('nope', view.revision));
  await s.close();
}));

test('nothing in a character card export or the card files mentions the plan list', async () => {
  const names = (await readdir(path.join(import.meta.dirname, '..', 'electron', 'cards'))).filter(name => /^character-cards?\.ts$|^character-card-update\.ts$/u.test(name));
  assert.ok(names.length > 0);
  for (const name of names) assert.ok(!/upcoming/iu.test(await readFile(path.join(import.meta.dirname, '..', 'electron', 'cards', name), 'utf8')), name);
});
