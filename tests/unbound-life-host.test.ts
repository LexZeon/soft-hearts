// Unbound v1 step 4, the host side of her own life (electron/unbound/life.ts) with fakes: what she starts and when, how she yields to
// you (a click, the box, waiting, a call, her reply, her reading aloud) and to the peek, the one mood write (you answering her coming
// closer; never her own moving, never a trial or the fast-forward), the walk's end saved, the peek's read-aloud gap, and the view
// never carrying a program name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LifeHost, LIFE_TIMING, type LifeLink, type LifePorts, type LifeReadings } from '../electron/unbound/life';
import { PeekDirectorHost, type PeekLink, type PeekPorts } from '../electron/unbound/peek';
import { NEUTRAL_MOOD, type MoodReading, type PeekCommand } from '../shared/unbound/director';
import type { LifeCommand } from '../shared/unbound/life/types';
import type { LifeSpot } from '../shared/unbound/life/action';
import { CURIOUS } from './helpers/unbound-peek';

function world(options: { readings?: Partial<LifeReadings>; mood?: MoodReading | null; random?: number } = {}) {
  const state = {
    now: 1_000_000, readings: { idleSeconds: 120, state: 'pause', pose: null, activity: null, talkedAt: null, sound: null, ...options.readings } as Partial<LifeReadings>,
    asleep: false, inCall: false, waiting: false, typing: false, reading: false, playing: false, mood: options.mood === undefined ? { ...NEUTRAL_MOOD } : options.mood,
    lastInteractionAt: null as number | null, answered: 0, shown: true, fullscreen: false, peekActive: false, here: { across: 0.78, size: 4.275 / (8 + 0.55) } as LifeSpot | null,
    sent: [] as LifeCommand[], arrived: [] as { xM: number; depthM: number }[], interrupted: [] as string[], noticed: [] as string[], told: [] as string[],
  };
  const ports: LifePorts = {
    clock: () => state.now, random: () => options.random ?? 0.5, readings: () => state.readings,
    asleep: () => state.asleep, inCall: () => state.inCall, waiting: () => state.waiting, typing: () => state.typing, readingAloud: () => state.reading,
    mood: () => state.mood, lastInteractionAt: () => state.lastInteractionAt, answered: () => { state.answered++; return true; },
    noticed: cue => state.noticed.push(cue.kind), every: () => () => {}, playing: () => state.playing,
  };
  const link: LifeLink = {
    shown: () => state.shown, fullscreen: () => state.fullscreen, out: () => true, send: command => state.sent.push(command),
    here: () => state.here, toWorld: spot => ({ xM: (spot.across - 0.5) * 3, depthM: 4.275 / spot.size - 0.55 }),
    arrived: at => { state.arrived.push(at); state.here = { across: at.xM / 3 + 0.5, size: 4.275 / (at.depthM + 0.55) }; },
    peekActive: () => state.peekActive, interruptPeek: reason => state.interrupted.push(reason), changed: () => {},
    interrupted: (action, by) => state.told.push(`${action}:${by}`),
  };
  const host = new LifeHost(ports, link);
  const starts = () => state.sent.filter((c): c is Extract<LifeCommand, { type: 'start' }> => c.type === 'start');
  const run = (seconds: number) => { for (let i = 0; i < seconds; i++) { state.now += 1_000; host.tick(); } };
  /** The page: reports the last start done at once (a walk: where it ended). */
  const finish = () => { const start = starts().at(-1)!; host.report({ id: start.id, phase: 'done', ...(start.plan.walk ? { at: { xM: start.plan.walk.xM, depthM: start.plan.walk.depthM } } : {}) }); };
  return { state, host, starts, run, finish };
}

test('left alone she lives: pauses come often, a small move every few minutes, a walk now and then; never two at once', () => {
  const w = world();
  w.state.here = { across: 0.86, size: 4.275 / (9.6 + 0.55) }; // not where she would go when you pause
  for (let s = 0; s < 3_600; s++) {
    if (s === 1_800) w.state.readings = { ...w.state.readings, idleSeconds: 5, state: 'busy' }; // then you get busy: she goes back
    w.run(1);
    const open = w.starts().length - w.state.sent.filter(c => c.type === 'cancel').length;
    // The page finishes each action a few seconds after it starts.
    if (w.host.active && s % 4 === 3) w.finish();
    assert.ok(open >= 0);
  }
  const count = (id: string) => w.starts().filter(c => c.plan.action === id).length;
  assert.ok(count('pause') > 60, `pauses in an hour: ${count('pause')}`);
  assert.ok(count('shift') + count('glance') >= 6 && count('shift') + count('glance') <= 40, `small moves: ${count('shift')} + ${count('glance')}`);
  assert.ok(count('place') >= 1 && count('place') <= 6, `walks: ${count('place')}`);
  assert.equal(w.state.answered, 0, 'nothing written without you');
});

