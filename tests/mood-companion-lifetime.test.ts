import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { MoodViewLifetime } from '../src/ui/mood-view-lifetime';
import { uiText, uiTemplate } from '../src/ui/ui-language';

const source = readFileSync(new URL('../src/ui/MoodCompanion.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('MoodCompanion.ts', source, ts.ScriptTarget.Latest, true);
const klass = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'MoodCompanion') as ts.ClassDeclaration;
const wanted = ['applyView', 'refreshView', 'clearFatigueView', 'reset'];
const methods = wanted.map(name => klass.members.find(n => ts.isMethodDeclaration(n) && n.name.getText(ast) === name)!.getText(ast));
const compiled = ts.transpileModule(`const Wrapper = class { ${methods.join('\n')} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const Wrapper = new Function('matchesDirectContactCancellation', 'uiText', 'uiTemplate', `${compiled}\nreturn Wrapper;`)(() => false, uiText, uiTemplate);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const defer = () => { let resolve!: (v: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; };
const view = (characterId: string, token: string, revision: number) => ({ characterId, token, revision, expressions: true, developerMode: false,
  snapshot: { cue: null, primary: 'calm' }, fatigue: { version: 1, A: .8, F: .7, W: .1, phase: 'drowsy', sleepEntryReady: true } });
function fixture() {
  let role = 'a', clears = 0, reads = 0;
  const applied: any[] = [], tickets: string[] = [], pending = [defer(), defer()];
  const object = Object.create(Wrapper.prototype) as any;
  Object.assign(object, { disposed: false, view: null, visible: true, lastSession: '', speechIds: [], viewLifetime: new MoodViewLifetime(),
    options: { isPet: false, getCharacterId: () => role, onView: (v: any) => applied.push(v), onScopeInvalidated() {} },
    inputQueue: { setToken: (token: string) => tickets.push(token), invalidate() {}, push: async () => {} }, touchChannel: { invalidate() {} },
    api: { getMood: () => pending[reads++].promise }, panel: { clearFatigue: () => { clears++; }, update() {}, setVisible() {} },
    storage: {}, container: {}, expressions: { setAttribute() {} }, resetLocal() {}, positionCompact() {}, error() {},
  });
  return { object, pending, applied, tickets, role: (v: string) => { role = v; }, clears: () => clears, reads: () => reads };
}

test('actual Companion methods clear a changed scope and reject its older async result before mapping or Stage callback', async () => {
  const f = fixture(); f.object.applyView(view('a', 'token_a', 1)); assert.equal(f.applied.length, 1);
  const oldRead = f.object.refreshView(); f.role('b'); f.object.reset('context');
  assert.equal(f.object.view.fatigue, undefined); assert.ok(f.clears() > 0); assert.equal(f.tickets.at(-1), '');
  f.pending[0].resolve(view('a', 'token_a', 10)); await oldRead; assert.equal(f.applied.length, 1);
  f.pending[1].resolve(view('b', 'token_b', 11)); await flush(); assert.equal(f.applied.length, 2); assert.equal(f.object.view.characterId, 'b');
  f.object.applyView(view('b', 'other_token', 11)); assert.equal(f.applied.length, 2);
  f.object.applyView(view('a', 'token_a', 10)); assert.equal(f.object.view.characterId, 'b'); assert.equal(f.object.view.fatigue.A, .8);
  f.object.reset('disconnect'); assert.equal(f.reads(), 2, 'An explicit lost source does not start an automatic reconnect loop.');
  assert.equal(f.object.view.fatigue, undefined); assert.equal(f.tickets.at(-1), '');
});

test('actual Companion preserves legacy mood without binding fatigue to an unknown or mismatched active character', () => {
  const f = fixture(); delete f.object.options.getCharacterId;
  f.object.applyView(view('a', 'token_a', 1)); assert.equal(f.applied.length, 1); assert.equal(f.applied[0].fatigue, undefined);
  f.object.options.getCharacterId = () => 'b'; f.object.applyView(view('a', 'token_a', 2));
  assert.equal(f.applied.length, 1); assert.ok(f.clears() > 0);
  f.object.applyView(view('b', 'token_b', 3)); assert.equal(f.applied.length, 2); assert.equal(f.applied[1].fatigue.A, .8);
});
