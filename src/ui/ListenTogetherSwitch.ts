import { uiText } from './ui-language';
import type { AudioReadingView } from '../../shared/audio-reading-toggles';
import { listenSwitchOn, listenWordsOn } from '../../shared/listen-together';

/**
 * I-016 一起听 (docs/claude/2026-11-03-listen-together.md): the one switch 「和她一起听」 in the pet's sound panel. It replaces the
 * four reading switches and the audio-rhythm button: on = the computer's sound, rhythm (M1, as before) and words (local
 * transcription) together; the microphone is not part of it. The host owns everything; this only shows and asks.
 */
export interface ListenSwitchFacts {
  view: AudioReadingView | null;
  /** The host's rhythm intent for the computer's sound (audio capture slot). */
  systemDance: boolean;
  /** A current rhythm frame reached the stage. */
  danceActive: boolean;
}

/** The status line under the switch (fixed shapes, Chinese source keys). */
export function listenSwitchStatus(facts: ListenSwitchFacts): string {
  if (!listenSwitchOn(facts.view, facts.systemDance)) return '关着';
  // Words off: no local component yet, or 识别方式 is the compatible address (Codex T-207); her notice says which and what to do.
  if (!listenWordsOn(facts.view)) return '只听得到节奏：本机识别能用时，才听得懂歌词和对白';
  const capture = facts.view!.sources['system-audio'].capture;
  if (capture.phase === 'paused') return '你说话或她朗读时，先停一下';
  if (capture.phase === 'error') return '没能听到电脑的声音，请关掉再打开';
  if (capture.phase !== 'ready') return '正在准备…';
  return '在听：节奏、歌词和对白都在这台电脑上分析';
}

export const LISTEN_SWITCH_NOTE = '听的是电脑里放的声音，不是麦克风。声音和转写只在这台电脑上；只有整理笔记、你问到、她想开口时，才把需要的文字交给你的 Claude。通话、开会这类只是说话的声音不记。';

export class ListenTogetherSwitch {
  readonly element: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly status: HTMLOutputElement;
  private facts: ListenSwitchFacts = { view: null, systemDance: false, danceActive: false };
  private pending: boolean | null = null;
  private operation = 0;
  private disposed = false;

  constructor(container: HTMLElement, private readonly actions: { set(enabled: boolean): Promise<unknown> }) {
    this.element = document.createElement('section');
    this.element.className = 'listen-together-switch';
    this.element.dataset.moodUi = 'true';
    const label = document.createElement('label');
    label.className = 'listen-together-switch__choice';
    this.input = document.createElement('input');
    this.input.type = 'checkbox'; this.input.checked = false; this.input.disabled = true;
    this.input.dataset.role = 'listen-together';
    const title = document.createElement('span'); title.textContent = uiText('和她一起听');
    this.status = document.createElement('output');
    this.status.className = 'listen-together-switch__status';
    this.status.setAttribute('aria-live', 'polite');
    this.input.onchange = () => { void this.request(this.input.checked); };
    label.append(this.input, title);
    const note = document.createElement('p'); note.className = 'listen-together-switch__note'; note.textContent = uiText(LISTEN_SWITCH_NOTE);
    this.element.append(label, this.status, note);
    container.append(this.element);
    this.render();
  }

  update(facts: ListenSwitchFacts): void { if (!this.disposed) { this.facts = facts; this.render(); } }
  get on(): boolean { return listenSwitchOn(this.facts.view, this.facts.systemDance); }

  dispose(): void { this.disposed = true; this.operation++; this.input.onchange = null; this.input.disabled = true; this.element.remove(); }

  private async request(enabled: boolean): Promise<void> {
    if (this.disposed || !this.facts.view) return;
    const operation = ++this.operation;
    this.pending = enabled; this.render();
    try { await this.actions.set(enabled); } catch { /* the host's state below is the truth; the error was already shown */ }
    if (this.disposed || operation !== this.operation) return;
    this.pending = null; this.render();
  }

  private render(): void {
    this.input.disabled = this.disposed || !this.facts.view;
    this.input.checked = this.pending ?? this.on;
    this.input.setAttribute('aria-busy', String(this.pending !== null));
    this.status.textContent = this.pending !== null ? uiText(this.pending ? '正在打开…' : '正在关掉…') : uiText(listenSwitchStatus(this.facts));
    this.status.dataset.active = String(this.on);
  }
}
