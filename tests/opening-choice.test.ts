/**
 * #10 她想找你说话时"这次说什么"由她挑（I-020 第四批，docs/claude/2026-11-04-opening-choice.md；方案第 4 节的安全线、第 7 节的标准）。
 * 守约：真实现（OpeningChoiceDirector）和假实现（FixedOpeningChoice）跑同一组约定；接线：electron/inner-loop/opening-host.ts，
 * 用真内心循环、真屏幕主动聊天、真一起听停顿点开口、真共享闸门，截图和模型都是计数的假实现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OpeningChoiceDirector, chooseOpening, openingNow, type OpeningNowInput } from '../shared/behaviors/opening-choice/choose';
import { FixedOpeningChoice } from '../shared/behaviors/opening-choice/fake';
import { OPENING_CANDIDATE_IDS, OPENING_CHOICE_KNOBS, type OpeningChoiceKnobs } from '../shared/behaviors/opening-choice/knobs';
import type { OpeningCandidateId, OpeningChoiceHost, OpeningNow } from '../shared/behaviors/opening-choice/interface';
import { OpeningHost, type OpeningClaimants, type OpeningLoop } from '../electron/inner-loop/opening-host';
import { claimedView } from '../electron/inner-loop/claim';
import { InnerLoop, type InnerLoopDependencies } from '../electron/inner-loop/inner-loop';
import { innerLoopPrompt } from '../electron/inner-loop/context';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { ProactiveVision } from '../electron/proactive-vision';
import { ListenProactive } from '../electron/listen-together/proactive';
import { HerNeedsHost } from '../electron/her-needs/host';
import { buildInnerLoopPrompt, parseInnerLoopDecision, type InnerLoopPromptInput, type InnerLoopQuiet } from '../shared/inner-loop';
import { SHE_CHOOSES_NO_LEAN } from '../shared/she-chooses';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot, type MoodCue, type MoodLabel, type MoodTendency } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';
import type { ListenNote } from '../shared/listen-together';

const rng = (seed: number) => { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; };
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const AWAKE: InnerLoopQuiet = { asleep: false, drowsy: false, night: false, quiet: false };
const REST = getMoodSnapshot(createMoodState(1_000), 1_000);
const ALL = { listen: true, screen: true, mood: true, play: true };
const PERSON = (p: Partial<Record<MoodTendency, number>> = {}) => ({ playful: 1, close: 1, comfortable: 1, cautious: 1, ...p });
const PLAYFUL = PERSON({ playful: 1.6, close: 1.2, cautious: 0.7 }), CAUTIOUS = PERSON({ playful: 0.6, close: 0.9, cautious: 1.6 });

function moment(input: Partial<OpeningNowInput> & { primary?: MoodLabel } = {}): OpeningNow {
  return openingNow({ available: ALL, snapshot: { ...REST, primary: input.primary ?? 'calm', companion: null, boredom: 80 }, personality: PERSON(),
    need: false, quiet: { night: false, drowsy: false }, last: null, ...input });
}
const weightsOf = (line: string) => Object.fromEntries(line.split(' · ').map(part => { const at = part.lastIndexOf(' '); return [part.slice(0, at), Number(part.slice(at + 1))]; }));
const LABEL = Object.fromEntries(OPENING_CANDIDATE_IDS.map(id => [id, OPENING_CHOICE_KNOBS.candidates[id].label])) as Record<OpeningCandidateId, string>;

// ---------------------------------------------------------------- the choice itself (pure, zero quota)

test('contract (real and fake): only what is there now, "这次不说" always, nothing already tried', () => {
  const hosts: [string, OpeningChoiceHost][] = [['real', new OpeningChoiceDirector({ random: rng(1) })], ['fake', new FixedOpeningChoice()]];
  for (const [name, host] of hosts) {
    for (let i = 0; i < 200; i++) {
      const random = rng(i + 7);
      const available = { listen: random() < 0.5, screen: random() < 0.5, mood: random() < 0.5, play: random() < 0.5 };
      const now = moment({ available });
      const chose = host.choose('gene', now);
      assert.ok(chose, `${name}: something is always there ("这次不说")`);
      assert.ok(chose.id === 'quiet' || available[chose.id], `${name}: ${chose.id} was not there`);
      const without = OPENING_CANDIDATE_IDS.filter(() => random() < 0.5);
      const again = host.choose('gene', now, without);
      if (again) assert.ok(!without.includes(again.id) && (again.id === 'quiet' || available[again.id]), `${name}: ${again.id} was tried or not there`);
      else assert.ok(without.includes('quiet') && OPENING_CANDIDATE_IDS.every(id => id === 'quiet' || without.includes(id) || !available[id]), `${name}: null only when nothing is left`);
    }
    assert.equal(host.choose('gene', moment(), OPENING_CANDIDATE_IDS), null);
    host.settle('gene', 'mood', 5); assert.deepEqual(host.last('gene'), { id: 'mood', at: 5 });
  }
});

test('one random draw per pick, whatever is left out; a knob changes only what it names', () => {
  let draws = 0;
  const director = new OpeningChoiceDirector({ random: () => { draws++; return 0.5; } });
  director.choose('gene', moment()); director.choose('gene', moment(), ['screen', 'mood']); director.choose('gene', moment(), OPENING_CANDIDATE_IDS);
  assert.equal(draws, 3);
  const before = weightsOf(chooseOpening(moment({ primary: 'happy' }), [], () => 0)!.weights);
  const knobs: OpeningChoiceKnobs = { ...OPENING_CHOICE_KNOBS, candidates: { ...OPENING_CHOICE_KNOBS.candidates, screen: { ...OPENING_CHOICE_KNOBS.candidates.screen, base: 0 } } };
  const after = weightsOf(chooseOpening(moment({ primary: 'happy' }), [], () => 0, knobs)!.weights);
  assert.equal(after[LABEL.screen], 0, '"她太爱说屏幕了" → screen.base, and only screen moves');
  for (const id of ['listen', 'mood', 'play', 'quiet'] as const) assert.equal(after[LABEL[id]], before[LABEL[id]], id);
  for (let i = 0; i < 100; i++) assert.notEqual(chooseOpening(moment(), [], rng(i), knobs)!.id, 'screen');
});

test('plan §7: the same scene 20 times (listen pause, a small need, a playful card, happy) varies; a cautious card lets more pass', () => {
  const run = (personality: Record<MoodTendency, number>, seed: number) => {
    const director = new OpeningChoiceDirector({ random: rng(seed) }), counts: Record<string, number> = {};
    for (let i = 0; i < 20; i++) {
      const now = moment({ available: { listen: true, screen: false, mood: true, play: true }, primary: 'happy', personality, need: true, last: director.last('gene') });
      const chose = director.choose('gene', now)!;
      director.settle('gene', chose.id, i + 1);
      counts[chose.id] = (counts[chose.id] ?? 0) + 1;
    }
    return counts;
  };
  let playfulQuiet = 0, cautiousQuiet = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const playful = run(PLAYFUL, seed), cautious = run(CAUTIOUS, seed);
    assert.ok(Object.keys(playful).length >= 3, `seed ${seed}: at least three different picks (${JSON.stringify(playful)})`);
    assert.ok(Math.max(...Object.values(playful)) <= 14, `seed ${seed}: none over 70% (${JSON.stringify(playful)})`);
    playfulQuiet += playful.quiet ?? 0; cautiousQuiet += cautious.quiet ?? 0;
  }
  assert.ok(cautiousQuiet >= 2 * playfulQuiet + 10, `"这次不说" clearly more often on the cautious card (${cautiousQuiet} vs ${playfulQuiet} of 100)`);
});

test('plan Q2: night and drowsy press listen and screen to about a third and raise "这次不说"; nothing is shut', () => {
  const day = weightsOf(chooseOpening(moment(), [], () => 0)!.weights);
  for (const quiet of [{ night: true, drowsy: false }, { night: false, drowsy: true }]) {
    const late = weightsOf(chooseOpening(moment({ quiet }), [], () => 0)!.weights);
    for (const id of ['listen', 'screen'] as const) {
      assert.ok(Math.abs(late[LABEL[id]] / day[LABEL[id]] - 0.33) < 0.02, `${id}: ${late[LABEL[id]]} vs ${day[LABEL[id]]}`);
      assert.ok(late[LABEL[id]] > 0, `${id} still possible`);
    }
    assert.ok(Math.abs(late[LABEL.quiet] / day[LABEL.quiet] - 2) < 0.05);
    assert.equal(late[LABEL.mood], day[LABEL.mood], 'her own line keeps the inner loop\'s own quiet rules');
  }
});

test('"why" holds only true reasons from this moment', () => {
  const happy = chooseOpening(moment({ available: { listen: true, screen: false, mood: false, play: false }, primary: 'happy', personality: PLAYFUL }), [], () => 0)!;
  assert.equal(happy.id, 'listen'); assert.ok(happy.why.includes('心情：愉快') && happy.why.includes('性格：爱玩'), happy.why.join('；'));
  const plain = chooseOpening(moment({ available: { listen: false, screen: false, mood: true, play: false } }), [], () => 0)!;
  assert.deepEqual(plain.why, [SHE_CHOOSES_NO_LEAN], 'at rest she has no lean, and says so');
  const rest = chooseOpening(moment({ available: { listen: true, screen: true, mood: true, play: false }, snapshot: REST }), [], rng(2))!;
  assert.ok(!rest.why.some(line => /这会儿(有点调皮|想黏着你|很放松|有点拘谨)/u.test(line)), `no lean from a baseline hair (${rest.why.join('；')})`);
  const needy = chooseOpening(moment({ available: { listen: false, screen: false, mood: true, play: false }, need: true }), [], () => 0)!;
  assert.ok(needy.why.includes('她正好有一件小需要'));
  // "上次想找你说话以后你还没来过": only after a speaking pick the user has not answered (a chat, pat or feeding since).
  const last = { id: 'screen' as const, at: 5_000 };
  assert.ok(moment({ last }).moments.includes('unanswered'));
  assert.ok(!moment({ last, snapshot: { ...REST, primary: 'calm', companion: null, boredom: 80, lastInteractionAt: 6_000 } }).moments.includes('unanswered'));
  assert.ok(!moment({ last: { id: 'quiet', at: 5_000 } }).moments.includes('unanswered'));
});

// ---------------------------------------------------------------- the host (electron/inner-loop/opening-host.ts)

interface FakeLoop extends OpeningLoop { calls: string[]; take: boolean; can: boolean; sleeping: boolean; reminder: boolean; quiet: InnerLoopQuiet }
function fakeLoop(): FakeLoop {
  const loop: FakeLoop = { calls: [], take: true, can: true, sleeping: false, reminder: false, quiet: { ...AWAKE },
    offerOpportunity: (cue, focus) => { loop.calls.push(`offer:${(cue as MoodCue).id}:${focus ?? '-'}`); return loop.take; },
    canTake: () => loop.can, claims: () => false, asleep: () => loop.sleeping,
    silence: cue => { loop.calls.push(`silence:${(cue as MoodCue).id}`); return true; }, restReminderDue: () => loop.reminder, quietNow: () => ({ ...loop.quiet }) };
  return loop;
}
const VIEW = { characterId: 'gene', snapshot: REST, parameters: DEFAULT_MOOD_PARAMETERS } as Pick<MoodView, 'characterId' | 'snapshot' | 'parameters'>;
let cueSerial = 0;
const speech = (source = false): MoodCue => ({ id: `cue-${++cueSerial}`, kind: 'speech', at: 10_000, until: 13_000,
  ...(source ? { source: { kind: 'ambient', sessionId: 'listen1', observationId: `listen1:${cueSerial}` } } : {}) } as MoodCue);
function host(loop: OpeningLoop, chooser: OpeningChoiceHost, extra: Partial<ConstructorParameters<typeof OpeningHost>[0]> = {}) {
  const refunds: string[] = [];
  const opening = new OpeningHost({ loop, chooser, innerOn: () => true, developerMode: () => true, clock: () => 10_500,
    releaseSpeech: cue => { refunds.push(cue.id); }, ...extra });
  return { opening, refunds };
}

test('asleep nobody; her memorial invitation first; R20 next; a motion cue straight to the inner loop; none of them weighed', () => {
  const loop = fakeLoop(), chooser = new FixedOpeningChoice(), { opening } = host(loop, chooser);
  const asked: string[] = [];
  const claimants = (memorial: boolean, r20 = false): OpeningClaimants => ({ memorial: () => { asked.push('memorial'); return memorial; }, r20: () => { asked.push('r20'); return r20; },
    vision: () => { asked.push('vision'); return true; } });
  loop.sleeping = true;
  const asleep = speech();
  assert.equal(opening.claim(asleep, claimants(true), VIEW), 'asleep');
  assert.deepEqual(asked, [], 'asleep: the memorial is not asked (not spent), the screen is not even looked at');
  assert.deepEqual(loop.calls, [`silence:${asleep.id}`]);
  loop.sleeping = false;
  assert.equal(opening.claim(speech(), claimants(true), VIEW), 'memorial');
  assert.deepEqual(asked, ['memorial']);
  asked.length = 0;
  assert.equal(opening.claim(speech(), claimants(false, true), VIEW), 'r20');
  assert.deepEqual(asked, ['memorial', 'r20']);
  assert.equal(chooser.asked.length, 0, 'none of these was a pick');
  const motion: MoodCue = { id: 'motion-1', kind: 'motion', at: 10_000, until: 13_000 };
  assert.equal(opening.claim(motion, claimants(false), VIEW), 'inner');
  loop.take = false;
  assert.equal(opening.claim({ ...motion, id: 'motion-2' }, claimants(false), VIEW), null, 'a motion cue the inner loop refuses stays the rule motion');
  assert.equal(chooser.asked.length, 0);
});

test('the night\'s one rest reminder goes the old way (not weighed), even with the screen chat on', () => {
  const loop = fakeLoop(), chooser = new FixedOpeningChoice(['screen', 'quiet']), { opening } = host(loop, chooser);
  loop.reminder = true; loop.quiet = { asleep: false, drowsy: false, night: true, quiet: true };
  const cue = speech();
  assert.equal(opening.claim(cue, { vision: () => true }, VIEW), 'inner');
  assert.deepEqual(loop.calls, [`offer:${cue.id}:rest`]); assert.equal(chooser.asked.length, 0);
  assert.match(opening.recent('gene')[0].why.join(''), /提醒一次休息/);
  loop.take = false; // the inner loop cannot take it now: the cue goes to the pick as usual
  assert.equal(opening.claim(speech(), { vision: () => true }, VIEW), 'vision'); assert.equal(chooser.asked.length, 1);
});

// Choosing never captures, records or calls a model: the wired tests below count captures and model calls around each claim.
test('privacy: 1000 random moments — a switch that is off never brings its candidate', () => {
  const random = rng(42), director = new OpeningChoiceDirector({ random: rng(43) });
  const moods = Object.keys(DEFAULT_MOOD_PARAMETERS.weights);
  let screenOff = 0, listenOff = 0, innerOff = 0;
  for (let i = 0; i < 1000; i++) {
    const loop = fakeLoop(), visionOn = random() < 0.5, source = random() < 0.4, listenOn = random() < 0.5, inner = random() < 0.6;
    loop.can = random() < 0.8; loop.quiet = random() < 0.3 ? { asleep: false, drowsy: random() < 0.5, night: true, quiet: true } : { ...AWAKE };
    const { opening } = host(loop, director, { innerOn: () => inner, play: () => random() < 0.5, need: () => random() < 0.5 });
    const primary = (['calm', 'happy', 'sad', 'longing', 'upset', 'excited'] as MoodLabel[])[Math.floor(random() * 6)];
    const view = { ...VIEW, snapshot: { ...REST, primary, boredom: 75 + random() * 25 },
      parameters: { ...DEFAULT_MOOD_PARAMETERS, weights: Object.fromEntries(moods.map(m => [m, 0.5 + random()])) as typeof DEFAULT_MOOD_PARAMETERS.weights } };
    const owner = opening.claim(speech(source), { vision: c => c.source === undefined && visionOn, ambient: c => c.source !== undefined && listenOn }, view);
    if (!visionOn || source) { screenOff++; assert.notEqual(owner, 'vision', `#${i}`); }
    if (!listenOn || !source) { listenOff++; assert.notEqual(owner, 'ambient', `#${i}`); }
    if (!inner) { innerOff++; assert.notEqual(owner, 'inner', `#${i}: no small feeling or invite while the inner loop is off`); assert.ok(!loop.calls.some(call => call.startsWith('offer')), `#${i}`); }
    if (owner === 'inner') assert.ok(loop.calls.some(call => /:(mood|play)$/.test(call)), `#${i}`);
  }
  assert.ok(screenOff > 300 && listenOff > 300 && innerOff > 300);
});

test('备选: what she picked cannot be done → one more pick among the rest → else silence, the quota back once', () => {
  // The inner loop refuses her small feeling: neither of its two is tried again; the screen is her second pick.
  let loop = fakeLoop(); loop.take = false;
  let h = host(loop, new FixedOpeningChoice(['mood', 'play', 'screen', 'quiet']), { play: () => true });
  const cue = speech();
  assert.equal(h.opening.claim(cue, { vision: () => true }, VIEW), 'vision');
  assert.deepEqual(loop.calls, [`offer:${cue.id}:mood`], 'play was not asked after the inner loop said no');
  assert.match(h.opening.recent('gene')[0].why[0], /说说她的小情绪这会儿做不成，备选：说说你屏幕上的/);
  assert.deepEqual(h.refunds, []);
  // Nothing else can: silence, its quota back, and later publishes of the same cue do not ask again or refund twice.
  loop = fakeLoop(); loop.take = false;
  h = host(loop, new FixedOpeningChoice(['mood', 'screen', 'quiet']));
  const lone = speech();
  assert.equal(h.opening.claim(lone, { vision: () => false }, VIEW), 'quiet');
  assert.equal(h.opening.claim(lone, { vision: () => true }, VIEW), 'quiet');
  assert.deepEqual(h.refunds, [lone.id]);
  assert.match(h.opening.recent('gene')[0].why[0], /这会儿做不成，这次不说（次数退回）/);
  // The screen looked available but is not by the time it is taken (the switch went off in between): the second pick.
  loop = fakeLoop();
  let looks = 0;
  h = host(loop, new FixedOpeningChoice(['screen', 'mood', 'quiet']));
  assert.equal(h.opening.claim(speech(), { vision: () => ++looks === 1 }, VIEW), 'inner');
  assert.equal(looks, 2);
});

test('"这次不说": silence, quota back once, the pet window sees no cue; a pause point not given to the listen line is dropped', () => {
  const loop = fakeLoop(), h = host(loop, new FixedOpeningChoice(['quiet']));
  const passed: string[] = [], cue = speech(true);
  const claimants: OpeningClaimants = { ambient: () => true, ambientPassed: c => passed.push(c.id) };
  assert.equal(h.opening.claim(cue, claimants, VIEW), 'quiet');
  assert.equal(h.opening.claim(cue, claimants, VIEW), 'quiet');
  assert.deepEqual(h.refunds, [cue.id]); assert.deepEqual(passed, [cue.id]);
  const view = { ...VIEW, snapshot: { ...REST, cue } } as MoodView;
  assert.equal(claimedView(view, 'quiet').snapshot.cue, null);
  const listen = host(fakeLoop(), new FixedOpeningChoice(['listen']));
  assert.equal(listen.opening.claim(speech(true), claimants, VIEW), 'ambient');
  assert.deepEqual(passed, [cue.id], 'the listen line keeps its own pause point');
});

test('inner loop off (#13): no small feeling and no invite in the list, never a fixed line; screen and listen as usual', () => {
  const loop = fakeLoop(), chooser = new FixedOpeningChoice(['mood', 'play', 'screen', 'quiet']);
  const { opening, refunds } = host(loop, chooser, { innerOn: () => false, play: () => true, need: () => true });
  assert.equal(opening.claim(speech(), { vision: () => true }, VIEW), 'vision');
  assert.deepEqual(chooser.asked[0].now.available, { listen: false, screen: true, mood: false, play: false });
  assert.ok(!chooser.asked[0].now.moments.includes('need'), 'her small need is not even looked at');
  const alone = speech();
  assert.equal(opening.claim(alone, {}, VIEW), 'quiet'); assert.deepEqual(refunds, [alone.id]);
  assert.deepEqual(loop.calls, [], 'the inner loop was never asked');
});

test('look, don\'t take: weighing her small need does not spend it; a pick that goes elsewhere leaves it for her own line', () => {
  let now = 50_000;
  const needs = new HerNeedsHost({ file: () => null, diagnosticsFile: () => null, developerMode: () => false, changed: () => {}, lift: () => {}, clock: () => now });
  assert.equal(needs.startNow('gene', 'lonely', now), true);
  const chooser = new FixedOpeningChoice(['screen', 'mood', 'quiet']);
  const { opening } = host(fakeLoop(), chooser, { need: id => needs.hasSpeechChance(id) });
  for (let i = 0; i < 5; i++) assert.equal(opening.claim(speech(), { vision: () => true }, VIEW), 'vision');
  assert.ok(chooser.asked.every(ask => ask.now.moments.includes('need')), 'it was weighed every time');
  now += 1_000;
  assert.equal(needs.hasSpeechChance('gene'), true);
  assert.notEqual(needs.speechChance('gene'), '', 'still there for the inner loop\'s prompt');
  assert.equal(needs.hasSpeechChance('gene'), false, 'and spent only by that');
});

test('the "why" line: developer mode only, memory only, labels and reasons only', () => {
  let developer = false;
  const { opening } = host(fakeLoop(), new OpeningChoiceDirector({ random: rng(3) }), { developerMode: () => developer });
  opening.claim(speech(), { vision: () => true }, VIEW);
  assert.deepEqual(opening.recent('gene'), [], 'not recorded outside developer mode');
  developer = true;
  opening.claim(speech(true), { ambient: () => true }, { ...VIEW, snapshot: { ...REST, primary: 'happy' } });
  const [line] = opening.recent('gene');
  assert.equal(line.from, 'pause'); assert.ok(OPENING_CANDIDATE_IDS.map(id => LABEL[id]).includes(line.label), line.label);
  assert.ok(line.weights.includes(LABEL.listen) && line.weights.includes(LABEL.quiet));
  assert.deepEqual(Object.keys(line).sort(), ['at', 'from', 'label', 'weights', 'why']);
  developer = false;
  assert.deepEqual(opening.recent('gene'), [], 'and not sent once developer mode is off');
});

// ---------------------------------------------------------------- wired: real inner loop, screen chat, listen line, shared gate

const note = (): ListenNote => ({ id: 'ln-a', characterId: 'gene', segmentId: 'a', kind: 'music', what: '歌', gist: '一首讲夏天的歌', mood: '怀念',
  points: ['夏天'], mention: true, hook: '', startedAt: 0, endedAt: 0, local: false, languages: ['zh'], createdAt: 0, updatedAt: 0, rolls: 0, talkedAt: null });

function wired(options: { chooser: OpeningChoiceHost; innerOn?: boolean; frames?: () => Promise<{ source: 'screen'; dataUrl: string }[]>; visionText?: () => Promise<string> }) {
  const clock = { now: 1_000_000 };
  const count = { captures: 0, visionModel: 0, visionOffers: 0, listenModel: 0, listenOffers: 0, innerModel: 0, innerOffers: 0, refunds: 0, prompts: [] as string[], innerCues: [] as string[] };
  const gate = new ProactiveSpeechGate(() => clock.now); gate.setScope('scope');
  const deps: InnerLoopDependencies = {
    gate, clock: () => clock.now, enabled: () => options.innerOn !== false, canStart: () => !gate.busy, current: () => true,
    scope: () => ({ characterId: 'gene', gateScope: 'scope' }), parameters: () => DEFAULT_MOOD_PARAMETERS, quiet: () => ({ ...AWAKE }),
    prompt: (claim, _allowSpeech, _quiet, _life, play, focus) => { count.innerCues.push(`${claim.id}:${focus ?? '-'}:${play ? 'play' : ''}`); return 'prompt'; },
    decide: async () => { count.innerModel++; return { text: '{"action":"speak","text":"在呢"}' }; },
    realize: () => {}, releaseSpeech: () => { count.refunds++; }, offer: () => { count.innerOffers++; },
    present: async () => true, presentationCurrent: () => true, archive: async () => {},
  };
  const loop = new InnerLoop(deps);
  const vision = new ProactiveVision({ gate, clock: () => clock.now,
    capture: async () => { count.captures++; return options.frames ? options.frames() : [{ source: 'screen', dataUrl: 'data:image/jpeg;base64,YQ==' }]; },
    generate: async () => { count.visionModel++; return options.visionText ? options.visionText() : '看起来你在写东西。'; },
    offer: () => { count.visionOffers++; }, present: async () => true, presentationCurrent: () => true, current: () => true, archive: async () => {},
    unable: (id, stage) => opening.unable(id, stage) });
  const session = { owner: 2, sessionId: 'listen1', startedAt: 0, captureReadyAt: 0, mode: 'music' as const, scope: { characterId: 'gene', providerScope: 'p' }, contextIdentity: 'scope' };
  const listen = new ListenProactive({ gate, currentSession: () => session, canComment: () => true, persona: () => '你是 Gene。', moodText: () => '平静',
    generate: async prompt => { count.listenModel++; count.prompts.push(prompt); return '{"comment":"刚才那首好怀念"}'; },
    offer: () => { count.listenOffers++; }, mood: () => ({ primary: 'calm' }), readNote: () => note(), talked: () => {}, will: () => true, now: () => clock.now });
  const opening: OpeningHost = new OpeningHost({ loop, chooser: options.chooser, innerOn: () => options.innerOn !== false, developerMode: () => true,
    clock: () => clock.now, releaseSpeech: () => { count.refunds++; } });
  /** electron/main.ts: the claim in the mood publish, then the screen chat in the tick and the listen line on the visible view. */
  const opportunity = async (kind: 'idle' | 'pause') => {
    clock.now += 31 * 60_000;
    loop.sweep(); void gate.busy; // the one-second mood tick: an unacknowledged line from last time has expired by now
    let source: MoodCue['source'];
    if (kind === 'pause') { listen.candidate({ ...note(), rolls: clock.now }, 'ended'); source = listen.nextSourceObservation(); assert.ok(source); }
    const cue = { id: `c${clock.now}`, kind: 'speech', at: clock.now, until: clock.now + 3_000, ...(source ? { source } : {}) } as MoodCue;
    const before = { ...count, prompts: [...count.prompts], innerCues: [...count.innerCues] };
    const owner = opening.claim(cue, { vision: c => c.source === undefined, ambient: c => c.source !== undefined && listen.canTake(c), ambientPassed: c => listen.pass(c) }, VIEW);
    assert.deepEqual({ captures: count.captures, visionModel: count.visionModel, listenModel: count.listenModel, innerModel: count.innerModel },
      { captures: before.captures, visionModel: before.visionModel, listenModel: before.listenModel, innerModel: before.innerModel }, 'choosing itself: no capture, no model');
    const view = { ...VIEW, snapshot: { ...REST, cue } } as MoodView;
    listen.observe(claimedView(view, owner));
    if (owner === 'vision') void vision.start('scope', cue, true);
    await flush();
    return { owner, cue, before };
  };
  return { opportunity, count, opening, listen, dispose: () => { loop.dispose(); vision.dispose(); listen.clear(); gate.dispose(); } };
}

