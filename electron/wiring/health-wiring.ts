// 一部分关了 (overhaul step 7, docs/claude/2026-11-17-isolation-step7.md; plan docs/claude/2026-11-16-wiring-rewrite-plan.md section 3): the app's
// part runner and what the user sees of it. electron/main.ts calls wireHealth once, before the first wire call (the runner must exist when
// the parts' wiring runs), declareParts once every part's handle exists, and registers getPartHealth inside the agent channel's recorder.
// - The runner's mode is APP_PART_RUNNER_MODE. SOFT_HEARTS_FAIL_PART=<part>:<unit> is honoured only when the app is not packaged and its
//   profile is inside the system temporary folder (failPartRequest).
// - A unit switched off: one journal line {type:'part-off', part, unit, failure} (written once the cards are loaded, so the journal's
//   switch is known), the control window hears the new health (desk:part-health: its banner and greyed switches), the tray menu gets one
//   line. Nothing is shown on the companion.
// - get_status / get_diagnostics read partsOffNow() (closed `<part>/<unit>` words only).
// - The GPU process (docs/claude/2026-11-22-gpu-reset.md): wireGpuReset, first thing, lifts Chromium's GPU crash limit and WebGL domain
//   block and journals each GPU process end ({type:'gpu-reset'}); a graphics driver reset never ends the app.
// - The graphics chip (docs/claude/2026-11-24-stage-smooth.md): wireGpuChoice asks Chromium for the high-performance chip (a switch, before
//   ready) and a few seconds after the app is up journals one {type:'gpu-start'} row (hardware or software, the vendor family).
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { app, type BrowserWindow } from 'electron';
import os from 'node:os';
import type { JournalInput } from '../../shared/memory';
import type { PartHealthView } from '../../shared/foundation/ports';
import { fatalStartNotice, partsOffList } from '../../shared/foundation/part-health';
import { t } from '../../shared/foundation/ui-language';
import { answerPartOff } from './ipc-wiring';
import { wireGpuReset } from './gpu-reset-wiring';
import { wireGpuChoice } from './gpu-choice-wiring';
import { createPartRunner, failPartRequest, failureName, useRunner, type PartDeclaration, type PartOffEntry, type PartRunner, type PartRunnerMode } from './parts-wiring';
import { UNBOUND_PART } from './unbound-wiring';
import { updateTray } from './shell-wiring';
import { wireStepUnits } from './steps-wiring';

/** The app's mode: 'isolate' since step 7 ('strict' was the rewrite's mode, steps 3 to 6; it changes nothing on a failure). */
export const APP_PART_RUNNER_MODE: PartRunnerMode = 'isolate';

/** What the health wiring reads from the app, each when used (electron/main.ts's table of parts' needs). */
export interface HealthNeeds {
  readonly controls: BrowserWindow | null;
  readonly appJournal: { record(input: JournalInput): unknown };
  /** The cards are loaded (so the settings are, and the journal knows whether it is on). */
  readonly characterCards: unknown;
  journalCharacterId(): string | null;
}

let runner: PartRunner | null = null;
let needs: HealthNeeds | null = null;
let unwritten: PartOffEntry[] = [];
let retry: ReturnType<typeof setTimeout> | null = null;

/** electron/main.ts, once, before the first wire call: the app's part runner (every part's work runs through it from here on). */
export function wireHealth(given: HealthNeeds): PartRunner {
  needs = given;
  wireGpuReset(given); // the GPU process: a driver reset never ends the app (before ready: Chromium switches)
  wireGpuChoice(given); // 2026-11-24: ask for the high-performance chip (before ready), one start row a few seconds after (docs/claude/2026-11-24-stage-smooth.md)
  runner = createPartRunner({
    mode: APP_PART_RUNNER_MODE,
    inject: failPartRequest(process.env, { packaged: app.isPackaged, profile: app.getPath('userData'), temp: os.tmpdir() }),
    onOff: entry => { unwritten.push(entry); writeJournal(); },
    // The developer log: the line always; the failure itself only in source runs (a packaged app keeps no message anywhere).
    log: (line, error) => { if (app.isPackaged || !error) console.error(line); else console.error(line, error); },
  });
  // The notices: the control window hears each change (its banner and greyed switches); the tray menu gets its line. Nothing on the companion.
  runner.onHealth(view => {
    const { controls } = given; // read when called
    if (controls && !controls.isDestroyed()) controls.webContents.send('desk:part-health', view);
    try { updateTray(); } catch { /* before the tray and the settings exist, the menu is made later and reads the health then */ }
  });
  useRunner(runner);
  runner.add(UNBOUND_PART); // Unbound has no PartHandle: its one unit is declared here
  wireStepUnits(); // which unit each step of the ordered lists belongs to
  return runner;
}
/**
 * The ready chain's fatal dialog (a core unit did not start: the card store, her conversation and mood, the stage core, the settings, the
 * safety pipeline, the help card): the plan's words, then the failure itself as before (shown on this computer only, never kept).
 */
export function fatalStartDialog(error: unknown): string {
  const tr = (source: string, ...values: readonly unknown[]): string => t(source, Object.fromEntries(values.map((value, index) => [String(index), String(value)])));
  return `${fatalStartNotice('核心部分', failureName(error), tr)}\n\n${error instanceof Error ? error.message : String(error)}`;
}
/** electron/main.ts, once every part's handle exists: each part's units, core units and handlers. */
export function declareParts(...parts: readonly PartDeclaration[]): void {
  for (const part of parts) runner?.add(part);
}
/** What the control window, the tray and the agent channel read. */
export function partHealth(): PartHealthView {
  return runner?.health() ?? { mode: APP_PART_RUNNER_MODE, started: [], off: [] };
}
/** get_status / get_diagnostics: the units that are off, as `<part>/<unit>`. */
export function partsOffNow(): string[] {
  return partsOffList(partHealth());
}

/** After every part registered (shell-wiring.ts registerQuit): the handlers a switched-off unit never registered answer PART_OFF. */
export function answerOffUnits(): void {
  if (!runner) return;
  for (const entry of runner.health().off) answerPartOff(entry.part, runner.methodsOf(entry.part, entry.unit));
}

/** One journal line per switched-off unit, once the journal's switch is known (a unit may fail before the settings are loaded). */
function writeJournal(): void {
  if (!needs || !unwritten.length) return;
  if (!needs.characterCards) {
    if (!retry) { retry = setTimeout(() => { retry = null; writeJournal(); }, 1_000); retry.unref?.(); }
    return;
  }
  const entries = unwritten;
  unwritten = [];
  for (const entry of entries) {
    try { needs.appJournal.record({ type: 'part-off', characterId: needs.journalCharacterId(), part: entry.part, unit: entry.unit, failure: entry.reason }); }
    catch { /* the journal never changes what the runner did */ }
  }
}
