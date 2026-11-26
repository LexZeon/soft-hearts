/** I-166: the journal's see-and-say lines (shared/senses/see-and-say/words.ts, shared/senses/journal-entries.ts). Authored copy only. */
export const ENGLISH_SEE_AND_SAY_UI_COPY: Readonly<Record<string, string>> = {
  '这一轮她看到了开着的小图': 'This turn she saw small pictures of what is on', '她自己想凑近看': 'She wanted a closer look herself',
  '摄像头和屏幕': 'the camera and the screen', '这一轮一张也没备好': 'none was ready this turn',
  '{0}（{1}：{2}{3}{4}）': '{0} ({1}: {2}{3}{4})', '；{0} 秒后接着说': '; went on after {0} s',
  '看清了': 'saw it clearly', '没看清，接着说了': 'did not see it clearly, went on', '没看（取消了）': 'did not look (cancelled)', '那个没开，没看': 'that one is off, did not look',
  '等太久了': 'took too long', '没拿到画面': 'no picture came', '聊天进程接不上': 'her chat process could not continue', '出错了': 'something failed',
  '你说了别看或关掉了': 'you said not to look, or turned it off', '你又说了一句': 'you said something new', '回复停了': 'the reply stopped',
  // 2026-11-22: why no clear picture came (CLOSER_MISS_WORDS), and a second try
  '那个没开': 'that one is off', '拍的时候关掉了或说了别看': 'it was turned off or held while the picture was taken', '画面来源还没准备好': 'the picture source was not ready',
  '拍到一半被打断了': 'the capture was interrupted', '屏幕或摄像头没给画面': 'the screen or camera gave no picture',
  '拍的时候开关或视觉上下文变了': 'a switch or the vision context changed while it was taken', '拍到了，送出前已经不能用': 'taken, but no longer allowed when it was to go',
  '；试了 {0} 次': '; {0} tries',
  // I-168: her own looks are no longer capped; the self-look row counts them
  '这一小时第 {0} 次': 'look {0} this hour',
};
