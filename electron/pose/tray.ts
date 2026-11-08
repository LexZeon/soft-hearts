/**
 * The 24×24 tray bitmap. Off: exactly the original drawn dot. Local pose sensing on: the same dot with a
 * small "eye" in the corner, so the user can always see that the camera is being looked at.
 * I-036: the eye shows while either camera switch is on, 「姿势识别」 (while sensing runs) or 「发图片」.
 */
export const TRAY_SIZE = 24;

export const TRAY_TIPS = {
  off: 'soft hearts · Ctrl+Alt+P 显示/隐藏',
  pose: 'soft hearts · 摄像头感知开启中（画面只在本机处理）',
  images: 'soft hearts · 摄像头发图片开启中（发消息时附一张小图）',
  both: 'soft hearts · 摄像头开启中：发图片 + 姿势识别',
} as const;

/** The eye and tooltip of the tray from the two camera switches; `apply` runs only when either changes. */
export class CameraTrayEye {
  private posed = false;
  private imaged = false;
  private shown: string | null = null;
  constructor(private readonly apply: (eye: boolean, tip: string) => void) {}
  pose(on: boolean): void { this.posed = on; this.sync(); }
  images(on: boolean): void { this.imaged = on; this.sync(); }
  get eye(): boolean { return this.posed || this.imaged; }
  private sync(): void {
    const tip = this.posed && this.imaged ? TRAY_TIPS.both : this.posed ? TRAY_TIPS.pose : this.imaged ? TRAY_TIPS.images : TRAY_TIPS.off;
    if (tip === this.shown) return;
    this.shown = tip;
    this.apply(this.eye, tip);
  }
}

export function trayBitmap(sensing: boolean): Buffer {
  const pixels = Buffer.alloc(TRAY_SIZE * TRAY_SIZE * 4);
  for (let y = 0; y < TRAY_SIZE; y++)
    for (let x = 0; x < TRAY_SIZE; x++) {
      const i = (y * TRAY_SIZE + x) * 4;
      const inside = (x - 12) ** 2 + (y - 12) ** 2 < 100;
      pixels[i] = 230;
      pixels[i + 1] = 170;
      pixels[i + 2] = 138;
      pixels[i + 3] = inside ? 255 : 0;
      if (!sensing) continue;
      const d = Math.hypot(x - 18, y - 18);
      if (d < 5.6) { pixels[i] = pixels[i + 1] = pixels[i + 2] = d < 2.4 ? 36 : 255; pixels[i + 3] = 255; }
    }
  return pixels;
}
