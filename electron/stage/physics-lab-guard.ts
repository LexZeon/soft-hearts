/**
 * R01 物理调参台: the lab's two gates, apart from Electron so a test can break them (scripts/dev/mutations/stage.json).
 * - It opens, and a tuning is saved, only in developer mode.
 * - A lab request is answered only from the lab window's own main frame.
 */
export function labAllowed(developerMode: boolean): void {
  if (developerMode !== true) throw new Error('物理调参台只在开发者模式里可用。');
}

export interface LabSender { readonly id: number; readonly mainFrame: unknown }

export function labSenderAllowed(window: { isDestroyed(): boolean; webContents: LabSender } | null, sender: LabSender, senderFrame: unknown): boolean {
  return !!window && !window.isDestroyed() && sender === window.webContents && senderFrame === window.webContents.mainFrame;
}
