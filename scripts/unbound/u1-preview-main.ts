// Unbound U1 preview (docs/claude/2026-11-12-unbound-u1-part1.md): the real Unbound host, window, preload and page with the
// bundled Gene, in a small window ('fit': the whole screen's view scaled into 960x600), in a temporary user-data folder.
// A small stand-in companion window shows that entering hides it and leaving brings it back where it was. Measures the click-through
// switch latency (an injected mouse move inside the window → the host has switched; the OS cursor is never moved), takes window
// screenshots (this window's own pixels only), and ends by itself. Not the app: no settings, chat, profile or model calls.
import { app, BrowserWindow, ipcMain, net, protocol, screen } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AssetRegistry } from '../../electron/foundation/assets';
import { createAssetProtocolHandler } from '../../electron/foundation/asset-protocol';
import { UnboundHost, type UnboundIpcMain } from '../../electron/unbound/host';
import { asUnboundWindow, primaryDisplayFacts } from '../../electron/unbound/electron-host';
import { createUnboundWindow, loadUnboundPage } from '../../electron/unbound/window';
import { readMonitorSizes } from '../../electron/unbound/display-size';
import { WindowsFullscreenProbe, type FullscreenReading } from '../../electron/unbound/fullscreen-watch';
import type { UnboundControlView } from '../../shared/unbound/scene';

