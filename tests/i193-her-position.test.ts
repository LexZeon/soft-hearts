// I-193:
// the position line for her turn (information only, English in an English chat; I-211 2026-11-24: with numbers from the screen), her "go where" words
// (a closed set, each resolves to a reachable spot that keeps clear of a window that must stay clear, never the spot she stands on), the walk gates
// (a call is not one), the host's answer and her own walk path (plan.walk of the life player: the gait, no teleport), the page's question, and the
// speech-beat sentence (the go words only in full-screen). I-212: spots are screen terms (across, size); `at(across, m)` is the old metres on the
// reference laptop (8 m = 0.5), so the cases read as they did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GO_WORDS, GO_ACROSS, GO_SIZE, HER_POSITION_KNOBS, alreadyThere, goBlock, goSpot, herPosition, herPositionLine, interruptsGoWalk, nearestGoSize, parseGoBeatAsk,
  type GoGates, type GoWord } from '../shared/unbound/her-position';
import { INSTRUCTION_WORDS } from '../shared/unbound/life/history';
import { SPEECH_BEAT_GO_WORDS, SPEECH_BEAT_WORDS } from '../shared/behaviors/speech-beats/interface';
import { SpeechBeatFilter, speechBeatSentence } from '../shared/behaviors/speech-beats/choose';
import { offeredBeatWords } from '../shared/behaviors/speech-beats/window-close';
import { SpeechBeatTurn } from '../electron/brain/speech-beats/turn';
import { speechBeatSituationOf } from '../shared/behaviors/speech-beats/availability';
import { LifeHost, type LifeLink, type LifePorts, type LifeReadings } from '../electron/unbound/life';
import { NEUTRAL_MOOD } from '../shared/unbound/director';
import type { LifeCommand } from '../shared/unbound/life/types';
import type { LifeSpot } from '../shared/unbound/life/action';
import { referenceSize } from '../shared/unbound/screen-terms';
import { UnboundSpeechBeats } from '../src/unbound/speech-beat-player';
import { REST_TARGETS } from '../src/unbound/motion/generator';
import { CursorAcross } from '../src/unbound/go-cursor';
import type { UnboundBubble } from '../shared/unbound/scene';
import { laptopLens } from './helpers/unbound-peek';

const K = HER_POSITION_KNOBS;
const ACROSS = [0.02, 0.1, 0.14, 0.2, 0.3, 0.38, 0.5, 0.62, 0.7, 0.86, 0.9, 0.98];
const DEPTH = [1.5, 3, 4, 5, 6, 6.6, 8, 9.4, 11, 12.5];
const CJK = /[㐀-鿿]/u;
/** A spot `m` metres behind the screen on the reference laptop (the knobs' old numbers). */
const at = (across: number, m: number): LifeSpot => ({ across, size: referenceSize(m) });

test('position words: left / middle / right, near / far, the edge and the taskbar, for a grid of places', () => {
  for (const across of ACROSS) for (const depthM of DEPTH) {
    const spot = at(across, depthM), size = spot.size;
    const p = herPosition(spot)!;
    assert.equal(p.side, across < K.leftUntil ? 'left' : across > K.rightFrom ? 'right' : 'middle', `side at ${across}`);
    assert.equal(p.range, size >= K.veryNearSize ? 'very-near' : size >= K.nearSize ? 'near' : size <= K.farSize ? 'far' : 'middle', `range at ${depthM}`);
    assert.equal(p.edge, across <= K.edgeShare ? 'left' : across >= 1 - K.edgeShare ? 'right' : null, `edge at ${across}`);
    assert.equal(p.floor, size <= K.floorSize, `feet on the floor line at ${depthM}`);
    const zh = herPositionLine(spot, { taskbar: true, distanceM: 3.5 })!;
    assert.ok(zh.startsWith('你现在离用户约') && zh.endsWith('。'), zh);
    assert.ok(zh.includes(p.side === 'left' ? '偏左' : p.side === 'right' ? '偏右' : '中间'), zh);
    assert.match(zh, /横向约 \d+% 处/u, 'the share across');
    assert.equal(zh.includes('任务栏'), size <= K.floorSize, `the taskbar only where her feet are on its line: ${zh}`);
    assert.equal(zh.includes('边缘'), p.edge !== null, zh);
    assert.ok(!herPositionLine(spot, { taskbar: false, distanceM: 3.5 }).includes('任务栏'), 'no taskbar on the display: not named');
    const en = herPositionLine(spot, { taskbar: true, language: 'en', distanceM: 3.5 });
    assert.ok(en && !CJK.test(en) && en.startsWith('You are about'), `an English chat gets English: ${en}`);
  }
});

