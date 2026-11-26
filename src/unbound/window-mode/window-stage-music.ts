/**
 * I-154 batch 6, row 37: the music stage members of the Unbound window stage (the old stage's src/stage/mmd/music.ts members), between the
 * previews' members (window-stage-previews.ts, batch 7; under it the empty not-yet.ts) and the games' members (window-stage-games.ts), so window-stage.ts stays a wiring file. The music itself
 * is WindowMusic (window-music.ts), held by the stage's own-life composition (window-own-life.ts).
 * Only through the user's own switch: the wiring calls setMusicEnabled / setMusicSample from the 和她一起听 controls only (it sends no
 * sample while that is off), and WindowMusic refuses a sample that comes while she does not hear.
 */
import type { StageSurface } from '../../stage';
import { WindowStagePreviews } from './window-stage-previews';
import type { WindowOwnLife } from './window-own-life';

type S = StageSurface;

export abstract class WindowStageMusic extends WindowStagePreviews {
  protected abstract readonly ownLife: WindowOwnLife;
  /** Her mood view now (the developer line is developer mode only). */
  protected abstract musicView(): Parameters<S['setMood']>[0] | null;

  /** The 和她一起听 switch: she hears. Whether she moves to it is her choice (M1), or the R15 dance until the music settings arrive. */
  setMusicEnabled(enabled: boolean): void { this.ownLife.music.setEnabled(enabled); }
  /** One capture sample (30 Hz), only while she hears. */
  setMusicSample(sample: Parameters<S['setMusicSample']>[0]): void { this.ownLife.music.setSample(sample); }
  /** "让她一直跟着跳" and the strength (normalized as on the old stage). */
  setMusicSettings(settings: Parameters<S['setMusicSettings']>[0]): void { this.ownLife.music.setSettings(settings); }
  /** I-017: what her body is doing to the sound now (the companion window reports it to the host). */
  getMusicPresence(): ReturnType<S['getMusicPresence']> { return this.ownLife.music.presence(); }
  /** The developer line: her want to dance, the tier and why, is it music, the host's kind (developer mode only). */
  getMusicChoiceLine(): string { return this.ownLife.music.line(this.musicView()); }
  setListenKindLine(line: string): void { this.ownLife.music.setListenKindLine(line); }
  /** Developer test command: she judges again at the next frame. False: no music, or "一直跟着跳". */
  rejudgeMusicNow(): boolean { return this.ownLife.music.rejudge(); }
}
