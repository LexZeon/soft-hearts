/**
 * I-023 haiku 调度台 (shared/module-router/, electron/module-router/) and 猜拳 on it (electron/rps/host.ts), with a fake haiku
 * on a fake clock: the module list comes from the registry; haiku runs beside Opus and never holds up her first character;
 * a newer message voids the older verdict; errors, timeouts and bad JSON change nothing; the local fast path never waits;
 * haiku's yes opens the game after her reply (by her character); a local refusal wins; the panel keeps no words.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
// @ts-expect-error -- a plain .mjs script without types (tests/knobs-table.test.mjs uses it the same way)
import { parseKnobFile, REPO_ROOT } from '../scripts/list-knobs.mjs';
import os from 'node:os';
import path from 'node:path';
import { ModuleRouter, type ModuleRouterOptions } from '../electron/module-router/router';
import { createModuleRouter } from '../electron/module-router/wiring';
import { RpsHost, type RpsCharacterState } from '../electron/rps/host';
import { RpsStore } from '../electron/rps/store';
import { createRps } from '../electron/rps/wiring';
import { MoodHost } from '../electron/mood';
import { ROUTER_SYSTEM_PROMPT, parseRouterAnswer, routerModuleList, routerPlan, routerPrompt, routerRegistryProblems } from '../shared/module-router/choose';
import { routerMessageOf, scriptedRouterAsk, noRouterAsk, type RouterAsk, type ScriptedAnswer } from '../shared/module-router/fake';
import type { ModuleRouterWhy, RoutedModule, RouterVerdict } from '../shared/module-router/interface';
import { MODULE_ROUTER_KNOBS } from '../shared/module-router/knobs';
import { ROUTED_MODULES } from '../shared/module-router/modules';
import { RPS_ROUTE, scanRpsRefusal, scanRpsRequest } from '../shared/rps-personality';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import { formatModuleRouterLines } from '../src/ui/MoodPanel';
import { seeded } from './helpers/seeded';

class Clock {
  now = Date.UTC(2026, 10, 4, 6, 0, 0); private timers: { at: number; fn: () => void; id: number }[] = []; private next = 0;
  readonly timerApi = { set: (fn: () => void, ms: number) => { const id = ++this.next; this.timers.push({ at: this.now + ms, fn, id }); return id; },
    clear: (id: unknown) => { this.timers = this.timers.filter(t => t.id !== id); } };
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const due = this.timers[0];
      if (!due || due.at > end) break;
      this.timers.shift(); this.now = Math.max(this.now, due.at); due.fn();
    }
    this.now = end;
  }
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
/** Time passes in 50 ms steps, promises settling in between (a fake haiku answers through the clock). */
async function run(clock: Clock, ms: number): Promise<void> { for (let t = 0; t < ms; t += 50) { clock.advance(Math.min(50, ms - t)); await flush(); } }
/** A fake haiku's wait on the fake clock (aborts like the real call). */
const waiter = (clock: Clock) => (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const id = clock.timerApi.set(resolve, ms);
  signal.addEventListener('abort', () => { clock.timerApi.clear(id); reject(new Error('aborted')); }, { once: true });
});
const yes = (confidence = 0.9) => JSON.stringify({ called: [{ module: 'rps', confidence }] });
const NATURAL = '我们来石头剪子布吧，输的请喝奶茶'; // the local words miss it (an extra clause), the hint words catch it
const VALUES = { D: 70, O: 50, E: 55, N: 50, C: 40 };

function router(clock: Clock, ask: RouterAsk, options: Partial<ModuleRouterOptions> = {}) {
  let developer = options.developerMode ? options.developerMode() : true, changed = 0;
  const r = new ModuleRouter({ ask, available: () => true, developerMode: () => developer, changed: () => { changed++; }, clock: () => clock.now, timers: clock.timerApi, ...options });
  return { r, setDeveloper: (on: boolean) => { developer = on; }, get changed() { return changed; } };
}

// ------------------------------------------------------------------ the registry and the list haiku gets

