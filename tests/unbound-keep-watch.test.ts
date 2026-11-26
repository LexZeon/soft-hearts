// 2026-11-24 (user: "保留", docs/claude/2026-11-24-watch-turns-off.md): what the user turned on by hand in full screen (「◉」, settings, her, their
// own Claude) stays on when she goes back to the small window; what the permission bundle turned on for them and they never touched still goes back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OWN_STEP_QUIET_MS, PermissionBundle, tellBundleOfWatch, type BundleFacts, type BundleItem, type BundlePorts } from '../electron/unbound/permission-bundle';
import { buildJournalEntry } from '../shared/memory/journal';
import { WATCH_CHANGE_EVENTS } from '../shared/senses';

const OFF: BundleFacts = { camera: false, images: false, microphone: false, screen: false, listen: false, face: false };

function rig(initial: Partial<BundleFacts> = {}) {
  const facts: BundleFacts = { ...OFF, ...initial };
  const calls: string[] = [];
  const kept: BundleItem[][] = [];
  const refuse = new Set<BundleItem>();
  let clock = 1_000_000;
  let ticker: (() => void) | null = null;
  const ports: BundlePorts = {
    read: () => ({ ...facts }), face: () => ({ supported: false, installed: false, enrolled: 0 }),
    set: async (item, on) => { calls.push(`${item}:${on ? 'on' : 'off'}`); if (!(on && refuse.has(item))) facts[item] = on; },
    save: async () => {}, replyRunning: () => false, every: (_ms, run) => { ticker = run; return () => { ticker = null; }; }, wait: async () => {},
    kept: items => { kept.push(items); }, now: () => clock,
  };
  const bundle = new PermissionBundle(ports);
  return {
    bundle, facts, calls, kept, refuse,
    watch: () => ticker?.(),
    later: (ms = OWN_STEP_QUIET_MS + 500) => { clock += ms; },
    /** The user's own hand. */
    hand: (item: BundleItem, on: boolean) => { facts[item] = on; },
  };
}

test('what the bundle turned on and the user never touched goes back (unchanged)', async () => {
  const r = rig();
  await r.bundle.apply(); r.later(); r.watch();
  await r.bundle.restore('exit');
  assert.deepEqual(r.calls.filter(c => c.endsWith(':off')).sort(), ['camera:off', 'images:off', 'listen:off', 'microphone:off', 'screen:off']);
  assert.deepEqual(r.kept, []);
});

test('一起看 the user began by hand in full screen stays: screen and sound are not turned off, the rest goes back, one note is made', async () => {
  const r = rig();
  await r.bundle.apply(); r.later(); r.watch();
  r.bundle.watchBegan(); // 「◉」: the words of the computer's sound joined the screen the bundle had opened
  await r.bundle.restore('exit');
  const off = r.calls.filter(c => c.endsWith(':off')).sort();
  assert.deepEqual(off, ['camera:off', 'images:off', 'microphone:off'], 'screen and listen stay for 一起看 to go on');
  assert.deepEqual(r.kept, [['screen', 'listen']]);
});

test('an item the bundle could not open and the user switched on by hand stays; the bundle\'s own reopening is not the user\'s', async () => {
  const r = rig();
  r.refuse.add('images'); // no component: it stays off however often it is tried
  await r.bundle.apply(); r.later();
  r.hand('microphone', false); r.watch(); // seen off; the bundle turns it on again as itself
  await new Promise(resolve => setTimeout(resolve, 0)); r.later(); r.watch();
  await new Promise(resolve => setTimeout(resolve, 0)); r.later();
  r.refuse.delete('images'); r.hand('images', true); r.watch(); // the user opened it in settings (no step of ours behind it)
  await r.bundle.restore('exit');
  const off = r.calls.filter(c => c.endsWith(':off'));
  assert.ok(!off.includes('images:off'), 'the user turned it on by hand');
  assert.ok(off.includes('microphone:off'), 'a step of the bundle\'s own is not a hand');
  assert.deepEqual(r.kept, [['images']], 'the port hears it; the wiring writes the journal row only when the screen is among them');
});