const plan = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--plan') + 1], 'utf8')) as { out: string; build: string; gene: string; stand: string; userData: string; full?: boolean; withPhysics?: boolean };
app.setPath('userData', plan.userData);
app.setName('unbound-u1-preview');
protocol.registerSchemesAsPrivileged([{ scheme: 'mmd-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const results: Record<string, unknown> = {};
const log = (line: string) => console.log(`[u1] ${line}`);

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
  // The stand-in companion: a small plain window where the companion would be.
  const pet = new BrowserWindow({ x: wa.x + wa.width - 260, y: wa.y + wa.height - 300, width: 200, height: 260, frame: false, skipTaskbar: true, focusable: false, show: false, backgroundColor: '#ffd6e6' });
  await pet.loadURL('data:text/html,<body style="margin:0;font:16px sans-serif;display:grid;place-items:center;height:100vh">pet</body>');
  pet.showInactive();
  const petBefore = pet.getBounds();
  const views: UnboundControlView[] = [];
  let restored = 0, unboundWindow: BrowserWindow | null = null;
  const ignoreLog: { at: number; ignore: boolean }[] = [];
  const preview = { x: wa.x + 40, y: wa.y + 40, width: 960, height: 600 };
  let fullscreenFirst: FullscreenReading | null = null;
  const probe = new WindowsFullscreenProbe();
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
    fullscreen: { start: send => probe.start(value => { fullscreenFirst ??= value; send(value); }), stop: () => probe.stop() },
    restored: () => { restored++; }, publish: view => { views.push(view); }, ...(plan.full ? {} : { preview: { bounds: preview } }),
  });
  const until = async (test: () => boolean, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await sleep(20); } return test(); };
  const shot = async (name: string) => {
    if (!unboundWindow || unboundWindow.isDestroyed()) return;
    const image = await unboundWindow.webContents.capturePage();
    writeFileSync(path.join(plan.out, `${name}.png`), image.toPNG());
  };
  const page = <T>(expression: string) => unboundWindow!.webContents.executeJavaScript(expression) as Promise<T>;
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
    // ---- enter -------------------------------------------------------------------------------------------------------------
    const started = performance.now();
    host.apply({ active: true, debug: true });
    const entered = await until(() => host.state === 'unbound', 40_000);
    results.enter = { ok: entered, ms: Math.round(performance.now() - started), error: host.view().error, petHidden: !pet.isVisible(), view: host.view() };
    log(`entered ${entered} in ${Math.round(performance.now() - started)} ms; pet hidden ${!pet.isVisible()}`);
    if (!entered) throw new Error(`did not enter: ${host.view().error}`);
    await sleep(2_000); // fade in, textures
    results.window = { bounds: unboundWindow!.getBounds(), page: await page('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })'), full: !!plan.full, physics: !!plan.withPhysics };
    await frames.start(); frames.watch(); await sleep(1_000);
    await shot('1-home-8m');
    results.home = await page('window.__unboundProbe.stats()');
    // ---- click-through switch latency ----------------------------------------------------------------------------------------
    const body = await page<{ x: number; y: number }>('window.__unboundProbe.body()');
    const latencies: { on: number[]; off: number[] } = { on: [], off: [] };
    const contents = unboundWindow!.webContents;
    for (let i = 0; i < 20; i++) {
      for (const [x, y, want] of [[body.x, body.y, false], [12, 12, true]] as const) {
        const before = ignoreLog.length, t0 = performance.now();
        contents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
        const ok = await until(() => ignoreLog.slice(before).some(entry => entry.ignore === want), 1_000);
        const hit = ignoreLog.slice(before).find(entry => entry.ignore === want);
        if (ok && hit) (want ? latencies.off : latencies.on).push(hit.at - t0);
        await sleep(60);
      }
    }
    // A click on her lands on her (the window takes it while the cursor is on her).
    contents.sendInputEvent({ type: 'mouseMove', x: Math.round(body.x), y: Math.round(body.y) }); await sleep(100);
    contents.sendInputEvent({ type: 'mouseDown', x: Math.round(body.x), y: Math.round(body.y), button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x: Math.round(body.x), y: Math.round(body.y), button: 'left', clickCount: 1 }); await sleep(150);
    const summary = (values: number[]) => { const s = [...values].sort((a, b) => a - b); const at = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; return s.length ? { n: s.length, p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) } : null; };
    results.toggle = { onHer: summary(latencies.on), offHer: summary(latencies.off), page: await page('window.__unboundProbe.stats()') };
    log(`toggle latency on ${JSON.stringify(summary(latencies.on))} off ${JSON.stringify(summary(latencies.off))}`);
    contents.sendInputEvent({ type: 'mouseMove', x: 12, y: 12 }); await sleep(100);
    // ---- nearer and farther: part 2 walks there (docs/claude/2026-11-12-unbound-u1-part2.md) -----------------------------------
    // Each walk: the body meter restarted, the request, a few screenshots on the way, then the page's own numbers (planted-foot
    // drift, largest per-frame move and jolt of her place, standing COM margin, steps, fps) once she has stopped.
    const walk = async (name: string, depthM: number, shots: number[]) => {
      await page('window.__unboundProbe.resetMeter()');
      const t0 = Date.now(), fpsSeen: number[] = [], f0 = await frames.mark();
      host.apply({ depthM });
      for (const [i, at] of shots.entries()) { await sleep(Math.max(0, at - (Date.now() - t0))); await shot(`${name}-${i + 1}`); }
      await sleep(1_500);
      let stats = await page<{ moving: boolean; fps: number | null }>('window.__unboundProbe.stats()');
      while (stats.moving && Date.now() - t0 < 30_000) { if (stats.fps) fpsSeen.push(stats.fps); await sleep(500); stats = await page('window.__unboundProbe.stats()'); }
      await sleep(1_000);
      const end = await page<Record<string, unknown>>('window.__unboundProbe.stats()');
      const result = { ms: Date.now() - t0, frameMs: await frames.since(f0), fpsWhileWalking: fpsSeen.length ? { min: Math.min(...fpsSeen), mean: fpsSeen.reduce((a, b) => a + b, 0) / fpsSeen.length } : null, end };
      log(`${name}: ${JSON.stringify({ ms: result.ms, fps: result.fpsWhileWalking, steps: end.steps, meter: end.meter, placement: end.placement })}`);
      return result;
    };
    host.apply({ walkSpeedMps: 0.7, stepLengthM: 0.3 });
    results.walkNear = await walk('2-walk-to-2.5m', 2.5, [1_200, 3_000, 6_000]);
    await shot('3-near-2.5m');
    results.walkAway = await walk('4-walk-away-to-12m', 12, [800, 2_500, 6_000, 12_000]);
    await shot('5-far-12m');
    results.walkBack = await walk('6-walk-back-to-8m', 8, [2_000]);
    // ---- one foot ---------------------------------------------------------------------------------------------------------------
    await page('window.__unboundProbe.resetMeter()');
    const ff0 = await frames.mark();
    host.apply({ stance: 'left' });
    await sleep(3_000); await shot('7-one-foot');
    results.oneFoot = await page('window.__unboundProbe.stats()'); results.oneFootFrameMs = await frames.since(ff0);
    host.apply({ stance: 'both' });
    await sleep(2_000);
    results.backOnBothFeet = await page('window.__unboundProbe.stats()');
    log(`one foot: ${JSON.stringify({ holding: (results.oneFoot as { stance: string }).stance, comMargin: (results.oneFoot as { comMargin: number }).comMargin, meter: (results.backOnBothFeet as { meter: unknown }).meter })}`);
    // ---- her reply as a bubble ----------------------------------------------------------------------------------------------
    host.stream({ id: 'preview', kind: 'chat', type: 'delta', text: '我在这儿呢。' });
    host.stream({ id: 'preview', kind: 'chat', type: 'delta', text: '看得到我吗？' });
    await sleep(500); await shot('8-bubble');
    host.stream({ id: 'preview', kind: 'chat', type: 'done', text: '' });
    host.apply({ debug: false });
    await sleep(400); await shot('9-plain');
    results.fullscreenFirstReading = fullscreenFirst;
    try { results.eyeInHead = summarizeEyes(await frames.eyeLog()); } catch { /* page gone */ }
    // ---- leave: the companion comes back where she was ------------------------------------------------------------------------------
    host.apply({ active: false });
    await sleep(300);
    results.exit = { state: host.state, petVisible: pet.isVisible(), petBoundsSame: JSON.stringify(pet.getBounds()) === JSON.stringify(petBefore), windowGone: !!unboundWindow?.isDestroyed(), restoredCalls: restored };
    log(`exit ${JSON.stringify(results.exit)}`);
    // ---- enter again, then quit while in Unbound ------------------------------------------------------------------------------
    host.apply({ active: true });
    const again = await until(() => host.state === 'unbound', 40_000);
    host.quit();
    results.quit = { enteredAgain: again, state: host.state, petVisible: pet.isVisible(), restoredCalls: restored, windowGone: !!unboundWindow?.isDestroyed() };
    log(`quit ${JSON.stringify(results.quit)}`);
  } catch (error) {
    results.error = String((error as Error)?.stack ?? error);
    log(`error ${results.error}`);
  } finally {
    results.views = views.slice(-3);
    writeFileSync(path.join(plan.out, 'results.json'), JSON.stringify(results, null, 2));
    probe.stop();
    app.exit(results.error ? 1 : 0);
  }
});