test('the module list haiku gets is built from the registry: a fake module registered shows up in the list and in the prompt', async () => {
  assert.deepEqual(routerRegistryProblems(ROUTED_MODULES), [], 'the app\'s registry is well-formed');
  assert.ok(ROUTED_MODULES.includes(RPS_ROUTE), '猜拳 is registered');
  const fake: RoutedModule = { id: 'fake-hug', name: '抱抱', handles: '让她张开手臂抱抱你。', calledWhen: '用户说要抱抱。', notCalled: '讲别人抱抱的事。', hints: /抱/u };
  const list = routerModuleList([...ROUTED_MODULES, fake]);
  assert.match(list, /- rps（猜拳）/u);
  assert.match(list, /- fake-hug（抱抱）\n {2}管什么：让她张开手臂抱抱你。\n {2}算叫它：用户说要抱抱。\n {2}不算：讲别人抱抱的事。/u);
  assert.doesNotMatch(routerModuleList(ROUTED_MODULES), /fake-hug/u, 'not registered: not in the list');
  // The prompt the router really sends carries the fake module and the message, and nothing else is added for it.
  const clock = new Clock(), prompts: string[] = [], systems: string[] = [];
  const { r } = router(clock, async (prompt, system) => { prompts.push(prompt); systems.push(system); return '{"called":[]}'; }, { registry: [...ROUTED_MODULES, fake] });
  r.userTurn('m1', '抱抱我嘛');
  await run(clock, 400);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /fake-hug（抱抱）/u); assert.match(prompts[0], /rps（猜拳）/u);
  assert.equal(routerMessageOf(prompts[0]), '抱抱我嘛', 'the very message, as data');
  assert.equal(prompts[0], routerPrompt([...ROUTED_MODULES, fake], '抱抱我嘛'), 'only the list and this one message');
  assert.equal(systems[0], ROUTER_SYSTEM_PROMPT);
  // A malformed registration is caught.
  assert.ok(routerRegistryProblems([fake, { ...fake }]).some(p => /两次/u.test(p)));
  assert.ok(routerRegistryProblems([{ ...fake, id: 'Bad Id' }]).some(p => /编号/u.test(p)));
  assert.ok(routerRegistryProblems([{ ...fake, hints: /抱/gu }]).some(p => /g \/ y/u.test(p)));
  r.dispose();
});

test('the router\'s knobs are in the "想改什么 → 改哪里" table ("她没反应" and "额度用得太多了" lead to the prefilter)', async () => {
  const text = await readFile(path.join(REPO_ROOT, 'shared', 'module-router', 'knobs.ts'), 'utf8');
  const { feature, knobs } = parseKnobFile(text) as { feature: string; knobs: { path: string; say: string }[] };
  assert.match(feature, /I-023/u);
  for (const name of Object.keys(MODULE_ROUTER_KNOBS)) assert.ok(knobs.some(knob => knob.path === `MODULE_ROUTER_KNOBS.${name}`), `${name} is in the table`);
  const prefilter = knobs.find(knob => knob.path.endsWith('.prefilter'))!;
  assert.match(prefilter.say, /她没反应/u); assert.match(prefilter.say, /额度/u);
});

test('haiku\'s answer is read strictly: exactly {"called":[{module, confidence}]}; anything else is a bad answer', () => {
  const reg = ROUTED_MODULES;
  assert.deepEqual(parseRouterAnswer('{"called":[{"module":"rps","confidence":0.82}]}', reg), [{ module: 'rps', confidence: 0.82 }]);
  assert.deepEqual(parseRouterAnswer('{"called":[]}', reg), []);
  assert.deepEqual(parseRouterAnswer('```json\n{"called":[]}\n```', reg), [], 'one ```json fence is tolerated');
  for (const bad of ['', 'rps', '好的，{"called":[]}', '{"called":[],"why":"x"}', '{"modules":[]}', '{"called":{}}', '[{"module":"rps","confidence":1}]',
    '{"called":[{"module":"dance","confidence":0.9}]}', '{"called":[{"module":"rps","confidence":1.2}]}', '{"called":[{"module":"rps","confidence":"0.9"}]}',
    '{"called":[{"module":"rps"}]}', '{"called":[{"module":"rps","confidence":0.9,"note":"x"}]}',
    '{"called":[{"module":"rps","confidence":0.9},{"module":"rps","confidence":0.8}]}', 'x'.repeat(2001)])
    assert.equal(parseRouterAnswer(bad, reg), null, bad.slice(0, 60));
  assert.equal(parseRouterAnswer(null, reg), null);
});

