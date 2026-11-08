import path from 'node:path';
import { nativeImage } from 'electron';
import { MOOD_LABELS } from '../../shared/mood-runtime';
import type { MoodView } from '../../shared/mood-runtime';
import type { FeedLineMessage, FeedRecognitionView } from '../../shared/feed-recognition';
import { FeedRecognitionHost, type AcceptedFood, type FeedJournalEntry, type FeedRecognitionHostOptions } from './host';
import { shrinkFeedImage, type FeedImageCodec, type FeedImageDecoded } from './image';
import { feedLineWithClaude, recognizeWithClaude } from './model';
import { FeedRecognitionStore } from './store';

/** Electron's own decoder (PNG / JPEG only), in memory. */
export const nativeFeedImageCodec: FeedImageCodec = bytes => {
  const wrap = (image: Electron.NativeImage): FeedImageDecoded => {
    const size = image.getSize();
    return { width: size.width, height: size.height, resize: next => wrap(image.resize({ ...next, quality: 'good' })), jpeg: quality => image.toJPEG(quality) };
  };
  const image = nativeImage.createFromBuffer(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return image.isEmpty() ? null : wrap(image);
};

/** What electron/main.ts supplies: closures read only at the moment they are needed. */
export interface FeedRecognitionWiring {
  directory(): string;
  /** The pet window's webContents id (only it may hand over a picture or report her line), or null. */
  petSender(): number | null;
  mood(): { get(): MoodView; chatContext(): string; lastAcceptedFood(): AcceptedFood | null;
    lift(lift: { id: string; delta: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>>; reason: string }, characterId?: string): void } | null;
  character(): { id: string; persona: string; language: string } | null;
  identity(): string;
  /** The chat model setting when chat runs on Claude (''= Claude Code's default), else null. */
  chatModel(): string | null;
  available(): boolean;
  recording(): boolean;
  free(): boolean;
  send(message: FeedLineMessage): boolean;
  speechStyle(id: string): void;
  archive: FeedRecognitionHostOptions['archive'];
  /** The switch changed: both windows hear it. */
  broadcast(view: FeedRecognitionView): void;
  journal?(characterId: string, entry: FeedJournalEntry): void;
}
type Register = (method: string, operation: (sender: number, ...args: any[]) => unknown, controlOnly?: boolean) => void;

/** I-019 for the app: the store, the host, its four fixed IPC operations (and two channels: desk:feed-line, desk:feed-recognition). */
export function createFeedRecognition(wiring: FeedRecognitionWiring) {
  const store = new FeedRecognitionStore({ file: () => path.join(wiring.directory(), 'feed-recognition.json') });
  const host = new FeedRecognitionHost({
    store,
    acceptedFood: () => wiring.mood()?.lastAcceptedFood() ?? null,
    character: wiring.character,
    moodLabel: () => { const view = wiring.mood()?.get(); return view ? MOOD_LABELS[view.snapshot.primary] ?? '' : ''; },
    moodContext: () => wiring.mood()?.chatContext() ?? '',
    moodPhase: () => wiring.mood()?.get().snapshot.phase ?? '',
    lift: (lift, characterId) => wiring.mood()?.lift(lift, characterId),
    identity: wiring.identity,
    shrink: bytes => shrinkFeedImage(bytes, nativeFeedImageCodec),
    recognize: (prompt, image, signal) => recognizeWithClaude(prompt, image, signal),
    line: (prompt, signal) => { const model = wiring.chatModel(); return model === null ? null : feedLineWithClaude(prompt, model, signal); },
    available: wiring.available, recording: wiring.recording, free: wiring.free,
    publish: wiring.send, speechStyle: wiring.speechStyle, archive: wiring.archive, journal: wiring.journal,
  });
  const view = (): FeedRecognitionView => ({ enabled: store.recognize });
  const register = (scopedHost: Register) => {
    const fromPet = (sender: number) => sender === wiring.petSender();
    // The picture: pet window only, exactly { sessionId, image } (shared/feed-recognition.ts readFeedSnackInput).
    scopedHost('feedSnack', (sender, value) => host.accept(fromPet(sender), value), false);
    scopedHost('feedLineDone', (sender, value) => host.done(fromPet(sender), value), false);
    scopedHost('getFeedRecognition', () => view(), false);
    // The switch: the control window only (隐私与设置).
    scopedHost('setFeedRecognition', (_sender, value) => {
      if (typeof value !== 'boolean') throw new Error('认图开关不正确。');
      store.setRecognize(value);
      if (!value) host.cancel();
      const next = view(); wiring.broadcast(next); return next;
    }, true);
  };
  return { host, store, register, load: () => store.load(), dispose: () => host.dispose() };
}
