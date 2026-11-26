// Baseline for the program overhaul (docs/claude/2026-11-15-overhaul-plan.md section 六 item 3): how fast she appears and what
// she costs while idle, measured on ONE packaged build in a throw-away profile. Run it before and after, compare the JSON.
//   node scripts/dev/heavy.mjs --label baseline -- node scripts/dev/baseline.mjs --exe <path\to\soft hearts next.exe> [--runs 3]
//        [--settle 30] [--sample 60] [--interval 2] [--with-chat] [--out <folder>]
// The exe may also come from MMD_TEST_EXE. Isolation is the smoke's own (scripts/lib/smoke-isolation.mjs): a temp folder named
// soft-hearts-smoke-*, with its own profile, empty Codex/Claude homes, LOCALAPPDATA, an inert Claude placeholder and the fake Claude
// Code. Nothing under %APPDATA% is read or written. See docs/claude/2026-11-16-baseline-tool.md.
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isOwnExecutable, isCodexProfilePath } from '../lib/app-identity.mjs';
import { FAKE_CLAUDE_MARKER, FAKE_CLAUDE_REPLY } from '../lib/fake-claude.mjs';
import { CLAUDE_PLACEHOLDER_TEXT, SMOKE_CLAUDE_MODEL, assertOwnedProfile, childEnvironment, installClaudeInterposer, rejectExternalSmokeFlags } from '../lib/smoke-isolation.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WIN = process.platform === 'win32';
const system32 = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32');

// ---------- pure parts (tests/baseline.test.mjs) ----------

/** Sorted-copy median; null for an empty list. */
export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
/** Median, min, max, n and the spread (max - min); numbers rounded to 1 decimal. */
export function summarize(values) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return { n: 0, median: null, min: null, max: null, spread: null };
  const r = x => Math.round(x * 10) / 10, lo = Math.min(...v), hi = Math.max(...v);
  return { n: v.length, median: r(median(v)), min: r(lo), max: r(hi), spread: r(hi - lo) };
}
/** Chromium process type from a command line: --type=gpu-process, renderer, utility (with its --utility-sub-type), crashpad-handler ... ; none = the main process. */
export function processType(commandLine, name = '') {
  const text = String(commandLine ?? '');
  const type = /--type=([\w-]+)/u.exec(text)?.[1];
  if (!type) return /\.exe$/iu.test(name) && /electron|soft hearts/iu.test(name) ? 'main' : 'other';
  if (type === 'utility') { const sub = /--utility-sub-type=([\w.]+)/u.exec(text)?.[1]; return sub ? 'utility:' + sub.split('.').at(-1) : 'utility'; }
  return type === 'gpu-process' ? 'gpu' : type;
}
/** Windows file times are 100 ns ticks. */
export const ticksToSeconds = ticks => Number(ticks) / 1e7;
/** Rows of Win32_Process (ProcessId, ParentProcessId, Name, CommandLine, KernelModeTime, UserModeTime, WorkingSetSize, PrivatePageCount) -> the root and everything under it. */
export function descendants(rows, rootPid) {
  const byParent = new Map();
  for (const row of rows) { const list = byParent.get(row.ParentProcessId) ?? []; list.push(row); byParent.set(row.ParentProcessId, list); }
  const out = [], seen = new Set(), stack = rows.filter(row => row.ProcessId === rootPid);
  while (stack.length) {
    const row = stack.pop();
    if (seen.has(row.ProcessId)) continue;
    seen.add(row.ProcessId); out.push(row);
    for (const child of byParent.get(row.ProcessId) ?? []) stack.push(child);
  }
  return out;
}
/** One sample: per process {pid, type, cpuSeconds, workingSet, privateBytes}. */
export function toSample(rows, rootPid, at) {
  return { at, processes: descendants(rows, rootPid).map(row => ({ pid: row.ProcessId, type: processType(row.CommandLine, row.Name),
    cpuSeconds: ticksToSeconds(Number(row.KernelModeTime) + Number(row.UserModeTime)), workingSet: Number(row.WorkingSetSize), privateBytes: Number(row.PrivatePageCount) })) };
}
/**
 * Between consecutive samples: CPU % of ONE core (100 = one core fully busy; may exceed 100), summed and per type, and memory at the
 * later sample. A process seen in only one sample (started or ended in between) counts its CPU only if it is in both.
 */
