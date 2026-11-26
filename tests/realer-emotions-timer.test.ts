// I-112 B: "更真实的情绪" turns itself off after the time the user chose (docs/claude/2026-11-14-i112-realer-emotions-timer.md).
// Every card here is synthetic; the clock is fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore, parseCharacterCardText } from '../electron/cards/character-cards';
import { startRealerExpiryWatcher } from '../electron/mood/realer-expiry';
import { realerEmotionsDialogOptions, realerEmotionsRequest } from '../electron/mood/realer-emotions-host';
import { createAppTools, type AgentAppBridge } from '../electron/safety/agent-channel/app-tools';
import { AgentToolRegistry, type AgentConfirmRequest } from '../electron/safety/agent-channel/registry';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { realerStatus, realerUntil } from '../shared/mood/realer-duration';
import type { CharacterCardState, CharacterDraft } from '../shared/foundation/character-card';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);
const draft = (name: string): CharacterDraft => ({ name, description: '合成测试卡', personality: '嘴硬心软', scenario: '', greeting: '', examples: '', systemPrompt: '' });

async function inDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-i112b-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const clock = (start = T0) => { const state = { now: start }; return { state, read: () => state.now }; };
const find = (cards: CharacterCardStore, id: string) => cards.publicState().cards.find(card => card.id === id)!;
const stored = async (directory: string, id: string) => JSON.parse(await readFile(path.join(directory, 'characters.json'), 'utf8')).cards.find((card: { id: string }) => card.id === id);

async function newCard(cards: CharacterCardStore): Promise<string> {
  await cards.load();
  return (await cards.save(draft('阿棠'))).cards.at(-1)!.id;
}

test('a week: still on on day 6, off after day 7; the card says it ran out', async () => {
  await inDirectory(async directory => {
    const time = clock(), cards = new CharacterCardStore(directory, 'legacy', undefined, undefined, time.read);
    const id = await newCard(cards);
    await cards.setRealerEmotions(id, true, 'week');
    assert.equal(find(cards, id).realerEmotions, true);
    assert.equal(find(cards, id).realerEmotionsUntil, T0 + 7 * DAY);
    time.state.now = T0 + 6 * DAY + 23 * 3600_000;
    assert.deepEqual(await cards.expireRealerEmotions(), []);
    assert.equal(find(cards, id).realerEmotions, true, 'still on on day 6');
    time.state.now = T0 + 7 * DAY + 1;
    assert.deepEqual(await cards.expireRealerEmotions(), [id]);
    const after = find(cards, id);
    assert.equal(after.realerEmotions, undefined);
    assert.equal(after.realerEmotionsUntil, undefined);
    assert.equal(after.realerEmotionsExpired, true);
    assert.deepEqual(realerStatus(after), { kind: 'expired' });
    assert.deepEqual(await cards.expireRealerEmotions(), [], 'a second check changes nothing');
    const record = await stored(directory, id);
    assert.ok(!Object.hasOwn(record, 'realerEmotions') && !Object.hasOwn(record, 'realerEmotionsUntil'));
  });
});

test('day and month lengths; 一直开 never expires', async () => {
  assert.equal(realerUntil('day', T0), T0 + DAY);
  assert.equal(realerUntil('month', T0), T0 + 30 * DAY);
  assert.equal(realerUntil('forever', T0), null);
  await inDirectory(async directory => {
    const time = clock(), cards = new CharacterCardStore(directory, 'legacy', undefined, undefined, time.read);
    const id = await newCard(cards);
    await cards.setRealerEmotions(id, true, 'forever');
    assert.equal(find(cards, id).realerEmotionsUntil, undefined);
    time.state.now = T0 + 5000 * DAY;
    assert.deepEqual(await cards.expireRealerEmotions(), []);
    assert.equal(find(cards, id).realerEmotions, true);
    assert.deepEqual(realerStatus(find(cards, id)), { kind: 'forever' });
    assert.equal(cards.nextRealerExpiry(), null);
  });
});

test('expired while the app was closed: off at the next start, before anything reads the cards', async () => {
  await inDirectory(async directory => {
    const time = clock(), first = new CharacterCardStore(directory, 'legacy', undefined, undefined, time.read);
    const id = await newCard(first);
    await first.setRealerEmotions(id, true, 'day');
    time.state.now = T0 + 3 * DAY;
    const second = new CharacterCardStore(directory, 'legacy', undefined, undefined, time.read);
    const state = await second.load();
    assert.equal(state.cards.find(card => card.id === id)!.realerEmotions, undefined, 'load() already returns it off');
    assert.equal(state.cards.find(card => card.id === id)!.realerEmotionsExpired, true);
    assert.equal(find(second, id).realerEmotions, undefined);
    assert.equal((await stored(directory, id)).realerEmotionsExpired, true);
  });
});

