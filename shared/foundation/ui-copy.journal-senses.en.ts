// 体验记录 (E2), split out of ui-copy.journal.en.ts (I-187, the file had grown past its size pin): the journal's English for what she
// sees of you (camera looks, her own look, text first, gifts, gaze, hands). Spread into ENGLISH_JOURNAL_UI_COPY at the same place. Authored copy only.
export const ENGLISH_JOURNAL_SENSES_UI_COPY: Readonly<Record<string, string>> = {
  // 2026-11-24 一起看 turned off (shared/senses/journal-entries.ts WATCH_OFF_WHYS)
  '和她一起看关了': 'Watching together turned off', '你关的': 'you turned it off', '她的窗口没了': 'her window was gone', '她的窗口离开了屏幕': 'her window left the screen', '重置或退出': 'a reset or quitting', '换了角色或对话被清掉': 'the character changed or the conversation was cleared', '别的原因': 'another reason',
  // 2026-11-24 一起看 paused, resumed or lost (shared/senses/journal-entries.ts WATCH_CHANGE_EVENTS)
  '一起看的屏幕共享断了': 'The screen share for watching together was lost', '她的窗口最小化了，一起看先停着': 'Her window was minimized; watching together paused', '你在全屏里开的一起看，回到小窗时留着了': 'Watching together, which you turned on in full screen, was kept when she came back to the small window',
  '她的窗口回来了，一起看接着开了': 'Her window came back; watching together resumed', '她的窗口回来了，一起看没有接着开': 'Her window came back; watching together did not resume',
  '屏幕画面一直取不到': 'the screen picture could not be taken', '共享的窗口或屏幕不在了': 'the shared window or screen was gone', '没人说得出原因': 'nobody could say why',
  '你在这期间关了': 'you turned it off meanwhile', '屏幕共享不再开着': 'screen sharing was no longer on', '台词那一路开不起来': 'the dialogue could not be turned on', '换了角色或对话': 'the character or conversation changed', '；离开了 {0} 秒': '; away for {0} s',
  // I-084 with camera pictures on: what she saw of you this turn (shared/senses/camera-look.ts)
  '这一轮她看清了你': 'She saw you clearly this turn', '她回完话又看了你一眼': 'After her reply she took a look at you',
  '这一轮她只有你的小图': 'She only had the small picture of you this turn', '这一轮她没看到你': 'She did not see you this turn',
  '你叫她看的': 'you asked her to look', '你问到自己的样子': 'you asked about how you look', '你点了按钮': 'you pressed the button',
  '她问要不要看，你说好': 'she offered to look and you said yes', '你拍给她的': 'you took the photo for her',
  '没人叫她看': 'nobody asked her to look', '她判断这句不用看': 'she judged this message did not need a look', '这句要不要看，没判断出来': 'whether to look was not worked out', '你说过别看': 'you had asked her not to look',
  '叫她看了，但没拿到画面': 'she was asked to look but got no picture', '没等她判断完或看完，这一轮就过去了': 'the turn was over before she finished judging or looking',
  '她想看，没看成': 'she tried to look and could not',
  // 2026-11-21: where a failed look broke, how far a cut-short one got (shared/senses/camera-look.ts)
  '{0}；{1}': '{0}; {1}', '没有能拍的窗口': 'no window could take the picture', '正在拍另一张': 'another picture was being taken', '拍到的画面没被收下': 'the picture taken was refused',
  '摄像头那边没回画面': 'the camera window gave no picture', '那一刻发图片关着或你说了别看': 'camera pictures were off or held at that moment', '等太久了': 'it took too long',
  '拍到了，但没看出什么': 'a picture came but nothing was made of it', '看到了，但那句话没说出来': 'she saw, but her line about it failed',
  '还在判断要不要看': 'still judging whether to look', '判断要看，正在看': 'judged to look, still looking', '看到了，还没来得及说': 'seen, not said yet',
  '你又说了一句': 'you said something new', '她的回复停了': 'her reply stopped', '太晚了': 'too late', '她一直没空说': 'she never had a free moment to say it',
  '她在全屏里说了': 'she said it in her full-screen bubble',
  // I-085 she looks at you because she wants to (shared/initiative/self-look.ts)
  '她自己看了你一眼': 'She took a look at you on her own', '她想看你一眼，你说过别看，她没看': 'She wanted to look at you; you had asked her not to, so she did not',
  '她想看你一眼，「发图片」没开，她没看': 'She wanted to look at you; “Send pictures” was off, so she did not',
  '她想看你一眼，刚看过不久，忍住了': 'She wanted to look at you; she had looked a short while ago, so she held back', '她想看你一眼，没看成': 'She wanted to look at you and could not',
  // 担心 (Concerned) and 摄像头 (Camera) already have their English elsewhere in the catalog.
  '想你': 'Missed you', '好奇': 'Curious', '无聊': 'Bored', '开口前': 'Before speaking up', '聊天时': 'While chatting',
  // I-085 step 3, text first: per chat turn, a picture or text (shared/brain/text-first.ts)
  '这一轮附了画面': 'This turn carried a picture', '这一轮她用文字知道你那边': 'This turn she knew your side from text', '这一轮她没看到画面': 'This turn she saw no picture',
  '一起看': 'Watching together', '附了画面': 'a picture', '用文字': 'text', '什么都没有': 'nothing', '她好奇凑近看了一眼': 'she was curious and took a closer look',
  // I-086 she hands you something
  '你接住了她递的东西，她很开心': 'You took what she handed you; she was happy', '她递给你的东西，你接住了': 'You took what she handed you',
  '她递给你的东西，你没顾上接，她悄悄收回去了': 'You were busy and did not take it; she quietly took it back', '她递东西时被别的事打断，收回去了': 'Something came up while she was handing it over; she took it back',
  '她给你留了一张她自己的图': 'She left you a picture of herself', '点心': 'snack', '靠垫': 'cushion', '（你喂过她的那张）': ' (one you fed her)',
  '深夜': 'late at night', '她自己困了': 'she was sleepy', '你刚说累': 'you said you were tired', '你很久没动': 'you had not moved for a long time', '她有点调皮': 'she felt playful',
  '你熬到很晚': 'you were up very late', '她很想你': 'she missed you a lot', '特别的日子': 'a special day', '她自己想递': 'she simply wanted to',
  // I-081 with pose sensing on: her attention to you (shared/behaviors/gaze-attention/interface.ts)
  '她开始时不时看你': 'She started looking at you now and then', '她不再看你那边了': 'She stopped looking your way',
  '你们对视了一会儿，她心里暖了一点': 'You looked at each other for a moment; she felt a little warmer', '和你对上眼，她害羞地躲开了一下': 'Your eyes met and she looked away shyly for a moment',
  '你转过来朝着她': 'you turned toward her', '你离开了': 'you left', '你转开了': 'you turned away', '姿势识别关了': 'posture sensing was turned off',
  '和你对视了一会儿，觉得亲近了些': 'Looked at each other for a moment and felt a little closer',
  // I-087 hold hands, pinky promise, high five (shared/behaviors/hands/)
  '和你牵了手，心里安稳了些': 'Held hands with you and felt calmer', '和你击了掌，挺开心的': 'Gave you a high five and felt happy',
  '你们第一次牵了手': 'You held hands for the first time',
  // I-189 what the local pose signals were used for (shared/behaviors/pose-uses/journal.ts)
  '本机姿势：你转开或走开时她的朗读': 'Local pose: her reading while you turned or walked away', '本机姿势：通话里你侧过脸说话': 'Local pose: you spoke with your face turned in a call',
  '本机姿势：你点头摇头回答她': 'Local pose: you answered her with a nod or a shake', '本机姿势：画面里好像还有一个人': 'Local pose: what looks like one more person in the frame',
  '本机姿势：你问今天坐了多久': 'Local pose: you asked how long you sat today',
  '停在一句说完的地方': 'paused where a sentence ended', '你转回来，接着念': 'you turned back; she went on', '你一直没回来，后面的只留在气泡里': 'you did not come back; the rest stayed in her bubble',
  '不算插她的话': 'not taken as talking over her', '点头，作为回答发了过去': 'a nod, sent as your answer', '摇头，作为回答发了过去': 'a shake, sent as your answer',
  '告诉了她（只是资料）': 'told to her (information only)', '认出来了，但这会儿没发': 'recognised, but not sent right then', '{0}，约 {1} 秒': '{0}, about {1} s',
};
