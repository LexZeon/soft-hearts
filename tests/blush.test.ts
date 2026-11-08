/**
 * #26 脸红 (shared/behaviors/blush/): the safety line (never more often than the card, the card's switch and size, legal shapes),
 * every draw keeps it, 20 times the same scene, her mood and card lean it (the shy blush more easily), the why names only what
 * is true, one knob changes only what it governs, the real mood model draws what was picked, and the contract both
 * implementations keep. BLUSH_REPORT=1 prints the 20 draws.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMoodEvent, createMoodState, DEFAULT_MOOD_PARAMETERS, getMoodSnapshot, type MoodBlushParameters, type MoodLabel, type MoodTendency } from '../shared/mood';
import { MOOD_LABELS } from '../shared/mood-runtime';
import { blushEase, blushNow, blushProfileSafe, BlushDirector, drawBlush } from '../shared/behaviors/blush/choose';
import { FixedBlush } from '../shared/behaviors/blush/fake';
import { BLUSH_KNOBS, type BlushKnobs, type BlushLookId } from '../shared/behaviors/blush/knobs';
import type { BlushChance, BlushHost, BlushNow } from '../shared/behaviors/blush/interface';
import { seeded } from './helpers/seeded';

const report = !!process.env.BLUSH_REPORT;
const card = DEFAULT_MOOD_PARAMETERS.blush;
const MOODS = Object.keys(MOOD_LABELS) as MoodLabel[];
const TENDENCIES: MoodTendency[] = ['playful', 'close', 'comfortable', 'cautious'];
const plain = { playful: 1, close: 1, comfortable: 1, cautious: 1 };
const calm: BlushNow = { mood: 'calm', tendency: null, personality: plain, trigger: 'touch', moments: [] };
const who = (cautious: number, mood: MoodLabel = 'calm', trigger: BlushNow['trigger'] = 'touch'): BlushNow => ({ ...calm, mood, trigger, personality: { ...plain, cautious } });
const counting = (random: () => number) => { const wrapped = () => { wrapped.calls++; return random(); }; wrapped.calls = 0; return wrapped; };
const chance = (at: number, patch: Partial<BlushChance> = {}): BlushChance => ({ contact: 'pat', cue: null, lastBlushAt: null, at, threshold: 6, ...patch });
const total = (p: Pick<MoodBlushParameters, 'riseMs' | 'holdMs' | 'fadeMs'>) => p.riseMs + p.holdMs + p.fadeMs;
function randomCard(random: () => number): MoodBlushParameters {
  return { enabled: true, intensity: Math.round(1 + random() * 99), size: Math.round(random() * 100), riseMs: Math.round(100 + random() * 4_900),
    holdMs: Math.round(random() * 20_000), fadeMs: Math.round(100 + random() * 9_900), cooldownMs: Math.round(random() * 3_600_000) };
}

test('the safety line catches a shorter cooldown, a changed switch or size, and shapes outside the legal ranges', () => {
  assert.ok(blushProfileSafe(card, card));
  assert.ok(blushProfileSafe(card, { ...card, intensity: 40, riseMs: 600, holdMs: 2_200, fadeMs: 2_500, cooldownMs: 80_000 }));
  for (const bad of [{ cooldownMs: 59_999 }, { enabled: false }, { size: 60 }, { intensity: 17 }, { intensity: 53 }, { riseMs: 99 }, { holdMs: 20_001 },
    { fadeMs: 10_001 }, { intensity: Number.NaN }, { cooldownMs: Infinity }] as Partial<MoodBlushParameters>[])
    assert.equal(blushProfileSafe(card, { ...card, ...bad }), false, JSON.stringify(bad));
  assert.equal(blushProfileSafe(card, null), false);
  assert.ok(blushProfileSafe({ ...card, intensity: 0 }, { ...card, intensity: 0 }));
  assert.equal(blushProfileSafe({ ...card, intensity: 0 }, { ...card, intensity: 5 }), false, 'a card with no blush gets none');
});

test('every draw is safe for any card, mood and card personality: never more often than the card; six random numbers when she may blush, none when not', () => {
  const random = seeded(26);
  for (let i = 0; i < 3_000; i++) {
    const c = randomCard(random);
    const personality = Object.fromEntries(TENDENCIES.map(t => [t, Math.round(random() * 40) / 10])) as Record<MoodTendency, number>;
    const now: BlushNow = { mood: MOODS[i % MOODS.length], tendency: random() < 0.3 ? 'cautious' : null, personality, trigger: random() < 0.5 ? 'words' : 'touch',
      moments: random() < 0.2 ? ['sleepy'] : [] };
    const draws = counting(seeded(i));
    const director = new BlushDirector({ random: draws });
    const prepared = director.prepare('gene', c, chance(10_000, { contact: now.trigger === 'words' ? 'words' : 'pat' }), () => now);
    assert.equal(draws.calls, 6);
    assert.notEqual(prepared.draw, null);
    assert.ok(blushProfileSafe(c, prepared.profile), `${JSON.stringify(c)} → ${JSON.stringify(prepared.profile)}`);
    const ease = blushEase(BLUSH_KNOBS, personality).scale;
    assert.ok(prepared.thresholdScale === (now.trigger === 'words' ? 1 : ease) && ease >= 0.7 && ease <= 1.3);
    director.settle('gene', prepared, { cue: { id: 'b1', at: 10_000, until: 10_000 + total(prepared.profile), strength: 1, reason: 'closeness' }, rise: 3, total: 6 });
    const showing = director.profile('gene', c, { id: 'b1' });
    assert.ok(blushProfileSafe(c, showing));
    assert.deepEqual([showing.intensity, showing.riseMs, showing.holdMs, showing.fadeMs], [prepared.profile.intensity, prepared.profile.riseMs, prepared.profile.holdMs, prepared.profile.fadeMs]);
    const after = director.profile('gene', c, null);
    assert.ok(blushProfileSafe(c, after) && after.cooldownMs >= c.cooldownMs);
    assert.deepEqual([after.intensity, after.riseMs, after.holdMs, after.fadeMs], [c.intensity, c.riseMs, c.holdMs, c.fadeMs], 'not showing: the card\'s shape');
    // Cooling down (by the cooldown after this blush, never the card's shorter one): nothing to pick, no random number.
    const calls = draws.calls;
    const cooling = director.prepare('gene', c, chance(10_000 + Math.max(0, after.cooldownMs - 1), { lastBlushAt: 10_000 }), () => now);
    if (after.cooldownMs > 0) { assert.equal(cooling.draw, null); assert.equal(draws.calls, calls); }
    assert.equal(director.prepare('gene', c, chance(10_001, { cue: { id: 'b1', at: 10_000, until: 20_000, strength: 1, reason: 'closeness' } }), () => now).draw, null, 'showing one');
  }
});

test('20 times the same scene (a pat that makes her blush): before the same shape every time; now the depth and lengths vary, the cooldown never shorter', () => {
  const before = new FixedBlush(), after = new BlushDirector({ random: seeded(20) });
  const rows: { look: string; depth: number; total: number; cooldown: number }[] = [], old: string[] = [];
  let at = 0;
  for (let i = 0; i < 20; i++) {
    at += 5 * 60_000;
    for (const host of [before, after] as BlushHost[]) {
      const prepared = host.prepare('gene', card, chance(at), () => calm);
      host.settle('gene', prepared, { cue: { id: `b${i}`, at, until: at + total(prepared.profile), strength: 1, reason: 'closeness' }, rise: 1, total: 6 });
      if (host === before) old.push(JSON.stringify(prepared.profile));
      else rows.push({ look: after.recent('gene')[0].look, depth: Math.round(prepared.profile.intensity / card.intensity * 100) / 100, total: total(prepared.profile),
        cooldown: after.profile('gene', card, null).cooldownMs });
    }
  }
  if (report) for (const row of rows) console.log(`${row.look} 深浅×${row.depth} 一共 ${row.total} ms 冷却 ${row.cooldown} ms`);
  assert.equal(new Set(old).size, 1);
  assert.equal(JSON.parse(old[0]).riseMs + JSON.parse(old[0]).holdMs + JSON.parse(old[0]).fadeMs, 3_450);
  assert.ok(new Set(rows.map(r => r.total)).size >= 15, rows.map(r => r.total).join(' '));
  assert.ok(new Set(rows.map(r => r.depth)).size >= 8);
  assert.ok(new Set(rows.map(r => r.look)).size >= 2);
  assert.ok(rows.every(r => r.depth >= 0.7 && r.depth <= 1.15 && r.total >= 2_000 && r.total <= 6_000 && r.cooldown >= card.cooldownMs && r.cooldown <= card.cooldownMs * 1.4 + 1));
});

test('the shy blush more easily and deeper, the bold more faintly and less often; her mood leans it; the why names only what is true', () => {
  const stats = (now: BlushNow) => {
    const random = seeded(8);
    const looks: Record<BlushLookId, number> = { deep: 0, usual: 0, faint: 0 };
    let cooldown = 0;
    for (let i = 0; i < 400; i++) { const draw = drawBlush(card, now, [], random); looks[draw.look]++; cooldown += draw.cooldownMs; }
    return { looks, cooldown: cooldown / 400 };
  };
  const shy = stats(who(1.6)), usual = stats(calm), bold = stats(who(0.4)), upset = stats(who(1, 'upset'));
  assert.ok(shy.looks.deep > 1.5 * usual.looks.deep && usual.looks.deep > bold.looks.deep, JSON.stringify([shy.looks, usual.looks, bold.looks]));
  assert.ok(bold.looks.faint > 1.5 * usual.looks.faint && usual.looks.faint > shy.looks.faint);
  assert.ok(upset.looks.faint > 1.5 * usual.looks.faint);
  assert.ok(shy.cooldown <= usual.cooldown && usual.cooldown < bold.cooldown, `${shy.cooldown} ${usual.cooldown} ${bold.cooldown}`);
  assert.equal(shy.cooldown, card.cooldownMs, 'shy: the card\'s cooldown, never shorter');
  assert.ok(blushEase(BLUSH_KNOBS, who(1.6).personality).scale < 1 && blushEase(BLUSH_KNOBS, who(0.4).personality).scale > 1 && blushEase(BLUSH_KNOBS, plain).scale === 1);
  const random = seeded(5);
  for (let i = 0; i < 300; i++) {
    const draw = drawBlush(card, calm, [], random);
    for (const word of ['性格', '困了', '不满', '想念', '是你说的话']) assert.ok(!draw.why.join('；').includes(word), `a plain calm card never says "${word}": ${draw.why}`);
    assert.deepEqual(draw.cooldownWhy, []);
  }
  const director = new BlushDirector({ random: seeded(3) });
  const prepared = director.prepare('gene', card, chance(1_000), () => who(1.6, 'close'));
  director.settle('gene', prepared, { cue: { id: 'x', at: 1_000, until: 1_000 + total(prepared.profile), strength: 1, reason: 'closeness' }, rise: 1.1, total: 4.6 });
  const why = director.recent('gene')[0].why.join('；');
  assert.match(why, /被摸头，亲近一下子涨了 4\.6/);
  assert.match(why, /性格：谨慎（容易害羞）：涨够 4\.2 就红了（卡上要涨够 6）/);
  const bolder = new BlushDirector({ random: seeded(3) });
  const b = bolder.prepare('gene', card, chance(1_000), () => who(0.4));
  bolder.settle('gene', b, { cue: { id: 'y', at: 1_000, until: 1_000 + total(b.profile), strength: 1, reason: 'closeness' }, rise: 1, total: 8 });
  assert.match(bolder.recent('gene')[0].why.join('；'), /性格：大胆（不太害羞），红过以后隔得久一点/);
  assert.ok(!bolder.recent('gene')[0].why.join('；').includes('涨够'), 'the harder threshold did not make her blush: not a reason');
  const words = new BlushDirector({ random: seeded(3) });
  const w = words.prepare('gene', card, chance(1_000, { contact: 'words' }), () => who(1, 'happy', 'words'));
  assert.equal(w.thresholdScale, 1, 'warm words: the mood model\'s own threshold');
  words.settle('gene', w, { cue: { id: 'z', at: 1_000, until: 1_000 + total(w.profile), strength: 0.6, reason: 'semantic' }, rise: 2.3, total: 2.3 });
  assert.match(words.recent('gene')[0].why.join('；'), /你说了暖心的话，亲近涨了 2\.3/);
});

test('one knob changes only what it governs', () => {
  const run = (knobs: BlushKnobs) => {
    const director = new BlushDirector({ random: seeded(13), knobs });
    const out: { look: string; profile: MoodBlushParameters; cooldown: number; scale: number }[] = [];
    let at = 0;
    for (let i = 0; i < 60; i++) {
      at += 10 * 60_000;
      const prepared = director.prepare('gene', card, chance(at), () => who(i % 3 ? 1.3 : 0.6, MOODS[i % MOODS.length]));
      director.settle('gene', prepared, { cue: { id: `c${i}`, at, until: at + total(prepared.profile), strength: 1, reason: 'closeness' }, rise: 1, total: 6 });
      out.push({ look: director.recent('gene')[0].look, profile: prepared.profile, cooldown: director.profile('gene', card, null).cooldownMs, scale: prepared.thresholdScale });
    }
    return out;
  };
  const base = run(BLUSH_KNOBS);
  const longer = run({ ...BLUSH_KNOBS, cooldown: { ...BLUSH_KNOBS.cooldown, range: [1.5, 2] } });
  base.forEach((row, i) => {
    // The shape is the same; only the cooldown carried in it (the one after the last blush) may differ.
    assert.equal(longer[i].look, row.look); assert.deepEqual({ ...longer[i].profile, cooldownMs: 0 }, { ...row.profile, cooldownMs: 0 }); assert.equal(longer[i].scale, row.scale);
    assert.ok(longer[i].cooldown >= row.cooldown);
  });
  assert.ok(longer.some((row, i) => row.cooldown > base[i].cooldown));
  const faintHold = run({ ...BLUSH_KNOBS, looks: { ...BLUSH_KNOBS.looks, faint: { ...BLUSH_KNOBS.looks.faint, hold: [0, 0.1] } } });
  let faintSeen = 0;
  base.forEach((row, i) => {
    const other = faintHold[i];
    assert.equal(other.look, row.look); assert.equal(other.cooldown, row.cooldown); assert.equal(other.scale, row.scale);
    assert.equal(other.profile.intensity, row.profile.intensity); assert.equal(other.profile.riseMs, row.profile.riseMs); assert.equal(other.profile.fadeMs, row.profile.fadeMs);
    if (row.look === BLUSH_KNOBS.looks.faint.label) { faintSeen++; assert.ok(other.profile.holdMs <= 120 && other.profile.holdMs < row.profile.holdMs); }
    else assert.equal(other.profile.holdMs, row.profile.holdMs);
  });
  assert.ok(faintSeen > 0);
  const easier = run({ ...BLUSH_KNOBS, ease: { ...BLUSH_KNOBS.ease, personality: { cautious: -0.5 } } });
  base.forEach((row, i) => {
    assert.equal(easier[i].look, row.look); assert.deepEqual(easier[i].profile, row.profile); assert.equal(easier[i].cooldown, row.cooldown);
  });
  assert.ok(easier.some((row, i) => row.scale !== base[i].scale));
});

test('in the real mood model the blush she picked is the one drawn: its length, its envelope in the snapshot, and the threshold for a pat', () => {
  const director = new BlushDirector({ random: seeded(31) });
  const p = structuredClone(DEFAULT_MOOD_PARAMETERS);
  let state = createMoodState(0, p);
  // A slow pat: O rises about 0.7 per half second, so by itself the card's threshold (6) is reached on the ninth report.
  const shy = who(1.6);
  let t = 0, prepared = null as ReturnType<BlushDirector['prepare']> | null, raised = -1;
  for (let i = 0; i < 12 && raised < 0; i++) {
    t += 500;
    prepared = director.prepare('gene', p.blush, chance(t, { lastBlushAt: state.lastBlushAt, cue: state.blushCue }), () => shy);
    const rules = { ...p, blush: prepared.profile, fastThreshold: p.fastThreshold * prepared.thresholdScale, sensitivity: { ...p.sensitivity, O: 0.4 } };
    state = applyMoodEvent(state, { type: 'rua', id: `r${i}`, effectiveMs: 500 }, t, rules);
    const total = state.trend.reduce((sum, sample) => sum + sample.delta.O, 0);
    director.settle('gene', prepared, { cue: state.blushCue?.id === `r${i}` ? state.blushCue : null, rise: state.trend.at(-1)!.delta.O, total });
    if (state.blushCue) raised = i;
  }
  assert.ok(raised >= 0, 'she blushed');
  const sum = state.trend.reduce((s, sample) => s + sample.delta.O, 0);
  assert.ok(sum < p.fastThreshold, `before the card's own threshold (${sum} < 6): the shy card's lower one`);
  const cue = state.blushCue!;
  assert.equal(cue.until - cue.at, total(prepared!.profile));
  const shown = getMoodSnapshot(state, cue.at + 700, { ...p, blush: director.profile('gene', p.blush, cue) });
  assert.deepEqual(shown.blush!.profile, director.profile('gene', p.blush, cue));
  assert.match(director.recent('gene')[0].why.join('；'), /涨够 4\.2 就红了/);
});

for (const [name, make] of [['real', () => new BlushDirector({ random: seeded(4) })], ['fake', () => new FixedBlush()]] as const) {
  test(`contract (${name}): only when she may blush, the shape stays for that blush, the card's shape otherwise, never more often, memory-only why`, () => {
    const host: BlushHost = make();
    let reads = 0;
    const now = () => { reads++; return who(1.2, 'happy'); };
    const off = { ...card, enabled: false };
    assert.equal(host.prepare('gene', off, chance(0), now).draw, null);
    assert.equal(host.profile('gene', off, null), off, 'switched off: the card as it is');
    const prepared = host.prepare('gene', card, chance(100), now);
    assert.notEqual(prepared.draw, null);
    assert.ok(blushProfileSafe(card, prepared.profile));
    const cue = { id: 'one', at: 100, until: 100 + total(prepared.profile), strength: 1, reason: 'closeness' as const };
    host.settle('gene', prepared, { cue, rise: 2, total: 6 });
    const showing = host.profile('gene', card, cue);
    for (let i = 0; i < 5; i++) assert.deepEqual(host.profile('gene', card, cue), showing, 'the same shape all the way through');
    assert.deepEqual([showing.intensity, showing.riseMs, showing.holdMs, showing.fadeMs], [prepared.profile.intensity, prepared.profile.riseMs, prepared.profile.holdMs, prepared.profile.fadeMs]);
    const gone = host.profile('gene', card, null);
    assert.deepEqual([gone.intensity, gone.riseMs, gone.holdMs, gone.fadeMs], [card.intensity, card.riseMs, card.holdMs, card.fadeMs]);
    assert.ok(gone.cooldownMs >= card.cooldownMs);
    assert.equal(host.prepare('gene', card, chance(100 + card.cooldownMs - 1, { lastBlushAt: 100 }), now).draw, null, 'cooling down');
    assert.equal(host.prepare('gene', card, chance(200, { cue }), now).draw, null, 'showing');
    // A chance that did not end in a blush leaves nothing behind.
    const before = host.recent('gene').length;
    const missed = host.prepare('gene', card, chance(100 + 10 * card.cooldownMs, { lastBlushAt: 100 }), now);
    host.settle('gene', missed, { cue: null, rise: 0.2, total: 1 });
    assert.equal(host.recent('gene').length, before);
    assert.ok(reads <= 2);
    const random = seeded(6);
    for (let i = 0; i < 100; i++) {
      const c = randomCard(random);
      const p = host.prepare('gene', c, chance(1e9 + i * 1e8), now);
      assert.ok(blushProfileSafe(c, p.profile) && blushProfileSafe(c, host.profile('gene', c, null)));
      host.settle('gene', p, { cue: null, rise: 0, total: 0 });
    }
    const rows = host.recent('gene');
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows, 'plain data');
    (rows[0].why as string[]).push('changed');
    assert.ok(!host.recent('gene')[0].why.includes('changed'), 'a copy');
    assert.ok(rows[0].cooldownMs >= card.cooldownMs);
    assert.deepEqual(host.recent('someone-else'), []);
    assert.deepEqual(card, DEFAULT_MOOD_PARAMETERS.blush, 'the card is untouched');
  });
}

test('"此刻" comes from the snapshot, the card, her tiredness and what made her blush', () => {
  assert.deepEqual(blushNow({ snapshot: { primary: 'close', companion: 'cautious' }, personality: { cautious: 7 }, fatiguePhase: 'asleep', trigger: 'words' }),
    { mood: 'close', tendency: 'cautious', personality: { playful: 1, close: 1, comfortable: 1, cautious: 4 }, trigger: 'words', moments: ['sleepy'] });
  assert.equal(blushNow({ snapshot: { primary: 'x' as MoodLabel, companion: null }, personality: null, fatiguePhase: 'light-drowsy', trigger: 'touch' }).mood, 'calm');
  assert.equal(blushNow({ snapshot: { primary: 'calm', companion: 'cautious', tendencies: { playful: 0, close: 0, comfortable: 0, cautious: 0.01 } }, personality: null, fatiguePhase: null, trigger: 'touch' }).tendency, null,
    'a hair of a tendency is not "这会儿有点拘谨"');
  for (const look of Object.values(BLUSH_KNOBS.looks)) for (const range of [look.depth, look.rise, look.hold, look.fade]) assert.ok(range[0] <= range[1]);
  assert.ok(BLUSH_KNOBS.cooldown.range[0] >= 1, 'the cooldown range never starts below the card');
});
