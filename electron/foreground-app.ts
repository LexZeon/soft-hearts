import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { programKey } from '../shared/screen-activity';

/**
 * 屏幕只读大概 (docs/claude/2026-11-04-screen-rough-only.md): which program is in front, read only while screen sharing is on.
 *
 * A small helper started with sharing and stopped with it (electron/screen-glance.ts): Windows PowerShell, with four Windows calls
 * (GetForegroundWindow, GetWindowThreadProcessId, OpenProcess with the least query right, QueryFullProcessImageNameW), prints one
 * line every POLL_MS: the file name of the program in front ("Code.exe", never the folder it is in), "=" when it is this app
 * (its windows belong to the main process), "?" when it cannot tell. It never reads a window title, an address or a document
 * name: the script has no call that could. It ends by itself when this app's process ends, and when its output is closed.
 *
 * The name stays in this process's memory (electron/screen-glance.ts maps it to an activity at once); it is never saved, logged
 * or sent. Started in the background: nothing on the send path waits for it, and when it cannot run the activity is "不知道".
 */

/** One line from the helper: the program in front, this app ('self'), or nothing readable (null). undefined: not a line it sends. */
export type ForegroundReading = { exe: string } | 'self' | null;

/** The reader electron/screen-glance.ts uses (a fake one in tests: no real foreground window is ever read there). */
export interface ForegroundProbe {
  /** Starts reading; each reading arrives through `reading`, and `ended` once when the reader stops on its own. */
  start(reading: (value: ForegroundReading) => void, ended: () => void): void;
  /** Stops reading at once; no reading arrives after this. */
  stop(): void;
}

export const FOREGROUND_POLL_MS = 2_000;

/** The helper's whole program. `$ParentPid` and `$PollMs` are numbers put in by foregroundHelperScript. */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace SoftHearts -Name Foreground -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, System.Text.StringBuilder name, ref uint size);
[DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
'@
$api = [SoftHearts.Foreground]
$parent = $api::OpenProcess(0x00100000, $false, [uint32]$ParentPid)
while ($true) {
  if ($parent -ne [IntPtr]::Zero -and $api::WaitForSingleObject($parent, 0) -ne 0x102) { exit 0 }
  $line = '?'
  try {
    $window = $api::GetForegroundWindow()
    if ($window -ne [IntPtr]::Zero) {
      $owner = [uint32]0
      [void]$api::GetWindowThreadProcessId($window, [ref]$owner)
      if ($owner -eq [uint32]$ParentPid) { $line = '=' }
      elseif ($owner -ne 0) {
        $process = $api::OpenProcess(0x1000, $false, $owner)
        if ($process -ne [IntPtr]::Zero) {
          $name = New-Object System.Text.StringBuilder 1024
          $size = [uint32]1024
          if ($api::QueryFullProcessImageNameW($process, 0, $name, [ref]$size)) { $line = [System.IO.Path]::GetFileName($name.ToString()) }
          [void]$api::CloseHandle($process)
        }
      }
    }
  } catch { $line = '?' }
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $PollMs
}
`;

/** The script with this app's process id and the poll interval put in (numbers only). */
export function foregroundHelperScript(parentPid: number, pollMs = FOREGROUND_POLL_MS): string {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || !Number.isSafeInteger(pollMs) || pollMs < 250 || pollMs > 60_000)
    throw new Error('前台程序读取参数不正确。');
  return `$ParentPid = ${parentPid}\n$PollMs = ${pollMs}\n${SCRIPT}`;
}

/** One output line → a reading. A plain file name only (programKey); anything else is "?" (null). */
export function readForegroundLine(line: string): ForegroundReading | undefined {
  const text = line.trim();
  if (!text) return undefined;
  if (text === '=') return 'self';
  if (text === '?' || text.length > 260 || programKey(text) === null) return null;
  return { exe: text };
}

type Spawn = (command: string, args: readonly string[], options: { windowsHide: boolean; stdio: ['ignore', 'pipe', 'ignore'] }) => ChildProcess;

/** Windows PowerShell, from the system folder (never one found on PATH). */
export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** The real reader (Windows only). `spawn` is a seam for tests, which never start it. */
export class WindowsForegroundProbe implements ForegroundProbe {
  private child: ChildProcess | null = null;
  private generation = 0;
  constructor(private readonly options: { parentPid?: number; pollMs?: number; spawn?: Spawn; powershell?: string } = {}) {}

  start(reading: (value: ForegroundReading) => void, ended: () => void): void {
    this.stop();
    const generation = ++this.generation;
    const script = foregroundHelperScript(this.options.parentPid ?? process.pid, this.options.pollMs ?? FOREGROUND_POLL_MS);
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const run = this.options.spawn ?? (spawn as unknown as Spawn);
    let child: ChildProcess;
    try {
      child = run(this.options.powershell ?? windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { queueMicrotask(() => { if (generation === this.generation) ended(); }); return; }
    this.child = child;
    let buffer = '', over = false;
    const current = () => generation === this.generation && this.child === child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (!current()) return;
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        const value = readForegroundLine(line);
        if (value !== undefined) reading(value);
      }
      if (buffer.length > 1024) { buffer = ''; if (!over) { over = true; reading(null); } }
    });
    const finish = () => { if (!current()) return; this.child = null; ended(); };
    child.once('error', finish);
    child.once('exit', finish);
  }

  stop(): void {
    this.generation++;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && !child.killed) { try { child.kill(); } catch { /* already gone */ } }
  }
}