test('who is asked: the local words first (a request or a refusal needs no haiku), then the hint words; empty or long messages never', () => {
  const k = MODULE_ROUTER_KNOBS;
  assert.deepEqual(routerPlan(ROUTED_MODULES, '来玩猜拳吧', k), { asked: [], skipped: 'local', local: [{ module: 'rps', kind: 'called' }] });
  assert.deepEqual(routerPlan(ROUTED_MODULES, '不想玩石头剪刀布了', k), { asked: [], skipped: 'local', local: [{ module: 'rps', kind: 'refused' }] });
  assert.deepEqual(routerPlan(ROUTED_MODULES, NATURAL, k), { asked: ['rps'], skipped: null, local: [] });
  assert.deepEqual(routerPlan(ROUTED_MODULES, '今天好累啊', k), { asked: [], skipped: 'prefilter', local: [] });
  assert.deepEqual(routerPlan(ROUTED_MODULES, '今天好累啊', { ...k, prefilter: false }).asked, ['rps', 'nickname-her', 'nickname-user'], 'prefilter off: every message, every registered module');
  assert.equal(routerPlan(ROUTED_MODULES, '  ', k).skipped, 'empty');
  assert.equal(routerPlan(ROUTED_MODULES, `${'石头'.repeat(101)}`, k).skipped, 'long');
  // Natural ways to ask that the local words miss but the hint words keep (the trade-off is written in knobs.ts).
  for (const text of ['剪子包袱锤！', '来比划比划？', '猜丁壳来不来', '用猜拳决定谁洗碗', '出拳吧你', '我们决一胜负', 'rock paper scissors, now!', '石头剪刀布走起，输了你唱歌'])
    assert.deepEqual(routerPlan(ROUTED_MODULES, text, k).asked, ['rps'], text);
  // Refusals and requests the local words know.
  for (const text of ['不想玩了', '别玩了', '我不玩猜拳', '改天吧', '算了', '玩够了'])
    assert.ok(scanRpsRefusal(text), text);
  for (const text of ['要不要玩猜拳', '你来不来玩石头剪刀布，输了请吃饭', '别玩手机了，来石头剪刀布', '石头剪刀布！不许耍赖'])
    assert.equal(scanRpsRefusal(text), false, text);
  assert.ok(scanRpsRequest('来玩一把猜拳来'), 'the 11-04 phrase stays on the fast path');
});

// ------------------------------------------------------------------ the router on its own

test('haiku runs beside Opus: userTurn returns at once, haiku starts after the chat handler returned, Opus\'s first character does not wait', async () => {
  const clock = new Clock(), order: string[] = [];
  const ask: RouterAsk = (_p, _s, signal) => { order.push('haiku asked'); return waiter(clock)(4_000, signal).then(() => { order.push('haiku answered'); return yes(); }); };
  const { r } = router(clock, ask);
  const returned = r.userTurn('m1', NATURAL);
  assert.equal(returned, undefined, 'nothing to await');
  order.push('chat handler returned'); // main.ts then runs rps.host.chatTurn and launches the Opus turn
  assert.deepEqual(order, ['chat handler returned'], 'haiku is not even asked inside the handler');
  await flush();
  assert.deepEqual(order, ['chat handler returned'], 'nor in the same tick: its process start would hold the main thread');
  clock.timerApi.set(() => order.push('Opus turn written out'), 80);
  clock.timerApi.set(() => order.push('Opus first character'), 1_700);
  clock.timerApi.set(() => order.push('Opus reply done'), 3_200);
  await run(clock, 5_000);
  assert.deepEqual(order, ['chat handler returned', 'Opus turn written out', 'haiku asked', 'Opus first character', 'Opus reply done', 'haiku answered']);
  // The verdict asked when the reply was done (at 3.2 s) arrives when haiku answers (0.3 s start delay + 4 s), within the grace.
  const late = new ModuleRouter({ ask, available: () => true, developerMode: () => false, clock: () => clock.now, timers: clock.timerApi });
  late.userTurn('m2', NATURAL);
  await run(clock, 3_200);
  let verdict: RouterVerdict | null = null;
  void late.verdict('m2', 'rps').then(v => { verdict = v; });
  await run(clock, 1_000);
  assert.equal(verdict, null, 'still waiting at 4.2 s');
  await run(clock, 200);
  assert.deepEqual(verdict, { kind: 'called', confidence: 0.9, ms: MODULE_ROUTER_KNOBS.startDelayMs + 4_000 });
  r.dispose(); late.dispose();
});

