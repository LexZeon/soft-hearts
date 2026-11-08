// Resource probe for the warm haiku (electron/inner-loop/warm-line.ts, docs/claude/2026-11-07-reactions-warm-haiku.md). No model
// call: the real Claude Code process is started and left idle (Claude Code sends nothing before its first message).
//   1. CPU and memory of the booted, idle process (its child processes included) over --seconds (default 60).
//   2. dispose() (the app's quit path): the process is gone.
//   3. The owner killed without any cleanup (a crash): does Claude Code still exit by itself (its stdin closes)?
// Run: node node_modules/tsx/dist/cli.mjs scripts/lib/warm-haiku-resources.ts [--seconds 60]
// The script runs part 3 by starting itself with --orphan-child.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { ClaudeChatProcess } from '../../electron/claude-process';
import { WarmLine } from '../../electron/inner-loop/warm-line';

const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const SYSTEM = '你是测试用的进程，什么都不用做。';

/** CPU ms, working set and private bytes of a process and all its descendants (Windows). */
function tree(pid: number): { pids: number[]; cpu: number; ws: number; priv: number } {
  const script = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; $ids = @(${pid}); $i = 0;
while ($i -lt $ids.Count) { $p = $ids[$i]; $all | Where-Object { $_.ParentProcessId -eq $p } | ForEach-Object { $ids += $_.ProcessId }; $i++ }
$cpu = 0; $ws = 0; $pv = 0; foreach ($id in $ids) { $q = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($q) { $cpu += $q.TotalProcessorTime.TotalMilliseconds; $ws += $q.WorkingSet64; $pv += $q.PrivateMemorySize64 } }
"$($ids -join ',') $cpu $ws $pv"`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
  const [ids, cpu, ws, priv] = out.split(/\s+/);
  return { pids: ids.split(',').map(Number), cpu: Number(cpu), ws: Number(ws), priv: Number(priv) };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function line(children: ChildProcess[]): WarmLine {
  return new WarmLine({ systemPrompt: () => SYSTEM, allowed: () => true, retryMs: 50, bootMs: 0,
    startProcess: options => ClaudeChatProcess.start({ ...options, spawn: ((...args: Parameters<typeof spawn>) => { const c = spawn(...args); children.push(c); return c; }) as typeof spawn }) });
}

async function orphanChild(): Promise<void> {
  const children: ChildProcess[] = [];
  const warm = line(children);
  warm.want(0);
  while (!children.length) await sleep(20);
  console.log(`CLAUDE_PID ${children[0].pid}`);
  await sleep(600_000);
}

async function main(): Promise<void> {
  const seconds = Math.max(10, Number(option('seconds', '60')) || 60);
  const children: ChildProcess[] = [];
  const warm = line(children);
  const t0 = performance.now();
  warm.want(0);
  while (!children.length) await sleep(20);
  const pid = children[0].pid!;
  await sleep(5_000);
  const booted = tree(pid);
  console.log(`booted (5 s): pids ${booted.pids.join(',')}, cpu ${booted.cpu.toFixed(0)} ms, working set ${(booted.ws / 2 ** 20).toFixed(0)} MB, private ${(booted.priv / 2 ** 20).toFixed(0)} MB`);
  const start = { at: performance.now(), cpu: booted.cpu };
  let last = booted;
  for (let s = 10; s <= seconds; s += 10) {
    await sleep(10_000);
    last = tree(pid);
    console.log(`idle +${s} s: cpu ${last.cpu.toFixed(0)} ms, working set ${(last.ws / 2 ** 20).toFixed(0)} MB, private ${(last.priv / 2 ** 20).toFixed(0)} MB`);
  }
  const idleMs = performance.now() - start.at;
  const idleCpuPct = (last.cpu - start.cpu) / idleMs * 100;
  console.log(`idle CPU over ${(idleMs / 1000).toFixed(0)} s: ${(last.cpu - start.cpu).toFixed(0)} ms = ${idleCpuPct.toFixed(2)} % of one core`);
  const pids = last.pids;
  warm.dispose();
  const disposedAt = performance.now();
  while (pids.some(alive) && performance.now() - disposedAt < 15_000) await sleep(50);
  console.log(`dispose(): ${pids.some(alive) ? 'STILL ALIVE' : `all gone in ${Math.round(performance.now() - disposedAt)} ms`}`);

  // 3. The owner dies without cleanup.
  const owner = spawn(process.execPath, [...process.execArgv, process.argv[1], '--orphan-child'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  owner.stdout.on('data', chunk => { out += chunk; });
  while (!/CLAUDE_PID (\d+)/.test(out)) await sleep(50);
  const orphan = Number(/CLAUDE_PID (\d+)/.exec(out)![1]);
  await sleep(4_000);
  const orphanTree = tree(orphan).pids;
  execFileSync('taskkill.exe', ['/PID', String(owner.pid), '/F'], { stdio: 'ignore' });
  const killedAt = performance.now();
  while (orphanTree.some(alive) && performance.now() - killedAt < 20_000) await sleep(100);
  const left = orphanTree.filter(alive);
  console.log(`owner killed without cleanup: ${left.length ? `STILL ALIVE after 20 s: ${left.join(',')}` : `Claude Code exited by itself in ${Math.round(performance.now() - killedAt)} ms`}`);
  for (const p of left) { try { execFileSync('taskkill.exe', ['/PID', String(p), '/T', '/F'], { stdio: 'ignore' }); } catch { /* Gone. */ } }
  console.log(`total ${(performance.now() - t0) / 1000 | 0} s`);
}

(process.argv.includes('--orphan-child') ? orphanChild() : main()).catch(error => { console.error(error); process.exit(1); });