export function intervalStats(prev, next) {
  const wall = (next.at - prev.at) / 1000;
  const before = new Map(prev.processes.map(p => [p.pid, p]));
  const cpu = { total: 0 }, mem = { total: { workingSet: 0, privateBytes: 0 } };
  for (const p of next.processes) {
    const was = before.get(p.pid), d = was ? Math.max(0, p.cpuSeconds - was.cpuSeconds) / wall * 100 : 0;
    cpu.total += d; cpu[p.type] = (cpu[p.type] ?? 0) + d;
    mem.total.workingSet += p.workingSet; mem.total.privateBytes += p.privateBytes;
    mem[p.type] ??= { workingSet: 0, privateBytes: 0 };
    mem[p.type].workingSet += p.workingSet; mem[p.type].privateBytes += p.privateBytes;
  }
  return { wall, cpu, mem, count: next.processes.length };
}
/** All samples -> per group (total and each type): CPU % summary and memory (MB) summary. */
export function summarizeSamples(samples) {
  const intervals = []; for (let i = 1; i < samples.length; i++) intervals.push(intervalStats(samples[i - 1], samples[i]));
  const groups = new Set(['total']); for (const it of intervals) for (const key of [...Object.keys(it.cpu), ...Object.keys(it.mem)]) groups.add(key);
  const MB = 1024 * 1024, result = {};
  for (const group of groups) {
    result[group] = { cpuPercent: summarize(intervals.map(it => it.cpu[group] ?? 0)),
      workingSetMB: summarize(intervals.map(it => (it.mem[group]?.workingSet ?? 0) / MB)), privateMB: summarize(intervals.map(it => (it.mem[group]?.privateBytes ?? 0) / MB)) };
  }
  return { intervals: intervals.length, processCount: summarize(intervals.map(it => it.count)), groups: result };
}
/** Command-line options. */
export function parseArgs(argv, env = {}) {
  const o = { exe: env.MMD_TEST_EXE ?? null, runs: 3, settle: 30, sample: 60, interval: 2, withChat: false, out: null, deadline: 900, lateControls: false };
  const num = (name, value) => { const n = Number(value); if (!Number.isFinite(n) || n <= 0) throw Error(`${name} needs a positive number`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--with-chat') o.withChat = true;
    else if (a === '--late-controls') o.lateControls = true; // overhaul step 8: the measured start with SOFT_HEARTS_LATE_CONTROLS=1 (the control window loads on first show)
    else if (a === '--exe') o.exe = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--runs') o.runs = num(a, argv[++i]);
    else if (a === '--settle') o.settle = num(a, argv[++i]);
    else if (a === '--sample') o.sample = num(a, argv[++i]);
    else if (a === '--interval') o.interval = num(a, argv[++i]);
    else if (a === '--deadline') o.deadline = num(a, argv[++i]);
    else throw Error('Unknown option ' + a);
  }
  if (!o.exe) throw Error('Give the packaged executable with --exe <path> (or MMD_TEST_EXE).');
  if (!Number.isInteger(o.runs)) throw Error('--runs must be a whole number');
  return o;
}

// ---------- process sampling (Windows, no dependencies) ----------

const ps = path.join(system32, 'WindowsPowerShell/v1.0/powershell.exe');
const SAMPLE_SCRIPT = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,KernelModeTime,UserModeTime,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress";
function readProcessRows() {
  const text = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', SAMPLE_SCRIPT], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const rows = JSON.parse(text); return Array.isArray(rows) ? rows : [rows];
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pidGone = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
function killTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { execFileSync(path.join(system32, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* already gone */ }
}

/** Sample the tree under rootPid every `interval` s for `duration` s; the time stamp is the midpoint of the (slow) PowerShell call. */
async function sampleTree(rootPid, duration, interval) {
  const samples = [], end = Date.now() + duration * 1000;
  while (Date.now() < end) {
    const t0 = Date.now(), rows = readProcessRows(), t1 = Date.now();
    samples.push(toSample(rows, rootPid, (t0 + t1) / 2));
    await sleep(Math.max(0, interval * 1000 - (Date.now() - t0)));
  }
  return samples;
}

// ---------- first-frame probe, injected into every window before its scripts run ----------

/**
 * Self-contained (it is serialised into the page). Writes window.__baseline = epoch-ms milestones:
 *  canvasAt     first <canvas> in the document (the Three.js stage mounted)
 *  rafAt        first animation frame after the canvas exists
 *  readyAt      the status line (#pet-status / #stage-status) first says the model is ready (模型已就绪, or its translation "Model ready")
 *  frameAt      the first animation frame after readyAt = "first rendered frame with the character"
 *  chatInputAt  #chat-input exists (the control window's chat page is usable)
 */
export function installFrameProbe() {
  const origin = () => performance.timeOrigin + performance.now();
  const marks = window.__baseline = { href: location.href, canvasAt: null, rafAt: null, readyAt: null, frameAt: null, chatInputAt: null };
  const ready = /模型已就绪|Model ready|ready/iu;
  const check = () => {
    const now = origin();
    if (marks.canvasAt === null && document.querySelector('canvas')) { marks.canvasAt = now; requestAnimationFrame(() => { marks.rafAt = origin(); }); }
    if (marks.chatInputAt === null && document.getElementById('chat-input')) marks.chatInputAt = now;
    if (marks.readyAt === null) {
      const text = (document.getElementById('pet-status')?.textContent ?? '') + ' ' + (document.getElementById('stage-status')?.textContent ?? '');
      if (ready.test(text)) { marks.readyAt = now; requestAnimationFrame(() => requestAnimationFrame(() => { marks.frameAt = origin(); })); }
    }
    if (marks.readyAt !== null && marks.canvasAt !== null && marks.chatInputAt !== null && marks.frameAt !== null) observer.disconnect();
  };
  const observer = new MutationObserver(check);
  const start = () => { observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true }); check(); };
  if (document.documentElement) start(); else document.addEventListener('readystatechange', start, { once: true });
}

// ---------- one run ----------

let livePid = null;
async function oneRun(options, index, exe, log) {
  const root = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), 'soft-hearts-smoke-baseline-')));
  const owned = { root, profile: path.join(root, 'profile'), codexHome: path.join(root, 'codex-home'), sentinel: path.join(root, 'must-not-exist-codex.exe'),
    claudeHome: path.join(root, 'claude-home'), claudePlaceholder: path.join(root, 'claude-placeholder.exe'), fakeLog: path.join(root, 'fake-claude'),
    localAppData: path.join(root, 'local-app-data'), marker: JSON.stringify({ version: 1, nonce: randomUUID(), baseline: true }) };
  const result = { run: index + 1, error: null };
  let instance = null, mainPid = null;
  try {
    for (const directory of [owned.profile, owned.codexHome, owned.claudeHome, owned.fakeLog, owned.localAppData]) await mkdir(directory);
    await writeFile(path.join(owned.profile, 'smoke-owner.json'), owned.marker, { flag: 'wx' });
    await writeFile(owned.claudePlaceholder, CLAUDE_PLACEHOLDER_TEXT, { flag: 'wx', mode: 0o700 });
    // Default settings except the chat connection (Claude, fixed alias): no companion.* keys, so the app's own defaults (FPS included) apply.
    await writeFile(path.join(owned.profile, 'settings.json'), JSON.stringify({ version: 1, provider: { kind: 'claude', model: SMOKE_CLAUDE_MODEL } }));
    await assertOwnedProfile(owned);
    const expected = { ...owned, kind: 'claude', model: SMOKE_CLAUDE_MODEL, fakeNode: process.execPath, fakeScript: path.join(source, 'scripts', 'lib', 'fake-claude.mjs'), fakeMarker: FAKE_CLAUDE_MARKER };

    // Setup launch (not measured): like the user's stable app, the measured start opens a profile that already has her model.
    {
      const first = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${owned.profile}`], cwd: source, env: childEnvironment(process.env, owned), timeout: 60000 });
      const firstPid = first.process().pid; livePid = firstPid;
      try {
        await first.evaluate(installClaudeInterposer, expected);
        await first.firstWindow();
        let control = null;
        for (let i = 0; i < 600 && !control; i++) { control = first.windows().find(w => /index\.html(?:\?|$)/u.test(w.url()) && !new URL(w.url()).searchParams.has('pet')); if (!control) await sleep(100); }
        if (!control) throw Error('Setup: the control window did not open.');
        await control.waitForSelector('#chat-input', { timeout: 60000 });
        await control.evaluate(() => window.desktop.useBundledModel());
        const set = await control.evaluate(async () => !!(await window.desktop.getSettings()).model);
        if (!set) throw Error('Setup: the bundled model was not selected.');
      } finally {
        await Promise.race([first.close().catch(() => {}), sleep(8000)]);
        for (let i = 0; i < 50 && !pidGone(firstPid); i++) { if (i === 25) killTree(firstPid); await sleep(100); }
        killTree(firstPid);
      }
      await sleep(500);
    }

    const launchAt = Date.now();
    instance = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${owned.profile}`], cwd: source, env: { ...childEnvironment(process.env, owned), ...(options.lateControls ? { SOFT_HEARTS_LATE_CONTROLS: '1' } : {}) }, timeout: 60000 });
    const launchedAt = Date.now();
    mainPid = instance.process().pid; livePid = mainPid;
    await instance.context().addInitScript(installFrameProbe); // before the windows' own scripts, as far as Playwright can get
    // Never measure a process that is not on the owned profile.
    const userData = await instance.evaluate(({ app }) => app.getPath('userData'));
    if (path.resolve(userData).toLowerCase() !== path.resolve(owned.profile).toLowerCase() || isCodexProfilePath(userData)) throw Error('The app is not on the owned profile: ' + userData);
    await instance.evaluate(installClaudeInterposer, expected);
    await instance.firstWindow();
    const find = pet => instance.windows().find(w => /index\.html(?:\?|$)/u.test(w.url()) && new URL(w.url()).searchParams.has('pet') === pet);
    const deadline = Date.now() + 60000;
    let petPage, controlPage;
    // --late-controls: the control window's page is not loaded at start-up, so only the companion's is waited for.
    while (Date.now() < deadline && !((petPage = find(true)) && (options.lateControls || (controlPage = find(false))))) await sleep(50);
    if (!petPage) throw Error('The pet window did not open.');
    const read = async page => page ? page.evaluate(() => ({ ...window.__baseline, timeOrigin: performance.timeOrigin })).catch(() => null) : null;
    // Wait for the character's first frame on the companion stage (up to 60 s), then the control window's marks.
    let pet = null, control = null;
    while (Date.now() < deadline) {
      pet = await read(petPage); control = await read(controlPage);
      if (pet?.frameAt && (!controlPage || control?.chatInputAt)) break;
      await sleep(100);
    }
    const settings = await (controlPage ?? petPage).evaluate(() => window.desktop.getSettings()).catch(() => null);
    result.statusText = await Promise.all([petPage, controlPage].map(p => p ? p.evaluate(() => ({ pet: document.getElementById('pet-status')?.textContent ?? null, stage: document.getElementById('stage-status')?.textContent ?? null, canvases: document.querySelectorAll('canvas').length })).catch(() => null) : null));
    result.settings = { petFps: settings?.pet?.fps ?? null, petVisible: settings?.pet?.visible ?? null, hasModel: !!settings?.model, note: 'default settings; only the chat connection and the bundled Gene model are set' };
    const ms = (t, from = launchAt) => (Number.isFinite(t) ? Math.round(t - from) : null);
    result.coldStartMs = {
      mainProcessReady: launchedAt - launchAt, // Playwright connected to the new main process
      petWindowLoaded: ms(pet?.timeOrigin), // the companion page's navigation start
      petCanvas: ms(pet?.canvasAt), petFirstFrameNoModel: ms(pet?.rafAt),
      petModelReady: ms(pet?.readyAt), petFirstFrame: ms(pet?.frameAt),
      controlWindowLoaded: ms(control?.timeOrigin), controlChatInput: ms(control?.chatInputAt), controlCanvas: ms(control?.canvasAt),
      controlModelReady: ms(control?.readyAt),
    };
    result.firstFrameSignal = pet?.frameAt ? 'pet #pet-status says ready, then the second animation frame' : (pet?.rafAt ? 'FALLBACK: first animation frame after the canvas (no ready status seen)' : 'none observed');
    log(`run ${index + 1}: cold start first frame ${result.coldStartMs.petFirstFrame ?? 'n/a'} ms`);

    // Idle cost.
    log(`run ${index + 1}: settling ${options.settle} s, then sampling ${options.sample} s every ${options.interval} s`);
    await sleep(options.settle * 1000);
    const samples = await sampleTree(mainPid, options.sample, options.interval);
    result.idle = { settleSeconds: options.settle, sampleSeconds: options.sample, intervalSeconds: options.interval, ...summarizeSamples(samples) };
    log(`run ${index + 1}: idle total CPU median ${result.idle.groups.total.cpuPercent.median}% of one core, private ${result.idle.groups.total.privateMB.median} MB`);

    if (options.withChat && controlPage) result.chat = await chatTurn(controlPage, owned, log);
  } catch (error) {
    result.error = String(error?.stack ?? error).split('\n').slice(0, 4).join(' | ');
    log(`run ${index + 1}: FAILED ${result.error}`);
  } finally {
    // Always: close, end the whole tree, remove the profile.
    if (instance) await Promise.race([instance.close().catch(() => {}), sleep(8000)]);
    if (mainPid) { for (let i = 0; i < 50 && !pidGone(mainPid); i++) { if (i === 25) killTree(mainPid); await sleep(100); } killTree(mainPid); }
    for (let i = 0; i < 20; i++) { try { await rm(root, { recursive: true, force: true }); break; } catch { await sleep(250); } }
    result.cleanup = { mainGone: mainPid ? pidGone(mainPid) : true, profileRemoved: !existsSync(root) };
  }
  return result;
}

