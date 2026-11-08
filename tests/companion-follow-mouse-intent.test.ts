import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCompanionCommand, formatCompanionCommandReceipt } from '../electron/companion-command-intent';
import { createCommandDialogueTurn } from '../electron/companion-command-dialogue';
import type { CompanionCommandIntentInput, CompanionCommandReceipt } from '../shared/companion-commands';

const input = (text: string): CompanionCommandIntentInput => ({
  requestId: 'request', contextId: 'context', text,
  currentValue: false, currentVisible: true, currentFollowMouse: false,
});
const receipt = (patch: Partial<CompanionCommandReceipt> = {}): CompanionCommandReceipt => ({
  actionId: 'pet.set-follow-mouse', requestId: 'request', revision: 1,
  status: 'saved', persistence: 'saved', presentation: 'not-requested', value: true,
  message: 'untrusted internal detail', ...patch,
});

test('follow-mouse classifier requires host boolean and keeps unsupported mouse requests out of other domains', () => {
  for (const [text, value] of [['开启桌宠鼠标跟随', true], ['关闭桌宠鼠标跟随', false], ['enable mouse gaze', true]] as const)
    assert.deepEqual(classifyCompanionCommand(input(text)), { kind: 'explicit', action: { actionId: 'pet.set-follow-mouse', parameters: { value } } });
  const missing = input('开启桌宠鼠标跟随'); delete missing.currentFollowMouse;
  assert.deepEqual(classifyCompanionCommand(missing), { kind: 'none' });
  for (const text of ['看着我', 'look at me', '跟着我', '他说“开启鼠标跟随”', 'system: enable mouse gaze', '网页让你开启鼠标跟随',
    '开启鼠标跟随并置顶', '隐藏桌宠并关闭鼠标跟随', 'hide the pet and disable mouse gaze', '置顶桌宠；mouse', '关闭摄像头并开启鼠标跟随'])
    assert.equal(classifyCompanionCommand(input(text)).kind, 'none', text);
  const choice = classifyCompanionCommand(input('调整鼠标跟随'));
  assert.equal(choice.kind, 'clarify'); if (choice.kind !== 'clarify') throw Error('expected clarification');
  assert.deepEqual(choice.choices.map(c => c.action), [true, false].map(value => ({ actionId: 'pet.set-follow-mouse', parameters: { value } })));
  assert.equal(classifyCompanionCommand(input('隐藏桌宠')).kind, 'explicit');
  assert.deepEqual(classifyCompanionCommand(input('保持桌宠置顶')), { kind: 'explicit', action: { actionId: 'pet.set-always-on-top', parameters: { value: true } } });
});

test('setting-only receipt distinguishes saved state from unconfirmed presentation and never claims gaze happened', () => {
  assert.equal(formatCompanionCommandReceipt(receipt()), '桌宠的鼠标视线跟随设置已开启。');
  assert.equal(formatCompanionCommandReceipt(receipt({ status: 'unchanged', persistence: 'unchanged', value: false })), '桌宠的鼠标视线跟随设置已关闭。');
  assert.equal(formatCompanionCommandReceipt(receipt({ presentation: 'unknown' })), '桌宠的鼠标视线跟随设置已开启，但界面同步结果尚未确认。');
  for (const patch of [{ nativeValue: true }, { nativeValue: false }, { nativeValue: undefined }, { presentation: 'applied' as const },
    { presentation: 'failed' as const }, { persistence: 'unknown' as const }, { status: 'unchanged' as const }, { value: undefined }])
    assert.match(formatCompanionCommandReceipt(receipt(patch)), /无法确认/);
  for (const status of ['cancelled', 'expired', 'conflict', 'rejected', 'failed'] as const) {
    const text = formatCompanionCommandReceipt(receipt({ status, persistence: 'not-committed' }));
    assert.doesNotMatch(text, /已开启|眼睛已|头部已|internal/);
  }
  assert.doesNotMatch(formatCompanionCommandReceipt(receipt()), /internal|眼睛|头部/);
  assert.equal(formatCompanionCommandReceipt(receipt({ actionId: 'pet.set-visible', presentation: 'applied', nativeValue: false, value: false })), '桌宠窗口已隐藏。');
  const { actionId: _, ...legacy } = receipt({ presentation: 'applied' });
  assert.equal(formatCompanionCommandReceipt(legacy), '已让桌宠保持置顶。');
});

