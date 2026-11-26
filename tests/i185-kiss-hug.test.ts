// I-185 (on I-185 "第三条可以，但不筛
// ”角色不会做的“。万一用户说比个V呢？"): kiss and hug in her marker vocabulary, and each turn's one short line of the words she cannot use now.
// Guards: the markers never leak (suffixes, backup brackets, split chunks); a performance-only ⟦hug⟧ shows the grey line; full-screen asks the
// host (the close moments' gates: arms held → no hug walk-up, a cooldown, a call…; "she is speaking" is not a gate there: the pucker waits on
// the page) and falls back to the lighter one, never nothing; the window plays them in place; the old stage ignores them; the per-turn line
// for window / full-screen / arms held / asleep / a call / a model without arms; her character never filters a word.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechBeatFilter, describeBeats, filterSpeechBeats, speechBeatSentence } from '../shared/behaviors/speech-beats/choose';
import { SPEECH_BEAT_CLOSE_WORDS, SPEECH_BEAT_WORDS, type SpeechBeatWord } from '../shared/behaviors/speech-beats/interface';
import { offeredBeatWords } from '../shared/behaviors/speech-beats/window-close';
import { SPEECH_BEAT_ARM_WORDS, speechBeatAvailabilityLine, speechBeatSituationOf, unavailableBeatWords, type SpeechBeatSituation } from '../shared/behaviors/speech-beats/availability';
import { SpeechBeatTurn } from '../electron/brain/speech-beats/turn';
import { SpeechBeatsHost } from '../electron/brain/speech-beats/host';
import { SpeechBeatArchive } from '../electron/brain/speech-beats/archive';
import { BeatSituation, beatCardOf } from '../electron/unbound/beat-situation';
import { CHAT_CLOSE_CALL_BLOCKS, CLOSE_MOMENT_KNOBS, PuckerGate, chatCloseBlock, closeMomentLine, parseCloseBeatAsk, parseCloseMomentPlan, type CloseHappened } from '../shared/unbound/close-moments';
import { INSTRUCTION_WORDS } from '../shared/unbound/life/history';
import { PeekDirectorHost, type PeekLink, type PeekPorts } from '../electron/unbound/peek';
import { CloseMomentsHost, type CloseMomentPorts } from '../electron/unbound/close-moments';
import { NEUTRAL_MOOD, type PeekCommand } from '../shared/unbound/director';
import { SPEECH_BEAT_HAND_WORDS, UnboundSpeechBeats, closeBeatStage } from '../src/unbound/speech-beat-player';
import { WindowBeats } from '../src/unbound/window-mode/window-beats';
import { REST_TARGETS, type MotionRequest } from '../src/unbound/motion/generator';
import type { UnboundBubble } from '../shared/unbound/scene';
import { chatWorld, settle } from './helpers/chat-world';
import { laptopLens } from './helpers/unbound-peek';

const REPORT = process.env.I185_REPORT === '1';
const leaks = (text: string) => /[⟦⟧【】〖〗[\]]/u.test(text) || /\b(kiss|hug|once|line)\b/u.test(text) || SPEECH_BEAT_WORDS.some(word => text.includes(word));
const FREE: SpeechBeatSituation = { surface: 'window', shown: true, asleep: false, armsHeld: false, inCall: false, model: { arms: true } };
// 2026-11-24: the window has no kiss / hug while its knob is off (shared/behaviors/speech-beats/window-close.ts); the tests below about the whole list turn it on for the turn (the 6th and 7th arguments: gate, language, windowClose).
const WIN_ON = [null, null, true] as const;

// ---------------------------------------------------------------- the vocabulary and the filter

test('kiss and hug are words: parsed in her brackets, the backup brackets and with a suffix; never in the text; split chunks too', () => {
  const whole = '⟦kiss⟧嗯～⟦hug once⟧过来。【kiss line】好呀[hug]，[[kiss]]〖hug〗嘿⟦hug forever⟧哈';
  const summary = filterSpeechBeats(whole);
  assert.equal(summary.text, '嗯～过来。好呀，嘿哈');
  assert.deepEqual(summary.beats.map(b => [b.word, b.how ?? '']), [['kiss', ''], ['hug', 'once'], ['kiss', 'line'], ['hug', ''], ['kiss', ''], ['hug', ''], ['hug', '']]);
  assert.ok(!leaks(summary.text), summary.text);
  // any split of the same reply into chunks gives the same text and beats
  for (let cut = 1; cut < whole.length; cut += 3) {
    const filter = new SpeechBeatFilter();
    const text = filter.push(whole.slice(0, cut)).text + filter.push(whole.slice(cut)).text + filter.end().text;
    assert.equal(text, summary.text, `cut at ${cut}`);
    assert.deepEqual(filter.summary().beats, summary.beats, `cut at ${cut}`);
  }
  // ordinary bracketed words that are not markers stay as written
  assert.equal(filterSpeechBeats('[hugging] 【kiss me】').text, '[hugging] 【kiss me】');
});

