// I-209 step 3 smoke, the Electron side (scripts/unbound/company-stage-smoke.mjs builds and starts it). The real stage as the app makes it
// (electron/unbound/company/build.ts buildUnboundStage) with Electron's real ipcMain and windows, small preview windows, the bundled Gene
// as all three cards, a temporary user-data folder. Checks and records:
//  - all three come out, each her own window (three webContents), the stage view says three, the windows are ordered by depth;
//  - each page's frame numbers (the probe's perf: frame intervals) and the stage's own (others seen, frames held short);
//  - the full-screen box's panel with three on stage: 谁在场 rows, the senses rows; nothing overflows the panel (no scrolling); clicking
//    another one moves "在和你说话" to her and her box says "对 <name> 说点什么…"; PNG shots of the panel and of each window (Gene only).
import { app, BrowserWindow, ipcMain, net, protocol, screen } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AssetRegistry } from '../../electron/foundation/assets';
import { createAssetProtocolHandler } from '../../electron/foundation/asset-protocol';
import type { UnboundIpcMain } from '../../electron/unbound/host';
import { asUnboundWindow, primaryDisplayFacts } from '../../electron/unbound/electron-host';
import { buildUnboundStage } from '../../electron/unbound/company/build';
import { MAIN_KEY } from '../../electron/unbound/company/stage';
import { createUnboundWindow, loadUnboundPage } from '../../electron/unbound/window';
import { readMonitorSizes } from '../../electron/unbound/display-size';
import { companyPorts } from '../../electron/unbound/company/ports';
import { InputBoxWindow } from '../../electron/unbound/input-window';
import { InputCallBridge } from '../../electron/unbound/input-call';
import { INPUT_PANEL_SIZE } from '../../shared/unbound/typing';

