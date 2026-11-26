// I-144 回收站 smoke (docs/claude/2026-11-16-i144-recycle-bin.md): the built app in an isolated temporary profile (never a real one), chat
// through the synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs). A made-up character gets chat memory, her profile file and the
// other things a profile keeps; the user deletes her on the character page with "同时删除她的记忆" ticked, sees her in 「回收站（N）」, finds
// her back, and every file of the rows the bin keeps reads as before (the chat journal and the card file by content: they are rewritten
// whole). Screenshots go to .local/recycle-bin-smoke/ (git-ignored).
//   node scripts/dev/heavy.mjs --label recycle-smoke -- node scripts/recycle-bin-smoke.mjs      (after vite build + build-electron)
import { _electron as electron } from 'playwright';
import { navigateControlPage } from './lib/control-navigation.mjs';
import { createClaudeFixture } from './lib/claude-smoke-fixture.mjs';
import { armSmokeWatchdog, closeElectron } from './lib/electron-cleanup.mjs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const output = path.resolve('.local/recycle-bin-smoke');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'soft-recycle-e2e-'));
const profile = path.join(temporary, 'profile');
await mkdir(profile);
const checks = [], errors = [];
let instance, controls, pet, report;
const disarm = armSmokeWatchdog(() => instance, 300_000, 'recycle-bin-smoke');
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const claude = await createClaudeFixture({ root: temporary, respond: turn => `好呀，我记住了：${turn.currentUser}` });
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ version: 1, persona: 'smoke', model: null, motion: null, provider: claude.provider,
  voice: { enabled: false, voiceURI: '', rate: 1.1, volume: 0.4 }, pet: { visible: true, clickThrough: false, followMouse: false, fps: 24, scale: 1 } }));

async function waitFor(condition, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
}
/** The files of the rows the bin keeps (electron/foundation/data-map.ts recycle: 'take'). */
const kept = rel => /^(memories\.jsonl|memory-scopes\.json|memory-notes\.json|user-profiles\/|relationship\/|rps\.json|feed-recognition\.json|special-day\.json|her-keepsakes\.json|text-invitations\.jsonl|characters\.json|character-response-settings\.json|character-avatars\/|hands\/|our-things\/|people-things\/|memory-keywords\/|memory-vectors\/|watch-notes\/|listen-together\.json|system-audio-transcripts\.json|audio-reading-v2\.json|song-memory-)/.test(rel);
/** Every kept file under the profile (relative, '/'), with its bytes. */
async function files() {
  const out = new Map();
  for (const entry of await readdir(profile, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name.endsWith('.tmp')) continue;
    const full = path.join(entry.parentPath, entry.name);
    const rel = path.relative(profile, full).split(path.sep).join('/');
    if (!kept(rel)) continue; // Chromium's own files (some locked) are not the app's data
    out.set(rel, await readFile(full));
  }
  return out;
}
const shot = name => controls.screenshot({ path: path.join(output, `${name}.png`) });

