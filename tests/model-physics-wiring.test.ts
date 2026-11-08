import * as uiCopy from '../src/ui/ui-language';
const { uiText, uiHtml, uiMarkup, uiTemplate } = uiCopy;
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { normalizeModelPhysicsSettings, type ModelPhysicsSettings, type ModelPhysicsState } from '../shared/model-physics';

const hostSource = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const sourceFile = (source: string) => ts.createSourceFile('physics-wiring.ts', source, ts.ScriptTarget.ES2022, true);
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const off = () => normalizeModelPhysicsSettings(undefined);
const on = () => normalizeModelPhysicsSettings({ hair: { enabled: true, strength: 0.8 }, quality: 'high' });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/**
 * Execute only the production narrow handlers/functions. AST selection excludes
 * app bootstrap, Electron imports, Three, Ammo, media and real DOM completely.
 */
function execute(source: string, functions: readonly string[], sandbox: Record<string, unknown>, handlers: readonly string[] = []): void {
  const file = sourceFile(source);
  const selected = functions.map(name => {
    const node = file.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(node, `production function ${name}`);
    return node.getText(file);
  });
  if (handlers.length) {
    const registration = file.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'registerIPC');
    assert.ok(registration && ts.isFunctionDeclaration(registration) && registration.body);
    for (const name of handlers) {
      const statement = registration.body.statements.find(candidate => {
        if (!ts.isExpressionStatement(candidate) || !ts.isCallExpression(candidate.expression)) return false;
        const call = candidate.expression;
        return ts.isIdentifier(call.expression) && call.expression.text === 'host'
          && !!call.arguments[0] && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === name;
      });
      assert.ok(statement, `production handler ${name}`);
      selected.push(statement.getText(file));
    }
  }
  const compiled = ts.transpileModule(selected.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  runInNewContext(compiled, Object.assign(sandbox, { uiText, uiHtml, uiMarkup, uiTemplate }), { filename: 'physics-wiring-functions.js' });
}

function hostHarness(persist: (input: unknown) => Promise<ModelPhysicsSettings>) {
  type WindowStub = { webContents: { id: number } };
  type EventStub = { sender: { id: number; mainFrame: object }; senderFrame: object };
  const controls: WindowStub = { webContents: { id: 1 } }, pet: WindowStub = { webContents: { id: 2 } };
  const handlers = new Map<string, (event: EventStub, ...args: unknown[]) => unknown>();
  const broadcasts: { channel: string; value: ModelPhysicsSettings }[] = [];
  const sandbox: Record<string, unknown> = {
    controls, windows: () => [controls, pet],
    ipcMain: { handle: (channel: string, callback: (event: EventStub, ...args: unknown[]) => unknown) => handlers.set(channel, callback) },
    modelPhysicsSettings: { get current() { return off(); }, persist },
    broadcast(channel: string, value: ModelPhysicsSettings) { broadcasts.push({ channel, value: plain(value) }); },
  };
  execute(hostSource, ['host', 'scopedHost'], sandbox, ['getModelPhysicsSettings', 'setModelPhysicsSettings']);
  const invoke = (method: string, id = 1, mainFrame = true, ...args: unknown[]) => {
    const frame = {};
    return handlers.get(`desk:${method}`)!({ sender: { id, mainFrame: frame }, senderFrame: mainFrame ? frame : {} }, ...args);
  };
  return { invoke, broadcasts };
}