test('a performance-only ⟦hug⟧ (or ⟦kiss⟧) is the grey line, and her history keeps the marker (switch on)', () => {
  const sent: unknown[] = [];
  const turn = new SpeechBeatTurn(true, event => sent.push(event));
  const pushed: string[] = [];
  const push = turn.input<'delta'>((_type, text) => pushed.push(text));
  push('delta', '⟦hu'); push('delta', 'g⟧'); turn.end((_type, text) => pushed.push(text));
  assert.equal(pushed.join(''), '');
  const outcome = turn.complete('');
  assert.equal(outcome.performanceOnly, true);
  assert.equal(outcome.line, '（抱了抱你）');
  assert.equal(outcome.history, '⟦hug⟧');
  assert.equal(describeBeats(filterSpeechBeats('⟦kiss⟧⟦shy⟧').beats), '（亲了你一下，害羞地笑了）');
});

test('through the real chat turn: a performance-only ⟦hug⟧ shows the grey line, nothing read aloud; suffixed kiss and backup brackets never reach the bubble', async () => {
  const w = chatWorld({ stream: ['⟦hu', 'g⟧'], beats: true, passThrough: true });
  w.send('r1');
  await settle(() => w.settled('r1'), 'settles');
  assert.equal(w.shown.join(''), '');
  assert.ok(!w.log.includes('speech recorded'), 'nothing is read aloud');
  const final = (w.events as { type: string; speechBeats?: { final?: unknown } }[]).filter(e => e.type === 'beats').at(-1)?.speechBeats?.final;
  assert.deepEqual(final, { performanceOnly: true, line: '（抱了抱你）', history: '⟦hug⟧' });
  const v = chatWorld({ stream: ['⟦kiss on', 'ce⟧亲一下。【hu', 'g】[kiss line]好啦'], beats: true, passThrough: true });
  v.send('r2');
  await settle(() => v.settled('r2'), 'settles');
  const pushed = v.log.filter(line => line.startsWith('push delta ')).map(line => line.slice('push delta '.length));
  assert.equal(pushed.join(''), '亲一下。好啦');
  for (const text of [...pushed, ...v.shown, ...v.spoken.map(line => line.replace(/^\[record\] /u, ''))]) assert.ok(!leaks(text), `leaked: ${text}`);
});

// ---------------------------------------------------------------- each turn's line (I-185 第 3 条)

test('each turn: the line of words she cannot use now — window, full-screen, arms held, asleep, a call, a model without arms', () => {
  assert.equal(speechBeatAvailabilityLine(FREE), '', 'the window: every word (kiss and hug in place)');
  assert.equal(speechBeatAvailabilityLine({ ...FREE, surface: 'full' }), '', 'full-screen: every word');
  assert.equal(speechBeatAvailabilityLine({ ...FREE, armsHeld: true }), '这一轮用不了：hand-cheek、v、hug。');
  assert.equal(speechBeatAvailabilityLine({ ...FREE, model: { arms: false } }), '这一轮用不了：hand-cheek、v、hug。', 'no arm rig');
  assert.equal(speechBeatAvailabilityLine({ ...FREE, model: null }), '', 'model not known yet: nothing left out');
  // 2026-11-22: a call no longer leaves kiss and hug out; the arm words still follow the arms
  assert.equal(speechBeatAvailabilityLine({ ...FREE, inCall: true }), '', 'a call: kiss and hug are on the list');
  assert.equal(speechBeatAvailabilityLine({ ...FREE, inCall: true, armsHeld: true }), '这一轮用不了：hand-cheek、v、hug。', 'a call with her arms held: the arm words only');
  assert.equal(speechBeatAvailabilityLine({ ...FREE, inCall: true, model: { arms: false } }), '这一轮用不了：hand-cheek、v、hug。');
  assert.equal(speechBeatAvailabilityLine({ ...FREE, inCall: true, asleep: true }), '这一轮动作标记都用不了。', 'a call, asleep: still none');
  assert.equal(speechBeatAvailabilityLine({ ...FREE, asleep: true }), '这一轮动作标记都用不了。');
  assert.equal(speechBeatAvailabilityLine({ ...FREE, surface: 'full', shown: false }), '这一轮动作标记都用不了。', 'stepped back for a full-screen program');
  assert.equal(speechBeatAvailabilityLine(null), '');
  for (const word of SPEECH_BEAT_HAND_WORDS) assert.ok(SPEECH_BEAT_ARM_WORDS.includes(word as SpeechBeatWord), `${word}: the page's hand words are arm words here`);
  // never more characters than listing what is left (it picks the shorter)
  for (const s of [{ ...FREE, armsHeld: true }, { ...FREE, inCall: true, armsHeld: true }]) {
    const out = unavailableBeatWords(s), left = SPEECH_BEAT_WORDS.filter(w => !out.includes(w));
    assert.ok(speechBeatAvailabilityLine(s).length <= `这一轮只能用：${left.join('、')}。`.length);
  }
});

