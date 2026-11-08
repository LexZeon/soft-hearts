import test from 'node:test';
import assert from 'node:assert/strict';
import { VisualSelfRuntime, type VisualSelfLease } from '../electron/visual-self-runtime';
import type { VisualSelfSnapshot, VisualSelfSource } from '../electron/visual-self-context';

// In-memory 1px PNG fixtures. No capture, decoder, provider or filesystem is used.
const PNG_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/QAAAABJRU5ErkJggg==';
const PNG_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_C = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
const frame = (source: string = 'screen', dataUrl = PNG_A) => ({ source, dataUrl });
function snapshot(): VisualSelfSnapshot {
  return {
    revision: 1,
    character: { key: 'private-character-key', publicName: 'Gene' },
    model: null,
    window: { role: 'pet', key: 'private-window-key', revision: 1, visible: true },
    sources: [
      { kind: 'screen', key: 'private-screen-key', revision: 1 },
      { kind: 'camera', key: 'private-camera-key', revision: 1 },
    ],
  };
}
function fixture() {
  let now = 1000;
  let serial = 0;
  const runtime = new VisualSelfRuntime({ clock: () => now, mint: () => `opaque-${++serial}` });
  assert.equal(runtime.setContext(snapshot()), true);
  return { runtime, at: (time: number) => { now = time; } };
}
function capture(runtime: VisualSelfRuntime, kind: VisualSelfSource = 'screen', dataUrl = PNG_A, expiry = 20_000) {
  const token = runtime.beginCapture(kind);
  assert.ok(token);
  assert.equal(runtime.completeCapture(token, frame(kind, dataUrl), 1000, expiry), true);
  return token;
}
function projection(runtime: VisualSelfRuntime, lease: VisualSelfLease | null) {
  assert.ok(lease);
  const text = runtime.read(lease);
  assert.equal(typeof text, 'string');
  assert.ok(text!.length <= 4096);
  const parsed = JSON.parse(text!) as { visualSelf: { source: VisualSelfSource; selfInFrame: string; region: unknown; avatar: unknown }[] };
  assert.deepEqual(Object.keys(parsed), ['visualSelf']);
  assert.ok(Array.isArray(parsed.visualSelf));
  assert.ok(parsed.visualSelf.length > 0 && parsed.visualSelf.length <= 2);
  for (const hint of parsed.visualSelf) {
    assert.equal(hint.selfInFrame, 'UNKNOWN');
    assert.equal(hint.region, null);
    assert.equal(hint.avatar, null);
  }
  for (const forbidden of ['private-character-key', 'private-window-key', 'private-screen-key', 'private-camera-key', 'data:image', PNG_A, PNG_B]) {
    assert.equal(text!.includes(forbidden), false);
  }
  return parsed.visualSelf;
}

test('only exact host bytes and source resolve a receipt; labels and a different valid image do not', () => {
  for (const attached of [frame('camera'), frame('screen', PNG_B)]) {
    const { runtime } = fixture();
    try {
      capture(runtime);
      assert.equal(runtime.accept('user-message', 'wrong-frame', [attached], 10_000), null);
    } finally { runtime.dispose(); }
  }
  const { runtime } = fixture();
  try {
    assert.equal(runtime.accept('user-message', 'no-receipt', [frame()], 10_000), null);
    capture(runtime);
    assert.deepEqual(projection(runtime, runtime.accept('user-message', 'exact-frame', [frame()], 10_000)).map(h => h.source), ['screen']);
  } finally { runtime.dispose(); }
});

test('copied and superseded capture tokens cannot complete the current pending host capture', () => {
  const { runtime } = fixture();
  try {
    const first = runtime.beginCapture('screen'); assert.ok(first); assert.equal(Object.isFrozen(first), true);
    assert.equal(runtime.completeCapture({ ...first }, frame(), 1000, 10_000), false);
    const newer = runtime.beginCapture('screen'); assert.ok(newer);
    assert.equal(runtime.completeCapture(first, frame(), 1000, 10_000), false);
    assert.equal(runtime.completeCapture(newer, frame('screen', PNG_B), 1000, 10_000), true);
    assert.equal(runtime.completeCapture(newer, frame(), 1000, 10_000), false);
    assert.deepEqual(projection(runtime, runtime.accept('user-message', 'new-capture', [frame('screen', PNG_B)], 9000)).map(h => h.source), ['screen']);
  } finally { runtime.dispose(); }
});

test('equal normalized context preserves an earlier exact cached receipt for a later accepted opportunity', () => {
  const { runtime, at } = fixture();
  try {
    capture(runtime);
    at(1300);
    const same = snapshot(); same.character.publicName = ' Gene '; same.sources = [...same.sources].reverse();
    assert.equal(runtime.setContext(same), true);
    at(1700);
    assert.deepEqual(projection(runtime, runtime.accept('accepted-proactive-vision', 'later-accepted', [frame()], 5000)).map(h => h.source), ['screen']);
  } finally { runtime.dispose(); }
});

