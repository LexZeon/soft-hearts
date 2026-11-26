import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DAY_READ_KEEP_MS, dayRead, dayReadLine, lookSignal, voiceSignal } from '../shared/memory/day-read';
import { DayReadStore } from '../electron/memory/day-read';
import { CompanionService } from '../electron/brain/companion';
import { SelfLookHost } from '../electron/initiative/self-look/host';

// I-089 item 5: synthetic signals only (no real chat, camera, microphone, screen or profile).
const MIN = 60_000;
const T0 = 1_800_000_000_000;
const noon = () => 12;

test('one clear signal gives a read; one stray signal of the wrong kind or no signal gives none', () => {
  const store = new DayReadStore({ clock: () => T0, hour: noon });
  assert.equal(store.current(), null, 'no signals: unclear');
  store.noteTone('neutral'); store.noteTone(null); store.noteLook('present'); store.noteLook('away'); store.noteLook('unclear'); store.noteSaid('calm');
  assert.equal(store.current(), null, 'tags that carry nothing add nothing');
  store.noteTone('crying');
  assert.equal(store.current()?.read, 'low');
  assert.equal(store.current()?.reason, 'voice');
});

test('the read decays within the day: a tired look counts for a while, then is gone', () => {
  const store = new DayReadStore({ hour: noon });
  store.noteLook('tired', T0);
  assert.equal(store.current(T0 + 5 * MIN)?.read, 'tired');
  assert.equal(store.current(T0 + 5 * MIN)?.reason, 'look');
  assert.equal(store.current(T0 + 90 * MIN), null, 'half-lives later it no longer reaches the threshold');
  assert.equal(dayRead([{ read: 'tired', reason: 'look', weight: 50, at: T0 }], T0 + DAY_READ_KEEP_MS), null, 'and nothing older than the keep time counts, however strong');
});

test('two kinds close together are unclear; a clear lead wins; several weak signals add up', () => {
  const store = new DayReadStore({ hour: noon });
  store.noteTone('laughing', T0); store.noteLook('tired', T0);
  assert.equal(store.current(T0), null, 'laughing and looking tired at once: she does not pick');
  store.noteSaid('tired', T0);
  assert.equal(store.current(T0)?.read, 'tired', 'her own judgment tips it');
  const late = new DayReadStore({ hour: () => 2 });
  late.noteMessage(30, T0); late.noteMessage(30, T0 + 10 * MIN);
  assert.equal(late.current(T0 + 10 * MIN), null, 'two small-hours messages are not enough');
  late.noteMessage(30, T0 + 20 * MIN);
  assert.equal(late.current(T0 + 20 * MIN)?.read, 'tired');
  assert.equal(late.current(T0 + 20 * MIN)?.reason, 'late');
  const day = new DayReadStore({ hour: noon });
  for (const at of [0, 10, 20, 30]) day.noteMessage(30, T0 + at * MIN);
  assert.equal(day.current(T0 + 30 * MIN), null, 'the same messages in daytime say nothing');
});

test('message rhythm: a run of short quick messages reads as busy, long or slow ones do not; only lengths and times are taken', () => {
  const quick = new DayReadStore({ hour: noon });
  for (let i = 0; i < 4; i++) quick.noteMessage(4, T0 + i * 20_000);
  assert.equal(quick.current(T0 + 60_000)?.read, 'busy');
  const longer = new DayReadStore({ hour: noon });
  for (let i = 0; i < 4; i++) longer.noteMessage(40, T0 + i * 20_000);
  assert.equal(longer.current(T0 + 60_000), null);
  const slow = new DayReadStore({ hour: noon });
  for (let i = 0; i < 4; i++) slow.noteMessage(4, T0 + i * 3 * MIN);
  assert.equal(slow.current(T0 + 9 * MIN), null);
  assert.equal(quick.current(T0 + 60 * MIN), null, 'a burst of quick messages is gone within the hour');
});

