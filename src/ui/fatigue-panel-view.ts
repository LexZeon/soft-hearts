import { uiText, uiTemplate } from './ui-language';
/** Presentation only. Identity, ordering and lifecycle are owned by the caller. */
export type FatiguePanelReading = Readonly<{
  connected: boolean; A: number | null; F: number | null; W: number | null;
  phase: string | null; entryReady: boolean | null; storageError: string | null;
}>;
const phases: Record<string, string> = {
  awake: '清醒', 'light-drowsy': '轻困', drowsy: '明显困倦',
  'falling-asleep': '入睡中', asleep: '睡眠', 'micro-awake': '轻微唤醒',
};
const REST_KIND: Record<string, string> = { closed: '上次关了', away: '不在屏幕上', paused: '电脑睡眠／应用停住' };
const restDuration = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000), hours = Math.floor(minutes / 60);
  return hours > 0 ? uiTemplate`${hours} 小时 ${minutes % 60} 分` : minutes > 0 ? uiTemplate`${minutes} 分` : uiTemplate`${Math.max(0, Math.round(ms / 1000))} 秒`;
};
/**
 * I-022 developer line: the last time off screen counted as rest — "作息：上次关了 8 小时 2 分（准确）· 按休息算 8 小时 2 分 · 困意积累 75 → 3 · 困倦 69 → 10".
 * '' when there is none (not developer mode, or she has not been away since the start). Presentation only.
 */
export function fatigueRestLine(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const v = value as Record<string, unknown>, before = v.before as Record<string, unknown> | undefined, after = v.after as Record<string, unknown> | undefined;
  const ms = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
  const away = ms(v.awayMs), counted = ms(v.countedMs);
  const a0 = percent(before?.A), a1 = percent(after?.A), f0 = percent(before?.F), f1 = percent(after?.F);
  if (typeof v.kind !== 'string' || !Object.hasOwn(REST_KIND, v.kind) || away === null || counted === null || a0 === null || a1 === null || f0 === null || f1 === null) return '';
  const exact = v.kind === 'closed' && v.exact === false ? uiText('（上次没正常退出，估的上限）') : v.kind === 'closed' ? uiText('（准确）') : '';
  return uiTemplate`作息：${uiText(REST_KIND[v.kind])} ${restDuration(away)}${exact} · 按休息算 ${restDuration(counted)} · 困意积累 ${a0.toFixed(0)} → ${a1.toFixed(0)} · 困倦 ${f0.toFixed(0)} → ${f1.toFixed(0)}`;
}
const percent = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value * 100 : null;
export function fatiguePanelView(value: unknown): FatiguePanelReading {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { connected: false, A: null, F: null, W: null, phase: null, entryReady: null, storageError: null };
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return { connected: false, A: null, F: null, W: null, phase: null, entryReady: null, storageError: null };
  return { connected: true, A: percent(v.A), F: percent(v.F), W: percent(v.W),
    phase: typeof v.phase === 'string' && Object.hasOwn(phases, v.phase) ? uiText(phases[v.phase]) : null,
    entryReady: typeof v.sleepEntryReady === 'boolean' ? v.sleepEntryReady : null,
    storageError: typeof v.storageError === 'string' && v.storageError ? v.storageError : null };
}
