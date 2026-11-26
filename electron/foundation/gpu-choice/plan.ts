// 显卡有没有用上 (2026-11-24, docs/claude/2026-11-24-stage-smooth.md): which graphics chip Chromium is asked to use, and the one row that says
// at start which one drew. Pure: no Electron import. electron/foundation/gpu-choice/host.ts applies it to the app; electron/wiring/gpu-choice-wiring.ts
// wires it, before the app is ready (a Chromium switch only counts then).
//
// What is asked: on a machine with two graphics chips (a laptop's built-in one and a separate one) Chromium otherwise follows Windows' default
// for the app, which is usually the built-in one. `force_high_performance_gpu` asks for the separate one (the switch exists in Chromium 156:
// checked in the Electron 45 binary). No registry write, no per-app setting of Windows. What is never asked: software rendering (no
// `disable-gpu`, no SwiftShader, no `disable-software-rasterizer`, which would leave a machine without a working chip with no picture at all).
import { classifyRenderer, graphicsChips, vendorOfId, type GpuDeviceFacts, type GpuStartRow, type SecondChip } from '../../../shared/foundation/gpu-kind';

/** The switch that asks for the high-performance chip, and the one a person could have set to ask for the opposite (we never override it). */
export const GPU_CHOICE_SWITCH = 'force_high_performance_gpu';
export const GPU_CHOICE_OPPOSITE_SWITCH = 'force_low_power_gpu';

export interface GpuChoicePlan {
  /** Switches to append before the app is ready. */
  readonly switches: readonly string[];
}

/** Before ready: ask for the high-performance chip, unless the app was started with the opposite request (someone chose it on purpose). */
export function gpuChoicePlan(hasSwitch: (name: string) => boolean): GpuChoicePlan {
  return { switches: hasSwitch(GPU_CHOICE_OPPOSITE_SWITCH) || hasSwitch(GPU_CHOICE_SWITCH) ? [] : [GPU_CHOICE_SWITCH] };
}

/** What a throw-away WebGL context said (asked for the high-performance chip, as the full-screen page asks): its renderer string, or null. */
export interface GpuProbe { renderer: string | null }

const chipWords = (chips: number | null): SecondChip => chips === null ? 'unknown' : chips >= 2 ? 'yes' : 'no';

/**
 * The start row. `asked`: the switch is on the command line now (ours or someone else's high-performance one). `fellBack`: WebGL is drawn in
 * software although a real graphics chip is listed, which is the case the user cannot see and must not be left with silently.
 */
export function gpuStartRow(probe: GpuProbe | null, devices: readonly GpuDeviceFacts[] | null, asked: boolean): GpuStartRow {
  const seen = classifyRenderer(probe?.renderer);
  const chips = graphicsChips(devices);
  // No renderer string but a single listed chip: its vendor family is still known, the drawing kind is not.
  const first = Array.isArray(devices) ? devices.find(d => vendorOfId(d?.vendorId) !== 'other') : undefined;
  const vendor = seen.kind === 'unknown' && first ? vendorOfId(first.vendorId) : seen.vendor;
  return { kind: seen.kind, vendor, secondChip: chipWords(chips), asked, fellBack: seen.kind === 'software' && (chips ?? 0) >= 1 };
}

/** The developer log line for a start row (closed words only). */
export function gpuStartLine(row: GpuStartRow): string {
  return `GPU at start: ${row.kind}, ${row.vendor}, second chip ${row.secondChip}, high-performance asked ${row.asked}${row.fellBack ? ' (SOFTWARE although a graphics chip is listed)' : row.kind === 'software' ? ' (SOFTWARE)' : ''}`;
}