test('the turn\'s sentence: the fixed full list first (unchanged every turn), the short line after; no situation: exactly as before', () => {
  const before = speechBeatSentence(SPEECH_BEAT_WORDS.filter(w => !(SPEECH_BEAT_CLOSE_WORDS as readonly string[]).includes(w))); // the sentence before I-185
  const fixed = speechBeatSentence();
  assert.equal(new SpeechBeatTurn(true, () => {}).sentence(), fixed);
  assert.equal(new SpeechBeatTurn(true, () => {}, FREE, ...WIN_ON).sentence(), fixed, 'nothing out: not one character more');
  const held = new SpeechBeatTurn(true, () => {}, { ...FREE, armsHeld: true }, ...WIN_ON).sentence();
  assert.ok(held.startsWith(fixed + '\n'), 'the fixed part is byte for byte the same (cache-friendly)');
  assert.equal(new SpeechBeatTurn(false, () => {}, { ...FREE, armsHeld: true }, ...WIN_ON).sentence(), '', 'switch off: nothing');
  const call = new SpeechBeatTurn(true, () => {}, { ...FREE, inCall: true }, ...WIN_ON).sentence(true);
  assert.equal(call, speechBeatSentence(undefined, true), 'a call: not one character more, kiss and hug not named as unusable');
  assert.ok(!call.includes('用不了'));
  const sizes = { before: before.length, after: fixed.length, armsHeld: held.length, call: call.length, callBefore: speechBeatSentence(SPEECH_BEAT_WORDS.filter(w => w !== 'kiss' && w !== 'hug'), true).length,
    asleep: new SpeechBeatTurn(true, () => {}, { ...FREE, asleep: true }, ...WIN_ON).sentence().length, noArms: new SpeechBeatTurn(true, () => {}, { ...FREE, model: { arms: false } }, ...WIN_ON).sentence().length };
  if (REPORT) console.log('[I-185 characters per turn]', JSON.stringify(sizes));
  assert.ok(sizes.after - sizes.before <= 20, `kiss and hug add ${sizes.after - sizes.before} characters to the fixed sentence`);
  assert.ok(sizes.armsHeld - sizes.after <= 25 && sizes.asleep - sizes.after <= 14, 'the per-turn line stays short');
});

test('her character never filters a word: shy, bold or cold cards, any mood template, give the same line (no filtering by what a card would not do)', () => {
  const cards = [
    { parameters: { weights: { playful: 0.5, close: 0.6, comfortable: 1, cautious: 2.6 }, intensity: { expression: 20, playful: 10 } } },
    { parameters: { weights: { playful: 2.4, close: 1.8, comfortable: 1.2, cautious: 0.4 }, intensity: { expression: 85, playful: 85 } } },
    { parameters: { weights: { playful: 0.3, close: 0.3, comfortable: 1.6, cautious: 1.8 }, intensity: { expression: 12, playful: 5 } } },
    { parameters: null }, null,
  ];
  for (const base of [{ armsHeld: false, inCall: false }, { armsHeld: true, inCall: false }, { armsHeld: false, inCall: true }]) {
    const lines = cards.map(view => speechBeatAvailabilityLine(speechBeatSituationOf({ surface: 'window', shown: true, view: view as never, ...base, card: { gesture: { enabled: true } } })));
    assert.equal(new Set(lines).size, 1, `${JSON.stringify(base)}: ${JSON.stringify(lines)}`);
    const words = cards.map(view => unavailableBeatWords(speechBeatSituationOf({ surface: 'full', shown: true, view: view as never, ...base, card: null })).join());
    assert.equal(new Set(words).size, 1);
  }
  // every word (a V too) is offered to a cautious, reserved card when she can do it
  const shy = speechBeatSituationOf({ surface: 'window', shown: true, view: cards[0] as never, armsHeld: false, inCall: false, card: { gesture: { enabled: true } } });
  assert.deepEqual(unavailableBeatWords(shy), []);
});

