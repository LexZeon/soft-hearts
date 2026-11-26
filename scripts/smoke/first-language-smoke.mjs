// I-219 first-install language, real Electron, isolated. Run after `pnpm build:app`:  node scripts/smoke/first-language-smoke.mjs
// Throw-away profile + a throw-away hint folder (MMD_FIRST_LANGUAGE_HINT_DIR, read only together with MMD_DESK_USER_DATA, see
// electron/settings/first-language-hint.ts), a synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs), no network, no real
// profile. Cases: fresh + en; relaunch with a zh-CN hint (saved language stays en); fresh + zh-CN. A control-window screenshot per
// language goes to the temp folder (printed, never committed).
import { _electron as electron } from 'playwright';
import { createClaudeFixture } from '../lib/claude-smoke-fixture.mjs';
import { armSmokeWatchdog, closeElectron } from '../lib/electron-cleanup.mjs';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'soft-firstlang-'));
const claude = await createClaudeFixture({ root: temporary, respond: () => 'unused' });
let instance;
const disarm = armSmokeWatchdog(() => instance, 240_000, 'first-language-smoke');
const results = [];
const exists = file => stat(file).then(() => true, () => false);
const waitFor = async (condition, label, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await condition()) return; await new Promise(r => setTimeout(r, 150)); }
  throw new Error(`Timed out: ${label}`);
};

/** One launch of `profile` with `hint` (or none) in `hintDir`; returns what the app shows and saved. */
async function launch({ name, profile, hintDir, hint, shot }) {
  if (hint) await writeFile(path.join(hintDir, 'first-language.txt'), hint);
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile, MMD_FIRST_LANGUAGE_HINT_DIR: hintDir });
  delete env.ELECTRON_RUN_AS_NODE; delete env.MMD_TEST_EXE;
  // A Chinese system locale on purpose: the hint, not the system, must decide.
  instance = await electron.launch({ args: ['.', '--lang=zh-CN'], env, timeout: 30000 });
  await claude.install(instance);
  await instance.firstWindow();
  let controls;
  await waitFor(() => {
    // no-pet-ok: 'pet' is the app's own query parameter naming the companion window, not a way of speaking about her
    controls = instance.windows().find(p => p.url().includes('index.html') && !new URL(p.url()).searchParams.has('pet'));
    return controls;
  }, 'control window');
  controls.setDefaultTimeout(20000);
  await controls.waitForFunction(() => !!window.desktop?.getCharacterCards);
  const cards = await controls.evaluate(() => window.desktop.getCharacterCards());
  const active = cards.cards.find(card => card.id === cards.activeId);
  const htmlLang = await controls.evaluate(() => document.documentElement.lang);
  const saved = JSON.parse(await readFile(path.join(profile, 'ui-language-settings.json'), 'utf8'));
  const hintLeft = await exists(path.join(hintDir, 'first-language.txt'));
  let screenshot = null;
  if (shot) { screenshot = path.join(temporary, `control-${name}.png`); await controls.screenshot({ path: screenshot }); }
  const shutdown = await closeElectron(instance, 30_000);
  instance = null;
  assert.ok(shutdown.closed, `${name}: Electron closed by itself ${JSON.stringify(shutdown)}`);
  return { name, saved: saved.preference, htmlLang, active: active?.name, activeLanguage: active?.language, hintLeft, screenshot };
}

try {
  const hintDir = path.join(temporary, 'hint');
  await mkdir(hintDir);
  const enProfile = path.join(temporary, 'profile-en');
  const zhProfile = path.join(temporary, 'profile-zh');
  await mkdir(enProfile); await mkdir(zhProfile);

  const first = await launch({ name: 'en-first', profile: enProfile, hintDir, hint: 'en', shot: true });
  assert.equal(first.saved, 'en'); assert.match(first.htmlLang, /^en/);
  assert.match(first.active ?? '', /^Gene/); assert.match(first.active ?? '', /English/);
  assert.equal(first.hintLeft, false);
  results.push(first);

  const second = await launch({ name: 'en-second-with-zh-hint', profile: enProfile, hintDir, hint: 'zh-CN' });
  assert.equal(second.saved, 'en', 'a later hint never changes the saved language');
  assert.match(second.htmlLang, /^en/); assert.equal(second.hintLeft, false);
  results.push(second);

  const zh = await launch({ name: 'zh-first', profile: zhProfile, hintDir, hint: 'zh-CN', shot: true });
  assert.equal(zh.saved, 'zh-CN'); assert.match(zh.htmlLang, /^zh/);
  assert.equal(zh.active, 'Gene', 'Chinese Gene, no English tag on a Chinese-only list');
  assert.equal(zh.hintLeft, false);
  results.push(zh);

  console.log(JSON.stringify({ status: 'PASS', results, folder: temporary }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', error: String(error), results, folder: temporary }, null, 2));
  process.exitCode = 1;
} finally {
  if (instance) await closeElectron(instance);
  disarm();
  await claude.close();
  // Profiles and fixtures are removed; the screenshots stay in the temp folder for the lead to look at.
  for (const part of ['profile-en', 'profile-zh', 'hint']) await rm(path.join(temporary, part), { recursive: true, force: true });
}