class Input {
  checked = false;
  disabled = false;
  value = '';
  textContent = '';
  onchange: (() => void) | null = null;
  oninput: (() => void) | null = null;
  get valueAsNumber(): number { return Number(this.value); }
  checkValidity(): boolean { return Number.isFinite(this.valueAsNumber) && this.valueAsNumber >= 0 && this.valueAsNumber <= 1; }
}
function rendererHarness() {
  const elements = new Map<string, Input>();
  for (const name of ['physics-save-state', 'physics-quality', ...['hair', 'chest'].flatMap(part =>
    [`physics-${part}-enabled`, `physics-${part}-strength`, `physics-${part}-strength-value`, `physics-${part}-support`])]) elements.set(name, new Input());
  const applied: ModelPhysicsSettings[] = [], requests: unknown[] = [], errors: string[] = [];
  const initial = deferred<ModelPhysicsSettings>(), save = deferred<ModelPhysicsSettings>();
  let listener: ((settings: ModelPhysicsSettings) => void) | undefined;
  let subscribed = false;
  const state: Pick<ModelPhysicsState, 'support'> = { support: {
    hair: { supported: true, bones: 2, bodies: 2, reason: null },
    chest: { supported: false, bones: 0, bodies: 0, reason: '没有可靠结构' },
  } };
  const sandbox: Record<string, unknown> = {
    isPet: false, settings: { model: { name: 'synthetic.pmx' } },
    modelPhysicsSettings: off(), modelPhysicsState: state,
    modelPhysicsSettingsReady: false, modelPhysicsSaving: false, modelPhysicsEventVersion: 0,
    modelPhysicsUnsubscribe: null, normalizeModelPhysicsSettings,
    stage: { setPhysicsSettings(value: ModelPhysicsSettings) { applied.push(structuredClone(value)); } },
    $: (id: string) => elements.get(id),
    text: (id: string, value: string) => { const element = elements.get(id); if (element) element.textContent = value; },
    notify: (message: string) => errors.push(message),
    window: { desktop: {
      onModelPhysicsSettings(callback: (settings: ModelPhysicsSettings) => void) { subscribed = true; listener = callback; return () => { listener = undefined; }; },
      getModelPhysicsSettings() { assert.equal(subscribed, true, 'subscribe before requesting the initial value'); return initial.promise; },
      setModelPhysicsSettings(input: unknown) { requests.push(plain(input)); return save.promise; },
    } },
  };
  execute(rendererSource, ['syncModelPhysicsSupport', 'syncModelPhysicsForm', 'applyModelPhysicsSettings',
    'initModelPhysicsSettings', 'saveModelPhysicsSettings', 'bindModelPhysicsControls'], sandbox);
  return {
    sandbox, elements, applied, requests, errors, initial, save,
    init: sandbox.initModelPhysicsSettings as () => Promise<void>,
    bind: sandbox.bindModelPhysicsControls as () => void,
    persist: sandbox.saveModelPhysicsSettings as (patch: unknown) => Promise<void>,
    accept: sandbox.applyModelPhysicsSettings as (value: ModelPhysicsSettings) => void,
    broadcast: (value: ModelPhysicsSettings) => { assert.ok(listener); listener(value); },
    field: (id: string) => { const field = elements.get(id); assert.ok(field); return field; },
  };
}

test('physics settings allow both main-frame readers but only the controls main frame can persist', async () => {
  const requests: unknown[] = [];
  const h = hostHarness(async input => { requests.push(input); return on(); });
  assert.deepEqual(h.invoke('getModelPhysicsSettings', 1), off());
  assert.deepEqual(h.invoke('getModelPhysicsSettings', 2), off());
  for (const [id, mainFrame] of [[1, false], [2, true], [2, false], [3, true]] as const)
    assert.throws(() => h.invoke('setModelPhysicsSettings', id, mainFrame, { hair: { enabled: true } }), /未授权/);
  assert.throws(() => h.invoke('getModelPhysicsSettings', 2, false), /未授权/);
  assert.throws(() => h.invoke('getModelPhysicsSettings', 3), /未授权/);
  assert.deepEqual(await h.invoke('setModelPhysicsSettings', 1, true, undefined), off());
  assert.equal(requests.length, 0);
  assert.equal(h.broadcasts.length, 0);
  await h.invoke('setModelPhysicsSettings', 1, true, { hair: { enabled: true } });
  assert.equal(requests.length, 1);
  assert.deepEqual(h.broadcasts, [{ channel: 'desk:model-physics-settings', value: on() }]);
});

