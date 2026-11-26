/**
 * I-086 送你一张图: one frame of her own stage, as she is now (holding the snack out, or with the cushion), rendered locally with a
 * temporary camera (her upper body and what she holds) onto a small warm card. No camera, no screen capture: only her own render,
 * the same way the character page makes her avatar (MmdStage.captureCharacterAvatar). The user's camera, animation and settings
 * are untouched; the next frame renders as before. Returns a PNG data URL, or null when it cannot be made.
 */
import { MathUtils, PerspectiveCamera, Vector3, type Bone, type Object3D, type Scene, type WebGLRenderer } from 'three';

export interface GivePictureInput {
  renderer: WebGLRenderer;
  scene: Scene;
  head: Bone | null;
  /** Her height (world units) and her centre on x. */
  height: number;
  centerX: number;
  /** Hidden for the shot (the control window's grid). */
  hide?: readonly (Object3D | null | undefined)[];
  edge?: number;
  maxChars?: number;
}

export function renderGivePicture(input: GivePictureInput): string | null {
  const { renderer, scene, head } = input;
  const source = renderer.domElement, width = source.width, height = source.height;
  if (!head || !width || !height || typeof document === 'undefined') return null;
  const point = head.getWorldPosition(new Vector3()), H = input.height;
  // Head to below the chest, a little wider than tall, so her hand and what she holds are in it.
  const top = point.y + H * 0.1, bottom = point.y - H * 0.42, span = top - bottom, crop = Math.min(width, height);
  const camera = new PerspectiveCamera(26, width / height, 0.1, Math.max(3000, H * 50));
  const distance = (span * height / crop) / (2 * Math.tan(MathUtils.degToRad(camera.fov / 2)));
  camera.position.set(input.centerX, (top + bottom) / 2, point.z + distance);
  camera.lookAt(input.centerX, (top + bottom) / 2, point.z);
  camera.updateMatrixWorld(true);
  let edge = input.edge ?? 384;
  const hidden = (input.hide ?? []).filter((object): object is Object3D => !!object && object.visible);
  for (let attempt = 0; attempt < 3; attempt++, edge = Math.round(edge * 0.8)) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = edge;
    const context = canvas.getContext('2d');
    if (!context) return null;
    try {
      for (const object of hidden) object.visible = false;
      renderer.render(scene, camera);
      // A warm paper card behind her (the companion window's own background is transparent), a soft vignette, a thin white border.
      const g = context.createLinearGradient(0, 0, 0, edge);
      g.addColorStop(0, '#fbefe2'); g.addColorStop(1, '#f2d9c6');
      context.fillStyle = g; context.fillRect(0, 0, edge, edge);
      context.drawImage(source, (width - crop) / 2, (height - crop) / 2, crop, crop, 0, 0, edge, edge);
      const v = context.createRadialGradient(edge / 2, edge / 2, edge * 0.35, edge / 2, edge / 2, edge * 0.75);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(90,50,30,0.16)');
      context.fillStyle = v; context.fillRect(0, 0, edge, edge);
      context.strokeStyle = '#fffaf3'; context.lineWidth = Math.max(4, edge * 0.025); context.strokeRect(0, 0, edge, edge);
      const png = canvas.toDataURL('image/png');
      if (png.startsWith('data:image/png;base64,') && png.length <= (input.maxChars ?? 520_000)) return png;
    } catch { return null; }
    finally { for (const object of hidden) object.visible = true; canvas.width = canvas.height = 0; }
  }
  return null;
}
