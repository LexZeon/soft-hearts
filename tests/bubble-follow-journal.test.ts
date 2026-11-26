// I-165: the experience journal's first character stays "when her text arrived" even though her bubble now waits for her voice; a
// bubble that waited adds when its first sentence showed (electron/brain/reply-latency.ts firstCharTiming, shared/brain/journal-entries.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { firstCharTiming } from '../electron/brain/reply-latency';
import { buildBrainJournalEntry } from '../shared/brain/journal-entries';

test('first character: when the text arrived; a bubble that waited for her voice also says when its first sentence showed', () => {
  assert.deepEqual(firstCharTiming({ firstContentMs: 1800, firstVisibleMs: 1850 }), { ms: 1850 }, 'not followed: as before');
  assert.deepEqual(firstCharTiming({ firstContentMs: 1800, firstVisibleMs: 4200, heldForVoice: true }), { ms: 1800, shownMs: 4200 });
  assert.deepEqual(firstCharTiming({ firstContentMs: null, firstVisibleMs: 4200, heldForVoice: true }), { ms: 4200, shownMs: 4200 });
  assert.equal(firstCharTiming({ firstContentMs: null, firstVisibleMs: null }), null);
});

test('the journal keeps shownMs as a number of milliseconds, never anything else', () => {
  const base = { ms: 1800, pauseTalk: false, carried: false };
  const kept = buildBrainJournalEntry('first-char', { ...base, shownMs: 4200.4 }, 'c') as { shownMs?: number } | null;
  assert.equal(kept?.shownMs, 4200);
  const dropped = buildBrainJournalEntry('first-char', { ...base, shownMs: 'soon' }, 'c') as { shownMs?: number } | null;
  assert.equal(dropped?.shownMs, undefined);
});
