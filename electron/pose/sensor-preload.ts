/**
 * Preload of the hidden pose sensor window (dist-electron/pose-sensor-preload.cjs). The page itself is an
 * empty static file with no script; everything happens here: open the camera, downscale to ≤ 320×240,
 * hand RGBA frames to the inference process over the MessagePort, one at a time (next frame only after an ack).
 * Exposes nothing to the page. This is the only place in the app that holds the live camera stream while
 * local pose sensing is on.
 */
import { ipcRenderer } from 'electron';

type Status = 'started' | 'camera-error' | 'camera-ended';
const report = (status: Status) => ipcRenderer.send('pose:sensor-status', status);
const MAX_W = 320, MAX_H = 240;

ipcRenderer.once('pose:port', event => {
  const port = event.ports[0];
  if (!port) return;
  let fps = 1, waiting = false, stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  let stream: MediaStream | null = null;
  const video = document.createElement('video');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const stop = () => {
    stopped = true; clearTimeout(timer);
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    video.pause(); video.srcObject = null;
  };
  window.addEventListener('pagehide', stop);
  port.onmessage = message => {
    const data = message.data as { type?: unknown; fps?: unknown };
    if ((data?.type === 'fps' || data?.type === 'ack') && typeof data.fps === 'number' && Number.isFinite(data.fps)) {
      fps = Math.min(15, Math.max(0, data.fps));
      if (data.type === 'ack') waiting = false;
      if (fps === 0) stop();
    }
  };
  const tick = () => {
    if (stopped) return;
    if (!waiting && fps > 0 && context && video.readyState >= 2 && video.videoWidth && video.videoHeight) {
      const scale = Math.min(1, MAX_W / video.videoWidth, MAX_H / video.videoHeight);
      const width = Math.max(16, Math.round(video.videoWidth * scale)), height = Math.max(16, Math.round(video.videoHeight * scale));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      context.drawImage(video, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      waiting = true;
      // Copied, not transferred: a transferred ArrayBuffer does not survive the hop to the utility process.
      port.postMessage({ type: 'frame', width, height, data: pixels.buffer });
    }
    timer = setTimeout(tick, fps > 0 ? 1000 / fps : 500);
  };
  port.start();
  void (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 30 } } });
      if (stopped) { stream.getTracks().forEach(track => track.stop()); return; }
      for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => { if (!stopped) { stop(); report('camera-ended'); } });
      video.muted = true; video.playsInline = true; video.srcObject = stream;
      await video.play();
      report('started');
      tick();
    } catch {
      stop();
      report('camera-error');
    }
  })();
});
