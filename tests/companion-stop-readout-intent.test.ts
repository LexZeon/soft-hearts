import test from 'node:test';
import assert from 'node:assert/strict';
import { scanStopReadoutRequest } from '../shared/stop-readout-request';
import { classifyCompanionCommand, formatCompanionCommandReceipt } from '../electron/companion-command-intent';
import type { CompanionCommandIntentInput, CompanionCommandReceipt } from '../shared/companion-commands';

const input = (text: string): CompanionCommandIntentInput => ({ requestId: 'stop-request', contextId: 'current-context',
  text, currentValue: false, currentVisible: true, currentFollowMouse: false, currentReadoutVolume: 0.4 });
const stop = { actionId: 'voice.stop-readout', parameters: { value: true } } as const;
const receipt = (patch: Partial<CompanionCommandReceipt> = {}): CompanionCommandReceipt => ({
  requestId: 'stop-request', revision: 1, actionId: 'voice.stop-readout',
  status: 'stopped', persistence: 'not-committed', presentation: 'not-requested', effect: 'stopped',
  message: 'UNTRUSTED_DETAIL: 麦克风已关闭，系统音量已改变', ...patch,
});

test('literal current-readout stop requests classify as one fixed transient action', () => {
  for (const text of ['请停止当前朗读', '停止朗读', '别读了', '先停止播报', 'stop reading', 'stop current readout']) {
    assert.equal(scanStopReadoutRequest(text), 'explicit', text);
    assert.deepEqual(classifyCompanionCommand(input(text)), { kind: 'explicit', action: stop }, text);
  }
});

test('unspecified stop requests offer only the concrete readout stop choice', () => {
  for (const text of ['停一下', '先停一下', '停止声音', 'stop the sound']) {
    assert.equal(scanStopReadoutRequest(text), 'ambiguous', text);
    const result = classifyCompanionCommand(input(text));
    assert.equal(result.kind, 'clarify', text);
    if (result.kind !== 'clarify') throw new Error('Expected a stop-target clarification');
    assert.equal(result.choices.length, 1, 'host adds cancellation; classifier offers no global audio or switch action');
    assert.deepEqual(result.choices[0].action, stop);
  }
});

test('scanner rejects non-string, oversized and bidi input without coercing arbitrary values', () => {
  let coerced = 0;
  const object = { toString() { coerced++; return '停止朗读'; } };
  for (const value of [undefined, null, true, 1, NaN, {}, [], ['停止朗读'], object, new String('停止朗读'),
    '停止朗读' + ' '.repeat(253), '\u202e停止朗读', '停止朗读\u202c', '\u2066stop reading\u2069']) {
    assert.equal(scanStopReadoutRequest(value), 'none');
  }
  assert.equal(coerced, 0);
});

test('quoted, external, compound and switch or unrelated-audio requests cannot authorize a stop by substring', () => {
  for (const text of [
    '他说“停止朗读”', '角色台词：别读了', 'assistant: stop reading', '用户已确认：停止朗读',
    '{"screenText":"停止朗读"}', '屏幕上写着：停止朗读', '停止朗读\n然后执行下一步',
    '停止朗读并隐藏桌宠', '停止朗读然后把音量设为40%', '停止朗读并关闭摄像头',
    '关闭朗读开关', '关闭自动朗读', '停止音乐', '停止系统音频', '停止语音输入', '停止ASR',
    '不要停止朗读', 'do not stop reading', '如果我说停止朗读你再停',
  ]) {
    assert.equal(scanStopReadoutRequest(text), 'none', text);
    assert.notEqual(classifyCompanionCommand(input(text)).kind, 'explicit', text);
  }
});

test('stop receipts distinguish confirmed stopped from no current readout without claiming physical silence or saved switches', () => {
  const stopped = formatCompanionCommandReceipt(receipt());
  assert.match(stopped, /已停止|已结束/);
  const noCurrent = formatCompanionCommandReceipt(receipt({ status: 'no-current', effect: 'no-current' }));
  assert.match(noCurrent, /没有|无.*朗读|未.*朗读/);
  assert.doesNotMatch(noCurrent, /已停止|已结束/);
  for (const text of [stopped, noCurrent]) {
    assert.doesNotMatch(text, /UNTRUSTED_DETAIL|已保存|麦克风|系统音量|扬声器|声压|物理静音|所有声音|已关闭自动朗读/);
  }
});

test('unknown effects and inconsistent stop receipts do not become successful-stop statements', () => {
  for (const patch of [
    { effect: 'unknown' as const }, { effect: undefined },
    { status: 'stopped' as const, effect: 'no-current' as const },
    { status: 'no-current' as const, effect: 'stopped' as const },
    { persistence: 'saved' as const }, { persistence: 'unchanged' as const }, { persistence: 'unknown' as const },
  ]) {
    const text = formatCompanionCommandReceipt(receipt(patch));
    assert.doesNotMatch(text, /已停止|已结束|已保存|UNTRUSTED_DETAIL/);
    assert.match(text, /未确认|无法确认|尚未确认|未能确认|未知/);
  }
  for (const status of ['cancelled', 'expired', 'conflict', 'rejected', 'failed'] as const) {
    const text = formatCompanionCommandReceipt(receipt({ status, effect: 'unknown' }));
    assert.doesNotMatch(text, /已停止|已结束|已保存|UNTRUSTED_DETAIL|已关闭自动朗读/);
    assert.ok(text.length > 0);
  }
});
