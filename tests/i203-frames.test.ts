// I-203 frames (2026-11-23: a hug may keep talking or pause, each says something different, and the hug and the let-go are frames in her own choreography;
// agreed 2026-11-24; on an interrupted moment: no preset wording, only information). The chain without a model: her reply's stream (SpeechBeatTurn with the host's CloseBeatSequence),
// the peek host (PeekDirectorHost: the page's asks and reports), the page's player (UnboundSpeechBeats), the bubble, the cut record, and her one
// immediate turn through the moments host. Numbers of her body are in tests/i203-frames-gene.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloseBeatSequence, CLOSE_SEQUENCE_CAPS, type CloseCutEvent } from '../electron/unbound/close-sequence';
import { CloseCutNotice, CLOSE_CUT_TIMING } from '../electron/unbound/close-cut';
import { SpeechBeatTurn } from '../electron/brain/speech-beats/turn';
import { SpeechBeatsHost } from '../electron/brain/speech-beats/host';
import { PeekDirectorHost, type PeekLink, type PeekPorts } from '../electron/unbound/peek';
import { CloseMomentsHost, type CloseMomentPorts } from '../electron/unbound/close-moments';
import { UnboundBubbleHold } from '../electron/unbound/bubble-hold';
import { MomentHost, type MomentHostPorts, type MomentJournalRow } from '../electron/initiative/moments/host';
import { MomentStateStore } from '../electron/initiative/moments/state-store';
import { momentPromptLine } from '../shared/behaviors/moments/prompt';
import { ARRIVAL_KNOBS } from '../shared/unbound/arrival';
import { CLOSE_FRAME_KNOBS, HoldFrames, closeCutLine, parseFrameBeatAsk, pauseSeconds, type CloseCutFacts } from '../shared/unbound/close-moments';
import { NEUTRAL_MOOD, parsePeekSideCommand, type PeekCommand } from '../shared/unbound/director';
import { INSTRUCTION_WORDS } from '../shared/unbound/life/history';
import { filterSpeechBeats, speechBeatFramesClause, speechBeatSentence } from '../shared/behaviors/speech-beats/choose';
import { withSpeechBeatMarkers } from '../shared/behaviors/speech-beats/history';
import { SPEECH_BEAT_FRAME_WORDS, SPEECH_BEAT_WORDS, type SpeechBeatsEvent } from '../shared/behaviors/speech-beats/interface';
import type { SpeechBeatSituation } from '../shared/behaviors/speech-beats/availability';
import { UnboundSpeechBeats } from '../src/unbound/speech-beat-player';
import { REST_TARGETS, type MotionRequest } from '../src/unbound/motion/generator';
import type { UnboundBubble } from '../shared/unbound/scene';
import { laptopLens } from './helpers/unbound-peek';

const WARM = { ...NEUTRAL_MOOD, O: 80, E: 66, D: 62, M: 20 };
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const FULL: SpeechBeatSituation = { surface: 'full', shown: true, asleep: false, armsHeld: false, inCall: false, model: null };
/** Words that would tell her how to react or what to say (the mutation "the immediate turn note suggests what to say" must be caught). */
const STEERING = [...INSTRUCTION_WORDS, '不要', '别', '可以说', '你可以', '试着', '建议', 'should', "don't", 'try to', 'you could', 'say something'];

function clock() {
  let now = 0, seq = 0; const timers = new Map<number, { at: number; run: () => void }>();
  return {
    ports: { setTimer: (run: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, run }); return id; }, clearTimer: (id: unknown) => { timers.delete(id as number); } },
    advance(ms: number) { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.run(); } },
  };
}

