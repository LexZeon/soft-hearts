/**
 * The hidden pose sensor window: its own in-memory session partition (separate from the pet and control
 * windows), sandboxed, no Node, a static empty page, a preload that only captures frames. Camera permission
 * is granted to this one window and only while its handle is open; everything else is denied.
 */
import { BrowserWindow, ipcMain, session, type IpcMainEvent, type MessagePortMain } from 'electron';
import path from 'node:path';
import { POSE_BUNDLE } from './bundle-files';
import { sensorMediaAllowed } from './sensor-policy';
import type { SensorHandle, SensorStatus } from './supervisor';

export const POSE_SENSOR_PARTITION = 'soft-hearts-pose-sensor';
const STATUSES = new Set(['started', 'camera-error', 'camera-ended']);

export function openSensorWindow(port: MessagePortMain, status: (status: SensorStatus) => void, directory = __dirname): SensorHandle {
  const ses = session.fromPartition(POSE_SENSOR_PARTITION, { cache: false });
  let open = true;
  const win = new BrowserWindow({
    show: false, width: 64, height: 48, frame: false, skipTaskbar: true, focusable: false, resizable: false,
    title: 'soft hearts · pose sensor', paintWhenInitiallyHidden: false,
    webPreferences: { session: ses, preload: path.join(directory, POSE_BUNDLE.sensorPreload), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, spellcheck: false, devTools: false,
      // Timers must keep running while the window is hidden, or capture drops to one frame per second.
      backgroundThrottling: false },
  });
  const id = win.webContents.id;
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const types = 'mediaTypes' in details ? details.mediaTypes as string[] | undefined : undefined;
    callback(sensorMediaAllowed(open, contents?.id, id, permission, types));
  });
  ses.setPermissionCheckHandler((contents, permission, _origin, details) =>
    sensorMediaAllowed(open, contents?.id ?? undefined, id, permission, details.mediaType ? [details.mediaType] : undefined));
  ses.setDevicePermissionHandler(() => false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-redirect', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  const onStatus = (event: IpcMainEvent, value: unknown) => {
    if (open && event.sender.id === id && typeof value === 'string' && STATUSES.has(value)) status(value as SensorStatus);
  };
  ipcMain.on('pose:sensor-status', onStatus);
  const gone = () => { if (open) { close(); status('gone'); } };
  win.webContents.on('render-process-gone', gone);
  win.webContents.once('did-finish-load', () => { if (open && !win.isDestroyed()) win.webContents.postMessage('pose:port', null, [port]); });
  win.on('closed', () => { if (open) { open = false; ipcMain.removeListener('pose:sensor-status', onStatus); } });
  const close = () => {
    if (!open) return;
    open = false;
    ipcMain.removeListener('pose:sensor-status', onStatus);
    try { port.close(); } catch { /* already closed */ }
    if (!win.isDestroyed()) win.destroy(); // destroys the renderer: the camera track stops with it
  };
  void win.loadFile(path.join(directory, POSE_BUNDLE.sensorPage)).catch(gone);
  return { close };
}
