/** M1: the local "want to dance" decision: it follows her character, mood, energy and what she is doing; a chat request expires. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DANCE_BASE, DANCE_DANCE_AT, DANCE_NOD_AT, DANCE_REQUEST_WINDOW_MS, DANCE_STAY_MARGIN, danceReluctance, danceRequestStrength, danceTierOf,
  danceTierWithHysteresis, moodLabelDanceDesire, type DanceDesireInput,
} from '../shared/music-desire';

const card = { playfulWeight: 1, cautiousWeight: 1 };
const base = (over: Partial<DanceDesireInput> = {}): DanceDesireInput => ({ playfulWeight: 1, cautiousWeight: 1, playfulIntensity: 50, mood: 'calm',
  fatigue: { phase: 'awake', F: 0.25 }, activity: 'company', heardSeconds: 0, request: 0, ...over });
const score = (over: Partial<DanceDesireInput> = {}) => moodLabelDanceDesire(base(over)).score;

test('M1 desire: an average card in a calm mood nods; happy dances; sad stays still', () => {
  assert.equal(score(), DANCE_BASE);
  assert.equal(moodLabelDanceDesire(base()).tier, 'nod');
  assert.equal(moodLabelDanceDesire(base({ mood: 'happy' })).tier, 'dance');
  assert.equal(moodLabelDanceDesire(base({ mood: 'excited' })).tier, 'dance');
  assert.equal(moodLabelDanceDesire(base({ mood: 'sad' })).tier, 'none');
  assert.equal(moodLabelDanceDesire(base({ mood: 'upset' })).tier, 'none');
});

test('M1 desire: the score follows her mood in the order happy moods > calm > low moods', () => {
  const order = ['excited', 'happy', 'relieved', 'content', 'close', 'calm', 'longing', 'concerned', 'disappointed', 'upset', 'sad'].map(mood => score({ mood }));
  for (let i = 1; i < order.length; i++) assert.ok(order[i] <= order[i - 1] + 1e-9, `mood #${i}: ${order[i]} <= ${order[i - 1]}`);
  assert.ok(order[0] > order.at(-1)! + 0.4);
});

test('M1 desire: her character moves it: a playful card wants to dance more, a cautious one less', () => {
  assert.ok(score({ playfulWeight: 1.5 }) > score() && score({ playfulWeight: 0.5 }) < score());
  assert.ok(score({ cautiousWeight: 1.5 }) < score() && score({ cautiousWeight: 0.5 }) > score());
  assert.ok(score({ playfulIntensity: 90 }) > score() && score({ playfulIntensity: 10 }) < score());
  // The same mood gives a different tier for a different card.
  assert.equal(moodLabelDanceDesire(base({ mood: 'content', playfulWeight: 1.5, playfulIntensity: 80 })).tier, 'dance');
  assert.equal(moodLabelDanceDesire(base({ mood: 'content', playfulWeight: 0.5 })).tier, 'nod', 'a quiet card still nods when content');
  assert.equal(moodLabelDanceDesire(base({ mood: 'content', playfulWeight: 0.5, cautiousWeight: 1.5 })).tier, 'none', 'a reserved one stays still');
  assert.equal(moodLabelDanceDesire(base({ playfulWeight: 0.5, cautiousWeight: 1.5, playfulIntensity: 20 })).tier, 'none');
});

test('M1 desire: energy: tired she moves less, drowsy she stops, asleep never moves', () => {
  const rested = score({ mood: 'happy' });
  assert.ok(score({ mood: 'happy', fatigue: { phase: 'awake', F: 0.9 } }) < rested);
  assert.ok(score({ mood: 'happy', fatigue: { phase: 'light-drowsy', F: 0.5 } }) < rested);
  const drowsy = moodLabelDanceDesire(base({ mood: 'happy', fatigue: { phase: 'drowsy', F: 0.7 } }));
  assert.equal(drowsy.tier, 'none', 'drowsy: a happy but sleepy her does not dance');
  for (const phase of ['falling-asleep', 'asleep', 'micro-awake']) {
    const asleep = moodLabelDanceDesire(base({ mood: 'excited', request: 1, fatigue: { phase, F: 0.2 } }));
    assert.deepEqual([asleep.score, asleep.tier, asleep.asleep], [0, 'none', true], `${phase} never moves, even when asked`);
  }
  assert.equal(moodLabelDanceDesire(base({ mood: 'excited', fatigue: { phase: 'awake', sleeping: true } })).asleep, true);
});

test('M1 desire: what she is doing: a fresh daydream or thought delays being carried along; humming helps', () => {
  const start = score({ mood: 'happy', activity: 'daydream', heardSeconds: 0 }), later = score({ mood: 'happy', activity: 'daydream', heardSeconds: 10 });
  assert.ok(start < later && later === score({ mood: 'happy' }), 'a daydream costs most at the start of the song and is gone after a few seconds');
  assert.equal(moodLabelDanceDesire(base({ mood: 'happy', activity: 'daydream', heardSeconds: 0 })).tier, 'nod', 'at first she is only half there');
  assert.equal(moodLabelDanceDesire(base({ mood: 'happy', activity: 'daydream', heardSeconds: 10 })).tier, 'dance', 'after a moment she is carried along');
  assert.ok(score({ mood: 'happy', activity: 'thinking', heardSeconds: 0 }) < score({ mood: 'happy' }));
  const ramp = [0, 2, 4, 6, 8].map(heardSeconds => score({ mood: 'happy', activity: 'daydream', heardSeconds }));
  for (let i = 1; i < ramp.length; i++) assert.ok(ramp[i] >= ramp[i - 1], 'it only ever rises as the song goes on');
  assert.ok(score({ activity: 'humming' }) > score());
});

test('M1 desire: a chat request adds a lot, but her character and mood still decide', () => {
  assert.ok(score({ request: 1 }) - score() >= 0.4, 'a large bonus');
  assert.equal(moodLabelDanceDesire(base({ request: 1 })).tier, 'dance', 'asked, an average calm her dances');
  // Stubborn: a sad, cautious, low-playful her is asked and still does not dance (at most a light nod).
  const stubborn = moodLabelDanceDesire(base({ request: 1, mood: 'sad', playfulWeight: 0.5, cautiousWeight: 1.5, playfulIntensity: 20 }));
  assert.notEqual(stubborn.tier, 'dance');
  assert.ok(score({ request: 1, mood: 'upset' }) - score({ mood: 'upset' }) < 0.2, 'a cross her takes the request less');
  assert.ok(score({ request: 1, mood: 'happy', fatigue: { phase: 'drowsy', F: 0.7 } }) < DANCE_DANCE_AT, 'drowsy: asked, still no dance');
});

test('M1 desire: the future inputs are accepted and add nothing today (user moving: a small plus; raw channels: ignored)', () => {
  assert.ok(score({ userMoving: 1 }) > score());
  assert.equal(score({ userMoving: 0 }), score());
  assert.equal(score({ channels: { D: 90, O: 10, E: 50, N: 80, C: 20 } }), score(), 'the label version ignores the raw channels');
  for (const bad of [Number.NaN, Infinity, -5]) assert.ok(Number.isFinite(score({ playfulWeight: bad, cautiousWeight: bad, playfulIntensity: bad, request: bad })));
});

test('M1 desire: the developer line says what moved the score', () => {
  const result = moodLabelDanceDesire(base({ mood: 'happy', activity: 'daydream', heardSeconds: 0, playfulWeight: 1.4 }));
  assert.match(result.reason, /^想跳 0\.\d\d · /);
  assert.match(result.reason, /心情愉快\+0\.22/);
  assert.match(result.reason, /正在做的事发呆-0\.14/);
  assert.match(result.reason, /爱玩倾向\+0\.09/);
  assert.equal(moodLabelDanceDesire(base({ fatigue: { phase: 'asleep' } })).reason, '想跳 0.00 · 不动 · 睡着了');
});

test('M1 desire: tiers have hysteresis: climbing needs the threshold, falling needs a clear drop', () => {
  assert.equal(danceTierOf(DANCE_DANCE_AT), 'dance');
  assert.equal(danceTierOf(DANCE_DANCE_AT - 0.001), 'nod');
  assert.equal(danceTierOf(DANCE_NOD_AT - 0.001), 'none');
  assert.equal(danceTierWithHysteresis(DANCE_DANCE_AT - 0.01, 'nod'), 'nod', 'not up yet');
  assert.equal(danceTierWithHysteresis(DANCE_DANCE_AT - 0.01, 'dance'), 'dance', 'just below: stays');
  assert.equal(danceTierWithHysteresis(DANCE_DANCE_AT - DANCE_STAY_MARGIN - 0.01, 'dance'), 'nod', 'clearly below: eases to a nod');
  assert.equal(danceTierWithHysteresis(DANCE_NOD_AT - 0.01, 'nod'), 'nod');
  assert.equal(danceTierWithHysteresis(DANCE_NOD_AT - DANCE_STAY_MARGIN - 0.01, 'nod'), 'none');
  assert.equal(danceTierWithHysteresis(0, 'dance'), 'none', 'a full drop goes straight to none');
  assert.equal(danceTierWithHysteresis(0.9, 'none'), 'dance');
});

test('M1 request: strength rises at once for a willing card, late for a stubborn one, and expires', () => {
  const willing = { playfulWeight: 1.5, cautiousWeight: 1 }, stubborn = { playfulWeight: 0.5, cautiousWeight: 1.5 };
  assert.ok(danceReluctance(willing) < danceReluctance(card) && danceReluctance(card) < danceReluctance(stubborn));
  assert.equal(danceRequestStrength(0, willing), 0);
  assert.ok(danceRequestStrength(2_500, willing) > 0.99, 'a willing card takes it within a couple of seconds');
  assert.equal(danceRequestStrength(2_500, stubborn), 0, 'a stubborn card holds out at first');
  assert.ok(danceRequestStrength(30_000, stubborn) > 0.99, 'and gives in after a while');
  const series = Array.from({ length: 160 }, (_, i) => danceRequestStrength(i * 1_000, stubborn));
  assert.ok(series.every(value => value >= 0 && value <= 1));
  assert.equal(danceRequestStrength(DANCE_REQUEST_WINDOW_MS, willing), 0, 'it expires');
  assert.equal(danceRequestStrength(DANCE_REQUEST_WINDOW_MS + 10_000, stubborn), 0);
  assert.ok(danceRequestStrength(DANCE_REQUEST_WINDOW_MS - 1_000, willing) < 0.05, 'and fades out before it ends');
  assert.equal(danceRequestStrength(-5, willing), 0);
  assert.equal(danceRequestStrength(Number.NaN, willing), 0);
});

test('M1 desire: the decision is local: no model, network or process in the modules that make it', () => {
  for (const file of ['../shared/music-desire.ts', '../shared/dance-request.ts', '../src/stage/music-choice.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import[^;]*from\s+['"]([^'"]+)['"]/gmu)].map(match => match[1]);
    for (const spec of imports) assert.ok(!/claude|codex|child_process|node:|electron|http|fetch/iu.test(spec), `${file} imports ${spec}`);
    assert.ok(!/\bfetch\(|XMLHttpRequest|spawn\(|exec\(|window\.desktop/u.test(source), `${file} calls out`);
  }
});
