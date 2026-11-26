// Motion-model spike round 2: the video host (docs/claude/2026-11-14-motion-model-spike.md「第 2 轮」). One 1280x720 window with
// the video page, a temporary user-data folder, nothing of the app (no settings, chat, profile or calls). Records only the page's
// own canvas (MediaRecorder in the page) and writes the webm files; each recording's bytes come out in base64 slices.
import { app, BrowserWindow, net, protocol, screen } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { preparePmxForMmdParser } from '../../shared/foundation/pmx-text-encoding';

interface Take { file: string; mode: 'side' | 'sequence'; groups: string[]; seconds: number; activity: number; warmS: number }
const plan = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--plan') + 1], 'utf8')) as {
  out: string; build: string; gene: string; data: Record<string, string>; userData: string; takes: Take[] };
app.setPath('userData', plan.userData);
app.setName('idle-video');
protocol.registerSchemesAsPrivileged([{ scheme: 'idlep', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const log = (line: string) => console.log(`[idle-video] ${line}`);

app.whenReady().then(async () => {
  mkdirSync(plan.out, { recursive: true });
  protocol.handle('idlep', async request => {
    const url = new URL(request.url), headers = { 'Access-Control-Allow-Origin': '*' };
    try {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (url.host === 'app') {
        const name = path.basename(rel);
        return new Response(await readFile(path.join(plan.build, name)), { headers: { ...headers, 'Content-Type': name.endsWith('.js') ? 'text/javascript' : 'text/html' } });
      }
      if (url.host === 'data') {
        const file = plan.data[rel]; // only the named files
        if (!file) return new Response('no', { status: 403 });
        return new Response(await readFile(file), { headers: { ...headers, 'Content-Type': rel.endsWith('.json') ? 'application/json' : 'application/octet-stream' } });
      }
      const file = path.resolve(plan.gene, rel);
      if (!file.startsWith(path.resolve(plan.gene) + path.sep)) return new Response('no', { status: 403 });
      if (file.toLowerCase().endsWith('.pmx')) return new Response(Buffer.from(preparePmxForMmdParser(new Uint8Array(await readFile(file))).bytes), { headers: { ...headers, 'Content-Type': 'application/octet-stream' } });
      const res = await net.fetch(pathToFileURL(file).toString());
      return new Response(res.body, { status: res.status, headers: { ...headers, 'Content-Type': file.endsWith('.png') ? 'image/png' : 'application/octet-stream' } });
    } catch { return new Response('missing', { status: 404 }); }
  });
  const wa = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({ x: wa.x + 10, y: wa.y + 10, width: 1280, height: 720, useContentSize: true, frame: false, resizable: false, skipTaskbar: true, focusable: false, show: false,
    backgroundColor: '#f3ede6', webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true, zoomFactor: 1 } });
  win.webContents.on('console-message', (_e, _level, message) => { if (!/deprecated/.test(message)) log(`page: ${message}`); });
  win.webContents.setZoomFactor(1);
  await win.loadURL('idlep://app/page.html');
  win.showInactive();
  const js = <T>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const end = Date.now() + 20000;
  while (!(await js<boolean>('!!window.__ready'))) { if (Date.now() > end) { log('page did not start'); app.exit(1); return; } await new Promise(r => setTimeout(r, 50)); }
  for (const take of plan.takes) {
    const started = Date.now();
    const { bytes, frames, frameMs } = await js<{ bytes: number; frames: number; frameMs: { p50: number; p95: number; max: number } }>(`window.__record(${JSON.stringify(take.mode)}, ${JSON.stringify(take.groups)}, ${take.seconds}, ${take.activity}, ${take.warmS})`);
    const parts: Buffer[] = [];
    for (let from = 0; from < bytes; from += 1 << 20) parts.push(Buffer.from(await js<string>(`window.__slice(${from}, ${1 << 20})`), 'base64'));
    const file = path.join(plan.out, take.file);
    writeFileSync(file, Buffer.concat(parts));
    log(`${take.file}: ${(bytes / 1e6).toFixed(1)} MB, ${take.groups.join(' / ')}, ${frames} frames, frame time p50 ${frameMs.p50.toFixed(1)} / p95 ${frameMs.p95.toFixed(1)} / max ${frameMs.max.toFixed(1)} ms, done in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    // Played back and checked: a frame from the middle of each part (it decodes; this is what the user will see).
    const partsAt = take.mode === 'side' ? [take.seconds / 2] : take.groups.map((_, i) => (i + 0.5) * take.seconds);
    for (const [i, at] of partsAt.entries()) {
      try {
        const poster = await js<{ png: string; width: number; height: number }>(`window.__poster(${at})`);
        writeFileSync(file.replace(/\.webm$/, `-frame${i + 1}.png`), Buffer.from(poster.png.split(',')[1], 'base64'));
      } catch (error) { log(`playback check failed: ${String(error)}`); }
    }
    // StayStill round: a contact sheet decoded from the webm (side by side: 4 rows of 5 moments, each row with its overlay; one
    // after another: a row per group, 8 moments and the overlay of that group's stretch).
    try {
      const even = (from: number, to: number, n: number) => Array.from({ length: n }, (_, k) => Math.round((from + (to - from) * k / (n - 1)) * 10) / 10);
      const rows = take.mode === 'side'
        ? Array.from({ length: 4 }, (_, r) => { const span = (take.seconds - 2) / 4; return { label: `${(1 + r * span).toFixed(0)}–${(1 + (r + 1) * span).toFixed(0)} s`, times: even(1 + r * span, 1 + (r + 1) * span - 0.5, 5) }; })
        : take.groups.map((g, i) => ({ label: g, times: even(i * take.seconds + 1, (i + 1) * take.seconds - 1, 8) }));
      const sheet = await js<{ png: string }>(`window.__sheet(${JSON.stringify(rows)}, ${take.mode === 'side' ? 0.35 : 0.25}, true)`);
      writeFileSync(file.replace(/\.webm$/, '-sheet.png'), Buffer.from(sheet.png.split(',')[1], 'base64'));
    } catch (error) { log(`contact sheet failed: ${String(error)}`); }
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
