/** 体验记录: the fixed words of the rows (shared/stage/smooth-journal.ts: 'gpu-start' and 'frame-time'), Authored copy only. */
export const ENGLISH_SMOOTH_UI_COPY: Readonly<Record<string, string>> = {
  '应用启动时读了一次画面用的显卡': 'Read once at start which graphics chip draws the picture',
  '这台电脑有显卡，但画面是用处理器软件画的': 'This computer has a graphics card, but the picture is drawn in software by the processor',
  '用的是显卡': 'the graphics card is drawing', '没有用上显卡（处理器在画）': 'the graphics card is not used (the processor is drawing)', '没读到用的是什么': 'could not read what is drawing',
  '其他厂商': 'another maker', '机器上有第二块显卡': 'the machine lists a second graphics chip', '机器上只有一块显卡': 'the machine lists one graphics chip', '不知道有几块显卡': 'the number of graphics chips is not known',
  '{0}：{1}（{2}；{3}）': '{0}: {1} ({2}; {3})',
  '她这一分钟的画面画得有多顺': 'How smoothly her picture was drawn this minute',
  '{0}：{1} 帧每秒，中位 {2} 毫秒，p95 {3} 毫秒（画质 {4}，台上 {5} 位，{6}，{7}% 的时间是安静降帧）': '{0}: {1} frames a second, median {2} ms, p95 {3} ms (quality {4}, {5} on stage, {6}, {7}% of the time at the quiet rate)',
  '高': 'high', '中': 'medium', '低': 'low', '你正和她在一起': 'you are with her', '你没和她在一起': 'you are not with her',
};
