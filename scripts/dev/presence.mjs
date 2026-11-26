// I-030 (docs/claude/2026-11-04-presence-tray-plan.md): Claude's heavy work follows the user's "我在用电脑" tray check box.
// Checked ("在", also when the tray is gone, its file is missing, unreadable or older than two minutes): one heavy job at a time,
// at below-normal priority on half the cores; the children it starts inherit both. Unchecked ("不在"): no cap.
// Heavy = the full test suite, preparing/packaging a candidate, the isolated smoke, the pretrial. They gate themselves through
// gateHeavy() (or run under scripts/dev/heavy.mjs); a process already gated passes CLAUDE_HEAVY_GATED=1 to its children so a
// nested heavy step (the smoke inside a prepare) never waits for its own parent's slot.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tidyOccupancy } from './occupancy-tidy.mjs';

/** What "在" allows. One place to change: the user may turn the cores down (6) if it still stutters, or up (14) if too slow. */
export const PRESENT_LIMITS = Object.freeze({ maxHeavy: 1, cores: 10, priority: 'BelowNormal' });
const STALE_MS = 2 * 60_000;
export const GATED_ENV = 'CLAUDE_HEAVY_GATED';

/**
 * The folder the tray and Claude share: `%USERPROFILE%\.claude-presence`,
 * outside AppData. The Claude desktop app is a Windows package: everything it starts sees its own private copy of AppData, while
 * the tray (started at sign-in) sees the real one, so one path under AppData was two files. The tray said "不在" for days and
 * Claude read a copy from 11-05 that said nothing current. The user folder is not virtualized: both see the same file.
 */
export function presenceDir(env = process.env) {
  return env.CLAUDE_PRESENCE_DIR || path.join(env.USERPROFILE || os.homedir(), '.claude-presence');
}
/** Where a tray installed before 2026-11-12 still writes, until it is reinstalled; null when a folder is given explicitly. */
export function legacyPresenceDir(env = process.env) {
  return env.CLAUDE_PRESENCE_DIR ? null : path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'claude-presence');
}

/**
 * "在" unless the tray says "不在" and has said so within the last two minutes. With no folder given, a fresh answer in the
 * shared folder wins; without one there, a fresh answer from an older tray's folder is taken.
 */
export function readPresence({ dir, legacy, now = Date.now() } = {}) {
  const main = readPresenceFile(dir ?? presenceDir(), now);
  const old = dir === undefined ? (legacy === undefined ? legacyPresenceDir() : legacy) : (legacy ?? null);
  if (main.reason === 'present' || main.reason === 'away' || !old) return main;
  const fallback = readPresenceFile(old, now);
  return fallback.reason === 'present' || fallback.reason === 'away' ? fallback : main;
}

function readPresenceFile(dir, now) {
  let raw;
  try { raw = readFileSync(path.join(dir, 'presence.json'), 'utf8'); } catch { return { present: true, reason: 'no-tray' }; }
  let state;
  try { state = JSON.parse(raw.replace(/^﻿/u, '')); } catch { return { present: true, reason: 'unreadable' }; }
  const beat = Date.parse(state?.heartbeatAt ?? '');
  if (!Number.isFinite(beat) || now - beat > STALE_MS || beat - now > STALE_MS) return { present: true, reason: 'tray-stale' };
  if (state.present === false) return { present: false, reason: 'away' };
  return { present: true, reason: 'present' };
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };

/** Heavy jobs running now (their slot files), dropping the ones whose process is gone. */
export function liveSlots({ dir = presenceDir(), isAlive = alive, except = null } = {}) {
  const slots = path.join(dir, 'slots');
  let names = [];
  try { names = readdirSync(slots).filter(name => /^\d+\.json$/u.test(name)); } catch { return []; }
  const live = [];
  for (const name of names) {
    const pid = Number(name.slice(0, -5));
    if (!isAlive(pid)) { try { rmSync(path.join(slots, name), { force: true }); } catch { /* Someone else cleans it. */ } continue; }
    if (pid === except) continue;
    let label = '';
    try { label = JSON.parse(readFileSync(path.join(slots, name), 'utf8')).label ?? ''; } catch { /* A slot being written. */ }
    live.push({ pid, label });
  }
  return live;
}

/** May a new heavy job start now? */
export function mayStart(presence, running, limits = PRESENT_LIMITS) {
  return !presence.present || running < limits.maxHeavy;
}

export function takeSlot(label, { dir = presenceDir(), pid = process.pid, now = new Date() } = {}) {
  const slots = path.join(dir, 'slots');
  mkdirSync(slots, { recursive: true });
  const file = path.join(slots, `${pid}.json`);
  writeFileSync(file, JSON.stringify({ pid, label, startedAt: now.toISOString() }) + '\n');
  return () => { try { rmSync(file, { force: true }); } catch { /* Swept by liveSlots. */ } };
}

