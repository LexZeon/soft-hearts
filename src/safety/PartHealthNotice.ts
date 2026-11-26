// 一部分关了 (overhaul step 7, docs/claude/2026-11-17-isolation-step7.md; plan docs/claude/2026-11-16-wiring-rewrite-plan.md section 3): the
// control window's banner, in the place and style of ChatAvailabilityNotice (right above the workspace), with the plan's words for each
// unit the host switched off alone, and that unit's switches greyed with 「这部分暂时关了」. Everything shown is the host's closed words
// (part and unit ids mapped to fixed labels in shared/foundation/part-health.ts) set as textContent. Nothing is shown on the companion.
// Units only go off during a run (a restart turns them on again), so a switch once greyed stays greyed until the window reloads.
import { uiText } from '../foundation/ui-language';
import { PART_OFF_SWITCH_NOTE, isPartUnit, partOffNotice } from '../../shared/foundation/part-health';
import type { PartHealthView } from '../../shared/foundation/ports';

export interface PartHealthPorts {
  get(): Promise<PartHealthView>;
  changed(callback: (view: PartHealthView) => void): () => void;
  /** The elements that hold a unit's switches in this window (`<part>/<unit>` → elements); none: nothing to grey. */
  switches?(unit: string): readonly HTMLElement[];
}

/**
 * The control window's switches of the units that can be switched off, by the id of the panel or section that holds them. A unit not
 * listed has no switch of its own here: its handlers answer PART_OFF and its panel shows its own error.
 */
export const PART_SWITCH_ELEMENTS: Readonly<Record<string, readonly string[]>> = {
  'senses/face-check': ['face-check'],
  'senses/pose-sensing': ['pose-sensing'],
  'senses/local-asr': ['local-asr'],
  'senses/user-activity': ['user-activity'],
  'initiative/her-folder': ['her-folder'],
  'memory/memory-notes': ['people-things'],
  'memory/moving-memory': ['moving-memory'],
  'mood/mood-judge': ['mood-judge'],
  'mood/reactions': ['reactions'],
  'safety/agent-channel': ['agent-channel'],
};

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '') => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  return value;
};

export class PartHealthNotice {
  private readonly title = make('span', 'chat-availability-reason');
  private readonly lines = make('div', 'part-health-lines');
  private readonly greyed = new Map<HTMLElement, { note: HTMLElement; disabled: (HTMLInputElement | HTMLButtonElement | HTMLSelectElement)[] }>();
  private latest = 0;
  private readonly stop: () => void;

  constructor(private readonly root: HTMLElement, private readonly ports: PartHealthPorts) {
    const heading = make('div', 'chat-availability-title');
    const label = make('strong');
    label.textContent = uiText('需要处理');
    heading.append(label, this.title);
    root.setAttribute('role', 'status');
    root.replaceChildren(heading, this.lines);
    root.hidden = true;
    this.stop = ports.changed(view => { this.latest++; this.show(view); });
    const ticket = ++this.latest;
    void ports.get().then(view => { if (ticket === this.latest) this.show(view); }, () => {});
  }

  dispose(): void {
    this.stop();
    for (const [element, { note, disabled }] of this.greyed) {
      for (const control of disabled) control.disabled = false;
      note.remove();
      element.classList.remove('part-off');
    }
    this.greyed.clear();
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  private show(view: PartHealthView): void {
    const off = view.off.filter(entry => isPartUnit(entry.part, entry.unit));
    if (!off.length) { this.root.hidden = true; this.lines.replaceChildren(); return; }
    this.title.textContent = uiText('有一部分暂时关了');
    this.lines.replaceChildren(...off.map(entry => { const line = make('p', 'chat-availability-hint'); line.textContent = partOffNotice(entry, uiText); return line; }));
    this.root.hidden = false;
    for (const entry of off) for (const element of this.ports.switches?.(`${entry.part}/${entry.unit}`) ?? []) this.grey(element);
  }

  /** A unit's switches: their controls disabled, the note beside them. */
  private grey(element: HTMLElement): void {
    if (this.greyed.has(element)) return;
    const disabled = [...element.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select')].filter(control => !control.disabled);
    for (const control of disabled) control.disabled = true;
    const note = make('small', 'part-off-note');
    note.textContent = uiText(PART_OFF_SWITCH_NOTE);
    element.classList.add('part-off');
    element.append(note);
    this.greyed.set(element, { note, disabled });
  }
}
