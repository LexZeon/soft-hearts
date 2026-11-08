// 体验记录 (E2): the existing hosts' moments become journal inputs (electron/journal/sources.ts and the small hooks in
// electron/mood.ts, companion.ts, her-life, her-needs, relationship, user-state, inner-loop and rps). The end-to-end test runs a
// chat turn of the real shape and checks that nothing the user or she said reaches the journal file.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { CompanionService } from '../electron/companion';
import { MoodHost } from '../electron/mood';
import { CharacterJournal, LABEL_STABLE_MS, MoodJournal, TOUCH_GAP_MS, boredomLevel, longingLevel, type MoodJournalEvent } from '../electron/journal/sources';
import { JournalWriter } from '../electron/journal/writer';
import { InnerLoop } from '../electron/inner-loop/inner-loop';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { RpsHost } from '../electron/rps/host';
import { RpsStore } from '../electron/rps/store';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import type { JournalInput } from '../shared/journal';
import type { MoodView } from '../shared/mood-runtime';
import type { ProviderConfig } from '../shared/contracts';

const provider: ProviderConfig = { kind: 'claude', baseUrl: 'https://synthetic.example/v1', model: 'fixture' };
const values = (n = 50) => ({ D: n, O: n, E: n, N: n, C: n });
const sink = () => { const inputs: JournalInput[] = []; return { inputs, record: (input: JournalInput) => { inputs.push(input); } }; };
async function temp(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function view(characterId: string, primary: string, extra: { boredom?: number; longing?: number; phase?: string } = {}): MoodView {
  return { characterId, parameters: DEFAULT_MOOD_PARAMETERS, snapshot: { primary, boredom: extra.boredom ?? 0, longing: extra.longing ?? 0 },
    ...(extra.phase ? { fatigue: { phase: extra.phase } } : {}) } as unknown as MoodView;
}

test('a run of pats is one line; another kind of moment or a pause closes it', () => {
  const out = sink(), clock = { now: 0 };
  const journal = new MoodJournal(out, () => clock.now);
  const pat = (after: number): MoodJournalEvent => ({ characterId: 'gene', type: 'rua', effectiveMs: 400, before: values(after - 1), after: values(after), labelBefore: 'calm', labelAfter: 'content' });
  for (let i = 1; i <= 5; i++) { clock.now += 500; journal.event(pat(50 + i)); }
  assert.equal(out.inputs.length, 0, 'still patting');
  clock.now += 100;
  journal.event({ characterId: 'gene', type: 'food', before: values(56), after: values(60), labelBefore: 'content', labelAfter: 'happy' });
  assert.deepEqual(out.inputs.map(input => input.type === 'mood-event' && [input.source, input.count ?? 1, input.durationMs ?? 0]), [['touch', 5, 2_000], ['food', 1, 0]]);
  const touch = out.inputs[0] as Extract<JournalInput, { type: 'mood-event' }>;
  assert.equal(touch.before.O, 50); assert.equal(touch.after.O, 55);
  journal.event(pat(61));
  clock.now += TOUCH_GAP_MS + 1;
  journal.view(view('gene', 'happy'));
  assert.equal(out.inputs.length, 3, 'a pause closes the run');
  // The model's own reason never travels on: the appraisal keeps only its context.
  journal.event({ characterId: 'gene', type: 'appraisal', reason: '用户说老板骂了他', context: 'concern', before: values(), after: values(52), labelBefore: 'calm', labelAfter: 'concerned' });
  assert.ok(!JSON.stringify(out.inputs).includes('老板'));
  assert.deepEqual(out.inputs.at(-1), { type: 'mood-event', characterId: 'gene', source: 'appraisal', context: 'concern', before: values(), after: values(52), labelBefore: 'calm', labelAfter: 'concerned' });
});

test('labels count once they held; boredom and longing count when they cross a threshold; sleep and waking up', () => {
  const out = sink(), clock = { now: 0 };
  const journal = new MoodJournal(out, () => clock.now);
  journal.view(view('gene', 'calm', { longing: 40, phase: 'awake' }));
  assert.deepEqual(out.inputs, [{ type: 'longing', characterId: 'gene', level: 'longing', value: 40, atStart: true }], 'she missed the user while the app was closed');
  clock.now += 1_000; journal.view(view('gene', 'content', { longing: 40, phase: 'awake' }));
  clock.now += 1_000; journal.view(view('gene', 'calm', { longing: 40, phase: 'awake' }));
  clock.now += LABEL_STABLE_MS; journal.view(view('gene', 'calm', { longing: 40, phase: 'awake' }));
  assert.equal(out.inputs.length, 1, 'a flicker is not a change');
  journal.view(view('gene', 'happy', { longing: 0, boredom: 31, phase: 'awake' }));
  clock.now += LABEL_STABLE_MS; journal.view(view('gene', 'happy', { boredom: 56, phase: 'awake' }));
  clock.now += 1_000; journal.view(view('gene', 'happy', { boredom: 40, phase: 'asleep' }));
  clock.now += 1_000; journal.view(view('gene', 'happy', { boredom: 0, phase: 'micro-awake' }));
  clock.now += 1_000; journal.view(view('gene', 'happy', { boredom: 0, phase: 'awake' }));
  assert.deepEqual(out.inputs.slice(1).map(input => [input.type, 'level' in input ? input.level : 'to' in input ? input.to : 'event' in input ? input.event : '']), [
    ['boredom', 'look'], ['longing', 'none'], ['mood-label', 'happy'], ['boredom', 'motion'], ['sleep', 'asleep'], ['boredom', 'none'], ['sleep', 'awake'],
  ]);
  assert.equal(boredomLevel(75, DEFAULT_MOOD_PARAMETERS.boredom), 'speech');
  assert.equal(longingLevel(85, DEFAULT_MOOD_PARAMETERS.longing), 'cry');
});

test('cards: the first look learns them; then activation, edits, model links, new and deleted cards; never names or paths', () => {
  const out = sink(), journal = new CharacterJournal(out);
  const card = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `名字-${id}`, systemPrompt: '人设原文', ...extra });
  journal.observe({ activeId: 'a', cards: [card('a'), card('b')] } as never);
  assert.equal(out.inputs.length, 0);
  journal.observe({ activeId: 'b', cards: [card('a', { systemPrompt: '新的人设原文' }), card('b', { modelPath: 'C:\\models\\私人.pmx', modelName: '私人模型' }), card('c')] } as never);
  journal.observe({ activeId: 'b', cards: [card('a', { systemPrompt: '新的人设原文' }), card('b', { modelPath: 'C:\\models\\私人.pmx', modelName: '私人模型' })] } as never);
  assert.deepEqual(out.inputs, [
    { type: 'character', characterId: 'a', event: 'update' },
    { type: 'character', characterId: 'b', event: 'model-link', linked: true },
    { type: 'character', characterId: 'c', event: 'add' },
    { type: 'character', characterId: 'b', event: 'activate' },
    { type: 'character', characterId: 'c', event: 'remove' },
  ]);
  assert.ok(!/名字|人设|私人|models/u.test(JSON.stringify(out.inputs)));
});