/** The host side as the app wires it: the peek host with her close moments and the sequence (ports recorded). */
function host() {
  const c = clock(), contact: boolean[] = [], cuts: CloseCutEvent[] = [], caps: string[] = [];
  let presented: number | null = null;
  const bubble = new UnboundBubbleHold({ emit: () => {}, now: () => 0, setTimer: () => 0, clearTimer: () => {} }); // as the wiring: her lips on pause her bubble and her voice
  const sequence = new CloseBeatSequence({ ...c.ports, capped: (kind, phase) => caps.push(`${kind}:${phase}`), contact: on => { contact.push(on); if (on) bubble.pause(); else bubble.resume(); }, cut: event => { cuts.push(event); return presented; } });
  let now = Date.UTC(2026, 10, 24, 3, 0, 0);
  const closePorts: CloseMomentPorts = { clock: () => now, random: () => 0.4, day: () => 'today', mood: () => ({ ...WARM }), view: () => null,
    typing: () => false, playing: () => false, moment: () => true };
  const sent: PeekCommand[] = [], told: string[] = [];
  const ports: PeekPorts = {
    clock: () => now, random: () => 0.4, idleSeconds: () => 0, asleep: () => false, inCall: () => false, userTalking: () => true,
    mood: () => ({ ...WARM }), lastInteractionAt: () => null, answered: () => true, readingAloud: () => false,
    every: () => () => {}, close: new CloseMomentsHost(closePorts), sequence,
    notes: { missed: () => {}, interrupted: (action, by) => told.push(`${action}:${by}`), notReached: kind => told.push(`${kind}:unreached`) },
  };
  const link: PeekLink = { shown: () => true, fullscreen: () => false, send: command => sent.push(command), changed: () => {} };
  const peek = new PeekDirectorHost(ports, link);
  const start = () => sent.filter((x): x is Extract<PeekCommand, { type: 'start' }> => x.type === 'start').at(-1)!;
  return { peek, sequence, bubble, clock: c, sent, told, contact, cuts, caps, start, present(n: number | null) { presented = n; },
    play(id: string, phases: readonly string[]) { for (const phase of phases) peek.report({ id, phase }); } };
}

/** Her reply's stream as the chat turn runs it (filtered, pushed: shown, read and archived); `gate` the host's sequence (null: no full-screen). */
function stream(gate: CloseBeatSequence | null) {
  const pushed: string[] = [], events: SpeechBeatsEvent[] = [], breaks: number[] = [];
  const turn = new SpeechBeatTurn(true, event => events.push(event), FULL, gate);
  const shown = () => pushed.join('');
  turn.onHold = () => breaks.push(shown().length);
  const push = (type: 'delta', text: string) => { turn.shown(text); pushed.push(text); };
  const controller = new AbortController();
  const input = turn.input(push, controller.signal);
  return { turn, events, breaks, shown, input, controller, end: () => turn.end(push), beats: () => events.flatMap(e => e.beats ?? []).map(b => `${b.word}@${b.at}`) };
}

// ---- the words -------------------------------------------------------------------------------------------------------------------------------

test('the frames are never shown or read aloud: the filter takes them out (pause long keeps its length), her history writes them back as she wrote them', () => {
  const out = filterSpeechBeats('来⟦hug⟧我过来啦，⟦hug-held⟧嗯……⟦pause long⟧好啦⟦let-go⟧，放开你。');
  assert.equal(out.text, '来我过来啦，嗯……好啦，放开你。', 'no marker in the text the bubble, the voice and the archive get');
  assert.deepEqual(out.beats, [{ word: 'hug', at: 1 }, { word: 'hug-held', at: 6 }, { word: 'pause', at: 9, how: 'long' }, { word: 'let-go', at: 11 }]);
  assert.equal(withSpeechBeatMarkers(out.text, out.beats), '来⟦hug⟧我过来啦，⟦hug-held⟧嗯……⟦pause long⟧好啦⟦let-go⟧，放开你。', 'her history: as she wrote it');
  assert.equal(filterSpeechBeats('嗯⟦pause once⟧好').text, '嗯好', 'her own bracket with another suffix: still a pause, never shown');
  assert.deepEqual(filterSpeechBeats('嗯⟦pause once⟧好').beats, [{ word: 'pause', at: 1 }], 'the plain length');
  assert.equal(filterSpeechBeats('[pause long]好').text, '好', 'a backup bracket with the one suffix it takes');
  assert.equal(filterSpeechBeats('[pause soon]好').text, '[pause soon]好', 'ordinary text in brackets stays as written');
  assert.equal(filterSpeechBeats('⟦pout long⟧哼').beats[0]!.how, undefined, '"long" belongs to a pause only');
});

