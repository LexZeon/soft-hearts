// AppPorts (wiring rewrite step 3, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2; docs/claude/2026-11-16-wiring-step-3.md):
// the state the parts share, as named getters read at the moment of use (before the ready chain sets a store it is undefined, as the
// old `companion?.` reads were). The predicates are the old inline expressions copied word for word, one port per expression: ones that
// look alike are NOT merged (senseRouter's `free` waits for the user's typing, feeding's does not; keepsake's and specialDay's `calm`
// are kept apart; the notebook's `userBusy` is its own). tests/wiring-skeleton.test.ts checks each still matches its inline copy.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import type { BrowserWindow } from 'electron';
import type { SettingsStore } from '../settings';
import type { CompanionService } from '../brain';
import type { UnboundHost } from '../unbound';

interface Busy { readonly busy: boolean }
interface ActiveFlag { readonly active: boolean }
/** What electron/main.ts hands over: getters of its own state (read when a port is read, never kept). */
export interface AppPortSources {
  readonly store: SettingsStore | undefined;
  readonly companion: CompanionService | undefined;
  readonly pet: BrowserWindow | null;
  readonly controls: BrowserWindow | null;
  readonly unbound: UnboundHost | null;
  readonly pending: ReadonlyMap<string, { readonly kind: string }>;
  readonly exiting: boolean;
  readonly userInputUntil: number;
  readonly petWindowDrag: ActiveFlag | null;
  readonly ambientSpeakingOwners: { readonly size: number };
  readonly proactiveSpeechGate: Busy;
  readonly rps: { readonly host: ActiveFlag };
  readonly innerLoopHost: { readonly loop: { asleep(): boolean } };
  readonly userActivity: { view(): { state: string } | null | undefined; presence(): { interrupt?: string } } | undefined;
  readonly speechPlaybackActivity: Busy;
  readonly voiceHost: Busy;
  readonly foregroundAsr: Busy;
  readonly asrTask: unknown;
  replySpeechBusy(): boolean;
  claudeCallsInFlight(): number;
  readonly chatAvailability: { isAvailable(): boolean };
}

export interface AppPorts {
  readonly store: SettingsStore | undefined;
  readonly companion: CompanionService | undefined;
  readonly pet: BrowserWindow | null;
  readonly controls: BrowserWindow | null;
  readonly exiting: boolean;
  readonly userInputUntil: number;
  /** A chat turn runs now. */
  chatBusy(): boolean;
  /** The companion window is shown and not minimized. */
  petVisible(): boolean;
  /** The companion window's sender id, or null. */
  petSender(): number | null;
  /** Her line can be shown: the companion window, or her Unbound bubble while she is out (read-aloud). */
  herOnScreen(): boolean;
  /** I-019 feeding: her answer to the user's own act (not held back by typing). */
  feedingFree(): boolean;
  /** I-050 keepsake: a quiet moment for her light line. */
  keepsakeCalm(): boolean;
  /** I-059 special day: a quiet moment for her line about the day. */
  specialDayCalm(): boolean;
  /** I-021 / P-001 notebook: the user is with her (no note call now). */
  noteUserBusy(): boolean;
}

export function createAppPorts(sources: AppPortSources): AppPorts {
  const read = () => sources;
  return {
    get store() { return sources.store; },
    get companion() { return sources.companion; },
    get pet() { return sources.pet; },
    get controls() { return sources.controls; },
    get exiting() { return sources.exiting; },
    get userInputUntil() { return sources.userInputUntil; },
    chatBusy: () => { const { pending } = read();
      return [...pending.values()].some(task => task.kind === 'chat'); },
    petVisible: () => { const { pet } = read();
      return !!pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized(); },
    petSender: () => { const { pet } = read();
      return pet && !pet.isDestroyed() ? pet.webContents.id : null; },
    herOnScreen: () => { const { pet, unbound } = read();
      return (!!pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized()) || !!unbound?.readAloud.canShow(); },
    feedingFree: () => { const { pet, petWindowDrag, replySpeechBusy, ambientSpeakingOwners, proactiveSpeechGate, pending, rps } = read();
      return !!pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized() && !petWindowDrag?.active && !replySpeechBusy() && ambientSpeakingOwners.size === 0
    && !proactiveSpeechGate.busy && ![...pending.values()].some(task => task.kind === 'chat') && !rps.host.active; },
    keepsakeCalm: () => { const { exiting, innerLoopHost, userActivity, proactiveSpeechGate, pending, claudeCallsInFlight, chatAvailability } = read();
      return !exiting && !innerLoopHost.loop.asleep() && userActivity?.view()?.state !== 'busy' && userActivity?.presence().interrupt !== 'no' && !proactiveSpeechGate.busy && ![...pending.values()].some(task => task.kind === 'chat') && claudeCallsInFlight() === 0 && chatAvailability.isAvailable(); },
    specialDayCalm: () => { const { exiting, innerLoopHost, userActivity, proactiveSpeechGate, pending, claudeCallsInFlight, chatAvailability } = read();
      return !exiting && !innerLoopHost.loop.asleep() && userActivity?.view()?.state !== 'busy' && userActivity?.presence().interrupt !== 'no' && !proactiveSpeechGate.busy && ![...pending.values()].some(task => task.kind === 'chat') && claudeCallsInFlight() === 0 && chatAvailability.isAvailable(); },
    noteUserBusy: () => { const { exiting, pending, userInputUntil, replySpeechBusy, speechPlaybackActivity, ambientSpeakingOwners, proactiveSpeechGate, voiceHost, foregroundAsr, asrTask } = read();
      return exiting || pending.size > 0 || Date.now() < userInputUntil || replySpeechBusy() || speechPlaybackActivity.busy || ambientSpeakingOwners.size > 0
          || proactiveSpeechGate.busy || voiceHost.busy || foregroundAsr.busy || !!asrTask; },
  };
}
