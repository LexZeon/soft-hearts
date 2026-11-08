import assert from 'node:assert/strict';
import test from 'node:test';
import { initialControlsVisible } from '../electron/initial-controls';

test('startup never leaves the user with no visible window when the pet stays hidden by preference', () => {
  // R37: a saved "hidden" pet (tray, Ctrl+Alt+P or Alt+F4 on the pet) plus a ready model
  // used to show neither window at startup, which reads as "the app started invisible".
  assert.equal(initialControlsVisible(true, false, false), true);
});

test('an ordinary immersive start with a visible pet keeps the control window closed', () => {
  assert.equal(initialControlsVisible(true, false, true), false);
});

test('setup and developer sessions still open the controls', () => {
  assert.equal(initialControlsVisible(false, false, true), true);
  assert.equal(initialControlsVisible(false, false, false), true);
  assert.equal(initialControlsVisible(true, true, true), true);
});
