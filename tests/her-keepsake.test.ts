// I-050 她的文件夹, 第 2 步: 特别的日子和偶尔留一份。Dates she knows, the one model call (a fake here), the folder's own checks reused through
// HerFolderHost.keep, the ledger ("once per date per year"), and the opening-choice / inner-loop path of her light line. Temporary folders only;
// no real model calls.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import {
  KEEPSAKE_FORMS, KEEPSAKE_KNOBS, daysUntil, drawForm, drawGapMs, leadDaysFor, parseSpecialDates, readLedger, specialKey, startOfDay, tellDeadline,
} from '../shared/memory/keepsake';
import { HerFolderHost, type HerFolderJournalInput } from '../electron/initiative/her-folder/host';
import { HerFolderStore } from '../electron/initiative/her-folder/store';
import { KeepsakeHost } from '../electron/initiative/her-folder/keepsake';
import { keepsakePrompt, parseKeepsake } from '../electron/initiative/her-folder/keepsake-prompt';
import { keepsakeWithClaude } from '../electron/initiative/her-folder/keepsake-model';
import { OpeningHost, type OpeningLoop } from '../electron/brain/opening-host';
import { InnerLoop, type InnerLoopDependencies } from '../electron/initiative/inner-loop/inner-loop';
import { FixedOpeningChoice } from '../shared/behaviors/opening-choice/fake';
import { OpeningChoiceDirector } from '../shared/behaviors/opening-choice/choose';
import { ProactiveSpeechGate } from '../electron/initiative/proactive-speech-gate';
import type { InnerLoopQuiet } from '../shared/initiative/inner-loop';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot, type MoodCue } from '../shared/foundation/mood';
import type { MoodView } from '../shared/mood/mood-runtime';

const temps: string[] = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
const temp = (label: string) => { const dir = mkdtempSync(path.join(os.tmpdir(), `sh-keepsake-${label}-`)); temps.push(dir); return dir; };
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const NOV8 = at(2026, 11, 8);
const rng = (seed: number) => { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; };
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const visible = (dir: string) => readdirSync(dir).filter(name => !name.startsWith('.')).sort();
const AWAKE: InnerLoopQuiet = { asleep: false, drowsy: false, night: false, quiet: false };
const REST = getMoodSnapshot(createMoodState(1_000), 1_000);
const VIEW = { characterId: 'gene', snapshot: REST, parameters: DEFAULT_MOOD_PARAMETERS } as Pick<MoodView, 'characterId' | 'snapshot' | 'parameters'>;

const GIFT = (name = '生日的信.md', say = '去我的文件夹看看') =>
  `{"name":"${name}","say":${JSON.stringify(say)}}\n亲爱的你，生日快乐。这是我提前几天悄悄给你准备的一点小心意，愿你每天都开心。`;

// ---------------------------------------------------------------- dates she knows

test('dates: only what the user told her, with a clear month and day; others\' birthdays and guesses give nothing', () => {
  const dates = parseSpecialDates(['我的生日是3月5日', '我们的纪念日是10月1日', '我喜欢吃草莓', '我朋友的生日是6月6日', '生日大概在夏天', '我的生日是2月30日', '我的生日是13月1日']);
  assert.deepEqual(dates.map(specialKey).sort(), ['anniversary-10-01', 'birthday-03-05']);
  assert.deepEqual(parseSpecialDates(['6月6日我们认识', '今天心情不错']), [], 'a date without birthday or anniversary words is not one');
  assert.deepEqual(parseSpecialDates(null), []);
  assert.deepEqual(parseSpecialDates(['我的生日是2月29日']).map(specialKey), ['birthday-02-29']);
  assert.deepEqual(parseSpecialDates(['生日 5月20日', '5月20号是我生日']).map(specialKey), ['birthday-05-20'], 'both orders, one date');
});

test('days until: local days, the year it falls in, Feb 29 in a common year', () => {
  assert.deepEqual(daysUntil(NOV8, 11, 10), { days: 2, year: 2026 });
  assert.deepEqual(daysUntil(NOV8, 11, 8), { days: 0, year: 2026 });
  assert.deepEqual(daysUntil(NOV8, 11, 7), { days: 364, year: 2027 });
  assert.deepEqual(daysUntil(at(2027, 2, 27), 2, 29), { days: 1, year: 2027 }, 'Feb 29 is Feb 28 in a common year');
  assert.deepEqual(daysUntil(at(2028, 2, 27), 2, 29), { days: 2, year: 2028 });
  assert.equal(startOfDay(NOV8, 2), at(2026, 11, 10, 0));
  assert.equal(tellDeadline(NOV8, 2), at(2026, 11, 12, 0), 'the line may still be said through the day after');
});

