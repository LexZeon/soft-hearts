/**
 * A host signal that can arrive before its renderer handler is ready. The pet renderer only
 * registered "desk:pet-recovered" after several startup awaits, so a one-click recovery sent
 * during startup was dropped and the pet kept the reset default camera instead of the
 * full-body framing (2026-11-02 smoke triage). Subscribe immediately; a signal received before
 * attach() is delivered once when the handler attaches.
 */
export interface LatchedSignal {
  attach(handler: () => void): void;
  dispose(): void;
}

export function latchSignal(subscribe: (callback: () => void) => () => void): LatchedSignal {
  let handler: (() => void) | null = null;
  let pending = false;
  const unsubscribe = subscribe(() => {
    if (handler) handler();
    else pending = true;
  });
  return {
    attach(next) {
      handler = next;
      if (pending) { pending = false; next(); }
    },
    dispose() { handler = null; pending = false; unsubscribe(); },
  };
}
