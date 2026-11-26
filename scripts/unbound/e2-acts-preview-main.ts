// Unbound U2 experiment E2 preview (docs/claude/2026-11-14-unbound-night-e2-autonomy.md): the real Unbound host, window, preload and
// page with the bundled Gene, in a small window, in a temporary user-data folder. Her acts are started through the page's probe
// (window.__unboundProbe.act); nothing else starts them. The idle time is a number this script sets; no input is read. Screenshots
// are this window's own pixels. Not the app: no settings, chat, profile, mood or calls.
import { app, BrowserWindow, ipcMain, net, protocol, screen } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AssetRegistry } from '../../electron/foundation/assets';
import { createAssetProtocolHandler } from '../../electron/foundation/asset-protocol';
import { UnboundHost, type UnboundIpcMain } from '../../electron/unbound/host';
import { asUnboundWindow, primaryDisplayFacts } from '../../electron/unbound/electron-host';
import { createUnboundWindow, loadUnboundPage } from '../../electron/unbound/window';
import { readMonitorSizes } from '../../electron/unbound/display-size';
import { NEUTRAL_MOOD } from '../../shared/unbound/director';

const plan = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--plan') + 1], 'utf8')) as { out: string; build: string; gene: string; stand: string; userData: string };
app.setPath('userData', plan.userData);
app.setName('unbound-e2-preview');
protocol.registerSchemesAsPrivileged([{ scheme: 'mmd-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const results: Record<string, unknown> = {};
const log = (line: string) => console.log(`[e2] ${line}`);

interface ActState { active: boolean; act: string | null; beat: string | null; t: number; lastEnd: unknown; hopLift: number; armsRaised: number; comMargin: number | null }

app.whenReady().then(async () => {
  mkdirSync(plan.out, { recursive: true });
  const assets = new AssetRegistry();
  const model = await assets.register(plan.gene), stand = await assets.register(plan.stand);
  protocol.handle('mmd-asset', createAssetProtocolHandler({ resolve: url => assets.resolve(url), fetchFile: url => net.fetch(url) }));
  const wa = screen.getPrimaryDisplay().workArea;
  const pet = new BrowserWindow({ x: wa.x + wa.width - 260, y: wa.y + wa.height - 300, width: 200, height: 260, frame: false, skipTaskbar: true, focusable: false, show: false, backgroundColor: '#ffd6e6' });
  await pet.loadURL('data:text/html,<body style="margin:0;font:16px sans-serif;display:grid;place-items:center;height:100vh">pet</body>');
  pet.showInactive();
  let unboundWindow: BrowserWindow | null = null;
  const preview = { x: wa.x + 40, y: wa.y + 40, width: 960, height: 600 };
  const host = new UnboundHost({
    ipcMain: ipcMain as unknown as UnboundIpcMain,
    pet: () => pet, petWanted: () => true, developerMode: () => true,
    source: () => ({ modelUrl: model.url, motion: { pose: stand.url, gesture: null, expression: null, legacy: false }, breath: 0.5, physics: null }),
    reviewed: async () => true, display: primaryDisplayFacts, measure: () => readMonitorSizes(),
    openWindow: bounds => {
      const win = unboundWindow = createUnboundWindow(bounds, { electronDir: plan.build, distDir: plan.build });
      win.webContents.on('console-message', (_event, _level, message) => { if (!/deprecated/.test(message)) log(`page: ${message}`); });
      return { window: asUnboundWindow(win), loaded: loadUnboundPage(win, { electronDir: plan.build, distDir: plan.build }, { probe: 'preview' }) }; // round 13: the preview-only probes
    },
    restored: () => {}, publish: () => {}, preview: { bounds: preview },
    // The peek never starts by itself here (idle 0, and its knob at the longest); the acts are what this preview shows.
    peek: {
      clock: () => Date.now(), random: () => Math.random(), idleSeconds: () => 0, idleNow: () => 0,
      asleep: () => false, inCall: () => false, userTalking: () => false, mood: () => NEUTRAL_MOOD, lastInteractionAt: () => null, answered: () => false,
      every: (ms, run) => { const t = setInterval(run, ms); return () => clearInterval(t); },
    },
  });
  const until = async (test: () => Promise<boolean> | boolean, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await sleep(15); } return test(); };
  const shots: string[] = [];
  const shot = async (name: string) => {
    if (!unboundWindow || unboundWindow.isDestroyed()) return;
    const image = await unboundWindow.webContents.capturePage();
    writeFileSync(path.join(plan.out, `${name}.png`), image.toPNG());
    shots.push(name);
  };
  const page = <T>(expression: string) => unboundWindow!.webContents.executeJavaScript(expression) as Promise<T>;
  const state = () => page<ActState>('window.__unboundProbe.actState()');
  const fps = async () => (await page<{ fps: number | null }>('window.__unboundProbe.stats()')).fps;
  try {
    host.apply({ active: true });
    const entered = await until(() => host.state === 'unbound', 40_000);
    if (!entered) throw new Error(`did not enter: ${host.view().error}`);
    host.apply({ depthM: 7 }); // her whole body, feet and floor in the window (at 4 m her feet are below its edge)
    await sleep(1_500);
    await until(async () => !(await page<{ moving: boolean }>('window.__unboundProbe.stats()')).moving, 40_000);
    await sleep(1_000);
    await shot('0-standing');
    const ends: Record<string, unknown> = {}, fpsDuring: Record<string, (number | null)[]> = {};

    // ---- sway ----------------------------------------------------------------------------------------------------------------
    const steps = async () => (await page<{ steps: number }>('window.__unboundProbe.stats()')).steps;
    const stepsBeforeSway = await steps();
    if (!(await page<boolean>("window.__unboundProbe.act('sway')"))) throw new Error('sway did not start');
    fpsDuring.sway = [];
    await sleep(1_900); await shot('1-sway-left'); fpsDuring.sway.push(await fps());
    await sleep(1_050); await shot('1-sway-right'); fpsDuring.sway.push(await fps());
    await until(async () => !(await state()).active, 15_000);
    ends.sway = (await state()).lastEnd;
    results.stepsDuringSway = (await steps()) - stepsBeforeSway;
    log(`steps during the sway: ${results.stepsDuringSway as number}`);

    // ---- stretch -------------------------------------------------------------------------------------------------------------
    await sleep(800);
    if (!(await page<boolean>("window.__unboundProbe.act('stretch')"))) throw new Error('stretch did not start');
    fpsDuring.stretch = [];
    await until(async () => (await state()).beat === 'up', 5_000); await sleep(500); await shot('2-stretch-rising');
    await until(async () => (await state()).beat === 'hold', 5_000); await sleep(800); await shot('2-stretch-top'); fpsDuring.stretch.push(await fps());
    results.stretchTop = await state();
    await until(async () => (await state()).beat === 'down', 5_000); await sleep(600); await shot('2-stretch-letting-go');
    await until(async () => !(await state()).active, 15_000);
    ends.stretch = (await state()).lastEnd;

    // ---- hop: once at full speed (frame rate, end report), once slowed to a tenth for the key frames ----------------------------
    await sleep(800);
    if (!(await page<boolean>("window.__unboundProbe.act('hop')"))) throw new Error('hop did not start');
    fpsDuring.hop = [];
    await until(async () => (await state()).beat === 'flight', 5_000); fpsDuring.hop.push(await fps());
    await until(async () => !(await state()).active, 15_000);
    ends.hopFullSpeed = (await state()).lastEnd;
    await sleep(800);
    await page('window.__unboundProbe.timeScale(0.1)');
    if (!(await page<boolean>("window.__unboundProbe.act('hop')"))) throw new Error('slow hop did not start');
    const caught: Record<string, ActState> = {};
    await until(async () => { const s = await state(); return s.beat === 'crouch' && s.hopLift < -0.045; }, 20_000);
    await shot('3-hop-crouch'); caught.crouch = await state();
    await until(async () => (await state()).beat === 'flight', 20_000); await sleep(1_300);
    await shot('4-hop-in-the-air'); caught.air = await state();
    await until(async () => { const s = await state(); return s.beat === 'land' && s.hopLift < -0.035; }, 20_000);
    await shot('5-hop-landing'); caught.landing = await state();
    await page('window.__unboundProbe.timeScale(1)');
    await until(async () => !(await state()).active, 20_000);
    ends.hopSlow = (await state()).lastEnd;
    results.hopCaught = caught;
    results.ends = ends; results.fpsDuring = fpsDuring; results.shots = shots;
    results.stats = await page('window.__unboundProbe.stats()');
    log(`ends ${JSON.stringify(ends)}`);
    log(`fps ${JSON.stringify(fpsDuring)}`);
    log(`hop caught ${JSON.stringify(Object.fromEntries(Object.entries(caught).map(([k, v]) => [k, { beat: v.beat, hopLift: v.hopLift }])))}`);
  } catch (error) {
    results.error = String((error as Error)?.stack ?? error);
    log(`error ${results.error}`);
  } finally {
    writeFileSync(path.join(plan.out, 'results.json'), JSON.stringify(results, null, 2));
    host.quit();
    app.exit(results.error ? 1 : 0);
  }
});
