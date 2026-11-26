// 舞台's wiring, keeping the control window usable while she is top-most (Codex T-253 option 1; X-549).
// Record: docs/claude/2026-11-19-control-window-avoid.md.
// - The reply bubble keeps clear of the control window's rectangle while it is shown (electron/brain/reply-avoid.ts, read by the reply
//   window on every layout).
// - She steps aside from the control window's bottom band (its input / send / stop area) when her body really covers it, never while the
//   user drags her (electron/stage/companion-step-aside.ts).
// Her top-most state is not touched: the reply window and the step use setBounds / showInactive only (the topmost guard, I-062).
// Called once from stage-wiring.ts's startStageWindows, after dragging exists. No module-level side effects.
import { screen, type BrowserWindow } from 'electron';
import { CompanionStepAside, protectedRegion, shownWindowRect } from '../stage';
import { needs, petWindowDrag as windowDrag, type ReplyWindowPort } from './stage-wiring'; // no-pet-ok: the stage wiring's existing export name
import { petHeld as outInUnbound } from './unbound-wiring'; // no-pet-ok: the Unbound wiring's existing export name

/** Wait this long after the control window stops moving before she steps (the bubble follows at once). */
const SETTLE_MS = 200;

export function startControlAvoidance(companion: BrowserWindow, reply: ReplyWindowPort): void {
  const controls = needs.controls;
  // Tiers: the whole control window; when her head is in front of it and nothing near her mouth clears it, at least its input band.
  reply.setAvoidSource(() => { const shown = shownWindowRect(needs.controls), band = protectedRegion(needs.controls); return shown ? (band ? [shown, band] : [shown]) : null; });
  const stepAside = new CompanionStepAside({
    window: () => (companion.isDestroyed() ? null : companion),
    region: () => protectedRegion(needs.controls),
    area: bounds => screen.getDisplayMatching(bounds).workArea,
    dragging: () => !!windowDrag?.active,
    enabled: () => !companion.isDestroyed() && companion.isVisible() && !companion.isMinimized() && !outInUnbound(),
    clickThrough: () => needs.store.current.pet.clickThrough, // no-pet-ok: the settings field name
  });
  let settle: ReturnType<typeof setTimeout> | undefined;
  const later = () => { clearTimeout(settle); settle = setTimeout(() => stepAside.check(), SETTLE_MS); };
  // Quitting closes the windows in any order: a closed companion takes no more layout.
  const now = () => { if (companion.isDestroyed()) return; reply.sync(); stepAside.check(); };
  const moving = () => { if (companion.isDestroyed()) return; reply.sync(); later(); };
  if (controls && !controls.isDestroyed()) {
    for (const name of ['show', 'hide', 'minimize', 'restore', 'closed'] as const) controls.on(name as 'show', now);
    controls.on('move', moving); controls.on('resize', moving);
  }
  // Named listeners: tests/stage-gates.test.ts evaluates the wiring's inline arrows on her window in its own environment.
  const moved = () => stepAside.windowMoved(), shown = () => stepAside.check(), closed = () => { clearTimeout(settle); stepAside.stop(); };
  companion.on('move', moved); companion.on('show', shown); companion.on('restore', shown); companion.on('closed', closed);
  stepAside.start();
}
