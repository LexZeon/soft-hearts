// The host's "the user is away" for the stage (overhaul step 7, docs/claude/2026-11-17-isolation-step7.md; plan section 4): while
// 「知道你是不是在忙」 is on, no keyboard or mouse input for STAGE_AWAY_IDLE_SECONDS, a locked screen or a sleeping computer make the switch view
// say `away: true` (told to both windows when it changes; the companion window's stage then draws at its 24 fps away pace). Switched off, nothing
// is read and nothing is said. The renderer side: src/wiring/pet-window-wiring.ts calls stage.setUserAway with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserActivity, type PowerEventName } from '../electron/senses/user-activity';
import { STAGE_AWAY_IDLE_SECONDS, type UserActivitySwitchView } from '../shared/behaviors/user-activity/interface';

function world(switchOn = true) {
  let idle = 0;
  const told: UserActivitySwitchView[] = [];
  const listeners = new Map<PowerEventName, () => void>();
  let reads = 0;
  const ua = createUserActivity({ directory: () => null, idleSeconds: () => { reads++; return idle; }, windowFocused: () => false,
    power: { on: (event, listener) => { listeners.set(event, listener); } }, broadcast: view => { told.push(view); } });
  if (!switchOn) ua.setEnabled(false);
  told.length = 0;
  return { ua, told, set idle(value: number) { idle = value; }, power: (event: PowerEventName) => listeners.get(event)?.(), reads: () => reads };
}

test('two minutes without input: away once; input again: back once; nothing told while nothing changes', () => {
  const w = world();
  w.idle = STAGE_AWAY_IDLE_SECONDS - 1; w.ua.tick();
  assert.deepEqual(w.told, []);
  assert.deepEqual(w.ua.switchView(), { enabled: true });
  w.idle = STAGE_AWAY_IDLE_SECONDS; w.ua.tick(); w.idle = STAGE_AWAY_IDLE_SECONDS + 30; w.ua.tick();
  assert.deepEqual(w.told, [{ enabled: true, away: true }]);
  assert.deepEqual(w.ua.switchView(), { enabled: true, away: true });
  w.idle = 0; w.ua.tick(); w.ua.tick();
  assert.deepEqual(w.told, [{ enabled: true, away: true }, { enabled: true }]);
});

test('a locked screen or a sleeping computer is away at once (next second), whatever the idle time', () => {
  const w = world();
  w.power('lock-screen'); w.ua.tick();
  assert.deepEqual(w.told.at(-1), { enabled: true, away: true });
  w.power('unlock-screen'); w.ua.tick();
  assert.deepEqual(w.told.at(-1), { enabled: true });
  w.power('suspend'); w.ua.tick();
  assert.deepEqual(w.told.at(-1), { enabled: true, away: true });
  w.power('resume'); w.ua.tick();
  assert.deepEqual(w.told.at(-1), { enabled: true });
});

test('switched off: no idle read, never away; switching off while away tells "not away"', () => {
  const off = world(false);
  off.idle = 10_000; for (let i = 0; i < 5; i++) off.ua.tick();
  assert.equal(off.reads(), 0, 'nothing read while the switch is off');
  assert.deepEqual(off.told, []);
  assert.deepEqual(off.ua.switchView(), { enabled: false });
  const on = world();
  on.idle = 10_000; on.ua.tick();
  assert.deepEqual(on.told, [{ enabled: true, away: true }]);
  assert.deepEqual(on.ua.setEnabled(false), { enabled: false });
  assert.deepEqual(on.told.at(-1), { enabled: false });
});

test('the pet window follows it: stage.setUserAway from the view it is told and the one it reads at start (pet only)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = fs.readFileSync(path.join(root, 'src/wiring/pet-window-wiring.ts'), 'utf8');
  assert.match(source, /if \(isPet\) \{ const follow = \(view: \{ away\?: true \}\) => stage\.setUserAway\(view\.away === true\); window\.desktop\.onUserActivity\(follow\); void window\.desktop\.getUserActivity\(\)\.then\(follow, \(\) => \{\}\); \}/);
});
