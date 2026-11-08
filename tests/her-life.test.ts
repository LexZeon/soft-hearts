/**
 * 她自己的生活 (docs/claude/2026-11-02-her-life-plan.md 「验证」): the shared table and state machine, the host
 * (persistence across restarts, the one-turn chat line, the diary line, developer diagnostics) and the inner loop's
 * "换件事做" option. The stage side (R29 frame loop) is in her-life-stage.test.ts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HER_LIFE_ACTIVITIES, HER_LIFE_TABLE, herLifeChatLine, herLifeDiaryLine, herLifeDuration, herLifeIdleAfterMs, herLifeSwitchOffer, herLifeWeights,
  noteHerLifeReturn, pickHerLifeActivity, stepHerLife, type HerLifeRecord, type HerLifeStepInput,
} from '../shared/her-life';
import { HerLifeHost, type HerLifeTickInput } from '../electron/her-life/host';
import { DEFAULT_MOOD_PARAMETERS, type MoodParameters } from '../shared/mood';
import { buildInnerLoopPrompt, parseInnerLoopDecision, sanitizeInnerLoopDiagnostic } from '../shared/inner-loop';
import { buildCompanionPersona } from '../electron/conversation-context';
import { buildDiaryPrompt } from '../electron/diary/diary-prompt';
import { formatHerLifeLine } from '../src/ui/MoodPanel';
import { InnerLoop } from '../electron/inner-loop/inner-loop';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { herLifeMotionAllowed, resolveHerLifeMotionResource } from '../electron/her-life/motion-resource';

const MINUTE = 60_000;
const card = (motionMinutes = 5, weights: Partial<MoodParameters['weights']> = {}): MoodParameters => ({
  ...structuredClone(DEFAULT_MOOD_PARAMETERS),
  frequency: { ...DEFAULT_MOOD_PARAMETERS.frequency, motionIntervalMs: motionMinutes * MINUTE },
  weights: { ...DEFAULT_MOOD_PARAMETERS.weights, ...weights },
});
const sequence = (...values: number[]) => { let i = 0; return () => values[i++ % values.length]; };
const step = (record: HerLifeRecord, over: Partial<HerLifeStepInput> = {}, random = () => 0.5) => stepHerLife(record, {
  now: 10 * MINUTE, expressions: true, idle: true, fatigue: 'awake', parameters: card(), mood: 'calm', localMinute: 14 * 60, ...over }, random);
const daydream: HerLifeRecord = { activity: 'daydream', since: 0, until: 20 * MINUTE, source: 'rule' };

test('the table: every state has words and a presentation; only drowsy is left to fatigue; motions are the two pinned ones', () => {
  for (const id of HER_LIFE_ACTIVITIES) {
    const spec = HER_LIFE_TABLE[id];
    assert.ok(spec.label && spec.chat, id);
    assert.equal(spec.pick.auto, id !== 'drowsy' && id !== 'watching', id); // I-006 step 3: 跟着看 is not rule-picked either (only while the user watches or plays something on the shared screen)
    assert.equal(spec.presentation.mouthSmile <= 0.3, true, 'humming is silent: a closed smile at most, never an open mouth');
  }
  assert.deepEqual(HER_LIFE_ACTIVITIES.filter(id => HER_LIFE_TABLE[id].motion).map(id => HER_LIFE_TABLE[id].motion!.id), ['thinking', 'sleepy']);
  assert.equal(HER_LIFE_ACTIVITIES.includes('reading' as never), false, 'no 看书 in the first version (no book prop)');
});

test('she only changes while the user is away; "自动表现" off freezes her', () => {
  assert.equal(step(daydream, { now: 25 * MINUTE, idle: false }).reason, 'busy');
  assert.equal(step(daydream, { now: 25 * MINUTE, idle: false }).record, daydream);
  assert.equal(step(daydream, { now: 25 * MINUTE, expressions: false }).reason, 'frozen');
  assert.equal(step(daydream, { now: 5 * MINUTE }).reason, 'unchanged');
  const next = step(daydream, { now: 25 * MINUTE });
  assert.equal(next.reason, 'elapsed');
  assert.notEqual(next.record.activity, 'daydream', 'the next state is a different one');
  assert.notEqual(next.record.activity, 'drowsy');
});

test('drowsy follows the fatigue model: in while drowsy or asleep, out (to a picked state) once awake', () => {
  for (const phase of ['drowsy', 'falling-asleep', 'asleep', 'micro-awake'] as const) {
    const result = step(daydream, { fatigue: phase });
    assert.equal(result.record.activity, 'drowsy', phase); assert.equal(result.record.source, 'fatigue');
    assert.equal(result.record.until, Number.MAX_SAFE_INTEGER, 'lasts as long as the fatigue model says');
  }
  const drowsy: HerLifeRecord = { activity: 'drowsy', since: 0, until: Number.MAX_SAFE_INTEGER, source: 'fatigue' };
  assert.equal(step(drowsy, { fatigue: 'drowsy' }).reason, 'unchanged');
  const awake = step(drowsy, { fatigue: 'light-drowsy' });
  assert.equal(awake.reason, 'awake'); assert.notEqual(awake.record.activity, 'drowsy');
  assert.equal(step(drowsy, { fatigue: 'awake', idle: false }).record, drowsy, 'still only while the user is away');
  // Light drowsiness alone is not 犯困, and the rules never pick it.
  for (let i = 0; i < 50; i++) assert.notEqual(pickHerLifeActivity({ current: 'company', localMinute: 3 * 60, mood: 'calm', weights: {} }, () => i / 50), 'drowsy');
});

test('the duration follows the card\'s small-motion interval (no fixed numbers for every card)', () => {
  const half = () => 0.5;
  assert.equal(herLifeDuration('daydream', card(5), half), 5 * MINUTE * 4.5, 'default card: about 22 minutes');
  assert.equal(herLifeDuration('daydream', card(10), half), 10 * MINUTE * 4.5, 'a slower card dwells twice as long');
  assert.equal(herLifeDuration('humming', card(5), half), 5 * MINUTE * 3);
  const [low, high] = HER_LIFE_TABLE.daydream.pick.duration;
  assert.equal(herLifeDuration('daydream', card(5), () => 0), 5 * MINUTE * low);
  assert.equal(herLifeDuration('daydream', card(5), () => 1), 5 * MINUTE * high);
  assert.equal(herLifeIdleAfterMs(card(5)), 5 * MINUTE, 'she takes up her own things after the card\'s interval');
  const record = step({ activity: 'company', since: 0, until: 0, source: 'start' }, { parameters: card(8) }, half).record;
  assert.equal(record.until - record.since, 8 * MINUTE * (HER_LIFE_TABLE[record.activity].pick.duration[0] + HER_LIFE_TABLE[record.activity].pick.duration[1]) / 2);
});

test('the pick follows time of day, mood and the card\'s tendency weights', () => {
  const at = (mood: string, minute = 14 * 60, weights = {}) => herLifeWeights({ current: 'company', localMinute: minute, mood, weights });
  assert.ok(at('happy').humming! > at('sad').humming!, 'a good mood hums more');
  assert.ok(at('calm', 1 * 60).humming! < at('calm', 14 * 60).humming!, 'quieter at night');
  assert.ok(at('calm', 22 * 60).daydream! > at('calm', 14 * 60).daydream!, 'more daydreaming in the evening');
  assert.ok(at('calm', 14 * 60, { comfortable: 1.5 }).daydream! > at('calm', 14 * 60, { comfortable: 0.5 }).daydream!, 'a quiet, comfortable character daydreams more');
  assert.ok(at('calm', 14 * 60, { playful: 1.5 }).humming! > at('calm').humming!, 'a playful one hums more');
  assert.equal(herLifeWeights({ current: 'daydream', localMinute: 0, mood: 'calm', weights: {} }).daydream, undefined, 'never the same state again');
  assert.equal(at('calm').drowsy, undefined, 'drowsy is the fatigue model\'s');
  // Deterministic roll: the cumulative weights decide.
  assert.equal(pickHerLifeActivity({ current: 'company', localMinute: 14 * 60, mood: 'happy', weights: { playful: 1.5 } }, sequence(0.999)), 'thinking');
});

test('"抬起头" and the chat line on the first interaction while she is at her own thing', () => {
  const back = noteHerLifeReturn(daydream, 25 * MINUTE);
  assert.equal(back.lookUp, true); assert.deepEqual(back.interrupted, { activity: 'daydream', minutes: 25 });
  assert.equal(back.record.activity, 'company'); assert.equal(back.record.source, 'return');
  assert.equal(noteHerLifeReturn(back.record, 25 * MINUTE + 5_000).lookUp, false, 'the second interaction is just company');
  // Pretrial issue 6 (2026-11-03): any interaction while she is at her own thing lifts her out of it, however long the
  // user was away and however long she had been at it (the "测试：去忙自己的事" shortcut is the same as a real return).
  const fresh = noteHerLifeReturn({ ...daydream, since: 25 * MINUTE - 20_000 }, 25 * MINUTE);
  assert.equal(fresh.lookUp, true, 'she had only just started: still a look-up'); assert.equal(fresh.record.activity, 'company');
  assert.deepEqual(fresh.interrupted, { activity: 'daydream', minutes: 0 });
  assert.equal(herLifeChatLine(fresh.interrupted), '你刚才在：发呆（刚开始没一会儿），被用户打断了；可以自然提一句，不用每次都提。');
  assert.equal(herLifeChatLine(back.interrupted), '你刚才在：发呆（约 25 分钟），被用户打断了；可以自然提一句，不用每次都提。');
  assert.equal(herLifeChatLine({ activity: 'humming', minutes: 3 }), '你刚才在：轻轻哼歌（没出声）（约 3 分钟），被用户打断了；可以自然提一句，不用每次都提。');
  assert.equal(herLifeChatLine(null), ''); assert.equal(herLifeChatLine({ activity: 'company', minutes: 9 }), '');
  assert.doesNotMatch(herLifeChatLine(back.interrupted), /[他她]/u, 'the user is 用户 / 你');
});

function hostHarness(file: string | null, options: { developer?: boolean; clock?: { now: number } } = {}) {
  const clock = options.clock ?? { now: 1_000 * MINUTE };
  const changed: string[] = [], appended: string[] = [];
  const host = new HerLifeHost({ file: () => file, diagnosticsFile: () => '/dev/her-life.jsonl', developerMode: () => options.developer === true,
    changed: id => changed.push(id), clock: () => clock.now, random: () => 0.5, append: async (_file, line) => { appended.push(line); } });
  const tick = (over: Partial<HerLifeTickInput> = {}) => host.tick('gene', { now: clock.now, expressions: true, canExpress: true, phase: 'idle',
    lastInteractionAt: null, fatigue: 'awake', parameters: card(), mood: 'calm', localMinute: 14 * 60, ...over });
  return { host, clock, changed, appended, tick };
}

test('host: away for the card\'s interval she takes up her own thing; a chat turns her back with a look-up and one line, once', () => {
  const h = hostHarness(null);
  const talked = h.clock.now;
  h.tick({ lastInteractionAt: talked });
  assert.equal(h.host.view('gene')!.activity, 'company');
  h.clock.now = talked + 4 * MINUTE; h.tick({ lastInteractionAt: talked });
  assert.equal(h.host.view('gene')!.activity, 'company', 'not yet away long enough');
  h.clock.now = talked + 5 * MINUTE; h.tick({ lastInteractionAt: talked });
  const own = h.host.view('gene')!;
  assert.notEqual(own.activity, 'company'); assert.equal(own.since, h.clock.now);
  h.clock.now += 3 * MINUTE; h.tick({ lastInteractionAt: talked, canExpress: false });
  assert.equal(h.host.view('gene')!.activity, own.activity, 'a hidden pet / reply speech does not change her');
  h.clock.now += 9 * MINUTE;
  const line = h.host.chatTurn('gene', h.clock.now);
  assert.equal(line, herLifeChatLine({ activity: own.activity, minutes: 12 }));
  assert.equal(h.host.view('gene')!.activity, 'company');
  assert.ok(h.host.view('gene')!.lookUp, 'the stage gets one look-up');
  assert.equal(h.host.chatTurn('gene', h.clock.now + 20_000), '', 'only that one turn');
  // The persona carries the line only when given: the next turn's context has no trace of it.
  const persona = (herLife?: string) => buildCompanionPersona({ persona: 'P', stateContext: 'S', herLife, memories: [], protocolInstruction: 'X' });
  assert.ok(persona(line).includes(`S\n\n${line}\n\n`), 'right after the mood context, in this turn\'s private context');
  assert.equal(persona(''), persona(undefined), 'the next turn is exactly as without her life');
  h.clock.now += 6_000; assert.equal(h.host.view('gene')!.lookUp, null, 'the look-up is fresh for a few seconds only');
});

test('host: a touch or feeding seen only by the mood model counts as the return too; the line waits for the next chat but not forever', () => {
  const h = hostHarness(null);
  h.tick({ lastInteractionAt: h.clock.now - 30 * MINUTE });
  assert.notEqual(h.host.view('gene')!.activity, 'company');
  h.clock.now += 10 * MINUTE;
  h.tick({ lastInteractionAt: h.clock.now - 30 * MINUTE, phase: 'rua' });
  assert.equal(h.host.view('gene')!.activity, 'company'); assert.ok(h.host.view('gene')!.lookUp);
  assert.ok(h.host.chatTurn('gene', h.clock.now + MINUTE).startsWith('你刚才在：'), 'a chat a minute later still hears it');
  const late = hostHarness(null);
  late.tick({ lastInteractionAt: late.clock.now - 30 * MINUTE });
  late.clock.now += 10 * MINUTE; late.host.interact('gene', late.clock.now);
  assert.equal(late.host.chatTurn('gene', late.clock.now + 11 * MINUTE), '', 'a stale line is dropped');
});

test('host: across a restart she carries on within the state\'s time, and has moved on after it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'her-life-'));
  const file = path.join(directory, 'her-life.json');
  const clock = { now: 1_000 * MINUTE };
  const first = hostHarness(file, { clock });
  await first.host.load();
  first.tick({ lastInteractionAt: clock.now - 30 * MINUTE });
  const before = first.host.view('gene')!;
  assert.notEqual(before.activity, 'company');
  await first.host.flush();
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(saved.characters), ['gene']);
  assert.deepEqual(Object.keys(saved.characters.gene.record).sort(), ['activity', 'since', 'source', 'until'], 'state names and times only');

  clock.now = before.until - MINUTE;
  const reopened = hostHarness(file, { clock });
  await reopened.host.load();
  assert.equal(reopened.host.view('gene')!.activity, before.activity);
  reopened.tick({ lastInteractionAt: before.since - 30 * MINUTE });
  assert.equal(reopened.host.view('gene')!.activity, before.activity, 'still within its time: she carries on');
  assert.equal(reopened.host.view('gene')!.since, before.since);

  clock.now = before.until + 60 * MINUTE;
  const later = hostHarness(file, { clock });
  await later.host.load();
  later.tick({ lastInteractionAt: before.since - 30 * MINUTE });
  assert.notEqual(later.host.view('gene')!.activity, before.activity, 'long after: she is doing something else');

  // An unreadable file is kept as it is and never overwritten.
  await writeFile(file, '{oops', 'utf8');
  const broken = hostHarness(file, { clock });
  await broken.host.load(); broken.tick({ lastInteractionAt: null }); await broken.host.flush();
  assert.equal(await readFile(file, 'utf8'), '{oops');
});

test('host: developer diagnostics are state names and times only, and only in developer mode', async () => {
  const quiet = hostHarness(null);
  quiet.tick({ lastInteractionAt: quiet.clock.now - 30 * MINUTE });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(quiet.appended, []); assert.deepEqual(quiet.host.recent(), []);
  const dev = hostHarness(null, { developer: true });
  dev.tick({ lastInteractionAt: dev.clock.now - 30 * MINUTE });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dev.appended.length, 1);
  const entry = JSON.parse(dev.appended[0]);
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'from', 'to', 'until']);
  assert.equal(entry.from, 'company');
});

test('host: the diary gets one line of what she did that day; nothing short or "陪着你" is mentioned', () => {
  const h = hostHarness(null);
  const day = new Date(2026, 10, 2).getTime(), minuteOf = (ms: number) => (ms - day) / MINUTE;
  h.clock.now = day + 14 * 60 * MINUTE;
  h.tick({ lastInteractionAt: h.clock.now - 30 * MINUTE });
  const first = h.host.view('gene')!.activity;
  h.clock.now += 40 * MINUTE; h.host.interact('gene', h.clock.now);
  const line = h.host.diaryLine('gene', day, day + 24 * 60 * MINUTE, minuteOf);
  assert.ok(line.includes(`下午${HER_LIFE_TABLE[first].diaryLong}（约 40 分钟）`), line);
  assert.equal(herLifeDiaryLine([{ activity: 'company', from: day, to: day + 90 * MINUTE }, { activity: 'humming', from: day, to: day + 3 * MINUTE }], day, day + 1440 * MINUTE, minuteOf), '');
  const prompt = buildDiaryPrompt({ persona: 'P', language: '', date: '2026-11-02', relative: '昨天', material: '10:00 用户：早', herLife: line });
  assert.ok(prompt.includes(line)); assert.ok(!buildDiaryPrompt({ persona: 'P', language: '', date: '2026-11-02', relative: '昨天', material: 'x' }).includes('自己做过的事'));
});

test('inner loop "换件事做": offered only on a motion opportunity, only after a while, never into or out of drowsy', () => {
  const p = card(5), record: HerLifeRecord = { activity: 'daydream', since: 0, until: 20 * MINUTE, source: 'rule' };
  const offer = herLifeSwitchOffer(record, { now: 6 * MINUTE, expressions: true, idle: true, fatigue: 'awake', parameters: p })!;
  assert.deepEqual(offer, { current: 'daydream', minutes: 6, choices: ['company', 'humming', 'thinking'] });
  assert.equal(herLifeSwitchOffer(record, { now: 4 * MINUTE, expressions: true, idle: true, fatigue: 'awake', parameters: p }), null, 'not before the card\'s interval');
  assert.equal(herLifeSwitchOffer(record, { now: 6 * MINUTE, expressions: true, idle: false, fatigue: 'awake', parameters: p }), null);
  assert.equal(herLifeSwitchOffer(record, { now: 6 * MINUTE, expressions: true, idle: true, fatigue: 'drowsy', parameters: p }), null);
  const base = { persona: 'P', mood: 'M', weights: p.weights, intensity: p.intensity, localMinute: 600, minutesSinceInteraction: 30,
    quiet: { asleep: false, drowsy: false, night: false, quiet: false } };
  const motion = buildInnerLoopPrompt({ ...base, cue: 'motion', allowSpeech: false, herLife: offer });
  assert.ok(motion.includes('你自己现在在做的事：发呆（约 6 分钟）。'));
  assert.ok(motion.includes('switch（换件事做）'));
  assert.ok(motion.includes('company（安静地陪着用户）、humming（轻轻哼歌（没出声））、thinking（想事情）'));
  assert.ok(motion.includes('{"action":"switch","activity":"上面列出的一件事的英文名"}'));
  const speech = buildInnerLoopPrompt({ ...base, cue: 'speech', allowSpeech: true, herLife: offer });
  assert.ok(!speech.includes('switch'), 'a speech opportunity has no such option');
  assert.ok(!buildInnerLoopPrompt({ ...base, cue: 'motion', allowSpeech: false }).includes('switch'), 'no offer, no option');
});

test('inner loop "换件事做": anything but an exact offered choice is "do nothing"', () => {
  const offer = { current: 'daydream' as const, minutes: 6, choices: ['company', 'humming', 'thinking'] as const };
  assert.deepEqual(parseInnerLoopDecision('{"action":"switch","activity":"humming"}', false, offer), { action: 'switch', activity: 'humming' });
  assert.deepEqual(parseInnerLoopDecision('```json\n{"action":"switch","activity":"thinking"}\n```', false, offer), { action: 'switch', activity: 'thinking' });
  for (const bad of ['{"action":"switch","activity":"daydream"}', '{"action":"switch","activity":"drowsy"}', '{"action":"switch","activity":"reading"}',
    '{"action":"switch"}', '{"action":"switch","activity":"humming","text":"嗯"}', '{"action":"switch","activity":["humming"]}', '{"action":"switch","activity":"Humming"}'])
    assert.equal(parseInnerLoopDecision(bad, false, offer), null, bad);
  assert.equal(parseInnerLoopDecision('{"action":"switch","activity":"humming"}', false, null), null, 'not offered: invalid');
  assert.deepEqual(parseInnerLoopDecision('{"action":"motion"}', false, offer), { action: 'motion' }, 'the old options are unchanged');
  assert.deepEqual(sanitizeInnerLoopDiagnostic({ at: 1, cue: 'motion', called: true, decision: 'switch', result: 'ok', quiet: false, ms: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 })?.decision, 'switch');
});

test('host: the inner loop\'s choice applies only while the offer still stands', () => {
  const h = hostHarness(null);
  h.tick({ lastInteractionAt: h.clock.now - 30 * MINUTE });
  const current = h.host.view('gene')!.activity;
  const input = { now: h.clock.now, expressions: true, canExpress: true, phase: 'idle' as const, fatigue: 'awake' as const, parameters: card() };
  assert.equal(h.host.switchTo('gene', 'humming', input), false, 'too early in the state');
  h.clock.now += 6 * MINUTE;
  const later = { ...input, now: h.clock.now };
  assert.equal(h.host.switchTo('gene', current, later), false, 'not the same state');
  assert.equal(h.host.switchTo('gene', 'drowsy', later), false);
  assert.equal(h.host.switchTo('gene', 'thinking', { ...later, canExpress: false }), false, 'the user is busy now');
  assert.equal(h.host.switchTo('gene', current === 'thinking' ? 'humming' : 'thinking', later), true);
  assert.equal(h.host.view('gene')!.source, 'inner');
});

test('developer panel line: what she does, for how long, about when it changes', () => {
  const now = 100 * MINUTE;
  assert.equal(formatHerLifeLine({ activity: 'daydream', since: now - 12 * MINUTE, until: now + 9 * MINUTE, source: 'rule', lookUp: null }, now),
    '她在做的事：发呆 · 已经 12 分钟 · 大约 9 分钟后换');
  assert.equal(formatHerLifeLine({ activity: 'company', since: now, until: Number.MAX_SAFE_INTEGER, source: 'return', lookUp: null }, now),
    '她在做的事：陪着你 · 已经 0 分钟 · 等你离开一会儿再换');
  assert.equal(formatHerLifeLine({ activity: 'drowsy', since: now - MINUTE, until: Number.MAX_SAFE_INTEGER, source: 'fatigue', lookUp: null }, now),
    '她在做的事：犯困 · 已经 1 分钟 · 困意过去后再换');
  assert.equal(formatHerLifeLine(undefined), '她在做的事：暂无');
});

test('inner loop engine: a "switch" decision is handed to the host in the same one call; an invalid one changes nothing', async () => {
  const offer = { current: 'daydream' as const, minutes: 6, choices: ['company', 'humming', 'thinking'] as const };
  for (const [answer, expected] of [['{"action":"switch","activity":"humming"}', ['humming']], ['{"action":"switch","activity":"drowsy"}', []],
    ['{"action":"switch","activity":"daydream"}', []], ['not json', []]] as const) {
    const now = 1_000_000, gate = new ProactiveSpeechGate(() => now); gate.setScope('scope');
    const switched: string[] = [], prompts: unknown[] = [];
    let decides = 0;
    const loop = new InnerLoop({ gate, clock: () => now, enabled: () => true, canStart: () => true, current: () => true,
      scope: () => ({ characterId: 'gene', gateScope: 'scope' }), parameters: () => DEFAULT_MOOD_PARAMETERS,
      quiet: () => ({ asleep: false, drowsy: false, night: false, quiet: false }),
      prompt: (_claim, _speech, _quiet, herLife) => { prompts.push(herLife ?? null); return 'prompt'; },
      decide: async () => { decides++; return { text: answer }; },
      herLife: { offer: () => offer, switch: (_claim, activity) => { switched.push(activity); } },
      realize: () => { throw Error('no rule motion for a switch'); }, releaseSpeech: () => {}, offer: () => {}, present: async () => true, presentationCurrent: () => true,
      archive: async () => {} });
    assert.equal(loop.offerOpportunity({ id: 'motion-cue', kind: 'motion', at: now, until: now + 3_000 }), true);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(decides, 1, 'no extra model call'); assert.deepEqual(prompts, [offer]); assert.deepEqual(switched, expected, answer);
    loop.dispose(); gate.dispose();
  }
});

test('motion grant: only the pinned motion of the state she is in now, and only its exact bytes', async () => {
  const view = (activity: 'thinking' | 'drowsy' | 'daydream', expressions = true) => ({ expressions, herLife: { activity, since: 0, until: 1, source: 'rule' as const, lookUp: null } });
  assert.equal(herLifeMotionAllowed('thinking', view('thinking')), true);
  assert.equal(herLifeMotionAllowed('sleepy', view('drowsy')), true);
  assert.equal(herLifeMotionAllowed('sleepy', view('thinking')), false, 'not the current state\'s motion');
  assert.equal(herLifeMotionAllowed('thinking', view('daydream')), false);
  assert.equal(herLifeMotionAllowed('thinking', view('thinking', false)), false, '"自动表现" off');
  assert.equal(herLifeMotionAllowed('../../model.pmx', view('thinking')), false);
  const gene = path.resolve('assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/motions');
  const library = (file: string) => ({ resolvePreview: async () => file });
  const resolved = await resolveHerLifeMotionResource(library(path.join(gene, 'reaction/thinking.vmd')), 'thinking');
  assert.deepEqual({ ...resolved, path: undefined }, { motionId: 'thinking', sha256: '1f9927296862cc379004f29d8d7fa902918ad2868967c71b5fe7006e80bd118e', durationMs: 10_000, path: undefined });
  assert.equal((await resolveHerLifeMotionResource(library(path.join(gene, 'expression/sleepy.vmd')), 'sleepy')).motionId, 'sleepy');
  await assert.rejects(resolveHerLifeMotionResource(library(path.join(gene, 'expression/sleepy.vmd')), 'thinking'), 'other bytes under the pinned name');
  await assert.rejects(resolveHerLifeMotionResource(library(path.join(gene, 'reaction/thinking.vmd')), 'smile'));
});