test('you interacting: her action eases out at once (each kind), her gaze turns to you, nothing new starts, then a wait after you; typing to her never ends it (2026-11-23)', () => {
  const typed = world();
  typed.host.trial('shift'); typed.state.typing = true; typed.run(5);
  assert.ok(!typed.state.sent.some(c => c.type === 'cancel'), 'typing: she goes on (the arbiter: typing never ends an action)');
  assert.deepEqual(typed.state.sent.filter(c => c.type === 'attend').at(-1), { type: 'attend', on: true, why: 'user' }, 'typing: she still turns to you');
  for (const key of ['inCall', 'waiting', 'reading'] as const) {
    const w = world();
    w.host.trial('shift');
    w.state[key] = true;
    w.run(1);
    const cancel = w.state.sent.find(c => c.type === 'cancel');
    assert.ok(cancel && cancel.type === 'cancel' && cancel.reason === 'user', key);
    assert.deepEqual(w.state.sent.filter(c => c.type === 'attend').at(-1), { type: 'attend', on: true, why: 'user' }, key);
    w.finish();
    const before = w.starts().length;
    w.run(120);
    assert.equal(w.starts().length, before, `${key}: nothing starts while you are with her`);
    w.state[key] = false;
    w.run(1);
    assert.deepEqual(w.state.sent.filter(c => c.type === 'attend').at(-1), { type: 'attend', on: false });
    w.run(LIFE_TIMING.clickHoldMs / 1000);
    assert.equal(w.starts().filter(c => c.plan.level !== 'idle').length, 1, `${key}: a moment after you, still only the trial`);
  }
  const clicked = world();
  clicked.host.trial('glance'); clicked.host.touched(); clicked.run(1);
  assert.ok(clicked.state.sent.some(c => c.type === 'cancel' && c.reason === 'user'), 'a click');
  assert.deepEqual(clicked.state.told, [], 'a trial is never told to her');
  const replying = world();
  replying.host.trial('glance'); replying.host.chat('delta'); replying.run(1);
  assert.ok(replying.state.sent.some(c => c.type === 'cancel' && c.reason === 'user'), 'her reply');
});

test('a peek or a close moment mid-way (2026-11-23): a call, typing, a click, her reading aloud never back it off; a game (a new action of hers) does', () => {
  const w = world();
  w.state.peekActive = true; w.state.inCall = true; w.run(1);
  w.state.inCall = false; w.state.reading = true; w.run(1);
  w.state.reading = false; w.state.typing = true; w.run(1); w.state.typing = false;
  w.host.touched(); w.run(1);
  assert.deepEqual(w.state.interrupted, []);
  w.state.playing = true; w.run(1);
  assert.deepEqual(w.state.interrupted, ['play']);
});

test('no chance, no start: asleep, full-screen, not shown, no mood; whatever runs is left to finish (never frozen)', () => {
  for (const patch of [{ asleep: true }, { fullscreen: true }, { shown: false }, { mood: null }] as const) {
    const w = world();
    Object.assign(w.state, patch);
    w.run(3_600);
    assert.equal(w.starts().length, 0, JSON.stringify(patch));
  }
  const w = world();
  w.host.trial('shift'); w.state.asleep = true; w.run(30);
  assert.equal(w.state.sent.filter(c => c.type === 'cancel').length, 0, 'falling asleep does not cut her move short');
});

test('the peek asks for its turn: a lower action eases out first; nothing of hers starts while it plays', () => {
  const w = world();
  w.host.trial('place');
  assert.equal(w.host.claim(), false, 'a walk is under way: not yet');
  assert.ok(w.state.sent.some(c => c.type === 'cancel' && c.reason === 'higher'));
  w.finish();
  assert.equal(w.host.claim(), false, 'right after her walk: the gap between two things you notice');
  w.state.now += 46_000;
  assert.equal(w.host.claim(), true);
  w.state.peekActive = true;
  const before = w.starts().length;
  w.run(120);
  assert.equal(w.starts().length, before);
});

