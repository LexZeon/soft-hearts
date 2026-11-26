/**
 * I-154 batch 7, row 44 头像、贴纸截图 on the window engine: the old stage's two control-window pictures (src/stage/mmd/camera.ts), the same
 * renders on this engine's renderer, scene and camera (the same surface as 送你一张图, give-picture.ts). Controls only; one extra render;
 * the user's camera, her motion and the settings are untouched; the grid is hidden for the shot; the next frame renders as before.
 *  - captureCharacterAvatar: a small half-body square of her as she stands in the preview now (C2 角色页), a temporary camera from a little
 *    above her head to about the chest, centred;
 *  - captureCharacterStickerReference: the preview canvas as it is (at most 1024 px), for the sticker reference.
 * The PNGs stay on this computer (the host stores them, electron/cards/). Refused while the preview is not ready: no model, a model change
 * on the way, not rendered yet, hidden, the camera being adjusted, or (the avatar) still fading in.
 */
import { MathUtils, PerspectiveCamera, Vector3, type Bone, type Camera, type Object3D, type Scene, type WebGLRenderer } from 'three';
import type { StickerCapture } from '../../../shared/cards';

export interface WindowCaptureParts {
  renderer: WebGLRenderer; scene: Scene; camera: Camera; head: Bone | null;
  /** Her height (model units, as shown) and her centre on x. */
  height: number; centerX: number;
  /** Hidden for the shot (the control window's grid). */
  hide: readonly (Object3D | null | undefined)[];
}

function withHidden<T>(parts: WindowCaptureParts, run: () => T): T {
  const hidden = parts.hide.filter((object): object is Object3D => !!object && object.visible);
  try { for (const object of hidden) object.visible = false; return run(); }
  finally { for (const object of hidden) object.visible = true; parts.renderer.render(parts.scene, parts.camera); }
}

/** C2: the half-body square (`side` px); `still()` false after the render: the model changed meanwhile (throws). */
export function renderAvatar(parts: WindowCaptureParts, side: number, still: () => boolean, messages: { size: string; context: string; changed: string }): string {
  const input = parts.renderer.domElement, width = input.width, height = input.height;
  if (!width || !height || !parts.head) throw Error(messages.size);
  const head = parts.head.getWorldPosition(new Vector3());
  // Half body: from a little above the head to about the chest, centred; square crop of the canvas (the old stage's numbers).
  const top = head.y + parts.height * 0.09, bottom = head.y - parts.height * 0.3, span = top - bottom, crop = Math.min(width, height);
  const camera = new PerspectiveCamera(26, width / height, 0.1, Math.max(3000, parts.height * 50));
  const visible = span * height / crop, distance = visible / (2 * Math.tan(MathUtils.degToRad(camera.fov / 2)));
  camera.position.set(parts.centerX, (top + bottom) / 2, head.z + distance);
  camera.lookAt(parts.centerX, (top + bottom) / 2, head.z);
  camera.updateMatrixWorld(true);
  const image = document.createElement('canvas'); image.width = image.height = side;
  const context = image.getContext('2d'); if (!context) throw Error(messages.context);
  try {
    return withHidden(parts, () => {
      parts.renderer.render(parts.scene, camera);
      context.drawImage(input, (width - crop) / 2, (height - crop) / 2, crop, crop, 0, 0, side, side);
      const png = image.toDataURL('image/png');
      if (!still()) throw Error(messages.changed);
      return png;
    });
  } finally { image.width = image.height = 0; }
}

/** The sticker reference: the preview canvas as it is now, scaled to at most 1024 px. */
export function renderStickerReference(parts: WindowCaptureParts, modelUrl: string, loadGeneration: number, still: () => boolean,
  messages: { size: string; context: string; changed: string }): StickerCapture {
  const input = parts.renderer.domElement;
  if (!input.width || !input.height) throw Error(messages.size);
  const image = document.createElement('canvas'), scale = Math.min(1, 1024 / input.width, 1024 / input.height);
  image.width = Math.max(1, Math.floor(input.width * scale)); image.height = Math.max(1, Math.floor(input.height * scale));
  const context = image.getContext('2d'); if (!context) throw Error(messages.context);
  try {
    return withHidden(parts, () => {
      parts.renderer.render(parts.scene, parts.camera);
      context.drawImage(input, 0, 0, image.width, image.height);
      const png = image.toDataURL('image/png');
      if (!still()) throw Error(messages.changed);
      return { png, modelUrl, loadGeneration } as StickerCapture;
    });
  } finally { image.width = image.height = 0; }
}