test('lead days: inside the range, stable for a date and year, not the same for every date', () => {
  const seen = new Set<number>();
  for (let i = 0; i < 60; i++) {
    const lead = leadDaysFor('gene', `birthday-0${1 + (i % 9)}-1${i % 9}`, 2026 + (i % 3));
    assert.ok(lead >= KEEPSAKE_KNOBS.prepLeadDays.min && lead <= KEEPSAKE_KNOBS.prepLeadDays.max, String(lead));
    assert.equal(lead, leadDaysFor('gene', `birthday-0${1 + (i % 9)}-1${i % 9}`, 2026 + (i % 3)));
    seen.add(lead);
  }
  assert.ok(seen.size >= 3, 'a spread, not one fixed number');
});

test('what she makes: never the same form twice in a row; a clingy card leans to letters, a playful one to lists; the gap is shorter for them and longer when she is asked to talk less', () => {
  for (const form of KEEPSAKE_FORMS) for (let i = 0; i < 40; i++) assert.notEqual(drawForm(null, form.id, rng(i + 1)).id, form.id);
  const count = (personality: Record<string, number>, id: string) => { let n = 0; for (let i = 0; i < 400; i++) if (drawForm(personality, null, rng(i * 7 + 3)).id === id) n++; return n; };
  assert.ok(count({ close: 1.8 }, 'letter') > count({ close: 0.4 }, 'letter'));
  assert.ok(count({ playful: 1.8 }, 'list') > count({ playful: 0.4 }, 'list'));
  const gap = (p: Record<string, number>, scale = 1) => drawGapMs(p, scale, () => 0.5);
  assert.ok(gap({ close: 1.6, playful: 1.4 }) < gap({ close: 1, playful: 1 }));
  assert.ok(gap({ close: 1, playful: 1 }, 2) > gap({ close: 1, playful: 1 }, 1));
  const { min, max } = KEEPSAKE_KNOBS.occasionalGapHours;
  assert.equal(drawGapMs(null, 1, () => 0), min * 3_600_000);
  assert.equal(drawGapMs(null, 1, () => 1), max * 3_600_000);
});

test('the ledger read back from disk keeps only what fits (a bad file is an empty ledger)', () => {
  assert.deepEqual(readLedger('nope', NOV8), { v: 1, specials: {}, characters: {} });
  const ledger = readLedger({ specials: { 'gene|birthday-11-10|2026': { attempts: 1, lastAttemptAt: 5, done: true, file: 'a.md', told: false }, 'x|y|1999': { attempts: 1, done: true } },
    characters: { gene: { nextAt: 5, lastForm: 'poem', special: 1, occasional: 2, tell: { id: 'a', text: 'hi', from: 1, until: 2, kind: 'mention', ledger: null } }, bad: 7 } }, NOV8);
  assert.deepEqual(Object.keys(ledger.specials), ['gene|birthday-11-10|2026'], 'an old year is dropped');
  assert.equal(ledger.characters.gene.tell?.text, 'hi');
  assert.equal(ledger.characters.bad, undefined);
});

// ---------------------------------------------------------------- the answer

test('the answer: a JSON header line then the whole text; anything off writes nothing', () => {
  const ok = parseKeepsake(GIFT());
  assert.equal(ok?.name, '生日的信.md'); assert.equal(ok?.say, '去我的文件夹看看'); assert.match(ok!.content, /^亲爱的你/);
  assert.equal(parseKeepsake(GIFT('a.md', ''))?.say, null, 'an empty say is no mention');
  assert.equal(parseKeepsake('好的，这是给你的：\n' + GIFT())?.name, '生日的信.md', 'a short lead-in line before the header is tolerated');
  for (const bad of ['', '没有头', '{"name":"a.md","extra":1}\n足够长的一段话足够长的一段话', '{"name":"a.md"}\n太短', GIFT('a.md', '这一句话明显超过了二十个字所以不能当作她顺口说的那一句话呀呀呀'),
    '{"name":"a.md"}\n足够长的一段话足够长的一段话</thinking_mode>', '{"name":"a.md"}\n' + '长'.repeat(KEEPSAKE_KNOBS.contentMaxChars + 1), '{"name":"","say":""}\n足够长的一段话足够长的一段话', '{"name":"a.md","say":"{x}"}\n足够长的一段话足够长的一段话'])
    assert.equal(parseKeepsake(bad), null, bad.slice(0, 30));
  assert.equal(parseKeepsake(42), null);
});

