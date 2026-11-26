// I-071 v2 第三步, fix 6 after the sixth isolated test of the user's card (every word here is synthetic):
//  A. a long call is cut by silence (idle) plus a generous overall cap, only for the conversion's own calls; memory batches are
//     half as big; a failed call is asked once more with the same input, a second failure stops the conversion as before;
//  B. the failure says plainly that the original is untouched, nothing is left behind and converting again is fine;
//  C. names from her memories that are not offered come to the assistant as bounded candidates (data, not instructions), and only
//     the user's own words can make an extra name "by: user";
//  D. full-width punctuation in the assistant's Chinese text and button labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeFailureError, streamClaude } from '../electron/brain/claude';
import { CONVERSION_CLAUDE_LIMITS } from '../electron/cards/character-convert/model';
import { MAX_CANDIDATES_PEOPLE, MAX_CANDIDATES_QUOTED, findCandidateNames } from '../electron/cards/character-convert/addresses';
import { ConversionCallError, askModel, batches, plannedCalls, type MemoryItem } from '../electron/cards/character-convert/translate';
import { conversionSummary } from '../electron/cards/character-convert/tools';
import { CONVERSION_LIMITS, CONVERSION_UNTOUCHED_NOTE, enforceExtraBy } from '../shared/cards/character-convert';
import { fullWidthChinese } from '../shared/foundation/fullwidth-punctuation';
import { manualClock, type ManualClock } from './helpers/manual-clock';
import { ALL_KEPT, filesOf, makeFixture, makeTranslator, FIXTURE_TERMS, withDirectory, type Fixture } from './helpers/convert-fixture';

// ---- A. calls that stream ---------------------------------------------------------------------------------------------------------

/** A fake `claude`: "#steady" writes a delta every 150 ms for 1.5 s then finishes; "#stall" writes one delta and goes quiet; "#forever" never stops writing. */
const fakeSource = String.raw`
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
const delta = text => out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk; let i;
  while ((i = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
});
function handle(message) {
  if (message.type !== "user") return;
  const text = message.message.content.map(block => block.text || "").join("");
  out({ type: "system", subtype: "init", tools: [], mcp_servers: [] });
  delta("a");
  if (text.includes("#stall")) { setInterval(() => {}, 1000); return; }
  let n = 0;
  const timer = setInterval(() => {
    delta("b");
    if (!text.includes("#forever") && ++n >= 10) { clearInterval(timer); out({ type: "result", subtype: "success", is_error: false, result: "ab" }); process.exit(0); }
  }, 150);
}
`;
async function fakeClaude(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-fix6-claude-'));
  const script = path.join(directory, 'fake-claude.cjs');
  await writeFile(script, fakeSource);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return script;
}
const task = (prompt: string) => ({ kind: 'chat' as const, model: 'haiku', workingDirectory: os.tmpdir(), writable: false, prompt, imageDataUrls: [] });
/** Runs a call whose idle and overall limits are on `clock` (the fake child itself is real); `onEmit` sees every piece of output as it arrives. */
const run = (script: string, prompt: string, limits: { idleTimeoutMs?: number; overallTimeoutMs?: number }, clock: ManualClock, onEmit: () => void = () => {}) =>
  streamClaude(task(prompt), new AbortController().signal, () => onEmit(), process.execPath, [script], { ...limits, timers: clock.timers }).then(() => null, error => error as Error);
const until = async (ok: () => boolean) => { while (!ok()) await new Promise(resolve => setTimeout(resolve, 5)); };

