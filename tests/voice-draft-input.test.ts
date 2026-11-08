import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceDraftInput } from '../src/ui/VoiceDraftInput';
test('two cancelled groups cannot overwrite one recovered input; only the same group can update it', () => {
  const recovery = new VoiceDraftInput(), input = { value: '' }, fallback: string[] = [];
  for (const [key, text] of [['epoch/group-a', '第一组原文'], ['epoch/group-b', '第二组原文'], ['epoch/group-c', '第三组原文']])
    if (!recovery.place(input, key, text)) fallback.push(text);
  assert.equal(input.value, '第一组原文'); assert.deepEqual(fallback, ['第二组原文', '第三组原文']);
  assert.equal(recovery.place(input, 'epoch/group-a', '第一组完整原文'), true);
  assert.equal(input.value, '第一组完整原文');
  assert.equal(recovery.place(input, 'new-epoch/group-a', '另一代原文'), false);
});
test('manual text survives recovery and scope clear; clear removes only this path owned text', () => {
  const recovery = new VoiceDraftInput(), input = { value: '用户手打草稿' };
  assert.equal(recovery.place(input, 'a', '语音A'), false); assert.equal(input.value, '用户手打草稿');
  recovery.clear(input); assert.equal(input.value, '用户手打草稿');
  input.value = ''; assert.equal(recovery.place(input, 'a', '语音A'), true);
  input.value = '用户修改后的内容'; assert.equal(recovery.place(input, 'a', '更新语音A'), false);
  recovery.clear(input); assert.equal(input.value, '用户修改后的内容');
  input.value = ''; recovery.place(input, 'b', '语音B'); recovery.clear(input); assert.equal(input.value, '');
});
