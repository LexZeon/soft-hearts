// Unbound U2 peek preview (docs/claude/2026-11-12-unbound-peek.md): the real Unbound host, window, preload, page and director with
// the bundled Gene, in a small window ('fit': the whole screen's view scaled into 960x600), in a temporary user-data folder.
// The idle time is a number this script sets (the real keyboard and mouse are never read); mouse moves are injected into the page
// only (the OS cursor is never moved). Screenshots are this window's own pixels. Not the app: no settings, chat, profile or calls.
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

const plan = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--plan') + 1], 'utf8')) as { out: string; build: string; gene: string; stand: string; userData: string; full?: boolean; withPhysics?: boolean };
app.setPath('userData', plan.userData);
app.setName('unbound-u2-preview');
protocol.registerSchemesAsPrivileged([{ scheme: 'mmd-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const results: Record<string, unknown> = {};
const log = (line: string) => console.log(`[u2] ${line}`);
const CURIOUS: MoodReading = { D: 75, O: 62, E: 55, N: 50, C: 45, A: 0.2, B: 40, M: 10 };

interface PeekProbe { active: boolean; phase: string | null; cancelled: string | null; nearM: number; softPx: number; eyeDistanceM: number | null; eyeOffM: number | null;
  firstMotionMs: number | null; holds: number[]; phases: { phase: string | null; at: number }[]; closeFrameMs: { n: number; p50: number; p95: number; max: number } | null; forcing: boolean }

// Eye-in-head summary: max and p95 of |yaw| and |pitch|, and each stretch where an eye passes 15 deg yaw or 10 deg pitch (what she was doing, where, heading).
function summarizeEyes(log: any[]) {
  const abs = (key: string) => log.flatMap(r => [Math.abs(r['l' + key]), Math.abs(r['r' + key])]).filter(Number.isFinite).sort((a, b) => a - b);
  const stat = (v: number[]) => v.length ? { max: +v[v.length - 1].toFixed(1), p95: +v[Math.floor(v.length * 0.95)].toFixed(1), p50: +v[Math.floor(v.length * 0.5)].toFixed(1) } : null;
  const over = (r: any) => Math.max(Math.abs(r.ly), Math.abs(r.ry)) > 15 || Math.max(Math.abs(r.lp), Math.abs(r.rp)) > 10;
  const doing = (r: any) => r.active ? 'peek:' + r.phase : r.walking ? 'walking' : r.moving ? 'moving' : 'standing';
  const spans: any[] = []; let cur: any = null;
  for (const r of log) {
    if (over(r)) {
      const what = doing(r);
      if (!cur || cur.what !== what) { cur = { what, fromS: +(r.t / 1000).toFixed(2), toS: 0, maxYaw: 0, maxPitch: 0, frames: 0, headingDeg: +r.heading.toFixed(0), x: +r.x.toFixed(2), d: +r.d.toFixed(2) }; spans.push(cur); }
      cur.toS = +(r.t / 1000).toFixed(2); cur.frames++; cur.maxYaw = Math.max(cur.maxYaw, Math.abs(r.ly), Math.abs(r.ry)); cur.maxPitch = Math.max(cur.maxPitch, Math.abs(r.lp), Math.abs(r.rp));
    } else cur = null;
  }
  const byWhat: Record<string, number> = {};
  for (const r of log) { const w = doing(r); byWhat[w] = +Math.max(byWhat[w] ?? 0, Math.abs(r.ly), Math.abs(r.ry)).toFixed(1); }
  return { frames: log.length, yawDeg: stat(abs('y')), pitchDeg: stat(abs('p')), overFrames: log.filter(over).length, maxYawByActivity: byWhat, spans: spans.map(s => ({ ...s, maxYaw: +s.maxYaw.toFixed(1), maxPitch: +s.maxPitch.toFixed(1) })) };
}

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
  const ignoreLog: { at: number; ignore: boolean }[] = [];
  const preview = { x: wa.x + 40, y: wa.y + 40, width: 960, height: 600 };
  let idle = 0;
  const host = new UnboundHost({
    ipcMain: ipcMain as unknown as UnboundIpcMain,
    pet: () => pet, petWanted: () => true, developerMode: () => true,
    source: () => ({ modelUrl: model.url, motion: { pose: stand.url, gesture: null, expression: null, legacy: false }, breath: 0.5, physics: plan.withPhysics ? { hair: { enabled: true, strength: 0.65 }, chest: { enabled: true, strength: 0.35 }, quality: 'standard' } : null }),
    reviewed: async () => true, display: primaryDisplayFacts, measure: () => readMonitorSizes(),
    openWindow: bounds => {
      const win = unboundWindow = createUnboundWindow(bounds, { electronDir: plan.build, distDir: plan.build });
      const original = win.setIgnoreMouseEvents.bind(win);
      win.setIgnoreMouseEvents = ((ignore: boolean, options?: { forward: boolean }) => { ignoreLog.push({ at: performance.now(), ignore }); original(ignore, options); }) as typeof win.setIgnoreMouseEvents;
      win.webContents.on('console-message', (_event, _level, message) => { if (!/deprecated/.test(message)) log(`page: ${message}`); });
      return { window: asUnboundWindow(win), loaded: loadUnboundPage(win, { electronDir: plan.build, distDir: plan.build }) };
    },
    restored: () => {}, publish: () => {}, ...(plan.full ? {} : { preview: { bounds: preview } }),
    peek: {
      clock: () => Date.now(), random: () => Math.random(), idleSeconds: () => idle, idleNow: () => idle,
      asleep: () => false, inCall: () => false, userTalking: () => false, mood: () => CURIOUS, lastInteractionAt: () => null, answered: () => true,
      every: (ms, run) => { const t = setInterval(run, ms); return () => clearInterval(t); },
    },
  });
  const until = async (test: () => Promise<boolean> | boolean, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await sleep(25); } return test(); };
  const shot = async (name: string) => {
    if (!unboundWindow || unboundWindow.isDestroyed()) return;
    const image = await unboundWindow.webContents.capturePage();
    writeFileSync(path.join(plan.out, `${name}.png`), image.toPNG());
  };
  const page = <T>(expression: string) => unboundWindow!.webContents.executeJavaScript(expression) as Promise<T>;
  const peek = () => page<PeekProbe>('window.__unboundProbe.peek()');
  const phaseIs = (phase: string) => async () => (await peek()).phase === phase;
  // Frame times from the page's own requestAnimationFrame (a sampler this script injects; nothing in the product changes).
  const frames = {
    start: () => page('window.__ft = []; window.__eyeLog = []; (function tick(t) { window.__ft.push(t); const e = window.__unboundProbe.eyes(); if (e) window.__eyeLog.push({ t, ly: e.eyes[0] && e.eyes[0].yaw, lp: e.eyes[0] && e.eyes[0].pitch, ry: e.eyes[1] && e.eyes[1].yaw, rp: e.eyes[1] && e.eyes[1].pitch, heading: e.heading, walking: e.walking, moving: e.moving, phase: e.phase, active: e.active, x: e.placement.xM, d: e.placement.depthM }); requestAnimationFrame(tick); })(performance.now()); 0'),
    eyeLog: () => page<Record<string, unknown>[]>('window.__eyeLog'),
    // Screenshots (this window's own pixels) of the first few moments an eye passes 15 deg yaw or 10 deg pitch, one per activity.
    watch: () => { const seen = new Set<string>(); setInterval(async () => { try { const e = await page<any>('(() => { const l = window.__eyeLog; const r = l[l.length - 1]; return r || null; })()'); if (!e) return; const hot = Math.max(Math.abs(e.ly), Math.abs(e.ry)) > 15 || Math.max(Math.abs(e.lp), Math.abs(e.rp)) > 10; const what = (e.active ? 'peek-' + e.phase : e.walking ? 'walking' : 'standing') + (Math.max(Math.abs(e.ly), Math.abs(e.ry)) > 30 ? '-yaw30' : ''); if (hot && !seen.has(what) && seen.size < 8) { seen.add(what); await shot('eye-over-' + what); } } catch { /* page gone */ } }, 80); },
    mark: () => page<number>('window.__ft.length'),
    since: async (from: number) => {
      const all = await page<number[]>('window.__ft.slice(' + from + ')');
      const dt = all.slice(1).map((t, i) => t - all[i]).sort((a, b) => a - b);
      const q = (p: number) => +dt[Math.min(dt.length - 1, Math.floor(p * dt.length))].toFixed(2);
      return dt.length ? { n: dt.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +dt[dt.length - 1].toFixed(2), over25ms: dt.filter(x => x > 25).length, over100ms: dt.filter(x => x > 100).length } : null;
    },
  };
  try {
    host.apply({ active: true });
    const entered = await until(() => host.state === 'unbound', 40_000);
    if (!entered) throw new Error(`did not enter: ${host.view().error}`);
    await sleep(2_500);
    await shot('0-home-8m');
    results.window = { bounds: unboundWindow!.getBounds(), page: await page('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })'), full: !!plan.full, physics: !!plan.withPhysics };
    await frames.start(); frames.watch(); await sleep(500);
    const wholeFrom = await frames.mark(); let leanFrom = 0;
    const contents = unboundWindow!.webContents;

    // ---- 1. a whole peek (trial), screenshots at each beat ---------------------------------------------------------------------
    host.apply({ peekNow: true });
    const t0 = Date.now();
    await sleep(600); await shot('1-notice');
    results.clickThroughAtStart = { lastIgnore: ignoreLog.at(-1)?.ignore ?? null, forcing: host.peek?.forcing ?? null };
    await until(phaseIs('walk'), 5_000); await sleep(4_000); await shot('2-walking-up');
    await until(phaseIs('lean'), 30_000); leanFrom = await frames.mark(); await sleep(700); await shot('3-leaning-in');
    await page('window.__unboundProbe.resetPeekFrames()');
    await until(phaseIs('hold'), 10_000); await sleep(1_000); await shot('4-close-up');
    const eyeSamples: { off: number; dist: number; near: number }[] = [];
    for (let i = 0; i < 12; i++) { const p = await peek(); if (p.eyeOffM !== null && p.eyeDistanceM !== null) eyeSamples.push({ off: p.eyeOffM, dist: p.eyeDistanceM, near: p.nearM }); await sleep(120); }
    const close = await peek();
    results.holdEye = { samples: eyeSamples.length, offMm_p50: eyeSamples.length ? +(eyeSamples.map(e => e.off * 1000).sort((a, b) => a - b)[Math.floor(eyeSamples.length / 2)]).toFixed(2) : null, offMm_max: eyeSamples.length ? +Math.max(...eyeSamples.map(e => e.off * 1000)).toFixed(2) : null, distCm: eyeSamples.length ? +(eyeSamples[0].dist * 100).toFixed(2) : null, nearMm: eyeSamples.length ? +(eyeSamples[0].near * 1000).toFixed(2) : null };
    // The page cannot take the mouse now, even on her.
    const interactiveDuringHold = ignoreLog.at(-1)?.ignore;
    await until(phaseIs('back'), 10_000); await sleep(350); await shot('5-backing-off');
    await until(phaseIs('settle'), 5_000); await sleep(1_500); await shot('6-going-home');
    await until(async () => !(await peek()).active, 40_000);
    const whole = await peek();
    results.wholeFrameMs = await frames.since(wholeFrom); results.leanToEndFrameMs = await frames.since(leanFrom);
    results.whole = { ms: Date.now() - t0, closeUp: close, end: whole, clickThroughDuringHold: interactiveDuringHold };
    log(`whole: ${JSON.stringify({ ms: Date.now() - t0, firstMotionMs: whole.firstMotionMs, holds: whole.holds, closeFrameMs: close.closeFrameMs, eye: { d: close.eyeDistanceM, off: close.eyeOffM }, near: close.nearM, softPx: close.softPx, phases: whole.phases })}`);

    // ---- 2. lens softness at three settings, same close-up ----------------------------------------------------------------------
    // ---- and 3. a mouse move cancels it (page) ---------------------------------------------------------------------------------
    host.apply({ depthM: 1.5 }); await until(async () => !(await page<{ moving: boolean }>('window.__unboundProbe.stats()')).moving, 30_000); await sleep(800);
    const softness: Record<string, unknown> = {};
    for (const value of [0, 0.35, 1]) {
      host.apply({ peekSoftness: value, peekNow: true });
      await until(phaseIs('hold'), 30_000); await sleep(900);
      await shot(`7-close-up-softness-${value}`);
      softness[String(value)] = (await peek()).softPx;
      if (value === 1) {
        // The mouse moves (injected into the page): she backs off at once.
        const before = Date.now();
        contents.sendInputEvent({ type: 'mouseMove', x: 300, y: 200 }); contents.sendInputEvent({ type: 'mouseMove', x: 320, y: 210 });
        const cancelled = await until(async () => (await peek()).phase === 'back', 2_000);
        const after = await peek();
        results.mouseCancel = { cancelled, ms: Date.now() - before, phase: after.phase, reason: after.cancelled };
        await sleep(300); await shot('8-mouse-moved-backing-off');
        log(`mouse cancel: ${JSON.stringify(results.mouseCancel)}`);
      } else {
        await until(phaseIs('back'), 10_000);
      }
      await until(async () => !(await peek()).active, 40_000);
    }
    results.softnessPx = softness;
    log(`softness px: ${JSON.stringify(softness)}`);

    // ---- 4. a key press (the host's idle reading drops) cancels it --------------------------------------------------------------
    idle = 30;
    host.apply({ peekNow: true });
    await until(phaseIs('lean'), 30_000);
    for (let i = 0; i < 5; i++) { idle += 0.2; await sleep(200); }
    const before = Date.now();
    idle = 0; // any key or mouse input: seconds since input back to 0
    const cancelled = await until(async () => (await peek()).phase === 'back', 2_000);
    const after = await peek();
    results.keyCancel = { cancelled, ms: Date.now() - before, phase: after.phase, reason: after.cancelled };
    log(`key cancel: ${JSON.stringify(results.keyCancel)}`);
    await until(async () => !(await peek()).active, 40_000);

    // ---- 5. automatic: idle long enough, she comes by herself ------------------------------------------------------------------
    host.apply({ peekIdleSeconds: 20 });
    idle = 25;
    const auto = await until(async () => (await peek()).active, 70_000);
    results.automatic = { started: auto, view: host.view().peek };
    log(`automatic: ${JSON.stringify(results.automatic)}`);
    await until(async () => !(await peek()).active, 60_000);
    results.afterAutomatic = host.view().peek;
  } catch (error) {
    results.error = String((error as Error)?.stack ?? error);
    log(`error ${results.error}`);
  } finally {
    try { results.eyeInHead = summarizeEyes(await frames.eyeLog()); } catch { /* page gone */ }
    writeFileSync(path.join(plan.out, 'results.json'), JSON.stringify(results, null, 2));
    host.quit();
    app.exit(results.error ? 1 : 0);
  }
});
