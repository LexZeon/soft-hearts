// 2026-11-23, the hug that did not happen and the words that came too early (docs/claude/2026-11-22-i185-words-kiss-hug.md, 2026-11-23 section):
//  - "8：41抱抱没成功": a kiss at 08:39:21, her reply's hug at 08:41:21 was turned away silently (the 3-minute chat cooldown; the "typing" gate read
//    the box being open). Now no cooldown blocks what she writes, typing means keystrokes, a block is journaled and told to her next turn.
//  - 10:39 "连凑近都没动": lean-in + hug at the very start of her reply, a second after the user pressed Enter: the keys of the line she answers
//    never count as typing, and a beat that comes due while something with priority has her waits a moment instead of being dropped.
//  - the words before go first; I-203 (2026-11-24): only the frames she places hold the words after them
//    (⟦hug-held⟧ until she holds, ⟦pause⟧ a moment); the kiss / hug itself no longer holds them (tests/i203-frames.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CloseBeatSequence, CLOSE_SEQUENCE_CAPS } from '../electron/unbound/close-sequence';
import { SpeechBeatTurn } from '../electron/brain/speech-beats/turn';
import { CompletedReplySpeech } from '../electron/voice/completed-reply-speech';
import { PeekDirectorHost, type PeekLink, type PeekPorts } from '../electron/unbound/peek';
import { CloseMomentsHost, type CloseMomentPorts } from '../electron/unbound/close-moments';
import { UnboundHistory } from '../electron/unbound/history-host';
import { UnboundTyping, TYPING_RECENT_MS } from '../electron/unbound/typing';
import { CLOSE_MOMENT_KNOBS, closeMissedLine, type ChatCloseBlock } from '../shared/unbound/close-moments';
import { NEUTRAL_MOOD, type PeekCommand } from '../shared/unbound/director';
import { INSTRUCTION_WORDS } from '../shared/unbound/life/history';
import { speechBeatAvailabilityLine, speechBeatSituationOf } from '../shared/behaviors/speech-beats/availability';
import type { SpeechBeatsEvent } from '../shared/behaviors/speech-beats/interface';
import { UnboundSpeechBeats } from '../src/unbound/speech-beat-player';
import { REST_TARGETS, type MotionRequest } from '../src/unbound/motion/generator';
import type { UnboundBubble } from '../shared/unbound/scene';
import { laptopLens } from './helpers/unbound-peek';

const WARM = { ...NEUTRAL_MOOD, O: 80, E: 66, D: 62, M: 20 };
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

/** Fake timers in ms. */
function clock() {
  let now = 0, seq = 0; const timers = new Map<number, { at: number; run: () => void }>();
  return {
    ports: { setTimer: (run: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, run }); return id; }, clearTimer: (id: unknown) => { timers.delete(id as number); } },
    advance(ms: number) { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.run(); } },
    get pending() { return timers.size; },
  };
}

/** The host's peek with her close moments, as the app wires them (notes and the sequence included); `start` is 08:39:00 of a day. */
function host(options: { typing?: () => boolean; asleep?: boolean } = {}) {
  let now = Date.UTC(2026, 10, 23, 0, 39, 0); const timers: (() => void)[] = [];
  const sent: PeekCommand[] = [], missed: { kind: string; block: ChatCloseBlock }[] = [], told: string[] = [];
  const c = clock(), sequence = new CloseBeatSequence(c.ports);
  const closePorts: CloseMomentPorts = {
    clock: () => now, random: () => 0.4, day: () => 'today', mood: () => ({ ...WARM }), view: () => null,
    typing: options.typing ?? (() => false), playing: () => false, moment: () => true,
  };
  const close = new CloseMomentsHost(closePorts);
  const ports: PeekPorts = {
    clock: () => now, random: () => 0.4, idleSeconds: () => 0, asleep: () => options.asleep === true, inCall: () => false, userTalking: () => true,
    mood: () => ({ ...WARM }), lastInteractionAt: () => null, answered: () => true, readingAloud: () => false,
    every: (_ms, run) => { timers.push(run); return () => {}; }, close, sequence,
    notes: { missed: (kind, block) => missed.push({ kind, block }), interrupted: (action, by) => told.push(`${action}:${by}`) },
  };
  const link: PeekLink = { shown: () => true, fullscreen: () => false, send: command => sent.push(command), changed: () => {} };
  const peek = new PeekDirectorHost(ports, link);
  const start = () => sent.filter((x): x is Extract<PeekCommand, { type: 'start' }> => x.type === 'start').at(-1)!;
  return { peek, close, sequence, clock: c, sent, missed, told, start, at(ms: number) { now = ms; }, get now() { return now; },
    /** The page plays the performance it was sent, through its way back. */
    play(id: string, phases: readonly string[] = ['notice', 'walk', 'lean', 'hold', 'back', 'settle', 'done']) { for (const phase of phases) peek.report({ id, phase }); } };
}