test('cards that already had it on when this shipped (no end time) are 一直开 and are shown so', async () => {
  await inDirectory(async directory => {
    const time = clock(), cards = new CharacterCardStore(directory, 'legacy', undefined, undefined, time.read);
    const id = await newCard(cards);
    const file = path.join(directory, 'characters.json'), raw = JSON.parse(await readFile(file, 'utf8'));
    raw.cards.find((card: { id: string }) => card.id === id).realerEmotions = true;
    await writeFile(file, JSON.stringify(raw));
    time.state.now = T0 + 400 * DAY;
    const reloaded = new CharacterCardStore(directory, 'legacy', undefined, undefined, time.read);
    const state = await reloaded.load();
    assert.equal(state.cards.find(card => card.id === id)!.realerEmotions, true);
    assert.deepEqual(realerStatus(state.cards.find(card => card.id === id)!), { kind: 'forever' });
  });
});

test('the end time stays local: editing, in-place updates and restarts keep it; export has none; an import cannot set it', async () => {
  await inDirectory(async directory => {
    const time = clock(), cards = new CharacterCardStore(directory, 'legacy', undefined, undefined, time.read);
    const id = await newCard(cards);
    await cards.setRealerEmotions(id, true, 'month');
    const until = T0 + 30 * DAY;
    await cards.save({ ...draft('阿棠'), personality: '改过的性格' }, id);
    assert.equal(find(cards, id).realerEmotionsUntil, until, 'the editor\'s save keeps it');
    await cards.updateInPlace(id, { ...draft('阿棠'), personality: '文件里的性格' }, { expected: cards.cardFingerprint(id), backup: async () => {} });
    assert.equal(find(cards, id).realerEmotionsUntil, until, 'an in-place update keeps it');
    const restarted = new CharacterCardStore(directory, 'legacy', undefined, undefined, time.read);
    await restarted.load();
    assert.equal(find(restarted, id).realerEmotionsUntil, until, 'a restart reads it back');
    const exported = cards.export(id);
    assert.ok(!exported.includes('realerEmotionsUntil') && !exported.includes('Expired') && !exported.includes(String(until)), 'export carries no end time');
    assert.equal(parseCharacterCardText(exported).draft.realerEmotions, undefined);
    const injected = JSON.parse(exported);
    injected.card.realerEmotionsUntil = until;
    assert.throws(() => parseCharacterCardText(JSON.stringify(injected)), /未知字段/, 'a file cannot bring an end time');
    const imported = await cards.import(exported);
    const copy = imported.cards.at(-1)!;
    assert.equal(copy.realerEmotions, undefined);
    assert.equal(copy.realerEmotionsUntil, undefined);
  });
});

test('turning it off by hand clears the note; turning it on again starts a new time', async () => {
  await inDirectory(async directory => {
    const time = clock(), cards = new CharacterCardStore(directory, 'legacy', undefined, undefined, time.read);
    const id = await newCard(cards);
    await cards.setRealerEmotions(id, true, 'day');
    time.state.now = T0 + 2 * DAY;
    await cards.expireRealerEmotions();
    assert.equal(find(cards, id).realerEmotionsExpired, true);
    await cards.setRealerEmotions(id, false);
    assert.equal(find(cards, id).realerEmotionsExpired, undefined, 'the note goes away once the user changes it');
    await cards.setRealerEmotions(id, true);
    assert.equal(find(cards, id).realerEmotionsUntil, T0 + 2 * DAY + 7 * DAY, 'default a week');
    await cards.setRealerEmotions(id, false);
    assert.equal(find(cards, id).realerEmotionsUntil, undefined);
    assert.throws(() => cards.setRealerEmotions(id, true, 'year' as never), /开多久/);
  });
});

test('editor text: the end time, 一直开着, expired, and nothing for a card that never had it', () => {
  const at = new Date(2026, 10, 20, 21, 5).getTime();
  assert.deepEqual(realerStatus({ realerEmotions: true, realerEmotionsUntil: at }), { kind: 'until', month: 11, day: 20, hour: '21', minute: '05' });
  assert.deepEqual(realerStatus({ realerEmotions: true }), { kind: 'forever' });
  assert.deepEqual(realerStatus({ realerEmotionsExpired: true }), { kind: 'expired' });
  assert.equal(realerStatus({}), null);
});

