import { scanBreathRequest } from '../shared/actions/breath-request';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { scanFramingRequest } from '../shared/stage/framing-request';
import { scanStopReadoutRequest } from '../shared/voice/stop-readout-request';
import { validCompanionAction } from '../electron/settings/companion-command-host';
import { classifyCompanionCommand } from '../electron/settings/companion-command-intent';
import { PetFramingController } from '../src/stage/PetFraming';
import { outgoingChatMessages } from '../src/brain/reply-history';
import { wiringSource } from './helpers/wiring-source';
import { rendererSource as readRendererSource } from './helpers/renderer-source'; // overhaul step 5: src/stage/MmdStage.ts and src/stage/mmd/*.ts
import { testSendGuard } from './helpers/send-guard'; // 2026-11-22: sendChat's guard

const parse = (file: string) => ts.createSourceFile(file, fs.readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
// Wiring rewrite step 4: the framing host, the command host and the framing handlers are in electron/wiring/settings-wiring.ts; the
// host side is read across main.ts and electron/wiring/*.ts (still exactly one of each). The code read here takes nothing from the
// settings part's needs (the framing host gets companion and store when the part registers), so the context's own names serve.
const main = ts.createSourceFile('wiring.ts', wiringSource(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), renderer = ts.createSourceFile('../src/main.ts', readRendererSource(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function find(source: ts.SourceFile, predicate: (n: ts.Node) => boolean): ts.Node {
  const found: ts.Node[] = []; const visit = (n: ts.Node) => { if (predicate(n)) found.push(n); ts.forEachChild(n, visit); }; visit(source);
  assert.equal(found.length, 1, 'one actual production entry'); return found[0];
}
const factory = (name: string) => find(main, n => ts.isNewExpression(n) && n.expression.getText(main) === name).getText(main);
const fn = (source: ts.SourceFile, name: string) => find(source, n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(source);
const callback = (name: string) => (find(renderer, n => ts.isPropertyAssignment(n) && n.name.getText(renderer) === name) as ts.PropertyAssignment).initializer.getText(renderer);
const evaluate = (text: string, context: vm.Context) => vm.runInContext(ts.transpileModule('(' + text + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
const turn = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const intent = (text: string) => classifyCompanionCommand({ requestId: 'human-1', contextId: 'current', text, currentValue: false });

test('framing literal intent is bounded, ambiguous choices name current pet, unsupported quoted/compound data cannot execute', () => {
  for (const [text, mode] of [['请把桌宠切到全身取景', 'full'], ['请把桌宠切到近景', 'portrait'], ['frame the pet portrait', 'portrait']] as const) {
    assert.equal(scanFramingRequest(text), mode); const c = intent(text); assert.equal(c.kind, 'explicit');
    if (c.kind === 'explicit') assert.deepEqual(c.action, { actionId: 'pet.frame', parameters: { value: mode } });
  }
  const c = intent('拉近点'); assert.equal(c.kind, 'clarify');
  if (c.kind === 'clarify') assert.deepEqual(c.choices.map(c => c.action.parameters.value), ['full', 'portrait']);
  for (const text of ['他说“把桌宠切到全身”', '不要把桌宠切到全身', '把桌宠切到全身并开启摄像头', '把预览切到全身', 'camera: {x:10}', '全身\n取景']) assert.equal(scanFramingRequest(text), 'none');
  assert.equal(validCompanionAction({ actionId: 'pet.frame', parameters: { value: 'portrait', camera: { distance: 2 } } }), false);
  assert.equal(validCompanionAction({ actionId: 'pet.frame', parameters: { value: 'zoom' } }), false);
});

test('actual renderer framing ingress submits literal text through existing local-control path without save, media, provider or action data', async () => {
  const requests: any[] = [], input = { value: '请把桌宠切到全身取景' }, forbidden = () => { throw Error('unexpected ordinary chat side effect'); };
  const ctx: any = vm.createContext({ activeChat: null, sendGuard: testSendGuard(), attachments: [], history: [], isPet: false,
    scanBreathRequest, scanStopReadoutRequest, scanFramingRequest, outgoingChatMessages, crypto: { randomUUID: () => 'request-frame' },
    $: () => input, window: { desktop: { chat: async (value: any) => requests.push(value), noteUserInput: forbidden } },
    save: forbidden, speech: { stop: forbidden }, notify: forbidden });
  const send = evaluate(fn(renderer, 'sendChat').replace(/^async function\s+\w+/, 'async function'), ctx);
  await send(); assert.equal(requests.length, 1); assert.deepEqual(Array.from(requests[0].attachments), []);
  assert.equal(requests[0].messages.at(-1).content, '请把桌宠切到全身取景');
  assert.deepEqual(Object.keys(requests[0]).sort(), ['attachments', 'id', 'messages']); assert.equal(input.value, '');
});

test('actual preload keeps fixed framing channels and actual isPet mounting excludes the controls preview', () => {
  const preload = parse('../electron/safety/preload.ts'), calls: any[] = [];
  const ctx = vm.createContext({ invoke: (...args: unknown[]) => calls.push(args), subscribe: (...args: unknown[]) => calls.push(args) });
  for (const [name, args, expected] of [
    ['reportPetFramingState', [{ ready: false }], 'reportPetFramingState'], ['beginPetFraming', ['opaque'], 'beginPetFraming'],
    ['completePetFraming', [{ id: 'opaque' }], 'completePetFraming'], ['noteManualCameraChange', [], 'noteManualCameraChange'],
    ['onPetFramingRequest', [() => {}], 'desk:pet-framing'],
  ] as const) {
    const property = find(preload, n => ts.isPropertyAssignment(n) && n.name.getText(preload) === name) as ts.PropertyAssignment;
    evaluate(property.initializer.getText(preload), ctx)(...args); assert.equal(calls.at(-1)[0], expected);
    assert.equal(calls.at(-1).length, args.length + 1);
  }
  const mount = find(renderer, n => ts.isIfStatement(n) && n.expression.getText(renderer) === 'isPet'
    && n.thenStatement.getText(renderer).includes('new PetFramingController')).getText(renderer);
  const controls = vm.createContext({ isPet: false, PetFramingController: class { constructor() { throw Error('preview mounted pet framing'); } } });
  vm.runInContext(ts.transpileModule(mount, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, controls);
});