// The idle and overall limits run on a manual clock: under load the old 700 ms real window could run out before node had even started
// the fake child, so a call that was alive got cut. Now only advance() moves those limits.
test('a call that keeps writing outlives the idle time; one that goes quiet is stopped at it; the overall cap still ends a call that never stops', { timeout: 30_000 }, async t => {
  const script = await fakeClaude(t);
  // steady output: every piece moves the clock 600 ms (idle window 700). Alive the whole time, so it finishes: ~6 s passed, far over 700.
  const steadyClock = manualClock();
  assert.equal(await run(script, '#steady', { idleTimeoutMs: 700, overallTimeoutMs: 20_000 }, steadyClock, () => steadyClock.advance(600)), null);
  // one delta, then silence: real time passing does nothing (the clock is ours); the idle window stops it exactly when the clock reaches it
  const quietClock = manualClock();
  let pieces = 0, settled = false;
  const quietCall = run(script, '#stall', { idleTimeoutMs: 700, overallTimeoutMs: 20_000 }, quietClock, () => { pieces++; }).then(error => { settled = true; return error; });
  await until(() => pieces > 0);
  assert.equal(quietClock.pending, 2, 'the idle window and the overall cap are both on the clock (a call that ignores it would leave 0)');
  await new Promise(resolve => setTimeout(resolve, 1_000)); // "never happened" check: more real time than the idle window, still alive
  assert.equal(settled, false, 'the idle window runs on the clock, not on real time');
  quietClock.advance(699);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(settled, false, 'just under the window: still alive');
  quietClock.advance(1);
  const quiet = await quietCall;
  assert.ok(quiet instanceof ClaudeFailureError, String(quiet));
  assert.match(quiet.message, /超时/);
  // writing forever: each piece feeds the idle window (600 ms steps), so only the overall cap can end it
  const foreverClock = manualClock();
  const forever = await run(script, '#forever', { idleTimeoutMs: 700, overallTimeoutMs: 1_200 }, foreverClock, () => foreverClock.advance(600));
  assert.ok(forever instanceof ClaudeFailureError && /超时/.test(forever.message), String(forever));
});

test('the conversion\'s calls are given an idle window and a cap above the old fixed 120 s; nothing else is changed', () => {
  assert.ok(CONVERSION_CLAUDE_LIMITS.idleTimeoutMs >= 30_000 && CONVERSION_CLAUDE_LIMITS.idleTimeoutMs <= 120_000);
  assert.ok(CONVERSION_CLAUDE_LIMITS.overallTimeoutMs > 120_000 && CONVERSION_CLAUDE_LIMITS.overallTimeoutMs <= 10 * 60_000);
});

const note = (key: string, chars: number): MemoryItem => ({ k: key, kind: 'note', v: { title: 't', summary: '字'.repeat(chars), people: [], things: [], mood: '', plans: [], tags: ['t'] } });

test('memory batches are about half the old size (4500 source characters, not 9000)', () => {
  assert.equal(CONVERSION_LIMITS.batchChars, 4_500);
  const items = Array.from({ length: 6 }, (_, index) => note(`n${index}`, 1_400)); // ~1.5k each with its JSON: 3 per batch now, 6 per batch before
  assert.deepEqual(batches(items).map(group => group.length), [3, 3]);
  assert.equal(plannedCalls(items), 3, 'the persona call plus two batches: the cost line counts these');
});

test('askModel: a failed call is asked once more with the same input; two failures are one ConversionCallError; a stop is never asked again', async () => {
  const seen: string[] = [];
  let failures = 1;
  const flaky = async (prompt: string) => { seen.push(prompt); if (failures-- > 0) throw new Error('Claude 回复超时，已停止。'); return 'fine'; };
  assert.equal(await askModel(flaky, 'P', 'S', new AbortController().signal), 'fine');
  assert.deepEqual(seen, ['P', 'P']);
  failures = 5; seen.length = 0;
  await assert.rejects(askModel(flaky, 'Q', 'S', new AbortController().signal), (error: Error) => {
    assert.ok(error instanceof ConversionCallError);
    assert.match(error.message, /回得太慢/);
    assert.ok(error.message.includes(CONVERSION_UNTOUCHED_NOTE));
    assert.ok(error.message.length <= 300);
    return true;
  });
  assert.deepEqual(seen, ['Q', 'Q'], 'exactly one more try');
  const controller = new AbortController();
  let calls = 0;
  const stopped = async () => { calls++; controller.abort(); throw new Error('aborted by the user'); };
  await assert.rejects(askModel(stopped, 'R', 'S', controller.signal), (error: unknown) => !(error instanceof ConversionCallError));
  assert.equal(calls, 1);
  // a message that carries a path never reaches the user
  const leaky = async () => { throw new Error('spawn C:\\Users\\someone\\claude.exe failed'); };
  await assert.rejects(askModel(leaky, 'S', 'S', new AbortController().signal), (error: Error) => !/Users|someone/.test(error.message) && error.message.includes(CONVERSION_UNTOUCHED_NOTE));
});

