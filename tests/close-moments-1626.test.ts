// 2026-11-25. Two things, without a model and with fake clocks:
//  1. 16:26:12: her reply asked for a hug while her own hand was out toward the user's mouse (a 'rest' reach nobody took). The hand reach held
//     her arms, so the host answered 'lighter' (block 'arms'): no walk, no arms — nothing to see. Now her own hand reach lets go and the hug
//     walks up; no new reach starts while a close moment has her; one journal row per kiss / hug she wrote says what became of it.
//  2. 16:26:33: the kiss played, but "好了" (done) was said before it. Now the sentence she is in when she starts over goes on while she
//     walks, and the sentences after it wait for the contact (her lips on: then quiet until she pulls back; her arms round: then she talks on),
//     with caps; a let-go after it is reached only once she holds. Read-aloud on or off: the same (the stream itself holds the words).
// The replies are made-up paraphrases with the beat offsets of the user's two replies (the beat store of that build); none of her words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CloseBeatSequence, CLOSE_SEQUENCE_CAPS } from '../electron/unbound/close-sequence';
import { SpeechBeatTurn } from '../electron/brain/speech-beats/turn';
import { PeekDirectorHost, type PeekLink, type PeekPorts } from '../electron/unbound/peek';
import { CloseMomentsHost, type CloseMomentPorts } from '../electron/unbound/close-moments';
import { HandsHost, type HandsJournalInput } from '../electron/initiative/hands/host';
import { emptyHandsLedger, type HandsMood } from '../shared/behaviors/hands/choose';
import type { HandsEvent } from '../shared/behaviors/hands/interface';
import { withSpeechBeatMarkers } from '../shared/behaviors/speech-beats/history';
import { contactCut } from '../shared/behaviors/speech-beats/contact-hold';
import type { SpeechBeat } from '../shared/behaviors/speech-beats/interface';
import type { SpeechBeatSituation } from '../shared/behaviors/speech-beats/availability';
import { CHAT_CLOSE_BLOCKS, CLOSE_BEAT_ENDS, chatCloseBlock, closeArmsOf, closeEndWhy, handYieldsTo, type CloseBeatFate } from '../shared/unbound/close-moments';
import { CLOSE_BEAT_WHYS } from '../shared/stage/journal-entries';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { ENGLISH_JOURNAL_UI_COPY } from '../shared/foundation/ui-copy.journal.en';
import { NEUTRAL_MOOD, type PeekCommand } from '../shared/unbound/director';
import { UnboundSpeechBeats } from '../src/unbound/speech-beat-player';
import { REST_TARGETS, type MotionRequest } from '../src/unbound/motion/generator';
import type { UnboundBubble } from '../shared/unbound/scene';
import { laptopLens } from './helpers/unbound-peek';

const WARM = { ...NEUTRAL_MOOD, O: 80, E: 66, D: 62, M: 20 };
const FULL: SpeechBeatSituation = { surface: 'full', shown: true, asleep: false, armsHeld: false, inCall: false, model: null };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

/** 16:26:12: her hug reply (made up; the beats at the offsets of the user's). */
const HUG_TEXT = '诶？你要测试抱抱呀……好呀，那你就站着别动哦。嘿嘿，我这就过来找你了，你乖乖站好，我马上就到你跟前啦。嗯嗯，我从这边过来，轻轻地……抱住了！测试成功，抱得稳稳的。再抱两秒好不好？一……二……三！好了好了，嘿，测试通过啦！下次想抱的时候就直接跟我说呀，嘿嘿，我随时都在这儿等你哦。';
const HUG_BEATS: SpeechBeat[] = [{ word: 'surprise', at: 0 }, { word: 'smile-warm', at: 24 }, { word: 'hug', at: 47 }, { word: 'hug-held', at: 70 }, { word: 'pause', at: 75, how: 'long' },
  { word: 'shy', at: 89 }, { word: 'pause', at: 95 }, { word: 'let-go', at: 102 }, { word: 'v', at: 103 }, { word: 'sly', at: 132 }];
