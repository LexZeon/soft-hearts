// turned itself off.
// Found path: a window other than the companion going away (the settings window closed or reloaded, Unbound's input box made or closed:
// both are the 'controls' owner) called MediaRuntime.dropOwner, which switched the screen off whoever shared it; 一起看 needs the screen, so
// it ended without the user. These tests reproduce that and pin the one-row journal note that says why 一起看 ended.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { MediaRuntime } from '../electron/senses/media-runtime';
import { WATCH_OFF_CAUSE_MS, WatchOffDetector, clearWatchOffCause, noteWatchOffCause } from '../electron/senses/watch-off-notice';
import { buildJournalEntry } from '../shared/memory/journal';
import type { WatchOffWhy } from '../shared/senses';

const OWNER_WINDOW = 'pet' as const; // no-pet-ok: the media owner id of the companion window

beforeEach(() => clearWatchOffCause());

/** The detector over a MediaRuntime, as the host ticks it: on = the screen is shared (the dialogue's part is a flag the test flips). */
function rig() {
  const media = new MediaRuntime();
  let dialogue = true, clock = 1_000_000;
  const rows: WatchOffWhy[] = [];
  const detector = new WatchOffDetector({ on: () => media.state.screenSharing && dialogue, ended: why => rows.push(why), now: () => clock });
  return { media, rows, tick: (advanceMs = 1000) => { clock += advanceMs; detector.tick(); }, setDialogue: (value: boolean) => { dialogue = value; }, advance: (ms: number) => { clock += ms; } };
}

test('another window going away no longer switches the screen off (the bug)', () => {
  const { media } = rig();
  media.update({ screenSharing: true }, OWNER_WINDOW);
  assert.equal(media.state.screenSharing, true);
  media.dropOwner('controls'); // the settings window closed, or Unbound's input box went
  assert.equal(media.state.screenSharing, true, 'before the fix this was false and 一起看 ended by itself');
});

test('the companion window going away does end the screen, and the row says the window was gone', () => {
  const { media, rows, tick } = rig();
  media.update({ screenSharing: true }, OWNER_WINDOW); tick();
  media.dropOwner(OWNER_WINDOW); tick();
  assert.equal(media.state.screenSharing, false);
  assert.deepEqual(rows, ['window-gone']);
});

test('the user switching the screen off is "user"; a reset is "reset"', () => {
  const a = rig();
  a.media.update({ screenSharing: true }, OWNER_WINDOW); a.tick();
  a.media.update({ screenSharing: false }, OWNER_WINDOW); a.tick();
  assert.deepEqual(a.rows, ['user']);
  const b = rig();
  b.media.update({ screenSharing: true }, OWNER_WINDOW); b.tick();
  b.media.reset(); b.tick();
  assert.deepEqual(b.rows, ['reset']);
});

test('the dialogue stopping alone is one row with the noted cause; nothing noted is "other"', () => {
  const a = rig();
  a.media.update({ screenSharing: true }, OWNER_WINDOW); a.tick();
  noteWatchOffCause('window-hidden', 1_000_500); noteWatchOffCause('conversation-change', 1_000_600); // the first note stands
  a.setDialogue(false); a.tick();
  assert.deepEqual(a.rows, ['window-hidden']);
  clearWatchOffCause();
  const b = rig();
  b.media.update({ screenSharing: true }, OWNER_WINDOW); b.tick();
  b.setDialogue(false); b.tick();
  assert.deepEqual(b.rows, ['other'], 'a way off nobody named still leaves its row, so it can be found');
});

test('the user\'s own off wins over any other note made in the same moments', () => {
  const { media, rows, tick, setDialogue } = rig();
  media.update({ screenSharing: true }, OWNER_WINDOW); tick();
  noteWatchOffCause('conversation-change', 1_000_900);
  noteWatchOffCause('user', 1_000_950);
  setDialogue(false); tick();
  assert.deepEqual(rows, ['user']);
});

test('one row per change; staying on or staying off writes nothing; a stale note is ignored', () => {
  const { media, rows, tick, setDialogue, advance } = rig();
  tick(); tick(); // off from the start
  media.update({ screenSharing: true }, OWNER_WINDOW); tick(); tick(); tick();
  assert.deepEqual(rows, []);
  noteWatchOffCause('window-hidden', 1_000_000);
  advance(WATCH_OFF_CAUSE_MS + 1000); // the note is old now: not the cause of this change
  setDialogue(false); tick(); tick(); tick();
  assert.deepEqual(rows, ['other']);
  setDialogue(true); tick(); setDialogue(false); tick();
  assert.equal(rows.length, 2, 'turning on and off again is a second change');
});

test('the journal accepts the closed words and nothing else', () => {
  for (const why of ['user', 'window-gone', 'window-hidden', 'reset', 'conversation-change', 'other'] as const) {
    const line = buildJournalEntry({ type: 'watch-off', characterId: 'gene', why }, 1_000);
    assert.ok(line && (line as { why?: string }).why === why, why);
  }
  assert.equal(buildJournalEntry({ type: 'watch-off', characterId: 'gene', why: '她看的视频' } as never, 1_000), null);
});
