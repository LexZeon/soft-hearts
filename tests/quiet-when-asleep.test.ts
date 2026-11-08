/**
 * 睡着时谁都不开口（docs/claude/2026-11-04-quiet-when-asleep.md）。
 * 宿主装配照 electron/main.ts 心情回调和心情时钟那几行：真 MoodHost（隔离临时目录，fatigue-state.json 预置困倦阶段）、
 * 真 ProactiveSpeechGate、真内心循环（createInnerLoopHost）、真屏幕主动聊天（ProactiveVision）、真一起听停顿点开口
 * （ListenProactive）、真纪念邀请（TextMemorials）；截图、模型都是计数的假实现。每一种状态给一次开口时机，数各路做了什么。
 * #10 以后（I-020，electron/inner-loop/opening-host.ts）认领走"她来挑"：这里用固定顺序的假挑法（shared/behaviors/opening-choice/fake.ts）
 * 把每一条路固定住，看那条路被挑中时自己的行为照旧；深夜、困了时她更常不说、屏幕和一起听压低，是真挑法的事（tests/opening-choice.test.ts）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MoodHost } from '../electron/mood';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { createInnerLoopHost } from '../electron/inner-loop/host';
import { InnerLoop } from '../electron/inner-loop/inner-loop';
import { claimMoodCue, claimedView, type MoodCueOwner } from '../electron/inner-loop/claim';
import { ProactiveVision } from '../electron/proactive-vision';
import { ListenProactive } from '../electron/listen-together/proactive';
import { TextMemorials } from '../electron/text-memorials';
import { isVisualAttentionCue } from '../shared/vision-runtime';
import { FixedOpeningChoice } from '../shared/behaviors/opening-choice/fake';
import type { OpeningCandidateId } from '../shared/behaviors/opening-choice/interface';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot, type MoodCue } from '../shared/mood';
import type { FatiguePhase } from '../shared/fatigue';
import type { InnerLoopDiagnostic } from '../shared/inner-loop';
import type { ListenNote } from '../shared/listen-together';
import type { MoodView } from '../shared/mood-runtime';

type State = 'day' | 'night-awake' | 'drowsy' | 'asleep';
type Route = 'vision' | 'listen' | 'memorial' | 'inner' | 'inner-off';
/** Fatigue as saved on disk: each stays in its phase for the few seconds of a run (checked below). */
const SEEDS: Record<State, { minute: number; A: number; F: number; phase: FatiguePhase }> = {
  day: { minute: 15 * 60, A: 0.1, F: 0.1, phase: 'awake' },
  'night-awake': { minute: 60, A: 0.1, F: 0.15, phase: 'awake' },
  drowsy: { minute: 15 * 60, A: 0.68, F: 0.62, phase: 'drowsy' },
  asleep: { minute: 3 * 60, A: 0.9, F: 0.86, phase: 'asleep' },
};
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const note = (): ListenNote => ({ id: 'ln-a', characterId: 'gene', segmentId: 'a', kind: 'music', what: '歌', gist: '一首讲夏天的歌', mood: '怀念',
  points: ['夏天'], mention: true, hook: '', startedAt: 0, endedAt: 0, local: false, languages: ['zh'], createdAt: 0, updatedAt: 0, rolls: 0, talkedAt: null });
const original = '今天我完成了第一幅自己的画。', purpose = '留作我们一起见证的纪念';
const proposal = JSON.stringify({ quote: original, purpose, invite: `你愿意把“${original}”${purpose}吗？` });

/** Which one the fixed-order fake picks first for each route (the route's own feature is the only one switched on). */
const ORDER: Record<Route, readonly OpeningCandidateId[]> = { vision: ['screen', 'quiet'], listen: ['listen', 'quiet'], memorial: ['mood', 'quiet'],
  inner: ['mood', 'quiet'], 'inner-off': ['screen', 'listen', 'mood', 'quiet'] };

