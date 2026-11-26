/**
 * I-190: which camera this window opens. The user's camera list (the toolbar's camera panel, the Unbound input box's panel) is read through
 * a chooser the wiring sets (src/wiring/sources-wiring.ts → shared/senses/device-sources.ts cameraDeviceId); without one, or with nothing
 * chosen and plugged in, the system default, exactly as before. A chosen camera that will not open falls back to the default.
 * It picks WHICH camera only: it never opens one by itself (the callers are 「发图片」's stream and 「拍一张给她看」, each behind its own switch).
 */
let chooser: (() => Promise<string | null>) | null = null;

export function setCameraChooser(next: (() => Promise<string | null>) | null): void { chooser = next; }

export async function chosenCamera(): Promise<string | null> {
  try { return chooser ? await chooser() : null; } catch { return null; }
}

/**
 * One getUserMedia for video only, from the chosen camera when there is one (then the default). Without a chooser it is exactly the old
 * call (same promise, no extra steps: a caller that stops a late stream sees it as early as before).
 */
export function openCamera(video: MediaTrackConstraints): Promise<MediaStream> {
  const plain = () => navigator.mediaDevices.getUserMedia({ video, audio: false });
  if (!chooser) return plain();
  return chosenCamera().then(deviceId => deviceId
    ? navigator.mediaDevices.getUserMedia({ video: { ...video, deviceId: { exact: deviceId } }, audio: false }).catch(plain) // unplugged since: the default
    : plain());
}
