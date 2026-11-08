import test from 'node:test';
import assert from 'node:assert/strict';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { InnerLoop, type InnerLoopDependencies, type InnerLoopMessage } from '../electron/inner-loop/inner-loop';
import { withoutClaimedCue } from '../electron/inner-loop/claim';
import { OpeningHost } from '../electron/inner-loop/opening-host';
import { FixedOpeningChoice } from '../shared/behaviors/opening-choice/fake';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot, type MoodCue } from '../shared/mood';
import type { InnerLoopDiagnostic, InnerLoopQuiet } from '../shared/inner-loop';
import { formatVisionPresentation } from '../shared/vision-runtime';
import type { MoodView } from '../shared/mood-runtime';

const MINUTE = 60_000;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const awake: InnerLoopQuiet = { asleep: false, drowsy: false, night: false, quiet: false };

function harness(overrides: Partial<InnerLoopDependencies> = {}, answer: string | (() => Promise<{ text: string }>) = '{"action":"none"}') {
  const state = { now: 1_000_000, enabled: true, canStart: true, current: true, quiet: { ...awake } };
  const gate = new ProactiveSpeechGate(() => state.now); gate.setScope('scope');
  const log = { prompts: [] as boolean[], decides: 0, realized: [] as [string, string, string][], released: [] as string[],
    offered: [] as InnerLoopMessage[], revoked: [] as string[], archived: [] as InnerLoopMessage[], records: [] as InnerLoopDiagnostic[], signals: [] as AbortSignal[] };
  let ids = 0;
  const loop = new InnerLoop({
    gate, clock: () => state.now, createId: () => `realized-${++ids}`,
    enabled: () => state.enabled, canStart: () => state.canStart, current: () => state.current,
    scope: () => ({ characterId: 'gene', gateScope: 'scope' }), parameters: () => DEFAULT_MOOD_PARAMETERS,
    quiet: () => state.quiet,
    prompt: (_claim, allowSpeech) => { log.prompts.push(allowSpeech); return 'prompt'; },
    decide: async (_prompt, signal) => { log.decides++; log.signals.push(signal); return typeof answer === 'string' ? { text: answer } : answer(); },
    realize: (claim, kind, id) => { log.realized.push([claim.id, kind, id]); },
    releaseSpeech: claim => { log.released.push(claim.id); },
    offer: message => { log.offered.push(message); },
    present: async () => true, presentationCurrent: () => true,
    cancelOffer: id => { log.revoked.push(id); },
    archive: async message => { log.archived.push(message); },
    record: entry => { log.records.push(entry); },
    ...overrides,
  });
  const cue = (kind: 'motion' | 'speech' | 'look', id = `${kind}-cue`): MoodCue => ({ id, kind, at: state.now, until: state.now + 3_000 });
  return { loop, gate, state, log, cue, dispose: () => { loop.dispose(); gate.dispose(); } };
}

// Whether the screen chat takes a speech cue is no longer the inner loop's to know: the opening choice decides (tests/opening-choice.test.ts).
test('typing, a chat in progress, a hidden pet or the switch off: no run, no model call', async () => {
  for (const blocked of ['enabled', 'canStart'] as const) {
    const h = harness();
    h.state[blocked] = false;
    assert.equal(h.loop.offerOpportunity(h.cue('speech')), false, blocked);
    await flush();
    assert.equal(h.log.decides, 0, blocked); assert.equal(h.gate.busy, false); h.dispose();
  }
  const h = harness();
  for (const cue of [h.cue('look'), { ...h.cue('speech'), source: { kind: 'ambient', sessionId: 's', observationId: 's:1' } }, { ...h.cue('motion'), until: h.state.now }])
    assert.equal(h.loop.offerOpportunity(cue), false);
  await flush(); assert.equal(h.log.decides, 0); h.dispose();
});