test('position words: nothing known, nothing said', () => {
  for (const bad of [null, undefined, { across: Number.NaN, size: 0.5 }, { across: 0.5, size: Number.POSITIVE_INFINITY }, { across: 0.5, size: 0 }]) assert.equal(herPositionLine(bad as never), '');
});

test('the position line is information only: no instruction word, no walking verb, nothing about the window you are using', () => {
  for (const across of ACROSS) for (const depthM of DEPTH) for (const language of ['zh-CN', 'en']) for (const seen of [null, { seen: 'chest-up' as const, crownCut: true, feetOnFloor: false }]) {
    const line = herPositionLine(at(across, depthM), { taskbar: true, language, distanceM: 3.5, seen, defaultPlace: at(0.7, 8) });
    for (const word of INSTRUCTION_WORDS) assert.ok(!line.includes(word), `${word} in ${line}`);
    assert.doesNotMatch(line, /走|去|移|过来|窗口|\b(should|must|please|go|move|walk|try)\b/iu, line);
  }
});

test('a "go where" word resolves to a reachable spot, never the spot she stands on, and (with a hook) never over a window that must stay clear', () => {
  const random = (seed: number) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (const word of GO_WORDS) for (const across of [0.1, 0.3, 0.5, 0.7, 0.9]) for (const depthM of [5, 8, 10.5]) for (let seed = 1; seed <= 12; seed++) {
    const here = at(across, depthM);
    const go = goSpot({ word, here, cursorAcross: 0.45, random: random(seed), drives: { tense: 0.2, warm: 0.3, energy: 0.6, sleepy: 0 } });
    if (!go) continue; // already there / nowhere
    const label = `${word} from ${across}/${depthM} seed ${seed}`;
    assert.ok(go.spot.across >= GO_ACROSS[0] && go.spot.across <= GO_ACROSS[1], `${label}: inside the screen`);
    assert.ok(go.spot.size >= GO_SIZE[0] && go.spot.size <= GO_SIZE[1], `${label}: on her floor`);
    assert.ok(!alreadyThere(here, go.spot), `${label}: not where she stands`);
    assert.ok(go.speedMps >= 0.2 && go.speedMps <= 0.8 && go.stayMinutes >= K.stayMinutesMin && go.stayMinutes <= K.stayMinutesMax, `${label}: her own pace, a few minutes' stay`);
    if (word === 'come-near') assert.ok(go.spot.size <= Math.max(K.nearestSize, here.size) + 1e-9, `${label}: not nearer than where her whole body fits`);
    // A window that must stay clear: the left third. She does not end up there.
    const clear = goSpot({ word, here, cursorAcross: 0.45, random: random(seed), covers: spot => spot.across < 0.34 });
    if (clear) assert.ok(clear.spot.across >= 0.34, `${label}: kept clear of the window`);
  }
  // Every spot blocked: nowhere to go (she says it, the body stays).
  assert.equal(goSpot({ word: 'go-left', here: at(0.8, 8), random: () => 0.5, covers: () => true }), null);
});

