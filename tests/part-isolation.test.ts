// One part failing switches off only that part (overhaul step 7, docs/claude/2026-11-17-isolation-step7.md; plan section 3 "测试"): the whole
// app (electron/main.ts with every wireX, the ready chain, the clock) runs under node with Electron and Claude stand-ins
// (tests/helpers/app-stand-in/: no window, no process, no real Claude call), once without a failure and once per unit that has a start, with
// SOFT_HEARTS_FAIL_PART=<part>:<unit> (honoured only unpackaged in a temporary profile). For each:
//   - the app starts (no fatal dialog, no quit), and only that unit is off, reason `start:InjectedPartFailure`;
//   - a chat turn with the stand-in Claude completes (kind chat, never writable);
//   - the 1-second clock's entries are the run without a failure, minus that unit's;
//   - its desk: handlers answer PART_OFF, and getPartHealth says it is off;
//   - a privacy action (put back from the bin) refuses as a whole while a unit that owns data is off, and only then.
// Flaky under the full suite's load (11-17): fixed waits (a 1.15 s clock window, 3 s chat, 5 s boot, 90 s per run) were exceeded when the machine was
// busy. The stand-in now waits for the events (first clock tick, chat done, unit off) with generous bounds, and the per-run kill and test timeouts are larger.
// Two clock units are switched off by their ticks (three in a row), and the host's user-away signal reaches the companion window.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { PRIVACY_PART_OFF_MESSAGE } from '../shared/foundation/part-health';
import { inBatches, runStandIn, standInTimeout, type StandInReport } from './helpers/app-stand-in/spawn';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const wiringFiles = () => fs.readdirSync(path.join(ROOT, 'electron/wiring')).filter(name => name.endsWith('.ts') && name !== 'parts-wiring.ts').map(name => `electron/wiring/${name}`);
const strings = (node: ts.Expression | undefined): string[] => node && ts.isArrayLiteralExpression(node) ? node.elements.filter(ts.isStringLiteral).map(e => e.text) : [];