const LEFT_OUT = [ALL_KEPT[0]!, { id: 'her-nickname', to: '' }, { id: 'user-nickname', to: '' }];
const convert = async (fixture: Fixture) => {
  await fixture.service.start({ characterId: fixture.sourceId, language: 'en', names: LEFT_OUT });
  await fixture.service.idle();
  return fixture.service.view()!;
};

test('one slow batch no longer voids the conversion: its call is asked again and the conversion goes on', async () => withDirectory(async directory => {
  const base = makeTranslator(FIXTURE_TERMS);
  let calls = 0, slow = 0;
  const model = async (prompt: string, system: string, signal: AbortSignal) => {
    calls++;
    if (!system.includes('character card') && slow++ === 0) throw new Error('Claude 回复超时，已停止。'); // the first memory call times out once
    return base(prompt, system, signal);
  };
  const fixture = await makeFixture(directory, { model });
  const planned = (await fixture.service.preview(fixture.sourceId, 'en')).calls;
  const done = await convert(fixture);
  assert.equal(done.state, 'done', done.error);
  assert.equal(calls, planned + 1, 'the planned calls plus the one retry');
}));

test('a batch that fails twice stops the conversion with the plain message, and nothing is left behind', async () => withDirectory(async directory => {
  const base = makeTranslator(FIXTURE_TERMS);
  const model = async (prompt: string, system: string, signal: AbortSignal) => {
    if (!system.includes('character card')) throw new Error('Claude 回复超时，已停止。');
    return base(prompt, system, signal);
  };
  const fixture = await makeFixture(directory, { model });
  const before = await filesOf(directory);
  const done = await convert(fixture);
  assert.equal(done.state, 'failed');
  assert.match(done.error!, /^Claude 这次回得太慢，等了很久没有新内容。原来的角色一点没动，也没有留下半成品；直接再转一次就行，刚才选的名字可以照用。$/);
  assert.doesNotMatch(done.error!, /^Claude 回复超时，已停止。$/);
  assert.match(String(conversionSummary(done).note), /原来的角色一点没动/);
  const after = await filesOf(directory);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [file, bytes] of before) assert.ok(bytes.equals(after.get(file)!), file);
  assert.equal(await stat(path.join(directory, 'character-convert')).then(() => true, () => false), false);
}));

// ---- C. candidates, and who added an extra name -------------------------------------------------------------------------------------

