import type { CameraConfig } from '../shared/contracts';
import { framingId, readPetFramingReport, readPetFramingState, sameFramingCamera, sameFramingState,
  type PetFramingState, type PetFramingRequest, type PetFramingPreset } from '../shared/pet-framing';
import type { CommandCommitResult } from './companion-command-host';

interface Ports {
  now(): number; id(): string; authorize(sender: number): boolean;
  context(): string | null; camera(): CameraConfig; modelUrl(): string;
  send(request: PetFramingRequest): void;
  save(camera: CameraConfig, stillCurrent: () => boolean): Promise<CommandCommitResult['persistence']>;
}
interface Pending {
  request: PetFramingRequest; identity: PetFramingState; current(): boolean; begun: boolean;
  resolve(value: ReturnType<typeof readPetFramingReport> | null): void;
  done: Promise<boolean>; finish(value: boolean): void;
}
/** One fixed framing operation of the current pet. State reports and diagnostic IDs grant no command authority. */
export class PetFramingHost {
  private state: PetFramingState | null = null;
  private revision = 0;
  private pending: Pending | null = null;
  constructor(private readonly ports: Ports) {}
  report(sender: number, value: unknown): void {
    if (!this.ports.authorize(sender)) throw Error('取景状态来源不正确。');
    const next = readPetFramingState(value);
    if (this.state && sameFramingState(this.state, next)) return;
    this.state = next; this.revision++;
    this.pending?.resolve(null);
  }
  reset(): void { this.state = null; this.revision++; this.pending?.resolve(null); }
  manual(): void { this.revision++; this.pending?.resolve(null); }
  cancel(): void { this.pending?.resolve(null); }
  target() {
    const context = this.ports.context(), state = this.state;
    if (!context || !state?.ready || !state.modelUrl || state.modelUrl !== this.ports.modelUrl()) return null;
    return { contextId: `${context}:${state.session}:${state.modelGeneration}:${state.contextRevision}`,
      value: false as const, revision: this.revision, identity: state };
  }
  begin(sender: number, id: unknown): boolean {
    const p = this.pending;
    if (!this.ports.authorize(sender) || !framingId(id) || !p || p.request.id !== id || p.begun || !p.current()
      || !sameFramingCamera(this.ports.camera(), p.identity.camera)) return false;
    p.begun = true; return true;
  }
  complete(sender: number, value: unknown): Promise<boolean> {
    if (!this.ports.authorize(sender)) throw Error('取景回执来源不正确。');
    const report = readPetFramingReport(value), p = this.pending;
    if (!p || p.request.id !== report.id || !p.begun || !p.current()
      || report.state.session !== p.identity.session || report.state.modelGeneration !== p.identity.modelGeneration
      || report.state.contextRevision !== p.identity.contextRevision || report.state.modelUrl !== p.identity.modelUrl
      || !report.state.ready || report.state.cameraRevision < p.identity.cameraRevision) return Promise.resolve(false);
    p.resolve(report); return p.done;
  }
  async frame(preset: PetFramingPreset, identity: object, authorized: () => boolean): Promise<CommandCommitResult> {
    const rejected = { persistence: 'not-committed', presentation: 'not-requested' } as const;
    if (this.pending || this.state !== identity || !this.target() || !authorized()
      || !sameFramingCamera(this.ports.camera(), this.state!.camera)) return rejected;
    const state = this.state!, context = this.ports.context(), revision = this.revision, deadline = this.ports.now() + 4000;
    let resolve!: Pending['resolve'], finish!: Pending['finish'];
    const response = new Promise<ReturnType<typeof readPetFramingReport> | null>(yes => { resolve = yes; });
    const done = new Promise<boolean>(yes => { finish = yes; });
    const p: Pending = { request: { id: this.ports.id(), preset, expiresAt: deadline, expected: structuredClone(state) }, identity: state,
      current: () => this.pending === p && this.state === state && this.revision === revision && this.ports.context() === context
        && this.ports.now() < deadline && authorized(), begun: false, resolve, done, finish };
    this.pending = p;
    const timeout = setTimeout(() => resolve(null), 4000);
    let applied = false;
    try {
      this.ports.send(p.request);
      const report = await response;
      if (!report) return { persistence: 'not-committed', presentation: 'unknown' };
      if (!report.applied) return rejected;
      applied = true;
      if (!p.current()) return { persistence: 'not-committed', presentation: 'applied' };
      const persistence = await this.ports.save(report.state.camera, p.current);
      return { persistence, presentation: p.current() ? 'applied' : 'unknown' };
    } catch { return { persistence: 'unknown', presentation: applied ? 'applied' : 'unknown' }; }
    finally { clearTimeout(timeout); if (this.pending === p) this.pending = null; finish(applied); }
  }
}
