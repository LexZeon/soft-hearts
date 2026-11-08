// 体验记录 (E2) 的两处口径（Codex X-212 复核后按用户的规矩定下）：
// 1. 关着就不记。开关关着时的互动不进记录，开关打开后也不补记：会合并的（连续摸头 4 秒内合成一条）关着时不合并，
//    要稳定一会儿才算的（心情标签 5 秒）关着时直接当作已知。开着时发生、已经交给记录的照记：还在合并中的那串摸头，
//    关开关前先结清成一行（写在"体验记录关闭"前面）；已经排队、关掉后才写完的那一行也照写（J10 的边界）。
//    互动对她心情的影响不变，只是不记。
// 2. 每天 8 MiB（8,388,608 字节）含 `truncated` 标记：一行只有在写完后还放得下标记时才写，否则写标记并停；
//    当天文件连标记一起不超过上限。
// 序列取自 Codex 的 J11、F01、J08、J10（合成数据，只在临时目录）。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { CompanionService } from '../electron/companion';
import { AppJournal, registerJournalIpc } from '../electron/journal/app-journal';
import { LABEL_STABLE_MS, MoodJournal, TOUCH_GAP_MS, type MoodJournalEvent } from '../electron/journal/sources';
import { JournalWriter } from '../electron/journal/writer';
import { JOURNAL_DAY_LIMIT_BYTES, buildJournalEntry, type JournalInput, type JournalView } from '../shared/journal';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';
import type { ProviderConfig } from '../shared/contracts';

