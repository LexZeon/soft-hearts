import test from 'node:test';
import assert from 'node:assert/strict';
import { RPS_HANDS, RPS_TIMING, rpsBeats, rpsCommit, rpsJudge, rpsLoserAgainst, rpsVerify, rpsWinnerAgainst, readRpsThrow, type RpsHand } from '../shared/rps';
import { RpsMatch, type RpsMatchOptions } from '../shared/rps-match';
import { RPS_LIMITS, resolveRpsStyle, type RpsResolvedStyle } from '../shared/rps-personality';
import { rpsHabits, type RpsGameRecord } from '../shared/rps-memory';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import { seeded } from './helpers/seeded';
const nonces = () => { let n = 0; return () => `nonce${++n}`; };
const T = RPS_TIMING;
const style: RpsResolvedStyle = resolveRpsStyle({ soft: 2, tease: 2 }, DEFAULT_MOOD_PARAMETERS);
const options = (seed: number, extra: Partial<RpsMatchOptions> = {}): RpsMatchOptions => ({ id: 'match1', origin: 'user', random: seeded(seed), nonce: nonces(), style, habits: null, ...extra });

test('who wins: rock beats scissors beats paper beats rock; the helpers agree', () => {
  assert.equal(rpsJudge('rock', 'scissors'), 'her'); assert.equal(rpsJudge('scissors', 'rock'), 'user'); assert.equal(rpsJudge('paper', 'paper'), 'draw');
  for (const hand of RPS_HANDS) {
    assert.ok(rpsBeats(rpsWinnerAgainst(hand), hand)); assert.ok(rpsBeats(hand, rpsLoserAgainst(hand)));
    assert.equal(rpsJudge(hand, hand), 'draw');
  }
});

test('the seal: the digest opens only with the exact hand, intent and nonce', () => {
  const secret = { hand: 'paper' as const, intent: 'fair' as const, nonce: 'abc' };
  const commitment = rpsCommit('g1', 1, 1000, secret);
  assert.match(commitment.digest, /^[0-9a-f]{64}$/u);
  assert.equal(rpsVerify(commitment, secret), true);
  for (const tampered of [{ ...secret, hand: 'rock' as const }, { ...secret, intent: 'soft' as const }, { ...secret, nonce: 'abd' }])
    assert.equal(rpsVerify(commitment, tampered), false);
  assert.equal(rpsVerify({ ...commitment, round: 2 }, secret), false);
  assert.equal(rpsVerify({ ...commitment, committedAt: 1001 }, secret), false);
});

type Timing = 'early' | 'same-before' | 'same-after' | 'late';
/** Plays one match to its end with the given user hands and timing; returns her sealed hands per round and every view. */
function play(seed: number, hands: (round: number) => RpsHand, timing: Timing, extra: Partial<RpsMatchOptions> = {}) {
  let now = 10_000;
  const match = new RpsMatch(options(seed, extra), now);
  const sealed: { round: number; hand: RpsHand; digest: string; sealedAt: number; inputAt: number | null }[] = [];
  const views: ReturnType<RpsMatch['view']>[] = [];
  for (let guard = 0; guard < 200 && !match.over; guard++) {
    const view = match.view(now, null); views.push(view);
    const { secret, commitment } = match.sealedForTest();
    if (!sealed.some(row => row.round === commitment.round)) sealed.push({ round: commitment.round, hand: secret.hand, digest: commitment.digest, sealedAt: now, inputAt: null });
    const row = sealed.find(entry => entry.round === commitment.round)!;
    const phase = match.currentPhase, deadline = match.deadline();
    const throwNow = () => { const result = match.throwHand({ round: view.round, hand: hands(view.round), source: 'click' }, now); row.inputAt ??= now; return result; };
    if (view.accepting && phase === 'ready' && timing === 'early') { assert.equal(throwNow(), 'accepted'); }
    if (phase === 'count' && view.accepting) {
      now = deadline!; // exactly on 布
      if (timing === 'same-before') { assert.equal(throwNow(), 'accepted'); match.advance(now); continue; }
      match.advance(now);
      if (timing === 'same-after') { assert.equal(match.currentPhase, 'wait'); assert.equal(throwNow(), 'accepted'); continue; }
      continue;
    }
    if (phase === 'wait' && view.accepting) {
      // Late: her hand is still sealed and hidden while she waits.
      assert.equal(view.revealed, null); assert.ok(view.commitment);
      now += 3_000; assert.equal(throwNow(), 'accepted'); continue;
    }
    if (deadline === null) break;
    now = deadline; match.advance(now);
  }
  return { match, sealed, views, now };
}