test('each word does what it says', () => {
  const here = at(0.5, 8), half = () => 0.5;
  const to = (word: GoWord, over: Partial<Parameters<typeof goSpot>[0]> = {}) => goSpot({ word, here, random: half, ...over })!.spot;
  assert.ok(to('go-left').across < 0.3 && to('go-left').size === here.size);
  assert.ok(to('go-right').across > 0.7 && to('go-right').size === here.size);
  const middle = goSpot({ word: 'go-middle', here: at(0.85, 8), random: half })!.spot;
  assert.ok(Math.abs(middle.across - 0.5) < 0.1);
  assert.ok(to('come-near').size > here.size && to('come-near').size <= K.nearestSize, 'closer (bigger), but she still fits');
  assert.ok(to('go-far').size < here.size && to('go-far').size >= K.farthestSize, 'further (smaller), not past the far end');
  const corner = to('go-corner', { here: at(0.3, 8) });
  assert.ok(corner.across <= K.cornerMax && corner.size <= K.cornerSizeMax, 'the left corner when she is on the left, and far');
  assert.ok(to('go-corner', { here: at(0.7, 8) }).across >= 1 - K.cornerMax, 'the right corner when she is on the right');
  const beside = to('go-cursor', { cursorAcross: 0.2 });
  assert.ok(Math.abs(beside.across - 0.2) >= K.besideMin - 1e-9 && Math.abs(beside.across - 0.2) <= K.besideMax + 1e-9 && beside.across > 0.2, 'beside the pointer, on the roomier side');
  assert.equal(goSpot({ word: 'go-cursor', here, random: half }), null, 'the pointer is not known: she does not guess');
  assert.ok(Math.abs(to('go-cursor', { cursorAcross: 0.3, covers: spot => spot.across > 0.3 }).across - 0.3) >= K.besideMin - 1e-9 && to('go-cursor', { cursorAcross: 0.3, covers: spot => spot.across > 0.3 }).across < 0.3, 'the other side when one is blocked');
  // I-212: a step is a change of her size, the same share on any screen: on the reference laptop it is the old 1.2-2.4 m from 8 m.
  const step = to('come-near', { knobs: { ...K, comeNearToPlace: false } }).size / here.size;
  assert.ok(step >= K.nearStepMin - 1e-9 && step <= K.nearStepMax + 1e-9, `a step nearer: ×${step.toFixed(3)}`);
});

test('come-near never goes nearer than her whole body fits; her mood leans the step (warm further in, tense less)', () => {
  const near = goSpot({ word: 'come-near', here: { across: 0.5, size: K.nearestSize * 1.01 }, random: () => 0.9, knobs: { ...K, comeNearToPlace: false } });
  assert.equal(near, null, 'already as big as a step may make her: she does not come nearer');
  assert.equal(nearestGoSize(), K.nearestSize);
  const warm = goSpot({ word: 'come-near', here: at(0.5, 9), random: () => 0.5, drives: { tense: 0, warm: 1, energy: 0.5, sleepy: 0 }, knobs: { ...K, comeNearToPlace: false } })!;
  const tense = goSpot({ word: 'come-near', here: at(0.5, 9), random: () => 0.5, drives: { tense: 1, warm: 0, energy: 0.5, sleepy: 0 }, knobs: { ...K, comeNearToPlace: false } })!;
  assert.ok(warm.spot.size > tense.spot.size, `warm ${warm.spot.size} > tense ${tense.spot.size}`);
});

test('the gates: pulled, a game, asleep, the box open, a peek or a close moment, not shown block; a call does not', () => {
  const open: GoGates = { shown: true, asleep: false, pulled: false, playing: false, typing: false, busy: false };
  assert.equal(goBlock(open), null);
  for (const [key, why] of [['shown', 'not-shown'], ['asleep', 'asleep'], ['pulled', 'pulled'], ['playing', 'playing'], ['typing', 'typing'], ['busy', 'busy']] as const) {
    assert.equal(goBlock({ ...open, [key]: key === 'shown' ? false : true }), why, key);
  }
  assert.ok(!('inCall' in open), 'there is no call gate');
  assert.deepEqual(['call', 'pull', 'play', 'click', 'typing', 'waiting', 'reply', 'reading'].filter(interruptsGoWalk), ['pull', 'play', 'click']);
});

test('the page asks with a closed question only', () => {
  assert.deepEqual(parseGoBeatAsk({ goBeat: 'go-left' }), { goBeat: 'go-left' });
  assert.deepEqual(parseGoBeatAsk({ goBeat: 'go-cursor', cursorAcross: 0.4 }), { goBeat: 'go-cursor', cursorAcross: 0.4 });
  for (const bad of [null, [], 'go-left', { goBeat: 'teleport' }, { goBeat: 'go-left', x: 1 }, { goBeat: 'go-cursor', cursorAcross: 2 }, { goBeat: 'go-cursor', cursorAcross: 'a' }, { closeBeat: 'kiss' }]) assert.equal(parseGoBeatAsk(bad), null, JSON.stringify(bad));
});