test('the host reads the situation once per turn (switch on only); a broken reader adds nothing; the wiring\'s reads become the line', async () => {
  const host = new SpeechBeatsHost('tmp', new SpeechBeatArchive('tmp', async () => {}, () => { throw new Error('no file'); }));
  let reads = 0;
  host.situate(() => { reads++; return { ...FREE, armsHeld: true }; });
  assert.ok(host.begin(true, () => {}).sentence().endsWith('这一轮用不了：hand-cheek、v。'));
  host.begin(false, () => {});
  assert.equal(reads, 1, 'off: not read');
  host.situate(() => { throw new Error('broken'); });
  assert.equal(host.begin(true, () => {}).sentence(), speechBeatSentence());
  // electron/unbound/beat-situation.ts: the card is read in the background, a model without a profile is "not known"
  let card: unknown = { profile: { morphs: {}, bones: { map: {} } }, record: null };
  const situation = new BeatSituation({ state: () => 'unbound', companionShown: () => true, view: () => null, asleep: () => false, armsHeld: () => false,
    inCall: () => false, card: async () => card });
  assert.equal(situation.now().model, null, 'first turn: the card is not read yet');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(situation.now(), { surface: 'full', shown: true, asleep: false, armsHeld: false, inCall: false, model: { arms: false } }, 'a model with no arm bones');
  card = { profile: null, record: null };
  situation.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(situation.now().model, null, 'no profile yet: not known');
  assert.equal(beatCardOf(undefined), null);
  // through the real chat turn: the line rides right after the fixed sentence
  const w = chatWorld({ stream: ['好呀'], beats: true, passThrough: true });
  w.beatsHost.situate(() => ({ ...FREE, inCall: true, armsHeld: true }));
  w.send('r1');
  await settle(() => w.settled('r1'), 'settles');
  assert.ok(String(w.tasks[0].prompt).includes(speechBeatSentence(offeredBeatWords('window', false)) + '\n这一轮用不了：hand-cheek、v。')); // 2026-11-24: the window's list has no kiss / hug
});

// ---------------------------------------------------------------- full-screen: the host's answer (the close moments' gates)

const WARM = { ...NEUTRAL_MOOD, O: 80, E: 66, D: 62, M: 20 };
function rig(options: { playing?: boolean; inCall?: boolean; reading?: boolean } = {}) {
  let now = 1_700_000_000_000, idle = 120, timers: (() => void)[] = [];
  const sent: PeekCommand[] = [], moments: string[] = [], happened: CloseHappened[] = [];
  let playing = options.playing === true, reading = options.reading === true, typing = false;
  const closePorts: CloseMomentPorts = {
    clock: () => now, random: () => 0.4, day: () => 'today', mood: () => ({ ...WARM }), view: () => null,
    typing: () => false, playing: () => playing, moment: kind => { moments.push(kind); return true; }, happened: item => happened.push(item),
  };
  const close = new CloseMomentsHost(closePorts);
  const ports: PeekPorts = {
    clock: () => now, random: () => 0.4, idleSeconds: () => idle, asleep: () => false, inCall: () => options.inCall === true, userTalking: () => true,
    mood: () => ({ ...WARM }), lastInteractionAt: () => null, answered: () => true, readingAloud: () => reading,
    every: (_ms, run) => { timers.push(run); return () => { timers = timers.filter(t => t !== run); }; }, close,
  };
  const link: PeekLink = { shown: () => true, fullscreen: () => false, send: c => sent.push(c), changed: () => {} };
  const host = new PeekDirectorHost(ports, link);
  const starts = () => sent.filter((c): c is Extract<PeekCommand, { type: 'start' }> => c.type === 'start');
  return { host, close, sent, moments, happened, starts, advance(ms: number) { now += ms; for (const t of [...timers]) t(); }, set idle(v: number) { idle = v; },
    set playing(v: boolean) { playing = v; }, set reading(v: boolean) { reading = v; }, set typing(v: boolean) { typing = v; },
    /** I-192: key or mouse input that goes on for `ms` (the idle time stays near zero), read five times a second. */
    keepInput(ms: number) { for (let t = 0; t < ms; t += 200) { idle = 0.05; now += 200; for (const run of [...timers]) run(); } } };
}

test('chatCloseBlock: the family\'s gates except "she is speaking"; a hug never while her arms are held; never a cooldown', () => {
  const gates = { shown: true, asleep: false, inCall: false, typing: false, pulled: false, armsHeld: false, speaking: true };
  const block = (over: Partial<typeof gates>, kind: 'kiss' | 'hug' = 'hug', busy = false) => chatCloseBlock({ kind, gates: { ...gates, ...over }, busy });
  assert.equal(block({}), null, 'she is speaking: still yes (the pucker waits for a pause on the page)');
  assert.equal(block({ armsHeld: true }), 'arms');
  assert.equal(block({ armsHeld: true }, 'kiss'), null, 'a kiss needs no arms');
  assert.equal(block({ shown: false }), 'not-shown'); assert.equal(block({ asleep: true }), 'asleep'); assert.equal(block({ inCall: true }), null, 'a call: a chat kiss or hug may walk over (2026-11-22)');
  assert.equal(block({ inCall: true }, 'kiss'), null);
  assert.equal(block({ inCall: true, armsHeld: true }), 'arms', 'a call does not lift the arms gate');
  assert.equal(block({ inCall: true, typing: true }, 'kiss'), 'typing');
  assert.equal(block({ inCall: true, asleep: true }, 'kiss'), 'asleep');
  assert.equal(block({ inCall: true, pulled: true }, 'kiss'), 'pulled');
  assert.equal(block({ inCall: true }, 'kiss', true), 'busy');
  assert.deepEqual([...CHAT_CLOSE_CALL_BLOCKS], [], 'the one list: empty');
  assert.equal(block({ typing: true }), 'typing'); assert.equal(block({ pulled: true }), 'pulled'); assert.equal(block({}, 'kiss', true), 'busy');
  assert.equal(block({}, 'kiss'), null, 'a kiss right after another one: no cooldown blocks what she writes (the host keeps no history for it)');
  assert.ok(!('chatCooldownMinutes' in CLOSE_MOMENT_KNOBS), 'the chat cooldown knob is gone');
  assert.deepEqual(parseCloseBeatAsk({ closeBeat: 'hug' }), { closeBeat: 'hug' });
  for (const bad of [{ closeBeat: 'dance' }, { closeBeat: 'hug', extra: 1 }, null, 'hug', ['hug']]) assert.equal(parseCloseBeatAsk(bad), null);
});

