import type { WindowVisibilityState } from "../../shared/foundation/runtime-state";

/** Native display snapshots are transient and belong to one webContents. */
export class WindowVisibility {
  private current: WindowVisibilityState;
  constructor(windowId: number, visible: boolean, petVisible: boolean, minimized = false) {
    this.current = { windowId, revision: 0, visible, petVisible, ...(minimized ? { minimized } : {}) };
  }
  /** I-171: `minimized` says the window is not visible only because it is minimized (a step away); a change of it is its own revision (the key is there only while true). */
  observe(visible: boolean, petVisible: boolean, minimized = false): WindowVisibilityState {
    if (visible !== this.current.visible || petVisible !== this.current.petVisible || minimized !== (this.current.minimized === true)) {
      const { minimized: _old, ...rest } = this.current;
      this.current = { ...rest, revision: this.current.revision + 1, visible, petVisible, ...(minimized ? { minimized } : {}) };
    }
    return { ...this.current };
  }
}
