// I-184 (docs/claude/2026-11-22-i184-unbound-kiss.md): close moments in full-screen Unbound (凑近看、亲亲、抱抱), the pure rules: the one
// chooser (gates, mood, familiarity, character, caps, cooldowns), the after-beat by character ("按性格定"), the plan, the curves (no jump
// at 60 or 30 fps, a cancel starts from where it is), the pucker that never starts while she speaks, and the turn line's words.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOSE_MOMENT_KNOBS, CloseMomentHistory, NEUTRAL_TEMPERAMENT, PuckerGate, REST_CHANNELS, afterBeatChances, backChannels, backLength, chooseAfterBeat,
  chooseCloseMoment, closeChances, closeMomentLine, leanChannels, parseCloseMomentPlan, parseDirectorPlan, planCloseMoment, settleChannels, SETTLE_FADE_S,
  type CloseChannels, type CloseChoiceInput, type CloseGates, type CloseMomentPlan, type CloseTemperament,
} from '../shared/unbound/close-moments';
import { NEUTRAL_MOOD, planPeek, type MoodReading } from '../shared/unbound/director';
import { ARRIVAL_KNOBS } from '../shared/unbound/arrival';
import { INSTRUCTION_WORDS } from '../shared/unbound/life/history';
import { MOOD_MOMENTS, MOOD_MOMENT_KINDS } from '../shared/foundation/mood-moments';
import { MOOD_EVENT_SOURCES, moodEventSource } from '../shared/mood/journal-entries';

const OPEN: CloseGates = { shown: true, asleep: false, inCall: false, speaking: false, typing: false, pulled: false, armsHeld: false };
const WARM: MoodReading = { ...NEUTRAL_MOOD, O: 78, E: 65, D: 60, M: 20 };
const BOLD: CloseTemperament = { weights: { playful: 2.4, close: 1.8, comfortable: 1.2, cautious: 0.4 }, intensity: { expression: 85, playful: 85 } };
const SHY: CloseTemperament = { weights: { playful: 0.5, close: 1, comfortable: 0.9, cautious: 2.6 }, intensity: { expression: 60, playful: 20 } };
const COOL: CloseTemperament = { weights: { playful: 0.6, close: 0.9, comfortable: 1.6, cautious: 1 }, intensity: { expression: 12, playful: 20 } };
const DAY = '2026-11-22', NOW = 1_000_000_000;
const input = (patch: Partial<CloseChoiceInput> = {}): CloseChoiceInput => ({ via: 'pulled', now: NOW, day: DAY, mood: WARM, label: 'close',
  temperament: BOLD, gates: OPEN, history: new CloseMomentHistory(), ...patch });

test('gates: not shown, asleep, in a call, speaking, typing, being pulled → never a kiss or a hug, either way in', () => {
  for (const via of ['own', 'pulled'] as const) {
    assert.ok(closeChances(input({ via })).chances.kiss > 0, `${via}: the favourable case does kiss sometimes`);
    for (const [key, words] of [['shown', 'not-shown'], ['asleep', 'asleep'], ['inCall', 'call'], ['speaking', 'speaking'], ['typing', 'typing'], ['pulled', 'pulled']] as const) {
      const gates = { ...OPEN, [key]: key === 'shown' ? false : true };
      const c = closeChances(input({ via, gates }));
      assert.equal(c.block, words, `${via}: ${key}`);
      assert.equal(c.chances.kiss, 0, `${via}: no kiss when ${key}`); assert.equal(c.chances.hug, 0, `${via}: no hug when ${key}`);
      for (const r of [0, 0.3, 0.6, 0.99]) assert.ok(!['kiss', 'hug'].includes(chooseCloseMoment(input({ via, gates }), r).kind));
    }
  }
});

