import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RpsHost, type RpsCharacterState, type RpsHostOptions } from '../electron/rps/host';
import { RpsStore } from '../electron/rps/store';
import { RPS_TIMING, rpsVerify, rpsRevealAfterMs, type RpsView, type RpsCommitment } from '../shared/rps';
import { RPS_VOICE_LATE_MS, RPS_VOICE_SYSTEM_PROMPT } from '../shared/rps-voice';
import { DEFAULT_MOOD_PARAMETERS, applyMoodEvent, createMoodState, getMoodSnapshot } from '../shared/mood';
import { rpsMoodEvent } from '../electron/rps/host';
import { seeded } from './helpers/seeded';

const T = RPS_TIMING;
class Clock {
  now = 1_000_000; private timers: { at: number; fn: () => void; id: number }[] = []; private next = 0;
  readonly timerApi = { set: (fn: () => void, ms: number) => { const id = ++this.next; this.timers.push({ at: this.now + ms, fn, id }); return id; },
    clear: (id: unknown) => { this.timers = this.timers.filter(t => t.id !== id); } };
  /** Timers still waiting (a disposed host owns none). */
  get waiting(): number { return this.timers.length; }
  /** Moves time forward, firing due timers in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const due = this.timers[0];
      if (!due || due.at > end) break;
      this.timers.shift(); this.now = Math.max(this.now, due.at); due.fn();
    }
    this.now = end;
  }
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

interface Options { recording?: boolean; quick?: RpsHostOptions['quick']; available?: () => boolean; character?: Partial<RpsCharacterState>; seed?: number; busy?: () => boolean;
  speaking?: () => boolean; random?: () => number; voiceRandom?: () => number }
async function harness(options: Options = {}) {
  const clock = new Clock(), dir = await mkdtemp(path.join(os.tmpdir(), 'rps-host-'));
  const store = new RpsStore({ file: () => path.join(dir, 'rps.json'), now: () => clock.now }); await store.load();
  const views: (RpsView | null)[] = [], moods: { id: string; delta: object; reason: string }[] = [], styled: string[] = [];
  const state = { visible: true, recording: options.recording ?? true, available: true, character: { id: 'gene', persona: '角色：基恩', parameters: DEFAULT_MOOD_PARAMETERS,
    snapshot: { primary: 'happy', values: { D: 70, O: 50, E: 55, N: 50, C: 40 } }, fatigue: null, herLife: 'company', ...options.character } as RpsCharacterState };
  let n = 0;
  const host = new RpsHost({ store,
    character: () => state.character, visible: () => state.visible, recording: () => state.recording, localDate: () => '2026-11-03',
    publish: view => views.push(view), mood: event => moods.push(event), chatBusy: options.busy ?? (() => false), speaking: options.speaking,
    quick: options.quick, available: options.available ?? (() => state.available), speechStyle: id => styled.push(id),
    clock: () => clock.now, random: options.random ?? seeded(options.seed ?? 5), voiceRandom: options.voiceRandom ?? seeded(11),
    nonce: () => `nonce${++n}`, createId: () => `id${++n}`, timers: clock.timerApi });
  return { host, clock, store, views, moods, styled, state, dir, close: async () => { host.dispose(); await store.flush(); await rm(dir, { recursive: true, force: true }); } };
}
type H = Awaited<ReturnType<typeof harness>>;
const last = (h: H) => h.views.at(-1) ?? null;
/** Plays the current match with `hand` each round, `delayMs` after each round opens (negative: before 布 is never reached → early). */
function playOut(h: H, hand: 'rock' | 'paper' | 'scissors' = 'rock', delayMs = 200) {
  for (let guard = 0; guard < 600 && h.host.active; guard++) {
    const view = last(h);
    if (!view) throw new Error(`no view while active: ${JSON.stringify(h.views.map(v => v && [v.phase, v.round]))}`);
    if (view.accepting && view.userHand === null) { h.clock.advance(delayMs); assert.equal(h.host.throwHand({ gameId: view.id, round: view.round, hand, source: 'click' }), 'accepted'); continue; }
    h.clock.advance(250);
  }
}

test('asking in chat: she agrees in this turn\'s private context, the match starts after the reply, and the window never sees her hand early', async () => {
  const h = await harness();
  assert.equal(h.host.chatTurn('r1', '今天好累'), null);
  const context = h.host.chatTurn('r2', '来玩猜拳吧');
  assert.match(context!, /^【猜拳】用户想和你玩猜拳/u);
  assert.equal(h.views.length, 0, 'nothing shows during her reply');
  h.host.chatDone('r2', true);
  h.clock.advance(800);
  assert.equal(last(h)!.phase, 'ready'); assert.equal(last(h)!.accepting, true);
  const commitments = new Map<number, RpsCommitment>();
  playOut(h, 'paper', 900);
  for (const view of h.views) {
    if (!view) continue;
    if (view.commitment) commitments.set(view.round, view.commitment);
    if (view.phase === 'ready' || view.phase === 'count' || view.phase === 'wait') assert.equal(view.revealed, null, 'hidden before the reveal');
    if (view.phase === 'reveal') assert.ok(rpsVerify(commitments.get(view.round)!, view.revealed!), 'the seal opens to the revealed hand');
  }
  h.clock.advance(T.endMs + 100);
  assert.equal(last(h), null, '玩完就散');
  assert.equal(h.moods.length, 1); assert.equal(h.moods[0].reason, '和用户玩了猜拳');
  assert.equal(h.store.games('gene').length, 1);
  await h.close();
});

/** She agreed in chat and her reply finished (t = 0 for the 700 ms start; Codex T-112 round-004's opening). */
function agreed(h: H): void {
  assert.match(h.host.chatTurn('request-a', '来玩猜拳吧')!, /你正好也想玩/u, 'the accept branch');
  h.host.chatDone('request-a', true);
  assert.equal(h.host.active, false); assert.equal(h.views.length, 0);
}
const started = (h: H) => h.host.active && h.host.stats.matches === 1 && last(h)?.phase === 'ready';
const nothing = (h: H) => !h.host.active && h.host.stats.matches === 0 && h.views.length === 0;

test('G1 the start after her reply (Codex T-112 round-004): uncancelled it opens once at 700 ms; hidden across 700 ms it never opens or retries', async () => {
  const h = await harness();
  agreed(h);
  h.clock.advance(699); assert.ok(nothing(h), 'not at 699 ms');
  h.clock.advance(1); assert.ok(started(h), 'at 700 ms, once');
  h.clock.advance(300); h.host.sweep();
  assert.equal(h.host.stats.matches, 1); assert.equal(h.host.active, true);
  await h.close();
  const hidden = await harness();
  agreed(hidden);
  hidden.clock.advance(200); hidden.state.visible = false;
  hidden.clock.advance(500); assert.ok(nothing(hidden), 'hidden at the deadline: no game');
  hidden.clock.advance(200); hidden.state.visible = true;
  hidden.clock.advance(100); hidden.host.sweep(); hidden.clock.advance(10_000);
  assert.ok(nothing(hidden), 'shown again: the consumed start is not retried');
  await hidden.close();
});

test('G1 a late start never comes back (Codex T-112 round-004): cancel, an ordinary message, another character or disposal before 700 ms', async () => {
  const cancelled = await harness();
  agreed(cancelled);
  cancelled.clock.advance(350); cancelled.host.cancel();
  cancelled.clock.advance(350); assert.ok(nothing(cancelled), 'cancelled at 350 ms: no game, no line, no publish at 700 ms');
  cancelled.clock.advance(300); cancelled.host.sweep(); cancelled.clock.advance(10_000);
  assert.ok(nothing(cancelled), 'and never later');
  await cancelled.close();

  let busy = false;
  const chat = await harness({ busy: () => busy });
  agreed(chat);
  chat.clock.advance(350); busy = true;
  assert.equal(chat.host.chatTurn('request-b', '今天天气如何'), null);
  chat.clock.advance(350); assert.ok(nothing(chat), 'a new ordinary message at 350 ms (still running at 700 ms): no game');
  chat.clock.advance(1_000); busy = false; chat.host.chatDone('request-b', true);
  chat.clock.advance(10_000); assert.ok(nothing(chat), 'nor after that message is answered');
  await chat.close();

  const switched = await harness();
  agreed(switched);
  switched.clock.advance(350); switched.state.character = { ...switched.state.character, id: 'other' };
  switched.clock.advance(10_000); assert.ok(nothing(switched), 'another character at 700 ms: no game');
  await switched.close();

  const disposed = await harness();
  agreed(disposed);
  disposed.clock.advance(350); disposed.host.dispose();
  assert.equal(disposed.clock.waiting, 0, 'a disposed host leaves no timer behind');
  disposed.clock.advance(10_000); assert.ok(nothing(disposed));
  await disposed.close();
});

test('G1 the start waits for the chat turn to be free: never while a chat turn runs, at once when it ends, and gives up if it never does', async () => {
  // In the app chatDone(true) comes while the reply task is still wrapping up (chatBusy is still true then).
  let busy = true;
  const h = await harness({ busy: () => busy });
  agreed(h);
  h.clock.advance(899); assert.ok(nothing(h), 'not while the chat turn still runs');
  busy = false; h.clock.advance(300);
  assert.ok(started(h), 'opens once the turn is free');
  h.clock.advance(5_000); assert.equal(h.host.stats.matches, 1, 'once');
  await h.close();
  let stuck = true;
  const late = await harness({ busy: () => stuck });
  agreed(late);
  late.clock.advance(8_000); stuck = false; late.clock.advance(10_000);
  assert.ok(nothing(late), 'a start that waited too long is dropped, not played late');
  assert.equal(late.clock.waiting, 0, 'and leaves no timer behind');
  await late.close();
});

test('a reply that failed, or a sleepy answer, starts nothing; a sleepy or absorbed character can put it off', async () => {
  const h = await harness({ character: { fatigue: 'drowsy' }, seed: 1 });
  let sleepy = 0;
  for (let i = 0; i < 20; i++) { const context = h.host.chatTurn(`s${i}`, '猜拳！'); if (/困得不行/u.test(context!)) sleepy++; h.host.chatDone(`s${i}`, true); h.clock.advance(800); h.host.cancel(); }
  assert.ok(sleepy >= 12, `sleepy ${sleepy}`);
  const g = await harness();
  g.host.chatTurn('x', '来玩猜拳'); g.host.chatDone('x', false); g.clock.advance(2000);
  assert.equal(g.host.active, false, 'a failed reply starts no game');
  await h.close(); await g.close();
});

test('first, on the beat, or late: the host takes the hand; a late hand never sees her hand; a stale or camera hand is refused', async () => {
  for (const delay of [100, T.readyMs + rpsRevealAfterMs(T), T.readyMs + rpsRevealAfterMs(T) + 4000]) {
    const h = await harness({ seed: 9 });
    h.host.chatTurn('a', '来玩猜拳'); h.host.chatDone('a', true); h.clock.advance(800);
    const open = last(h)!;
    h.clock.advance(delay);
    if (delay > T.readyMs + rpsRevealAfterMs(T)) { assert.equal(last(h)!.phase, 'wait'); assert.equal(last(h)!.revealed, null); }
    assert.equal(h.host.throwHand({ gameId: open.id, round: 1, hand: 'rock', source: 'camera' }), 'invalid', 'no camera input yet');
    assert.equal(h.host.throwHand({ gameId: open.id, round: 2, hand: 'rock', source: 'click' }), 'stale');
    assert.equal(h.host.throwHand({ gameId: 'other', round: 1, hand: 'rock', source: 'click' }), 'closed');
    assert.equal(h.host.throwHand({ gameId: open.id, round: 1, hand: 'rock', source: 'click' }), 'accepted');
    h.clock.advance(rpsRevealAfterMs(T) + T.readyMs);
    assert.ok(h.views.some(view => view?.phase === 'reveal' && view.round === 1));
    await h.close();
  }
});

test('her invitation: buttons only after the line was shown; accept plays, decline says it lightly, ignoring just lets it go', async () => {
  const h = await harness();
  assert.equal(h.host.inviteEligible('gene', false), true);
  assert.equal(h.host.inviteEligible('gene', true), false, 'quiet');
  h.host.invited('gene');
  const invite = last(h)!;
  assert.equal(invite.phase, 'invite');
  assert.equal(h.host.inviteEligible('gene', false), false, 'one at a time');
  assert.equal(h.host.respond({ id: invite.id, action: 'accept' }), true);
  assert.equal(last(h)!.phase, 'ready');
  h.host.respond({ id: last(h)!.id, action: 'quit' });
  assert.equal(last(h)!.phase, 'end'); assert.equal(last(h)!.line, null, 'no table line any more');
  h.clock.advance(T.endMs + 50); assert.equal(last(h), null);
  // Two hours later: decline.
  h.clock.advance(2 * 3_600_000 + 1);
  assert.equal(h.host.inviteEligible('gene', false), true);
  h.host.invited('gene');
  h.host.respond({ id: last(h)!.id, action: 'decline' });
  assert.equal(last(h), null, 'the buttons go at once; with nothing to say (no model, nothing remembered) she stays quiet');
  // Two invitations today: no third, however long she waits.
  h.clock.advance(3 * 3_600_000);
  assert.equal(h.host.inviteEligible('gene', false), false);
  await h.close();
  const quiet = await harness();
  quiet.host.invited('gene'); quiet.clock.advance(T.inviteMs + 10);
  assert.equal(last(quiet), null, 'an ignored invitation quietly goes away');
  await quiet.close();
});

test('a chat message or hiding ends an open game (玩完就散); the mood event waits for a running chat turn', async () => {
  let busy = false;
  const h = await harness({ busy: () => busy });
  h.host.chatTurn('a', '来玩猜拳'); h.host.chatDone('a', true); h.clock.advance(800);
  const view = last(h)!; h.host.throwHand({ gameId: view.id, round: 1, hand: 'rock', source: 'click' });
  h.clock.advance(T.readyMs + rpsRevealAfterMs(T) + 100);
  assert.equal(last(h)!.phase, 'reveal');
  busy = true; // chat turn b runs from here until its chatDone
  h.host.chatTurn('b', '我去吃饭啦');
  assert.equal(last(h), null); assert.equal(h.host.active, false);
  assert.equal(h.moods.length, 0, 'held while the chat turn runs');
  busy = false; h.host.chatDone('b', true);
  assert.equal(h.moods.length, 1, 'then applied once');
  await h.close();
});

test('the user profile switch decides what is remembered: off keeps no hands, on keeps them and grows the habit and the diary line', async () => {
  const off = await harness({ recording: false });
  off.host.chatTurn('a', '来玩猜拳'); off.host.chatDone('a', true); off.clock.advance(800); playOut(off); off.clock.advance(T.endMs + 100);
  assert.deepEqual(off.store.games('gene'), []);
  await off.store.flush();
  assert.doesNotMatch(await readFile(path.join(off.dir, 'rps.json'), 'utf8'), /"rounds"/u, 'no hands on disk');
  await off.close();
  const on = await harness({ recording: true });
  for (let i = 0; i < 4; i++) {
    on.host.chatTurn(`g${i}`, '来玩猜拳'); on.host.chatDone(`g${i}`, true); on.clock.advance(800); playOut(on, 'rock'); on.clock.advance(T.endMs + 100);
    on.clock.advance(60_000);
  }
  assert.equal(on.store.games('gene').length, 4);
  const line = on.host.diaryLine('gene', 0, Number.MAX_SAFE_INTEGER);
  assert.match(line, /玩了猜拳/u); assert.match(line, /老是先出石头/u);
  await on.close();
});

/** Plays the current match like a window would: throws `delayMs` after each round opens and answers `said` for every line it shows. */
async function playVoiced(h: H, hand: 'rock' | 'paper' | 'scissors' = 'rock', delayMs = 200, reply = true): Promise<string[]> {
  const said: string[] = [];
  for (let guard = 0; guard < 800 && h.host.active; guard++) {
    await flush();
    const view = last(h);
    if (view?.say && !said.includes(view.say.id)) { said.push(view.say.id); if (reply) h.host.respond({ id: view.say.id, action: 'said' }); continue; }
    if (view?.accepting && view.userHand === null) { h.clock.advance(delayMs); h.host.throwHand({ gameId: view.id, round: view.round, hand, source: 'click' }); continue; }
    h.clock.advance(250);
  }
  await flush();
  return said;
}
const sayTexts = (h: H) => [...new Map(h.views.filter(view => view?.say).map(view => [view!.say!.id, view!.say!.text])).values()];

test('her words: asked as soon as both hands are in, shown at the reveal as `say` for the chat bubble, the game waits while she talks', async () => {
  const prompts: string[] = [];
  let answer: (raw: string) => void = () => {};
  const quick = (prompt: string, system: string) => { prompts.push(prompt); assert.equal(system, RPS_VOICE_SYSTEM_PROMPT); return new Promise<string>(resolve => { answer = resolve; }); };
  const h = await harness({ quick, voiceRandom: () => 0 });
  h.host.chatTurn('a', '来玩猜拳'); h.host.chatDone('a', true); h.clock.advance(800);
  const open = last(h)!;
  h.clock.advance(300);
  assert.equal(h.host.throwHand({ gameId: open.id, round: 1, hand: 'rock', source: 'click' }), 'accepted');
  await flush();
  assert.equal(prompts.length, 1, 'asked at the throw, while the count still runs');
  assert.match(prompts[0], /刚刚揭晓：第一次你出(?:石头|剪刀|布)、用户出石头/u);
  assert.match(prompts[0], /^角色：基恩/u, 'in her own persona');
  assert.ok(h.views.every(view => !view?.say), 'nothing is said before the reveal');
  h.clock.advance(T.readyMs + rpsRevealAfterMs(T));
  assert.equal(last(h)!.phase, 'reveal'); assert.equal(last(h)!.say ?? null, null, 'still coming');
  h.clock.advance(T.reactMs + 500);
  assert.equal(last(h)!.phase, 'reveal', 'the reveal waits for her words');
  answer('{"text":"嘿嘿，这局算我的"}'); await flush();
  const shown = last(h)!;
  assert.equal(shown.phase, 'reveal'); assert.equal(shown.say!.text, '嘿嘿，这局算我的');
  assert.deepEqual(h.styled, [shown.say!.id], 'its voice style is frozen before it is shown');
  h.clock.advance(1000); assert.equal(last(h)!.phase, 'reveal', 'held while the window reads it');
  assert.equal(h.host.respond({ id: shown.say!.id, action: 'said' }), true);
  assert.equal(h.host.respond({ id: shown.say!.id, action: 'said' }), false, 'once');
  h.clock.advance(500);
  assert.notEqual(last(h)!.phase, 'reveal', 'then the game goes on'); assert.equal(last(h)!.say ?? null, null);
  assert.equal(h.host.stats.linesSaid, 1); assert.equal(h.host.voiceStats.calls, 1);
  await h.close();
  // Ready long before 布 (the user threw early): still nothing until the reveal, then at once.
  const quickOne = await harness({ quick: async () => '{"text":"看我的！"}', voiceRandom: () => 0 });
  quickOne.host.chatTurn('a', '来玩猜拳'); quickOne.host.chatDone('a', true); quickOne.clock.advance(800);
  quickOne.host.throwHand({ gameId: last(quickOne)!.id, round: 1, hand: 'rock', source: 'click' });
  for (let i = 0; i < 40 && last(quickOne)!.phase !== 'reveal'; i++) { await flush(); assert.equal(last(quickOne)!.say ?? null, null, `before the reveal (${last(quickOne)!.phase})`); quickOne.clock.advance(100); }
  assert.equal(last(quickOne)!.phase, 'reveal'); assert.equal(last(quickOne)!.say!.text, '看我的！', 'said the moment it is revealed');
  assert.ok(quickOne.views.filter(view => view && view.phase !== 'reveal' && view.round === 1).every(view => !view!.say));
  await quickOne.close();
});

// Codex T-112 round 028 (fixed 17f9807): with the pet busy the window skipped the line (no bubble, no voice), yet the host had
// already counted it as said (linesSaid and today's said, which presses her later lines down). Said only once it was shown.
async function revealLine(h: H) {
  h.host.chatTurn('a', '来玩猜拳'); h.host.chatDone('a', true); h.clock.advance(800);
  h.host.throwHand({ gameId: last(h)!.id, round: 1, hand: 'rock', source: 'click' });
  for (let i = 0; i < 60 && !last(h)!.say; i++) { await flush(); h.clock.advance(100); }
  const shown = last(h)!;
  assert.equal(shown.phase, 'reveal'); assert.ok(shown.say, 'her line is on show');
  return shown;
}
test('round 028: a line the window skipped is not counted as said; a line it showed counts even when its answer comes after the game went on', async () => {
  const skipped = await harness({ quick: async () => '{"text":"嘿嘿，这局算我的"}', voiceRandom: () => 0 });
  const shown = await revealLine(skipped);
  assert.equal(skipped.host.stats.linesSaid, 0, 'handed to the window is not said yet');
  assert.equal(skipped.host.respond({ id: shown.say!.id, action: 'skipped' }), true);
  assert.equal(skipped.host.respond({ id: shown.say!.id, action: 'said' }), false, 'answered once');
  skipped.clock.advance(T.reactMs + 500);
  assert.notEqual(last(skipped)!.phase, 'reveal', 'the game goes on as after a said line (no hold for the whole reading time)');
  assert.equal(skipped.host.stats.linesSaid, 0);
  assert.equal(skipped.store.voiceOn('2026-11-03').said, 0, 'today\'s count (it presses her later lines down) is untouched');
  assert.equal(skipped.host.voiceStats.live, 0, 'a live line not shown is not kept as one she said');
  await skipped.close();
  const slow = await harness({ quick: async () => '{"text":"嘿嘿，这局算我的"}', voiceRandom: () => 0 });
  const line = await revealLine(slow);
  slow.clock.advance(13_000); // longer than any hold (rpsSayHoldMs): the game moved on without her answer
  assert.ok(!last(slow)?.say, 'the moment is over');
  assert.equal(slow.host.respond({ id: line.say!.id, action: 'said' }), true, 'a late answer for a line it did show');
  assert.equal(slow.host.stats.linesSaid, 1); assert.equal(slow.store.voiceOn('2026-11-03').said, 1);
  assert.equal(slow.host.respond({ id: line.say!.id, action: 'said' }), false, 'once');
  assert.equal(slow.host.respond({ id: 'nothing', action: 'skipped' }), false, 'an unknown line changes nothing');
  await slow.close();
});

test('her words: a late line is dropped (the game went on); a line still coming when the game is left never shows; a working note never shows', async () => {
  let answer: (raw: string) => void = () => {};
  const late = await harness({ quick: () => new Promise(resolve => { answer = resolve; }), voiceRandom: () => 0 });
  late.host.chatTurn('a', '来玩猜拳'); late.host.chatDone('a', true); late.clock.advance(800);
  late.host.throwHand({ gameId: last(late)!.id, round: 1, hand: 'rock', source: 'click' }); await flush(); // the call is made
  late.clock.advance(T.readyMs + rpsRevealAfterMs(T) + RPS_VOICE_LATE_MS + 100);
  assert.notEqual(last(late)!.phase, 'reveal', 'not held past the late limit');
  answer('{"text":"迟到的话"}'); await flush();
  assert.equal(sayTexts(late).length, 0, 'a late line is dropped'); assert.equal(late.host.voiceStats.calls, 1, 'it was asked');
  await late.close();
  // The host's timer itself runs late (a busy event loop): a line that comes after the limit is still dropped.
  const slowTimer = await harness({ quick: () => new Promise(resolve => { answer = resolve; }), voiceRandom: () => 0 });
  slowTimer.host.chatTurn('a', '来玩猜拳'); slowTimer.host.chatDone('a', true); slowTimer.clock.advance(800);
  slowTimer.host.throwHand({ gameId: last(slowTimer)!.id, round: 1, hand: 'rock', source: 'click' }); await flush(); // the call is made
  slowTimer.clock.advance(T.readyMs + rpsRevealAfterMs(T));
  assert.equal(last(slowTimer)!.phase, 'reveal');
  slowTimer.clock.now += RPS_VOICE_LATE_MS + 50; // time passes, the timer has not fired yet
  answer('{"text":"迟到的话"}'); await flush();
  assert.equal(sayTexts(slowTimer).length, 0, 'past the limit by the clock: dropped'); assert.equal(slowTimer.host.voiceStats.calls, 1);
  await slowTimer.close();

  const left = await harness({ quick: () => new Promise(resolve => { answer = resolve; }), voiceRandom: () => 0 });
  left.host.chatTurn('a', '来玩猜拳'); left.host.chatDone('a', true); left.clock.advance(800);
  left.host.throwHand({ gameId: last(left)!.id, round: 1, hand: 'rock', source: 'click' }); await flush(); // the call is made
  left.clock.advance(T.readyMs + rpsRevealAfterMs(T) + 100);
  left.host.chatTurn('b', '我去吃饭啦');
  assert.equal(last(left), null);
  answer('{"text":"嘿嘿"}'); await flush(); left.clock.advance(10_000);
  assert.equal(sayTexts(left).length, 0, 'the game was left: her line for it never shows'); assert.equal(left.host.voiceStats.calls, 1);
  await left.close();

  for (const raw of ['I should keep it short. {"text":"好"}', '{"text":"用户赢了，我要表现得不服气"}', '{"text":"（扬起下巴）哼"}', '{"text":"x","note":"y"}']) {
    const noted = await harness({ quick: async () => raw, voiceRandom: () => 0 });
    noted.host.chatTurn('a', '来玩猜拳'); noted.host.chatDone('a', true); noted.clock.advance(800);
    await playVoiced(noted);
    assert.equal(sayTexts(noted).length, 0, raw);
    await noted.close();
  }
});

test('without the model: lines she herself said before at that kind of moment (never a written table); none yet: she stays quiet', async () => {
  let calls = 0;
  const h = await harness({ quick: async () => { calls++; return '{"text":"再来再来！"}'; }, voiceRandom: () => 0 });
  h.host.chatTurn('a', '来玩猜拳'); h.host.chatDone('a', true); h.clock.advance(800);
  await playVoiced(h, 'rock');
  assert.ok(calls >= 1);
  h.clock.advance(T.endMs + 100); h.views.length = 0;
  h.state.available = false;
  const before = calls;
  h.host.chatTurn('b', '来玩猜拳'); h.host.chatDone('b', true); h.clock.advance(800);
  await playVoiced(h, 'rock');
  assert.equal(calls, before, 'not asked while Claude cannot answer');
  const texts = sayTexts(h);
  assert.ok(texts.length >= 1, 'she still says something');
  assert.ok(texts.every(text => text === '再来再来！'), texts.join('|'));
  assert.ok(h.host.voiceStats.remembered >= 1);
  await h.close();
  const fresh = await harness({ quick: async () => { throw new Error('not while unavailable'); }, available: () => false, voiceRandom: () => 0 });
  fresh.host.chatTurn('a', '来玩猜拳'); fresh.host.chatDone('a', true); fresh.clock.advance(800);
  await playVoiced(fresh, 'rock');
  assert.equal(sayTexts(fresh).length, 0, 'nothing remembered yet: her face says it');
  assert.equal(fresh.store.games('gene').length, 1, 'the game itself is played as always');
  await fresh.close();
});

test('the pretend cheat lives in her words: the fake hand shows only while she says it, then she owns up; when she will not say it, it is a plain loss', async () => {
  // random 0: round 1 she lets the user win with scissors-vs-rock habit guess (she plays scissors), round 2 a fair rock that
  // loses to paper and rolls the tease (teaseChance > 0).
  const prompts: string[] = [];
  let tell: (raw: string) => void = () => {};
  const h = await harness({ random: () => 0, voiceRandom: () => 0, quick: prompt => { prompts.push(prompt);
    return /其实出的是/u.test(prompt) ? new Promise<string>(resolve => { tell = resolve; }) : Promise.resolve('{"text":"哼"}'); } });
  h.host.chatTurn('a', '来玩猜拳'); h.host.chatDone('a', true); h.clock.advance(800);
  // Round 1.
  h.host.throwHand({ gameId: last(h)!.id, round: 1, hand: 'paper', source: 'click' }); await flush();
  for (let i = 0; i < 80 && last(h)!.round === 1; i++) { await flush(); const v = last(h)!; if (v.say) h.host.respond({ id: v.say.id, action: 'said' }); h.clock.advance(250); }
  // Round 2: the tease. Her words come a moment after the reveal.
  h.host.throwHand({ gameId: last(h)!.id, round: 2, hand: 'paper', source: 'click' }); await flush();
  assert.ok(prompts.some(prompt => /其实出的是剪刀/u.test(prompt)), 'asked for the pretend cheat, naming the hand that beats paper');
  for (let i = 0; i < 40 && last(h)!.phase !== 'reveal'; i++) h.clock.advance(100);
  h.clock.advance(800);
  assert.equal(last(h)!.phase, 'reveal');
  assert.ok(h.views.filter(view => view?.phase === 'reveal' && view.round === 2).every(view => view!.tease === null), 'no fake hand before her words');
  tell('{"text":"等等，我出的是剪刀！骗你的啦"}'); await flush();
  const reveal = h.views.filter(view => view?.phase === 'reveal' && view.round === 2);
  assert.equal(reveal[0]!.revealed!.hand, 'rock', 'the real hand is revealed');
  const teasing = reveal.find(view => view!.tease);
  assert.ok(teasing, 'then the fake hand while she says it');
  assert.equal(teasing!.tease, 'scissors'); assert.equal(teasing!.face, 'tease'); assert.match(teasing!.say!.text, /骗你的/u);
  assert.equal(teasing!.score.user, 1, 'the score never changes');
  h.clock.advance(T.teaseMs + 10);
  assert.equal(last(h)!.tease, null); assert.equal(last(h)!.face, 'happy', 'owning up');
  await h.close();

  const mute = await harness({ random: () => 0, voiceRandom: () => 0 });
  mute.host.chatTurn('a', '来玩猜拳'); mute.host.chatDone('a', true); mute.clock.advance(800);
  await playVoiced(mute, 'paper');
  assert.ok(mute.views.some(view => view?.phase === 'reveal' && view.outcome === 'user'));
  assert.ok(mute.views.every(view => !view?.tease), 'no words, no pretend hand');
  assert.ok(mute.views.filter(view => view?.phase === 'reveal' && view.outcome === 'user').every(view => view!.face === 'pout'), 'a plain loss');
  await mute.close();
});

test('her answer to "下次吧" is a line in the chat bubble (an aside view with nothing else), gone once read', async () => {
  const h = await harness({ quick: async () => '{"text":"好吧，那下次哦"}', voiceRandom: () => 0 });
  h.host.invited('gene');
  h.host.respond({ id: last(h)!.id, action: 'decline' });
  assert.equal(last(h), null, 'the buttons go at once');
  await flush();
  const aside = last(h)!;
  assert.equal(aside.phase, 'aside'); assert.equal(aside.say!.text, '好吧，那下次哦'); assert.equal(aside.accepting, false);
  h.host.respond({ id: aside.say!.id, action: 'said' });
  h.clock.advance(10);
  assert.equal(last(h), null);
  await h.close();
});

test('she starts the game after her voice has read her yes (and at most 20 s later)', async () => {
  let talking = true;
  const h = await harness({ speaking: () => talking });
  agreed(h);
  h.clock.advance(3_000); assert.ok(nothing(h), 'not while she is still talking');
  talking = false; h.clock.advance(300);
  assert.ok(started(h));
  await h.close();
  const long = await harness({ speaking: () => true });
  agreed(long);
  long.clock.advance(19_000); assert.ok(nothing(long));
  long.clock.advance(1_500); assert.equal(long.host.active, true, 'a very long reading does not cancel the game');
  await long.close();
});

test('not every round: over many matches she speaks now and then, more at the decisive one, pressed down by what she already said', async () => {
  let calls = 0;
  const h = await harness({ quick: async () => { calls++; return '{"text":"嗯哼"}'; }, voiceRandom: seeded(3), seed: 8 });
  const perMatch: number[] = [];
  for (let i = 0; i < 40; i++) {
    const before = h.host.stats.linesSaid;
    h.host.chatTurn(`m${i}`, '来玩猜拳'); h.host.chatDone(`m${i}`, true); h.clock.advance(800);
    await playVoiced(h, (['rock', 'paper', 'scissors'] as const)[i % 3]);
    h.clock.advance(T.endMs + 100); h.views.length = 0;
    perMatch.push(h.host.stats.linesSaid - before);
  }
  const average = perMatch.reduce((a, b) => a + b, 0) / perMatch.length;
  assert.ok(average >= 0.5 && average <= 2.2, `lines per match ${average}`);
  assert.ok(perMatch.some(n => n === 0) || average < 2, 'not a line at every round');
  assert.equal(calls, h.host.voiceStats.calls);
  await h.close();
});

test('the mood event is the existing positive chat event with its own topic: her mood improves, repeats give less', () => {
  let state = createMoodState(0);
  const before = getMoodSnapshot(state, 0).values.D;
  state = applyMoodEvent(state, rpsMoodEvent({ id: 'rps-1', delta: { D: 6, O: 3, E: 4 }, reason: '和用户玩了猜拳' }), 1000);
  const once = getMoodSnapshot(state, 1000).values.D - before;
  assert.ok(once > 0);
  const mid = getMoodSnapshot(state, 2000).values.D;
  state = applyMoodEvent(state, rpsMoodEvent({ id: 'rps-2', delta: { D: 6, O: 3, E: 4 }, reason: '和用户玩了猜拳' }), 2000);
  assert.ok(getMoodSnapshot(state, 2000).values.D - mid < once, 'diminishing');
});