test('08:39 kiss → 08:41 hug: the hug walks up now (the old 3-minute chat cooldown blocked it); a box left open with an unsent line is not typing', () => {
  const box = { open: true, keys: false }; // 08:40:00: the box came back open with the "没发出去" line; nobody typed after
  const h = host({ typing: () => box.open && box.keys });
  h.at(Date.UTC(2026, 10, 23, 0, 39, 21));
  assert.equal(h.peek.report({ closeBeat: 'kiss' }), 'play');
  h.play(h.start().id); // the kiss reached its hold: recorded (as the journal's moment-kiss at 08:39:21)
  assert.equal(h.close.history.lastAt(), Date.UTC(2026, 10, 23, 0, 39, 21));
  h.at(Date.UTC(2026, 10, 23, 0, 41, 21));
  const since = h.now - h.close.history.lastAt()!;
  assert.ok(since < 3 * 60_000, `the old rule (chatCooldownMinutes 3) would have said 'cooldown' here: ${since / 1000} s after the kiss`);
  assert.equal(h.peek.report({ closeBeat: 'hug' }), 'play', 'now: she walks up');
  assert.deepEqual(h.missed, [], 'nothing missed');
  assert.ok(!('chatCooldownMinutes' in CLOSE_MOMENT_KNOBS));
});

test('every block of a kiss / hug she wrote writes one note (journal row + next turn) with its closed word; a lighter one never waits', () => {
  const asleep = host({ asleep: true });
  assert.equal(asleep.peek.report({ closeBeat: 'hug' }), 'lighter');
  assert.deepEqual(asleep.missed, [{ kind: 'hug', block: 'asleep' }]);
  const typing = host({ typing: () => true });
  assert.equal(typing.peek.report({ closeBeat: 'kiss' }), 'lighter');
  assert.deepEqual(typing.missed, [{ kind: 'kiss', block: 'typing' }]);
  const busy = host();
  assert.equal(busy.peek.report({ closeBeat: 'kiss' }), 'play');
  assert.equal(busy.peek.report({ closeBeat: 'hug' }), 'lighter', 'one already playing');
  assert.deepEqual(busy.missed, [{ kind: 'hug', block: 'busy' }]);
  assert.equal(busy.missed.length, 1, 'once per block, never twice');
  const line = closeMissedLine([{ kind: 'hug', block: 'pulled', at: 0 }]);
  assert.equal(line, '你上一条回复里写的抱抱没有走过来做（用户那时正拉着你），只在原地凑近了一点。');
  for (const block of ['not-shown', 'asleep', 'call', 'typing', 'pulled', 'busy', 'arms', 'unready'] as const) {
    const words = closeMissedLine([{ kind: 'kiss', block, at: 0 }]);
    assert.ok(words && !/[0-9]/.test(words) && !INSTRUCTION_WORDS.some(w => words.includes(w)), words);
  }
});

