// Unbound v1 step 2 smoke (docs/claude/2026-11-15-unbound-v1-step2-typing.md): the real Unbound host, window, preload and page with the
// bundled Gene in a small window ('fit', 960x600), the real small input box (window, page, preload), in a temporary user-data folder.
// A stand-in companion window, a stand-in chat path (it only records the line), no model call, no profile, no global shortcut. It checks, in
// the real windows: a click on her reports one touch and opens the box beside her head; typing and Enter send; Esc and clicking away
// close; her reply bubble is readable beside her head; the senses light shows and its hover text; her mouth follows a voice flag.
import { app, BrowserWindow, ipcMain, net, protocol, screen } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AssetRegistry } from '../../electron/foundation/assets';
import { createAssetProtocolHandler } from '../../electron/foundation/asset-protocol';
import { UnboundHost, type UnboundIpcMain } from '../../electron/unbound/host';
import { asUnboundWindow, primaryDisplayFacts } from '../../electron/unbound/electron-host';
import { createUnboundWindow, loadUnboundPage } from '../../electron/unbound/window';
import { readMonitorSizes } from '../../electron/unbound/display-size';
import { InputBoxWindow } from '../../electron/unbound/input-window';
import { UnboundTyping } from '../../electron/unbound/typing';
import { reportTouch, setTouchSink } from '../../electron/mood/touch/sink';
import type { TouchEvent } from '../../shared/mood/touch';
import type { MoodReading } from '../../shared/unbound/director';