test('MoodHost tells the journal each applied change with before and after; a refused or repeated event tells nothing', async t => {
  const directory = await temp(t, 'sh-journal-mood-'), clock = { now: 1_000_000 }, events: MoodJournalEvent[] = [];
  const host = new MoodHost(directory, () => {}, () => clock.now);
  await host.load(); host.activate('gene');
  host.setJournalObserver(event => events.push(event));
  host.event({ type: 'food', id: 'snack-1' });
  host.event({ type: 'food', id: 'snack-1' });
  host.event({ type: 'chat', id: 'turn-1', reason: '收到用户聊天' });
  host.event({ type: 'appraisal', id: 'appraisal-x', responseTo: 'not-the-last-turn', delta: { O: 5 } });
  host.event({ type: 'appraisal', id: 'appraisal-1', responseTo: 'turn-1', delta: { O: 5, D: 3 }, context: 'support', reason: '模型自己写的原因' });
  host.lift({ id: 'lift-1', delta: { O: 4 }, reason: '被用户哄好了' });
  assert.deepEqual(events.map(event => [event.type, event.reason ?? null]), [['food', null], ['chat', '收到用户聊天'], ['appraisal', '模型自己写的原因'], ['lift', '被用户哄好了']]);
  const food = events[0];
  assert.ok(food.after.D > food.before.D && food.after.E > food.before.E, 'a snack raises D and E');
  assert.ok(events[2].after.O - events[2].before.O > 3);
  assert.equal(events[2].context, 'support');
  await host.flush();
});

