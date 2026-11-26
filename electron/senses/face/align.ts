/**
 * I-135: align a detected face to SFace's 112×112 input using YuNet's five landmarks. Pure math (no ONNX, no Electron).
 *
 * Same recipe as OpenCV's FaceRecognizerSF::alignCrop: a similarity transform (rotation + uniform scale + shift, no
 * reflection) fitted by least squares from the five landmarks to SFace's reference points, then an affine warp with
 * bilinear sampling and black outside the frame. Pixel coordinates use the OpenCV convention (integer = pixel centre).
 */

export interface Point { x: number; y: number }
/** YuNet order: the person's right eye, left eye, nose tip, right mouth corner, left mouth corner (image left first). */
export type Landmarks5 = readonly [Point, Point, Point, Point, Point];

/** SFace's reference landmark positions in the 112×112 crop (opencv/modules/objdetect/src/face_recognize.cpp). */
export const SFACE_REFERENCE: Landmarks5 = Object.freeze([
  { x: 38.2946, y: 51.6963 }, { x: 73.5318, y: 51.5014 }, { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 }, { x: 70.7299, y: 92.2041 },
]) as unknown as Landmarks5;
export const SFACE_SIZE = 112;

/** x' = a·x − b·y + tx ; y' = b·x + a·y + ty */
export interface Similarity { a: number; b: number; tx: number; ty: number }

/** Least-squares similarity transform taking `src` onto `dst` (both the same length ≥ 2). */
export function fitSimilarity(src: readonly Point[], dst: readonly Point[]): Similarity {
  if (src.length !== dst.length || src.length < 2) throw new Error('need matching point lists');
  const n = src.length;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { sx += src[i].x; sy += src[i].y; dx += dst[i].x; dy += dst[i].y; }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let norm = 0, dotSum = 0, crossSum = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i].x - sx, py = src[i].y - sy, qx = dst[i].x - dx, qy = dst[i].y - dy;
    norm += px * px + py * py;
    dotSum += px * qx + py * qy;
    crossSum += px * qy - py * qx;
  }
  if (!(norm > 1e-9)) throw new Error('degenerate landmarks');
  const a = dotSum / norm, b = crossSum / norm;
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
}

export function applySimilarity(t: Similarity, p: Point): Point {
  return { x: t.a * p.x - t.b * p.y + t.tx, y: t.b * p.x + t.a * p.y + t.ty };
}

export function invertSimilarity(t: Similarity): Similarity {
  const det = t.a * t.a + t.b * t.b;
  if (!(det > 1e-12)) throw new Error('singular transform');
  const a = t.a / det, b = -t.b / det;
  // inverse of x' = M x + t  is  x = M⁻¹ x' − M⁻¹ t
  return { a, b, tx: -(a * t.tx - b * t.ty), ty: -(b * t.tx + a * t.ty) };
}

export interface AlignedFace {
  /** 3×112×112 planar RGB, 0..255 (what SFace expects: OpenCV feeds it with swapRB from BGR, no scaling). */
  rgb: Float32Array;
  /** 112×112 grey, 0..255 (for sharpness and brightness). */
  grey: Float32Array;
}

/** Warp an RGBA frame (canvas order) to SFace's aligned crop. */
export function alignFace(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, landmarks: Landmarks5): AlignedFace {
  const toCrop = fitSimilarity(landmarks, SFACE_REFERENCE);
  const back = invertSimilarity(toCrop);
  const size = SFACE_SIZE, plane = size * size;
  const rgb = new Float32Array(3 * plane), grey = new Float32Array(plane);
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      const x = back.a * u - back.b * v + back.tx, y = back.b * u + back.a * v + back.ty;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      let r = 0, g = 0, bl = 0;
      for (let k = 0; k < 4; k++) {
        const xi = x0 + (k & 1), yi = y0 + (k >> 1);
        if (xi < 0 || yi < 0 || xi >= width || yi >= height) continue; // black border, like warpAffine's default
        const w = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy);
        const at = (yi * width + xi) * 4;
        r += rgba[at] * w; g += rgba[at + 1] * w; bl += rgba[at + 2] * w;
      }
      const index = v * size + u;
      rgb[index] = r; rgb[plane + index] = g; rgb[2 * plane + index] = bl;
      grey[index] = 0.299 * r + 0.587 * g + 0.114 * bl;
    }
  }
  return { rgb, grey };
}
