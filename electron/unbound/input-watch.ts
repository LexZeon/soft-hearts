/**
 * I-190 follow-up in the full-screen input box's senses panel. The same one click as
 * the companion's eye button (shared/senses/watch-together-switch.ts: the screen and the dialogue together, off stops the dialogue first)
 * and the same look (shared/senses/watch-together-state.ts: pressed, the "台词没在听" mark and its reason), from the host side: the input box
 * has no window.desktop, so its request comes here and goes through the user's own switch paths (the permission bundle uses the same).
 *
 * While she is out the permission bundle keeps screen sharing on (I-159, electron/unbound/permission-bundle.ts), so turning 一起看 off here
 * only stops the dialogue; the screen is not switched off just to be switched back on a second later. Never the camera, the microphone or
 * 「和她一起听」's music: the click reaches only these two ports.
 */
import { switchWatchTogether, watchTogetherLook, type WatchTogetherLook } from '../../shared/senses';
import type { RuntimeState } from '../../shared/foundation/runtime-state';
import type { AudioReadingAck, AudioReadingView } from '../../shared/voice';

export interface InputWatchPorts {
  /** Screen sharing is on now. */
  screen(): boolean;
  /** The host's 读取音频 view (who is listening and where the capture is), null before there is one. */
  view(): Pick<AudioReadingView, 'sources'> | null;
  /** The user's own switch paths: screen sharing, and the computer's sound with words for watching (the 'movie' purpose only). */
  setScreen(on: boolean): Promise<void>;
  setDialogue(on: boolean): Promise<void>;
  /** She is out: the permission bundle holds the screen on. */
  screenHeld(): boolean;
}
export interface InputWatch {
  look(): WatchTogetherLook;
  toggle(): Promise<WatchTogetherLook>;
}

export function inputWatchTogether(ports: InputWatchPorts): InputWatch {
  const look = () => watchTogetherLook({ screen: ports.screen(), view: ports.view() });
  return {
    look,
    async toggle() {
      const facts = { screen: ports.screen(), dialogue: ports.view()?.sources?.['system-audio']?.movie?.intent === true };
      await switchWatchTogether({
        setRuntimeState: async patch => {
          const on = patch.screenSharing === true;
          if (on || !ports.screenHeld()) await ports.setScreen(on);
          return { screenSharing: ports.screen() } as RuntimeState;
        },
        setAudioReadingIntent: async value => { await ports.setDialogue(value.enabled === true); return { ok: true } as unknown as AudioReadingAck; },
      }, facts);
      return look();
    },
  };
}