test('a newer message voids the older verdict: its call is aborted, its waiters hear "superseded", the new one stands alone', async () => {
  const clock = new Clock(), signals: AbortSignal[] = [];
  const ask = scriptedRouterAsk(message => message === NATURAL ? { raw: yes(), after: 3_000 } : { raw: '{"called":[]}', after: 500 }, waiter(clock));
  const { r } = router(clock, (p, s, signal) => { signals.push(signal); return ask(p, s, signal); });
  r.userTurn('old', NATURAL);
  await run(clock, 1_000);
  const verdicts: RouterVerdict[] = [];
  void r.verdict('old', 'rps', 10_000).then(v => verdicts.push(v));
  r.userTurn('new', '石头太硬了');
  await flush();
  assert.equal(signals[0].aborted, true, 'the old call is stopped');
  assert.deepEqual(verdicts, [{ kind: 'unknown', reason: 'superseded' }]);
  assert.deepEqual(await r.verdict('old', 'rps'), { kind: 'unknown', reason: 'other-turn' }, 'asked again later: still void');
  await run(clock, 900);
  assert.deepEqual(await r.verdict('new', 'rps'), { kind: 'not-called', confidence: null, ms: MODULE_ROUTER_KNOBS.startDelayMs + 500 });
  await run(clock, 3_000);
  assert.equal(r.stats.superseded, 1); assert.equal(r.stats.answered, 1);
  // Two messages in quick succession: the first is voided before its call starts, so only one call is made.
  r.userTurn('x', NATURAL); r.userTurn('y', NATURAL);
  await run(clock, 3_500);
  assert.equal(signals.length, 3, 'x never called haiku');
  assert.equal((await r.verdict('y', 'rps')).kind, 'called');
  r.dispose();
});

test('haiku fails, times out, answers bad JSON or too unsure: the verdict is unknown or not-called, never a call', async () => {
  const cases: [string, ScriptedAnswer | null, RouterVerdict['kind'], string | null][] = [
    ['error', { raw: new Error('claude exited 1') }, 'unknown', 'error'],
    ['bad json', { raw: '好的，我觉得是猜拳' }, 'unknown', 'bad-json'],
    ['unknown module', { raw: '{"called":[{"module":"dance","confidence":0.99}]}' }, 'unknown', 'bad-json'],
    ['unsure', { raw: yes(0.5) }, 'not-called', null],
    ['timeout', null, 'unknown', 'timeout'],
  ];
  for (const [name, answer, kind, reason] of cases) {
    const clock = new Clock();
    const ask = scriptedRouterAsk(() => answer, waiter(clock));
    const { r } = router(clock, ask);
    r.userTurn('m', NATURAL);
    const got: RouterVerdict[] = [];
    void r.verdict('m', 'rps', 60_000).then(v => { got.push(v); });
    await run(clock, MODULE_ROUTER_KNOBS.timeoutMs + 100);
    assert.equal(got.length, 1, name);
    assert.equal(got[0].kind, kind, name);
    if (reason) assert.equal((got[0] as { reason: string }).reason, reason, name);
    r.dispose();
  }
});

test('not asked: hint words missing, Claude unavailable, the day\'s ceiling, or the local words already decided', async () => {
  const clock = new Clock();
  const ask = scriptedRouterAsk(() => ({ raw: yes() }));
  let available = false;
  const { r } = router(clock, ask, { available: () => available, knobs: { callsPerDay: 2 } });
  r.userTurn('a', NATURAL); assert.deepEqual(await r.verdict('a', 'rps'), { kind: 'unknown', reason: 'unavailable' });
  available = true;
  r.userTurn('b', '今天好累'); assert.deepEqual(await r.verdict('b', 'rps'), { kind: 'unknown', reason: 'prefilter' });
  r.userTurn('c', '来玩猜拳吧'); assert.deepEqual(await r.verdict('c', 'rps'), { kind: 'unknown', reason: 'local' });
  r.userTurn('d', NATURAL); await run(clock, 400); assert.equal((await r.verdict('d', 'rps')).kind, 'called');
  r.userTurn('e', NATURAL); await run(clock, 400); assert.equal((await r.verdict('e', 'rps')).kind, 'called');
  r.userTurn('f', NATURAL); assert.deepEqual(await r.verdict('f', 'rps'), { kind: 'unknown', reason: 'quota' }, 'the third call of the day is not made');
  assert.equal(ask.calls.length, 2);
  r.dispose();
});