test('full-screen host: ⟦hug⟧ walks up through the peek channel (via chat, not counted); her own reply, reading aloud, your typing and your keys never back it off (2026-11-23)', () => {
  const f = rig({ reading: true });
  f.host.chat('delta'); // her reply is streaming (the page reached the word in it)
  assert.equal(f.host.report({ closeBeat: 'hug' }), 'play');
  const [start] = f.starts();
  assert.equal(start.plan.action, 'close-moment');
  assert.equal((start.plan as { via: string }).via, 'chat');
  assert.ok(parseCloseMomentPlan(start.plan), 'the page accepts the plan');
  f.host.chat('delta'); f.advance(1_000); f.host.tick(); f.host.interrupt('reply'); f.host.interrupt('input');
  assert.ok(!f.sent.some(c => c.type === 'cancel'), 'her reply, reading aloud and the life host\'s "you two are talking" never back her off');
  assert.equal(f.host.report({ closeBeat: 'kiss' }), 'lighter', 'another one while it plays: the lighter one');
  f.advance(2_000);
  // 2026-11-23: typing to her, one stray key, and keys or the mouse going on elsewhere: she stays every time.
  f.typing = true; f.keepInput(4_000);
  f.typing = false; f.keepInput(200); f.advance(1_200); f.advance(1_200);
  f.keepInput(5_000); f.host.interrupt('typing'); f.host.interrupt('click'); f.host.interrupt('call'); f.host.interrupt('pointer');
  assert.ok(!f.sent.some(c => c.type === 'cancel'), 'typing, keys, the mouse, a click and a call never back her off');
  f.host.interrupt('play');
  assert.ok(f.sent.some(c => c.type === 'cancel' && c.reason === 'play'), 'a game (a new action of hers) does');
  const g = rig();
  g.host.chat('delta');
  assert.equal(g.host.chatBeat('kiss'), 'play');
  g.host.chat('done'); g.host.chat('delta');
  assert.ok(!g.sent.some(c => c.type === 'cancel'), 'I-192: a new reply starting no longer backs her off (she holds while she speaks, up to the cap)');
});

test('in a call (2026-11-22): a chat kiss/hug walks over, the call\'s turns (the life host\'s call interrupt, her next reply, your utterance) cut the hold no differently than typed chat; the pucker waits for the sentence end', () => {
  for (const kind of ['kiss', 'hug'] as const) {
    const typed = rig(), call = rig({ inCall: true });
    for (const f of [typed, call]) {
      f.host.chat('delta');
      assert.equal(f.host.report({ closeBeat: kind }), 'play', `${kind}: plays`);
      f.advance(1_000);
      // what a call turn sends: the life host's 'call' interaction → interrupt('input'); her next spoken reply starts and ends; your utterance is no key or mouse input
      f.host.interrupt('input'); f.host.interrupt('reply');
      f.host.chat('done'); f.host.chat('delta'); f.host.chat('done'); f.advance(3_000);
    }
    assert.deepEqual(call.sent.map(c => c.type), typed.sent.map(c => c.type), `${kind}: the same commands in a call as typed (start only, no cancel)`);
    assert.ok(!call.sent.some(c => c.type === 'cancel'));
    assert.equal(call.starts().length, 1);
  }
  // the pucker: never starts while the held "she is speaking" is on (the call's voice feeds the same hold), rises in the pause after the sentence, never cuts the voice
  const gate = new PuckerGate();
  for (let i = 0; i < 30; i++) assert.equal(gate.frame(0.1, 1, false, true), 0, 'she is speaking: no pucker');
  for (let i = 0; i < 10; i++) assert.equal(gate.frame(0.1, 1, false, false), 0, 'quiet but mid-sentence (may not start): still none');
  let shown = 0; for (let i = 0; i < 10; i++) shown = gate.frame(0.1, 1, true, false);
  assert.ok(shown > 0.99, 'the pause after the sentence: it shows');
  assert.ok(gate.frame(0.1, 1, true, true) < shown, 'she speaks again: it eases back down');
});

