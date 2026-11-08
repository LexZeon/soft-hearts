import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeElectron, killOwnElectron } from '../scripts/lib/electron-cleanup.mjs';

// The smokes' own launched app stands in as a plain child process: a hung main process
// (e.g. behind Electron's uncaught-exception dialog) never answers instance.close().
function hungApp() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  return { child, exited, instance: { close: () => new Promise<void>(() => {}), process: () => child } };
}

test('a hung app is ended by the bounded close instead of being left on the desktop', async () => {
  const app = hungApp();
  try {
    const result = await closeElectron(app.instance, 150);
    assert.equal(result.closed, false);
    assert.equal(result.killed, true);
    await app.exited;
    assert.notEqual(app.child.exitCode ?? app.child.signalCode, null);
  } finally { app.child.kill(); }
});

test('a normal close is awaited and nothing is killed', async () => {
  let closed = false;
  const result = await closeElectron({ close: async () => { closed = true; }, process: () => { throw Error('connection gone'); } }, 1000);
  assert.deepEqual(result, { closed: true, killed: false });
  assert.equal(closed, true);
  assert.deepEqual(await closeElectron(null), { closed: true, killed: false });
});

test('only the smoke\'s own, still running process is ended', async () => {
  assert.equal(killOwnElectron(null), false);
  assert.equal(killOwnElectron({ process: () => { throw Error('connection gone'); } }), false);
  const app = hungApp();
  app.child.kill(); await app.exited;
  assert.equal(killOwnElectron(app.instance), false, 'an exited child is not killed again');
});