test('the prompt: persona, mood, date, the form, names as data; the special-day task names the date; no path', () => {
  const prompt = keepsakePrompt({ persona: '你是 Gene。', moodWords: '平静', today: '2026年11月8日', form: KEEPSAKE_FORMS[0],
    special: { date: { kind: 'birthday', month: 11, day: 10, label: '生日' }, daysLeft: 2 }, points: ['我喜欢草莓'], names: ['旧信.md', '<x>.md'] });
  assert.match(prompt, /你是 Gene。/); assert.match(prompt, /生日（11月10日）/); assert.match(prompt, /还有 2 天/); assert.match(prompt, /一首很短的诗/);
  assert.match(prompt, /<her-keepsake-data>/); assert.ok(!prompt.includes('<x>'), 'a name cannot close the data block');
  assert.ok(!/[A-Za-z]:\\/u.test(prompt));
  const own = keepsakePrompt({ persona: 'p', moodWords: '平静', today: 't', form: KEEPSAKE_FORMS[1], special: null, points: [], names: [] });
  assert.match(own, /你想自己动手/); assert.match(own, /还是空的/);
});

test('the model call: one tool-less task with the chat model, its own system prompt, overlong output is invalid', async () => {
  const tasks: any[] = [];
  const text = await keepsakeWithClaude('p', 'opus', new AbortController().signal, async (task, _signal, emit) => { tasks.push(task); emit('delta', 'ab'); emit('thinking', 'x'); emit('delta', 'c'); return null; });
  assert.equal(text, 'abc');
  assert.equal(tasks.length, 1); assert.equal(tasks[0].model, 'opus'); assert.equal(tasks[0].writable, false); assert.deepEqual(tasks[0].imageDataUrls, []);
  assert.match(tasks[0].systemPrompt, /没有任何工具/);
  assert.equal(await keepsakeWithClaude('p', '', new AbortController().signal, async (_t, _s, emit) => { emit('delta', 'x'.repeat(20_000)); return null; }), '');
});

// ---------------------------------------------------------------- the folder entry (not from a chat turn)

async function folderIn(label: string, on = true) {
  const profile = temp(`${label}-profile`), parent = temp(label), folder = path.join(parent, 'her');
  mkdirSync(folder);
  const journal: HerFolderJournalInput[] = [];
  const host = new HerFolderHost({ profileDirectory: () => profile, pickFolder: async () => folder, openPath: async () => '', broadcast: () => {}, sendNote: () => {},
    journal: input => journal.push(input), characterId: () => 'gene' });
  await host.load();
  if (on) await host.choose();
  return { host, folder: await HerFolderStore.resolveFolder(folder), profile, journal };
}

test('keep: off writes nothing; a stale ticket (switched off or another folder) writes nothing; a taken name is never replaced', async () => {
  const off = await folderIn('keep-off', false);
  assert.equal(off.host.beginKeepsake(), null);
  assert.deepEqual(await off.host.keep(null, '信.md', '一些足够长的内容'), { ok: false, why: 'stale' });
  assert.deepEqual(visible(off.folder), []);

  const { host, folder, journal } = await folderIn('keep');
  writeFileSync(path.join(folder, '生日的信.md'), '用户自己的文件');
  const ticket = host.beginKeepsake()!;
  const first = await host.keep(ticket, '生日的信.md', '她新写的内容很长很长');
  assert.deepEqual(first.ok && first.name, '生日的信（2）.md', 'the user\'s file keeps its name and content');
  assert.equal(readFileSync(path.join(folder, '生日的信.md'), 'utf8'), '用户自己的文件');
  assert.ok(first.ok && first.bytes > 0);
  const stale = host.beginKeepsake()!;
  await host.turnOff();
  assert.deepEqual(await host.keep(stale, 'x.md', '一些足够长的内容'), { ok: false, why: 'stale' });
  assert.deepEqual(visible(folder), ['生日的信.md', '生日的信（2）.md']);
  assert.deepEqual(journal.map(item => item.action), ['created', 'refused']);
  assert.ok(!JSON.stringify(journal).includes('她新写'), 'names and sizes only');
});

