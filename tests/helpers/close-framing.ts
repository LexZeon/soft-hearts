// I-203 (docs/claude/2026-11-23-i203-kiss-hug-plan.md): where a close moment puts her face on the screen, measured on a frame of the real frame
// loop (tests/helpers/unbound-arrival.ts): her head's width as a share of the screen's width (her face's width from her eye span, as the plan
// reads "头大概占比"), where her eyes, her mouth and her ear (the one the camera sees) are in the window (u across, v up; ±1 the edges), the
// top of her head (the highest of her measured head points), and which way her face points as seen from the camera (degrees; + toward the
// screen's right). Shared by tests/i192-arrival-models.test.ts and scripts/dev/i203-close-frames.ts.
// Straight from the files (not the part's index), so the same helper also measures the code before I-203 (scripts/dev/i203-close-frames.ts).
import { earOffset, faceTurnSeen, headPointNow, headWidthM } from '../../shared/unbound/arrival/screen-frame';
import { headNow, inWindow } from '../../shared/unbound/arrival/frame';
import type { FaceGeometry } from '../../shared/unbound/arrival/face';
import type { V3 } from '../../shared/unbound/arrival/solve';
import type { ArrivalFrame } from './unbound-arrival';

export interface CloseFraming {
  t: number; phase: string | null;
  headShare: number | null; eyes: [number, number] | null; mouth: [number, number] | null; ear: [number, number] | null; earPoint: V3 | null;
  crownV: number | null; turnDeg: number | null;
}
const r3 = (v: number | null | undefined) => v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000;

/** The framing on one frame; `face` and `heading` from her figure's sense (null face: only the eyes, the mouth and the turn). */
export function closeFraming(frame: ArrivalFrame, face: FaceGeometry | null, heading: number): CloseFraming {
  const view = frame.view, lens = { camera: view.camera, axis: { x: 0, y: 0, z: -1 }, window: { left: view.left, right: view.right, top: view.top, bottom: view.bottom } };
  const spot = (p: V3 | null): [number, number] | null => { if (!p) return null; const w = inWindow(lens, p); return w ? [r3(w.u)!, r3(w.v)!] : null; };
  const l = frame.eyes.left, r = frame.eyes.right, mid = l && r ? { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2, z: (l.z + r.z) / 2 } : null;
  const turn = faceTurnSeen(frame.eyes);
  let headShare: number | null = null, crownV: number | null = null, earPoint: V3 | null = null;
  if (face && l && r && mid) {
    const span = Math.hypot(l.x - r.x, l.y - r.y, l.z - r.z);
    headShare = headWidthM(face, span) / ((view.camera.z - mid.z) * (view.right - view.left));
    const pts = frame.head ? headNow(face.points, face.eyes, { head: frame.head, left: l, right: r, heading }) : null;
    if (pts) crownV = Math.max(...pts.map(p => spot(p)?.[1] ?? -Infinity));
    // The ear the camera sees: her face turned toward the screen's right shows her right ear, toward its left her left ear.
    earPoint = headPointNow(frame.eyes, earOffset(face, span, (turn ?? 0) >= 0 ? -1 : 1));
  }
  return { t: r3(frame.t)!, phase: frame.phase, headShare: r3(headShare), eyes: spot(mid), mouth: spot(frame.mouth), ear: spot(earPoint), earPoint, crownV: r3(crownV),
    turnDeg: turn === null ? null : Math.round(turn * 180 / Math.PI) };
}
