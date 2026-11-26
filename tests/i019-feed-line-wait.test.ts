/**
 * I-019 (2026-11-12 real-use sweep): twelve recognised bites, no line ever said, every outcome "missed". The evidence: single
 * bites ended about seven seconds after the bite, i.e. right after the look and the line, long before any wait could run out, while
 * she was reading a chat reply aloud. The companion window said "not now" and the host dropped the line on the spot. These tests drive the
 * host with a fake clock and a fake companion window the way real use goes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FEED_RECENT_NAME_MS, FeedRecognitionHost, type FeedJournalEntry } from '../electron/senses/feed-recognition/host';
import type { FeedLineMessage, FeedVerdict } from '../shared/senses/feed-recognition';
import { FEED_JOURNAL_OUTCOMES } from '../shared/senses/feed-recognition';
import { journalReason } from '../shared/memory/journal';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const CAKE = '{"edible":true,"name":"草莓蛋糕","category":"甜点","liking":"爱吃","summary":"是一块草莓蛋糕；她爱吃甜的，应该会很开心"}';
const TEA = '{"edible":true,"name":"奶茶","category":"饮料","liking":"爱吃","summary":"是一杯奶茶；她爱喝"}';
const say = (text: string) => JSON.stringify({ text });

/** The host with a fake clock; `free` is the host's own check, `petFree` what the companion window answers when a line reaches it. */
function rig(start: Partial<{ phase: string; free: boolean; petFree: boolean; lineMs: number }> = {}) {
  const state = { now: 1_000_000, phase: 'idle', free: true, petFree: true, ...start, food: { sessionId: 'pet-1-1', characterId: 'gene', at: 1_000_000, delta: { D: 12, E: 6 } as Record<string, number> | null } };
  const log = { published: [] as FeedLineMessage[], publishedAt: [] as number[], archived: [] as FeedLineMessage[], journal: [] as FeedJournalEntry[], styles: [] as string[], looks: 0, lines: [] as string[] };
  const timers = new Map<number, { at: number; callback: () => void }>();
  let next = 1, lineText = '……草莓蛋糕？！';
  const look = { value: CAKE };
  const host: FeedRecognitionHost = new FeedRecognitionHost({
    store: { get recognize() { return true; }, note: () => 0, fed: () => [], last: () => null },
    acceptedFood: () => state.food,
    character: () => ({ id: 'gene', persona: '你是小桃。', language: '' }),
    moodLabel: () => '愉快', moodContext: () => '', moodPhase: () => state.phase,
    lift: () => {}, identity: () => 'scope-1',
    shrink: bytes => ({ dataUrl: `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`, width: 1, height: 1, bytes: bytes.length }),
    recognize: () => { log.looks++; return Promise.resolve(look.value); },
    line: () => Promise.resolve(say(lineText)),
    available: () => true, recording: () => true, free: () => state.free,
    publish: message => {
      log.published.push(message); log.publishedAt.push(state.now);
      // The companion window answers once the message has arrived (src/initiative/feed-line.ts: not free -> shown: false, nothing queued).
      queueMicrotask(() => host.done(true, { id: message.id, shown: state.petFree }));
      return true;
    },
    speechStyle: id => { log.styles.push(id); },
    archive: async message => { log.archived.push(message); },
    journal: (_id, entry) => { log.journal.push(entry); },
    clock: () => state.now,
    timers: { set: (callback, ms) => { const id = next++; timers.set(id, { at: state.now + ms, callback }); return id; }, clear: handle => { timers.delete(handle as number); } },
    createId: () => `id${next++}`,
  });
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const advance = async (ms: number) => {
    const end = state.now + ms;
    await flush();
    while (state.now < end) {
      state.now = Math.min(end, state.now + 50);
      for (const [id, timer] of [...timers]) if (timer.at <= state.now) { timers.delete(id); timer.callback(); }
      await flush();
    }
  };
  const bite = (sessionId: string) => { state.food = { sessionId, characterId: 'gene', at: state.now, delta: { D: 12, E: 6 } }; return host.accept(true, { sessionId, image: JPEG }); };
  return { host, state, log, advance, bite, look, setLine: (text: string) => { lineText = text; } };
}