/** One chat turn to the fake Claude Code: send -> the first character of the assistant bubble is on screen. */
async function chatTurn(page, owned, log) {
  await page.evaluate(() => document.getElementById('new-chat')?.click());
  const timing = await page.evaluate(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const input = document.getElementById('chat-input'), send = document.getElementById('send-chat');
    if (!input || !send) return { error: 'chat controls not found' };
    const count = () => document.querySelectorAll('.message.assistant').length;
    const before = count();
    let firstChar = null;
    const seen = () => { const last = [...document.querySelectorAll('.message.assistant')].slice(before).at(-1); return !!last && (last.textContent ?? '').trim().length > 0; };
    const observer = new MutationObserver(() => { if (firstChar === null && seen()) firstChar = performance.now(); });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    nativeSet.call(input, '你好'); input.dispatchEvent(new Event('input', { bubbles: true }));
    const t0 = performance.now(); send.click();
    let done = null;
    for (let i = 0; i < 300; i++) { await wait(100); if (document.getElementById('chat-state')?.textContent === '回复完成') { done = performance.now(); break; } }
    observer.disconnect();
    return { firstCharMs: firstChar === null ? null : Math.round(firstChar - t0), completeMs: done === null ? null : Math.round(done - t0) };
  });
  const { readFakeClaudeLogs } = await import('../lib/fake-claude.mjs');
  const turns = readFakeClaudeLogs(owned.fakeLog).turns.filter(turn => turn.parsed !== false);
  log(`chat: first visible character ${timing.firstCharMs ?? 'n/a'} ms`);
  return { ...timing, fakeTurnsReceived: turns.length, note: 'fake Claude Code streams ' + FAKE_CLAUDE_REPLY.length + ' deltas with a short gap; compare before/after, not against real Claude' };
}

