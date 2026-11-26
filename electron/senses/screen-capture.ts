// 看: the two reads of the shared screen, moved out of electron/wiring/senses-look-wiring.ts unchanged (I-174: that file was at its size
// limit). No module-level side effects; the look wiring makes one with its own runtime pieces and calls these from its closures.
import type { BrowserWindow, DesktopCapturerSource, SourcesOptions } from 'electron';
import type { Attachment } from '../../shared/foundation/chat';
import { glanceFit } from '../../shared/senses';
import type { MediaRuntime } from './media-runtime';

export interface ScreenCapturePorts {
  media: MediaRuntime;
  /** Her companion window (the glance reads the display it is on). */
  companion(): BrowserWindow | null | undefined;
  onScreen(win: BrowserWindow): boolean;
  /** Her visual self's capture of this screen (a token per capture), and which source it watches now. */
  visualSelf(): { runtime: { beginCapture(kind: 'screen'): unknown; completeCapture(token: never, frame: { source: 'screen'; dataUrl: string }, at: number, until: number): void }; sourceId: string | null };
  intervalSeconds(): number;
  /** Electron's desktopCapturer and the display a window is on (the look wiring passes the real ones; tests pass fakes). */
  capturer: { getSources(options: SourcesOptions): Promise<DesktopCapturerSource[]> };
  displayOf(win: BrowserWindow): { id: number };
  /** I-190: the source the user chose (electron/senses/screen-source.ts ScreenSourceChoice.source); absent: the companion's screen, as before. */
  pick?(companionDisplayId: string, thumbnailSize: { width: number; height: number }): Promise<DesktopCapturerSource | null>;
  now?(): number;
}

export function screenCaptures(ports: ScreenCapturePorts) {
  const { media } = ports;
  const read = async (displayId: string, thumbnailSize: { width: number; height: number }) => ports.pick ? ports.pick(displayId, thumbnailSize)
    : (await ports.capturer.getSources({ types: ['screen'], thumbnailSize, fetchWindowIcons: false })).find(item => item.display_id === displayId) ?? null;
  return {
    /**
     * 屏幕只读大概: one thumbnail of the shared screen (the display the companion is on), 320×200 at most, as a JPEG data URL, for the small model's
     * one word (electron/senses/screen-glance.ts). In memory only; null when sharing is off, the companion is hidden or the screen cannot be read.
     */
    async glance(signal: AbortSignal): Promise<string | null> {
      const win = ports.companion();
      signal.throwIfAborted();
      if (!media.state.screenSharing || !win || !ports.onScreen(win)) return null;
      const opening = media.openings.screen, sourceId = String(ports.displayOf(win).id);
      const source = await read(sourceId, { width: 320, height: 200 });
      signal.throwIfAborted();
      if (opening !== media.openings.screen || !media.state.screenSharing) return null; // 2026-11-22: only screen sharing turning off (or off and on) drops it
      if (!source || source.thumbnail.isEmpty()) return null;
      const size = source.thumbnail.getSize(), fit = glanceFit(size);
      if (!fit) return null;
      const picture = fit.width === size.width && fit.height === size.height ? source.thumbnail : source.thumbnail.resize(fit);
      return `data:image/jpeg;base64,${picture.toJPEG(70).toString('base64')}`;
    },
    async shared(sourceId: string, signal: AbortSignal): Promise<Attachment> {
      signal.throwIfAborted();
      // a change of another switch (voice input, the camera) while the screen is read no longer drops it;
      // screen sharing turning off, or off and on (a new opening), still does.
      const opening = media.openings.screen;
      if (!media.state.screenSharing) throw new Error('Screen sharing off');
      const self = ports.visualSelf();
      const token = sourceId === self.sourceId ? self.runtime.beginCapture('screen') : null;
      const source = await read(sourceId, { width: 1600, height: 1000 });
      signal.throwIfAborted();
      if (opening !== media.openings.screen || !media.state.screenSharing) throw new Error('Sharing changed');
      if (!source || source.thumbnail.isEmpty()) throw new Error('Selected screen unavailable');
      const dataUrl = `data:image/jpeg;base64,${source.thumbnail.toJPEG(75).toString('base64')}`;
      if (dataUrl.length > 4_000_000) throw new Error('Shared image too large');
      const frame = { source: 'screen' as const, dataUrl };
      const now = ports.visualSelf();
      if (token && sourceId === now.sourceId) {
        const at = ports.now?.() ?? Date.now();
        now.runtime.completeCapture(token as never, frame, at, at + Math.min(ports.intervalSeconds() * 2_000, 60_000));
      }
      return frame;
    },
  };
}
