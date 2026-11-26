// 2026-11-24 (续) 「和她一起看」 keeps going or says so.
// A lost share gives her the facts in ONE immediate turn (never when the user turned it off, never twice for one loss, not on top of a message in flight);
// a minimize pauses watching and the window coming back resumes it only if the user turned nothing off meanwhile; the next turn is told the facts.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { MediaRuntime } from '../electron/senses/media-runtime';
import { WatchContinuity, WatchFactsTurn, type WatchFactsOutcome } from '../electron/senses';
import { CAPTURE_MISSES_FOR_LOSS } from '../electron/senses/watch-continuity';
import { awayFacts, lossFacts, lossPrompt } from '../electron/senses/watch-continuity/facts';
import { WatchOffDetector, clearWatchOffCause, noteWatchOffCause, onWatchUserOff } from '../electron/senses/watch-off-notice';
import { buildJournalEntry } from '../shared/memory/journal';
import { companionHiddenStep } from '../electron/stage/companion-hidden';

const OWNER = 'pet' as const; // no-pet-ok: the media owner id of the companion window
beforeEach(() => clearWatchOffCause());

type Row = { event: string; why?: string; awayS?: number };
interface Rig {
  media: MediaRuntime; continuity: WatchContinuity; rows: Row[]; spoken: string[]; resumes: { count: number }; tick(ms?: number): void; advance(ms: number): void;
  state: { dialogue: boolean; inFlight: boolean; character: string; refuse: boolean; outcome: WatchFactsOutcome; resumeWorks: boolean };
  stopListening(): void;
}
/** The pieces as the wiring joins them: the media switches, the detector that sees watching end, the continuity, and a speaker that records what she was given. */
function rig(): Rig {
  const media = new MediaRuntime();
  let clock = 5_000_000;
  const state = { dialogue: true, inFlight: false, character: 'gene', refuse: false, outcome: 'said' as WatchFactsOutcome, resumeWorks: true };
  const rows: Row[] = [], spoken: string[] = [], resumes = { count: 0 };
  const watching = () => media.state.screenSharing === true && state.dialogue;
  const continuity = new WatchContinuity({
    now: () => clock, characterId: () => state.character, watching, screenOpening: () => media.openings.screen,
    screenAllowed: () => media.state.screenSharing === true && !state.refuse, userTurnInFlight: () => state.inFlight,
    journal: row => rows.push(row),
    resume: async () => { resumes.count++; if (state.resumeWorks) state.dialogue = true; return state.resumeWorks && watching(); },
  });
  continuity.attachSpeaker(async facts => { spoken.push(facts); return state.outcome; });
  const detector = new WatchOffDetector({ on: watching, now: () => clock, ended: (why, lasted) => continuity.ended(why, lasted ?? 0), began: () => continuity.began() });
  const stopListening = onWatchUserOff(() => continuity.userOff());
  return { media, continuity, rows, spoken, resumes, state, stopListening, advance: ms => { clock += ms; }, tick: (ms = 1000) => { clock += ms; detector.tick(); } };
}
const nextTick = () => new Promise<void>(resolve => setImmediate(resolve));
const WORDING = /不要|别|请|应该|可以说|告诉|提醒|安慰|道歉/u;

// ---------------------------------------------------------------- the share lost

test('watching ended and nobody could say why: exactly one immediate turn, with the facts and no wording', async () => {
  const r = rig();
  r.media.update({ screenSharing: true }, OWNER); r.tick(); r.tick(60_000 * 25);
  r.state.dialogue = false; r.tick(); // it stopped; no place noted a cause
  await nextTick();
  assert.equal(r.spoken.length, 1);
  assert.match(r.spoken[0]!, /断了/u); assert.match(r.spoken[0]!, /没有哪一处说得出原因/u); assert.match(r.spoken[0]!, /25 分钟/u);
  assert.doesNotMatch(r.spoken[0]!, WORDING, 'facts only: no suggested wording, no instruction');
  assert.deepEqual(r.rows.map(row => [row.event, row.why]), [['share-lost', 'unexplained']]);
  r.stopListening();
});

test('the user turning the screen or the dialogue off is not a loss: no turn, no row', async () => {
  const a = rig();
  a.media.update({ screenSharing: true }, OWNER); a.tick(); a.media.update({ screenSharing: false }, OWNER); a.tick();
  const b = rig();
  b.media.update({ screenSharing: true }, OWNER); b.tick(); noteWatchOffCause('user'); b.state.dialogue = false; b.tick();
  await nextTick();
  assert.equal(a.spoken.length + b.spoken.length, 0);
  assert.equal(a.rows.length + b.rows.length, 0);
  a.stopListening(); b.stopListening();
});

