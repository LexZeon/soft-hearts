// Unbound U4 preview (docs/claude/2026-11-14-unbound-night-e4-surfaces.md): Electron main. One small window (960x540) showing the
// preview page with the bundled Gene and SYNTHETIC windows; screenshots are this window's own pixels (capturePage). No real window,
// desktop, screen, camera or microphone is read; no profile, settings or model calls. The OS cursor is never touched.
import { app, BrowserWindow, net, protocol, screen } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AssetRegistry } from '../../electron/foundation/assets';
import { createAssetProtocolHandler } from '../../electron/foundation/asset-protocol';

const plan = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--plan') + 1], 'utf8')) as { out: string; build: string; gene: string; stand: string; userData: string };
app.setPath('userData', plan.userData);
app.setName('unbound-u4-preview');
protocol.registerSchemesAsPrivileged([{ scheme: 'mmd-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const results: Record<string, unknown> = {};
const log = (line: string) => console.log(`[u4] ${line}`);
const round = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_k, v) => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v));

app.whenReady().then(async () => {
  mkdirSync(plan.out, { recursive: true });
  const assets = new AssetRegistry();
  const model = await assets.register(plan.gene), stand = await assets.register(plan.stand);
  protocol.handle('mmd-asset', createAssetProtocolHandler({ resolve: url => assets.resolve(url), fetchFile: url => net.fetch(url) }));
  const wa = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({ x: wa.x + 40, y: wa.y + 40, width: 960, height: 540, useContentSize: true, frame: false, skipTaskbar: true, focusable: false, show: false, resizable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.on('console-message', (_event, _level, message) => { if (!/deprecated/.test(message)) log(`page: ${message}`); });
  await win.loadFile(path.join(plan.build, 'u4-surfaces.html'));
  win.showInactive();
  const page = <T>(expression: string) => win.webContents.executeJavaScript(expression) as Promise<T>;
  const shot = async (name: string) => { const image = await win.webContents.capturePage(); writeFileSync(path.join(plan.out, `${name}.png`), image.toPNG()); log(`shot ${name}`); };
  const until = async (test: () => Promise<boolean>, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await sleep(40); } return test(); };
  const still = async (extra = 1_800) => {
    await until(async () => !(await page<{ moving: boolean }>('__u4.measure()')).moving, 30_000);
    await sleep(extra);
  };
  const W = (id: number, x: number, y: number, width: number, height: number, z = id) => ({ id, rect: { x, y, width, height }, z });
  const json = (value: unknown) => JSON.stringify(value);
  try {
    const info = await page<{ heightM: number }>(`__u4.init(${json({ model: model.url, stand: stand.url })}, 0.62, 8)`);
    results.init = info; await sleep(800);
    const box = await page<{ x: number; y: number; width: number; height: number }>('__u4.box()');
    results.box = box; log(`her box at 8 m: ${json(round(box))}`);

    // ---- A. a window in front of her covers her lower half ---------------------------------------------------------------------
    const cut = box.y + box.height * 0.5;
    const a = [W(1, 380, cut, 920, 1080 - cut), W(2, 1180, box.y + box.height * 0.25, 500, 1080 - box.y - box.height * 0.25 - 60)];
    await page(`__u4.layout(${json(a)}); __u4.caption('A 被前面的窗口挡住一半：下半身在窗口后面（合成布局）')`);
    await page('__u4.walkTo(' + json({ xM: 0, depthM: 8 }) + ')');
    await still(); await shot('a-covered-half');
    results.a = round(await page('__u4.measure()'));

    // ---- B. peek around the edge of the right-hand window ------------------------------------------------------------------------
    const b = [W(1, 130, 150, 760, 760), W(2, 1250, 200, 560, 700)];
    await page(`__u4.rest(); __u4.layout(${json(b)}); __u4.caption('B 站在两块窗口之间（她还没动）')`);
    await page('__u4.walkTo(' + json({ xM: 0.1, depthM: 8 }) + ')');
    await still(); await shot('b0-before-peek');
    const peeks: unknown[] = [];
    for (const [label, sides, reveal] of [['b-right-window-left-edge', ['left'], 0.55], ['b-left-window-right-edge', ['right'], 0.55], ['b-bolder-face-out', ['left'], 0.85]] as const) {
      await page('__u4.rest()');
      await page('__u4.walkTo(' + json({ xM: 0.1, depthM: 8 }) + ')'); await still(600);
      const p = await page<Record<string, unknown> & { stand: unknown; edge: unknown; pose: unknown; predicted: { parts: unknown[]; hidden: number; headShown: number }; notes: string[]; feasible: boolean; walkM: number }>(`__u4.plan('peek', ${json({ sides, reveal })})`);
      if (!p) { peeks.push({ label, plan: null }); log(`${label}: no plan`); continue; }
      await page(`window.__plan = ${json(p)}; __u4.caption('B 她走到窗口后面（看不见了）· ${label}'); __u4.take(window.__plan, 0)`);
      await still(900); await shot(`${label}-1-hidden-behind`);
      await page(`__u4.caption('B 探头：头偏出窗口边，身体还在窗口后面 · ${label}'); __u4.take(window.__plan, 1, 0.6)`);
      await sleep(3_200); await shot(`${label}-2-peeking`);
      const error = await page(`__u4.headError(window.__plan)`), m = await page('__u4.measure()');
      peeks.push({ label, sides, reveal, plan: round({ stand: p.stand, edge: p.edge, pose: p.pose, predicted: p.predicted, feasible: p.feasible, notes: p.notes, walkM: p.walkM }), headError: round(error), measured: round(m) });
      log(`${label}: ${json(round({ lean: p.pose, headError: error, headShown: p.predicted.headShown, hidden: p.predicted.hidden, notes: p.notes }))}`);
    }
    results.b = peeks;

    // ---- C. standing between two windows --------------------------------------------------------------------------------------
    const cases: [string, ReturnType<typeof W>[], number][] = [
      ['c1-wide-gap', [W(1, 0, 150, 640, 760), W(2, 1300, 150, 620, 760)], 8],
      ['c2-narrow-gap-8m', [W(1, 0, 150, 850, 760), W(2, 990, 150, 930, 760)], 8],
      ['c3-narrow-gap-she-steps-back-to-12m', [W(1, 0, 150, 850, 760), W(2, 990, 150, 930, 760)], 12],
    ];
    const between: unknown[] = [];
    for (const [label, windows, depth] of cases) {
      await page(`__u4.rest(); __u4.layout(${json(windows)}); __u4.caption('C 站在两块窗口之间 · ${label}')`);
      await page('__u4.walkTo(' + json({ xM: 0, depthM: 8 }) + ')'); await still(600);
      const p = await page<{ mode: string; gapM: number; gap: number[]; bounds: unknown; feasible: boolean; notes: string[]; predicted: { hidden: number }; stand: unknown }>(`__u4.plan('between', ${json({ depthM: depth })})`);
      if (!p) { between.push({ label, plan: null }); continue; }
      await page(`window.__plan = ${json(p)}; __u4.take(window.__plan, 0)`);
      await still(); await shot(label);
      between.push({ label, depth, mode: p.mode, gapM: p.gapM, gapDip: p.gap, bounds: p.bounds, hiddenFraction: p.predicted.hidden, feasible: p.feasible, notes: p.notes, stand: round(p.stand), measured: round(await page('__u4.measure()')) });
      log(`${label}: ${json(round({ mode: p.mode, gapM: p.gapM, hidden: p.predicted.hidden }))}`);
    }
    results.c = between;

    // ---- D. leaning on the side of a window ------------------------------------------------------------------------------------
    await page(`__u4.rest(); __u4.layout(${json([W(1, 160, 120, 800, 820)])}); __u4.caption('D 靠在窗口侧面：肩膀贴着窗口边')`);
    await page('__u4.walkTo(' + json({ xM: 0.5, depthM: 8 }) + ')'); await still(600);
    const lean = await page<Record<string, unknown> & { pose: unknown; contact: unknown; predicted: { hidden: number }; notes: string[]; feasible: boolean; stand: unknown; edge: unknown }>(`__u4.plan('lean', ${json({ sides: ['right'] })})`);
    if (lean) {
      await page(`window.__plan = ${json(lean)}; __u4.take(window.__plan, 1, 0.6)`);
      await still(2_600); await shot('d-lean-on-side');
      results.d = round({ plan: { pose: lean.pose, contact: lean.contact, hidden: lean.predicted.hidden, feasible: lean.feasible, notes: lean.notes, stand: lean.stand }, measured: await page('__u4.measure()') });
    } else results.d = { plan: null };
    await page('__u4.rest()');
  } catch (error) {
    results.error = String((error as Error)?.stack ?? error);
    log(`error ${results.error}`);
  } finally {
    writeFileSync(path.join(plan.out, 'results.json'), JSON.stringify(results, null, 2));
    app.exit(results.error ? 1 : 0);
  }
});
