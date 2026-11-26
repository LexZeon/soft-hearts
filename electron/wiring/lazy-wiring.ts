// Parts made on first use (overhaul step 8, docs/claude/2026-11-17-lazy-loading-step8.md; plan docs/claude/2026-11-16-wiring-rewrite-plan.md
// section 4). A lazy part registers, where it registered before (inside the agent channel's recorder), one shell per desk: method it has,
// with the method's own flags (window guard, controlOnly). The first call to any of them makes the part (`create`, through the part runner
// when it is a unit), then lets the part register its real handlers into a table (`register`, with the same registrar shape the old code
// had); every call, the first included, then runs the real handler with its own arguments. So the recorder records the same names, a
// window's call answers what it answered before, and nothing of the part exists until something asks for it.
// - The declared methods must be exactly the ones `register` registers, with the same flags: a mismatch throws on the first call (and
//   tests/lazy-parts.test.ts checks each lazy part's declaration against its register()).
// - A unit whose making fails (isolate mode) is switched off by the runner; its call, and every later one, answers PART_OFF.
// - Before quit or on a window event, a part that was never made has nothing to release: its cleanup reads `made()`.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import type { PartIpc } from './ipc-wiring';
import { PartOffError, partRunner } from './parts-wiring';

/** One desk: method of a lazy part, with the flags its real registration uses. */
export interface LazyMethod {
  readonly method: string;
  /** Registered with scopedHost (its operation gets the sender first); else host. */
  readonly scoped?: boolean;
  /** host / scopedHost's controlOnly (their default is true). */
  readonly controlOnly: boolean;
}
export interface LazyPart {
  readonly part: string;
  /** The part runner's unit, when the part is one (its making is then that unit's start). */
  readonly unit?: string;
  readonly methods: readonly LazyMethod[];
  /** Makes the part (once, on the first call). */
  create(): void;
  /** Registers the part's real handlers (called once, right after create, with a registrar that fills the table). */
  register(ipc: PartIpc): void;
}
export interface LazyHandle {
  /** Whether the part was made. */
  made(): boolean;
  /** Makes it now (a test; or a caller outside IPC that needs it): the same as a first call. */
  ensure(): void;
}

type Operation = (...args: any[]) => unknown;

/** Registers the lazy part's shells through `ipc` (the part's registrar: the guard, PART_OFF and the recorder see them as before). */
export function registerLazy(ipc: PartIpc, lazy: LazyPart): LazyHandle {
  const declared = new Map(lazy.methods.map(entry => [entry.method, entry] as const));
  let table: Map<string, Operation> | null = null;
  let made = false;
  const refuseOff = () => {
    const runner = partRunner();
    if (lazy.unit && runner?.isOff(lazy.part, lazy.unit)) throw new PartOffError(lazy.part, lazy.unit);
  };
  const ensure = (): void => {
    refuseOff(); // a unit that failed to be made is off: every later call answers PART_OFF
    if (table) return;
    const filled = new Map<string, Operation>();
    const fill = (scoped: boolean) => (method: string, operation: Operation, controlOnly = true) => {
      const entry = declared.get(method);
      if (!entry || !!entry.scoped !== scoped || entry.controlOnly !== controlOnly || filled.has(method))
        throw new Error(`lazy part ${lazy.part}: ${method} is not registered as declared`);
      filled.set(method, operation);
    };
    lazy.create(); // a throw that is not isolated reaches this caller; the next call tries again, as a failed start would have been fatal
    refuseOff(); // isolate: making it failed and the runner switched it off: this call answers PART_OFF
    made = true;
    lazy.register({ host: fill(false), scopedHost: fill(true) });
    for (const method of declared.keys()) if (!filled.has(method)) throw new Error(`lazy part ${lazy.part}: ${method} was declared but not registered`);
    table = filled;
  };
  const run = (method: string, args: unknown[]) => { ensure(); return table!.get(method)!(...args); };
  // One shell (the wiring golden reads the real registrations in `register`, not these: a registrar passing its own first parameter on).
  const shell = (method: string) => {
    const entry = declared.get(method)!;
    if (entry.scoped) ipc.scopedHost(method, (sender: number, ...args: unknown[]) => run(method, [sender, ...args]), entry.controlOnly);
    else ipc.host(method, (...args: unknown[]) => run(method, args), entry.controlOnly);
  };
  for (const entry of lazy.methods) shell(entry.method);
  return { made: () => made, ensure };
}
