import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { AmmoModule } from '../src/stage/ammo-runtime';

const source = readFileSync(new URL('../src/stage/ammo-runtime.ts', import.meta.url), 'utf8');
const wasmHeader = () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer;
interface FactoryOptions {
  locateFile(name: string): string;
  instantiateWasm(imports: WebAssembly.Imports, receive: (instance: unknown) => void): unknown;
  onAbort(reason: unknown): void;
}
interface ScriptStub {
  src: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  remove(): void;
}

/** Only loader code runs. No third-party JS, native WASM, DOM, or network runs. */
function harness(options: { page?: string; scriptAsset?: string; wasmAsset?: string; previous?: unknown } = {}) {
  const state = {
    status: 200,
    bytes: wasmHeader(),
    readError: false,
    scriptError: false,
    missingFactory: false,
    compileError: false,
    abort: false,
    invalidModule: false,
    scriptCount: 0,
    removeCount: 0,
    compileCount: 0,
    requests: [] as string[],
    resources: [] as string[],
    receivers: [] as unknown[],
    factoryOptions: undefined as FactoryOptions | undefined,
  };
  const module: AmmoModule = { destroy() {} };
  const exports: { loadAmmo?: () => Promise<AmmoModule> } = {};
  const sandbox: Record<string, unknown> = {
    exports, URL, ArrayBuffer, Uint8Array, Promise,
    document: {
      location: { href: options.page ?? 'file:///app/dist/index.html' },
      createElement(tag: string) {
        assert.equal(tag, 'script');
        return {
          src: '', onload: null, onerror: null,
          remove() { state.removeCount++; },
        };
      },
      head: {
        append(script: ScriptStub) {
          state.scriptCount++;
          state.resources.push(script.src);
          queueMicrotask(() => {
            if (state.scriptError) { script.onerror?.(); return; }
            if (!state.missingFactory) {
              sandbox.Ammo = function (this: unknown, config: FactoryOptions): Promise<unknown> {
                state.receivers.push(this);
                state.factoryOptions = config;
                if (state.abort) {
                  config.onAbort('synthetic abort');
                  return new Promise(() => {});
                }
                assert.equal(config.locateFile('ammo.wasm.wasm'), state.requests.at(-1));
                assert.throws(() => config.locateFile('https://invalid.example/other.wasm'), /unsupported resource/);
                return new Promise((resolve) => {
                  config.instantiateWasm({}, () => resolve(state.invalidModule ? {} : module));
                });
              };
            }
            script.onload?.();
          });
        },
      },
    },
    XMLHttpRequest: class {
      response = state.bytes;
      status = state.status;
      onload?: () => void;
      onerror?: () => void;
      open(method: string, url: string, async: boolean) {
        assert.equal(method, 'GET');
        assert.equal(async, true);
        state.requests.push(url);
      }
      send() { queueMicrotask(() => state.readError ? this.onerror?.() : this.onload?.()); }
    },
    WebAssembly: {
      instantiate() {
        state.compileCount++;
        return state.compileError
          ? Promise.reject(new Error('synthetic compile failure'))
          : Promise.resolve({ instance: {} });
      },
    },
  };
  if ('previous' in options) sandbox.Ammo = options.previous;
  const isolatedSource = source
    .replace(/^import ammoScriptAsset .*;$/m,
      `const ammoScriptAsset = ${JSON.stringify(options.scriptAsset ?? './assets/ammo-fixed.js')};`)
    .replace(/^import ammoWasmAsset .*;$/m,
      `const ammoWasmAsset = ${JSON.stringify(options.wasmAsset ?? './assets/ammo-fixed.wasm')};`);
  const compiled = ts.transpileModule(isolatedSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: 'ammo-runtime.ts',
  }).outputText;
  runInNewContext(compiled, sandbox, { filename: 'ammo-runtime.test-loader.cjs' });
  assert.equal(typeof exports.loadAmmo, 'function');
  return { state, sandbox, module, load: exports.loadAmmo! };
}

test('Ammo shares one attempt and successful module without retaining a global runtime', async () => {
  const h = harness();
  const first = h.load();
  assert.equal(h.load(), first);
  assert.equal(await first, h.module);
  assert.equal(h.load(), first);
  assert.equal(h.state.requests.length, 1);
  assert.equal(h.state.scriptCount, 1);
  assert.equal(h.state.compileCount, 1);
  assert.equal(h.state.removeCount, 1);
  assert.equal(h.state.requests[0], 'file:///app/dist/assets/ammo-fixed.wasm');
  assert.equal(h.sandbox.Ammo, undefined);
  assert.equal(Object.getPrototypeOf(h.state.receivers[0]), null);
});