test('keep: a write already queued when the switch goes off writes nothing (checked again where it takes effect)', async () => {
  const { host, folder, journal } = await folderIn('keep-queued');
  const ticket = host.beginKeepsake()!;
  const pending = host.keep(ticket, 'queued.md', '一些足够长的内容');
  void host.turnOff(); // before the queued write runs
  assert.deepEqual(await pending, { ok: false, why: 'stale' });
  assert.deepEqual(visible(folder), []);
  assert.ok(journal.some(line => line.action === 'refused' && line.why === 'stale'));
});

test('keep: the same name, size and type checks as a chat block (traversal, wrong type, over 200 KB write nothing)', async () => {
  const { host, folder, journal } = await folderIn('keep-checks');
  const ticket = host.beginKeepsake()!;
  for (const name of ['../x.md', 'C:\\x.md', 'x.exe', 'CON.md', 'a:b.md', '.hidden.md']) assert.equal((await host.keep(ticket, name, '一些足够长的内容')).ok, false, name);
  assert.equal((await host.keep(ticket, 'big.md', 'x'.repeat(200 * 1024 + 1))).ok, false);
  assert.equal((await host.keep(ticket, 'empty.md', '   ')).ok, false);
  assert.deepEqual(visible(folder), []);
  assert.ok(journal.every(item => item.action === 'refused'));
});

// ---------------------------------------------------------------- special days

interface RigOptions { recording?: string[] | null; on?: boolean; answer?: (prompt: string) => string | Promise<string>; now?: number;
  moment?: (kind: 'keepsake' | 'special-day', characterId: string, key: string) => void }
async function rig(label: string, options: RigOptions = {}) {
  const folder = await folderIn(label, options.on !== false);
  const state = { recording: options.recording === undefined ? ['我的生日是11月10日'] : options.recording, calm: true, now: options.now ?? NOV8, character: 'gene',
    answer: options.answer ?? (() => GIFT()) };
  const asks: string[] = [];
  const keep = new KeepsakeHost({ folder: folder.host, file: () => path.join(folder.profile, 'her-keepsakes.json'), characterId: () => state.character,
    recordingTexts: () => state.recording, persona: () => '你是 Gene。', moodWords: () => '平静', personality: () => ({ playful: 1, close: 1, comfortable: 1, cautious: 1 }),
    calm: () => state.calm, ask: async prompt => { asks.push(prompt); return state.answer(prompt); }, now: () => state.now, random: rng(5),
    ...(options.moment ? { moment: options.moment } : {}) });
  await keep.load();
  return { ...folder, keep, state, asks };
}

test('心情第二批: the birthday line really shown is a keepsake moment and a special-day moment, once; another message is neither', async () => {
  const moments: [string, string, string][] = [];
  const r = await rig('special-moment', { moment: (kind, characterId, key) => { moments.push([kind, characterId, key]); } });
  await r.keep.tick();
  r.state.now = at(2026, 11, 10, 9);
  assert.equal(r.keep.line({ id: 'cue-1', characterId: 'gene' }), '去我的文件夹看看');
  r.keep.noteDelivered('some-other-message');
  assert.deepEqual(moments, []);
  r.keep.noteDelivered('cue-1');
  assert.deepEqual(moments, [['keepsake', 'gene', 'cue-1'], ['special-day', 'gene', 'cue-1']]);
  r.keep.noteDelivered('cue-1');
  assert.equal(moments.length, 2, 'told once');
});

test('a known birthday: one keepsake a few days before, one light line on the day, once per year', async () => {
  const r = await rig('special');
  await r.keep.tick();
  assert.equal(r.asks.length, 1);
  assert.match(r.asks[0], /生日（11月10日）/);
  assert.deepEqual(visible(r.folder), ['生日的信.md']);
  assert.equal(r.journal.at(-1)?.action, 'created');
  assert.equal(r.keep.peek('gene'), null, 'nothing to say before the day (and the first look only sets the next time)');
  assert.equal(r.keep.line({ id: 'cue-0', characterId: 'gene' }), null, 'the line is not given out before the day');
  await r.keep.tick(); await r.keep.tick();
  assert.equal(r.asks.length, 1, 'once for this date this year');
  // On the day.
  r.state.now = at(2026, 11, 10, 9);
  assert.equal(r.keep.peek('gene'), 'tell');
  assert.equal(r.keep.line({ id: 'cue-1', characterId: 'gene' }), '去我的文件夹看看');
  assert.equal(r.keep.peek('gene'), 'tell', 'still held until it was really shown');
  r.keep.noteDelivered('some-other-message');
  assert.equal(r.keep.peek('gene'), 'tell');
  r.keep.noteDelivered('cue-1');
  assert.notEqual(r.keep.peek('gene'), 'tell', 'told once');
  await r.keep.tick();
  assert.equal(r.asks.length, 1, 'the day itself, told: nothing more');
  r.state.now = at(2026, 11, 20);
  await r.keep.tick();
  assert.equal(r.asks.length, 1, 'next year\'s birthday is far away');
  // The next year: prepared again, the old file is not replaced.
  r.state.now = at(2027, 11, 8);
  await r.keep.tick();
  assert.equal(r.asks.length, 2);
  assert.deepEqual(visible(r.folder), ['生日的信.md', '生日的信（2）.md']);
  await r.keep.idle();
  // Survives a restart: the ledger is on disk, so a new host does not prepare the same date again.
  const again = new KeepsakeHost({ folder: r.host, file: () => path.join(r.profile, 'her-keepsakes.json'), characterId: () => 'gene', recordingTexts: () => r.state.recording,
    persona: () => 'p', moodWords: () => '平静', personality: () => ({}), calm: () => true, ask: async prompt => { r.asks.push(prompt); return GIFT(); }, now: () => r.state.now });
  await again.load(); await again.tick();
  assert.equal(r.asks.length, 2);
});

