// Repro / check for 2026-11-02 smoke triage P4: can a real mouse start a head pat (rua) on Gene's crown?
//   node scripts/smoke-runner.mjs crown-reach-probe.mjs recovered --timeout 150   # after one-click recovery
//   node scripts/smoke-runner.mjs crown-reach-probe.mjs fresh --timeout 150       # a fresh profile, nothing touched
// Hovers the crown with the toolbar expanded, folds the toolbar with a real click on its ">" button, hovers again,
// unfolds it with a real click, then enters and leaves camera edit with real clicks on that toolbar button.
// Prints the camera, the crown, the toolbar box and the mood phase reached; exits 1 if any step failed.
// Isolated temporary profile, no chat (Claude Code is an inert placeholder); `pnpm build` first.
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { createClaudeIsolation } from './lib/claude-smoke-fixture.mjs';
import { closeElectron } from './lib/electron-cleanup.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(workspace, '.local/crown-reach-probe');
await mkdir(out, { recursive: true });
const profile = await mkdtemp(path.join(out, 'profile-'));
const claude = await createClaudeIsolation();
const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile }); delete env.ELECTRON_RUN_AS_NODE;
const mode = process.argv[2] === 'fresh' ? 'fresh' : 'recovered';
const instance = await electron.launch({ args: [workspace, `--user-data-dir=${profile}`], cwd: workspace, env, timeout: 30000 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failures = [];
try {
  await instance.firstWindow();
  await sleep(3000);
  const controls = instance.windows().find(page => page.url().includes('index.html') && !page.url().includes('pet=1'));
  const pet = instance.windows().find(page => page.url().includes('pet=1'));
  await controls.evaluate(async mode => {
    const settings = await window.desktop.getSettings(); settings.pet.followMouse = false; await window.desktop.saveSettings(settings);
    if (mode === 'recovered') await window.desktop.recoverPet();
  }, mode);
  await sleep(5000);
  await pet.bringToFront();
  const geometry = () => pet.evaluate(() => {
    const region = JSON.parse(document.querySelector('#stage canvas').dataset.interactionRegion);
    const bar = document.getElementById('pet-toolbar').getBoundingClientRect();
    const rect = document.querySelector('#stage').getBoundingClientRect();
    return { crown: { x: rect.left + region.x, y: rect.top + region.y, halfHeight: Math.hypot(region.axisYX, region.axisYY), halfWidth: Math.hypot(region.axisXX, region.axisXY) },
      toolbar: { left: bar.left, top: bar.top, right: bar.right, bottom: bar.bottom }, collapsed: document.getElementById('pet-toolbar').classList.contains('is-collapsed'),
      viewport: { width: innerWidth, height: innerHeight } };
  });
  const round = value => Math.round(value * 10) / 10;
  const tryCrown = async label => {
    const g = await geometry();
    await pet.mouse.move(g.crown.x - 60, g.crown.y + 200); await sleep(300);
    let phase = 'idle';
    for (let i = 0; i < 12 && phase !== 'rua'; i++) {
      await pet.mouse.move(g.crown.x + (i % 2 ? 6 : -6), g.crown.y); await sleep(250);
      phase = (await pet.evaluate(() => window.desktop.getMood())).snapshot.phase;
    }
    const top = g.crown.y - g.crown.halfHeight;
    const insideToolbar = g.crown.x >= g.toolbar.left && g.crown.x < g.toolbar.right && g.crown.y >= g.toolbar.top && g.crown.y < g.toolbar.bottom;
    console.log(mode, label, JSON.stringify({ crown: { x: round(g.crown.x), y: round(g.crown.y), top: round(top), halfHeight: round(g.crown.halfHeight), halfWidth: round(g.crown.halfWidth) },
      toolbar: Object.fromEntries(Object.entries(g.toolbar).map(([key, value]) => [key, round(value)])), viewport: g.viewport, collapsed: g.collapsed, insideToolbar, inWindow: top >= 0, phase }));
    if (phase !== 'rua') failures.push(`${label}: crown hover reached ${phase}`);
    await pet.mouse.move(g.crown.x - 60, g.crown.y + 260); await sleep(1500);
  };
  // A real click: hover reveals the faded toolbar, then the button itself is clicked.
  const clickToolbar = async id => {
    const box = await pet.locator(`#${id}`).boundingBox();
    if (!box) throw Error(`${id} has no box`);
    await pet.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await sleep(350);
    await pet.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await sleep(300);
  };
  console.log('camera', JSON.stringify((await controls.evaluate(() => window.desktop.getSettings())).camera));
  await tryCrown('expanded-toolbar');
  await clickToolbar('pet-toolbar-toggle');
  if ((await geometry()).collapsed !== true) failures.push('a real click on ">" did not fold the toolbar');
  await tryCrown('collapsed-toolbar');
  await clickToolbar('pet-toolbar-toggle');
  if ((await geometry()).collapsed !== false) failures.push('a real click on "<" did not unfold the toolbar');
  await clickToolbar('pet-camera-edit');
  const editing = await pet.locator('#pet-camera-edit').getAttribute('aria-pressed');
  await clickToolbar('pet-camera-edit');
  const done = await pet.locator('#pet-camera-edit').getAttribute('aria-pressed');
  console.log(mode, 'toolbar-buttons', JSON.stringify({ toggleFoldsAndUnfolds: !failures.some(f => f.includes('fold')), cameraEditOn: editing, cameraEditOff: done }));
  if (editing !== 'true' || done !== 'false') failures.push(`camera edit button: ${editing} -> ${done}`);
  await tryCrown('re-expanded-toolbar');
  console.log('camera-after', JSON.stringify((await controls.evaluate(() => window.desktop.getSettings())).camera));
} catch (error) { failures.push(String(error?.stack ?? error)); }
finally { console.log(JSON.stringify(await closeElectron(instance, 20000))); }
console.log(mode, failures.length ? `FAILED ${JSON.stringify(failures)}` : 'PASS');
process.exitCode = failures.length ? 1 : 0;
