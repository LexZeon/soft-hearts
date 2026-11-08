import type { Attachment } from "../../shared/contracts";

/** Capture one frame and release the device, including tracks returned after cancellation. */
export async function cameraSnapshot(
  signal?: AbortSignal,
): Promise<Attachment> {
  const canceled = () => new DOMException("拍摄已取消", "AbortError");
  const check = () => {
    if (signal?.aborted) throw canceled();
  };
  check();
  let stream: MediaStream | undefined;
  let video: HTMLVideoElement | undefined;
  let frameId: number | undefined;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let permissionRequested = false;
  let rejectAbort!: (reason: Error) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const stop = (media = stream) =>
    media?.getTracks().forEach((track) => track.stop());
  const abort = () => {
    stop();
    rejectAbort(canceled());
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    check();
    permissionRequested = true;
    await Promise.race([
      window.desktop.setCameraPermission(true),
      abortPromise,
    ]);
    check();
    const media = navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    // getUserMedia cannot be canceled. Its eventual result must not reopen observation.
    void media.then(
      (lateStream) => {
        if (finished || signal?.aborted) stop(lateStream);
      },
      () => {},
    );
    stream = await Promise.race([media, abortPromise]);
    check();
    video = document.createElement("video");
    video.muted = true;
    video.srcObject = stream;
    await Promise.race([video.play(), abortPromise]);
    check();
    const frame = new Promise<void>((resolve, reject) => {
      frameTimer = setTimeout(
        () => reject(new Error("摄像头未返回画面")),
        7000,
      );
      frameId = video!.requestVideoFrameCallback(() => resolve());
    });
    await Promise.race([frame, abortPromise]);
    check();
    if (!video.videoWidth || !video.videoHeight)
      throw new Error("摄像头未返回有效画面");
    const canvas = document.createElement("canvas");
    const scale = Math.min(
      1,
      1280 / video.videoWidth,
      1280 / video.videoHeight,
    );
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建摄像头快照");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return { source: "camera", dataUrl: canvas.toDataURL("image/jpeg", 0.8) };
  } finally {
    finished = true;
    signal?.removeEventListener("abort", abort);
    clearTimeout(frameTimer);
    if (video) {
      if (frameId !== undefined) video.cancelVideoFrameCallback(frameId);
      video.pause();
      video.srcObject = null;
    }
    stop();
    if (permissionRequested) await window.desktop.setCameraPermission(false);
  }
}
