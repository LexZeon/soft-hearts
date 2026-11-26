// Unbound v1 step 2: the small input box's preload (built to dist-electron/unbound-input-preload.cjs). Exposes only the whitelist in
// input-preload-api.ts as window.unboundInput; the page runs sandboxed, with context isolation and no Node.
import { contextBridge, ipcRenderer } from 'electron';
import { createUnboundInputApi } from './input-preload-api';

contextBridge.exposeInMainWorld('unboundInput', createUnboundInputApi(ipcRenderer));
