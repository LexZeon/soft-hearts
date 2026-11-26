// Motion-model spike preview host (docs/claude/2026-11-14-motion-model-spike.md): one small window with the preview page, a
// temporary user-data folder, nothing of the app (no settings, chat, profile or calls). For each group (rest / procedural /
// matching / model) it sets up a fresh Gene, steps her to the same times and saves this window's own pixels (capturePage).
import { app, BrowserWindow, net, protocol, screen } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { preparePmxForMmdParser } from '../../shared/foundation/pmx-text-encoding';

const plan = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--plan') + 1], 'utf8')) as {
  out: string; build: string; gene: string; data: Record<string, string>; userData: string; groups: string[]; times: number[]; seed: number };
app.setPath('userData', plan.userData);
app.setName('idle-preview');
protocol.registerSchemesAsPrivileged([{ scheme: 'idlep', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const log = (line: string) => console.log(`[idle-preview] ${line}`);

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
        const file = plan.data[rel]; // only the four named files
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
  const win = new BrowserWindow({ x: wa.x + 20, y: wa.y + 20, width: 540, height: 720, useContentSize: true, frame: false, resizable: false, skipTaskbar: true, focusable: false, show: false,
    backgroundColor: '#f3ede6', webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.on('console-message', (_e, _level, message) => { if (!/deprecated/.test(message)) log(`page: ${message}`); });
  await win.loadURL('idlep://app/page.html');
  win.showInactive();
  const js = <T>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const until = async (code: string, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js<boolean>(code)) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
  if (!(await until('!!window.__ready', 20000))) { log('page did not start'); app.exit(1); return; }
  const shots: { group: string; view: string; t: number; file: string }[] = [];
  for (const group of plan.groups) {
    const setup = await js<{ heightM: number }>(`window.__setup(${JSON.stringify(group)}, ${plan.seed})`);
    log(`${group}: Gene ${setup.heightM.toFixed(2)} m`);
    for (const t of plan.times) for (const view of ['body', 'bust'] as const) {
      await js(`window.__advance(${t}, ${JSON.stringify(view)})`);
      await new Promise(r => setTimeout(r, 120));
      const image = await win.webContents.capturePage();
      const file = path.join(plan.out, `${group}-${view}-t${String(t).padStart(2, '0')}.png`);
      writeFileSync(file, image.resize({ width: 540 }).toPNG());
      shots.push({ group, view, t, file: path.basename(file) });
    }
    // The whole run's head and hip paths over the last full-body frame.
    await js(`window.__advance(${plan.times.at(-1)}, 'body'); window.__drawTrace(true, ${JSON.stringify(group)})`);
    await new Promise(r => setTimeout(r, 120));
    const traced = path.join(plan.out, `${group}-trace.png`);
    writeFileSync(traced, (await win.webContents.capturePage()).resize({ width: 540 }).toPNG());
    await js('window.__drawTrace(false, "")');
    shots.push({ group, view: 'trace', t: plan.times.at(-1)!, file: path.basename(traced) });
  }
  writeFileSync(path.join(plan.out, 'shots.json'), JSON.stringify(shots, null, 1));
  // A contact sheet (plain HTML next to the PNGs): one row per group, the same times in the same columns.
  const rows = ['body', 'bust'].map(view => `<h2>${view}</h2><table><tr><th></th>${plan.times.map(t => `<th>t=${t}s</th>`).join('')}</tr>`
    + plan.groups.map(g => `<tr><th>${g}</th>${plan.times.map(t => `<td><img src="${g}-${view}-t${String(t).padStart(2, '0')}.png" width="180"></td>`).join('')}</tr>`).join('') + '</table>').join('')
    + `<h2>trace</h2>${plan.groups.map(g => `<img src="${g}-trace.png" width="270">`).join('')}`;
  writeFileSync(path.join(plan.out, 'sheet.html'), `<!doctype html><meta charset="utf-8"><title>idle groups</title><style>body{font:13px sans-serif;background:#fff}td,th{padding:2px}</style>${rows}`);
  log(`${shots.length} screenshots → ${plan.out}`);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
