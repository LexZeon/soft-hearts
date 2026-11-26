// Boots electron/main.ts under node with the Electron and Claude stand-ins and runs one scenario (overhaul step 7,
// docs/claude/2026-11-17-isolation-step7.md). Run as a child process (main.ts keeps module state):
//   node <tsx cli> tests/helpers/app-stand-in/run.ts
// with SOFT_HEARTS_STAND_IN_ROOT a fresh temporary folder (the profile is made inside it), and optionally SOFT_HEARTS_FAIL_PART=<part>:<unit>
// and STAND_IN_METHODS=<desk method>[=<json argument>];;<…> (each is called once from the control window after the boot; its answer or error is reported).
// It prints one line `STAND-IN-REPORT <json>`: the error dialogs, whether the app quit, the part health, one chat turn's events, which clock
// entries ran in one tick (in order), and the methods' answers. No window, tray, process or Claude call is real.
import './boot';
import path from 'node:path';

process.env.SOFT_HEARTS_CLAUDE_PERSISTENT = '0'; // the chat goes through streamClaude (the stand-in), never a long-lived process
process.env.SOFT_HEARTS_CLAUDE_CODE_LINK = 'off'; // the agent channel never looks for the real Claude Code
const uncaught: string[] = [];
process.on('uncaughtException', error => { uncaught.push(`${(error as Error)?.name ?? 'Error'}: ${String((error as Error)?.message ?? error).slice(0, 200)}`); });
process.on('unhandledRejection', () => { /* the stand-ins leave some optional promises unanswered on purpose */ });

// STAND_IN_IDLE_SECONDS: what powerMonitor says about the time since the last keyboard or mouse input (the user-away signal).
if (process.env.STAND_IN_IDLE_SECONDS) (await import('electron') as unknown as { powerMonitor: { getSystemIdleTime(): number } }).powerMonitor.getSystemIdleTime = () => Number(process.env.STAND_IN_IDLE_SECONDS);
// Overhaul step 8: the companion page "runs" while the ready chain still starts parts (electron/wiring/ipc-wiring.ts IPC shells); STAND_IN_EARLY_METHODS
// (`;;`-separated) are called from the companion window then, as its renderer would, and each answer is reported with whether the shells were
// still open when it was called (report.early). Importing the IPC wiring here first has no side effects (tests/wiring-skeleton.test.ts).
const early: Record<string, unknown> = {};
const ipcWiring = await import('../../../electron/wiring/ipc-wiring');
{
  const earlyMethods = (process.env.STAND_IN_EARLY_METHODS ?? '').split(';;').filter(Boolean);
  (globalThis as Record<string, unknown>).__standInOnLoad = (role: string, contents: { mainFrame: unknown }) => {
    if (role !== 'pet') return;
    const handlers = (globalThis as Record<string, any>).__softHeartsStandIn.handlers as Map<string, (event: unknown) => unknown>;
    for (const method of earlyMethods) {
      const shellsOpen = ipcWiring.ipcShellsOpen();
      early[method] = { shellsOpen, pending: true };
      Promise.resolve().then(() => handlers.get(`desk:${method}`)!({ sender: contents, senderFrame: contents.mainFrame }))
        .then(value => { early[method] = { shellsOpen, answeredShellsOpen: ipcWiring.ipcShellsOpen(), value: JSON.parse(JSON.stringify(value ?? null)) }; },
          error => { early[method] = { shellsOpen, answeredShellsOpen: ipcWiring.ipcShellsOpen(), error: `${(error as Error).name}: ${(error as Error).message}` }; });
    }
  };
}
const started = Date.now();
await import('../../../electron/main');
const parts = await import('../../../electron/wiring/parts-wiring');
const state = (globalThis as Record<string, any>).__softHeartsStandIn;
await state.ready;
// the ready chain: wait until the windows were made and it went past its last step (or failed)
for (let i = 0; i < 1200 && !state.quit && !state.dialogs.length && !state.sent.some((m: any) => m.channel === 'desk:settings'); i++) await new Promise(r => setTimeout(r, 25));
await new Promise(r => setTimeout(r, 200));
const readyMs = Date.now() - started;
const controls = state.windows.find((w: any) => w.role === 'controls');
const call = async (method: string, ...args: unknown[]) => {
  const handler = state.handlers.get(`desk:${method}`);
  if (!handler) return { missing: true };
  try { return { value: JSON.parse(JSON.stringify(await handler({ sender: controls.webContents, senderFrame: controls.webContents.mainFrame }, ...args)) ?? null) }; }
  catch (error) { return { error: `${(error as Error).name}: ${(error as Error).message}` }; }
};

