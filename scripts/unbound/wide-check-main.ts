// Development check (docs/claude/2026-11-21-unbound-wide.md): the real Unbound host, preload and page full screen with a given
// display (default the user's: 1536x960 DIP, a 48 DIP taskbar), her saved place and a viewer distance, a model read only (Gene or
// a VRM). Started by scripts/unbound/wide-check.mjs under Electron, in a temporary user-data folder. --offscreen (default): the
// window never shows (offscreen rendering); --onscreen: the real window shows on the screen for a few seconds.
// It captures the window's own pixels and measures her silhouette's on-screen width / height (alpha bounding box), with the page's
// own sizes (innerWidth/innerHeight, the canvas, the device pixel ratio) next to the world's window rectangle.
import { app, BrowserWindow, ipcMain, net, protocol } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AssetRegistry } from '../../electron/foundation/assets';
import { createAssetProtocolHandler } from '../../electron/foundation/asset-protocol';
import { UnboundHost, type UnboundIpcMain } from '../../electron/unbound/host';
import { asUnboundWindow, primaryDisplayFacts } from '../../electron/unbound/electron-host';
import { loadUnboundPage } from '../../electron/unbound/window';
import { UNBOUND_PRELOAD, unboundWindowOptions } from '../../electron/unbound/window-options';
import type { DisplayFacts } from '../../shared/unbound/world';

interface Plan {
  out: string; build: string; model: string; stand: string; userData: string; label: string;
  display: DisplayFacts | null; across: number; depthM: number; viewerCm: number | null; offscreen: boolean; waitMs: number; dsf?: number | null; move?: boolean;
}
const plan = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--plan') + 1]!, 'utf8')) as Plan;
app.setPath('userData', plan.userData);
app.setName('unbound-wide-check');
if (plan.dsf) app.commandLine.appendSwitch('force-device-scale-factor', String(plan.dsf));
protocol.registerSchemesAsPrivileged([{ scheme: 'mmd-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const log = (line: string) => console.log(`[wide] ${line}`);

/** The alpha bounding box of a BGRA bitmap (pixels with alpha above `min`). */
function alphaBox(bitmap: Buffer, width: number, height: number, min = 24) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1, count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (bitmap[(y * width + x) * 4 + 3]! > min) { count++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, pixels: count };
}

app.whenReady().then(async () => {
  mkdirSync(plan.out, { recursive: true });
  const assets = new AssetRegistry();
  const model = await assets.register(plan.model), stand = await assets.register(plan.stand);
  protocol.handle('mmd-asset', createAssetProtocolHandler({ resolve: url => assets.resolve(url), fetchFile: url => net.fetch(url) }));
  let win: BrowserWindow | null = null;
  const display = () => plan.display ?? primaryDisplayFacts();
  const host = new UnboundHost({
    ipcMain: ipcMain as unknown as UnboundIpcMain,
    pet: () => null, petWanted: () => false, developerMode: () => true, // no-pet-ok: the host's own port names
    source: () => ({ modelUrl: model.url, motion: { pose: stand.url, gesture: null, expression: null, legacy: false }, breath: 0.5, physics: null }),
    reviewed: async () => false, display, measure: async () => null,
    savedPlace: { load: async () => ({ version: 1, across: plan.across, depthM: plan.depthM }), save: () => {} },
    openWindow: bounds => {
      const options = unboundWindowOptions(bounds, path.join(plan.build, UNBOUND_PRELOAD));
      if (plan.offscreen) options.webPreferences = { ...options.webPreferences, offscreen: true, backgroundThrottling: false };
      win = new BrowserWindow(options);
      win.webContents.on('console-message', (_event, _level, message) => { if (!/deprecated/i.test(message)) log(`page: ${message}`); });
      const port = asUnboundWindow(win);
      if (plan.offscreen) port.showInactive = () => {}; // never on the screen
      return { window: port, loaded: loadUnboundPage(win, { electronDir: plan.build, distDir: plan.build }) };
    },
    restored: () => {}, publish: () => {},
  });
  const results: Record<string, unknown> = { label: plan.label, plan: { ...plan, userData: undefined } };
  try {
    if (plan.viewerCm !== null) host.apply({ viewerDistanceCm: plan.viewerCm });
    host.apply({ active: true });
    const end = Date.now() + 60_000;
    while (host.state !== 'unbound' && Date.now() < end) await sleep(50);
    if (host.state !== 'unbound') throw new Error(`did not enter: ${host.view().error}`);
    await sleep(plan.waitMs);
    const w = win as BrowserWindow | null;
    if (!w) throw new Error('no window');
    const page = <T>(expression: string) => w.webContents.executeJavaScript(expression) as Promise<T>;
    if (plan.move) {
      // The pointer moves over the window (the app forwards every move on the screen to her page): before 2026-11-21 her touch
      // input's head region rebuilt the world camera's projection on such a move and she turned wide and short.
      const head = await page<{ x: number; y: number } | null>('window.__unboundProbe.head()');
      for (const [x, y] of [[200, 200], [head?.x ?? 400, head?.y ?? 400]]) { w.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x!), y: Math.round(y!) }); await sleep(250); }
      w.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 20 }); await sleep(600);
    }
    results.window = w.getBounds();
    results.page = await page(`(() => { const c = document.querySelector('canvas.unbound-stage'); const r = c.getBoundingClientRect();
      const gl = c.getContext('webgl2') || c.getContext('webgl'); const p = window.__unboundProbe;
      return { innerWidth, innerHeight, dpr: devicePixelRatio, canvas: [c.width, c.height], css: [r.width, r.height], viewport: gl ? Array.from(gl.getParameter(gl.VIEWPORT)) : null,
        drawing: gl ? [gl.drawingBufferWidth, gl.drawingBufferHeight] : null, body: p.body(), head: p.head(), perf: p.perf() }; })()`);
    results.stats = await page('window.__unboundProbe.stats()');
    results.view = host.view();
    results.display = display();
    const image = await w.webContents.capturePage();
    const size = image.getSize();
    writeFileSync(path.join(plan.out, `${plan.label}.png`), image.toPNG());
    const box = alphaBox(image.toBitmap(), size.width, size.height);
    results.capture = { size, box, aspect: box ? +(box.width / box.height).toFixed(4) : null };
    log(`${plan.label}: window ${JSON.stringify(results.window)} page ${JSON.stringify(results.page)} box ${JSON.stringify(box)} w/h ${box ? (box.width / box.height).toFixed(4) : '-'}`);
  } catch (error) {
    results.error = String(error);
    log(`error: ${String(error)}`);
  } finally {
    writeFileSync(path.join(plan.out, `${plan.label}.json`), JSON.stringify(results, null, 2));
    host.apply({ active: false });
    await sleep(300);
    app.exit(0);
  }
});
