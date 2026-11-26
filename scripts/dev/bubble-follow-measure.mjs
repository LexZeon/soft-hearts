#!/usr/bin/env node
// I-165: what revealing her bubble character by character costs against whole sentences.
//
//   node scripts/dev/heavy.mjs --label bubble-measure -- node scripts/dev/bubble-follow-measure.mjs [--skip-build] [--runs window,unbound-window]
//
// Isolated: a fresh temporary profile per run (never %APPDATA%\soft-hearts*), the synthetic Claude Code of the smokes (scripts/lib/
// claude-smoke-fixture.mjs), no network (every renderer request is refused), and a silent fake voice: the system voice with
// speechSynthesis replaced in both windows by a timer that "plays" each sentence for a real reading length (220 ms per character, about
// Drama 3's pace) and fires the engine's start/end events. Everything else is the real app: the host's sentence plan and its display
// proofs, the follow view, PetUI, the native bubble window, the stage. // no-pet-ok: the app's own names (the ?pet window query, #pet-status, settings.pet, updatePetReply, PetUI)
//
// Three builds of the renderer: the knob read as 'off' (before I-165), the default one ('sentence') and one with the knob read as 'char' (scripts/dev/bubble-follow-measure.vite.mjs;
// no source changes). Each build runs on the window stage and on the Unbound window stage (the developer switch in page storage).
// Measured while she reads the reply (first sentence start → last end), against a 5 s idle baseline before the message:
//   - bubble updates and IPC messages per second (main-process invoke handlers by channel; desk:reply-render sends; paint receipts);
//   - main-process time per bubble update (the updatePetReply handler, synchronous), and CPU time per process (app.getAppMetrics); // no-pet-ok: the app's own names (the ?pet window query, #pet-status, settings.pet, updatePetReply, PetUI)
//   - the bubble window: DOM updates, and its frame intervals (requestAnimationFrame) with the frames that held an update;
//   - the companion window's frame intervals (requestAnimationFrame in her page: the stage draws on the same frames).
// Results: .local/bubble-follow-measure/results.json and a table on stdout. Windows appear on screen while it runs (about 2 minutes).
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createClaudeFixture } from '../lib/claude-smoke-fixture.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const output = path.join(workspace, '.local', 'bubble-follow-measure');
const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const runsArg = args.includes('--runs') ? args[args.indexOf('--runs') + 1].split(',') : ['window', 'unbound-window'];
const modesArg = args.includes('--modes') ? args[args.indexOf('--modes') + 1].split(',') : ['off', 'sentence', 'char'];
const REPLY = '嗯，我在呢。今天看你忙了一整天，肩膀是不是又僵了？要不要先停下来喝口水，我陪你坐一会儿。刚才那首歌我一直在跟着哼，你听到了吗？等你忙完，我们再慢慢聊今天发生的事。不着急，我一直都在这里。';
const MS_PER_CHAR = 220, BASELINE_MS = 5000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const node = process.execPath;

async function waitFor(condition, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await condition().catch(() => false)) return; await pause(100); }
  throw new Error(`Timed out: ${label}`);
}

function build(mode) {
  const vite = path.join(workspace, 'node_modules', 'vite', 'bin', 'vite.js');
  console.log(`BUILD renderer (${mode})`);
  execFileSync(node, [vite, 'build', ...(mode !== 'sentence' ? ['--config', 'scripts/dev/bubble-follow-measure.vite.mjs'] : []), '--logLevel', 'warn'],
    { cwd: workspace, stdio: 'inherit', env: { ...process.env, SOFT_HEARTS_MEASURE_BUBBLE_MODE: mode } });
}

/** In both windows: speechSynthesis plays nothing; each utterance "starts" 60 ms after speak and "ends" after its reading length. */
function installVoice(page) {
  return page.evaluate(msPerChar => {
    const facts = window.__bfmSpeech = [];
    let active = null;
    Object.defineProperties(speechSynthesis, {
      speak: { configurable: true, value: utterance => {
        active = utterance;
        setTimeout(() => {
          if (active !== utterance) return;
          facts.push(['start', Date.now(), utterance.text.length, utterance.text]); utterance.onstart?.(new Event('start'));
          setTimeout(() => { if (active !== utterance) return; active = null; facts.push(['end', Date.now(), utterance.text.length]); utterance.onend?.(new Event('end')); },
            Math.max(400, utterance.text.length * msPerChar));
        }, 60);
      } },
      cancel: { configurable: true, value: () => { active = null; } },
      pause: { configurable: true, value: () => {} }, resume: { configurable: true, value: () => {} },
      getVoices: { configurable: true, value: () => [] },
      speaking: { configurable: true, get: () => active !== null }, pending: { configurable: true, get: () => false }, paused: { configurable: true, get: () => false },
    });
    return true;
  }, MS_PER_CHAR);
}

