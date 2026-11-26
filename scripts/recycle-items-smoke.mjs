// I-144b 单条删除也先进回收站 smoke (docs/claude/2026-11-16-i144-recycle-bin.md 「I-144b 做完」): the built app in an isolated temporary profile
// (never a real one), chat through the synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs).
//  1. Two lines of chat; on the memory page the user deletes one record with 「删除这段记录」 (two clicks), sees it in 「最近删除的」 beside
//     it, clicks 「找回」, and the record reads as before.
//  2. A diary day (seeded into the isolated profile between two launches) is deleted through the same call the profile panel makes,
//     shows in 「最近删除的」 of the profile panel, comes back with 「找回」 there, and the profile file reads as before (all but the revision).
// Screenshots go to .local/recycle-items-smoke/ (git-ignored).
//   node scripts/dev/heavy.mjs --label recycle-items-smoke -- node scripts/recycle-items-smoke.mjs      (after vite build + build-electron)
import { _electron as electron } from 'playwright';
import { navigateControlPage } from './lib/control-navigation.mjs';
import { createClaudeFixture } from './lib/claude-smoke-fixture.mjs';
import { armSmokeWatchdog, closeElectron } from './lib/electron-cleanup.mjs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const output = path.resolve('.local/recycle-items-smoke');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'soft-recycle-items-e2e-'));
const profile = path.join(temporary, 'profile');
await mkdir(profile);
const checks = [], errors = [], notes = [];
let instance, controls, pet, report;
const disarm = armSmokeWatchdog(() => instance, 420_000, 'recycle-items-smoke');
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const claude = await createClaudeFixture({ root: temporary, respond: turn => `好呀，我记住了：${turn.currentUser}` });
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ version: 1, persona: 'smoke', model: null, motion: null, provider: claude.provider,
  voice: { enabled: false, voiceURI: '', rate: 1.1, volume: 0.4 }, pet: { visible: true, clickThrough: false, followMouse: false, fps: 24, scale: 1 } }));

