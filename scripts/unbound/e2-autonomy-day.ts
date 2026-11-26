// Unbound U2 experiment E2: five synthetic days through the autonomy planner and writer (shared/unbound/autonomy/day-sim.ts).
// Prints the count table per day (and, with --timeline, each day's acts); writes both to .local/unbound-night/e2-autonomy/.
//   node node_modules/tsx/dist/cli.mjs scripts/unbound/e2-autonomy-day.ts [--timeline] [--seeds 5]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTONOMY_ACTS } from '../../shared/unbound/autonomy/choose';
import { SYNTHETIC_DAYS, simulateDay, type DayResult } from '../../shared/unbound/autonomy/day-sim';

const args = process.argv.slice(2);
const seeds = Number(args[args.indexOf('--seeds') + 1]) || 5;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mainRoot = root.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`) ? root.slice(0, root.indexOf(`${path.sep}.claude${path.sep}worktrees${path.sep}`)) : root;
const out = path.join(mainRoot, '.local', 'unbound-night', 'e2-autonomy');
mkdirSync(out, { recursive: true });

const clock = (minute: number) => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(Math.floor(minute % 60)).padStart(2, '0')}`;
const lines: string[] = [];
const say = (line = '') => { lines.push(line); console.log(line); };

say(`# E2 一天的模拟（${seeds} 个随机种子，表里是种子 1；括号里是 ${seeds} 个种子的最小–最大）`);
say();
say(`| 一天 | ${AUTONOMY_ACTS.join(' | ')} | 合计 | 每醒着小时 | 10 分钟最多 | 1 小时最多 | 同一动作连续最多 | 两次最短间隔(分) | 困时大动作 | 害怕时动作 | 忙/说话时大动作 | 你离开时 | 平均幅度 | 定住(分) | 写回 D/E/N/C/A | 叠在曲线上最多 D/E/N/C/A |`);
say(`|---|${AUTONOMY_ACTS.map(() => '---').join('|')}|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
const timelines: string[] = [];
for (const day of SYNTHETIC_DAYS) {
  const runs: DayResult[] = Array.from({ length: seeds }, (_, i) => simulateDay(day, i + 1));
  const r = runs[0];
  const range = (pick: (x: DayResult) => number) => { const v = runs.map(pick); return `${pick(r)}（${Math.min(...v)}–${Math.max(...v)}）`; };
  const f = (n: number) => n.toFixed(1);
  say(`| ${day.label} | ${AUTONOMY_ACTS.map(a => range(x => x.counts[a])).join(' | ')} | ${range(x => x.acts.length)} | ${f(r.perWakingHour)} | ${range(x => x.max10)} | ${range(x => x.max60)} | ${range(x => x.maxRun)} | ${r.minGapMin?.toFixed(1) ?? '-'} | ${range(x => x.bigWhileSleepy)} | ${range(x => x.whileAfraid)} | ${range(x => x.bigWhileBusyOrTalking)} | ${range(x => x.acts.filter(a => a.mode === 'away').length)} | ${r.acts.length ? (r.acts.reduce((s, a) => s + a.amplitude, 0) / r.acts.length).toFixed(2) : '-'} | ${f(r.freezeMinutes)} | ${[r.written.D, r.written.E, r.written.N, r.written.C].map(f).join('/')}/${r.written.A.toFixed(3)} | ${[r.peakOffset.D, r.peakOffset.E, r.peakOffset.N, r.peakOffset.C].map(f).join('/')}/${r.peakOffset.A.toFixed(3)} |`);
  timelines.push(`## ${day.label}（种子 1）`, ...r.acts.map(a => `${clock(a.minute)} ${a.act.padEnd(8)} 想做 ${a.want.toFixed(2)} 幅度 ${a.amplitude.toFixed(2)} A ${a.A.toFixed(2)} ${a.mode}${a.talking ? ' 说话中' : ''} 空闲 ${Math.round(a.idleSeconds)}s${a.wobble ? ' 差点没站稳' : ''}${a.completed ? '' : ' （提前收）'}`), '');
}
if (args.includes('--timeline')) { say(); for (const line of timelines) say(line); }
writeFileSync(path.join(out, 'day-sim.md'), [...lines, '', ...(args.includes('--timeline') ? [] : timelines)].join('\n'));
console.log(`\n→ ${path.join(out, 'day-sim.md')}`);