/** The affinity mask for "在" (the first N cores) or for no cap (every core). */
export function affinityMask(present, cores = os.availableParallelism(), limits = PRESENT_LIMITS) {
  const use = present ? Math.max(1, Math.min(limits.cores, cores)) : cores;
  return use >= 63 ? null : (2 ** use) - 1;
}

/** Windows only: set priority and cores on these processes (and, with `tree`, everything they started). Best effort. */
export function applyLimits(pids, present, { tree = false, run = execFileSync } = {}) {
  if (process.platform !== 'win32' || !pids.length) return false;
  const mask = affinityMask(present);
  const priority = present ? PRESENT_LIMITS.priority : 'Normal';
  const roots = pids.map(Number).filter(Number.isSafeInteger).join(',');
  const script = [
    `$roots = @(${roots});`,
    '$all = @($roots);',
    tree ? '$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId; $added = $true; while ($added) { $added = $false; foreach ($p in $procs) { if ($all -notcontains $p.ProcessId -and $all -contains $p.ParentProcessId) { $all += $p.ProcessId; $added = $true } } }' : '',
    `foreach ($id in $all) { try { $p = Get-Process -Id $id -ErrorAction Stop; $p.PriorityClass = '${priority}';${mask === null ? '' : ` $p.ProcessorAffinity = [IntPtr]${mask};`} } catch { } }`,
  ].join(' ');
  try { run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true, timeout: 30_000 }); return true; }
  catch { return false; }
}

const sleep = ms => new Promise(done => setTimeout(done, ms));

/**
 * Wait for a heavy slot (only while "在" and another heavy job runs), take it, limit this process (its children inherit), and
 * follow the check box while running: switching to "在" limits this process and everything it started, "不在" lifts it.
 * Already gated (CLAUDE_HEAVY_GATED=1): nothing to do. Returns the release function (also run on exit).
 */
/**
 * Codex X-403 (2026-11-11): our heavy jobs also put one line on the bridge's 真机占用.md while they run, so Codex can plan its
 * own heavy windows around them; the line is removed when the job ends (also on a crash, through process 'exit'). No bridge
 * file (another computer), no maintainer tooling (the public snapshot leaves out scripts/pretrial and scripts/test-env) or a
 * write error: nothing happens. Returns the remover.
 */
async function occupancyHelpers() {
  try {
    const [files, lib] = await Promise.all([import('../pretrial/files.mjs'), import('../test-env/lib.mjs')]); // optional: left out of the public snapshot
    return { addOccupancy: files.addOccupancy, removeOccupancy: files.removeOccupancy, formatOccupancyLine: files.formatOccupancyLine, file: lib.OCCUPANCY_FILE };
  } catch { return null; }
}

