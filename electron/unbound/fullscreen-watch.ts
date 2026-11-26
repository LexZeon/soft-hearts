/**
 * Unbound U1: is a full-screen program in front? Information only (I-199; 11-15: she does not make
 * way): her window is never hidden, moved or demoted for it; she is raised once when one arrives (electron/unbound/host.ts), and the
 * reading reaches her as a fact (her free time's signals, her peek's reasons to wait, the 「你从全屏程序里出来」 moment). A small Windows PowerShell helper,
 * started while she is in Unbound and stopped with it, asks Windows once a second what its notifications would do
 * (SHQueryUserNotificationState): QUNS_BUSY (a full-screen program), QUNS_RUNNING_D3D_FULL_SCREEN (a full-screen game) and
 * QUNS_PRESENTATION_MODE mean someone is using the whole screen. That is all it reads: no window, title or program name. Her own
 * window never takes focus, so it is never the program in front. It ends with this app's process and when its output closes.
 */
import { windowsPowerShell } from '../senses';
import { spawnOffMain, type HelperProcess, type HelperSpawn } from './off-main-spawn';

export type FullscreenReading = 'fullscreen' | 'clear';
export interface FullscreenProbe {
  start(reading: (value: FullscreenReading) => void): void;
  stop(): void;
}
export const FULLSCREEN_POLL_MS = 1_000;
/** QUNS_BUSY, QUNS_RUNNING_D3D_FULL_SCREEN, QUNS_PRESENTATION_MODE. */
const FULLSCREEN_STATES = new Set([2, 3, 4]);

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace SoftHearts -Name Notify -MemberDefinition @'
[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
[DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
'@
$api = [SoftHearts.Notify]
$parent = $api::OpenProcess(0x00100000, $false, [uint32]$ParentPid)
while ($true) {
  if ($parent -ne [IntPtr]::Zero -and $api::WaitForSingleObject($parent, 0) -ne 0x102) { exit 0 }
  $state = 0
  try { if ($api::SHQueryUserNotificationState([ref]$state) -ne 0) { $state = 0 } } catch { $state = 0 }
  [Console]::Out.WriteLine($state)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $PollMs
}`;

/** One helper line → a reading; undefined for anything that is not a state number (0: unknown, no change). */
export function readFullscreenLine(line: string): FullscreenReading | undefined {
  const text = line.trim();
  if (!/^\d{1,2}$/.test(text)) return undefined;
  const state = Number(text);
  if (state === 0) return undefined;
  return FULLSCREEN_STATES.has(state) ? 'fullscreen' : 'clear';
}

export function fullscreenHelperScript(parentPid: number, pollMs = FULLSCREEN_POLL_MS): string {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || !Number.isSafeInteger(pollMs) || pollMs < 250 || pollMs > 60_000) throw new Error('全屏检测参数不正确。');
  return `$ParentPid = ${parentPid}\n$PollMs = ${pollMs}\n${SCRIPT}`;
}

/**
 * The real watcher (Windows only; elsewhere it never reports). The helper is started off the main thread (off-main-spawn.ts): starting
 * PowerShell on it held every mouse event for 26-152 ms each time she went full screen (step 6, 2026-11-23).
 */
export class WindowsFullscreenProbe implements FullscreenProbe {
  private child: HelperProcess | null = null;
  private generation = 0;
  constructor(private readonly spawn: HelperSpawn = spawnOffMain, private readonly platform: string = process.platform) {}
  start(reading: (value: FullscreenReading) => void): void {
    this.stop();
    if (this.platform !== 'win32') return;
    const generation = ++this.generation;
    let child: HelperProcess;
    try { child = this.spawn(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(fullscreenHelperScript(process.pid), 'utf16le').toString('base64')]); }
    catch { return; }
    this.child = child;
    let buffer = '', last: FullscreenReading | undefined;
    child.onData((chunk: string) => {
      if (generation !== this.generation) return;
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const value = readFullscreenLine(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
        if (value !== undefined && value !== last) { last = value; reading(value); }
      }
      if (buffer.length > 256) buffer = '';
    });
    child.onExit(() => { if (this.child === child) this.child = null; });
  }
  stop(): void {
    this.generation++;
    const child = this.child; this.child = null;
    if (child && !child.ended) { try { child.kill(); } catch { /* gone */ } }
  }
}
