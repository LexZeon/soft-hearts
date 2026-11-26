/**
 * I-135 认出"不是你": what the user reads (the switch's explanation, states, notices, in Chinese and English) and the journal row
 * (five counts, nothing else; anything more is refused).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { faceExplainText, faceNoticeText, faceStatusText } from '../src/senses/FaceCheckPanel';
import { setUiLanguage } from '../shared/foundation/ui-language';
import { FACE_CHECK_NOTICES, FACE_CHECK_PHASES, OFF_FACE_CHECK_VIEW, parseFaceCheckView, type FaceCheckView } from '../shared/senses/face-check';
import { buildJournalEntry, describeJournalEntry, journalReason } from '../shared/memory/journal';
import { ENGLISH_JOURNAL_UI_COPY } from '../shared/foundation/ui-copy.journal.en';

const view: FaceCheckView = { enabled: true, phase: 'idle', downloadBytes: 10_129_522, installedBytes: 0, progress: null, enrolled: 0, enrolling: null, camera: true, active: false, notice: '' };
const plain = (source: string, ...items: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_, i: string) => String(items[Number(i)]));

test('the explanation beside the switch says what is stored, where, deleting, off by default, and only "is it you"', () => {
  setUiLanguage('zh-CN');
  const text = faceExplainText(view);
  for (const fact of ['一串数字，不是照片', '只存在这台电脑上', '加密保存', '一键删除', '不认别人是谁', '也不存别人', '默认关闭', '约 10 MB', '拿不准时都当成是你', '偏爱只给你'])
    assert.ok(text.includes(fact), fact);
  assert.equal(faceStatusText({ ...view, enabled: false }), '', 'off: no status line');
  assert.match(faceStatusText(view), /还没登记你的脸/);
  assert.equal(faceStatusText({ ...view, enrolling: 0.4 }), '请看着摄像头… 40%');
  assert.match(faceStatusText({ ...view, enrolled: 5 }), /已登记（5 组数字）。摄像头开着时/);
  assert.match(faceStatusText({ ...view, enrolled: 5, camera: false }), /摄像头关着，现在不会看/);
  assert.equal(faceStatusText({ ...view, phase: 'downloading', progress: 0.5 }), '正在下载识别组件… 50%');
  for (const phase of FACE_CHECK_PHASES) assert.equal(typeof faceStatusText({ ...view, phase }), 'string');
  for (const notice of FACE_CHECK_NOTICES) if (notice) assert.ok(faceNoticeText(notice).length > 4, notice);
  assert.ok(!/onnx|YuNet|SFace|embedding|DLL|error/i.test([...FACE_CHECK_NOTICES.map(faceNoticeText), text].join()), 'no technical words');
});

test('English copy exists for the explanation, states and notices', () => {
  setUiLanguage('en');
  try {
    assert.match(faceExplainText(view), /a list of numbers, not a photo/);
    for (const text of [faceStatusText(view), faceStatusText({ ...view, enrolled: 3 }), ...FACE_CHECK_NOTICES.filter(Boolean).map(faceNoticeText)])
      assert.ok(!/[一-鿿]/.test(text), text);
  } finally { setUiLanguage('zh-CN'); }
});

test('the view parser accepts only exact keys and closed values', () => {
  assert.ok(parseFaceCheckView(view));
  assert.ok(parseFaceCheckView(OFF_FACE_CHECK_VIEW));
  assert.equal(parseFaceCheckView({ ...view, score: 0.3 }), null);
  assert.equal(parseFaceCheckView({ ...view, phase: 'watching' }), null);
  assert.equal(parseFaceCheckView({ ...view, enrolled: 1.5 }), null);
  assert.equal(parseFaceCheckView({ ...view, notice: '<b>x</b>' }), null);
});

test('journal: five counts only; anything else is refused; plain words in both languages', () => {
  const entry = buildJournalEntry({ type: 'face-check', characterId: 'gene', matched: 12, notYou: 2, unsure: 5, skipped: 1, stranger: 1 }, Date.UTC(2026, 10, 14, 12));
  assert.ok(entry);
  const text = describeJournalEntry(entry!, plain);
  assert.match(text, /她认出坐在电脑前的不是你（认出你 12 次，明显不是你 2 次，拿不准当成你 5 次，跳过 1 次，当成陌生人 1 回）/);
  assert.equal(journalReason({ type: 'face-check', characterId: null, matched: 3, notYou: 0, unsure: 0, skipped: 0, stranger: 0 }), '她看了看是不是你');
  const row = (extra: Record<string, unknown>) => buildJournalEntry({ type: 'face-check', characterId: 'gene', matched: 1, notYou: 0, unsure: 0, skipped: 0, stranger: 0, ...extra }, 0);
  for (const bad of [{ matched: -1 }, { notYou: 1.5 }, { stranger: '1' }, { unsure: null }]) assert.equal(row(bad), null, JSON.stringify(bad));
  for (const extra of [{ similarity: 0.2 }, { embedding: [1, 2] }, { picture: 'data:image/jpeg;base64,AAAA' }]) {
    const kept = row(extra);
    assert.ok(kept, 'the counts are kept…');
    assert.ok(!(Object.keys(extra)[0] in kept!), '…and anything else is dropped');
  }
  for (const key of ['她认出坐在电脑前的不是你', '她看了看是不是你', '认出你 {0} 次，明显不是你 {1} 次，拿不准当成你 {2} 次，跳过 {3} 次，当成陌生人 {4} 回'])
    assert.ok(ENGLISH_JOURNAL_UI_COPY[key], key);
});