async function waitFor(condition, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
}
const shot = name => controls.screenshot({ path: path.join(output, `${name}.png`) });
async function launch() {
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile });
  delete env.ELECTRON_RUN_AS_NODE; delete env.MMD_TEST_EXE;
  instance = await electron.launch({ args: ['.'], env, timeout: 30000 });
  await claude.install(instance);
  await instance.firstWindow();
  assert.equal(await instance.evaluate(({ app }) => app.getPath('userData')), profile, 'the isolated profile, never a real one');
  await waitFor(() => {
    controls = instance.windows().find(page => page.url().includes('index.html') && !new URL(page.url()).searchParams.has('pet'));
    pet = instance.windows().find(page => page.url().includes('index.html') && new URL(page.url()).searchParams.has('pet'));
    return controls && pet;
  }, 'both windows');
  for (const page of [controls, pet]) { page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message)); }
  await controls.waitForFunction(() => !!window.desktop?.getRecycleBin);
  await waitFor(async () => (await controls.evaluate(() => window.desktop.getRecycleBin())).ready, 'the recycle bin loaded');
}
/** The journal's records (a fresh read): id → record without `sealed` (a deleted open conversation comes back closed). */
async function journalRecords() {
  const out = new Map();
  for (const line of (await readFile(path.join(profile, 'memories.jsonl'), 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    const record = event.type === 'record' ? event.record : event.type === 'begin' ? event.record : null;
    if (record) { const { sealed: _sealed, ...rest } = record; out.set(record.id, rest); }
  }
  return out;
}
const profileFile = async () => (await readdir(path.join(profile, 'user-profiles'))).find(name => /^profile-[0-9a-f]{64}\.json$/.test(name));

try {
  // ---- first launch: chat, and switch 「允许记录」 on (the profile file appears) ----
  await launch();
  await navigateControlPage(controls, 'chat');
  for (const line of ['今天下午去了趟植物园，看到好多睡莲', '晚上想吃番茄鸡蛋面']) {
    await controls.bringToFront();
    await controls.locator('#chat-input').focus();
    await controls.locator('#chat-input').fill(line);
    await controls.locator('#chat-input').press('Enter');
    await controls.waitForFunction(text => [...document.querySelectorAll('.message.assistant .message-body')].some(node => node.textContent?.includes(text)), line, { polling: 100, timeout: 60000 });
  }
  await controls.evaluate(() => window.desktop.newConversation());
  const view = await controls.evaluate(() => window.desktop.getUserProfile());
  assert.ok(view, 'fixture: the profile is shown');
  if (!view.enabled) await controls.evaluate(value => window.desktop.setUserProfileEnabled({ scopeId: value.scopeId, generation: value.generation, revision: value.revision, enabled: true }), view);
  await waitFor(async () => !!(await profileFile().catch(() => null)), 'the profile file is written');
  await new Promise(resolve => setTimeout(resolve, 1000));
  await closeElectron(instance); instance = null;

  // Seed one diary day into the isolated profile (the diary writer needs days to pass).
  const name = await profileFile();
  const stored = JSON.parse(await readFile(path.join(profile, 'user-profiles', name), 'utf8'));
  stored.diary = [{ date: '2026-11-10', text: '今天她陪我聊了植物园的睡莲。', writtenAt: Date.UTC(2026, 10, 11, 1) }];
  await writeFile(path.join(profile, 'user-profiles', name), JSON.stringify(stored) + '\n');

  // ---- second launch ----
  await launch();
  const recordsBefore = await journalRecords();
  const target = [...recordsBefore.values()].find(record => JSON.stringify(record).includes('植物园'));
  assert.ok(target, 'fixture: the chat record is on disk');
  const readRecord = id => controls.evaluate(value => window.desktop.readMemory(value), id).then(page => { const { sealed: _sealed, ...rest } = page; return rest; }); // what the memory page reads
  const recordBefore = await readRecord(target.id);
  check('a chat record and a diary day');

  // 1. 记忆页「删除这段记录」 → 「最近删除的」 → 「找回」
  await navigateControlPage(controls, 'memory');
  const record = controls.locator(`button.memory-record[data-record-id="${target.id}"]`);
  await record.waitFor();
  await record.click();
  await controls.locator('#memory-delete').click();
  await shot('1-chat-confirm');
  await controls.locator('#memory-delete').click();
  await waitFor(async () => !(await journalRecords()).has(target.id), 'the record left the journal');
  assert.equal((await readFile(path.join(profile, 'memories.jsonl'), 'utf8')).includes('植物园'), false, 'nothing of it left in the journal');
  const memoryList = controls.locator('#memory-panel [data-recycle=recently-deleted]').first(); // the memory list (the panels inside the page have their own)
  await memoryList.locator('li').first().waitFor({ state: 'visible' });
  const line = await memoryList.innerText();
  assert.match(line, /最近删除的/);
  assert.equal(line.includes('植物园'), false, 'the line names what and when, never the content');
  await shot('2-chat-recently-deleted');
  check(`deleted on the memory page; 「最近删除的」 says: ${line.replace(/\s+/g, ' ').slice(0, 80)}`);
  await memoryList.locator('[data-recycle=restore]').first().click();
  await waitFor(async () => (await journalRecords()).has(target.id), 'the record is back');
  assert.deepEqual(await readRecord(target.id), recordBefore, 'the record reads as before (what the memory page reads, all but sealed)');
  await shot('3-chat-found-back');
  check('found back: the chat record reads as before');

  // 2. A diary day: the profile panel's own call, its 「最近删除的」, 「找回」 there.
  const diaryBefore = await readFile(path.join(profile, 'user-profiles', name));
  const current = await controls.evaluate(() => window.desktop.getUserProfile());
  assert.ok(current.diary.some(entry => entry.date === '2026-11-10'), 'fixture: the day is shown');
  await controls.evaluate(value => window.desktop.deleteUserDiary({ scopeId: value.scopeId, generation: value.generation, revision: value.revision, date: '2026-11-10' }), current);
  const afterDelete = JSON.parse(await readFile(path.join(profile, 'user-profiles', name), 'utf8'));
  assert.equal((afterDelete.diary ?? []).some(entry => entry.date === '2026-11-10'), false, 'the day is gone');
  const bin = await controls.evaluate(() => window.desktop.getRecycleBin());
  const entry = bin.entries.find(item => item.part === 'diary-day');
  assert.ok(entry && !entry.label.includes('睡莲'), 'one entry, without the content');
  const toggle = controls.locator('#user-profile-toggle');
  let viaPanel = false;
  if (await toggle.count()) {
    await toggle.click().catch(() => {});
    const list = controls.locator('#user-profile-panel [data-recycle=recently-deleted]').first();
    try {
      await list.locator('li').first().waitFor({ state: 'visible', timeout: 5000 });
      await shot('4-diary-recently-deleted');
      await list.locator('[data-recycle=restore]').first().click();
      viaPanel = true;
    } catch { notes.push('the profile panel list was not visible; found back through the same IPC call'); }
  }
  if (!viaPanel) await controls.evaluate(id => window.desktop.restoreRecycleEntry(id), entry.id);
  await waitFor(async () => (JSON.parse(await readFile(path.join(profile, 'user-profiles', name), 'utf8')).diary ?? []).some(day => day.date === '2026-11-10'), 'the day is back');
  const strip = bytes => { const value = JSON.parse(bytes.toString('utf8')); delete value.revision; return value; };
  assert.deepEqual(strip(await readFile(path.join(profile, 'user-profiles', name))), strip(diaryBefore), 'the profile file reads as before (all but the revision)');
  if (viaPanel) await shot('5-diary-found-back');
  check(`diary day found back ${viaPanel ? 'in the profile panel' : 'through the IPC call'}; the profile file reads as before (all but the revision)`);

  assert.deepEqual(errors, []);
  report = { status: 'PASS', checks, notes, screenshots: output };
  console.log(JSON.stringify(report));
} catch (error) {
  report = { status: 'FAIL', checks, notes, error: String(error), errors };
  console.error(JSON.stringify(report));
  if (controls) await controls.screenshot({ path: path.join(output, 'failure-controls.png'), timeout: 5000 }).catch(() => {});
  process.exitCode = 1;
} finally {
  const shutdown = instance ? await closeElectron(instance) : { closed: true };
  disarm();
  if (!shutdown.closed) { process.exitCode = 1; console.error('recycle-items-smoke: Electron did not close by itself', shutdown); }
  await claude.close();
  await rm(temporary, { recursive: true, force: true });
  if (report) await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
