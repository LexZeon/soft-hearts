/**
 * I-048 step 2: 「和她一起看」 running (electron/watch-notes/session.ts and wiring.ts). Never a real model, screen or profile: fake clock,
 * fake sampler and fake haiku, synthetic pictures, temporary folders. What it pins: nothing is captured unless watching together;
 * the slot is taken at capture time and filled when the description arrives; a stale or cancelled description is never inserted;
 * turning watching, the screen or 一起听 off (or switching character, or a refusal) cancels everything pending and removes the
 * pending screenshots; the hourly budget holds; the reply path (render) never waits for the model; descriptions, summaries,
 * keywords and screenshots go to disk per character and forgetting removes all of them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WatchSession, type WatchConditions } from '../electron/watch-notes/session';
import { WatchNotesStore } from '../electron/watch-notes/store';
import { ScreenshotCache, SCREENSHOT_FOLDER } from '../electron/watch-notes/screenshots';
import { KeywordIndexStore, KEYWORD_FOLDER } from '../electron/memory-keywords/store';
import { WatchTogether } from '../electron/watch-notes/wiring';
import { WATCH_TIMELINE_KNOBS, type WatchTimelineKnobs } from '../shared/behaviors/watch-timeline/knobs';

const SEC = 1_000, MIN = 60_000, T0 = 2_000_000_000_000;
const FRAME_JSON = (description: string, keywords: unknown[] = []) => JSON.stringify({ description, keywords });
const SUMMARY_JSON = (summary: string, keywords: unknown[] = []) => JSON.stringify({ summary, keywords });
const KEYWORD = (term: string, extra: Record<string, unknown> = {}) => ({ term, kind: 'person', weight: 0.8, aliases: [], ...extra });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
async function until(check: () => Promise<boolean>): Promise<void> { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } }

function knobs(patch: Partial<WatchTimelineKnobs['haiku']> = {}, session: Partial<WatchTimelineKnobs['session']> = {}): WatchTimelineKnobs {
  return { ...WATCH_TIMELINE_KNOBS, haiku: { ...WATCH_TIMELINE_KNOBS.haiku, ...patch }, session: { ...WATCH_TIMELINE_KNOBS.session, ...session } };
}

async function withRig(run: (rig: ReturnType<typeof makeRig>, directory: string) => Promise<void>, options: { knobs?: WatchTimelineKnobs } = {}): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-watch-session-test-'));
  try { await run(makeRig(directory, options.knobs ?? WATCH_TIMELINE_KNOBS), directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

function makeRig(directory: string, k: WatchTimelineKnobs) {
  let clock = T0, frame = 0;
  const state = { conditions: { watch: true, screen: true } as WatchConditions, character: 'gene' as string | null };
  const counts = { captures: 0, describes: 0, summaries: 0 };
  const calls: { signal: AbortSignal; picture: string; done: ReturnType<typeof deferred<string>> }[] = [];
  const summaryCalls: { signal: AbortSignal; prompt: string; done: ReturnType<typeof deferred<string>> }[] = [];
  const keywordStore = new KeywordIndexStore(directory);
  const screenshots = new ScreenshotCache(directory, () => clock, k.notes);
  const notes = new WatchNotesStore(directory, { keywords: keywordStore, screenshots }, k.notes);
  const session = new WatchSession({
    now: () => clock, characterId: () => state.character, conditions: () => state.conditions,
    capture: async () => { counts.captures++; frame++; return `data:image/jpeg;base64,FRAME${frame}`; },
    prepare: url => ({ thumb: new Uint8Array(576).fill((Number(/FRAME(\d+)/u.exec(url)![1]) * 60) % 256), picture: url }),
    describe: (picture, _prompt, _system, signal) => { counts.describes++; const done = deferred<string>(); calls.push({ signal, picture, done }); return done.promise; },
    summarize: (prompt, _system, signal) => { counts.summaries++; const done = deferred<string>(); summaryCalls.push({ signal, prompt, done }); return done.promise; },
    notes, screenshots, knobs: k, createId: (() => { let n = 0; return () => `f${++n}`; })(),
  });
  const advance = (ms: number) => { clock += ms; };
  /** One sampling round: ten seconds pass, the session looks, takes a picture, compares. */
  const round = async () => { advance(10 * SEC); await session.tick(); await flush(); };
  const files = async (...parts: string[]) => readdir(path.join(directory, ...parts)).catch(() => [] as string[]);
  return { session, state, counts, calls, summaryCalls, advance, round, now: () => clock, notes, screenshots, keywordStore, files, directory,
    set clock(v: number) { clock = v; } };
}