test('her word list (zh and en) names each frame as what it is, only where her words can wait for them; never when to use one', () => {
  const full = new SpeechBeatTurn(true, () => {}, FULL, new CloseBeatSequence(clock().ports));
  const sentence = full.sentence();
  for (const word of SPEECH_BEAT_FRAME_WORDS) assert.ok(sentence.includes(word), `${word} offered in full-screen`);
  assert.ok(sentence.includes('pause long') && sentence.includes('2 秒') && sentence.includes('4 秒'), sentence);
  const window = new SpeechBeatTurn(true, () => {}, { ...FULL, surface: 'window' }, null).sentence();
  for (const word of SPEECH_BEAT_FRAME_WORDS) assert.ok(!window.includes(`、${word}`) && !window.includes(`${word}停`), `${word} not offered in the window`);
  const call = new SpeechBeatTurn(true, () => {}, FULL, null).sentence(true);
  assert.ok(!call.includes('hug-held'), 'no gate (a call\'s legs): no frames');
  assert.equal(speechBeatSentence(SPEECH_BEAT_WORDS), speechBeatSentence(), 'without frames the fixed sentence is as before');
  const zh = speechBeatFramesClause('zh-CN'), en = speechBeatFramesClause('en');
  assert.ok(new SpeechBeatTurn(true, () => {}, FULL, new CloseBeatSequence(clock().ports), 'en').sentence().includes(en), 'an English card gets the English frames clause');
  for (const text of [zh, en]) for (const word of ['什么时候用', '应该', '要用', 'when to', 'should', 'use it when']) assert.ok(!text.includes(word), `information only: "${word}" in ${text}`);
  assert.match(en, /hug-held/); assert.match(en, /let-go/); assert.match(en, /pause long/);
});

// ---- the words around her walk ---------------------------------------------------------------------------------------------------------------

test('22:51 + 16:26: with only ⟦hug⟧ the sentence she is in goes on while she walks (never stopped mid-sentence); the next one waits for her arms round, then she talks on while she holds', async () => {
  const h = host(), s = stream(h.sequence);
  s.input('delta', '好呀，'); s.input('delta', '⟦hug⟧'); s.input('delta', '我过来抱你，走过来的路上也想和你说说话。今天辛苦啦。');
  let ended = false; void s.end().then(() => { ended = true; });
  await flush();
  assert.equal(s.shown(), '好呀，我过来抱你，走过来的路上也想和你说说话。', 'her walking sentence is out whole (the page shows and reads it as it goes)');
  assert.deepEqual(h.sequence.holding, { word: 'contact', phase: 'reach' }, 'the next sentence waits for the contact (2026-11-25)');
  assert.deepEqual(s.breaks, [23], 'the read-aloud breaks between two sentences, never inside one');
  assert.equal(h.peek.report({ closeBeat: 'hug' }), 'play');
  const id = h.start().id;
  h.play(id, ['notice', 'walk', 'lean', 'hold']); await flush();
  assert.equal(s.shown(), '好呀，我过来抱你，走过来的路上也想和你说说话。今天辛苦啦。', 'holding: she talks on');
  assert.equal(ended, true, 'the turn may finish and archive');
  assert.deepEqual(s.beats(), ['hug@3']);
});

test('⟦hug-held⟧: the words after it wait until she is holding (walk and lean go on with the words before it); a lighter hug or a hug-held with no hug never waits', async () => {
  const h = host(), s = stream(h.sequence);
  s.input('delta', '来，⟦hug⟧走过去的时候我在想，'); s.input('delta', '⟦hug-held⟧……抱住了。好暖。');
  let ended = false; void s.end().then(() => { ended = true; });
  await flush();
  assert.equal(s.shown(), '来，走过去的时候我在想，……', 'the words up to the frame (and the dots right after it) are out');
  assert.deepEqual(h.sequence.holding, { word: 'hug-held', phase: 'reach' });
  assert.deepEqual(s.breaks, [14], 'the read-aloud reads the words before it as their own piece');
  assert.equal(h.peek.report({ closeBeat: 'hug' }), 'play', 'the page reached the hug');
  assert.deepEqual(h.sequence.holding, { word: 'hug-held', phase: 'action' });
  const id = h.start().id;
  h.play(id, ['notice', 'walk', 'lean']); await flush();
  assert.equal(s.shown(), '来，走过去的时候我在想，……', 'walking and leaning in: still waiting');
  h.play(id, ['hold']); await flush();
  assert.equal(s.shown(), '来，走过去的时候我在想，……抱住了。好暖。', 'holding: her words come');
  assert.equal(ended, true);
  assert.deepEqual(h.caps, [], 'no cap');
  const lighter = host(), l = stream(lighter.sequence);
  l.input('delta', '来⟦hug⟧嗯⟦hug-held⟧好暖。'); void l.end();
  lighter.sequence.asked('hug', 'lighter'); await flush();
  assert.equal(l.shown(), '来嗯好暖。', 'the hug did not walk up: nothing waits for a hold that will not come');
  const alone = host(), a = stream(alone.sequence);
  a.input('delta', '嗯⟦hug-held⟧好暖。'); await a.end();
  assert.equal(a.shown(), '嗯好暖。', 'a hug-held with no kiss / hug before it: nothing to wait for');
  const already = host(), r = stream(already.sequence);
  already.sequence.asked('hug', 'play'); already.sequence.held('hug');
  r.input('delta', '⟦hug⟧嗯⟦hug-held⟧好暖。'); await r.end();
  assert.equal(r.shown(), '嗯好暖。', 'already holding when the stream reaches it: no wait');
});

