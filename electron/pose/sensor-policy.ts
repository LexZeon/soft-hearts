/** Camera permission rule of the hidden pose sensor window (electron/pose/sensor-window.ts): only camera video, only that window, only while its handle is open. */
export function sensorMediaAllowed(open: boolean, requester: number | undefined, windowId: number | undefined, permission: string, mediaTypes: readonly string[] | undefined): boolean {
  return open && requester !== undefined && requester === windowId && permission === 'media'
    && !!mediaTypes && mediaTypes.length > 0 && mediaTypes.every(type => type === 'video');
}
