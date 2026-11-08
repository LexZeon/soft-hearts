import test from 'node:test';
import assert from 'node:assert/strict';
import { VisualSelfContext, type VisualSelfSnapshot, type VisualSelfFrameProof, type VisualSelfSource } from '../electron/visual-self-context';

function context(revision = 1): VisualSelfSnapshot {
  return { revision, character: { key: 'internal-card-A', publicName: '当前角色 A' }, model: { key: 'internal-actual-avatar-B' },
    window: { role: 'pet', key: 'internal-pet-window', revision, visible: true },
    sources: [{ kind: 'screen', key: 'internal-screen-source', revision }] };
}
function fixture() {
  const clock = { now: 1000 }; let count = 0;
  const host = new VisualSelfContext({ clock: () => clock.now, mint: () => `opaque-${++count}` });
  const current = context(); assert.equal(host.setContext(current), true);
  return { host, clock, current, begin: () => { const h = host.beginOpportunity('user-message', 'accepted-turn', clock.now + 2000); assert.ok(h); return h; } };
}
function proof(now: number, kind: VisualSelfSource = 'screen', revision = 1): VisualSelfFrameProof {
  return { frameKey: 'internal-frame-PRIVATE', contextRevision: revision, sourceKey: kind === 'screen' ? 'internal-screen-source' : 'internal-camera-source', sourceRevision: revision, capturedAt: now, expiresAt: now + 1000 };
}

test('current card identity is independent of actual avatar; output is minimal and always pixel-UNKNOWN', () => {
  const f = fixture(), op = f.begin(), ticket = f.host.issueFrameTicket(op, 'screen')!;
  const hint = f.host.buildHint(op, ticket, proof(f.clock.now))!; assert.ok(hint);
  assert.equal(hint.character.publicName, '当前角色 A'); assert.ok(hint.avatar);
  assert.notEqual(hint.character.ref, hint.avatar.ref);
  assert.equal(hint.selfInFrame, 'UNKNOWN'); assert.equal(hint.region, null); assert.equal(hint.reason, 'FRAME_PIXELS_UNVERIFIED');
  assert.equal(f.host.isCurrent(op, hint), true);
  const serialized = JSON.stringify(hint);
  for (const privateKey of ['internal-card-A', 'internal-actual-avatar-B', 'internal-screen-source', 'internal-frame-PRIVATE', 'internal-pet-window']) assert.equal(serialized.includes(privateKey), false);
  assert.deepEqual(Object.keys(hint).sort(), ['version', 'frameRef', 'source', 'sourceRef', 'character', 'avatar', 'selfInFrame', 'region', 'reason'].sort());
});

test('no configured consent, invisible pet, foreign role or forged opportunity can open a projection', () => {
  const host = new VisualSelfContext({ clock: () => 1000 });
  assert.equal(host.beginOpportunity('user-message', 'accepted', 2000), null);
  const c = context(); c.sources = []; assert.equal(host.setContext(c), true);
  assert.equal(host.beginOpportunity('user-message', 'accepted', 2000), null);
  const hidden = context(2); hidden.window.visible = false; assert.equal(host.setContext(hidden), true);
  assert.equal(host.beginOpportunity('accepted-proactive-vision', 'accepted', 2000), null);
  const f = fixture();
  assert.equal(f.host.beginOpportunity('idle-poll' as never, 'accepted', 2000), null);
  assert.equal(f.host.beginOpportunity('user-message', 'private/path', 2000), null);
  assert.equal(f.host.beginOpportunity('user-message', 'accepted', 1000), null);
  const op = f.begin(); assert.equal(f.host.issueFrameTicket({ ...op }, 'screen'), null);
  assert.equal(f.host.issueFrameTicket(op, 'camera'), null);
  const foreign = context(2); foreign.window.role = 'controls' as never;
  assert.equal(f.host.setContext(foreign), false); assert.equal(f.host.beginOpportunity('user-message', 'accepted', 2000), null);
});

