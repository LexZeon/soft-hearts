// I-161 a call's unfinished look is not thrown away by the next segment (asked whether the look still going when her next
// words come should be finished and could come up in the following sentences: "需要，但不是写死的。").
// Measured before (docs/claude/2026-11-20-call-look-first-char.md): at a fast pace only 1 of 4 needed looks reached her words, because a new
// segment dropped the previous one's unfinished look. Now it finishes, its facts wait (joinDeadlineMs) and go into a later segment as
// something she KNOWS (with how long ago), never an order to say it. Fake: haiku (held by the test), captures, the clock and timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SenseOn } from '../shared/senses/sense-router';
import { senseCarryNote } from '../shared/senses/sense-carry';
import { SenseRouterHost } from '../electron/senses/sense-router/host';
import { CarryStore, MAX_CARRIED_NOTES } from '../electron/senses/sense-router/carry-store';

const FACTS = (n: number) => `屏幕上是第 ${n} 个窗口。`;

function world() {
  let now = 1_000;
  const state = { on: { camera: true, screen: true, transcript: false } as SenseOn, character: 'c1', conversation: 'v1' };
  const timers: { at: number; fn: () => void }[] = [];
  const asks: { system: string; resolve: (text: string) => void; n: number }[] = [];
  const lines: string[] = [], published: string[] = [];
  let looks = 0, judgments = 0;
  const router = new SenseRouterHost({
    enabled: () => true, on: () => state.on, identity: () => 'id', conversation: () => state.conversation,
    capture: async sense => `data:${sense}`, heard: () => null,
    ask: (_prompt, system) => new Promise<string>(resolve => {
      if (system.includes('感知判定员')) { judgments++; resolve('{"senses":["screen"]}'); return; }
      const n = ++looks;
      asks.push({ system, resolve: () => resolve(FACTS(n)), n });
    }),
    line: async prompt => { lines.push(prompt); return '{"text":"x"}'; }, character: () => ({ id: state.character, persona: '', language: '' }), mood: () => '', free: () => true,
    publish: message => { published.push(message.text); return true; }, speechStyle: () => {}, archive: async () => {},
    clock: () => now, timers: { set: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return t; }, clear: t => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1); } },
  });
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  /** A call segment whose judgment (on the reaction call) named the screen: its look starts and stays held until `finish`. */
  const segment = async (id: string, scope = 's1', text = '这个呢') => {
    const took = router.userTurn(id, text, { merged: true, join: 'carry', scope });
    router.port.block(id);
    router.port.answer(id, ['screen'], true);
    await flush();
    return took;
  };
  const finish = async (n: number) => { asks.find(a => a.n === n)!.resolve(''); await flush(); };
  return { router, state, segment, finish, flush, asks, lines, published, judgments: () => judgments, looks: () => looks, advance: (ms: number) => { now += ms; } };
}

test('a new segment does not drop the previous one\'s unfinished look: its facts wait and go into a later segment', async () => {
  const w = world();
  assert.equal(await w.segment('g1'), true);
  assert.equal(w.looks(), 1, 'the look started');
  // The next segment comes while the look is still running (a fast pace).
  assert.equal(await w.segment('g2'), true);
  assert.equal(w.router.stats.dropped, 0, 'nothing was thrown away');
  assert.equal(w.looks(), 2, 'one look per segment, each its own (no look repeated)');
  await w.finish(1);
  assert.equal(w.router.stats.carried, 1, 'the older look finished after its segment was over: its facts are kept');
  w.advance(4_000);
  const got = w.router.takeCarried('s1', 'r3');
  assert.equal(got.length, 1);
  assert.ok(got[0].kind === 'seen' && got[0].facts === FACTS(1));
  assert.ok(got[0].agoMs >= 4_000, 'it says how long ago it was seen');
  assert.match(senseCarryNote(got, 'zh-CN'), /秒前/u);
  assert.equal(w.lines.length, 0, 'in a call: never a second reply');
  assert.deepEqual(w.published, []);
});

test('two looks that finish: both facts in ONE note for ONE segment, oldest first; the next segment gets none; capped', async () => {
  const w = world();
  await w.segment('g1'); await w.segment('g2'); await w.segment('g3');
  await w.finish(1); w.advance(2_000); await w.finish(2);
  const first = w.router.takeCarried('s1', 'r4');
  assert.deepEqual(first.map(note => note.kind === 'seen' ? note.facts : ''), [FACTS(1), FACTS(2)], 'oldest first, one note');
  assert.equal(w.router.takeCarried('s1', 'r5').length, 0, 'never two segments');
  w.router.releaseCarried('r4');
  assert.equal(w.router.carrying, false);
  await w.finish(3);
  assert.equal(w.router.takeCarried('s1', 'r5').length, 1, 'one that came after the first was taken waits for the next segment');
  // The cap.
  const store = new CarryStore(), meta = { scope: 's', identity: 'i', conversation: 'c', characterId: 'k' };
  for (let i = 0; i < MAX_CARRIED_NOTES + 3; i++) store.add(meta, [{ sense: 'screen', kind: 'seen', facts: `f${i}` }], i, i);
  const read = store.read('s', 'r', 100, 1_000, () => true, () => true).notes;
  assert.equal(read.length, MAX_CARRIED_NOTES);
  assert.ok(read[0].kind === 'seen' && read[0].facts === `f3`, 'the oldest go first');
});