/** requestAnimationFrame timestamps in a page (and, for the bubble, its DOM updates). Bounded. */
function installFrames(page, bubble) {
  return page.evaluate(withMutations => {
    const frames = window.__bfmFrames = [], updates = window.__bfmUpdates = [];
    const tick = at => { if (frames.length < 40000) frames.push(at); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    if (withMutations) {
      const body = document.getElementById('reply-body');
      if (body) updates.push([performance.now(), (body.textContent || '').length, Date.now()]); // what it already shows
      if (body) new MutationObserver(() => { if (updates.length < 20000) updates.push([performance.now(), (body.textContent || '').length, Date.now()]); })
        .observe(body, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-pieces'] });
    }
    window.__bfmClock = () => ({ perf: performance.now(), wall: Date.now() });
    return true;
  }, bubble);
}

/** Main process: every invoke handler counted and timed, desk:reply-render sends and paint receipts counted. */
function installMainProbe(instance) {
  return instance.evaluate(({ app, ipcMain, BrowserWindow }) => {
    const probe = globalThis.__bfm = { invokes: [], renders: [], acks: [], wrapped: 0, ok: false };
    const handlers = ipcMain._invokeHandlers;
    if (handlers && typeof handlers.forEach === 'function') {
      for (const [channel, handler] of [...handlers.entries()]) {
        handlers.set(channel, (event, ...rest) => {
          const t0 = performance.now();
          const done = () => { if (probe.invokes.length < 200000) probe.invokes.push([channel, Date.now(), performance.now() - t0]); };
          try { const result = handler(event, ...rest); if (result && typeof result.then === 'function') return result.finally(done); done(); return result; }
          catch (error) { done(); throw error; }
        });
        probe.wrapped++;
      }
      probe.ok = true;
    }
    const wrap = win => {
      if (win.__bfmWrapped) return; win.__bfmWrapped = true;
      const send = win.webContents.send.bind(win.webContents);
      win.webContents.send = (channel, ...rest) => {
        if (channel === 'desk:reply-render' && probe.renders.length < 200000) probe.renders.push([Date.now(), rest[0] && typeof rest[0].text === 'string' ? rest[0].text.length : -1]);
        return send(channel, ...rest);
      };
    };
    BrowserWindow.getAllWindows().forEach(wrap);
    app.on('browser-window-created', (_event, win) => wrap(win));
    ipcMain.on('desk:reply-presented', () => { if (probe.acks.length < 200000) probe.acks.push(Date.now()); });
    return { wrapped: probe.wrapped, ok: probe.ok };
  });
}

function metrics(instance) {
  return instance.evaluate(({ app, BrowserWindow }) => {
    const owners = new Map(BrowserWindow.getAllWindows().map(win => [win.webContents.getOSProcessId(), win.webContents.getURL()]));
    return { at: Date.now(), list: app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type, url: owners.get(m.pid) ?? null,
      cumulative: m.cpu.cumulativeCPUUsage ?? null, percent: m.cpu.percentCPUUsage })) };
  });
}

const stats = values => {
  if (!values.length) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b), at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: values.length, mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(3), p50: +at(0.5).toFixed(3), p95: +at(0.95).toFixed(3), p99: +at(0.99).toFixed(3), max: +sorted.at(-1).toFixed(3) };
};
const intervals = (frames, from, to) => { const out = []; for (let i = 1; i < frames.length; i++) if (frames[i - 1] >= from && frames[i] <= to) out.push(frames[i] - frames[i - 1]); return out; };
function frameReport(frames, from, to) {
  const gaps = intervals(frames, from, to), s = stats(gaps), median = s.p50 ?? 16.7;
  return { ...s, fps: gaps.length ? +(1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length)).toFixed(1) : null,
    over1_5x: gaps.length ? +(gaps.filter(gap => gap > 1.5 * median).length / gaps.length * 100).toFixed(2) : null };
}
function cpuDelta(before, after, select) {
  const pick = list => list.filter(select);
  const a = pick(before.list), b = pick(after.list);
  if (!a.length || !b.length) return null;
  if (a.every(m => m.cumulative !== null) && b.every(m => m.cumulative !== null)) {
    const sum = list => list.reduce((total, m) => total + m.cumulative, 0);
    return { cpuMs: +((sum(b) - sum(a)) * 1000).toFixed(1), percent: +(((sum(b) - sum(a)) * 1000) / (after.at - before.at) * 100).toFixed(2) };
  }
  return { percentNow: b.reduce((total, m) => total + m.percent, 0) };
}