// ---------- report ----------

export function aggregate(runs) {
  const ok = runs.filter(run => !run.error);
  const coldKeys = new Set(ok.flatMap(run => Object.keys(run.coldStartMs ?? {}))), cold = {};
  for (const key of coldKeys) cold[key] = summarize(ok.map(run => run.coldStartMs[key]));
  const groups = new Set(ok.flatMap(run => Object.keys(run.idle?.groups ?? {}))), idle = {};
  for (const group of groups) idle[group] = {
    cpuPercent: summarize(ok.map(run => run.idle.groups[group]?.cpuPercent.median)),
    workingSetMB: summarize(ok.map(run => run.idle.groups[group]?.workingSetMB.median)),
    privateMB: summarize(ok.map(run => run.idle.groups[group]?.privateMB.median)) };
  const chat = ok.filter(run => run.chat && !run.chat.error);
  return { runsOk: ok.length, runsFailed: runs.length - ok.length, coldStartMs: cold, idle,
    processCount: summarize(ok.map(run => run.idle?.processCount.median)),
    chat: chat.length ? { firstCharMs: summarize(chat.map(run => run.chat.firstCharMs)), completeMs: summarize(chat.map(run => run.chat.completeMs)) } : null };
}
export function markdown(report) {
  const a = report.summary, f = x => (x?.median === null || x?.median === undefined ? '无' : `${x.median}（${x.min}–${x.max}）`);
  const lines = [`# 基线测量 ${report.startedAt}`, '',
    `- 构建：\`${report.exe}\`（${report.exeBytes} 字节，修改于 ${report.exeModified}）`,
    `- 次数：${a.runsOk} 次成功，${a.runsFailed} 次失败；每个数字写作 中位数（最小–最大）`,
    `- 机器：${report.machine.cpu}，${report.machine.cores} 个逻辑核，${report.machine.memGB} GB；默认设置，宠物帧率设置 ${report.runs.find(r => r.settings)?.settings.petFps ?? '未读到'}`,
    `- 首帧信号：${report.runs.find(r => r.firstFrameSignal)?.firstFrameSignal ?? '无'}`, '', '## 冷启动（毫秒，从启动进程算起）', ''];
  const names = { mainProcessReady: '主进程可连接', petWindowLoaded: '宠物窗口开始加载', petCanvas: '宠物舞台画布出现', petModelReady: '宠物说“模型已就绪”', petFirstFrame: '宠物首帧（角色画出来）', controlWindowLoaded: '控制窗口开始加载', controlChatInput: '控制窗口聊天可用', petFirstFrameNoModel: '画布后第一帧（不含模型）', controlCanvas: '控制窗口画布', controlModelReady: '控制窗口模型就绪' };
  for (const [key, label] of Object.entries(names)) if (a.coldStartMs[key]) lines.push(`- ${label}：${f(a.coldStartMs[key])}`);
  lines.push('', '## 空闲代价（先静置后采样；CPU 以单核 100% 计，可以超过 100）', '', '| 进程类别 | CPU % | 工作集 MB | 私有 MB |', '|---|---|---|---|');
  for (const [group, v] of Object.entries(a.idle).sort((x, y) => (x[0] === 'total' ? -1 : y[0] === 'total' ? 1 : x[0].localeCompare(y[0]))))
    lines.push(`| ${group === 'total' ? '合计' : group} | ${f(v.cpuPercent)} | ${f(v.workingSetMB)} | ${f(v.privateMB)} |`);
  lines.push('', `进程个数：${f(a.processCount)}`);
  if (a.chat) lines.push('', '## 聊天一轮（假 Claude）', '', `- 发送到第一个字可见：${f(a.chat.firstCharMs)} 毫秒`, `- 发送到回复完成：${f(a.chat.completeMs)} 毫秒`);
  lines.push('', '## 每次运行', '');
  for (const run of report.runs) lines.push(`- 第 ${run.run} 次：${run.error ? '失败 ' + run.error : `首帧 ${run.coldStartMs.petFirstFrame ?? '无'} ms，空闲合计 CPU ${run.idle.groups.total.cpuPercent.median}%，私有 ${run.idle.groups.total.privateMB.median} MB`}；清理 ${run.cleanup.mainGone && run.cleanup.profileRemoved ? '干净' : '有残留 ' + JSON.stringify(run.cleanup)}`);
  return lines.join('\n') + '\n';
}

