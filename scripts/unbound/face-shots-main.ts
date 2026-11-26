// Development (started by face-shots.mjs under Electron): opens the page in a hidden window, loads each model of the plan, writes the
// sheets (PNG) and a small JSON of what the page reported. A temporary user-data folder; nothing is shown on the screen.
// webSecurity is off only so the hidden page can read the local model files named in the plan.
import { app, BrowserWindow } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface Job { model: string; out: string; shots: unknown[]; cols: number; size: number }
interface Plan { build: string; userData: string; jobs: Job[] }
const plan = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--plan') + 1]!, 'utf8')) as Plan;
app.setPath('userData', plan.userData);
app.setName('face-shots');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => { /* the run decides */ });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  let code = 0;
  try {
    const win = new BrowserWindow({ width: 900, height: 900, show: false, webPreferences: { contextIsolation: true, sandbox: false, webSecurity: false } });
    win.webContents.on('console-message', (_e, _l, message) => console.log(`[page] ${message}`));
    await win.loadFile(path.join(plan.build, 'page.html'));
    const start = Date.now();
    while (Date.now() - start < 20_000 && !await win.webContents.executeJavaScript('window.__ready === true')) await sleep(100);
    for (const job of plan.jobs) {
      mkdirSync(path.dirname(job.out), { recursive: true });
      const info = await win.webContents.executeJavaScript(`window.__load(${JSON.stringify(pathToFileURL(job.model).href)})`) as { reason: string; anchors: unknown };
      console.log(`[faces] ${job.model}: ${info.reason}`);
      const png = await win.webContents.executeJavaScript(`window.__sheet(${JSON.stringify(job.shots)}, ${job.cols}, ${job.size})`) as string;
      writeFileSync(job.out, Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64'));
      console.log(`[faces] wrote ${job.out}`);
    }
  } catch (error) { console.error(String((error as Error)?.stack ?? error)); code = 1; }
  app.exit(code);
});