test('the developer panel record: developer mode only, memory only, module names, verdicts, times and who decided, never the words', async () => {
  const clock = new Clock();
  const ask = scriptedRouterAsk(() => ({ raw: yes(0.92), after: 1_800 }), waiter(clock));
  const h = router(clock, ask);
  h.setDeveloper(false);
  h.r.userTurn('quiet', NATURAL);
  await run(clock, 2_000);
  assert.deepEqual(h.r.recent(), [], 'off: nothing kept');
  h.setDeveloper(true);
  h.r.userTurn('m1', '今天好累');
  h.r.userTurn('m2', '来玩猜拳吧');
  h.r.decided('m2', 'rps', { by: 'local', action: '答应，回复说完开局' });
  h.r.userTurn('m3', NATURAL);
  await run(clock, 2_500);
  h.r.decided('m3', 'rps', { by: 'haiku', action: '答应，回复说完开局' });
  await run(clock, 50);
  const lines = h.r.recent();
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], { at: lines[0].at, asked: ['猜拳'], skipped: null, local: [], answer: { status: 'answered', called: [{ module: '猜拳', confidence: 0.92 }], ms: 2_100 },
    decisions: [{ module: '猜拳', by: 'haiku', action: '答应，回复说完开局' }] });
  assert.deepEqual(lines[1].local, [{ module: '猜拳', kind: 'called' }]); assert.equal(lines[1].skipped, 'local'); assert.equal(lines[1].answer, null);
  assert.equal(lines[2].skipped, 'prefilter');
  const json = JSON.stringify(lines), text = formatModuleRouterLines(lines);
  for (const words of [NATURAL, '奶茶', '今天好累', '来玩猜拳吧']) { assert.ok(!json.includes(words), `no words in the record: ${words}`); assert.ok(!text.includes(words)); }
  assert.match(text, /^调度台：\S+ 问了 haiku（猜拳）→ 叫到 猜拳（把握 0\.92） · 2\.1 秒｜猜拳：haiku 说了算 → 答应，回复说完开局$/mu);
  assert.match(text, /没问 haiku（本机认出来了：猜拳 叫了）｜猜拳：本机说了算 → 答应，回复说完开局/u);
  assert.match(text, /没问 haiku（粗筛没命中）/u);
  assert.ok(h.changed > 0, 'the panel heard about it');
  h.setDeveloper(false);
  assert.deepEqual(h.r.recent(), [], 'developer mode turned off: not shown');
  assert.equal(formatModuleRouterLines([]), '调度台：暂无');
  h.r.dispose();
});

// ------------------------------------------------------------------ 猜拳 on the router

interface Harness { host: RpsHost; router: ModuleRouter; clock: Clock; store: RpsStore; state: { character: RpsCharacterState; visible: boolean }; ask: ReturnType<typeof scriptedRouterAsk>; close(): Promise<void> }
async function harness(script: (message: string) => ScriptedAnswer | null, character: Partial<RpsCharacterState> = {}, random = seeded(5)): Promise<Harness> {
  const clock = new Clock(), dir = await mkdtemp(path.join(os.tmpdir(), 'module-router-'));
  const store = new RpsStore({ file: () => path.join(dir, 'rps.json'), now: () => clock.now }); await store.load();
  const ask = scriptedRouterAsk(script, waiter(clock));
  const moduleRouter = new ModuleRouter({ ask, available: () => true, developerMode: () => true, clock: () => clock.now, timers: clock.timerApi });
  const state = { visible: true, character: { id: 'gene', persona: '角色：基恩', parameters: DEFAULT_MOOD_PARAMETERS,
    snapshot: { primary: 'happy', values: { D: 70, O: 50, E: 55, N: 50, C: 40 } }, fatigue: null, herLife: 'company', ...character } as RpsCharacterState };
  let n = 0;
  const host = new RpsHost({ store, character: () => state.character, visible: () => state.visible, recording: () => false, localDate: () => '2026-11-04',
    publish: () => {}, mood: () => {}, chatBusy: () => false, clock: () => clock.now, random, voiceRandom: seeded(11),
    nonce: () => `nonce${++n}`, createId: () => `id${++n}`, timers: clock.timerApi,
    routed: id => moduleRouter.verdict(id, 'rps'), decided: (id, decision) => moduleRouter.decided(id, 'rps', decision) });
  return { host, router: moduleRouter, clock, store, state, ask, close: async () => { host.dispose(); moduleRouter.dispose(); await store.flush(); await rm(dir, { recursive: true, force: true }); } };
}
/** One chat turn in main.ts's order: the router, then 猜拳's chatTurn, then Opus streams; chatDone(true) when her reply is done, chatDone(false) in finally. */
function chat(h: Harness, id: string, text: string, replyMs: number): { context: string | null; firstCharAt: () => number | null } {
  const start = h.clock.now;
  h.router.userTurn(id, text);
  const context = h.host.chatTurn(id, text);
  let first: number | null = null;
  h.clock.timerApi.set(() => { first = h.clock.now - start; }, Math.min(1_700, replyMs));
  h.clock.timerApi.set(() => { h.host.chatDone(id, true); h.host.chatDone(id, false); }, replyMs);
  return { context, firstCharAt: () => first };
}

