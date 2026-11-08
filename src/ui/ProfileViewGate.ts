import type { UserProfileView } from '../../shared/user-profile-ui';

/** Renderer ordering only; the host remains the authority for all writes. */
export class ProfileViewGate {
  view: UserProfileView | null = null;
  sequence = 0;
  private floor = -1;
  private barrier = false;
  event(value: UserProfileView | null): boolean {
    this.sequence++;
    if (!value) {
      this.floor = Math.max(this.floor, this.view?.generation ?? -1);
      this.barrier = true; this.view = null; return true;
    }
    return this.accept(value);
  }
  snapshot(sequence: number, value: UserProfileView | null): boolean {
    if (sequence !== this.sequence) return false;
    if (!value) return this.event(null);
    return this.accept(value);
  }
  response(scope: string, value: UserProfileView): boolean {
    if (!this.view || this.view.scopeId !== scope || value.scopeId !== scope) return false;
    return this.accept(value);
  }
  private accept(value: UserProfileView): boolean {
    if (!Number.isSafeInteger(value.generation) || !Number.isSafeInteger(value.revision)) return false;
    if (value.generation < this.floor || (this.barrier && value.generation <= this.floor)) return false;
    const old = this.view;
    if (old && (value.generation < old.generation
      || (value.generation === old.generation && (value.scopeId !== old.scopeId || value.revision < old.revision)))) return false;
    this.floor = Math.max(this.floor, value.generation); this.barrier = false; this.view = value; return true;
  }
}