test("her window's own steps (hidden, gone, a character change, a reset) are not a loss either", async () => {
  for (const why of ['window-hidden', 'window-gone', 'conversation-change', 'reset'] as const) {
    const r = rig();
    r.media.update({ screenSharing: true }, OWNER); r.tick();
    noteWatchOffCause(why); r.state.dialogue = false; r.tick();
    await nextTick();
    assert.equal(r.spoken.length, 0, why);
    clearWatchOffCause(); r.stopListening();
  }
});

test('the capture giving nothing again and again is the share lost, once, however long it goes on', async () => {
  const r = rig();
  r.media.update({ screenSharing: true }, OWNER); r.tick();
  for (let i = 0; i < CAPTURE_MISSES_FOR_LOSS * 3; i++) r.continuity.captureMissed();
  await nextTick();
  assert.equal(r.spoken.length, 1, 'one loss, one turn');
  assert.match(r.spoken[0]!, /画面连着取不到/u);
  // a picture came again, then it is lost again: that is a new loss
  r.continuity.captureOk();
  for (let i = 0; i < CAPTURE_MISSES_FOR_LOSS; i++) r.continuity.captureMissed();
  await nextTick();
  assert.equal(r.spoken.length, 2);
  r.stopListening();
});

test('a miss now and then is not a loss, and a loss is not counted twice by two ways of seeing it', async () => {
  const r = rig();
  r.media.update({ screenSharing: true }, OWNER); r.tick();
  for (let i = 0; i < CAPTURE_MISSES_FOR_LOSS * 2; i++) { r.continuity.captureMissed(); r.continuity.captureMissed(); r.continuity.captureOk(); }
  await nextTick();
  assert.equal(r.spoken.length, 0);
  r.continuity.sourceGone(); r.continuity.sourceGone();
  r.state.dialogue = false; r.tick(); // then it ended unexplained, in the same loss
  await nextTick();
  assert.equal(r.spoken.length, 1, 'the same loss: one turn');
  assert.match(r.spoken[0]!, /窗口或屏幕不在了/u);
  r.stopListening();
});

test('while the user has a message in flight no turn starts; the facts ride on her next turn, once', async () => {
  const r = rig();
  r.media.update({ screenSharing: true }, OWNER); r.tick();
  r.state.inFlight = true;
  r.state.dialogue = false; r.tick();
  await nextTick();
  assert.equal(r.spoken.length, 0);
  const note = r.continuity.takeNotes();
  assert.match(note, /断了/u); assert.match(note, /一起看的事实/u);
  assert.equal(r.continuity.takeNotes(), '', 'taken once');
  r.stopListening();
});

test('a turn that could not reach the user keeps the facts for her next turn; one she said or chose to skip does not', async () => {
  for (const [outcome, kept] of [['undelivered', true], ['said', false], ['quiet', false]] as const) {
    const r = rig();
    r.state.outcome = outcome;
    r.media.update({ screenSharing: true }, OWNER); r.tick(); r.state.dialogue = false; r.tick();
    await nextTick();
    assert.equal(r.continuity.takeNotes() !== '', kept, outcome);
    r.stopListening();
  }
});

test('the facts and her prompt never carry wording for her to use', () => {
  for (const cause of ['capture-lost', 'source-gone', 'unexplained'] as const) assert.doesNotMatch(lossFacts({ cause, at: 1, lastedMs: 90 * 60_000 }), WORDING);
  for (const text of [awayFacts({ awayMs: 5 * 60_000, resumed: true }), awayFacts({ awayMs: 9_000, resumed: false, notResumed: 'turned-off' })]) assert.doesNotMatch(text, WORDING);
  const prompt = lossPrompt({ persona: '她的性格', facts: lossFacts({ cause: 'capture-lost', at: 1, lastedMs: 60_000 }) });
  assert.doesNotMatch(prompt.slice(prompt.indexOf('<watch-facts>'), prompt.indexOf('</watch-facts>')), WORDING);
});

// ---------------------------------------------------------------- her window away and back

test('minimized then back: paused, then resumed by itself, and her next turn is told', async () => {
  const r = rig();
  r.media.update({ screenSharing: true }, OWNER); r.tick();
  r.continuity.minimized(); r.state.dialogue = false; r.tick(); // the sound stops with the window
  assert.equal(r.continuity.waiting, true);
  r.advance(5 * 60_000);
  await r.continuity.restored();
  assert.equal(r.resumes.count, 1);
  assert.deepEqual(r.rows.map(row => row.event), ['paused', 'resumed']);
  assert.equal(r.rows[1]!.awayS, 301); // 300 s away plus the second the sound took to stop
  assert.equal(r.spoken.length, 0, 'no Claude call for a minimize');
  const note = r.continuity.takeNotes();
  assert.match(note, /最小化了 5 分钟/u); assert.match(note, /接着开了/u);
  assert.doesNotMatch(note, WORDING);
  r.stopListening();
});

