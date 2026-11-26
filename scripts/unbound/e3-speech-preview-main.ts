// Unbound night experiment E3 preview (docs/claude/2026-11-14-unbound-night-e3-speech.md): the real Unbound host, window,
// preload, page and director with the bundled Gene, in a small window ('fit': the whole screen's view scaled into 960x600), in a
// temporary user-data folder. The reply is a stand-in text sent through the host's own stream() (no model, no chat, no profile).
// She first turns to look 35° to her side (a preview-only probe call); then the reply comes; screenshots at fixed moments after its
// first words, once with the opening beat off and once on. Screenshots are this window's own pixels.
import { app, BrowserWindow, ipcMain, net, protocol, screen } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AssetRegistry } from '../../electron/foundation/assets';
import { createAssetProtocolHandler } from '../../electron/foundation/asset-protocol';
import { UnboundHost, type UnboundIpcMain } from '../../electron/unbound/host';
import { asUnboundWindow, primaryDisplayFacts } from '../../electron/unbound/electron-host';
import { createUnboundWindow, loadUnboundPage } from '../../electron/unbound/window';
import { readMonitorSizes } from '../../electron/unbound/display-size';
import type { MoodReading } from '../../shared/unbound/director';

const plan = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--plan') + 1], 'utf8')) as { out: string; build: string; gene: string; stand: string; userData: string };
app.setPath('userData', plan.userData);
app.setName('unbound-e3-preview');
protocol.registerSchemesAsPrivileged([{ scheme: 'mmd-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const results: Record<string, unknown> = {};
const log = (line: string) => console.log(`[e3] ${line}`);
const CALM: MoodReading = { D: 50, O: 50, E: 50, N: 50, C: 50, A: 0.2, B: 0, M: 0 };
/** Moments after the reply's first words (ms) for the screenshots; the reply is done at 1000 ms. */
const SHOTS = [-100, 120, 300, 550, 820, 1000, 1200, 1500, 2200, 4500];
const ASIDE_DEG = 35;

interface SpeechProbe { enabled: boolean; active: boolean; phase: string | null; phases: { phase: string; at: number }[]; bubbleAt: number | null; interrupted: string | null; skipped: string | null; holding: number }

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
    // Never peeks by itself here: the idle time is unknown (null), so the host's director stays quiet.
    peek: {
      clock: () => Date.now(), random: () => Math.random(), idleSeconds: () => null, idleNow: () => null,
      asleep: () => false, inCall: () => false, userTalking: () => false, mood: () => CALM, lastInteractionAt: () => null, answered: () => false,
      every: (ms, run) => { const t = setInterval(run, ms); return () => clearInterval(t); },
    },
  });
  const until = async (test: () => Promise<boolean> | boolean, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await sleep(25); } return test(); };
  const page = <T>(expression: string) => unboundWindow!.webContents.executeJavaScript(expression) as Promise<T>;
  const speech = () => page<SpeechProbe>('window.__unboundProbe.speech()');
  try {
    host.apply({ active: true });
    if (!(await until(() => host.state === 'unbound', 40_000))) throw new Error(`did not enter: ${host.view().error}`);
    host.apply({ depthM: 1.2 });
    await until(async () => !(await page<{ moving: boolean }>('window.__unboundProbe.stats()')).moving, 30_000);
    await sleep(1_000);
    for (const [label, on] of [['without', false], ['with', true]] as const) {
      host.apply({ speechBeat: on });
      // She looks to her side (35° off the line to you), and settles there.
      const stats = await page<{ placement: { xM: number; depthM: number } }>('window.__unboundProbe.stats()');
      const d = host.view().viewerDistanceCm / 100, x = stats.placement.xM, z = -stats.placement.depthM;
      const a = Math.atan2(0 - x, d - z) + ASIDE_DEG * Math.PI / 180;
      await page(`window.__unboundProbe.faceToward(${x + 20 * Math.sin(a)}, ${z + 20 * Math.cos(a)})`);
      await sleep(3_500);
      const id = `e3-${label}`;
      const shots: { name: string; plannedMs: number; atMs: number; phase: string | null; bubbleShown: boolean }[] = [];
      let t0 = 0, sentDone = false;
      const shoot = async (at: number) => {
        const image = await unboundWindow!.webContents.capturePage();
        const atMs = t0 ? Math.round(performance.now() - t0) : at;
        const probe = await speech();
        const bubbleShown = await page<boolean>("!document.querySelector('.unbound-bubble')?.hidden");
        const name = `${label}-${String(SHOTS.indexOf(at)).padStart(2, '0')}-${at < 0 ? 'm' : ''}${Math.abs(at)}ms`;
        writeFileSync(path.join(plan.out, `${name}.png`), image.toPNG());
        shots.push({ name, plannedMs: at, atMs, phase: probe.phase, bubbleShown });
      };
      await shoot(SHOTS[0]); // before her words
      await sleep(-SHOTS[0]);
      t0 = performance.now();
      host.stream({ id, kind: 'chat', type: 'delta', text: '嗯，我在听呢。' }); // her first words
      for (const at of SHOTS.slice(1)) {
        if (!sentDone && at > 1000) { await sleep(Math.max(0, t0 + 1000 - performance.now())); host.stream({ id, kind: 'chat', type: 'done', text: '' }); sentDone = true; }
        await sleep(Math.max(0, t0 + at - performance.now()));
        await shoot(at);
      }
      if (!sentDone) host.stream({ id, kind: 'chat', type: 'done', text: '' });
      const final = await speech();
      results[label] = { shots, phases: final.phases, bubbleAt: final.bubbleAt, skipped: final.skipped, interrupted: final.interrupted };
      log(`${label}: ${JSON.stringify(results[label])}`);
      await sleep(4_000); // the bubble lingers 6 s; she is back in her idle
    }
  } catch (error) {
    results.error = String((error as Error)?.stack ?? error);
    log(`error ${results.error}`);
  } finally {
    writeFileSync(path.join(plan.out, 'results.json'), JSON.stringify(results, null, 2));
    host.quit();
    app.exit(results.error ? 1 : 0);
  }
});
