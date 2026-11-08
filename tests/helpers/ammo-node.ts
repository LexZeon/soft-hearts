import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script, createContext } from 'node:vm';
import type { AmmoModule } from '../../src/stage/ammo-runtime';

const JS_SHA256 = '3fa63c584d4732f72b954c5ea105f1faca99559c95c57ce7bb738d3497f98228';
const WASM_SHA256 = '16be07b989963bddebfef66eab28a4387536eb37014d9df1531dab380bd96a93';
const libraryUrl = new URL('../../node_modules/three/examples/jsm/libs/', import.meta.url);
const scriptFilename = fileURLToPath(new URL('ammo.wasm.js', libraryUrl));
const wasmFilename = fileURLToPath(new URL('ammo.wasm.wasm', libraryUrl));

interface TestFactoryOptions {
  wasmBinary: Uint8Array;
  locateFile(name: string): string;
  instantiateWasm(
    imports: WebAssembly.Imports,
    receive: (instance: WebAssembly.Instance) => void,
  ): Record<string, never>;
  onAbort(reason: unknown): void;
  print(message: unknown): void;
  printErr(message: unknown): void;
  quit(status: number, error: unknown): never;
}
type TestAmmoFactory = (this: object, options: TestFactoryOptions) => Promise<unknown>;

let runtime: Promise<AmmoModule> | undefined;

/** Real, reviewed Ammo for CPU tests only. Does not install a renderer/global bridge. */
export function loadAmmoForTests(): Promise<AmmoModule> {
  if (!runtime) {
    const attempt = initializeAmmoForTests().catch((error: unknown) => {
      if (runtime === attempt) runtime = undefined;
      throw error;
    });
    runtime = attempt;
  }
  return runtime;
}

async function initializeAmmoForTests(): Promise<AmmoModule> {
  const jsBytes = reviewedBytes(scriptFilename, JS_SHA256);
  const wasmBytes = reviewedBytes(wasmFilename, WASM_SHA256);
  const commonModule: { exports: unknown } = { exports: {} };
  const noPrint = (_message: unknown): void => {};
  const refuseExit = (_status?: unknown, error?: unknown): never => {
    throw new Error('Ammo CPU test runtime attempted to exit.', { cause: error });
  };
  // The vendor must not register process-wide rejection/exception handlers or
  // terminate the test runner. This is an execution context for fixed, hashed
  // vendor code, not a security sandbox for arbitrary JavaScript.
  const testProcess = Object.freeze({
    versions: Object.freeze({ node: process.versions.node }),
    argv: Object.freeze(['node', 'reviewed-ammo-cpu-test']),
    on: (_event: unknown, _handler: unknown): void => {},
    exit: refuseExit,
  });
  const requireForAmmo = (name: string): unknown => {
    if (name === 'path') {
      return Object.freeze({ normalize: path.normalize, dirname: path.dirname });
    }
    if (name === 'fs') {
      return Object.freeze({
        readFileSync(filename: string, encoding?: unknown): Buffer {
          if (path.resolve(filename) !== wasmFilename || encoding) {
            throw new Error('Ammo CPU test runtime requested an unexpected file.');
          }
          // No new filesystem capability: only return the bytes already read
          // and verified above, even if the vendor invokes its Node fallback.
          return Buffer.from(wasmBytes);
        },
      });
    }
    throw new Error('Ammo CPU test runtime requested an unsupported Node module.');
  };
  const context = createContext({
    module: commonModule,
    exports: commonModule.exports,
    require: requireForAmmo,
    __dirname: path.dirname(scriptFilename),
    __filename: scriptFilename,
    process: testProcess,
    console: Object.freeze({ log: noPrint, warn: noPrint, error: noPrint }),
    WebAssembly,
    TextDecoder,
    // The fixed build only uses delayed status callbacks when setStatus was
    // provided (it is not). Supplying timers keeps its Node context explicit.
    setTimeout,
    clearTimeout,
    clearInterval,
  }, { name: 'soft-hearts-reviewed-ammo-cpu-test', codeGeneration: { strings: false, wasm: true } });
  new Script(jsBytes.toString('utf8'), { filename: 'reviewed-ammo.wasm.js' })
    .runInContext(context, { timeout: 5000 });
  if (typeof commonModule.exports !== 'function') {
    throw new Error('Reviewed Ammo script did not export its Node factory.');
  }
  const factory = commonModule.exports as TestAmmoFactory;

  return new Promise<AmmoModule>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => fail('Ammo CPU test initialization timed out.', undefined), 15000);
    const fail = (message: string, cause: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(message, { cause }));
    };
    try {
      const ready = factory.call(Object.create(null), {
        wasmBinary: new Uint8Array(wasmBytes),
        locateFile(name) {
          if (name !== 'ammo.wasm.wasm') {
            throw new Error('Ammo CPU test runtime requested an unsupported resource.');
          }
          return wasmFilename;
        },
        instantiateWasm(imports, receive) {
          // Own the rejection rather than relying on this legacy build's
          // resolve-only ready Promise or its process unhandledRejection hook.
          void WebAssembly.instantiate(new Uint8Array(wasmBytes), imports).then(
            (result) => {
              if (settled) return;
              try {
                receive(result.instance);
              } catch (error) {
                fail('Ammo CPU test bindings could not initialize.', error);
              }
            },
            (error: unknown) => fail('Ammo CPU test WASM compilation failed.', error),
          );
          return {};
        },
        onAbort: (reason) => fail('Ammo CPU test runtime aborted.', reason),
        print: noPrint,
        printErr: noPrint,
        quit: refuseExit,
      });
      void Promise.resolve(ready).then((value: unknown) => {
        if (settled) return;
        if (!value || typeof value !== 'object' ||
            typeof (value as Partial<AmmoModule>).destroy !== 'function') {
          fail('Ammo CPU test factory returned an invalid module.', undefined);
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(value as AmmoModule);
      }, (error: unknown) => fail('Ammo CPU test initialization failed.', error));
    } catch (error) {
      fail('Ammo CPU test initialization failed.', error);
    }
  });
}

function reviewedBytes(filename: string, expected: string): Buffer {
  const bytes = readFileSync(filename);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error('Ammo CPU test dependency differs from the reviewed bytes.');
  }
  return bytes;
}