test('猜拳 slow path: the local words miss, haiku says she is asked, the game opens after her reply (Opus got no context, her first character on time)', async () => {
  const h = await harness(message => message === NATURAL ? { raw: yes(), after: 2_500 } : null);
  const turn = chat(h, 'r1', NATURAL, 3_500);
  assert.equal(turn.context, null, 'no private context: Opus answers as usual');
  await run(h.clock, 3_500);
  assert.equal(turn.firstCharAt(), 1_700, 'her first character is not held up by haiku');
  assert.equal(h.host.active, false, 'nothing during her reply');
  await run(h.clock, 650); assert.equal(h.host.active, false, 'not before 700 ms after the reply');
  await run(h.clock, 100); assert.equal(h.host.active, true, 'the match opens like an accepted request');
  assert.equal(h.host.view()?.phase, 'ready', 'its own opening: her arm comes up, then 石头——剪刀——布');
  assert.deepEqual(h.router.recent()[0].decisions, [{ module: '猜拳', by: 'haiku', action: '答应，回复说完开局' }]);
  await h.close();
});

test('猜拳 slow path when haiku is slower than her reply: it waits up to the grace, then gives up (no game), and a game never opens late', async () => {
  const slow = await harness(() => ({ raw: yes(), after: 4_500 }));
  chat(slow, 'r1', NATURAL, 3_000);
  await run(slow.clock, 3_000 + 1_800 + 700 + 150);
  assert.equal(slow.host.active, true, 'haiku at 4.8 s (1.8 s after the reply, within 2.5 s): the game opens 700 ms after it');
  await slow.close();
  const late = await harness(() => ({ raw: yes(), after: 6_000 }));
  chat(late, 'r1', NATURAL, 3_000);
  await run(late.clock, 12_000);
  assert.equal(late.host.active, false, 'haiku at 6 s (3 s after the reply, past the grace): no game');
  assert.equal(late.host.stats.matches, 0);
  await late.close();
});

test('猜拳 slow path answers by her character: drowsy she puts it off (no game); her own invitation open, a yes is an accept', async () => {
  const sleepy = await harness(() => ({ raw: yes() }), { fatigue: 'asleep' }, () => 0);
  chat(sleepy, 'r1', NATURAL, 3_000);
  await run(sleepy.clock, 8_000);
  assert.equal(sleepy.host.stats.matches, 0, 'put off: no game');
  assert.deepEqual(sleepy.router.recent()[0].decisions, [{ module: '猜拳', by: 'haiku', action: '困了，推一推，不开局' }]);
  await sleepy.close();
  const invited = await harness(() => ({ raw: yes() }), { fatigue: 'asleep' }, () => 0);
  invited.host.testInvite();
  chat(invited, 'r1', '好啊，石头剪刀布来，输了别哭', 3_000);
  await run(invited.clock, 4_000);
  assert.equal(invited.host.active, true, 'she asked first: haiku\'s yes accepts her invitation');
  await invited.close();
});

test('猜拳 fast path: the local words recognise the request, haiku is not asked, the game opens 700 ms after her reply', async () => {
  const h = await harness(() => ({ raw: yes(), after: 60_000 }));
  const turn = chat(h, 'r1', '来玩一把猜拳来', 3_000);
  assert.match(turn.context!, /^【猜拳】用户想和你玩猜拳，你正好也想玩/u, 'Opus hears it in this turn\'s private context');
  await run(h.clock, 3_700);
  assert.equal(h.host.active, true);
  assert.equal(h.ask.calls.length, 0, 'haiku never asked');
  assert.deepEqual(h.router.recent()[0].decisions, [{ module: '猜拳', by: 'local', action: '答应，回复说完开局' }]);
  await h.close();
  // Even with a haiku that never answers and a routed() that never settles, the fast path opens on time.
  const clock = new Clock(), dir = await mkdtemp(path.join(os.tmpdir(), 'module-router-fast-'));
  const store = new RpsStore({ file: () => path.join(dir, 'rps.json'), now: () => clock.now }); await store.load();
  let routedCalls = 0;
  const host = new RpsHost({ store, character: () => ({ id: 'gene', persona: '角色', parameters: DEFAULT_MOOD_PARAMETERS, snapshot: { primary: 'happy', values: VALUES }, fatigue: null, herLife: 'company' }),
    visible: () => true, recording: () => false, localDate: () => '2026-11-04', publish: () => {}, mood: () => {}, chatBusy: () => false, clock: () => clock.now, random: seeded(5),
    timers: clock.timerApi, routed: () => { routedCalls++; return new Promise<RouterVerdict>(() => {}); } });
  host.chatTurn('a', '来玩猜拳吧'); host.chatDone('a', true);
  await run(clock, 750);
  assert.equal(host.active, true); assert.equal(routedCalls, 0, 'the fast path never asks for the verdict');
  host.dispose(); await store.flush(); await rm(dir, { recursive: true, force: true });
});

