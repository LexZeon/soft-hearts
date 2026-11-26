/** 体验记录: the fixed words of the 2026-11-24 voice-gap rows (shared/voice/voice-gaps-journal.ts, shared/brain/stream-gaps-journal.ts, the new cancel causes and the first-char timer note). Authored copy only. */
export const ENGLISH_VOICE_GAPS_UI_COPY: Readonly<Record<string, string>> = {
  // speech row: the error kind, the retry, which reply and sentence
  '连不上服务': 'could not reach the service', '等太久超时了': 'timed out', '被停掉了': 'was stopped', '服务拒绝了这次请求（4xx）': 'the service refused the request (4xx)',
  '服务那边出错了（5xx）': 'the service failed (5xx)', '服务没有给出声音': 'the service gave no sound', '其他原因': 'another reason',
  '重试了一次还是不行': 'tried a second time and it still failed', '第 {0} 条回复': 'reply {0}', '第 {0} 条回复的第 {1} 句': 'sentence {1} of reply {0}',
  '，重试一次后仍然失败': ', and still failed after one retry',
  // the causes of a cancelled reading (the first six had no English line until now)
  '她的下一条回复开始了': 'her next reply began', '你打断了她': 'you interrupted her', '电话挂断了': 'the call ended', '叫停了朗读': 'the reading was stopped',
  '朗读出错': 'the reading failed', '这条回复被换掉了（合并、换了上下文）': 'this reply was replaced (merged, or the context changed)',
  '你开口说话了': 'you started speaking', '桌宠窗口收起了': 'her window was put away', '换了模式、声音或设置': 'the mode, the voice or a setting changed', '窗口关了': 'the window closed',
  '你走开了，朗读安静结束': 'you stepped away and the reading ended quietly', '有一条取消的路没记原因': 'a cancel path that gave no reason',
  // 2026-11-24 12:26: why a reply that was shown was never read
  '你的下一句话先到了，这条没交给声音': 'your next line arrived first, so this reply was not handed to her voice', '这条回复没有语气评估，没交给声音': 'this reply had no mood reading, so it was not handed to her voice',
  '这段话没处理完整，这条没交给声音': 'your passage was not fully handled, so this reply was not handed to her voice', '交给声音以后，声音一直没来要第一句': 'handed to her voice, which never asked for the first sentence',
  '窗口没显示，这条没读': 'the window was not showing, so it was not read', '新的一轮已经开始，这条没读': 'a new turn had already begun, so it was not read', '气泡还没就绪，这条没读': 'the bubble was not ready, so it was not read',
  // per-sentence timing
  '这条回复每一句的合成和空档时间': 'Synthesis time and gaps for each sentence of this reply', '第 {0} 句 {1} 合成 {2} 秒': 'sentence {0}, {1}, synthesis {2} s', '前面空了 {0} 秒': '{0} s of silence before it',
  '（被取消）': ' (cancelled)', '（出错）': ' (failed)', '第 {0} 条回复：': 'Reply {0}: ', '；': '; ', '系统语音': 'system voice', '百炼': 'Bailian', 'Drama 3': 'Drama 3', '其他': 'other',
  // where a reply's text stopped arriving
  '这条回复的文字到达得有多连贯': 'How steadily the text of this reply arrived', '当时没有在等什么': 'nothing was pending', '当时有一个括号标记没写完': 'a bracketed tag was unfinished',
  '当时停在强调符号上': 'it stopped on an emphasis mark', '当时有一段字在协议里等着放行': 'some text was held back by the reply protocol', '模型的字没有隔开过': 'the model’s text never paused',
  '模型的字最长一次隔了 {0} 秒（到第 {1} 个字；{2}）': 'the longest pause in the model’s text was {0} s (at character {1}; {2})', '，送出给气泡的字最长隔了 {0} 秒（到第 {1} 个字）': ', the longest pause in the text sent on to the bubble was {0} s (at character {1})',
  '；共收到 {0} 段': '; {0} chunks received',
  // 2026-11-25 a change that waited for her to finish
  '一项设置的改动等她说完才生效，没有打断她': 'A setting change waited until she had finished, so she was not cut off', '{0}（{1}，{2}）': '{0} ({1}, {2})',
  '换了连接': 'the connection changed', '她的角色设定变了': 'her character text changed', '关掉了看': 'sight was turned off', '她正在回复': 'she was replying', '她正在朗读': 'she was reading aloud',
  // first-char
  '；这一行是定时器收尾时写的（回复结束约 15 秒后），不是第一个字出现的时刻': '; this line was written by the settle timer (about 15 s after the reply ended), not when the first character showed',
};
