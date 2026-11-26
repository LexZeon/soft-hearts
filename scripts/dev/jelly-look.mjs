#!/usr/bin/env node
// I-147 全身果冻 (docs/claude/2026-11-17-whole-body-jelly.md): measure the two experimental layers in the physics lab, in an isolated
// temporary profile, on the bundled Gene. Builds nothing (run the build first). Same isolation as physics-lab-look.mjs: a fresh
// temporary profile, an inert Claude Code path, an empty Claude config, developer mode on in that profile only; deleted at the end.
// For 60 and 30 fps, with the lab waiting for the GPU each frame ("量帧时间"), it reads the whole frame's cost with: both layers
// off, layer 2 only, layer 3 only, both; then saves a tuning with both on, checks the sidecar and the companion's settings carry it (the
// companion window then compiles the jelly shader: its console must stay clean), and removes it again.
//   node scripts/dev/jelly-look.mjs [--keep] [--motion 挥手] [--seconds 6]
// Output: .local/jelly-look/<time>/report.json and screenshots.
import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const motionLabel = arg('--motion', '挥手'), seconds = Number(arg('--seconds', '6'));
const output = path.join(root, '.local', 'jelly-look', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const temp = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-jelly-look-'));
const profile = path.join(temp, 'profile'), claudeHome = path.join(temp, 'claude-home'), localAppData = path.join(temp, 'local');
await Promise.all([profile, claudeHome, localAppData].map(dir => mkdir(dir, { recursive: true })));
const placeholder = path.join(temp, 'claude-placeholder.txt');
await writeFile(placeholder, '# jelly look: CLAUDE_PATH placeholder, never a real Claude Code\n');
const keep = process.argv.includes('--keep');
const pick = keys => Object.fromEntries(Object.entries(process.env).filter(([key]) => keys.includes(key.toUpperCase())));
const env = { ...pick(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']),
  LOCALAPPDATA: localAppData, CLAUDE_PATH: placeholder, CLAUDE_CONFIG_DIR: claudeHome, CODEX_PATH: path.join(temp, 'no-codex'), CODEX_HOME: path.join(temp, 'codex-home'),
  MMD_DESK_USER_DATA: profile, SOFT_HEARTS_TEST_PET_CORNER: 'top-left' };
const report = { output, motion: motionLabel, seconds, frames: [], steps: [], errors: [] };
const note = (step, value) => { report.steps.push({ step, ...(value === undefined ? {} : { value }) }); console.log(step, value === undefined ? '' : JSON.stringify(value)); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let app;
try {
  app = await electron.launch({ args: ['.'], cwd: root, env });
  const controls = await app.firstWindow();
  await controls.waitForLoadState('domcontentloaded');
  app.on('window', page => page.on('console', message => { if (message.type() === 'error') report.errors.push(`${page.url().split('/').pop()}: ${message.text().slice(0, 400)}`); }));
  for (const page of app.windows()) page.on('console', message => { if (message.type() === 'error') report.errors.push(`${page.url().split('/').pop()}: ${message.text().slice(0, 400)}`); });
  let model = null;
  for (let i = 0; i < 60 && !model; i++) { model = await controls.evaluate(() => window.desktop.getSettings().then(s => s.model?.url ?? null)).catch(() => null); if (!model) await pause(500); }
  note('model set', !!model);
  await controls.evaluate(() => window.desktop.setMoodDeveloperMode(true));
  await pause(800);
  note('openPhysicsLab', await controls.evaluate(() => window.desktop.openPhysicsLab().then(() => 'opened', error => String(error))));
  let lab = null;
  for (let i = 0; i < 40 && !lab; i++) { lab = app.windows().find(page => page.url().includes('physics-lab')) ?? null; if (!lab) await pause(500); }
  if (!lab) throw new Error('the lab window did not open');
  lab.on('pageerror', error => report.errors.push(`lab page: ${error.message}`));
  for (let i = 0; i < 60; i++) { const rows = await lab.$$eval('table.numbers tbody tr', rows => rows.length).catch(() => 0); if (rows) break; await pause(500); }
  await lab.click(`#overlay >> text=${motionLabel}`).catch(error => report.errors.push(`motion: ${error}`));
  await lab.evaluate(() => window.labMeasure(true));
  const setLayers = async (follow, soft) => lab.evaluate(([f, s]) => {
    const boxes = [...document.querySelectorAll('#side label.check')];
    const box = text => boxes.find(label => label.textContent?.startsWith(text))?.querySelector('input');
    for (const [text, want] of [['第 2 层', f], ['第 3 层', s]]) { const input = box(text); if (input && input.checked !== want) input.click(); }
  }, [follow, soft]);
  note('soft regions on Gene', await lab.$$eval('#side details.group summary', nodes => nodes.map(node => node.textContent).filter(text => /处|没找到/.test(text ?? ''))));
  for (const fps of [60, 30]) {
    await lab.click(`#overlay >> text=${fps} 帧`);
    for (const [label, follow, soft] of [['off', false, false], ['layer2', true, false], ['layer3', false, true], ['both', true, true], ['off-again', false, false]]) {
      await setLayers(follow, soft);
      await pause(1500); // the fade and the shader compile settle
      await lab.evaluate(() => window.labMeasure(true));
      const samples = [];
      for (let t = 0; t < seconds; t++) { await pause(1000); samples.push(await lab.evaluate(() => window.labFrame)); }
      const frame = samples.map(sample => sample.frameMs).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
      const last = samples.at(-1);
      const row = { fps, layers: label, frameMs: Number(frame.toFixed(3)), followMs: last.jelly?.follow?.avgMs ?? null, softMs: last.jelly?.soft?.avgMs ?? null,
        followDeg: last.jelly?.follow?.maxShownDeg ?? null, softShown: last.jelly?.soft?.maxShown ?? null, materials: last.jelly?.soft?.materials ?? 0, unsupported: last.jelly?.soft?.unsupported ?? 0 };
      report.frames.push(row); console.log(JSON.stringify(row));
      if (label === 'both' && fps === 60) await lab.screenshot({ path: path.join(output, 'both-on-60.png') });
    }
  }
  await lab.evaluate(() => window.labMeasure(false));
  await setLayers(true, true);
  await pause(500);
  await lab.click('text=保存为这个模型的设置');
  await pause(1500);
  const sidecar = JSON.parse(await readFile(path.join(profile, 'physics-tuning.json'), 'utf8').catch(() => 'null'));
  note('sidecar has jelly on', !!sidecar?.models?.[0]?.tuning?.jelly?.follow?.enabled && !!sidecar?.models?.[0]?.tuning?.jelly?.soft?.enabled);
  const pet = await controls.evaluate(() => window.desktop.getModelPhysicsSettings());
  note('pet settings carry the jelly tuning', !!pet.tuning?.jelly?.soft?.enabled);
  await pause(4000); // the companion draws with both layers (its console is watched)
  await lab.click('text=恢复原样');
  await pause(2000);
  note('pet settings after clear', (await controls.evaluate(() => window.desktop.getModelPhysicsSettings())).tuning ?? null);
  await controls.evaluate(() => window.desktop.setMoodDeveloperMode(false)).catch(() => {});
} catch (error) {
  report.errors.push(String(error?.stack ?? error));
  console.error(error);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (!keep) await rm(temp, { recursive: true, force: true }).catch(() => {});
  console.log('errors', report.errors.length, report.errors.slice(0, 5));
  console.log('report', path.join(output, 'report.json'));
}
