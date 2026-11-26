// The developer overlay's lines (split out of main.ts 2026-11-18; the whole text since 2026-11-21, so the page file shrinks; no behaviour change).
import { summarize, type UnboundWorld } from '../../shared/unbound/scene';
import { apparentHeightM } from '../../shared/unbound/world';
import type { BodyMeter } from './body-meter';
import type { UnboundFigure } from './figure';
import type { PerfManager } from './perf';

/** 显卡有没有用上: the developer readout says so when the picture is drawn by the processor instead of a graphics chip (docs/claude/2026-11-24-stage-smooth.md). */
export function gpuLine(perf: PerfManager): string {
  const gpu = perf.gpu;
  if (!gpu || gpu.kind === 'unknown') return '显卡：还没读到'; // ui-zh-ok: developer overlay
  return gpu.kind === 'software' ? '显卡：没有用上显卡，是处理器在软件渲染（画面会吃力）' : `显卡：硬件渲染（${gpu.vendor}）`; // ui-zh-ok: developer overlay
}

const PACED_WORD = '空闲陪衬（30 帧、低一档像素）'; // ui-zh-ok: developer overlay
export function perfLine(perf: PerfManager, frameLog: readonly number[]): string {
  const ft = summarize(frameLog as number[]);
  return `档位 ${perf.tier.label}${perf.testing ? '（自测中）' : ''} · 上限 ${perf.tier.fps} 帧 · ${perf.paced ? PACED_WORD : perf.quiet ? '安静 30 帧' : '全速'} · 帧间隔 p50 ${ft ? ft.p50.toFixed(1) : '-'} / p95 ${ft ? ft.p95.toFixed(1) : '-'} ms · 降档 ${perf.drops} 次${perf.note ? ` · ${perf.note}` : ''}`;
}

const STANCE_WORDS: Record<string, string> = { both: '双脚站', shifting: '重心移过去', lifting: '抬脚', holding: '单脚站', lowering: '放下脚' };

export function bodyLine(figure: UnboundFigure | null, meter: BodyMeter): string {
  if (!figure) return '';
  const r = figure.report, m = meter.value;
  const stance = figure.walking ? '走路' : STANCE_WORDS[r?.stance ?? 'both'] ?? r?.stance ?? '';
  return `${stance} · 走了 ${r?.steps ?? 0} 步 · 重心余量 ${r?.comMargin != null ? (r.comMargin * 100).toFixed(1) : '-'} cm · 踩住的脚漂移最多 ${(m.driftCm * 10).toFixed(1)} mm · 每帧最大位移 ${m.rootStepCm.toFixed(2)} cm`;
}

/** The developer overlay's whole text: where she stands and how tall she shows, the screen, her body, the machine, the click-through. */
export function overlayText(figure: UnboundFigure, world: UnboundWorld, meter: BodyMeter, perf: PerfManager, frameLog: readonly number[],
  s: { fps: number | null; toggles: number; roundTrips: number[]; clicks: number; interactive: boolean }): string {
  const at = figure.placement, d = world.viewerDistanceM, rt = summarize(s.roundTrips);
  return [
    `她离屏幕 ${at.depthM.toFixed(2)} m · 横向 ${at.xM.toFixed(2)} m · 身高 ${figure.heightM.toFixed(2)} m → 屏上 ${(apparentHeightM(figure.heightM, at.depthM, d) * 100).toFixed(1)} cm`, // ui-zh-ok: developer overlay (moved from main.ts)
    `屏幕 ${(world.screen.widthM * 100).toFixed(1)}×${(world.screen.heightM * 100).toFixed(1)} cm（${world.screen.source}） · 观看 ${(d * 100).toFixed(0)} cm · 眼高 ${world.eyeHeightM.toFixed(2)} m · ${world.mapping}`, // ui-zh-ok: developer overlay
    bodyLine(figure, meter),
    perfLine(perf, frameLog),
    gpuLine(perf),
    `${s.fps ? s.fps.toFixed(0) : '-'} fps · 穿透切换 ${s.toggles} 次 · 往返 p50 ${rt ? rt.p50.toFixed(1) : '-'} / p95 ${rt ? rt.p95.toFixed(1) : '-'} ms · 点到她 ${s.clicks} 次 · ${s.interactive ? '可点' : '穿透'}`, // ui-zh-ok: developer overlay
  ].join('\n');
}
