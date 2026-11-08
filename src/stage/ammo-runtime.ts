import ammoScriptAsset from 'three/examples/jsm/libs/ammo.wasm.js?url';
import ammoWasmAsset from 'three/examples/jsm/libs/ammo.wasm.wasm?url';

/** The vendor API is refined only inside the local physics adapter. */
export interface AmmoModule {
  destroy(value: unknown): void;
  [name: string]: unknown;
}

interface AmmoFactoryOptions {
  wasmBinary: ArrayBuffer;
  locateFile(name: string): string;
  instantiateWasm(
    imports: WebAssembly.Imports,
    receive: (instance: WebAssembly.Instance) => void,
  ): Record<string, never>;
  onAbort(reason: unknown): void;
}

type AmmoFactory = (this: object, options: AmmoFactoryOptions) => Promise<unknown>;
type AmmoGlobal = typeof globalThis & { Ammo?: unknown };

let runtime: Promise<AmmoModule> | undefined;

/** One module per renderer; a rejected attempt is evicted so a later call can retry. */
export function loadAmmo(): Promise<AmmoModule> {
  if (!runtime) {
    const attempt = initializeAmmo().catch((error: unknown) => {
      if (runtime === attempt) runtime = undefined;
      throw error;
    });
    runtime = attempt;
  }
  return runtime;
}

async function initializeAmmo(): Promise<AmmoModule> {
  if (typeof document === 'undefined' || typeof WebAssembly === 'undefined') {
    throw new Error('Local Ammo requires a renderer with WebAssembly support.');
  }
  const scriptUrl = localAssetUrl(ammoScriptAsset);
  const wasmUrl = localAssetUrl(ammoWasmAsset);
  // Read bytes before allocating the vendor runtime. In particular, file:// must
  // not enter this old Emscripten build's browser fetch/synchronous fallback.
  const binary = await readWasm(wasmUrl);
  const factory = await readFactory(scriptUrl);

  return new Promise<AmmoModule>((resolve, reject) => {
    let failed = false;
    const fail = (message: string, cause: unknown): void => {
      if (failed) return;
      failed = true;
      reject(new Error(message, { cause }));
    };
    try {
      // The classic factory writes `this.Ammo` at the end of initialization.
      // Give it a private receiver; upstream MMDPhysics gets a scoped module
      // through the adapter, never a permanently installed renderer global.
      const ready = factory.call(Object.create(null), {
        wasmBinary: binary,
        locateFile(name) {
          if (name !== 'ammo.wasm.wasm') {
            throw new Error('Local Ammo requested an unsupported resource.');
          }
          return wasmUrl;
        },
        instantiateWasm(imports, receive) {
          // This owns rejection: the vendor ready Promise has no reject path,
          // and its default asynchronous abort can otherwise stay pending.
          void WebAssembly.instantiate(binary, imports).then(
            (result) => {
              if (failed) return;
              try {
                receive(result.instance);
              } catch (error) {
                fail('Local Ammo could not initialize its WASM bindings.', error);
              }
            },
            (error: unknown) => fail('Local Ammo WASM compilation failed.', error),
          );
          return {};
        },
        onAbort(reason) {
          fail('Local Ammo runtime aborted.', reason);
        },
      });
      void Promise.resolve(ready).then((value: unknown) => {
        if (failed) return;
        if (!value || typeof value !== 'object' ||
            typeof (value as Partial<AmmoModule>).destroy !== 'function') {
          fail('Local Ammo returned an invalid module.', undefined);
          return;
        }
        resolve(value as AmmoModule);
      }, (error: unknown) => fail('Local Ammo initialization failed.', error));
    } catch (error) {
      fail('Local Ammo initialization failed.', error);
    }
  });
}

/** No caller-provided URL, path, fallback CDN, or renderer IPC is accepted. */
function localAssetUrl(asset: string): string {
  const page = new URL(document.location.href);
  const resource = new URL(asset, page);
  const localFile = page.protocol === 'file:' && resource.protocol === 'file:' && !resource.host;
  const localDev = page.protocol === 'http:' && resource.origin === page.origin &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(page.hostname);
  if ((!localFile && !localDev) || resource.username || resource.password || resource.hash) {
    throw new Error('Local Ammo resources must belong to the packaged app or local dev server.');
  }
  return resource.href;
}

function readWasm(url: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const fail = (): void => reject(new Error('Local Ammo WASM resource could not be read.'));
    request.open('GET', url, true);
    request.responseType = 'arraybuffer';
    request.timeout = 15000;
    request.onload = () => {
      const localFile = new URL(url).protocol === 'file:' && request.status === 0;
      if ((!localFile && (request.status < 200 || request.status >= 300)) ||
          !(request.response instanceof ArrayBuffer) || request.response.byteLength < 8) {
        fail();
        return;
      }
      // Fail clearly before invoking vendor code on a missing/HTML fallback.
      const header = new Uint8Array(request.response, 0, 8);
      if (header[0] !== 0 || header[1] !== 97 || header[2] !== 115 || header[3] !== 109 ||
          header[4] !== 1 || header[5] !== 0 || header[6] !== 0 || header[7] !== 0) {
        fail();
        return;
      }
      resolve(request.response);
    };
    request.onerror = request.onabort = request.ontimeout = fail;
    request.send();
  });
}

function readFactory(url: string): Promise<AmmoFactory> {
  return new Promise((resolve, reject) => {
    const global = globalThis as AmmoGlobal;
    const previous = Object.getOwnPropertyDescriptor(global, 'Ammo');
    if (previous && (!('value' in previous) || !previous.writable)) {
      reject(new Error('Local Ammo global slot is unavailable.'));
      return;
    }
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    const restore = (): void => {
      script.onload = script.onerror = null;
      script.remove();
      if (previous) {
        Object.defineProperty(global, 'Ammo', previous);
      } else if (!Reflect.deleteProperty(global, 'Ammo')) {
        // A classic top-level `var` can create a non-configurable property.
        // Clear its value rather than pretending the property was removable.
        global.Ammo = undefined;
      }
    };
    script.onload = () => {
      const factory = global.Ammo;
      restore();
      if (typeof factory !== 'function' || factory === previous?.value) {
        reject(new Error('Local Ammo script did not export its factory.'));
      } else {
        resolve(factory as AmmoFactory);
      }
    };
    script.onerror = () => {
      restore();
      reject(new Error('Local Ammo script could not be loaded.'));
    };
    try {
      document.head.append(script);
    } catch (error) {
      restore();
      reject(new Error('Local Ammo script could not be loaded.', { cause: error }));
    }
  });
}
