// Unbound showcase host (docs/claude/2026-11-14-lapwing-showcase.md): Electron main for the showcase page, run by
// scripts/unbound/showcase.mjs with a temporary user-data folder and the bundled Gene. It asks Claude for the choreography in two
// segments (electron/unbound/showcase/choreo-model.ts: the second is asked while the first plays), or plays fixed fake ones for
// development; records the canvas (record mode) or shows her full screen over the desktop, click-through (live mode).
// Writes everything (mood, prompts, replies, timings, the beats as played, stills, the video) to the run's folder.
import { app, BrowserWindow, globalShortcut, ipcMain, net, protocol, screen } from 'electron';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AssetRegistry } from '../../electron/foundation/assets';
import { createAssetProtocolHandler } from '../../electron/foundation/asset-protocol';
import { readMonitorSizes } from '../../electron/unbound/display-size';
import { composeSegment, type ComposedSegment } from '../../electron/unbound/showcase/choreo-model';
import { resolvePhysicalScreen } from '../../shared/unbound/world';
import { capMurmurs, SHOWCASE_ENDINGS, SHOWCASE_OPENINGS, SHOWCASE_SITUATIONS, liveliness as livelinessOf, sampleWarmMorning, validateBeats, type ShowcaseBeat } from '../../shared/unbound/showcase';
import type { ShowcasePlan } from '../../src/unbound/showcase/api';

