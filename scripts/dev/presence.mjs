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

/** What "在" allows. One place to change: the user may turn the cores down (6) if it still stutters, or up (14) if too slow. */
export const PRESENT_LIMITS = Object.freeze({ maxHeavy: 1, cores: 10, priority: 'BelowNormal' });
const STALE_MS = 2 * 60_000;
export const GATED_ENV = 'CLAUDE_HEAVY_GATED';

export function presenceDir(env = process.env) {
  return env.CLAUDE_PRESENCE_DIR || path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'claude-presence');
}

/** "在" unless the tray says "不在" and has said so within the last two minutes. */
export function readPresence({ dir = presenceDir(), now = Date.now() } = {}) {
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
export async function gateHeavy(label, { log = line => console.error(line), pollMs = 5_000, env = process.env } = {}) {
  if (env[GATED_ENV] === '1') return () => {};
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
  const release = takeSlot(label);
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
