/** G1 猜拳: the inner loop's "邀请玩猜拳" option, the small model her game lines use, and the diary hand-off. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { InnerLoop, type InnerLoopDependencies, type InnerLoopMessage } from '../electron/inner-loop/inner-loop';
import { buildInnerLoopPrompt, parseInnerLoopDecision, type InnerLoopQuiet } from '../shared/inner-loop';
import { DEFAULT_MOOD_PARAMETERS, type MoodCue } from '../shared/mood';
import { DiaryWriter } from '../electron/diary/diary-writer';
import { userProfileScopeId } from '../electron/user-profile';
import { buildDiaryPrompt } from '../electron/diary/diary-prompt';
import { rpsDiaryLine, rpsHabits } from '../shared/rps-memory';
import { quickLineWithClaude, decideWithClaude, INNER_LOOP_MODEL } from '../electron/inner-loop/model';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const awake: InnerLoopQuiet = { asleep: false, drowsy: false, night: false, quiet: false };

test('the invite option appears only on a speech opportunity that may speak, when the host offers it, and never as the rest reminder', () => {
  const base = { persona: '角色', mood: '心情', weights: DEFAULT_MOOD_PARAMETERS.weights, intensity: DEFAULT_MOOD_PARAMETERS.intensity, localMinute: 900,
    minutesSinceInteraction: 30, cue: 'speech' as const, allowSpeech: true, quiet: awake };
  assert.match(buildInnerLoopPrompt({ ...base, play: true }), /invite（邀请用户玩猜拳）/u);
  assert.match(buildInnerLoopPrompt({ ...base, play: true }), /不让用户内疚/u);
  assert.doesNotMatch(buildInnerLoopPrompt({ ...base }), /invite/u);
  assert.doesNotMatch(buildInnerLoopPrompt({ ...base, play: true, allowSpeech: false }), /invite/u);
  assert.doesNotMatch(buildInnerLoopPrompt({ ...base, play: true, cue: 'motion' }), /invite/u);
  assert.doesNotMatch(buildInnerLoopPrompt({ ...base, play: true, quiet: { ...awake, night: true, quiet: true, restReminder: true } }), /invite/u);
  assert.deepEqual(parseInnerLoopDecision('{"action":"invite","text":"要不要来猜拳？"}', true, null, true), { action: 'invite', text: '要不要来猜拳？' });
  assert.equal(parseInnerLoopDecision('{"action":"invite","text":"要不要来猜拳？"}', true, null, false), null, 'not offered');
  assert.equal(parseInnerLoopDecision('{"action":"invite","text":"要不要来猜拳？"}', false, null, true), null, 'no speech allowed');
  assert.equal(parseInnerLoopDecision('{"action":"invite"}', true, null, true), null, 'needs her line');
});

function loop(answer: string, play: { eligible: boolean } | null, overrides: Partial<InnerLoopDependencies> = {}) {
  const state = { now: 1_000_000 };
  const gate = new ProactiveSpeechGate(() => state.now); gate.setScope('scope');
  const log = { prompts: [] as (boolean | undefined)[], offered: [] as InnerLoopMessage[], released: [] as string[], invited: [] as string[], archived: 0 };
  const inner = new InnerLoop({
    gate, clock: () => state.now, enabled: () => true, canStart: () => true, current: () => true,
    scope: () => ({ characterId: 'gene', gateScope: 'scope' }), parameters: () => DEFAULT_MOOD_PARAMETERS, quiet: () => awake,
    prompt: (_c, _a, _q, _h, offered) => { log.prompts.push(offered); return 'prompt'; },
    decide: async () => ({ text: answer }), realize: () => {}, releaseSpeech: claim => { log.released.push(claim.id); },
    offer: message => { log.offered.push(message); }, present: async () => true, presentationCurrent: () => true, cancelOffer: () => {},
    archive: async () => { log.archived++; },
    ...(play ? { play: { eligible: () => play.eligible, invited: claim => { log.invited.push(claim.id); } } } : {}),
    ...overrides,
  });
  const cue = (id = 'speech-cue'): MoodCue => ({ id, kind: 'speech', at: state.now, until: state.now + 3_000 });
  return { inner, gate, log, cue, state };
}

test('inner loop: an invitation uses the same one call and speech quota; the buttons come only after the line was shown and committed', async () => {
  const h = loop('{"action":"invite","text":"要不要来猜拳？"}', { eligible: true });
  assert.equal(h.inner.offerOpportunity(h.cue()), true);
  await flush();
  assert.deepEqual(h.log.prompts, [true]);
  assert.equal(h.log.offered.length, 1); assert.equal(h.log.offered[0].text, '要不要来猜拳？');
  assert.deepEqual(h.log.invited, [], 'not before the line is visible');
  assert.equal(await h.inner.ack(h.log.offered[0].id), true);
  assert.deepEqual(h.log.invited, ['speech-cue']); assert.deepEqual(h.log.released, [], 'spoken: the quota stays used');
  h.inner.dispose(); h.gate.dispose();
  // Not shown: no buttons, quota back.
  const hidden = loop('{"action":"invite","text":"来猜拳吗"}', { eligible: true }, { present: async () => false });
  hidden.inner.offerOpportunity(hidden.cue()); await flush();
  assert.equal(await hidden.inner.ack(hidden.log.offered[0].id), false);
  assert.deepEqual(hidden.log.invited, []); assert.deepEqual(hidden.log.released, ['speech-cue']);
  hidden.inner.dispose(); hidden.gate.dispose();
  // Not offered by the host: the same answer is invalid, nothing is said.
  const closed = loop('{"action":"invite","text":"来猜拳吗"}', { eligible: false });
  closed.inner.offerOpportunity(closed.cue()); await flush();
  assert.deepEqual(closed.log.prompts, [undefined]); assert.equal(closed.log.offered.length, 0); assert.deepEqual(closed.log.released, ['speech-cue']);
  closed.inner.dispose(); closed.gate.dispose();
});

test('her game lines go through the inner loop\'s small model with their own system prompt (brain interface)', async () => {
  const tasks: { model: string; systemPrompt?: string }[] = [];
  const stream = async (task: { model: string; systemPrompt?: string }, _signal: AbortSignal, emit: (type: string, text: string) => void) => { tasks.push(task); emit('delta', '{"text":"好"}'); return null; };
  assert.equal((await quickLineWithClaude('p', '只输出 JSON', new AbortController().signal, stream as never)).text, '{"text":"好"}');
  await decideWithClaude('p', new AbortController().signal, stream as never);
  assert.deepEqual(tasks.map(task => task.model), [INNER_LOOP_MODEL, INNER_LOOP_MODEL]);
  assert.equal(tasks[0].systemPrompt, '只输出 JSON'); assert.notEqual(tasks[1].systemPrompt, '只输出 JSON');
});

test('diary: a day they played is written with one line about it (even without chat); the habit is offered for the meme field', async () => {
  const games = [{ at: 5, origin: 'user' as const, result: 'user' as const, rounds: [{ her: 'scissors' as const, user: 'rock' as const, outcome: 'user' as const }] }];
  const habits = rpsHabits(Array.from({ length: 4 }, () => games[0]));
  const line = rpsDiaryLine(games, habits);
  const prompt = buildDiaryPrompt({ persona: '角色', language: '', date: '2026-11-02', relative: '昨天', material: '', games: line });
  assert.ok(prompt.includes('玩了猜拳')); assert.ok(prompt.includes('"meme"'));
  const prompts: string[] = [];
  const scope = { characterId: 'gene', providerScope: 'p' };
  const profiles = {
    diaryTicket: () => ({ scopeId: userProfileScopeId(scope), scopeEpoch: 1, enableEpoch: 1 }), diaryTicketValid: () => true,
    diaryDue: (_t: unknown, dates: readonly string[]) => [...dates], noteDiaryAttempt: async () => true,
    saveDiary: async () => true, recentDiaryPoints: () => '',
  };
  const writer = new DiaryWriter({ profiles: profiles as never, scope: () => ({ ...scope }),
    messages: () => [], character: () => ({ persona: '角色', language: '' }), model: () => 'opus',
    generate: async request => { prompts.push(request.prompt); return '{"entry":"今天和你玩了猜拳。","meme":"你老是先出石头"}'; },
    written: () => {}, games: (_scope, start) => start <= Date.now() && prompts.length === 0 ? line : '' });
  writer.tick();
  for (let i = 0; i < 50 && writer.busy; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(prompts.length, 1, 'one day had games and no chat: written once, the other days skipped');
  assert.ok(prompts[0].includes('玩了猜拳'));
  writer.dispose();
});
