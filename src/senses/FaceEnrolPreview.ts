// 认出是不是你（Beta）: the live picture shown while the user enrols their face. It shows the camera's picture the host sends to this window only while enrolling, a frame around the found
// face, one line of advice about the current frame (too dark, too small, ...) and how many of the sets are taken. Nothing is stored here;
// the picture is a data URL put into one <img> and is dropped when enrolment ends. Everything shown is fixed copy chosen by closed words.
import { uiText, uiTemplate } from '../foundation/ui-language';
import { registerUiMessages } from '../../shared/foundation/ui-language';
import type { FaceEnrolHint, FaceEnrolPreview } from '../../shared/senses/face-check';

registerUiMessages({ 'zh-CN': {}, en: {
  '正在打开摄像头画面…': 'Opening the camera picture…', '没找到脸：请正对摄像头。': 'No face found: please face the camera.', '离得太远了，靠近一点。': 'Too far away: move a little closer.',
  '太暗了，找个亮一点的地方。': 'Too dark: find somewhere brighter.', '太亮了，避开强光。': 'Too bright: avoid the glare.', '请正对摄像头，不要侧着或低着头。': 'Please face the camera straight on, not turned or looking down.',
  '画面有点糊，稳一下。': 'A little blurry: hold still.', '这一帧很好，保持不动。': 'This frame is good: hold still.', '已采 {0} / {1} 组': '{0} of {1} sets taken',
  '这是你电脑上的摄像头画面，只在这里显示，不保存，也不会发给任何人。': 'This is your camera on this computer. It shows only here, is not saved and is not sent to anyone.',
} });

const HINT: Record<FaceEnrolHint, string> = {
  starting: '正在打开摄像头画面…', 'no-face': '没找到脸：请正对摄像头。', 'too-small': '离得太远了，靠近一点。', 'too-dark': '太暗了，找个亮一点的地方。',
  'too-bright': '太亮了，避开强光。', 'off-angle': '请正对摄像头，不要侧着或低着头。', blurry: '画面有点糊，稳一下。', good: '这一帧很好，保持不动。',
};

export function enrolHintText(hint: FaceEnrolHint): string { return uiText(HINT[hint]); }
export function enrolCountText(taken: number, total: number): string { return uiTemplate`已采 ${taken} / ${total} 组`; }

export class FaceEnrolPreviewView {
  readonly element = document.createElement('div');
  private readonly frame = document.createElement('div');
  private readonly image = document.createElement('img');
  private readonly box = document.createElement('div');
  private readonly hint = document.createElement('p');
  private readonly count = document.createElement('p');
  private readonly note = document.createElement('small');

  constructor() {
    this.element.className = 'face-enrol-preview';
    this.element.hidden = true;
    this.frame.style.cssText = 'position:relative;display:inline-block;max-width:240px;line-height:0;border-radius:8px;overflow:hidden;background:#000';
    this.image.alt = '';
    this.image.style.cssText = 'display:block;width:100%;height:auto;transform:scaleX(-1)'; // like a mirror: moving right looks like moving right
    this.box.style.cssText = 'position:absolute;border:2px solid #4ade80;border-radius:6px;box-sizing:border-box;pointer-events:none';
    this.box.hidden = true;
    this.hint.className = 'hint'; this.count.className = 'hint'; this.note.className = 'hint';
    this.note.textContent = uiText('这是你电脑上的摄像头画面，只在这里显示，不保存，也不会发给任何人。');
    this.frame.append(this.image, this.box);
    this.element.append(this.frame, this.hint, this.count, this.note);
  }

  /** null closes it and drops the picture. */
  render(preview: FaceEnrolPreview | null): void {
    if (!preview) { this.element.hidden = true; this.image.removeAttribute('src'); this.box.hidden = true; return; }
    this.element.hidden = false;
    if (preview.image) this.image.src = preview.image;
    this.frame.hidden = !preview.image;
    if (preview.box && preview.image) {
      const [x, y, w, h] = preview.box;
      // The picture is mirrored, so the box is mirrored too.
      this.box.style.left = `${(1 - x - w) * 100}%`; this.box.style.top = `${y * 100}%`; this.box.style.width = `${w * 100}%`; this.box.style.height = `${h * 100}%`;
      this.box.style.borderColor = preview.hint === 'good' ? '#4ade80' : '#facc15';
      this.box.hidden = false;
    } else this.box.hidden = true;
    this.hint.textContent = enrolHintText(preview.hint);
    this.count.textContent = enrolCountText(preview.taken, preview.total);
  }
}
