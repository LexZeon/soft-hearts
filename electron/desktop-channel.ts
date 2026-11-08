// Fixed local product entry. No renderer authority, script host or process control.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { assertNotCodexProfile, isOwnExecutable } from '../scripts/lib/app-identity.mjs';

export type DesktopChannel = 'stable' | 'development';
export interface InstalledDesktopChannel {
  channel: DesktopChannel;
  workspaceRoot: string;
  versionRoot: string;
  executable: string;
  profile: string;
  versionId: string;
  manifestFile: string;
  manifestSha256: string;
  asarSha256: string;
  exeSha256: string;
  ownerMarker: string;
  maintenanceProfile: string;
}
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (a: string, b: string) => { const rel = path.relative(a.toLowerCase(), b.toLowerCase()); return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
function safeAbsolute(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f"]/.test(value) || /^\\\\[?.]\\/.test(value.replaceAll('/', '\\'))) throw Error('Invalid local desktop path.');
  return path.resolve(value);
}
function noLinks(root: string, file: string): void {
  if (!inside(root, file)) throw Error('Desktop artifact escaped its installation.');
  let current = root;
  for (const component of path.relative(root, file).split(path.sep)) { current = path.join(current, component); if (lstatSync(current).isSymbolicLink()) throw Error('Linked desktop artifacts are unsupported.'); }
  if (!same(realpathSync(file), file)) throw Error('Desktop artifact physical identity changed.');
}
function json(file: string): Record<string, unknown> {
  if (!statSync(file).isFile() || statSync(file).size > 16384) throw Error('Invalid desktop reference size.');
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}
function configuredProfile(workspaceRoot: string, channel: DesktopChannel): string {
  const file = path.join(workspaceRoot, 'release', channel === 'stable' ? 'desktop-profile.json' : 'desktop-development-profile.json');
  noLinks(workspaceRoot, file); const ref = json(file);
  if (ref.version !== 1) throw Error('Invalid desktop profile version.');
  const directory = assertNotCodexProfile(safeAbsolute(ref.directory));
  if (!statSync(directory).isDirectory()) throw Error('Desktop profile directory is unavailable.');
  return assertNotCodexProfile(realpathSync(directory));
}

/** Unmanaged portable launches retain the existing startup path; managed channel launches fail closed. */
export function resolveInstalledDesktopChannel(input: {
  executable: string; packaged: boolean; platform: string; defaultProfile: string;
  requestedChannel?: string; explicitProfile?: string; buildMarker?: string; ownerMarker?: string;
  readRawArchive?: (file: string) => Buffer;
}): InstalledDesktopChannel | null {
  const requested = input.requestedChannel ?? '';
  if (requested && requested !== 'stable' && requested !== 'development') throw Error('Unknown desktop channel.');
  if (input.platform !== 'win32' || !input.packaged) { if (requested) throw Error('Managed desktop channels require their installed Windows product.'); return null; }
  const executable = safeAbsolute(input.executable), bundleRoot = path.dirname(executable), versionRoot = path.dirname(bundleRoot);
  const channelRoot = path.dirname(versionRoot), releaseRoot = path.dirname(channelRoot), workspaceRoot = path.dirname(releaseRoot);
  const channel = path.basename(channelRoot), versionId = path.basename(versionRoot);
  const managed = ['stable', 'development'].includes(channel) && /^[a-f0-9]{64}$/.test(versionId) && path.basename(releaseRoot) === 'release';
  if (!managed) { if (requested) throw Error('The channel launch is outside an immutable installation.'); return null; }
  if (requested && requested !== channel || !isOwnExecutable(executable)) throw Error('Desktop channel or executable mismatch.');
  const arch = /^win-(x64|arm64)-unpacked$/.exec(path.basename(bundleRoot))?.[1];
  if (!arch) throw Error('Unsupported installed desktop architecture.');
  const manifestFile = path.join(versionRoot, `${channel}-manifest.json`);
  noLinks(workspaceRoot, manifestFile); noLinks(workspaceRoot, executable);
  const manifestBytes = readFileSync(manifestFile), manifest = json(manifestFile);
  if (manifest.version !== 1 || manifest.entryKind !== 'native-product-v1' || manifest.channel !== channel
    || manifest.versionId !== versionId || manifest.platform !== 'win32' || manifest.arch !== arch
    || !/^[a-f0-9]{64}$/.test(String(manifest.asarSha256)) || !/^[a-f0-9]{64}$/.test(String(manifest.exeSha256))) throw Error('Invalid immutable native desktop manifest.');
  if (typeof manifest.executable !== 'string' || path.isAbsolute(manifest.executable)
    || !same(path.join(workspaceRoot, manifest.executable), executable)) throw Error('Manifest does not identify this product executable.');
  const asar = path.join(bundleRoot, 'resources', 'app.asar'); noLinks(workspaceRoot, asar);
  if (hash(readFileSync(executable)) !== manifest.exeSha256 || hash((input.readRawArchive ?? readFileSync)(asar)) !== manifest.asarSha256) throw Error('Immutable desktop program bytes changed.');
  const stableProfile = configuredProfile(workspaceRoot, 'stable');
  const profile = channel === 'stable' ? stableProfile : configuredProfile(workspaceRoot, 'development');
  if (channel === 'development' && (same(profile, stableProfile) || inside(profile, stableProfile) || inside(stableProfile, profile))) throw Error('Development and stable profiles overlap.');
  if (input.explicitProfile && !same(realpathSync(safeAbsolute(input.explicitProfile)), profile)) throw Error('The supplied profile conflicts with this installed channel.');
  const ownerMarker = hash(workspaceRoot.toLowerCase() + '\n' + channel + '\n' + profile.toLowerCase()).slice(0, 24);
  if (input.buildMarker && input.buildMarker.toLowerCase() !== manifest.asarSha256
    || input.ownerMarker && input.ownerMarker.toLowerCase() !== ownerMarker) throw Error('Desktop launch marker mismatch.');
  return { channel: channel as DesktopChannel, workspaceRoot, versionRoot, executable, profile, versionId, manifestFile,
    manifestSha256: hash(manifestBytes), asarSha256: manifest.asarSha256 as string, exeSha256: manifest.exeSha256 as string,
    ownerMarker, maintenanceProfile: path.join(workspaceRoot, '.local', 'desktop-entry-maintenance', versionId) };
}
