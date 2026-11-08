import * as uiCopy from '../src/ui/ui-language';
const { uiText, uiHtml, uiMarkup, uiTemplate } = uiCopy;
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { normalizeMusicSettings, type MusicSettings } from '../shared/music-settings';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function execute(source: string, names: string[], sandbox: Record<string, unknown>, handlers: string[] = []): void {
  const file = ts.createSourceFile('music-wiring.ts', source, ts.ScriptTarget.ES2022, true);
  const declarations = names.map(name => {
    const item = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(item, name); return item.getText(file);
  });
  if (handlers.length) {
    const registration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'registerIPC');
    assert.ok(registration && ts.isFunctionDeclaration(registration) && registration.body);
    for (const name of handlers) {
      const statement = registration.body.statements.find(node => ts.isExpressionStatement(node)
        && ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'host' && ts.isStringLiteral(node.expression.arguments[0])
        && node.expression.arguments[0].text === name);
      assert.ok(statement, name); declarations.push(statement.getText(file));
    }
  }
  runInNewContext(ts.transpileModule(declarations.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, Object.assign(sandbox, { uiText, uiHtml, uiMarkup, uiTemplate }));
}
const hostSource = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

test('actual music handlers reject pet/foreign/subframe writes and broadcast only successful atomic commits', async () => {
  const controls = { webContents: { id: 1 } }, pet = { webContents: { id: 2 } };
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const commit = deferred<MusicSettings>();
  const broadcasts: unknown[] = [];
  let calls = 0;
  const sandbox = { controls, windows: () => [controls, pet],
    ipcMain: { handle: (name: string, callback: (...args: any[]) => unknown) => handlers.set(name, callback) },
    musicSettings: { current: { strength: 0.7, alwaysDance: false }, persist: () => { calls++; return commit.promise; } },
    broadcast: (channel: string, value: MusicSettings) => broadcasts.push({ channel, value }),
  };
  execute(hostSource, ['host', 'scopedHost'], sandbox, ['getMusicSettings', 'setMusicSettings']);
  const invoke = (name: string, id: number, main = true, input?: unknown) => {
    const frame = {}; return handlers.get(`desk:${name}`)!({ sender: { id, mainFrame: frame }, senderFrame: main ? frame : {} }, input);
  };
  assert.deepEqual(invoke('getMusicSettings', 1), { strength: 0.7, alwaysDance: false });
  assert.deepEqual(invoke('getMusicSettings', 2), { strength: 0.7, alwaysDance: false });
  for (const [id, main] of [[2, true], [1, false], [2, false], [3, true]] as const)
    assert.throws(() => invoke('setMusicSettings', id, main, { strength: 0 }), /未授权/);
  const pending = invoke('setMusicSettings', 1, true, { strength: 0 }) as Promise<MusicSettings>;
  assert.equal(calls, 1); assert.equal(broadcasts.length, 0);
  commit.resolve({ strength: 0, alwaysDance: false }); await pending;
  assert.deepEqual(broadcasts, [{ channel: 'desk:music-settings', value: { strength: 0, alwaysDance: false } }]);
  sandbox.musicSettings.persist = () => Promise.reject(new Error('synthetic commit failure'));
  await assert.rejects(invoke('setMusicSettings', 1, true, { strength: 1 }) as Promise<MusicSettings>, /commit failure/);
  assert.equal(broadcasts.length, 1);
});

class Input {
  value = ''; disabled = false; textContent = ''; oninput: (() => void) | null = null; onchange: (() => void) | null = null;
  get valueAsNumber(): number { return Number(this.value); }
  checkValidity(): boolean { return Number.isFinite(this.valueAsNumber) && this.valueAsNumber >= 0 && this.valueAsNumber <= 1; }
}
function renderer() {
  const elements = new Map(['music-strength', 'music-strength-value', 'music-save-state'].map(id => [id, new Input()]));
  const initial = deferred<MusicSettings>(), save = deferred<MusicSettings>();
  const applied: MusicSettings[] = [], requests: unknown[] = [], errors: string[] = [];
  let listener: ((value: MusicSettings) => void) | undefined;
  const sandbox: Record<string, unknown> = { isPet: false, musicSettings: { strength: 0.7, alwaysDance: false },
    musicSettingsReady: false, musicSettingsSaving: false, musicSettingsEventVersion: 0, musicSettingsUnsubscribe: null,
    normalizeMusicSettings, stage: { setMusicSettings: (value: MusicSettings) => applied.push(plain(value)) },
    $: (id: string) => elements.get(id), text: (id: string, value: string) => { elements.get(id)!.textContent = value; },
    notify: (message: string) => errors.push(message),
    window: { desktop: {
      onMusicSettings(callback: (value: MusicSettings) => void) { listener = callback; return () => { listener = undefined; }; },
      getMusicSettings() { assert.ok(listener, 'subscribe before reading'); return initial.promise; },
      setMusicSettings(value: unknown) { requests.push(plain(value)); return save.promise; },
    } },
  };
  execute(rendererSource, ['syncMusicSettingsForm', 'applyMusicSettings', 'initMusicSettings', 'saveMusicSettings', 'bindMusicSettingsControls'], sandbox);
  return { sandbox, applied, requests, errors, initial, save, elements,
    init: sandbox.initMusicSettings as () => Promise<void>, bind: sandbox.bindMusicSettingsControls as () => void,
    persist: sandbox.saveMusicSettings as (strength: number) => Promise<void>,
    accept: sandbox.applyMusicSettings as (value: MusicSettings) => void,
    broadcast: (value: MusicSettings) => listener!(value),
  };
}

test('a newer music broadcast wins over late load and late save acknowledgements', async () => {
  const h = renderer(); const load = h.init();
  h.broadcast({ strength: 0.35, alwaysDance: false }); h.initial.resolve({ strength: 0.7, alwaysDance: false }); await load;
  assert.deepEqual(h.applied, [{ strength: 0.35, alwaysDance: false }]);
  const save = h.persist(0.8); assert.equal(h.elements.get('music-strength')!.disabled, true);
  h.broadcast({ strength: 0, alwaysDance: false }); h.save.resolve({ strength: 0.8, alwaysDance: false }); await save;
  assert.deepEqual(h.applied, [{ strength: 0.35, alwaysDance: false }, { strength: 0, alwaysDance: false }]);
  assert.equal(h.elements.get('music-strength')!.value, '0');
});

test('music slider zero is committed independently, and failure restores its accepted value', async () => {
  const h = renderer(); h.accept({ strength: 0.35, alwaysDance: false }); h.bind();
  const input = h.elements.get('music-strength')!; input.value = '0'; input.oninput!();
  assert.equal(h.requests.length, 0); input.onchange!();
  assert.deepEqual(h.requests, [{ strength: 0 }]);
  h.save.reject(new Error('synthetic private file error'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(input.value, '0.35'); assert.equal(input.disabled, false);
  assert.deepEqual(h.applied, [{ strength: 0.35, alwaysDance: false }]);
  assert.deepEqual(h.errors, ['音乐强度未保存，请重试。']);
});