test('猜拳: a local refusal wins over haiku; haiku errors, bad JSON and a newer message open nothing', async () => {
  // A refusal: haiku is not asked, and even a routed() that says yes would not be consulted.
  const refusal = await harness(() => ({ raw: yes() }));
  chat(refusal, 'r1', '石头剪刀布？不想玩了', 3_000);
  await run(refusal.clock, 6_000);
  assert.equal(refusal.host.stats.matches, 0); assert.equal(refusal.ask.calls.length, 0);
  assert.deepEqual(refusal.router.recent()[0].decisions, [{ module: '猜拳', by: 'refusal', action: '你说了不玩，不开局' }]);
  await refusal.close();
  for (const raw of [new Error('boom'), '是猜拳！', '{"called":[{"module":"rps","confidence":0.3}]}']) {
    const h = await harness(() => ({ raw }));
    chat(h, 'r1', NATURAL, 3_000);
    await run(h.clock, 8_000);
    assert.equal(h.host.stats.matches, 0, String(raw));
    // …and the local words still work afterwards.
    chat(h, 'r2', '来玩猜拳吧', 3_000);
    await run(h.clock, 3_800);
    assert.equal(h.host.active, true, `local still works after ${String(raw)}`);
    await h.close();
  }
  // A newer message while haiku is still thinking: its yes is void even though it arrives.
  const newer = await harness(message => message === NATURAL ? { raw: yes(), after: 5_000 } : { raw: '{"called":[]}' });
  chat(newer, 'r1', NATURAL, 3_000);
  await run(newer.clock, 3_400); // her reply is done, the verdict is awaited
  chat(newer, 'r2', '我先去吃饭啦', 2_000);
  await run(newer.clock, 8_000);
  assert.equal(newer.host.stats.matches, 0, 'the older message no longer opens a game');
  await newer.close();
  // The reply failed or was stopped: no game.
  const failed = await harness(() => ({ raw: yes() }));
  failed.router.userTurn('r1', NATURAL); failed.host.chatTurn('r1', NATURAL);
  await run(failed.clock, 1_000); failed.host.chatDone('r1', false);
  await run(failed.clock, 5_000);
  assert.equal(failed.host.stats.matches, 0);
  await failed.close();
});

test('猜拳\'s own guards (a routed() that always says yes, ignoring newer messages): a refusal is never sent, a newer message, cancel or a hidden pet void it', async () => {
  const clock = new Clock(), dir = await mkdtemp(path.join(os.tmpdir(), 'module-router-guards-'));
  const store = new RpsStore({ file: () => path.join(dir, 'rps.json'), now: () => clock.now }); await store.load();
  const asked: string[] = [], release: (() => void)[] = [];
  let visible = true, characterId = 'gene';
  const host = new RpsHost({ store, character: () => ({ id: characterId, persona: '角色', parameters: DEFAULT_MOOD_PARAMETERS, snapshot: { primary: 'happy', values: VALUES }, fatigue: null, herLife: 'company' }),
    visible: () => visible, recording: () => false, localDate: () => '2026-11-04', publish: () => {}, mood: () => {}, chatBusy: () => false, clock: () => clock.now, random: seeded(5),
    timers: clock.timerApi, routed: id => { asked.push(id); return new Promise<RouterVerdict>(done => release.push(() => done({ kind: 'called', confidence: 0.95, ms: 1 }))); } });
  host.chatTurn('no', '石头剪刀布？不想玩了'); host.chatDone('no', true);
  assert.deepEqual(asked, [], 'a refusal the local words know is not even sent for a verdict');
  host.chatTurn('a', NATURAL); host.chatDone('a', true);
  host.chatTurn('b', '我先去吃饭啦'); // newer message before a's yes arrives
  release.shift()!(); await run(clock, 2_000);
  assert.equal(host.stats.matches, 0, 'a newer message voids it');
  host.chatDone('b', true); release.shift()!(); await run(clock, 2_000);
  assert.equal(host.stats.matches, 1, 'b\'s own yes (this guard ignores what haiku would say about "吃饭") opens one');
  host.cancel(); await run(clock, 100);
  host.chatTurn('c', NATURAL); host.chatDone('c', true); host.cancel();
  release.shift()!(); await run(clock, 2_000);
  assert.equal(host.stats.matches, 1, 'cancel voids it');
  host.chatTurn('d', NATURAL); host.chatDone('d', true); visible = false;
  release.shift()!(); await run(clock, 2_000);
  assert.equal(host.stats.matches, 1, 'hidden: no game');
  visible = true;
  host.chatTurn('e', NATURAL); host.chatDone('e', true); characterId = 'someone-else';
  release.shift()!(); await run(clock, 2_000);
  assert.equal(host.stats.matches, 1, 'another character by the time the yes arrives: no game');
  host.dispose(); await store.flush(); await rm(dir, { recursive: true, force: true });
});

