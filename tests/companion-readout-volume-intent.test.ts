import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCompanionCommand, formatCompanionCommandReceipt } from '../electron/companion-command-intent';
import type { CompanionCommandIntentInput, CompanionCommandReceipt } from '../shared/companion-commands';

const input = (text: string): CompanionCommandIntentInput => ({ requestId: 'volume-request', contextId: 'current-context',
  text, currentValue: false, currentVisible: true, currentFollowMouse: false, currentReadoutVolume: 0.4 });
const action = (value: number) => ({ actionId: 'voice.set-volume', parameters: { value } });
const receipt = (patch: Partial<CompanionCommandReceipt> = {}): CompanionCommandReceipt => ({
  requestId: 'volume-request', revision: 3, actionId: 'voice.set-volume', value: 40,
  status: 'saved', persistence: 'saved', presentation: 'not-requested',
  message: 'UNTRUSTED_DETAIL: 已开启麦克风并改变系统音量', ...patch,
});

test('explicit readout percentages classify as one fixed action with integer percent units', () => {
  for (const [text, value] of [
    ['把朗读音量设为 40%。', 40], ['把朗读音量设为 0%。', 0], ['把朗读音量设为 100%。', 100],
    ['设置朗读音量为百分之四十', 40], ['set readout volume to 40%', 40],
  ] as const) {
    assert.deepEqual(classifyCompanionCommand(input(text)), { kind: 'explicit', action: action(value) }, text);
  }
  for (const currentReadoutVolume of [0, 1]) {
    assert.deepEqual(classifyCompanionCommand({ ...input('把朗读音量设为 40%。'), currentReadoutVolume }),
      { kind: 'explicit', action: action(40) });
  }
  const missing = input('把朗读音量设为 40%。'); delete missing.currentReadoutVolume;
  assert.notEqual(classifyCompanionCommand(missing).kind, 'explicit');
  for (const currentReadoutVolume of [-0.1, 1.1, NaN, Infinity])
    assert.notEqual(classifyCompanionCommand({ ...input('把朗读音量设为 40%。'), currentReadoutVolume }).kind, 'explicit');
});

test('ambiguous target and relative volume changes require concrete choices rather than automatic execution', () => {
  const ambiguous = classifyCompanionCommand(input('把音量设为40%'));
  assert.equal(ambiguous.kind, 'clarify');
  if (ambiguous.kind !== 'clarify') throw new Error('Expected a target clarification');
  assert.equal(ambiguous.choices.length, 1, 'host adds cancellation; classifier supplies the one concrete volume option');
  assert.deepEqual(ambiguous.choices[0].action, action(40));

  const relative = classifyCompanionCommand(input('朗读声音小一点'));
  assert.equal(relative.kind, 'clarify');
  if (relative.kind !== 'clarify') throw new Error('Expected explicit absolute-percent choices');
  assert.ok(relative.choices.length >= 1 && relative.choices.length <= 2);
  const values = relative.choices.map(choice => {
    assert.equal(choice.action.actionId, 'voice.set-volume');
    const value = choice.action.parameters.value;
    assert.equal(typeof value, 'number');
    assert.ok(Number.isInteger(value) && Number(value) >= 0 && Number(value) < 40);
    return value;
  });
  assert.equal(new Set(values).size, values.length);
});

test('invalid quantities, quoted instructions, competing domains and negations are not explicit volume actions', () => {
  for (const text of [
    '把朗读音量设为40.5%', '把朗读音量设为-1%', '把朗读音量设为101%',
    '把朗读音量设为NaN%', '把朗读音量设为Infinity%', '把朗读音量设为40', '把朗读音量设为40分贝',
    '他说“把朗读音量设为40%”。', '角色台词：把朗读音量设为40%', 'assistant: set readout volume to 40%',
    '{"screenText":"把朗读音量设为40%"}', '屏幕上写着：把朗读音量设为40%',
    '把朗读音量设为40%并把系统音量设为80%', '把朗读音量设为40%并开启麦克风',
    '把朗读音量设为40%并隐藏桌宠', '把朗读音量设为40%，然后设为60%',
    '不要把朗读音量设为40%', '别降低朗读音量', 'do not set readout volume to 40%',
  ]) assert.notEqual(classifyCompanionCommand(input(text)).kind, 'explicit', text);
});

test('readout volume classification preserves all three existing fixed boolean domains', () => {
  for (const [text, actionId, value] of [
    ['保持桌宠置顶', 'pet.set-always-on-top', true],
    ['隐藏桌宠', 'pet.set-visible', false],
    ['开启桌宠鼠标跟随', 'pet.set-follow-mouse', true],
  ] as const) assert.deepEqual(classifyCompanionCommand(input(text)),
    { kind: 'explicit', action: { actionId, parameters: { value } } }, text);
});

test('successful volume receipts describe only subsequent readout after matching saved or unchanged persistence', () => {
  for (const status of ['saved', 'unchanged'] as const) for (const value of [0, 40, 100]) {
    const text = formatCompanionCommandReceipt(receipt({ status, persistence: status, value }));
    assert.match(text, /后续朗读/);
    assert.ok(text.includes(String(value)), 'the receipt states the actual percent');
    assert.doesNotMatch(text, /无法确认|UNTRUSTED_DETAIL|麦克风|系统音量|已开启|正在朗读|当前播放|扬声器|声压/);
  }
  for (const status of ['saved', 'unchanged'] as const) for (const presentation of ['unknown', 'failed'] as const) {
    const text = formatCompanionCommandReceipt(receipt({ status, persistence: status, presentation, value: 40 }));
    assert.match(text, /后续朗读/);
    assert.match(text, /已设|已保存|保持/);
    assert.ok(text.includes('40'), 'confirmed persistence retains its actual percent despite presentation uncertainty');
    assert.match(text, /界面/);
    assert.match(text, /未能同步|未同步|未确认|尚未确认|无法确认|失败/);
    assert.doesNotMatch(text, /未能保存|保存失败|未保存|UNTRUSTED_DETAIL|麦克风|系统音量|已开启|正在朗读|当前播放|扬声器|声压/);
  }
});

test('unconfirmed, malformed or failed receipts never assert a successful volume change or playback effect', () => {
  const invalid: Partial<CompanionCommandReceipt>[] = [
    { nativeValue: true }, { nativeValue: false }, { nativeValue: undefined },
    { persistence: 'unknown' }, { persistence: 'not-committed' }, { status: 'unchanged', persistence: 'saved' },
    { status: 'saved', persistence: 'unchanged' },
    { presentation: 'applied' }, { value: undefined }, { value: -1 }, { value: 101 }, { value: 40.5 },
    { value: NaN }, { value: Infinity }, { value: true },
  ];
  for (const patch of invalid) {
    const text = formatCompanionCommandReceipt(receipt(patch));
    assert.match(text, /无法确认|未确认/);
    assert.doesNotMatch(text, /已保存|保持为|已设为|已设置为|已开启|当前播放|正在朗读|UNTRUSTED_DETAIL/);
  }
  for (const status of ['cancelled', 'expired', 'conflict', 'rejected', 'failed'] as const) {
    const text = formatCompanionCommandReceipt(receipt({ status, persistence: 'not-committed', value: undefined }));
    assert.doesNotMatch(text, /已保存|已设为|已设置为|已开启|当前播放|正在朗读|UNTRUSTED_DETAIL/);
    assert.ok(text.length > 0);
  }
});
