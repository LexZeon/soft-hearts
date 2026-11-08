/** M1: the director that turns "she hears music" into her choice: when it judges, what changes, what acts at once, how the request counts. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DANCE_REQUEST_WINDOW_MS, moodLabelDanceDesire, type DanceDesireFn, type DanceDesireInput } from '../shared/music-desire';
import {
  MUSIC_CATCH_ON_S, MUSIC_MIN_STAY_S, MUSIC_NEW_SONG_GAP_S, MUSIC_REJUDGE_S, MUSIC_VARIATION, MusicChoice, type MusicChoiceContext,
} from '../src/stage/music-choice';

const NOW = 1_700_000_000_000;
const context = (over: Partial<MusicChoiceContext> = {}): MusicChoiceContext => ({ playfulWeight: 1, cautiousWeight: 1, playfulIntensity: 50, mood: 'calm',
  fatigue: { phase: 'awake', F: 0.25 }, activity: 'company', scope: 'gene|a', request: null, nowMs: NOW, expressive: true, ...over });
/**
 * Runs the director at 30 frames a second for `seconds`, with the context possibly changing over time. What she hears is
 * music (I-016: the stage gives the fast layer's verdict every frame; tests/listen-kind-stage.test.ts covers sound that is not).
 */
function run(choice: MusicChoice, seconds: number, ctx: MusicChoiceContext | ((time: number) => MusicChoiceContext), start = 0) {
  const tiers: string[] = [];
  const frames = Math.round(seconds * 30);
  for (let i = 0; i < frames; i++) {
    choice.noteMusic(true);
    choice.frame(1 / 30, typeof ctx === 'function' ? ctx(start + i / 30) : ctx);
    tiers.push(choice.tier);
  }
  return tiers;
}
const fixed = (value: number) => () => value;
const mid = fixed(0.5); // no variation

test('M1 director: "always" is the original: dance exactly while she hears music, no judging, whatever her mood or sleep', () => {
  let judged = 0;
  const choice = new MusicChoice(input => { judged++; return moodLabelDanceDesire(input); }, mid);
  choice.setAlways(true);
  assert.equal(choice.tier, 'none');
  choice.setHearing(true);
  assert.equal(choice.tier, 'dance', 'on the very call, before any frame');
  const sad = context({ mood: 'sad', fatigue: { phase: 'asleep' }, expressive: false });
  assert.deepEqual(new Set(run(choice, 30, sad)), new Set(['dance']));
  choice.setHearing(false);
  assert.equal(choice.tier, 'none');
  choice.setHearing(true); choice.setHearing(false); choice.setHearing(true);
  assert.equal(choice.tier, 'dance');
  assert.equal(judged, 0, 'the decision function is never called');
  assert.match(choice.getState().line, /让她一直跟着跳/);
});

test('M1 director: a new song is judged at once, again after a few seconds, then every so often', () => {
  const calls: number[] = [];
  let clock = 0;
  const choice = new MusicChoice(input => { calls.push(clock); return moodLabelDanceDesire(input); }, mid);
  choice.setHearing(true);
  assert.equal(choice.tier, 'none', 'not judged yet: she has not decided');
  for (let i = 0; i < 30 * 40; i++) { clock = i / 30; choice.noteMusic(true); choice.frame(1 / 30, context()); }
  // At the start, at the catch-on moment (5 s), then every 15 s: 0, 5, 20, 35 in 40 s.
  assert.equal(calls.length, 4, JSON.stringify(calls));
  assert.ok(calls[0] <= 1 / 30 + 1e-9 && Math.abs(calls[1] - MUSIC_CATCH_ON_S) < 0.1 && Math.abs(calls[2] - (MUSIC_CATCH_ON_S + MUSIC_REJUDGE_S)) < 0.1, JSON.stringify(calls));
  assert.equal(choice.tier, 'nod', 'a calm average card nods');
});

test('M1 director: the tier follows her character, mood, energy and what she is doing', () => {
  const tierOf = (ctx: MusicChoiceContext, seconds = 12) => { const c = new MusicChoice(moodLabelDanceDesire, mid); c.setHearing(true); run(c, seconds, ctx); return c.tier; };
  assert.equal(tierOf(context()), 'nod');
  assert.equal(tierOf(context({ mood: 'happy' })), 'dance');
  assert.equal(tierOf(context({ mood: 'sad' })), 'none');
  assert.equal(tierOf(context({ mood: 'content', playfulWeight: 1.5, playfulIntensity: 80 })), 'dance');
  assert.equal(tierOf(context({ mood: 'content', playfulWeight: 0.5, cautiousWeight: 1.5 })), 'none');
  assert.equal(tierOf(context({ mood: 'happy', fatigue: { phase: 'drowsy', F: 0.7 } })), 'none', 'drowsy');
  assert.equal(tierOf(context({ mood: 'happy', fatigue: { phase: 'asleep', F: 0.1 }, expressive: true })), 'none', 'asleep');
  assert.equal(tierOf(context({ mood: 'happy', expressive: false })), 'none', '自动表现 paused');
  // Daydreaming: only a nod at first, carried along into the dance after the catch-on moment.
  const lost = new MusicChoice(moodLabelDanceDesire, mid); lost.setHearing(true);
  const first = run(lost, 1, context({ mood: 'happy', activity: 'daydream' }));
  assert.equal(first.at(-1), 'nod', 'at the start she is only half there');
  run(lost, 10, context({ mood: 'happy', activity: 'daydream' }), 1);
  assert.equal(lost.tier, 'dance', 'after a moment she is carried along');
});