test('full-screen host: recorded only when its hold is reached (once), via chat; arms held → hug lighter, kiss still plays; a call → plays like outside one; right after one: plays again (no cooldown, 2026-11-23)', () => {
  const f = rig();
  assert.equal(f.host.chatBeat('kiss'), 'play');
  const id = f.starts()[0].id;
  f.host.report({ id, phase: 'lean' });
  assert.deepEqual(f.moments, []);
  f.host.report({ id, phase: 'hold' }); f.host.report({ id, phase: 'hold' });
  assert.deepEqual(f.moments, ['kiss'], 'once, at the hold');
  assert.equal(f.happened[0].via, 'chat');
  for (const phase of ['back', 'settle', 'done'] as const) f.host.report({ id, phase });
  assert.equal(f.host.chatBeat('hug'), 'play', 'right after the kiss: the hug walks up too (what she writes has no cooldown)');
  const g = rig();
  g.host.chatBeat('kiss');
  const gid = g.starts()[0].id;
  g.host.report({ id: gid, phase: 'lean' }); g.host.report({ id: gid, phase: 'back', cancelled: 'input' }); g.host.report({ id: gid, phase: 'hold' });
  assert.deepEqual(g.moments, [], 'cancelled before the hold: nothing written');
  const h = rig({ playing: true });
  assert.equal(h.host.chatBeat('hug'), 'lighter', 'a game holds her arms: no hug walk-up');
  assert.equal(h.starts().length, 0);
  assert.equal(h.host.chatBeat('kiss'), 'play');
  assert.equal(rig({ inCall: true }).host.chatBeat('kiss'), 'play', 'a call: she walks over');
  assert.equal(rig({ inCall: true, playing: true }).host.chatBeat('hug'), 'lighter', 'a call, arms held: still no hug walk-up');
  const line = closeMomentLine([{ kind: 'kiss', via: 'chat', after: 'grin', at: 0 }]);
  assert.ok(line.startsWith('你刚才边说边走到用户跟前亲了用户一下'), line);
  for (const word of INSTRUCTION_WORDS) assert.ok(!line.includes(word), `no instruction word: ${word}`);
});

// ---------------------------------------------------------------- full-screen page: ask, then play or the lighter one

const fakeGenerator = (requests: MotionRequest[]) => ({ generate: (request: MotionRequest) => { requests.push(request); return { ...REST_TARGETS }; }, reset() {} }) as never;
const say = (player: UnboundSpeechBeats, word: string, text = '好呀，抱一下。') => {
  player.receive({ id: 'r1', type: 'beats', speechBeats: { beats: [{ word, at: 0 }] } } as unknown as UnboundBubble);
  player.receive({ id: 'r1', type: 'delta', text, rev: 1 } as UnboundBubble);
};
const GATES = { shown: true, asleep: false, armsHeld: false };

test('full-screen page: a kiss or a hug asks the host; "play" → the director has her (nothing here); "lighter" or no host → the lighter one, never nothing', async () => {
  const lens = laptopLens(), HOME = { x: 0, z: -0.85 }, body = { sense: {} as never, setPoseTargets() {} };
  const asked: string[] = [];
  const play = new UnboundSpeechBeats(fakeGenerator([]), () => {}, word => { asked.push(word); return Promise.resolve('play'); });
  say(play, 'hug');
  play.frame(1 / 60, lens, HOME, body, true, GATES);
  await Promise.resolve();
  for (let k = 0; k < 10; k++) play.frame(1 / 60, lens, HOME, body, true, GATES);
  assert.deepEqual(asked, ['hug']);
  assert.deepEqual(play.played, ['hug', 'hug:play']);
  assert.equal(play.active, false, 'the director plays it, not this player');
  const requests: MotionRequest[] = [];
  const lighter = new UnboundSpeechBeats(fakeGenerator(requests), () => {}, () => Promise.resolve('lighter'));
  say(lighter, 'hug');
  lighter.frame(1 / 60, lens, HOME, body, true, GATES);
  await Promise.resolve();
  for (let k = 0; k < 60; k++) lighter.frame(1 / 60, lens, HOME, body, true, GATES);
  assert.deepEqual(lighter.played, ['hug', 'hug:lighter']);
  const showcase = requests.map(r => r.intent).filter(i => i.kind === 'showcase') as Extract<MotionRequest['intent'], { kind: 'showcase' }>[];
  assert.ok(showcase.length > 0 && showcase.some(i => i.lean > 0.01), 'she leans in where she stands');
  const arms = Math.max(...showcase.map(i => i.hands.left?.weight ?? 0));
  assert.ok(arms > 0.05 && arms < 0.4, `her arms open a little (${arms})`);
  assert.ok(showcase.every(i => i.place === null), 'she does not walk');
  const kiss = new UnboundSpeechBeats(fakeGenerator([]), () => {}, () => { throw new Error('no host'); });
  say(kiss, 'kiss');
  for (let k = 0; k < 5; k++) kiss.frame(1 / 60, lens, HOME, body, true, GATES);
  assert.deepEqual(kiss.played, ['kiss', 'kiss:lighter', 'kiss>shy'], 'a shy smile in its place');
  const none = new UnboundSpeechBeats(fakeGenerator([]));
  say(none, 'hug');
  none.frame(1 / 60, lens, HOME, body, true, GATES);
  assert.deepEqual(none.played, ['hug', 'hug:lighter'], 'no host: the lighter one at once');
});