// ---- the host -------------------------------------------------------------------------------------------------------------------

function world(over: { here?: LifeSpot | null; random?: number } = {}) {
  const state = {
    now: 1_000_000, asleep: false, inCall: false, waiting: false, typing: false, reading: false, shown: true, peekActive: false, here: over.here === undefined ? at(0.78, 8) as LifeSpot | null : over.here,
    sent: [] as LifeCommand[], arrived: [] as { xM: number; depthM: number }[],
  };
  const ports: LifePorts = {
    clock: () => state.now, random: () => over.random ?? 0.5, readings: () => ({ idleSeconds: 120, state: 'pause', pose: null, activity: null, talkedAt: null, sound: null } as Partial<LifeReadings>),
    asleep: () => state.asleep, inCall: () => state.inCall, waiting: () => state.waiting, typing: () => state.typing, readingAloud: () => state.reading,
    mood: () => ({ ...NEUTRAL_MOOD }), lastInteractionAt: () => null, answered: () => true, every: () => () => {},
  };
  const link: LifeLink = {
    shown: () => state.shown, fullscreen: () => false, out: () => true, send: command => state.sent.push(command), here: () => state.here, toWorld: spot => ({ xM: (spot.across - 0.5) * 3, depthM: 4.275 / spot.size - 0.55 }), // the reference laptop (8 m = 0.5)
    arrived: at => { state.arrived.push(at); state.here = { across: at.xM / 3 + 0.5, size: 4.275 / (at.depthM + 0.55) }; }, peekActive: () => state.peekActive, interruptPeek: () => {}, changed: () => {}, taskbar: () => true,
  };
  const host = new LifeHost(ports, link);
  const starts = () => state.sent.filter((c): c is Extract<LifeCommand, { type: 'start' }> => c.type === 'start');
  const run = (seconds: number) => { for (let i = 0; i < seconds; i++) { state.now += 1_000; host.tick(); } };
  return { state, host, starts, run };
}

test('the host starts her own walk path for a go word: plan.walk (the gait), level place, no mood write, never a teleport', () => {
  const w = world();
  assert.equal(w.host.goAsk({ goBeat: 'go-left' }), 'go');
  const start = w.starts().at(-1)!;
  assert.equal(start.plan.level, 'place'); assert.equal(start.plan.action, 'place');
  assert.ok(start.plan.walk && start.plan.walk.xM < 0, 'walks to the left of where the middle is');
  assert.ok(start.plan.walk!.speedMps >= 0.2 && start.plan.walk!.speedMps <= 0.8, 'a walking pace, not a jump');
  assert.equal(start.trial, false);
  // The page reports the end of the walk: where she stands is saved; her own "换个地方站" waits a few minutes.
  w.host.report({ id: start.id, phase: 'done', at: { xM: start.plan.walk!.xM, depthM: start.plan.walk!.depthM } });
  assert.equal(w.state.arrived.length, 1);
  const before = w.starts().length;
  w.run(150);
  assert.equal(w.starts().filter(c => c.plan.action === 'place').length, 1, `no walk of her own straight after (${before} starts)`);
});

test('the host answers stay for each gate, an unknown place, and being there already; a call lets her walk', () => {
  const gate = (change: (state: ReturnType<typeof world>['state'], host: LifeHost) => void) => { const w = world(); change(w.state, w.host); return w.host.goAsk({ goBeat: 'go-left' }); };
  assert.equal(gate(s => { s.asleep = true; }), 'stay', 'asleep');
  assert.equal(gate(s => { s.shown = false; }), 'stay', 'not shown');
  assert.equal(gate(s => { s.typing = true; }), 'stay', 'the box open');
  assert.equal(gate(s => { s.peekActive = true; }), 'stay', 'a peek or a close moment');
  assert.equal(gate((_s, host) => host.pulled('start')), 'stay', 'pulled');
  assert.equal(gate(s => { s.here = null; }), 'stay', 'her place is not known');
  assert.equal(gate(s => { s.here = at(0.2, 8); }), 'stay', 'already on the left');
  assert.equal(gate(s => { s.inCall = true; }), 'go', 'in a call she may walk');
  assert.equal(world().host.goAsk({ goBeat: 'teleport' }), undefined, 'not a go question');
  assert.equal(world().host.goAsk({ closeBeat: 'kiss' }), undefined);
});

