import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MoodHost } from '../electron/mood';
import { MoodInputQueue } from '../src/ui/MoodCompanion';
import { PetInteractionTracker } from '../src/ui/PetInteraction';
import type { MoodInput } from '../shared/mood-runtime';

test('rapid immediate reentry cancels only unsubmitted old tail and the real host never receives an expired packet', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-immediate-session-'));
  let now = 10_000;
  const host = new MoodHost(directory, () => {}, () => now);
  const sent: MoodInput[] = [], errors: string[] = [];
  const queue = new MoodInputQueue(input => {
    sent.push(input);
    return Promise.resolve(host.interaction(input));
  }, () => {}, message => errors.push(message));
  try {
    await host.load(); host.activate('gene'); queue.setToken(host.get().token);
    const head = { x: 100, y: 100, radius: 50, referenceWidth: 100 };
    const tracker = new PetInteractionTracker({
      onState: value => {
        // Mirrors the existing bridge: normal idle has a 220ms tail window;
        // a real new contact clears that timer and queues its phase immediately.
        if (value.phase === 'rua') void queue.push({ type: 'phase', phase: 'rua', sessionId: value.sessionId! });
      },
      onFeedback() {}, onEvent: value => { void queue.push(value); },
    }, {}, 'rapid-host');
    tracker.pointer(100, 100, now, head); await queue.settled(); const oldId = tracker.state.sessionId;
    now += 100; tracker.pointer(120, 100, now, head); await queue.settled();
    now += 50; tracker.pointer(130, 100, now, head); await queue.settled();
    now += 10; tracker.leave(now); await queue.settled();
    assert.equal(sent.filter(v => v.type === 'rua').reduce((sum, v) => sum + (v.type === 'rua' ? v.activeMs : 0), 0), 100);
    now += 10; tracker.pointer(100, 100, now, head); await queue.settled(); const newId = tracker.state.sessionId;
    assert.notEqual(newId, oldId);
    const newPhase = sent.findIndex(v => v.type === 'phase' && v.sessionId === newId);
    now += 100; tracker.pointer(120, 100, now, head); await queue.settled();
    now += 40; tracker.flush(now); await queue.settled();
    const activity = sent.filter((v): v is Extract<MoodInput, { type: 'rua' }> => v.type === 'rua');
    assert.deepEqual(activity.map(v => [v.sessionId, v.activeMs]), [[oldId, 100], [newId, 100]]);
    assert.equal(sent.slice(newPhase + 1).some(v => v.sessionId === oldId), false);
    assert.deepEqual(errors, []);
    assert.equal(host.get().snapshot.lastInteractionAt, now);
    assert.ok(host.get().snapshot.values.O > 50);
  } finally {
    queue.dispose(); await host.flush();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('soft-immediate-session-'));
    await rm(directory, { recursive: true, force: true });
  }
});
