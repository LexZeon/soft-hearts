import test from 'node:test';
import assert from 'node:assert/strict';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { createInnerLoopHost, type InnerLoopHostOptions } from '../electron/inner-loop/host';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot } from '../shared/mood';
import type { FatiguePhase } from '../shared/fatigue';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserProfileStore, type UserProfileScope } from '../electron/user-profile';
import { localDayRange, shiftDate } from '../electron/diary/diary-dates';
import { ChatAvailability } from '../electron/chat-availability';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function wired(overrides: Partial<InnerLoopHostOptions> = {}) {
  const state = { now: 1_000_000, setting: true, expressions: true, canExpress: true, current: true, developer: false,
    phase: 'awake' as FatiguePhase, localMinute: 15 * 60, profile: false, audio: false };
  const gate = new ProactiveSpeechGate(() => state.now); gate.setScope('g');
  const reads: string[] = [], prompts: string[] = [], writes: string[] = [];
  const host = createInnerLoopHost({
    gate, clock: () => state.now,
    setting: () => state.setting, expressions: () => state.expressions, canExpress: () => state.canExpress, current: () => state.current,
    characterId: () => 'gene', gateScope: () => 'g', parameters: () => DEFAULT_MOOD_PARAMETERS,
    fatiguePhase: () => state.phase,
    context: { localMinute: () => state.localMinute, persona: () => '你是 Gene。', language: () => '', mood: () => '平静。', lastInteractionAt: () => null,
      profileEnabled: () => state.profile, profilePoints: () => { reads.push('profile'); return '画像'; },
      audioReading: () => state.audio, ambientText: () => { reads.push('ambient'); return '转写'; } },
    // These tests are about the prompts and the rest reminder, not the rhythm (tests/inner-rhythm.test.ts): the smallest draw, so spacing is fixed.
    random: () => 0,
    decide: async prompt => { prompts.push(prompt); return { text: '{"action":"none"}', usage: { inputTokens: 3000, outputTokens: 9, costUsd: 0.0005 } }; },
    realize: () => {}, releaseSpeech: () => {}, offer: () => {}, cancelOffer: () => {}, surface: () => null, presentationIdentity: () => 'id',
    archive: async () => {}, developerMode: () => state.developer, diagnosticsFile: () => null, diagnosticsChanged: () => {},
    ...overrides,
  });
  void writes;
  const cue = (id: string, kind: 'motion' | 'speech' = 'speech') => ({ id, kind, at: state.now, until: state.now + 3_000 });
  return { host, gate, state, reads, prompts, cue, dispose: () => { host.loop.dispose(); gate.dispose(); } };
}

test('the app switch and "pause automatic expressions" both stop it before any model call', async () => {
  const off = wired(); off.state.setting = false;
  assert.equal(off.host.loop.offerOpportunity(off.cue('a')), false);
  const paused = wired(); paused.state.expressions = false;
  assert.equal(paused.host.loop.offerOpportunity(paused.cue('b')), false);
  const busy = wired(); busy.state.canExpress = false;
  assert.equal(busy.host.loop.offerOpportunity(busy.cue('c')), false);
  await flush();
  assert.deepEqual([...off.prompts, ...paused.prompts, ...busy.prompts], []);
  for (const h of [off, paused, busy]) h.dispose();
  // Turning the switch off while deciding cancels on the next tick sweep.
  const h = wired({ decide: () => new Promise(() => {}) });
  assert.equal(h.host.loop.offerOpportunity(h.cue('d')), true); await flush();
  h.state.setting = false; h.host.loop.sweep();
  assert.equal(h.host.loop.busy, false); assert.equal(h.gate.busy, false); h.dispose();
});

test('the wired prompt follows the fatigue view and the night window; optional sources stay unread while off', async () => {
  const h = wired();
  h.host.loop.offerOpportunity(h.cue('day')); await flush();
  assert.match(h.prompts[0], /这次可以说话/); assert.deepEqual(h.reads, []);
  h.state.localMinute = 23 * 60 + 30; h.state.now += 3_600_000;
  h.host.loop.offerOpportunity(h.cue('night')); await flush();
  assert.match(h.prompts[1], /这次不能说话（现在是你该安静的深夜时段。）/);
  h.state.localMinute = 15 * 60; h.state.phase = 'drowsy'; h.state.now += 3_600_000;
  h.host.loop.offerOpportunity(h.cue('drowsy')); await flush();
  assert.match(h.prompts[2], /你现在很困/);
  h.state.phase = 'awake'; h.state.profile = true; h.state.audio = true; h.state.now += 3_600_000;
  h.host.loop.offerOpportunity(h.cue('sources')); await flush();
  assert.deepEqual(h.reads.sort(), ['ambient', 'profile']); h.dispose();
});

