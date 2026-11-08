import type { ProviderConfig } from '../shared/contracts';

/** Missing capability metadata fails closed; a model name alone is not evidence. */
export function codexCatalogSupportsVision(raw: string, model: string): boolean {
  try {
    const data = JSON.parse(raw) as { models?: { slug?: string; input_modalities?: string[] }[] };
    if (!Array.isArray(data.models) || !data.models.length) return false;
    const candidates = model.trim() ? data.models.filter(item => item.slug === model.trim()) : data.models;
    return candidates.length > 0 && candidates.every(item => Array.isArray(item.input_modalities) && item.input_modalities.includes('image'));
  } catch { return false; }
}

/** Every model Claude Code offers today accepts images; an unrecognized name fails closed. */
export function claudeModelSupportsVision(model: string): boolean {
  const value = model.trim().toLowerCase();
  return !value || /^(?:haiku|sonnet|opus|default|best)(?:\[1m\])?$/.test(value) || /(?:^|[.:/])claude-[a-z0-9.-]+$/.test(value);
}

export class VisionProviderSupport {
  private readonly verified = new Set<string>();
  private key(provider: ProviderConfig): string { return JSON.stringify([provider.kind, provider.baseUrl, provider.model]); }
  /** Only the host may mark a successful ordinary request that actually had images. */
  noteImageSuccess(provider: ProviderConfig): void { this.verified.add(this.key(provider)); }
  async supports(provider: ProviderConfig, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (this.verified.has(this.key(provider))) return true;
    return provider.kind === 'claude' && claudeModelSupportsVision(provider.model);
  }
}