test('her hand is sealed before the round accepts input, and nothing the user does changes it (first, simultaneous either side, late; any hand)', () => {
  const timings: Timing[] = ['early', 'same-before', 'same-after', 'late'];
  const userPlans: ((round: number) => RpsHand)[] = [() => 'rock', () => 'paper', () => 'scissors', round => RPS_HANDS[round % 3], round => RPS_HANDS[(round * 7 + 1) % 3]];
  for (let seed = 1; seed <= 150; seed++) {
    let reference: { round: number; hand: RpsHand; digest: string }[] | null = null;
    for (const timing of timings) for (const plan of userPlans) {
      const { sealed, views } = play(seed, plan, timing);
      for (const row of sealed) if (row.inputAt !== null) assert.ok(row.sealedAt <= row.inputAt, 'sealed before the first input of its round');
      // What is revealed is exactly what was sealed before the user's hand arrived.
      for (const view of views) if (view.phase === 'reveal') assert.equal(view.revealed!.hand, sealed.find(row => row.round === view.round)!.hand, `seed ${seed} reveal ${view.round}`);
      if (!reference) { reference = sealed; continue; }
      const common = Math.min(reference.length, sealed.length);
      for (let i = 0; i < common; i++) {
        assert.equal(sealed[i].hand, reference[i].hand, `seed ${seed} round ${i + 1} ${timing}`);
        // The first seal is byte-identical; later seals carry their own (input-dependent) time, the hand inside is the same.
        if (i === 0) assert.equal(sealed[i].digest, reference[i].digest, `seed ${seed} round 1 digest`);
      }
    }
  }
});

test('the window never sees her hand before the reveal; at the reveal the seal verifies', () => {
  for (let seed = 1; seed <= 60; seed++) for (const timing of ['early', 'late'] as Timing[]) {
    const { views } = play(seed, round => RPS_HANDS[(round + seed) % 3], timing);
    let commitment = null as null | NonNullable<typeof views[number]['commitment']>;
    for (const view of views) {
      if (view.phase === 'ready' || view.phase === 'count' || view.phase === 'wait') {
        assert.equal(view.revealed, null); assert.ok(view.commitment); commitment = view.commitment;
        assert.equal(JSON.stringify(view).includes('"hand"'), false, 'no hand field before the reveal');
      }
      if (view.phase === 'reveal') { assert.ok(view.revealed); assert.equal(rpsVerify(commitment!, view.revealed!), true); }
    }
  }
});

test('a throw that does not belong to the open round is refused: next round, duplicate, after the end', () => {
  let now = 0;
  const match = new RpsMatch(options(3), now);
  assert.equal(match.throwHand({ round: 2, hand: 'rock', source: 'click' }, now), 'stale');
  assert.equal(match.throwHand({ round: 1, hand: 'rock', source: 'click' }, now), 'accepted');
  assert.equal(match.throwHand({ round: 1, hand: 'paper', source: 'click' }, now), 'duplicate');
  now += T.readyMs + T.leadMs + 2 * T.beatMs; match.advance(now);
  assert.equal(match.currentPhase, 'reveal');
  assert.equal(match.throwHand({ round: 1, hand: 'paper', source: 'click' }, now), 'stale');
  match.stop(now, 'abandoned');
  assert.equal(match.throwHand({ round: 1, hand: 'paper', source: 'click' }, now), 'closed');
  assert.equal(readRpsThrow({ gameId: 'x', round: 1, hand: 'rock', source: 'click', extra: 1 }), null);
  assert.equal(readRpsThrow({ gameId: 'x', round: 0, hand: 'rock', source: 'click' }), null);
  assert.equal(readRpsThrow({ gameId: 'x', round: 1, hand: 'lizard', source: 'click' }), null);
});

test('best of three: first to two wins, draws replay, a match never passes seven throws, one or two minutes long', () => {
  let lengths: number[] = [];
  for (let seed = 1; seed <= 400; seed++) {
    const { match, now } = play(seed, round => RPS_HANDS[(round * 5 + seed) % 3], 'early');
    const record = match.record(now);
    const her = record.rounds.filter(r => r.outcome === 'her').length, user = record.rounds.filter(r => r.outcome === 'user').length;
    assert.ok(record.rounds.length <= 7);
    if (record.result === 'her') assert.equal(her, 2); else if (record.result === 'user') assert.equal(user, 2);
    else assert.equal(record.rounds.length, 7);
    lengths.push(now - 10_000);
  }
  lengths = lengths.sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)], longest = lengths.at(-1)!;
  assert.ok(median >= 15_000 && median <= 60_000, `median ${median}`);
  assert.ok(longest <= 120_000, `longest ${longest}`);
});