/** Each unit's handlers (PartHandle `ipc`), and every unit whose start runs through the runner (startUnit / startUnitSync), from the source. */
function sourceFacts() {
  const ipc = new Map<string, string[]>(), starts = new Set<string>(), privacy = new Set<string>();
  for (const rel of wiringFiles()) {
    const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const prop = (name: string) => node.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf).replace(/'/g, '') === name)?.initializer;
        const id = prop('id'), map = prop('ipc');
        if (id && ts.isStringLiteral(id) && prop('units') && map && ts.isObjectLiteralExpression(map))
          for (const p of map.properties) if (ts.isPropertyAssignment(p)) ipc.set(`${id.text}:${p.name.getText(sf).replace(/'/g, '')}`, strings(p.initializer));
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['startUnit', 'startUnitSync'].includes(node.expression.text)) {
        const [part, unit] = node.arguments as unknown as ts.StringLiteral[];
        starts.add(`${part.text}:${unit.text}`);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'PRIVACY_STORE_UNITS') {
        const init = node.initializer && ts.isSatisfiesExpression(node.initializer) ? node.initializer.expression : node.initializer;
        const object = init && ts.isAsExpression(init) ? init.expression : init;
        if (object && ts.isObjectLiteralExpression(object)) for (const p of object.properties) if (ts.isPropertyAssignment(p)) { const owner = strings(p.initializer); if (owner.length === 2) privacy.add(owner.join(':')); }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { ipc, starts: [...starts].sort(), privacy };
}
const FACTS = sourceFacts();
const chatCompleted = (report: StandInReport) => {
  const events = report.chat?.events ?? [];
  return events.some(e => e.type === 'delta' && e.text === '好哒。') && events.at(-1)?.type === 'done'
    && (report.claudeCalls ?? []).length > 0 && (report.claudeCalls ?? []).every(c => c.kind === 'chat' && c.writable === false);
};
const unitEntry = (unit: string) => unit.replace(':', '/');
/** 「允许记录」 turned off from the control window (no revision: refused by its own check when nothing refuses it before). */
const RECORDING_OFF = 'setUserProfileEnabled={"enabled":false}';

let baseline: StandInReport;
test('without a failure: the app runs in isolate mode, nothing is off, she chats, the clock ticks', { timeout: standInTimeout(1) }, async () => {
  baseline = await runStandIn({ methods: ['restoreRecycleEntry', RECORDING_OFF] });
  assert.deepEqual(baseline.dialogs, []);
  assert.equal(baseline.quit, false);
  assert.equal(baseline.health?.mode, 'isolate');
  assert.deepEqual(baseline.health?.off, []);
  assert.ok(chatCompleted(baseline), JSON.stringify(baseline.chat));
  assert.ok((baseline.clock ?? []).length >= 8, `the clock ran: ${baseline.clock}`);
  assert.match(String(baseline.methods?.restoreRecycleEntry?.error), /回收站里没有这一项/, 'with every part on the bin answers as before');
  assert.ok(!String(baseline.methods?.setUserProfileEnabled?.error ?? '').includes(PRIVACY_PART_OFF_MESSAGE), '「允许记录」 off is not refused with every part on');
  assert.ok(FACTS.starts.length >= 30, `units with a start: ${FACTS.starts.length}`);
});

test('each unit with a start, failing: only it is off; she still chats; the clock is the same minus it; its handlers answer PART_OFF', { timeout: 1_800_000 }, async () => {
  assert.ok(baseline, 'the run without a failure came first');
  const results = await inBatches(FACTS.starts, 4, async unit => ({ unit, report: await runStandIn({ failPart: unit, methods: [...(FACTS.ipc.get(unit) ?? []), 'restoreRecycleEntry', RECORDING_OFF] }) }));
  const problems: string[] = [];
  for (const { unit, report } of results) {
    const say = (what: string) => problems.push(`${unit}: ${what}`);
    if (report.dialogs.length || report.quit) { say(`fatal: ${JSON.stringify(report.dialogs)}`); continue; }
    const off = (report.health?.off ?? []).map(entry => `${entry.part}:${entry.unit} ${entry.reason}`);
    if (JSON.stringify(off) !== JSON.stringify([`${unit} start:InjectedPartFailure`])) say(`off ${JSON.stringify(off)}`);
    if (!chatCompleted(report)) say(`chat ${JSON.stringify(report.chat)}`);
    const expected = (baseline.clock ?? []).filter(entry => entry !== unitEntry(unit));
    if (JSON.stringify(report.clock) !== JSON.stringify(expected)) say(`clock ${JSON.stringify(report.clock)}`);
    for (const method of FACTS.ipc.get(unit) ?? []) {
      const answer = report.methods?.[method];
      if (!answer || !/PART_OFF/.test(String(answer.error))) say(`${method} answered ${JSON.stringify(answer)}`);
    }
    if (!report.partHealthIpc?.value?.off.some(entry => `${entry.part}:${entry.unit}` === unit)) say('getPartHealth does not say it is off');
    const bin = String(report.methods?.restoreRecycleEntry?.error);
    if (FACTS.privacy.has(unit) ? !bin.endsWith(PRIVACY_PART_OFF_MESSAGE) : bin.includes(PRIVACY_PART_OFF_MESSAGE)) say(`the bin answered ${bin}`);
    // 「允许记录」 off: refused before the switch flips while a data owner is off (user-profiles itself answers PART_OFF)
    const recording = String(report.methods?.setUserProfileEnabled?.error ?? '');
    if (unit === 'memory:user-profiles' ? !/PART_OFF/.test(recording) : FACTS.privacy.has(unit) ? !recording.endsWith(PRIVACY_PART_OFF_MESSAGE) : recording.includes(PRIVACY_PART_OFF_MESSAGE))
      say(`「允许记录」 off answered ${recording}`);
    if (report.uncaught.length) say(`uncaught ${JSON.stringify(report.uncaught)}`);
  }
  assert.deepEqual(problems, []);
  assert.ok(results.some(r => FACTS.privacy.has(r.unit)), 'at least one data owner was switched off');
});

test('a clock unit whose tick throws: off after three seconds, alone; she still chats', { timeout: standInTimeout(1) }, async () => {
  for (const unit of ['memory:diary', 'initiative:impulse']) {
    const report = await runStandIn({ failPart: unit, waitMs: 3_500 });
    assert.deepEqual(report.dialogs, []);
    assert.deepEqual((report.health?.off ?? []).map(entry => `${entry.part}:${entry.unit} ${entry.reason}`), [`${unit} tick:InjectedPartFailure`]);
    assert.ok(chatCompleted(report), unit);
  }
});

test('the user away for over two minutes: the pet window is told (its stage then draws at the away pace)', { timeout: standInTimeout(1) }, async () => {
  const report = await runStandIn({ idleSeconds: 200 });
  assert.ok((report.userAwaySent ?? []).some(view => JSON.stringify(view) === JSON.stringify({ enabled: true, away: true })), JSON.stringify(report.userAwaySent));
  assert.ok(!(baseline.userAwaySent ?? []).some(view => (view as { away?: boolean }).away === true), 'idle 0: never away');
});
