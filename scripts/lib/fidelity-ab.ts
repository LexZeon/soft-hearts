// First-token A/B for a change to the chat's fixed system prompt (the companion rules): the same
// cards and situations are run under both prompts in one time window, alternating which goes first,
// and only first-token / first-sentence times are measured (no scoring). R28 found that one extra
// sentence at the end of the per-turn message moved the first-token median from 0.8 s to 2.6 s, and
// that a time-of-day drift is bigger than most prompt effects, so sequential runs prove nothing.
import { runEval } from './prompt-eval-runner';
import type { TurnRecord } from './prompt-eval-analysis';
import type { AbRecord } from './fidelity-report';
import { toEvalScenarios, type FidelityCard, type FidelityScenario } from './fidelity-scenarios';
import type { CallBudget } from './fidelity-run';

export interface AbOptions {
  model: string;
  cards: readonly FidelityCard[];
  scenarios: readonly FidelityScenario[];
  repeat: number;
  /** Round to start counting from (default 0); an odd value swaps who goes first, for a second block that balances the first. */
  firstRound?: number;
  /** Variant A is measured first on even rounds, B first on odd rounds. */
  a: { label: string; systemPrompt: string };
  b: { label: string; systemPrompt: string };
  binary: string;
  binaryArgs?: readonly string[];
  prewarmMs: number;
  budget: CallBudget;
  log?: (line: string) => void;
}

export async function runAb(options: AbOptions): Promise<{ items: AbRecord[]; stopped: string | null }> {
  const items: AbRecord[] = [];
  let round = options.firstRound ?? 0;
  try {
    for (let rep = 1; rep <= options.repeat; rep++) {
      for (const card of options.cards) {
        for (const scenario of options.scenarios) {
          const order = round++ % 2 === 0 ? [options.a, options.b] : [options.b, options.a];
          for (const variant of order) {
            await runEval({
              label: variant.label, model: options.model, repeat: rep, scenarios: toEvalScenarios([scenario]),
              binary: options.binary, ...(options.binaryArgs ? { binaryArgs: options.binaryArgs } : {}), prewarmMs: options.prewarmMs,
              card: { persona: card.persona, mood: card.mood }, systemPrompt: variant.systemPrompt,
              beforeTurn: () => options.budget.take('reply'),
              onTurn: (record: TurnRecord) => {
                items.push({ variant: variant.label, record });
                options.log?.(`  ${variant.label} ${card.id}/${scenario.id}#${record.turn} ${record.process ?? ''} 首字 ${record.chunks[0]?.[0] ?? '–'} ms${record.error ? ` 错误：${record.error}` : ''}`);
              },
            });
          }
        }
      }
    }
  } catch (error) {
    return { items, stopped: error instanceof Error ? error.message : String(error) };
  }
  return { items, stopped: null };
}