test('mood is written only when you answer her coming closer; never for her own moving, a trial or the fast-forward', () => {
  const w = world({ readings: { idleSeconds: 120, state: 'pause' } });
  w.state.here = { across: 0.85, size: 4.275 / (9.8 + 0.55) }; // far: coming closer
  for (let i = 0; i < 3_600 && !w.starts().some(c => c.plan.action === 'place'); i++) { w.run(1); if (w.host.active) w.finish(); }
  const walk = w.starts().find(c => c.plan.action === 'place');
  assert.ok(walk && walk.plan.walk!.depthM < 8, 'she walked closer');
  w.run(1);
  assert.equal(w.state.answered, 0, 'her walking alone writes nothing');
  w.state.lastInteractionAt = w.state.now; w.run(1);
  assert.equal(w.state.answered, 1, 'you talked to her: one peek-answered moment');
  w.state.lastInteractionAt = w.state.now; w.run(1);
  assert.equal(w.state.answered, 1, 'once');
  const trial = world();
  trial.state.here = { across: 0.85, size: 4.275 / (9.8 + 0.55) };
  trial.host.trial('place'); trial.state.lastInteractionAt = trial.state.now + 1; trial.run(1);
  assert.equal(trial.state.answered, 0, 'a trial never writes');
  const fast = world();
  fast.state.here = { across: 0.85, size: 4.275 / (9.8 + 0.55) };
  fast.host.fastForward(true);
  for (let i = 0; i < 400; i++) { fast.run(1); if (fast.host.active) { fast.state.lastInteractionAt = fast.state.now; fast.finish(); } }
  assert.ok(fast.starts().length > 20, `the fast-forward runs her day (${fast.starts().length} actions)`);
  assert.equal(fast.state.answered, 0, 'the fast-forward never writes');
});

test('a walk ends where she stands: the host is told (it saves it); a cue from the camera asks for a reaction now', () => {
  const w = world();
  w.host.trial('place'); w.finish();
  assert.equal(w.state.arrived.length, 1);
  const seen = world({ readings: { idleSeconds: 20, state: 'busy', pose: { present: true } } });
  seen.run(5);
  seen.state.readings = { ...seen.state.readings, pose: { present: true, events: ['wave'], eventConfidence: { wave: 0.9 } } };
  seen.run(1);
  assert.deepEqual(seen.state.noticed, ['wave']);
  const last = seen.starts().at(-1);
  assert.ok(last && last.plan.action === 'glance', `a wave: she looks at you (${last?.plan.action})`);
  const unsure = world({ readings: { idleSeconds: 20, state: 'busy', pose: { present: true, events: ['wave'] } } });
  unsure.run(3);
  assert.deepEqual(unsure.state.noticed, [], 'an unsure wave is not seen');
});

test('the view: plain words and numbers, never a program name or a title', () => {
  const w = world({ readings: { idleSeconds: 5, state: 'busy', activity: 'Code.exe — 秘密项目' } });
  w.run(3);
  const text = JSON.stringify(w.host.view());
  assert.ok(!text.includes('Code.exe') && !text.includes('秘密'), text);
  assert.equal(w.host.view().doing, '你在用电脑');
});

// ---- the peek, folded in ---------------------------------------------------------------------------------------------------------

