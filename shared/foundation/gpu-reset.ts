// 显卡重置后她自己回来 (docs/claude/2026-11-22-gpu-reset.md): the closed words a GPU process journal row may hold. Shared by the host's
// watch (electron/foundation/gpu-reset/plan.ts) and the journal's builder (shared/stage/journal-entries.ts 'gpu-reset').

/** Electron's `child-process-gone` reasons (Electron 45), plus 'unknown' for anything else. */
export const GPU_PROCESS_ENDS = ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction', 'unknown'] as const;
export type GpuProcessEnd = (typeof GPU_PROCESS_ENDS)[number];

/** 'gone': the GPU process went away (Chromium started a new one); 'software': WebGL is off for the rest of the run (software compositing). */
export const GPU_RESET_EVENTS = ['gone', 'software'] as const;
export type GpuResetEvent = (typeof GPU_RESET_EVENTS)[number];