test('the app wiring: createRps binds 猜拳 to the router\'s "rps" verdicts; createModuleRouter uses the small model call it is given', async () => {
  const clock = new Clock(), dir = await mkdtemp(path.join(os.tmpdir(), 'module-router-wiring-'));
  const calls: string[] = [];
  const fakeRouter = { verdict: (id: string, module: string) => { calls.push(`verdict ${id} ${module}`); return Promise.resolve<RouterVerdict>({ kind: 'not-called', confidence: 0.1, ms: 900 }); },
    decided: (id: string, module: string, decision: { by: string; action: string }) => { calls.push(`decided ${id} ${module} ${decision.by}`); } };
  const rps = createRps({ directory: () => dir, mood: () => null, persona: () => '', visible: () => true, recording: () => false, send: () => {}, moodEvent: () => {},
    interacted: () => {}, chatBusy: () => false, localDate: () => '2026-11-04', router: fakeRouter });
  rps.host.chatTurn('r1', NATURAL); rps.host.chatDone('r1', true);
  await flush();
  assert.deepEqual(calls, ['verdict r1 rps', 'decided r1 rps nobody']);
  rps.dispose(); await rm(dir, { recursive: true, force: true });
  const prompts: string[] = [];
  const app = createModuleRouter({ available: () => true, developerMode: () => false, ask: async prompt => { prompts.push(prompt); return '{"called":[]}'; } });
  app.userTurn('x', NATURAL);
  await new Promise(resolve => setTimeout(resolve, MODULE_ROUTER_KNOBS.startDelayMs + 150)); await flush();
  assert.equal(prompts.length, 1); assert.equal(routerMessageOf(prompts[0]), NATURAL);
  app.dispose();
  // No haiku at all (noRouterAsk never answers): after the grace the verdict is "late", and the call is stopped at its timeout.
  let signal: AbortSignal | null = null;
  const { r } = router(clock, (p, s, sig) => { signal = sig; return noRouterAsk(p, s, sig); });
  r.userTurn('y', NATURAL);
  let verdict: RouterVerdict | null = null;
  void r.verdict('y', 'rps').then(v => { verdict = v; });
  await run(clock, MODULE_ROUTER_KNOBS.graceAfterReplyMs + 50);
  assert.deepEqual(verdict, { kind: 'unknown', reason: 'late' });
  assert.equal(signal!.aborted, false, 'still running: it is already paid for, and the record shows when it ends');
  await run(clock, MODULE_ROUTER_KNOBS.timeoutMs);
  assert.equal(signal!.aborted, true, 'stopped at its timeout');
  assert.equal(r.stats.failed, 1);
  r.dispose();
});

test('the mood view carries the router\'s lines in developer mode only', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'module-router-mood-'));
  const clock = { now: Date.UTC(2026, 10, 4, 6, 0, 0) };
  let published = 0;
  const host = new MoodHost(directory, () => { published++; }, () => clock.now);
  try {
    await host.load();
    host.activate('gene', structuredClone(DEFAULT_MOOD_PARAMETERS));
    const line: ModuleRouterWhy = { at: clock.now, asked: ['猜拳'], skipped: null, local: [], answer: { status: 'answered', called: [], ms: 1200 }, decisions: [] };
    host.setModuleRouterSource(() => [line]);
    assert.equal('moduleRouterWhy' in host.get(), false, 'not in developer mode');
    const before = published; host.moduleRouterChanged(); assert.equal(published, before, 'no publish outside developer mode');
    host.setDeveloperMode(true);
    assert.deepEqual(host.get().moduleRouterWhy, [line]);
    const now = published; host.moduleRouterChanged(); assert.equal(published, now + 1);
    host.setModuleRouterSource(() => { throw new Error('broken'); });
    assert.deepEqual(host.get().moduleRouterWhy, [], 'a broken source shows nothing and breaks nothing');
  } finally {
    await host.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