test('an unspoken special-day line expires after the day after; a mention-less gift is just there', async () => {
  const r = await rig('expire');
  await r.keep.tick();
  r.state.now = at(2026, 11, 11, 20);
  assert.equal(r.keep.peek('gene'), 'tell', 'the day after, still');
  r.state.now = at(2026, 11, 12, 1);
  assert.notEqual(r.keep.peek('gene'), 'tell', 'then not any more (the file stays in the folder)');
  assert.deepEqual(visible(r.folder), ['生日的信.md']);
  const quiet = await rig('nosay', { answer: () => GIFT('信.md', '') });
  await quiet.keep.tick();
  quiet.state.now = at(2026, 11, 10, 9);
  assert.notEqual(quiet.keep.peek('gene'), 'tell');
  assert.deepEqual(visible(quiet.folder), ['信.md']);
});

test('nothing when: the folder is off, 允许记录 is off, no date is known, a guess only, someone else\'s birthday', async () => {
  for (const [label, options] of <[string, RigOptions][]>[
    ['folder-off', { on: false }], ['recording-off', { recording: null }], ['no-date', { recording: ['我喜欢草莓', '我通常晚睡'] }],
    ['other', { recording: ['我朋友的生日是11月10日'] }], ['far', { recording: ['我的生日是3月5日'] }],
  ]) {
    const r = await rig(label, options);
    await r.keep.tick();
    assert.equal(r.asks.length, 0, label);
    assert.deepEqual(visible(r.folder), [], label);
    assert.equal(r.keep.peek('gene'), null, label);
  }
});

test('asleep or the user busy (the calm gate): no call, nothing written, and the quiet writing does not start', async () => {
  const r = await rig('calm');
  r.state.calm = false;
  await r.keep.tick();
  assert.equal(r.asks.length, 0);
  assert.equal(r.keep.write('gene', { id: 'c', at: 1 }), false);
  r.state.calm = true;
  await r.keep.tick();
  assert.equal(r.asks.length, 1, 'later, when she is free, she prepares it');
});

test('the folder switched off while she was writing: the stale ticket writes nothing (and the date is not used up silently forever)', async () => {
  const r = await rig('stale', { answer: async () => { await r.host.turnOff(); return GIFT(); } });
  await r.keep.tick();
  assert.equal(r.asks.length, 1);
  assert.deepEqual(visible(r.folder), []);
  assert.equal(r.journal.at(-1)?.action, 'refused');
  assert.ok(!r.keep.peek('gene'));
});

test('a malformed answer writes nothing; at most two attempts per date per year, with a gap between them', async () => {
  const r = await rig('malformed', { answer: () => '抱歉，我写不出来' });
  await r.keep.tick();
  assert.deepEqual(visible(r.folder), []);
  await r.keep.tick();
  assert.equal(r.asks.length, 1, 'not again at once');
  r.state.now += KEEPSAKE_KNOBS.retryGapMs + 1;
  await r.keep.tick();
  assert.equal(r.asks.length, 2);
  r.state.now += KEEPSAKE_KNOBS.retryGapMs * 3;
  await r.keep.tick();
  assert.equal(r.asks.length, 2, 'then she stops for this year');
  r.state.answer = () => GIFT();
  r.state.now += KEEPSAKE_KNOBS.retryGapMs * 3;
  await r.keep.tick();
  assert.equal(r.asks.length, 2);
  assert.deepEqual(visible(r.folder), []);
});