test('⟦pause⟧ and ⟦pause long⟧: her words stop about 2 s / 4 s from when the page reached it (the words before it said); any reply, not only a hug', async () => {
  for (const [marker, ms] of [['⟦pause⟧', CLOSE_FRAME_KNOBS.pauseS * 1000], ['⟦pause long⟧', CLOSE_FRAME_KNOBS.pauseLongS * 1000]] as const) {
    const h = host(), s = stream(h.sequence);
    s.input('delta', `我想想。${marker}嗯，好。`); void s.end();
    await flush();
    assert.equal(s.shown(), '我想想。', `${marker}: the words before it`);
    h.clock.advance(10_000); await flush();
    assert.equal(s.shown(), '我想想。', 'still waiting for the page to reach it (the words before it are being shown and read)');
    h.peek.report(marker === '⟦pause⟧' ? { frameBeat: 'pause' } : { frameBeat: 'pause', long: true }); // the page reached it, her voice quiet
    assert.deepEqual(h.sequence.holding, { word: 'pause', phase: 'pause' });
    h.clock.advance(ms - 1); await flush();
    assert.equal(s.shown(), '我想想。', `${marker}: still quiet just before ${ms} ms`);
    h.clock.advance(1); await flush();
    assert.equal(s.shown(), '我想想。嗯，好。', `${marker}: her words go on after ${ms} ms`);
    assert.deepEqual(h.caps, []);
  }
  assert.equal(pauseSeconds(false), 2); assert.equal(pauseSeconds(true), 4);
});

test('the page: a pause is told to the host once her voice is quiet (the words before it said), a let-go at once; nothing of another reply is told late', async () => {
  const lens = laptopLens(), home = { x: 0, z: -0.85 }, body = { sense: {} as never, setPoseTargets() {} }, gates = { shown: true, asleep: false, armsHeld: false };
  const gen = { id: 'fake', generate: (_: MotionRequest) => ({ ...REST_TARGETS }), reset() {} } as never;
  const told: unknown[] = []; let speaking = true;
  const player = new UnboundSpeechBeats(gen, () => {}, () => 'play', null, { ask: ask => { told.push(ask); }, quiet: () => !speaking });
  player.receive({ id: 'r1', type: 'beats', speechBeats: { beats: [{ word: 'hug', at: 0 }, { word: 'pause', at: 4, how: 'long' }, { word: 'let-go', at: 6 }] } } as unknown as UnboundBubble);
  player.receive({ id: 'r1', type: 'delta', text: '我想想。', rev: 1 } as UnboundBubble);
  for (let i = 0; i < 10; i++) player.frame(1 / 60, lens, home, body, false, gates); // the walk-up has her: frames are still reached
  assert.deepEqual(told, [], 'her voice is still saying the words before it');
  speaking = false; player.frame(1 / 60, lens, home, body, false, gates);
  assert.deepEqual(told, [{ frameBeat: 'pause', long: true }], 'quiet: the pause is told');
  player.receive({ id: 'r1', type: 'delta', text: '好啦，放开你。', rev: 2 } as UnboundBubble);
  player.frame(1 / 60, lens, home, body, false, gates);
  assert.deepEqual(told.at(-1), { frameBeat: 'let-go' }, 'a let-go is told at once');
  assert.ok(player.played.includes('pause') && player.played.includes('let-go'), `${player.played}`);
  const stale = new UnboundSpeechBeats(gen, () => {}, () => 'play', null, { ask: ask => { (told as unknown[]).push(ask); }, quiet: () => false });
  stale.receive({ id: 'a', type: 'beats', speechBeats: { beats: [{ word: 'pause', at: 0 }] } } as unknown as UnboundBubble);
  stale.receive({ id: 'b', type: 'delta', text: '新的一条。', rev: 1 } as UnboundBubble);
  const before = told.length; stale.frame(1 / 60, lens, home, body, true, gates);
  assert.equal(told.length, before, 'a new reply began: the old pause is dropped, never told');
  assert.deepEqual(parseFrameBeatAsk({ frameBeat: 'pause', long: true }), { frameBeat: 'pause', long: true });
  for (const bad of [{ frameBeat: 'hug' }, { frameBeat: 'pause', long: false }, { frameBeat: 'let-go', extra: 1 }, null, []]) assert.equal(parseFrameBeatAsk(bad), null);
});

