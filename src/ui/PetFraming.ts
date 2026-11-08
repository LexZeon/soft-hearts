import { framingId, readPetFramingState, sameFramingState, type PetFramingState,
  type PetFramingRequest, type PetFramingReport, type PetFramingPreset } from '../../shared/pet-framing';

interface Ports {
  state(): Omit<PetFramingState, 'session' | 'contextRevision'>;
  report(state: PetFramingState): void;
  begin(id: string): Promise<boolean>;
  complete(report: PetFramingReport): Promise<unknown>;
  frame(preset: PetFramingPreset): boolean;
}
/** Mounted only by the real pet. Preview/controls do not subscribe to the framing channel. */
export class PetFramingController {
  applying = false;
  private contextRevision = 0;
  private readonly consumed = new Set<string>();
  constructor(private readonly session: string, private readonly ports: Ports, private readonly now = Date.now) {}
  state(): PetFramingState { return { ...this.ports.state(), session: this.session, contextRevision: this.contextRevision }; }
  report(): void { if (!this.applying) this.ports.report(this.state()); }
  invalidate(): void { this.contextRevision++; this.report(); }
  async receive(value: PetFramingRequest): Promise<void> {
    if (!value || !framingId(value.id) || this.consumed.has(value.id) || !['full', 'portrait'].includes(value.preset)
      || !Number.isFinite(value.expiresAt) || value.expiresAt <= this.now() || value.expiresAt > this.now() + 5000) return;
    const expected = readPetFramingState(value.expected);
    this.consumed.add(value.id);
    if (this.consumed.size > 64) this.consumed.delete(this.consumed.values().next().value!);
    if (!expected.ready || !sameFramingState(this.state(), expected) || !await this.ports.begin(value.id)) return;
    if (value.expiresAt <= this.now() || !sameFramingState(this.state(), expected)) {
      await this.ports.complete({ id: value.id, applied: false, state: this.state() }); return;
    }
    let applied = false;
    try { this.applying = true; applied = this.ports.frame(value.preset); }
    finally { this.applying = false; }
    try { await this.ports.complete({ id: value.id, applied, state: this.state() }); }
    finally { this.report(); }
  }
}
