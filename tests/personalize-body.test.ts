import { strict as assert } from 'node:assert';
import test from 'node:test';
import { bodyVisualResearchPrompt, parseBodyVisualStudy } from '../shared/personalize-body';

test('body observation keeps occlusion distinct and does not manufacture a pose', () => {
  const output = { observations: [
    { region: 'left-arm', visibility: 'occluded', description: '左臂被遮挡' },
    { region: 'right-arm', visibility: 'visible', description: '右臂靠近身体' },
  ], inferences: [], questions: ['希望表达什么？'], insufficient: '深度未知' };
  const parsed = parseBodyVisualStudy(JSON.stringify(output));
  assert.deepEqual(parsed, output);
  assert.equal('bindingId' in parsed, false);
  assert.throws(() => parseBodyVisualStudy(JSON.stringify({ ...output, bindingId: 'some-resource' })));
  assert.throws(() => parseBodyVisualStudy(JSON.stringify({ ...output, observations: [{ ...output.observations[0], visibility: '0' }] })));
});

test('research prompt contains only bounded data and rejects executable or path-shaped feedback', () => {
  const prompt = bodyVisualResearchPrompt('希望动作轻一些', null);
  assert.match(prompt, /不能根据单图恢复三维深度/);
  assert.throws(() => bodyVisualResearchPrompt('<script>go()</script>', null));
  assert.throws(() => bodyVisualResearchPrompt('C:\\private\\model.pmx', null));
});