test('the developer view lists the last decisions only in developer mode', async () => {
  const h = wired();
  h.host.loop.offerOpportunity(h.cue('one')); await flush();
  h.host.opening.claim(h.cue('one-b'), {}, { characterId: 'gene', snapshot: getMoodSnapshot(createMoodState(h.state.now), h.state.now), parameters: DEFAULT_MOOD_PARAMETERS });
  await flush();
  assert.deepEqual(h.host.view(), { enabled: true, developerMode: false, recent: [], opening: [] }, 'no "why" line outside developer mode either');
  h.state.developer = true; h.state.now += 3_600_000;
  h.host.loop.offerOpportunity(h.cue('two')); await flush();
  const view = h.host.view();
  assert.equal(view.recent.length, 1);
  assert.deepEqual({ ...view.recent[0], ms: 0 }, { at: h.state.now, cue: 'speech', called: true, decision: 'none', result: 'ok', quiet: false,
    ms: 0, inputTokens: 3000, outputTokens: 9, costUsd: 0.0005 });
  assert.deepEqual(view.opening, [], 'the earlier pick was not kept for later');
  h.host.opening.claim(h.cue('three'), {}, { characterId: 'gene', snapshot: getMoodSnapshot(createMoodState(h.state.now), h.state.now), parameters: DEFAULT_MOOD_PARAMETERS });
  assert.equal(h.host.view().opening?.length, 1, 'in developer mode the pick is shown (memory only)');
  h.state.setting = false;
  assert.equal(h.host.view().enabled, false); h.dispose();
});