test('a cue is decided on first sight only; a held cue stays claimed and a declined one is never taken later', async () => {
  const h = harness();
  h.state.canStart = false;
  const declined = h.cue('speech', 'declined');
  assert.equal(h.loop.offerOpportunity(declined), false);
  h.state.canStart = true;
  assert.equal(h.loop.offerOpportunity(declined), false, 'the renderer may already show it');
  const taken = h.cue('motion', 'taken');
  assert.equal(h.loop.offerOpportunity(taken), true);
  assert.equal(h.loop.offerOpportunity(taken), true); assert.equal(h.loop.claims('taken'), true);
  await flush(); assert.equal(h.log.decides, 1); h.dispose();
});

test('invalid answers, timeouts and cancellations do nothing and return the speech quota', async () => {
  const answers = ['{"action":"speak","text":"好","x":1}', 'not json', '{"action":"speak","text":"一二三四五六七八九十一二三四五六七八九十一"}',
    '{"action":"speak","text":"第一行\\n第二行"}', '{"action":"speak","text":"<b>嗨</b>"}'];
  for (const answer of answers) {
    const h = harness({}, answer);
    assert.equal(h.loop.offerOpportunity(h.cue('speech')), true);
    await flush();
    assert.deepEqual(h.log.realized, []); assert.deepEqual(h.log.offered, []); assert.deepEqual(h.log.released, ['speech-cue'], answer);
    assert.equal(h.log.records.at(-1)!.result, 'invalid'); assert.equal(h.gate.busy, false); h.dispose();
  }
  // Speak where speech is not allowed (night) is invalid as well.
  const night = harness({}, '{"action":"speak","text":"晚安"}');
  night.state.quiet = { asleep: false, drowsy: false, night: true, quiet: true };
  night.loop.offerOpportunity(night.cue('speech')); await flush();
  assert.deepEqual(night.log.prompts, [false]); assert.deepEqual(night.log.offered, []); assert.equal(night.log.records[0].result, 'invalid');
  assert.equal(night.log.records[0].quiet, true); night.dispose();
  // Timeout: the call is aborted and nothing happens.
  const slow = harness({ decideTimeoutMs: 20 }, () => new Promise(() => {}));
  slow.loop.offerOpportunity(slow.cue('speech'));
  await new Promise(resolve => setTimeout(resolve, 60)); await flush();
  assert.equal(slow.log.signals[0].aborted, true); assert.equal(slow.log.records[0].result, 'timeout');
  assert.deepEqual(slow.log.released, ['speech-cue']); assert.equal(slow.gate.busy, false); slow.dispose();
  // User input cancels through the shared gate; the late answer is dropped.
  let resolve!: (value: { text: string }) => void;
  const late = harness({}, () => new Promise(done => { resolve = done; }));
  late.loop.offerOpportunity(late.cue('speech')); await flush();
  late.gate.cancel('user');
  assert.equal(late.log.records[0].result, 'cancelled'); assert.deepEqual(late.log.released, ['speech-cue']);
  resolve({ text: '{"action":"speak","text":"你回来啦"}' }); await flush();
  assert.deepEqual(late.log.offered, []); assert.deepEqual(late.log.realized, []); assert.equal(late.log.records.length, 1); late.dispose();
  // Hiding / typing is noticed by the existing tick's sweep.
  const hidden = harness({}, () => new Promise(() => {}));
  hidden.loop.offerOpportunity(hidden.cue('motion')); await flush();
  hidden.state.current = false; hidden.loop.sweep();
  assert.equal(hidden.log.signals[0].aborted, true); assert.equal(hidden.log.records[0].result, 'cancelled'); hidden.dispose();
});

test('look and motion are realized as a new cue that is never claimed again; motion asks the model at most every 2 × interval', async () => {
  const h = harness({}, '{"action":"look"}');
  assert.equal(h.loop.offerOpportunity(h.cue('motion', 'm1')), true); await flush();
  assert.deepEqual(h.log.realized, [['m1', 'look', 'realized-1']]);
  assert.equal(h.loop.offerOpportunity({ id: 'realized-1', kind: 'motion', at: h.state.now, until: h.state.now + 3_000 }), false);
  const interval = DEFAULT_MOOD_PARAMETERS.frequency.motionIntervalMs;
  h.state.now += interval;
  assert.equal(h.loop.offerOpportunity(h.cue('motion', 'm2')), false, 'one motion interval later: the existing rule motion plays');
  h.state.now += interval;
  assert.equal(h.loop.offerOpportunity(h.cue('motion', 'm3')), true, 'two intervals later the model may be asked again');
  await flush(); assert.equal(h.log.decides, 2);
  assert.ok(h.log.records.every(record => record.result === 'ok' && record.decision === 'look' && record.called));
  assert.deepEqual(h.log.released, [], 'motion cues have no speech quota'); h.dispose();
});

