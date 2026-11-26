/**
 * 嘴型记录 in full screen (2026-11-25):
 * the full-screen page never wrote the 'mouth-reading' rows the desktop window writes, so the journal could not tell whose mouth moved.
 * Every drawn frame after her mouth: how far her lips parted while her voice moved them, one row per reply (the same log as the desktop
 * window, src/unbound/window-mode/mouth-reading-log.ts), sent on her stage channel (unbound:stage-mouth). The host takes it only from her own
 * window and writes it under HER card id (electron/unbound/company/stage.ts mouthRow), alone or with others on stage. Reads only; never
 * moves her mouth.
 */
import type { MouthReadingWord } from '../../shared/stage';
import type { MouthReading } from './mouth';
import { MouthReadingLog, type MouthReadingEntry } from './window-mode/mouth-reading-log';

export class MouthJournal {
  private readonly log: MouthReadingLog;
  constructor(send: ((entry: MouthReadingEntry) => Promise<unknown> | undefined) | null) {
    this.log = new MouthReadingLog(entry => { void send?.(entry)?.catch(() => {}); });
  }
  /** One drawn frame: her mouth now (null: none yet) and the expression holding her face. */
  frame(dt: number, mouth: { readonly voiced: boolean; readonly lastReading: MouthReading } | null, word: MouthReadingWord): void {
    this.log.frame(dt, mouth?.voiced === true, mouth?.lastReading, word);
  }
}
