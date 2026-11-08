/**
 * The local speech recognizer as the control window sees it (electron/asr/host.ts): phases, sizes, progress and fixed
 * notices only — never a path, a transcript or audio. Downloaded only after
 * the user clicks「下载」, free, the voice never leaves the computer.
 */
export const LOCAL_ASR_PHASES = [
  /** No component package for this computer (not Windows ARM64/x64). */
  'unsupported',
  'not-installed', 'downloading', 'installing',
  /** Installed; the recognition process is not running (voice input off). */
  'idle',
  /** The recognition process is loading the model. */
  'starting',
  /** Loaded and listening for requests. */
  'ready',
] as const;
export type LocalAsrPhase = typeof LOCAL_ASR_PHASES[number];
export const LOCAL_ASR_NOTICES = ['', 'download-failed', 'verify-failed', 'import-incomplete', 'import-done', 'removed', 'canceled', 'failed'] as const;
export type LocalAsrNotice = typeof LOCAL_ASR_NOTICES[number];

export interface LocalAsrView {
  phase: LocalAsrPhase;
  /** True after the user tried to turn voice input on while the component is missing: show the one-line question. */
  prompt: boolean;
  /** Bytes the first download fetches (without the runtime when it can be copied from pose sensing). */
  downloadBytes: number;
  installedBytes: number;
  /** 0..1 while downloading / installing, otherwise null. */
  progress: number | null;
  componentVersion: number;
  notice: LocalAsrNotice;
  /** The small runtime pack could not be fetched; the official sources are used (downloadBytes is their total). */
  fallback?: boolean;
  /** Refused voice-input requests so far (absent = none): each new one brings the question into view again. */
  asked?: number;
}

const member = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

export function sameLocalAsrView(a: LocalAsrView, b: LocalAsrView): boolean {
  return a.phase === b.phase && a.prompt === b.prompt && a.downloadBytes === b.downloadBytes && a.installedBytes === b.installedBytes
    && a.progress === b.progress && a.componentVersion === b.componentVersion && a.notice === b.notice && !!a.fallback === !!b.fallback
    && (a.asked ?? 0) === (b.asked ?? 0);
}

/** Renderer-side guard for the broadcast (the preload hands it through unchanged). */
export function parseLocalAsrView(value: unknown): LocalAsrView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const bytes = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n < 2 ** 40;
  if (!member(LOCAL_ASR_PHASES, v.phase) || typeof v.prompt !== 'boolean' || !bytes(v.downloadBytes) || !bytes(v.installedBytes)) return null;
  if (v.progress !== null && (typeof v.progress !== 'number' || !(v.progress >= 0 && v.progress <= 1))) return null;
  if (!bytes(v.componentVersion) || !member(LOCAL_ASR_NOTICES, v.notice)) return null;
  if (v.fallback !== undefined && typeof v.fallback !== 'boolean') return null;
  if (v.asked !== undefined && !(bytes(v.asked) && (v.asked as number) > 0)) return null;
  return { phase: v.phase, prompt: v.prompt, downloadBytes: v.downloadBytes as number, installedBytes: v.installedBytes as number,
    progress: v.progress as number | null, componentVersion: v.componentVersion as number, notice: v.notice,
    ...(v.fallback ? { fallback: true } : {}), ...(v.asked ? { asked: v.asked as number } : {}) };
}