test('full-screen page: her arms held → the lighter hug has no arms; asleep → still asked (no walk-up, no word waits); a new reply drops a lighter one still waiting', async () => {
  const lens = laptopLens(), HOME = { x: 0, z: -0.85 }, body = { sense: {} as never, setPoseTargets() {} };
  const requests: MotionRequest[] = [];
  const held = new UnboundSpeechBeats(fakeGenerator(requests), () => {}, () => 'lighter');
  say(held, 'hug');
  for (let k = 0; k < 90; k++) held.frame(1 / 60, lens, HOME, body, true, { ...GATES, armsHeld: true });
  const showcase = requests.map(r => r.intent).filter(i => i.kind === 'showcase') as Extract<MotionRequest['intent'], { kind: 'showcase' }>[];
  assert.ok(showcase.length > 0 && showcase.every(i => !i.hands.left && !i.hands.right), 'never her arms while a game holds them');
  const asked: string[] = [];
  const asleep = new UnboundSpeechBeats(fakeGenerator([]), () => {}, word => { asked.push(word); return 'play'; });
  say(asleep, 'kiss');
  asleep.frame(1 / 60, lens, HOME, body, true, { ...GATES, asleep: true });
  // 2026-11-23: asleep she plays nothing, but the host is still asked (her words after the beat wait for its answer; it journals why): no playing, no walk-up.
  assert.deepEqual(asked, ['kiss']);
  let answer: (value: unknown) => void = () => {};
  const late = new UnboundSpeechBeats(fakeGenerator([]), () => {}, () => new Promise(resolve => { answer = resolve; }));
  say(late, 'kiss');
  late.frame(1 / 60, lens, HOME, body, true, GATES);
  late.receive({ id: 'r2', type: 'delta', text: '新的一句', rev: 1 } as UnboundBubble);
  answer('lighter'); await Promise.resolve();
  for (let k = 0; k < 5; k++) late.frame(1 / 60, lens, HOME, body, true, GATES);
  assert.ok(!late.played.includes('kiss>shy'), 'the old reply\'s lighter kiss is not played late');
});

test('closeBeatStage: the window plays both in place; the lighter kiss is a shy smile, the lighter hug opens her arms a little or not at all', () => {
  assert.deepEqual(closeBeatStage('kiss', { lighter: false, armsHeld: false }), { kind: 'in-place', arms: 'none', lean: 0.55 });
  assert.deepEqual(closeBeatStage('kiss', { lighter: true, armsHeld: false }), { kind: 'word', word: 'shy' });
  assert.equal((closeBeatStage('hug', { lighter: false, armsHeld: false }) as { arms: string }).arms, 'full');
  assert.equal((closeBeatStage('hug', { lighter: false, armsHeld: true }) as { arms: string }).arms, 'none');
  assert.equal((closeBeatStage('hug', { lighter: false, armsHeld: false, arms: false }) as { arms: string }).arms, 'none', 'no arm rig');
  assert.equal((closeBeatStage('hug', { lighter: true, armsHeld: false }) as { arms: string }).arms, 'small');
});

// ---------------------------------------------------------------- the window: in place, smooth at 60 and 30 fps

function windowRun(fps: number, word: 'kiss' | 'hug', options: { speakingUntil?: number; armsHeld?: boolean; model?: { arms: boolean } | null; releaseAt?: number } = {}) {
  const beats = new WindowBeats(); beats.closeMoments = true; // 2026-11-24: the window's kiss / hug are behind a knob (off); these runs are of the in-place motion itself
  const frames: { t: number; torso: number; head: number; roll: number; blink: number; pucker: number; hands: number; wrap: number; slots: number }[] = [];
  let played = false;
  for (let i = 0; i <= fps * 12; i++) {
    const t = i / fps, dt = i ? 1 / fps : 0;
    if (!played && t >= 0.5) { played = beats.play(word, { shown: true, asleep: false, armsHeld: options.armsHeld === true }, false, options.model === undefined ? { arms: true } : options.model); }
    if (options.releaseAt !== undefined && Math.abs(t - options.releaseAt) < 0.5 / fps) beats.release();
    const out = beats.frame(dt, { armsHeld: options.armsHeld === true, speaking: t < (options.speakingUntil ?? 0) });
    frames.push({ t, torso: out.torso.pitch, head: out.head.pitch, roll: out.head.roll, blink: out.blink, pucker: beats.lastClose?.pucker ?? 0,
      hands: out.hands?.left?.weight ?? 0, wrap: out.hands?.left?.aim?.fore.x ?? 0, slots: Math.max(0, ...Object.values(out.slots)) });
  }
  return { frames, played, beats };
}
const steps = (values: number[]) => values.slice(1).map((v, i) => Math.abs(v - values[i]));
const accel = (values: number[]) => values.slice(2).map((v, i) => Math.abs(v - 2 * values[i + 1] + values[i]));