test('everything that drops facts still drops them for an older look', async () => {
  const run = async (name: string, drop: (w: ReturnType<typeof world>) => void | Promise<void>, expect: 'none' | 'ended') => {
    const w = world();
    await w.segment('g1'); await w.segment('g2');
    await drop(w);
    for (const ask of [...w.asks]) await w.finish(ask.n);
    await w.flush();
    assert.equal(w.router.takeCarried('s1', 'r3').length, 0, name);
    assert.equal(w.lines.length, 0, name);
    if (expect === 'ended') assert.equal(w.router.stats.carried, 0, `${name}: not even kept`);
  };
  await run('the sense switched off before the look finished', w => { w.state.on = { camera: true, screen: false, transcript: false }; }, 'none');
  await run('the sense switched off after the look finished', async w => { await w.finish(1); w.state.on = { camera: true, screen: false, transcript: false }; }, 'none');
  await run('a cleared vision context (cancel)', w => { w.router.cancel(); }, 'ended');
  await run('hang-up (the capture ended)', w => { w.router.endScope('s1'); }, 'ended');
  await run('a typed message', w => { w.router.userTurn('typed', '你好', { merged: false }); }, 'ended');
  await run('another capture', w => { w.router.userTurn('other', '嗯', { merged: true, join: 'carry', scope: 's2' }); }, 'ended');
  await run('another character', w => { w.state.character = 'c2'; }, 'ended');
  await run('another conversation', w => { w.state.conversation = 'v2'; }, 'ended');
  await run('another conversation after the look finished', async w => { await w.finish(1); await w.finish(2); w.state.conversation = 'v2'; }, 'none');
  await run('another character after the look finished', async w => { await w.finish(1); await w.finish(2); w.state.character = 'c2'; }, 'none');
  // Hang-up when the newest segment already ended (nothing needed): the older look still in flight is ended with the capture.
  const h = world();
  await h.segment('g1');
  h.router.userTurn('g2', '嗯', { merged: true, join: 'carry', scope: 's1' });
  h.router.port.answer('g2', [], true); // nothing needed: that turn ends
  h.router.endScope('s1');
  await h.finish(1);
  assert.equal(h.router.takeCarried('s1', 'r3').length, 0, 'hang-up ends the older look too');
  assert.equal(h.router.carrying, false);
  await run('older than the deadline', w => { w.advance(60_001); }, 'none');
  await run('the sense is off before it is read', w => { w.state.on = { camera: false, screen: false, transcript: false }; }, 'none');
  // "别看" in the words of the segment that would take them (misheard "憋看" is read as 别看 by the voice adapter, tested there).
  const w = world();
  await w.segment('g1'); await w.segment('g2'); await w.finish(1);
  assert.equal(w.router.takeCarried('s1', 'r3', '别看我屏幕了').length, 0, '"别看" drops it');
  assert.equal(w.router.takeCarried('s1', 'r3').length, 0, 'and it stays dropped');
  // "别看" in the NEXT message itself: that message never looks at the screen at all.
  const v = world();
  v.router.userTurn('g1', '别看我屏幕', { merged: true, join: 'carry', scope: 's1' });
  v.router.port.answer('g1', ['screen'], true);
  await v.flush();
  assert.equal(v.looks(), 0, 'a held look is never taken');
});

test('no new haiku calls: a fast series makes one look per needed segment and no judgment of its own; the first word is never waited for', async () => {
  const w = world();
  for (let i = 1; i <= 5; i++) {
    const before = Date.now();
    const took = w.router.userTurn(`g${i}`, '这个呢', { merged: true, join: 'carry', scope: 's1' });
    assert.equal(took, true);
    assert.ok(Date.now() - before < 50, 'userTurn is synchronous: nothing is awaited on the way to her first word');
    w.router.port.block(`g${i}`);
    w.router.port.answer(`g${i}`, ['screen'], true);
    await w.flush();
  }
  assert.equal(w.judgments(), 0, 'the question rode on the reaction call: no judgment call here');
  assert.equal(w.looks(), 5, 'one look per segment, none repeated');
  for (let n = 1; n <= 5; n++) await w.finish(n);
  assert.equal(w.looks(), 5, 'finishing the older looks asks nothing more');
  assert.ok(w.router.takeCarried('s1', 'r6').length <= 4, 'capped');
  assert.equal(w.lines.length, 0);
});

test('at most a few looks go on at once: the oldest ones end', async () => {
  const w = world();
  for (let i = 1; i <= 6; i++) await w.segment(`g${i}`);
  await w.finish(1);
  assert.equal(w.router.takeCarried('s1', 'r7').length, 0, 'the oldest look was ended, not kept');
  assert.ok(w.router.stats.dropped >= 1);
});

test('the carried note is something she knows, never an order to say it (Chinese and English)', () => {
  const notes = [{ sense: 'screen' as const, kind: 'seen' as const, facts: '一个表格', agoMs: 12_000 }, { sense: 'camera' as const, kind: 'seen' as const, facts: 'a table', agoMs: 31_000 }];
  const zh = senseCarryNote(notes, 'zh-CN');
  const en = senseCarryNote(notes.map(note => ({ ...note, facts: 'a table' })), 'en');
  assert.match(zh, /12 秒前/u);
  assert.match(zh, /31 秒前/u);
  assert.match(en, /12 s ago/u);
  assert.ok(!/[一-鿿]/u.test(en), 'English card: English');
  assert.match(zh, /由你决定/u);
  assert.match(en, /up to you/u);
  for (const text of [zh, en]) {
    assert.ok(!/下一句|一定要|必须|务必|请告诉|告诉用户|马上说|接下来说|要说出来(?!，不提)/u.test(text.replace('没有要求你一定说出来', '')), `no order in: ${text}`);
    assert.ok(!/you must|you should (mention|say|tell)|tell the user|next sentence|next reply|make sure to/iu.test(text), `no order in: ${text}`);
  }
  assert.ok(!/此刻正在看到的\S*你要/u.test(zh));
  assert.match(zh, /别当成此刻正在看到/u, 'an older look is not presented as this moment');
  assert.match(en, /not present it as what you see this very moment/u);
});