test('her next turn hears it once: a kiss / hug that did not walk up, and an action you ended (information only)', () => {
  let now = 1_000_000;
  const history = new UnboundHistory({ clock: () => now, random: () => 0.9, day: () => 'today', characterId: () => 'c', mood: () => null, asleep: () => false,
    moment: () => false, attention: () => false });
  history.closeMissed({ kind: 'hug', block: 'typing', at: now });
  history.interrupted({ action: 'kiss', by: 'pull', at: now });
  now += 5_000;
  const line = history.turnLine();
  assert.ok(line.includes('你上一条回复里写的抱抱没有走过来做（用户那时正在打字）'), line);
  assert.ok(line.includes('你刚才正凑过去亲用户，用户用力把你拉开了，没做完。'), line);
  assert.ok(!history.turnLine().includes('抱抱'), 'once');
});

test('typing means keys now, and never the keys of the line she is answering (10:39: lean-in + hug at the start of her reply, a second after Enter)', async () => {
  let now = 0, open = false;
  const typing = new UnboundTyping({
    touch: () => true, say: () => 'sent', shortcut: { register: () => true, unregister: () => {} },
    input: { open: () => { open = true; }, close: () => { open = false; }, destroy: () => {}, isOpen: () => open },
    state: () => 'unbound', window: () => ({ x: 0, y: 0, width: 1000, height: 800 }), askHead: async () => null, said: () => {}, clock: () => now,
  });
  typing.click({ part: 'head', side: null, head: null } as never);
  assert.equal(typing.boxOpen, true); assert.equal(typing.typingNow, false, 'the box open: not typing');
  typing.typed(); now += 500;
  assert.equal(typing.typingNow, true, 'a key just now: typing');
  now += 400;
  assert.equal((await typing.submit('抱抱我')).ok, true); // Enter: the line goes out, the box closes
  typing.click({ part: 'head', side: null, head: null } as never); // the box open again right away (as the refill does)
  now += 600; // her reply starts with lean-in + hug a moment later
  assert.equal(typing.typingNow, false, 'the keys of the line she answers do not count');
  typing.typed(); now += TYPING_RECENT_MS - 1;
  assert.equal(typing.typingNow, true, 'a key after the send counts');
  now += 2;
  assert.equal(typing.typingNow, false, 'and stops counting a moment later');
});

test('10:39 on the page: lean-in + hug at character 0 while the opening beat holds her: both wait a moment and play, never dropped', async () => {
  const lens = laptopLens(), home = { x: 0, z: -0.85 }, body = { sense: {} as never, setPoseTargets() {} };
  const requests: MotionRequest[] = [], asked: string[] = [];
  const gen = { id: 'fake', generate: (r: MotionRequest) => { requests.push(r); return { ...REST_TARGETS }; }, reset() {} } as never;
  const player = new UnboundSpeechBeats(gen, () => {}, word => { asked.push(word); return Promise.resolve('lighter'); });
  player.receive({ id: 'r1', type: 'beats', speechBeats: { beats: [{ word: 'lean-in', at: 0 }, { word: 'hug', at: 0 }] } } as unknown as UnboundBubble);
  player.receive({ id: 'r1', type: 'delta', text: '好呀，过来。', rev: 1 } as UnboundBubble);
  const gates = { shown: true, asleep: false, armsHeld: false };
  for (let i = 0; i < 70; i++) player.frame(1 / 60, lens, home, body, false, gates); // ~1.2 s: something with priority has her
  assert.deepEqual(player.played, [], 'nothing starts over it');
  player.frame(1 / 60, lens, home, body, true, gates); await flush();
  for (let i = 0; i < 30; i++) player.frame(1 / 60, lens, home, body, true, gates);
  assert.ok((player.played as string[]).includes('lean-in'), `the lean-in plays once she is free: ${player.played}`);
  assert.deepEqual(asked, ['hug'], 'the hug asks the host');
  const late = new UnboundSpeechBeats(gen, () => {}, () => Promise.resolve('play'));
  late.receive({ id: 'r2', type: 'beats', speechBeats: { beats: [{ word: 'lean-in', at: 0 }] } } as unknown as UnboundBubble);
  late.receive({ id: 'r2', type: 'delta', text: '嗯。', rev: 1 } as UnboundBubble);
  for (let i = 0; i < 60 * 4; i++) late.frame(1 / 60, lens, home, body, false, gates);
  late.frame(1 / 60, lens, home, body, true, gates);
  assert.deepEqual(late.played, [], 'too late (past the wait): not played out of its moment');
});

