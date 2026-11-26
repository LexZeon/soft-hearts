// I-193 walk by screen (the plan's three decisions "按推荐"):
//  - her turn line says how big she is, a near-far table for THIS screen and HER height, and how her last go-markers went (information only);
//  - ⟦go 30% 1.2m⟧: numbers only in `go`'s suffix, never shown or read aloud (chunks split anywhere), converted through screen-terms only;
//  - come-near: first to the default place's size, then one step nearer at a time up to "only the face", then she stays and is told so;
//  - the grey line names a go word only when the walk happened; the go-beat journal row keeps the target (numbers only).
// docs/claude/2026-11-24-i193-walk-by-screen.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GO_OUTCOME_RULES, GoOutcomes, HER_POSITION_KNOBS, GO_ACROSS, SEEN_WORDS, farthestWalkSize, goDecide, goOutcomeLine, goStayedRow, goWentRow, herPositionLine, herSeen, nearTable, nearestWalkSize,
  parseGoBeatAsk, type LifeJournalRow } from '../shared/unbound/her-position';
import { depthForSize, lookOfPlacement, placementOfLook, sizeAtDepth, sizeForToldM, toldDistanceM, type ScreenFrame } from '../shared/unbound/screen-terms';
import { SpeechBeatFilter, describeBeats, filterSpeechBeats, speechBeatSentence } from '../shared/behaviors/speech-beats/choose';
import { SPEECH_BEAT_FRAME_WORDS, SPEECH_BEAT_GO_WORDS, SPEECH_BEAT_WORDS, type SpeechBeat } from '../shared/behaviors/speech-beats/interface';
import { withSpeechBeatMarkers } from '../shared/behaviors/speech-beats/history';
import { SpeechBeatSchedule } from '../shared/behaviors/speech-beats/schedule';
import { SpeechBeatTurn } from '../electron/brain/speech-beats/turn';
import { INSTRUCTION_WORDS } from '../shared/unbound/life/history';
import { LifeHost, type LifeLink, type LifePorts, type LifeReadings } from '../electron/unbound/life';
import { HerPlace } from '../electron/unbound/her-place';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { NEUTRAL_MOOD } from '../shared/unbound/director';
import type { LifeCommand } from '../shared/unbound/life/types';
import type { UnboundWorld } from '../shared/unbound/scene';
import { UnboundSpeechBeats } from '../src/unbound/speech-beat-player';
import { REST_TARGETS } from '../src/unbound/motion/generator';
import type { UnboundBubble } from '../shared/unbound/scene';
import { laptopLens } from './helpers/unbound-peek';

