/**
 * I-037 three small fixes (docs/claude/2026-11-07-reaction-small-fixes.md):
 *  1. a shy the stage answers 'busy' or 'unsupported' to is recorded as not done (the stage's own answer comes back as desk:reactionResult);
 *  2. a light reaction blush is visible: through the real MoodHost, at the card's default intensity, it peaks at >= 0.4, mid and strong
 *     stay above it, the mood's own blush is unchanged and a card with blush off still blushes nothing;
 *  3. (the warm haiku counts as a model call: in tests/i037-reactions-warm-haiku.test.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { MoodHost } from '../electron/mood';
import { createReactionPerformers } from '../electron/reactions/performers';
import { createReactions, type ReactionMoodPort } from '../electron/reactions/wiring';
import { REACTION_KNOBS } from '../shared/behaviors/reactions/knobs';
import { REACTION_TABLE } from '../shared/behaviors/reactions/knobs';
import { readReactionStageCue, readReactionStageReply, type ReactionStageCue } from '../shared/behaviors/reactions/stage';
import { FakeReactionJudge } from '../shared/behaviors/reactions/fake';
import { DEFAULT_MOOD_PARAMETERS, getBlushAmount, type MoodValues } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';
import { FixedBlush } from '../shared/behaviors/blush/fake';

const HEROINE = 'gene';
const values = (): MoodValues => ({ D: 50, E: 50, O: 50, C: 50, N: 50 } as MoodValues);
const awake = () => ({ characterId: HEROINE, expressions: true, parameters: structuredClone(DEFAULT_MOOD_PARAMETERS), fatigue: { phase: 'awake' },
  snapshot: { primary: 'calm', values: values(), phase: 'idle', intensity: { expression: 1, posture: 1 }, blush: null } }) as unknown as MoodView;
const ctx = { characterId: HEROINE, event: 'praise' as const };

// ---------------------------------------------------------------- 1. the stage's own answer

test('shy performer: what the stage answers decides done / why (busy, unsupported, played, invalid); a plain true still means sent', async () => {
  const view = awake();
  const make = (answer: boolean | Promise<string>) => createReactionPerformers({ mood: () => ({ get: () => view, reactionBlush: () => ({ done: true }), lift: () => {} }),
    actions: () => null, stage: () => answer as never });
  const run = (answer: boolean | Promise<string>) => make(answer).shy.perform(REACTION_TABLE.shy, 'mid', { ...ctx, id: 'shy', key: 'k' });
  assert.deepEqual(await run(Promise.resolve('played')), { done: true });
  assert.deepEqual(await run(Promise.resolve('busy')), { done: false, why: 'busy' });
  assert.deepEqual(await run(Promise.resolve('unsupported')), { done: false, why: 'model' });
  assert.deepEqual(await run(Promise.resolve('invalid')), { done: false, why: 'failed' });
  assert.deepEqual(await run(Promise.resolve('no-answer')), { done: false, why: 'failed' });
  assert.deepEqual(await run(true), { done: true });
  assert.deepEqual(await run(false), { done: false, why: 'hidden' });
});

test('wiring: the pet window\'s desk:reactionResult reaches the shy performer; only the pet, only a matching id, only the closed words', async () => {
  const view = awake(), sent: ReactionStageCue[] = [];
  const mood: ReactionMoodPort = { get: () => view, isTestMoodActive: () => false, setReactionPort: () => {}, reactionBlush: () => ({ done: true }), lift: () => {} };
  const app = createReactions({ directory: () => null, defaultEnabled: true, mood: () => mood, persona: () => '', petVisible: () => true, available: () => true,
    actions: () => null, stage: cue => { sent.push(cue); return true; }, petSender: () => 12, stageAnswerMs: 40, ask: new FakeReactionJudge('{}').ask });
  await app.load();
  const operations = new Map<string, (sender: number, ...args: any[]) => unknown>();
  app.register((method, operation) => { operations.set(method, operation); });
  const reply = operations.get('reactionResult')!;
  assert.ok(reply, 'registered');
  const play = async (answer: (cue: ReactionStageCue) => unknown) => {
    const before = sent.length;
    const result = app.performers.shy.perform(REACTION_TABLE.shy, 'light', { ...ctx, id: 'shy', key: `k${before}` });
    const cue = readReactionStageCue(sent[before])!;
    assert.ok(cue);
    await answer(cue);
    return result;
  };
  assert.deepEqual(await play(cue => reply(12, { id: cue.id, result: 'busy' })), { done: false, why: 'busy' }, 'the stage was busy: not done');
  assert.deepEqual(await play(cue => reply(12, { id: cue.id, result: 'unsupported' })), { done: false, why: 'model' });
  assert.deepEqual(await play(cue => reply(12, { id: cue.id, result: 'played' })), { done: true });
  // Not the pet window, a bad word, an unknown id: ignored, and the performer then reports that nothing came back.
  assert.deepEqual(await play(cue => reply(11, { id: cue.id, result: 'played' })), { done: false, why: 'failed' });
  assert.deepEqual(await play(cue => reply(12, { id: cue.id, result: 'no-answer' })), { done: false, why: 'failed' });
  assert.equal(await reply(12, { id: 'nobody', result: 'played' }), false);
  assert.equal(readReactionStageReply({ id: 'a', result: 'played', extra: 1 }), null);
  assert.equal(readReactionStageReply({ id: 'a b', result: 'played' }), null);
  assert.deepEqual(readReactionStageReply({ id: 'reaction-shy-1', result: 'unsupported' }), { id: 'reaction-shy-1', result: 'unsupported' });
});

// ---------------------------------------------------------------- 2. the light blush is visible

/** The deepest the blush gets while it is held, through the real MoodHost.reactionBlush and its snapshot. */
async function peak(level: 'light' | 'mid' | 'strong', card = DEFAULT_MOOD_PARAMETERS, withFloor = true): Promise<number | null> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-reaction-blush-'));
  const clock = { now: Date.UTC(2026, 10, 7, 15, 0, 0) };
  const host = new MoodHost(directory, () => {}, () => clock.now, { blush: new FixedBlush() });
  try {
    await host.load();
    host.activate(HEROINE, structuredClone(card));
    const result = host.reactionBlush(HEROINE, `r-${level}`, REACTION_KNOBS.blushStrength[level], withFloor ? REACTION_KNOBS.blushFloor : 0);
    if (!result.done) return null;
    let best = 0;
    for (let ms = 0; ms <= 3_500; ms += 100) {
      clock.now += 100; host.tick(true);
      const amount = host.get().snapshot.blush?.amount ?? 0;
      best = Math.max(best, amount);
    }
    return best;
  } finally { await host.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}

