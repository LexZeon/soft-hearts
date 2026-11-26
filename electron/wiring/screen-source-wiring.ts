// I-190 (docs/claude/2026-11-22-i190-source-pickers.md): which screen or window 屏幕共享 reads. One choice for the whole app
// (electron/senses/screen-source.ts), made on first use: the look wiring's screen reads ask it (senses-look-wiring.ts), the app windows ask
// and change it here (three desk: requests), and the Unbound input box's senses panel reaches the same one (unbound-wiring.ts).
// No module-level side effects (tests/wiring-skeleton.test.ts): nothing is made before the first call.
import { BrowserWindow, desktopCapturer } from 'electron';
import type { ScreenSourceView } from '../../shared/senses';
import { ScreenSourceChoice } from '../senses';
import type { PartIpc } from './ipc-wiring';
import { broadcast } from './shell-wiring';
import { watchContinuity } from './senses-wiring';

let choice: ScreenSourceChoice | null = null;
let listeners: Set<(view: ScreenSourceView) => void> | null = null;

/** The app's one screen choice (made on first use). */
export function screenSourceChoice(): ScreenSourceChoice {
  return choice ??= new ScreenSourceChoice({
    capturer: desktopCapturer,
    ownWindows: () => BrowserWindow.getAllWindows().map(win => { try { return win.isDestroyed() ? '' : win.getMediaSourceId(); } catch { return ''; } }),
    gone: () => watchContinuity?.sourceGone(), // 2026-11-24 (续): 一起看 is told the chosen window or screen went (facts, not a switch)
    changed: view => {
      broadcast('desk:screen-source', view);
      for (const listener of [...listeners ?? []]) { try { listener(view); } catch { /* a closing window */ } }
    },
  });
}

/** Windows outside the app's window list (the Unbound input box) hear a change here. */
export function onScreenSourceChanged(listener: (view: ScreenSourceView) => void): () => void {
  (listeners ??= new Set()).add(listener);
  return () => { listeners?.delete(listener); };
}

/** The app windows' three requests. Only an opaque id crosses: the host lists the titles, the window sends back an id it was shown. */
export function registerScreenSource({ host }: PartIpc): void {
  host('screenSourceMenu', () => screenSourceChoice().menu(), false);
  host('chooseScreenSource', (id: unknown) => screenSourceChoice().choose(id), false);
  host('getScreenSource', () => screenSourceChoice().view(), false);
}
