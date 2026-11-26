// I-205b: the spot she chose in her own reply (a go-word) outranks the life arbiter's own place changes (busy zone, home, paused...) for
// 30 minutes (one knob); a pull, a new go-word and her tiredness behave as written in docs/claude/2026-11-23-i193-her-position.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HER_POSITION_KNOBS, chosenSpotOpen, chosenSpotUntil } from '../shared/unbound/her-position';
import { chosenSpotHolds } from '../shared/unbound/life/actions/place';
import { LifeHost, type LifeLink, type LifePorts, type LifeReadings } from '../electron/unbound/life';
import { NEUTRAL_MOOD } from '../shared/unbound/director';
import type { LifeCommand } from '../shared/unbound/life/types';
import type { LifeSpot } from '../shared/unbound/life/action';

const MIN = 60_000;

function world() {
  const state = { now: 1_000_000, here: { across: 0.5, size: 4.275 / (8 + 0.55) } as LifeSpot, sleepy: 0, sent: [] as LifeCommand[],
    readings: { idleSeconds: 5, state: 'busy', pose: null, activity: null, talkedAt: null, sound: null } as Partial<LifeReadings> };
  const ports: LifePorts = {
    clock: () => state.now, random: () => 0.5, readings: () => state.readings,
    asleep: () => false, inCall: () => false, waiting: () => false, typing: () => false, readingAloud: () => false, playing: () => false,
    mood: () => ({ ...NEUTRAL_MOOD, A: state.sleepy }), lastInteractionAt: () => null, answered: () => true, every: () => () => {}, journal: () => {},
  };
  const link: LifeLink = {
    shown: () => true, fullscreen: () => false, out: () => true, send: command => state.sent.push(command), here: () => state.here,
    toWorld: spot => ({ xM: (spot.across - 0.5) * 3, depthM: 4.275 / spot.size - 0.55 }), arrived: () => {}, peekActive: () => false, interruptPeek: () => {}, changed: () => {}, taskbar: () => true,
  };
  const host = new LifeHost(ports, link);
  const run = (seconds: number) => { for (let i = 0; i < seconds; i++) { state.now += 1_000; host.tick(); } };
  const starts = () => state.sent.filter((c): c is Extract<LifeCommand, { type: 'start' }> => c.type === 'start');
  /** The page reports the last walk done where it ended. */
  const finish = () => {
    const start = starts().at(-1)!;
    if (start.plan.walk) state.here = { across: start.plan.walk.xM / 3 + 0.5, size: 4.275 / (start.plan.walk.depthM + 0.55) };
    host.report({ id: start.id, phase: 'done', ...(start.plan.walk ? { at: { xM: start.plan.walk.xM, depthM: start.plan.walk.depthM } } : {}) });
  };
  const placeNotNow = () => host.view().actions.find(a => a.id === 'place')!.notNow;
  return { state, host, run, finish, starts, placeNotNow };
}
/** She went to the left (the go-word), the walk is over. */
function wentLeft() {
  const w = world();
  w.run(2);
  assert.equal(w.placeNotNow(), null, 'busy and standing mid-screen: the rule would walk her to the busy corner');
  assert.equal(w.host.goAsk({ goBeat: 'go-left' }), 'go');
  w.run(1); w.finish(); w.run(1);
  return w;
}

test('pure: the window opens for the knob, a bad value is closed, the zone rule holds unless she is tired', () => {
  assert.equal(HER_POSITION_KNOBS.chosenSpotMinutes, 30);
  assert.equal(chosenSpotUntil(1000), 1000 + 30 * MIN);
  assert.equal(chosenSpotUntil(1000, { ...HER_POSITION_KNOBS, chosenSpotMinutes: 0 }), 1000);
  assert.ok(chosenSpotOpen(1000 + MIN, 1000) && !chosenSpotOpen(1000, 1000) && !chosenSpotOpen(null, 0) && !chosenSpotOpen(Number.NaN, 0));
  for (const zone of ['busy', 'paused', 'home', 'wander'] as const) assert.equal(chosenSpotHolds({ chosenSpotKept: true }, zone), true, zone);
  assert.equal(chosenSpotHolds({ chosenSpotKept: true }, 'sleepy'), false, 'tiredness still applies');
  assert.equal(chosenSpotHolds({ chosenSpotKept: false }, 'busy'), false);
  assert.equal(chosenSpotHolds({}, 'busy'), false);
});

test('a go-word, then you get busy: she stays for the window, then the rule may move her', () => {
  const w = wentLeft();
  assert.match(w.placeNotNow() ?? '', /自己选/, 'her own choice holds the spot');
  w.run(29 * 60);
  assert.notEqual(w.placeNotNow(), null, 'still inside the 30 minutes');
  w.run(2 * 60);
  assert.equal(w.placeNotNow(), null, 'after the window the rules resume');
});

test('across the whole window the rules start no walk of hers', () => {
  const w = wentLeft();
  for (let s = 0; s < 28 * 60; s++) { w.run(1); if (w.host.active && s % 4 === 3) w.finish(); }
  assert.equal(w.starts().filter(c => c.plan.action === 'place').length, 1, 'only her own go-word walk');
});

test('a new go-word restarts the window; staying where she already is counts as a choice too', () => {
  const w = wentLeft();
  w.run(20 * 60);
  assert.equal(w.host.goAsk({ goBeat: 'go-right' }), 'go'); w.run(1); w.finish();
  w.run(25 * 60);
  assert.notEqual(w.placeNotNow(), null, '45 minutes after the first, 25 after the second');
  w.run(6 * 60);
  assert.equal(w.placeNotNow(), null);
  const stay = wentLeft();
  stay.run(20 * 60);
  assert.equal(stay.host.goAsk({ goBeat: 'go-left' }), 'stay', 'she already stands in the left');
  stay.run(25 * 60);
  assert.notEqual(stay.placeNotNow(), null, 'the window restarted on the stay');
});

test('pulling her ends the window', () => {
  const w = wentLeft();
  assert.notEqual(w.placeNotNow(), null);
  w.host.pulled('start'); w.host.pulled('end', true, 0);
  w.run(2);
  assert.equal(w.placeNotNow(), null);
});

test('tired (sleepy corner): the rule still applies during the window, as today', () => {
  const w = wentLeft();
  assert.notEqual(w.placeNotNow(), null);
  w.state.sleepy = 0.95; w.run(2);
  assert.equal(w.placeNotNow(), null, 'the tired corner is not blocked by her choice');
});