test('speak goes through the shared gate and commits only after host-confirmed presentation', async () => {
  const h = harness({}, '{"action":"speak","text":"还在忙呀？记得喝水"}');
  h.loop.offerOpportunity(h.cue('speech', 'speech_1')); await flush();
  assert.equal(h.log.offered.length, 1);
  const message = h.log.offered[0];
  assert.deepEqual(message.origin.sources, ['inner']); assert.equal(message.id, 'speech_1');
  assert.equal(formatVisionPresentation(message), '主动 · 自己想说的\n还在忙呀？记得喝水');
  assert.equal(h.gate.busy, true, 'other proactive sources wait');
  assert.equal(h.loop.owns('speech_1'), true);
  assert.equal(await h.loop.ack('speech_1'), true);
  await flush();
  assert.equal(h.gate.busy, false); assert.deepEqual(h.log.archived.map(m => m.text), ['还在忙呀？记得喝水']);
  assert.deepEqual(h.log.released, [], 'a spoken line keeps its quota');
  assert.equal(h.log.records[0].result, 'delivered'); assert.equal(await h.loop.ack('speech_1'), false, 'one archive only');
  h.dispose();
  // Not visibly presented: nothing archived, the quota comes back, the bubble is revoked.
  const hidden = harness({ present: async () => false }, '{"action":"speak","text":"嗨"}');
  hidden.loop.offerOpportunity(hidden.cue('speech', 'speech_2')); await flush();
  assert.equal(await hidden.loop.ack('speech_2'), false);
  assert.deepEqual(hidden.log.archived, []); assert.deepEqual(hidden.log.released, ['speech_2']); assert.deepEqual(hidden.log.revoked, ['speech_2']);
  hidden.dispose();
});

test('asleep: a speech opportunity is silence without a model call; a motion one is left to the existing rules', async () => {
  const h = harness();
  h.state.quiet = { asleep: true, drowsy: false, night: false, quiet: true };
  assert.equal(h.loop.offerOpportunity(h.cue('speech')), true);
  assert.equal(h.loop.offerOpportunity(h.cue('motion')), false);
  await flush();
  assert.equal(h.log.decides, 0); assert.deepEqual(h.log.released, ['speech-cue']);
  assert.deepEqual(h.log.records.map(r => [r.called, r.result]), [[false, 'asleep']]); h.dispose();
});

test('a speechPerHour or speechWithoutReply of 0 never allows speak', async () => {
  for (const frequency of [{ speechPerHour: 0 }, { speechWithoutReply: 0 }]) {
    const parameters = structuredClone(DEFAULT_MOOD_PARAMETERS); Object.assign(parameters.frequency, frequency);
    const h = harness({ parameters: () => parameters }, '{"action":"speak","text":"嗨"}');
    h.loop.offerOpportunity(h.cue('speech')); await flush();
    assert.deepEqual(h.log.prompts, [false]); assert.deepEqual(h.log.offered, []); h.dispose();
  }
});