test('M1 director: a short gap is the same song, a long one is a new song', () => {
  let judged = 0;
  const choice = new MusicChoice(input => { judged++; return moodLabelDanceDesire(input); }, mid);
  choice.setHearing(true); run(choice, 6, context({ mood: 'happy' }));
  assert.equal(choice.tier, 'dance'); const before = judged;
  choice.setHearing(false); run(choice, MUSIC_NEW_SONG_GAP_S - 1, context({ mood: 'happy' }));
  assert.equal(choice.tier, 'none', 'no music: nothing to do, whatever she decided');
  choice.setHearing(true);
  assert.equal(choice.tier, 'dance', 'the same song comes back as it was, without a new judgement');
  choice.noteMusic(true); choice.frame(1 / 30, context({ mood: 'happy' })); assert.equal(judged, before);
  choice.setHearing(false); run(choice, MUSIC_NEW_SONG_GAP_S + 1, context({ mood: 'sad' }));
  choice.setHearing(true);
  assert.equal(choice.tier, 'none', 'a new song starts undecided');
  choice.noteMusic(true); choice.frame(1 / 30, context({ mood: 'sad' }));
  assert.ok(judged > before, 'and is judged at once');
  assert.equal(choice.tier, 'none');
});

test('M1 director: falling asleep stops her on that very frame; waking lets her join in again at the next judgement', () => {
  const choice = new MusicChoice(moodLabelDanceDesire, mid);
  choice.setHearing(true);
  const awake = context({ mood: 'happy' });
  run(choice, 12, awake);
  assert.equal(choice.tier, 'dance');
  choice.frame(1 / 30, { ...awake, fatigue: { phase: 'falling-asleep', F: 0.9 } });
  assert.equal(choice.tier, 'none', 'at once, not at the next scheduled judgement');
  assert.match(choice.getState().line, /睡着了/);
  run(choice, 5, { ...awake, fatigue: { phase: 'asleep', F: 0.9 } });
  assert.equal(choice.tier, 'none');
  run(choice, 20, awake, 17);
  assert.equal(choice.tier, 'dance', 'awake again: she joins in');
});

test('M1 director: an extra judgement inside the minimum stay changes nothing; the next scheduled one does', () => {
  const choice = new MusicChoice(moodLabelDanceDesire, mid);
  choice.setHearing(true);
  const happy = context({ mood: 'happy' });
  run(choice, MUSIC_CATCH_ON_S + 1, happy);
  assert.equal(choice.tier, 'dance');
  // A change of energy a moment after she settled on the dance triggers a judgement of its own, 2 s after the last tier change.
  const tired = context({ mood: 'sad', fatigue: { phase: 'light-drowsy', F: 0.6 } });
  const tiers = run(choice, MUSIC_MIN_STAY_S / 2, tired, MUSIC_CATCH_ON_S + 1);
  assert.equal(tiers.at(-1), 'dance', `no flicker: she keeps dancing inside ${MUSIC_MIN_STAY_S} s of the last change`);
  run(choice, MUSIC_REJUDGE_S, tired, MUSIC_CATCH_ON_S + 1 + MUSIC_MIN_STAY_S / 2);
  assert.equal(choice.tier, 'none', 'at the next scheduled judgement she has changed');
});

