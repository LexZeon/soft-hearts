/**
 * I-086 for the app: the store, the host, the folder copy (debounced) and the fixed IPC operations. electron/main.ts supplies the
 * closures; nothing here reads a setting or a window on its own.
 *
 * IPC (shared/behaviors/give/interface.ts): the companion window only for giveAnswer / givePicture / saveGivePicture; the control window
 * only for the "我们的小东西" page (getOurThings, ourThingPicture, removeOurThing). Save goes through the native dialog: the renderer
 * never sends a path; the bytes written are the stored picture's own.
 */
import { writeFile } from 'node:fs/promises';
import { nativeImage } from 'electron';
import { OUR_THING_THUMB_EDGE, OUR_THING_THUMB_MAX_BYTES, isOurThingId, ourThingsText, type OurThing, type OurThingsView } from '../../../shared/initiative/our-things';
import type { GiveEvent } from '../../../shared/behaviors/give/interface';
import { GiveHost, type GiveHostOptions, type GiveJournalInput } from './host';
import { OurThingsStore } from './store';

type Register = (method: string, operation: (sender: number, ...args: any[]) => unknown, controlOnly?: boolean) => void;

/** A 256 px JPEG from the picture feeding already shrank (a data URL in memory); null when it cannot be made within the cap. */
export function nativeThumb(dataUrl: string): Uint8Array | null {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/jpeg;base64,')) return null;
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize(), longest = Math.max(width, height);
  const shrunk = longest > OUR_THING_THUMB_EDGE ? image.resize({ width: Math.max(1, Math.round(width * OUR_THING_THUMB_EDGE / longest)),
    height: Math.max(1, Math.round(height * OUR_THING_THUMB_EDGE / longest)), quality: 'good' }) : image;
  for (const quality of [78, 64, 50]) {
    const jpeg = new Uint8Array(shrunk.toJPEG(quality));
    if (jpeg.byteLength > 0 && jpeg.byteLength <= OUR_THING_THUMB_MAX_BYTES) return jpeg;
  }
  return null;
}

export interface GiveWiring extends Omit<GiveHostOptions, 'store' | 'send' | 'changed' | 'folder' | 'thumb' | 'journal'> {
  directory(): string | null;
  petSender(): number | null;
  /** The current character (the page and the IPC act on it only). */
  characterId(): string;
  send(event: GiveEvent): boolean;
  /** The control window's page changed. */
  broadcast(view: OurThingsView): void;
  journal?(entry: GiveJournalInput): void;
  /** Her folder, when on: the text list and her pictures, through the folder's own checked path (electron/initiative/her-folder/host.ts). */
  folder?: {
    enabled(): boolean;
    syncText(name: string, content: string): Promise<unknown>;
    keepPicture(stem: string, png: Uint8Array): Promise<unknown>;
    language(): 'zh-CN' | 'en';
  };
  /** The native "save as" dialog; resolves to the chosen path or null. */
  saveDialog(defaultName: string): Promise<string | null>;
  /** I-144b: 「删掉」 goes through the recycle bin (electron/memory/recycle-wiring.ts `recycled`); absent: removed as before. Read at the moment of each removal. */
  removeThroughBin?(characterId: string, id: string, remove: () => Promise<OurThingsView>): Promise<OurThingsView>;
}

/** How long a change waits before the folder's list is rewritten (several changes in a row become one write). */
export const OUR_THINGS_FOLDER_DEBOUNCE_MS = 5 * 60_000;

export function createGive(wiring: GiveWiring) {
  const store = new OurThingsStore({ directory: wiring.directory });
  const pendingFolder = new Map<string, ReturnType<typeof setTimeout>>();
  const folderList = (characterId: string, list: readonly OurThing[]) => {
    if (!wiring.folder?.enabled()) return;
    const previous = pendingFolder.get(characterId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      pendingFolder.delete(characterId);
      if (!wiring.folder?.enabled() || wiring.characterId() !== characterId) return;
      const language = wiring.folder.language();
      void wiring.folder.syncText(language === 'en' ? 'Our little things.md' : '我们的小东西.md', ourThingsText(list, language)).catch(() => {});
    }, OUR_THINGS_FOLDER_DEBOUNCE_MS);
    timer.unref?.();
    pendingFolder.set(characterId, timer);
  };
  const host = new GiveHost({
    ...wiring,
    store,
    thumb: nativeThumb,
    changed: characterId => { if (characterId === wiring.characterId()) wiring.broadcast(host.view(characterId)); },
    folder: {
      list: folderList,
      picture: (characterId, thing, png) => {
        if (!wiring.folder?.enabled() || wiring.characterId() !== characterId) return;
        const d = new Date(thing.at), two = (n: number) => String(n).padStart(2, '0');
        const stem = `${wiring.folder.language() === 'en' ? 'A picture for you' : '她给你的图'} ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
        void wiring.folder.keepPicture(stem, png).catch(() => {});
      },
    },
  });
  const register = (scopedHost: Register) => {
    const fromPet = (sender: number) => sender === wiring.petSender();
    scopedHost('giveAnswer', (sender, value) => host.answer(fromPet(sender), value), false);
    scopedHost('givePicture', (sender, value) => host.picture(fromPet(sender), value), false);
    scopedHost('saveGivePicture', async (sender, value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) return false;
      const id = (value as { id?: unknown }).id;
      if (!isOurThingId(id)) return false;
      return save(id);
    }, false);
    scopedHost('getOurThings', () => host.load(wiring.characterId()), true);
    scopedHost('ourThingPicture', async (_sender, id) => {
      if (!isOurThingId(id)) return null;
      const picture = await host.pictureData(wiring.characterId(), id);
      return picture ? `data:${picture.type};base64,${Buffer.from(picture.bytes).toString('base64')}` : null;
    }, true);
    scopedHost('removeOurThing', (_sender, id) => {
      if (!isOurThingId(id)) throw new Error('这条小东西不存在。');
      const characterId = wiring.characterId();
      return wiring.removeThroughBin ? wiring.removeThroughBin(characterId, id, () => host.remove(characterId, id)) : host.remove(characterId, id);
    }, true);
  };
  /** "存下来": the stored picture's bytes, to a place the user picks in the native dialog. */
  const save = async (id: string): Promise<boolean> => {
    const characterId = wiring.characterId(), picture = await host.pictureData(characterId, id);
    if (!picture) return false;
    const target = await wiring.saveDialog(picture.type === 'image/png' ? '她给你的图.png' : '点心.jpg');
    if (!target) return false;
    try { await writeFile(target, picture.bytes); return true; } catch { return false; }
  };
  const dispose = () => { host.dispose(); for (const timer of pendingFolder.values()) clearTimeout(timer); pendingFolder.clear(); };
  return { host, store, register, save, dispose };
}
