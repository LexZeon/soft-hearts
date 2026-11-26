/**
 * Settings broadcasts that arrive while a window is still starting (docs/claude/2026-11-25-first-turn-empty.md).
 *
 * A window read the host's settings at the very start of its startup (loadSettings) but only listened for 'desk:settings' at the end of it
 * (wireSettingsUpdates), after a dozen awaits: the stage, the mood panel, the memory panels, the control tools. A change the host made in
 * between was never seen: the window kept the old persona and model. The next ordinary broadcast (the companion window saving its framing
 * a moment later) then looked like "the card text changed", and the control window cleared her conversation view right after the user's
 * first message (before 2026-11-25 it also stopped that reply). The chat acceptance's turn 1 failed this way on every candidate after the
 * old stage was deleted (the window's startup grew longer).
 *
 * Now `load()` listens before it reads. Anything that arrives before the handler is attached only marks "something changed"; when the
 * handler attaches it gets the host's settings read again then (never a replay of an older broadcast, which could roll a newer read back),
 * and every later broadcast goes straight to it. Pure (ports), so it is tested without a window.
 */
export interface SettingsStartup<T> {
  /** Starts listening, then reads the host's settings (the window's first copy). */
  load(): Promise<T>;
  /** Attach the real handler; when a broadcast came before this, the host's settings are read again and handed to it once. */
  attach(handler: (next: T) => void): void;
  dispose(): void;
}

export interface SettingsStartupPorts<T> {
  subscribe(callback: (next: T) => void): () => void;
  read(): Promise<T>;
  onError?(error: unknown): void;
}

export function settingsStartup<T>(ports: SettingsStartupPorts<T>): SettingsStartup<T> {
  let handler: ((next: T) => void) | null = null;
  let missed = false;
  let unsubscribe: (() => void) | null = null;
  const listen = () => {
    unsubscribe ??= ports.subscribe(next => {
      if (handler) handler(next);
      else missed = true;
    });
  };
  return {
    load() { listen(); return ports.read(); },
    attach(next) {
      listen();
      handler = next;
      if (!missed) return;
      missed = false;
      void ports.read().then(fresh => { if (handler === next) next(fresh); }, error => ports.onError?.(error));
    },
    dispose() { handler = null; missed = false; unsubscribe?.(); unsubscribe = null; },
  };
}
