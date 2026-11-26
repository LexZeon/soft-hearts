// Hidden-window throttling probe (2026-11-23, docs/claude/2026-11-23-typed-send-deep-fix.md): three windows shown once and then hidden, each
// page keeping its own timers busy (20 ms every 50 ms). A: throttled; B: throttling lifted only while a probe is open (what
// electron/unbound/say-ack.ts keepControlsAwake does for a line from her full-screen box); C: lifted for good. Each probe: a message in, one
// invoke round trip, then a 2 s timer; prints the total ms per probe. Isolated temp profile; no app code, no model.
// Run: node_modules/electron/dist/electron.exe scripts/dev/hidden-window-throttle.cjs   (about 2.5 minutes)
// 2026-11-23 on this machine: A 21680, 15734, 7980, 4312, 20316, 20734 ms; B 2024–2047 ms; C 2002–2034 ms.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path'), os = require('node:os');
app.setPath('userData', path.join(os.tmpdir(), 'sh-toggle-probe-' + process.pid));
const page = `data:text/html,<script>
const { ipcRenderer } = require('electron');
function burn() { const end = performance.now() + 20; while (performance.now() < end) {} setTimeout(burn, 50); }
setTimeout(burn, 50);
ipcRenderer.on('probe', async (_e, seq, sentAt) => {
  const deliveredMs = Date.now() - sentAt;
  const a = performance.now(); await ipcRenderer.invoke('note'); const invokeMs = performance.now() - a;
  const b = performance.now(); await new Promise(r => setTimeout(r, 2000)); const capMs = performance.now() - b;
  ipcRenderer.send('probed', seq, deliveredMs, Math.round(invokeMs), Math.round(capMs), Date.now() - sentAt);
});
</script>`;
const kinds = [{ name: 'A-throttled' }, { name: 'B-lifted-per-line', per: true }, { name: 'C-lifted-for-good', off: true }];
const wins = [], rows = {};
ipcMain.handle('note', () => {});
ipcMain.on('probed', (e, seq, d, i, c, total) => {
  const w = wins.find(x => x.win.webContents.id === e.sender.id);
  if (w.per) w.win.webContents.setBackgroundThrottling(true);
  (rows[w.name] ??= []).push([d, i, c, total]);
});
app.whenReady().then(async () => {
  for (const k of kinds) {
    const win = new BrowserWindow({ width: 300, height: 200, show: true, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: true } });
    await win.loadURL(page); await new Promise(r => setTimeout(r, 500)); win.hide();
    if (k.off) win.webContents.setBackgroundThrottling(false);
    wins.push({ ...k, win });
  }
  await new Promise(r => setTimeout(r, 40000)); // the debt builds up
  let seq = 0;
  for (let round = 0; round < 6; round++) {
    for (const w of wins) { if (w.per) w.win.webContents.setBackgroundThrottling(false); w.win.webContents.send('probe', ++seq, Date.now()); }
    await new Promise(r => setTimeout(r, 8000));
  }
  await new Promise(r => setTimeout(r, 60000));
  for (const [name, list] of Object.entries(rows)) console.log(`${name.padEnd(20)} n=${list.length}/6 total ms: ${list.map(x => x[3]).join(',')} | deliver max=${Math.max(...list.map(x => x[0]))} invoke max=${Math.max(...list.map(x => x[1]))}`);
  app.quit();
});
