// F6 "更真实的情绪" (shared/realer-emotions.ts): the card editor's checkbox. Turning it on first shows, in the main process,
// what she will do and what never changes; only "我知道了，打开" saves. Turning it off saves at once. No Electron import:
// electron/main.ts passes the native dialog, tests pass their own.
import type { CharacterCardState } from '../shared/character-cards';
import { REALER_EMOTIONS_CONSENT } from '../shared/realer-emotions';

/** The native dialog's options (electron.MessageBoxOptions shape): the accept button is index 1, the safe default is 0. */
export function realerEmotionsDialogOptions(name: string) {
  return {
    type: 'question' as const, title: REALER_EMOTIONS_CONSENT.title, message: REALER_EMOTIONS_CONSENT.message(name),
    detail: REALER_EMOTIONS_CONSENT.detail, buttons: [REALER_EMOTIONS_CONSENT.decline, REALER_EMOTIONS_CONSENT.accept],
    defaultId: 0, cancelId: 0, noLink: true,
  };
}

/** I-014: the same explanation as an information box with one button, shown once after it turned on; nothing waits for it. */
export function realerEmotionsInfoOptions(name: string) {
  return {
    type: 'info' as const, title: REALER_EMOTIONS_CONSENT.title, message: `已给「${name}」打开“更真实的情绪”`,
    detail: REALER_EMOTIONS_CONSENT.detail, buttons: ['知道了'], defaultId: 0, cancelId: 0, noLink: true,
  };
}

export interface RealerEmotionsRequestDeps {
  cards(): CharacterCardState;
  /** Shows realerEmotionsDialogOptions(name); true only when the user chose the accept button. */
  confirm(options: ReturnType<typeof realerEmotionsDialogOptions>): Promise<boolean>;
  /** The one save (main.ts: the card store's setRealerEmotions inside the host's mutation queue, then the usual character sync). */
  save(id: string, value: boolean): Promise<CharacterCardState>;
  /**
   * I-014 "三方互通": while it is on, the user's own click in the settings window is the consent, so the
   * dialog does not ask again; the explanation is still shown once (`inform`, not waited for). Absent: off.
   */
  interconnected?(): boolean;
  inform?(options: ReturnType<typeof realerEmotionsInfoOptions>): void;
}

/**
 * The host handler for `requestCharacterRealerEmotions(id, value)`. On: the dialog first (outside the mutation queue, so nothing
 * else waits on the user), then the save only if the user agreed; declining returns the cards unchanged. Off: saved at once.
 * With 三方互通 on: saved at once, then the explanation is shown once.
 */
export function realerEmotionsRequest(deps: RealerEmotionsRequestDeps): (id: unknown, value: unknown) => Promise<CharacterCardState> {
  return async (id, value) => {
    if (typeof id !== 'string' || !id) throw new Error('角色卡编号不正确。');
    if (typeof value !== 'boolean') throw new Error('“更真实的情绪”只能是开或关。');
    const card = deps.cards().cards.find(item => item.id === id);
    if (!card) throw new Error('没有这张角色卡。');
    if ((card.realerEmotions === true) === value) return deps.cards();
    let direct = false;
    try { direct = deps.interconnected?.() === true; } catch { direct = false; }
    if (value && direct) {
      const state = await deps.save(id, value);
      try { deps.inform?.(realerEmotionsInfoOptions(card.name)); } catch { /* Showing it never undoes the change. */ }
      return state;
    }
    if (value && !(await deps.confirm(realerEmotionsDialogOptions(card.name)))) return deps.cards();
    return deps.save(id, value);
  };
}