test('a walk she chose keeps going while she talks, in a call and when you open the box; a pull, a game or a click takes it', () => {
  for (const [name, set, ends] of [
    ['her reply', (w: ReturnType<typeof world>) => w.host.chat('delta'), false], ['her reading aloud', (w: ReturnType<typeof world>) => { w.state.reading = true; }, false],
    ['a call', (w: ReturnType<typeof world>) => { w.state.inCall = true; }, false], ['you waiting', (w: ReturnType<typeof world>) => { w.state.waiting = true; }, false],
    ['the box open', (w: ReturnType<typeof world>) => { w.state.typing = true; }, false],
    ['a pull', (w: ReturnType<typeof world>) => w.host.pulled('start'), true], ['a click', (w: ReturnType<typeof world>) => w.host.touched(), true],
  ] as const) {
    const w = world();
    assert.equal(w.host.goAsk({ goBeat: 'go-left' }), 'go', name);
    set(w); w.run(2);
    const cancelled = w.state.sent.some(c => c.type === 'cancel');
    assert.equal(cancelled, ends, `${name}: ${ends ? 'ends the walk' : 'the walk goes on'}`);
  }
});

test('a go word waits for a small move of hers to ease out (at most a few seconds), then walks; a gate that closes meanwhile drops it', () => {
  const w = world();
  assert.equal(w.host.trial('shift'), true);
  const small = w.starts().at(-1)!;
  assert.equal(w.host.goAsk({ goBeat: 'go-left' }), 'go');
  assert.ok(w.state.sent.some(c => c.type === 'cancel' && c.id === small.id), 'the small move eases out');
  assert.equal(w.starts().length, 1, 'the walk has not started yet');
  w.host.report({ id: small.id, phase: 'done' });
  w.run(1);
  assert.equal(w.starts().length, 2, 'now the walk starts');
  const dropped = world();
  dropped.host.trial('shift'); dropped.host.goAsk({ goBeat: 'go-left' });
  dropped.state.typing = true; dropped.host.report({ id: dropped.starts().at(-1)!.id, phase: 'done' }); dropped.run(2);
  assert.equal(dropped.starts().length, 1, 'the box opened meanwhile: the walk is dropped');
});

// ---- her turn -------------------------------------------------------------------------------------------------------------------

test('the sentence names the go words only in full-screen Unbound; the window and an unknown place keep it as it was', () => {
  const base = speechBeatSentence();
  const mk = (surface: 'full' | 'window') => new SpeechBeatTurn(true, () => {}, speechBeatSituationOf({ surface, shown: true, view: null, armsHeld: false, inCall: false, card: null })).sentence();
  assert.equal(mk('window'), speechBeatSentence(offeredBeatWords('window', false)), 'the window: as it was, without kiss and hug since 2026-11-24 (window-close.ts)');
  assert.equal(new SpeechBeatTurn(true, () => {}, null).sentence(), base);
  const full = mk('full');
  for (const word of SPEECH_BEAT_GO_WORDS) assert.ok(full.includes(word), word);
  assert.ok(!base.includes('go-left') && !base.includes('come-near'), 'the window sentence does not mention them');
  for (const [word, zh] of [['go-left', '去左边'], ['go-right', '去右边'], ['go-middle', '到中间'], ['come-near', '走近'], ['go-far', '走远'], ['go-corner', '去角落'], ['go-cursor', '到你鼠标旁边']]) assert.ok(full.includes(word + zh), word);
  assert.ok(!full.includes('窗口旁边'), 'no word for the window you are using: the app has no reading of it');
  // The growth of her turn, in characters (recorded in docs/claude/2026-11-23-i193-her-position.md).
  const line = herPositionLine(at(0.86, 9.6), { taskbar: true, distanceM: 3.5, seen: { seen: 'whole', crownCut: false, feetOnFloor: true }, defaultPlace: at(0.78, 8) });
  // I-193 numbers (2026-11-24): the go clause (⟦go 30% 1.2m⟧) adds about 50 to the sentence; the table's growth: tests/i193-walk-by-screen.test.ts.
  assert.ok(full.length - base.length <= 145 && line.length <= 110, `sentence +${full.length - base.length}, position line ${line.length}`); // I-211: about 100 characters with the default place
});