test('no hand after 布 for the whole wait: she lets it go (timeout), nothing is revealed', () => {
  let now = 0;
  const match = new RpsMatch(options(9), now);
  now += T.readyMs; match.advance(now); now += T.leadMs + 2 * T.beatMs; match.advance(now);
  assert.equal(match.currentPhase, 'wait'); assert.equal(match.cue.kind, 'wait');
  now += T.waitMs; match.advance(now);
  assert.equal(match.currentPhase, 'end'); assert.equal(match.end, 'timeout'); assert.equal(match.cue.kind, 'timeout');
  assert.equal(match.view(now, null).revealed, null);
  now += T.endMs; match.advance(now); assert.equal(match.over, true);
  assert.deepEqual(match.record(now).rounds, []);
});

test('caps: letting the user win, reading a habit and the pretend cheat happen at most once per match, at bounded rates', () => {
  const greedy = resolveRpsStyle({ soft: 3, tease: 3 }, { ...DEFAULT_MOOD_PARAMETERS, weights: { playful: 3, close: 3, comfortable: 3, cautious: 0 }, intensity: { ...DEFAULT_MOOD_PARAMETERS.intensity, playful: 100 } });
  assert.ok(greedy.softChance <= RPS_LIMITS.softChance && greedy.teaseChance <= RPS_LIMITS.teaseChance && greedy.readChance <= RPS_LIMITS.readChance);
  const habitRecords: RpsGameRecord[] = Array.from({ length: 6 }, (_, i) => ({ at: i, origin: 'user', result: 'none', rounds: [{ her: 'paper', user: 'rock', outcome: 'her' }] }));
  const habits = rpsHabits(habitRecords);
  let soft = 0, read = 0, tease = 0, rounds = 0, lost = 0;
  const N = 6000;
  for (let seed = 1; seed <= N; seed++) {
    const { match, now } = play(seed, round => RPS_HANDS[(round + seed * 13) % 3], 'early', { style: greedy, habits });
    const intents = match.intents();
    assert.ok(intents.soft <= RPS_LIMITS.softPerMatch && intents.read <= RPS_LIMITS.readPerMatch && intents.tease <= RPS_LIMITS.teasePerMatch, `seed ${seed}`);
    soft += intents.soft; read += intents.read; tease += intents.tease;
    const record = match.record(now); rounds += record.rounds.length; lost += record.rounds.filter(r => r.outcome === 'user').length;
  }
  // Per match: soft only while unused, so its share of matches stays near 1 − (1 − p)^rounds and never above 1.
  assert.ok(soft / N < 0.8, `soft per match ${soft / N}`);
  assert.ok(read / N <= greedy.readChance + 0.03, `read per match ${read / N}`);
  assert.ok(tease / lost <= RPS_LIMITS.teaseChance + 0.02, `tease per lost round ${tease / lost}`);
  // A gentle default card lets the user win only now and then.
  const plain = resolveRpsStyle(null, DEFAULT_MOOD_PARAMETERS);
  let softPlain = 0;
  for (let seed = 1; seed <= 3000; seed++) softPlain += play(seed, () => 'rock', 'early', { style: plain }).match.intents().soft;
  assert.ok(softPlain / 3000 < 0.35, `default soft per match ${softPlain / 3000}`);
});

test('letting the user win uses only earlier games: with a rock habit she plays scissors when she gives way', () => {
  const records: RpsGameRecord[] = Array.from({ length: 5 }, (_, i) => ({ at: i, origin: 'user', result: 'none', rounds: [{ her: 'scissors', user: 'rock', outcome: 'user' }] }));
  const always: RpsResolvedStyle = { softChance: 1, teaseChance: 0, readChance: 0 };
  const match = new RpsMatch(options(1, { style: always, habits: rpsHabits(records) }), 0);
  assert.deepEqual({ hand: match.sealedForTest().secret.hand, intent: match.sealedForTest().secret.intent }, { hand: 'scissors', intent: 'soft' });
});