test('one opportunity, one voice: the screen is captured only when she picked it, once; nobody else speaks on that cue', async () => {
  const w = wired({ chooser: new OpeningChoiceDirector({ random: rng(11) }) });
  const owners: Record<string, number> = {};
  for (let i = 0; i < 40; i++) {
    const { owner, before } = await w.opportunity('idle');
    owners[String(owner)] = (owners[String(owner)] ?? 0) + 1;
    const spoke = (w.count.visionOffers - before.visionOffers) + (w.count.innerOffers - before.innerOffers) + (w.count.listenOffers - before.listenOffers);
    assert.ok(spoke <= 1, `#${i}: ${spoke} voices`);
    assert.equal(w.count.captures - before.captures, owner === 'vision' ? 1 : 0, `#${i} ${owner}`);
    assert.equal(w.count.innerModel - before.innerModel, owner === 'inner' ? 1 : 0, `#${i} ${owner}`);
  }
  assert.ok((owners.vision ?? 0) > 0 && (owners.inner ?? 0) > 0 && (owners.quiet ?? 0) > 0, JSON.stringify(owners));
  assert.equal(w.count.captures, owners.vision);
  w.dispose();
});

test('备选 for the screen: no frame, or nothing from the model → her small feeling instead (one short new chance); off → silence, quota back', async () => {
  for (const failure of ['capture', 'generation', 'throws'] as const) {
    const w = wired({ chooser: new FixedOpeningChoice(['screen', 'mood', 'quiet']),
      frames: failure === 'capture' ? async () => [] : undefined,
      visionText: failure === 'generation' ? async () => '' : failure === 'throws' ? async () => { throw new Error('model'); } : undefined });
    const { owner, cue } = await w.opportunity('idle');
    assert.equal(owner, 'vision');
    assert.equal(w.count.captures, 1); assert.equal(w.count.visionOffers, 0);
    assert.deepEqual(w.count.innerCues, [`${cue.id}-b:mood:`], `${failure}: one more pick, her small feeling`);
    assert.equal(w.count.innerOffers, 1); assert.equal(w.count.refunds, 0);
    assert.equal(w.opening.claim(cue, {}, VIEW), 'inner', 'later publishes: the pet window now hides it');
    assert.match(w.opening.recent('gene')[0].why[0], /说说你屏幕上的做不成（(取不到画面|画面没想出要说的)），备选：说说她的小情绪/);
    w.dispose();
  }
  const off = wired({ chooser: new FixedOpeningChoice(['screen', 'mood', 'quiet']), innerOn: false, frames: async () => [] });
  await off.opportunity('idle');
  assert.equal(off.count.innerModel, 0); assert.equal(off.count.refunds, 1, 'nothing said: the quota comes back, once');
  off.dispose();
});