test('reaction blush: at the card\'s default intensity a light one peaks at 0.4 or more, mid and strong stay above it', async () => {
  const light = (await peak('light'))!, mid = (await peak('mid'))!, strong = (await peak('strong'))!;
  assert.ok(light >= 0.4, `light ${light}`);
  assert.ok(mid > light + 0.05 && strong > mid + 0.05, `ordered ${light} ${mid} ${strong}`);
  assert.ok(strong <= 1);
});

test('reaction blush: a card with blush off or intensity 0 still shows nothing; a stronger card still wins; the mood\'s own blush is unchanged', async () => {
  assert.equal(await peak('light', { ...DEFAULT_MOOD_PARAMETERS, blush: { ...DEFAULT_MOOD_PARAMETERS.blush, enabled: false } }), null);
  assert.equal(await peak('light', { ...DEFAULT_MOOD_PARAMETERS, blush: { ...DEFAULT_MOOD_PARAMETERS.blush, intensity: 0 } }), null);
  const strongCard = (await peak('light', { ...DEFAULT_MOOD_PARAMETERS, blush: { ...DEFAULT_MOOD_PARAMETERS.blush, intensity: 100 } }))!;
  assert.ok(Math.abs(strongCard - REACTION_KNOBS.blushStrength.light) < 0.02, `card 100 → ${strongCard}`);
  // No floor (the mood's own blush, a pat's or warm words'): exactly the card's intensity times the strength, as before.
  const profile = DEFAULT_MOOD_PARAMETERS.blush;
  assert.equal(getBlushAmount(profile.riseMs + 100, 0.55, profile), profile.intensity / 100 * 0.55);
  assert.equal(getBlushAmount(profile.riseMs + 100, 0.55, profile, undefined), profile.intensity / 100 * 0.55);
  const without = (await peak('light', DEFAULT_MOOD_PARAMETERS, false))!;
  assert.ok(without < 0.25, `no floor ${without}`);
});

test('wiring (Codex X-345): a busy shy retried with the same key gets a new cue id, so a late answer to the first attempt cannot settle the retry', async () => {
  const view = awake(), sent: ReactionStageCue[] = [];
  const mood: ReactionMoodPort = { get: () => view, isTestMoodActive: () => false, setReactionPort: () => {}, reactionBlush: () => ({ done: true }), lift: () => {} };
  const app = createReactions({ directory: () => null, defaultEnabled: true, mood: () => mood, persona: () => '', petVisible: () => true, available: () => true,
    actions: () => null, stage: cue => { sent.push(cue); return true; }, petSender: () => 12, stageAnswerMs: 60, ask: new FakeReactionJudge('{}').ask });
  await app.load();
  const operations = new Map<string, (sender: number, ...args: any[]) => unknown>();
  app.register((method, operation) => { operations.set(method, operation); });
  const reply = operations.get('reactionResult')!;
  const first = app.performers.shy.perform(REACTION_TABLE.shy, 'mid', { ...ctx, id: 'shy', key: 'kx' });
  assert.equal(reply(12, { id: sent[0].id, result: 'busy' }), true);
  assert.deepEqual(await first, { done: false, why: 'busy' });
  const retry = app.performers.shy.perform(REACTION_TABLE.shy, 'mid', { ...ctx, id: 'shy', key: 'kx' });
  assert.notEqual(sent[1].id, sent[0].id, 'the retry has its own id');
  assert.ok(readReactionStageCue(sent[1]), 'still a valid cue');
  assert.equal(reply(12, { id: sent[0].id, result: 'played' }), false, 'a late answer to the first attempt is not taken');
  assert.equal(reply(12, { id: sent[1].id, result: 'played' }), true);
  assert.deepEqual(await retry, { done: true });
});