test('the user closing 一起看 in full screen drops the keep: it is off when she is back', async () => {
  const r = rig();
  await r.bundle.apply(); r.later();
  r.bundle.watchBegan();
  r.bundle.watchEnded(true); // the user's own off
  await r.bundle.restore('exit');
  assert.ok(r.calls.includes('screen:off') && r.calls.includes('listen:off'));
  assert.deepEqual(r.kept, []);
});

test('an end that is not the user\'s hand (her window left) does not drop the keep, but nothing stays that no longer reads on', async () => {
  const r = rig();
  await r.bundle.apply(); r.later();
  r.bundle.watchBegan();
  r.bundle.watchEnded(false);
  r.hand('screen', false); // the host stopped the screen when her window left the screen
  await r.bundle.restore('exit');
  assert.deepEqual(r.kept, [['listen']], 'only what still reads on is kept');
  assert.ok(r.calls.includes('screen:off'), 'the item that already read off goes through the normal way back');
});

test('the screen permission revoked: nothing is kept', async () => {
  const r = rig();
  await r.bundle.apply(); r.later();
  r.bundle.watchBegan();
  r.hand('screen', false); r.hand('listen', false);
  await r.bundle.restore('exit');
  assert.deepEqual(r.kept, []);
});

test('a begin the bundle caused itself (it opened the screen while the words were already on) is not the user\'s', async () => {
  const r = rig();
  await r.bundle.apply();
  r.bundle.watchBegan(); // within the quiet time after the bundle's own steps
  await r.bundle.restore('exit');
  assert.deepEqual(r.kept, []);
  assert.ok(r.calls.includes('screen:off'));
});

test('quitting the app keeps nothing of this kind (the run ends with its senses)', async () => {
  const r = rig();
  await r.bundle.apply(); r.later();
  r.bundle.watchBegan();
  await r.bundle.restore('quit');
  assert.deepEqual(r.kept, []);
});

test('the detector\'s words reach the bundle: a begin keeps, only an end with cause user drops it', async () => {
  const r = rig();
  await r.bundle.apply(); r.later();
  tellBundleOfWatch(r.bundle, { kind: 'began' });
  tellBundleOfWatch(r.bundle, { kind: 'ended', why: 'unbound-exit' }); // not the user's hand: the keep stands
  await r.bundle.restore('exit');
  assert.deepEqual(r.kept, [['screen', 'listen']]);
  const q = rig();
  await q.bundle.apply(); q.later();
  tellBundleOfWatch(q.bundle, { kind: 'began' });
  tellBundleOfWatch(q.bundle, { kind: 'ended', why: 'user' });
  await q.bundle.restore('exit');
  assert.deepEqual(q.kept, []);
});

test('the journal accepts the new word with no other field, and gives it a reason', () => {
  assert.ok((WATCH_CHANGE_EVENTS as readonly string[]).includes('kept-after-unbound'));
  const line = buildJournalEntry({ type: 'watch-change', characterId: 'gene', event: 'kept-after-unbound' }, 1_000) as { event?: string; reason?: string } | null;
  assert.equal(line?.event, 'kept-after-unbound');
  assert.match(line?.reason ?? '', /留着/);
  assert.equal(buildJournalEntry({ type: 'watch-change', characterId: 'gene', event: 'kept-after-unbound', why: 'turned-off' }, 1_000), null);
});

test('the detector tells listeners about a begin and about an end with its cause (the user\'s hand is the only "user")', async () => {
  const { WatchOffDetector, onWatchChange, offAsNotUsers, clearWatchOffCause, noteWatchOffCause } = await import('../electron/senses/watch-off-notice');
  clearWatchOffCause();
  let on = false; let clock = 1_000_000;
  const heard: string[] = [];
  const stop = onWatchChange(change => { heard.push(change.kind === 'began' ? 'began' : `ended:${change.why}`); });
  const detector = new WatchOffDetector({ on: () => on, ended: () => {}, now: () => clock });
  on = true; detector.tick();
  on = false; noteWatchOffCause('user'); clock += 1000; detector.tick();
  on = true; clock += 1000; detector.tick();
  const switches = { async set() { noteWatchOffCause('user'); } };
  await offAsNotUsers(switches, 'unbound-exit')!.set();
  on = false; clock += 1000; detector.tick();
  stop();
  assert.deepEqual(heard, ['began', 'ended:user', 'began', 'ended:unbound-exit']);
});
