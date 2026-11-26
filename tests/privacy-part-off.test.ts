// 隐私失败即关 (overhaul step 7, docs/claude/2026-11-17-isolation-step7.md; plan section 3): while a unit that owns data the privacy actions
// touch is switched off, every privacy action refuses as a whole, before it reads or deletes anything: 「允许记录」 off (privacyStores),
// every deletion and put-back through the bin (recycleStores, the recycle host's actions), never half a deletion. The full app run with a
// switched-off owner is in tests/part-isolation.test.ts.
import './helpers/app-stand-in/boot'; // Electron stand-ins: the wiring's modules load under node (imported dynamically below, after the hooks)
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRIVACY_PART_OFF_MESSAGE } from '../shared/foundation/part-health';

const parts = await import('../electron/wiring/parts-wiring');
const recycle = await import('../electron/wiring/memory-recycle-wiring');

/** An isolate runner that knows every owner unit; `off` is switched off through a failing start. */
function runnerWith(off: readonly [string, string] | null) {
  const runner = parts.createPartRunner({ mode: 'isolate' });
  const units = new Map<string, Set<string>>();
  for (const owner of Object.values(recycle.PRIVACY_STORE_UNITS) as readonly (readonly [string, string] | null)[]) if (owner) (units.get(owner[0]) ?? units.set(owner[0], new Set()).get(owner[0])!).add(owner[1]);
  for (const [id, set] of units) runner.add({ id, units: [...set] });
  if (off) runner.startUnitSync(off[0], off[1], () => { throw new Error('start'); });
  parts.useRunner(runner);
  return runner;
}

test('every store the privacy actions touch has its owner unit (or is core)', () => {
  const keys = new Set([...Object.keys(recycle.RECYCLE_STORE_OWNERS), ...Object.keys(recycle.RECORDING_OFF_STORE_OWNERS)]);
  assert.deepEqual(Object.keys(recycle.PRIVACY_STORE_UNITS).sort(), [...keys].sort());
});

test('with every owner unit on (or no runner: strict), nothing is refused', () => {
  parts.useRunner(null);
  assert.equal(recycle.privacyRefusal(), null);
  runnerWith(null);
  assert.equal(recycle.privacyRefusal(), null);
  parts.useRunner(null);
});

test('any owner unit off: 「允许记录」 off and every bin deletion refuse with the plan\'s words before reading a store', () => {
  const owners = [...new Map((Object.values(recycle.PRIVACY_STORE_UNITS) as readonly (readonly [string, string] | null)[]).filter(Boolean).map(o => [o!.join('/'), o!])).values()];
  assert.ok(owners.length >= 12);
  try {
    for (const owner of owners) {
      runnerWith(owner);
      assert.equal(recycle.privacyRefusal()?.message, PRIVACY_PART_OFF_MESSAGE, owner.join('/'));
      assert.throws(() => recycle.privacyStores(), (error: Error) => error.message === PRIVACY_PART_OFF_MESSAGE, `privacyStores with ${owner.join('/')} off`);
      assert.throws(() => recycle.recycleStores(), (error: Error) => error.message === PRIVACY_PART_OFF_MESSAGE, `recycleStores with ${owner.join('/')} off`);
    }
  } finally { parts.useRunner(null); }
});

test('the recycle host: every action that changes something is refused as a whole while an owner is off, and never starts; viewing stays', async () => {
  const called: string[] = [];
  const action = (name: string) => async (..._args: unknown[]) => { called.push(name); return name as never; };
  const host = recycle.gatedRecycleHost({
    view: () => { called.push('view'); return { days: 30, entries: [], ready: true }; },
    deleteCharacter: action('deleteCharacter'), deleteMemoryNote: action('deleteMemoryNote'), deleteMovingMemory: action('deleteMovingMemory'),
    deleteListenNote: action('deleteListenNote'), recycled: action('recycled') as never, restore: action('restore'), deleteForGood: action('deleteForGood'),
    setDays: action('setDays'),
  });
  const changing = ['deleteCharacter', 'deleteMemoryNote', 'deleteMovingMemory', 'deleteListenNote', 'recycled', 'restore', 'deleteForGood'] as const;
  try {
    runnerWith(['memory', 'user-profiles']);
    for (const name of changing) await assert.rejects((host[name] as (...a: unknown[]) => Promise<unknown>)('x', true, async () => {}), (error: Error) => error.message === PRIVACY_PART_OFF_MESSAGE, name);
    assert.deepEqual(called, [], 'nothing started');
    host.view(); await host.setDays(7);
    assert.deepEqual(called, ['view', 'setDays']);
    runnerWith(null);
    called.length = 0;
    for (const name of changing) await (host[name] as (...a: unknown[]) => Promise<unknown>)('x', true, async () => {});
    assert.deepEqual(called, [...changing], 'with every owner on each action runs as before');
  } finally { parts.useRunner(null); }
});
