// I-187 和她一起看's eye button on the companion toolbar (moved out of src/stage/PetUI.ts): pressed while she sees the screen AND // no-pet-ok: existing element ids and names
// hears the dialogue; a small mark (data-not-heard) and the tooltip say so whenever she sees the screen but the dialogue does not
// reach her (shared/senses/watch-together-state.ts). It only shows; the click goes to the page (src/senses/watch-together-toggle.ts).

import { uiText } from '../foundation/ui-language';
import type { AudioReadingView } from '../../shared/voice';
import { watchTogetherLook, type WatchTogetherLook } from '../../shared/senses';

export class WatchTogetherButton {
  private screen = false;
  private view: Pick<AudioReadingView, 'sources'> | null = null;
  private last: WatchTogetherLook = watchTogetherLook({ screen: false, view: null });

  constructor(private readonly button: () => HTMLElement | null, private readonly shown: (button: HTMLElement) => void) {}

  get look(): WatchTogetherLook { return this.last; }
  setScreen(on: boolean): void { this.screen = on === true; this.render(); }
  setView(view: Pick<AudioReadingView, 'sources'> | null): void { this.view = view; this.render(); }

  render(): void {
    this.last = watchTogetherLook({ screen: this.screen, view: this.view });
    const button = this.button(); if (!button) return;
    button.setAttribute('aria-pressed', String(this.last.on));
    button.dataset.notHeard = String(this.last.notHeard);
    button.dataset.tooltip = uiText(this.last.tooltip);
    button.setAttribute('aria-label', uiText(this.last.tooltip));
    if (button.matches(':hover, :focus-visible')) this.shown(button);
  }
}