test('M1 director: a fresh chat request lifts her at once; a stale or repeated one does not; it expires', () => {
  // A willing card that is a little worried (a nod on her own).
  const ctx = (request: MusicChoiceContext['request']) => context({ mood: 'concerned', playfulWeight: 1.5, cautiousWeight: 0.8, request });
  let judged = 0;
  const spy: DanceDesireFn = input => { judged++; return moodLabelDanceDesire(input); };
  const stale = new MusicChoice(spy, mid); stale.setHearing(true);
  run(stale, 6, ctx(null)); assert.equal(stale.tier, 'nod');
  // A message that is 20 s old when first seen is ignored (a late or replayed view starts nothing).
  run(stale, 6, ctx({ id: 'old', at: NOW - 20_000 }), 6);
  assert.equal(stale.getState().request, 0);
  assert.equal(stale.tier, 'nod');

  const willing = new MusicChoice(spy, mid); willing.setHearing(true);
  run(willing, 6, ctx(null)); assert.equal(willing.tier, 'nod');
  const before = judged;
  const tiers = run(willing, 4, ctx({ id: 'ask-1', at: NOW }), 6);
  assert.equal(tiers.at(-1), 'dance', 'asked, she joins in within a few seconds');
  assert.ok(willing.getState().request > 0.9);
  assert.ok(judged - before <= 3, `the same message is not counted again every frame (${judged - before} judgements)`);
  // The same marker stays in the view for a minute; it does not restart the request, and the request expires.
  run(willing, 140, ctx({ id: 'ask-1', at: NOW }), 10);
  assert.ok(willing.getState().request >= 0);
  run(willing, DANCE_REQUEST_WINDOW_MS / 1000 + 20 - 140, ctx({ id: 'ask-1', at: NOW }), 150);
  assert.equal(willing.getState().request, 0, 'expired');
  assert.equal(willing.tier, 'nod', 'after the window the extra push is gone and she settles back to her own want');
  // A second, different message asks again.
  run(willing, 5, { ...ctx({ id: 'ask-2', at: NOW + 170_000 }), nowMs: NOW + 170_000 }, 170);
  assert.equal(willing.tier, 'dance');
});

test('M1 director: a stubborn card holds out at first, then gives in a while later (and a request is per character)', () => {
  const stubborn = (request: MusicChoiceContext['request'], scope = 'gene|a') => context({ mood: 'calm', playfulWeight: 0.5, cautiousWeight: 1.5, request, scope });
  const choice = new MusicChoice(moodLabelDanceDesire, mid); choice.setHearing(true);
  const ask = { id: 'ask', at: NOW };
  const early = run(choice, 8, stubborn(ask));
  assert.ok(!early.includes('dance'), 'she says no at first');
  const late = run(choice, 40, stubborn(ask), 8);
  assert.equal(late.at(-1), 'dance', 'and later dances on her own');
  const other = new MusicChoice(moodLabelDanceDesire, mid); other.setHearing(true);
  run(other, 4, stubborn(ask, 'gene|a'));
  run(other, 40, stubborn(ask, 'someone|b'), 4);
  assert.ok(other.getState().request === 0 || other.tier !== 'dance', 'a request from the other character scope carries nothing over');
});

test('M1 director: the per-judgement variation is small, bounded and injectable', () => {
  const scores = [0, 0.5, 1].map(value => { const c = new MusicChoice(moodLabelDanceDesire, fixed(value)); c.setHearing(true); run(c, 1, context()); return c.getState().score!; });
  assert.ok(scores[0] < scores[1] && scores[1] < scores[2]);
  assert.ok(Math.abs(scores[2] - scores[0] - 2 * MUSIC_VARIATION) < 1e-9);
  const asleep = new MusicChoice(moodLabelDanceDesire, fixed(1)); asleep.setHearing(true); run(asleep, 1, context({ fatigue: { phase: 'asleep' } }));
  assert.equal(asleep.getState().score, 0, 'variation never wakes her');
});

test('M1 director: the decision is one replaceable function, and the raw mood channels are reachable for the next version', () => {
  const seen: DanceDesireInput[] = [];
  const raw: DanceDesireFn = input => { seen.push(input); return { score: 0.9, tier: 'dance', parts: [], reason: '想跳 0.90 · 跳起来 · 测试', asleep: false }; };
  const choice = new MusicChoice(raw, mid); choice.setHearing(true);
  run(choice, 1, context({ channels: { D: 80, O: 50, E: 60, N: 70, C: 20 } }));
  assert.equal(choice.tier, 'dance');
  assert.deepEqual(seen[0].channels, { D: 80, O: 50, E: 60, N: 70, C: 20 }, 'the future function receives the raw channels');
  assert.equal(seen[0].heardSeconds >= 0 && seen[0].request === 0, true);
});

test('M1 director: turning "always" off mid-song carries on as she was and judges at once; on again goes back to the original', () => {
  const choice = new MusicChoice(moodLabelDanceDesire, mid);
  choice.setAlways(true); choice.setHearing(true);
  run(choice, 5, context({ mood: 'sad' }));
  assert.equal(choice.tier, 'dance');
  choice.setAlways(false);
  assert.equal(choice.tier, 'dance', 'no cut at the switch');
  choice.frame(1 / 30, context({ mood: 'sad' }));
  assert.equal(choice.tier, 'none', 'judged on the next frame: sad she stops (by the smooth exit)');
  choice.setAlways(true);
  assert.equal(choice.tier, 'dance');
});
