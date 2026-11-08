/**
 * 睡着后还开口（Codex T-209 #1，docs/claude/2026-11-04-sleep-gap-and-feed-timing.md）：快睡着时已经发出去的一次主动开口，
 * 等她睡着了结果才回来，不能再提出、呈现、提交或存档。三条入口：屏幕主动话题、一起听停顿点、内心循环的深夜休息提醒。
 *
 * 宿主装配照 electron/main.ts：真 MoodHost（隔离临时目录，fatigue-state.json 预置很困）、真疲倦推进（FatigueActivityBridge，
 * 假时钟一秒一跳，自然进入 falling-asleep 再到 asleep，不强制阶段）、真 ProactiveSpeechGate（resting = 内心循环的"睡着"读法，
 * 和 main.ts 一样）、真内心循环、真屏幕主动聊天、真一起听停顿点开口；模型、截图、呈现确认、存档都是计数的假端口。
 * 对照：同一条请求在她睡着前回来，照常提出、提交、存档一次（证明这套装配本身能说出话）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MoodHost } from '../electron/mood';
import { FatigueActivityBridge } from '../electron/fatigue-activity';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { createInnerLoopHost, type InnerLoopHost } from '../electron/inner-loop/host';
import { claimedView, type MoodCueOwner } from '../electron/inner-loop/claim';
import { ProactiveVision } from '../electron/proactive-vision';
import { VisionPresentationGuard } from '../electron/vision-presentation-adapter';
import { ListenProactive } from '../electron/listen-together/proactive';
import { isVisualAttentionCue } from '../shared/vision-runtime';
import { FixedOpeningChoice } from '../shared/behaviors/opening-choice/fake';
import type { ListenNote } from '../shared/listen-together';
import type { MoodView } from '../shared/mood-runtime';

type Route = 'vision' | 'listen' | 'rest';
const T0 = 5_000_000;
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const note = (): ListenNote => ({ id: 'ln-synthetic', characterId: 'gene', segmentId: 'a', kind: 'music', what: '歌', gist: '一段合成的歌',
  mood: '安静', points: ['合成要点'], mention: true, hook: '合成话头', startedAt: T0 - 5_000, endedAt: T0, local: false, languages: ['zh'],
  createdAt: T0, updatedAt: T0, rolls: 0, talkedAt: null });

async function inFlight(route: Route, fallAsleep: boolean) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-asleep-in-flight-'));
  await writeFile(path.join(directory, 'fatigue-state.json'), JSON.stringify({ version: 1,
    profiles: [{ characterId: 'gene', A: 0.95, F: 0.9, W: 0, phase: 'drowsy', wallMs: T0 }] }));
  let now = T0;
  const clock = () => now;
  const localMinute = () => 180 + (now - T0) / 60_000; // 凌晨三点：深夜，休息提醒会到
  const count = { model: 0, offers: 0, acks: 0, archives: 0 };
  let release!: (text: string) => void;
  const answer = new Promise<string>(resolve => { release = resolve; });
  let offered: { id: string } | null = null;
  let mood!: MoodHost;
  let inner!: InnerLoopHost;
  // electron/main.ts: one gate for every proactive line; it reads her sleep the way the opening choice does ("睡着时谁都不开口").
  const gate = new ProactiveSpeechGate(clock, { resting: () => inner.loop.asleep() });
  const scope = () => `scope:gene:${mood.get().token}`;
  const idle = () => mood.get().snapshot.phase === 'idle';
  const visionOn = route === 'vision', listenOn = route === 'listen';
  const receive = () => { count.model++; return answer; };
  const offer = (message: { id: string }) => { offered = message; count.offers++; };
  const surface = { waitForPresentation: async () => true, isPresentationCurrent: () => true };
  inner = createInnerLoopHost({
    gate, clock, setting: () => true, expressions: () => mood.get().expressions, canExpress: () => !gate.busy, current: idle,
    openingChoice: new FixedOpeningChoice(route === 'vision' ? ['screen', 'quiet'] : route === 'listen' ? ['listen', 'quiet'] : ['mood', 'quiet']),
    characterId: () => 'gene', gateScope: scope, parameters: () => mood.get().parameters, fatiguePhase: () => mood.get().fatigue?.phase,
    context: { localMinute, persona: () => '合成角色', language: () => '', mood: () => '合成心情',
      lastInteractionAt: () => mood.get().snapshot.lastInteractionAt, profileEnabled: () => false, profilePoints: () => '',
      audioReading: () => false, ambientText: () => '' },
    decide: async () => ({ text: await receive() }),
    realize: () => {}, releaseSpeech: claim => mood.releaseSpeech({ id: claim.id, at: claim.at }, claim.characterId),
    offer, cancelOffer: () => {}, surface: () => surface, presentationIdentity: () => scope(),
    archive: async () => { count.archives++; }, developerMode: () => false, diagnosticsFile: () => null, diagnosticsChanged: () => {},
    restReminderFile: () => path.join(directory, 'inner-loop-state.json'),
  });
  const visionEligible = () => visionOn && idle();
  const visionPresentation = new VisionPresentationGuard({ surface: () => surface, identity: scope, eligible: visionEligible });
  const vision = new ProactiveVision({ gate, clock, current: visionEligible,
    capture: async () => [{ source: 'screen', dataUrl: 'data:image/png;base64,AA==' }],
    generate: () => receive(), offer,
    present: (message, signal) => visionPresentation.present(message, signal),
    presentationCurrent: message => visionPresentation.current(message),
    archive: async () => { count.archives++; } });
  const session = { owner: 1, sessionId: 'synthetic-listen', startedAt: T0, captureReadyAt: T0, mode: 'music' as const,
    scope: { characterId: 'gene', providerScope: 'fake' }, contextIdentity: 'scope:gene' };
  const listen = new ListenProactive({ gate, currentSession: () => listenOn ? session : null, canComment: idle,
    persona: () => '合成角色', moodText: () => '合成心情', generate: () => receive(), offer,
    mood: () => ({ primary: 'calm' }), readNote: id => id === 'ln-synthetic' ? note() : null, talked: () => {}, will: () => true, now: clock });
  const fatigue = new FatigueActivityBridge(value => mood.setFatigueActivity(value), async () => false);
  // electron/main.ts, the mood publish: scope, one claim (the opening choice), what the audio engines see.
  let owner: { id: string; who: MoodCueOwner | null } | null = null;
  mood = new MoodHost(directory, (view: MoodView) => {
    gate.setScope(`scope:gene:${view.token}`);
    const cue = view.snapshot.cue;
    const who = inner.opening.claim(cue, {
      vision: c => c.kind === 'speech' && c.source === undefined && visionEligible(),
      ambient: c => c.kind === 'speech' && c.source !== undefined && listen.canTake(c),
      ambientPassed: c => listen.pass(c),
    }, view);
    owner = cue ? { id: cue.id, who } : null;
    listen.observe(claimedView(view, who, mood));
  }, clock, { fatigueClock: { wallMs: clock, monotonicMs: clock, localMinute } });
  // electron/main.ts, the one-second mood clock.
  const tick = (canExpress: boolean) => {
    now += 1_000;
    inner.loop.sweep();
    mood.tick(canExpress, { fatigueActivity: fatigue.current(), ambientSpeech: canExpress ? listen.nextSourceObservation() : undefined,
      allowGenericSpeech: !listenOn });
    const view = mood.get(), cue = view.snapshot.cue;
    if (isVisualAttentionCue(cue) && owner?.id === cue.id && owner.who === 'vision')
      void vision.start(scope(), cue, canExpress && visionEligible() && view.expressions);
  };
  try {
    await mood.load();
    mood.activate('gene');
    mood.setDeveloperMode(true);
    fatigue.setSelection({ motion: null, motionLayers: undefined });
    fatigue.setActivity({ initialized: true, chat: false, tts: false });
    await inner.reminders?.load();
    if (route === 'rest') mood.event({ type: 'chat', id: 'synthetic-earlier-chat' }, 'gene'); // 用户刚才还醒着
    // Natural fatigue only: tick until she is falling asleep, then most of the way through it (the boredom grace is still on).
    for (let i = 0; i < 240 && mood.get().fatigue?.phase !== 'falling-asleep'; i++) tick(!gate.busy);
    assert.equal(mood.get().fatigue?.phase, 'falling-asleep', 'the fixture fell asleep naturally');
    for (let i = 0; i < 27; i++) tick(!gate.busy);
    assert.equal(mood.get().fatigue?.phase, 'falling-asleep');
    const token = mood.get().token;
    if (route === 'listen') { listen.candidate(note(), 'ended'); assert.ok(listen.nextSourceObservation()); }
    else assert.equal(mood.forceAttention('speech'), true);
    tick(true);
    await flush();
    assert.equal(count.model, 1, 'one request is in flight');
    assert.equal(offered, null);
    if (fallAsleep) {
      for (let i = 0; i < 5 && mood.get().fatigue?.phase !== 'asleep'; i++) tick(!gate.busy);
      assert.equal(mood.get().fatigue?.phase, 'asleep', 'she fell asleep with the request still out');
      assert.equal(mood.get().token, token, 'same character and mood scope across sleep');
    }
    release(route === 'vision' ? '看起来你在忙。' : route === 'listen' ? '{"comment":"刚才那段好安静"}' : '{"action":"speak","text":"很晚啦，早点休息？"}');
    await flush();
    const id = (offered as { id: string } | null)?.id;
    let acked = false;
    if (id && route === 'vision') acked = await vision.ack(id) && visionPresentation.canSpeak(id);
    else if (id && route === 'listen') {
      const awaiting = listen.awaitingPresentation(1, id);
      acked = !!awaiting && await surface.waitForPresentation() && !!await listen.acknowledge(1, id);
      if (acked) count.archives++; // electron/main.ts acknowledgeAmbientComment appends the line after a committed acknowledgement
    } else if (id) acked = await inner.loop.ack(id) && inner.presentation.canSpeak(id);
    if (acked) count.acks++;
    await flush();
    return { ...count, phase: mood.get().fatigue?.phase, gateBusy: gate.busy };
  } finally {
    fatigue.dispose(); listen.clear(); vision.dispose(); inner.loop.dispose(); gate.dispose();
    await inner.reminders?.flush(); await mood.flush().catch(() => {});
    assert.equal(path.dirname(directory), os.tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
}

for (const route of ['vision', 'listen', 'rest'] as const) {
  test(`asleep in flight / ${route}: a line asked for while falling asleep and answered after she is asleep is dropped`, async () => {
    const result = await inFlight(route, true);
    assert.deepEqual({ offers: result.offers, acks: result.acks, archives: result.archives }, { offers: 0, acks: 0, archives: 0 });
    assert.equal(result.gateBusy, false, 'the gate is free again');
  });
  test(`asleep in flight / ${route}: control, the same line answered before she is asleep is offered, committed and kept once`, async () => {
    const result = await inFlight(route, false);
    assert.notEqual(result.phase, 'asleep');
    assert.deepEqual({ offers: result.offers, acks: result.acks, archives: result.archives }, { offers: 1, acks: 1, archives: 1 });
  });
}

test('ProactiveSpeechGate resting: no new lease, an active one is dropped at the next look, and it cannot commit', () => {
  let now = 1_000, resting = false, reads = 0;
  const gate = new ProactiveSpeechGate(() => now, { resting: () => { reads++; return resting; } });
  gate.setScope('s');
  const cue = (id: string) => ({ scope: 's', opportunityId: id, expiresAt: now + 30_000 });
  // Awake: nothing changes (and nothing is read while no line is out).
  assert.equal(gate.busy, false);
  assert.equal(reads, 0);
  const awake = gate.tryAcquire(cue('a'), 'vision')!;
  assert.equal(awake.commit(), true);
  // She falls asleep while a line is out: the same-scope publish (setScope) drops it; the source sees an abort, never a commit.
  const out = gate.tryAcquire(cue('b'), 'inner')!;
  resting = true;
  gate.setScope('s');
  assert.equal(out.signal.aborted, true);
  assert.equal(out.commit(), false);
  assert.equal(gate.busy, false);
  // Asleep: nothing new starts.
  assert.equal(gate.tryAcquire(cue('c'), 'ambient'), null);
  // A line whose commit comes first after she fell asleep (no publish in between) is refused at the commit itself.
  resting = false;
  const late = gate.tryAcquire(cue('d'), 'memorial')!;
  resting = true;
  assert.equal(late.commit(), false);
  assert.equal(late.signal.aborted, true);
  // A broken reader keeps the old behavior, like InnerLoop.asleep() (an unreadable sleep never blocks or drops anything).
  const broken = new ProactiveSpeechGate(() => now, { resting: () => { throw new Error('unreadable'); } });
  broken.setScope('s');
  const kept = broken.tryAcquire(cue('e'), 'vision')!;
  assert.equal(kept.commit(), true);
  gate.dispose(); broken.dispose();
});