const plan = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--plan') + 1], 'utf8')) as { out: string; build: string; gene: string; stand: string; userData: string };
app.setPath('userData', plan.userData);
app.setName('unbound-step2-smoke');
protocol.registerSchemesAsPrivileged([{ scheme: 'mmd-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const results: Record<string, unknown> = {};
const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { checks.push({ name, ok, detail }); console.log(`[step2] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); };
const CALM: MoodReading = { D: 50, O: 50, E: 50, N: 50, C: 50, A: 0.2, B: 0, M: 0 };
const REPLY = '嗯，我在听呢。你刚才点了我一下，是想和我说点什么吗？不着急，慢慢说，我这里一直都在，哪怕你只是想随便聊两句今天的天气，或者刚才看到的有趣的事情也可以。想到什么就写在小框里，按回车我就能看到。';

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
  const preview = { x: wa.x + 40, y: wa.y + 40, width: 960, height: 600 };
  const touches: TouchEvent[] = [], said: string[] = [];
  setTouchSink(event => touches.push(event));
  const page = { electronDir: plan.build, distDir: plan.build };
  let typing!: UnboundTyping, host!: UnboundHost;
  const input = new InputBoxWindow({ page, submit: text => typing.submit(text), cancel: () => typing.cancel() });
  host = new UnboundHost({
    ipcMain: ipcMain as unknown as UnboundIpcMain,
    pet: () => pet, petWanted: () => true, developerMode: () => true,
    source: () => ({ modelUrl: model.url, motion: { pose: stand.url, gesture: null, expression: null, legacy: false }, breath: 0.5, physics: null }),
    reviewed: async () => true, display: primaryDisplayFacts, measure: () => readMonitorSizes(),
    openWindow: bounds => {
      const win = unboundWindow = createUnboundWindow(bounds, page);
      win.webContents.on('console-message', (_event, _level, message) => { if (!/deprecated/.test(message)) console.log(`[step2] page: ${message}`); });
      return { window: asUnboundWindow(win), loaded: loadUnboundPage(win, page, { probe: 'preview' }) };
    },
    restored: () => {}, publish: () => {}, preview: { bounds: preview }, headTimeoutMs: 1500,
    touch: report => typing.click(report),
    peek: { clock: () => Date.now(), random: () => Math.random(), idleSeconds: () => null, idleNow: () => null, asleep: () => false, inCall: () => false, userTalking: () => false, mood: () => CALM,
      lastInteractionAt: () => null, answered: () => false, every: (ms, run) => { const t = setInterval(run, ms); return () => clearInterval(t); } },
  });
  typing = new UnboundTyping({
    touch: reportTouch, say: text => { said.push(text); return 'sent'; }, shortcut: { register: () => true, unregister: () => {} },
    input, state: () => host.state, window: () => host.windowRect(), askHead: () => host.askHead(), said: text => host.said(text), clock: () => Date.now(),
  });
  const until = async (test: () => Promise<boolean> | boolean, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await sleep(25); } return test(); };
  const eval1 = <T>(expression: string) => unboundWindow!.webContents.executeJavaScript(expression) as Promise<T>;
  const boxWindow = () => BrowserWindow.getAllWindows().find(win => !win.isDestroyed() && win.getTitle().includes('对她说')) ?? null;
  const shot = async (name: string) => { writeFileSync(path.join(plan.out, `${name}.png`), (await unboundWindow!.webContents.capturePage()).toPNG()); };
  const mouse = (type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) => unboundWindow!.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  try {
    host.apply({ active: true });
    if (!(await until(() => host.state === 'unbound', 40_000))) throw new Error(`did not enter: ${host.view().error}`);
    typing.modeChanged('unbound');
    host.apply({ depthM: 1.2 });
    await until(async () => !(await eval1<{ moving: boolean }>('window.__unboundProbe.stats()')).moving, 30_000);
    await sleep(1_200);
    const body = await eval1<{ x: number; y: number }>('window.__unboundProbe.body()');
    const head0 = await eval1<{ x: number; y: number; r: number } | null>('window.__unboundProbe.headSpot()');
    results.body = body; results.head = head0;
    check('her head is on the window', !!head0, head0);
    await shot('00-before');

    // 1. A single click on her chest: one touch, and the box beside her head.
    for (const [dx, dy] of [[0, 0], [2, 1]]) { mouse('mouseMove', body.x + dx, body.y + dy); await sleep(120); }
    check('the window takes the mouse over her', await until(async () => { mouse('mouseMove', body.x + 1, body.y); return (await eval1<{ interactive: boolean }>('window.__unboundProbe.stats()')).interactive; }, 2_000));
    mouse('mouseDown', body.x, body.y); await sleep(60); mouse('mouseUp', body.x, body.y);
    await until(() => touches.length > 0 && !!boxWindow()?.isVisible(), 3_000);
    results.touches = touches;
    check('exactly one touch was reported', touches.length === 1, touches);
    check('it is a click on her, from Unbound, on her torso or an unnamed bone', touches[0]?.kind === 'click' && touches[0]?.where === 'unbound' && ['torso', 'other', 'arm', 'shoulder', 'hand'].includes(touches[0]?.part ?? ''), touches[0]);
    const box = boxWindow();
    check('the input box is open', !!box?.isVisible());
    if (box) {
      const b = box.getBounds(), head = head0!;
      const hx = preview.x + head.x, hy = preview.y + head.y;
      const nx = Math.max(b.x, Math.min(hx, b.x + b.width)), ny = Math.max(b.y, Math.min(hy, b.y + b.height));
      check('the box is beside her head, not over her face', Math.hypot(hx - nx, hy - ny) >= head.r - 1, { box: b, head: { hx, hy, r: head.r } });
      results.boxBounds = b; results.boxFocused = box.isFocused();
      await sleep(400);
      writeFileSync(path.join(plan.out, '01-box.png'), (await box.webContents.capturePage()).toPNG());
      // 2. Type and Enter.
      for (const ch of 'hi') box.webContents.sendInputEvent({ type: 'char', keyCode: ch });
      await sleep(150);
      const typed = await box.webContents.executeJavaScript('document.getElementById("line").value') as string;
      check('the typed text reached the field', typed === 'hi', typed);
      box.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); box.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      await until(() => said.length > 0, 2_000);
      check('Enter sent the line through the chat path once', said.length === 1 && said[0] === 'hi', said);
      await sleep(400);
      check('the box closed after sending', !box.isVisible());
      check('the user\'s line shows near her', await eval1<boolean>("!document.querySelector('.unbound-said')?.hidden && /hi/.test(document.querySelector('.unbound-said')?.textContent ?? '')"));
      await shot('02-said');
      // 3. Esc closes. A second click opens it again (a second touch).
      await sleep(500);
      mouse('mouseMove', body.x + 1, body.y); await sleep(150);
      mouse('mouseDown', body.x + 1, body.y); await sleep(60); mouse('mouseUp', body.x + 1, body.y);
      await until(() => touches.length > 1 && !!boxWindow()?.isVisible(), 3_000);
      check('a second click is a second touch and opens the box again', touches.length === 2 && !!boxWindow()?.isVisible(), touches.length);
      await sleep(400);
      box.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); box.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await sleep(400);
      check('Esc closed it, and sent nothing', !box.isVisible() && said.length === 1);
      // 4. Clicking away closes it.
      await sleep(500);
      mouse('mouseMove', body.x, body.y + 1); await sleep(150);
      mouse('mouseDown', body.x, body.y + 1); await sleep(60); mouse('mouseUp', body.x, body.y + 1);
      await until(() => touches.length > 2 && !!boxWindow()?.isVisible(), 3_000);
      await sleep(500);
      const focused = box.isFocused();
      box.blur();
      await sleep(400);
      check('blur (clicking away) closed it', !box.isVisible(), { wasFocused: focused });
    }
    // A double click reports once; a drag and a hold report nothing.
    const before = touches.length;
    await sleep(600);
    mouse('mouseMove', body.x, body.y); await sleep(150);
    mouse('mouseDown', body.x, body.y); await sleep(500); mouse('mouseUp', body.x, body.y); await sleep(300);
    check('a hold is not a click', touches.length === before, touches.length);
    mouse('mouseDown', body.x, body.y); await sleep(40); mouse('mouseMove', body.x + 40, body.y); mouse('mouseUp', body.x + 40, body.y); await sleep(300);
    check('a drag is not a click', touches.length === before, touches.length);
    boxWindow()?.hide();

    // 5. Her reply bubble: readable, beside her head, inside the window.
    mouse('mouseMove', 5, 5); await sleep(300);
    host.stream({ id: 'smoke-1', kind: 'chat', type: 'delta', text: REPLY });
    host.stream({ id: 'smoke-1', kind: 'chat', type: 'done', text: '' });
    await until(() => eval1<boolean>("!document.querySelector('.unbound-bubble')?.hidden"), 5_000);
    await sleep(1_800);
    const bubble = await eval1<{ x: number; y: number; width: number; height: number; text: number } | null>("(() => { const n = document.querySelector('.unbound-bubble'); if (!n || n.hidden) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, text: n.textContent.length, shown: getComputedStyle(n).visibility }; })()");
    const head1 = await eval1<{ x: number; y: number; r: number } | null>('window.__unboundProbe.headSpot()');
    results.bubble = bubble;
    check('the bubble shows the whole reply', !!bubble && bubble.text === REPLY.length, bubble?.text);
    if (bubble && head1) {
      const inside = bubble.x >= 0 && bubble.y >= 0 && bubble.x + bubble.width <= preview.width + 1 && bubble.y + bubble.height <= preview.height + 1;
      const nx = Math.max(bubble.x, Math.min(head1.x, bubble.x + bubble.width)), ny = Math.max(bubble.y, Math.min(head1.y, bubble.y + bubble.height));
      check('the bubble is inside the window and off her face', inside && Math.hypot(head1.x - nx, head1.y - ny) >= head1.r - 1, { bubble, head1 });
    }
    await shot('03-bubble');

    // 6. The senses light and its hover text.
    host.senses({ camera: true, microphone: true, screen: false, audio: false });
    await sleep(500);
    const light = await eval1<{ lit: number; at: { x: number; y: number; width: number; height: number } | null }>('window.__unboundProbe.light()');
    results.light = light;
    check('two dots are lit for the camera and the microphone', light.lit === 2 && !!light.at, light);
    await shot('04-light');
    if (light.at) {
      mouse('mouseMove', light.at.x + light.at.width / 2, light.at.y + light.at.height / 2); await sleep(400);
      const tip = await eval1<string | null>("(() => { const n = document.querySelector('.unbound-senses-tip'); return n && !n.hidden ? n.textContent : null; })()");
      check('hovering the light says which senses are on', !!tip && tip.includes('摄像头') && tip.includes('麦克风') && !tip.includes('屏幕'), tip);
      await shot('05-light-hover');
      mouse('mouseMove', 5, 5); await sleep(300);
    }
    host.senses({ camera: false, microphone: false, screen: false, audio: false });
    await sleep(300);
    check('the light is gone when nothing is on', (await eval1<{ lit: number }>('window.__unboundProbe.light()')).lit === 0);

    // 7. Her mouth follows the voice flag.
    const before0 = await eval1<{ has: boolean; open: number }>('window.__unboundProbe.mouth()');
    host.speaking(true);
    let max = 0; const end = Date.now() + 1_500;
    while (Date.now() < end) { max = Math.max(max, (await eval1<{ open: number }>('window.__unboundProbe.mouth()')).open); await sleep(40); }
    host.speaking(false); await sleep(1_200);
    const after = await eval1<{ open: number }>('window.__unboundProbe.mouth()');
    results.mouth = { before: before0, maxWhileSpeaking: max, after: after.open };
    check('her mouth opens while the voice sounds and closes after', before0.has && max > 0.25 && after.open < 0.02, results.mouth);
  } catch (error) {
    results.error = String((error as Error)?.stack ?? error);
    console.log(`[step2] error ${results.error}`);
  } finally {
    results.checks = checks;
    writeFileSync(path.join(plan.out, 'results.json'), JSON.stringify(results, null, 2));
    setTouchSink(null);
    input.dispose();
    host.quit();
    app.exit(results.error || checks.some(c => !c.ok) ? 1 : 0);
  }
});