export async function registerHeavyOccupancy(label, { now = new Date(), pid = process.pid, log = () => {}, helpers = null, file = null, lookup = undefined } = {}) {
  const tools = helpers ?? await occupancyHelpers();
  if (!tools) return () => {};
  const { addOccupancy, removeOccupancy, formatOccupancyLine } = tools;
  file ??= tools.file;
  const pad = value => String(value).padStart(2, '0');
  const offset = -now.getTimezoneOffset(), sign = offset < 0 ? '-' : '+';
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const clean = String(label).replace(/[\r\n|｜]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 80) || 'heavy job';
  let line;
  try {
    line = formatOccupancyLine({ who: `Claude 重活 pid ${pid}（scripts/dev/presence.mjs）`, start: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} ${zone}`,
      end: '跑完自动删掉这一行', purpose: `${clean}；无屏幕、无模型调用；按用户的 I-030：用户在用电脑时同时只跑一件、低优先级、${PRESENT_LIMITS.cores} 核` });
    // 2026-11-16: lines left behind by killed jobs of ours are cleared first, so Codex does not wait for a job that is gone.
    writeFileSync(file, addOccupancy(tidyOccupancy(readFileSync(file, 'utf8'), { lookup }).text, line), 'utf8');
  } catch { return () => {}; }
  log(`[真机占用] 登记：${line}`);
  let removed = false;
  return () => {
    if (removed) return; removed = true;
    try { writeFileSync(file, tidyOccupancy(removeOccupancy(readFileSync(file, 'utf8'), line), { lookup }).text, 'utf8'); } catch { /* The bridge went away; nothing to clean. */ }
  };
}

/** The lines other workers (Codex) have under the sign's 「当前登记」 right now; ours start with "Claude". */
export function otherOccupancy(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const header = lines.findIndex(value => /^##\s*当前登记\s*$/u.test(value));
  if (header < 0) return [];
  const out = [];
  for (let index = header + 1; index < lines.length && !/^##\s/u.test(lines[index]); index++) {
    const line = lines[index].trim();
    if (line && !line.startsWith('<!--') && !/^(?:[-*]\s*)?Claude[\s/]/u.test(line)) out.push(line);
  }
  return out;
}

/**
 * The latest deadline a line states ("绝对截止 2026-11-11 05:05:13 -08:00", "最迟 …", "截止 …"), in ms; null when it states none.
 * A time without a zone is read as this computer's local time.
 */
export function occupancyDeadline(line) {
  let latest = null;
  for (const match of String(line).matchAll(/(?:绝对截止|截止|最迟)\s*[:：]?\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:\d{2})?/gu)) {
    const at = Date.parse(`${match[1]}T${match[2].length === 5 ? `${match[2]}:00` : match[2]}${match[3] ?? ''}`);
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

/**
 * Codex C-211 / X-413 (2026-11-11): one heavy job at a time across both of us. Before starting, wait while another worker has a
 * line on the sign. A line that states a deadline is waited for until it is taken off, or until that deadline plus
 * `graceMs` has passed (then it is a forgotten line and we say so); there is no fixed timeout for it. Only a line that
 * states no deadline at all is waited for at most `noDeadlineMaxMs`. `read` returns the sign's text, or null when there is none.
 */
export async function waitForOthers(read, { noDeadlineMaxMs = 60 * 60_000, graceMs = 5 * 60_000, pollMs = 5_000, log = () => {}, label = '', wait = sleep, clock = () => Date.now() } = {}) {
  const started = clock();
  let announced = false;
  for (;;) {
    let others = [];
    try { others = otherOccupancy(read() ?? ''); } catch { return 'no-sign'; }
    const now = clock();
    const live = others.filter(line => {
      const deadline = occupancyDeadline(line);
      return deadline === null ? now - started < noDeadlineMaxMs : now <= deadline + graceMs;
    });
    if (!live.length) {
      if (others.length) log(`[真机占用] 对方还留着登记，但已过它自己写的截止时间（或没写截止、已等 ${Math.round(noDeadlineMaxMs / 60_000)} 分钟），当作忘了撤，"${label}" 开始：${others[0].slice(0, 80)}`);
      else if (announced) log(`[真机占用] 对方的登记撤了，"${label}" 开始。`);
      return others.length ? 'stale' : announced ? 'waited' : 'free';
    }
    if (!announced) { log(`[真机占用] 对方正在跑重活（${live[0].slice(0, 80)}），"${label}" 等它做完、撤掉登记再开始。`); announced = true; }
    await wait(pollMs);
  }
}

export async function gateHeavy(label, { log = line => console.error(line), pollMs = 5_000, env = process.env, occupancy = true } = {}) {
  if (env[GATED_ENV] === '1') return () => {};
  if (occupancy && env.CLAUDE_HEAVY_IGNORE_OTHERS !== '1') {
    const tools = await occupancyHelpers();
    if (tools) await waitForOthers(() => { try { return readFileSync(tools.file, 'utf8'); } catch { return null; } }, { pollMs, log, label });
  }
  let announced = false;
  for (;;) {
    const presence = readPresence();
    const running = liveSlots({ except: process.pid });
    if (mayStart(presence, running.length)) break;
    if (!announced) {
      log(`[我在用电脑] 你在用电脑：同时只跑 ${PRESENT_LIMITS.maxHeavy} 件重活。"${label}" 排队，等 ${running.map(slot => slot.label || slot.pid).join('、')} 做完。`);
      announced = true;
    }
    await sleep(pollMs);
  }
  const slot = takeSlot(label);
  const unregister = occupancy ? await registerHeavyOccupancy(label, { log }) : () => {};
  const release = () => { slot(); unregister(); };
  env[GATED_ENV] = '1';
  let present = readPresence().present;
  applyLimits([process.pid], present);
  if (present) log(`[我在用电脑] "${label}"：低优先级，只用 ${PRESENT_LIMITS.cores} 个核。`);
  const watch = setInterval(() => {
    const now = readPresence().present;
    if (now === present) return;
    present = now;
    applyLimits([process.pid], present, { tree: true });
    log(present ? `[我在用电脑] 你回来了："${label}" 降到低优先级、${PRESENT_LIMITS.cores} 个核。` : `[我在用电脑] 你不在："${label}" 放开。`);
  }, pollMs);
  watch.unref?.();
  let done = false;
  const finish = () => { if (done) return; done = true; clearInterval(watch); release(); };
  process.once('exit', finish);
  return finish;
}

/** `node scripts/dev/presence.mjs --tidy`: clear our stale lines on the sign now; prints what it removed. */
export async function tidyOccupancyFile({ file = null, lookup = undefined, now = Date.now(), log = console.log } = {}) {
  file ??= (await occupancyHelpers())?.file;
  if (!file) { log('[真机占用] 没有找到沟通桥的登记文件，什么都没动。'); return []; }
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { log('[真机占用] 读不到登记文件，什么都没动。'); return []; }
  const result = tidyOccupancy(text, { lookup, now });
  if (result.removed.length) writeFileSync(file, result.text, 'utf8');
  log(result.removed.length ? `[真机占用] 清掉 ${result.removed.length} 条过期的登记：\n${result.removed.map(line => `  ${line}`).join('\n')}` : '[真机占用] 没有过期的登记，什么都没删。');
  return result.removed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--tidy')) await tidyOccupancyFile();