test('the per-turn line names what is already known to block a kiss / hug as the turn starts (information only; never a cooldown)', () => {
  const base = { surface: 'full' as const, shown: true, view: null, armsHeld: false, inCall: false, card: null };
  assert.equal(speechBeatAvailabilityLine(speechBeatSituationOf(base)), '');
  assert.equal(speechBeatAvailabilityLine(speechBeatSituationOf({ ...base, closeNow: 'pulled' })), '这一轮用不了：kiss、hug（kiss、hug：用户正拉着你）。');
  assert.match(speechBeatAvailabilityLine(speechBeatSituationOf({ ...base, closeNow: 'busy', armsHeld: true })), /hand-cheek、v、kiss、hug（kiss、hug：上一个凑近的动作还没做完）/);
  assert.equal(speechBeatAvailabilityLine(speechBeatSituationOf({ ...base, closeNow: 'cooldown' })), '', 'no such word');
  assert.equal(speechBeatAvailabilityLine(speechBeatSituationOf({ ...base, surface: 'window', closeNow: 'pulled' })), '', 'the window plays them in place');
});

// ---- the order of her action and her words ---------------------------------------------------------------------------------------------

/** The reply's stream as the chat turn runs it: filtered, pushed (shown), the beats to the windows. */
function stream(gate: CloseBeatSequence | null) {
  const pushed: string[] = [], events: SpeechBeatsEvent[] = [], breaks: number[] = [];
  const turn = new SpeechBeatTurn(true, event => events.push(event), null, gate);
  const shown = () => pushed.join('');
  turn.onHold = () => breaks.push(shown().length);
  const push = (type: 'delta', text: string) => { turn.shown(text); pushed.push(text); };
  const controller = new AbortController();
  const input = turn.input(push, controller.signal);
  return { turn, pushed, events, breaks, shown, input, controller, end: () => turn.end(push) };
}
const beatsSent = (events: SpeechBeatsEvent[]) => events.flatMap(e => e.beats ?? []).map(b => `${b.word}@${b.at}`);

test('09:21 order, as frames (I-203): the words before a frame go first; with ⟦hug-held⟧ the words after it come once she holds, not once she is back; archived once, whole', async () => {
  const h = host(), s = stream(h.sequence);
  s.input('delta', '好呀，'); s.input('delta', '⟦lean-in⟧⟦hug⟧'); s.input('delta', '我过来啦。⟦hug-held⟧……好了，测完了。');
  const ended = s.end(); let done = false; void ended.then(() => { done = true; });
  assert.equal(s.shown(), '好呀，我过来啦。……', 'the words before the frame (and the dots right after it) are out: the hug itself holds nothing');
  assert.deepEqual(beatsSent(s.events), ['lean-in@3', 'hug@3', 'hug-held@8'], 'the beats go to the windows at once (the page plays them where the words reach them)');
  assert.deepEqual(s.breaks, [10], 'the read-aloud breaks its sentence at the frame');
  assert.equal(h.peek.report({ closeBeat: 'hug' }), 'play'); // the page reached the hug
  const id = h.start().id;
  h.play(id, ['notice', 'walk', 'lean']);
  await flush();
  assert.equal(s.shown(), '好呀，我过来啦。……', 'walking, leaning in: still waiting for her hold');
  h.play(id, ['hold']); await flush();
  assert.equal(s.shown(), '好呀，我过来啦。……好了，测完了。', 'holding: her words come (she holds while she says them)');
  await flush(); assert.equal(done, true, 'the turn may finish (and archive) now');
  const outcome = s.turn.complete(s.shown());
  assert.ok(outcome.history?.includes('好了，测完了'), 'her history holds the reply whole');
});