async function temp(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const AT = Date.UTC(2026, 10, 3, 12);
const values = (O = 50) => ({ D: 50, O, E: 50, N: 50, C: 50 });
const pat = (O = 56): MoodJournalEvent => ({ characterId: 'A', type: 'rua', effectiveMs: 500, before: values(), after: values(O), labelBefore: 'calm', labelAfter: 'content' });
const moodView = (primary = 'content'): MoodView => ({ characterId: 'A', parameters: DEFAULT_MOOD_PARAMETERS,
  snapshot: { primary, boredom: 0, longing: 0 }, fatigue: { phase: 'awake' } }) as unknown as MoodView;

/** The real AppJournal, the real IPC switch and the real MoodJournal on one synthetic profile (Codex F01's shape). */
async function harness(t: TestContext, on: boolean) {
  const profile = await temp(t, 'sh-journal-bound-'), state = { on, now: AT };
  const journal = new AppJournal({ profileDirectory: () => profile, enabled: () => state.on, clock: () => state.now, characters: () => ({ cards: [] }),
    publish: () => {}, publishDelayMs: 0 });
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let queue = Promise.resolve();
  registerJournalIpc((method, operation) => handlers.set(method, operation), { journal, enabled: () => state.on, characterId: () => 'A',
    mutate: run => { const next = queue.then(run); queue = next.then(() => {}, () => {}); return next; }, persist: async value => { state.on = value; } });
  const mood = new MoodJournal(journal, () => state.now);
  const turn = (value: boolean) => handlers.get('setExperienceJournal')!(value) as Promise<JournalView>;
  const lines = async () => {
    await journal.flush();
    const directory = path.join(profile, 'journal');
    let names: string[] = [];
    try { names = (await readdir(directory)).sort(); } catch { return []; }
    const out: any[] = [];
    for (const name of names) out.push(...(await readFile(path.join(directory, name), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)));
    return out;
  };
  return { profile, state, journal, mood, turn, lines };
}
const shape = (entries: any[]) => entries.map(entry => entry.type === 'mood-event' ? `touch×${entry.count ?? 1}:O${entry.after.O}` : entry.type === 'journal' ? entry.event : entry.type === 'mood-label' ? `${entry.from}→${entry.to}` : entry.type);

// ------------------------------------------------------------------ 1. 关着就不记

test('J11: a pat while the switch is off is not written once it is turned on and the run is closed', async t => {
  const h = await harness(t, false);
  h.mood.event(pat());
  await h.journal.flush();
  await assert.rejects(readdir(path.join(h.profile, 'journal')), /ENOENT/, 'off: no journal folder');
  h.state.on = true;
  h.mood.flushTouch();
  assert.deepEqual(shape(await h.lines()), [], 'the off-period pat is not replayed');
  assert.deepEqual(h.journal.writer.recent(), []);
});

test('F01: turned on through the real switch, the next mood view after the pause writes no off-period pat (both branches)', async t => {
  for (const viewWhileOff of [false, true]) {
    const h = await harness(t, false);
    h.mood.event(pat());
    if (viewWhileOff) { h.state.now = AT + 4_001; h.mood.view(moodView()); await h.journal.flush(); }
    await assert.rejects(readdir(path.join(h.profile, 'journal')), /ENOENT/);
    await h.turn(true);
    h.state.now = AT + 5_001;
    h.mood.view(moodView());
    assert.deepEqual(shape(await h.lines()), ['on'], `viewWhileOff=${viewWhileOff}`);
  }
});

test('turning it off settles the run of pats that began while on (before the "off" line); pats while off never join it', async t => {
  const h = await harness(t, false);
  await h.turn(true);
  h.mood.event(pat(52));                  // on: a run starts
  h.state.now += 1_000; await h.turn(false); // still inside the 4 s gap
  h.state.now += 1_000; h.mood.event(pat(54)); // off: would have joined the run
  h.state.now += 1_000; await h.turn(true);
  h.state.now += TOUCH_GAP_MS + 1; h.mood.view(moodView());
  h.state.now += 1_000; h.mood.flushTouch();
  assert.deepEqual(shape(await h.lines()), ['on', 'touch×1:O52', 'off', 'on']);
  // After it is on again, a pat is a line as before.
  h.mood.event(pat(58));
  h.state.now += TOUCH_GAP_MS + 1; h.mood.view(moodView());
  assert.deepEqual(shape(await h.lines()).slice(-1), ['touch×1:O58']);
});

test('a run nobody settled (the switch went off another way, like 重置应用设置) is dropped while off, not written once it is on', async t => {
  for (const whileOff of ['view', 'pat'] as const) {
    const h = await harness(t, true);
    h.mood.event(pat(52));
    h.state.on = false;                     // no IPC: nothing settled the run
    h.state.now += 1_000;
    if (whileOff === 'view') h.mood.view(moodView()); else h.mood.event(pat(54));
    h.state.now += 1_000; await h.turn(true);
    h.state.now += TOUCH_GAP_MS + 1; h.mood.view(moodView());
    assert.deepEqual(shape(await h.lines()), ['on'], whileOff);
  }
});

test('J10 boundary kept: a line handed over while on is written even when the switch goes off before the disk write', async t => {
  const directory = path.join(await temp(t, 'sh-journal-j10-'), 'journal'), state = { on: true };
  const writer = new JournalWriter({ directory: () => directory, enabled: () => state.on, clock: () => AT, localDay: () => '2026-11-03' });
  assert.ok(writer.record({ type: 'character', characterId: 'A', event: 'activate' }));
  state.on = false;
  assert.equal(writer.record({ type: 'character', characterId: 'A', event: 'update' }), null);
  await writer.flush();
  const kept = (await readFile(path.join(directory, '2026-11-03.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(kept.map(entry => entry.event), ['activate']);
});

test('a label that changed while off is not counted once it is on; a change after that still is', async t => {
  const h = await harness(t, true);
  h.mood.view(moodView('calm'));           // the first look only learns
  await h.turn(false);
  h.state.now += 1_000; h.mood.view(moodView('content'));  // changed while off
  await h.turn(true);
  h.state.now += 1_000; h.mood.view(moodView('content'));
  h.state.now += LABEL_STABLE_MS; h.mood.view(moodView('content'));
  assert.deepEqual(shape(await h.lines()), ['off', 'on'], 'calm→content happened while off');
  h.state.now += 1_000; h.mood.view(moodView('happy'));
  h.state.now += LABEL_STABLE_MS; h.mood.view(moodView('happy'));
  assert.deepEqual(shape(await h.lines()), ['off', 'on', 'content→happy']);
});

test('the real CompanionService: a pat while off moves her mood as usual and is not written when it is turned on and she quits', async t => {
  const provider: ProviderConfig = { kind: 'claude', baseUrl: 'https://synthetic.example/v1', model: 'fixture' };
  const profile = await temp(t, 'sh-journal-bound-e2e-'), state = { on: false };
  const journal = new AppJournal({ profileDirectory: () => profile, enabled: () => state.on, characters: () => ({ cards: [] }), publish: () => {}, publishDelayMs: 0 });
  const handlers = new Map<string, (...args: any[]) => unknown>();
  registerJournalIpc((method, operation) => handlers.set(method, operation), { journal, enabled: () => state.on, characterId: () => 'gene',
    mutate: run => run(), persist: async value => { state.on = value; } });
  const service = new CompanionService(profile, () => {}, { journal });
  await service.load(); await service.context('gene', provider, 'Gene');
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const stroke = async (session: string) => {
    const token = service.mood.get().token;
    service.mood.interaction({ token, sessionId: session, type: 'phase', phase: 'rua' });
    await wait(300);
    service.mood.interaction({ token, sessionId: session, type: 'rua', id: `${session}-stroke`, activeMs: 250 });
    service.mood.interaction({ token, sessionId: session, type: 'phase', phase: 'idle' });
  };
  const before = structuredClone(service.mood.get().snapshot.values);
  await stroke('pat-off');
  assert.notDeepEqual(service.mood.get().snapshot.values, before, 'the pat still moves her mood while the journal is off');
  await handlers.get('setExperienceJournal')!(true);
  await service.flush(); await journal.flush();     // the quit path closes any open run of pats
  const read = async () => (await readFile(path.join(profile, 'journal', (await readdir(path.join(profile, 'journal')))[0]), 'utf8'))
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual((await read()).map(entry => entry.type + ':' + (entry.source ?? entry.event)), ['journal:on']);
  await stroke('pat-on');
  await service.flush(); await journal.flush();
  assert.deepEqual((await read()).map(entry => entry.type + ':' + (entry.source ?? entry.event)), ['journal:on', 'blush:pat', 'mood-event:touch']); // the pat made a blush moment (2026-11-06 batch 1); the pat while off made none
});

// ------------------------------------------------------------------ 2. 8 MiB 含标记

const DAY = '2026-11-03';
const plain: JournalInput = { type: 'character', characterId: 'A', event: 'activate' };
const lineBytes = Buffer.byteLength(JSON.stringify(buildJournalEntry(plain, AT)) + '\n');
const markerBytes = Buffer.byteLength(JSON.stringify(buildJournalEntry({ type: 'truncated', characterId: null, day: DAY }, AT)) + '\n');
async function dayFile(t: TestContext, prefill: number) {
  const directory = path.join(await temp(t, 'sh-journal-cap-'), 'journal'), file = path.join(directory, `${DAY}.jsonl`);
  await mkdir(directory, { recursive: true });
  await writeFile(file, Buffer.alloc(prefill, 0x20));
  const writer = () => new JournalWriter({ directory: () => directory, enabled: () => true, clock: () => AT, localDay: () => DAY });
  const tail = async () => (await readFile(file)).subarray(-4_000).toString('utf8');
  return { file, writer, tail, size: async () => (await stat(file)).size };
}
const markers = (text: string) => text.split('"type":"truncated"').length - 1;

test('J08: the ceiling is 8 MiB (8,388,608 bytes) with the marker: an exact fill ends at the limit, marker included', async t => {
  assert.equal(JOURNAL_DAY_LIMIT_BYTES, 8_388_608);
  const day = await dayFile(t, JOURNAL_DAY_LIMIT_BYTES - lineBytes - markerBytes), writer = day.writer();
  writer.record(plain); await writer.flush();
  assert.equal(await day.size(), JOURNAL_DAY_LIMIT_BYTES - markerBytes, 'the last line that still leaves room for the marker');
  writer.record(plain); await writer.flush();
  assert.equal(await day.size(), JOURNAL_DAY_LIMIT_BYTES, 'the marker takes the room that was kept for it');
  writer.record(plain); await writer.flush();
  assert.equal(await day.size(), JOURNAL_DAY_LIMIT_BYTES, 'nothing more that day');
  const tail = await day.tail();
  assert.equal(markers(tail), 1);
  assert.ok(tail.endsWith('"reason":"今天的记录到上限了，后面的不再写"}\n'));
  assert.equal(writer.status().truncatedToday, true);
  // A restart reads the marker back and still writes nothing.
  const again = day.writer();
  again.record(plain); await again.flush();
  assert.equal(await day.size(), JOURNAL_DAY_LIMIT_BYTES);
  assert.equal(again.status().truncatedToday, true);
});

test('J08 (Codex sequence): a file filled to one line under 8 MiB never grows past 8 MiB', async t => {
  const day = await dayFile(t, JOURNAL_DAY_LIMIT_BYTES - lineBytes), writer = day.writer();
  for (let i = 0; i < 3; i++) { writer.record(plain); await writer.flush(); }
  const size = await day.size();
  assert.ok(size <= JOURNAL_DAY_LIMIT_BYTES, `size ${size} must be ≤ ${JOURNAL_DAY_LIMIT_BYTES}`);
  // This line is shorter than the marker, so neither fits: the day stops without a marker (in memory) rather than going over.
  assert.ok(lineBytes < markerBytes);
  assert.equal(size, JOURNAL_DAY_LIMIT_BYTES - lineBytes);
  assert.equal(markers(await day.tail()), 0);
  assert.equal(writer.status().truncatedToday, true);
  assert.equal(writer.status().dropped, 3);
});

test('a file with less room left than the marker (an older version wrote it) gets nothing more, and the day counts as full', async t => {
  const day = await dayFile(t, JOURNAL_DAY_LIMIT_BYTES - markerBytes + 1), writer = day.writer();
  writer.record(plain); await writer.flush();
  assert.equal(await day.size(), JOURNAL_DAY_LIMIT_BYTES - markerBytes + 1);
  assert.equal(writer.status().truncatedToday, true);
  assert.equal(writer.status().failure, null);
});

test('with mixed line sizes the day file (marker included) stays within a small ceiling and ends with one marker', async t => {
  const directory = path.join(await temp(t, 'sh-journal-cap-small-'), 'journal');
  const writer = new JournalWriter({ directory: () => directory, enabled: () => true, clock: () => AT, localDay: () => DAY, dayLimitBytes: 2048 });
  const inputs: JournalInput[] = [plain, { type: 'mood-label', characterId: 'gene', from: 'calm', to: 'content' },
    { type: 'mood-event', characterId: 'gene', source: 'food', before: values(), after: values(60), labelBefore: 'calm', labelAfter: 'happy' }];
  for (let i = 0; i < 60; i++) writer.record(inputs[i % inputs.length]);
  await writer.flush();
  const text = await readFile(path.join(directory, `${DAY}.jsonl`), 'utf8');
  assert.ok(Buffer.byteLength(text) <= 2048, `${Buffer.byteLength(text)} bytes`);
  assert.equal(markers(text), 1);
  assert.equal(JSON.parse(text.trimEnd().split('\n').at(-1)!).type, 'truncated');
});
