// I-020 #10: the frequency comparison of docs/claude/2026-11-04-opening-choice.md, old fixed order vs. her pick, same seeds.
// Fake models only (no Claude call, no quota):
//   node node_modules/tsx/dist/cli.mjs scripts/opening-choice-compare.ts [--seeds 1,2,3,4,5,6,7,8,9,10]
import { runInnerLoopDay, type DayDecide, type DayResult } from './lib/inner-loop-day';
import { simulateNight, type NightResult } from './lib/listen-night';
import { GENE_DAY_CARD } from './inner-loop-day-cards';
import { BoredomTimingDirector } from '../shared/behaviors/boredom-timing/choose';
import { OpeningChoiceDirector } from '../shared/behaviors/opening-choice/choose';

function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const option = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const seeds = option('seeds', '1,2,3,4,5,6,7,8,9,10').split(',').map(Number);

/** The user's day: an afternoon and an evening away (the evening runs into the night window). */
export const COMPARE_BLOCKS = [{ startMinute: 14 * 60, idleMinutes: 150 }, { startMinute: 21 * 60 + 30, idleMinutes: 150 }];
const none: DayDecide = async () => ({ text: '{"action":"none"}' });
const speak: DayDecide = async (_prompt, _signal, info) => ({ text: info.allowSpeech ? '{"action":"speak","text":"忙完了吗？"}' : '{"action":"look"}' });

export async function compareDay(seed: number, decide: DayDecide): Promise<{ old: DayResult; choice: DayResult }> {
  // One local midnight for both runs: each run reading the clock itself put them a day apart when a run straddled midnight
  // (the packaged unit run at 00:00 on 2026-11-07).
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const base = { card: GENE_DAY_CARD, blocks: COMPARE_BLOCKS, decide, midnight: midnight.getTime() };
  const old = await runInnerLoopDay({ ...base, boredomTiming: new BoredomTimingDirector({ random: rng(seed) }) });
  const choice = await runInnerLoopDay({ ...base, boredomTiming: new BoredomTimingDirector({ random: rng(seed) }),
    opening: { chooser: new OpeningChoiceDirector({ random: rng(seed * 31 + 5) }) } });
  return { old, choice };
}

export async function compareNight(seed: number): Promise<{ old: NightResult; choice: NightResult }> {
  return { old: await simulateNight({ seed }), choice: await simulateNight({ seed, choice: {} }) };
}

if (process.argv[1] && process.argv[1].endsWith('opening-choice-compare.ts')) {
  void (async () => {
    for (const [name, decide] of [['none', none], ['speak', speak]] as const) {
      console.log(`\n一天（Gene，下午 14:00 和晚上 21:30 各空闲 150 分钟），假模型总是 ${name}：`);
      for (const seed of seeds) {
        const { old, choice } = await compareDay(seed, decide);
        console.log(`seed ${seed}: 说话时机 ${old.opportunities.speech} → ${choice.opportunities.speech}；说出口 ${old.spoken.length} → ${choice.spoken.length}；`
          + `小模型 ${old.calls} → ${choice.calls}（说话时机上 ${old.diagnostics.filter(d => d.cue === 'speech' && d.called).length} → ${choice.diagnostics.filter(d => d.cue === 'speech' && d.called).length}）；谁 ${JSON.stringify(choice.owners)}`);
      }
    }
    console.log('\n一起听一晚（20 首歌、2 集剧，用户一半会接话）：');
    for (const seed of seeds) {
      const { old, choice } = await compareNight(seed);
      console.log(`seed ${seed}: 开口时机 ${old.cues} → ${choice.cues}；说出口 ${old.spoken} → ${choice.spoken}（聊歌 ${old.lines} → ${choice.lines}，她自己 ${choice.innerLines}）；`
        + `聊天模型 ${old.chatCalls} → ${choice.chatCalls}；小模型（开口） 0 → ${choice.innerCalls}；不说 ${choice.quiet}；笔记 haiku ${old.haikuCalls} → ${choice.haikuCalls}`);
    }
    process.exit(0);
  })();
}
