/**
 * I-010 互动余额 on a simulated day (scripts/lib/budget-day.ts: real MoodHost, real opening choice, real 她也会需要你 and 猜拳 rules,
 * fake clock, fake model that always says its line). The full table for the record: scripts/interaction-budget-day.ts.
 *  - a day you never interact with her: never more than before, for every character type (no new nagging);
 *  - a lively day: she does more than on a quiet day (按活跃).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GENE_DAY_CARD } from '../scripts/inner-loop-day-cards';
import { characterTypes, livelyUser, QUIET_USER, runBudgetDay, SILENT_USER } from '../scripts/lib/budget-day';

test('a day you never interact with her: with the budget she never does more than before (lines, invitations, small needs), every character type', async () => {
  for (const type of characterTypes(GENE_DAY_CARD.parameters)) {
    const before = await runBudgetDay({ parameters: type.parameters, user: SILENT_USER, seed: 1, budget: false, to: 16 * 60 });
    const after = await runBudgetDay({ parameters: type.parameters, user: SILENT_USER, seed: 1, budget: true, to: 16 * 60 });
    const label = `${type.name}: ${JSON.stringify({ ...after, lineAt: undefined })} vs ${JSON.stringify({ ...before, lineAt: undefined })}`;
    assert.ok(after.lines <= before.lines, label);
    assert.ok(after.invites <= before.invites, label);
    assert.ok(after.needs <= before.needs, label);
    // I-039: nobody answered, so no line follows the first sooner than 3 x the card's interval (at least 90 minutes unless the card's is longer).
    const gaps = after.lineAt.slice(1).map((m, i) => m - after.lineAt[i]);
    assert.ok(gaps.every(g => g >= 85), `${label}: ${JSON.stringify(after.lineAt)}`);
  }
});

test('a lively day: she does more on her own than on a quiet day (lines, invitations and small needs together)', async () => {
  const quiet = await runBudgetDay({ parameters: GENE_DAY_CARD.parameters, user: QUIET_USER, seed: 1, budget: true });
  const lively = await runBudgetDay({ parameters: GENE_DAY_CARD.parameters, user: livelyUser(1), seed: 1, budget: true });
  const total = (r: typeof quiet) => r.lines + r.needs;
  assert.ok(lively.interactions > quiet.interactions * 5);
  assert.ok(total(lively) > total(quiet), `lively ${JSON.stringify({ ...lively, lineAt: undefined })} vs quiet ${JSON.stringify({ ...quiet, lineAt: undefined })}`);
});
