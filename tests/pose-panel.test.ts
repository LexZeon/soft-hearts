import test from 'node:test';
import assert from 'node:assert/strict';
import { poseDetailsText, poseNoticeText, posePromptText, poseStatusText } from '../src/ui/PoseSensingPanel';
import { setUiLanguage } from '../shared/ui-language';
import { POSE_NOTICES, POSE_PHASES, type PoseSensingView } from '../shared/pose-signals';

const view: PoseSensingView = { phase: 'not-installed', prompt: true, downloadBytes: 170_023_451, installedBytes: 0, progress: null, route: null, level: null, componentVersion: 1, notice: '' };

test('the one question: plain words, the real size, local-only, nothing saved', () => {
  setUiLanguage('zh-CN');
  assert.equal(posePromptText(view), '想让我看见你，需要先下载约 170 MB 的本地识别组件。它只在你的电脑上运行，画面不会离开这台电脑，也不会被保存。现在下载吗？');
  assert.equal(poseStatusText({ ...view, phase: 'downloading', progress: 0.42 }), '正在下载本地识别组件… 42%');
  assert.equal(poseStatusText({ ...view, phase: 'running' }), '摄像头感知开启中 · 画面只在本机处理，不保存、不上传');
  assert.equal(poseDetailsText({ ...view, phase: 'running', installedBytes: 132_492_252, route: 'gpu' }), '已安装 132 MB · 组件版本 1 · 加速：显卡');
  for (const phase of POSE_PHASES) assert.equal(typeof poseStatusText({ ...view, phase }), 'string');
  for (const notice of POSE_NOTICES) if (notice) assert.ok(poseNoticeText(notice).length > 4, notice);
  assert.ok(!/DirectML|onnx|DLL|error/i.test(POSE_NOTICES.map(n => poseNoticeText(n)).join()), 'no technical words in what the user reads');
});

test('English copy exists for the question and the states', () => {
  setUiLanguage('en');
  try {
    assert.match(posePromptText(view), /^To see you I first need a local recognition component of about 170 MB\./);
    assert.match(poseStatusText({ ...view, phase: 'idle' }), /^The local recognition component is ready/);
    for (const notice of POSE_NOTICES) if (notice) assert.ok(!/[一-鿿]/.test(poseNoticeText(notice)), notice);
  } finally { setUiLanguage('zh-CN'); }
});