/** One speech opportunity on the wired host: `route` says which feature is on (vision, listening, a memorial proposal, the inner loop on/off). */
async function opportunity(state: State, route: Route) {
  const seed = SEEDS[state];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-quiet-asleep-'));
  await writeFile(path.join(directory, 'fatigue-state.json'), JSON.stringify({ version: 1,
    profiles: [{ characterId: 'gene', A: seed.A, F: seed.F, W: 0, phase: seed.phase, wallMs: 5_000_000 }] }));
  const clock = { now: 5_000_000 }, mono = { now: 1_000_000 };
  const count = { captures: 0, visionModel: 0, visionOffers: 0, listenModel: 0, listenOffers: 0, memorialOffers: 0,
    innerModel: 0, innerOffers: 0, rendererCues: 0, released: 0 };
  const owners: (MoodCueOwner | null)[] = [], records: InnerLoopDiagnostic[] = [], rendererSeen = new Set<string>();
  const innerOn = route !== 'inner-off', visionOn = route === 'vision';
  const chooser = new FixedOpeningChoice(ORDER[route]);
  let host!: MoodHost;
  const gate = new ProactiveSpeechGate(() => clock.now);
  const gateScope = () => `scope:${host.get().token}`;
  const inner = createInnerLoopHost({
    gate, clock: () => clock.now, setting: () => innerOn, expressions: () => host.get().expressions, canExpress: () => !gate.busy, current: () => true,
    openingChoice: chooser, characterId: () => 'gene', gateScope, parameters: () => host.get().parameters,
    fatiguePhase: () => host.get().fatigue?.phase,
    context: { localMinute: () => seed.minute, persona: () => '你是 Gene。', language: () => '', mood: () => '平静。', lastInteractionAt: () => null,
      profileEnabled: () => false, profilePoints: () => '', audioReading: () => false, ambientText: () => '' },
    decide: async () => { count.innerModel++; return { text: '{"action":"speak","text":"在呢"}' }; },
    realize: () => {}, releaseSpeech: claim => { count.released++; host.releaseSpeech({ id: claim.id, at: claim.at }, claim.characterId); },
    offer: () => { count.innerOffers++; }, cancelOffer: () => {}, surface: () => null, presentationIdentity: () => 'id',
    archive: async () => {}, developerMode: () => false, diagnosticsFile: () => null, diagnosticsChanged: () => {},
    journal: entry => { records.push(entry); },
  });
  const vision = new ProactiveVision({ gate, clock: () => clock.now,
    capture: async () => { count.captures++; return [{ source: 'screen', dataUrl: 'data:image/jpeg;base64,YQ==' }]; },
    generate: async () => { count.visionModel++; return '看起来你在写东西。'; },
    offer: () => { count.visionOffers++; }, present: async () => true, presentationCurrent: () => true, current: () => true, archive: async () => {} });
  const session = { owner: 2, sessionId: 'listen1', startedAt: 0, captureReadyAt: 0, mode: 'music' as const,
    scope: { characterId: 'gene', providerScope: 'p' }, contextIdentity: 'scope' };
  const listen = new ListenProactive({ gate, currentSession: () => route === 'listen' ? session : null, canComment: () => true,
    persona: () => '你是 Gene。', moodText: () => '平静', generate: async () => { count.listenModel++; return '{"comment":"刚才那首好怀念"}'; },
    offer: () => { count.listenOffers++; }, mood: () => ({ primary: 'calm' }), readNote: () => note(), talked: () => {}, will: () => true, now: () => clock.now });
  const memorial = new TextMemorials({ gate, store: { hasEvent: () => false, saveConfirmed: async () => null },
    context: () => ({ characterId: 'gene', providerScope: 'p', identity: 'scope', gateScope: gateScope() }), eligible: () => true,
    offer: () => { count.memorialOffers++; }, cancelOffer: () => {}, present: async () => true, presentationCurrent: () => true,
    archiveInvitation: async () => {}, changed: () => {}, now: () => clock.now });
  // electron/main.ts, the mood publish: one claim (the opening choice), the renderer's view (no fixed #13 line any more), the audio engines.
  let owner: { id: string; owner: MoodCueOwner | null } | null = null;
  host = new MoodHost(directory, (view: MoodView) => {
    const cue = view.snapshot.cue;
    gate.setScope(gateScope());
    const claimant = inner.opening.claim(cue, {
      memorial: c => c.kind === 'speech' && memorial.offerOpportunity(c),
      vision: c => c.kind === 'speech' && c.source === undefined && visionOn,
      ambient: c => c.kind === 'speech' && c.source !== undefined && listen.canTake(c),
      ambientPassed: c => listen.pass(c),
    }, view);
    owner = cue ? { id: cue.id, owner: claimant } : null;
    if (cue?.kind === 'speech') owners.push(claimant);
    const visible = claimedView(view, claimant, host);
    const shown = visible.snapshot.cue;
    if (shown?.kind === 'speech' && !rendererSeen.has(shown.id)) { rendererSeen.add(shown.id); count.rendererCues++; }
    listen.observe(visible);
  }, () => clock.now, { fatigueClock: { wallMs: () => clock.now, monotonicMs: () => mono.now, localMinute: () => seed.minute } });
  // electron/main.ts, the one-second mood clock: the screen chat starts only on a cue the claim gave it.
  const tick = (ambient?: ReturnType<ListenProactive['nextSourceObservation']>) => {
    clock.now += 1_000; mono.now += 1_000;
    host.tick(true, { ambientSpeech: ambient, allowGenericSpeech: route !== 'listen' });
    const view = host.get(), cue = view.snapshot.cue;
    if (isVisualAttentionCue(cue) && owner?.id === cue.id && owner.owner === 'vision')
      void vision.start(gateScope(), cue, visionOn && view.expressions && view.snapshot.phase === 'idle');
  };
  try {
    await host.load();
    host.activate('gene');
    host.setDeveloperMode(true);
    const phase = host.get().fatigue?.phase;
    if (route === 'memorial') {
      const turn = memorial.acceptUserTurn({ requestId: 'u1', messageId: 'u1', text: original, acceptedAt: clock.now, source: 'text' }, 'scope');
      await turn!.result; turn!.complete(true, proposal);
    }
    let raised: boolean;
    if (route === 'listen') { listen.candidate(note(), 'ended'); const source = listen.nextSourceObservation(); raised = !!source; tick(source); }
    else { raised = host.forceAttention('speech'); tick(); }
    await flush(); tick(); await flush();
    const result = { phase, phaseAfter: host.get().fatigue?.phase, raised, owners: [...owners], records: [...records], asked: chooser.asked.length, ...count };
    // The cue has gone (3 s); a second line is allowed only if this one returned its "unanswered" quota.
    clock.now += 5_000; mono.now += 5_000; tick();
    const again = host.forceAttention('speech');
    const proposalLeft = route === 'memorial' && memorial.offerOpportunity({ id: 'later-cue', kind: 'speech', until: clock.now + 3_000 });
    return { ...result, again, proposalLeft };
  } finally {
    inner.loop.dispose(); memorial.dispose(); listen.clear(); gate.dispose();
    await host.flush().catch(() => {});
    assert.equal(path.dirname(directory), os.tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
}

const NOTHING = { captures: 0, visionModel: 0, visionOffers: 0, listenModel: 0, listenOffers: 0, memorialOffers: 0, innerModel: 0, innerOffers: 0 };
const said = (r: Awaited<ReturnType<typeof opportunity>>) => ({ captures: r.captures, visionModel: r.visionModel, visionOffers: r.visionOffers,
  listenModel: r.listenModel, listenOffers: r.listenOffers, memorialOffers: r.memorialOffers, innerModel: r.innerModel, innerOffers: r.innerOffers });

test('asleep: no route speaks, captures or asks a model; the opportunity is silence, recorded, and its quota comes back', async () => {
  for (const route of ['vision', 'listen', 'memorial', 'inner', 'inner-off'] as const) {
    const r = await opportunity('asleep', route);
    assert.equal(r.phase, 'asleep', route); assert.equal(r.phaseAfter, 'asleep', `${route}: still asleep at the end`);
    assert.equal(r.raised, true, `${route}: the mood clock did give an opportunity`);
    assert.deepEqual(said(r), NOTHING, `${route}: nothing said, captured or asked`);
    assert.equal(r.owners[0], 'asleep', `${route}: the claim gave it to nobody`);
    assert.equal(r.asked, 0, `${route}: asleep, nothing is even weighed`);
    assert.equal(r.rendererCues, 0, `${route}: the pet window does not see it either`);
    assert.ok(r.owners.every(owner => owner === 'asleep' || owner === 'inner'), `${route}: later publishes keep it silent (${r.owners.join(',')})`);
    assert.equal(r.released, 1, `${route}: the unspoken line's quota is returned once`);
    assert.equal(r.again, true, `${route}: not counted as a line nobody answered`);
    assert.deepEqual(r.records.map(entry => [entry.cue, entry.called, entry.result]), [['speech', false, 'asleep']], `${route}: recorded as 睡着`);
  }
  // The memorial proposal is not spent while she sleeps: it is asked at the next opportunity she is awake for (within its 10 minutes).
  assert.equal((await opportunity('asleep', 'memorial')).proposalLeft, true);
});

test('not asleep: each route, once picked, does what it always did; with the inner loop off nothing of her own (no fixed line, #13)', async () => {
  for (const state of ['day', 'night-awake', 'drowsy'] as const) {
    const vision = await opportunity(state, 'vision');
    assert.equal(vision.phase, SEEDS[state].phase); assert.equal(vision.phaseAfter, SEEDS[state].phase, `${state}: same phase at the end`);
    assert.deepEqual(said(vision), { ...NOTHING, captures: 1, visionModel: 1, visionOffers: 1 }, `${state}: the screen chat captures once and speaks`);
    assert.equal(vision.owners[0], 'vision');
    const listen = await opportunity(state, 'listen');
    assert.deepEqual(said(listen), { ...NOTHING, listenModel: 1, listenOffers: 1 }, `${state}: the pause-point line is written and offered`);
    assert.equal(listen.owners[0], 'ambient');
    const memorial = await opportunity(state, 'memorial');
    assert.deepEqual(said(memorial), { ...NOTHING, memorialOffers: 1 }, `${state}: the memorial invitation is asked`);
    assert.equal(memorial.owners[0], 'memorial'); assert.equal(memorial.asked, 0, `${state}: her memorial invitation is asked first, not weighed`);
    const off = await opportunity(state, 'inner-off');
    assert.deepEqual(said(off), NOTHING, `${state}: with the inner loop off and nothing else on, silence`);
    assert.equal(off.owners[0], 'quiet'); assert.equal(off.rendererCues, 0, `${state}: and the pet window gets no cue to turn into a line`);
    assert.equal(off.released, 1, `${state}: the quota of the line she did not say comes back`); assert.equal(off.again, true);
    const on = await opportunity(state, 'inner');
    if (state === 'day') assert.deepEqual(said(on), { ...NOTHING, innerModel: 1, innerOffers: 1 }, 'day: she may speak');
    // Night or drowsy: the inner loop still asks once, told "这次不能说话"; a line is refused and its quota returned.
    else {
      assert.deepEqual(said(on), { ...NOTHING, innerModel: 1 }, `${state}: one quiet decision, no line`);
      assert.equal(on.released, 1); assert.equal(on.records[0]?.quiet, true);
    }
  }
});

test('claimMoodCue: asleep asks no claimant about a speech cue; motion, a held cue and a broken reader keep the ordinary pass', () => {
  const speech: MoodCue = { id: 's', kind: 'speech', at: 1, until: 2 }, motion: MoodCue = { id: 'm', kind: 'motion', at: 1, until: 2 };
  const asked: string[] = [], silenced: string[] = [];
  const claimants = Object.fromEntries((['memorial', 'r20', 'vision', 'ambient', 'inner'] as const)
    .map(name => [name, (c: MoodCue) => { asked.push(`${name}:${c.id}`); return true; }]));
  const sleep = (asleep: boolean | (() => boolean)) => ({ asleep: typeof asleep === 'function' ? asleep : () => asleep, silence: (c: MoodCue) => { silenced.push(c.id); } });
  assert.equal(claimMoodCue(speech, claimants, undefined, sleep(true)), 'asleep');
  assert.deepEqual(asked, []); assert.deepEqual(silenced, ['s']);
  assert.equal(claimMoodCue({ ...speech, source: { kind: 'ambient', sessionId: 'x', observationId: 'x:1' } }, claimants, undefined, sleep(true)), 'asleep', 'a listen cue too');
  assert.equal(claimMoodCue(motion, claimants, undefined, sleep(true)), 'memorial', 'look and motion cues keep their own rules');
  assert.equal(claimMoodCue(speech, claimants, () => 'inner', sleep(true)), 'inner', 'a cue the inner loop already holds stays its');
  assert.equal(claimMoodCue(speech, claimants, undefined, sleep(() => { throw new Error('x'); })), 'memorial', 'an unreadable sleep is not asleep');
  assert.equal(claimMoodCue(speech, claimants, undefined, { asleep: () => true, silence: () => { throw new Error('x'); } }), 'asleep', 'nobody speaks even if the silence fails');
  assert.equal(claimMoodCue(speech, claimants, undefined, sleep(false)), 'memorial');
  assert.equal(claimMoodCue(speech, claimants), 'memorial', 'no sleep reader: as before');
});

test('claimedView: what the renderer and the audio engines see for each owner', () => {
  const snapshot = getMoodSnapshot(createMoodState(1_000), 1_000);
  snapshot.cue = { id: 'c', kind: 'speech', at: 1_000, until: 4_000 };
  const view = { characterId: 'gene', revision: 1, token: 't', developerMode: false, expressions: true, parameters: DEFAULT_MOOD_PARAMETERS, snapshot, gesture: null } as unknown as MoodView;
  const hidden: string[] = [];
  for (const owner of ['memorial', 'r20', 'inner', 'asleep', 'quiet'] as const) assert.equal(claimedView(view, owner, { cueHidden: id => hidden.push(id) }).snapshot.cue, null, owner);
  assert.deepEqual(hidden, ['c', 'c', 'c'], 'the inner loop, a slept-through cue and one she let pass also drop what the cue started');
  for (const owner of ['vision', 'ambient', null] as const) assert.equal(claimedView(view, owner).snapshot.cue?.id, 'c', String(owner));
});

test('InnerLoop.silence: no switch, gate or model needed; once per cue; a listen cue too; no scope, no silence', () => {
  const released: string[] = [], records: InnerLoopDiagnostic[] = [];
  let calls = 0, scope: { characterId: string; gateScope: string } | null = { characterId: 'gene', gateScope: 'g' };
  const loop = new InnerLoop({ gate: { tryAcquire: () => { throw new Error('no gate'); } }, clock: () => 10_000,
    enabled: () => false, canStart: () => false, current: () => false, scope: () => scope,
    parameters: () => DEFAULT_MOOD_PARAMETERS, quiet: () => ({ asleep: true, drowsy: false, night: false, quiet: true }), prompt: () => '',
    decide: async () => { calls++; return { text: '{"action":"none"}' }; }, realize: () => {}, releaseSpeech: claim => { released.push(claim.id); },
    offer: () => {}, present: async () => true, presentationCurrent: () => true, archive: async () => {}, record: entry => { records.push(entry); } });
  assert.equal(loop.asleep(), true);
  assert.equal(loop.silence({ id: 'a', kind: 'speech', at: 9_000, until: 12_000 }), true);
  assert.equal(loop.silence({ id: 'a', kind: 'speech', at: 9_000, until: 12_000 }), true, 'already taken');
  assert.equal(loop.claims('a'), true);
  assert.equal(loop.silence({ id: 'b', kind: 'speech', at: 9_000, until: 12_000, source: { kind: 'ambient', sessionId: 'x', observationId: 'x:1' } }), true);
  assert.equal(loop.silence({ id: 'c', kind: 'motion', at: 9_000, until: 12_000 }), false, 'only speech');
  scope = null;
  assert.equal(loop.silence({ id: 'd', kind: 'speech', at: 9_000, until: 12_000 }), false);
  assert.deepEqual(released, ['a', 'b']); assert.equal(calls, 0);
  assert.deepEqual(records.map(entry => entry.result), ['asleep', 'asleep']);
  loop.dispose();
});
