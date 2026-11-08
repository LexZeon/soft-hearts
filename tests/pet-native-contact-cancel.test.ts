import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MoodHost } from '../electron/mood';
import { matchesDirectContactCancellation } from '../src/ui/MoodCompanion';
import type { MoodInput, MoodView } from '../shared/mood-runtime';

type Host = Pick<MoodHost, 'load' | 'activate' | 'get' | 'interaction' | 'flush' | 'beginChatGesture'> & { cancelDirectContact?(): void };
async function withHost<T>(create: (directory: string, changed: (view: MoodView) => void, now: () => number) => Host,
  run: (host: Host, clock: { now: number }, directory: string) => Promise<T>, changed: (view: MoodView) => void = () => {}): Promise<T> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'soft-r05-blur-cause-'));
  const clock = { now: 1_000_000 }, host = create(temporary, changed, () => clock.now);
  try { await host.load(); host.activate('gene'); return await run(host, clock, temporary); }
  finally {
    await host.flush();
    const resolved = path.resolve(temporary), root = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved).toLowerCase(), root.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('soft-r05-blur-cause-'));
    await rm(resolved, { recursive: true, force: true });
  }
}
const fixed = (directory: string, changed: (view: MoodView) => void, now: () => number) => new MoodHost(directory, changed, now, {
  fatigueClock: { monotonicMs: now, wallMs: now, localMinute: wall => (wall / 60_000) % 1440 },
});
const begin = (host: Host, id: string) => host.interaction({ token: host.get().token, sessionId: id, type: 'phase', phase: 'cheek' });
const release = (host: Host, id: string) => host.interaction({ token: host.get().token, sessionId: id, type: 'cheek', id: `${id}-up`, activeMs: 300 });

test('native cancellation publishes only its retired contact and a fresh contact receives exactly one canonical reward', async () => {
  await withHost(fixed, async (host, clock, directory) => {
    const token = host.get().token; begin(host, 'old'); clock.now += 750;
    host.cancelDirectContact!(); const cancelled = host.get();
    assert.deepEqual(cancelled.directContactCancellation, { characterId: 'gene', token, sessionId: 'old' });
    begin(host, 'fresh');
    host.interaction({ token, sessionId: 'old', type: 'phase', phase: 'idle' });
    assert.equal(host.get().snapshot.phase, 'cheek');
    assert.equal(matchesDirectContactCancellation(host.get(), 'fresh'), false);
    clock.now += 750; const accepted = release(host, 'fresh');
    assert.equal(accepted.snapshot.lastInteractionAt, clock.now);
    assert.equal(accepted.snapshot.event?.id, 'cheek:fresh');
    assert.throws(() => release(host, 'fresh'), /过期或已接受/);
    await host.flush();
    const saved = JSON.parse(await readFile(path.join(directory, 'mood-state.json'), 'utf8'));
    const ids = saved.profiles[0].state.recentEventIds.filter((id: string) => id.startsWith('cheek:'));
    assert.deepEqual(ids, ['cheek:fresh']);
  });
});

test('native blur without a direct session is a no-op for pending chat, token, body and mood view', async () => {
  await withHost(fixed, async host => {
    const token = host.get().token; host.beginChatGesture('pending-turn', token);
    const before = host.get(); host.cancelDirectContact!(); host.cancelDirectContact!();
    assert.deepEqual(host.get(), before);
    assert.equal(host.get().token, token);
  });
});

test('typed cancellation identity rejects other sessions, cards, tokens and ambiguous payloads', () => {
  const view = { characterId: 'gene', token: 'same-context', directContactCancellation: { characterId: 'gene', token: 'same-context', sessionId: 'old' } };
  assert.equal(matchesDirectContactCancellation(view, 'old'), true);
  assert.equal(matchesDirectContactCancellation(view, 'new'), false);
  assert.equal(matchesDirectContactCancellation({ ...view, token: 'new-context' }, 'old'), false);
  assert.equal(matchesDirectContactCancellation({ ...view, characterId: 'other' }, 'old'), false);
  const ambiguous = { ...view, directContactCancellation: { ...view.directContactCancellation, extra: true } };
  assert.equal(matchesDirectContactCancellation(ambiguous, 'old'), false);
});