test('recording turned off while she was writing: no special-day file; switched character: nothing', async () => {
  const r = await rig('recoff', { answer: () => { r.state.recording = null; return GIFT(); } });
  await r.keep.tick();
  assert.deepEqual(visible(r.folder), []);
  const s = await rig('switch', { answer: () => { s.state.character = 'other'; return GIFT(); } });
  await s.keep.tick();
  assert.deepEqual(visible(s.folder), []);
  // A special-day line also needs 允许记录 still on when it is due.
  const t = await rig('tellrec');
  await t.keep.tick();
  t.state.now = at(2026, 11, 10, 9);
  t.state.recording = null;
  assert.notEqual(t.keep.peek('gene'), 'tell');
});

test('the ledger and the journal hold names and sizes only: no content, no date text', async () => {
  const r = await rig('private');
  await r.keep.tick(); await r.keep.idle();
  const ledger = readFileSync(path.join(r.profile, 'her-keepsakes.json'), 'utf8');
  assert.ok(!ledger.includes('悄悄给你准备'), 'not the content');
  assert.ok(!ledger.includes('我的生日是'), 'not the profile text');
  assert.ok(!JSON.stringify(r.journal).includes('悄悄给你准备'));
});

// ---------------------------------------------------------------- now and then, through the opening choice

interface FakeLoop extends OpeningLoop { calls: string[]; take: boolean; sleeping: boolean; quiet: InnerLoopQuiet }
function fakeLoop(): FakeLoop {
  const loop: FakeLoop = { calls: [], take: true, sleeping: false, quiet: { ...AWAKE },
    offerOpportunity: (cue, focus) => { loop.calls.push(`offer:${(cue as MoodCue).id}:${focus ?? '-'}`); return loop.take; },
    canTake: () => true, claims: () => false, asleep: () => loop.sleeping, silence: () => true, restReminderDue: () => false, quietNow: () => ({ ...loop.quiet }) };
  return loop;
}
let cueSerial = 0;
const speech = (): MoodCue => ({ id: `kcue-${++cueSerial}`, kind: 'speech', at: 10_000, until: 13_000 } as MoodCue);

async function opening(label: string, options: RigOptions & { order?: ('keepsake' | 'quiet' | 'mood')[]; loop?: FakeLoop } = {}) {
  const r = await rig(label, { recording: [], ...options });
  const loop = options.loop ?? fakeLoop(), chooser = new FixedOpeningChoice(options.order ?? ['keepsake', 'quiet']), refunds: string[] = [];
  const host = new OpeningHost({ loop, chooser, innerOn: () => true, developerMode: () => true, clock: () => 10_500, releaseSpeech: cue => { refunds.push(cue.id); },
    keepsake: r.keep.port(() => true) });
  // The first look with the folder on only sets the next time; she does not write the moment it is given to her.
  assert.equal(r.keep.peek('gene'), null);
  r.state.now += 3 * 24 * 3_600_000;
  return { ...r, loop, chooser, oh: host, refunds };
}

test('now and then: she leaves one thing on a speech cue of the usual kind; the cue stays spent (no refund), nothing is shown, no extra cue is made', async () => {
  const o = await opening('occ', { answer: () => GIFT('随手记.md', '') });
  const cue = speech();
  assert.equal(o.oh.claim(cue, {}, VIEW), 'keepsake');
  assert.equal(o.chooser.asked[0].now.available.keepsake, true);
  assert.deepEqual(o.refunds, [], 'it counts against the same limits as a line would');
  assert.deepEqual(o.loop.calls, [], 'nothing is said or shown');
  await flush(); await o.keep.idle();
  assert.equal(o.asks.length, 1);
  assert.deepEqual(visible(o.folder), ['随手记.md']);
  // The next cue right after: the candidate is gone until the next time is due (one in flight / the gap), so the pick falls to "这次不说".
  assert.equal(o.oh.claim(speech(), {}, VIEW), 'quiet');
  assert.equal(o.chooser.asked.at(-1)!.now.available.keepsake, undefined);
  assert.equal(o.refunds.length, 1);
  assert.equal(o.asks.length, 1);
  assert.match(o.oh.recent('gene').map(line => line.why.join('')).join(''), /给你留点东西：特别的日子 0 份，平时 0 份/);
});

