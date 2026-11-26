// I-184: the host side of her close moments through the peek's own channel (electron/unbound/peek.ts + close-moments.ts): pulled close
// and held → exactly one decision per let-go; a short hold → the look as before; a kiss is recorded once, when its hold is reached (the
// mood moment, the cap, her next turn's line); cancelled before → nothing; repeated pulls inside the cooldown never get another kiss; her
// own: the peek's slot is sometimes a kiss or a hug, never past the day's cap; the turn line is told once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PeekDirectorHost, type PeekLink, type PeekPorts } from '../electron/unbound/peek';
import { CloseMomentsHost, labelOf, temperamentOf, type CloseMomentPorts } from '../electron/unbound/close-moments';
import { UnboundHistory } from '../electron/unbound/history-host';
import { CLOSE_MOMENT_KNOBS, type CloseHappened } from '../shared/unbound/close-moments';
import { NEUTRAL_MOOD, type PeekCommand } from '../shared/unbound/director';
import { NEAR_ARM_MS, parseUnboundPull, pullReportMessage } from '../shared/unbound/pull';

const WARM = { ...NEUTRAL_MOOD, O: 80, E: 66, D: 62, M: 20 };
const BOLD_VIEW = { snapshot: { primary: 'close' }, parameters: { weights: { playful: 2.4, close: 1.8, comfortable: 1.2, cautious: 0.4 }, intensity: { expression: 85, playful: 85 } } };

function rig(options: { random?: () => number; speaking?: boolean; playing?: boolean; view?: unknown } = {}) {
  let now = 1_700_000_000_000, idle = 120, timers: (() => void)[] = [];
  const sent: PeekCommand[] = [], moments: string[] = [], happened: CloseHappened[] = [];
  let random = options.random ?? (() => 0.5);
  const closePorts: CloseMomentPorts = {
    clock: () => now, random: () => random(), day: () => 'today', mood: () => ({ ...WARM }), view: () => (options.view ?? BOLD_VIEW) as never,
    typing: () => false, playing: () => options.playing === true, moment: kind => { moments.push(kind); return true; }, happened: item => happened.push(item),
  };
  const close = new CloseMomentsHost(closePorts);
  const ports: PeekPorts = {
    clock: () => now, random: () => random(), idleSeconds: () => idle, asleep: () => false, inCall: () => false, userTalking: () => false,
    mood: () => ({ ...WARM }), lastInteractionAt: () => null, answered: () => true, readingAloud: () => options.speaking === true,
    every: (_ms, run) => { timers.push(run); return () => { timers = timers.filter(t => t !== run); }; }, close,
  };
  const link: PeekLink = { shown: () => true, fullscreen: () => false, send: c => sent.push(c), changed: () => {} };
  const host = new PeekDirectorHost(ports, link);
  const starts = () => sent.filter((c): c is Extract<PeekCommand, { type: 'start' }> => c.type === 'start');
  return {
    host, close, sent, moments, happened, starts,
    advance(ms: number) { now += ms; for (const t of [...timers]) t(); },
    set random(f: () => number) { random = f; }, set idle(v: number) { idle = v; }, get now() { return now; },
    finish(id: string) { for (const phase of ['notice', 'walk', 'lean', 'hold', 'back', 'settle', 'done'] as const) host.report({ id, phase }); },
  };
}

test('pulled close, held long enough: one decision per let-go; a kiss plays through the peek channel with the near buffer', () => {
  const f = rig({ random: () => 0.3 });
  assert.equal(f.host.pulledNear(CLOSE_MOMENT_KNOBS.pullHoldMs + 100), true);
  assert.equal(f.host.pulledNear(CLOSE_MOMENT_KNOBS.pullHoldMs + 100), false, 'a second let-go while it plays: no second decision');
  const [start] = f.starts();
  assert.equal(f.starts().length, 1);
  assert.equal(start.plan.action, 'close-moment');
  assert.equal(start.armAfterMs, NEAR_ARM_MS, 'the hand leaving the mouse does not count');
  assert.equal(f.close.view().last?.via, 'pulled');
});

test('pulled close but let go at once (shorter than pullHoldMs): the look as before, no decision', () => {
  const f = rig({ random: () => 0.3 });
  assert.equal(f.host.pulledNear(CLOSE_MOMENT_KNOBS.pullHoldMs - 1), true);
  assert.equal(f.starts()[0].plan.action, 'peek-lens');
  assert.equal(f.close.view().last, null, 'the chooser was not asked');
  const g = rig(); assert.equal(g.host.pulledNear(), true, 'an old page (no hold sent): the look');
  assert.equal(g.starts()[0].plan.action, 'peek-lens');
});

test('a kiss is recorded once, when its hold is reached: the mood moment, the record, her next turn\'s line; cancelled before the hold: nothing', () => {
  const f = rig({ random: () => 0.3 });
  f.host.pulledNear(5_000);
  const id = f.starts()[0].id, plan = f.starts()[0].plan as { kind: string };
  assert.ok(plan.kind === 'kiss' || plan.kind === 'hug', `a warm, bold, old acquaintance: ${plan.kind}`);
  f.host.report({ id, phase: 'lean' });
  assert.deepEqual(f.moments, []);
  f.host.report({ id, phase: 'hold' }); f.host.report({ id, phase: 'hold' });
  assert.deepEqual(f.moments, [plan.kind], 'once');
  assert.equal(f.happened.length, 1); assert.equal(f.happened[0].via, 'pulled');
  assert.equal(f.close.history.size, 1);
  f.finish(id);
  const g = rig({ random: () => 0.3 });
  g.host.pulledNear(5_000);
  const gid = g.starts()[0].id;
  g.host.report({ id: gid, phase: 'lean' }); g.host.report({ id: gid, phase: 'back', cancelled: 'input' }); g.host.report({ id: gid, phase: 'hold' });
  assert.deepEqual(g.moments, [], 'you moved before it happened: nothing is written');
  assert.equal(g.close.history.size, 0);
});

