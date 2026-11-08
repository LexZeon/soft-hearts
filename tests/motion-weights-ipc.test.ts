import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

test('actual scoped handlers restrict annotation calls to controls main-frame and exact argument counts', async () => {
  const source = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const helper = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'scopedHost');
  assert.ok(helper);
  const register = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'registerIPC') as ts.FunctionDeclaration;
  const names = ['readMotionWeights', 'saveMotionWeights', 'searchMotionWeights', 'invalidateMotionWeightSelection'];
  const registrations = register.body!.statements.filter(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)
    && n.expression.expression.getText(ast) === 'scopedHost' && ts.isStringLiteral(n.expression.arguments[0])
    && names.includes(n.expression.arguments[0].text));
  assert.equal(registrations.length, 4);
  const methods = new Map<string, (...args: any[]) => any>(), calls: unknown[][] = [];
  const controls = { webContents: { id: 7 } }, pet = { webContents: { id: 8 } };
  const context = { controls, windows: () => [controls, pet], ipcMain: { handle: (id: string, callback: any) => methods.set(id, callback) },
    motionWeights: { read: (...args: unknown[]) => { calls.push(['read', ...args]); return 'read'; },
      save: (...args: unknown[]) => { calls.push(['save', ...args]); return 'save'; },
      invalidateSelection: (...args: unknown[]) => { calls.push(['invalidate', ...args]); },
      search: (...args: unknown[]) => { calls.push(['search', ...args]); return 'search'; } } };
  const script = helper.getText(ast) + '\n' + registrations.map(n => n.getText(ast)).join('\n');
  vm.runInNewContext(ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const frame = {}, event = (id: number, child = false) => ({ sender: { id, mainFrame: frame }, senderFrame: child ? {} : frame });
  const read = methods.get('desk:readMotionWeights')!, save = methods.get('desk:saveMotionWeights')!, search = methods.get('desk:searchMotionWeights')!;
  assert.throws(() => read(event(8), 'gene', 'stand'));
  assert.throws(() => read(event(7, true), 'gene', 'stand'));
  assert.throws(() => read(event(7), 'gene', 'stand', 'extra'));
  assert.throws(() => save(event(7), {}, {})); assert.throws(() => search(event(7)));
  const invalidate = methods.get('desk:invalidateMotionWeightSelection')!;
  assert.throws(() => invalidate(event(8), 'gene'));
  assert.throws(() => invalidate(event(7), 'gene', 'extra'));
  assert.equal(calls.length, 0);
  assert.equal(read(event(7), 'gene', 'stand'), 'read');
  assert.equal(save(event(7), { token: 'opaque' }), 'save');
  assert.equal(search(event(7), { packId: 'gene', preferred: [] }), 'search');
  invalidate(event(7), 'gene');
  assert.deepEqual(calls.map(c => c.slice(0, 2)), [['read', 7], ['save', 7], ['search', { packId: 'gene', preferred: [] }], ['invalidate', 7]]);
});

test('actual typed preload forwards four metadata operations and retains null/zero', async () => {
  const source = await readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8');
  let api: any; const calls: unknown[][] = [];
  const context = { process: { platform: 'win32' }, require: (name: string) => {
    assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (name: string, value: unknown) => { assert.equal(name, 'desktop'); api = value; } },
      ipcRenderer: { invoke: (...args: unknown[]) => { calls.push(args); return Promise.resolve(); } } };
  }, exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  await api.readMotionWeights('gene', 'stand');
  const request = { token: 'a'.repeat(48), revision: 0, tags: [{ dimension: 'mood', tag: 'gentle', weight: null },
    { dimension: 'context', tag: 'listen', weight: 0 }] };
  await api.saveMotionWeights(request); await api.searchMotionWeights({ packId: 'gene', preferred: [] });
  await api.invalidateMotionWeightSelection('gene');
  assert.deepEqual(calls.map(c => c[0]), ['desk:readMotionWeights', 'desk:saveMotionWeights', 'desk:searchMotionWeights', 'desk:invalidateMotionWeightSelection']);
  assert.equal(calls[1][1], request); assert.equal(calls[1].length, 2); assert.equal(calls[0].length, 3);
});

test('actual window hide, close and renderer-loss registrations invalidate annotation ownership', async () => {
  const source = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const window = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'secureWindow') as ts.FunctionDeclaration;
  const registrations = window.body!.statements.filter(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)
    && n.getText(ast).includes('motionWeights?.dropOwner(windowId)'));
  assert.equal(registrations.length, 3);
  const callbacks = new Map<string, () => void>(), dropped: number[] = [];
  const context = { windowId: 7, win: { on: (event: string, callback: () => void) => callbacks.set(event, callback),
    webContents: { on: (event: string, callback: () => void) => callbacks.set(event, callback) } },
    motionWeights: { dropOwner: (owner: number) => dropped.push(owner) } };
  vm.runInNewContext(ts.transpileModule(registrations.map(n => n.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  assert.deepEqual([...callbacks.keys()], ['hide', 'closed', 'render-process-gone']);
  for (const callback of callbacks.values()) callback();
  assert.deepEqual(dropped, [7, 7, 7]);
});
