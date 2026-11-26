// I-139 A3: what the control window may see of her "most moving thing" (opening layer 2). Plain data, no ids or paths. The window can
// delete the current one and bring an older one back; both name the version by its `chosenAt` (security review 2026-11-15: a list position
// could point at another version after a handoff), and the host finds it again or does nothing.
export interface MovingMemoryVersionView {
  date: string;
  text: string;
  /** Her own reason, in her words, when she gave one. */
  why: string | null;
  chosenAt: number;
  /** True for the one she opens with now (never true while the user has deleted it). */
  current: boolean;
}

export interface MovingMemoryView {
  /** I-139 is on and a character is active; off: the panel shows nothing. */
  active: boolean;
  /** Newest first. A version's `chosenAt` is what delete and restore take. */
  versions: MovingMemoryVersionView[];
}