test('hide, source replacement and invalid context invalidate both pending capture and active projection', () => {
  const transitions = [
    (s: VisualSelfSnapshot) => { s.revision++; s.window.revision++; s.window.visible = false; },
    (s: VisualSelfSnapshot) => { s.revision++; s.sources = [{ kind: 'screen', key: 'replacement-screen', revision: 2 }]; },
    (s: VisualSelfSnapshot) => { s.revision++; s.sources = []; },
    (s: VisualSelfSnapshot) => { s.character.publicName = ''; },
  ];
  for (const transition of transitions) {
    const { runtime } = fixture();
    try {
      capture(runtime);
      const lease = runtime.accept('user-message', 'before-change', [frame()], 10_000); assert.ok(lease);
      const pending = runtime.beginCapture('camera'); assert.ok(pending);
      const changed = snapshot(); transition(changed); runtime.setContext(changed);
      assert.equal(runtime.read(lease), undefined);
      assert.equal(runtime.completeCapture(pending, frame('camera', PNG_B), 1000, 10_000), false);
      assert.equal(runtime.accept('user-message', 'after-change', [frame()], 10_000), null);
    } finally { runtime.dispose(); }
  }
});

test('bad capture source, time or image consumes that token and cannot be repaired by its late callback', () => {
  const invalid = [
    { attachment: frame('camera'), capturedAt: 1000, expiresAt: 2000 },
    { attachment: frame(), capturedAt: 999, expiresAt: 2000 },
    { attachment: frame(), capturedAt: 1001, expiresAt: 2000 },
    { attachment: frame(), capturedAt: 1000, expiresAt: 1000 },
    { attachment: frame('screen', 'data:image/png;base64,%%%'), capturedAt: 1000, expiresAt: 2000 },
  ];
  for (const attempt of invalid) {
    const { runtime } = fixture();
    try {
      const token = runtime.beginCapture('screen'); assert.ok(token);
      assert.equal(runtime.completeCapture(token, attempt.attachment, attempt.capturedAt, attempt.expiresAt), false);
      assert.equal(runtime.completeCapture(token, frame(), 1000, 2000), false);
      assert.equal(runtime.accept('user-message', 'failed-capture', [frame()], 2000), null);
    } finally { runtime.dispose(); }
  }
});

test('receipt expiry, sixty-second cap and time rollback cannot revive cached or pending work', () => {
  for (const [expiry, deadline] of [[1010, 1010], [1_000_000, 61_001]]) {
    const { runtime, at } = fixture();
    try {
      capture(runtime, 'screen', PNG_A, expiry);
      const lease = runtime.accept('user-message', 'expires', [frame()], 1_000_000); assert.ok(lease);
      at(deadline);
      assert.equal(runtime.read(lease), undefined);
      assert.equal(runtime.accept('user-message', 'expired-cache', [frame()], 1_000_001), null);
    } finally { runtime.dispose(); }
  }
  const { runtime, at } = fixture();
  try {
    capture(runtime);
    const lease = runtime.accept('user-message', 'before-rollback', [frame()], 9000); assert.ok(lease);
    const pending = runtime.beginCapture('camera'); assert.ok(pending);
    at(999); assert.equal(runtime.read(lease), undefined);
    at(1100);
    assert.equal(runtime.completeCapture(pending, frame('camera'), 1000, 9000), false);
    assert.equal(runtime.accept('user-message', 'after-rollback', [frame()], 9000), null);
  } finally { runtime.dispose(); }
});

test('one receipt per source replaces earlier bytes and projection contains at most two source hints', () => {
  const { runtime } = fixture();
  try {
    capture(runtime, 'screen', PNG_A);
    capture(runtime, 'camera', PNG_B);
    capture(runtime, 'screen', PNG_C);
    assert.equal(runtime.accept('user-message', 'replaced-screen', [frame('screen', PNG_A)], 9000), null);
    const lease = runtime.accept('user-message', 'two-current-sources', [frame('screen', PNG_C), frame('camera', PNG_B)], 9000);
    assert.deepEqual(projection(runtime, lease).map(h => h.source).sort(), ['camera', 'screen']);
  } finally { runtime.dispose(); }
});

test('old or copied lease reads/cancels cannot clear the new lease; clear and dispose revoke access', () => {
  const { runtime } = fixture();
  try {
    capture(runtime);
    const old = runtime.accept('user-message', 'old-message', [frame()], 9000); assert.ok(old);
    const current = runtime.accept('user-message', 'new-message', [frame()], 9000); assert.ok(current);
    assert.equal(Object.isFrozen(current), true);
    assert.equal(runtime.read(old), undefined);
    assert.equal(runtime.read({ ...current }), undefined);
    runtime.cancel(old); runtime.cancel({ ...current });
    projection(runtime, current);
    runtime.cancelActive(); assert.equal(runtime.read(current), undefined);
    const beforeClear = runtime.accept('user-message', 'before-clear', [frame()], 9000); assert.ok(beforeClear);
    runtime.clear(); assert.equal(runtime.read(beforeClear), undefined);
    assert.equal(runtime.setContext(snapshot()), false);
    const fresh = snapshot(); fresh.revision++; fresh.window.revision++;
    assert.equal(runtime.setContext(fresh), true);
    assert.equal(runtime.accept('user-message', 'cache-cleared', [frame()], 9000), null);
    runtime.dispose();
    assert.equal(runtime.beginCapture('screen'), null);
    assert.equal(runtime.setContext({ ...fresh, revision: 3 }), false);
  } finally { runtime.dispose(); }
});
