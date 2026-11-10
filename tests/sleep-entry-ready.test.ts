// 2026-11-09: since the fork baseline she could only ever get drowsy. main.ts kept the sleep-entry
// activity "not initialized" forever (fatigueActivityReady was never set true), so FatigueActivityBridge published CLOSED
// (chat, speech and manual motion all "on") and every drowsy night ended at the door. Older tests injected the flag as true and
// never saw it. This file checks the one wiring line, then what it changes: with the real state open she falls asleep, closed she
// cannot.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { FatigueActivityBridge } from '../electron/fatigue-activity';
import { FatigueHost } from '../electron/fatigue-host';
import type { SleepEntryBlockers } from '../shared/fatigue';

const channels = { D: 50, O: 50, E: 50, N: 50, C: 50 };

test('main.ts opens the sleep-entry activity at startup, before its first sync (and nowhere sets it true later by accident)', async () => {
  const source = await readFile(path.join(import.meta.dirname, '..', 'electron', 'main.ts'), 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sets: Array<{ value: string; at: number }> = [];
  let firstSelection = -1;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left) && node.left.text === 'fatigueActivityReady') sets.push({ value: node.right.getText(ast), at: node.getStart(ast) });
    if (ts.isCallExpression(node) && node.getText(ast) === 'fatigueActivity.setSelection(store.current)' && firstSelection < 0) firstSelection = node.getStart(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const opens = sets.filter(set => set.value === 'true');
  assert.equal(opens.length, 1, 'exactly one place marks the activity ready');
  assert.ok(firstSelection > 0, 'the startup selection call is still there');
  assert.ok(opens[0].at < firstSelection, 'ready is set before the startup selection and its sync');
  assert.ok(sets.some(set => set.value === 'false' && set.at > opens[0].at), 'exit still closes it again');
});

test('the bridge: ready and idle publishes no blocker; not ready publishes all three', async () => {
  const published: SleepEntryBlockers[] = [];
  const bridge = new FatigueActivityBridge(value => published.push(value), async () => false);
  bridge.setActivity({ initialized: false, chat: false, tts: false });
  bridge.setSelection({ motion: null, motionLayers: {} } as any);
  assert.deepEqual(bridge.current(), { chat: true, tts: true, manualMotion: true });
  bridge.setActivity({ initialized: true, chat: false, tts: false });
  assert.deepEqual(bridge.current(), { chat: false, tts: false, manualMotion: false });
  assert.deepEqual(published.at(-1), { chat: false, tts: false, manualMotion: false });
});

async function drowsyNight(blockers: SleepEntryBlockers): Promise<string[]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'soft-hearts-fatigue-ready-'));
  let mono = 0, wall = 1_790_000_000_000;
  const clock = { monotonicMs: () => mono, wallMs: () => wall, localMinute: () => 180 }; // 03:00, the middle of her night
  try {
    await writeFile(path.join(dir, 'fatigue-state.json'), JSON.stringify({ version: 1,
      profiles: [{ characterId: 'gene', A: 0.83, F: 0.69, W: 0, phase: 'drowsy', wallMs: wall }] })); // last night's numbers
    const host = new FatigueHost(dir, clock); await host.load();
    host.setBlockers(blockers);
    const phases = [host.activate('gene', channels, channels).phase];
    for (let i = 0; i < 40 * 12; i++) { mono += 5_000; wall += 5_000; const view = host.update('gene', channels, channels); if (view && view.phase !== phases.at(-1)) phases.push(view.phase); }
    return phases;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('a drowsy night with nothing going on: open, she falls asleep within 40 minutes; closed (the old wiring), she never does', async () => {
  const open = await drowsyNight({ chat: false, tts: false, manualMotion: false });
  assert.ok(open.includes('falling-asleep'), open.join(' → '));
  assert.equal(open.at(-1), 'asleep', open.join(' → '));
  const closed = await drowsyNight({ chat: true, tts: true, manualMotion: true });
  assert.deepEqual(closed, ['drowsy'], 'with every blocker on she stays drowsy, as she did every night until now');
});
