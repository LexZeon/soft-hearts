import type { WindowVisibilityState } from "../shared/contracts";

/** Native display snapshots are transient and belong to one webContents. */
export class WindowVisibility {
  private current: WindowVisibilityState;
  constructor(windowId: number, visible: boolean, petVisible: boolean) {
    this.current = { windowId, revision: 0, visible, petVisible };
  }
  observe(visible: boolean, petVisible: boolean): WindowVisibilityState {
    if (visible !== this.current.visible || petVisible !== this.current.petVisible)
      this.current = { ...this.current, revision: this.current.revision + 1, visible, petVisible };
    return { ...this.current };
  }
}
