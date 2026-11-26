/**
 * I-209 step 3 / 2026-11-25: where an extra comes out so nobody stands inside anybody already there (her page then places her at the result).
 * Pure; electron/unbound/company/stage.ts clearOf gives the bodies standing now. A body counts as clear when its centre is at least the sum of the two
 * half-widths plus a hand's room away on the floor. The result is the nearest free x at her depth, right side first, inside `bounds`; when there is
 * no room at all it returns where she was asked to stand (nothing else to try; the stage's own step-aside logic then separates them).
 */
export interface StartBody { xM: number; depthM: number; radiusM: number }

/** Her own half-width and the room between two people (m): trial values. */
export const START_CLEAR = Object.freeze({ radiusM: 0.25, gapM: 0.15, stepM: 0.1, maxSteps: 40, /** No room in the row (she comes out near, the screen is narrow there): one row behind, this far (m), up to `rows` times. */ backStepM: 1.6, rows: 2 });

export function clearStartX(others: Iterable<StartBody>, at: { xM: number; depthM: number }, bounds: { minX: number; maxX: number }, k = START_CLEAR): { xM: number; depthM: number } {
  const list = [...others];
  const clearAt = (x: number, depthM: number) => list.every(body => Math.hypot(body.xM - x, body.depthM - depthM) >= body.radiusM + k.radiusM + k.gapM);
  for (let row = 0; row <= k.rows; row++) {
    const depthM = at.depthM + row * k.backStepM;
    if (clearAt(at.xM, depthM)) return { xM: at.xM, depthM };
    for (let step = 1; step <= k.maxSteps; step++) for (const side of [1, -1]) { const x = at.xM + side * step * k.stepM; if (x >= bounds.minX && x <= bounds.maxX && clearAt(x, depthM)) return { xM: x, depthM }; }
  }
  return at;
}
