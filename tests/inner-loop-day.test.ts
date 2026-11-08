import test from 'node:test';
import assert from 'node:assert/strict';
import { runInnerLoopDay, type DayCard, type DayDecide } from '../scripts/lib/inner-loop-day';
import { GENE_DAY_CARD, SLOW_TIRED_CARD } from '../scripts/inner-loop-day-cards';
import { DEFAULT_FATIGUE_PARAMETERS } from '../shared/fatigue';
import { BoredomTimingDirector } from '../shared/behaviors/boredom-timing/choose';
import { FixedBoredomTiming } from '../shared/behaviors/boredom-timing/fake';
import { seeded } from './helpers/seeded';

// Real MoodHost + InnerLoop + shared gate on a simulated clock; the model is a fake.
const none: DayDecide = async () => ({ text: '{"action":"none"}' });
const speak: DayDecide = async (_prompt, _signal, info) => ({ text: info.allowSpeech ? '{"action":"speak","text":"忙完了吗？"}' : '{"action":"look"}' });
const afternoon = [{ startMinute: 15 * 60, idleMinutes: 90 }];
/** These check the inner loop's own pacing, on the card's boredom numbers as they are (#8's own timing: the last test). */
const runDay = (options: Parameters<typeof runInnerLoopDay>[0]) => runInnerLoopDay({ boredomTiming: new FixedBoredomTiming(), ...options });

test('the card\'s own frequency and thresholds decide how often she is woken and may speak', async () => {
  const gene = await runDay({ card: GENE_DAY_CARD, blocks: afternoon, decide: none });
  const slow = await runDay({ card: { ...SLOW_TIRED_CARD, fatigue: DEFAULT_FATIGUE_PARAMETERS }, blocks: afternoon, decide: none });
  // Gene (motion every 5 min, speech every 30 min after B 55/75): first wake ~32 min, then about every 10 min.
  assert.equal(gene.calls, 6, JSON.stringify(gene.diagnostics));
  assert.equal(gene.allowSpeechCalls, 2);
  // The slower card (B 60/85 at 1.2/min, motion every 10 min, speech every 60 min): fewer wakes, one speech chance.
  assert.equal(slow.calls, 3, JSON.stringify(slow.diagnostics));
  assert.equal(slow.allowSpeechCalls, 1);
  assert.ok(gene.opportunities.motion > slow.opportunities.motion);
  // Rule-only motion opportunities still happen between model calls (at most one call per 2 × motion interval).
  assert.ok(gene.opportunities.motion > gene.calls - gene.opportunities.speech);
  const prompts = new Set([gene.prompts[0], slow.prompts[0]]);
  assert.equal(prompts.size, 2);
  assert.match(slow.prompts[0], /Momo/); assert.doesNotMatch(gene.prompts[0], /Momo/);
});

test('speechPerHour or speechWithoutReply of 0: she never speaks, whatever the model wants', async () => {
  for (const frequency of [{ speechPerHour: 0 }, { speechWithoutReply: 0 }]) {
    const parameters = structuredClone(GENE_DAY_CARD.parameters); Object.assign(parameters.frequency, frequency);
    const card: DayCard = { ...GENE_DAY_CARD, parameters };
    const result = await runDay({ card, blocks: afternoon, decide: speak });
    assert.equal(result.opportunities.speech, 0); assert.equal(result.allowSpeechCalls, 0); assert.deepEqual(result.spoken, []);
    assert.ok(result.calls > 0, 'motion opportunities still ask');
  }
});

test('a spoken line keeps the shared speech quota; an unspoken decision returns it', async () => {
  const spoken = await runDay({ card: GENE_DAY_CARD, blocks: afternoon, decide: speak });
  // Gene allows one unanswered line: after it, no speech opportunity (for any source) until the user replies.
  assert.equal(spoken.spoken.length, 1); assert.equal(spoken.opportunities.speech, 1);
  const invalid = await runDay({ card: GENE_DAY_CARD, blocks: afternoon,
    decide: async () => ({ text: '{"action":"speak","text":"太长太长太长太长太长太长太长太长太长太长太长"}' }) });
  assert.deepEqual(invalid.spoken, []);
  assert.equal(invalid.opportunities.speech, 2, 'the quota came back; the next chance still waited a full speech interval');
  assert.ok(invalid.diagnostics.every(entry => entry.result === 'invalid'));
});

test('late at night, or for a more easily tired character, she only moves or looks', async () => {
  const evening = [{ startMinute: 21 * 60, idleMinutes: 90 }];
  const gene = await runDay({ card: GENE_DAY_CARD, blocks: evening, decide: speak });
  const tired = await runDay({ card: { ...GENE_DAY_CARD, fatigue: SLOW_TIRED_CARD.fatigue }, blocks: evening, decide: speak });
  assert.equal(gene.allowSpeechCalls, 1, 'Gene may still speak before her night window (≈22:26)');
  assert.equal(tired.allowSpeechCalls, 0, 'the easily tired body clock is already in its night window (≈21:14)');
  assert.ok(tired.quietSpeechCalls > 0); assert.deepEqual(tired.spoken, []);
  assert.ok(tired.diagnostics.filter(entry => entry.called).every(entry => entry.decision === 'look' || entry.decision === 'none'));
});

test('#8: her own timing (when to look, move, want to speak) never wakes the inner loop more often than the card\'s fixed numbers', async () => {
  const blocks = [{ startMinute: 14 * 60, idleMinutes: 95 }, { startMinute: 16 * 60, idleMinutes: 140 }];
  let differs = 0;
  for (const card of [GENE_DAY_CARD, { ...SLOW_TIRED_CARD, fatigue: DEFAULT_FATIGUE_PARAMETERS }]) {
    const fixed = await runDay({ card, blocks, decide: none });
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const own = await runInnerLoopDay({ card, blocks, decide: none, boredomTiming: new BoredomTimingDirector({ random: seeded(seed) }) });
      const label = `${card.id} seed ${seed}: ${own.calls} calls vs ${fixed.calls}`;
      assert.ok(own.calls <= fixed.calls, `${label} ${JSON.stringify(own.diagnostics.map(d => [d.at, d.cue]))}`);
      assert.ok(own.allowSpeechCalls <= fixed.allowSpeechCalls, label);
      assert.ok(own.opportunities.speech <= fixed.opportunities.speech && own.opportunities.motion <= fixed.opportunities.motion, label);
      if (own.calls !== fixed.calls || own.opportunities.motion !== fixed.opportunities.motion) differs++;
    }
  }
  assert.ok(differs > 0, 'the timing did change');
});