test('the user turned watching off while it was minimized: not resumed', async () => {
  const r = rig();
  r.media.update({ screenSharing: true }, OWNER); r.tick();
  r.continuity.minimized(); r.state.dialogue = false; r.tick();
  noteWatchOffCause('user'); // their own off, from the toolbar, the settings or Unbound
  await r.continuity.restored();
  assert.equal(r.resumes.count, 0);
  assert.deepEqual(r.rows.map(row => [row.event, row.why]), [['paused', undefined], ['not-resumed', 'turned-off']]);
  assert.match(r.continuity.takeNotes(), /没有接着开/u);
  r.stopListening();
});

test('the screen turned off while it was minimized: not resumed (also when it was turned off and on again)', async () => {
  const off = rig();
  off.media.update({ screenSharing: true }, OWNER); off.tick();
  off.continuity.minimized(); off.state.dialogue = false; off.tick();
  off.media.update({ screenSharing: false }, OWNER);
  await off.continuity.restored();
  assert.equal(off.resumes.count, 0); assert.equal(off.rows.at(-1)!.event, 'not-resumed');
  const again = rig();
  again.media.update({ screenSharing: true }, OWNER); again.tick();
  again.continuity.minimized(); again.state.dialogue = false; again.tick();
  again.media.update({ screenSharing: false }, OWNER); again.media.update({ screenSharing: true }, OWNER);
  await again.continuity.restored();
  assert.equal(again.resumes.count, 0, 'a new opening of the screen is the user\'s own choice, not hers to build on');
  off.stopListening(); again.stopListening();
});

test('the screen sense revoked while minimized (a "别看" or a refusal): not resumed', async () => {
  const r = rig();
  r.media.update({ screenSharing: true }, OWNER); r.tick();
  r.continuity.minimized(); r.state.dialogue = false; r.tick();
  r.state.refuse = true;
  await r.continuity.restored();
  assert.equal(r.resumes.count, 0);
  assert.deepEqual(r.rows.at(-1), { event: 'not-resumed', why: 'screen-gone', awayS: 1 });
  r.stopListening();
});

test('a different character when the window is back: not resumed, nothing said of it to the new one', async () => {
  const r = rig();
  r.media.update({ screenSharing: true }, OWNER); r.tick();
  r.continuity.minimized(); r.state.dialogue = false; r.tick();
  r.state.character = 'someone-else';
  await r.continuity.restored();
  assert.equal(r.resumes.count, 0);
  assert.equal(r.rows.at(-1)!.why, 'changed');
  assert.equal(r.continuity.takeNotes(), '');
  r.stopListening();
});

test('a minimize while not watching pauses nothing; a restore with nothing paused does nothing; the dialogue refusing is told, not forced', async () => {
  const r = rig();
  r.continuity.minimized(); await r.continuity.restored();
  assert.equal(r.rows.length, 0);
  r.media.update({ screenSharing: true }, OWNER); r.tick();
  r.continuity.minimized(); r.state.dialogue = false; r.tick();
  r.state.resumeWorks = false;
  await r.continuity.restored();
  assert.deepEqual(r.rows.at(-1)!.why, 'not-allowed');
  r.stopListening();
});

test('a restore asked twice at once resumes once', async () => {
  const r = rig();
  r.media.update({ screenSharing: true }, OWNER); r.tick();
  r.continuity.minimized(); r.state.dialogue = false; r.tick();
  await Promise.all([r.continuity.restored(), r.continuity.restored()]);
  assert.equal(r.resumes.count, 1);
  r.stopListening();
});

test('the window steps: a minimize is told before the sound stops, the window back is told', () => {
  const calls: string[] = [];
  let minimized = true, visible = true;
  const win = { isDestroyed: () => false, isVisible: () => visible, isMinimized: () => minimized };
  const ports = { onScreen: () => false, stopSystemAudio: () => calls.push('stop'), cancelCompletedReply: () => calls.push('cancel'), resetPointer: () => calls.push('pointer'),
    minimized: () => calls.push('minimized'), restored: () => calls.push('restored') };
  companionHiddenStep(win, ports);
  assert.deepEqual(calls, ['minimized', 'stop', 'pointer']);
  calls.length = 0; minimized = false;
  companionHiddenStep(win, ports);
  assert.deepEqual(calls, ['restored']);
  calls.length = 0; visible = false; // hidden to the tray: no pause is made of it
  companionHiddenStep(win, ports);
  assert.equal(calls.includes('minimized'), false);
});