test('she is free but the pet window says "not now" for a while (a reply still being read): the line is asked again and shown once', async () => {
  const r = rig({ petFree: false });
  assert.equal(await r.bite('pet-1-1'), true);
  await r.advance(12_000);
  assert.ok(r.log.published.length >= 2, `asked again, not dropped (${r.log.published.length})`);
  assert.equal(r.log.journal.length, 0, 'still waiting, nothing recorded as missed');
  r.state.petFree = true;
  await r.advance(3_000);
  assert.equal(r.log.journal.at(-1)?.outcome, 'said');
  assert.equal(r.log.archived.length, 1, 'archived once');
  assert.equal(r.log.archived[0].id, r.log.published.at(-1)!.id, 'the one that was shown');
  assert.equal(new Set(r.log.published.map(m => m.text)).size, 1, 'the same words each time');
  assert.equal(r.host.stats.lines, 1);
  const count = r.log.published.length;
  await r.advance(5_000);
  assert.equal(r.log.published.length, count, 'nothing more after it was shown');
});

test('the host is busy (a reply being read, another line) past the old 20 s: her line still comes when she is free, within the minute', async () => {
  const r = rig({ free: false });
  await r.bite('pet-1-1');
  await r.advance(35_000);
  assert.deepEqual(r.log.published, []);
  r.state.free = true;
  await r.advance(2_000);
  assert.equal(r.log.published.length, 1);
  assert.equal(r.log.journal.at(-1)?.outcome, 'said');
});

test('never free before the bite stops being "a moment ago": dropped as busy, and says so', async () => {
  const r = rig({ free: false });
  await r.bite('pet-1-1');
  await r.advance(FEED_RECENT_NAME_MS + 30_000);
  assert.deepEqual(r.log.published, []);
  assert.deepEqual(r.log.journal.map(entry => entry.outcome), ['busy']);
  assert.equal(r.log.archived.length, 0);
});

test('the pet window never answers: dropped as missed after 15 s, not archived', async () => {
  const r = rig();
  const original = r.host.done.bind(r.host);
  r.host.done = () => false; // the answer never arrives
  await r.bite('pet-1-1');
  await r.advance(30_000);
  r.host.done = original;
  assert.equal(r.log.journal.at(-1)?.outcome, 'missed');
  assert.equal(r.log.archived.length, 0);
});

test('the mood host still says eating long after the bite (a phase that never went back to idle): her line is not held forever', async () => {
  const r = rig({ phase: 'food-eating' });
  await r.bite('pet-1-1');
  await r.advance(5_000);
  assert.deepEqual(r.log.published, [], 'still chewing');
  await r.advance(8_000);
  assert.equal(r.log.published.length, 1);
  assert.equal(r.log.journal.at(-1)?.outcome, 'said');
});

test('a newer bite takes the line over while the older one is waiting: one line, the older one recorded as superseded', async () => {
  const r = rig({ petFree: false });
  await r.bite('pet-1-1');
  await r.advance(9_000);
  assert.ok(r.log.published.length >= 1);
  r.look.value = TEA; r.setLine('奶茶！嘿嘿。');
  await r.bite('pet-1-2');
  r.state.petFree = true;
  await r.advance(12_000);
  const shown = r.log.archived.map(message => message.text);
  assert.deepEqual(shown, ['奶茶！嘿嘿。'], 'only the newer bite is archived');
  assert.deepEqual(r.log.journal.map(entry => entry.outcome).sort(), ['said', 'superseded']);
});

test('the new outcomes are valid journal values with their own plain reasons', () => {
  assert.ok(FEED_JOURNAL_OUTCOMES.includes('busy') && FEED_JOURNAL_OUTCOMES.includes('superseded'));
  const reasons = FEED_JOURNAL_OUTCOMES.map(outcome => journalReason({ type: 'feed', characterId: 'gene', outcome }));
  assert.equal(new Set(reasons).size, reasons.length, 'every outcome says something different');
  void ({} as FeedVerdict);
});
