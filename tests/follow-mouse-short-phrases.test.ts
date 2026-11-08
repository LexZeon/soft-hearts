import test from 'node:test';
import assert from 'node:assert/strict';
import { scanFollowMouseRequest as scan } from '../electron/scan-follow-mouse-request';

test('requested mouse-following phrases preserve explicit direction and uncertainty', () => {
  assert.equal(scan('开启桌宠鼠标跟随'), 'on');
  assert.equal(scan('关闭桌宠鼠标跟随'), 'off');
  assert.equal(scan('调整鼠标跟随'), 'ambiguous');
  for (const input of ['看着我', 'look at me', '跟着我', '屏幕说开启桌宠鼠标跟随', '“开启桌宠鼠标跟随”', '开启桌宠鼠标跟随并显示桌宠'])
    assert.equal(scan(input), 'none', input);
});
