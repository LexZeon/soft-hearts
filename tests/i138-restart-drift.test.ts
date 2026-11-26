import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../electron/memory/memory';
import { buildLongChatWindow } from '../electron/brain/long-chat/window';
import { LONG_CHAT_KNOBS } from '../shared/behaviors/long-chat/knobs';
import { OPENING_NOTE_HEADER } from '../electron/brain/claude-session-prompt';
import { FIDELITY_CARDS } from '../scripts/lib/fidelity-scenarios';
import { loadSnapshot } from '../scripts/lib/i134-replay';
import {
  CallCap, DEFAULT_CALL_CAP, DRIFT_ARMS, assertDriftOut, plannedCalls, suggestMoments,
} from '../scripts/lib/i138-plan';
import {
  addressForms, buildDriftSheet, buildReviewPrompt, catchphrases, compareStyle, driftSheetHtml, extractJokes, fakeReviewAnswer, jokePickup, parseReview,
  projectSessionTokens, reviewedArms, shuffleSegments, styleNumbers, tallyDriftRanks, tokenRatio, SEGMENT_LABELS,
} from '../scripts/lib/i138-analysis';
import { ProcessTap, fakeAsk, runMoment, removeTranscripts, type MomentState } from '../scripts/lib/i138-run';
import { loadDriftState, measureTokens, remainingPlan, runDrift } from '../scripts/lib/i138-driver';

const root = path.resolve(import.meta.dirname, '..');
const FAKE = path.join(root, 'scripts', 'lib', 'i138-fake-claude.mjs');
const local = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime();

// ---- the plan ---------------------------------------------------------------------------------------------------------------------

test('plan: the planned run is 105 calls (3 moments), 108 with the question-1 helper, under the 115 cap; every step is counted', () => {
  const plan = plannedCalls({ warmup: 12, next: 5, moments: 3, review: true, q1Calls: 0 });
  assert.equal(plan.total, 105);
  assert.equal(plannedCalls({ warmup: 12, next: 5, moments: 3, review: true, q1Calls: 3 }).total, 108);
  assert.ok(plan.total <= DEFAULT_CALL_CAP);
  assert.deepEqual(plan.steps.map(step => step.calls), [3, 36, 3, 15, 15, 15, 15, 3], 'note, warm-up, compaction, four arms, review');
  assert.equal(plannedCalls({ warmup: 12, next: 5, moments: 3, review: false, q1Calls: 0, arms: ['W', 'R'] }).total, 3 + 36 + 30);
});

test('call cap: the call that would pass it throws before anything is sent', () => {
  const cap = new CallCap(2);
  cap.take('a'); cap.take('b');
  assert.throws(() => cap.take('c'), /2 次调用上限/u);
  assert.equal(cap.used, 2);
});

test('output folder: inside the repository, OneDrive or a profile is refused; a plain temp folder passes', async () => {
  await assert.rejects(assertDriftOut('--out', path.join(root, 'docs', 'drift-out')), /仓库|repository|OneDrive/u);
  await assert.rejects(assertDriftOut('--out', path.join(process.env.APPDATA ?? 'C:\\Users\\x\\AppData\\Roaming', 'soft-hearts-claude', 'x')), /配置文件夹/u);
  const ok = await mkdtemp(path.join(os.tmpdir(), 'i138-out-'));
  try { assert.ok((await assertDriftOut('--out', ok)).length > 0); } finally { await rm(ok, { recursive: true, force: true }); }
});

test('moment suggestion: ids and times only; one per day; needs a run of user lines inside one day', () => {
  const messages = [];
  for (let i = 0; i < 20; i++) messages.push({ role: 'user' as const, content: `u${i}`, createdAt: local(11, 5, 9) + i * 60_000 }, { role: 'assistant' as const, content: `a${i}`, createdAt: local(11, 5, 9) + i * 60_000 + 1000 });
  for (let i = 0; i < 5; i++) messages.push({ role: 'user' as const, content: `v${i}`, createdAt: local(11, 6, 9) + i * 60_000 });
  const found = suggestMoments(messages, 17);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.at, local(11, 5, 9));
  assert.deepEqual(Object.keys(found[0]!).sort(), ['at', 'id', 'users']);
});