const K = HER_POSITION_KNOBS;
/** The I-212 fake screens (physical size, DIP, a taskbar of 48 DIP). */
const SCREENS: Record<string, ScreenFrame> = {
  '13.3"': screen(0.294, 0.165, 1536, 864),
  '15.6"': screen(0.345, 0.194, 1920, 1080),
  '27"': screen(0.598, 0.336, 2560, 1440),
  '32"': screen(0.708, 0.398, 2048, 1152),
};
function screen(widthM: number, heightM: number, w: number, h: number): ScreenFrame {
  return { screen: { widthM, heightM, source: 'measured', detail: 'test' }, display: { x: 0, y: 0, width: w, height: h }, workArea: { x: 0, y: 0, width: w, height: h - 48 }, viewerDistanceM: 0.55 };
}
const HEIGHTS = [1.35, 1.6, 1.85];
const worldOf = (frame: ScreenFrame): UnboundWorld => ({ ...frame, window: frame.workArea, mapping: 'physical', eyeHeightM: 1, placement: { xM: 0, depthM: 8 } });
const close = (a: number, b: number, tolerance: number, label: string) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} vs ${b}`);
const GUARD = /走|去|移|过来|窗口|\b(should|must|please|go|move|walk|try)\b/iu;

/** Her life host on a real HerPlace (the host's own conversion) for this screen and height; `at`: where she stands (a look). */
function stage(frame: ScreenFrame, heightM: number, at: { across: number; size: number }, defaultLook: { across: number; size: number } | null = null) {
  const keeper = { defaultLook, adopt: () => {}, walked: () => {} };
  const her = new HerPlace(keeper as never, () => worldOf(frame));
  her.heightM = heightM; her.placement = placementOfLook(frame, heightM, at)!;
  const state = { now: 1_000_000, sent: [] as LifeCommand[], rows: [] as LifeJournalRow[], typing: false };
  const ports: LifePorts = {
    clock: () => state.now, random: () => 0.5, readings: () => ({ idleSeconds: 120, state: 'pause', pose: null, activity: null, talkedAt: null, sound: null } as Partial<LifeReadings>),
    asleep: () => false, inCall: () => false, waiting: () => false, typing: () => state.typing, readingAloud: () => false, playing: () => false,
    mood: () => ({ ...NEUTRAL_MOOD }), lastInteractionAt: () => null, answered: () => true, every: () => () => {}, journal: row => state.rows.push(row),
  };
  const link: LifeLink = {
    shown: () => true, fullscreen: () => true, out: () => true, send: command => state.sent.push(command), ...her.lifeLink(),
    arrived: to => { her.arrived(frame, to); }, peekActive: () => false, interruptPeek: () => {}, changed: () => {}, taskbar: () => true,
  };
  const host = new LifeHost(ports, link);
  const starts = () => state.sent.filter((c): c is Extract<LifeCommand, { type: 'start' }> => c.type === 'start');
  /** Ask, and when she walks let the page report the walk done (she stands at its end now). */
  const ask = (value: Record<string, unknown>) => {
    const answer = host.goAsk(value), start = starts().at(-1);
    if (answer === 'go' && start?.plan.walk) { host.report({ id: start.id, phase: 'done', at: { xM: start.plan.walk.xM, depthM: start.plan.walk.depthM } }); state.now += 2_000; }
    return answer;
  };
  return { her, host, state, starts, ask };
}

// ---- the numbers: ⟦go 30% 1.2m⟧ --------------------------------------------------------------------------------------------------------

test('go numbers land on the right screen size: the same told metres and share across on every screen and for every model; the world metres differ', () => {
  for (const heightM of HEIGHTS) {
    const worldDepths = new Set<string>();
    for (const [name, frame] of Object.entries(SCREENS)) {
      const s = stage(frame, heightM, { across: 0.78, size: 0.5 });
      assert.equal(s.ask({ goBeat: 'go', percent: 30, metres: 1.2 }), 'go', name);
      const look = s.her.here()!;
      close(look.across, 0.3, 1e-9, `${name} ${heightM} m: across`);
      close(look.size, sizeForToldM(heightM, 1.2)!, 1e-9, `${name} ${heightM} m: size`);
      assert.equal(toldDistanceM(heightM, look.size), 1.2, `${name}: the next turn tells the same 1.2 m`);
      assert.ok(s.her.facts()!.facts.distanceM === 1.2);
      worldDepths.add(s.her.placement!.depthM.toFixed(2));
      // Only one part given: the other stays as it is.
      const only = stage(frame, heightM, { across: 0.78, size: 0.5 });
      assert.equal(only.ask({ goBeat: 'go', metres: 2.5 }), 'go');
      close(only.her.here()!.across, 0.78, 1e-9, 'across kept'); assert.equal(toldDistanceM(heightM, only.her.here()!.size), 2.5);
      const side = stage(frame, heightM, { across: 0.78, size: 0.5 });
      assert.equal(side.ask({ goBeat: 'go', percent: 20 }), 'go');
      close(side.her.here()!.size, 0.5, 1e-9, 'size kept'); close(side.her.here()!.across, 0.2, 1e-9, 'across');
    }
    assert.ok(worldDepths.size > 1, 'behind the glass she stands at different metres on different screens (screen terms, not world metres)');
  }
});

test('out of range walks to the edge: across to GO_ACROSS, near to "only the face" (or the glass), far to go-far\'s farthest; the next line tells where she is', () => {
  for (const [name, frame] of Object.entries(SCREENS)) for (const heightM of HEIGHTS) {
    const limit = nearestWalkSize(frame, heightM)!;
    const near = stage(frame, heightM, { across: 0.5, size: 0.5 });
    assert.equal(near.ask({ goBeat: 'go', percent: 150, metres: 0.05 }), 'go', name);
    close(near.her.here()!.across, GO_ACROSS[1], 1e-9, 'the right edge'); close(near.her.here()!.size, limit, 1e-6, `${name}: the nearest`);
    assert.notEqual(herSeen(frame, { heightM }, near.her.placement!.depthM)!.seen, 'face-close', 'never nearer than "only the face" on her own');
    const facts = near.her.facts()!;
    assert.equal(facts.facts.distanceM, facts.facts.table!.nearest.distanceM, 'the next turn: she stands at the nearest the table names');
    const far = stage(frame, heightM, { across: 0.5, size: 0.5 });
    assert.equal(far.ask({ goBeat: 'go', percent: 0, metres: 40 }), 'go');
    close(far.her.here()!.across, GO_ACROSS[0], 1e-9, 'the left edge'); close(far.her.here()!.size, farthestWalkSize(), 1e-6, 'the farthest');
    // Already at the edge: she stays, and the reason is closed.
    assert.equal(far.ask({ goBeat: 'go', percent: 0, metres: 40 }), 'stay');
    assert.deepEqual(far.state.rows.at(-1), { type: 'go-beat', word: 'go', outcome: 'stayed', why: 'already-there', metres: null, target: { percent: 0, metres: 40 } });
  }
});

test('the go question is closed: numbers only on go, at least one, in range; nothing else', () => {
  assert.deepEqual(parseGoBeatAsk({ goBeat: 'go', percent: 30, metres: 1.2 }), { goBeat: 'go', percent: 30, metres: 1.2 });
  assert.deepEqual(parseGoBeatAsk({ goBeat: 'go', metres: 1.25 }), { goBeat: 'go', metres: 1.3 });
  for (const bad of [{ goBeat: 'go' }, { goBeat: 'go', percent: 30.5 }, { goBeat: 'go', percent: -1 }, { goBeat: 'go', percent: 1000 }, { goBeat: 'go', metres: Number.NaN },
    { goBeat: 'go', metres: '1.2' }, { goBeat: 'go', metres: 1.2, cursorAcross: 0.5 }, { goBeat: 'go-left', percent: 30 }, { goBeat: 'come-near', metres: 1 }, { goBeat: 'go', metres: 1, path: 'x' }]) {
    assert.equal(parseGoBeatAsk(bad), null, JSON.stringify(bad));
  }
});

// ---- come-near: the place, then a step at a time, up to "only the face" ----------------------------------------------------------------

test('come-near: the first to the default place\'s size; a second steps nearer (the step with the mood\'s power); it stops at "only the face", stays and is told so', () => {
  const frame = SCREENS['15.6"'], heightM = 1.6, place = { across: 0.78, size: 0.6 };
  const limit = nearestWalkSize(frame, heightM)!;
  const s = stage(frame, heightM, { across: 0.5, size: 0.4 }, place);
  assert.equal(s.ask({ goBeat: 'come-near' }), 'go');
  close(s.her.here()!.size, 0.6, 1e-9, 'the first: to the place\'s size, as today');
  const sizes = [s.her.here()!.size];
  for (let i = 0; i < 30 && s.ask({ goBeat: 'come-near' }) === 'go'; i++) sizes.push(s.her.here()!.size);
  assert.ok(sizes.length >= 3, `several steps nearer: ${sizes.map(v => v.toFixed(2)).join(' → ')}`);
  for (let i = 1; i < sizes.length; i++) {
    const step = sizes[i]! / sizes[i - 1]!;
    assert.ok(step > 1 && (step <= K.nearStepMax ** 1.4 + 1e-9 || Math.abs(sizes[i]! - limit) < 1e-6), `a step nearer, not a jump: ×${step.toFixed(3)}`);
  }
  close(sizes.at(-1)!, limit, 1e-6, 'up to the nearest');
  assert.deepEqual(s.state.rows.at(-1), { type: 'go-beat', word: 'come-near', outcome: 'stayed', why: 'already-there', metres: null });
  const line = herPositionLine(s.her.here(), { ...s.her.facts()!.facts, lastGo: s.host.takeGoOutcomes() });
  assert.ok(line.includes('靠近——没有动，你已经站在能站到的最近处了'), line);
  // Pure: the mood leans the step (warm further in), and nothing past the limit; no limit known: she stops at the place (as before).
  const here = { across: 0.5, size: 0.6 };
  const warm = goDecide({ word: 'come-near', here, random: () => 0.5, nearSize: 0.6, nearestLimit: 5, drives: { tense: 0, warm: 1, energy: 0.5, sleepy: 0 } });
  const tense = goDecide({ word: 'come-near', here, random: () => 0.5, nearSize: 0.6, nearestLimit: 5, drives: { tense: 1, warm: 0, energy: 0.5, sleepy: 0 } });
  assert.ok('spot' in warm && 'spot' in tense && warm.spot.size > tense.spot.size);
  assert.deepEqual(goDecide({ word: 'come-near', here, random: () => 0.5, nearSize: 0.6 }), { why: 'already-there' });
  assert.deepEqual(goDecide({ word: 'come-near', here: { across: 0.5, size: 2 }, random: () => 0.5, nearSize: 0.6, nearestLimit: 1.5 }), { why: 'already-there' }, 'nearer than the limit: never walks back out');
});

// ---- the turn line --------------------------------------------------------------------------------------------------------------------

test('a stayed walk is told next turn (once, while fresh), with its reason; a went walk is told as went', () => {
  const notes = new GoOutcomes();
  notes.note(goStayedRow('come-near', 'already-there'), 0);
  notes.note({ type: 'place-moved', by: 'own', side: 'left', range: 'far', metres: 2 }, 0);
  notes.note(goWentRow('go-left', 1.4), 1);
  const told = notes.take(10);
  assert.deepEqual(told, [{ word: 'come-near', outcome: 'stayed', why: 'already-there' }, { word: 'go-left', outcome: 'went', why: null }]);
  assert.deepEqual(notes.take(20), [], 'told once');
  const zh = goOutcomeLine(told, false), en = goOutcomeLine(told, true);
  assert.equal(zh, '上一轮你写的位置记号：靠近——没有动，你已经站在能站到的最近处了；到左边——换了位置，现在就在上面说的地方。');
  assert.ok(en.includes('nearer: you stayed where you were') && en.includes('to the left: you changed place'), en);
  assert.ok(!goOutcomeLine([{ word: 'go-left', outcome: 'went', why: null }], false).includes('没有动'), 'a went walk is never told as stayed');
  for (const why of ['asleep', 'pulled', 'playing', 'typing', 'close-moment', 'queued', 'dropped', 'no-place', 'cursor-stale', 'covered', 'not-shown'] as const) {
    const line = goOutcomeLine([{ word: 'go', outcome: 'stayed', why }], false);
    assert.ok(line.includes('没有动，') && line.length < 60, line);
  }
  const stale = new GoOutcomes();
  stale.note(goStayedRow('go-far', 'asleep'), 0);
  assert.deepEqual(stale.take(GO_OUTCOME_RULES.freshMs + 1), [], 'an old outcome is not told');
  // Through the host: a gate's stay and a walk, in order, told once.
  const s = stage(SCREENS['15.6"'], 1.6, { across: 0.5, size: 0.5 });
  s.state.typing = true; assert.equal(s.ask({ goBeat: 'go-left' }), 'stay');
  s.state.typing = false; assert.equal(s.ask({ goBeat: 'go-right' }), 'go');
  assert.deepEqual(s.host.takeGoOutcomes(), [{ word: 'go-left', outcome: 'stayed', why: 'typing' }, { word: 'go-right', outcome: 'went', why: null }]);
  assert.deepEqual(s.host.takeGoOutcomes(), []);
});

test('the turn line: how big she is and the near-far table from the real framing; the table\'s metres and the line\'s come from the same function; its length', () => {
  for (const [name, frame] of Object.entries(SCREENS)) for (const heightM of HEIGHTS) {
    const table = nearTable(frame, heightM)!;
    assert.ok(table.rows.length >= 4 && table.rows[0]!.seen === 'whole', `${name}: whole first`);
    const order = ['whole', 'knees-up', 'waist-up', 'chest-up', 'face'];
    for (let i = 1; i < table.rows.length; i++) {
      assert.ok(order.indexOf(table.rows[i]!.seen) > order.indexOf(table.rows[i - 1]!.seen), 'far to near');
      assert.ok(table.rows[i]!.distanceM <= table.rows[i - 1]!.distanceM, 'nearer, fewer metres');
    }
    for (const row of table.rows) {
      // The metres are the told metres of a size in that band (screen-terms toldDistanceM): back through the formula, the framing says the same band.
      const size = sizeForToldM(heightM, row.distanceM)!;
      assert.equal(toldDistanceM(heightM, size), row.distanceM, 'the same ruler both ways');
    }
    assert.equal(table.nearest.distanceM, toldDistanceM(heightM, nearestWalkSize(frame, heightM)!));
    assert.equal(table.farthest.distanceM, toldDistanceM(heightM, K.farthestSize));
    assert.ok(nearestWalkSize(frame, heightM)! <= sizeAtDepth(frame, heightM, 0.6)! + 1e-9, 'never through the glass');
  }
  // Same-size band rows on the laptops: the same told metres on 13.3" and 15.6" (the bands are in screen terms; only the glass differs).
  const a = nearTable(SCREENS['13.3"'], 1.6)!, b = nearTable(SCREENS['15.6"'], 1.6)!;
  assert.deepEqual(a.rows.filter(r => r.seen === 'whole' || r.seen === 'waist-up'), b.rows.filter(r => r.seen === 'whole' || r.seen === 'waist-up'));
  // The line on a 15.6" laptop, 1.6 m, at half the usable height with a default place: before (I-211) and now.
  const frame = SCREENS['15.6"'], her = new HerPlace({ defaultLook: { across: 0.78, size: 0.5 }, adopt: () => {} } as never, () => worldOf(frame));
  her.heightM = 1.6; her.placement = placementOfLook(frame, 1.6, { across: 0.7, size: 0.5 })!;
  const now = her.facts()!;
  const before = herPositionLine(now.spot, { ...now.facts, table: null });
  const after = herPositionLine(now.spot, now.facts);
  const withGo = herPositionLine(now.spot, { ...now.facts, lastGo: [{ word: 'come-near', outcome: 'stayed', why: 'already-there' }] });
  const t = now.facts.table!, m = (v: number) => (v < 2 ? v.toFixed(1) : String(v));
  const words: Record<string, string> = { whole: '全身', 'knees-up': '膝盖以上', 'waist-up': '腰以上', 'chest-up': '胸口以上', face: '只有脸' };
  assert.equal(after, before.replace('。用户给你定的', `。你约占屏幕可用高度的 50%。这块屏幕上约 ${t.rows.map(r => `${m(r.distanceM)} 米${words[r.seen]}`).join('、')}；你能站的远近是 ${m(t.nearest.distanceM)}～${m(t.farthest.distanceM)} 米。用户给你定的`));
  console.log(`[I-193] position line: ${before.length} → ${after.length} characters (${withGo.length} with a stayed come-near)\n  ${withGo}`);
  assert.ok(after.length - before.length <= 90 && withGo.length - after.length <= 40, `${before.length} → ${after.length} → ${withGo.length}`); // measured 83 → 169 → 202 (2026-11-24)
  // Feet below the picture when she is nearer than whole; times instead of a share above 1.
  her.placement = placementOfLook(frame, 1.6, { across: 0.5, size: 1.6 })!;
  assert.ok(herPositionLine(her.here(), her.facts()!.facts).includes('你的身高约是屏幕可用高度的 1.6 倍，脚在画面下面'));
  assert.ok(herPositionLine(her.here(), { ...her.facts()!.facts, language: 'en' }).includes('Your height is about 1.6 times the usable screen height, your feet below the picture'));
});

test('no instruction words in the new line parts (the existing guard pattern), in Chinese and English', () => {
  const frame = SCREENS['15.6"'];
  const outcomes = [{ word: 'come-near', outcome: 'stayed', why: 'already-there' }, { word: 'go-far', outcome: 'stayed', why: 'already-there' }, { word: 'go-left', outcome: 'went', why: null }] as const;
  for (const heightM of HEIGHTS) for (const size of [0.35, 0.5, 0.9, 1.4, 3]) for (const language of ['zh-CN', 'en']) {
    const her = new HerPlace({ defaultLook: null, adopt: () => {} } as never, () => worldOf(frame));
    her.heightM = heightM; her.placement = placementOfLook(frame, heightM, { across: 0.3, size })!;
    const facts = her.facts()!.facts;
    const parts = [herPositionLine(her.here(), { ...facts, language, lastGo: [...outcomes] }).replace(herPositionLine(her.here(), { ...facts, language, table: null }).replace(/[.。]$/u, ''), '')];
    for (const why of ['not-shown', 'asleep', 'pulled', 'playing', 'typing', 'close-moment', 'already-there', 'cursor-stale', 'covered', 'no-place', 'queued', 'dropped'] as const)
      for (const word of SPEECH_BEAT_GO_WORDS) parts.push(goOutcomeLine([{ word, outcome: 'stayed', why }], language === 'en'));
    for (const part of parts) {
      for (const word of INSTRUCTION_WORDS) assert.ok(!part.includes(word), `${word} in ${part}`);
      assert.doesNotMatch(part, GUARD, part);
    }
  }
  assert.ok(SEEN_WORDS.zh.face === '只有脸');
});

// ---- the filter: ⟦go 30% 1.2m⟧ never shows, never is read aloud ---------------------------------------------------------------------

const SAMPLES: { raw: string; text: string; goTo: { percent?: number; metres?: number } | null }[] = [
  { raw: '好呀⟦go 30% 1.2m⟧我过来了。', text: '好呀我过来了。', goTo: { percent: 30, metres: 1.2 } },
  { raw: '⟦go 1.2m⟧', text: '', goTo: { metres: 1.2 } },
  { raw: '嗯⟦go 100%⟧这边。', text: '嗯这边。', goTo: { percent: 100 } },
  { raw: '来⟦GO 5M 7%⟧啦', text: '来啦', goTo: { percent: 7, metres: 5 } },
  { raw: '在这⟦go 0.4m 20%⟧呢', text: '在这呢', goTo: { percent: 20, metres: 0.4 } },
  { raw: '好⟦go 12.34m⟧的', text: '好的', goTo: null }, // a broken number: dropped whole
  { raw: '好⟦go 1234%⟧的', text: '好的', goTo: null },
  { raw: '好⟦go⟧的', text: '好的', goTo: null }, // go with no number is no marker
  { raw: '好⟦go 30% once⟧的', text: '好的', goTo: null },
  { raw: '好⟦go 30% 40%⟧的', text: '好的', goTo: null },
  { raw: '好⟦go 1.2m', text: '好', goTo: null }, // never closed
  { raw: '[go 30%]好', text: '好', goTo: { percent: 30 } }, // a backup bracket with valid numbers
  { raw: '第[1]条，[go 30 times]', text: '第[1]条，[go 30 times]', goTo: null }, // ordinary text in brackets stays
];
/** Every way to cut `raw` into two or three chunks (all single cut points, and every pair for the short ones). */
function* splits(raw: string): Generator<string[]> {
  const chars = Array.from(raw);
  yield chars;
  for (let i = 0; i <= chars.length; i++) yield [chars.slice(0, i).join(''), chars.slice(i).join('')];
  if (chars.length <= 24) for (let i = 1; i < chars.length; i++) for (let j = i + 1; j < chars.length; j++) yield [chars.slice(0, i).join(''), chars.slice(i, j).join(''), chars.slice(j).join('')];
}

test('the filter never leaks a go marker with numbers into the bubble or the voice text, with chunk splits at every position; the beat carries the numbers', () => {
  for (const sample of SAMPLES) for (const chunks of splits(sample.raw)) {
    const filter = new SpeechBeatFilter();
    let shown = '';
    const beats: SpeechBeat[] = [];
    for (const chunk of chunks) { const out = filter.push(chunk); shown += out.text; beats.push(...out.beats); }
    const last = filter.end(); shown += last.text; beats.push(...last.beats);
    assert.equal(shown, sample.text, `${JSON.stringify(chunks)} → ${shown}`);
    const go = beats.filter(b => b.word === 'go');
    if (sample.goTo) { assert.equal(go.length, 1, JSON.stringify(chunks)); assert.deepEqual({ ...go[0]!.goTo }, sample.goTo); } else assert.equal(go.length, 0, JSON.stringify(chunks));
  }
  // The turn's path (what the bubble, the archive and the read-aloud all take): the same text, never a marker piece.
  for (const sample of SAMPLES) for (const chunks of splits(sample.raw)) {
    const turn = new SpeechBeatTurn(true, () => {});
    let voiced = '';
    const push = turn.input((type: 'delta', text: string) => { voiced += text; });
    for (const chunk of chunks) push('delta', chunk);
    void turn.end(push);
    assert.equal(voiced, sample.text, JSON.stringify(chunks));
  }
});

test('digits in other markers are not accepted (dropped, never shown); the go sentence clause and the word list', () => {
  for (const raw of ['好⟦tilt 30%⟧的', '好⟦come-near 1.2m⟧的', '好⟦go-left 2⟧的', '好⟦pause 3⟧的', '好⟦smile-warm 1m⟧的']) {
    const summary = filterSpeechBeats(raw);
    assert.equal(summary.text, '好的', raw);
    assert.ok(!summary.beats.some(b => b.goTo), raw);
  }
  assert.ok(!filterSpeechBeats('[come-near 1.2m]').beats.length && filterSpeechBeats('[come-near 1.2m]').text === '[come-near 1.2m]', 'a backup bracket with a number after another word stays text');
  const full = speechBeatSentence([...SPEECH_BEAT_WORDS, ...SPEECH_BEAT_GO_WORDS, ...SPEECH_BEAT_FRAME_WORDS]);
  assert.ok(full.includes('go走到指定位置') && full.includes('形如⟦go 30% 1.2m⟧'), full);
  const clause = full.slice(full.indexOf('go 后面'), full.indexOf('。', full.indexOf('go 后面')) + 1);
  for (const word of INSTRUCTION_WORDS) assert.ok(!clause.includes(word), `${word} in ${clause}`);
  assert.doesNotMatch(clause, /什么时候|想.*时|可以用来/u, 'what it is, not when to use it');
  assert.ok(!speechBeatSentence().includes('go 后面'), 'the window sentence does not mention it');
  const base = speechBeatSentence(), withGo = speechBeatSentence([...SPEECH_BEAT_WORDS, ...SPEECH_BEAT_GO_WORDS]), noGo = speechBeatSentence([...SPEECH_BEAT_WORDS, ...SPEECH_BEAT_GO_WORDS.filter(w => w !== 'go')]);
  console.log(`[I-193] the speech-beat sentence: +${noGo.length - base.length} for the 7 old go words, +${withGo.length - base.length} with go and its clause`);
});

test('her history keeps go\'s numbers as she wrote them; the schedule carries them to the page; the page asks the host with them', async () => {
  const summary = filterSpeechBeats('好呀⟦go 30% 1.2m⟧我过来了。');
  const history = withSpeechBeatMarkers(summary.text, summary.beats);
  assert.equal(history, '好呀⟦go 30% 1.2m⟧我过来了。');
  assert.deepEqual(filterSpeechBeats(history).beats, summary.beats, 'read back the same');
  const schedule = new SpeechBeatSchedule();
  schedule.begin('r', 'shown', 0);
  schedule.add('r', [{ word: 'go', at: 0, goTo: { percent: 30, metres: 1.2 } }, { word: 'go-left', at: 0, goTo: { percent: 5 } } as SpeechBeat], 0);
  schedule.shown('r', 3, 0);
  const due = schedule.due(1);
  assert.deepEqual(due.map(p => [p.word, p.goTo ?? null]), [['go', { percent: 30, metres: 1.2 }], ['go-left', null]], 'only go carries numbers');
  const asked: unknown[] = [];
  const player = new UnboundSpeechBeats({ generate: () => ({ ...REST_TARGETS }), reset() {} } as never, () => {}, null, (word, goTo) => { asked.push(goTo ? { word, ...goTo } : { word }); return Promise.resolve('go'); });
  player.receive({ id: 'r1', type: 'beats', speechBeats: { beats: [{ word: 'go', at: 0, goTo: { percent: 30, metres: 1.2 } }, { word: 'go', at: 0, goTo: { metres: 'far' } }] } } as unknown as UnboundBubble);
  player.receive({ id: 'r1', type: 'delta', text: '我过来了。', rev: 1 } as UnboundBubble);
  for (let i = 0; i < 12; i++) player.frame(1 / 60, laptopLens(), { x: 0, z: -0.85 }, { sense: {} as never, setPoseTargets() {} }, true, { shown: true, asleep: false, armsHeld: false });
  await Promise.resolve();
  assert.deepEqual(asked, [{ word: 'go', percent: 30, metres: 1.2 }], 'the forged one without usable numbers is not asked');
});

test('the grey line names a go word only when the walk really happened', () => {
  const beats: SpeechBeat[] = [{ word: 'come-near', at: 0 }, { word: 'shy', at: 0 }, { word: 'go', at: 0, goTo: { metres: 1 } }];
  assert.equal(describeBeats(beats), '（害羞地笑了）', 'not known: nothing for it');
  assert.equal(describeBeats(beats, undefined, beat => beat.word === 'come-near'), '（走近了一些，害羞地笑了）');
  assert.equal(describeBeats([{ word: 'go-left', at: 0 }]), '', 'a marker-only reply whose walk did not happen (or is not known yet) says nothing for it');
  const turn = new SpeechBeatTurn(true, () => {});
  const push = turn.input(() => {});
  push('delta', '⟦come-near⟧');
  void turn.end(push);
  assert.equal(turn.complete('').line, '', 'the turn completes before the page asked the host: no "走近了一些"');
});

test('the go-beat journal row keeps the target (closed words and numbers only)', () => {
  const at = Date.UTC(2026, 10, 24, 12);
  const went = buildJournalEntry({ type: 'go-beat', characterId: 'one', word: 'go', outcome: 'went', why: null, metres: 4.26, target: { percent: 30, metres: 1.2 } }, at)!;
  const row = went as Extract<typeof went, { type: 'go-beat' }>;
  assert.deepEqual({ word: row.word, metres: row.metres, target: row.target }, { word: 'go', metres: 4.3, target: { percent: 30, metres: 1.2 } });
  const tr = (source: string, ...values: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_m, i) => String(values[Number(i)]));
  assert.ok(describeJournalEntry(went, tr).includes('到指定位置（横向 30%、离你约 1.2 米）（4.3 米）'), describeJournalEntry(went, tr));
  const stayed = buildJournalEntry({ type: 'go-beat', characterId: null, word: 'go', outcome: 'stayed', why: 'asleep', metres: null, target: { metres: 2 } }, at)!;
  assert.deepEqual((stayed as Extract<typeof stayed, { type: 'go-beat' }>).target, { metres: 2 });
  for (const target of [{ percent: 30, text: '我过来' }, { percent: '30' }, {}, { metres: -1 }, 'go 30%', [30]]) {
    assert.equal(buildJournalEntry({ type: 'go-beat', characterId: null, word: 'go', outcome: 'went', why: null, metres: 1, target }, at), null, JSON.stringify(target));
  }
  assert.equal(buildJournalEntry({ type: 'go-beat', characterId: null, word: 'go-left', outcome: 'went', why: null, metres: 1, target: { percent: 30 } }, at), null, 'numbers only on go');
  const plain = buildJournalEntry({ type: 'go-beat', characterId: null, word: 'come-near', outcome: 'went', why: null, metres: 1 }, at)!;
  assert.equal('target' in plain, false, 'no numbers given: no target');
  assert.deepEqual(goWentRow('go', 1, { percent: 30 }), { type: 'go-beat', word: 'go', outcome: 'went', why: null, metres: 1, target: { percent: 30 } });
  assert.deepEqual(goWentRow('go-left', 1), { type: 'go-beat', word: 'go-left', outcome: 'went', why: null, metres: 1 });
});

test('metres become a size only in screen-terms: the inverse of the told distance, on every screen', () => {
  for (const heightM of HEIGHTS) for (const metres of [0.4, 0.8, 1.2, 1.9, 3.5]) {
    const size = sizeForToldM(heightM, metres)!;
    assert.equal(toldDistanceM(heightM, size), metres);
    for (const frame of Object.values(SCREENS)) {
      const her = new HerPlace({ defaultLook: null, adopt: () => {} } as never, () => worldOf(frame));
      her.heightM = heightM;
      close(her.goTarget({ metres })!.size!, size, 1e-12, 'the host converts through sizeForToldM');
      const depth = depthForSize(frame, heightM, size)!;
      close(lookOfPlacement(frame, heightM, { xM: 0, depthM: depth })!.size, size, 1e-9, 'and back');
    }
  }
  assert.equal(new HerPlace({ defaultLook: null } as never, () => null).goTarget({ metres: 1 }), null, 'no height yet: nothing to convert');
  assert.deepEqual(new HerPlace({ defaultLook: null } as never, () => null).goTarget({ percent: 25 }), { across: 0.25 });
});
