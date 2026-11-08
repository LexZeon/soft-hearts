/**
 * Pretrial 2026-11-03 (L4, 问题 5 and 9): "有小情绪时脸和平常几乎一样", and the warmth after soothing hardly showed. Besides the head
 * channel coming back with the default Stand (tests/stage-default-stand-head.test.ts) and a little more face in the table, how plainly
 * it shows now follows her character and her mood (I-013, not one fixed size): herNeedVisibility, eased in by the stage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HER_NEED_TABLE, herNeedVisibility, scaledHerNeedPresentation } from '../shared/her-needs';
import { HER_LIFE_NEUTRAL_PRESENTATION } from '../shared/her-life';
import { HerLifeStage } from '../src/stage/her-life-stage';

const neutral = { D: 50, O: 50, E: 50, N: 50, C: 50 };
test('a small feeling shows more on a sensitive card and in a lower mood; the warmth more on a close or playful card and a happier one; always bounded', () => {
  const average = herNeedVisibility('need', {}, neutral);
  assert.ok(Math.abs(average - 1) < 1e-9, `an average card in a middle mood shows the table as it is (${average})`);
  const sensitive = herNeedVisibility('need', { close: 2.5, cautious: 2 }, neutral), carefree = herNeedVisibility('need', { close: 0.2, cautious: 0.2 }, neutral);
  assert.ok(sensitive > average && carefree < average, `${sensitive} > ${average} > ${carefree}`);
  assert.ok(herNeedVisibility('need', {}, { ...neutral, D: 30, O: 32 }) > average, 'a lower mood shows it more');
  assert.ok(herNeedVisibility('glow', { close: 2, playful: 2 }, { ...neutral, D: 70, O: 72 }) > herNeedVisibility('glow', { close: 0.5, playful: 0.5 }, neutral));
  for (const mode of ['need', 'glow', 'low'] as const) for (const w of [0, 1, 4]) for (const d of [0, 50, 100]) {
    const k = herNeedVisibility(mode, { close: w, cautious: w, playful: w }, { ...neutral, D: d, O: d });
    assert.ok(k >= 0.7 && k <= 1.5, `${mode} ${w} ${d}: ${k}`);
  }
  const big = scaledHerNeedPresentation({ id: 'lonely', mode: 'need' }, 1.5), spec = HER_NEED_TABLE.lonely.presentation;
  assert.ok(Math.abs(big.lidSoft - 1.5 * spec.lidSoft) < 1e-12 && Math.abs(big.headZ - 1.5 * spec.headZ) < 1e-12, 'the stage may push the look up to 1.5×');
  assert.ok(big.lidSoft > HER_LIFE_NEUTRAL_PRESENTATION.lidSoft);
});

test('the stage: the look scales with visibility, and a change of visibility eases in (no step)', () => {
  const owner = {}, gates = { expressive: true, engaged: false, bodyOwned: false, asleep: false, posture: 50 };
  const need = { id: 'lonely' as const, mode: 'need' as const, since: 0, strength: 1, usedToday: 1 };
  const stage = new HerLifeStage(null), dt = 1 / 60;
  for (let i = 0; i < 600; i++) stage.frame(dt, { owner, view: null, need, nowMs: 0, gates, needVisibility: 1 });
  const at1 = stage.life.lidSoft;
  let previous = at1, biggest = 0;
  for (let i = 0; i < 600; i++) { stage.frame(dt, { owner, view: null, need, nowMs: 0, gates, needVisibility: 1.4 }); biggest = Math.max(biggest, Math.abs(stage.life.lidSoft - previous)); previous = stage.life.lidSoft; }
  assert.ok(Math.abs(at1 - HER_NEED_TABLE.lonely.presentation.lidSoft) < 1e-3, `at 1: the table (${at1})`);
  assert.ok(Math.abs(stage.life.lidSoft - 1.4 * at1) < 2e-3, `at 1.4: 1.4× (${stage.life.lidSoft})`);
  assert.ok(biggest < 0.002, `eases in: largest step per frame ${biggest}`);
});