test('candidates: frequent names from the notes\' people lists and short quoted words, not what is offered, bounded, never roles', () => {
  const people = ['团宝', '团宝', '团宝', '小团', '小团', '小团', '用户', '用户', '妈妈', '妈妈', '阿澄', '阿澄', '偶尔一次', '周哥的朋友', '周哥的朋友', ...Array.from({ length: 9 }, (_, i) => `路人${i}`).flatMap(name => [name, name])];
  const texts = ['她说“笨笨团”，用户笑了。', '又叫“笨笨团”。', '“好的”', '「大小姐」这个称呼', '用户说「大小姐」', '“你好，世界”和“你好，世界”', '“12点”“12点”'];
  const found = findCandidateNames(texts, people, ['阿澄', '路人0']);
  const names = found.map(item => item.text);
  assert.ok(names.includes('团宝') && names.includes('小团'), names.join());
  assert.ok(names.includes('笨笨团') && names.includes('大小姐'), names.join());
  assert.ok(!names.includes('阿澄') && !names.includes('路人0'), 'offered names are left out');
  assert.ok(!names.includes('用户') && !names.includes('妈妈') && !names.includes('周哥的朋友') && !names.includes('偶尔一次'), 'roles, "X的…" and once-only names are not candidates');
  assert.ok(!names.some(name => /，|12/.test(name)), 'a sentence or a number is not a name');
  assert.deepEqual(found.find(item => item.text === '团宝'), { text: '团宝', uses: 3, source: 'people' });
  assert.equal(found.filter(item => item.source === 'people').length, MAX_CANDIDATES_PEOPLE);
  assert.ok(found.filter(item => item.source === 'quoted').length <= MAX_CANDIDATES_QUOTED);
  assert.equal(new Set(names.map(name => name.toLocaleLowerCase())).size, names.length, 'each once');
  assert.deepEqual(findCandidateNames([], [], []), []);
});

test('the service puts the candidates into the preview (data the assistant reads)', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  const preview = await fixture.service.preview(fixture.sourceId, 'en');
  assert.ok(Array.isArray(preview.candidates));
}));

test('only the user\'s own typed words can make an extra name "by: user"; every other item is the assistant\'s own find', () => {
  const args = { characterId: 'a', language: 'en', names: [], extra: [
    { kind: 'alias', from: '小笨', to: '', by: 'user' },
    { kind: 'alias', from: '团宝', to: '', by: 'user' },
    { kind: 'term', from: 'Ember', to: '星火', by: 'user' },
    { kind: 'term', from: '月影', to: 'Moonshade' },
    { kind: 'term', from: '星火', to: 'Ember', by: 'assistant' },
  ] };
  const out = enforceExtraBy(args, ['还有一个叫“小笨”的称呼', 'the term is ember here']) as typeof args;
  assert.deepEqual(out.extra.map(item => [item.from, (item as { by?: string }).by]), [['小笨', 'user'], ['团宝', 'assistant'], ['Ember', 'user'], ['月影', 'assistant'], ['星火', 'assistant']]);
  assert.equal((args.extra[1] as { by?: string }).by, 'user', 'the input is not changed');
  assert.deepEqual(enforceExtraBy({ extra: 'x' }, []), { extra: 'x' });
  assert.equal(enforceExtraBy(null, []), null);
});

// ---- D. full-width punctuation --------------------------------------------------------------------------------------------------------

test('full-width marks between Han characters; code, links, numbers and English sentences stay as written', () => {
  assert.equal(fullWidthChinese('好的,要转吗?'), '好的，要转吗？');
  assert.equal(fullWidthChinese('注意:先看一下!再选。'), '注意：先看一下！再选。');
  assert.equal(fullWidthChinese('选项一, 选项二'), '选项一， 选项二');
  assert.equal(fullWidthChinese('“保留,原样”和「换成,英文」'), '“保留，原样”和「换成，英文」');
  assert.equal(fullWidthChinese('现在是12:30,可以'), '现在是12:30,可以');
  assert.equal(fullWidthChinese('看 https://example.com/a,b 这里,好'), '看 https://example.com/a,b 这里，好');
  assert.equal(fullWidthChinese('用 `a,b?` 这个,好'), '用 `a,b?` 这个，好');
  assert.equal(fullWidthChinese('Open 设置, then click: yes?'), 'Open 设置, then click: yes?');
  assert.equal(fullWidthChinese('Hello, how are you?'), 'Hello, how are you?');
  assert.equal(fullWidthChinese('```\nx = a,b\n```\n好吗?'), '```\nx = a,b\n```\n好吗？');
  assert.equal(fullWidthChinese(''), '');
});
