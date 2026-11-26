// no-pet-ok-file: the tests spell the window record contract field petVisible and the existing pet window fixtures, not the word for her
/**
 * I-171 (docs/claude/2026-11-21-i171-minimize-keeps-her.md): a minimize is a step away, not a hide. The pure rules the host's steps and the
 * page's guards share (shared/foundation/step-away.ts), the window visibility records that carry it, and the warm process's idle rule.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { abortsWithClosedWindow, leaveClearsVision, chatSeen, hideEndsReply, minimizedAway, replyMayRun, awayAwareVision, type AwayWindow } from '../shared/foundation/step-away';
import { visionContextKey, visionContextChange } from '../electron/senses/vision-context';
import { companionHiddenStep } from '../electron/stage/companion-hidden';
import { watchChatSeen } from '../electron/brain/chat-seen';
import { WindowVisibility } from '../electron/stage/window-visibility';
import { WindowVisibilityTracker } from '../src/stage/window-visibility';
import { sessionIdleRule } from '../electron/brain/claude-session-idle';

const win = (visible: boolean, minimized: boolean, destroyed = false): AwayWindow => ({ isDestroyed: () => destroyed, isVisible: () => visible, isMinimized: () => minimized });
const shown = win(true, false), minimized = win(false, true), hiddenToTray = win(false, false);

test('a minimize keeps the reply; a hide to the tray ends it', () => {
  assert.equal(hideEndsReply(minimized), false);
  assert.equal(hideEndsReply(hiddenToTray), true);
  assert.equal(hideEndsReply(shown), false, 'a shown window ends nothing');
  assert.equal(hideEndsReply({ ...win(false, true), isMinimized: () => { throw new Error('gone'); } }), true, 'a throwing window counts as a hide: the reply ends (the old rule)');
});

test('a minimized window counts as seen for her chat process (10-minute idle rule), a tray hide does not (3-minute rule)', () => {
  assert.equal(chatSeen(shown), true);
  assert.equal(chatSeen(minimized), true);
  assert.equal(chatSeen(hiddenToTray), false);
  assert.equal(chatSeen(win(false, true, true)), false, 'a destroyed window is not seen');
  const rule = (seen: boolean) => sessionIdleRule({ visible: seen, idleMs: 600_000, hiddenIdleMs: 180_000 });
  assert.deepEqual(rule(chatSeen(minimized)), { ms: 600_000, reason: 'idle' });
  assert.deepEqual(rule(chatSeen(hiddenToTray)), { ms: 180_000, reason: 'hidden' });
});

test('minimizedAway reads the window, never a destroyed one', () => {
  assert.equal(minimizedAway(minimized), true);
  assert.equal(minimizedAway(hiddenToTray), false);
  assert.equal(minimizedAway(win(false, true, true)), false);
});

test('the page: the reply may go on while shown or only minimized, not while hidden', () => {
  assert.equal(replyMayRun(true, false, false), true);
  assert.equal(replyMayRun(false, true, true), true, 'minimized: the host is not visible and the document is hidden, the reply goes on');
  assert.equal(replyMayRun(false, true, false), false, 'a tray hide');
  assert.equal(replyMayRun(true, true, false), true, 'I-174: the document alone hidden (a cover, not a hide) no longer stops it');
});

const keyOf = (scope: string, window: AwayWindow, visible: boolean, displayId: number | null, screen = true) => {
  const away = awayAwareVision({ visible, window, displayId, lastDisplayId: 2 });
  return visionContextKey({ speech: 's', scope, visible: away.visible, display: away.displayId, screen, camera: false, cameraOwner: null });
};

test('a minimize does not change the look identity, so it does not end the turn made from it; a tray hide does', () => {
  const seen = keyOf('s:m1', shown, true, 2);
  assert.equal(keyOf('s:m1', minimized, false, null), seen, 'minimized: the same identity');
  assert.equal(visionContextChange(seen, keyOf('s:m1', minimized, false, null)), 'none');
  assert.equal(visionContextChange(seen, keyOf('s:m1', hiddenToTray, false, null)), 'seeing', 'hidden: it changes, as before');
  assert.equal(keyOf('s:m1', shown, true, 2, false), '', 'nothing shared: no identity');
});

test('a minimize and a mood-token rotation together: still no clear of what she was shown, only her mood scope', () => {
  const before = keyOf('s:m1', shown, true, 2);
  const after = keyOf('s:m2', minimized, false, null); // she minimized and her mood token rotated in the same moment
  assert.equal(visionContextChange(before, after), 'mood', 'not "seeing": the warm process and frames stay');
  assert.equal(visionContextChange(before, keyOf('s:m2', hiddenToTray, false, null)), 'seeing', 'a tray hide with a rotation still clears');
});

test('the host record carries minimized as its own revision, only while true', () => {
  const pet = new WindowVisibility(20, true, true);
  assert.deepEqual(pet.observe(true, true), { windowId: 20, revision: 0, visible: true, petVisible: true });
  assert.deepEqual(pet.observe(false, true, true), { windowId: 20, revision: 1, visible: false, petVisible: true, minimized: true });
  assert.equal(pet.observe(false, true, true).revision, 1, 'the same state: no new revision');
  assert.deepEqual(pet.observe(false, true, false), { windowId: 20, revision: 2, visible: false, petVisible: true }, 'minimized to hidden: a revision, no key');
  assert.deepEqual(pet.observe(true, true), { windowId: 20, revision: 3, visible: true, petVisible: true });
});

test('the page record reads minimized only while not visible, and refuses a non-boolean', () => {
  const tracker = new WindowVisibilityTracker();
  assert.equal(tracker.accept({ windowId: 3, revision: 1, visible: false, petVisible: true, minimized: true }), true);
  assert.equal(tracker.minimized, true);
  assert.equal(tracker.accept({ windowId: 3, revision: 2, visible: false, petVisible: true }), true);
  assert.equal(tracker.minimized, false, 'hidden to the tray');
  assert.equal(tracker.accept({ windowId: 3, revision: 3, visible: true, petVisible: true, minimized: true }), true);
  assert.equal(tracker.minimized, false, 'visible: never a step away');
  assert.equal(new WindowVisibilityTracker().accept({ windowId: 3, revision: 1, visible: false, petVisible: true, minimized: 'yes' as unknown as boolean }), false);
});

test('a closed control window does not cut off her chat reply while she is on screen; her own tasks, authoring and an unseen reply still end', () => {
  const chat = { kind: 'chat' }, authoring = { kind: 'chat', source: 'language-authoring' };
  assert.equal(abortsWithClosedWindow(chat, { owner: 'controls' }, true), false, 'she is on screen: the reply goes on');
  assert.equal(abortsWithClosedWindow(chat, { owner: 'controls' }, false), true, 'she is nowhere on screen: as before');
  assert.equal(abortsWithClosedWindow(authoring, { owner: 'controls' }, true), true, 'authoring ends with its window');
  assert.equal(abortsWithClosedWindow(chat, { owner: 'pet' }, true), true, 'the companion window\'s own turn ends with it');
  assert.equal(abortsWithClosedWindow({ kind: 'agent' }, { owner: 'controls' }, true), true);
});

test('a hide of the control window (she on screen) or a minimize of her window keeps the look and the reply; a destroyed or hidden one ends it', () => {
  assert.equal(leaveClearsVision(hiddenToTray, 'controls', true), false, 'control window hid, she is on screen');
  assert.equal(leaveClearsVision(hiddenToTray, 'controls', false), true, 'control window hid, she is nowhere');
  assert.equal(leaveClearsVision(minimized, 'pet', true), false, 'her window minimized');
  assert.equal(leaveClearsVision(hiddenToTray, 'pet', false), true, 'her window hidden to the tray');
  assert.equal(leaveClearsVision(win(false, false, true), 'controls', true), true, 'a destroyed window');
});

test('the wiring step: a minimize stops the computer\'s sound and the pointer but keeps the reply; a hide ends all three; a shown window does nothing', () => {
  const run = (w: AwayWindow, onScreen: boolean) => {
    const calls: string[] = [];
    companionHiddenStep(w, { onScreen: () => onScreen, stopSystemAudio: () => calls.push('audio'), cancelCompletedReply: () => calls.push('reply'), resetPointer: () => calls.push('pointer') });
    return calls;
  };
  assert.deepEqual(run(minimized, false), ['audio', 'pointer'], 'minimized: the reply is not cancelled');
  assert.deepEqual(run(hiddenToTray, false), ['audio', 'reply', 'pointer'], 'hidden: as before');
  assert.deepEqual(run(hiddenToTray, true), ['reply', 'pointer'], 'out in Unbound (still on screen): her senses keep going');
  assert.deepEqual(run(shown, true), []);
});

test('her chat process is told she is seen at the start and on every window event, a minimize counting as seen', () => {
  const listeners: Record<string, () => void> = {};
  const state = { visible: true, minimized: false };
  const w = { isDestroyed: () => false, isVisible: () => state.visible, isMinimized: () => state.minimized, on: (name: string, fn: () => void) => { listeners[name] = fn; } };
  const told: boolean[] = [];
  watchChatSeen(w, seen => told.push(seen));
  assert.deepEqual(told, [true]);
  state.visible = false; state.minimized = true; listeners.minimize!();
  state.minimized = false; listeners.hide!();
  state.visible = true; listeners.restore!();
  assert.deepEqual(told, [true, true, false, true], 'minimize: seen; hide: not seen; restore: seen');
});
