// Unbound U0 probe, Electron main (docs/claude/2026-11-12-unbound-u0.md). Started by scripts/unbound/u0-probe.mjs only, with an
// isolated user-data directory and a plan file. Measures; never touches the app's real profile, never reads a window title,
// process name or content, never uses the camera, microphone or any model.
import { app, BrowserWindow, protocol, screen, net } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { preparePmxForMmdParser } from '../../shared/foundation/pmx-text-encoding';

type RenderStep = { kind: 'render'; name: string; framing: 'pet' | 'corner' | 'face'; idle: boolean; seconds: number; size: 'dry' | 'pet' | 'full' };
type Step = RenderStep | { kind: 'geometry'; rates: number[]; seconds: number } | { kind: 'display' } | { kind: 'click'; size: 'small' | 'full' } | { kind: 'closeup' };
interface Plan { out: string; build: string; geneDir: string; userData: string; steps: Step[] }

const planPath = process.argv[process.argv.indexOf('--plan') + 1];
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const results: Record<string, unknown>[] = [];
let plan: Plan;

protocol.registerSchemesAsPrivileged([{ scheme: 'u0', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function psChild(script: string, args: string[] = []): ChildProcess {
  // Parameters go in as plain tokens at the top of the script ($Argv): -EncodedCommand takes no trailing arguments.
  const head = `$Argv = @(${args.map(a => `'${a.replace(/[^0-9A-Za-z._-]/g, '')}'`).join(',')})\n`;
  const encoded = Buffer.from(head + script, 'utf16le').toString('base64');
  return spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
}
function lines(child: ChildProcess, on: (line: string) => void) {
  let buffer = ''; child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => { buffer += chunk; for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) { on(buffer.slice(0, i).replace(/\r$/, '')); buffer = buffer.slice(i + 1); } });
}

app.setName('u0-probe');
app.on('window-all-closed', () => { /* the probe quits itself when the plan is done */ });
async function main() {
  plan = JSON.parse(await readFile(planPath, 'utf8')) as Plan;
  app.setPath('userData', plan.userData);
  await app.whenReady();
  protocol.handle('u0', async request => {
    const url = new URL(request.url); const headers = { 'Access-Control-Allow-Origin': '*' };
    try {
      if (url.host === 'app') {
        const name = path.basename(decodeURIComponent(url.pathname));
        return new Response(await readFile(path.join(plan.build, name)), { headers: { ...headers, 'Content-Type': name.endsWith('.js') ? 'text/javascript' : 'text/html' } });
      }
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.resolve(plan.geneDir, rel);
      if (!file.startsWith(path.resolve(plan.geneDir) + path.sep)) return new Response('no', { status: 403 });
      if (file.toLowerCase().endsWith('.pmx')) {
        const prepared = preparePmxForMmdParser(new Uint8Array(await readFile(file)));
        return new Response(Buffer.from(prepared.bytes), { headers: { ...headers, 'Content-Type': 'application/octet-stream' } });
      }
      const res = await net.fetch(pathToFileURL(file).toString());
      return new Response(res.body, { status: res.status, headers: { ...headers, 'Content-Type': file.endsWith('.png') ? 'image/png' : 'application/octet-stream' } });
    } catch { return new Response('missing', { status: 404 }); }
  });
  await mkdir(plan.out, { recursive: true });
  for (const step of plan.steps) {
    const started = Date.now();
    try {
      if (step.kind === 'render') results.push({ step: step.name, ...(await renderStep(step)) });
      else if (step.kind === 'geometry') results.push({ step: 'geometry', ...(await geometryStep(step)) });
      else if (step.kind === 'display') results.push({ step: 'display', ...(await displayStep()) });
      else if (step.kind === 'click') results.push({ step: 'click-through-' + step.size, ...(await clickStep(step.size)) });
      else results.push({ step: 'closeup', ...(await closeupStep()) });
    } catch (error) { results.push({ step: step.kind, error: String((error as Error)?.stack ?? error) }); }
    console.log(`step ${step.kind} done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    await writeFile(path.join(plan.out, 'results.json'), JSON.stringify(results, null, 2));
  }
  app.exit(0);
}

// ---- render configurations -------------------------------------------------------------------------------------------------

const GPU_COUNTER = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$dwm = (Get-Process dwm | Select-Object -First 1).Id
while ($true) {
  $s = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 1 -MaxSamples 1).CounterSamples
  $mine = 0.0; $dw = 0.0; $all = 0.0
  foreach ($c in $s) {
    if ($c.InstanceName -notmatch 'pid_(\d+)_.*engtype_(\w+)') { continue }
    $p = [int]$Matches[1]; $eng = $Matches[2]
    if ($eng -ne '3D' -and $eng -ne 'Compute' -and $eng -ne 'Copy') { continue }
    $all += $c.CookedValue
    if ($p -eq $dwm) { $dw += $c.CookedValue } elseif ($Argv -contains "$p") { $mine += $c.CookedValue }
  }
  [Console]::Out.WriteLine(('{0:F1}|{1:F1}|{2:F1}' -f $mine, $dw, $all)); [Console]::Out.Flush()
}`;

async function renderStep(step: RenderStep) {
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea, fb = display.bounds;
  const [w, h] = step.size === 'full' ? [fb.width, fb.height] : step.size === 'pet' ? [400, 560] : [400, 300];
  const [x, y] = step.size === 'full' ? [fb.x, fb.y] : [wa.x + wa.width - w - 20, wa.y + wa.height - h - 20];
  const win = new BrowserWindow({ x, y, width: w, height: h, transparent: true, backgroundColor: '#00000000', frame: false, resizable: false, hasShadow: false,
    skipTaskbar: true, focusable: false, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true } });
  win.setAlwaysOnTop(true, 'pop-up-menu'); // the level the companion uses (electron/stage/pet-topmost.ts)
  win.setIgnoreMouseEvents(true, { forward: true });
  const config = { mode: 'bench', name: step.name, seconds: step.seconds, framing: step.framing, idle: step.idle };
  await win.loadURL(`u0://app/page.html?config=${encodeURIComponent(JSON.stringify(config))}`);
  const page = win.webContents;
  const get = <T>(expr: string) => page.executeJavaScript(expr) as Promise<T>;
  for (let i = 0; i < 600; i++) { if (await get('!!(window.__u0Ready||window.__u0Error)')) break; await sleep(50); }
  const error = await get<string | undefined>('window.__u0Error');
  if (error) { win.destroy(); throw new Error(error); }
  const model = await get('window.__u0');
  win.showInactive(); win.setBounds({ x, y, width: w, height: h });
  await sleep(500);
  const gpuPid = app.getAppMetrics().find(m => m.type === 'GPU')?.pid;
  const gpuChild = psChild(GPU_COUNTER, gpuPid ? [String(gpuPid)] : []);
  const gpuSamples: number[][] = []; lines(gpuChild, line => { const v = line.split('|').map(Number); if (v.length === 3 && v.every(Number.isFinite)) gpuSamples.push(v); });
  const cpuBefore = os.cpus().map(c => ({ ...c.times }));
  const perSecond: { type: string; cpu: number; mb: number }[][] = [];
  const sysCpu: number[] = [];
  let prevCpus = cpuBefore;
  const sampler = setInterval(() => {
    perSecond.push(app.getAppMetrics().map(m => ({ type: m.type, cpu: m.cpu.percentCPUUsage, mb: m.memory.workingSetSize / 1024 })));
    const now = os.cpus().map(c => ({ ...c.times }));
    let busy = 0, total = 0;
    now.forEach((c, i) => { const p = prevCpus[i]; const dt = c.user + c.nice + c.sys + c.irq + c.idle - (p.user + p.nice + p.sys + p.irq + p.idle); total += dt; busy += dt - (c.idle - p.idle); });
    sysCpu.push(total ? busy / total * 100 : 0); prevCpus = now;
  }, 1000);
  await page.executeJavaScript('window.__u0Go = true');
  // One picture of what the overlay shows (the window's own pixels, nothing else on screen), as evidence the scene is not empty.
  setTimeout(() => { void win.webContents.capturePage().then(img => writeFile(path.join(plan.out, `view-${step.name.replace(/[^a-z0-9]+/gi, '-')}.png`), img.resize({ width: Math.min(800, img.getSize().width) }).toPNG())).catch(() => {}); }, 2500);
  for (let i = 0; i < (step.seconds + 20) * 20; i++) { if (await get('!!window.__u0Done')) break; await sleep(50); }
  clearInterval(sampler); try { gpuChild.kill(); } catch { /* gone */ }
  const bench = await get<unknown>('window.__u0Result'), benchError = await get<string | undefined>('window.__u0Error');
  win.destroy();
  // Drop the first 2 samples (load and warm-up). "cpu" is percent of one logical core as Electron reports it (can exceed 100).
  const trimmed = perSecond.slice(2), types = [...new Set(trimmed.flat().map(m => m.type))];
  const byType: Record<string, { cpuMean: number; cpuMax: number; mbMax: number }> = {};
  for (const t of types) {
    const cpuSeries = trimmed.map(s => s.filter(m => m.type === t).reduce((a, m) => a + m.cpu, 0));
    const mbSeries = trimmed.map(s => s.filter(m => m.type === t).reduce((a, m) => a + m.mb, 0));
    byType[t] = { cpuMean: avg(cpuSeries), cpuMax: Math.max(...cpuSeries), mbMax: Math.max(...mbSeries) };
  }
  const totalCpu = trimmed.map(s => s.reduce((a, m) => a + m.cpu, 0));
  const gpuT = gpuSamples.slice(2);
  return { error: benchError, model, window: { w, h, x, y, display: { size: display.size, scaleFactor: display.scaleFactor, hz: display.displayFrequency } }, bench,
    cpuPercentOfOneCore: { byType, appTotalMean: avg(totalCpu), appTotalMax: Math.max(...totalCpu), logicalCores: os.cpus().length },
    appTotalAsPercentOfAllCores: avg(totalCpu) / os.cpus().length, systemCpuPercentMean: avg(sysCpu.slice(2)),
    gpu3dPercent: { samples: gpuT.length, ourGpuProcessMean: avg(gpuT.map(s => s[0])), dwmMean: avg(gpuT.map(s => s[1])), allProcessesMean: avg(gpuT.map(s => s[2])) } };
}
const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

// ---- window geometry reading -------------------------------------------------------------------------------------------------

const GEOMETRY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace U0 -Name Win -MemberDefinition @'
public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLong(IntPtr h, int i);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT v, int s);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
// Position, size and z-order only (top to bottom). No title, no process name, no content is ever read.
public static string Snapshot(uint selfPid, out int raw, out int kept) {
  var sb = new System.Text.StringBuilder(); int r = 0, k = 0;
  EnumWindows(delegate(IntPtr h, IntPtr l) {
    r++;
    if (!IsWindowVisible(h) || IsIconic(h)) return true;
    int ex = GetWindowLong(h, -20); if ((ex & 0x80) != 0 && (ex & 0x40000) == 0) return true;
    int cloaked; DwmGetWindowAttribute(h, 14, out cloaked, 4); if (cloaked != 0) return true;
    uint pid; GetWindowThreadProcessId(h, out pid); if (pid == selfPid) return true;
    RECT rc; if (DwmGetWindowAttribute(h, 9, out rc, 16) != 0) { if (!GetWindowRect(h, out rc)) return true; }
    if (rc.R - rc.L <= 1 || rc.B - rc.T <= 1) return true;
    k++; sb.Append(rc.L).Append(',').Append(rc.T).Append(',').Append(rc.R - rc.L).Append(',').Append(rc.B - rc.T).Append(';');
    return true;
  }, IntPtr.Zero);
  raw = r; kept = k; return sb.ToString();
}
'@
$interval = [int]$Argv[0]; $maxMs = [int]$Argv[1]; $self = [uint32]$Argv[2]
$me = [Diagnostics.Process]::GetCurrentProcess(); $clock = [Diagnostics.Stopwatch]::StartNew(); $lastCpu = 0.0
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($clock.ElapsedMilliseconds -lt $maxMs) {
  $t0 = $clock.Elapsed.TotalMilliseconds; $raw = 0; $kept = 0
  $data = [U0.Win]::Snapshot($self, [ref]$raw, [ref]$kept)
  $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); $enumMs = $clock.Elapsed.TotalMilliseconds - $t0
  $me.Refresh(); $cpu = $me.TotalProcessorTime.TotalMilliseconds
  [Console]::Out.WriteLine(('{0}|{1:F2}|{2:F1}|{3}|{4}|{5}' -f $stamp, $enumMs, ($cpu - $lastCpu), $raw, $kept, $data)); [Console]::Out.Flush()
  $lastCpu = $cpu
  $wait = $interval - ($clock.Elapsed.TotalMilliseconds - $t0); if ($wait -gt 1) { Start-Sleep -Milliseconds ([int]$wait) }
}`;

async function geometryStep(step: { rates: number[]; seconds: number }) {
  const runs: Record<string, unknown>[] = [];
  for (const hz of step.rates) {
    const interval = Math.round(1000 / hz), spawnedAt = Date.now();
    const child = psChild(GEOMETRY_SCRIPT, [String(interval), String(step.seconds * 1000), String(process.pid)]);
    child.stdin!.end();
    let readyAt = 0; const latency: number[] = [], enumMs: number[] = [], cpuMs: number[] = [], parseMs: number[] = [], bytes: number[] = [], arrival: number[] = [];
    let raw = 0, kept = 0;
    lines(child, line => {
      const now = Date.now();
      if (line === 'ready') { readyAt = now; return; }
      const t = process.hrtime.bigint();
      const f = line.split('|'); const data = f[5] ?? '';
      const windows = data ? data.split(';').filter(Boolean).map(s => s.split(',').map(Number)) : []; // parsed and dropped: nothing is kept
      parseMs.push(Number(process.hrtime.bigint() - t) / 1e6);
      latency.push(now - Number(f[0])); enumMs.push(Number(f[1])); cpuMs.push(Number(f[2])); raw = Number(f[3]); kept = Number(f[4]); bytes.push(line.length); arrival.push(now);
      void windows;
    });
    await new Promise<void>(r => { child.once('exit', () => r()); setTimeout(() => { try { child.kill(); } catch { /* gone */ } r(); }, step.seconds * 1000 + 15000); });
    const dts = arrival.slice(1).map((t, i) => t - arrival[i]);
    const warm = (xs: number[]) => xs.slice(1); // the first poll pays JIT and first-call costs
    const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
    runs.push({ hz, polls: arrival.length, startupMs: readyAt ? readyAt - spawnedAt : null, windowsSeenRaw: raw, windowsKept: kept, bytesPerPollMean: avg(bytes),
      enumMs: { p50: pct(warm(enumMs), 0.5), p95: pct(warm(enumMs), 0.95), max: Math.max(...warm(enumMs), 0) },
      helperCpuMsPerPoll: avg(warm(cpuMs)), helperCpuPercentOfOneCore: avg(warm(cpuMs)) / interval * 100,
      nodeParseMsMean: avg(parseMs), latencyMs: { p50: pct(latency, 0.5), p95: pct(latency, 0.95), max: Math.max(...latency, 0) },
      achievedIntervalMs: { mean: avg(dts), p95: pct(dts, 0.95) },
      dataAgeAtRandomMomentMs: { mean: avg(latency) + avg(dts) / 2, worst: pct(latency, 0.95) + pct(dts, 0.95) } });
  }
  return { method: 'persistent Windows PowerShell helper: EnumWindows + IsWindowVisible/IsIconic/DWM cloaked/extended frame bounds; geometry only', runs };
}

// ---- display ---------------------------------------------------------------------------------------------------------------

const DISPLAY_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$basic = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams)
$conn = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorConnectionParams)
$out = @()
foreach ($b in $basic) {
  $key = ($b.InstanceName -replace '_\d+$', '')
  $tech = ($conn | Where-Object { ($_.InstanceName -replace '_\d+$', '') -eq $key } | Select-Object -First 1).VideoOutputTechnology
  $edid = $null
  $reg = Get-Item ('HKLM:\SYSTEM\CurrentControlSet\Enum\' + $key + '\Device Parameters')
  if ($reg) { $edid = $reg.GetValue('EDID') }
  $mmW = $null; $mmH = $null; $cmW = $null; $cmH = $null; $dtdPx = $null
  if ($edid -and $edid.Length -ge 72) {
    $cmW = [int]$edid[21]; $cmH = [int]$edid[22]
    if (($edid[54] -ne 0) -or ($edid[55] -ne 0)) {
      $mmW = [int]$edid[66] + (([int]$edid[68] -band 0xF0) -shl 4); $mmH = [int]$edid[67] + (([int]$edid[68] -band 0x0F) -shl 8)
      $dtdPx = @(([int]$edid[56] + (([int]$edid[58] -band 0xF0) -shl 4)), ([int]$edid[59] + (([int]$edid[61] -band 0xF0) -shl 4)))
    }
  }
  $out += [pscustomobject]@{ active = $b.Active; wmiCmW = $b.MaxHorizontalImageSize; wmiCmH = $b.MaxVerticalImageSize; outputTechnology = $tech; edidCmW = $cmW; edidCmH = $cmH; edidDtdMmW = $mmW; edidDtdMmH = $mmH; edidPreferredPx = $dtdPx }
}
$out | ConvertTo-Json -Compress -Depth 4`;

async function displayStep() {
  const displays = screen.getAllDisplays().map(d => ({ primary: d.id === screen.getPrimaryDisplay().id, internal: d.internal, sizeDip: d.size, scaleFactor: d.scaleFactor, sizePx: [Math.round(d.size.width * d.scaleFactor), Math.round(d.size.height * d.scaleFactor)], hz: d.displayFrequency, workArea: d.workArea, colorDepth: d.colorDepth }));
  const child = psChild(DISPLAY_SCRIPT); child.stdin!.end();
  let text = ''; child.stdout!.setEncoding('utf8'); child.stdout!.on('data', c => { text += c; });
  const started = Date.now();
  await new Promise<void>(r => { child.once('exit', () => r()); setTimeout(r, 30000); });
  let monitors: unknown = null; try { const v = JSON.parse(text); monitors = Array.isArray(v) ? v : [v]; } catch { monitors = null; }
  return { electronDisplays: displays, wmiAndEdidMonitors: monitors, wmiQueryMs: Date.now() - started };
}

// ---- click-through ---------------------------------------------------------------------------------------------------------

const CLICK_SCRIPT = String.raw`
Add-Type -Namespace U0 -Name In -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
'@
[void][U0.In]::SetProcessDPIAware()
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while (($l = [Console]::In.ReadLine()) -ne $null) {
  $p = $l.Split(' '); $x = [int]$p[0]; $y = [int]$p[1]
  $o = New-Object U0.In+POINT; [void][U0.In]::GetCursorPos([ref]$o)
  [void][U0.In]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 120
  [U0.In]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [U0.In]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 200
  [void][U0.In]::SetCursorPos($o.X, $o.Y)
  [Console]::Out.WriteLine('done'); [Console]::Out.Flush()
}`;

async function clickStep(size: 'small' | 'full') {
  const display = screen.getPrimaryDisplay(), wa = display.workArea, fb = display.bounds;
  const target = new BrowserWindow({ x: wa.x + 200, y: wa.y + 200, width: 300, height: 200, frame: false, resizable: false, skipTaskbar: true, focusable: false, show: false, webPreferences: { backgroundThrottling: false } });
  await target.loadURL('data:text/html,' + encodeURIComponent('<body onmousedown="window.n=(window.n||0)+1" style="margin:0;background:#3a7;height:100vh"></body>'));
  target.setAlwaysOnTop(true, 'floating'); target.showInactive();
  const [ow, oh] = size === 'full' ? [fb.width, fb.height] : [420, 320], [ox, oy] = size === 'full' ? [fb.x, fb.y] : [wa.x + 140, wa.y + 140];
  const overlay = new BrowserWindow({ x: ox, y: oy, width: ow, height: oh, transparent: true, backgroundColor: '#00000000', frame: false, resizable: false, hasShadow: false, skipTaskbar: true, focusable: false, show: false, webPreferences: { backgroundThrottling: false } });
  await overlay.loadURL('data:text/html,' + encodeURIComponent('<body onmousedown="window.n=(window.n||0)+1" style="margin:0;background:transparent"><div style="width:100vw;height:100vh;background:rgba(200,30,30,.35)"></div></body>'));
  const count = (w: BrowserWindow) => w.webContents.executeJavaScript('window.n||0') as Promise<number>;
  const click = new Promise<ChildProcess>(r => { const c = psChild(CLICK_SCRIPT); lines(c, l => { if (l === 'ready') r(c); }); });
  const child = await click;
  let pending: (() => void) | null = null; lines(child, l => { if (l === 'done') pending?.(); });
  const pt = screen.dipToScreenPoint({ x: wa.x + 350, y: wa.y + 300 }); // the centre of the target window, physical pixels
  const doClick = () => new Promise<void>(r => { pending = r; child.stdin!.write(`${pt.x} ${pt.y}\n`); });
  const rows: Record<string, unknown>[] = [];
  await sleep(400);
  // 1) no overlay shown: the click must reach the target (proves the test can see a click).
  await doClick(); rows.push({ case: 'overlay hidden', targetClicks: await count(target), overlayClicks: await count(overlay) });
  // 2) overlay shown at the companion's level, click-through on (forward): the click must pass to the target.
  overlay.setAlwaysOnTop(true, 'pop-up-menu'); overlay.setIgnoreMouseEvents(true, { forward: true }); overlay.showInactive(); await sleep(400);
  await doClick(); rows.push({ case: 'overlay, click-through on', targetClicks: await count(target), overlayClicks: await count(overlay) });
  // 3) overlay shown, click-through off: the overlay must take the click (proves the overlay really covers the point).
  overlay.setIgnoreMouseEvents(false); await sleep(200);
  await doClick(); rows.push({ case: 'overlay, click-through off', targetClicks: await count(target), overlayClicks: await count(overlay) });
  try { child.kill(); } catch { /* gone */ }
  target.destroy(); overlay.destroy();
  const [a, b, c] = rows as { targetClicks: number; overlayClicks: number }[];
  return { overlaySize: [ow, oh], rows, passed: a.targetClicks === 1 && b.targetClicks === 2 && b.overlayClicks === 0 && c.targetClicks === 2 && c.overlayClicks === 1 };
}

// ---- close-ups ---------------------------------------------------------------------------------------------------------------

async function closeupStep() {
  // Shown, but far off every screen: a hidden window gets no GPU frames, so reading pixels back returns nothing.
  const win = new BrowserWindow({ x: -6000, y: 0, width: 1280, height: 960, show: false, frame: false, skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false } });
  win.showInactive();
  await win.loadURL(`u0://app/page.html?config=${encodeURIComponent(JSON.stringify({ mode: 'closeup', name: 'closeup', seconds: 0, framing: 'pet', idle: true }))}`);
  const get = <T>(expr: string) => win.webContents.executeJavaScript(expr) as Promise<T>;
  for (let i = 0; i < 1200; i++) { if (await get('!!window.__u0Done')) break; await sleep(50); }
  const error = await get<string | undefined>('window.__u0Error'); if (error) { win.destroy(); throw new Error(error); }
  const result = await get<{ shots: { name: string; dataUrl: string }[]; morphCount: number; morphNames: string[]; wantedAvailable: string[] }>('window.__u0Result');
  const model = await get('window.__u0');
  await mkdir(plan.out, { recursive: true });
  for (const s of result.shots) await writeFile(path.join(plan.out, `closeup-${s.name}.png`), Buffer.from(s.dataUrl.split(',')[1], 'base64'));
  win.destroy();
  // Texture sizes, from the PNG headers.
  const textures: Record<string, [number, number]> = {};
  for (const name of ['face', 'eye', 'eye2', 'hair2', 'arm', 'top', 'bottoms', 'extra', 'pale', 'iraira']) {
    try { const head = await readFile(path.join(plan.geneDir, 'model', 'tex', `${name}.png`)); textures[name] = [head.readUInt32BE(16), head.readUInt32BE(20)]; } catch { /* absent */ }
  }
  return { model, shots: result.shots.map(s => ({ name: s.name, litFraction: (s as unknown as { litFraction: number }).litFraction, dbg: JSON.stringify(s, (k, v) => k === 'dataUrl' ? undefined : v) })), morphCount: result.morphCount, morphNames: result.morphNames, wantedAvailable: result.wantedAvailable, textures };
}

main().catch(error => { console.error(error); app.exit(1); });