test('frame receipts reject cross-source, wrong generation, stale/future and expired metadata without exposing geometry', () => {
  const f = fixture(), op = f.begin();
  const cases: Partial<VisualSelfFrameProof>[] = [
    { contextRevision: 0 }, { sourceRevision: 0 }, { sourceKey: 'other-source' }, { capturedAt: 999 },
    { capturedAt: 1001 }, { expiresAt: 1000 }, { frameKey: 'private/file.jpg' },
  ];
  for (const delta of cases) {
    const ticket = f.host.issueFrameTicket(op, 'screen')!;
    assert.equal(f.host.buildHint(op, ticket, { ...proof(f.clock.now), ...delta }), null);
  }
  const ticket = f.host.issueFrameTicket(op, 'screen')!;
  assert.equal(f.host.buildHint(op, ticket, { ...proof(f.clock.now), region: { x: 0, y: 0, width: 1, height: 1 } } as never), null);
  assert.equal(f.host.buildHint(op, { ...ticket }, proof(f.clock.now)), null);
  const hint = f.host.buildHint(op, ticket, proof(f.clock.now)); assert.ok(hint);
  assert.equal(f.host.buildHint(op, ticket, proof(f.clock.now)), null, 'one ticket builds once');
  assert.equal(f.host.isCurrent(op, { ...hint }), false, 'serialized values are not a host lease');
});

test('frame expiry, opportunity expiry and backward clock invalidate rather than making an old frame young', () => {
  const f = fixture(), op = f.begin(), ticket = f.host.issueFrameTicket(op, 'screen')!;
  const hint = f.host.buildHint(op, ticket, proof(f.clock.now))!;
  f.clock.now = 2000; assert.equal(f.host.isCurrent(op, hint), false, 'exact frame expiry rejects');
  const second = f.begin(), secondTicket = f.host.issueFrameTicket(second, 'screen')!;
  const secondHint = f.host.buildHint(second, secondTicket, proof(f.clock.now))!;
  f.clock.now = 1999; assert.equal(f.host.isCurrent(second, secondHint), false);
  f.clock.now = 2000; assert.equal(f.host.isCurrent(second, secondHint), false, 'clock recovery cannot restore cancelled scope');
  const third = f.begin(), thirdTicket = f.host.issueFrameTicket(third, 'screen')!;
  const thirdHint = f.host.buildHint(third, thirdTicket, { ...proof(f.clock.now), expiresAt: 9000 })!;
  f.clock.now = 4000; assert.equal(f.host.isCurrent(third, thirdHint), false, 'opportunity caps frame lifetime');
  f.host.dispose(); assert.equal(f.host.beginOpportunity('user-message', 'accepted', 9000), null);
});

test('hide, card/model/source changes invalidate old hints and unresolved actual model stays UNKNOWN', () => {
  for (const change of ['hide', 'card', 'model', 'source', 'off'] as const) {
    const f = fixture(), op = f.begin(), ticket = f.host.issueFrameTicket(op, 'screen')!;
    const hint = f.host.buildHint(op, ticket, proof(f.clock.now))!;
    const next = context(2);
    if (change === 'hide') next.window.visible = false;
    if (change === 'card') next.character = { key: 'new-card', publicName: '另一个角色' };
    if (change === 'model') next.model = { key: 'new-actual-model' };
    if (change === 'source') next.sources = [{ kind: 'screen', key: 'another-screen', revision: 2 }];
    if (change === 'off') next.sources = [];
    assert.equal(f.host.setContext(next), true); assert.equal(f.host.isCurrent(op, hint), false, change);
    assert.equal(f.host.buildHint(op, ticket, proof(f.clock.now)), null);
  }
  const f = fixture(), noModel = context(2); noModel.model = null;
  assert.equal(f.host.setContext(noModel), true); const op = f.begin(), ticket = f.host.issueFrameTicket(op, 'screen')!;
  const hint = f.host.buildHint(op, ticket, proof(f.clock.now, 'screen', 2))!;
  assert.equal(hint.avatar, null); assert.equal(hint.reason, 'MODEL_NOT_RESOLVED'); assert.equal(hint.region, null);
});