// ---- analysis ---------------------------------------------------------------------------------------------------------------------

test('style numbers: per reply questions, ellipses, exclamations, her catchphrases and address; comparison against W with a 20 percent line', () => {
  const earlier = ['哎呀，今天怎么样', '哎呀，真的吗', '哎呀，别急', '小糖，吃饭了吗', '小糖，早点睡'];
  const profile = { catchphrases: catchphrases(earlier), addresses: addressForms(earlier) };
  assert.ok(profile.catchphrases.includes('哎呀'));
  assert.ok(profile.addresses.includes('小糖'));
  const w = styleNumbers(['哎呀，真的吗？……', '小糖，好呀！'], profile);
  assert.equal(w.questions, 0.5); assert.equal(w.ellipses, 1); assert.equal(w.exclamations, 0.5); assert.ok(w.addresses >= 0.5);
  const same = compareStyle(w, w);
  assert.ok(same.every(item => item.within));
  const longer = compareStyle({ ...w, avgChars: w.avgChars * 2 }, w);
  assert.equal(longer.find(item => item.metric === 'avgChars')!.within, false);
  assert.equal(longer.find(item => item.metric === 'questions')!.within, true);
});

test('running jokes: born in the warm-up (both sides, at least twice, rare in the earlier chat) and picked up later', () => {
  const warm = [
    { user: '今天又是香菜战争', assistant: '香菜战争还没完呢' },
    { user: '我吃了牛肉面', assistant: '牛肉面好呀' },
    { user: '香菜战争第二回合', assistant: '好，第二回合开始' },
  ];
  const jokes = extractJokes(warm, ['牛肉面是我常吃的', '牛肉面，牛肉面，牛肉面']);
  assert.ok(jokes.some(joke => joke.includes('香菜战争')), '香菜战争 is a joke');
  assert.ok(!jokes.some(joke => joke.includes('牛肉面')), '牛肉面 is an old word');
  const pick = jokePickup(['哈哈，香菜战争又来了', '好的'], jokes);
  assert.equal(pick.replies, 1); assert.ok(pick.jokes >= 1); assert.equal(pick.total, jokes.length);
  assert.deepEqual(jokePickup(['没有'], jokes), { jokes: 0, replies: 0, total: jokes.length });
});

test('reviewer prompt hides the arms: only labels 甲乙丙丁, a key on our side; the parser reads fenced or fake answers and rejects bad shapes', () => {
  const key = shuffleSegments(DRIFT_ARMS, 7);
  assert.deepEqual(Object.keys(key).sort(), [...SEGMENT_LABELS].sort());
  assert.deepEqual(Object.values(key).sort(), ['C', 'R', 'R0', 'W']);
  assert.deepEqual(shuffleSegments(DRIFT_ARMS, 7), key, 'same seed, same order');
  const segments = Object.fromEntries(Object.entries(key).map(([label, arm]) => [label, [{ user: `用户说 ${arm}-密码`, assistant: `她答 ${arm}-密码` }]]));
  const prompt = buildReviewPrompt({ persona: '她是小糖', warm: [{ user: '热身用户', assistant: '热身她' }], segments });
  for (const name of ['不换', '换进程', '被压缩', '笔记']) assert.ok(!prompt.includes(name), `no arm name ${name}`);
  for (const label of SEGMENT_LABELS) assert.ok(prompt.includes(`"${label}"`));
  const fake = parseReview(fakeReviewAnswer());
  assert.equal(fake.segments.length, 4); assert.ok(fake.segments.every(segment => !segment.changed));
  const fenced = '这是结果：\n```json\n' + JSON.stringify({ segments: SEGMENT_LABELS.map((id, i) => ({ id, changed: i === 1, lines: i === 1 ? [3] : [], what: '更冷了' })) }) + '\n```';
  const parsed = parseReview(fenced);
  const byArm = reviewedArms(parsed, key);
  assert.equal(Object.values(byArm).filter(item => item?.changed).length, 1);
  assert.throws(() => parseReview('没有 JSON'), /JSON/u);
  assert.throws(() => parseReview(JSON.stringify({ segments: [{ id: '甲', changed: false }] })), /覆盖/u);
  assert.throws(() => parseReview(JSON.stringify({ segments: [{ id: '戊', changed: false }] })), /格式/u);
});

