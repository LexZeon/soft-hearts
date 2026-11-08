import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OUTAGE_LINE_KINDS } from '../shared/chat-availability';
import { OutageLineBank, outageCardKey, outageLinesPrompt, parseOutageLines, type OutageLines } from '../electron/outage-lines';

const HOUR = 3_600_000;
function lines(prefix = '她'): OutageLines {
  return Object.fromEntries(OUTAGE_LINE_KINDS.map(kind => [kind, [`${prefix}说甲${kind}`, `${prefix}说乙${kind}`, `${prefix}说丙${kind}`]])) as unknown as OutageLines;
}
const json = (value: unknown) => JSON.stringify(value);

async function workspace(run: (dir: string, file: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soft-outage-lines-'));
  try { await run(dir, path.join(dir, 'outage-lines.json')); }
  finally { assert.equal(path.dirname(dir), os.tmpdir()); await rm(dir, { recursive: true, force: true }); }
}

test('the prompt carries the card, names every situation, and asks for strict JSON only', () => {
  const prompt = outageLinesPrompt('角色名称：小夜\n性格：嘴硬心软');
  assert.match(prompt, /角色名称：小夜/);
  for (const kind of OUTAGE_LINE_KINDS) assert.ok(prompt.includes(`"${kind}"`), kind);
  assert.match(prompt, /只输出一个 JSON 对象/);
  assert.match(prompt, /不要出现任何技术词/);
});

test('valid output parses, with or without a code fence, and keeps three lines per situation', () => {
  const four = { ...lines(), quota: ['甲一', '乙二', '丙三', '丁四'].map(s => s + '呀') };
  const parsed = parseOutageLines('```json\n' + json(four) + '\n```');
  assert.deepEqual(parsed.quota, ['甲一呀', '乙二呀', '丙三呀']);
  assert.deepEqual(Object.keys(parsed).sort(), [...OUTAGE_LINE_KINDS].sort());
  assert.deepEqual(parseOutageLines(json(lines())), lines());
});

test('anything that is not exactly what was asked for is rejected whole', () => {
  const bad: [string, unknown][] = [
    ['an extra key', { ...lines(), extra: ['一二', '三四'] }],
    ['a missing situation', Object.fromEntries(Object.entries(lines()).filter(([k]) => k !== 'network'))],
    ['a single line', { ...lines(), quota: ['只有一句话'] }],
    ['five lines', { ...lines(), quota: ['一一', '二二', '三三', '四四', '五五'] }],
    ['a duplicate pair', { ...lines(), quota: ['一样的话', '一样的话'] }],
    ['a digit', { ...lines(), quota: ['过五分钟 再来', '5分钟后见'] }],
    ['a technical word', { ...lines(), network: ['Claude 好像断了', '网络不通啦'] }],
    ['an API word', { ...lines(), network: ['API 连不上了', '网络不通啦'] }],
    ['a link', { ...lines(), other: ['看 https://example.com', '再试一次'] }],
    ['markup', { ...lines(), other: ['<b>出错了</b>', '再试一次'] }],
    ['a newline', { ...lines(), other: ['第一行\n第二行', '再试一次'] }],
    ['a line that is too long', { ...lines(), other: ['长'.repeat(61), '再试一次'] }],
    ['a line that is too short', { ...lines(), other: ['短', '再试一次'] }],
    ['a non-string', { ...lines(), other: [3, '再试一次'] }],
    ['a list instead of an object', [lines()]],
  ];
  for (const [label, value] of bad) assert.throws(() => parseOutageLines(json(value)), Error, label);
  assert.throws(() => parseOutageLines('not json'));
  assert.throws(() => parseOutageLines('{"quota":'));
  assert.throws(() => parseOutageLines('x'.repeat(13_000)));
});

test('lines are generated once per card, written to the cache file, and read back after a restart', async () => {
  await workspace(async (_dir, file) => {
    let calls = 0, prompt = '';
    const clock = { now: 1_000_000 };
    const bank = new OutageLineBank({ file, now: () => clock.now, generate: async text => { calls++; prompt = text; return json(lines()); } });
    await bank.load();
    assert.equal(bank.lines('persona A'), null);
    assert.equal(bank.pick('persona A', 'quota'), null);
    assert.equal(await bank.ensure('persona A'), 'generated');
    assert.match(prompt, /persona A/);
    assert.deepEqual(bank.lines('persona A'), lines());
    assert.equal(await bank.ensure('persona A'), 'cached');
    assert.equal(calls, 1, 'a cached card costs nothing');
    // The choice rotates with the pick number.
    assert.deepEqual([0, 1, 2, 3, 4].map(n => bank.pick('persona A', 'network', n)), ['她说甲network', '她说乙network', '她说丙network', '她说甲network', '她说乙network']);
    assert.equal(bank.pick('persona A', 'network', -1), '她说乙network');

    const reopened = new OutageLineBank({ file, now: () => clock.now, generate: async () => { throw new Error('must not be called'); } });
    await reopened.load();
    assert.deepEqual(reopened.lines('persona A'), lines());
    assert.equal(await reopened.ensure('persona A'), 'cached');
    // The file holds a hash of the card, never the card text.
    const raw = await readFile(file, 'utf8');
    assert.ok(raw.includes(outageCardKey('persona A')));
    assert.ok(!raw.includes('persona A'));
  });
});

test('lines belong to the card: another card has none, and a changed card gets new ones', async () => {
  await workspace(async (_dir, file) => {
    const clock = { now: 1_000_000 };
    const seen: string[] = [];
    const bank = new OutageLineBank({ file, now: () => clock.now, limits: { minGapMs: 0 },
      generate: async text => { seen.push(text); return json(lines(seen.length === 1 ? '甲' : '乙')); } });
    await bank.load();
    await bank.ensure('card one');
    assert.equal(bank.lines('card two'), null, 'another card does not inherit them');
    assert.equal(bank.pick('card one', 'quota', 0), '甲说甲quota');
    clock.now += 1000;
    assert.equal(await bank.ensure('card one, edited'), 'generated');
    assert.equal(bank.pick('card one, edited', 'quota', 0), '乙说甲quota');
    assert.equal(bank.pick('card one', 'quota', 0), '甲说甲quota', 'the old card keeps its own');
    assert.notEqual(outageCardKey('card one'), outageCardKey('card one, edited'));
    assert.equal(seen.length, 2);
  });
});

test('generation is rate limited: a gap between attempts, a per-card pause after a miss, and a daily cap', async () => {
  await workspace(async (_dir, file) => {
    const clock = { now: 1_000_000 };
    let calls = 0, answer = 'garbage';
    const bank = new OutageLineBank({ file, now: () => clock.now, limits: { minGapMs: 10 * 60_000, retryCardMs: 6 * HOUR, maxPerDay: 3 },
      generate: async () => { calls++; return answer; } });
    await bank.load();
    assert.equal(await bank.ensure('card A'), 'invalid');
    assert.equal(calls, 1);
    assert.equal(await bank.ensure('card A'), 'limited', 'right after an attempt');
    clock.now += 11 * 60_000;
    assert.equal(await bank.ensure('card A'), 'limited', 'the same card waits hours after a miss');
    assert.equal(await bank.ensure('card B'), 'invalid', 'another card may try once the gap has passed');
    clock.now += 11 * 60_000;
    assert.equal(await bank.ensure('card C'), 'invalid');
    clock.now += 11 * 60_000;
    assert.equal(await bank.ensure('card D'), 'limited', 'three attempts in a day is the cap');
    assert.equal(calls, 3);
    // A day later the cap has lapsed, and so has card A's pause.
    clock.now += 24 * HOUR;
    answer = json(lines());
    assert.equal(await bank.ensure('card A'), 'generated');
    assert.equal(calls, 4);
  });
});

test('the attempt record survives a restart, so quitting and reopening does not buy another try', async () => {
  await workspace(async (_dir, file) => {
    const clock = { now: 1_000_000 };
    let calls = 0;
    const make = () => new OutageLineBank({ file, now: () => clock.now, generate: async () => { calls++; return 'nope'; } });
    const first = make(); await first.load();
    assert.equal(await first.ensure('card A'), 'invalid');
    const second = make(); await second.load();
    assert.equal(await second.ensure('card A'), 'limited');
    assert.equal(calls, 1);
  });
});

test('invalid or failed output never reaches the cache file', async () => {
  await workspace(async (_dir, file) => {
    const clock = { now: 1_000_000 };
    const outputs: (string | Error)[] = ['{"quota":["一一","二二"]}', new Error('offline'), json({ ...lines(), network: ['Claude 断了', '网络不通啦'] })];
    const bank = new OutageLineBank({ file, now: () => clock.now, limits: { minGapMs: 0, retryCardMs: 0, maxPerDay: 99 },
      generate: async () => { const next = outputs.shift()!; if (next instanceof Error) throw next; return next; } });
    await bank.load();
    assert.equal(await bank.ensure('card A'), 'invalid');
    clock.now += 1; assert.equal(await bank.ensure('card A'), 'failed');
    clock.now += 1; assert.equal(await bank.ensure('card A'), 'invalid');
    assert.equal(bank.lines('card A'), null);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(saved.cards, {});
    assert.equal(saved.attempts.length, 3);
    assert.ok(saved.attempts.every((a: { ok: boolean }) => a.ok === false));
  });
});

test('only one generation runs at a time', async () => {
  await workspace(async (_dir, file) => {
    let release!: (value: string) => void, calls = 0;
    const bank = new OutageLineBank({ file, generate: () => { calls++; return new Promise<string>(resolve => { release = resolve; }); } });
    await bank.load();
    const first = bank.ensure('card A');
    assert.equal(await bank.ensure('card B'), 'busy');
    while (calls === 0) await new Promise(resolve => setImmediate(resolve)); // the attempt is recorded on disk first
    release(json(lines()));
    assert.equal(await first, 'generated');
    assert.equal(calls, 1);
  });
});

test('the cache is checked again on load: damaged or tampered entries are dropped, and a broken file is just empty', async () => {
  await workspace(async (_dir, file) => {
    const good = outageCardKey('good'), bad = outageCardKey('bad');
    await writeFile(file, json({ version: 1, cards: { [good]: { at: 1, lines: lines() }, [bad]: { at: 1, lines: { ...lines(), quota: ['Claude 说', '额度没了'] } }, 'not-a-hash': { at: 1, lines: lines() } }, attempts: [] }));
    const bank = new OutageLineBank({ file, generate: async () => '' });
    await bank.load();
    assert.deepEqual(bank.lines('good'), lines());
    assert.equal(bank.lines('bad'), null);
    await writeFile(file, '{ broken');
    const empty = new OutageLineBank({ file, generate: async () => '' });
    await assert.doesNotReject(empty.load());
    assert.equal(empty.lines('good'), null);
    const missing = new OutageLineBank({ file: path.join(path.dirname(file), 'nothing.json'), generate: async () => '' });
    await assert.doesNotReject(missing.load());
  });
});

test('the cache keeps a bounded number of cards, forgetting the oldest', async () => {
  await workspace(async (_dir, file) => {
    const clock = { now: 1_000_000 };
    const bank = new OutageLineBank({ file, now: () => clock.now, limits: { maxCards: 2, minGapMs: 0, maxPerDay: 99 }, generate: async () => json(lines()) });
    await bank.load();
    for (const card of ['one', 'two', 'three']) { clock.now += 1000; await bank.ensure(card); }
    assert.equal(bank.lines('one'), null);
    assert.ok(bank.lines('two') && bank.lines('three'));
  });
});

test('a cache that cannot be written still serves this run', async () => {
  await workspace(async (_dir, file) => {
    const bank = new OutageLineBank({ file, generate: async () => json(lines()), write: async () => { throw new Error('disk full'); } });
    await bank.load();
    assert.equal(await bank.ensure('card A'), 'generated');
    assert.deepEqual(bank.lines('card A'), lines());
  });
});