// #10 (I-020): the fixed order is gone. Her own memorial invitation is still asked first and R20 next; after that
// she picks (electron/inner-loop/opening-host.ts; the full set is tests/opening-choice.test.ts). Here: the real inner loop under the host.
test('one cue, one owner: memorial first, R20 next, then her pick; a cue is decided once', async () => {
  const h = harness({}, '{"action":"speak","text":"在呢"}');
  const calls: string[] = [];
  const claimant = (name: string, result: boolean) => () => { calls.push(name); return result; };
  const view = { characterId: 'gene', snapshot: getMoodSnapshot(createMoodState(h.state.now), h.state.now), parameters: DEFAULT_MOOD_PARAMETERS };
  const host = new OpeningHost({ loop: h.loop, chooser: new FixedOpeningChoice(['screen', 'mood', 'quiet']), innerOn: () => true,
    releaseSpeech: cue => { calls.push(`refund:${cue.id}`); }, developerMode: () => false, clock: () => h.state.now });
  assert.equal(host.claim(h.cue('speech', 'm'), { memorial: claimant('memorial', true), vision: claimant('vision', true) }, view), 'memorial');
  assert.deepEqual(calls, ['memorial'], 'the memorial asks before anything is weighed');
  calls.length = 0;
  assert.equal(host.claim(h.cue('speech', 'v'), { memorial: claimant('memorial', false), r20: claimant('r20', false), vision: claimant('vision', true) }, view), 'vision');
  assert.deepEqual(calls, ['memorial', 'r20', 'vision', 'vision'], 'looked at, then taken: picked, not first in line');
  calls.length = 0;
  assert.equal(host.claim(h.cue('speech', 'v'), { memorial: claimant('memorial', true) }, view), 'vision', 'later publishes keep the first answer');
  assert.deepEqual(calls, []);
  assert.equal(host.claim(h.cue('speech', 'i'), { memorial: claimant('memorial', false), vision: claimant('vision', false) }, view), 'inner');
  await flush(); assert.equal(h.log.offered.length, 1, 'her own line, through the inner loop');
  assert.equal(host.claim(null, {}, view), null);
  h.dispose();
});

test('the shared gate keeps a cue the inner loop took from any other proactive source', async () => {
  const h = harness({}, () => new Promise(() => {}));
  const cue = h.cue('speech', 'shared');
  assert.equal(h.loop.offerOpportunity(cue), true); await flush();
  assert.equal(h.gate.tryAcquire({ scope: 'scope', opportunityId: 'shared', expiresAt: h.state.now + 10_000 }, 'vision'), null);
  assert.equal(h.gate.tryAcquire({ scope: 'scope', opportunityId: 'other', expiresAt: h.state.now + 10_000 }, 'memorial'), null, 'busy while deciding');
  h.loop.cancel();
  assert.equal(h.gate.tryAcquire({ scope: 'scope', opportunityId: 'shared', expiresAt: h.state.now + 10_000 }, 'vision'), null, 'consumed for good');
  h.dispose();
});

test('a claimed cue is hidden from the renderer with its face reaction', () => {
  const cue: MoodCue = { id: 'abc', kind: 'motion', at: 5, until: 3_005 };
  const reaction = { id: 'r', kind: 'reaction' as const, bindingId: 'x' as never, semantic: 'cue.motion' as never, at: 5, expiresAt: 900, strength: 1, stateKey: 'reaction:abc:5' };
  const other = { ...reaction, stateKey: 'reaction:zzz:1' };
  const view = { snapshot: { cue }, behavior: { state: null, reaction } } as unknown as MoodView;
  const hidden = withoutClaimedCue(view);
  assert.equal(hidden.snapshot.cue, null); assert.equal(hidden.behavior!.reaction, null);
  assert.equal(withoutClaimedCue({ ...view, behavior: { state: null, reaction: other } } as MoodView).behavior!.reaction, other);
  assert.equal(view.snapshot.cue, cue, 'the host view itself is untouched');
});

test('the inner origin is a valid archived presentation identity, never mixed with observed sources', () => {
  const base = { id: 'x1', text: '嗨', origin: { kind: 'proactive' as const, id: 'x1', at: 1, sources: ['inner'] as const, labels: ['自己想说的'] } };
  assert.equal(formatVisionPresentation({ ...base, origin: { ...base.origin, sources: ['inner'], labels: ['自己想说的'] } }), '主动 · 自己想说的\n嗨');
  assert.throws(() => formatVisionPresentation({ ...base, origin: { ...base.origin, sources: ['inner', 'screen'], labels: ['自己想说的', '屏幕'] } }));
  assert.equal(formatVisionPresentation({ ...base, origin: { ...base.origin, sources: ['screen'], labels: ['屏幕'] } }), '主动 · 屏幕\n嗨');
  void MINUTE;
});
