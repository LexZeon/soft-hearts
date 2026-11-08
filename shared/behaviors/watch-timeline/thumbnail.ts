// I-048 step 2: the small grayscale thumbnail the change gate compares (frame-change.ts). Making the small bitmap from a screenshot is
// Electron's job (electron/watch-notes/frame-picture.ts); turning its BGRA bytes into one gray byte per point is plain code. Pure.

/** Thumbnail size the gate compares (32 x 18 = 576 points, the screen's proportions). */
export const THUMB_WIDTH = 32;
export const THUMB_HEIGHT = 18;

/** One gray byte per point from a BGRA (or RGBA: the weights below treat the first and third channel alike) bitmap. null when the size is wrong. */
export function grayFromBgra(bitmap: Uint8Array, width = THUMB_WIDTH, height = THUMB_HEIGHT): Uint8Array | null {
  if (!(bitmap instanceof Uint8Array) || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || bitmap.length !== width * height * 4) return null;
  const gray = new Uint8Array(width * height);
  for (let index = 0; index < gray.length; index++) {
    const at = index * 4;
    // Integer luma (0.299 R + 0.587 G + 0.114 B); the two outer channels swap places between BGRA and RGBA, a small difference for a change gate.
    gray[index] = (bitmap[at + 2] * 77 + bitmap[at + 1] * 150 + bitmap[at] * 29) >> 8;
  }
  return gray;
}
