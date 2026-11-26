// The app's own windows may write the clipboard (every 「复制」 button), never read it; other frames and pages may not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wiringSource } from './helpers/wiring-source';
import { CLIPBOARD_WRITE_PERMISSION, allowsClipboardWrite } from '../electron/safety/clipboard-permission';

test('own window, main frame, write: allowed', () => {
  assert.equal(allowsClipboardWrite(CLIPBOARD_WRITE_PERMISSION, true, true), true);
});

test('reading the clipboard, another window, a subframe, or any other permission: denied', () => {
  assert.equal(allowsClipboardWrite('clipboard-read', true, true), false);
  assert.equal(allowsClipboardWrite(CLIPBOARD_WRITE_PERMISSION, true, false), false);
  assert.equal(allowsClipboardWrite(CLIPBOARD_WRITE_PERMISSION, false, true), false);
  for (const other of ['media', 'notifications', 'geolocation', 'display-capture', 'openExternal', ''])
    assert.equal(allowsClipboardWrite(other, true, true), false, other);
});

test('both session permission handlers ask the same rule (check and request)', () => {
  const main = wiringSource(); // the handlers moved to electron/wiring/shell-wiring.ts (wiring rewrite step 3)
  const check = main.slice(main.indexOf('setPermissionCheckHandler('), main.indexOf('setPermissionRequestHandler('));
  const request = main.slice(main.indexOf('setPermissionRequestHandler('));
  assert.match(check, /allowsClipboardWrite\(/);
  assert.match(request.slice(0, 1200), /allowsClipboardWrite\(/);
});
