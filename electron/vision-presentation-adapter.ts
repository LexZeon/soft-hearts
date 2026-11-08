import { formatVisionPresentation, type VisionInitiative } from '../shared/vision-runtime';

export interface VisionPresentationSurface {
  waitForPresentation(exactText: string, signal?: AbortSignal): Promise<boolean>;
  isPresentationCurrent(exactText: string): boolean;
}

interface PresentationContext {
  surface(): VisionPresentationSurface | null;
  identity(): string;
  eligible(): boolean;
}

/** Adapter stays host-only. Neither text, scope nor a presentation nonce comes from an ack IPC. */
export async function confirmVisionPresentation(message: Readonly<VisionInitiative>, signal: AbortSignal, context: PresentationContext): Promise<boolean> {
  if (signal.aborted || !context.eligible()) return false;
  const surface = context.surface(), identity = context.identity();
  if (!surface || !identity) return false;
  try {
    const text = formatVisionPresentation(message);
    const shown = await surface.waitForPresentation(text, signal);
    return shown === true && !signal.aborted && context.eligible()
      && context.surface() === surface && context.identity() === identity && surface.isPresentationCurrent(text) === true;
  } catch { return false; }
}

/** Holds only one bounded display identity, never a screenshot or a full persona. */
export class VisionPresentationGuard {
  private generation = 0;
  private proof: { id: string; text: string; surface: VisionPresentationSurface; identity: string; signal: AbortSignal } | null = null;
  constructor(private readonly context: PresentationContext) {}
  async present(message: Readonly<VisionInitiative>, signal: AbortSignal): Promise<boolean> {
    this.clear();
    const generation = this.generation;
    const surface = this.context.surface(), identity = this.context.identity();
    if (!surface || !identity || signal.aborted || !this.context.eligible()) return false;
    try {
      const text = formatVisionPresentation(message);
      const shown = await confirmVisionPresentation(message, signal, this.context);
      if (!shown || generation !== this.generation || this.context.surface() !== surface || this.context.identity() !== identity) return false;
      this.proof = { id: message.id, text, surface, identity, signal };
      return this.current(message);
    } catch { return false; }
  }
  /** Called synchronously immediately before the engine commits its lease. */
  current(message: Readonly<VisionInitiative>): boolean {
    try { return this.proof?.id === message.id && this.proof.text === formatVisionPresentation(message) && this.canSpeak(message.id); }
    catch { return false; }
  }
  /** Also rechecked by the host before starting each automatic cloud segment. */
  canSpeak(replyId: string): boolean {
    const proof = this.proof;
    if (!proof || proof.id !== replyId || proof.signal.aborted) return false;
    try {
      return this.context.eligible() && this.context.surface() === proof.surface && this.context.identity() === proof.identity
        && proof.surface.isPresentationCurrent(proof.text) === true;
    } catch { return false; }
  }
  clear(): void { this.generation++; this.proof = null; }
}
