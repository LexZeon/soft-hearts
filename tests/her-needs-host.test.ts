/**
 * 她也会需要你 (L4): the host (clock-driven start, saving, soothing, the chat line, the one speech chance, the developer log),
 * the mood side (applyMoodLift, MoodHost.lift, what a touch / a snack reports, the welcome-back chat context), the inner loop's
 * prompt, and the whole thing through CompanionService. docs/claude/2026-11-03-she-needs-you.md.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HerNeedsHost, type HerNeedsHostOptions, type HerNeedsTickInput } from '../electron/her-needs/host';
import { CompanionService } from '../electron/companion';
import { MoodHost } from '../electron/mood';
import { innerLoopPrompt, type InnerLoopContextSources } from '../electron/inner-loop/context';
import { buildInnerLoopPrompt, type InnerLoopQuiet } from '../shared/inner-loop';
import { DEFAULT_MOOD_PARAMETERS, advanceMood, applyMoodLift, createMoodState, getMoodSnapshot, type MoodValues } from '../shared/mood';
import { localDateKey } from '../electron/diary/diary-dates';
import type { MoodInput } from '../shared/mood-runtime';
import { BIG_LINE_WORDS, HER_NEED_DEJECTION, HER_NEED_TABLE, WELCOME_BACK_LINE, herNeedChatLine, herNeedRelief, herNeedSpeechLine, type HerNeedId, type HerNeedLimitInput } from '../shared/her-needs';

const SECOND = 1_000, MIN = 60_000, HOUR = 3_600_000, DAY_MS = 24 * HOUR;
const flat: MoodValues = { D: 50, O: 50, E: 50, N: 50, C: 50 };
const T0 = new Date(2026, 10, 3, 9, 0, 0).getTime();
/** What none of her lines may carry (the user's "big line", 2026-11-03: a little 撒娇 is fine, a lever on the user is not). */
const LEVER = /你走了|难过死|别去|在乎我就|离不开|没有你|少了你|必须|应该来|该来|多陪|欠我|活该/u;
/** The big line stated in her own lines (so the checks look at what is left). */
const BIG_LINE_PHRASES = new RegExp([BIG_LINE_WORDS, '不要求用户[^；。，]*', '也不要越说越委屈', '不要用户道歉或补偿', '不让用户不敢再离开', '不撒娇抱怨', '不惩罚、不加码、不翻旧账'].join('|'), 'gu');

interface Rig { host: HerNeedsHost; clock: { now: number }; changed: string[]; lifts: { characterId: string; id: string; delta: Partial<MoodValues>; reason: string; relief?: number }[]; directory: string; file: string;
  tick(over?: Partial<HerNeedsTickInput>): void; ticks(seconds: number, over?: Partial<HerNeedsTickInput>): void; developer: { on: boolean }; appended: string[] }

function tickInput(now: number, over: Partial<HerNeedsTickInput> = {}): HerNeedsTickInput {
  return { now, day: localDateKey(now), expressions: true, canExpress: true, phase: 'idle', lastInteractionAt: null, fatigue: 'awake', boredom: 80,
    mood: 'calm', channels: { ...flat }, parameters: { baseline: { ...flat }, weights: { ...DEFAULT_MOOD_PARAMETERS.weights } }, localMinute: 15 * 60, ...over };
}
async function rig(run: (rig: Rig) => Promise<void>, options: Partial<HerNeedsHostOptions> = {}, existing?: { directory: string; start: number }): Promise<void> {
  const directory = existing?.directory ?? await mkdtemp(path.join(os.tmpdir(), 'soft-her-needs-'));
  const file = path.join(directory, 'her-needs.json'), clock = { now: existing?.start ?? T0 };
  const changed: string[] = [], appended: string[] = [], lifts: Rig['lifts'] = [], developer = { on: false };
  const host = new HerNeedsHost({ file: () => file, diagnosticsFile: () => path.join(directory, 'dev', 'her-needs.jsonl'), developerMode: () => developer.on,
    changed: id => changed.push(id), lift: (characterId, lift) => lifts.push({ characterId, ...lift }), clock: () => clock.now, random: () => 0,
    append: async (_file, line) => { appended.push(line); }, ...options });
  await host.load();
  const tick = (over: Partial<HerNeedsTickInput> = {}) => host.tick('gene', tickInput(clock.now, over));
  const ticks = (seconds: number, over: Partial<HerNeedsTickInput> = {}) => { for (let i = 0; i < seconds; i++) { clock.now += SECOND; tick(over); } };
  try { await run({ host, clock, changed, lifts, directory, file, tick, ticks, developer, appended }); }
  finally { host.dispose(); if (!existing) await rm(directory, { recursive: true, force: true }); }
}
/** Past the warm-up and the "ignored" time, then ticks until the first need begins. */
function startOne(r: Rig): HerNeedId {
  r.clock.now += 41 * MIN; r.tick();
  r.ticks(3);
  const view = r.host.view('gene');
  assert.ok(view, 'a need began');
  return view.id;
}

// ---------------------------------------------------------------- the host

test('host: nothing while she has been ignored for less than 40 minutes of this run, whatever the days before; then one begins', async () => {
  await rig(async r => {
    // The last interaction was three days ago (the app was closed since): that time counts for nothing.
    const long = T0 - 3 * DAY_MS;
    r.clock.now += 10 * MIN; r.tick({ lastInteractionAt: long });
    r.ticks(29 * 60, { lastInteractionAt: long });
    assert.equal(r.host.view('gene'), null, 'only 39 minutes since this run began');
    assert.equal(r.changed.length, 0);
    r.ticks(2 * 60, { lastInteractionAt: long });
    assert.equal(r.host.view('gene')?.mode, 'need', 'past 40 minutes it can begin');
    assert.equal(r.host.view('gene')?.id, 'lonely');
    assert.ok(r.changed.length >= 1, 'the mood view is told');
  });
});

