/**
 * Test helper: programmatically drawn "faces" (flat shapes) as RGBA frames, for running the real YuNet and SFace models without a camera or
 * a real person. They are cartoons: the detector may or may not accept them, and SFace's numbers for them say nothing about real faces. They
 * are there to show that the pipeline (colour order, alignment, scale) gives different faces different numbers and the same face the same.
 */
export interface DrawnFace {
  skin: [number, number, number];
  hair: [number, number, number];
  eye: [number, number, number];
  lips: [number, number, number];
  /** Eye spacing, nose length and mouth width as fractions of the face width. */
  eyeGap: number; noseLength: number; mouthWidth: number; browThick: number; faceAspect: number; hairLine: number;
}

export const FACE_A: DrawnFace = { skin: [236, 190, 160], hair: [40, 28, 20], eye: [30, 30, 40], lips: [190, 80, 80], eyeGap: 0.42, noseLength: 0.2, mouthWidth: 0.3, browThick: 3, faceAspect: 1.25, hairLine: 0.28 };
export const FACE_B: DrawnFace = { skin: [120, 80, 58], hair: [200, 170, 90], eye: [60, 100, 160], lips: [110, 50, 50], eyeGap: 0.3, noseLength: 0.32, mouthWidth: 0.5, browThick: 7, faceAspect: 0.95, hairLine: 0.1 };

export function drawFace(face: DrawnFace, width = 320, height = 240, noise = 0, seed = 1): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  let s = seed >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const set = (x: number, y: number, color: readonly number[]) => { if (x < 0 || y < 0 || x >= width || y >= height) return; const at = (y * width + x) * 4; rgba[at] = color[0]; rgba[at + 1] = color[1]; rgba[at + 2] = color[2]; rgba[at + 3] = 255; };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) set(x, y, [205, 215, 225]); // a plain wall
  const cx = width / 2, cy = height / 2, fw = height * 0.34, fh = fw * face.faceAspect;
  const ellipse = (ox: number, oy: number, rx: number, ry: number, color: readonly number[]) => {
    for (let y = Math.floor(oy - ry); y <= oy + ry; y++) for (let x = Math.floor(ox - rx); x <= ox + rx; x++) if (((x - ox) / rx) ** 2 + ((y - oy) / ry) ** 2 <= 1) set(x, y, color);
  };
  const rect = (x0: number, y0: number, x1: number, y1: number, color: readonly number[]) => { for (let y = Math.floor(y0); y <= y1; y++) for (let x = Math.floor(x0); x <= x1; x++) set(x, y, color); };
  ellipse(cx, cy - fh * 0.12, fw * 1.12, fh * 1.12, face.hair);
  ellipse(cx, cy, fw, fh, face.skin);
  rect(cx - fw, cy - fh, cx + fw, cy - fh * (1 - face.hairLine * 2) , face.hair);
  const eyeY = cy - fh * 0.12, gap = fw * face.eyeGap * 2;
  for (const side of [-1, 1]) {
    ellipse(cx + side * gap / 2, eyeY, fw * 0.17, fw * 0.09, [250, 250, 250]);
    ellipse(cx + side * gap / 2, eyeY, fw * 0.08, fw * 0.08, face.eye);
    rect(cx + side * gap / 2 - fw * 0.2, eyeY - fw * 0.22, cx + side * gap / 2 + fw * 0.2, eyeY - fw * 0.22 + face.browThick, face.hair);
  }
  rect(cx - 2, eyeY, cx + 2, eyeY + fh * face.noseLength, [face.skin[0] - 40, face.skin[1] - 40, face.skin[2] - 30]);
  ellipse(cx, eyeY + fh * face.noseLength + 3, fw * 0.12, fw * 0.06, [face.skin[0] - 55, face.skin[1] - 55, face.skin[2] - 45]);
  ellipse(cx, cy + fh * 0.52, fw * face.mouthWidth, fw * 0.08, face.lips);
  if (noise) for (let i = 0; i < rgba.length; i += 4) { const n = (rand() - 0.5) * noise; rgba[i] = Math.max(0, Math.min(255, rgba[i] + n)); rgba[i + 1] = Math.max(0, Math.min(255, rgba[i + 1] + n)); rgba[i + 2] = Math.max(0, Math.min(255, rgba[i + 2] + n)); }
  return rgba;
}

/** Where drawFace put the five landmarks (the person's right eye, left eye, nose tip, right and left mouth corner), in pixels. */
export function drawnLandmarks(face: DrawnFace, width = 320, height = 240): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] {
  const cx = width / 2, cy = height / 2, fw = height * 0.34, fh = fw * face.faceAspect;
  const eyeY = cy - fh * 0.12, gap = fw * face.eyeGap * 2, mouthY = cy + fh * 0.52;
  return [{ x: cx - gap / 2, y: eyeY }, { x: cx + gap / 2, y: eyeY }, { x: cx, y: eyeY + fh * face.noseLength + 3 }, { x: cx - fw * face.mouthWidth, y: mouthY }, { x: cx + fw * face.mouthWidth, y: mouthY }];
}