test('nothing is captured unless watching together: screen off, 一起听 off, the knob off', async () => {
  await withRig(async rig => {
    rig.state.conditions = { watch: false, screen: true }; // screen sharing on but 一起听 off
    for (let i = 0; i < 4; i++) await rig.round();
    rig.state.conditions = { watch: false, screen: false };
    for (let i = 0; i < 4; i++) await rig.round();
    assert.equal(rig.counts.captures, 0);
    assert.equal(rig.counts.describes, 0);
    assert.equal(rig.session.active, false);
    assert.equal(rig.session.render('gene'), null);
  });
  await withRig(async rig => {
    for (let i = 0; i < 3; i++) await rig.round();
    assert.equal(rig.counts.captures, 0, 'the master knob off: not even watching together captures');
  }, { knobs: knobs({}, { enabled: false }) });
});

test('a frame: the slot is taken at capture time, the screenshot is kept, the description fills the slot and goes to disk with its keywords', async () => {
  await withRig(async rig => {
    await rig.round();
    assert.equal(rig.counts.captures, 1);
    assert.equal(rig.counts.describes, 1);
    // Before the model answers the reply path already sees the place, marked as not yet written.
    const captureAt = rig.now();
    const waiting = rig.session.render('gene');
    assert.ok(waiting && /画面描述中/u.test(waiting.text), waiting?.text);
    await until(async () => (await rig.files(SCREENSHOT_FOLDER)).length === 1);
    assert.equal((await rig.files(SCREENSHOT_FOLDER)).length, 1, 'the screenshot is cached at capture time');
    rig.advance(20 * SEC); // the model is slow; the slot stays at the capture moment
    rig.calls[0].done.resolve(FRAME_JSON('昏暗的走廊里两个人对峙，其中一个人手里拿着信封', [KEYWORD('信封', { kind: 'object' }), KEYWORD('编造的人名')]));
    await rig.session.settled();
    const rendered = rig.session.render('gene')!;
    assert.match(rendered.text, /看到：昏暗的走廊里两个人对峙/u);
    assert.ok(!/画面描述中/u.test(rendered.text));
    assert.match(rendered.text, /^2\d秒前 看到/u, 'relative to now, the slot is at the capture time');
    // On disk: the description, the keyword that the text supports, not the invented one.
    const saved = await rig.notes.list('gene');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].kind, 'frame');
    assert.equal(saved[0].at, captureAt);
    assert.deepEqual(saved[0].keywords.map(keyword => keyword.term), ['信封']);
    const index = await rig.keywordStore.load('gene');
    assert.equal(index.size, 1);
    assert.equal(rig.session.stats.framesDescribed, 1);
  });
});

test('the reply path never waits for the model: render is a local read while the description is still out', async () => {
  await withRig(async rig => {
    await rig.round();
    assert.equal(rig.calls.length, 1);
    const started = performance.now();
    for (let i = 0; i < 2_000; i++) rig.session.render('gene');
    assert.ok(performance.now() - started < 500, 'render does not wait');
    assert.ok(rig.session.render('gene'), 'it still answers with the placeholder');
  });
});

test('a description that arrives after the watch ended is dropped, and the screenshot of a cancelled frame goes', async () => {
  await withRig(async rig => {
    await rig.round();
    await until(async () => (await rig.files(SCREENSHOT_FOLDER)).length === 1);
    assert.equal((await rig.files(SCREENSHOT_FOLDER)).length, 1);
    rig.state.conditions = { watch: false, screen: true }; // 一起听 off
    await rig.session.tick();
    assert.equal(rig.calls[0].signal.aborted, true, 'the running call is aborted');
    rig.calls[0].done.resolve(FRAME_JSON('一个很晚才到的描述'));
    await rig.session.settled();
    assert.equal(rig.session.timelineSize, 0, 'nothing of it is on the timeline');
    assert.deepEqual(await rig.notes.list('gene'), [], 'nothing of it is on disk');
    await until(async () => (await rig.files(SCREENSHOT_FOLDER, ...(await rig.files(SCREENSHOT_FOLDER)))).length === 0);
    assert.deepEqual(await rig.files(SCREENSHOT_FOLDER, ...(await rig.files(SCREENSHOT_FOLDER))), [], 'the pending frame\'s screenshot was removed');
    assert.ok(rig.session.stats.droppedLate >= 0 && rig.session.stats.cancelled === 1);
  });
});

