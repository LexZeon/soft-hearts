/** Control-window IPC for local pose sensing (registered through main.ts's own `host()`, which checks the sender). */
import type { PoseSensingHost } from './host';

type HostRegistrar = (method: string, operation: (...args: any[]) => unknown, controlOnly?: boolean) => void;

/** Control-window IPC. Every reply is the fixed-shape view (enums and numbers only); no path ever leaves the host. */
export function registerPoseControls(host: HostRegistrar, pose: () => PoseSensingHost | null, chooseFiles: () => Promise<string[]>): void {
  const required = () => { const value = pose(); if (!value) throw new Error('本地姿态感知尚未就绪。'); return value; };
  host('getPoseSensing', () => required().view(), false);
  host('downloadPoseComponents', () => required().download());
  host('cancelPoseDownload', () => { required().cancelDownload(); });
  host('dismissPosePrompt', () => required().dismissPrompt(), false);
  host('importPoseComponents', async () => {
    const files = await chooseFiles();
    const { result: _result, ...view } = await required().importFiles(files);
    return view;
  });
  host('removePoseComponents', () => required().remove());
  host('redetectPoseHardware', () => required().redetect());
  host('getPoseDiagnostics', () => required().diagnostics());
}
