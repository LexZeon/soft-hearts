import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RECORDING_ON_MARKER, UserProfileStore, userProfileScopeId, type UserProfileScope } from '../electron/user-profile';
import { UserProfileManagement } from '../electron/user-profile-management';

const a: UserProfileScope = { characterId: 'char-a', providerScope: 'p' };
const b: UserProfileScope = { characterId: 'char-b', providerScope: 'p' };

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sh-p001-'));
  try { await run(path.join(dir, 'profiles')); } finally { await rm(dir, { recursive: true, force: true }); }
}
const fresh = (dir: string) => new UserProfileStore(dir);

test('P-001: recording ON survives a restart; the switch itself stays instant', () => withDir(async dir => {
  const first = fresh(dir); await first.activate(a);
  assert.equal(first.setEnabled(true).enabled, true);
  await first.settled(); first.dispose();
  const second = fresh(dir);
  assert.equal((await second.activate(a))?.enabled, true);
  assert.ok(second.diaryTicket(), 'diary writer gate is open again');
  second.dispose();
}));

test('the switch follows the user across characters and restarts (default off, then always the last choice)', () => withDir(async dir => {
  const s = fresh(dir); await s.activate(a);
  assert.equal(s.view().enabled, false, 'default off');
  s.setEnabled(true); await s.settled();
  assert.equal((await s.activate(b))?.enabled, true, 'another character: the same choice');
  s.dispose();
  const again = fresh(dir);
  assert.equal((await again.activate(b))?.enabled, true, 'after a restart');
  again.setEnabled(false); await again.settled();
  assert.equal((await again.activate(a))?.enabled, false, 'turned off on one character: off on the others too');
  again.dispose();
  const third = fresh(dir);
  assert.equal((await third.activate(a))?.enabled, false, 'and after a restart');
  third.dispose();
}));

test('profiles from before the global switch keep their own value until the next click', () => withDir(async dir => {
  const s = fresh(dir); await s.activate(a); s.setEnabled(true); await s.settled(); s.dispose();
  await rm(path.join(dir, 'recording.json'));
  const old = fresh(dir);
  assert.equal((await old.activate(a))?.enabled, true, 'the per-character marker still decides');
  assert.equal((await old.activate(b))?.enabled, false, 'a never-set character is off');
  old.dispose();
}));

test('P-001: turning it off is remembered too and a never-set scope leaves no file', () => withDir(async dir => {
  const s = fresh(dir); await s.activate(a); s.setEnabled(false); await s.settled();
  assert.deepEqual((await readdir(dir)).filter(name => name.startsWith('profile-')), [], 'no profile file for a never-set scope (only the choice itself)');
  s.setEnabled(true); await s.settled(); s.setEnabled(false); await s.settled();
  assert.equal((await s.activate(a))?.enabled, false);
  const file = path.join(dir, `profile-${userProfileScopeId(a)}.json`);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).blocked, [], 'the marker is gone again');
  s.dispose();
}));

test('P-001: an unreadable marker means off; the file keeps the old key set so an older build still reads it', () => withDir(async dir => {
  let s = fresh(dir); await s.activate(a); s.setEnabled(true); await s.settled();
  const file = path.join(dir, `profile-${userProfileScopeId(a)}.json`);
  const on = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(on), ['version', 'scopeId', 'revision', 'entries', 'blocked']);
  assert.deepEqual(on.blocked, [RECORDING_ON_MARKER]);
  await writeFile(file, JSON.stringify({ ...on, blocked: ['0'.repeat(64)] }));
  await rm(path.join(dir, 'recording.json')); s.dispose(); s = fresh(dir); // a profile from before the global switch: the per-scope marker decides
  assert.equal((await s.activate(b))?.enabled, false);
  assert.equal((await s.activate(a))?.enabled, false, 'some other fingerprint is not the marker');
  // A damaged marker makes the whole file unreadable (kept as is, as for any damaged profile); the switch is not on either.
  await writeFile(file, JSON.stringify({ ...on, blocked: [RECORDING_ON_MARKER.toUpperCase()] }));
  assert.equal((await s.activate(b))?.enabled, false);
  await assert.rejects(s.activate(a));
  assert.throws(() => s.view(), 'no profile is shown, so nothing is recorded');
  s.dispose();
}));

test('P-001: management off still forgets, and the off is what a restart sees', () => withDir(async dir => {
  const store = fresh(dir), forgot: string[] = [];
  const management = new UserProfileManagement(store, () => {}, () => a, (_scope, reason) => { forgot.push(reason); });
  await management.activate(a);
  const ask = (enabled: boolean) => { const v = management.get()!; return management.setEnabled({ scopeId: v.scopeId, generation: v.generation, revision: v.revision, enabled }); };
  ask(true); await store.settled();
  ask(false); await store.settled();
  assert.deepEqual(forgot, ['recording-off']);
  const again = fresh(dir);
  assert.equal((await again.activate(a))?.enabled, false);
  again.dispose(); management.dispose();
}));

test('P-001: quick on-off-on writes the last choice', () => withDir(async dir => {
  const s = fresh(dir); await s.activate(a);
  s.setEnabled(true); s.setEnabled(false); s.setEnabled(true); await s.settled();
  assert.equal((await s.activate(a))?.enabled, true);
  s.dispose();
}));

test('an unreadable recording.json falls back to the per-character marker; the next click repairs it', () => withDir(async dir => {
  const s = fresh(dir); await s.activate(a); s.setEnabled(true); await s.settled(); s.dispose();
  await writeFile(path.join(dir, 'recording.json'), '{not json');
  const old = fresh(dir);
  assert.equal((await old.activate(a))?.enabled, true, 'marker of a still on');
  assert.equal((await old.activate(b))?.enabled, false, 'b never set: off');
  old.setEnabled(false); await old.settled(); old.dispose();
  const again = fresh(dir);
  assert.equal((await again.activate(a))?.enabled, false, 'the new click is remembered');
  again.dispose();
}));