try {
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

  // 1. A character with memories: a made-up card, made the current one, two lines of chat.
  const before = await controls.evaluate(() => window.desktop.getCharacterCards());
  const keptId = before.activeId;
  const draft = { name: '试用小雨', description: '回收站冒烟测试用的角色', personality: '温柔', scenario: '', greeting: '', examples: '', systemPrompt: '' };
  const created = await controls.evaluate(value => window.desktop.saveCharacterCard(value), draft);
  const doomed = created.cards.find(card => card.name === '试用小雨').id;
  await controls.evaluate(id => window.desktop.switchCharacter(id), doomed);
  await navigateControlPage(controls, 'chat');
  for (const line of ['今天下午去了趟植物园，看到好多睡莲', '晚上想吃番茄鸡蛋面']) {
    await controls.bringToFront();
    await controls.locator('#chat-input').focus();
    await controls.locator('#chat-input').fill(line);
    await controls.locator('#chat-input').press('Enter');
    await controls.waitForFunction(text => [...document.querySelectorAll('.message.assistant .message-body')].some(node => node.textContent?.includes(text)), line, { polling: 100, timeout: 60000 });
  }
  await controls.evaluate(id => window.desktop.switchCharacter(id), keptId);
  await new Promise(resolve => setTimeout(resolve, 1500)); // her chat turn and profile are written
  const snapshotBefore = await files();
  assert.ok([...snapshotBefore.values()].some(bytes => bytes.includes('植物园')), 'fixture: her chat is on disk');
  check('a character with chat memory');

  // 2. Delete her on the character page, "同时删除她的记忆" ticked.
  await navigateControlPage(controls, 'characters');
  const tile = controls.locator(`article[data-character-id="${doomed}"]`);
  await tile.locator('[data-character-action=more]').click();
  await tile.locator('[data-character-action=delete]').click();
  await tile.locator('[data-character-action=forget-memories]').check();
  await shot('1-confirm');
  await tile.locator('[data-character-action=confirm-delete]').click();
  await waitFor(async () => !(await controls.evaluate(() => window.desktop.getCharacterCards())).cards.some(card => card.name === '试用小雨'), 'she is deleted');
  await new Promise(resolve => setTimeout(resolve, 800));
  const snapshotDeleted = await files();
  const leftovers = [...snapshotDeleted].filter(([rel, bytes]) => !rel.startsWith(`recycle-bin/${doomed}`) && (bytes.includes('植物园') || bytes.includes('番茄鸡蛋面')));
  assert.deepEqual(leftovers.map(([rel]) => rel), [], 'nothing of her chat is left outside the bin');
  check('deleted with her memories: nothing of her chat outside the bin');

  // 3. She is in 「回收站（N）」 on the character page.
  await controls.locator('#character-recycle').waitFor();
  assert.match(await controls.locator('#character-recycle').innerText(), /回收站（1）/);
  await controls.locator('[data-recycle=open]').click();
  const panel = controls.locator('#character-recycle-panel');
  await panel.waitFor({ state: 'visible' });
  assert.match(await panel.innerText(), /试用小雨/);
  await shot('2-recycle-bin');
  check('the character page shows 回收站（1） and her entry');

  // 4. Find her back.
  await panel.locator('[data-recycle=restore]').first().click();
  await waitFor(async () => (await controls.evaluate(() => window.desktop.getCharacterCards())).cards.some(card => card.id === doomed), 'she is back');
  const state = await controls.evaluate(() => window.desktop.getCharacterCards());
  assert.equal(state.activeId, keptId, 'finding her back does not switch to her');
  await new Promise(resolve => setTimeout(resolve, 800));
  await shot('3-found-back');
  check('found back under the same id, not made the current one');

  // 5. Every file as before (the chat journal and the card files by content).
  const snapshotAfter = await files();
  const differ = [];
  for (const rel of new Set([...snapshotBefore.keys(), ...snapshotAfter.keys()])) {
    if (!kept(rel)) continue;
    const a = snapshotBefore.get(rel), b = snapshotAfter.get(rel);
    if (!a || !b) { differ.push(`${rel} ${a ? 'missing' : 'new'}`); continue; }
    if (rel === 'memories.jsonl') {
      const lines = bytes => bytes.toString('utf8').split('\n').filter(line => line.includes('"type":"record"') || line.includes('"type":"begin"')).length > 0;
      if (!lines(b) || !b.includes('植物园') || !b.includes('番茄鸡蛋面')) differ.push(rel);
      continue;
    }
    if (rel === 'characters.json' || rel === 'character-response-settings.json') {
      const strip = bytes => { const value = JSON.parse(bytes.toString('utf8')); delete value.revision; return value; };
      try { assert.deepEqual(strip(b), strip(a)); } catch { differ.push(rel); }
      continue;
    }
    if (!a.equals(b)) differ.push(rel);
  }
  assert.deepEqual(differ, [], 'every kept file reads as before');
  check(`every kept file as before (${[...snapshotAfter.keys()].filter(kept).length} files compared)`);
  assert.deepEqual(errors, []);
  report = { status: 'PASS', checks, files: [...snapshotAfter.keys()].filter(kept).length, screenshots: output };
  console.log(JSON.stringify(report));
} catch (error) {
  report = { status: 'FAIL', checks, error: String(error), errors };
  console.error(JSON.stringify(report));
  if (controls) await controls.screenshot({ path: path.join(output, 'failure-controls.png'), timeout: 5000 }).catch(() => {});
  process.exitCode = 1;
} finally {
  const shutdown = await closeElectron(instance);
  disarm();
  if (!shutdown.closed) { process.exitCode = 1; console.error('recycle-bin-smoke: Electron did not close by itself', shutdown); }
  await claude.close();
  await rm(temporary, { recursive: true, force: true });
  if (report) await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
