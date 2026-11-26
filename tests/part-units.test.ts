// Which work of which unit runs through the part runner (overhaul step 7, docs/claude/2026-11-17-isolation-step7.md), read from the source:
// - every part's units in shared/foundation/part-health.ts are exactly its PartHandle's `units` (the journal, the notices and get_status read
//   the shared table); core units are units of that part;
// - every startUnit / startUnitSync / tickUnit call names a unit its part declared and that is not core (a core unit's step is not wrapped:
//   it stays fatal as before), in the order pinned below (the ready chain and the clock); the wiring golden reads each call as the step it wraps;
// - every handler a unit's `ipc` lists is a real desk: handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { UNIT_LABELS, partUnits, partOffNotice, PART_OFF_REASON, isPartOffMessage, partHealthTrayLine, partsOffList } from '../shared/foundation/part-health';
import { buildJournalEntry } from '../shared/memory/journal';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const goldenScript: string = '../scripts/dev/wiring-golden.mjs';
const { buildGolden } = await import(goldenScript) as { buildGolden(root: string): any };
const wiringFiles = () => fs.readdirSync(path.join(ROOT, 'electron/wiring')).filter(name => name.endsWith('.ts')).map(name => `electron/wiring/${name}`);
const strings = (node: ts.Expression | undefined): string[] => node && ts.isArrayLiteralExpression(node) ? node.elements.filter(ts.isStringLiteral).map(e => e.text) : [];