test('the running app: the watcher turns it off at the time, re-checks on wake, and a clock jump cannot confuse it', async () => {
  let now = T0, until: number | null = T0 + 100_000, expiredIds: string[] = [];
  const timers: Array<{ run: () => void; ms: number; live: boolean }> = [];
  const watcher = startRealerExpiryWatcher({
    now: () => now, next: () => until,
    expire: async at => { if (until !== null && until <= at) { until = null; return ['c1']; } return []; },
    onExpired: ids => { expiredIds = ids; },
    setTimer: (run, ms) => { const timer = { run, ms, live: true }; timers.push(timer); return timer; },
    clearTimer: handle => { (handle as { live: boolean }).live = false; },
  });
  const fire = async () => { const timer = timers.filter(item => item.live).at(-1)!; timer.live = false; timer.run(); await new Promise(resolve => setImmediate(resolve)); };
  assert.equal(timers.at(-1)!.ms, 30_000, 'polls at most every 30 s');
  now += 30_000; await fire(); assert.deepEqual(expiredIds, []);
  now += 69_000; await fire(); assert.deepEqual(expiredIds, [], 'one second before');
  assert.equal(timers.filter(item => item.live).at(-1)!.ms, 1000, 'wakes up exactly when it is due');
  now += 1000; await fire(); assert.deepEqual(expiredIds, ['c1']);
  // Sleep: the clock jumps over the end time while no timer ran; wake() decides from the wall clock.
  until = now + DAY; expiredIds = [];
  now += 3 * DAY; await watcher.wake();
  assert.deepEqual(expiredIds, ['c1']);
  watcher.stop();
  assert.equal(timers.filter(item => item.live).length, 0);
});

test('the dialog asks how long (default is the safe "先不打开"); each button is its time; 三方互通 uses a week', async () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  assert.deepEqual(realerEmotionsDialogOptions('阿棠').buttons, ['先不打开', '打开一天', '打开一周（推荐）', '打开一个月', '一直开着']);
  const saves: Array<[boolean, string | undefined]> = [];
  let on = false, expired = false, answer: boolean | number = 0, direct = false;
  const state = (): CharacterCardState => ({ activeId: id, cards: [{ ...draft('阿棠'), id, ...(on ? { realerEmotions: true as const } : {}), ...(expired ? { realerEmotionsExpired: true as const } : {}) }] });
  const request = realerEmotionsRequest({ cards: state, confirm: async () => answer, interconnected: () => direct, inform: () => {},
    save: async (_id, value, duration) => { saves.push([value, duration]); on = value; if (!value) expired = false; return state(); } });
  await request(id, true); assert.deepEqual(saves, [], 'declined');
  for (const [pressed, expected] of [[1, 'day'], [2, 'week'], [3, 'month'], [4, 'forever']] as const) {
    on = false; answer = pressed; await request(id, true);
    assert.deepEqual(saves.at(-1), [true, expected]);
  }
  saves.length = 0; on = false; answer = true; await request(id, true);
  assert.deepEqual(saves, [[true, 'week']], 'a plain yes means the default');
  saves.length = 0; on = false; direct = true; await request(id, true);
  assert.deepEqual(saves, [[true, 'week']]);
  // Off after "已到期关闭": the click clears the note even though it is already off.
  saves.length = 0; on = false; expired = true; direct = false;
  assert.equal((await request(id, false)).cards[0].realerEmotionsExpired, undefined);
  assert.deepEqual(saves, [[false, undefined]]);
});

test('the agent channel: duration only with realer_emotions on; default a week; the dialog says which; bad values are refused', async () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const calls: Array<[boolean, string | undefined]> = [];
  const bridge = { settings: () => structuredClone(DEFAULT_SETTINGS), characters: () => ({ activeId: id, cards: [{ ...draft('阿棠'), id }] }),
    setRealerEmotions: async (value: boolean, _guard: unknown, _card: unknown, duration?: string) => { calls.push([value, duration]); } } as unknown as AgentAppBridge;
  const asked: AgentConfirmRequest[] = [];
  const registry = new AgentToolRegistry(createAppTools(bridge).filter(tool => tool.name === 'set_setting'),
    { enabled: () => true, confirm: async request => { asked.push(request); return true; } });
  assert.equal((await registry.call('set_setting', { id: 'realer_emotions', value: true })).ok, true);
  assert.ok(asked[0].detail?.includes('这次会开一周'));
  assert.equal((await registry.call('set_setting', { id: 'realer_emotions', value: true, duration: 'forever' })).ok, true);
  assert.ok(asked[1].detail?.includes('一直开着'));
  assert.equal((await registry.call('set_setting', { id: 'realer_emotions', value: true, duration: 'day' })).ok, true);
  assert.ok(asked[2].detail?.includes('这次会开一天'));
  assert.deepEqual(calls, [[true, undefined], [true, 'forever'], [true, 'day']]);
  assert.equal((await registry.call('set_setting', { id: 'realer_emotions', value: true, duration: 'year' })).ok, false);
  assert.equal((await registry.call('set_setting', { id: 'realer_emotions', value: false, duration: 'day' })).ok, false);
  assert.equal((await registry.call('set_setting', { id: 'slow_warm_up', value: true, duration: 'day' })).ok, false);
  assert.equal(calls.length, 3);
});
