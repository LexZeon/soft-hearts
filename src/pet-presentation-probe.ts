import type { PetPresentationSample } from '../shared/contracts';

interface ProbeCanvas { width: number; height: number; clientWidth: number; clientHeight: number; getContext(kind: string): unknown }
export interface ProbeDocument {
  visibilityState?: string;
  querySelector(selector: string): unknown;
  defaultView?: { devicePixelRatio?: number } | null;
}
type FrameRequest = (callback: () => void) => unknown;

const dimension = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(100_000, Math.round(value)) : 0;

/** What the pet page itself can see: page visibility, canvas size, WebGL loss and whether frames run. */
export async function probePetPresentation(doc: ProbeDocument, hostVisible: boolean, reason: PetPresentationSample['reason'],
  frame: FrameRequest = callback => requestAnimationFrame(() => callback()), timeoutMs = 700): Promise<PetPresentationSample> {
  const canvas = doc.querySelector('#stage canvas') as ProbeCanvas | null;
  let contextLost: boolean | null = null;
  if (canvas && typeof canvas.getContext === 'function') {
    try {
      // Returns the stage's existing WebGL2 context; it never creates a second one.
      const gl = canvas.getContext('webgl2') as { isContextLost?: () => boolean } | null;
      contextLost = gl && typeof gl.isContextLost === 'function' ? gl.isContextLost() === true : null;
    } catch { contextLost = null; }
  }
  const frameAdvanced = await new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    try { frame(() => { clearTimeout(timer); resolve(true); }); }
    catch { clearTimeout(timer); resolve(false); }
  });
  const state = doc.visibilityState;
  const ratio = doc.defaultView?.devicePixelRatio;
  return {
    reason,
    visibility: state === 'visible' || state === 'hidden' || state === 'prerender' ? state : 'unknown',
    hostVisible,
    canvasWidth: dimension(canvas?.width), canvasHeight: dimension(canvas?.height),
    clientWidth: dimension(canvas?.clientWidth), clientHeight: dimension(canvas?.clientHeight),
    devicePixelRatio: typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 && ratio <= 16 ? ratio : 1,
    contextLost, frameAdvanced,
  };
}

/** A lost WebGL context cannot draw the transparent pet again without a fresh page. */
export function presentationNeedsReload(sample: PetPresentationSample): boolean {
  return sample.contextLost === true;
}

export interface PetPresentationCheckPorts {
  document: ProbeDocument;
  hostVisible(): boolean;
  reason: PetPresentationSample['reason'];
  report(sample: PetPresentationSample): Promise<unknown>;
  /** Only an explicit user recovery may reload the pet page. */
  reload?: () => void;
  delayMs?: number;
  frame?: FrameRequest;
  wait?: (ms: number) => Promise<void>;
}
/** Report the pet's drawing state to the host log; after an explicit recovery, reload a page whose GPU context is gone. */
export async function checkPetPresentation(ports: PetPresentationCheckPorts): Promise<PetPresentationSample | null> {
  try {
    if (ports.delayMs) await (ports.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms))))(ports.delayMs);
    const sample = await probePetPresentation(ports.document, ports.hostVisible(), ports.reason, ports.frame);
    try { await ports.report(sample); } catch { /* Diagnostics never block recovery. */ }
    if (ports.reload && presentationNeedsReload(sample)) ports.reload();
    return sample;
  } catch { return null; }
}