test('a listen pause point: the listen line gets only the note; picked otherwise, the inner loop takes it and the pause point is dropped', async () => {
  const listen = wired({ chooser: new FixedOpeningChoice(['listen', 'quiet']) });
  const first = await listen.opportunity('pause');
  assert.equal(first.owner, 'ambient'); assert.equal(listen.count.listenModel, 1); assert.equal(listen.count.listenOffers, 1);
  assert.match(listen.count.prompts[0], /<external-audio-data>/); assert.match(listen.count.prompts[0], /一首讲夏天的歌/);
  listen.dispose();
  const mood = wired({ chooser: new FixedOpeningChoice(['mood', 'quiet']) });
  const { owner, cue } = await mood.opportunity('pause');
  assert.equal(owner, 'inner'); assert.deepEqual(mood.count.innerCues, [`${cue.id}:mood:`]);
  assert.equal(mood.count.listenModel, 0); assert.equal(mood.listen.counts.passed, 1);
  assert.equal(mood.listen.nextSourceObservation(), undefined, 'not offered again');
  mood.dispose();
});

// ---------------------------------------------------------------- the inner loop's prompt, narrowed by the pick

const promptInput = (extra: Partial<InnerLoopPromptInput> = {}): InnerLoopPromptInput => ({ persona: '你是 Gene。', mood: '平静。', weights: DEFAULT_MOOD_PARAMETERS.weights,
  intensity: DEFAULT_MOOD_PARAMETERS.intensity, localMinute: 15 * 60, minutesSinceInteraction: 40, cue: 'speech', allowSpeech: true, quiet: { ...AWAKE }, ...extra });

