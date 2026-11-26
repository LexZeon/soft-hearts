/**
 * 体验记录 (the experience journal): the two rows of (docs/claude/2026-11-24-stage-smooth.md). Their own file, because
 * the stage slice (shared/stage/journal-entries.ts) is big and shared with the walking rows: it only joins them (a type name, an input shape,
 * three cases that call the functions here). Numbers and closed words only; never a path, a driver string or a word she said. Pure.
 *
 *  - 'gpu-start': once at start, which graphics chip draws WebGL: hardware or software, the vendor family, whether a second real chip was
 *    listed, whether the app asked for the high-performance one, and whether it drew in software although a real chip was listed (fellBack).
 *  - 'frame-time': once a minute per full-screen instance while Unbound is open: the median and the 95th-percentile frame interval, the
 *    frames a second, the quality tier, how many characters were on stage, whether she was the one you are with, the share of the minute
 *    she was drawn as an idle extra (30 fps, one pixel tier lower).
 */
import { count, finite, has, round, type JournalTranslate } from '../foundation/journal-fields';
import { GPU_KINDS, GPU_VENDORS, SECOND_CHIP_WORDS, type GpuKind, type GpuStartRow, type GpuVendor, type SecondChip } from '../foundation/gpu-kind';
export type { GpuStartRow };

export const FRAME_TIERS = ['high', 'medium', 'low'] as const;
export type FrameTier = (typeof FRAME_TIERS)[number];
const TIER_LABEL: Readonly<Record<FrameTier, string>> = Object.freeze({ high: '高', medium: '中', low: '低' });

export interface FrameTimeRow { tier: FrameTier; onStage: number; withYou: boolean; fps: number; medianMs: number; p95Ms: number; frames: number; idlePct: number }

export const GPU_START_ROW_WORDS = Object.freeze({ kinds: GPU_KINDS, vendors: GPU_VENDORS, second: SECOND_CHIP_WORDS });

const KIND_LABEL: Readonly<Record<GpuKind, string>> = Object.freeze({ hardware: '用的是显卡', software: '没有用上显卡（处理器在画）', unknown: '没读到用的是什么' });
const VENDOR_LABEL: Readonly<Record<GpuVendor, string>> = Object.freeze({ nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', qualcomm: 'Qualcomm', apple: 'Apple', other: '其他厂商' });
const SECOND_LABEL: Readonly<Record<SecondChip, string>> = Object.freeze({ yes: '机器上有第二块显卡', no: '机器上只有一块显卡', unknown: '不知道有几块显卡' });

export const gpuStartReason = (row: GpuStartRow): string => row.fellBack ? '这台电脑有显卡，但画面是用处理器软件画的' : '应用启动时读了一次画面用的显卡';

export function gpuStartFrom(v: Record<string, unknown>): GpuStartRow | null {
  if (!has(GPU_KINDS, v.kind) || !has(GPU_VENDORS, v.vendor) || !has(SECOND_CHIP_WORDS, v.secondChip) || typeof v.asked !== 'boolean' || typeof v.fellBack !== 'boolean') return null;
  return { kind: v.kind, vendor: v.vendor, secondChip: v.secondChip, asked: v.asked, fellBack: v.fellBack };
}
export function gpuStartWords(row: GpuStartRow, reason: string, tr: JournalTranslate): string {
  return tr('{0}：{1}（{2}；{3}）', reason, tr(KIND_LABEL[row.kind]), tr(VENDOR_LABEL[row.vendor]), tr(SECOND_LABEL[row.secondChip]));
}

export const FRAME_ROWS_MAX_FPS = 240;
export const frameTimeReason = (): string => '她这一分钟的画面画得有多顺';

export function frameTimeFrom(v: Record<string, unknown>): FrameTimeRow | null {
  const within = (value: unknown, min: number, max: number): number | undefined => { const n = count(value, max + 1); return n !== undefined && n >= min && n <= max ? n : undefined; }; // out of range: not clamped, refused
  const onStage = within(v.onStage, 1, 3), frames = within(v.frames, 0, 1_000_000), idlePct = within(v.idlePct, 0, 100);
  if (!has(FRAME_TIERS, v.tier) || onStage === undefined || frames === undefined || idlePct === undefined || typeof v.withYou !== 'boolean') return null;
  if (!finite(v.fps) || v.fps < 0 || v.fps > FRAME_ROWS_MAX_FPS || !finite(v.medianMs) || v.medianMs < 0 || v.medianMs > 10_000 || !finite(v.p95Ms) || v.p95Ms < 0 || v.p95Ms > 10_000) return null;
  return { tier: v.tier, onStage, withYou: v.withYou, fps: round(v.fps, 1), medianMs: round(v.medianMs, 1), p95Ms: round(v.p95Ms, 1), frames, idlePct };
}
export function frameTimeWords(row: FrameTimeRow, reason: string, tr: JournalTranslate): string {
  return tr('{0}：{1} 帧每秒，中位 {2} 毫秒，p95 {3} 毫秒（画质 {4}，台上 {5} 位，{6}，{7}% 的时间是安静降帧）', reason, String(row.fps), String(row.medianMs), String(row.p95Ms),
    tr(TIER_LABEL[row.tier]), String(row.onStage), tr(row.withYou ? '你正和她在一起' : '你没和她在一起'), String(row.idlePct));
}
