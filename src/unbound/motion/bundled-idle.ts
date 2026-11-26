/**
 * Unbound's idle model (after the side-by-side video: "Unbound用右的，但是后续模型也有升级空间。"): the StayStill
 * small model with its own quick moves, at liveliness 0.5, shipped under assets/bundled/unbound/idle/ (MIT, citation in the README
 * there; docs/claude/2026-11-14-staystill-idle.md「接进 Unbound」).
 *
 * The manifest (shared/unbound/idle-model.json) is the one knob: which files, their sizes and SHA-256, and the settings they are
 * played with. A retrained model drops in by replacing the files and the manifest; nothing here names a variant.
 *
 * The Unbound page reads the files itself, read-only, from the app's own folder (no new channel to the host): the built page is
 * <app>/dist/src/unbound/index.html and the bundled assets <app>/assets/bundled/ (package.json "files"); the dev server serves the
 * checkout's root. Each file is checked against the manifest before it is used. Anything wrong (missing, changed, not parseable,
 * another page) gives null: the caller falls back to the procedural idle and says nothing.
 */
import manifestJson from '../../../shared/unbound/idle-model.json';
import { IDLE_DIM } from './idle-channels';
import type { IdleEventLibrary } from './idle-events';
import type { IdleModelWeights } from './idle-model';
import { createLearnedIdle, type IdleBounds, type LearnedIdle } from './learned-idle';

export interface BundledIdleFile { relativePath: string; bytes: number; sha256: string }
export interface BundledIdleSettings { activation: number; calibrated: boolean; eventRate: number; leashS: number; bounds: IdleBounds | null }
export interface BundledIdleManifest {
  variant: string;
  settings: BundledIdleSettings;
  weights: BundledIdleFile;
  eventsMeta: BundledIdleFile;
  eventsData: BundledIdleFile;
}
/** The shipped model (the manifest as the build saw it). */
export const UNBOUND_IDLE_MODEL: BundledIdleManifest = manifestJson;

export interface BundledIdle { variant: string; settings: BundledIdleSettings; weights: IdleModelWeights; events: IdleEventLibrary }

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
/**
 * assets/bundled/ as seen from the Unbound page, or null for any other page: the built page (file:, under dist/src/unbound/) or
 * the local dev server (http on this computer, the checkout's root at /, the page under src/unbound/).
 */
export function bundledRootFor(pageHref: string): string | null {
  let page: URL;
  try { page = new URL(pageHref); } catch { return null; }
  if (page.username || page.password) return null;
  const file = page.protocol === 'file:' && !page.host;
  const dev = page.protocol === 'http:' && LOCAL_HOSTS.includes(page.hostname);
  if (!file && !dev) return null;
  const match = (file ? /^(.*\/)dist\/src\/unbound\/[^/]+$/ : /^(.*\/)src\/unbound\/[^/]+$/).exec(page.pathname);
  return match ? new URL(`${match[1]}assets/bundled/`, page).href : null;
}

/** Reads a file's bytes (the page: an XMLHttpRequest, which, unlike fetch, also reads file: URLs; tests pass their own). */
export type ReadBytes = (url: string) => Promise<ArrayBuffer>;

export const readBytesXhr: ReadBytes = url => new Promise((resolve, reject) => {
  const request = new XMLHttpRequest();
  request.open('GET', url, true);
  request.responseType = 'arraybuffer';
  request.timeout = 15_000;
  request.onload = () => {
    const ok = (new URL(url).protocol === 'file:' && request.status === 0) || (request.status >= 200 && request.status < 300);
    if (ok && request.response instanceof ArrayBuffer) resolve(request.response); else reject(new Error(`${url}: ${request.status}`));
  };
  request.onerror = request.ontimeout = () => reject(new Error(`${url}: unreadable`));
  request.send();
});

async function sha256Hex(bytes: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  return [...new Uint8Array(await subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function checked(read: ReadBytes, root: string, file: BundledIdleFile): Promise<ArrayBuffer> {
  if (!/^unbound\/idle\/[A-Za-z0-9.-]+$/.test(file.relativePath)) throw new Error('path');
  const bytes = await read(new URL(file.relativePath, root).href);
  if (bytes.byteLength !== file.bytes) throw new Error(`${file.relativePath}: size`);
  const hash = await sha256Hex(bytes);
  if (hash !== null && hash !== file.sha256) throw new Error(`${file.relativePath}: SHA-256`);
  return bytes;
}

/** The shipped model and quick moves, checked against the manifest; null when anything is off (never throws). */
export async function loadBundledIdle(pageHref: string, read: ReadBytes = readBytesXhr, manifest: BundledIdleManifest = UNBOUND_IDLE_MODEL): Promise<BundledIdle | null> {
  try {
    const root = bundledRootFor(pageHref);
    if (!root) return null;
    const [w, m, d] = await Promise.all([manifest.weights, manifest.eventsMeta, manifest.eventsData].map(file => checked(read, root, file)));
    const text = new TextDecoder();
    const weights = JSON.parse(text.decode(w)) as IdleModelWeights;
    const meta = JSON.parse(text.decode(m)) as { frames: number; count: number; perMinuteByActivityFifth: number[] };
    const events = new Float32Array(d);
    const rates = meta.perMinuteByActivityFifth;
    if (weights?.kind !== 'idle-ar-cvae' || weights.dim !== IDLE_DIM) return null;
    if (!(meta.frames > 0) || meta.count * meta.frames * IDLE_DIM !== events.length || !Array.isArray(rates) || rates.length !== 5 || !rates.every(Number.isFinite)) return null;
    if (!events.every(Number.isFinite)) return null;
    return { variant: manifest.variant, settings: { ...manifest.settings }, weights, events: { events, frames: meta.frames, perMinuteByActivityFifth: rates } };
  } catch { return null; }
}

/** Her idle from the shipped model (or the procedural one when `bundled` is null), with the manifest's settings. */
export function createBundledIdle(heightM: number, bundled: BundledIdle | null, seed: number): LearnedIdle {
  const s = bundled?.settings ?? UNBOUND_IDLE_MODEL.settings;
  return createLearnedIdle({ heightM, seed, activation: s.activation, calibrated: s.calibrated, eventRate: s.eventRate, leashS: s.leashS, bounds: s.bounds,
    weights: bundled?.weights ?? null, events: bundled?.events ?? null });
}
