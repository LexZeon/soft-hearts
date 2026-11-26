// E1 eye-head screenshots, Electron side: one window far off every screen (never the desktop), a temporary user-data folder, the
// bundled Gene served from the repository. For each scene it loads the page, lets it step the scene and draw the chosen frame,
// then saves this window's own pixels (capturePage). Not the app: no host, settings, profile, chat or calls.
import { app, BrowserWindow, net, protocol } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { preparePmxForMmdParser } from '../../shared/foundation/pmx-text-encoding';

const plan = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--plan') + 1], 'utf8')) as {
  out: string; build: string; geneDir: string; userData: string; label: string; scenes: string[]; frames: Record<string, number> };
app.setPath('userData', plan.userData);
app.setName('eye-head-shots');
protocol.registerSchemesAsPrivileged([{ scheme: 'eyeshot', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.on('window-all-closed', () => { /* quits itself */ });

app.whenReady().then(async () => {
  protocol.handle('eyeshot', async request => {
    const url = new URL(request.url), headers = { 'Access-Control-Allow-Origin': '*' };
    try {
      if (url.host === 'app') {
        const name = path.basename(decodeURIComponent(url.pathname));
        return new Response(await readFile(path.join(plan.build, name)), { headers: { ...headers, 'Content-Type': name.endsWith('.js') ? 'text/javascript' : 'text/html' } });
      }
      const file = path.resolve(plan.geneDir, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
      if (!file.startsWith(path.resolve(plan.geneDir) + path.sep)) return new Response('no', { status: 403 });
      if (file.toLowerCase().endsWith('.pmx')) return new Response(Buffer.from(preparePmxForMmdParser(new Uint8Array(await readFile(file))).bytes), { headers });
      const res = await net.fetch(pathToFileURL(file).toString());
      return new Response(res.body, { status: res.status, headers: { ...headers, 'Content-Type': file.endsWith('.png') ? 'image/png' : 'application/octet-stream' } });
    } catch { return new Response('missing', { status: 404 }); }
  });
  mkdirSync(plan.out, { recursive: true });
  const results: Record<string, unknown> = {};
  try {
    for (const name of plan.scenes) {
      // Off-screen rendering: the window is never on any screen; its pixels are its own (capturePage, or the last painted frame).
      const win = new BrowserWindow({ width: 720, height: 720, show: false, frame: false, skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false, offscreen: true } });
      let painted: Electron.NativeImage | null = null;
      win.webContents.on('paint', (_event, _dirty, image) => { painted = image; });
      win.webContents.setFrameRate(30);
      const config = { scene: name, model: 'eyeshot://gene/model/gene.pmx', stand: 'eyeshot://gene/motions/pose/stand.vmd', ...(plan.frames[name] !== undefined ? { frame: plan.frames[name] } : {}) };
      await win.loadURL(`eyeshot://app/page.html?config=${encodeURIComponent(JSON.stringify(config))}`);
      const result = await win.webContents.executeJavaScript('window.__run()');
      await new Promise(resolve => setTimeout(resolve, 300));
      let image = await win.webContents.capturePage().catch(() => null);
      if (!image || image.isEmpty()) image = painted;
      if (!image) throw new Error('no picture');
      writeFileSync(path.join(plan.out, `${plan.label}-${name}.png`), image.toPNG());
      results[name] = result;
      console.log(`[eye-shots] ${plan.label} ${name} ${JSON.stringify(result)}`);
      win.destroy();
    }
  } catch (error) {
    results.error = String((error as Error)?.stack ?? error);
    console.error(results.error);
  } finally {
    writeFileSync(path.join(plan.out, `${plan.label}-results.json`), JSON.stringify(results, null, 2));
    app.exit(results.error ? 1 : 0);
  }
});
