/**
 * Electron glue for I-135 认出"不是你": the real utilityProcess, `net.fetch` for the download the user asked for by turning the
 * switch on, `safeStorage` for the embeddings, `nativeImage` to decode a camera picture, and the control-window IPC.
 * main.ts only creates this, forwards the camera / presence / typing hooks and registers the IPC; the chat wiring (the
 * stranger line in her private context, the photo check before a camera picture is sent) is the lead's, via the host's API.
 */
import { nativeImage, net, utilityProcess } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { FACE_ENROL_IMAGE_MAX, type FaceCheckCounts, type FaceCheckView, type FaceEnrolPreview } from '../../../shared/senses/face-check';
import { ASR_COMPONENT_VERSION } from '../../foundation/asr-manifest';
import { PoseComponentStore, defaultComponentRoot, type FetchLike } from '../pose/component-store';
import { POSE_COMPONENT_VERSION, posePlatform } from '../../foundation/pose-manifest';
import { SEMANTIC_COMPONENT_VERSION } from '../../memory';
import type { SecretStorage } from '../../settings';
import { bgraToRgba, createFaceFrameSource, fitFaceFrame, type FaceFramePorts } from './frames';
import { FaceCheckHost, type FaceFrame, type FaceRecordRow, type FaceWorkerHandle } from './host';
import { FACE_MANIFEST } from './manifest';
import { FaceDataStore } from './store';

/** What scripts/build-electron.mjs puts next to main.cjs. */
export const FACE_BUNDLE = Object.freeze({ worker: 'face-worker.cjs', licenses: 'face-licenses' });

export interface ElectronFaceOptions {
  /** dist-electron (where face-worker.cjs and face-licenses/ are). */
  directory: string;
  /** The profile directory: the saved switch and the encrypted embeddings live here. */
  profileDirectory: string;
  secret: SecretStorage;
  publish(view: FaceCheckView): void;
  journal?(counts: FaceCheckCounts): void;
  /** One journal row about a check's score or why none ran (numbers and closed words; the caller adds the character). */
  record?(row: FaceRecordRow): void;
  /** The enrolment picture, to the control window only (null closes it). Never stored, never sent anywhere else. */
  sendPreview?(message: { enrolPreview: FaceEnrolPreview | null }): void;
  frames: Omit<FaceFramePorts, 'decode'>;
  /** Tests / smoke: a component root other than %LOCALAPPDATA%\soft-hearts-claude\components. */
  componentRoot?: string | null;
}

export interface FaceCheckParts {
  host: FaceCheckHost;
  /** The lead's photo hook: a camera picture (JPEG data URL) about to be sent → the verdict to use for this turn. */
  checkPhoto(dataUrl: string | null | undefined): Promise<'you' | 'not-you'>;
}

function workerEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['SystemRoot', 'windir', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

/** An RGBA frame → a small JPEG data URL for the enrolment picture (at most about 240 px wide, so well under FACE_ENROL_IMAGE_MAX). Memory only. */
export function previewPicture(frame: FaceFrame): string | null {
  const bgra = new Uint8Array(frame.rgba.byteLength);
  for (let i = 0; i < bgra.byteLength; i += 4) { bgra[i] = frame.rgba[i + 2]; bgra[i + 1] = frame.rgba[i + 1]; bgra[i + 2] = frame.rgba[i]; bgra[i + 3] = 255; }
  let image = nativeImage.createFromBitmap(Buffer.from(bgra.buffer), { width: frame.width, height: frame.height });
  if (image.isEmpty()) return null;
  if (frame.width > 240) image = image.resize({ width: 240, quality: 'good' });
  const url = `data:image/jpeg;base64,${image.toJPEG(60).toString('base64')}`;
  return url.length <= FACE_ENROL_IMAGE_MAX ? url : null;
}

/** A camera picture → an RGBA frame of at most 640×480 (memory only). */
export function decodePicture(dataUrl: string): FaceFrame | null {
  if (!/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(dataUrl) || dataUrl.length > 8_000_000) return null;
  let image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) return null;
  const size = image.getSize();
  const target = fitFaceFrame(size.width, size.height);
  if (target.width !== size.width || target.height !== size.height) image = image.resize({ width: target.width, height: target.height, quality: 'good' });
  const actual = image.getSize();
  const rgba = bgraToRgba(new Uint8Array(image.toBitmap()), actual.width, actual.height);
  return rgba ? { width: actual.width, height: actual.height, rgba } : null;
}