test('physics settings broadcast only after the atomic commit and never broadcast failed writes', async () => {
  const commit = deferred<ModelPhysicsSettings>();
  const h = hostHarness(() => commit.promise);
  const pending = h.invoke('setModelPhysicsSettings', 1, true, { quality: 'high' }) as Promise<ModelPhysicsSettings>;
  assert.equal(h.broadcasts.length, 0);
  commit.resolve(on());
  assert.deepEqual(await pending, on());
  assert.equal(h.broadcasts.length, 1);
  const failed = hostHarness(async () => { throw new Error('synthetic commit failure'); });
  await assert.rejects(failed.invoke('setModelPhysicsSettings', 1, true, { quality: 'low' }) as Promise<ModelPhysicsSettings>, /commit failure/);
  assert.equal(failed.broadcasts.length, 0);
});

test('a newer physics settings broadcast wins over a late initial get and reaches the stage once', async () => {
  const h = rendererHarness();
  const loading = h.init();
  h.broadcast(on());
  h.initial.resolve(off());
  await loading;
  assert.deepEqual(h.sandbox.modelPhysicsSettings, on());
  assert.deepEqual(h.applied, [on()]);
  assert.equal(h.field('physics-hair-enabled').checked, true);
  assert.equal(h.requests.length, 0);
});

test('a pending physics save cannot apply a stale acknowledgement over a newer broadcast', async () => {
  const h = rendererHarness();
  const loading = h.init(); h.initial.resolve(off()); await loading;
  const saving = h.persist({ hair: { enabled: true } });
  assert.equal(h.field('physics-quality').disabled, true);
  assert.equal(h.field('physics-hair-enabled').disabled, true);
  const newer = normalizeModelPhysicsSettings({ chest: { enabled: true }, quality: 'low' });
  h.broadcast(newer);
  h.save.resolve(on());
  await saving;
  assert.deepEqual(h.sandbox.modelPhysicsSettings, newer);
  assert.deepEqual(h.applied, [off(), newer]);
  assert.equal(h.field('physics-quality').value, 'low');
  assert.equal(h.field('physics-chest-enabled').disabled, false, 'an unsupported saved request remains cancellable');
});

test('failed physics saves restore committed controls and never apply the rejected draft', async () => {
  const h = rendererHarness();
  h.accept(off());
  h.field('physics-hair-enabled').checked = true;
  const saving = h.persist({ hair: { enabled: true } });
  assert.deepEqual(h.applied, [off()]);
  h.save.reject(new Error('synthetic private file error'));
  await saving;
  assert.deepEqual(h.sandbox.modelPhysicsSettings, off());
  assert.equal(h.field('physics-hair-enabled').checked, false);
  assert.equal(h.field('physics-quality').disabled, false);
  assert.deepEqual(h.errors, ['物理设置未保存，请重试。']);
  assert.equal(h.field('physics-save-state').textContent.includes('未能保存'), true);
});

test('unsupported switches can cancel a saved request and strength input alone never enables physics', async () => {
  const h = rendererHarness();
  h.accept(normalizeModelPhysicsSettings({ chest: { enabled: true } }));
  h.bind();
  const chest = h.field('physics-chest-enabled');
  assert.equal(chest.disabled, false);
  assert.equal(h.field('physics-chest-strength').disabled, true);
  chest.checked = false; chest.onchange!();
  assert.deepEqual(h.requests, [{ chest: { enabled: false } }]);
  h.save.resolve(off());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chest.disabled, true);
  const other = rendererHarness();
  other.accept(off()); other.bind();
  const strength = other.field('physics-hair-strength');
  strength.value = '0.4'; strength.oninput!();
  assert.equal(other.requests.length, 0);
  assert.equal(other.field('physics-hair-strength-value').textContent, '0.4');
  strength.onchange!();
  assert.deepEqual(other.requests, [{ hair: { strength: 0.4 } }]);
  assert.deepEqual(other.applied, [off()]);
  other.save.resolve(normalizeModelPhysicsSettings({ hair: { strength: 0.4 } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((other.sandbox.modelPhysicsSettings as ModelPhysicsSettings).hair.enabled, false);
});