test('order: a blocked hug holds nothing; a stalled hug-held is let go at its cap; a stopped reply drops what waited (never revived); a call\'s legs never wait', async () => {
  const blocked = host({ asleep: true }), b = stream(blocked.sequence);
  b.input('delta', '好⟦hug⟧，我来啦⟦hug-held⟧，抱住。'); const bEnd = b.end();
  assert.equal(blocked.peek.report({ closeBeat: 'hug' }), 'lighter');
  await flush(); await bEnd;
  assert.equal(b.shown(), '好，我来啦，抱住。', 'blocked: nothing waits');
  const stalled = host(), s = stream(stalled.sequence);
  s.input('delta', '来⟦hug⟧嗯⟦hug-held⟧抱一下。'); void s.end();
  stalled.peek.report({ closeBeat: 'hug' });
  stalled.clock.advance(CLOSE_SEQUENCE_CAPS.actionMs - 1); await flush();
  assert.equal(s.shown(), '来嗯', 'still waiting just before the cap');
  stalled.clock.advance(2); await flush();
  assert.equal(s.shown(), '来嗯抱一下。', 'the cap lets her words go');
  const never = host(), n = stream(never.sequence);
  n.input('delta', '来⟦kiss⟧嗯⟦hug-held⟧亲一下。'); void n.end();
  never.clock.advance(CLOSE_SEQUENCE_CAPS.reachMs); await flush();
  assert.equal(n.shown(), '来嗯亲一下。', 'the page never reached the kiss: let go at the reach cap');
  const stopped = host(), t = stream(stopped.sequence);
  t.input('delta', '嗯⟦hug⟧来⟦hug-held⟧好了。'); let tDone = false; void t.end().then(() => { tDone = true; });
  t.controller.abort(); await flush();
  assert.equal(tDone, true, 'stopped: the turn does not wait');
  stopped.peek.report({ closeBeat: 'hug' }); stopped.play(stopped.start().id, ['notice', 'walk', 'lean', 'hold', 'back', 'settle', 'done']); await flush();
  assert.equal(t.shown(), '嗯来', 'stopped: what waited is gone, and stays gone');
  const plain = stream(null);
  plain.input('delta', '嗯⟦hug⟧来⟦hug-held⟧好了。'); await plain.end();
  assert.equal(plain.shown(), '嗯来好了。', 'no gate (the window, a call): as before');
  const tail = host(), e = stream(tail.sequence);
  e.input('delta', '抱一下⟦hug⟧嗯⟦hug-held⟧'); await e.end();
  assert.equal(tail.sequence.holding, null, 'a frame at the very end: nothing to wait for');
});

test('the read-aloud: the words before a held beat are a piece of their own, read before the action', () => {
  const speech = new CompletedReplySpeech(() => 0);
  const fence = speech.beginCommit(1, 'r1', 'scope');
  speech.append(fence, '好呀，');
  assert.equal(speech.segmentEnd('r1', 0), null, 'a comma alone is not a sentence yet');
  speech.breakHere(fence);
  assert.equal(speech.segmentEnd('r1', 0), 3, 'the beat breaks it: "好呀，" is read now');
  speech.append(fence, '……好了，测完了。');
  assert.equal(speech.segmentEnd('r1', 1), 12, 'the words after are their own sentence, at their place');
  assert.equal(speech.record(1, 'r1', 'scope', '好呀，……好了，测完了。', { prefix: true, fence }), true, 'the whole reply still checks out');
});

test('a large pull that ended a kiss / hug / look (the page reports cancelled "pull"): one note (journal + next turn), never twice; a peek cancelled otherwise: none', () => {
  const h = host();
  assert.equal(h.peek.report({ closeBeat: 'hug' }), 'play');
  const id = h.start().id;
  h.play(id, ['notice', 'walk', 'lean']);
  h.peek.report({ id, phase: 'back', cancelled: 'pull' }); h.peek.report({ id, phase: 'back', cancelled: 'pull' });
  assert.deepEqual(h.told, ['hug:pull']);
  h.play(id, ['settle', 'done']);
  assert.equal(h.sequence.holding, null);
  const other = host();
  other.peek.report({ closeBeat: 'kiss' });
  other.peek.report({ id: other.start().id, phase: 'back', cancelled: 'timeout' });
  assert.deepEqual(other.told, []);
});
