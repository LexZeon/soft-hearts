// Unbound showcase preload (docs/claude/2026-11-14-lapwing-showcase.md): the page's whitelist (src/unbound/showcase/api.ts).
// Showcase only; the app never loads it.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('showcase', {
  plan: () => ipcRenderer.invoke('showcase:plan'),
  onSegment: (listener: (beats: unknown) => void) => { ipcRenderer.on('showcase:segment', (_event, beats) => listener(beats)); },
  onNoMore: (listener: () => void) => { ipcRenderer.on('showcase:no-more', () => listener()); },
  ready: () => ipcRenderer.invoke('showcase:ready'),
  chunk: (data: ArrayBuffer) => ipcRenderer.invoke('showcase:chunk', data),
  still: (name: string) => ipcRenderer.invoke('showcase:still', String(name).slice(0, 120)),
  log: (entry: unknown) => ipcRenderer.send('showcase:log', entry),
  saveImage: (name: string, dataUrl: string) => ipcRenderer.invoke('showcase:image', String(name).slice(0, 120), String(dataUrl).slice(0, 40_000_000)),
  done: (result: unknown) => ipcRenderer.invoke('showcase:done', result),
});