test('at most one keepsake in flight, and the gap is drawn at the start (a slow call does not make a second one)', async () => {
  let release: (() => void) | null = null;
  const o = await opening('inflight', { answer: () => new Promise<string>(resolve => { release = () => resolve(GIFT('慢慢写.md', '')); }) });
  assert.equal(o.oh.claim(speech(), {}, VIEW), 'keepsake');
  // The call starts after real disk reads, so a fixed number of turns is not enough on a slow disk:
  // wait until it has started (bounded, so a bug fails here instead of hanging the whole run).
  for (const until = Date.now() + 5_000; release === null && Date.now() < until;) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(release, 'the slow call started');
  o.state.now += 100 * 3_600_000;
  assert.equal(o.keep.peek('gene'), null, 'one at a time');
  (release as () => void)(); await flush(); await o.keep.idle();
  assert.deepEqual(visible(o.folder), ['慢慢写.md']);
  assert.equal(o.asks.length, 1);
});

test('the folder off, the quiet hours, asleep, or the user busy: no keepsake candidate, no call', async () => {
  const off = await opening('occ-off', { on: false });
  assert.equal(off.oh.claim(speech(), {}, VIEW), 'quiet'); assert.equal(off.asks.length, 0);
  assert.equal(off.chooser.asked[0].now.available.keepsake, undefined);

  const night = fakeLoop(); night.quiet = { asleep: false, drowsy: false, night: true, quiet: true };
  const n = await opening('occ-night', { loop: night });
  assert.equal(n.oh.claim(speech(), {}, VIEW), 'quiet'); assert.equal(n.asks.length, 0);

  const sleeping = fakeLoop(); sleeping.sleeping = true;
  const s = await opening('occ-asleep', { loop: sleeping });
  assert.equal(s.oh.claim(speech(), {}, VIEW), 'asleep'); assert.equal(s.chooser.asked.length, 0); assert.equal(s.asks.length, 0);

  const busy = await opening('occ-busy');
  busy.state.calm = false;
  assert.notEqual(busy.oh.claim(speech(), {}, VIEW), 'keepsake', 'the user is busy: she cannot start writing');
  await flush();
  assert.equal(busy.asks.length, 0);
  assert.deepEqual(visible(busy.folder), []);
});

test('the folder switched off between the pick and the writing: the cue is spent but nothing is written', async () => {
  let switchOff: () => Promise<unknown> = async () => {};
  const o = await opening('occ-stale', { answer: async () => { await switchOff(); return GIFT('x.md', ''); } });
  switchOff = () => o.host.turnOff();
  assert.equal(o.oh.claim(speech(), {}, VIEW), 'keepsake');
  await flush(); await o.keep.idle();
  assert.equal(o.asks.length, 1);
  assert.deepEqual(visible(o.folder), []);
  assert.equal(o.journal.at(-1)?.action, 'refused');
});

test('her light line: held after a keepsake she wants to mention, spoken through the inner loop with no model call, told once', async () => {
  // A real inner loop: the line is already written, so deciding makes no call.
  const clock = { now: 1_000_000 };
  const gate = new ProactiveSpeechGate(() => clock.now); gate.setScope('scope');
  const offered: { id: string; text: string }[] = [], archived: string[] = [], prompts: string[] = [];
  let decides = 0;
  const r = await rig('line', { recording: [], answer: () => GIFT('随手记.md', '给你留了点东西') });
  const deps: InnerLoopDependencies = {
    gate, clock: () => clock.now, enabled: () => true, canStart: () => true, current: () => true,
    scope: () => ({ characterId: 'gene', gateScope: 'scope' }), parameters: () => DEFAULT_MOOD_PARAMETERS, quiet: () => ({ ...AWAKE }),
    prompt: () => { prompts.push('x'); return 'prompt'; }, decide: async () => { decides++; return { text: '{"action":"none"}' }; },
    keepsake: { line: claim => r.keep.line(claim) },
    realize: () => {}, releaseSpeech: () => {}, offer: message => { offered.push({ id: message.id, text: message.text }); },
    present: async () => true, presentationCurrent: () => true, archive: async message => { archived.push(message.text); r.keep.noteDelivered(message.id); },
  };
  const loop = new InnerLoop(deps);
  r.state.now = NOV8;
  assert.equal(r.keep.peek('gene'), null);
  r.state.now += 3 * 24 * 3_600_000;
  assert.equal(r.keep.write('gene', { id: 'w', at: 1 }), true);
  await flush(); await r.keep.idle();
  assert.equal(r.keep.peek('gene'), 'tell');
  const chooser = new FixedOpeningChoice(['keepsake', 'quiet']);
  const host = new OpeningHost({ loop: { ...loopPort(loop), }, chooser, innerOn: () => true, developerMode: () => false, clock: () => clock.now, releaseSpeech: () => {},
    keepsake: r.keep.port(() => true) });
  const cue = { id: 'tellcue', kind: 'speech', at: clock.now, until: clock.now + 3_000 } as MoodCue;
  assert.equal(host.claim(cue, {}, VIEW), 'inner');
  await flush();
  assert.deepEqual(offered, [{ id: 'tellcue', text: '给你留了点东西' }]);
  assert.equal(decides, 0, 'no model call for the line'); assert.deepEqual(prompts, []);
  assert.equal(r.keep.peek('gene'), 'tell', 'not told until it was really shown');
  assert.equal(await loop.ack('tellcue'), true);
  await flush();
  assert.deepEqual(archived, ['给你留了点东西']);
  assert.notEqual(r.keep.peek('gene'), 'tell');
  loop.dispose(); gate.dispose();
});