test('mood and character: warm, close and bold raise a kiss; tense or sleepy lowers it', () => {
  const warmBold = closeChances(input()).chances, neutral = closeChances(input({ mood: NEUTRAL_MOOD, label: 'calm', temperament: NEUTRAL_TEMPERAMENT })).chances;
  assert.ok(warmBold.kiss > neutral.kiss * 1.5, `warm + bold + close: ${warmBold.kiss} vs neutral ${neutral.kiss}`);
  const tense = closeChances(input({ mood: { ...WARM, N: 80, C: 80 }, label: 'afraid' })).chances, sleepy = closeChances(input({ mood: { ...WARM, A: 0.68 } })).chances;
  assert.ok(tense.kiss < warmBold.kiss / 2 && sleepy.kiss < warmBold.kiss / 2, 'tense or sleepy: much less');
  const shyCard = closeChances(input({ temperament: SHY })).chances;
  assert.ok(shyCard.kiss < warmBold.kiss && shyCard.shy > warmBold.shy, 'a cautious, unplayful card kisses less and shies more');
  const own = closeChances(input({ via: 'own' }));
  assert.ok(own.chances.kiss + own.chances.hug <= CLOSE_MOMENT_KNOBS.ownShare + 1e-9, 'her own: at most ownShare of the slots');
  assert.ok(Math.abs(Object.values(own.chances).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

// Rules audit item 15: the relationship stage no longer shapes these choices. A stage handed in anyway
// (an older caller) changes nothing: same mood and card, same chances, same beat, same plan.
test('the same mood and card give the same choice whatever the familiarity stage', () => {
  const withStage = (stage: unknown) => ({ ...input(), stage }) as never;
  const chances = (stage: unknown) => closeChances(withStage(stage));
  for (const via of ['pulled', 'own'] as const) {
    const base = JSON.stringify(closeChances({ ...input(), via }));
    for (const stage of ['new', 'warming', 'familiar', 'close', 'old', null]) assert.equal(JSON.stringify(closeChances({ ...input(), via, stage } as never)), base, `${via} / ${String(stage)}`);
  }
  assert.ok(chances('new').chances.kiss > 0.05, 'a new acquaintance is not barred from a kiss by the stage');
  const beat = (stage: unknown) => JSON.stringify(afterBeatChances({ mood: WARM, label: 'close', temperament: BOLD, stage } as never));
  const plan = (stage: unknown) => JSON.stringify(planCloseMoment({ kind: 'kiss', after: 'grin', via: 'pulled', mood: WARM, label: 'close', stage } as never, () => 0.5));
  for (const stage of ['new', 'old', null]) { assert.equal(beat(stage), beat('close')); assert.equal(plan(stage), plan('close')); }
});

test('the daily cap: her own kisses and hugs stop at ownPerDay (kisses at ownKissPerDay); pulled ones are not capped by the day', () => {
  const history = new CloseMomentHistory(), long = (CLOSE_MOMENT_KNOBS.cooldownMinutes + 1) * 60_000;
  for (let i = 0; i < CLOSE_MOMENT_KNOBS.ownPerDay; i++) history.record({ kind: 'hug', via: 'own', at: NOW - (i + 1) * long, day: DAY });
  const own = closeChances(input({ via: 'own', history }));
  assert.ok(own.capped.includes('day'));
  assert.equal(own.chances.kiss, 0, 'no kiss after the day\'s own ones'); assert.equal(own.chances.hug, 0, 'no hug either');
  assert.ok(closeChances(input({ via: 'own', history, day: '2026-11-23' })).chances.kiss > 0, 'a new day: again');
  assert.ok(closeChances(input({ via: 'pulled', history })).chances.kiss > 0, 'pulled close: the day cap is for her own');
  const kisses = new CloseMomentHistory();
  for (let i = 0; i < CLOSE_MOMENT_KNOBS.ownKissPerDay; i++) kisses.record({ kind: 'kiss', via: 'own', at: NOW - (i + 1) * long, day: DAY });
  const k = closeChances(input({ via: 'own', history: kisses }));
  assert.equal(k.chances.kiss, 0, 'kisses capped'); assert.ok(k.chances.hug > 0, 'a hug still may');
});

test('cooldowns: after a kiss or a hug she does not come again on her own for cooldownMinutes; pulled again within pulledCooldownMinutes: no kiss, no hug', () => {
  const history = new CloseMomentHistory();
  history.record({ kind: 'kiss', via: 'pulled', at: NOW - 60_000, day: DAY });
  const own = closeChances(input({ via: 'own', history })), pulled = closeChances(input({ history }));
  assert.equal(own.chances.kiss + own.chances.hug, 0); assert.equal(pulled.chances.kiss + pulled.chances.hug, 0);
  assert.ok(pulled.chances.look + pulled.chances.shy + pulled.chances.none > 0.999, 'pulled again: she looks, shies or does nothing');
  const later = NOW + CLOSE_MOMENT_KNOBS.pulledCooldownMinutes * 60_000;
  assert.ok(closeChances(input({ history, now: later })).chances.kiss > 0, 'pulled after its cooldown: again');
  assert.equal(closeChances(input({ via: 'own', history, now: later })).chances.kiss, 0, 'her own: still cooling down');
  assert.ok(closeChances(input({ via: 'own', history, now: NOW + CLOSE_MOMENT_KNOBS.cooldownMinutes * 60_000 })).chances.kiss > 0);
});

test('a hug never while a game, an offer or her reach holds her arms (a kiss may)', () => {
  for (const via of ['own', 'pulled'] as const) {
    const c = closeChances(input({ via, gates: { ...OPEN, armsHeld: true } }));
    assert.equal(c.chances.hug, 0, via); assert.ok(c.chances.kiss > 0, via); assert.ok(c.capped.includes('arms'));
  }
});

test('the choice follows the chances with the random number (a fake random in tests)', () => {
  const c = closeChances(input());
  const order = ['look', 'kiss', 'hug', 'shy', 'none'] as const;
  let acc = 0;
  for (const kind of order) {
    if (c.chances[kind] <= 0) continue;
    assert.equal(chooseCloseMoment(input(), acc + c.chances[kind] / 2).kind, kind);
    acc += c.chances[kind];
  }
});

test('after a kiss or a hug: "按性格定" — a shy card mostly blushes and looks away, a bold playful one grins or winks, a cool one acts as if nothing happened', () => {
  const at = (temperament: CloseTemperament) => afterBeatChances({ mood: WARM, label: 'close', temperament });
  const shy = at(SHY), bold = at(BOLD), cool = at(COOL);
  const top = (c: Record<string, number>) => Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
  console.log('[I-184 after-beat]', JSON.stringify({ shy, bold, cool }));
  assert.equal(top(shy), 'shy');
  assert.ok(bold.grin + bold.wink > 0.5 && bold.shy < shy.shy / 2, 'bold: grin or wink, rarely shy');
  assert.equal(top(cool), 'cool');
  assert.ok(Math.abs(Object.values(shy).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  // Never one fixed beat: over the random range each card shows more than one.
  const beats = (t: CloseTemperament) => new Set([0.05, 0.3, 0.55, 0.8, 0.97].map(r => chooseAfterBeat({ mood: WARM, label: 'close', temperament: t }, r)));
  assert.notDeepEqual([...beats(SHY)], [...beats(BOLD)]);
});

test('the plan is bounded and survives the trip to the page; anything else is refused; a peek plan still parses', () => {
  let r = 0.37; const random = () => { r = (r * 9301 + 49297) % 233280 / 233280; return r; };
  for (const kind of ['kiss', 'hug', 'shy'] as const) {
    const plan = planCloseMoment({ kind, after: 'grin', via: 'own', mood: WARM, label: 'close', temperament: BOLD }, random);
    assert.deepEqual(parseCloseMomentPlan(JSON.parse(JSON.stringify(plan))), plan, kind);
    assert.deepEqual(parseDirectorPlan(plan), plan);
  }
  const kiss = planCloseMoment({ kind: 'kiss', after: 'shy', via: 'pulled', mood: WARM, label: 'close' }, random);
  // I-192: her own hold, warm and old friends: longer than the base, within the cap; the hug holds longer than the kiss.
  assert.ok(kiss.holdS > ARRIVAL_KNOBS.kissHoldS && kiss.holdS <= ARRIVAL_KNOBS.holdCapS, `the kiss holds as she decides (${kiss.holdS} s)`);
  const hug = planCloseMoment({ kind: 'hug', after: 'shy', via: 'pulled', mood: WARM, label: 'close' }, random);
  assert.ok(hug.holdS > ARRIVAL_KNOBS.hugHoldS && hug.holdS <= ARRIVAL_KNOBS.holdCapS && hug.holdS > kiss.holdS, `the hug (${hug.holdS} s)`);
  const shyer = planCloseMoment({ kind: 'kiss', after: 'shy', via: 'pulled', mood: { ...NEUTRAL_MOOD, N: 80, C: 75 }, label: null }, () => 0.5);
  assert.ok(shyer.holdS < kiss.holdS && shyer.holdS >= ARRIVAL_KNOBS.closeHoldMinS, // I-203: the storyboard's 1.5 s floor
    `tense and new: shorter, never below the least (${shyer.holdS} s)`);
  assert.ok(Math.abs(kiss.yawRad) < Math.abs(hug.yawRad) && Math.abs(hug.yawRad) > 0.2, 'the hug turns her cheek to you more than the kiss turns');
  for (const bad of [{ ...kiss, kind: 'bite' }, { ...kiss, after: 'smirk' }, { ...kiss, leanRad: 2 }, { ...kiss, holdS: NaN }, { ...kiss, action: 'peek-lens' }, null, 'kiss'])
    assert.equal(parseCloseMomentPlan(bad), null, JSON.stringify(bad));
  const peek = planPeek(NEUTRAL_MOOD, () => 0.5);
  assert.deepEqual(parseDirectorPlan(peek), peek);
});

// ---- the curves ------------------------------------------------------------------------------------------------------------------

function play(plan: CloseMomentPlan, fps: number, cancelAt: number | null = null): CloseChannels[] {
  const out: CloseChannels[] = [], dt = 1 / fps;
  let phase: 'lean' | 'hold' | 'back' | 'settle' = 'lean', since = 0, from = { ...REST_CHANNELS }, cancelled = false, shown = { ...REST_CHANNELS }, prev = { ...REST_CHANNELS };
  let velocity: Partial<CloseChannels> | null = null;
  for (let t = 0; t < 30; t += dt) { // I-192: her own hold is longer now (up to the cap)
    let beat = t - since;
    if (cancelAt !== null && !cancelled && t >= cancelAt && (phase === 'lean' || phase === 'hold')) {
      // As the performance does: back from where every channel is, with the speed it had (src/unbound/director/close-moment.ts).
      cancelled = true; from = { ...shown }; phase = 'back'; since = t - dt; beat = dt;
      velocity = Object.fromEntries(CHANNELS.map(key => [key, (shown[key] - prev[key]) / dt]));
    }
    prev = shown;
    if (phase === 'lean') { shown = leanChannels(plan, beat); if (beat >= plan.approachS) { phase = 'hold'; since = t; } }
    else if (phase === 'hold') { shown = leanChannels(plan, plan.approachS); if (beat >= plan.holdS) { from = { ...shown }; phase = 'back'; since = t; } }
    else if (phase === 'back') { shown = backChannels(plan, from, beat, cancelled, velocity); if (beat >= backLength(plan, cancelled)) { from = { ...shown }; phase = 'settle'; since = t; } }
    else shown = settleChannels(from, beat);
    out.push(shown);
  }
  return out;
}
const CHANNELS = Object.keys(REST_CHANNELS) as (keyof CloseChannels)[];
function worst(frames: CloseChannels[]) {
  let step = 0, surprise = 0;
  for (let i = 1; i < frames.length; i++) for (const key of CHANNELS) {
    step = Math.max(step, Math.abs(frames[i][key] - frames[i - 1][key]));
    if (i >= 2) surprise = Math.max(surprise, Math.abs(frames[i][key] - 2 * frames[i - 1][key] + frames[i - 2][key]));
  }
  return { step, surprise };
}

test('curves: from rest and back to rest with no jump at 60 and 30 fps (kiss, hug, shy; every after-beat), and a cancel starts from where it is', () => {
  const report: Record<string, unknown> = {};
  for (const kind of ['kiss', 'hug', 'shy'] as const) for (const after of ['shy', 'grin', 'wink', 'pleased', 'cool'] as const) {
    const plan = planCloseMoment({ kind, after, via: 'own', mood: WARM, label: 'close', temperament: BOLD }, () => 0.5);
    for (const fps of [60, 30]) {
      for (const cancelAt of [null, plan.approachS * 0.5, plan.approachS + plan.holdS * 0.5]) {
        const frames = play(plan, fps, cancelAt), w = worst(frames), k = 60 / fps;
        if (after === 'shy') report[`${kind}-${fps}-${cancelAt === null ? 'full' : 'cancel'}`] = w;
        // A wink is a quick lid (a crisp beat on purpose); everything else eases.
        const stepCap = (after === 'wink' ? 0.35 : 0.08) * k, surpriseCap = (after === 'wink' ? 0.12 : 0.012) * k * k;
        assert.ok(w.step < stepCap, `${kind}/${after}/${fps} fps/${cancelAt}: step ${w.step}`);
        assert.ok(w.surprise < surpriseCap, `${kind}/${after}/${fps} fps/${cancelAt}: surprise ${w.surprise}`);
        for (const key of CHANNELS) assert.ok(Math.abs(frames[0][key]) < 1e-6, `${kind}/${after}: starts at rest (${key})`);
        for (const key of CHANNELS) assert.ok(Math.abs(frames[frames.length - 1][key]) < 1e-6, `${kind}/${after}: back to rest (${key})`);
      }
    }
  }
  console.log('[I-184 curves] worst step / surprise per frame (0..1 channels, rad for lean/tilt)', JSON.stringify(report));
  const kiss = planCloseMoment({ kind: 'kiss', after: 'grin', via: 'own', mood: WARM, label: 'close' }, () => 0.5);
  const atHold = leanChannels(kiss, kiss.approachS);
  assert.ok(atHold.closed === 1 && atHold.pucker === 1 && Math.abs(atHold.lean - kiss.leanRad) < 1e-9, 'kiss: eyes closed, pucker, leaning in');
  const hug = planCloseMoment({ kind: 'hug', after: 'grin', via: 'own', mood: WARM, label: 'close' }, () => 0.5);
  const hugHold = leanChannels(hug, hug.approachS);
  assert.ok(hugHold.arms === 1 && hugHold.wrap === 1 && hugHold.pucker === 0, 'hug: arms out and wrapped, no pucker');
  assert.ok(SETTLE_FADE_S > 0.5);
});

test('the pucker never starts while she speaks or mid-sentence; it starts in a pause and eases back (no jump) if she speaks again', () => {
  for (const fps of [60, 30]) {
    const dt = 1 / fps;
    const speaking = new PuckerGate();
    for (let i = 0; i < fps * 3; i++) assert.equal(speaking.frame(dt, 1, false, true), 0, 'speaking: never');
    const midSentence = new PuckerGate();
    for (let i = 0; i < fps * 3; i++) assert.equal(midSentence.frame(dt, 1, false, false), 0, 'mid-sentence (may not start): never');
    const gate = new PuckerGate(), values: number[] = [];
    for (let i = 0; i < fps * 2; i++) values.push(gate.frame(dt, 1, true, false));
    assert.ok(values[values.length - 1] > 0.99, 'in a pause it comes in fully');
    for (let i = 0; i < fps; i++) values.push(gate.frame(dt, 1, false, true));
    assert.ok(values[values.length - 1] < 1e-9, 'she speaks: it goes back');
    let step = 0; for (let i = 1; i < values.length; i++) step = Math.max(step, Math.abs(values[i] - values[i - 1]));
    assert.ok(step < 0.2 * 60 / fps, `no jump (${step})`);
    // Started in a pause, it keeps rising while she stays quiet even if the sentence gate closes (it never stops halfway).
    const kept = new PuckerGate(); kept.frame(dt, 1, true, false);
    for (let i = 0; i < fps; i++) kept.frame(dt, 1, false, false);
    assert.ok(kept.frame(dt, 1, false, false) > 0.99);
  }
});

test('mood and memory: kiss and hug are their own mood moments (O up, only small), with journal sources; her turn line is facts only', () => {
  assert.ok(MOOD_MOMENT_KINDS.includes('kiss') && MOOD_MOMENT_KINDS.includes('hug'));
  for (const kind of ['kiss', 'hug'] as const) {
    const spec = MOOD_MOMENTS[kind];
    assert.ok((spec.delta.O ?? 0) > 0 && Object.values(spec.delta).every(v => Math.abs(v!) <= 3), kind);
    assert.equal(spec.keepReason, false, 'the reason: her next turn sees it in her state');
    assert.ok(MOOD_EVENT_SOURCES.includes(`moment-${kind}` as never));
  }
  assert.equal(moodEventSource('lift', '她凑过来亲了你一下'), 'moment-kiss');
  assert.equal(moodEventSource('lift', '她凑过来抱了抱你'), 'moment-hug');
  const lines = [
    closeMomentLine([{ kind: 'kiss', via: 'own', after: 'shy', at: 1 }]), closeMomentLine([{ kind: 'hug', via: 'pulled', after: 'cool', at: 1 }]),
    closeMomentLine([{ kind: 'kiss', via: 'pulled', after: null, at: 1 }]),
  ];
  assert.equal(lines[0], '你刚才自己凑过去亲了用户一下，然后红着脸别开了眼睛。');
  assert.equal(lines[1], '用户刚才把你拉到跟前，你隔着屏幕抱了抱用户，然后装作什么都没发生。');
  for (const line of lines) {
    assert.ok(!/[0-9０-９]/.test(line), line);
    for (const word of INSTRUCTION_WORDS) assert.ok(!line.includes(word), `${line}: ${word}`);
  }
  assert.equal(closeMomentLine([]), '');
});