// ---------------------------------------------------------------- her one turn

function turnRig(overrides: Partial<ConstructorParameters<typeof WatchFactsTurn>[0]> = {}) {
  const out = { published: [] as string[], archived: [] as string[], styles: [] as string[], prompts: [] as string[] };
  let character = 'gene', free = true, identity = 'scope-1', answer = '{"text":"诶，刚才好像断了一下"}';
  const turn: WatchFactsTurn = new WatchFactsTurn({
    chatModel: () => 'opus', character: () => ({ id: character, persona: '她是她', language: '' }), mood: () => '', identity: () => identity, available: () => true,
    line: async prompt => { out.prompts.push(prompt); return answer; }, free: () => free,
    publish: message => { out.published.push(message.text); queueMicrotask(() => turn.done(true, { id: message.id, shown: true })); return true; },
    speechStyle: id => out.styles.push(id), archive: async message => { out.archived.push(message.text); },
    sleep: async () => undefined, ...overrides,
  });
  return { turn, out, set: { character: (id: string) => { character = id; }, free: (v: boolean) => { free = v; }, identity: (v: string) => { identity = v; }, answer: (v: string) => { answer = v; } } };
}

test('her turn: one line shown, one archive, the facts in the prompt', async () => {
  const { turn, out } = turnRig();
  assert.equal(await turn.say('一起看屏幕在 14:32 断了。', 'gene'), 'said');
  assert.deepEqual(out.published, ['诶，刚才好像断了一下']);
  assert.deepEqual(out.archived, ['诶，刚才好像断了一下']);
  assert.equal(out.styles.length, 1);
  assert.match(out.prompts[0]!, /14:32/u);
});

test('her turn: she may say nothing; a line that was not shown is not archived; a late or switched result never comes back', async () => {
  const quiet = turnRig();
  quiet.set.answer('{"text":""}');
  assert.equal(await quiet.turn.say('x', 'gene'), 'quiet');
  assert.equal(quiet.out.published.length + quiet.out.archived.length, 0);

  const notShown = turnRig({ publish: () => false });
  assert.equal(await notShown.turn.say('x', 'gene'), 'undelivered');
  assert.equal(notShown.out.archived.length, 0);

  const switched = turnRig();
  const original = switched.set.answer.bind(switched.set);
  original('{"text":"嗯"}');
  const pending = switched.turn.say('x', 'gene');
  switched.set.identity('scope-2'); // the character or model changed while the call was out
  assert.equal(await pending, 'undelivered');
  assert.equal(switched.out.published.length, 0);

  const cancelled = turnRig();
  const running = cancelled.turn.say('x', 'gene');
  cancelled.turn.cancel();
  assert.equal(await running, 'undelivered');
  assert.equal(cancelled.out.archived.length, 0);
});

test('her turn: not asked for another character, not twice at once, and the shown-report must be hers', async () => {
  const other = turnRig();
  assert.equal(await other.turn.say('x', 'someone-else'), 'undelivered');
  assert.equal(other.out.prompts.length, 0, 'no call is made for a character who is not the active one');

  let release: () => void = () => undefined;
  const slow = turnRig({ line: async () => { await new Promise<void>(resolve => { release = resolve; }); return '{"text":"嗯"}'; } });
  const first = slow.turn.say('x', 'gene');
  assert.equal(await slow.turn.say('y', 'gene'), 'undelivered');
  release();
  assert.equal(await first, 'said');
  assert.equal(slow.turn.done(false, { id: 'sense-watch-nope', shown: true }), false);
});

// ---------------------------------------------------------------- the journal

test('the journal rows: closed words only', () => {
  const ok = (v: Record<string, unknown>) => buildJournalEntry({ type: 'watch-change', characterId: 'gene', ...v }, 1_700_000_000_000);
  assert.ok(ok({ event: 'share-lost', why: 'capture-lost' }));
  assert.ok(ok({ event: 'paused' }));
  assert.ok(ok({ event: 'resumed', awayS: 300 }));
  assert.ok(ok({ event: 'not-resumed', why: 'turned-off', awayS: 12 }));
  assert.equal(ok({ event: 'share-lost', why: 'a window title' }), null);
  assert.equal(ok({ event: 'share-lost' }), null);
  assert.equal(ok({ event: 'paused', why: 'turned-off' }), null);
  assert.equal(ok({ event: 'paused', awayS: 5 }), null);
  assert.equal(ok({ event: 'resumed', awayS: -1 }), null);
  assert.equal(ok({ event: 'resumed', awayS: 5, title: 'x' }) !== null && Object.keys(ok({ event: 'resumed', awayS: 5, title: 'x' }) as object).includes('title'), false);
});