test('late cancellation, frame callback and stale native snapshot cannot cancel a newer valid opportunity', () => {
  const f = fixture(), first = f.begin(), oldTicket = f.host.issueFrameTicket(first, 'screen')!;
  const second = f.begin(), currentTicket = f.host.issueFrameTicket(second, 'screen')!;
  const hint = f.host.buildHint(second, currentTicket, proof(f.clock.now))!;
  assert.equal(f.host.cancel(first), false);
  assert.equal(f.host.buildHint(first, oldTicket, proof(f.clock.now)), null);
  assert.equal(f.host.isCurrent(second, hint), true);
  const next = context(2); assert.equal(f.host.setContext(next), true);
  const third = f.begin(), ticket = f.host.issueFrameTicket(third, 'screen')!;
  const thirdHint = f.host.buildHint(third, ticket, proof(f.clock.now, 'screen', 2))!;
  assert.equal(f.host.setContext(context(1)), false); assert.equal(f.host.isCurrent(third, thirdHint), true);
  const staleWindow = context(3); staleWindow.window.revision = 1;
  assert.equal(f.host.setContext(staleWindow), false); assert.equal(f.host.isCurrent(third, thirdHint), true);
  assert.equal(f.host.cancel(third), true); assert.equal(f.host.isCurrent(third, thirdHint), false);
});

test('input is copied, output frozen, and private extra fields/accessors cannot become a context', () => {
  const f = fixture(); f.current.character.publicName = 'Mutated outside';
  const op = f.begin(), ticket = f.host.issueFrameTicket(op, 'screen')!, hint = f.host.buildHint(op, ticket, proof(f.clock.now))!;
  assert.equal(hint.character.publicName, '当前角色 A'); assert.equal(Object.isFrozen(hint), true); assert.equal(Object.isFrozen(hint.character), true);
  assert.throws(() => { (hint.character as { publicName: string }).publicName = 'forged'; });
  assert.equal(f.host.setContext({ ...context(2), apiKey: 'private-key', history: ['private'], modelPath: 'C:/private/model.pmx' } as never), false);
  assert.equal(f.host.isCurrent(op, hint), false); assert.equal(f.host.beginOpportunity('user-message', 'accepted', 2000), null);
  let reads = 0; const bad = context(2); Object.defineProperty(bad.character, 'publicName', { get() { reads++; return 'secret'; }, enumerable: true });
  assert.equal(f.host.setContext(bad), false); assert.equal(reads, 0);
  assert.equal(f.host.setContext(context(2)), true); assert.ok(f.begin());
});

test('screen and camera have separate opaque frame receipts, and a newer same-source frame supersedes its predecessor', () => {
  const f = fixture(), c = context(2); c.sources = [...c.sources, { kind: 'camera', key: 'internal-camera-source', revision: 2 }];
  assert.equal(f.host.setContext(c), true); const op = f.begin();
  const screenTicket = f.host.issueFrameTicket(op, 'screen')!, cameraTicket = f.host.issueFrameTicket(op, 'camera')!;
  const screen = f.host.buildHint(op, screenTicket, proof(f.clock.now, 'screen', 2))!;
  const camera = f.host.buildHint(op, cameraTicket, proof(f.clock.now, 'camera', 2))!;
  assert.notEqual(screen.frameRef, camera.frameRef); assert.notEqual(screen.sourceRef, camera.sourceRef);
  assert.equal(camera.reason, 'CAMERA_HAS_NO_SCREEN_CORRELATION'); assert.equal(camera.region, null); assert.equal(camera.selfInFrame, 'UNKNOWN');
  assert.equal(f.host.isCurrent(op, screen), true); assert.equal(f.host.isCurrent(op, camera), true);
  const replacement = f.host.issueFrameTicket(op, 'screen')!;
  assert.equal(f.host.isCurrent(op, screen), false); assert.equal(f.host.isCurrent(op, camera), true);
  assert.ok(f.host.buildHint(op, replacement, proof(f.clock.now, 'screen', 2)));
});

test('expiry crossing inside construction cannot emit a hint before the final send check', () => {
  let now = 1000, reads = 0, count = 0;
  const ticks: number[] = [];
  const host = new VisualSelfContext({ clock: () => { reads++; return ticks.length ? ticks.shift()! : now; }, mint: () => `clock-${++count}` });
  assert.equal(host.setContext(context()), true);
  const op = host.beginOpportunity('user-message', 'accepted', 1002)!;
  const ticket = host.issueFrameTicket(op, 'screen')!;
  now = 1001;
  const candidate = proof(now);
  // The frame record is a plain data record, but the trusted injected clock may
  // advance between live() and the later receipt-time check.
  ticks.push(1001, 1002); now = 1002;
  assert.equal(host.buildHint(op, ticket, candidate), null);
  assert.equal(host.issueFrameTicket(op, 'screen'), null);
  assert.ok(reads >= 3);
});
