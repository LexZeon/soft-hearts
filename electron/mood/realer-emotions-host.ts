// F6 "更真实的情绪" (shared/mood/realer-emotions.ts): the card editor's checkbox. Turning it on first shows, in the main process,
// what she will do and what never changes, and (I-112 B) how long it stays on; only one of the accept buttons saves. Turning it
// off saves at once. No Electron import: electron/main.ts passes the native dialog, tests pass their own.
import type { CharacterCardState } from '../../shared/foundation/character-card';
import { REALER_EMOTIONS_CONSENT } from '../../shared/mood/realer-emotions';
import { DEFAULT_REALER_DURATION, REALER_DURATIONS, REALER_DURATION_LABELS, type RealerDuration } from '../../shared/mood/realer-duration';

/** The accept buttons in the order they appear after the decline button (index 0). */
export const REALER_DIALOG_DURATIONS: readonly RealerDuration[] = REALER_DURATIONS;

/** The native dialog's options (electron.MessageBoxOptions shape): button 0 declines (also the safe default), buttons 1..4 are the durations. */
export function realerEmotionsDialogOptions(name: string) {
  return {
    type: 'question' as const, title: REALER_EMOTIONS_CONSENT.title, message: REALER_EMOTIONS_CONSENT.message(name),
    detail: `${REALER_EMOTIONS_CONSENT.detail}\n\n${REALER_EMOTIONS_CONSENT.durationAsk}`,
    buttons: [REALER_EMOTIONS_CONSENT.decline, ...REALER_DIALOG_DURATIONS.map(duration => REALER_EMOTIONS_CONSENT.durationButtons[duration])],
    defaultId: 0, cancelId: 0, noLink: true,
  };
}

/** The line the agent channel's dialog and notice add for a chosen time (default: a week). */
export function realerDurationLine(duration: RealerDuration = DEFAULT_REALER_DURATION): string {
  return REALER_EMOTIONS_CONSENT.durationLine(REALER_DURATION_LABELS[duration], duration === 'forever');
}

/** I-014: the same explanation as an information box with one button, shown once after it turned on; nothing waits for it. */
export function realerEmotionsInfoOptions(name: string, duration: RealerDuration = DEFAULT_REALER_DURATION) {
  return {
    type: 'info' as const, title: REALER_EMOTIONS_CONSENT.title, message: `已给「${name}」打开“更真实的情绪”`,
    detail: `${REALER_EMOTIONS_CONSENT.detail}\n\n${realerDurationLine(duration)}`, buttons: ['知道了'], defaultId: 0, cancelId: 0, noLink: true,
  };
}

export interface RealerEmotionsRequestDeps {
  cards(): CharacterCardState;
  /**
   * Shows realerEmotionsDialogOptions(name). Returns the index of the button pressed (0 or a closed box: declined; 1..4: the
   * duration of REALER_DIALOG_DURATIONS), or a boolean (false declined; true the default duration).
   */
  confirm(options: ReturnType<typeof realerEmotionsDialogOptions>): Promise<boolean | number>;
  /** The one save (main.ts: the card store's setRealerEmotions inside the host's mutation queue, then the usual character sync). */
  save(id: string, value: boolean, duration?: RealerDuration): Promise<CharacterCardState>;
  /**
   * I-014 "三方互通": while it is on, the user's own click in the settings window is the consent, so the
   * dialog does not ask again; the explanation is still shown once (`inform`, not waited for). Absent: off.
   */
  interconnected?(): boolean;
  inform?(options: ReturnType<typeof realerEmotionsInfoOptions>): void;
}

function chosenDuration(answer: boolean | number): RealerDuration | null {
  if (answer === true) return DEFAULT_REALER_DURATION;
  if (typeof answer === 'number' && Number.isInteger(answer) && answer >= 1 && answer <= REALER_DIALOG_DURATIONS.length) return REALER_DIALOG_DURATIONS[answer - 1];
  return null;
}

/**
 * The host handler for `requestCharacterRealerEmotions(id, value)`. On: the dialog first (outside the mutation queue, so nothing
 * else waits on the user), then the save only if the user agreed (with the chosen duration); declining returns the cards unchanged.
 * Off: saved at once (this also clears an "已到期关闭" note). With 三方互通 on: saved at once for the default time, then the
 * explanation is shown once.
 */
export function realerEmotionsRequest(deps: RealerEmotionsRequestDeps): (id: unknown, value: unknown) => Promise<CharacterCardState> {
  return async (id, value) => {
    if (typeof id !== 'string' || !id) throw new Error('角色卡编号不正确。');
    if (typeof value !== 'boolean') throw new Error('“更真实的情绪”只能是开或关。');
    const card = deps.cards().cards.find(item => item.id === id);
    if (!card) throw new Error('没有这张角色卡。');
    // Already in the asked state: nothing to do, except that turning "off" by hand clears the "已到期关闭" note.
    if ((card.realerEmotions === true) === value && !(value === false && card.realerEmotionsExpired === true)) return deps.cards();
    let direct = false;
    try { direct = deps.interconnected?.() === true; } catch { direct = false; }
    if (value && direct) {
      const state = await deps.save(id, value, DEFAULT_REALER_DURATION);
      try { deps.inform?.(realerEmotionsInfoOptions(card.name, DEFAULT_REALER_DURATION)); } catch { /* Showing it never undoes the change. */ }
      return state;
    }
    if (!value) return deps.save(id, false);
    const duration = chosenDuration(await deps.confirm(realerEmotionsDialogOptions(card.name)));
    return duration ? deps.save(id, true, duration) : deps.cards();
  };
}