test('repeated pulls: inside pulledCooldownMinutes after a kiss or a hug, never another one (look, shy or nothing)', () => {
  const f = rig({ random: () => 0.3 });
  f.host.pulledNear(5_000);
  const first = f.starts()[0];
  f.host.report({ id: first.id, phase: 'hold' }); f.finish(first.id);
  for (let i = 0; i < 12; i++) {
    f.advance(30_000);
    f.random = () => (i * 0.083) % 1;
    const played = f.host.pulledNear(5_000);
    const last = f.starts().at(-1)!;
    if (played && last.id !== first.id) {
      const plan = last.plan as { action: string; kind?: string };
      assert.ok(plan.action === 'peek-lens' || plan.kind === 'shy', `pull ${i}: ${plan.action} ${plan.kind ?? ''}`);
      f.host.report({ id: last.id, phase: 'hold' }); f.finish(last.id);
    }
  }
  assert.equal(f.moments.length, 1, 'still the one kiss');
});

test('gates on the host: she speaking or her arms held by a game — never a kiss while speaking, never a hug while a game holds her arms', () => {
  const speaking = rig({ random: () => 0.3, speaking: true });
  speaking.host.pulledNear(5_000);
  assert.ok(!speaking.starts().some(s => ['kiss', 'hug'].includes((s.plan as { kind?: string }).kind ?? '')), 'speaking: no kiss or hug');
  for (let r = 0; r < 1; r += 0.05) {
    const playing = rig({ random: () => r, playing: true });
    playing.host.pulledNear(5_000);
    assert.ok(!playing.starts().some(s => (s.plan as { kind?: string }).kind === 'hug'), `arms held (r=${r}): no hug`);
  }
});

test('her own: the peek\'s slot is sometimes a kiss or a hug (a low random), never past the day\'s cap; otherwise the look', () => {
  const f = rig({ random: () => 0.97 }); // high: past the look's share (the order is look, kiss, hug)
  const kinds: string[] = [];
  for (let i = 0; i < 8; i++) {
    f.advance(1_000); f.host.tick(); f.advance(120_000); f.host.tick();
    const last = f.starts().at(-1);
    if (!last || kinds.length > i) continue;
    const plan = last.plan as { action: string; kind?: string };
    kinds.push(plan.kind ?? plan.action);
    if (plan.kind) f.host.report({ id: last.id, phase: 'hold' });
    f.finish(last.id);
    f.advance((CLOSE_MOMENT_KNOBS.cooldownMinutes + 25) * 60_000); // past her own cooldown and the peek's
  }
  const close = kinds.filter(k => k === 'kiss' || k === 'hug').length;
  assert.ok(close >= 1, `she came for a kiss or a hug at least once: ${kinds.join(',')}`);
  assert.ok(close <= CLOSE_MOMENT_KNOBS.ownPerDay, `never past the day's cap: ${kinds.join(',')}`);
  assert.ok(kinds.includes('peek-lens'), 'and the look when capped');
  assert.ok(f.moments.every(k => k === 'kiss' || k === 'hug'));
});

test('her next turn hears it once, as a fact (the interaction history\'s line), and only while fresh', () => {
  let now = 1_000_000;
  const history = new UnboundHistory({ clock: () => now, random: () => 1, day: () => 'd', characterId: () => 'c', mood: () => null, asleep: () => false, moment: () => false, attention: () => false });
  history.closeMoment({ kind: 'kiss', via: 'own', after: 'grin', at: now });
  assert.equal(history.turnLine(), '你刚才自己凑过去亲了用户一下，然后笑了笑。');
  assert.equal(history.turnLine(), '', 'told once');
  history.closeMoment({ kind: 'hug', via: 'pulled', after: null, at: now });
  now += 11 * 60_000;
  assert.equal(history.turnLine(), '', 'too old to be "刚才"');
});

test('the card and the readings as the host reads them (anything odd: neutral); the pull message carries the hold only with a near let-go', () => {
  assert.deepEqual(temperamentOf(null), { weights: { playful: 1, close: 1, comfortable: 1, cautious: 1 }, intensity: { expression: 50, playful: 50 } });
  assert.equal(temperamentOf({ weights: { playful: 'x' } }).weights.playful, 1);
  assert.equal(labelOf('close'), 'close'); assert.equal(labelOf('smug'), null);
  const held = (m: unknown) => (m as { nearHeldMs?: number } | null)?.nearHeldMs;
  const msg = pullReportMessage({ part: 'torso', heldMs: 900 } as never, { xM: 0, depthM: 0.6 }, true, 900);
  assert.equal(held(parseUnboundPull(msg)), 900);
  assert.equal(held(parseUnboundPull({ ...msg, near: undefined })), undefined, 'no near, no hold');
  assert.equal(held(parseUnboundPull({ ...msg, nearHeldMs: 'long' })), undefined);
  assert.equal(held(pullReportMessage({ part: 'torso' } as never, { xM: 0, depthM: 0.6 }, false, 900)), undefined);
});