test('⟦let-go⟧ reaches her body only while a kiss / hug of her reply plays (the host relays it with the performance id); the page parses only these shapes', () => {
  const h = host();
  h.peek.report({ frameBeat: 'let-go' });
  assert.equal(h.sent.length, 0, 'nothing plays: nothing to relay');
  assert.equal(h.peek.report({ closeBeat: 'hug' }), 'play');
  const id = h.start().id;
  h.play(id, ['notice', 'walk', 'lean', 'hold']);
  h.peek.report({ frameBeat: 'let-go' }); h.peek.report({ frameBeat: 'pause' });
  assert.deepEqual(h.sent.slice(1), [{ type: 'frame', id, frame: 'let-go', seconds: 0 }, { type: 'frame', id, frame: 'pause', seconds: 2 }]);
  assert.deepEqual(parsePeekSideCommand({ type: 'frame', id, frame: 'pause', seconds: 99 }), { type: 'frame', id, frame: 'pause', seconds: 12 }, 'bounded');
  assert.equal(parsePeekSideCommand({ type: 'frame', id, frame: 'kiss', seconds: 1 }), null);
  assert.deepEqual(parsePeekSideCommand({ type: 'cancel', id, reason: 'pull' }), { type: 'cancel', id, reason: 'pull' });
});

test('her hold with frames: a let-go ends it at its place (written before she arrived: after the floor); a pause holds her through it; with neither, once her words and her own length are done; the cap always holds', () => {
  const plain = new HoldFrames();
  assert.equal(plain.goesOn(true, 3, 3), true, 'she is speaking: on');
  assert.equal(plain.goesOn(false, 3, 3), false, 'her words done and her own length passed: she lets go');
  const inHold = new HoldFrames(); inHold.letGo(0.5);
  assert.equal(inHold.goesOn(true, 0.49, 0.49), true); assert.equal(inHold.goesOn(true, 0.5, 0.5), false, 'at her let-go, even while she speaks on');
  const early = new HoldFrames(); early.letGo(null);
  assert.equal(early.goesOn(true, ARRIVAL_KNOBS.closeHoldMinS - 0.01, 1), true); assert.equal(early.goesOn(true, ARRIVAL_KNOBS.closeHoldMinS, 1), false, 'on her way: the floor, then she lets go');
  const paused = new HoldFrames(); paused.keep(10, 4);
  assert.equal(paused.goesOn(false, 5, 13.9), true, 'a pause: she holds through it'); assert.equal(paused.goesOn(false, 5, 14), false);
  assert.equal(paused.goesOn(true, ARRIVAL_KNOBS.holdCapS, 11), false, 'the cap');
});

test('a kiss: her words go on while she walks, stop by themselves while her lips are on (the voice starts no new sentence either), and resume as she pulls back', async () => {
  const h = host(), s = stream(h.sequence);
  s.input('delta', '闭上眼睛，⟦kiss⟧我过来了。');
  await flush();
  assert.equal(s.shown(), '闭上眼睛，我过来了。', 'on her way: her words go on');
  assert.equal(h.peek.report({ closeBeat: 'kiss' }), 'play');
  const id = h.start().id;
  h.play(id, ['notice', 'walk', 'lean', 'hold']);
  assert.deepEqual(h.contact, [true], 'her lips on: the bubble that follows her voice stops its clocks');
  const quiet = h.bubble.quiet(); // what the read-aloud's next piece awaits (electron/wiring/voice-wiring.ts)
  assert.ok(quiet, 'the read-aloud\'s next sentence waits');
  let resumed = false; void quiet!.then(() => { resumed = true; });
  s.input('delta', '嗯……亲到了。'); void s.end(); await flush();
  assert.equal(s.shown(), '闭上眼睛，我过来了。', 'what comes now waits: her mouth is busy');
  h.play(id, ['back']); await flush();
  assert.equal(s.shown(), '闭上眼睛，我过来了。', 'still: she is only just leaving');
  h.play(id, ['settle']); await flush();
  assert.equal(s.shown(), '闭上眼睛，我过来了。嗯……亲到了。', 'she pulled back: her words resume');
  assert.equal(resumed, true); assert.deepEqual(h.contact, [true, false]);
  assert.equal(h.bubble.quiet(), null);
  const capped = host(); capped.sequence.asked('kiss', 'play'); capped.sequence.held('kiss');
  capped.clock.advance(CLOSE_SEQUENCE_CAPS.actionMs); assert.equal(capped.sequence.inContact, false, 'a contact never outlasts the cap');
});