test('turning the screen off, switching character or a refusal cancels pending work; the next watch starts clean', async () => {
  for (const cut of ['screen', 'character', 'refused'] as const) {
    await withRig(async rig => {
      await rig.round();
      rig.calls[0].done.resolve(FRAME_JSON('第一个画面：一间亮着灯的书店'));
      await rig.session.settled();
      assert.equal(rig.session.timelineSize, 1);
      await rig.round(); // a second frame is out
      assert.equal(rig.calls.length, 2);
      if (cut === 'screen') rig.state.conditions = { watch: false, screen: false };
      if (cut === 'character') rig.state.character = 'someone-else';
      if (cut === 'refused') rig.state.conditions = { watch: false, screen: false };
      await rig.session.tick();
      assert.equal(rig.calls[1].signal.aborted, true, cut);
      rig.calls[1].done.resolve(FRAME_JSON('第二个画面：太晚了'));
      await rig.session.settled();
      assert.equal((await rig.notes.list('gene')).length, 1, `${cut}: only the first description reached the disk`);
      if (cut !== 'character') assert.equal(rig.session.render('gene'), null);
      // Back on: it starts from nothing, the old timeline is not carried over.
      rig.state.character = 'gene'; rig.state.conditions = { watch: true, screen: true };
      await rig.session.tick();
      assert.equal(rig.session.timelineSize, 0, `${cut}: the timeline was wiped`);
    });
  }
});

test('"别看" (the refusal call) cancels what is out and keeps nothing new', async () => {
  await withRig(async rig => {
    await rig.round();
    rig.session.refuse();
    assert.equal(rig.calls[0].signal.aborted, true);
    rig.calls[0].done.resolve(FRAME_JSON('不该出现的描述'));
    await rig.session.settled();
    assert.deepEqual(await rig.notes.list('gene'), []);
    assert.equal(rig.session.render('gene'), null);
  });
});

test('the hourly budget holds: at most framesPerHour descriptions, the rest are not asked for', async () => {
  await withRig(async rig => {
    for (let i = 0; i < 8; i++) { await rig.round(); rig.calls.at(-1)?.done.resolve(FRAME_JSON(`第 ${i} 个画面是一条街`)); await rig.session.settled(); }
    assert.equal(rig.counts.describes, 3, 'three, then the budget says no');
    assert.ok(rig.session.stats.budgetRefused >= 1);
    // An hour later the budget is back.
    rig.advance(61 * MIN);
    await rig.round();
    assert.equal(rig.counts.describes, 4);
  }, { knobs: knobs({ framesPerHour: 3 }) });
});