export function createFaceCheck(options: ElectronFaceOptions): FaceCheckParts {
  const platform = posePlatform();
  const root = options.componentRoot === undefined ? defaultComponentRoot() : options.componentRoot;
  const others = platform && root ? [path.join(root, `pose-v${POSE_COMPONENT_VERSION}`, platform), path.join(root, 'asr', `asr-v${ASR_COMPONENT_VERSION}`, platform),
    path.join(root, 'semantic', `semantic-v${SEMANTIC_COMPONENT_VERSION}`, platform)] : [];
  const store = platform && root ? new PoseComponentStore({ root: path.join(root, 'face'), platform, manifest: FACE_MANIFEST, component: 'face',
    fetch: net.fetch as unknown as FetchLike, licenseDir: path.join(options.directory, FACE_BUNDLE.licenses),
    // The onnxruntime files are copied from an installed pose, speech or recall component instead of downloaded again.
    reuseDirs: () => others }) : null;
  const fork = (): FaceWorkerHandle => {
    const child = utilityProcess.fork(path.join(options.directory, FACE_BUNDLE.worker), [], {
      serviceName: 'soft hearts face check', stdio: 'ignore', env: workerEnvironment() });
    return {
      postMessage: message => child.postMessage(message),
      onMessage: listener => { child.on('message', listener); },
      onExit: listener => { child.on('exit', listener); },
      kill: () => { child.kill(); },
    };
  };
  const frames = createFaceFrameSource({ ...options.frames, decode: decodePicture });
  const host = new FaceCheckHost({
    store, fork, frames, publish: options.publish, journal: options.journal, record: options.record, threads: 1,
    preview: input => {
      if (!options.sendPreview) return;
      if (!input) { options.sendPreview({ enrolPreview: null }); return; }
      let image: string | null = null;
      try { image = input.frame ? previewPicture(input.frame) : null; } catch { image = null; }
      const frame = input.frame, box = input.box;
      const fractions = frame && box ? ([box.x / frame.width, box.y / frame.height, box.width / frame.width, box.height / frame.height].map(v => Math.min(1, Math.max(0, v))) as [number, number, number, number]) : null;
      options.sendPreview({ enrolPreview: { image, box: fractions, hint: input.hint, taken: input.taken, total: input.total } });
    },
    data: new FaceDataStore(options.profileDirectory, options.secret),
    sharedRuntime: () => others.some(dir => existsSync(path.join(dir, 'installed.json'))),
  });
  return {
    host,
    checkPhoto: async dataUrl => {
      let frame: FaceFrame | null = null;
      try { frame = dataUrl ? decodePicture(dataUrl) : null; } catch { frame = null; }
      return host.checkFrame(frame);
    },
  };
}

/** main.ts's entry: a failure here leaves the face check unavailable instead of ending the app. */
export function createFaceCheckOrNull(options: ElectronFaceOptions): FaceCheckParts | null {
  try { return createFaceCheck(options); }
  catch (error) { console.warn('认出是不是你没能建立：', error instanceof Error ? error.name : 'unknown'); return null; }
}

type HostRegistrar = (method: string, operation: (...args: any[]) => unknown, controlOnly?: boolean) => void;

/**
 * Control-window IPC. Every reply is the fixed-shape view (enums, counts and byte sizes); no path, picture, embedding or score
 * ever leaves the host. Turning the switch on, enrolling and deleting are control-window only (main.ts's `host()` checks the
 * sender); reading the view is allowed for the companion too (its small light).
 */
export function registerFaceControls(host: HostRegistrar, face: () => FaceCheckHost | null, chooseFiles: () => Promise<string[]>): void {
  const required = () => { const value = face(); if (!value) throw new Error('认出是不是你尚未就绪。'); return value; };
  host('getFaceCheck', () => required().view(), false);
  host('setFaceCheck', (on: unknown) => {
    if (typeof on !== 'boolean') throw new Error('开关值不正确。');
    return required().setEnabled(on);
  });
  host('downloadFaceComponents', () => required().download());
  host('cancelFaceDownload', () => { required().cancelDownload(); });
  host('startFaceEnrolment', () => required().enrol());
  host('cancelFaceEnrolment', () => required().cancelEnrol());
  host('deleteFaceData', () => required().deleteData());
  host('importFaceComponents', async () => required().importFiles(await chooseFiles()));
  host('removeFaceComponents', () => required().removeComponent());
}