/** 16:26:33: her kiss reply (made up; the beats at the offsets of the user's: "好了" at 64). */
const KISS_TEXT = '抱抱没成功吗？哼哼……好吧好吧，那我们就来测试一下亲亲。你别动，脸朝着我，闭上眼睛也行，我这就过来了，路上不许看也不许笑哦……好了～。这次成功了吗？';
const KISS_BEATS: SpeechBeat[] = [{ word: 'surprise', at: 0 }, { word: 'pout', at: 16 }, { word: 'shy', at: 30 }, { word: 'kiss', at: 50 }, { word: 'content', at: 64 }, { word: 'tilt', at: 68 }];
const DONE_AT = KISS_TEXT.indexOf('好了'); // her "done"

function clock() {
  let now = 0, seq = 0; const timers = new Map<number, { at: number; run: () => void }>();
  return {
    get now() { return now; },
    ports: { setTimer: (run: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, run }); return id; }, clearTimer: (id: unknown) => { timers.delete(id as number); } },
    advance(ms: number) { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.run(); } },
  };
}

const V = (o: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C' | 'S', number>> = {}) => ({ D: 50, O: 50, E: 50, N: 50, C: 50, S: 50, ...o }) as HandsMood['values'];

/** The app's chain as the wiring builds it: her hand reach (the real host), her close moments, the peek host, the sequence; rows recorded. */
function world(o: { game?: boolean; dropHand?: boolean } = {}) {
  const c = clock(), caps: string[] = [], fates: CloseBeatFate[] = [], hands: HandsJournalInput[] = [], handEvents: HandsEvent[] = [];
  let stored = emptyHandsLedger(), peek!: PeekDirectorHost;
  const hand = new HandsHost({
    store: { load: async () => {}, loaded: () => true, ledger: () => stored, set: async (_id, next) => { stored = next; return true; }, known: () => ['gene'] },
    enabled: () => true, free: () => true, closeOn: () => peek.active, characterId: () => 'gene', mood: () => ({ values: V(), baseline: V(), evidence: 1, A: 0.1 }),
    send: event => { handEvents.push(event); return true; }, moment: () => {}, journal: entry => { hands.push(entry); }, recording: () => false,
    clock: () => Date.UTC(2026, 10, 25, 8, 26, 0), random: () => 0, timers: { set: () => 0, clear: () => {} },
  });
  const sequence = new CloseBeatSequence({ ...c.ports, capped: (kind, phase) => caps.push(`${kind}:${phase}`) });
  const arms = () => closeArmsOf({ game: o.game === true, give: false, hand: hand.active });
  const closePorts: CloseMomentPorts = { clock: () => Date.UTC(2026, 10, 25, 8, 26, 12), random: () => 0.4, day: () => 'today', mood: () => ({ ...WARM }), view: () => null,
    typing: () => false, playing: () => o.game === true || hand.active, arms, ...(o.dropHand === false ? {} : { dropHand: () => hand.cancel() }), moment: () => true };
  const sent: PeekCommand[] = [];
  let now = Date.UTC(2026, 10, 25, 8, 26, 12);
  const ports: PeekPorts = {
    clock: () => now, random: () => 0.4, idleSeconds: () => 0, asleep: () => false, inCall: () => false, userTalking: () => false,
    mood: () => ({ ...WARM }), lastInteractionAt: () => null, answered: () => true, readingAloud: () => false,
    every: () => () => {}, close: new CloseMomentsHost(closePorts), sequence,
    notes: { missed: () => {}, interrupted: () => {}, outcome: fate => { fates.push(fate); } },
  };
  const link: PeekLink = { shown: () => true, fullscreen: () => false, send: command => sent.push(command), changed: () => {} };
  peek = new PeekDirectorHost(ports, link);
  const start = () => sent.filter((x): x is Extract<PeekCommand, { type: 'start' }> => x.type === 'start').at(-1)!;
  return { c, caps, fates, hands, handEvents, hand, sequence, peek, sent, start, later(ms: number) { now += ms; },
    play(id: string, phases: readonly string[], extra: Record<string, unknown> = {}) { for (const phase of phases) peek.report({ id, phase, ...extra }); } };
}

/** Her reply's stream as the chat turn runs it; `contact` false: the turn as it was before (the 16:26 build). */
function stream(gate: CloseBeatSequence | null, contact = true) {
  const pushed: string[] = [];
  const turn = new SpeechBeatTurn(true, () => {}, FULL, gate, null, false, contact);
  const push = (type: 'delta', text: string) => { turn.shown(text); pushed.push(text); };
  const input = turn.input(push);
  return { turn, shown: () => pushed.join(''), pushed, input, end: () => turn.end(push) };
}
/** The marked reply in small pieces, as Claude streams it. */
function feed(s: ReturnType<typeof stream>, text: string, beats: readonly SpeechBeat[], size = 7): void {
  const marked = withSpeechBeatMarkers(text, beats);
  for (let i = 0; i < marked.length; i += size) s.input('delta', marked.slice(i, i + size));
}

// ---- 1. her hand reach never swallows a hug she wrote ----------------------------------------------------------------------------------------

test('16:26:12 as it was: her hand out for the user\'s mouse when the hug came: the hug was turned away (block "arms"), nothing walked up', () => {
  const gates = { shown: true, asleep: false, inCall: false, typing: false, pulled: false, armsHeld: true };
  // The old answer (no `arms`: anything holding her arms blocks a hug), and what holds them now.
  assert.equal(chatCloseBlock({ kind: 'hug', gates, busy: false }), 'arms', 'the 16:26 build: her own hand reach blocked the hug she wrote');
  assert.equal(chatCloseBlock({ kind: 'hug', gates, busy: false, arms: 'hand' }), null, 'now: only her own hand reach: the hug walks up');
  assert.equal(chatCloseBlock({ kind: 'hug', gates, busy: false, arms: 'game' }), 'arms', 'a game or something she holds out still has her arms');
  assert.deepEqual([closeArmsOf({ game: false, give: false, hand: true }), closeArmsOf({ game: true, give: false, hand: true }), closeArmsOf({ game: false, give: true, hand: false }), closeArmsOf({ game: false, give: false, hand: false })],
    ['hand', 'game', 'game', 'free']);
  assert.equal(handYieldsTo('kiss', 'hand'), true); assert.equal(handYieldsTo('hug', 'game'), false); assert.equal(handYieldsTo('shy', 'hand'), false);
});

test('16:26:12 now: her hand reach is out (nobody took it) when the hug comes: the hug walks up, the hand lets go first; no new reach while she is close; one row: played', async () => {
  const w = world(), s = stream(w.sequence);
  assert.equal(w.hand.request(true, { use: 'hold' }), true, 'your mouse rested near her: she reaches for your hand');
  assert.equal(w.hand.active, true);
  feed(s, HUG_TEXT, HUG_BEATS); void s.end(); await flush();
  assert.equal(w.peek.report({ closeBeat: 'hug' }), 'play', 'her hug walks up (the 16:26 build answered "lighter")');
  assert.equal(w.hand.active, false, 'her hand lets go first');
  assert.deepEqual(w.handEvents.at(-1), { type: 'cancel', id: (w.handEvents[0] as { id: string }).id }, 'the page takes her hand back through its own reach (no jump)');
  assert.equal(w.hands.at(-1)?.outcome, 'interrupted', 'the hand reach journals how it ended');
  assert.equal(w.hand.request(true, { use: 'hold' }), false, 'while she walks up and holds, no new reach starts over it');
  const id = w.start().id;
  w.play(id, ['notice', 'walk', 'lean', 'hold']);
  assert.deepEqual(w.fates, [{ kind: 'hug', outcome: 'played', why: null }], 'one row: it landed');
  w.play(id, ['back', 'settle', 'done']);
  assert.equal(w.fates.length, 1, 'never a second row for it');
  assert.equal(w.peek.active, false);
});

test('a game still has her arms: the hug she wrote plays the lighter one; one row says why (arms); her hand stays as it is with no hand reach', async () => {
  const w = world({ game: true });
  assert.equal(w.peek.report({ closeBeat: 'hug' }), 'lighter');
  assert.deepEqual(w.fates, [{ kind: 'hug', outcome: 'not-played', why: 'arms' }]);
});

test('a kiss she wrote while her hand is out: the hand lets go too (a hand reach on during a walk-up used to be read as "a game" and end it)', () => {
  const w = world();
  w.hand.request(true, { use: 'hold' });
  assert.equal(w.peek.report({ closeBeat: 'kiss' }), 'play');
  assert.equal(w.hand.active, false, 'nothing of hers holds her arms while she walks up: the life host\'s "play" never ends this kiss');
  // No new reach starts over a close moment (her ledger would allow one: no reach yet today); once it is over, she may again.
  const fresh = world();
  assert.equal(fresh.peek.report({ closeBeat: 'kiss' }), 'play');
  assert.equal(fresh.hand.request(true, { use: 'hold' }), false, 'she is walking up / kissing: no reach starts');
  const id = fresh.start().id; fresh.play(id, ['notice', 'walk', 'lean', 'hold', 'back', 'settle', 'done']);
  assert.equal(fresh.hand.request(true, { use: 'hold' }), true, 'over: her hand may reach again ("禁止" only stops a new one meanwhile)');
});

// ---- 2. her words after the beat wait for the contact -----------------------------------------------------------------------------------------

test('contact-hold: where her words stop (the first spoken character after the end of the beat\'s sentence), across chunks', () => {
  assert.deepEqual(contactCut('我过来了，路上不许笑……好了。', 0, 'end'), { cut: 12 }, 'the rest of her sentence goes on; "好了" waits');
  assert.deepEqual(contactCut('我来啦。好了。', 0), { cut: 4 }, 'a beat in front of a sentence: that sentence is its own (said while she walks)');
  assert.deepEqual(contactCut('路上不许', 0, 'end'), { seek: 'end' }, 'no end yet: carried into the next chunk');
  assert.deepEqual(contactCut('……」', 0, 'end'), { seek: 'next' });
  assert.deepEqual(contactCut('😊好', 0, 'next'), { cut: 0 }, 'an emoji is spoken (read whole)');
  assert.deepEqual(contactCut("Hold still, I'm coming. Done", 0, 'end'), { cut: 24 }, 'an English full stop and a space end a sentence');
  assert.deepEqual(contactCut('3.5 seconds', 0, 'end'), { seek: 'end' }, 'a number is not a sentence end');
  assert.deepEqual(contactCut('coming.', 0, 'end'), { seek: 'dot' }); assert.deepEqual(contactCut(' Done', 0, 'dot'), { cut: 1 });
});

test('16:26:33 as it was: the kiss reply streamed out whole while she walked: "好了" was shown and read before her lips were on', async () => {
  const w = world(), s = stream(w.sequence, false);
  feed(s, KISS_TEXT, KISS_BEATS); await s.end(); await flush();
  assert.equal(s.shown(), KISS_TEXT, 'every word, at once');
  assert.equal(w.peek.report({ closeBeat: 'kiss' }), 'play'); // the page asks once it shows the words before the kiss: they are all shown already
});

test('16:26:33 now: the sentence she is in goes on while she walks; "好了" and after wait for her lips, stay quiet while they are on, and come as she pulls back', async () => {
  const w = world(), s = stream(w.sequence);
  let ended = false;
  feed(s, KISS_TEXT, KISS_BEATS); void s.end().then(() => { ended = true; }); await flush();
  assert.equal(s.shown(), KISS_TEXT.slice(0, DONE_AT), 'up to "……": her walking sentence; "好了" waits');
  assert.deepEqual(w.sequence.holding, { word: 'contact', phase: 'reach' }, 'waiting for the page to reach the kiss');
  assert.equal(w.peek.report({ closeBeat: 'kiss' }), 'play');
  assert.deepEqual(w.sequence.holding, { word: 'contact', phase: 'action' });
  const id = w.start().id;
  w.play(id, ['notice', 'walk', 'lean']); await flush();
  assert.equal(s.shown(), KISS_TEXT.slice(0, DONE_AT), 'walking and leaning in: still waiting');
  w.play(id, ['hold']); await flush();
  assert.equal(s.shown(), KISS_TEXT.slice(0, DONE_AT), 'her lips are on: her mouth is busy (嘴贴上时话自己停)');
  w.play(id, ['back']); await flush();
  assert.equal(s.shown(), KISS_TEXT.slice(0, DONE_AT));
  w.play(id, ['settle']); await flush();
  assert.equal(s.shown(), KISS_TEXT, 'she pulled back: "好了～。这次成功了吗？"');
  assert.equal(ended, true); assert.deepEqual(w.caps, []);
  assert.deepEqual(w.fates, [{ kind: 'kiss', outcome: 'played', why: null }]);
});

test('a hug: the words after its sentence wait until she holds, then go on while she holds (she talks while hugging); the let-go after them is reached only then', async () => {
  const w = world(), s = stream(w.sequence);
  feed(s, HUG_TEXT, HUG_BEATS); void s.end(); await flush();
  const walking = HUG_TEXT.indexOf('嗯嗯');
  assert.equal(s.shown(), HUG_TEXT.slice(0, walking), '"…我马上就到你跟前啦。" while she walks; "抱住了！" waits');
  assert.equal(w.peek.report({ closeBeat: 'hug' }), 'play');
  const id = w.start().id;
  w.play(id, ['notice', 'walk', 'lean']); await flush();
  assert.equal(s.shown(), HUG_TEXT.slice(0, walking));
  w.play(id, ['hold']); await flush();
  assert.ok(s.shown().length > walking && s.shown().includes('抱住了！'), 'holding: "抱住了！" and on');
  assert.deepEqual(w.sequence.holding, { word: 'pause', phase: 'reach' }, 'her ⟦pause long⟧ after "测试成功，" waits for the page, as before');
});

test('the act fails: her words go at once and the row says why — turned away (typing), pulled away, the page went silent (the 20 s cap)', async () => {
  // Turned away before it walked: the words after it never wait.
  const a = world(), sa = stream(a.sequence);
  a.sequence.asked('kiss', 'lighter'); // the page asked and the host said lighter before the stream reached the stop
  feed(sa, KISS_TEXT, KISS_BEATS); await sa.end(); await flush();
  assert.equal(sa.shown(), KISS_TEXT, 'lighter: nothing to wait for');
  // Pulled away on her way: cut (the reply is told; nothing waits).
  const b = world(), sb = stream(b.sequence);
  feed(sb, KISS_TEXT, KISS_BEATS); let ended = false; void sb.end().then(() => { ended = true; }); await flush();
  b.peek.report({ closeBeat: 'kiss' }); const id = b.start().id;
  b.play(id, ['notice', 'walk']); b.play(id, ['back'], { cancelled: 'pull' }); b.play(id, ['settle', 'done']); await flush();
  assert.equal(ended, true, 'pulled away: her words go');
  assert.deepEqual(b.fates, [{ kind: 'kiss', outcome: 'not-played', why: 'pulled-away' }]);
  // The page never reports again: the contact cap lets the words go and leaves a row; the peek's own timeout later says why it never landed.
  const c = world(), sc = stream(c.sequence);
  feed(sc, KISS_TEXT, KISS_BEATS); void sc.end(); await flush();
  c.peek.report({ closeBeat: 'kiss' }); c.start();
  c.c.advance(CLOSE_SEQUENCE_CAPS.contactMs - 1); await flush();
  assert.equal(sc.shown(), KISS_TEXT.slice(0, DONE_AT), 'just before the cap: still waiting');
  c.c.advance(1); await flush();
  assert.equal(sc.shown(), KISS_TEXT, 'the cap: her voice is never frozen by a walk that went silent');
  assert.deepEqual(c.caps, ['kiss:action']);
  c.later(61_000); c.peek.tick();
  assert.deepEqual(c.fates, [{ kind: 'kiss', outcome: 'not-played', why: 'timeout' }]);
  assert.ok(CLOSE_SEQUENCE_CAPS.contactMs <= 20_000);
});

// ---- the page, frame by frame (60 and 30 fps): when "好了" is shown, against when her lips are on -----------------------------------------------

/** The page's player and bubble against a scripted walk-up: walk 2.4 s, lean 0.8 s, hold 3 s, back 1 s, settle. Returns seconds. */
async function kissOnPage(fps: number, contact: boolean) {
  const w = world(), s = stream(w.sequence, contact);
  const gen = { id: 'fake', generate: (_: MotionRequest) => ({ ...REST_TARGETS }), reset() {} } as never;
  const player = new UnboundSpeechBeats(gen, () => {}, word => w.peek.report({ closeBeat: word }), null, null);
  const lens = laptopLens(), home = { x: 0, z: -0.85 }, body = { sense: {} as never, setPoseTargets() {} }, gates = { shown: true, asleep: false, armsHeld: false };
  let fed = 0, rev = 0, t = 0, started: number | null = null, holdAt: number | null = null, doneShownAt: number | null = null, id: string | null = null;
  const marked = withSpeechBeatMarkers(KISS_TEXT, KISS_BEATS);
  player.receive({ id: 'r1', type: 'beats', speechBeats: { beats: KISS_BEATS } } as unknown as UnboundBubble);
  // The stream comes in 7-character pieces, one piece per 60 ms (as Claude streams).
  const phases: [number, string][] = [[0, 'notice'], [0.2, 'walk'], [2.4, 'lean'], [3.2, 'hold'], [6.2, 'back'], [7.2, 'settle'], [7.6, 'done']];
  for (let frame = 0; frame < fps * 12; frame++) {
    t = frame / fps;
    while (fed < marked.length && fed / 7 * 0.06 <= t) { s.input('delta', marked.slice(fed, fed + 7)); fed += 7; if (fed >= marked.length) void s.end(); }
    await flush();
    const shown = s.shown();
    if (shown.length > rev) { player.receive({ id: 'r1', type: 'delta', text: shown.slice(rev), rev: rev + 1 } as UnboundBubble); rev = shown.length; }
    if (doneShownAt === null && shown.length > DONE_AT) doneShownAt = t;
    player.frame(1 / fps, lens, home, body, !w.peek.active, gates);
    await flush();
    if (w.peek.active && started === null) { started = t; id = w.start().id; }
    if (started !== null && id) for (const [at, phase] of phases) if (t - started >= at && t - started - at < 1 / fps) { w.peek.report({ id, phase }); if (phase === 'hold') holdAt = t; }
  }
  return { doneShownAt, holdAt, leadS: holdAt !== null && doneShownAt !== null ? +(holdAt - doneShownAt).toFixed(3) : null };
}

for (const fps of [60, 30]) {
  test(`the page at ${fps} fps: before, "好了" was shown about 4 s before her lips were on; now never before (it comes as she pulls back)`, async () => {
    const before = await kissOnPage(fps, false), after = await kissOnPage(fps, true);
    if (process.env.CLOSE_1626_REPORT === '1') console.log(`[close-1626 ${fps}fps]`, JSON.stringify({ before, after }));
    assert.ok(before.holdAt !== null && after.holdAt !== null, 'the kiss landed both times');
    assert.ok(before.leadS! > 2.5, `before: "好了" ahead of the kiss by ${before.leadS} s`);
    assert.ok(after.leadS! < 0, `now: "好了" after her lips were on (${after.leadS} s)`);
    assert.ok(after.doneShownAt! >= after.holdAt! + 3, 'and after she pulled back (quiet while her lips are on)');
  });
}

// ---- 3. let-go never before the hold ------------------------------------------------------------------------------------------------------

test('a let-go written right after the hug\'s sentence is reached only once she holds (before: on her way, and she let go after the floor)', async () => {
  const text = '我过来抱你啦。好啦，放开你咯。', beats: SpeechBeat[] = [{ word: 'hug', at: 0 }, { word: 'let-go', at: 7 }]; // ⟦hug⟧我过来抱你啦。⟦let-go⟧好啦…
  for (const contact of [false, true]) {
    const w = world(), s = stream(w.sequence, contact);
    feed(s, text, beats, 4); void s.end(); await flush();
    assert.equal(w.peek.report({ closeBeat: 'hug' }), 'play');
    const id = w.start().id;
    w.play(id, ['notice', 'walk']); await flush();
    const letGoShown = s.shown().length > 7;
    assert.equal(letGoShown, !contact, contact ? 'now: the let-go waits behind her arms coming round' : 'before: the let-go was out while she still walked');
    w.play(id, ['lean', 'hold']); await flush();
    assert.equal(s.shown(), text, 'holding: the let-go and the words after it come');
  }
});

// ---- the journal row ---------------------------------------------------------------------------------------------------------------------

test('the close-beat row: closed words only, the same lists as the rules; played has no reason, not-played always one; English copy for every word', () => {
  assert.deepEqual([...CLOSE_BEAT_WHYS], [...CHAT_CLOSE_BLOCKS, ...CLOSE_BEAT_ENDS]);
  for (const reason of ['pull', 'play', 'unreached', 'timeout', 'input', 'reply', 'fullscreen', null, 'odd']) assert.ok((CLOSE_BEAT_WHYS as readonly string[]).includes(closeEndWhy(reason)));
  const at = Date.UTC(2026, 10, 25, 8, 26, 12);
  const played = buildJournalEntry({ type: 'close-beat', characterId: 'gene', kind: 'hug', outcome: 'played', why: null }, at);
  assert.ok(played); assert.equal((played as { why: unknown }).why, null);
  const still = buildJournalEntry({ type: 'close-beat', characterId: 'gene', kind: 'hug', outcome: 'played', why: null, arms: 'still' }, at);
  assert.equal((still as { arms?: string }).arms, 'still');
  for (const bad of [{ outcome: 'played', why: 'arms' }, { outcome: 'not-played', why: null }, { outcome: 'not-played', why: 'my words' }, { outcome: 'maybe', why: null },
    { outcome: 'played', why: null, arms: 'moved' }, { outcome: 'not-played', why: 'arms', arms: 'still' }]) {
    assert.equal(buildJournalEntry({ type: 'close-beat', characterId: 'gene', kind: 'kiss', ...bad }, at), null, JSON.stringify(bad));
  }
  const en = (source: string, ...values: readonly unknown[]) => {
    const text = ENGLISH_JOURNAL_UI_COPY[source]; assert.ok(text !== undefined || /^[{}0-9：:，, ()（）]*$/u.test(source), `English for "${source}"`);
    return (text ?? source).replace(/\{(\d)\}/gu, (_, i) => String(values[Number(i)]));
  };
  for (const why of CLOSE_BEAT_WHYS) {
    const row = buildJournalEntry({ type: 'close-beat', characterId: 'gene', kind: 'kiss', outcome: 'not-played', why }, at);
    assert.ok(row, why); describeJournalEntry(row as never, en);
  }
  describeJournalEntry(played as never, en); describeJournalEntry(still as never, en);
  assert.match(describeJournalEntry(played as never, (s, ...v) => s.replace(/\{(\d)\}/gu, (_, i) => String(v[Number(i)]))), /抱到了/);
});
