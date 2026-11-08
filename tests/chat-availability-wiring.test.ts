import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { CHAT_AVAILABILITY_METHODS } from '../electron/chat-availability-host';

async function loadPreload() {
  const source = await readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8');
  let api: any; const invokes: unknown[][] = [], subscriptions: unknown[][] = [];
  const context = { process: { platform: 'win32' }, require: (name: string) => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld: (key: string, value: unknown) => { assert.equal(key, 'desktop'); api = value; } },
      ipcRenderer: { invoke: (...args: unknown[]) => { invokes.push(args); return Promise.resolve(); },
        on: (...args: unknown[]) => { subscriptions.push(['on', ...args]); }, removeListener: (...args: unknown[]) => { subscriptions.push(['off', ...args]); } } };
  }, exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { api, invokes, subscriptions };
}

test('actual preload: the repair operations forward only their fixed channel and drop every argument', async () => {
  const { api, invokes } = await loadPreload();
  for (const name of CHAT_AVAILABILITY_METHODS) assert.equal(typeof api[name], 'function', name);
  await api.getChatAvailability('https://evil.example');
  await api.retryChatAvailability({ command: 'calc.exe' }, 1, 2);
  await api.openClaudeHelp('https://evil.example', 'x');
  await api.openNetworkSettings('ms-settings:privacy');
  assert.deepEqual(invokes, [['desk:getChatAvailability'], ['desk:retryChatAvailability'], ['desk:openClaudeHelp'], ['desk:openNetworkSettings']]);
});

test('actual preload: the availability feed listens on its one channel and can be released', async () => {
  const { api, subscriptions } = await loadPreload();
  const seen: unknown[] = [];
  const stop = api.onChatAvailability((view: unknown) => seen.push(view));
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0][0], 'on');
  assert.equal(subscriptions[0][1], 'desk:chat-availability');
  (subscriptions[0][2] as (event: unknown, value: unknown) => void)({}, { state: 'ok', checking: false });
  assert.deepEqual(seen, [{ state: 'ok', checking: false }]);
  stop();
  assert.deepEqual(subscriptions[1].slice(0, 2), ['off', 'desk:chat-availability']);
});

test('the typed API has exactly these operations and none takes a parameter', async () => {
  const text = await readFile(new URL('../shared/contracts.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('contracts.ts', text, ts.ScriptTarget.Latest, true);
  const api = ast.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === 'DesktopAPI')!;
  for (const name of [...CHAT_AVAILABILITY_METHODS, 'onChatAvailability']) {
    const members = api.members.filter((member): member is ts.MethodSignature => ts.isMethodSignature(member) && member.name.getText(ast) === name);
    assert.equal(members.length, 1, name);
    if (name !== 'onChatAvailability') assert.equal(members[0].parameters.length, 0, name);
  }
});