const report: Record<string, unknown> = { readyMs, dialogs: state.dialogs, quit: state.quit, handlers: state.handlers.size, uncaught, loadedAtBoot: [...state.loaded] };
const runner = parts.partRunner();
report.health = runner?.health() ?? null;
if (!state.quit && controls) {
  // one clock tick: which entries ran, in order
  const ran: string[] = [];
  if (runner) {
    const tick = runner.tick.bind(runner);
    runner.tick = ((part: any, unit: string, run: () => unknown) => tick(part, unit, () => { ran.push(`${typeof part === 'string' ? part : part.id}/${unit}`); return run(); })) as typeof runner.tick;
  }
  // wait for the clock's first tick itself (a fixed 1.15 s could pass with no tick under load); a tick is synchronous, so one more macrotask finds it whole
  for (let i = 0; i < 1200 && !ran.length; i++) await new Promise(r => setTimeout(r, 25));
  await new Promise(r => setTimeout(r, 50));
  const firstTick: string[] = [];
  for (const entry of ran) { if (firstTick.includes(entry) && entry === ran[0]) break; firstTick.push(entry); }
  report.clock = firstTick;
  // one chat turn with the stand-in Claude
  const turn = await call('chat', { id: 'stand-in-turn', messages: [{ role: 'user', content: '你好' }], attachments: [], sentAt: Date.now() });
  for (let i = 0; i < 1200; i++) {
    if (state.sent.some((m: any) => m.channel === 'desk:stream' && m.args[0]?.id === 'stand-in-turn' && (m.args[0]?.type === 'done' || m.args[0]?.type === 'error'))) break;
    await new Promise(r => setTimeout(r, 25));
  }
  report.chat = { call: turn, events: state.sent.filter((m: any) => m.channel === 'desk:stream' && m.window === 'controls' && m.args[0]?.id === 'stand-in-turn').map((m: any) => ({ type: m.args[0].type, text: m.args[0].text })) };
  report.claudeCalls = ((globalThis as Record<string, any>).__softHeartsClaudeCalls ?? []).map((c: any) => ({ kind: c.kind, writable: c.writable }));
  // `name` or `name=<json argument>`, separated by `;;`; each answer is reported under its name.
  const methods = (process.env.STAND_IN_METHODS ?? '').split(';;').filter(Boolean);
  const answers: Record<string, unknown> = {};
  for (const entry of methods) { const at = entry.indexOf('='); answers[at < 0 ? entry : entry.slice(0, at)] = at < 0 ? await call(entry) : await call(entry.slice(0, at), JSON.parse(entry.slice(at + 1))); }
  report.methods = answers;
  report.early = early;
  report.shellsOpen = ipcWiring.ipcShellsOpen();
  report.shellsUnfilled = ipcWiring.ipcShellsUnfilled();
  report.loaded = [...state.loaded];
  report.controlsVisible = controls.isVisible();
  // STAND_IN_WAIT_MS: more seconds of the clock before the health is read (a tick that throws is switched off at its third second).
  if (process.env.STAND_IN_WAIT_MS) {
    await new Promise(r => setTimeout(r, Number(process.env.STAND_IN_WAIT_MS)));
    // under load the three ticks can come late: wait until the unit is off (bounded) rather than trust the fixed time
    for (let i = 0; i < 1200 && process.env.SOFT_HEARTS_FAIL_PART && !(runner?.health().off.length); i++) await new Promise(r => setTimeout(r, 25));
  }
  report.health = runner?.health() ?? null;
  report.partHealthIpc = state.handlers.has('desk:getPartHealth') ? await call('getPartHealth') : null;
  report.partHealthSent = state.sent.filter((m: any) => m.channel === 'desk:part-health').map((m: any) => m.window);
  report.userAwaySent = state.sent.filter((m: any) => m.channel === 'desk:user-activity' && m.window === 'pet').map((m: any) => m.args[0]);
}
report.profile = path.relative(state.root, (await import('electron')).app.getPath('userData'));
console.log(`STAND-IN-REPORT ${JSON.stringify(report)}`);
process.exit(0);
