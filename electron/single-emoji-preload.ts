import { contextBridge, ipcRenderer } from 'electron';
import { getEmoji } from '../shared/single-emoji';

contextBridge.exposeInMainWorld('singleEmoji', {
  onCue(callback: (value: { glyph: string; token: string;png?:string } | null) => void) {
    ipcRenderer.on('desk:single-emoji-render', (_event, value: unknown) => {
      const entry = value && typeof value === 'object' && !Array.isArray(value)
        ? getEmoji((value as { catalogId?: unknown }).catalogId) : undefined;
      const token = value && typeof value === 'object' ? (value as { token?: unknown }).token : null;
      const candidate=value&&typeof value==='object'?(value as {png?:unknown}).png:null;
      const png=typeof candidate==='string'&&candidate.length<=22369646&&/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(candidate)?candidate:undefined;
      callback(entry && typeof token === 'string' && /^emoji-paint-\d{1,12}$/.test(token) ? { glyph: entry.glyph, token,...(png?{png}:{}) } : null);
    });
  },
  presented(token: unknown) {
    if (typeof token === 'string' && /^emoji-paint-\d{1,12}$/.test(token)) ipcRenderer.send('desk:single-emoji-presented', token);
  },
});