test('"邀你玩猜拳" narrows her one small-model call to the invite; nothing else in any prompt changes', () => {
  const plain = buildInnerLoopPrompt(promptInput({ play: true }));
  assert.equal(buildInnerLoopPrompt(promptInput({ play: true, inviteOnly: false })), plain, 'without the pick: byte for byte as before');
  assert.equal(buildInnerLoopPrompt(promptInput({ inviteOnly: true })), buildInnerLoopPrompt(promptInput()), 'no invite offered: nothing to narrow');
  const narrowed = buildInnerLoopPrompt(promptInput({ play: true, inviteOnly: true }));
  assert.match(plain, /speak（说一句话）/); assert.doesNotMatch(narrowed, /speak（说一句话）|"action":"speak"/);
  assert.match(narrowed, /invite（邀请用户玩猜拳）/); assert.match(narrowed, /这次你想邀用户玩一局猜拳/);
  assert.equal(parseInnerLoopDecision('{"action":"speak","text":"在呢"}', true, null, true, false), null);
  assert.deepEqual(parseInnerLoopDecision('{"action":"invite","text":"来一局？"}', true, null, true, false), { action: 'invite', text: '来一局？' });
  assert.deepEqual(parseInnerLoopDecision('{"action":"speak","text":"在呢"}', true, null, true), { action: 'speak', text: '在呢' }, 'old callers unchanged');
  // Her small need is not read (so not spent) when the pick was the invite; it is for her small feeling.
  let reads = 0;
  const sources = { now: () => 1_000, localMinute: () => 15 * 60, persona: () => '你是 Gene。', language: () => '', mood: () => '平静。', parameters: () => DEFAULT_MOOD_PARAMETERS,
    lastInteractionAt: () => null, need: () => { reads++; return '你此刻有一点轻轻的小情绪。'; }, profileEnabled: () => false, profilePoints: () => '', audioReading: () => false, ambientText: () => '' };
  const claim = { id: 'c', kind: 'speech' as const, at: 1_000, characterId: 'gene' };
  innerLoopPrompt(sources, claim, true, AWAKE, null, true, 'play'); assert.equal(reads, 0);
  innerLoopPrompt(sources, claim, true, AWAKE, null, false, 'mood'); assert.equal(reads, 1);
});

