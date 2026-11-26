#!/usr/bin/env node
// R01 物理调参台 (docs/claude/2026-11-17-physics-lab.md): open the lab once in an isolated temporary profile and look at it.
// Builds nothing (run `pnpm build` first). Starts the source build with a fresh temporary profile, an inert Claude Code path and an
// empty Claude config (no real Claude call can happen), the bundled Gene model, developer mode switched on in that profile only,
// then opens the lab from the control window, waits for the model and the numbers, saves a tuning, reads it back, removes it, and
// writes screenshots and a JSON report under .local/physics-lab-look/<time>/. The temporary profile is deleted at the end.
//   node scripts/dev/physics-lab-look.mjs [--keep]
import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const output = path.join(root, '.local', 'physics-lab-look', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const temp = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-physics-lab-'));
const profile = path.join(temp, 'profile'), claudeHome = path.join(temp, 'claude-home'), localAppData = path.join(temp, 'local');
await Promise.all([profile, claudeHome, localAppData].map(dir => mkdir(dir, { recursive: true })));
const placeholder = path.join(temp, 'claude-placeholder.txt');
await writeFile(placeholder, '# physics lab look: CLAUDE_PATH placeholder, never a real Claude Code\n');
const keep = process.argv.includes('--keep');
const pick = keys => Object.fromEntries(Object.entries(process.env).filter(([key]) => keys.includes(key.toUpperCase())));
const env = { ...pick(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']),
  LOCALAPPDATA: localAppData, CLAUDE_PATH: placeholder, CLAUDE_CONFIG_DIR: claudeHome, CODEX_PATH: path.join(temp, 'no-codex'), CODEX_HOME: path.join(temp, 'codex-home'),
  MMD_DESK_USER_DATA: profile, SOFT_HEARTS_TEST_PET_CORNER: 'top-left' };
const report = { output, steps: [], errors: [] };
const note = (step, value) => { report.steps.push({ step, ...(value === undefined ? {} : { value }) }); console.log(step, value === undefined ? '' : JSON.stringify(value)); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let app;
try {
  app = await electron.launch({ args: ['.'], cwd: root, env });
  // Every window's console errors from the first moment, with the window's address and where the message came from (the load-time ones were missed before 2026-11-18).
  const watch = page => page.on('console', message => { if (message.type() === 'error') report.errors.push(`${decodeURIComponent(page.url()).split('/dist/').pop().slice(0, 60)} :: ${message.text().slice(0, 300)} @ ${decodeURIComponent(message.location().url).split('/dist/').pop().slice(0, 80)}:${message.location().lineNumber}`); });
  app.on('window', watch);
  const controls = await app.firstWindow();
  for (const page of app.windows()) watch(page);
  await controls.waitForLoadState('domcontentloaded');
  note('control window loaded');
  let model = null;
  for (let i = 0; i < 60 && !model; i++) { model = await controls.evaluate(() => window.desktop.getSettings().then(s => s.model?.url ?? null)).catch(() => null); if (!model) await pause(500); }
  note('model set', !!model);
  await controls.evaluate(() => window.desktop.setMoodDeveloperMode(true)).catch(error => report.errors.push(`developer mode: ${error}`));
  note('developer mode on (temporary profile only)');
  await pause(800);
  const button = await controls.$('button.mood-physics-lab');
  note('lab button in the developer panel', !!button);
  const refused = await controls.evaluate(() => window.desktop.openPhysicsLab().then(() => 'opened', error => String(error)));
  note('openPhysicsLab', refused);
  let lab = null;
  for (let i = 0; i < 40 && !lab; i++) { lab = app.windows().find(page => page.url().includes('physics-lab')) ?? null; if (!lab) await pause(500); }
  if (!lab) throw new Error('the lab window did not open');
  lab.on('pageerror', error => report.errors.push(`lab page: ${error.message}`));
  await lab.waitForLoadState('domcontentloaded');
  for (let i = 0; i < 60; i++) { const rows = await lab.$$eval('table.numbers tbody tr', rows => rows.length).catch(() => 0); if (rows) break; await pause(500); }
  await pause(5000);
  note('groups', await lab.$$eval('details.group summary', nodes => nodes.map(node => node.textContent)));
  note('numbers', await lab.$$eval('table.numbers tbody tr', rows => rows.map(row => [...row.children].map(cell => cell.textContent))));
  note('step line', await lab.$eval('#side', side => [...side.querySelectorAll('p.hint')].map(p => p.textContent).find(text => text?.startsWith('每帧物理用时')) ?? null));
  note('node in the page', await lab.evaluate(() => typeof (globalThis).require === 'function' || typeof (globalThis).process === 'object'));
  note('lab api keys', await lab.evaluate(() => Object.keys(window.physicsLab).sort()));
  await lab.screenshot({ path: path.join(output, '1-front-headturn.png') });
  // Switch the longest hair group to the spring solver, look from the side, then save, read back and remove.
  await lab.evaluate(() => { const box = document.querySelector('details.group'); if (box) box.open = true; });
  const engine = await lab.$('details.group select');
  if (engine) await engine.selectOption('spring');
  await lab.click('text=侧面').catch(() => {});
  await pause(4000);
  await lab.screenshot({ path: path.join(output, '2-side-spring.png') });
  note('numbers with spring', await lab.$$eval('table.numbers tbody tr', rows => rows.map(row => [...row.children].map(cell => cell.textContent))));
  await lab.click('text=保存为这个模型的设置');
  await pause(1500);
  note('after save', await lab.$eval('#notice', node => node.textContent));
  const files = await readdir(profile);
  note('sidecar written', files.includes('physics-tuning.json'));
  const pet = await controls.evaluate(() => window.desktop.getModelPhysicsSettings());
  note('pet settings carry the tuning', !!pet.tuning);
  await lab.click('text=恢复原样');
  await pause(2500);
  note('after clear', await lab.$eval('#notice', node => node.textContent).catch(() => null));
  const cleared = await controls.evaluate(() => window.desktop.getModelPhysicsSettings());
  note('pet settings after clear', cleared.tuning ?? null);
  await controls.evaluate(() => window.desktop.setMoodDeveloperMode(false)).catch(() => {});
  const blocked = await controls.evaluate(() => window.desktop.openPhysicsLab().then(() => 'opened', error => String(error).slice(0, 80)));
  note('openPhysicsLab without developer mode', blocked);
} catch (error) {
  report.errors.push(String(error?.stack ?? error));
  console.error(error);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (!keep) await rm(temp, { recursive: true, force: true }).catch(() => {});
  console.log('report', path.join(output, 'report.json'));
}
