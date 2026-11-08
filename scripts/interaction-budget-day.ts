// I-010 互动余额: how active she is on a silent, a quiet and a lively day, per character type, before and after the budget.
// Fake clock, fake model (she always says her line when given a speech cue), real mood / opening choice / needs / invitation rules.
// CPU-heavy: run through the I-030 gate:
//   node scripts/dev/heavy.mjs --label budget-day -- node node_modules/tsx/dist/cli.mjs scripts/interaction-budget-day.ts [--seeds 1,2,3]
import { GENE_DAY_CARD } from './inner-loop-day-cards';
import { characterTypes, livelyUser, QUIET_USER, runBudgetDay, SILENT_USER, type BudgetDayResult, type DayUser } from './lib/budget-day';

const option = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const seeds = option('seeds', '1,2,3').split(',').map(Number);

const KEYS = ['lines', 'invites', 'games', 'needs', 'interactions', 'opportunities', 'budgetQuiet'] as const;
type Key = typeof KEYS[number];
const mean = (runs: BudgetDayResult[], key: Key) => runs.reduce((sum, run) => sum + run[key], 0) / runs.length;
const show = (runs: BudgetDayResult[]) => `说 ${mean(runs, 'lines').toFixed(1)}（其中邀请 ${mean(runs, 'invites').toFixed(1)}）· 小情绪 ${mean(runs, 'needs').toFixed(1)}`
  + ` · 一起玩 ${mean(runs, 'games').toFixed(1)} · 说话时机 ${mean(runs, 'opportunities').toFixed(1)} · 余额压成不说 ${mean(runs, 'budgetQuiet').toFixed(1)} · 你的互动 ${mean(runs, 'interactions').toFixed(1)}`;

void (async () => {
  const days: [string, (seed: number) => DayUser][] = [['一整天没理她', () => SILENT_USER], ['安静的一天', () => QUIET_USER], ['热闹的一天', livelyUser]];
  console.log(`08:00–24:00，假时钟，种子 ${seeds.join(',')} 的平均（她拿到说话时机就说，是上限）\n`);
  for (const type of characterTypes(GENE_DAY_CARD.parameters)) {
    console.log(`== ${type.name} ==`);
    for (const [name, user] of days) {
      const before: BudgetDayResult[] = [], after: BudgetDayResult[] = [];
      for (const seed of seeds) {
        before.push(await runBudgetDay({ parameters: type.parameters, user: user(seed), seed, budget: false }));
        after.push(await runBudgetDay({ parameters: type.parameters, user: user(seed), seed, budget: true }));
      }
      console.log(`${name}\n  原来：${show(before)}\n  余额：${show(after)}`);
    }
    console.log('');
  }
  process.exit(0);
})();
