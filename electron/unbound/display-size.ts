/**
 * Unbound U1: the monitors' physical sizes, read once (docs/claude/2026-11-12-unbound-u0.md section 3).
 *
 * Windows PowerShell asks WMI (WmiMonitorBasicDisplayParams, whole centimeters) and reads the EDID's own centimeter bytes
 * (21, 22) from the registry, plus the connection type (an embedded panel or not). Nothing else: no serial number, no model
 * name, nothing written. U0 measured both agreeing on this laptop (34 x 22 cm). The result is kept in memory for the session.
 */
import { windowsPowerShell } from '../senses';
import { spawnOffMain, type HelperSpawn } from './off-main-spawn';
import type { MonitorMeasurement } from '../../shared/unbound/world';

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$basic = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams)
$conn = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorConnectionParams)
$out = @()
foreach ($b in $basic) {
  if (-not $b.Active) { continue }
  $key = ($b.InstanceName -replace '_\d+$', '')
  $tech = ($conn | Where-Object { ($_.InstanceName -replace '_\d+$', '') -eq $key } | Select-Object -First 1).VideoOutputTechnology
  $edid = $null
  $reg = Get-Item ('HKLM:\SYSTEM\CurrentControlSet\Enum\' + $key + '\Device Parameters')
  if ($reg) { $edid = $reg.GetValue('EDID') }
  $cmW = $null; $cmH = $null
  if ($edid -and $edid.Length -ge 23) { $cmW = [int]$edid[21]; $cmH = [int]$edid[22] }
  $out += [pscustomobject]@{ w = $b.MaxHorizontalImageSize; h = $b.MaxVerticalImageSize; ew = $cmW; eh = $cmH; t = $tech }
}
ConvertTo-Json -Compress -InputObject @($out)`;

/** VideoOutputTechnology values of a panel built into the machine (LVDS, embedded DisplayPort / UDI, "internal"). */
const INTERNAL_TECH = new Set([6, 11, 13, 0x80000000, -0x80000000]);

/** The helper's JSON → measurements (EDID's own bytes first, WMI's when the EDID has none). Anything malformed is dropped. */
export function parseMonitorSizes(text: string): MonitorMeasurement[] | null {
  let value: unknown;
  try { value = JSON.parse(text.trim()); } catch { return null; }
  const rows = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : null;
  if (!rows) return null;
  const out: MonitorMeasurement[] = [];
  const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1000 ? v : null;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const tech = typeof r.t === 'number' && Number.isFinite(r.t) ? r.t : null;
    const internal = tech === null ? null : INTERNAL_TECH.has(tech);
    const ew = int(r.ew), eh = int(r.eh), w = int(r.w), h = int(r.h);
    if (ew && eh) out.push({ widthCm: ew, heightCm: eh, source: 'edid', internal });
    else if (w && h) out.push({ widthCm: w, heightCm: h, source: 'wmi', internal });
  }
  return out;
}

/**
 * Runs the helper once (Windows only), at most `timeoutMs`. null when it cannot tell. Started off the main thread (off-main-spawn.ts): the
 * first start of PowerShell held the main thread, and with it every mouse event, for 802 ms the moment she first went full screen.
 */
export function readMonitorSizes(timeoutMs = 8_000, spawn: HelperSpawn = spawnOffMain, platform: string = process.platform): Promise<MonitorMeasurement[] | null> {
  if (platform !== 'win32') return Promise.resolve(null);
  return new Promise(resolve => {
    let text = '', settled = false;
    const done = (value: MonitorMeasurement[] | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    let child: ReturnType<HelperSpawn>;
    try { child = spawn(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')]); }
    catch { resolve(null); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } done(null); }, timeoutMs);
    child.onData(chunk => { if (text.length < 64_000) text += chunk; });
    child.onExit(code => done(code === null ? null : parseMonitorSizes(text)));
  });
}