test('the diary (L3) enters the decision only while the user profile records: real profile store', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-inner-loop-diary-'));
  const TODAY = '2026-11-02', at = (day: string, hour: number) => localDayRange(day).start + hour * 3_600_000;
  const scope: UserProfileScope = { characterId: 'gene', providerScope: 'provider-a' };
  const store = new UserProfileStore(path.join(directory, 'user-profiles'), { now: () => at(TODAY, 9) });
  try {
    await store.activate(scope); store.setEnabled(true);
    assert.equal(await store.saveDiary(store.diaryTicket()!, shiftDate(TODAY, -1), '他说周末想去海边，我也想去。'), true);
    const h = wired({ context: { localMinute: () => 15 * 60, persona: () => '你是 Gene。', language: () => '', mood: () => '平静。',
      lastInteractionAt: () => null, profileEnabled: () => store.view().enabled, profilePoints: () => '',
      diaryPoints: () => store.recentDiaryPoints(scope, at(TODAY, 15), 300), audioReading: () => false, ambientText: () => '' } });
    h.host.loop.offerOpportunity(h.cue('on')); await flush();
    assert.match(h.prompts[0], /<diary-data>[\s\S]*他说周末想去海边/);
    store.setEnabled(false); h.state.now += 3_600_000;
    h.host.loop.offerOpportunity(h.cue('off')); await flush();
    assert.doesNotMatch(h.prompts[1], /diary-data|海边/);
    h.dispose();
  } finally { store.dispose(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('while Claude is unavailable the inner loop does not call the model; it reports each real call', async () => {
  const clock = { now: () => 0 };
  const availability = new ChatAvailability({ now: () => clock.now() });
  let calls = 0, fail = true;
  const h = wired({
    canExpress: () => availability.isAvailable(),
    report: availability,
    decide: async () => { calls++; if (fail) throw new Error('API Error: 429 Too Many Requests'); return { text: '{"action":"none"}' }; },
  });
  clock.now = () => h.state.now;
  assert.equal(h.host.loop.offerOpportunity(h.cue('first')), true); await flush();
  assert.equal(calls, 1); assert.equal(availability.view().state, 'unavailable');
  h.state.now += 10_000;
  assert.equal(h.host.loop.offerOpportunity(h.cue('second')), false, 'unavailable: no model call');
  await flush(); assert.equal(calls, 1);
  h.state.now += 61_000; fail = false;
  assert.equal(h.host.loop.offerOpportunity(h.cue('third')), true, 'after the backoff one call goes through');
  await flush(); assert.equal(calls, 2); assert.equal(availability.view().state, 'ok', 'a working call clears the outage');
  h.dispose();
});

/** Gene: speech interval 30 min → recent = within 30 min. */
async function night(run: (n: ReturnType<typeof wired> & { file: string; interactedAgo(minutes: number | null): void; say(id: string): Promise<boolean> }) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-inner-loop-rest-'));
  const file = path.join(directory, 'inner-loop-state.json');
  let last: number | null = null;
  const offered: string[] = [];
  const surface = { waitForPresentation: async () => true, isPresentationCurrent: () => true };
  const make = () => {
    const n = wired({ restReminderFile: () => file, surface: () => surface,
      offer: message => { offered.push(message.id); },
      decide: async (prompt: string) => { n.prompts.push(prompt); return { text: /这次可以说|只能是很短地、温柔地提醒/.test(prompt) ? '{"action":"speak","text":"不早了，快去睡吧"}' : '{"action":"none"}' }; },
      context: { localMinute: () => n.state.localMinute, persona: () => '你是 Gene。', language: () => '', mood: () => '平静。',
        lastInteractionAt: () => last, profileEnabled: () => false, profilePoints: () => '', audioReading: () => false, ambientText: () => '' } });
    n.state.localMinute = 23 * 60 + 40;
    return n;
  };
  let n = make();
  const api = {
    file,
    interactedAgo: (minutes: number | null) => { last = minutes === null ? null : n.state.now - minutes * 60_000; },
    say: async (id: string) => {
      offered.length = 0;
      n.host.loop.offerOpportunity(n.cue(id)); await flush();
      if (!offered.length) return false;
      return n.host.loop.ack(offered[0]);
    },
    restart: async () => { await n.host.reminders!.flush(); const now = n.state.now; n.dispose(); n = make(); n.state.now = now; await n.host.reminders!.load(); },
  };
  try {
    await n.host.reminders!.load();
    await run(new Proxy(api, { get: (target, key) => key in target ? (target as any)[key] : (n as any)[key] }) as any);
  } finally {
    // The last remembered night is still being written (temp file + rename). On Windows removing the folder under it
    // failed with ENOTEMPTY, which failed the frozen unit run of a development update (R26, 2026-11-03).
    await n.host.reminders?.flush();
    n.dispose(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test('late at night, a recent interaction allows one gentle rest reminder, and only one per night', () => night(async n => {
  n.interactedAgo(12);
  assert.equal(await n.say('night-1'), true, 'awake and busy at 23:40: she may say it');
  assert.match(n.prompts.at(-1)!, /本来该安静，但用户约 12 分钟前还和你互动过/);
  assert.match(n.prompts.at(-1)!, /只能是一句很短的、温柔地提醒用户休息的话.*傲娇的可以嘴硬.*不施压、不说教、不让用户内疚/);
  n.state.now += 31 * 60_000; n.interactedAgo(5);
  assert.equal(await n.say('night-2'), false, 'the second chance the same night stays quiet');
  assert.match(n.prompts.at(-1)!, /这次不能说话/);
  await n.host.reminders!.flush();
  const stored = JSON.parse(await readFile(n.file, 'utf8'));
  assert.equal(stored.version, 1); assert.match(stored.restReminderNight, /^\d{4}-\d{2}-\d{2}$/);
}));

test('no recent interaction at night: she stays quiet', () => night(async n => {
  n.interactedAgo(45);
  assert.equal(await n.say('late'), false);
  assert.match(n.prompts.at(-1)!, /这次不能说话（现在是你该安静的深夜时段。）/);
  n.interactedAgo(null);
  n.state.now += 31 * 60_000;
  assert.equal(await n.say('never'), false);
}));

test('after a restart the same night does not remind again; the next night may', () => night(async n => {
  n.interactedAgo(3);
  assert.equal(await n.say('before-restart'), true);
  await (n as any).restart();
  n.state.now += 40 * 60_000; n.interactedAgo(3);
  assert.equal(await n.say('after-restart'), false, 'remembered across sessions');
  n.state.now += 24 * 3_600_000; n.interactedAgo(3);
  assert.equal(await n.say('next-night'), true, 'a new night');
}));

test('daytime speech is unaffected and does not use up the night reminder; asleep stays silent', () => night(async n => {
  n.state.localMinute = 15 * 60; n.interactedAgo(null);
  assert.equal(await n.say('afternoon'), true, 'ordinary daytime speech');
  assert.doesNotMatch(n.prompts.at(-1)!, /提醒用户休息的话/);
  n.state.localMinute = 23 * 60 + 50; n.state.now += 40 * 60_000; n.interactedAgo(8);
  assert.equal(await n.say('night'), true, 'the night reminder is still available');
  n.state.now += 24 * 3_600_000; n.interactedAgo(2); n.state.phase = 'asleep';
  assert.equal(await n.say('asleep'), false, 'asleep: never speaks');
}));