test('end to end: a chat turn of the real shape, a pat, a snack, a small need and her own activity; the file holds none of the words', async t => {
  const root = await temp(t, 'sh-journal-e2e-'), journalDir = path.join(root, 'journal');
  const writer = new JournalWriter({ directory: () => journalDir, enabled: () => true });
  const service = new CompanionService(root, () => {}, { journal: writer });
  await service.load(); await service.context('gene', provider, 'Gene');
  const userText = '今天被老板骂了，好难过。我的门禁密码是 4471，别告诉别人';
  const reply = '抱抱你，先别想工作的事了，我一直都在这里陪你。';
  const tailReason = '用户被老板骂了很难过，提到门禁密码';
  const turn = await service.begin('turn-e2e', userText, 'Gene', () => {});
  const opening = turn.persona.match(/<sh-state-[a-f0-9]+>/)?.[0];
  assert.ok(opening);
  turn.push('delta', `${reply}\n${opening}${JSON.stringify({ context: 'concern', delta: { O: 3, C: 2 }, reason: tailReason, confidence: 0.92, gesture: 'consider',
    user: { state: 'low', confidence: 0.9, reason: '被老板骂' } })}${opening.replace('<', '</')}`);
  await turn.finish('complete');
  assert.equal(service.memory.read(turn.scope, turn.recordId)?.messages[1].content, reply, 'the reply itself is archived as always');
  // The host credits a pat and readies a snack by its own clock, so these wait a little real time.
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const token = service.mood.get().token;
  service.mood.interaction({ token, sessionId: 'pat', type: 'phase', phase: 'rua' });
  await wait(300);
  service.mood.interaction({ token, sessionId: 'pat', type: 'rua', id: 'stroke-1', activeMs: 250 });
  service.mood.interaction({ token, sessionId: 'pat', type: 'phase', phase: 'idle' });
  service.mood.interaction({ token, sessionId: 'snack', type: 'phase', phase: 'food-wait' });
  await wait(550);
  service.mood.interaction({ token, sessionId: 'snack', type: 'phase', phase: 'food-ready' });
  service.mood.interaction({ token, sessionId: 'snack', type: 'food', id: 'snack-1' });
  service.mood.interaction({ token, sessionId: 'snack', type: 'phase', phase: 'idle' });
  assert.equal(service.herNeeds.startNow('gene', 'lonely'), true);
  service.herNeeds.interact('gene', 'touch', 9_000);
  service.herLifeStartNow('humming');
  await service.flush();
  await writer.flush();
  const [name] = await readdir(journalDir);
  const text = await readFile(path.join(journalDir, name), 'utf8');
  const types = text.split('\n').filter(Boolean).map(line => JSON.parse(line)).map(entry => entry.type + (entry.source ? `:${entry.source}` : entry.event ? `:${entry.event}` : ''));
  for (const expected of ['mood-event:chat', 'mood-event:appraisal', 'user-state', 'mood-event:touch', 'mood-event:food', 'her-need:started', 'her-need:soothed', 'mood-event:soothed', 'her-life'])
    assert.ok(types.includes(expected), `${expected} in ${types.join(', ')}`);
  for (const words of [userText, reply, tailReason, '老板', '4471', '门禁', '抱抱你', '工作', 'Gene', '被老板骂', opening])
    assert.ok(!text.includes(words), `the journal must not contain ${words}`);
  assert.match(text, /"reason":"你说的话让她担心你"/);
});

