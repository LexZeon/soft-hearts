/**
 * #11 on the real MoodHost (electron/mood.ts) with an isolated temporary profile: the one-second tick's rule cue and the inner
 * loop's own decision both go through the idle gesture; the stage gets the shape, the face player the picked face; a cue the
 * inner loop takes (electron/inner-loop/claim.ts) is never remembered or explained; the developer "why" is memory only.
 * IDLE_GESTURE_REPORT=1 prints the 20 rule cues.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { MoodHost } from '../electron/mood';
import { withoutClaimedCue } from '../electron/inner-loop/claim';
import { DEFAULT_MOOD_PARAMETERS, type MoodCue } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';
import { IdleGestureDirector } from '../shared/behaviors/idle-gesture/choose';
import { seeded } from './helpers/seeded';

const report = !!process.env.IDLE_GESTURE_REPORT;
/** The default card, only faster: bored from the start, a look or small motion every 10 s instead of every 5 minutes. */
const FAST = { ...structuredClone(DEFAULT_MOOD_PARAMETERS), boredom: { ...DEFAULT_MOOD_PARAMETERS.boredom, graceMs: 0, perMinute: 20 },
  frequency: { ...DEFAULT_MOOD_PARAMETERS.frequency, motionIntervalMs: 10_000 } };