test('Ammo rejects missing or malformed WASM before invoking vendor code and can retry', async () => {
  const h = harness();
  h.state.status = 404;
  const failed = h.load();
  await assert.rejects(failed, /WASM resource could not be read/);
  assert.equal(h.state.scriptCount, 0);
  h.state.status = 200;
  h.state.bytes = new Uint8Array(8).buffer;
  await assert.rejects(h.load(), /WASM resource could not be read/);
  assert.equal(h.state.scriptCount, 0);
  h.state.bytes = wasmHeader();
  const retry = h.load();
  assert.notEqual(retry, failed);
  assert.equal(await retry, h.module);
});

test('Ammo accepts status zero only for its fixed packaged file resource', async () => {
  const file = harness();
  file.state.status = 0;
  assert.equal(await file.load(), file.module);
  const dev = harness({ page: 'http://127.0.0.1:5173/index.html' });
  dev.state.status = 0;
  await assert.rejects(dev.load(), /WASM resource could not be read/);
  assert.equal(dev.state.scriptCount, 0);
});

test('Ammo reports script failure, restores previous global and retries', async () => {
  const previous = { marker: true };
  const h = harness({ previous });
  h.state.scriptError = true;
  await assert.rejects(h.load(), /script could not be loaded/);
  assert.equal(h.sandbox.Ammo, previous);
  h.state.scriptError = false;
  assert.equal(await h.load(), h.module);
  assert.equal(h.sandbox.Ammo, previous);
  assert.equal(h.state.removeCount, 2);
});

test('Ammo does not accept an ambient factory if the local script fails to export', async () => {
  const ambient = () => { throw new Error('must not invoke ambient code'); };
  const h = harness({ previous: ambient });
  h.state.missingFactory = true;
  await assert.rejects(h.load(), /did not export its factory/);
  assert.equal(h.sandbox.Ammo, ambient);
  assert.equal(h.state.compileCount, 0);
});

test('Ammo clears an owned non-configurable var slot and preserves a locked foreign slot', async () => {
  const owned = harness();
  Object.defineProperty(owned.sandbox, 'Ammo', { value: undefined, writable: true, configurable: false });
  assert.equal(await owned.load(), owned.module);
  assert.equal(owned.sandbox.Ammo, undefined);
  const locked = harness();
  Object.defineProperty(locked.sandbox, 'Ammo', { value: 'foreign', writable: false, configurable: false });
  await assert.rejects(locked.load(), /global slot is unavailable/);
  assert.equal(locked.sandbox.Ammo, 'foreign');
  assert.equal(locked.state.scriptCount, 0);
});

test('Ammo compile, abort and invalid-module failures release the cached attempt', async () => {
  const h = harness();
  h.state.compileError = true;
  await assert.rejects(h.load(), /WASM compilation failed/);
  h.state.compileError = false;
  h.state.abort = true;
  await assert.rejects(h.load(), /runtime aborted/);
  h.state.abort = false;
  h.state.invalidModule = true;
  await assert.rejects(h.load(), /invalid module/);
  h.state.invalidModule = false;
  assert.equal(await h.load(), h.module);
  assert.equal(h.sandbox.Ammo, undefined);
});

test('Ammo rejects cross-origin, remote, data and blob resources before any load', async () => {
  for (const wasmAsset of ['https://invalid.example/ammo.wasm', 'file://server/ammo.wasm',
    'data:application/wasm;base64,AA==', 'blob:http://127.0.0.1:5173/token']) {
    const h = harness({ wasmAsset });
    await assert.rejects(h.load(), /must belong to the packaged app or local dev server/);
    assert.equal(h.state.requests.length, 0);
    assert.equal(h.state.scriptCount, 0);
  }
  const remotePage = harness({ page: 'https://invalid.example/index.html' });
  await assert.rejects(remotePage.load(), /must belong to the packaged app or local dev server/);
});

test('Ammo sources are the reviewed Three r170 JS and WASM bytes', () => {
  for (const [name, expected] of [
    ['ammo.wasm.js', '3fa63c584d4732f72b954c5ea105f1faca99559c95c57ce7bb738d3497f98228'],
    ['ammo.wasm.wasm', '16be07b989963bddebfef66eab28a4387536eb37014d9df1531dab380bd96a93'],
  ]) {
    const bytes = readFileSync(new URL(`../node_modules/three/examples/jsm/libs/${name}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
  }
  assert.match(source, /from 'three\/examples\/jsm\/libs\/ammo\.wasm\.js\?url'/);
  assert.match(source, /from 'three\/examples\/jsm\/libs\/ammo\.wasm\.wasm\?url'/);
});