// ---------- main ----------

async function main() {
  rejectExternalSmokeFlags(process.env);
  if (!WIN) throw Error('The baseline samples Windows processes (Get-CimInstance); run it on Windows.');
  const options = parseArgs(process.argv.slice(2), process.env);
  const exe = await realpath(path.resolve(options.exe));
  if (!isOwnExecutable(exe)) throw Error('--exe must be "soft hearts next.exe" (never the Codex edition).');
  if (isCodexProfilePath(exe)) throw Error('That path is inside the Codex profile folder.');
  const startedAt = new Date(), stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const out = path.resolve(options.out ?? path.join(source, '.local', 'baseline', stamp));
  await mkdir(out, { recursive: true });
  const log = line => console.log(`[baseline ${new Date().toISOString().slice(11, 19)}] ${line}`);
  const fs = await import('node:fs');
  const stat = fs.statSync(exe);
  const cpus = os.cpus();
  const report = { startedAt: startedAt.toISOString(), exe, exeBytes: stat.size, exeModified: stat.mtime.toISOString(), options: { ...options, exe: undefined },
    machine: { cpu: cpus[0]?.model?.trim() ?? '?', cores: cpus.length, memGB: Math.round(os.totalmem() / 2 ** 30) }, runs: [], summary: null };
  const save = async () => { report.summary = aggregate(report.runs); await writeFile(path.join(out, 'baseline.json'), JSON.stringify(report, null, 2) + '\n'); await writeFile(path.join(out, 'baseline.md'), markdown(report)); };
  // A deadline that cannot leave Electron behind: end the app's tree. oneRun's own finally cleans the profile when it unwinds.
  const timer = setTimeout(() => { log('deadline exceeded; ending the app tree'); killTree(livePid); }, options.deadline * 1000 * options.runs);
  timer.unref?.();
  try {
    for (let i = 0; i < options.runs; i++) {
      const run = await oneRun(options, i, exe, log);
      report.runs.push(run); await save();
    }
  } finally { clearTimeout(timer); }
  await save();
  console.log(markdown(report));
  log('written to ' + out);
  process.exitCode = report.summary.runsOk === 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error(error.message ?? error); process.exit(1); });
