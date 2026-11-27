/**
 * The model check-up's save (docs/claude/2026-11-27-model-checkup-not-saved.md). Every page that reads "what can this model do" in the host
 * (her chat actions' offered list, the internal channel's play_her_action and list_model_capabilities, the character page's switches and the
 * host's half of I-024) reads the profile the HOST stored for the model's content hash (model-profiles.json). Nothing in the host computes
 * it: the window that loads the model builds it (StageModelProfile) and hands it over once. The old stage did that in its load step; when it
 * was deleted (575216516, 2026-11-24) the window engine kept building the profile but never handed it over, so a model first loaded after
 * that day had no stored check-up and was offered no action at all.
 *
 * The rule, one place:
 *  - a profile the host already had for this model (the stage accepted the cached copy: `source === 'cache'`) is kept, not written again;
 *  - a freshly computed one is saved once, under the content key the host gave with its cache read, only while the load is still current;
 *  - a refusal or an error is not swallowed: it is logged (the developer log and the host's own line) and the next load of the model tries
 *    again (nothing is remembered about the failure, so the next load computes and saves afresh);
 *  - the save is never awaited by the load: the caller schedules it after the model is measured, off the first frame's path.
 * Pure: the port, the clock and the log are given.
 */

/** What the page asks the host: save this model's profile under its content key (the host refuses a key that is not the current model's). */
export interface ProfileSavePort { saveModelProfile(modelKey: string, profile: unknown): Promise<boolean> }
/** What the stage built for this load (src/stage/model-profile.ts StageModelProfile has these). */
export interface BuiltProfileView { readonly profile: unknown; readonly source: 'cache' | 'computed' | 'unavailable' }

export type ProfileSaveOutcome =
  | { status: 'saved' }
  /** The host already had this model's profile (it is the one in use): nothing to write. */
  | { status: 'kept' }
  /** Nothing to save: no profile could be built for this model, or a newer load replaced this one before the save. */
  | { status: 'skipped'; reason: 'no-profile' | 'stale' }
  | { status: 'failed'; reason: 'no-key' | 'refused' | 'error'; detail?: string };

export interface ProfileSaveOptions {
  /** The load is still the current one (a model change in between drops the save; the host would refuse it too). */
  current(): boolean;
  /** Where a failure is written (the developer log); never shown as an error to the user, never swallowed. */
  log(line: string): void;
}

/**
 * Saves a freshly built check-up for the model just loaded. `cache` is what the host's cache read returned for this load (its content key):
 * null when the read failed or the host had no model, which makes the save impossible this time (logged, tried again on the next load).
 */
export async function saveBuiltProfile(port: ProfileSavePort, cache: { readonly modelKey: string } | null | undefined,
  built: BuiltProfileView | null | undefined, options: ProfileSaveOptions): Promise<ProfileSaveOutcome> {
  if (!built || !built.profile || built.source === 'unavailable') return { status: 'skipped', reason: 'no-profile' };
  if (built.source === 'cache') return { status: 'kept' };
  if (!options.current()) return { status: 'skipped', reason: 'stale' };
  const fail = (reason: 'no-key' | 'refused' | 'error', detail?: string): ProfileSaveOutcome => {
    try { options.log(`model check-up not saved (${reason}${detail ? `: ${detail}` : ''}); the next load of this model tries again`); } catch { /* a log line only */ }
    return detail ? { status: 'failed', reason, detail } : { status: 'failed', reason };
  };
  if (!cache || typeof cache.modelKey !== 'string' || !cache.modelKey) return fail('no-key');
  try {
    const saved = await port.saveModelProfile(cache.modelKey, built.profile);
    if (saved === true) return { status: 'saved' };
    return options.current() ? fail('refused') : { status: 'skipped', reason: 'stale' };
  } catch (error) {
    return fail('error', (error instanceof Error ? error.message : String(error)).slice(0, 160));
  }
}