/** The OpeningLoop surface of a real InnerLoop. */
function loopPort(loop: InnerLoop): OpeningLoop {
  return { offerOpportunity: (cue, focus) => loop.offerOpportunity(cue, focus), canTake: (cue, focus) => loop.canTake(cue, focus), claims: id => loop.claims(id), asleep: () => loop.asleep(),
    silence: cue => loop.silence(cue), restReminderDue: () => loop.restReminderDue(), quietNow: () => loop.quietNow() };
}

test('the inner loop refuses the keepsake focus in the quiet hours or without a written line, and makes no call', async () => {
  const gate = new ProactiveSpeechGate(() => 1_000_000); gate.setScope('scope');
  let decides = 0;
  const make = (quiet: InnerLoopQuiet, withLine: boolean) => new InnerLoop({
    gate, clock: () => 1_000_000, enabled: () => true, canStart: () => true, current: () => true, scope: () => ({ characterId: 'gene', gateScope: 'scope' }),
    parameters: () => DEFAULT_MOOD_PARAMETERS, quiet: () => quiet, prompt: () => 'p', decide: async () => { decides++; return { text: '{"action":"none"}' }; },
    ...(withLine ? { keepsake: { line: () => '嗨' } } : {}), realize: () => {}, releaseSpeech: () => {}, offer: () => {}, present: async () => true, presentationCurrent: () => true, archive: async () => {} });
  const cue = (id: string) => ({ id, kind: 'speech', at: 1_000_000, until: 1_003_000 });
  assert.equal(make({ asleep: false, drowsy: false, night: true, quiet: true }, true).offerOpportunity(cue('a'), 'keepsake'), false, 'quiet hours: she may not speak');
  assert.equal(make({ ...AWAKE }, false).offerOpportunity(cue('b'), 'keepsake'), false, 'no source for the line');
  assert.equal(make({ ...AWAKE }, true).offerOpportunity({ id: 'm', kind: 'motion', at: 1_000_000, until: 1_003_000 }, 'keepsake'), false, 'a motion cue is not this');
  assert.equal(decides, 0);
  gate.dispose();
});

test('with the real chooser: the candidate is weighed by her mood and character, and is sometimes picked and sometimes not (never forced)', async () => {
  const picked: Record<string, number> = {};
  for (let i = 0; i < 40; i++) {
    const r = await rig(`weigh${i}`, { recording: [] });
    const loop = fakeLoop();
    const host = new OpeningHost({ loop, chooser: new OpeningChoiceDirector({ random: rng(Math.imul(i + 1, 2654435761) >>> 0) }), innerOn: () => true, developerMode: () => false, clock: () => 10_500,
      releaseSpeech: () => {}, keepsake: r.keep.port(() => true) });
    r.keep.peek('gene'); r.state.now += 3 * 24 * 3_600_000;
    const owner = host.claim(speech(), {}, { ...VIEW, snapshot: { ...REST, primary: 'longing', boredom: 80 } });
    picked[String(owner)] = (picked[String(owner)] ?? 0) + 1;
    await flush(); await r.keep.idle();
    assert.equal(r.asks.length, owner === 'keepsake' ? 1 : 0, `#${i} ${owner}`);
  }
  assert.ok((picked.keepsake ?? 0) > 0 && (picked.keepsake ?? 0) < 40, JSON.stringify(picked));
});

test('no real work is hidden in the clock: ledger reads and the first look make no call', async () => {
  const r = await rig('quiet-start');
  assert.equal(r.keep.counts('gene').includes('0 份'), true);
  assert.equal(r.asks.length, 0);
});
