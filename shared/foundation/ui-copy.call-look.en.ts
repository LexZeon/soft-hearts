/** The journal's look line for a voice or call segment (shared/voice/call-look-journal.ts, shared/voice/journal-entries.ts). Authored copy only. */
export const ENGLISH_CALL_LOOK_UI_COPY: Readonly<Record<string, string>> = {
  '这一句话里要不要看画面': 'Whether to look at a picture for this sentence',
  '{0}（{1}；开着：{2}；句式规则要看：{3}；语义判断：{4}，答：{5}；结果：{6}）': '{0} ({1}; on: {2}; phrase rules asked for: {3}; semantic judgment: {4}, answered: {5}; result: {6})',
  '通话中': 'in a call', '语音输入': 'voice input', '一条消息（打字或语音转文字）': 'a message (typed, or voice input sent as text)',
  '没有要看的': 'nothing to look at', '摄像头画面': 'the camera picture', '屏幕画面': 'the screen picture', '摄像头和屏幕画面': 'the camera and screen pictures',
  '都没开': 'neither is on', '只开了摄像头': 'only the camera is on', '只开了屏幕': 'only the screen is on', '摄像头和屏幕都开着': 'the camera and the screen are on',
  '骑在反应判定上': 'on the reaction call', '单独问了一次': 'its own call', '没问': 'not asked',
  '不用看': 'no look needed', '别的（陪看的话）': 'something else (talk about what is playing)', '没答出来': 'no usable answer',
  '看了': 'looked', '没有判断': 'nothing judged', '判断说不用看': 'the judgment said no look needed', '要看的那个没开': 'the one to look at is off',
  '你说了别看': 'you said not to look', '判断没有结果（超时或读不懂）': 'the judgment gave no result (timed out or unreadable)',
  '没看成（截图或读取失败）': 'could not look (the capture or reading failed)', '被新的一句话或挂断打断': 'cut short by a newer sentence or the end of the call',
};
