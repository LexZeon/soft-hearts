import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MoodHost } from '../electron/mood';
import { CompanionService } from '../electron/companion';
import { ChatAvailability } from '../electron/chat-availability';
import { ClaudeFailureError } from '../electron/claude';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import { FixedBoredomTiming } from '../shared/behaviors/boredom-timing/fake';
import { FixedTouchFeedEffect } from '../shared/behaviors/touch-feed-effect/fake';
import { FixedBlush } from '../shared/behaviors/blush/fake';
import type { ProviderConfig } from '../shared/contracts';

const DOWN = [
  "You've hit your session limit · resets 1:20pm (America/Los_Angeles)",
  "Can't reach the API server",
  'API Error: Unable to connect to API: SSL certificate verification failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)',
  'Not logged in · Please run /login',
];

/** Everything the pet does by herself and by touch, run on a fixed clock; returns what the simulation ended up as. */
async function liveThroughTouchAndTime(unavailable: ChatAvailability | null) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-alive-'));
  const clock = { now: 1_000_000 };
  // Both runs must be the same simulation: the card's boredom numbers, touch and snack amounts and blush as they are
  // (#8's timing, #21's effect and #26's blush are random by design).
  const host = new MoodHost(directory, () => {}, () => clock.now, { boredomTiming: new FixedBoredomTiming(), touchFeedEffect: new FixedTouchFeedEffect(), blush: new FixedBlush() });
  try {
    await host.load();
    host.activate('gene');
    host.setDeveloperMode(true);
    const p = structuredClone(DEFAULT_MOOD_PARAMETERS);
    p.boredom.graceMs = 0; p.boredom.perMinute = 20;
    host.setParameters(p);
    const input = (value: Record<string, unknown>) => host.interaction({ token: host.get().token, ...value });
    const log: unknown[] = [];
    for (let i = 0; i < 6; i++) { clock.now += 1_000; host.tick(false); }       // time passes: boredom grows
    log.push(host.get().snapshot.boredom);
    input({ type: 'phase', sessionId: 'pat', phase: 'rua' });                   // she is petted
    clock.now += 100;
    input({ type: 'rua', sessionId: 'pat', id: 'pat-1', activeMs: 400 });
    log.push(host.get().snapshot.phase, host.get().snapshot.values.O);
    input({ type: 'phase', sessionId: 'pat', phase: 'idle' });
    input({ type: 'phase', sessionId: 'meal', phase: 'food-wait' });            // she is fed
    clock.now += 500;
    input({ type: 'phase', sessionId: 'meal', phase: 'food-ready' });
    input({ type: 'food', sessionId: 'meal', id: 'release' });
    log.push(host.get().snapshot.phase, host.get().snapshot.values.D, host.get().snapshot.lastInteractionAt);
    if (unavailable) for (const detail of DOWN) unavailable.failure(new ClaudeFailureError('x', detail)); // chat dies while she lives on
    for (let i = 0; i < 5; i++) { clock.now += 1_000; host.tick(true); }
    log.push(host.get().snapshot.values, host.get().snapshot.cue === null);
    return log;
  } finally {
    await host.flush().catch(() => {});
    assert.equal(path.dirname(directory), os.tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
}

test('mood ticks, petting and feeding behave exactly the same whether or not chat is available', async () => {
  const baseline = await liveThroughTouchAndTime(null);
  const availability = new ChatAvailability();
  const down = await liveThroughTouchAndTime(availability);
  assert.equal(availability.view().state, 'unavailable');
  assert.deepEqual(down, baseline);
  // And the run was not trivially still: petting and feeding changed her.
  assert.ok((baseline[0] as number) > 0, 'boredom grew with time');
  assert.equal(baseline[1], 'rua');
  assert.ok((baseline[4] as number) > 50, 'the snack lifted D');
});

const provider: ProviderConfig = { kind: 'claude', baseUrl: 'http://fixture.invalid/v1', model: 'fixture' };
test('a failed chat turn is archived as the user\'s words only: her in-character line never enters the history, and the next turn is ordinary', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-alive-companion-'));
  const service = new CompanionService(directory, () => {});
  const availability = new ChatAvailability({ cardKey: () => 'card', line: () => '我今天说得有点多，要先歇一会儿啦。' });
  try {
    await service.load();
    await service.context('gene', provider, 'Gene');
    const shown: string[] = [];
    const turn = await service.begin('failing', '你好', 'Gene', (type, text) => { if (type === 'delta') shown.push(text); });
    const error = new ClaudeFailureError('Claude 暂时不可用', DOWN[0]);
    availability.failure(error);
    const notice = availability.notice(error);
    assert.equal(notice?.line, '我今天说得有点多，要先歇一会儿啦。');
    await turn.finish('error'); // exactly what the chat handler does with a failed reply
    assert.deepEqual(shown, [], 'nothing was delivered through the reply stream');
    const failed = service.memory.read(turn.scope, turn.recordId)!;
    assert.deepEqual(failed.messages.filter(message => message.role === 'assistant').map(message => [message.content, message.status]), [['', 'error']], 'only the empty, errored placeholder the app always writes');
    assert.ok(!JSON.stringify(failed).includes('歇一会儿'));

    // She still lives: time passes, she is fed, and the pet keeps feeling it.
    const before = service.mood.get().snapshot.values.D;
    service.mood.event({ type: 'food', id: 'snack-during-outage' });
    service.mood.tick(true);
    assert.ok(service.mood.get().snapshot.values.D > before);

    // Chat comes back: the next turn archives once, normally.
    availability.success();
    const ok = await service.begin('working', '在吗', 'Gene', () => {});
    ok.push('delta', '在的。');
    await ok.finish('complete');
    const record = service.memory.read(ok.scope, ok.recordId)!;
    assert.deepEqual(record.messages.filter(message => message.turnId === 'working').map(message => [message.role, message.content]), [['user', '在吗'], ['assistant', '在的。']]);
    assert.deepEqual(record.messages.filter(message => message.role === 'assistant' && message.content).map(message => message.content), ['在的。'], 'the failure left no reply text behind');

  } finally {
    await service.flush().catch(() => {});
    assert.equal(path.dirname(directory), os.tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
});