function peekWorld(reading: { on: boolean }) {
  const t = { now: 5_000_000 }, sent: PeekCommand[] = [];
  const ports: PeekPorts = { clock: () => t.now, random: () => 0, idleSeconds: () => 120, asleep: () => false, inCall: () => false, userTalking: () => false,
    mood: () => CURIOUS, lastInteractionAt: () => null, answered: () => true, every: () => () => {}, readingAloud: () => reading.on };
  const link: PeekLink = { shown: () => true, fullscreen: () => false, send: c => sent.push(c), changed: () => {} };
  return { t, sent, peek: new PeekDirectorHost(ports, link) };
}
test('the read-aloud gap: while her voice reads (long after the reply\'s 6 s tail) she does not come up to the lens; I-192: reading no longer backs a peek off', () => {
  const reading = { on: true }, w = peekWorld(reading);
  for (let i = 0; i < 120; i++) { w.t.now += 1_000; w.peek.tick(); }
  assert.equal(w.sent.length, 0, 'no peek while she reads aloud');
  assert.equal(w.peek.view().blocked, '她在说话');
  reading.on = false;
  for (let i = 0; i < 120 && !w.sent.length; i++) { w.t.now += 1_000; w.peek.tick(); }
  assert.equal(w.sent[0]?.type, 'start');
  reading.on = true; w.t.now += 1_000; w.peek.tick();
  assert.ok(!w.sent.some(c => c.type === 'cancel'), 'she reads on and stays (her hold, up to the cap)');
});

test('with the arbiter: the peek waits for its turn, takes its pace from her mood, and keeps quiet when you talk to someone or a video plays', () => {
  const reading = { on: false }, w = peekWorld(reading);
  let claim = false, block: string | null = null;
  w.peek.arbiter = { claim: () => claim, block: () => block, pace: () => ({ perHour: 1, cooldownMinutes: 20 }) };
  for (let i = 0; i < 120; i++) { w.t.now += 1_000; w.peek.tick(); }
  assert.equal(w.sent.length, 0, 'no turn yet');
  block = '你在看视频'; w.t.now += 1_000; w.peek.tick();
  assert.equal(w.peek.view().blocked, '你在看视频');
  block = null; claim = true;
  for (let i = 0; i < 120 && !w.sent.length; i++) { w.t.now += 1_000; w.peek.tick(); }
  assert.equal(w.sent[0]?.type, 'start');
  w.peek.report({ id: (w.sent[0] as { id: string }).id, phase: 'done' });
  w.t.now += 30 * 60_000;
  for (let i = 0; i < 60; i++) { w.t.now += 1_000; w.peek.tick(); }
  assert.equal(w.sent.filter(c => c.type === 'start').length, 1, 'her mood said once an hour');
});

test('step 5 (拉她): a pull is you interacting (her action eases out, she turns to you); pulled along, her own walks wait the stay', () => {
  const w = world();
  const happened: string[] = [];
  (w.host as unknown as { ports: LifePorts }).ports.happened = kind => { happened.push(kind); };
  w.host.trial('shift');
  w.host.pulled('start');
  w.run(1);
  assert.ok(w.state.sent.some(c => c.type === 'cancel' && c.reason === 'user'), 'her own action eases out');
  assert.deepEqual(w.state.sent.filter(c => c.type === 'attend').at(-1), { type: 'attend', on: true, why: 'user' });
  w.finish();
  const due = (host: unknown) => (host as { nextAt: Map<string, number> }).nextAt;
  due(w.host).set('place', 0); // her own walk was due right now
  w.host.pulled('end', true, 5);
  assert.deepEqual(happened, ['pulled-along'], 'the day\'s history counts it');
  assert.ok(due(w.host).get('place')! >= w.state.now + 5 * 60_000, 'her own next walk waits the stay');
  w.run(4 * 60);
  assert.equal(w.starts().filter(c => c.plan.action === 'place').length, 0, 'no walk of her own within the stay');
  const control = world();
  control.host.pulled('start'); control.run(1);
  due(control.host).set('place', 0);
  control.host.pulled('end', false, 5);
  assert.equal(due(control.host).get('place'), 0, 'not pulled along: her schedule is as it was');
  const plain = world();
  plain.host.pulled('start'); plain.run(1); plain.host.pulled('end', false, 5);
  plain.run(1);
  assert.deepEqual(plain.state.sent.filter(c => c.type === 'attend').at(-1), { type: 'attend', on: false }, 'a pull without walking ends the interaction too');
});

test('step 5 (拉她): a start with no end is not forever (the lease)', () => {
  const w = world();
  w.host.pulled('start'); w.run(1);
  assert.deepEqual(w.state.sent.filter(c => c.type === 'attend').at(-1), { type: 'attend', on: true, why: 'user' });
  w.run(LIFE_TIMING.pullLeaseMs / 1000 + 1);
  assert.deepEqual(w.state.sent.filter(c => c.type === 'attend').at(-1), { type: 'attend', on: false });
});
