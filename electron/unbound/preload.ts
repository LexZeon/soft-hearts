// Unbound U1: the Unbound window's preload (built to dist-electron/unbound-preload.cjs). Exposes only the whitelist in
// preload-api.ts as window.unbound; the page itself runs sandboxed, with context isolation and no Node.
import { contextBridge, ipcRenderer } from 'electron';
import { createUnboundApi } from './preload-api';

contextBridge.exposeInMainWorld('unbound', createUnboundApi(ipcRenderer));