test('reading sheet: one page per moment, shuffled slots, no arm names, a free-text box; ties and notes tally', () => {
  const arms = Object.fromEntries(DRIFT_ARMS.map(arm => [arm, [{ user: `u-${arm}`, assistant: `a-${arm}` }]]));
  const { items, key } = buildDriftSheet([{ id: 'm01', context: [{ role: 'user', text: '热身最后一句' }], arms }, { id: 'm02', context: [], arms: { W: [{ user: 'x', assistant: 'y' }] } }], 5);
  assert.equal(items.length, 1, 'a moment with a single arm is not a page');
  assert.equal(items[0]!.options.length, 4);
  assert.deepEqual(Object.values(key.pages[0]!.slots).sort(), ['C', 'R', 'R0', 'W']);
  const html = driftSheetHtml(items);
  assert.ok(html.includes('<textarea id="note"') && html.includes('state.notes[ITEMS[at].page]=this.value') && html.includes('i138-ranks'));
  assert.ok(!html.includes('换进程') && !html.includes('被压缩'));
  const slotOf = (arm: string) => Object.entries(key.pages[0]!.slots).find(([, value]) => value === arm)![0];
  const ranks = { ranks: { m01: { [slotOf('W')]: 1, [slotOf('R')]: 1, [slotOf('R0')]: 2, [slotOf('C')]: 3 } }, notes: { m01: '都像她' } };
  const tally = tallyDriftRanks(ranks, key);
  assert.equal(tally.ranked, 1); assert.equal(tally.notes, 1);
  assert.deepEqual([tally.meanRank.W, tally.meanRank.R, tally.meanRank.R0, tally.meanRank.C], [1, 1, 2, 3]);
  assert.deepEqual(tally.pairs['R>W'], { better: 0, worse: 0, tied: 1 });
  assert.equal(tally.worst.C, 1);
});

test('question 1: characters to tokens counts fresh, cached and cache-written input; projection against the 1M window and the compaction line', () => {
  assert.equal(tokenRatio([]), null);
  const ratio = tokenRatio([{ promptChars: 1000, inputTokens: 100, cacheReadTokens: 400, cacheCreationTokens: 500 }, { promptChars: 2000, inputTokens: 2000, cacheReadTokens: 0, cacheCreationTokens: 0 }])!;
  assert.equal(ratio.samples, 2); assert.equal(ratio.tokensPerChar, 1); assert.equal(ratio.min, 1);
  const projection = projectSessionTokens(ratio, 120_000);
  assert.deepEqual([projection.tokens, projection.ofContext], [120_000, 0.12]);
});

test('process tap: the app arguments stay as they are; persisted drops only the no-persistence flag; fork also enables slash commands and resumes the warm session', () => {
  const args = ['-p', '--disable-slash-commands', '--no-session-persistence', '--setting-sources', '', '--system-prompt', 'x', '--model', 'opus'];
  assert.deepEqual(new ProcessTap('plain').variantArguments(args), args);
  assert.deepEqual(new ProcessTap('persisted').variantArguments(args), args.filter(arg => arg !== '--no-session-persistence'));
  const fork = new ProcessTap('fork', 'sess-1').variantArguments(args);
  assert.ok(!fork.includes('--disable-slash-commands') && !fork.includes('--no-session-persistence'));
  assert.deepEqual(fork.slice(-3), ['--resume', 'sess-1', '--fork-session']);
  assert.throws(() => new ProcessTap('fork').variantArguments(args), /session id/u);
});

