/** The page's numbers for the developer view, sent to the host every two seconds when they changed (moved out of main.ts 2026-11-24 so the page file shrinks; no behaviour change). */
import type { UnboundApi } from '../../electron/unbound/preload-api';
import type { UnboundStats } from '../../shared/unbound/scene';

/** Keeps a list of samples short: past `max` the oldest half goes. */
export function keepLast(list: number[], value: number, max = 400): void { list.push(value); if (list.length > max) list.splice(0, max / 2); }

export function startStatsReport(api: Pick<UnboundApi, 'report'> | undefined, read: () => UnboundStats): void {
  let last = '';
  setInterval(() => {
    const stats = read(), key = JSON.stringify(stats);
    if (key !== last && api) { last = key; void api.report(stats).catch(() => {}); }
  }, 2_000);
}
