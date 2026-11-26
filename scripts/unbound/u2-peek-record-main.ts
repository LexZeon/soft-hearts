// Unbound U2 peek, recorded on the real desktop (evening: "录，而且要录完整的我电脑屏幕。显示我的桌面，不要窗口，要下面的任务栏。（展示在我电脑上运行）").
// The real Unbound host, window, preload, page and director with the bundled Gene, full screen (work area, transparent, click-through,
// as the product), hair/chest physics on, a temporary user-data folder. Two peeks: one she ends by herself, one a mouse move (injected
// into her page only; the OS cursor is never moved) sends back. The whole primary screen (desktop and taskbar) is recorded with
// Electron's own screen capture into one webm file in --out. Not the app: no settings, chat, profile or calls.
import { app, BrowserWindow, desktopCapturer, ipcMain, net, protocol, session } from 'electron';
import { mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
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
app.setName('unbound-u2-record');
protocol.registerSchemesAsPrivileged([{ scheme: 'mmd-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const log = (line: string) => console.log(`[record] ${line}`);
const CURIOUS: MoodReading = { D: 75, O: 62, E: 55, N: 50, C: 45, A: 0.2, B: 40, M: 10 };
let videoFile = path.join(plan.out, 'peek-desktop.webm');

// A hidden page records the primary screen (getDisplayMedia, answered below with the whole screen) and hands the webm over in pieces.
// A file page, not data:, so the page is a secure context and navigator.mediaDevices exists.
const RECORDER_HTML = '<!doctype html><meta charset="utf-8"><title>recorder</title><body>recorder</body>';
const START = `(async () => {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
  const track = stream.getVideoTracks()[0];
  try { await track.applyConstraints({ width: 1920, height: 1140, frameRate: 30 }); } catch (e) {}
  window.__queue = []; window.__size = track.getSettings();
  // MP4 (H.264) first: the user wants to post it ("如果能给我MP4的录屏会很好。我要运营账户。"); webm only if MP4 is not available.
  const type = ['video/mp4;codecs=avc1.640032', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  window.__type = type;
  const rec = window.__rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 10000000 });
  rec.ondataavailable = async e => { if (e.data.size) window.__queue.push(new Uint8Array(await e.data.arrayBuffer())); };
  rec.onstop = () => { window.__stopped = true; stream.getTracks().forEach(t => t.stop()); };
  rec.start(1000);
  return { size: window.__size, type: window.__type };
})()`;
const DRAIN = `(() => { const q = window.__queue || []; window.__queue = []; let n = 0; for (const c of q) n += c.length; const all = new Uint8Array(n); let o = 0; for (const c of q) { all.set(c, o); o += c.length; }
  let s = ''; for (let i = 0; i < all.length; i += 0x8000) s += String.fromCharCode.apply(null, all.subarray(i, i + 0x8000)); return btoa(s); })()`;

app.whenReady().then(async () => {
  mkdirSync(plan.out, { recursive: true });

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    void desktopCapturer.getSources({ types: ['screen'] }).then(sources => callback({ video: sources[0]! }));
  });
  const assets = new AssetRegistry();
  const model = await assets.register(plan.gene), stand = await assets.register(plan.stand);
  protocol.handle('mmd-asset', createAssetProtocolHandler({ resolve: url => assets.resolve(url), fetchFile: url => net.fetch(url) }));
  // The host wants a companion window to hide while she is out; a hidden stand-in that never shows.
  const pet = new BrowserWindow({ width: 200, height: 260, frame: false, skipTaskbar: true, focusable: false, show: false });
  await pet.loadURL('data:text/html,<body></body>');
  const recorder = new BrowserWindow({ width: 320, height: 200, show: false, skipTaskbar: true, webPreferences: { backgroundThrottling: false } });
  const recorderFile = path.join(plan.build, 'recorder.html');
  writeFileSync(recorderFile, RECORDER_HTML);
  await recorder.loadFile(recorderFile);
  let unboundWindow: BrowserWindow | null = null;
  let idle = 0;
  const host = new UnboundHost({
    ipcMain: ipcMain as unknown as UnboundIpcMain,
    pet: () => pet, petWanted: () => false, developerMode: () => true,
    source: () => ({ modelUrl: model.url, motion: { pose: stand.url, gesture: null, expression: null, legacy: false }, breath: 0.5, physics: { hair: { enabled: true, strength: 0.65 }, chest: { enabled: true, strength: 0.35 }, quality: 'standard' } }),
    reviewed: async () => true, display: primaryDisplayFacts, measure: () => readMonitorSizes(),
    openWindow: bounds => {
      const win = unboundWindow = createUnboundWindow(bounds, { electronDir: plan.build, distDir: plan.build });
      return { window: asUnboundWindow(win), loaded: loadUnboundPage(win, { electronDir: plan.build, distDir: plan.build }) };
    },
    restored: () => {}, publish: () => {},
    peek: {
      clock: () => Date.now(), random: () => Math.random(), idleSeconds: () => idle, idleNow: () => idle,
      asleep: () => false, inCall: () => false, userTalking: () => false, mood: () => CURIOUS, lastInteractionAt: () => null, answered: () => true,
      every: (ms, run) => { const t = setInterval(run, ms); return () => clearInterval(t); },
    },
  });
  const until = async (test: () => Promise<boolean> | boolean, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await sleep(50); } return test(); };
  const page = <T>(expression: string) => unboundWindow!.webContents.executeJavaScript(expression) as Promise<T>;
  const phase = async () => (await page<{ phase: string | null; active: boolean }>('window.__unboundProbe.peek()'));
  let bytes = 0, draining = false;
  const drain = async () => { if (draining) return; draining = true; try { const b64 = await recorder.webContents.executeJavaScript(DRAIN) as string; if (b64) { const buf = Buffer.from(b64, 'base64'); appendFileSync(videoFile, buf); bytes += buf.length; } } finally { draining = false; } };
  const pump = setInterval(() => { void drain(); }, 2000);
  const beats: { at: number; what: string }[] = [];
  let t0 = 0;
  const beat = (what: string) => { beats.push({ at: +((Date.now() - t0) / 1000).toFixed(1), what }); log(what); };
  let error: string | null = null;
  try {
    const started = await recorder.webContents.executeJavaScript(START, true) as { size: unknown; type: string };
    if (started.type.startsWith('video/mp4')) videoFile = path.join(plan.out, 'peek-desktop.mp4');
    writeFileSync(videoFile, Buffer.alloc(0));
    const size = started;
    t0 = Date.now();
    log(`recording ${JSON.stringify(size)}`);
    await sleep(2_000); beat('desktop before');
    host.apply({ active: true });
    if (!await until(() => host.state === 'unbound', 40_000)) throw new Error(`did not enter: ${host.view().error}`);
    beat('she is home');
    await sleep(5_000);
    // 1. She notices you, comes up, leans in until one eye fills the screen, holds, and goes back by herself.
    host.apply({ peekNow: true }); beat('peek 1: notices you');
    await until(async () => (await phase()).phase === 'hold', 40_000); beat('peek 1: closest (one eye fills the screen)');
    await until(async () => (await phase()).phase === 'back', 20_000); beat('peek 1: backs off by herself');
    await until(async () => !(await phase()).active, 40_000); beat('peek 1: home again');
    await sleep(5_000);
    // 2. Again; this time the mouse moves while she is closest and she backs off at once.
    host.apply({ peekNow: true }); beat('peek 2: notices you');
    await until(async () => (await phase()).phase === 'hold', 40_000); await sleep(1_500); beat('peek 2: closest');
    const contents = unboundWindow!.webContents;
    contents.sendInputEvent({ type: 'mouseMove', x: 300, y: 200 }); contents.sendInputEvent({ type: 'mouseMove', x: 340, y: 230 });
    beat('peek 2: mouse moves');
    await until(async () => (await phase()).phase === 'back', 3_000); beat('peek 2: backs off at once');
    await until(async () => !(await phase()).active, 40_000); beat('peek 2: home again');
    await sleep(4_000);
  } catch (failure) {
    error = String((failure as Error)?.stack ?? failure);
    log(`error ${error}`);
  } finally {
    try {
      await recorder.webContents.executeJavaScript('window.__rec && window.__rec.state !== "inactive" && window.__rec.stop(); 0');
      await until(async () => await recorder.webContents.executeJavaScript('!!window.__stopped') as boolean, 5_000);
      await sleep(500); clearInterval(pump); await drain();
    } catch { clearInterval(pump); }
    writeFileSync(path.join(plan.out, 'beats.json'), JSON.stringify({ beats, bytes, error }, null, 2));
    log(`saved ${videoFile} (${(bytes / 1048576).toFixed(1)} MB)`);
    host.quit();
    app.exit(error ? 1 : 0);
  }
});