// ---- interrupted ------------------------------------------------------------------------------------------------------------------------------

/** The moments host with only what the immediate turn needs (as tests/i188-moments.test.ts). */
function moments(notice: CloseCutNotice, state: { typing: boolean }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'i203-moments-')), asks: string[] = [], journal: MomentJournalRow[] = [], cues: string[] = [];
  let serial = 0;
  const ports: MomentHostPorts = {
    clock: () => Date.UTC(2026, 10, 24, 6, 0), random: () => 0, createId: () => `m${++serial}`, characterId: () => 'gene', localMinute: () => 14 * 60,
    enabled: () => true, typing: () => state.typing, call: () => false, asleep: () => false, visible: () => true, presence: () => null, idleSeconds: () => 5,
    lastInteractionAt: () => null, nightKey: () => 'n', restUsed: () => true, state: new MomentStateStore(() => path.join(dir, 's.json')),
    askSpeech: mode => { asks.push(mode); const cue = { id: `cue${asks.length}`, kind: 'speech' }; const claim = host.claims(cue); if (claim) { cues.push(cue.id); claim.put('inner'); } return true; },
    closeCut: notice, journal: row => { journal.push(row); },
  };
  const host = new MomentHost(ports);
  return { host, asks, journal, cues, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('pulled away during her hug: the reply is cut (words and frames stop; archived once, whole, with the cut record: pulled-away); exactly one immediate turn with the facts and no wording', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'i203-cut-'));
  try {
    const h = host(), beats = new SpeechBeatsHost(dir), notice = new CloseCutNotice();
    beats.sequence(h.sequence); beats.heardCut((event, cut, text) => notice.cut(event, cut, text));
    const s = stream(h.sequence);
    const scope = { characterId: 'gene', providerScope: 'p' };
    s.turn.onCut = (cut, event, text) => beats.fileCut(scope, 'turn-1', cut, event, text);
    s.input('delta', '来，⟦hug⟧我走过去啦。你等等我'); s.input('delta', '⟦hug-held⟧抱住你以后想说的话。⟦let-go⟧最后一句。');
    let ended = false; void s.end().then(() => { ended = true; });
    await flush();
    assert.equal(h.peek.report({ closeBeat: 'hug' }), 'play');
    const id = h.start().id;
    h.play(id, ['notice', 'walk', 'lean']);
    h.present(6); // her bubble showed "来，我走过去啦" (and her voice read it) when the pull came
    h.peek.report({ id, phase: 'back', cancelled: 'pull' }); h.peek.report({ id, phase: 'back', cancelled: 'pull' });
    await flush();
    assert.deepEqual(h.cuts, [{ kind: 'hug', frame: 'walking', cause: 'pulled-away' }], 'one cut: the wiring stops her bubble and her reading here');
    assert.deepEqual(h.told, ['hug:pull'], 'the journal row and the short line, once');
    assert.equal(ended, true, 'nothing waits any more');
    const whole = '来，我走过去啦。你等等我抱住你以后想说的话。最后一句。';
    assert.equal(s.shown(), whole, 'the rest still reaches the reply (the chat window and the archive keep it whole); the bubble and the voice were stopped');
    const outcome = s.turn.complete(s.shown());
    assert.ok(outcome.history?.includes('最后一句'), 'her history: the whole reply');
    assert.deepEqual(beats.archive.get(scope, 'turn-1')?.cut, { cause: 'pulled-away', known: true, saidEnd: 0, sentenceEnd: 6 }, 'the generic cut record: where (the sentence she was in) and why');
    s.turn.complete(s.shown());
    const one = moments(notice, { typing: false });
    try {
      one.host.tick();
      assert.deepEqual(one.asks, ['promise'], 'one immediate turn: only the hard state (not her autonomous behaviour: no cooldown)');
      const line = one.host.promptLine('gene');
      for (const fact of ['走过去抱用户', '用户用鼠标把你拉开了', '正在说的这一句', '「来，我走过去」', '还没说出来的', '啦。你等等我抱住你以后想说的话。最后一句。']) assert.ok(line.includes(fact), `the facts: ${fact} in ${line}`);
      for (const word of STEERING) assert.ok(!line.includes(word), `no wording, no how to react: "${word}" in ${line}`);
      one.host.done(one.cues[0]!, true);
      assert.deepEqual(one.journal.at(-1), { characterId: 'gene', kind: 'close-cut', outcome: 'spoke' });
      for (let i = 0; i < 5; i++) one.host.tick();
      assert.equal(one.asks.length, 1, 'never twice for one moment');
      assert.equal(notice.turnLine(), '', 'and her next chat turn does not hear it again');
    } finally { one.done(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the usual case: her words streamed and the reply completed long before she walked; pulled away while holding: the record is filed then, against the archived reply; a newer reply\'s moment is never this one\'s', async () => {
  const h = host(), notice = new CloseCutNotice(), s = stream(h.sequence);
  const filed: { cut: unknown; text: string }[] = [];
  s.turn.onCut = (cut, event, text) => { filed.push({ cut, text }); notice.cut(event, cut, text); };
  s.input('delta', '好呀⟦hug⟧，我过来抱你。抱住你就不想放开了。'); const ended = s.end();
  assert.equal(h.peek.report({ closeBeat: 'hug' }), 'play');
  const id = h.start().id;
  h.play(id, ['notice', 'walk', 'lean', 'hold']);
  await ended; // 2026-11-25: the sentence after the hug's own came once she held
  s.turn.complete(s.shown()); // archived once, whole
  assert.deepEqual(filed, [], 'nothing cut yet');
  h.present(9); // her bubble (following her voice) showed up to "…我过来抱你。"
  h.peek.report({ id, phase: 'back', cancelled: 'pull' });
  assert.deepEqual(h.cuts, [{ kind: 'hug', frame: 'holding', cause: 'pulled-away' }]);
  assert.deepEqual(filed, [{ cut: { cause: 'pulled-away', known: true, saidEnd: 9, sentenceEnd: 9 }, text: '好呀，我过来抱你。抱住你就不想放开了。' }], 'filed at once: her words stopped between two sentences');
  assert.ok(notice.take()?.line.includes('你正抱着用户'), 'her one immediate turn has the facts');
  // A newer reply began while the older hug still played: pulling that hug away is not the new reply's interruption.
  const older = host(), first = stream(older.sequence);
  first.input('delta', '⟦hug⟧来啦。'); await first.end(); first.turn.complete(first.shown());
  older.peek.report({ closeBeat: 'hug' }); const oid = older.start().id; older.play(oid, ['notice', 'walk']);
  const second = stream(older.sequence), cuts: unknown[] = []; second.turn.onCut = cut => cuts.push(cut);
  second.input('delta', '新的一条。'); await second.end();
  older.peek.report({ id: oid, phase: 'back', cancelled: 'pull' });
  assert.deepEqual(older.cuts, [], 'the new reply\'s bubble and voice are left alone');
  second.turn.complete(second.shown()); assert.deepEqual(cuts, []);
});

test('the user already has a message in flight: no immediate turn; the facts go into that next turn instead (once); her face could not reach: could-not-reach', async () => {
  const h = host(), notice = new CloseCutNotice(), s = stream(h.sequence);
  const filed: string[] = [];
  s.turn.onCut = (cut, event, text) => { filed.push(cut.cause); notice.cut(event, cut, text); };
  s.input('delta', '⟦kiss⟧过来亲你一下。'); void s.end(); await flush();
  assert.equal(h.peek.report({ closeBeat: 'kiss' }), 'play');
  const id = h.start().id;
  h.play(id, ['notice', 'walk', 'lean']);
  h.peek.report({ id, phase: 'back', cancelled: 'unreached' });
  assert.deepEqual(h.cuts, [{ kind: 'kiss', frame: 'walking', cause: 'could-not-reach' }]);
  s.turn.complete(s.shown());
  assert.deepEqual(filed, ['could-not-reach']);
  const busy = { typing: true }, m = moments(notice, busy);
  try {
    for (let i = 0; i < 3; i++) m.host.tick();
    assert.deepEqual(m.asks, [], 'a chat turn is under way / the user is typing: no immediate turn');
    assert.equal(m.host.view(), null, 'not even taken: the facts stay for that next turn (nothing started, nothing journaled)'); assert.deepEqual(m.journal, []);
    const line = notice.turnLine();
    assert.ok(line.includes('你的脸够不到用户跟前') && line.includes('过来亲你一下'), line);
    assert.equal(notice.turnLine(), '', 'once');
    busy.typing = false; for (let i = 0; i < 3; i++) m.host.tick();
    assert.deepEqual(m.asks, [], 'and never afterwards either');
  } finally { m.done(); }
  // Taken for the immediate turn, but the user's message came first: that turn hears it, the immediate one never goes ahead.
  const late = new CloseCutNotice(), n = moments(late, { typing: false });
  try {
    late.cut({ kind: 'hug', frame: 'holding', cause: 'pulled-away' }, { cause: 'pulled-away', known: true, saidEnd: 0, sentenceEnd: 2 }, '嗯嗯，抱着你。');
    const taken = late.take(); assert.ok(taken);
    assert.ok(late.turnLine().includes('你正抱着用户'));
    assert.equal(late.live(taken!.id), false);
    assert.equal(late.take(), null, 'never twice');
  } finally { n.done(); }
  // Immediate means immediate: past CLOSE_CUT_TIMING.immediateMs no turn of its own starts; the next chat turn still hears it.
  let now = 0; const slow = new CloseCutNotice({ clock: () => now });
  slow.cut({ kind: 'hug', frame: 'walking', cause: 'pulled-away' }, { cause: 'pulled-away', known: true, saidEnd: 0, sentenceEnd: 0 }, '嗯。');
  assert.equal(slow.waiting, true); now = CLOSE_CUT_TIMING.immediateMs + 1;
  assert.equal(slow.waiting, false); assert.equal(slow.take(), null); assert.ok(slow.turnLine().includes('用户用鼠标把你拉开了'));
});

test('the facts line, zh and en: what happened, where, why, her words; nothing about what to say or how to react', () => {
  const facts: CloseCutFacts = { kind: 'hug', frame: 'holding', cause: 'pulled-away', said: '我抱着你，', sentence: '想和你说', rest: '一件很重要的事。' };
  const zh = closeCutLine(facts, 'zh-CN'), en = closeCutLine(facts, 'en');
  assert.match(zh, /你正抱着用户，用户用鼠标把你拉开了/); assert.match(zh, /「我抱着你，」/); assert.match(zh, /「想和你说」/); assert.match(zh, /「一件很重要的事。」/);
  assert.match(en, /you were hugging the user, and the user pulled you away with the mouse/); assert.match(en, /Not said yet/);
  for (const text of [zh, en]) for (const word of STEERING) assert.ok(!text.includes(word), `"${word}" in ${text}`);
  assert.equal(closeCutLine({ ...facts, cause: 'other' as never }), '', 'only the two causes of a close moment');
  assert.equal(momentPromptLine({ kind: 'close-cut', facts: { closeCut: zh } }), zh, 'the moment line is the facts line');
});

test('her bubble on a cut: it keeps what it shows and ends; nothing more of that reply reaches it; the next reply shows as usual', () => {
  const sent: { id: string; type: string; text: string }[] = [];
  const hold = new UnboundBubbleHold({ emit: e => sent.push({ ...e }), now: () => 0, setTimer: () => 0, clearTimer: () => {} });
  assert.equal(hold.take({ id: 'r1', type: 'delta', text: '来，我走过去啦。' }), false, 'not following the voice: shown as it comes');
  assert.equal(hold.cut(), null, 'shown as it came: everything given out so far was shown');
  assert.deepEqual(sent, [{ id: 'r1', type: 'done', text: '' }], 'the bubble ends (it lingers, then fades)');
  assert.equal(hold.take({ id: 'r1', type: 'delta', text: '后面的话。' }), true, 'later words of the cut reply never reach her bubble');
  assert.equal(hold.take({ id: 'r1', type: 'done', text: '' }), true);
  assert.equal(hold.take({ id: 'r2', type: 'delta', text: '新的。' }), false, 'a new reply: as usual');
});
