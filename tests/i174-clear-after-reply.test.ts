// I-174 item 9b (docs/claude/2026-11-21-i174-parity-fixes.md): with the camera on, a minimize or the control window hiding releases the
// camera (kept: privacy) and ends the look's context; the page used to clear the conversation at once, stopping her reply in progress.
// A step away's clear now waits for that reply (src/brain/clear-after-reply.ts); any other clear is immediate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLEAR_AFTER_REPLY, clearAfterReply, clearKeepsReply } from '../src/brain/clear-after-reply';

function fakeTimer() {
  let run: (() => void) | null = null;
  return { every: (_ms: number, fn: () => void) => { run = fn; return () => { run = null; }; }, tick: () => run?.(), get running() { return run !== null; } };
}

test('a step away\'s clear waits for her reply to end, then starts the new conversation', () => {
  const timer = fakeTimer(); let active: string | null = 'r1', cleared = 0;
  clearAfterReply({ afterReply: true }, { active: () => active, clear: () => cleared++, every: timer.every });
  assert.equal(cleared, 0, 'her reply goes on (before: cleared and stopped at once)');
  timer.tick(); assert.equal(cleared, 0);
  active = null; timer.tick();
  assert.equal(cleared, 1, 'over: the new conversation starts');
  assert.equal(timer.running, false);
});

test('no reply in progress, or any other clear (sharing off, a hide to the tray): at once', () => {
  let cleared = 0;
  clearAfterReply({ afterReply: true }, { active: () => null, clear: () => cleared++ });
  clearAfterReply(undefined, { active: () => 'r1', clear: () => cleared++ });
  clearAfterReply({ afterReply: 'yes' }, { active: () => 'r1', clear: () => cleared++ });
  assert.equal(cleared, 3);
  assert.equal(clearKeepsReply({ afterReply: true }), true);
  assert.equal(clearKeepsReply(null), false);
});

test('a new turn of yours that began meanwhile is not cut: the waiting clear is dropped', () => {
  const timer = fakeTimer(); let active: string | null = 'r1', cleared = 0;
  clearAfterReply({ afterReply: true }, { active: () => active, clear: () => cleared++, every: timer.every });
  active = 'r2'; timer.tick();
  assert.equal(cleared, 0);
  assert.equal(timer.running, false);
  assert.ok(CLEAR_AFTER_REPLY.capMs >= 60_000, 'a reply that never ends does not hold the clear forever');
});

// The host side (electron/wiring/senses-look-wiring.ts releaseCameraOnLeave), evaluated as the wiring has it.
test('the host: a step away with the camera on releases the camera and ends the context with her reply kept; a hide ends it at once', async () => {
  const ts = (await import('typescript')).default;
  const { WIRING_PRELUDE, wiringFunction } = await import('./helpers/wiring-source');
  const { leaveClearsVision } = await import('../shared/foundation/step-away');
  const run = (o: { minimized: boolean; camera: boolean }) => {
    // no-pet-ok: 'pet' is the media owner's existing name for the companion window
    const calls: string[] = [], state = { screenSharing: false, cameraSharing: o.camera, cameraOwner: 'pet' };
    const media = { get state() { return state; }, update: (patch: { cameraSharing: boolean }) => { state.cameraSharing = patch.cameraSharing; calls.push('camera off'); } };
    const env = { media, leaveClearsVision, herOnScreen: () => false, proactiveVision: { pendingId: null }, lookAttachments: { busy: false },
      clearVisionContext: (keep?: boolean) => calls.push(keep ? 'clear after reply' : 'clear now'), mediaChanged: () => calls.push('changed') };
    const code = ts.transpileModule(WIRING_PRELUDE + '\n' + wiringFunction('releaseCameraOnLeave') + '\nreturn releaseCameraOnLeave;', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const release = new Function(...Object.keys(env), code)(...Object.values(env)) as (win: unknown, owner: string) => void;
    // no-pet-ok: the media owner's existing name
    release({ isDestroyed: () => false, isVisible: () => !o.minimized, isMinimized: () => o.minimized }, 'pet');
    return calls;
  };
  assert.deepEqual(run({ minimized: true, camera: true }), ['clear after reply', 'camera off', 'changed'], 'minimized with the camera on: released (privacy), her reply kept');
  assert.deepEqual(run({ minimized: true, camera: false }), [], 'minimized, nothing shared: nothing ends (I-171)');
  assert.deepEqual(run({ minimized: false, camera: true }), ['clear now', 'camera off', 'changed'], 'a hide to the tray: ends at once, as before');
});