test('the go words and the host\'s list are one list; the filter takes the markers out of her text and records them as beats', () => {
  assert.deepEqual([...SPEECH_BEAT_GO_WORDS], [...GO_WORDS]);
  assert.ok(!SPEECH_BEAT_GO_WORDS.some(word => (SPEECH_BEAT_WORDS as readonly string[]).includes(word)), 'not part of the stages\' own list');
  const f = new SpeechBeatFilter();
  const first = f.push('好呀。⟦go-left⟧我去那边待着。⟦go-cursor once⟧');
  const summary = f.end() && f.summary();
  assert.equal(first.text.includes('⟦'), false);
  assert.deepEqual(summary.beats.map(b => b.word), ['go-left', 'go-cursor']);
  assert.ok(!summary.text.includes('go-'), summary.text);
});

// ---- the page -------------------------------------------------------------------------------------------------------------------

const fakeGenerator = () => ({ generate: () => ({ ...REST_TARGETS }), reset() {} }) as never;
const GATES = { shown: true, asleep: false, armsHeld: false };
function pagePlayer(answer: unknown = 'go', withHost = true) {
  const asked: string[] = [];
  const player = new UnboundSpeechBeats(fakeGenerator(), () => {}, null, withHost ? word => { asked.push(word); return Promise.resolve(answer); } : null);
  const lens = laptopLens(), HOME = { x: 0, z: -0.85 }, body = { sense: {} as never, setPoseTargets() {} };
  const say = (word: string, text = '好呀，我过去。', over: { allowed?: boolean; gates?: typeof GATES } = {}) => {
    player.receive({ id: `r-${word}`, type: 'beats', speechBeats: { beats: [{ word, at: 0 }] } } as unknown as UnboundBubble);
    player.receive({ id: `r-${word}`, type: 'delta', text, rev: 1 } as UnboundBubble);
    for (let i = 0; i < 12; i++) player.frame(1 / 60, lens, HOME, body, over.allowed ?? true, over.gates ?? GATES);
  };
  return { player, asked, say };
}

test('the page only asks the host for a go word: no beat, no body motion of its own, no teleport; no host: she stays', async () => {
  const { player, asked, say } = pagePlayer();
  for (const word of GO_WORDS) say(word);
  await Promise.resolve();
  // I-193 numbers: a `go` with no usable numbers has nowhere to ask for (the filter never makes one; a forged beat stays here).
  assert.deepEqual(asked, GO_WORDS.filter(word => word !== 'go'));
  assert.ok(player.played.includes('go:stay'), player.played.join());
  assert.equal(player.active, false, 'nothing is performed here: the host walks her with the gait');
  assert.ok(player.played.includes('go-left:go'), player.played.join());
  const none = pagePlayer(undefined, false);
  none.say('go-far');
  assert.ok(none.player.played.includes('go-far:stay'), 'no host: she stays');
  const refused = pagePlayer('stay');
  refused.say('go-far'); await Promise.resolve();
  assert.ok(refused.player.played.includes('go-far:stay'));
});

test('the page does not ask while something with priority has her (a pull, a peek) or when she is asleep', () => {
  const held = pagePlayer();
  held.say('go-left', '好呀，我过去。', { allowed: false });
  assert.deepEqual(held.asked, [], 'not allowed now: nothing is asked');
  const asleep = pagePlayer();
  asleep.say('go-left', '好呀，我过去。', { gates: { ...GATES, asleep: true } });
  assert.deepEqual(asleep.asked, []);
});

test('the pointer\'s place: known while it moved lately, never guessed', () => {
  let now = 0;
  const cursor = new CursorAcross(() => 1000, () => now, 1000);
  assert.equal(cursor.across(), null, 'never moved');
  cursor.move(250); assert.equal(cursor.across(), 0.25);
  now = 2000; assert.equal(cursor.across(), null, 'too long ago');
  cursor.move(5000); assert.equal(cursor.across(), 1, 'clamped to the screen');
  cursor.move(Number.NaN); assert.equal(cursor.across(), 1, 'a bad number changes nothing');
});
