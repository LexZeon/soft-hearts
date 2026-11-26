/**
 * Unbound v1 step 2: her companion window is hidden while she is out in Unbound, but she is on the user's screen all the same. Things
 * that ask "is the companion shown?" for the senses (the internal channel's set_perception) must read that as shown. Step 1 did this
 * inside electron/main.ts for the host's own checks (`onScreen`); this is the same rule for a window handed to another module.
 */
import type { AgentWindow } from '../safety';

/** The window as the asker should see it: shown (and not minimised) while she is held out in Unbound; otherwise exactly the window. */
export function seenWhileHeld(win: AgentWindow | null | undefined, held: () => boolean): AgentWindow | null {
  if (!win) return null;
  return {
    isDestroyed: () => win.isDestroyed(),
    isVisible: () => win.isVisible() || (!win.isDestroyed() && held()),
    isMinimized: () => (held() && !win.isDestroyed() ? false : win.isMinimized()),
    get webContents() { return win.webContents; },
  };
}
