import assert from 'node:assert/strict';
import test from 'node:test';
import { DROWSY_RELEASE_SECONDS, DrowsyExpression } from '../src/stage/drowsy-expression';

type Input = Parameters<DrowsyExpression['frame']>[1];
type Frame = ReturnType<DrowsyExpression['frame']>;
const MAX = { headX: .018, brow: .06, rawEye: .12 } as const;
const input = (change: Partial<Input> = {}): Input => ({
  scope: 'model-a/character-a/token-a', verified: true, phase: 'drowsy', F: 1,
  headAllowed: true, browAllowed: true, eyeAllowed: true, finalClosure: 0,
  ...change,
});
function close(actual: number, expected: number, label: string): void {
  assert.ok(Number.isFinite(actual), `${label} must remain finite`);
  assert.ok(Math.abs(actual - expected) <= 1e-12, `${label}: ${actual} versus ${expected}`);
}
function neutral(frame: Frame): void {
  assert.deepEqual(frame, { headX: 0, brow: 0, eyeShape: 0, rawEye: 0, active: false });
}
function sameValues(actual: Frame, expected: Frame): void {
  for (const key of ['headX', 'brow', 'rawEye', 'eyeShape'] as const) close(actual[key], expected[key], key);
}
function fresh(change: Partial<Input> = {}): DrowsyExpression {
  const expression = new DrowsyExpression();
  neutral(expression.frame(0, input(change)));
  return expression;
}
function warm(change: Partial<Input> = {}): { expression: DrowsyExpression; frame: Frame } {
  const expression = fresh(change);
  let frame = expression.frame(.1, input(change));
  for (let i = 1; i < 6; i++) frame = expression.frame(.1, input(change));
  assert.ok(frame.active);
  return { expression, frame };
}

test('drowsy intent follows the approved full-scale targets and linear finite F', () => {
  for (const F of [0, .25, .7, 1]) {
    const expression = fresh({ F });
    const frame = expression.frame(.1, input({ F }));
    const attack = 1 - Math.exp(-.1 / .35);
    for (const key of ['headX', 'brow', 'rawEye'] as const) close(frame[key], MAX[key] * F * attack, `${key} F=${F}`);
    close(frame.eyeShape, frame.rawEye, 'open-eye applied contribution');
    if (F > 0) assert.ok(frame.active);
  }
  sameValues(new DrowsyExpression().frame(.1, input()), fresh().frame(.1, input()));
});

test('attack integrates elapsed time across frame partitions without exceeding approved maxima', () => {
  const split = fresh(), single = fresh();
  let actual = split.frame(.02, input());
  for (const dt of [.03, .05]) actual = split.frame(dt, input());
  sameValues(actual, single.frame(.1, input()));
  for (let i = 0; i < 200; i++) actual = split.frame(.1, input());
  for (const key of ['headX', 'brow', 'rawEye'] as const) {
    assert.ok(actual[key] <= MAX[key], key);
    close(actual[key], MAX[key], `${key} asymptote`);
  }
});

test('lower targets release with tau .5 even when F rises but remains below the current intent', () => {
  const { expression, frame: before } = warm();
  const down = expression.frame(.1, input({ F: .25 }));
  for (const key of ['headX', 'brow', 'rawEye'] as const)
    close(down[key], MAX[key] * .25 + (before[key] - MAX[key] * .25) * Math.exp(-.1 / .5), `${key} falling target`);
  const risesBelowCurrent = expression.frame(.1, input({ F: .5 }));
  for (const key of ['headX', 'brow', 'rawEye'] as const) {
    assert.ok(down[key] > MAX[key] * .5, 'test must exercise release despite a larger F');
    close(risesBelowCurrent[key], MAX[key] * .5 + (down[key] - MAX[key] * .5) * Math.exp(-.1 / .5), `${key} below-current target`);
  }
});

