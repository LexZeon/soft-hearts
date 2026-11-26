// R01 物理调参台: the lab window's preload (built to dist-electron/physics-lab-preload.cjs). Exposes only the whitelist in
// physics-lab-preload-api.ts as window.physicsLab; the page runs sandboxed, with context isolation and no Node.
import { contextBridge, ipcRenderer } from 'electron';
import { createPhysicsLabApi } from './physics-lab-preload-api';

contextBridge.exposeInMainWorld('physicsLab', createPhysicsLabApi(ipcRenderer));