test('the line is fixed words per closed value: no user text, no number, never "检测", and care without guilt or isolation', () => {
  for (const read of ['tired', 'low', 'upbeat', 'busy', 'edgy'] as const) {
    const line = dayReadLine({ read, reason: 'voice', score: 1.234567 });
    assert.ok(line.length > 20);
    assert.ok(!/\d/.test(line), 'no digits');
    assert.match(line, /不要说出这个判断/);
    assert.ok(!/找别人|去睡觉吧|你应该/.test(line));
  }
  assert.equal(dayReadLine(null), '');
  assert.equal(dayReadLine({ read: '<x>' as never, reason: 'voice', score: 1 }), '');
  assert.equal(voiceSignal('__proto__', T0), null);
  assert.equal(lookSignal('constructor', T0), null);
});

test('she hears a new read at once and the same one only now and then; it comes back when the read changes', () => {
  let roll = 0.9;
  const store = new DayReadStore({ hour: noon, random: () => roll, clock: () => T0 });
  store.noteTone('sad');
  assert.match(store.chatContext(), /情绪有点低/);
  assert.equal(store.chatContext(), '', 'the same read, not due');
  roll = 0.1;
  assert.match(store.chatContext(), /情绪有点低/, 'now and then she is told again');
  store.clear();
  assert.equal(store.chatContext(), '');
  store.noteTone('laughing');
  roll = 0.9;
  assert.match(store.chatContext(), /心情不错/);
  assert.match(store.innerLoopContext(), /心情不错/, 'the inner loop gets it every time');
});

test('her own look reports its closed tag to the day read (tired, smiling, away, none) and never the line or the frame', async () => {
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  for (const [answer, expected] of [['他在看屏幕\n标签：tired', 'tired'], ['他在笑\n标签：smiling', 'smiling'], ['座位上没人\n标签：away', 'away'], ['他在看屏幕', null]] as const) {
    const tags: unknown[] = [];
    const pending = new Map<number, () => void>(); let seq = 0;
    const host = new SelfLookHost({
      enabled: () => true, camera: () => 'on', scope: () => 'gene|c1', present: () => true, typing: () => false, idleSeconds: () => null,
      mood: () => ({ values: { D: 50, O: 50, E: 50, N: 50, C: 50 }, baseline: { D: 50, O: 50, E: 50, N: 50, C: 50 }, boredom: 100, longing: 0, fatigue: { F: 0.25, phase: 'awake' } }),
      lastInteractionAt: () => 0, capture: async () => 'data:image/jpeg;base64,SECRETFRAME', ask: async () => answer,
      tag: tag => { tags.push(tag); }, clock: () => 40 * MIN,
      timers: { set: callback => { pending.set(++seq, callback); return seq; }, clear: handle => { pending.delete(handle as number); } },
    });
    host.tick(); await flush();
    assert.deepEqual(tags, [expected], answer);
    assert.ok(!JSON.stringify(tags).includes('SECRETFRAME') && !JSON.stringify(tags).includes('屏幕'));
    const store = new DayReadStore({ hour: noon });
    for (const tag of tags) store.noteLook(tag, T0);
    assert.equal(store.current(T0)?.read ?? null, expected === 'tired' ? 'tired' : expected === 'smiling' ? 'upbeat' : null);
  }
});

test('chat: her turn carries the day line from a tone and a look, not from nothing, and a deleted chat takes it away', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-day-read-'));
  const service = new CompanionService(directory, () => {});
  try {
    await service.load(); await service.context('gene', { kind: 'claude', baseUrl: 'https://day-read.invalid/v1', model: 'fixture' }, 'Gene');
    let n = 0;
    const turnPersona = async () => {
      const turn = await service.begin(`m${++n}`, '嗯', 'Gene', () => {});
      const persona = turn.persona;
      const marker = persona.match(/<sh-state-[a-f0-9]+>/)?.[0];
      assert.ok(marker);
      turn.push('delta', `好的。
${marker}${JSON.stringify({ context: 'support', delta: { O: 1 }, confidence: 0.9, reason: '测试' })}${marker.replace('<', '</')}`);
      await turn.finish('complete');
      return persona;
    };
    assert.ok(!(await turnPersona()).includes('你隐约觉得用户今天'), 'no signal: no line');
    service.dayRead.noteLook('tired');
    assert.match(await turnPersona(), /你隐约觉得用户今天.*累/, 'a tired look reaches her turn as private context');
    service.dayRead.clear();
    assert.ok(!(await turnPersona()).includes('你隐约觉得用户今天'), 'cleared (a deleted chat does that): the line is gone');
  } finally {
    await service.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
