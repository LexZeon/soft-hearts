// Where touches go (I-136). The places that see the mouse (Unbound now, the companion window later) call reportTouch; the brain side
// (electron/mood/touch/, set up in electron/main.ts) registers itself with setTouchSink. Until one is set, touches are dropped:
// a touch is never a reason for an error.
import { parseTouchEvent, type TouchEvent } from '../../../shared/mood/touch';

type Sink = (event: TouchEvent) => void;
let sink: Sink | null = null;

export function setTouchSink(next: Sink | null): void { sink = next; }

/** Validates (anything odd is dropped) and hands the touch to the brain side. Never throws. */
export function reportTouch(value: unknown): boolean {
  const event = parseTouchEvent(value);
  if (!event || !sink) return false;
  try { sink(event); return true; } catch { return false; }
}