test('host: the user doing something with her (a mood phase, an interaction) restarts the count', async () => {
  await rig(async r => {
    r.clock.now += 30 * MIN; r.tick();
    r.clock.now += 5 * MIN; r.tick({ phase: 'rua' });
    r.clock.now += 20 * MIN; r.tick();
    r.ticks(5);
    assert.equal(r.host.view('gene'), null, '20 minutes after a pat: not yet');
    r.clock.now += 5 * MIN; r.tick({ lastInteractionAt: r.clock.now - 10 * MIN });
    r.ticks(5, { lastInteractionAt: r.clock.now - 10 * MIN });
    assert.equal(r.host.view('gene'), null, 'a chat 10 minutes ago');
  });
});

test('host: a start is saved with today\'s counts and the interaction counts; a restart keeps them (and what went unanswered) but not the need, and the limit function sees them', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-her-needs-keep-'));
  try {
    let startedAt = 0;
    await rig(async r => {
      assert.equal(startOne(r), 'lonely');
      startedAt = r.host.view('gene')!.since;
      r.host.interact('gene', 'touch', 500); // a tenth of an interaction: a pat of half a second
      await r.host.flush();
      const saved = JSON.parse(await readFile(r.file, 'utf8'));
      assert.deepEqual(Object.keys(saved), ['version', 'characters']);
      assert.deepEqual(saved.characters.gene, { day: localDateKey(startedAt), used: ['lonely'], lastStartAt: startedAt, interactions: 0.1, interactionsToday: 0.1,
        lastStartInteractions: 0, kindStartInteractions: { lonely: 0 }, snubs: {} });
      // It fades unanswered: she remembers that; and 低落 is not saved.
      r.clock.now += 40 * MIN; r.tick();
      assert.equal(r.host.view('gene')?.mode, 'low');
      await r.host.flush();
      const later = JSON.parse(await readFile(r.file, 'utf8')).characters.gene;
      assert.deepEqual(Object.keys(later.snubs), ['lonely']);
      assert.equal('dejection' in later, false);
    }, {}, { directory, start: T0 });
    // A restart one hour after it began: no need and no 低落; but today's start, the counts and the lonely snub are what the limit function reads.
    const seen: HerNeedLimitInput[] = [];
    await rig(async r => {
      r.clock.now = startedAt + HOUR;
      r.tick(); r.ticks(60);
      assert.equal(r.host.view('gene'), null, 'no need and no 低落 carry over a restart');
      assert.ok(seen.length > 0);
      const input = seen.at(-1)!;
      assert.deepEqual(input.startsToday, ['lonely']);
      assert.equal(input.lastStartAt, startedAt);
      assert.ok(Math.abs(input.interactionsSinceLastStart! - 0.1) < 1e-9);
      assert.ok(input.snubbed.lonely && input.snubbed.lonely.ageMs > 0 && input.snubbed.lonely.ageMs < HOUR);
      assert.equal(input.dejection, 0);
    }, { trigger: () => ({ lonely: 0.5 }), limits: limitInput => { seen.push(limitInput); return { soft: 0, reluctance: 1 }; } }, { directory, start: startedAt + HOUR });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('host: an unreadable file is kept as it is and never overwritten; a bad entry is dropped', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-her-needs-bad-'));
  try {
    const file = path.join(directory, 'her-needs.json');
    await writeFile(file, '{not json', 'utf8');
    await rig(async r => { startOne(r); await r.host.flush(); }, {}, { directory, start: T0 });
    assert.equal(await readFile(file, 'utf8'), '{not json');
    await writeFile(file, JSON.stringify({ version: 1, characters: { gene: { day: 'nope', used: [], lastStartAt: null }, other: { day: '2026-11-03', used: ['dream'], lastStartAt: T0 } } }), 'utf8');
    await rig(async r => {
      startOne(r); await r.host.flush();
      const saved = JSON.parse(await readFile(file, 'utf8'));
      assert.deepEqual(saved.characters.other, { day: '2026-11-03', used: ['dream'], lastStartAt: T0, interactions: 0, interactionsToday: 0, lastStartInteractions: null,
        kindStartInteractions: {}, snubs: {} }, 'another character\'s record is kept (with the counts a file from before had none of)');
      assert.deepEqual(saved.characters.gene.used, ['lonely']);
    }, {}, { directory, start: T0 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('host: soothing by patting and a snack adds up, lifts the mood once by the table\'s amount, and turns into the glow', async () => {
  await rig(async r => {
    assert.equal(startOne(r), 'lonely');
    const need = HER_NEED_TABLE.lonely.soothe;
    assert.equal(r.host.interact('gene', 'touch', need.touchMs / 2), null);
    assert.ok(r.host.view('gene')!.strength < 1, 'being soothed halfway makes it weaker');
    assert.equal(r.lifts.length, 0);
    assert.equal(r.host.interact('gene', 'food', need.foods / 2), 'lonely');
    assert.equal(r.lifts.length, 1);
    assert.equal(r.lifts[0].characterId, 'gene');
    assert.deepEqual(r.lifts[0].delta, HER_NEED_TABLE.lonely.comfort);
    assert.equal(r.lifts[0].reason, '被用户哄好了');
    const view = r.host.view('gene')!;
    assert.equal(view.mode, 'glow'); assert.equal(view.strength, 1);
    // Nothing more to soothe: a further pat adds no second lift.
    assert.equal(r.host.interact('gene', 'touch', 60_000), null);
    assert.equal(r.lifts.length, 1);
    // The glow fades away by itself.
    r.clock.now += 20 * MIN; r.tick();
    assert.equal(r.host.view('gene'), null);
  });
});

test('host: interact() with an invalid amount (0, negative, NaN) is rejected before it touches anything: no "the user is here", no re-arm, no event (T-112 round-007)', async () => {
  const seen: number[] = [];
  await rig(async r => {
    r.clock.now += 41 * MIN; r.tick();
    const before = seen.at(-1)!;
    assert.ok(before >= 40 * MIN, `ignored since the run began: ${before}`);
    const changes = r.changed.length, lifts = r.lifts.length;
    for (const amount of [0, -1, NaN, Infinity]) for (const kind of ['touch', 'food', 'chat'] as const) assert.equal(r.host.interact('gene', kind, amount), null);
    assert.equal(r.changed.length, changes, 'nothing to republish');
    assert.equal(r.lifts.length, lifts, 'no relief');
    r.clock.now += SECOND; r.tick();
    assert.ok(seen.at(-1)! >= before + SECOND, `the ignored time was not reset by a nothing: ${seen.at(-1)} after ${before}`);
    // A real pat does reset it.
    r.host.interact('gene', 'touch', 500);
    r.clock.now += SECOND; r.tick();
    assert.ok(seen.at(-1)! <= SECOND, `a real pat is the user coming: ${seen.at(-1)}`);
  }, { trigger: signals => { seen.push(signals.ignoredMs ?? -1); return {}; } });
  // Left unanswered (not armed): a nothing does not let another need begin; a real pat does.
  await rig(async r => {
    startOne(r);
    r.clock.now += 2 * HOUR; r.tick();
    assert.notEqual(r.host.view('gene')?.mode, 'need', 'the first faded unanswered');
    for (const amount of [0, -3, NaN]) r.host.interact('gene', 'touch', amount);
    r.clock.now += 2 * HOUR; r.ticks(600);
    assert.notEqual(r.host.view('gene')?.mode, 'need', 'still not re-armed: nothing begins');
    r.host.interact('gene', 'touch', 500);
    r.ticks(600);
    assert.equal(r.host.view('gene')?.mode, 'need', 'a real pat re-arms it');
  }, { trigger: () => ({ lonely: 1 }), limits: () => ({ soft: 1, reluctance: 1 }) });
});

test('host: the chat line is told once per state and a message counts as a few words; the message that soothes her gets the happy line', async () => {
  await rig(async r => {
    assert.equal(r.host.chatTurn('gene'), '', 'nothing going on: no line, no cost');
    startOne(r);
    r.clock.now += MIN;
    const first = r.host.chatTurn('gene');
    assert.equal(first, herNeedChatLine('need', 'lonely'));
    assert.ok(first.includes(BIG_LINE_WORDS)); assert.match(first, /你先和好/);
    assert.equal(r.lifts.length, 0, 'one message is half of what she needs');
    r.clock.now += MIN;
    const second = r.host.chatTurn('gene');
    assert.equal(second, herNeedChatLine('soothed', 'lonely'), 'the second message soothes her');
    assert.equal(r.lifts.length, 1);
    assert.equal(r.host.chatTurn('gene'), '', 'told once');
  });
});

test('host: a touch alone is told at the next message, once, and never twice', async () => {
  await rig(async r => {
    startOne(r);
    r.host.interact('gene', 'touch', HER_NEED_TABLE.lonely.soothe.touchMs);
    assert.equal(r.lifts.length, 1);
    assert.equal(r.host.chatTurn('gene'), herNeedChatLine('soothed', 'lonely'));
    assert.equal(r.host.chatTurn('gene'), '');
  });
});

test('host: the inner loop gets one speech chance per need, none when she is soothed, none with 自动表现 off', async () => {
  await rig(async r => {
    assert.equal(r.host.speechChance('gene'), '');
    startOne(r);
    const line = r.host.speechChance('gene');
    assert.equal(line, herNeedSpeechLine('lonely'));
    assert.equal(r.host.speechChance('gene'), '', 'the chance is used up');
  });
  await rig(async r => {
    startOne(r);
    r.host.interact('gene', 'touch', 60_000);
    assert.equal(r.host.speechChance('gene'), '', 'soothed');
  });
  await rig(async r => {
    startOne(r);
    r.tick({ expressions: false });
    assert.equal(r.host.view('gene'), null, 'put away at once');
    assert.equal(r.host.speechChance('gene'), '');
    assert.equal(r.host.chatTurn('gene'), '');
  });
  await rig(async r => {
    startOne(r);
    r.clock.now += HER_NEED_TABLE.lonely.holdMs + HER_NEED_TABLE.lonely.fadeMs * 0.9;
    r.tick();
    assert.equal(r.host.speechChance('gene'), '', 'nearly faded: she lets it go');
  });
});

test('host: nobody answers: it fades, the mood dips a little, 低落 shows (quietly) and nothing comes after until the user has done something with her', async () => {
  await rig(async r => {
    startOne(r);
    r.clock.now += 40 * MIN; r.tick();
    assert.equal(r.lifts.length, 1);
    const dip = r.lifts[0];
    assert.ok(dip.delta.D! < 0 && dip.delta.O! < 0 && dip.delta.D! >= -(HER_NEED_DEJECTION.dipBase + HER_NEED_DEJECTION.dipGain) * 1.6, 'a small dip, bounded');
    assert.equal(dip.relief, undefined);
    assert.doesNotMatch(dip.reason, /你|用户|没理|晾/, 'the reason that goes into the chat context blames nobody');
    const low = r.host.view('gene')!;
    assert.equal(low.mode, 'low'); assert.ok(Math.abs(low.strength - HER_NEED_TABLE.lonely.dejection) < 1e-9);
    assert.equal(r.host.speechChance('gene'), '', '低落 is never spoken');
    // Hours of the same wants, nobody there: nothing new, and 低落 settles by itself (half-life 6 h).
    for (let hour = 0; hour < 5; hour++) { r.clock.now += HOUR; r.tick(); r.ticks(30); }
    assert.equal(r.lifts.length, 1, 'no second dip, no second need');
    const settled = r.host.view('gene');
    assert.ok(settled === null || settled.strength < low.strength, 'it only settles');
  });
});

test('host: the user comes after she was left unanswered: 释然 (a lift as big as what had piled up, the label for a moment), the relief line once, and nothing is carried', async () => {
  await rig(async r => {
    startOne(r);
    r.clock.now += 40 * MIN; r.tick();
    const piled = r.host.view('gene')!.strength;
    r.lifts.length = 0;
    const line = r.host.chatTurn('gene');
    assert.equal(line, herNeedChatLine('relief'));
    assert.match(line, /先给台阶、先和好/); assert.ok(line.includes(BIG_LINE_WORDS));
    assert.equal(r.lifts.length, 1);
    assert.deepEqual(r.lifts[0].delta, herNeedRelief(piled));
    assert.ok(Math.abs(r.lifts[0].relief! - piled) < 1e-9, 'the label 释然 is asked for, as much as had piled up');
    assert.equal(r.host.view('gene'), null, '低落 ended');
    assert.equal(r.host.chatTurn('gene'), '', 'once');
    assert.equal(r.lifts.length, 1);
    // A touch does it too, and a user who was not away from her at all gets nothing of it.
    await rig(async r2 => {
      r2.host.interact('gene', 'touch', 60_000);
      assert.equal(r2.lifts.length, 0, 'nothing piled up, no relief');
    });
  });
  await rig(async r => {
    startOne(r);
    r.clock.now += 40 * MIN; r.tick();
    r.lifts.length = 0;
    r.host.interact('gene', 'touch', 500);
    assert.equal(r.lifts.length, 1); assert.ok(r.lifts[0].relief! > 0);
    assert.equal(r.host.view('gene'), null);
  });
});

test('host: a kind she was left unanswered about can show again later and the user can soothe it as usual: no old account is settled', async () => {
  await rig(async r => {
    startOne(r); // lonely, left unanswered
    r.clock.now += 40 * MIN; r.tick();
    r.host.interact('gene', 'chat', 1); // the user comes (relief, armed again)
    r.lifts.length = 0;
    // Hours later a different draw lets lonely show once more (a strong enough want, or just luck): it is soothed like any other.
    r.clock.now += 8 * HOUR; r.tick({ boredom: 100 }); r.ticks(60, { boredom: 100 });
    const view = r.host.view('gene');
    assert.ok(view && view.mode === 'need', 'a need shows again');
    r.host.interact('gene', 'touch', HER_NEED_TABLE[view.id].soothe.touchMs);
    assert.equal(r.host.view('gene')?.mode, 'glow');
    assert.equal(r.lifts.length, 1, 'only the comfort');
    assert.deepEqual(r.lifts[0].delta, HER_NEED_TABLE[view.id].comfort);
    // Nothing she is given to say mentions having been left.
    assert.doesNotMatch(r.host.chatTurn('gene'), /之前没|刚才没|没理|晾|上次/);
  });
});

test('host: a bad dream follows a real sleep and only that; a nap or the middle of the night without waking does nothing', async () => {
  await rig(async r => {
    r.clock.now += 20 * MIN;
    r.ticks(3 * 3600, { fatigue: 'asleep', localMinute: 3 * 60 });
    assert.equal(r.host.view('gene'), null);
    r.ticks(5, { fatigue: 'awake', localMinute: 3 * 60 });
    assert.equal(r.host.view('gene')?.id, 'dream', 'she woke at three in the morning with a bad dream: a look only');
    assert.equal(r.host.speechChance('gene'), herNeedSpeechLine('dream'), 'her one chance exists, but the inner loop gives none at night (below)');
  });
  await rig(async r => {
    r.clock.now += 20 * MIN;
    r.ticks(5 * 60, { fatigue: 'asleep', localMinute: 14 * 60 });
    r.ticks(5, { fatigue: 'awake', localMinute: 14 * 60 });
    assert.equal(r.host.view('gene'), null, 'five minutes is a doze');
  }, { trigger: undefined });
});

test('host: developer log only in developer mode, and only names, kinds and times', async () => {
  await rig(async r => {
    startOne(r);
    r.host.interact('gene', 'touch', 60_000);
    assert.equal(r.appended.length, 0);
    assert.deepEqual(r.host.recent(), []);
  });
  await rig(async r => {
    r.developer.on = true;
    startOne(r);
    r.host.interact('gene', 'chat', 5);
    assert.equal(r.appended.length, 2);
    const entries = r.appended.map(line => JSON.parse(line));
    assert.deepEqual(entries.map(entry => `${entry.type}:${entry.id}`), ['started:lonely', 'soothed:lonely']);
    for (const entry of entries) assert.deepEqual(Object.keys(entry).filter(key => !['at', 'type', 'id', 'via', 'snubbed'].includes(key)), []);
    assert.equal(r.host.recent().length, 2);
  });
  await rig(async r => {
    r.developer.on = true;
    startOne(r);
    r.clock.now += 40 * MIN; r.tick();
    const faded = r.appended.map(line => JSON.parse(line)).find(entry => entry.type === 'faded');
    assert.deepEqual(faded && Object.keys(faded).sort(), ['at', 'id', 'snubbed', 'type'], 'an unanswered one is marked, with no text and no numbers about her feelings');
  });
});

test('host: the replaceable trigger decides (T-106); a throwing view or lift never breaks a touch', async () => {
  await rig(async r => {
    startOne(r);
    assert.equal(r.host.view('gene')?.id, 'chatty');
    r.host.interact('gene', 'touch', 60_000);
    assert.equal(r.lifts.length, 1);
  }, { trigger: () => ({ chatty: 1 }) });
  await rig(async r => {
    startOne(r);
    assert.doesNotThrow(() => r.host.interact('gene', 'touch', 60_000));
    assert.equal(r.host.view('gene')?.mode, 'glow', 'the glow shows even when the mood could not be lifted');
  }, { lift: () => { throw new Error('mood gone'); } });
});

// ---------------------------------------------------------------- the mood side

test('applyMoodLift: lifts the channels by the amount with the same saturation, as a positive event; no reply, no interaction, no boredom relief', () => {
  const p = DEFAULT_MOOD_PARAMETERS;
  const start = createMoodState(1_000_000, p);
  start.boredom = 70; start.lastInteractionAt = 500_000;
  const lifted = applyMoodLift(start, { id: 'lift-1', delta: { D: 12, O: 12, E: 8 }, reason: '被用户哄好了' }, 1_000_000, p);
  const expectedD = 100 - 50 * Math.exp(-12 / 50);
  assert.ok(Math.abs(lifted.values.D - expectedD) < 1e-9, `${lifted.values.D}`);
  assert.ok(lifted.values.O > 56 && lifted.values.E > 57 && lifted.values.N === 50 && lifted.values.C === 50);
  assert.equal(lifted.boredom, 70); assert.equal(lifted.lastInteractionAt, 500_000);
  assert.equal(lifted.cue, null); assert.equal(lifted.reunion, null); assert.equal(lifted.blushCue, null); assert.equal(lifted.phase, 'idle');
  assert.deepEqual(Object.keys(lifted.freshness), []);
  assert.equal(lifted.reason?.text, '被用户哄好了'); assert.equal(lifted.reason?.context, 'positive');
  const snapshot = getMoodSnapshot(lifted, 1_000_000, p);
  assert.equal(snapshot.context, 'positive');
  assert.equal(snapshot.primary, 'happy', 'D ≥ 60 and E ≥ 55 in a positive moment: plainly happy');
  assert.equal(snapshot.event?.id, 'lift-1');
  // The same id twice changes nothing; the input state is never touched.
  assert.deepEqual(applyMoodLift(lifted, { id: 'lift-1', delta: { D: 12 }, reason: 'x' }, 1_000_000, p).values, lifted.values);
  assert.equal(start.values.D, 50);
  // Per-channel sensitivity applies, near the ceiling it saturates, and it decays back like everything else.
  const strong = createMoodState(0, { ...p, sensitivity: { ...p.sensitivity, D: 2 } });
  assert.ok(applyMoodLift(strong, { id: 'a', delta: { D: 12 }, reason: 'x' }, 0, { ...p, sensitivity: { ...p.sensitivity, D: 2 } }).values.D > lifted.values.D);
  const high = createMoodState(0, p); high.values.D = 98;
  assert.ok(applyMoodLift(high, { id: 'b', delta: { D: 20 }, reason: 'x' }, 0, p).values.D <= 100);
  const later = applyMoodLift(start, { id: 'c', delta: { D: 12 }, reason: 'x' }, 1_000_000, p);
  const decayed = advanceMood(later, 1_000_000 + 3 * HOUR, { online: true }, p).values.D;
  assert.ok(decayed < 51, `three hours later it is back to normal (${decayed})`);
});

test('applyMoodLift: a small dip is a neutral moment (no face of its own) that recovers; 释然 gives the label "relieved" for the reunion window with no tears and no cue, and never over a real reunion', () => {
  const p = DEFAULT_MOOD_PARAMETERS;
  const start = createMoodState(1_000_000, p);
  const dipped = applyMoodLift(start, { id: 'dip-1', delta: { D: -4, O: -5 }, reason: '一个人待了一会儿，有点低落' }, 1_000_000, p);
  assert.ok(dipped.values.D < 50 && dipped.values.O < 50 && dipped.values.E === 50);
  assert.equal(dipped.reason?.context, 'neutral'); assert.equal(dipped.cue, null); assert.equal(dipped.reunion, null);
  assert.equal(getMoodSnapshot(dipped, 1_000_000, p).context, 'neutral', 'no disappointed face for a small dip');
  const recovered = advanceMood(dipped, 1_000_000 + 3 * HOUR, { online: true }, p);
  assert.ok(recovered.values.D > 49.9 && recovered.values.O > 49 && recovered.values.O < 51, 'it recovers like any other feeling');
  // 释然.
  const sad = applyMoodLift(start, { id: 'dip-2', delta: { D: -6, O: -7 }, reason: 'x' }, 1_000_000, p);
  const relieved = applyMoodLift(sad, { id: 'relief-1', delta: herNeedRelief(0.8), reason: '用户来了，松了口气', relief: 0.8 }, 1_000_000 + MIN, p);
  assert.ok(relieved.values.D > sad.values.D + 5 && relieved.values.O > sad.values.O + 5, 'the lift is bigger than the dip');
  assert.equal(relieved.cue, null); assert.equal(relieved.reunion?.crying, false);
  assert.ok(relieved.reunion && relieved.reunion.longing < p.longing.sadAt, 'no wistful face');
  const snapshot = getMoodSnapshot(relieved, 1_000_000 + MIN, p);
  assert.equal(snapshot.primary, 'relieved');
  assert.equal(snapshot.cryingCandidate, false);
  assert.equal(getMoodSnapshot(advanceMood(relieved, 1_000_000 + MIN + p.interaction.reunionMs + 1, { online: true }, p), 1_000_000 + 2 * MIN, p).reunion, null, 'the label lasts the reunion window only');
  // A bigger pile-up, a bigger relief.
  const small = applyMoodLift(sad, { id: 'relief-2', delta: herNeedRelief(0.1), reason: 'x', relief: 0.1 }, 1_000_000 + MIN, p);
  assert.ok(relieved.values.D > small.values.D);
  // Never over a real reunion (a long absence: the reply itself makes that one) and never over one that is there.
  const longAway = { ...createMoodState(1_000_000, p), lastInteractionAt: 1_000_000 - 70 * HOUR, longing: 90 };
  assert.equal(applyMoodLift(longAway, { id: 'r', delta: { D: 4 }, reason: 'x', relief: 1 }, 1_000_000, p).reunion, null);
  const there = { ...start, reunion: { id: 'real', at: 1_000_000, longing: 80, crying: true } };
  assert.equal(applyMoodLift(there, { id: 'r2', delta: { D: 4 }, reason: 'x', relief: 1 }, 1_000_000, p).reunion?.id, 'real');
});

test('applyMoodLift: refuses anything but a bounded, named shift', () => {
  const state = createMoodState(0);
  for (const bad of [
    { id: '', delta: { D: 1 }, reason: 'x' }, { id: 'x'.repeat(161), delta: { D: 1 }, reason: 'x' }, { id: 'a', delta: { X: 1 }, reason: 'x' },
    { id: 'a', delta: { D: -21 }, reason: 'x' }, { id: 'a', delta: { D: 21 }, reason: 'x' }, { id: 'a', delta: { D: NaN }, reason: 'x' },
    { id: 'a', delta: [] , reason: 'x' }, { id: 'a', delta: { D: 1 }, reason: 'x'.repeat(201) }, { id: 'a', delta: { D: 1 }, reason: 'x', relief: 2 },
    { id: 'a', delta: { D: 1 }, reason: 'x', relief: -0.1 }, null,
  ]) assert.throws(() => applyMoodLift(state, bad as never, 0), /Invalid mood lift|within ±20/, JSON.stringify(bad));
  assert.doesNotThrow(() => applyMoodLift(state, { id: 'ok', delta: { D: -20, O: 20 }, reason: 'x', relief: 0 }, 0));
});

async function withMood(run: (mood: MoodHost, clock: { now: number }) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-her-needs-mood-'));
  const clock = { now: 1_000_000 };
  const mood = new MoodHost(directory, () => {}, () => clock.now);
  try { await mood.load(); mood.activate('gene'); await run(mood, clock); }
  finally { await mood.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}

test('MoodHost: lift is published and saved but is not a reply, and does nothing while 自动表现 is off; what a touch and a snack are worth is reported', async () => {
  await withMood(async (mood, clock) => {
    const seen: [string, string, number][] = [];
    mood.setInteractionObserver((id, kind, amount) => seen.push([id, kind, amount]));
    const input = (value: Omit<MoodInput, 'token'> | Record<string, unknown>) => mood.interaction({ token: mood.get().token, ...value } as MoodInput);
    input({ type: 'phase', sessionId: 'touch', phase: 'rua' });
    clock.now += 300;
    input({ type: 'rua', sessionId: 'touch', id: 'first', activeMs: 300 });
    assert.deepEqual(seen, [['gene', 'touch', 300]]);
    input({ type: 'phase', sessionId: 'cheek', phase: 'cheek' });
    clock.now += 400;
    input({ type: 'cheek', sessionId: 'cheek', id: 'c1', activeMs: 300 });
    assert.deepEqual(seen[1], ['gene', 'touch', 300], 'a cheek release is a touch');
    input({ type: 'phase', sessionId: 'meal', phase: 'food-wait' });
    clock.now += 600;
    input({ type: 'phase', sessionId: 'meal', phase: 'food-ready' });
    input({ type: 'food', sessionId: 'meal', id: 'release' });
    assert.deepEqual(seen[2], ['gene', 'food', 1]);
    assert.equal(seen.length, 3);

    const before = mood.get();
    clock.now += 60_000;
    mood.lift({ id: 'soothed-1', delta: { D: 12, O: 12, E: 8 }, reason: '被用户哄好了' });
    const after = mood.get();
    assert.ok(after.snapshot.values.D > before.snapshot.values.D && after.snapshot.values.O > before.snapshot.values.O);
    assert.equal(after.snapshot.lastInteractionAt, before.snapshot.lastInteractionAt, 'a lift is not an interaction');
    assert.equal(after.snapshot.reason, '被用户哄好了');
    mood.setExpressions(false);
    const off = mood.get().snapshot.values.D;
    mood.lift({ id: 'soothed-2', delta: { D: 12 }, reason: 'x' });
    assert.equal(mood.get().snapshot.values.D, off, '自动表现 off: no lift');
    mood.lift({ id: 'soothed-3', delta: { D: 12 }, reason: 'x' }, 'nobody');
  });
});

test('MoodHost: herNeed rides the view only while 自动表现 is on', async () => {
  await withMood(async mood => {
    mood.setHerNeedSource(() => ({ id: 'lonely', mode: 'need', since: 1_000_000, strength: 0.8, usedToday: 1 }));
    assert.equal(mood.get().herNeed?.id, 'lonely');
    mood.setExpressions(false);
    assert.equal(mood.get().herNeed, undefined);
    mood.setExpressions(true);
    mood.setHerNeedSource(() => { throw new Error('gone'); });
    assert.equal(mood.get().herNeed, undefined, 'a failing source never breaks the view');
  });
});

test('welcome back: after three days the first reply is written under "很想、见到很开心", with nothing that invites reproach; it ends with the reunion', async () => {
  await withMood(async (mood, clock) => {
    mood.event({ type: 'chat', id: 'last-chat', reason: '收到用户聊天' });
    clock.now += 4 * HOUR; mood.get();
    const ordinary = mood.chatContext();
    assert.match(ordinary, /主感受/); assert.doesNotMatch(ordinary, /用户隔了一阵子/);
    assert.match(ordinary, /关切或失落时不因先前舒适而强行欢快/, 'an ordinary context is exactly what it was');
    clock.now += 68 * HOUR; mood.get();
    assert.equal(mood.get().snapshot.primary, 'sad', 'the label before this change would have said 伤感 here');
    const away = mood.chatContext();
    assert.ok(away.includes(WELCOME_BACK_LINE));
    assert.doesNotMatch(away, /伤感|主感受想念|强行欢快/);
    assert.doesNotMatch(away.replace(WELCOME_BACK_LINE.replace(BIG_LINE_PHRASES, ''), '').replace(BIG_LINE_PHRASES, ''), LEVER);
    assert.doesNotMatch(away, /失落|委屈|孤单|寂寞|冷落/);
    assert.match(away, /小小地嘀咕一句/); assert.match(away, /先给台阶、先和好/);
    // The user replies: for the 12 seconds of the reunion she is glad (not "释然 + 想念余韵" and nothing else).
    mood.event({ type: 'chat', id: 'back', reason: '收到用户聊天' });
    assert.ok(mood.get().snapshot.reunion, 'the reunion exists now');
    assert.ok(mood.chatContext().includes(WELCOME_BACK_LINE));
    clock.now += 13_000; mood.get();
    const settled = mood.chatContext();
    assert.doesNotMatch(settled, /用户隔了一阵子/); assert.match(settled, /主感受/);
  });
});

test('welcome back: a day and a half away is not yet "missing the user"; the line starts at the card\'s own longing threshold', async () => {
  await withMood(async (mood, clock) => {
    mood.event({ type: 'chat', id: 'last-chat', reason: '收到用户聊天' });
    clock.now += 20 * HOUR; mood.get();
    assert.doesNotMatch(mood.chatContext(), /用户隔了一阵子/);
    clock.now += 14 * HOUR; mood.get();
    assert.ok(mood.get().snapshot.longing >= DEFAULT_MOOD_PARAMETERS.longing.longingAt);
    assert.ok(mood.chatContext().includes(WELCOME_BACK_LINE));
  });
});

// ---------------------------------------------------------------- the inner loop

const awake: InnerLoopQuiet = { asleep: false, drowsy: false, night: false, quiet: false };
function promptInput(over: Partial<Parameters<typeof buildInnerLoopPrompt>[0]> = {}): Parameters<typeof buildInnerLoopPrompt>[0] {
  return { persona: '你是 Gene，温和、自然。', mood: '当前角色内在状态：平静。', weights: DEFAULT_MOOD_PARAMETERS.weights, intensity: DEFAULT_MOOD_PARAMETERS.intensity,
    localMinute: 15 * 60, minutesSinceInteraction: 61, cue: 'speech', allowSpeech: true, quiet: awake, ...over };
}

test('inner loop prompt: the small feeling appears only on a speech chance that may speak and is not quiet', () => {
  const line = herNeedSpeechLine('lonely');
  const withNeed = buildInnerLoopPrompt(promptInput({ need: line }));
  assert.ok(withNeed.includes(line));
  assert.match(withNeed, /很短、很可爱/); assert.match(withNeed, /小小地撒个娇、别扭一下/); assert.ok(withNeed.includes(BIG_LINE_WORDS));
  assert.equal(buildInnerLoopPrompt(promptInput()), buildInnerLoopPrompt(promptInput({ need: '' })), 'byte for byte the old prompt without one');
  for (const [name, over] of Object.entries({
    'a motion chance': { cue: 'motion' as const, allowSpeech: false }, 'speech not allowed': { allowSpeech: false },
    'night': { quiet: { ...awake, night: true, quiet: true } }, 'drowsy': { quiet: { ...awake, drowsy: true, quiet: true } },
    'the rest reminder': { quiet: { ...awake, night: true, quiet: true, restReminder: true } },
  })) assert.ok(!buildInnerLoopPrompt(promptInput({ need: line, ...over })).includes(line), `no small feeling: ${name}`);
});

test('inner loop sources: the speech chance is read (and used up) only when it can be used', () => {
  let reads = 0;
  const sources: InnerLoopContextSources = { now: () => 1_000_000, persona: () => '你是 Gene。', language: () => '', mood: () => '当前角色内在状态：平静。', parameters: () => DEFAULT_MOOD_PARAMETERS,
    lastInteractionAt: () => null, profileEnabled: () => false, profilePoints: () => '', audioReading: () => false, ambientText: () => '',
    need: () => { reads++; return herNeedSpeechLine('chatty'); } };
  const claim = { id: 'c1', kind: 'speech' as const, at: 1_000_000, characterId: 'gene' };
  assert.ok(innerLoopPrompt(sources, claim, true, awake).includes(herNeedSpeechLine('chatty')));
  assert.equal(reads, 1);
  innerLoopPrompt(sources, { ...claim, kind: 'motion' }, false, awake);
  innerLoopPrompt(sources, claim, false, awake);
  innerLoopPrompt(sources, claim, true, { ...awake, night: true, quiet: true });
  innerLoopPrompt(sources, claim, true, { ...awake, night: true, quiet: true, restReminder: true });
  assert.equal(reads, 1, 'a chance that cannot speak does not use it up');
  assert.doesNotThrow(() => innerLoopPrompt({ ...sources, need: () => { throw new Error('x'); } }, claim, true, awake));
});

// ---------------------------------------------------------------- through CompanionService

const provider = { kind: 'claude' as const, baseUrl: 'https://her-needs.invalid/v1', model: 'fixture' };
async function withService(run: (service: CompanionService, clock: { now: number }) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-her-needs-service-'));
  const clock = { now: Date.now() };
  const service = new CompanionService(directory, () => {}, { herNeeds: { clock: () => clock.now, random: () => 0, trigger: () => ({ lonely: 1 }) } });
  try { await service.load(); await service.context('gene', provider, 'Gene'); await run(service, clock); }
  finally { await service.flush().catch(() => {}); await service.herNeeds.flush().catch(() => {}); service.herNeeds.dispose(); await rm(directory, { recursive: true, force: true }); }
}
async function chat(service: CompanionService, id: string, text: string) {
  const turn = await service.begin(id, text, 'Gene', () => {});
  const marker = turn.persona.match(/<sh-state-[a-f0-9]+>/)![0];
  turn.push('delta', `好的。\n${marker}${JSON.stringify({ context: 'neutral', delta: {}, confidence: 0.9, reason: '测试' })}${marker.replace('<', '</')}`);
  await turn.finish('complete');
  return turn;
}
/** The host's tick, driven the way main.ts drives it (one a second), until the need begins. */
function startNeed(service: CompanionService, clock: { now: number }): void {
  clock.now += 20 * MIN;
  for (let i = 0; i < 5; i++) { clock.now += SECOND; service.herLifeTick(true, clock.now); }
  assert.equal(service.mood.get().herNeed?.id, 'lonely', 'the need is in the mood view the stage reads');
}

test('service: a pat soothes her through the real interaction path: the glow shows, the mood rises, and the next message knows why', async () => {
  await withService(async (service, clock) => {
    startNeed(service, clock);
    const before = service.mood.get().snapshot.values;
    const input = (value: Record<string, unknown>) => service.mood.interaction({ token: service.mood.get().token, ...value } as MoodInput);
    // A little patting first (the real path budgets patting by the real clock): she perks up a little, not yet soothed.
    input({ type: 'phase', sessionId: 'pat', phase: 'rua' });
    await new Promise(resolve => setTimeout(resolve, 330));
    input({ type: 'rua', sessionId: 'pat', id: 'pat-1', activeMs: 300 });
    assert.equal(service.mood.get().herNeed?.mode, 'need');
    assert.ok(service.mood.get().herNeed!.strength < 1, 'the pat counted');
    // Then two snacks, the way the feeding gesture reports them.
    for (const meal of ['meal-1', 'meal-2']) {
      input({ type: 'phase', sessionId: meal, phase: 'food-wait' });
      await new Promise(resolve => setTimeout(resolve, 520));
      input({ type: 'phase', sessionId: meal, phase: 'food-ready' });
      input({ type: 'food', sessionId: meal, id: `release-${meal}` });
    }
    const view = service.mood.get();
    assert.equal(view.herNeed?.mode, 'glow');
    assert.ok(view.snapshot.values.D > before.D + 8, 'more than a pat alone would give');
    const turn = await chat(service, 'after-pat', '早呀');
    assert.ok(turn.persona.includes(herNeedChatLine('soothed', 'lonely')));
    const next = await chat(service, 'after-pat-2', '在吗');
    assert.ok(!next.persona.includes('被用户哄好了'), 'told once');
  });
});

test('service: two messages soothe her; the first one is told she is a little off, the second that she is happy; and a quiet chat costs nothing', async () => {
  await withService(async (service, clock) => {
    const quiet = await chat(service, 'quiet', '你好');
    assert.ok(!quiet.persona.includes('小情绪') && !quiet.persona.includes('哄好'), 'no need, nothing added to the turn');
    startNeed(service, clock);
    const first = await chat(service, 'one', '我在呢');
    assert.ok(first.persona.includes(herNeedChatLine('need', 'lonely')));
    assert.equal(service.mood.get().herNeed?.mode, 'need');
    const second = await chat(service, 'two', '来摸摸');
    assert.ok(second.persona.includes(herNeedChatLine('soothed', 'lonely')));
    assert.equal(service.mood.get().herNeed?.mode, 'glow');
    const lastInteraction = service.mood.get().snapshot.lastInteractionAt;
    assert.ok(lastInteraction !== null);
    const told = herNeedChatLine('need', 'lonely');
    assert.doesNotMatch(told.replace(BIG_LINE_PHRASES, ''), LEVER);
    assert.ok(first.persona.includes(told) && first.persona.indexOf(told) > first.persona.indexOf('当前角色内在状态'), 'after the mood: this reply is written under the lifted mood');
  });
});

test('service: nobody answers, then the user comes: the mood dipped a little and she looks low; the reply is written under 释然 (glad, small 撒娇 allowed, she makes up first) and nothing else is carried', async () => {
  await withService(async (service, clock) => {
    startNeed(service, clock);
    const before = service.mood.get().snapshot.values;
    clock.now += 40 * MIN; service.herLifeTick(true, clock.now);
    const low = service.mood.get();
    assert.equal(low.herNeed?.mode, 'low');
    assert.ok(low.snapshot.values.D < before.D && low.snapshot.values.O < before.O, 'the mood went down a little');
    assert.ok(low.snapshot.values.D > before.D - 8, 'only a little');
    assert.equal(low.snapshot.reason, '一个人待了一会儿，有点低落');
    const turn = await chat(service, 'back', '我来了');
    assert.ok(turn.persona.includes(herNeedChatLine('relief')), 'the relief line, once');
    assert.ok(turn.persona.includes(WELCOME_BACK_LINE), 'and the reply is written under "glad to see you"');
    assert.doesNotMatch(turn.persona.slice(turn.persona.indexOf('当前角色内在状态'), turn.persona.indexOf(herNeedChatLine('relief'))), /伤感|失落|低落|没人理/);
    const after = service.mood.get();
    assert.equal(after.herNeed, undefined, '低落 ended with the first message');
    assert.equal(after.snapshot.primary, 'relieved');
    assert.ok(after.snapshot.values.D > low.snapshot.values.D, 'lifted by as much as had piled up');
    const next = await chat(service, 'later', '在吗');
    assert.ok(!next.persona.includes(herNeedChatLine('relief')), 'told once');
  });
});

test('service: 自动表现 off means no need, no line, no lift', async () => {
  await withService(async (service, clock) => {
    service.mood.setExpressions(false);
    clock.now += 20 * MIN;
    for (let i = 0; i < 5; i++) { clock.now += SECOND; service.herLifeTick(true, clock.now); }
    assert.equal(service.mood.get().herNeed, undefined);
    const turn = await chat(service, 'off', '你好');
    assert.ok(!turn.persona.includes('小情绪'));
  });
});
