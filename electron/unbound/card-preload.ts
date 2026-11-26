// I-159 C: the card window's preload (built to dist-electron/unbound-card-preload.cjs). Exposes only the whitelist in
// card-preload-api.ts as window.unboundCard; the page runs sandboxed, with context isolation and no Node.
import { contextBridge, ipcRenderer } from 'electron';
import { createUnboundCardApi } from './card-preload-api';

contextBridge.exposeInMainWorld('unboundCard', createUnboundCardApi(ipcRenderer));