test('the inner loop with a pick: "mood" never offers the invite; "play" offers it and refuses a plain line', async () => {
  const run = async (focus: 'mood' | 'play', answer: string) => {
    const gate = new ProactiveSpeechGate(() => 5_000); gate.setScope('scope');
    const log = { eligible: 0, prompts: [] as string[], offered: 0, released: 0, invited: 0 };
    const loop = new InnerLoop({ gate, clock: () => 5_000, enabled: () => true, canStart: () => true, current: () => true,
      scope: () => ({ characterId: 'gene', gateScope: 'scope' }), parameters: () => DEFAULT_MOOD_PARAMETERS, quiet: () => ({ ...AWAKE }),
      prompt: (_c, _a, _q, _l, play, f) => { log.prompts.push(`${f}:${play}`); return 'p'; }, decide: async () => ({ text: answer }),
      realize: () => {}, releaseSpeech: () => { log.released++; }, offer: () => { log.offered++; }, present: async () => true, presentationCurrent: () => true,
      archive: async () => {}, play: { eligible: () => { log.eligible++; return true; }, invited: () => { log.invited++; } } });
    assert.equal(loop.canTake({ id: 'p1', kind: 'speech', at: 4_000, until: 8_000, source: { kind: 'ambient', sessionId: 's', observationId: 's:1' } }, focus), true, 'a pause-point cue too');
    assert.equal(loop.offerOpportunity({ id: 'p1', kind: 'speech', at: 4_000, until: 8_000, source: { kind: 'ambient', sessionId: 's', observationId: 's:1' } }, focus), true);
    await flush(); loop.dispose(); gate.dispose();
    return log;
  };
  const mood = await run('mood', '{"action":"speak","text":"在呢"}');
  assert.equal(mood.eligible, 0); assert.deepEqual(mood.prompts, ['mood:false']); assert.equal(mood.offered, 1);
  const play = await run('play', '{"action":"speak","text":"在呢"}');
  assert.equal(play.eligible, 1); assert.deepEqual(play.prompts, ['play:true']);
  assert.equal(play.offered, 0, 'a plain line is not one of the options'); assert.equal(play.released, 1, 'its quota comes back');
  const invite = await run('play', '{"action":"invite","text":"来一局？"}');
  assert.equal(invite.offered, 1);
});
