import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import type { AudioCaptureDescriptor } from '../shared/audio-capture';

test('actual system driver rechecks dance intent after a delayed physical-ready acknowledgement', async () => {
  const source = await readFile(new URL('../src/ui/AudioReadingClient.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('AudioReadingClient.ts', source, ts.ScriptTarget.Latest, true);
  const klass = tree.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === 'AudioReadingClient') as ts.ClassDeclaration;
  const method = klass.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(tree) === 'driveSystem')!;
  assert.ok(method);
  const script = ts.transpile(`class Driver { ${method.getText(tree)} }; globalThis.Driver = Driver;`, { target: ts.ScriptTarget.ES2022 });
  const context = vm.createContext({}); vm.runInContext(script, context);
  const driver = new context.Driver();
  let desired: AudioCaptureDescriptor = { id: 'physical-system', source: 'system-audio', owner: 'pet', revision: 2, chat: false, dance: true,
    ambient: { scopeId: 'reading', source: 'system-audio', epoch: 1, captureId: 'physical-system' } };
  let finishAck!: (value: boolean) => void, enteredAck!: () => void;
  const waiting = new Promise<void>(resolve => { enteredAck = resolve; });
  const acknowledgement = new Promise<boolean>(resolve => { finishAck = resolve; });
  const music: boolean[] = [];
  const input = { active: true, async setEnabled(enabled: boolean) { assert.equal(enabled, true); } };
  driver.options = { system: input, api: { ackAudioCapture: () => { enteredAck(); return acknowledgement; } }, onMusicEnabled: (value: boolean) => music.push(value) };
  driver.owned = () => desired;
  driver.releaseSystem = () => { throw Error('same physical owner must not be released'); };
  const running = driver.driveSystem(); await waiting;
  desired = { ...desired, revision: 3, dance: false };
  driver.systemOwned = desired;
  music.push(false); // actual capture event has already presented the newer off intent
  finishAck(true); await running;
  assert.deepEqual(music, [false], 'ready ack cannot bypass the host-frame fusion route');
  assert.equal(driver.startingSystem, false); assert.equal(driver.systemPending, null);
});