// ---- a synthetic chat, the fake Claude end to end ------------------------------------------------------------------------------------

const SCOPE = { characterId: 'char-1', providerScope: 'prov-1' };
async function fixture(): Promise<{ dir: string; atOf: (index: number) => number; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'i138-test-snapshot-'));
  const store = new MemoryStore(dir);
  await store.load();
  const times: number[] = [];
  for (let i = 0; i < 12; i++) times.push(local(11, 5, 20, i));
  for (let i = 0; i < 12; i++) times.push(local(11, 6, 9, i));
  for (const [i, at] of times.entries()) {
    const id = `t${i}`;
    await store.beginTurn(SCOPE, { id, userText: `第${i}件事，我吃了牛肉面`, at, conversationId: 'conv' });
    await store.appendAssistant(SCOPE, id, `嗯，第${i}件，听起来不错`, at + 1000);
    await store.finishTurn(SCOPE, id, 'complete', at + 2000);
  }
  await store.seal(SCOPE); await store.flush();
  return { dir, atOf: index => times[index]!, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const history = (prompt: string): { role: string; content: string }[] => {
  const start = prompt.lastIndexOf('<conversation-data>\n'), end = prompt.lastIndexOf('\n</conversation-data>');
  return JSON.parse(prompt.slice(start + '<conversation-data>\n'.length, end)).history;
};

async function runFake(options: { points?: number[]; warmup?: number; next?: number; cap?: number; resume?: boolean; out: string; dump?: string; snapshotDir: string; atOf: (i: number) => number; askNote?: Parameters<typeof runDrift>[0]['askNote']; seed?: number }) {
  const snapshot = await loadSnapshot(options.snapshotDir);
  const cap = new CallCap(options.cap ?? 1000);
  const dump = options.dump;
  try {
    const result = await runDrift({
      engine: { snapshot, card: FIDELITY_CARDS[0]!, model: '', binary: process.execPath, binaryArgs: [FAKE], cap, prewarmMs: 0,
        ...(dump ? { promptDump: (name: string, prompt: string) => writeFile(path.join(dump, `${name}.txt`), prompt, 'utf8') } : {}) },
      points: (options.points ?? [12]).map((index, order) => ({ id: `m0${order + 1}`, at: options.atOf(index) })), settings: { warmup: options.warmup ?? 3, next: options.next ?? 2, review: true },
      seed: options.seed ?? 9, out: options.out, resume: options.resume ?? false, fake: true, cap,
      askNote: options.askNote ?? fakeAsk(cap, '笔记', () => '（假笔记）我是她，我记得你喜欢牛肉面。'), askReview: fakeAsk(cap, '审查', () => fakeReviewAnswer()),
    });
    return { ...result, cap, snapshot };
  } finally { await snapshot.close(); }
}

test('fake end to end: one warm-up, four arms from it; R is the app-way rebuild, R0 differs only by the note, W continues live, C is forked and compacted', async () => {
  const fx = await fixture();
  const out = await mkdtemp(path.join(os.tmpdir(), 'i138-test-out-'));
  const dump = path.join(out, 'prompts');
  await mkdir(dump);
  const log = path.join(out, 'fake-log.jsonl');
  process.env.I138_FAKE_LOG = log;
  try {
    const run = await runFake({ out, dump, snapshotDir: fx.dir, atOf: fx.atOf });
    assert.equal(run.stopped, null);
    const moment = run.state.moments[0]!;
    assert.ok(moment.done);
    assert.equal(moment.warm.length, 3);
    assert.deepEqual(Object.keys(moment.arms).sort(), ['C', 'R', 'R0', 'W']);
    for (const arm of DRIFT_ARMS) assert.equal(moment.arms[arm]!.length, 2, arm);
    // Calls: note 1 + warm-up 3 + compaction 1 + 4 x 2 + review 1.
    assert.equal(run.cap.used, 1 + 3 + 1 + 8 + 1);
    assert.equal(run.cap.used, plannedCalls({ warmup: 3, next: 2, moments: 1, review: true, q1Calls: 0 }).total);
    // Who opened a session and who continued one.
    assert.equal(moment.arms.W![0]!.opening, false, 'W: same live process, a follow-up turn');
    assert.equal(moment.arms.W![0]!.sessionTurn, 4, 'W: turn 4 of the warm process');
    assert.equal(moment.arms.R![0]!.opening, true); assert.equal(moment.arms.R![0]!.sessionTurn, 1);
    assert.equal(moment.arms.R0![0]!.opening, true);
    assert.equal(moment.arms.C![0]!.opening, false, 'C: the forked session carries what the warm one knew (reuse: ' + moment.arms.C![0]!.reuse + ')');
    // The fork asked for what the docs say: resume the warm session, fork it, slash commands on, persistence on; the warm process was persisted.
    const starts = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const fork = starts.filter(item => item.fork);
    assert.equal(fork.length, 1);
    assert.ok(fork[0].resumed && fork[0].slashCommands && fork[0].persistence);
    const plain = starts.filter(item => !item.fork);
    assert.ok(plain.every(item => !item.slashCommands), 'every non-fork process keeps the app flag that turns slash commands off');
    assert.ok(plain.some(item => item.persistence) && plain.some(item => !item.persistence), 'the warm process is persisted (so it can be forked); R and R0 run the app plain form');
    // R rebuilds from the archive the app's way: today + 60 earlier, the real chat before the point plus the warm-up turns as generated; nothing of W's or C's turns.
    const base = run.snapshot.messages.filter(message => message.createdAt < fx.atOf(12));
    const archive = moment.warm.flatMap((rec, i) => [{ role: 'user' as const, content: rec.user, createdAt: fx.atOf(12 + i) }, { role: 'assistant' as const, content: rec.text, createdAt: fx.atOf(12 + i) + 1 }]);
    const expected = buildLongChatWindow({ messages: [...base, ...archive], current: { content: moment.arms.R![0]!.user, createdAt: fx.atOf(15) }, now: fx.atOf(15), knobs: LONG_CHAT_KNOBS });
    const promptR = await readFile(path.join(dump, 'm01-R-4.txt'), 'utf8'), promptR0 = await readFile(path.join(dump, 'm01-R0-4.txt'), 'utf8');
    assert.deepEqual(history(promptR), expected.history);
    assert.deepEqual(history(promptR0), expected.history, 'R0 sees the same window');
    assert.equal(history(promptR).length, 24 + 6);
    assert.ok(promptR.includes(OPENING_NOTE_HEADER) && promptR.includes(moment.note));
    assert.ok(!promptR0.includes(OPENING_NOTE_HEADER) && !promptR0.includes('我记得你喜欢牛肉面'), 'R0 has no note');
    assert.equal(promptR.length - promptR0.length, OPENING_NOTE_HEADER.length + 1 + moment.note.length + 2, 'the note is the only difference');
    // The reviewer's prompt and answer, the sheet, the metrics: private files, numbers in the metrics.
    assert.ok(moment.review!.answer!.segments.length === 4);
    const reviewPrompt = await readFile(path.join(out, 'review', 'm01-prompt.txt'), 'utf8');
    assert.ok(!reviewPrompt.includes('被压缩') && !reviewPrompt.includes('换进程'));
    const items = JSON.parse(await readFile(path.join(out, 'items.json'), 'utf8'));
    assert.equal(items.length, 1); assert.equal(items[0].options.length, 4);
    const metrics = await readFile(path.join(out, 'metrics.md'), 'utf8');
    assert.ok(metrics.includes('R0 换进程不带笔记') && metrics.includes('第一道关'));
    for (const rec of Object.values(moment.arms).flat()) assert.ok(!metrics.includes(rec!.text) || rec!.text.length < 4, 'the metrics file carries numbers, not her words');
    // The saved state resumes: a finished moment is kept and costs nothing.
    const again = await runFake({ out, snapshotDir: fx.dir, atOf: fx.atOf, resume: true });
    assert.equal(again.cap.used, 14, 'nothing was called again');
    assert.equal(again.state.moments[0]!.warm[0]!.text, moment.warm[0]!.text);
  } finally { delete process.env.I138_FAKE_LOG; await fx.cleanup(); await rm(out, { recursive: true, force: true }); }
});

test('cap: a run that would pass it is refused before any call; a cap reached mid-moment stops with what finished saved', async () => {
  const fx = await fixture();
  const out = await mkdtemp(path.join(os.tmpdir(), 'i138-test-out-'));
  try {
    await assert.rejects(runFake({ out, snapshotDir: fx.dir, atOf: fx.atOf, cap: 13 }), /超过上限 13/u);
    assert.equal(await loadDriftState(out), null, 'refused before anything was written');
    const snapshot = await loadSnapshot(fx.dir);
    const cap = new CallCap(7);
    const saved: MomentState[] = [];
    try {
      await assert.rejects(runMoment({ snapshot, card: FIDELITY_CARDS[0]!, model: '', binary: process.execPath, binaryArgs: [FAKE], cap }, { id: 'm01', at: fx.atOf(12) },
        { settings: { warmup: 3, next: 2, review: true }, seed: 1, arms: DRIFT_ARMS, askNote: fakeAsk(cap, '笔记', () => '笔记'), askReview: fakeAsk(cap, '审查', () => fakeReviewAnswer()),
          save: async state => { saved.push(structuredClone(state)); } }), /7 次调用上限/u);
    } finally { await snapshot.close(); }
    assert.equal(cap.used, 7, 'note + 3 warm-up + compaction + 2 turns, then stopped');
    assert.equal(saved.at(-1)!.warm.length, 3);
  } finally { await fx.cleanup(); await rm(out, { recursive: true, force: true }); }
});

test('resume: an interrupted moment is redone from its warm-up, finished moments are kept, calls are counted across both runs', async () => {
  const fx = await fixture();
  const out = await mkdtemp(path.join(os.tmpdir(), 'i138-test-out-'));
  try {
    let notes = 0;
    const failing = (cap: CallCap) => fakeAsk(cap, '笔记', () => { if (++notes === 2) throw new Error('simulated 429 rate limit'); return '（假笔记）一页'; });
    const snapshot = await loadSnapshot(fx.dir);
    const cap = new CallCap(200);
    let first;
    try {
      first = await runDrift({
        engine: { snapshot, card: FIDELITY_CARDS[0]!, model: '', binary: process.execPath, binaryArgs: [FAKE], cap }, points: [{ id: 'm01', at: fx.atOf(12) }, { id: 'm02', at: fx.atOf(13) }],
        settings: { warmup: 3, next: 2, review: true }, seed: 3, out, resume: false, fake: true, cap, askNote: failing(cap), askReview: fakeAsk(cap, '审查', () => fakeReviewAnswer()),
      });
    } finally { await snapshot.close(); }
    assert.match(first.stopped ?? '', /429/u);
    assert.equal(first.state.moments.length, 1, 'moment 1 done, moment 2 not');
    const usedBefore = cap.used;
    const warmText = first.state.moments[0]!.warm[0]!.text;
    const second = await runFake({ out, snapshotDir: fx.dir, atOf: fx.atOf, resume: true, points: [12, 13], cap: 200, seed: 3 });
    assert.equal(second.stopped, null);
    assert.equal(second.state.moments.length, 2);
    assert.equal(second.state.moments[0]!.warm[0]!.text, warmText, 'moment 1 untouched');
    assert.equal(second.cap.used, usedBefore + 14, 'only the second moment was called');
  } finally { await fx.cleanup(); await rm(out, { recursive: true, force: true }); }
});

test('question 1 helper: one call per point, characters to tokens from what the fake reports (input tokens are the prompt length there)', async () => {
  const fx = await fixture();
  const out = await mkdtemp(path.join(os.tmpdir(), 'i138-test-out-'));
  try {
    const snapshot = await loadSnapshot(fx.dir);
    const cap = new CallCap(5);
    try {
      const result = await measureTokens({ snapshot, card: FIDELITY_CARDS[0]!, model: '', binary: process.execPath, binaryArgs: [FAKE], cap }, [{ id: 'm01', at: fx.atOf(12) }, { id: 'm02', at: fx.atOf(15) }], 40_000, out);
      assert.equal(cap.used, 2);
      assert.equal(result.samples.length, 2);
      assert.equal(result.ratio!.tokensPerChar, 1);
      assert.equal(result.projection!.tokens, LONG_CHAT_KNOBS.sessionMaxChars);
      assert.ok((await readFile(path.join(out, 'q1.json'), 'utf8')).includes('tokensPerChar'));
    } finally { await snapshot.close(); }
  } finally { await fx.cleanup(); await rm(out, { recursive: true, force: true }); }
});

test('transcripts: only the throwaway session folders of the experiment are removed from Claude Code\'s projects folder', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'i138-home-'));
  try {
    const cwd = path.join(os.tmpdir(), 'soft-hearts-claude', 'claude-chat', 'session-abc');
    const name = path.resolve(cwd).replace(/[^A-Za-z0-9]/gu, '-');
    await mkdir(path.join(home, 'projects', name), { recursive: true });
    await mkdir(path.join(home, 'projects', 'someone-elses-project'), { recursive: true });
    assert.equal(await removeTranscripts([cwd, path.join(os.tmpdir(), 'not-a-session')], home), 1);
    assert.deepEqual(await readdir(path.join(home, 'projects')), ['someone-elses-project']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('cli: --dry-run prints the planned calls and calls nothing (no snapshot, no Claude)', () => {
  const run = spawnSync(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'scripts', 'i138-restart-drift.ts'), '--dry-run', '--moments', '3', '--q1-calls', '3'],
    { encoding: 'utf8', env: { ...process.env, CLAUDE_PATH: path.join(os.tmpdir(), 'no-such-claude') } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /合计 108 次调用（上限 115）/u);
  assert.match(run.stdout, /热身（每个时刻 12 次）：36 次/u);
  const refused = spawnSync(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'scripts', 'i138-restart-drift.ts'), '--dry-run', '--moments', '4', '--max-calls', '100'], { encoding: 'utf8' });
  assert.match(refused.stdout, /超过上限/u);
  const repo = spawnSync(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'scripts', 'i138-restart-drift.ts'), '--snapshot', os.tmpdir(), '--out', path.join(root, 'docs', 'x'), '--fake'], { encoding: 'utf8' });
  assert.notEqual(repo.status, 0);
  assert.match(repo.stderr, /仓库|repository|OneDrive/u);
});

test('remainingPlan: counts only the moments not done', () => {
  const cap = new CallCap(30);
  assert.deepEqual(remainingPlan({ points: [{ id: 'a', at: 1 }, { id: 'b', at: 2 }], settings: { warmup: 3, next: 2, review: true }, cap }, new Set(['a'])), { moments: 1, calls: 14 });
  assert.throws(() => remainingPlan({ points: [{ id: 'a', at: 1 }, { id: 'b', at: 2 }, { id: 'c', at: 3 }], settings: { warmup: 3, next: 2, review: true }, cap }, new Set()), /超过上限/u);
});
