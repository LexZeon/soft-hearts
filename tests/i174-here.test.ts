// I-174 item 2 (docs/claude/2026-11-21-i174-parity-fixes.md): one "is she here" for both pages and the host. A temporary cover (another
// window on top, the Win+Shift+S snip overlay, Chromium marking the page hidden, a minimize; a full-screen program no longer hides her
// at all, I-199) is not "gone": her speech, reading and beats go on and her warm Claude process keeps the seen idle rule. Only a hide to
// the tray (or a closed window) is gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { herHere, herPresence, replyMayRun, windowPresenceFacts } from '../shared/foundation/step-away';
import { UnboundBubbleProof } from '../electron/unbound/read-aloud';
import { sessionIdleRule } from '../electron/brain/claude-session-idle';

const win = (visible: boolean, minimized = false, destroyed = false) => ({ isDestroyed: () => destroyed, isVisible: () => visible, isMinimized: () => minimized });

test('herPresence: shown, covered (minimized), gone (tray, closed, missing)', () => {
  assert.equal(herPresence(windowPresenceFacts(win(true))), 'shown');
  assert.equal(herPresence(windowPresenceFacts(win(false, true))), 'covered', 'minimized');
  assert.equal(herPresence(windowPresenceFacts(win(true, true))), 'covered', 'minimized while Electron still says visible');
  assert.equal(herPresence(windowPresenceFacts(win(false))), 'gone', 'hidden to the tray');
  assert.equal(herPresence(windowPresenceFacts(win(true, false, true))), 'gone', 'closed');
  assert.equal(herPresence(windowPresenceFacts(null)), 'gone');
  assert.equal(herHere(windowPresenceFacts({ isDestroyed: () => false, isVisible: () => { throw new Error('gone'); } })), false, 'a throwing reader reads as gone');
});

test('the page: the reply goes on while the document alone is hidden (another window, the snip overlay); a tray hide stops it', () => {
  assert.equal(replyMayRun(true, true, false), true, 'covered by a window or the snip overlay: Chromium says hidden, the host says shown');
  assert.equal(replyMayRun(false, true, true), true, 'minimized');
  assert.equal(replyMayRun(false, true, false), false, 'a tray hide');
  assert.equal(replyMayRun(true, false, false), true);
});

test('full-screen: while her bubble is only covered (minimized) her voice still follows it; out of Unbound it does not', () => {
  const place = { shown: true, minimized: false, out: true };
  const proof = new UnboundBubbleProof({ active: () => place.out && place.shown && !place.minimized,
    here: () => place.out && herHere(windowPresenceFacts(win(place.shown, place.minimized))) });
  proof.sent('r1', '第一句。');
  assert.equal(proof.followingText(), '第一句。');
  place.minimized = true; // only covered for a while
  assert.equal(proof.canShow(), false, 'nothing can be proven painted now');
  assert.equal(proof.followingText(), '第一句。', 'but her voice goes on following the bubble (before: null, the reading stopped)');
  place.out = false;
  assert.equal(proof.followingText(), null, 'she went back to her window: gone from here');
});

test('the warm Claude process: covered keeps the 10-minute idle rule; only gone is the 3-minute hidden rule', () => {
  const rule = (seen: boolean) => sessionIdleRule({ visible: false, seenElsewhere: () => seen, idleMs: 600_000, hiddenIdleMs: 180_000 });
  // Only covered (minimized); before I-199 also out in full-screen behind a full-screen program (dev journal 05:42:38Z: reuse "hidden").
  assert.deepEqual(rule(herHere(windowPresenceFacts(win(false, true)))), { ms: 600_000, reason: 'idle' });
  assert.deepEqual(rule(herHere(windowPresenceFacts(win(false)))), { ms: 180_000, reason: 'hidden' });
});
