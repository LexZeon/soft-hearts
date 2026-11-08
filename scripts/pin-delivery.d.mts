export interface DeliveredManifest {
  version: 1;
  entryKind: 'native-product-v1';
  channel: 'stable' | 'development';
  versionId: string;
  executable: string;
  exeSha256: string;
  asarSha256: string;
  buildId: string;
  validationSourceHash: string;
  validationInputCount: number;
  bundleSha256: string;
  platform: 'win32';
  arch: 'x64' | 'arm64';
  installedAt: string;
  validatedAt: string;
}
export interface StagedDelivery {
  channel: 'stable' | 'development';
  manifest: DeliveredManifest;
  target: string;
  manifestFile: string;
  manifestSha256: string;
  history: null | { directory: string; members: { name: string; sha256: string }[]; previous: Record<string, unknown> };
  stableShortcutPath: string | null;
  stableProfile: string | null;
  stableProfileReferenceSha256: string | null;
  ownerMarker: string | null;
  pointerUpdated: boolean;
  shortcutUpdated: boolean;
  runningVersionChanged: false;
}
export interface DesktopShortcutReceipt {
  kind: string;
  channel: string;
  manifestSha256: string;
  executable: string;
  shortcutPath: string;
  shortcutSha256: string;
  targetPath: string;
  arguments: string;
  previous?: { sha256: string; bytesBase64: string } | null;
}
/** @deprecated name kept for older callers; the receipt now covers both channels. */
export type StableShortcutReceipt = DesktopShortcutReceipt;
export type StableHistory = NonNullable<StagedDelivery['history']>;
export function bundleSnapshot(root: string, bundle: string): Promise<[string, string][]>;
export function pinDelivery(workspaceRoot: string, candidatePath: string, options?: {
  channel?: string; stableShortcutPath?: string; deferHistory?: boolean;
}): Promise<StagedDelivery>;
export function archiveStableHistory(workspaceRoot: string, options?: { previousShortcut?: Buffer | null }): Promise<StableHistory | null>;
export function commitDeliveryPointer(workspaceRoot: string, staged: StagedDelivery, options?: { shortcutReceipt?: DesktopShortcutReceipt }): Promise<StagedDelivery>;