for (const fps of [60, 30]) {
  test(`window ${fps} fps: kiss in place — eyes close, a small lean, the pucker only after she stops speaking; from rest to rest, no jump`, () => {
    const run = windowRun(fps, 'kiss', { speakingUntil: 1.6 });
    assert.ok(run.played);
    assert.deepEqual(run.beats.played, ['kiss']);
    const f = run.frames, k = 60 / fps;
    assert.ok(Math.max(...f.map(x => x.blink)) > 0.85, 'her eyes close');
    assert.ok(Math.max(...f.map(x => x.torso)) > 0.08 && Math.max(...f.map(x => x.torso)) < 0.25, `a small lean (${Math.max(...f.map(x => x.torso))} rad)`);
    assert.equal(Math.max(...f.filter(x => x.t < 1.6).map(x => x.pucker)), 0, 'no pucker while she speaks');
    assert.ok(Math.max(...f.map(x => x.pucker)) > 0.9, 'the pucker in the pause');
    assert.equal(Math.max(...f.map(x => x.hands)), 0, 'a kiss: no arms');
    const last = f.at(-1)!;
    assert.ok(Math.abs(last.torso) < 1e-3 && last.blink < 1e-3 && last.pucker < 1e-3, 'back at rest');
    const report = { torsoStep: Math.max(...steps(f.map(x => x.torso))), torsoAccel: Math.max(...accel(f.map(x => x.torso))), blinkStep: Math.max(...steps(f.map(x => x.blink))), puckerStep: Math.max(...steps(f.map(x => x.pucker))) };
    if (REPORT) console.log(`[I-185 window kiss ${fps} fps]`, JSON.stringify(report));
    assert.ok(report.torsoStep < 0.012 * k && report.torsoAccel < 0.0015 * k * k, `lean step ${report.torsoStep}, accel ${report.torsoAccel}`);
    assert.ok(report.blinkStep < 0.09 * k && report.puckerStep < 0.09 * k, `eyes ${report.blinkStep}, pucker ${report.puckerStep}`);
  });

  test(`window ${fps} fps: hug in place — arms forward and wrapped, a small lean; arms held or no arm rig → no arms; a release mid-hug eases back`, () => {
    const run = windowRun(fps, 'hug'), f = run.frames, k = 60 / fps;
    assert.ok(Math.max(...f.map(x => x.hands)) > 0.9, 'both arms come forward');
    assert.ok(Math.max(...f.map(x => x.torso)) > 0.05, 'a small lean');
    assert.ok(f.at(-1)!.hands < 1e-4 && Math.abs(f.at(-1)!.torso) < 1e-3, 'and let go again');
    const report = { handStep: Math.max(...steps(f.map(x => x.hands))), handAccel: Math.max(...accel(f.map(x => x.hands))), torsoStep: Math.max(...steps(f.map(x => x.torso))) };
    if (REPORT) console.log(`[I-185 window hug ${fps} fps]`, JSON.stringify(report));
    assert.ok(report.handStep < 0.04 * k && report.handAccel < 0.004 * k * k && report.torsoStep < 0.012 * k, JSON.stringify(report));
    for (const over of [{ armsHeld: true }, { model: { arms: false } }]) {
      const none = windowRun(fps, 'hug', over);
      assert.ok(none.played);
      assert.deepEqual(none.beats.played, ['hug:lighter']);
      assert.equal(Math.max(...none.frames.map(x => x.hands)), 0, `${JSON.stringify(over)}: never her arms`);
      assert.ok(Math.max(...none.frames.map(x => x.torso)) > 0.02, 'still a lean toward you');
    }
    const cut = windowRun(fps, 'hug', { releaseAt: 1.6 });
    const c = cut.frames;
    assert.ok(Math.max(...steps(c.map(x => x.hands))) < 0.04 * k && Math.max(...steps(c.map(x => x.torso))) < 0.012 * k, 'the release: from where it is, no jump');
    assert.ok(c.at(-1)!.hands < 1e-4);
  });
}