interface Plan { out: string; build: string; gene: string; stand: string; userData: string }
const plan = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--plan') + 1]!, 'utf8')) as Plan;
app.setPath('userData', plan.userData);
app.setName('unbound-company-smoke');
protocol.registerSchemesAsPrivileged([{ scheme: 'mmd-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { checks.push({ name, ok, detail }); console.log(`[i209] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); };
const NEUTRAL = { snapshot: { values: { D: 55, O: 55, E: 50, N: 50, C: 50 }, boredom: 0, longing: 0 }, parameters: { baseline: { D: 50, O: 50, E: 50, N: 50, C: 50 }, evidence: { level: 1 } } };

app.whenReady().then(async () => {
  mkdirSync(plan.out, { recursive: true });
  const assets = new AssetRegistry();
  const model = await assets.register(plan.gene), stand = await assets.register(plan.stand);
  protocol.handle('mmd-asset', createAssetProtocolHandler({ resolve: url => assets.resolve(url), fetchFile: url => net.fetch(url) }));
  const wa = screen.getPrimaryDisplay().workArea;
  const small = new BrowserWindow({ width: 200, height: 260, frame: false, skipTaskbar: true, focusable: false, show: false });
  await small.loadURL('data:text/html,<body></body>');
  const page = { electronDir: plan.build, distDir: plan.build };
  const windows: BrowserWindow[] = [];
  const cards = [{ id: 'gene', name: 'Gene' }, { id: 'gene-2', name: 'Gene 二号', modelPath: plan.gene }, { id: 'gene-3', name: 'Gene 三号', modelPath: plan.gene }];
  const { host, stage } = buildUnboundStage({
    page,
    // no-pet-ok: the wiring's port names for the small window
    pet: () => small, petWanted: () => false, developerMode: () => true,
    source: () => ({ modelUrl: model.url, motion: { pose: stand.url, gesture: null, expression: null, legacy: false }, breath: 0.5, physics: null }),
    reviewed: async () => true, restPose: async () => stand.url, restored: () => {}, publish: () => {},
    company: companyPorts(() => ({ cards: { modelCards: () => cards, presetGeneId: async () => 'gene', publicState: () => ({ activeId: 'gene' }) },
      models: { bundledModel: async () => model, register: file => assets.register(file) } })),
    stage: { mood: () => ({ get: () => NEUTRAL, interaction: () => { throw new Error('no'); } }), peekMood: () => NEUTRAL as never, close: () => undefined, journal: () => {} },
  }, {
    ipcMain: ipcMain as unknown as UnboundIpcMain, measure: () => readMonitorSizes(), display: primaryDisplayFacts,
    preview: { bounds: { x: wa.x + 40, y: wa.y + 40, width: 960, height: 600 } },
    open: bounds => {
      const win = createUnboundWindow(bounds, page);
      windows.push(win);
      win.webContents.on('console-message', (_event, _level, message) => { if (/error|Error/.test(message) && !/deprecated/.test(message)) console.log(`[i209] page: ${message}`); });
      return { window: asUnboundWindow(win), loaded: loadUnboundPage(win, page, { probe: 'preview', perf: 'high', perfquiet: '0' }) };
    },
  });
  const until = async (test: () => Promise<boolean> | boolean, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await sleep(250); } return test(); };
  const probe = <T>(win: BrowserWindow, expression: string) => win.webContents.executeJavaScript(expression) as Promise<T>;
  const results: Record<string, unknown> = {};
  let error: string | null = null;
  try {
    host.apply({ active: true });
    check('the first one comes out', await until(() => host.state === 'unbound', 90_000), host.view().error);
    await host.company.set('gene-2', true);
    check('the second one comes out as her own full screen', await until(() => stage.present === 2, 90_000), stage.keys());
    await host.company.set('gene-3', true);
    check('the third one comes out', await until(() => stage.present === 3, 90_000), stage.keys());
    check('three windows, three pages', new Set(windows.filter(w => !w.isDestroyed()).map(w => w.webContents.id)).size === 3, windows.length);
    await sleep(8_000); // her first frames, her body reports, the shared eye
    const live = windows.filter(w => !w.isDestroyed());
    for (const win of live) await probe(win, 'window.__unboundProbe.perfDrain()').catch(() => null);
    await sleep(10_000);
    const pages = [];
    for (const win of live) {
      const perf = await probe<{ frameMs: unknown; fps: number; tier: string }>(win, 'window.__unboundProbe.perf()');
      const view = await probe<{ present: number; others: unknown[]; held: number } | null>(win, 'window.__unboundProbe.stage()');
      const frames = await probe<{ ms: number; quiet: boolean }[]>(win, 'window.__unboundProbe.perfDrain()');
      const ms = frames.filter(f => !f.quiet).map(f => f.ms).sort((a, b) => a - b), at = (p: number) => ms.length ? Math.round(ms[Math.min(ms.length - 1, Math.ceil(p * ms.length) - 1)]! * 10) / 10 : null;
      pages.push({ id: win.webContents.id, tier: perf.tier, fps: perf.fps, frames: ms.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1), stage: view });
    }
    results.pages = pages;
    check('every page sees the other two', pages.every(p => p.stage?.present === 3 && p.stage.others.length === 2), pages.map(p => p.stage));
    results.stack = stage.world.stack;
    results.bodies = Object.fromEntries([...stage.world.bodies()].map(([id, b]) => [id, { xM: Math.round(b.xM * 100) / 100, depthM: Math.round(b.depthM * 100) / 100, radiusM: Math.round(b.radiusM * 100) / 100 }]));
    results.subject = stage.world.subject();
    // Each window's own picture (Gene only), half size.
    for (const [i, win] of live.entries()) writeFileSync(path.join(plan.out, `window-${i + 1}.png`), (await win.webContents.capturePage()).resize({ width: 480 }).toPNG());
    // The full-screen box's panel with three on stage.
    const input = new InputBoxWindow({ page, submit: () => ({ ok: true }), cancel: () => {}, call: new InputCallBridge(), state: () => host.state, senses: () => null,
      place: { look: () => host.places.look(), set: () => host.places.look() }, company: { look: () => host.company.look(), set: (id, on) => host.company.set(id, on) },
      to: () => stage.addresseeName() });
    const rect = { x: wa.x + wa.width - INPUT_PANEL_SIZE.width - 60, y: wa.y + 60, ...INPUT_PANEL_SIZE };
    const panelShot = async (name: string) => {
      input.open(rect, true);
      const boxNow = () => BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.getTitle().includes('对')); // it hides itself when it loses the keyboard; its page is still there
      await until(async () => { const b = boxNow(); return !!b && await b.webContents.executeJavaScript(`document.querySelectorAll('.senses-row[data-sense="company"]').length >= 3`).catch(() => false); }, 15_000);
      await sleep(800);
      const box = boxNow();
      if (!box) { check(`${name}: the box is there`, false); return null; }
      const fit = await box.webContents.executeJavaScript(`(() => { const panel = document.getElementById('panel'); const rows = [...document.querySelectorAll('.senses-row[data-sense="company"]')];
        const overflow = [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 1 && getComputedStyle(e).overflowY !== 'visible').map(e => e.id || e.className).slice(0, 5);
        return { panelHeight: panel?.getBoundingClientRect().height ?? 0, scrollHeight: panel?.scrollHeight ?? 0, clientHeight: panel?.clientHeight ?? 0, windowHeight: innerHeight, overflow,
          bottom: Math.max(0, ...[...document.querySelectorAll('#panel *')].map(e => e.getBoundingClientRect().bottom)),
          rows: rows.map(r => ({ id: r.dataset.id, text: r.textContent })), placeholder: document.querySelector('input,textarea')?.placeholder ?? null }; })()`);
      writeFileSync(path.join(plan.out, `${name}.png`), (await box.webContents.capturePage()).toPNG());
      input.close();
      await sleep(500);
      return fit as { scrollHeight: number; clientHeight: number; windowHeight: number; bottom: number; overflow: string[]; rows: { id: string; text: string }[]; placeholder: string | null };
    };
    const three = await panelShot('panel-three');
    results.panelThree = three;
    check('谁在场 lists all three, the first one 在和你说话', !!three && three.rows.length === 3 && /在和你说话/.test(three.rows[0]!.text) && three.rows.slice(1).every(r => /在场/.test(r.text)), three?.rows);
    check('the panel fits its window: nothing scrolls, nothing is cut', !!three && three.scrollHeight <= three.clientHeight + 1 && three.bottom <= three.windowHeight + 1 && three.overflow.length === 0, three && { scroll: three.scrollHeight, client: three.clientHeight, bottom: three.bottom, window: three.windowHeight, overflow: three.overflow });
    stage.address('gene-2');
    const addressed = await panelShot('panel-talking-to-2');
    results.panelAddressed = addressed;
    check('clicked Gene 二号: she is the one 在和你说话, her box says so', !!addressed && /在和你说话/.test(addressed.rows.find(r => r.id === 'gene-2')?.text ?? '') && /Gene 二号/.test(addressed.placeholder ?? ''), addressed && { rows: addressed.rows, placeholder: addressed.placeholder });
    stage.address(MAIN_KEY);
    input.destroy();
  } catch (failure) { error = String((failure as Error)?.stack ?? failure); console.log(`[i209] error ${error}`); }
  writeFileSync(path.join(plan.out, 'results.json'), JSON.stringify({ checks, ...results, error }, null, 2));
  host.exit(); await sleep(500); host.quit();
  app.exit(error || checks.some(c => !c.ok) ? 1 : 0);
});
