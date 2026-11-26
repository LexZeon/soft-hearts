/**
 * "Recall by meaning" as the control window sees it (electron/memory/memory-semantic/host.ts): switch, phase, sizes, progress and fixed
 * notices only, never a path or a memory. The switch is off by default; nothing is downloaded or computed while it is off.
 */
export const SEMANTIC_PHASES = [
  /** No component package for this computer (not Windows ARM64/x64). */
  'unsupported',
  'not-installed', 'downloading', 'installing',
  /** Installed; the embedding process is not running. */
  'idle', 'starting', 'ready',
] as const;
export type SemanticPhase = typeof SEMANTIC_PHASES[number];
export const SEMANTIC_NOTICES = ['', 'download-failed', 'verify-failed', 'canceled', 'failed', 'removed'] as const;
export type SemanticNotice = typeof SEMANTIC_NOTICES[number];

export interface SemanticRecallView {
  enabled: boolean;
  phase: SemanticPhase;
  /** Bytes the one-time download fetches (without the runtime when it can be copied from pose sensing or speech recognition). */
  downloadBytes: number;
  installedBytes: number;
  /** 0..1 while downloading / installing, otherwise null. */
  progress: number | null;
  notice: SemanticNotice;
  /** Memories of the current character whose meaning is computed, and how many there are to compute. */
  indexed: number;
  total: number;
}

const member = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

export function sameSemanticView(a: SemanticRecallView, b: SemanticRecallView): boolean {
  return a.enabled === b.enabled && a.phase === b.phase && a.downloadBytes === b.downloadBytes && a.installedBytes === b.installedBytes
    && a.progress === b.progress && a.notice === b.notice && a.indexed === b.indexed && a.total === b.total;
}

/** Renderer-side guard for the broadcast (the preload hands it through unchanged). */
export function parseSemanticView(value: unknown): SemanticRecallView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n < 2 ** 40;
  if (typeof v.enabled !== 'boolean' || !member(SEMANTIC_PHASES, v.phase) || !count(v.downloadBytes) || !count(v.installedBytes) || !member(SEMANTIC_NOTICES, v.notice)) return null;
  if (v.progress !== null && (typeof v.progress !== 'number' || !(v.progress >= 0 && v.progress <= 1))) return null;
  if (!count(v.indexed) || !count(v.total)) return null;
  return { enabled: v.enabled, phase: v.phase, downloadBytes: v.downloadBytes as number, installedBytes: v.installedBytes as number,
    progress: v.progress as number | null, notice: v.notice, indexed: v.indexed as number, total: v.total as number };
}