interface RunPlan {
  mode: 'record' | 'live'; out: string; build: string; gene: string; stand: string; userData: string;
  /** 'claude' or paths of fake choreography JSON files (development). */
  source: 'claude' | string[];
  seed: number; parentPid?: number; physics: boolean; lighting?: 'night' | 'night3' | 'warm' | 'stage';
  /** Round 7: the learned idle's files (the trained weights JSON and the quick-move folder under .local/ml); absent: idle off. */
  idle?: { model: string; events: string } | null;
  /** Record window size (DIP). */
  size?: { width: number; height: number };
}
const plan = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--plan') + 1], 'utf8')) as RunPlan;
app.setPath('userData', plan.userData);
app.setName('soft-hearts-showcase');
protocol.registerSchemesAsPrivileged([{ scheme: 'mmd-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
mkdirSync(plan.out, { recursive: true });
const log = (line: unknown) => { const text = typeof line === 'string' ? line : JSON.stringify(line); console.log(`[showcase] ${text}`); appendFileSync(path.join(plan.out, 'log.txt'), `${new Date().toISOString()} ${text}\n`); };

// A seeded draw for the mood and situation (recorded, so a run can be told apart and re-read).
let s = Math.floor(plan.seed * 2 ** 31) || 1;
const random = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
const mood = sampleWarmMorning(random);
// Round 4: a batch passes distinct situation and ending indices (no repeats within it); otherwise drawn at random.
const pickIndex = (env: string | undefined, length: number) => { const n = Number(env); return Number.isInteger(n) && n >= 0 ? n % length : Math.floor(random() * length); };
const situation = SHOWCASE_SITUATIONS[pickIndex(process.env.SHOWCASE_SITUATION, SHOWCASE_SITUATIONS.length)];
const ending = SHOWCASE_ENDINGS[pickIndex(process.env.SHOWCASE_ENDING, SHOWCASE_ENDINGS.length)];
const talk = Math.floor(random() * 6);
const opening = SHOWCASE_OPENINGS[pickIndex(process.env.SHOWCASE_OPENING, SHOWCASE_OPENINGS.length)];
// Development (round 9): SHOWCASE_LIVELINESS=0..1 overrides the mood's liveliness (comparisons of a lively and a calm hold).
const livelyOverride = Number(process.env.SHOWCASE_LIVELINESS);
const lively = process.env.SHOWCASE_LIVELINESS && Number.isFinite(livelyOverride) ? Math.max(0, Math.min(1, livelyOverride)) : livelinessOf(mood);
const TOTAL = 44 + Math.round(random() * 10);
/** Round 3: closer (was 1.0 m): at her closest her face is about half the picture's height. */
// Round 14: live, on the desktop, a little further back (1.15 m): at 0.85 her head and shoulders took about two thirds of the
// screen's height (life size right behind the screen) and an approach brought her face to fill it. Recordings keep 0.85.
const HOME_DEPTH_M = Number(process.env.SHOWCASE_DEPTH_M) || (plan.mode === 'live' ? 1.15 : 0.85);
const SPLIT = Math.round(TOTAL * 0.48);
const record: Record<string, unknown> = { mode: plan.mode, seed: plan.seed, mood, situation, opening: opening.text, ending, talk, liveliness: Number(lively.toFixed(3)), totalS: TOTAL, source: plan.source === 'claude' ? 'claude' : 'fake', calls: [] as unknown[] };

/** Round 7: the learned idle's weights and quick moves (scripts/ml/idle-data.ts's format), read here; missing files: the procedural idle. */
/** Round 13 (review): at most this many Claude calls in one run, whatever the retries ask for (normally 2). */
export const MAX_CALLS_PER_RUN = 4;
let callsMade = 0;
function capped(input: Parameters<typeof composeSegment>[0], signal: AbortSignal): Promise<ComposedSegment> {
  if (callsMade >= MAX_CALLS_PER_RUN) return Promise.resolve({ prompt: '', text: '', ms: 0, usage: null, segment: null, error: `call cap reached (${MAX_CALLS_PER_RUN} per run)` });
  callsMade++;
  return composeSegment(input, signal);
}

function readIdle(): ShowcasePlan['idle'] {
  if (!plan.idle) { record.idle = 'off'; return null; }
  let weights = null, events = null;
  try { weights = JSON.parse(readFileSync(plan.idle.model, 'utf8')); } catch { /* no model: procedural */ }
  try {
    const meta = JSON.parse(readFileSync(path.join(plan.idle.events, 'events.json'), 'utf8')), raw = readFileSync(path.join(plan.idle.events, 'events.f32'));
    events = { events: new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)), frames: meta.frames, perMinuteByActivityFifth: meta.perMinuteByActivityFifth };
  } catch { /* no quick moves */ }
  record.idle = weights ? (events ? 'model+events' : 'model') : 'procedural';
  return { weights, events };
}

app.whenReady().then(async () => {
  const assets = new AssetRegistry();
  const model = await assets.register(plan.gene), stand = await assets.register(plan.stand);
  protocol.handle('mmd-asset', createAssetProtocolHandler({ resolve: url => assets.resolve(url), fetchFile: url => net.fetch(url) }));
  const display = screen.getPrimaryDisplay();
  const facts = { bounds: { ...display.bounds }, workArea: { ...display.workArea }, scaleFactor: display.scaleFactor, internal: display.internal === true };
  const physical = resolvePhysicalScreen(facts, await readMonitorSizes().catch(() => null));
  const live = plan.mode === 'live';
  const size = plan.size ?? { width: 1280, height: Math.round(1280 * display.bounds.height / display.bounds.width) };
  const bounds = live ? { ...display.workArea } : { x: display.workArea.x + 20, y: display.workArea.y + 20, ...size };
  const world = { screen: physical, display: { ...display.bounds }, workArea: { ...display.workArea }, window: bounds, mapping: live ? 'physical' as const : 'fit' as const,
    viewerDistanceM: 0.55, eyeHeightM: 1.4, placement: { xM: 0, depthM: HOME_DEPTH_M } };
  const pagePlan: ShowcasePlan = {
    mode: plan.mode, modelUrl: model.url, standUrl: stand.url, world, depthM: HOME_DEPTH_M, xM: live ? 0.12 : 0,
    liveliness: lively, seed: plan.seed, prerollS: live ? 0 : 1.2, capS: live ? 150 : 95, physics: plan.physics,
    opening: live ? 'away' : opening.start, lighting: plan.lighting ?? 'night',
    idle: readIdle(),
    background: live ? null : ['#f7e9e4', '#e3d9ec'], stills: live ? (process.env.SHOWCASE_LIVE_STILLS ? process.env.SHOWCASE_LIVE_STILLS.split(',').map(Number).filter(Number.isFinite) : []) /* round 14, development: the live window's own pixels */ : (process.env.SHOWCASE_DENSE_STILLS ? Array.from({ length: 60 }, (_, i) => i + 0.5) : [1, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48]),
  };
  record.screen = { widthCm: Math.round(physical.widthM * 1000) / 10, source: physical.source, displayDip: `${display.bounds.width}x${display.bounds.height}@${display.scaleFactor}` };
  const win = new BrowserWindow({
    ...bounds, frame: false, transparent: live, backgroundColor: live ? '#00000000' : '#f2e6ea', resizable: false, skipTaskbar: true, focusable: !live, show: false, hasShadow: false,
    webPreferences: { preload: path.join(plan.build, 'showcase-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  if (live) { win.setIgnoreMouseEvents(true); win.setAlwaysOnTop(true, 'floating'); }
  win.webContents.on('console-message', (_e, _l, message) => { if (!/deprecated|DevTools/.test(message)) log(`page: ${message}`); });
  const video = path.join(plan.out, 'showcase.webm');
  let quitting = false;
  const quit = (why: string) => { if (quitting) return; quitting = true; log(`quit: ${why}`); writeFileSync(path.join(plan.out, 'choreography.json'), JSON.stringify(record, null, 2)); setTimeout(() => app.exit(0), 300); };
  const segments: ShowcaseBeat[][] = [];
  let pageReady = false;
  const send = (beats: ShowcaseBeat[]) => { segments.push(beats); if (pageReady) win.webContents.send('showcase:segment', beats); };
  let noMore = false;
  const finishSegments = () => { noMore = true; if (pageReady) win.webContents.send('showcase:no-more'); };

  ipcMain.handle('showcase:plan', () => pagePlan);
  ipcMain.handle('showcase:ready', () => { pageReady = true; for (const b of segments) win.webContents.send('showcase:segment', b); if (noMore) win.webContents.send('showcase:no-more'); });
  ipcMain.handle('showcase:chunk', (_e, data: ArrayBuffer) => { appendFileSync(video, Buffer.from(data)); });
  ipcMain.handle('showcase:still', async (_e, name: string) => { const image = await win.webContents.capturePage(); writeFileSync(path.join(plan.out, `${name.replace(/[^\w+.-]/g, '_')}.png`), image.toPNG()); });
  ipcMain.on('showcase:log', (_e, entry) => log({ page: entry }));
  ipcMain.handle('showcase:image', (_e, name: string, dataUrl: string) => { const m = /^data:image\/png;base64,(.+)$/u.exec(String(dataUrl)); if (m) writeFileSync(path.join(plan.out, `${String(name).replace(/[^\w+.-]/g, '_')}.png`), Buffer.from(m[1], 'base64')); });
  ipcMain.handle('showcase:done', (_e, result) => { record.result = result; quit(`done ${(result as { reason?: string })?.reason ?? ''}`); });

  // Live: never in the way; a key to stop early, and gone when the launcher is.
  if (live) {
    globalShortcut.register('Control+Alt+Q', () => quit('ctrl+alt+q'));
    if (plan.parentPid) setInterval(() => { try { process.kill(plan.parentPid!, 0); } catch { quit('launcher closed'); } }, 1000);
  }
  setTimeout(() => quit('host cap'), (pagePlan.capS + 40) * 1000);

  // The choreography.
  const calls = record.calls as unknown[];
  const keep = (part: number, c: ComposedSegment) => { calls.push({ part, ms: c.ms, usage: c.usage, error: c.error, prompt: c.prompt, reply: c.text, beats: c.segment?.beats.length ?? 0, dropped: c.segment?.dropped ?? null, clamped: c.segment?.clamped ?? null, summary: c.segment?.summary ?? null }); log(`claude part ${part}: ${c.ms} ms, ${c.segment?.beats.length ?? 0} beats${c.error ? `, error ${c.error}` : ''}`); };
  const compose = async () => {
    const controller = new AbortController();
    if (plan.source !== 'claude') {
      // A fake choreography ({ beats }) or a recorded run's choreography.json ({ segments }: replayed as Claude wrote it).
      const fake = plan.source.flatMap(file => { const v = JSON.parse(readFileSync(file, 'utf8')) as { beats?: unknown[]; segments?: unknown[][] }; record.replayOf = file; return v.beats ?? (v.segments ?? []).flat(); });
      // Development: the same performance with the old random mouth instead of the line's pinyin (a contact-sheet comparison).
      if (process.env.SHOWCASE_NO_PINYIN) for (const b of fake as { pinyin?: string }[]) delete b.pinyin;
      const all = validateBeats(fake, { from: 0, to: 62 })!.beats;
      record.segments = [all];
      const split = Math.max(...all.map(b => b.at)) / 2;
      send(all.filter(b => b.at < split));
      setTimeout(() => { send(all.filter(b => b.at >= split)); finishSegments(); }, 4000);
      return;
    }
    let first: ComposedSegment | null = null;
    for (let attempt = 0; attempt < 2 && !first?.segment; attempt++) { first = await capped({ mood, situation, window: { from: 0, to: SPLIT }, part: 1, total: TOTAL, opening: live ? 'away' : opening.start, openingText: live ? undefined : opening.text, talk }, controller.signal); keep(1, first); }
    if (!first?.segment) { finishSegments(); return; }
    const cap1 = capMurmurs(first.segment.beats, talk); first.segment.beats = cap1.beats;
    const spoken1 = first.segment.beats.filter(b => b.kind === 'murmur').length;
    send(first.segment.beats);
    let second = await capped({ mood, situation, window: { from: SPLIT, to: TOTAL }, part: 2, total: TOTAL, previous: first.segment, ending, talk }, controller.signal);
    keep(2, second);
    if (!second.segment) { second = await capped({ mood, situation, window: { from: SPLIT, to: TOTAL }, part: 2, total: TOTAL, previous: first.segment, ending, talk }, controller.signal); keep(2, second); }
    let dropped2 = 0;
    if (second.segment) { const cap2 = capMurmurs(second.segment.beats, talk - spoken1); second.segment.beats = cap2.beats; dropped2 = cap2.dropped; send(second.segment.beats); }
    record.murmursDropped = cap1.dropped + dropped2;
    record.segments = [first.segment.beats, second.segment?.beats ?? []];
    finishSegments();
  };
  const composing = compose().catch(error => { log(`compose error ${String(error)}`); finishSegments(); });
  // Record mode waits for the first segment before showing her (the opening then plays as the camera rolls); live shows at once.
  if (!live) await Promise.race([new Promise<void>(resolve => { const t = setInterval(() => { if (segments.length || noMore) { clearInterval(t); resolve(); } }, 100); }), composing]);
  await win.loadFile(path.join(plan.build, 'src/unbound/showcase/index.html'), { query: live ? {} : { opaque: '1', ...(process.env.SHOWCASE_LIGHT_PROBE ? { lightProbe: '1' } : {}), ...(process.env.SHOWCASE_SHEET ? { sheet: process.env.SHOWCASE_SHEET } : {}), ...(process.env.SHOWCASE_QUIET_OLD ? { quietOld: '1' } : {}), ...(process.env.SHOWCASE_STILL_OLD ? { stillOld: '1' } : {}), ...(process.env.SHOWCASE_BLUSH_OLD ? { blushOld: '1' } : {}), ...(process.env.SHOWCASE_BLUSH_PAINTED ? { blush: 'procedural' } : {}), ...(process.env.SHOWCASE_FIT_OFF ? { fitOff: '1' } : {}),...(process.env.SHOWCASE_BITRATE ? { vbr: process.env.SHOWCASE_BITRATE } : {}) } });
  if (live) win.showInactive(); else win.show();
  log(`window ${JSON.stringify(bounds)} mode ${plan.mode}`);
});
app.on('window-all-closed', () => app.exit(0));