test('quitting turns a run of pats that is still open into its line', async t => {
  const root = await temp(t, 'sh-journal-quit-'), journalDir = path.join(root, 'journal');
  const writer = new JournalWriter({ directory: () => journalDir, enabled: () => true });
  const service = new CompanionService(root, () => {}, { journal: writer });
  await service.load(); await service.context('gene', provider, 'Gene');
  const token = service.mood.get().token;
  service.mood.interaction({ token, sessionId: 'pat', type: 'phase', phase: 'rua' });
  await new Promise(resolve => setTimeout(resolve, 300));
  service.mood.interaction({ token, sessionId: 'pat', type: 'rua', id: 'stroke-1', activeMs: 250 });
  await service.flush(); await writer.flush();
  const [name] = await readdir(journalDir);
  const entries = (await readFile(path.join(journalDir, name), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(entries.some(entry => entry.type === 'mood-event' && entry.source === 'touch'), JSON.stringify(entries.map(entry => entry.type)));
});

test('the inner loop hands each decision to the journal with whose opportunity it was', async () => {
  const now = 1_000_000, gate = new ProactiveSpeechGate(() => now); gate.setScope('scope');
  const records: [string, string][] = [];
  const loop = new InnerLoop({
    gate, clock: () => now, createId: () => 'id', enabled: () => true, canStart: () => true, current: () => true,
    scope: () => ({ characterId: 'gene', gateScope: 'scope' }), parameters: () => DEFAULT_MOOD_PARAMETERS,
    quiet: () => ({ asleep: true, drowsy: false, night: false, quiet: true }), prompt: () => 'prompt', decide: async () => ({ text: '{"action":"none"}' }),
    realize: () => {}, releaseSpeech: () => {}, offer: () => {}, present: async () => true, presentationCurrent: () => true, cancelOffer: () => {}, archive: async () => {},
    record: (entry, characterId) => { records.push([entry.result, characterId]); },
  });
  assert.equal(loop.offerOpportunity({ id: 'speech-cue', kind: 'speech', at: now, until: now + 3_000 }), true);
  assert.deepEqual(records, [['asleep', 'gene']]);
  loop.dispose(); gate.dispose();
});

test('a game: the invitation, the answer and the numbers of a match (never the hands)', async t => {
  const dir = await temp(t, 'sh-journal-rps-'), clock = { now: 1_000_000 }, timers: { at: number; fn: () => void }[] = [];
  const store = new RpsStore({ file: () => path.join(dir, 'rps.json'), now: () => clock.now }); await store.load();
  const entries: [string, Record<string, unknown>][] = [];
  const character = { id: 'gene', persona: '角色', parameters: DEFAULT_MOOD_PARAMETERS, snapshot: { primary: 'happy', values: { D: 70, O: 50, E: 55, N: 50, C: 40 } }, fatigue: null, herLife: 'company' };
  let n = 0;
  const host = new RpsHost({ store, character: () => character as never, visible: () => true, recording: () => false,
    localDate: () => '2026-11-03', publish: () => {}, mood: () => {}, chatBusy: () => false, clock: () => clock.now, random: () => 0.3, nonce: () => `n${++n}`, createId: () => `id${++n}`,
    timers: { set: (fn, ms) => { timers.push({ at: clock.now + ms, fn }); return timers.length; }, clear: () => {} },
    journal: (id, entry) => { entries.push([id, { ...entry }]); } });
  host.invited('gene');
  host.cancel();
  host.invited('gene');
  const inviteId = (host as unknown as { invite: { id: string } }).invite.id;
  host.respond({ id: inviteId, action: 'decline' });
  host.testStart();
  host.cancel();
  assert.deepEqual(entries.map(([id, entry]) => [id, entry.event]), [['gene', 'invite'], ['gene', 'invite'], ['gene', 'decline'], ['gene', 'start'], ['gene', 'result']]);
  const result = entries.at(-1)![1];
  assert.equal(result.rounds, 0); assert.equal(result.result, 'none'); assert.equal(result.end, 'abandoned');
  assert.ok(!/rock|paper|scissors/u.test(JSON.stringify(entries)));
  host.dispose(); await store.flush();
});