async function withHost(claim: (cue: MoodCue, index: number) => boolean, run: (context: { host: MoodHost; clock: { now: number }; shown: MoodView[] }) => Promise<void> | void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-idle-gesture-'));
  const clock = { now: 1_000_000 };
  const shown: MoodView[] = [], seen = new Set<string>(), taken = new Set<string>();
  let motions = 0;
  // The claim pass as electron/main.ts runs it inside the mood callback: decided once, on first sight.
  const host: MoodHost = new MoodHost(directory, view => {
    const cue = view.snapshot.cue;
    if (cue?.kind === 'motion' && !seen.has(cue.id)) { seen.add(cue.id); if (claim(cue, motions++)) taken.add(cue.id); }
    shown.push(cue && taken.has(cue.id) ? withoutClaimedCue(view, host) : view);
  }, () => clock.now, { idleGesture: new IdleGestureDirector({ random: seeded(9), clock: () => clock.now }) });
  try {
    await host.load();
    host.activate('gene', structuredClone(FAST));
    host.setDeveloperMode(true);
    await run({ host, clock, shown });
  } finally {
    await host.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
const tick = (host: MoodHost, clock: { now: number }, seconds: number) => {
  for (let i = 0; i < seconds; i++) { clock.now += 1_000; host.tick(true, { allowGenericSpeech: false }); }
};
/** The first window view of each look or motion cue. */
const firstViews = (shown: readonly MoodView[], kind: 'look' | 'motion') => {
  const out = new Map<string, MoodView>();
  for (const view of shown) { const cue = view.snapshot.cue; if (cue?.kind === kind && !out.has(cue.id)) out.set(cue.id, view); }
  return [...out.values()];
};

test('20 rule "动一动" cues on the real host: the stage gets a picked shape, the face player the picked face, the panel the why', async () => {
  await withHost(() => false, ({ host, clock, shown }) => {
    tick(host, clock, 200);
    for (let i = 0; i < 400 && firstViews(shown, 'motion').length < 20; i++) tick(host, clock, 1);
    tick(host, clock, 2);
    const motions = firstViews(shown, 'motion').slice(0, 20);
    assert.equal(motions.length, 20);
    const shapes: string[] = [], faces: string[] = [];
    for (const view of motions) {
      const gesture = view.idleGesture!;
      assert.ok(gesture, 'a picked shape for the stage');
      assert.equal(gesture.cueId, view.snapshot.cue!.id);
      const reaction = view.behavior?.reaction;
      // Once it was shown (the next view), its why heads the developer panel.
      const next = shown.find(item => item.revision > view.revision && item.snapshot.cue?.id === view.snapshot.cue!.id)!;
      const entry = next.idleGestureWhy![0];
      assert.ok(entry && entry.at === view.snapshot.cue!.at && entry.kind === 'motion', 'its why is in the developer panel');
      assert.equal(entry.why[0], '闲着到了动一动的时候');
      if (reaction) { assert.equal(reaction.semantic, 'cue.motion'); faces.push(reaction.bindingId); } else faces.push('none');
      shapes.push(gesture.shape);
    }
    const repeats = (values: string[]) => values.filter((value, i) => i > 0 && value === values[i - 1]).length;
    const pairs = shapes.map((shape, i) => `${shape}+${faces[i]}`);
    const line = `${new Set(shapes).size} shapes, ${new Set(faces).size} faces, ${new Set(pairs).size} combinations; in a row: shape ${repeats(shapes)}, face ${repeats(faces)}, both ${repeats(pairs)}`;
    if (report) console.log(`[host 20x rule motion] ${line}\n  ${shapes.join(' ')}\n  ${faces.join(' ')}`);
    assert.ok(new Set(shapes).size >= 5 && new Set(faces).size >= 3, line);
    assert.ok(repeats(pairs) <= 2, line);
    // Looks went through it too.
    assert.ok(firstViews(shown, 'look').every(view => view.idleGesture?.kind === 'look'));
    // Memory only and labels only: the panel keeps the last 8, and nothing of it reaches the saved state.
    assert.ok(host.get().idleGestureWhy!.length <= 8);
  });
});

test('a cue the inner loop takes is never shown, remembered or explained; her own decision then says so', async () => {
  let taken: MoodCue | null = null;
  await withHost((cue, index) => { if (index !== 2) return false; taken = cue; return true; }, ({ host, clock, shown }) => {
    tick(host, clock, 200);
    for (let i = 0; i < 300 && firstViews(shown, 'motion').length < 4; i++) tick(host, clock, 1);
    assert.ok(taken, 'the third motion cue was taken');
    // The window never got the taken cue, its shape or a face for it (claim.ts strips them) ...
    assert.ok(shown.every(view => view.snapshot.cue?.id !== taken!.id && view.idleGesture?.cueId !== taken!.id));
    assert.ok(shown.every(view => !view.behavior?.reaction?.stateKey.startsWith(`reaction:${taken!.id}:`)));
    // ... and the panel explains exactly the looks and motions that were shown, the taken one not among them.
    const why = host.get().idleGestureWhy!;
    const visible = [...firstViews(shown, 'motion'), ...firstViews(shown, 'look')].map(view => view.snapshot.cue!.at).sort((a, b) => b - a).slice(0, why.length);
    assert.deepEqual(why.map(entry => entry.at), visible);
    assert.ok(!why.some(entry => entry.at === taken!.at && entry.kind === 'motion'));
  });
});

test('realize: the inner loop\'s own motion is picked and explained as hers; with automatic expression off nothing is picked', async () => {
  let takenCue: MoodCue | null = null;
  await withHost(cue => { if (takenCue) return false; takenCue = cue; return true; }, ({ host, clock, shown }) => {
    for (let i = 0; i < 400 && !takenCue; i++) tick(host, clock, 1);
    assert.ok(takenCue, 'one motion cue was taken');
    const before = host.get().idleGestureWhy![0];
    assert.ok(shown.every(view => view.snapshot.cue?.id !== takenCue!.id), 'the taken cue never reached the window');
    clock.now += 2_000;
    host.event({ type: 'attention', id: 'inner-motion', kind: 'motion', claimed: { id: takenCue!.id, kind: 'motion', at: takenCue!.at } });
    const view = host.get();
    assert.equal(view.snapshot.cue?.id, 'inner-motion');
    assert.equal(view.idleGesture?.cueId, 'inner-motion');
    const entry = view.idleGestureWhy![0];
    assert.notDeepEqual(entry, before, 'a new line heads the panel');
    assert.equal(entry.source, 'inner'); assert.equal(entry.why[0], '她自己决定动一动');
    // "暂停自动表现": no cue, no pick.
    host.setExpressions(false);
    tick(host, clock, 30);
    assert.ok(host.get().idleGesture === undefined);
    host.setDeveloperMode(false);
    assert.equal(host.get().idleGestureWhy, undefined, 'developer mode only');
  });
});
