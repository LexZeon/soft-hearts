import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import ts from 'typescript';

const names = [
  'getAudioReadingView', 'setAudioReadingIntent', 'onAudioReadingView', 'getAudioCaptureState',
  'onAudioCaptureState', 'ackAudioCapture', 'submitAudioReadingPcm', 'setAudioDanceIntent',
  'setAudioDanceSourceIntent', 'submitAudioDanceSample', 'onAudioDanceSample',
] as const;
const preloadText = readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');
const contractText = readFileSync(new URL('../shared/contracts.ts', import.meta.url), 'utf8');
const parse = (name: string, text: string) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const preload = parse('electron/preload.ts', preloadText), contracts = parse('shared/contracts.ts', contractText);
function variable(name: string): ts.VariableStatement {
  const found = preload.statements.filter((node): node is ts.VariableStatement => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(value => ts.isIdentifier(value.name) && value.name.text === name));
  assert.equal(found.length, 1, 'one actual preload variable: ' + name); return found[0];
}
const apiStatement = variable('api');
const apiDeclaration = apiStatement.declarationList.declarations.find(value => ts.isIdentifier(value.name) && value.name.text === 'api')!;
assert.ok(apiDeclaration.initializer && ts.isObjectLiteralExpression(apiDeclaration.initializer));
const apiObject = apiDeclaration.initializer;
const subscribe = preload.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'subscribe');
assert.equal(subscribe.length, 1);
// Execute the checked-in helpers and complete API object against only an IPC
// boundary fixture. No Electron import, contextBridge, device or service runs.
const code = ts.transpileModule([variable('invoke'), subscribe[0], apiStatement].map(node => node.getText(preload)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

test('actual finite audio preload ports keep exact payloads and individually released callbacks', async () => {
  const typed = contracts.statements.filter((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === 'DesktopAPI');
  assert.equal(typed.length, 1); assert.equal(typed[0].members.some(ts.isIndexSignatureDeclaration), false);
  const channels = new Map([
    ['getAudioReadingView', ['invoke', 'getAudioReadingView']],
    ['setAudioReadingIntent', ['invoke', 'setAudioReadingIntent']],
    ['onAudioReadingView', ['subscribe', 'desk:audio-reading-view']],
    ['getAudioCaptureState', ['invoke', 'getAudioCaptureState']],
    ['onAudioCaptureState', ['subscribe', 'desk:audio-capture-state']],
    ['ackAudioCapture', ['invoke', 'ackAudioCapture']],
    ['submitAudioReadingPcm', ['invoke', 'submitAudioReadingPcm']],
    ['setAudioDanceIntent', ['invoke', 'setAudioDanceIntent']],
    ['setAudioDanceSourceIntent', ['invoke', 'setAudioDanceSourceIntent']],
    ['submitAudioDanceSample', ['invoke', 'submitAudioDanceSample']],
    ['onAudioDanceSample', ['subscribe', 'desk:audio-dance-sample']],
  ]);
  for (const name of names) {
    const properties = apiObject.properties.filter(node => ts.isPropertyAssignment(node) && node.name.getText(preload) === name);
    assert.equal(properties.length, 1, name);
    const property = properties[0] as ts.PropertyAssignment;
    assert.ok(ts.isArrowFunction(property.initializer) && ts.isCallExpression(property.initializer.body));
    const call = property.initializer.body, [helper, channel] = channels.get(name)!;
    assert.equal(call.expression.getText(preload), helper);
    assert.ok(ts.isStringLiteral(call.arguments[0])); assert.equal(call.arguments[0].text, channel);
    assert.equal(call.arguments.length, name.startsWith('get') ? 1 : 2);
    const signatures = typed[0].members.filter(node => ts.isMethodSignature(node) && node.name.getText(contracts) === name);
    assert.equal(signatures.length, 1, 'finite typed port: ' + name);
    assert.equal((signatures[0] as ts.MethodSignature).parameters.length, name.startsWith('get') ? 0 : 1);
  }
  const calls: { channel: string; args: unknown[] }[] = [], replies = new Map<string, unknown>();
  const events = new EventEmitter();
  const ipc = {
    invoke(channel: string, ...args: unknown[]) { calls.push({ channel, args }); return Promise.resolve(replies.get(channel)); },
    on: events.on.bind(events), removeListener: events.removeListener.bind(events),
  };
  const create = new Function('ipcRenderer', code + '\nreturn api;') as (value: typeof ipc) => Record<string, (...args: unknown[]) => unknown>;
  const api = create(ipc);
  for (const capability of ['invoke', 'subscribe', 'ipcRenderer', 'send', 'shell', 'execute', 'enumerateDevices'])
    assert.equal(Object.hasOwn(api, capability), false, 'no generic IPC/device capability: ' + capability);
  const intent = { source: 'microphone', purpose: 'movie', enabled: false };
  const captureAck = { id: 'host-capture', source: 'system-audio', revision: 7, phase: 'released' };
  const pcm = { token: { scopeId: 'host-scope', source: 'system-audio', epoch: 1, captureId: 'host-capture' },
    sequence: 1, startedAtMs: 0, pcm16: new ArrayBuffer(4) };
  const cases: [string, unknown[], unknown][] = [
    ['getAudioReadingView', [], { scopeId: 'view-reply' }],
    ['setAudioReadingIntent', [intent], { accepted: false }],
    ['getAudioCaptureState', [], { revision: 7 }],
    ['ackAudioCapture', [captureAck], false],
    ['submitAudioReadingPcm', [pcm], { accepted: true, segmentId: 'host-segment' }],
    ['setAudioDanceIntent', [false], { revision: 8 }],
    ['setAudioDanceIntent', [true], { revision: 9 }],
    ['setAudioDanceSourceIntent', [{ source: 'microphone', enabled: true }], { revision: 10 }],
    ['submitAudioDanceSample', [{ id: 'mic', source: 'microphone', revision: 10, sample: { time: 1, rms: 0.2, low: 0.1, mid: 0.1, high: 0 } }], true],
  ];
  for (const [name, args, response] of cases) {
    const channel = 'desk:' + name; replies.set(channel, response);
    const promise = api[name](...args); assert.ok(promise instanceof Promise);
    assert.equal(await promise, response);
    const sent = calls.at(-1)!; assert.equal(sent.channel, channel); assert.equal(sent.args.length, args.length);
    args.forEach((value, index) => assert.equal(sent.args[index], value, 'payload is forwarded without coercion or extra authority'));
  }
  assert.deepEqual(calls.map(value => value.channel), cases.map(([name]) => 'desk:' + name));
  const reading: unknown[][] = [], capture: unknown[][] = [];
  const stopReading = api.onAudioReadingView((...args: unknown[]) => reading.push(args));
  const stopCapture = api.onAudioCaptureState((...args: unknown[]) => capture.push(args));
  const dance: unknown[][] = [];
  const stopDance = api.onAudioDanceSample((...args: unknown[]) => dance.push(args)) as () => void;
  events.emit('desk:audio-dance-sample', { private: true }, { sample: 'bounded-frame' });
  assert.deepEqual(dance, [[{ sample: 'bounded-frame' }]]);
  stopDance(); events.emit('desk:audio-dance-sample', {}, { sample: 'late' }); assert.equal(dance.length, 1);
  assert.equal(typeof stopReading, 'function'); assert.equal(typeof stopCapture, 'function');
  assert.equal(events.listenerCount('desk:audio-reading-view'), 1); assert.equal(events.listenerCount('desk:audio-capture-state'), 1);
  const readingView = { scopeId: 'actual-view' }, captureState = { revision: 9 }, privateEvent = { sender: 'not-exposed' };
  events.emit('desk:audio-reading-view', privateEvent, readingView); events.emit('desk:audio-capture-state', privateEvent, captureState);
  assert.deepEqual(reading, [[readingView]]); assert.deepEqual(capture, [[captureState]]);
  (stopReading as () => void)(); (stopReading as () => void)();
  assert.equal(events.listenerCount('desk:audio-reading-view'), 0);
  events.emit('desk:audio-reading-view', privateEvent, { scopeId: 'late' });
  events.emit('desk:audio-capture-state', privateEvent, captureState);
  assert.equal(reading.length, 1); assert.equal(capture.length, 2);
  (stopCapture as () => void)(); assert.equal(events.listenerCount('desk:audio-capture-state'), 0);
  events.emit('desk:audio-capture-state', privateEvent, captureState); assert.equal(capture.length, 2);
});