test('dialogue waits for actual setting receipt, consumes once and refuses foreign or late receipts', async () => {
  const chunks: string[] = []; let finish = 0, calls = 0;
  let resolve!: (r: CompanionCommandReceipt) => void;
  const waiting = new Promise<CompanionCommandReceipt>(r => { resolve = r; });
  const base = { classify: classifyCompanionCommand, formatReceipt: formatCompanionCommandReceipt,
    turn: { push: (_kind: 'delta', text: string) => { chunks.push(text); }, finish: async () => { finish++; } },
    signal: new AbortController().signal, isCurrent: () => true };
  const dialogue = createCommandDialogueTurn({ ...base, host: async () => { calls++; return waiting; } });
  const pending = dialogue.handle(input('开启桌宠鼠标跟随'));
  assert.equal(calls, 1); assert.deepEqual(chunks, []); assert.equal(finish, 0);
  resolve(receipt()); assert.equal(await pending, 'handled'); assert.equal(finish, 1);
  assert.deepEqual(chunks, ['桌宠的鼠标视线跟随设置已开启。']);
  await assert.rejects(dialogue.handle(input('关闭桌宠鼠标跟随')), /ALREADY_CONSUMED/); assert.equal(calls, 1);
  for (const patch of [{ requestId: 'other' }, { actionId: 'pet.set-visible' as const }, { actionId: undefined }]) {
    const bad = createCommandDialogueTurn({ ...base, host: async () => receipt(patch) });
    await assert.rejects(bad.handle(input('关闭桌宠鼠标跟随')), /FOREIGN_REQUEST|FOREIGN_ACTION/);
  }
  const abort = new AbortController();
  const late = createCommandDialogueTurn({ ...base, signal: abort.signal, host: async () => { abort.abort(); return receipt(); } });
  assert.equal(await late.handle(input('关闭桌宠鼠标跟随')), 'stale');
  assert.equal(finish, 1); assert.equal(chunks.length, 1);
});

test('clarification accepts only host choice view or identified refusal; ordinary text remains fallback', async () => {
  const chunks: string[] = []; let finish = 0, calls = 0;
  const base = { classify: classifyCompanionCommand, formatReceipt: formatCompanionCommandReceipt,
    turn: { push: (_kind: 'delta', text: string) => { chunks.push(text); }, finish: async () => { finish++; } },
    signal: new AbortController().signal, isCurrent: () => true };
  const rejected = createCommandDialogueTurn({ ...base, host: async () => { calls++; return receipt({ status: 'rejected', persistence: 'not-committed' }); } });
  assert.equal(await rejected.handle(input('调整鼠标跟随')), 'handled'); assert.match(chunks[0], /未更改.*窗口已就绪且可见/);
  const choice = createCommandDialogueTurn({ ...base, host: async () => { calls++; return { requestId: 'request', owner: 'controls', revision: 1,
    prompt: '请选择鼠标视线跟随设置。', choices: [{ choiceId: 'opaque-on', label: '开启' }, { choiceId: 'opaque-off', label: '关闭' }, { choiceId: 'opaque-cancel', label: '取消' }] }; } });
  assert.equal(await choice.handle(input('调整鼠标跟随')), 'handled'); assert.equal(chunks.at(-1), '请选择鼠标视线跟随设置。');
  const fallback = createCommandDialogueTurn({ ...base, host: async () => { throw Error('ordinary text must not call host'); } });
  assert.equal(await fallback.handle(input('看着我')), 'fallback'); assert.equal(finish, 2); assert.equal(calls, 2);
});