test('final closure attenuates already-smoothed eye intent immediately and never enters its history', () => {
  const masked = fresh(), control = fresh();
  for (const finalClosure of [0, .4, 1, .75, 0]) {
    const actual = masked.frame(.03, input({ finalClosure }));
    const raw = control.frame(.03, input());
    close(actual.rawEye, raw.rawEye, 'raw eye intent is independent of closure');
    close(actual.eyeShape, actual.rawEye * (1 - finalClosure), 'same-frame closure product');
    close(actual.headX, raw.headX, 'closure leaves head intent');
    close(actual.brow, raw.brow, 'closure leaves brow intent');
    if (finalClosure === 1) assert.equal(actual.eyeShape, 0);
  }
  const onlyEye = fresh({ headAllowed: false, browAllowed: false, finalClosure: 1 });
  const fullyClosed = onlyEye.frame(.1, input({ headAllowed: false, browAllowed: false, finalClosure: 1 }));
  assert.equal(fullyClosed.headX, 0); assert.equal(fullyClosed.brow, 0); assert.equal(fullyClosed.eyeShape, 0);
  assert.ok(fullyClosed.rawEye > 0); assert.equal(fullyClosed.active, true);
});

// R29c (was: "each lost channel clears its raw value immediately"): losing an
// owner is a hand-off, never a one-frame cut. The channel fades from the value
// it shows, with zero speed at both ends, while the others keep their histories.
const smoothstep = (t: number) => t * t * (3 - 2 * t);
test('R29c: each lost channel fades from its shown value (zero speed at both ends) while other channels keep their histories', () => {
  const channels = [
    { gate: 'headAllowed', field: 'headX' },
    { gate: 'browAllowed', field: 'brow' },
    { gate: 'eyeAllowed', field: 'rawEye' },
  ] as const;
  const dt = 1 / 60, frames = Math.round(DROWSY_RELEASE_SECONDS / dt);
  for (const { gate, field } of channels) {
    const { expression, frame: before } = warm();
    const shown = before[field];
    // Event time (dt 0): nothing changes yet, so an event between ticks never cuts.
    const held = expression.frame(0, input({ [gate]: false }));
    close(held[field], shown, `${field} is unchanged at dt 0`);
    assert.equal(expression.releasing, true);
    const values = [shown];
    for (let i = 1; i <= frames; i++) {
      const denied = expression.frame(dt, input({ [gate]: false }));
      values.push(denied[field]);
      close(denied[field], i === frames ? 0 : shown * (1 - smoothstep(i / frames)), `${field} release frame ${i}`);
      for (const other of ['headX', 'brow', 'rawEye'] as const) if (other !== field) assert.ok(denied[other] > 0, `${other} remains owned`);
    }
    const stepsTaken = values.slice(1).map((value, i) => Math.abs(value - values[i]));
    assert.ok(Math.max(...stepsTaken) <= shown * 1.5 / frames + 1e-12, `${field}: no frame takes more than the smoothstep peak`);
    assert.ok(stepsTaken[0] < shown * 0.01 && stepsTaken.at(-1)! < shown * 0.01, `${field}: zero speed at both ends`);
    assert.equal(expression.releasing, false);
    if (gate === 'eyeAllowed') assert.equal(expression.frame(dt, input({ [gate]: false })).eyeShape, 0);
    const resumed = expression.frame(.05, input());
    close(resumed[field], MAX[field] * (1 - Math.exp(-.05 / .35)), `${field} reentry after the release starts neutral`);
  }
});

test('R29c: an owner returning mid-release continues from what is shown; the eye mask still applies while fading', () => {
  const { expression, frame: before } = warm();
  let frame = before;
  for (let i = 0; i < 6; i++) frame = expression.frame(1 / 60, input({ browAllowed: false, eyeAllowed: false }));
  assert.ok(frame.brow < before.brow && frame.brow > 0);
  const fading = expression.frame(1 / 60, input({ browAllowed: false, eyeAllowed: false, finalClosure: 1 }));
  assert.ok(fading.rawEye > 0, 'the raw eye keeps fading underneath');
  assert.equal(fading.eyeShape, 0, 'a closed lid (natural blink) still wins over a fading eye shape');
  const back = expression.frame(.05, input());
  close(back.brow, fading.brow + (MAX.brow - fading.brow) * (1 - Math.exp(-.05 / .35)), 'brow eases on from the shown value');
  assert.equal(expression.releasing, false);
});