interface Declared { id: string; units: string[]; core: string[]; ipc: Record<string, string[]> }
/** Every object literal in electron/wiring/ with `id: '<part>'` and `units: [...]` (each PartHandle, and UNBOUND_PART). */
function declarations(): Declared[] {
  const out: Declared[] = [];
  for (const rel of wiringFiles()) {
    const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const prop = (name: string) => node.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf).replace(/'/g, '') === name)?.initializer;
        const id = prop('id'), units = prop('units');
        if (id && ts.isStringLiteral(id) && units && ts.isArrayLiteralExpression(units)) {
          const ipcNode = prop('ipc');
          const ipc: Record<string, string[]> = {};
          if (ipcNode && ts.isObjectLiteralExpression(ipcNode)) for (const p of ipcNode.properties) if (ts.isPropertyAssignment(p)) ipc[p.name.getText(sf).replace(/'/g, '')] = strings(p.initializer);
          out.push({ id: id.text, units: strings(units), core: strings(prop('core')), ipc });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}
/** Every startUnit / startUnitSync / tickUnit call in the wiring and main.ts, in file order: `<file> <helper> <part>/<unit>`. */
function wrappedSteps(): { file: string; helper: string; part: string; unit: string }[] {
  const out: { file: string; helper: string; part: string; unit: string }[] = [];
  for (const rel of ['electron/main.ts', ...wiringFiles()]) {
    if (rel.endsWith('parts-wiring.ts')) continue;
    const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['startUnit', 'startUnitSync', 'tickUnit'].includes(node.expression.text)) {
        const [part, unit] = node.arguments;
        assert.ok(part && unit && ts.isStringLiteral(part) && ts.isStringLiteral(unit), `${rel}: ${node.getText(sf).slice(0, 80)} names its part and unit as literals`);
        out.push({ file: rel, helper: node.expression.text, part: (part as ts.StringLiteral).text, unit: (unit as ts.StringLiteral).text });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

test('the shared parts table is exactly every part\'s declared units; core units are its own', () => {
  const declared = declarations();
  assert.deepEqual(declared.map(d => d.id).sort(), Object.keys(UNIT_LABELS).sort(), 'one declaration per part of the table');
  for (const d of declared) {
    assert.deepEqual([...d.units].sort(), [...partUnits(d.id)].sort(), `${d.id}: shared/foundation/part-health.ts lists the handle's units`);
    for (const unit of d.core) assert.ok(d.units.includes(unit), `${d.id}: core unit ${unit} is one of its units`);
    for (const unit of Object.keys(d.ipc)) assert.ok(d.units.includes(unit) && !d.core.includes(unit), `${d.id}: ipc unit ${unit} is a unit that can be switched off`);
  }
  // plan section 3: what can never be switched off
  const core = (id: string) => declared.find(d => d.id === id)!.core;
  assert.ok(core('cards').includes('cards'), 'the card store');
  assert.ok(['companion', 'claude-chat', 'chat-turn'].every(u => core('brain').includes(u)), 'CompanionService with the mood host, her chat');
  assert.ok(['pet-window', 'reply-window', 'presentation'].every(u => core('stage').includes(u)), 'the stage core');
  assert.ok(core('safety').includes('crisis-card'), 'the help card');
});

test('every wrapped step names a declared unit that can be switched off; the ready chain\'s and the clock\'s are pinned', () => {
  const declared = new Map(declarations().map(d => [d.id, d]));
  const steps = wrappedSteps();
  for (const s of steps) {
    const d = declared.get(s.part);
    assert.ok(d && d.units.includes(s.unit), `${s.file}: ${s.part}/${s.unit} is declared`);
    assert.ok(!d!.core.includes(s.unit), `${s.file}: ${s.part}/${s.unit} is core; a core step is not wrapped (it stays fatal as before)`);
  }
  // Each unit's start, where it is wrapped (the ready chain calls these functions in its old order; electron/main.ts itself wraps nothing).
  const starts: Record<string, string[]> = {};
  for (const s of steps.filter(s => s.helper !== 'tickUnit')) (starts[s.file] ??= []).push(`${s.part}/${s.unit}`);
  assert.deepEqual(starts, {
    'electron/wiring/actions-wiring.ts': ['actions/motion-library', 'actions/motion-fits'],
    'electron/wiring/cards-ready-wiring.ts': ['cards/stickers', 'cards/personalize-language', 'cards/personalize-language'],
    'electron/wiring/memory-profile-wiring.ts': ['memory/user-profiles', 'memory/text-memorials', 'initiative/r20-offers', 'senses/ambient-audio', 'memory/upcoming',
      'memory/memory-semantic', 'memory/memory-notes'],
    'electron/wiring/mood-wiring.ts': ['mood/blush-calibration', 'mood/realer-expiry', 'mood/fatigue-activity'],
    'electron/wiring/ready-wiring.ts': ['brain/chat-outage', 'initiative/rps', 'initiative/feeding', 'mood/mood-judge', 'mood/reactions', 'initiative/her-folder',
      'initiative/keepsake', 'initiative/special-day'],
    'electron/wiring/safety-wiring.ts': ['safety/claude-tasks', 'safety/test-commands', 'safety/agent-channel'] /* step 8: both made on first use */,
    'electron/wiring/senses-music-wiring.ts': ['senses/music-settings'],
    'electron/wiring/senses-wiring.ts': ['senses/user-activity', 'senses/pose-sensing', 'senses/face-check', 'senses/local-asr'],
    'electron/wiring/stage-body-wiring.ts': ['stage/personalize-authoring', 'stage/personalize-authoring'],
    'electron/wiring/stage-model-wiring.ts': ['stage/physics-settings', 'stage/model-profile', 'stage/model-capability'],
    'electron/wiring/stage-wiring.ts': ['stage/single-emoji'],
    'electron/wiring/unbound-wiring.ts': ['unbound/unbound'],
  });
});

test('the 1-second clock: each entry of a unit runs through the runner, in the old order; her conversation and mood (core) and the scope that gates them do not', () => {
  const clock = wrappedSteps().filter(s => s.file === 'electron/wiring/clock-wiring.ts');
  assert.ok(clock.every(s => s.helper === 'tickUnit'));
  assert.deepEqual(clock.map(s => `${s.part}/${s.unit}`), ['memory/diary', 'memory/period-review', 'memory/her-note', 'mood/fatigue-activity', 'senses/screen-glance',
    'senses/user-activity', 'initiative/moments', 'initiative/inner-loop', 'initiative/impulse', 'senses/face-check', 'initiative/inner-loop', 'initiative/rps', 'senses/proactive-vision']);
  const text = read('electron/wiring/clock-wiring.ts');
  for (const line of ['  const scope = refreshVisionContext();', '  companion.mood.tick(canExpress, {', '  companion.herLifeTick(canExpress);', 'companion?.mood.moments.presence(userActivity?.presence());'])
    assert.ok(text.includes(line), `core clock entry as it was: ${line.trim()}`);
});

/** The function names of each ordered list electron/main.ts gives (wireWindowEvents, wireQuit, wireSettingsSync, wireMoodPublish). */
function listSteps(): Record<string, string[]> {
  const sf = ts.createSourceFile('electron/main.ts', read('electron/main.ts'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Record<string, string[]> = {};
  const names = (node: ts.Node | undefined, into: string[]) => {
    if (!node) return;
    if (ts.isIdentifier(node)) { into.push(node.text); return; }
    if (ts.isArrayLiteralExpression(node)) for (const el of node.elements) {
      if (ts.isArrayLiteralExpression(el) && el.elements.length === 3 && ts.isStringLiteral(el.elements[0])) names(el.elements[2], into); else names(el, into);
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['wireWindowEvents', 'wireQuit', 'wireSettingsSync', 'wireMoodPublish'].includes(node.expression.text)) {
      const into = (out[node.expression.text] ??= []);
      for (const arg of node.arguments) {
        if (ts.isObjectLiteralExpression(arg)) { for (const p of arg.properties) if (ts.isPropertyAssignment(p)) names(p.initializer, into); }
        else names(arg, into);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
/** The steps electron/wiring/steps-wiring.ts gives a unit: `<name>` → `<part>/<unit>`. */
function attributedSteps(): Map<string, string> {
  const rel = 'electron/wiring/steps-wiring.ts';
  const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'unitSteps') {
      const [part, unit, ...steps] = node.arguments;
      for (const step of steps) out.set((step as ts.Identifier).text, `${(part as ts.StringLiteral).text}/${(unit as ts.StringLiteral).text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

test('the ordered lists: every step belongs to a unit that can be switched off, or is named here as running as it is (the trunk\'s, a core unit\'s)', () => {
  const lists = listSteps(), attributed = attributedSteps();
  const declared = new Map(declarations().map(d => [d.id, d]));
  for (const [name, owner] of attributed) {
    const [part, unit] = owner.split('/');
    const d = declared.get(part);
    assert.ok(d && d.units.includes(unit) && !d.core.includes(unit), `${name}: ${owner} is a declared unit that can be switched off`);
    assert.ok(Object.values(lists).some(steps => steps.includes(name)), `${name} is a step of a list`);
  }
  // As they are (their failure stays what it was): the trunk's own steps, and the steps of core units (her chat and conversation, the stage
  // core, the settings, the shell), the card conversion, the cue chain, the initiative's and the together features' disposals, the journal's stop.
  const asTheyAre = ['releaseHiddenCamera', 'publishVisibility', 'notePetWindow', 'onNewDocument', 'guardWindowNavigation', 'stopSurprisePreview', 'petPageGone',
    'closeControlsTools', 'petWindowClosed', 'abortWindowTasks', 'cameraOffWithControls', 'resetPetBody', 'notePetBodyVisible', 'petHidden', 'sendNativeVisibility',
    'releaseCameraOffScreen', 'noteQuitting', 'holdForConversion', 'releasePetWindow', 'markExiting', 'stopClock', 'disposeReplyWindow', 'disposeInitiative',
    'abortAllTasks', 'disposeChat', 'disposeTogether', 'holdForFlush', 'releaseShell', 'waitForChats', 'conversionEnded', 'flushCompanion', 'flushMemoryStores',
    'syncMood', 'syncPetWindow', 'syncWindowVisibility', 'broadcastSettings', 'syncTray', 'publishCue'];
  const all = new Set(Object.values(lists).flat());
  assert.deepEqual([...all].filter(name => !attributed.has(name) && !asTheyAre.includes(name)), [], 'a new step: give it its unit in steps-wiring.ts, or name it here');
  for (const name of asTheyAre) assert.ok(all.has(name) && !attributed.has(name), `${name} runs as it is`);
  assert.ok(lists.wireWindowEvents.length > 30 && lists.wireQuit.length > 30 && lists.wireSettingsSync.length === 12 && lists.wireMoodPublish.length === 7);
});

test('every handler a unit lists is a real desk: handler', () => {
  const golden = buildGolden(ROOT);
  const all = new Set<string>([...golden.handlers.controlOnly, ...golden.handlers.eitherWindow]);
  for (const d of declarations()) for (const [unit, methods] of Object.entries(d.ipc)) for (const method of methods)
    assert.ok(all.has(method), `${d.id}/${unit}: ${method} is a desk: handler`);
});

test('the notices: the plan\'s texts; PART_OFF answers are recognised; closed words only', () => {
  assert.equal(partOffNotice({ part: 'senses', unit: 'face-check', when: 'start' }),
    '感知（认出你）这次没能启动，我先把它单独关掉了，别的都照常。重启 soft hearts 通常就好；还不行的话，点「复制诊断信息」发给 Claude。');
  assert.equal(partOffNotice({ part: 'initiative', unit: 'rps', when: 'running' }), '主动刚才连续出错，先关掉了，别的照常；重启后会再试。');
  assert.equal(partHealthTrayLine({ mode: 'isolate', started: [], off: [] }), '');
  const off = [{ part: 'senses', unit: 'face-check', category: 'start' as const, when: 'start' as const, reason: 'start:TypeError', at: 1 },
    { part: 'senses', unit: 'pose-sensing', category: 'tick' as const, when: 'running' as const, reason: 'tick:Error', at: 2 },
    { part: 'nope', unit: 'x', category: 'tick' as const, when: 'running' as const, reason: 'tick:Error', at: 3 }];
  assert.equal(partHealthTrayLine({ mode: 'isolate', started: [], off }), '有一部分暂时关了：感知、nope');
  assert.deepEqual(partsOffList({ mode: 'isolate', started: [], off }), ['senses/face-check', 'senses/pose-sensing']);
  assert.ok(isPartOffMessage("Error invoking remote method 'desk:getFaceCheck': PartOffError: PART_OFF senses/face-check"));
  assert.ok(!isPartOffMessage('PART_OFFICE'));
  assert.match('start:TypeError', PART_OFF_REASON);
  assert.doesNotMatch('start:Cannot read properties', PART_OFF_REASON);
});

test('the journal\'s part-off line keeps closed words only: a message, an unknown unit or a unit of another part is never written', () => {
  const at = Date.UTC(2026, 10, 17, 3);
  const ok = buildJournalEntry({ type: 'part-off', characterId: 'akiko-1', part: 'senses', unit: 'face-check', failure: 'start:TypeError' }, at);
  assert.ok(ok);
  assert.equal(ok!.reason, '一部分这次没能启动，单独关掉了，别的照常');
  for (const bad of [{ failure: 'start:Cannot read properties of undefined' }, { failure: 'start:TypeError: C:\\x' }, { unit: 'rps' }, { part: 'nope' }, { failure: 'boot:TypeError' }])
    assert.equal(buildJournalEntry({ type: 'part-off', characterId: 'akiko-1', part: 'senses', unit: 'face-check', failure: 'start:TypeError', ...bad } as never, at), null, JSON.stringify(bad));
});