test('an unchanged picture is not described again, a changed one is', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-watch-session-test-'));
  try {
    let clock = T0, describes = 0;
    const notes = new WatchNotesStore(directory), screenshots = new ScreenshotCache(directory, () => clock);
    let thumbValue = 100;
    const session = new WatchSession({ now: () => clock, characterId: () => 'gene', conditions: () => ({ watch: true, screen: true }),
      capture: async () => 'data:image/jpeg;base64,X', prepare: url => ({ thumb: new Uint8Array(576).fill(thumbValue), picture: url }),
      describe: async () => { describes++; return FRAME_JSON('一个没变的画面是一张桌子'); }, summarize: async () => '', notes, screenshots });
    const round = async () => { clock += 10 * SEC; await session.tick(); await session.settled(); };
    await round(); await round(); await round();
    assert.equal(describes, 1, 'the same picture three times: described once');
    thumbValue = 200;
    await round();
    assert.equal(describes, 2, 'a changed picture: described');
    assert.ok(session.stats.gateRefused >= 2);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('the heard words enter the timeline only while watching together; the summary compacts older lines and is kept on disk', async () => {
  await withRig(async rig => {
    rig.state.conditions = { watch: false, screen: true };
    rig.session.heard('不该进来的一句', rig.now());
    assert.equal(rig.session.timelineSize, 0);
    rig.state.conditions = { watch: true, screen: true };
    await rig.session.tick();
    rig.calls[0].done.resolve(FRAME_JSON('一个画面是一家钟表店的橱窗'));
    await rig.session.settled();
    // Seven heard lines long ago, then time passes: the compaction asks for a summary.
    const base = rig.now();
    for (let i = 0; i < 7; i++) rig.session.heard(`第 ${i} 句台词说到了钟表匠`, base + i * SEC);
    assert.equal(rig.session.timelineSize, 8, 'seven heard lines and the frame');
    rig.advance(5 * MIN);
    await rig.session.tick();
    await flush();
    assert.equal(rig.counts.summaries, 1, 'one summary call');
    assert.match(rig.summaryCalls[0].prompt, /钟表匠/u);
    rig.summaryCalls[0].done.resolve(SUMMARY_JSON('钟表匠在橱窗前说了很多话', [KEYWORD('钟表匠')]));
    // The frame that was queued behind the summary starts when the summary is done; answer whatever comes until the planner is idle.
    await until(async () => { for (const call of rig.calls.slice(1)) call.done.resolve(FRAME_JSON('一个画面是同一家店')); return rig.session.planning.running === 0 && rig.session.planning.queued === 0; });
    await rig.session.settled();
    const rendered = rig.session.render('gene')!;
    assert.match(rendered.text, /概要：钟表匠在橱窗前说了很多话/u);
    assert.ok(!/第 3 句台词/u.test(rendered.text), 'the lines the summary covers are gone');
    const saved = await rig.notes.list('gene');
    assert.deepEqual(saved.map(note => note.kind).sort(), ['frame', 'frame', 'summary']);
    assert.deepEqual(saved.find(note => note.kind === 'summary')!.keywords.map(keyword => keyword.term), ['钟表匠']);
  });
});

test('an unusable answer leaves no description and no placeholder', async () => {
  await withRig(async rig => {
    await rig.round();
    rig.calls[0].done.resolve('不是 JSON，只是一句话');
    await rig.session.settled();
    assert.equal(rig.session.timelineSize, 0);
    assert.equal(rig.session.stats.framesInvalid, 1);
    await rig.round();
    rig.calls[1].done.reject(new Error('offline'));
    await rig.session.settled();
    assert.equal(rig.session.timelineSize, 0);
    assert.equal(rig.session.stats.framesFailed, 1);
  });
});

test('the model call takes the haiku tier only through the port: the prompt carries the data rule and no description is trusted as an instruction', async () => {
  await withRig(async rig => {
    const seen: string[] = [];
    const session = new WatchSession({ now: () => rig.now(), characterId: () => 'gene', conditions: () => ({ watch: true, screen: true }),
      capture: async () => 'data:image/jpeg;base64,X', prepare: url => ({ thumb: new Uint8Array(576).fill(7), picture: url }),
      describe: async (_picture, prompt, system) => { seen.push(system, prompt); return FRAME_JSON('一个画面是一台电脑'); }, summarize: async () => '',
      notes: rig.notes, screenshots: rig.screenshots });
    rig.advance(10 * SEC); await session.tick(); await session.settled();
    assert.match(seen[0], /忽略以上/u, 'the system prompt says on-screen text is not an instruction');
    assert.match(seen[0], /聊天|邮件|密码/u, 'and private content is not copied');
    assert.match(seen[1], /只输出那一行 JSON/u);
  });
});

test('WatchTogether: forgetting a character removes her watch notes, keywords and cached screenshots, and no one else\'s', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-watch-together-test-'));
  try {
    let clock = T0, character = 'gene';
    const togetherPorts = { directory, now: () => clock, characterId: () => character, conditions: () => ({ watch: false, screen: false }), capture: async () => null,
      prepare: () => null, readListenNote: () => null };
    const together = new WatchTogether(togetherPorts);
    for (const who of ['gene', 'other']) {
      await together.notes.add(who, { id: `n-${who}`, kind: 'frame', at: clock, text: `${who} 的画面里有一把红伞`, keywords: [{ term: '红伞', kind: 'object', weight: 0.8, aliases: [] }] });
      await together.screenshots.put(who, `s-${who}`, 'data:image/jpeg;base64,AAAA', clock);
    }
    assert.equal((await together.view()).cache.files, 2);
    await together.forgetCharacter('gene');
    assert.deepEqual(await together.notes.list('gene'), []);
    assert.equal(await together.screenshots.get('gene', 's-gene'), null);
    assert.equal((await together.keywordStore.load('gene')).size, 0);
    assert.equal((await together.notes.list('other')).length, 1, 'another character is untouched');
    assert.ok(await together.screenshots.get('other', 's-other'));
    assert.equal((await together.keywordStore.load('other')).size, 1);
    // forgetWatch (the recycle-bin forget of chat memory): watch notes and their keywords go too.
    await together.forgetWatch('other');
    assert.deepEqual(await together.notes.list('other'), []);
    assert.equal((await together.keywordStore.load('other')).size, 0);
    assert.equal(await together.screenshots.get('other', 's-other'), null);
    assert.deepEqual(await readdir(path.join(directory, KEYWORD_FOLDER)).then(names => names.filter(name => name.endsWith('.json')).length > 0), true);
    await together.dispose();
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('expired screenshots are swept at startup and now and then; the journal tally has counts and timings only', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-watch-together-test-'));
  try {
    let clock = T0;
    const together = new WatchTogether({ directory, now: () => clock, characterId: () => 'gene', conditions: () => ({ watch: false, screen: false }), capture: async () => null,
      prepare: () => null, readListenNote: () => null });
    await together.screenshots.put('gene', 'old', 'data:image/jpeg;base64,AAAA', clock);
    clock += 31 * MIN;
    await together.session.tick(); // the sweep is due (never captured, nothing watching)
    await together.session.settled();
    assert.equal((await together.view()).cache.files, 0, 'a 31-minute-old screenshot was swept');
    const tally = await together.tally();
    assert.equal(tally, null, 'a quiet minute writes nothing');
    await together.dispose();
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