async function run(mode, stage) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'soft-bubble-measure-'));
  const profile = path.join(temporary, 'profile'); await mkdir(profile);
  const claude = await createClaudeFixture({ root: temporary, respond: turn => { turn.delta(REPLY); setTimeout(() => turn.done(), 200); } });
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({
    version: 1, model: null, motion: null, provider: claude.provider, persona: 'Synthetic measurement companion.',
    pet: { visible: true, alwaysOnTop: true, clickThrough: false, scale: 1, followMouse: false }, // no-pet-ok: the app's own names (the ?pet window query, #pet-status, settings.pet, updatePetReply, PetUI)
    voice: { enabled: true, voiceURI: '', rate: 1, volume: 0 },
    tts: { provider: 'system', apiHost: '', region: '', model: 'qwen-audio-3.1-tts-flash', voice: 'longanlingxin_v3.1', instruction: '', emotion: 'custom', rate: 1, apiKey: '', introduced: true, styleBindings: [] },
  }));
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile });
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  let instance;
  try {
    instance = await electron.launch({ args: [workspace, `--user-data-dir=${profile}`], cwd: workspace, env, timeout: 30000 });
    await claude.install(instance);
    await instance.firstWindow();
    let controls, companion;
    await waitFor(() => {
      controls = instance.windows().find(page => /index\.html(?:\?|$)/.test(page.url()) && !new URL(page.url()).searchParams.has('pet')); // no-pet-ok: the app's own names (the ?pet window query, #pet-status, settings.pet, updatePetReply, PetUI)
      companion = instance.windows().find(page => /index\.html(?:\?|$)/.test(page.url()) && new URL(page.url()).searchParams.has('pet')); // no-pet-ok: the app's own names (the ?pet window query, #pet-status, settings.pet, updatePetReply, PetUI)
      return Promise.resolve(!!controls && !!companion);
    }, 'control and companion windows');
    await instance.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true })));
    for (const page of [controls, companion]) await page.waitForSelector('#chat-input');
    await controls.evaluate(() => window.desktop.useBundledModel());
    await waitFor(() => companion.evaluate(() => /模型已就绪|VMD 播放中/.test(document.getElementById('pet-status')?.textContent || '')), 'bundled Gene ready', 60000); // no-pet-ok: the app's own names (the ?pet window query, #pet-status, settings.pet, updatePetReply, PetUI)
    if (stage === 'unbound-window') {
      const origin = await companion.evaluate(() => performance.timeOrigin);
      await controls.evaluate(() => localStorage.setItem('soft-hearts.window-engine.v1', JSON.stringify({ on: true, style: 0 })));
      await waitFor(() => companion.evaluate(before => performance.timeOrigin !== before && document.readyState === 'complete' && !!document.querySelector('canvas'), origin),
        'companion window reloaded with the Unbound engine', 60000);
      await pause(6000); // the engine loads her model
    }
    await pause(1500);
    for (const page of [controls, companion]) await installVoice(page);
    await installFrames(companion, false);
    const probe = await installMainProbe(instance);
    const engine = await companion.evaluate(() => localStorage.getItem('soft-hearts.window-engine.v1'));
    // Baseline: she stands, nothing is said.
    const baseStart = await companion.evaluate(() => window.__bfmClock());
    const m0 = await metrics(instance);
    await pause(BASELINE_MS);
    const baseEnd = await companion.evaluate(() => window.__bfmClock());
    const m1 = await metrics(instance);
    // The message; the bubble window exists from the first reply on.
    await controls.evaluate(value => { const input = document.getElementById('chat-input'); input.value = value; document.getElementById('chat-form').requestSubmit(); }, 'MEASURE');
    let bubble;
    await waitFor(() => { bubble = instance.windows().find(page => page.url().endsWith('#soft-hearts-reply')); return Promise.resolve(!!bubble); }, 'bubble window', 30000);
    await bubble.waitForSelector('#reply-body', { state: 'attached' });
    await installFrames(bubble, true);
    await waitFor(() => controls.evaluate(() => window.__bfmSpeech.some(fact => fact[0] === 'start')), 'her first sentence sounds', 30000);
    const m2 = await metrics(instance);
    await waitFor(async () => {
      const facts = await controls.evaluate(() => window.__bfmSpeech);
      const starts = facts.filter(fact => fact[0] === 'start').length, ends = facts.filter(fact => fact[0] === 'end').length;
      const last = facts.at(-1);
      const shown = await bubble.evaluate(() => document.getElementById('reply-body')?.textContent ?? '');
      return starts > 0 && starts === ends && last && Date.now() - last[1] > 1500 && shown === REPLY;
    }, 'the reading ended and the whole reply shows', 120000);
    const m3 = await metrics(instance);
    const facts = await controls.evaluate(() => window.__bfmSpeech);
    const readFrom = facts.find(fact => fact[0] === 'start')[1], readTo = facts.filter(fact => fact[0] === 'end').at(-1)[1], seconds = (readTo - readFrom) / 1000;
    const main = await instance.evaluate(() => globalThis.__bfm);
    const companionFrames = await companion.evaluate(() => ({ frames: window.__bfmFrames, clock: window.__bfmClock() }));
    const bubbleData = await bubble.evaluate(() => ({ frames: window.__bfmFrames, updates: window.__bfmUpdates, clock: window.__bfmClock() }));
    // Wall time → each page's performance clock.
    const toCompanion = wall => companionFrames.clock.perf - (companionFrames.clock.wall - wall), toBubble = wall => bubbleData.clock.perf - (bubbleData.clock.wall - wall);
    const inRead = at => at >= readFrom && at <= readTo;
    const invokes = main.invokes.filter(([, at]) => inRead(at)), baseInvokes = main.invokes.filter(([, at]) => at >= baseStart.wall && at <= baseEnd.wall);
    const byChannel = {};
    for (const [channel] of invokes) byChannel[channel] = (byChannel[channel] ?? 0) + 1;
    const updates = invokes.filter(([channel]) => channel === 'desk:updatePetReply'); // no-pet-ok: the app's own names (the ?pet window query, #pet-status, settings.pet, updatePetReply, PetUI)
    const renders = main.renders.filter(([at]) => inRead(at)), textRenders = renders.filter(([, length]) => length >= 0);
    const bubbleUpdates = bubbleData.updates.filter(([, , wall]) => inRead(wall));
    // Each bubble DOM update: the frame interval that contained it.
    // How far her bubble runs ahead of her voice: for each sentence she starts saying, when the bubble first showed all of it (ms; > 0 = ahead).
    let said = 0; const ahead = [];
    // Only her reply's sentences (the waiting "嗯…" cue is spoken in the same voice): each one where the reply continues.
    for (const [kind, at, length, text] of facts) { if (kind !== 'start' || typeof text !== 'string' || !REPLY.startsWith(text.trim(), said)) continue; said += length; const shownAt = bubbleData.updates.find(([, shown]) => shown >= said); if (shownAt) ahead.push(at - shownAt[2]); }
    const updateFrames = bubbleUpdates.map(([at]) => { const i = bubbleData.frames.findIndex(frame => frame > at); return i > 0 ? bubbleData.frames[i] - bubbleData.frames[i - 1] : null; }).filter(value => value !== null);
    const procs = { main: m => m.type === 'Browser', companion: m => typeof m.url === 'string' && m.url.includes('pet'), bubble: m => typeof m.url === 'string' && m.url.endsWith('#soft-hearts-reply'), gpu: m => m.type === 'GPU' }; // no-pet-ok: the app's own names (the ?pet window query, #pet-status, settings.pet, updatePetReply, PetUI)
    const result = {
      mode, stage, engine, probe, readSeconds: +seconds.toFixed(2),
      perSecond: { invokes: +(invokes.length / seconds).toFixed(2), baselineInvokes: +(baseInvokes.length / (BASELINE_MS / 1000)).toFixed(2), updatePetReply: +(updates.length / seconds).toFixed(2), // no-pet-ok: the app's own names (the ?pet window query, #pet-status, settings.pet, updatePetReply, PetUI)
        replyRenders: +(renders.length / seconds).toFixed(2), replyTextRenders: +(textRenders.length / seconds).toFixed(2), paintReceipts: +(main.acks.filter(inRead).length / seconds).toFixed(2),
        bubbleDomUpdates: +(bubbleUpdates.length / seconds).toFixed(2) },
      topChannels: Object.entries(byChannel).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([channel, count]) => [channel, +(count / seconds).toFixed(2)]),
      mainUpdateMs: stats(updates.map(([, , ms]) => ms)),
      cpu: { baseline: Object.fromEntries(Object.entries(procs).map(([name, select]) => [name, cpuDelta(m0, m1, select)])),
        reading: Object.fromEntries(Object.entries(procs).map(([name, select]) => [name, cpuDelta(m2, m3, select)])) },
      companionFrames: { baseline: frameReport(companionFrames.frames, toCompanion(baseStart.wall), toCompanion(baseEnd.wall)), reading: frameReport(companionFrames.frames, toCompanion(readFrom), toCompanion(readTo)) },
      bubbleAheadOfVoiceMs: stats(ahead), bubbleAheadEach: ahead, speechFacts: facts.slice(0, 64).map(([kind, at, length]) => [kind, at, length]), bubbleTexts: bubbleData.updates.filter(([, , wall]) => wall >= readFrom - 30000).map(([, length, wall]) => [length, wall]).slice(0, 400),
      bubbleFrames: { reading: frameReport(bubbleData.frames, toBubble(readFrom), toBubble(readTo)), framesWithAnUpdate: stats(updateFrames) },
    };
    console.log(`DONE ${mode} / ${stage}: ${result.perSecond.updatePetReply} bubble updates/s, pet ${result.companionFrames.reading.fps} fps (baseline ${result.companionFrames.baseline.fps})`); // no-pet-ok: the app's own names (the ?pet window query, #pet-status, settings.pet, updatePetReply, PetUI)
    return result;
  } finally {
    if (instance) await Promise.race([instance.close(), pause(10000)]).catch(() => {});
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

await mkdir(output, { recursive: true });
const results = [];
if (!skipBuild) execFileSync(node, [path.join(workspace, 'scripts', 'build-electron.mjs')], { cwd: workspace, stdio: 'inherit' });
// 'off': the renderer as before I-165 (text first, voice after), for the before/after numbers.
for (const mode of modesArg) {
  if (!skipBuild || mode !== 'sentence') build(mode);
  for (const stage of runsArg) {
    results.push(await run(mode, stage));
    // Saved after every run: a later failure keeps what was measured.
    await writeFile(path.join(output, 'results.json'), JSON.stringify({ at: new Date().toISOString(), reply: REPLY.length, msPerChar: MS_PER_CHAR, results }, null, 1));
  }
}
if (!skipBuild) build('sentence'); // leave the default build behind
console.table(results.map(r => ({ mode: r.mode, stage: r.stage, 'updates/s': r.perSecond.updatePetReply, 'invokes/s': r.perSecond.invokes, 'base invokes/s': r.perSecond.baselineInvokes, // no-pet-ok: the app's own names (the ?pet window query, #pet-status, settings.pet, updatePetReply, PetUI)
  'text renders/s': r.perSecond.replyTextRenders, 'renders/s': r.perSecond.replyRenders, 'receipts/s': r.perSecond.paintReceipts, 'main ms/update p50': r.mainUpdateMs.p50, 'p95': r.mainUpdateMs.p95,
  'companion fps': r.companionFrames.reading.fps, 'companion base fps': r.companionFrames.baseline.fps, 'companion p95 ms': r.companionFrames.reading.p95, 'companion base p95': r.companionFrames.baseline.p95, // no-pet-ok: the app's own names (the ?pet window query, #pet-status, settings.pet, updatePetReply, PetUI)
  'bubble p95 ms': r.bubbleFrames.reading.p95, 'ahead of voice ms p50': r.bubbleAheadOfVoiceMs.p50, 'ahead max': r.bubbleAheadOfVoiceMs.max })));
console.log(`written ${path.relative(workspace, path.join(output, 'results.json'))}`);