test('awake and light-drowsy release still-owned intent toward base instead of retaining a drowsy target', () => {
  for (const phase of ['awake', 'light-drowsy']) {
    const { expression, frame: before } = warm();
    const released = expression.frame(.1, input({ phase }));
    for (const key of ['headX', 'brow', 'rawEye'] as const) {
      close(released[key], before[key] * Math.exp(-.1 / .5), `${key} ${phase}`);
      assert.ok(released[key] > 0 && released[key] < before[key]);
    }
    close(released.eyeShape, released.rawEye, 'release still obeys open eye mask');
  }
});

test('R29c: sleep transition, sleeping and micro-awake release by the same fade; null and unsupported phases still revoke at once', () => {
  for (const phase of ['falling-asleep', 'asleep', 'micro-awake']) {
    const { expression, frame: before } = warm();
    const held = expression.frame(0, input({ phase }));
    sameValues(held, before);
    let frame = held;
    for (let i = 0; i < Math.ceil(DROWSY_RELEASE_SECONDS * 60); i++) {
      const next = expression.frame(1 / 60, input({ phase }));
      for (const key of ['headX', 'brow', 'rawEye'] as const) assert.ok(next[key] <= frame[key] + 1e-15, `${key} only falls while ${phase}`);
      frame = next;
    }
    neutral(frame);
    neutral(expression.frame(1 / 60, input({ phase })));
  }
  for (const phase of [null, 'unsupported-phase']) {
    const { expression } = warm();
    neutral(expression.frame(0, input({ phase })));
    sameValues(expression.frame(.05, input()), fresh().frame(.05, input()));
  }
});

test('unverified or invalid strength/closure clears all history rather than preserving a prior valid frame', () => {
  const invalid: Partial<Input>[] = [
    { verified: false },
    ...[null, NaN, Infinity, -Infinity, -.001, 1.001].map(F => ({ F })),
    ...[NaN, Infinity, -Infinity, -.001, 1.001].map(finalClosure => ({ finalClosure })),
  ];
  for (const invalidInput of invalid) {
    const { expression } = warm();
    neutral(expression.frame(0, input(invalidInput)));
    sameValues(expression.frame(.05, input()), fresh().frame(.05, input()));
  }
});

test('a scope change or absent scope never transfers the previous model-character-token intent', () => {
  const { expression } = warm();
  const second = input({ scope: 'model-b/character-b/token-b' });
  sameValues(expression.frame(.05, second), fresh({ scope: second.scope }).frame(.05, second));
  const third = input({ scope: 'model-c/character-c/token-c' });
  neutral(expression.frame(0, third));
  sameValues(expression.frame(.05, third), fresh({ scope: third.scope }).frame(.05, third));
  for (const scope of [null, '']) {
    neutral(expression.frame(0, input({ scope })));
    sameValues(expression.frame(.05, input()), fresh().frame(.05, input()));
  }
});

test('render delta is bounded to .1, negative is zero, and nonfinite delta revokes all history', () => {
  for (const delta of [.1, .2, 5, Number.MAX_VALUE]) {
    const expression = fresh();
    sameValues(expression.frame(delta, input()), fresh().frame(.1, input()));
  }
  for (const delta of [0, -.1]) {
    const { expression, frame: before } = warm();
    sameValues(expression.frame(delta, input()), before);
  }
  for (const delta of [NaN, Infinity, -Infinity]) {
    const { expression } = warm();
    neutral(expression.frame(delta, input()));
    sameValues(expression.frame(.05, input()), fresh().frame(.05, input()));
  }
});

test('explicit reset discards all smoothing history and is safe to repeat', () => {
  const { expression } = warm();
  expression.reset(); expression.reset();
  neutral(expression.frame(0, input()));
  sameValues(expression.frame(.05, input()), fresh().frame(.05, input()));
});

test('frame reads frozen caller input without mutating phase, scope, F or ownership gates', () => {
  const expression = fresh();
  const value = Object.freeze(input({ F: .7, finalClosure: .2 }));
  const before = { ...value };
  assert.ok(expression.frame(.05, value).active);
  assert.deepEqual(value, before);
});
