/**
 * 功能：像打语音电话一样和她聊天（I-091 第 1、2 步：免按键、能打断、她先"嗯"一下）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：
 *  - 通话开着时麦克风一直在听（不用按 T）；你停下来超过 endpointSilenceMs 算一句说完，马上交给本机识别，并告诉她"说完了"。
 *  - 她在读回复时也在听，但要更大声才算你开口（她自己从音箱出来的声音不能算）：门槛取下面三个里最大的一个——
 *    bargeIn.floor、平时门槛 × bargeIn.gateFactor、她说话时麦克风里的回声大小 × bargeIn.echoFactor；
 *    最近 bargeIn.windowMs 里超过门槛的声音加起来够 bargeIn.minVoicedMs，就算你可能在插话：麦克风开始盖着她听，她照常说；
 *    2026-11-19 起 要识别出明确、成句的话或"等一下"这类叫停话她才停，
 *    规则和旋钮在 shared/behaviors/interrupt/。
 *  - 你说完一段（说了至少 filler.minVoicedMs）后安静了 filler.delayMs，她先用自己的声音轻轻"嗯……""诶？"接一下；
 *    真正的回答一出声，这一声立刻停。同一声不会连着两次。出不出声、出哪一声按她的性格和心情（choose.ts），只读心情，不写。
 *  - 很久没人说话（autoHangUpMs）就自动挂断。
 *  - 第 4 步：通话里她的回复一句一句读（第一句写好就开口，不等整条）。百炼 / Drama 3 按次计费，所以字数少于 speech.paidMinChunkChars 的一句
 *    会先和下一句并成一次朗读（系统声音免费，不并）。她说话的规则（短句、口语、不列表）是每轮私下带给她的几行（shared/voice/voice-call.ts）。
 *  - I-197：你一句交给她后、她的声音还没出来之前，再说一句明确的话就接到上一句后面，两句一起回（electron/voice/voice-call/add-on.ts）；
 *    她的回复写完了但还没出声时最多等 addOn.holdMs。
 *  - 通话里常驻进程最多连续用 session.maxTurns 轮才换新的（平时 12 轮）；字数上限和其他换新规则不变。
 *  - I-099：通话里用本机的 Silero 语音检测（神经网络，shared/voice/silero-vad.json）判断"是不是人在说话"：连续 vad.startMs 有人声算开口，
 *    安静 endpointSilenceMs 算说完（同上一个旋钮），她说话时要先过上面的回声门槛、再被它认成人声才算插话。模型没装好或出错时，自动退回按音量判断。
 *  - I-099/I-100：有语音检测时，再请"说完了吗"模型（Smart Turn v3.2，shared/voice/smart-turn.json，本机运行）判断：你安静 turn.pauseMs 后听一次这一轮，
 *    说完了（把握 >= turn.threshold）就马上交给识别；没说完就最多再等 turn.capMs 的安静（中途开口还是同一轮）；模型没装好、没答案、
 *    选了"转写地址"（没有语音检测）时，完全按 endpointSilenceMs。
 * 这些都只是试用值，没在真机上听过。
 */

export interface VoiceCallKnobs {
  readonly endpointSilenceMs: number;
  readonly autoHangUpMs: number;
  readonly bargeIn: {
    readonly floor: number; readonly gateFactor: number; readonly echoFactor: number;
    readonly minVoicedMs: number; readonly windowMs: number; readonly learnMs: number; readonly prerollMs: number;
  };
  readonly filler: {
    readonly delayMs: number; readonly sleepyExtraMs: number; readonly minVoicedMs: number;
    readonly chanceBase: number; readonly chanceMin: number; readonly chanceMax: number;
  };
  readonly speech: { readonly paidMinChunkChars: number };
  readonly session: { readonly maxTurns: number };
  readonly addOn: { readonly holdMs: number };
  readonly vad: {
    readonly threshold: number; readonly negThreshold: number; readonly startMs: number; readonly prerollMs: number;
    readonly bargeInShare: number; readonly timeoutMs: number; readonly warmTimeoutMs: number; readonly failLimit: number;
    readonly retryAfterMs: number;
  };
  readonly turn: {
    readonly pauseMs: number; readonly threshold: number; readonly capMs: number; readonly tailMs: number; readonly guardWasted: number; readonly guardOf: number;
    readonly timeoutMs: number; readonly warmTimeoutMs: number; readonly failLimit: number;
  };
}

export const VOICE_CALL_KNOBS: VoiceCallKnobs = Object.freeze<VoiceCallKnobs>({
  // 用户可能怎么说：通话时我还没说完她就接了 / 我说完了她半天才接
  // 怎么调：你停下来多少毫秒算一句说完（通话外仍是原来的 650 毫秒加 1.5 秒）；建议 600～800
  endpointSilenceMs: 700,

  // 用户可能怎么说：我没挂电话，它自己挂了 / 我忘了挂，麦克风开了好久
  // 怎么调：多久没人说话就自动挂断（毫秒），默认 2 分半
  autoHangUpMs: 150_000,

  bargeIn: Object.freeze({
    // 用户可能怎么说：她说话时我小声插话，她没停
    // 怎么调：插话至少要多大声才开始盖着她听（0～1 的音量，0.03 约 -30 dB）；她停不停另看"她说话时怎样才算打断她"那几项
    floor: 0.03,
    // 用户可能怎么说：她说话时旁边一点小声音她就停了
    // 怎么调：插话要比平时"算说话"的门槛大几倍才开始盖着她听（2026-11-19 起光有声音不会让她停）
    gateFactor: 3,
    // 用户可能怎么说：她自己说着说着就停了，好像被自己的声音打断
    // 怎么调：插话要比她说话时麦克风里的回声大几倍；调大更不容易被回声打断
    echoFactor: 2.5,
    // 用户可能怎么说：我咳嗽一声她就不说了
    // 怎么调：最近一小段里要有多少毫秒的大声才开始盖着她听（咳嗽本身不会让她停）
    minVoicedMs: 220,
    // 用户可能怎么说：我插话要说好几个字她才停
    // 怎么调：上面那"一小段"有多长（毫秒）
    windowMs: 400,
    // 用户可能怎么说：她刚开口那一下我插话没用
    // 怎么调：她开口后先听多少毫秒来认识回声，这段时间里不算插话
    learnMs: 250,
    // 用户可能怎么说：我插话的第一个字没识别出来
    // 怎么调：插话被认出来时，往前补多少毫秒的声音一起交给识别
    prerollMs: 600,
  }),

  filler: Object.freeze({
    // 用户可能怎么说：我说完她"嗯"得太快，像抢话 / 太慢，空了好久
    // 怎么调：你说完安静多少毫秒后她先"嗯"一下；建议 300～500
    delayMs: 400,
    // 用户可能怎么说：她困的时候也接得很快，不像困
    // 怎么调：她困了（A 高）时"嗯"晚多少毫秒
    sleepyExtraMs: 150,
    // 用户可能怎么说：我就"啊"了一声她也"嗯"
    // 怎么调：你至少说了多少毫秒，她才会先"嗯"一下
    minVoicedMs: 500,
    // 用户可能怎么说：她每次都"嗯"，有点烦 / 她很少"嗯"，空着不说话
    // 怎么调：平时（心情和性格都在中间时）先"嗯"一下的机会，0～1
    chanceBase: 0.7,
    // 用户可能怎么说：她紧张的时候完全不出声了
    // 怎么调：最少的机会（她很紧张时也至少这么多）
    chanceMin: 0.25,
    // 用户可能怎么说：她开心的时候每次都"嗯"
    // 怎么调：最多的机会
    chanceMax: 0.95,
  }),

  speech: Object.freeze({
    // 用户可能怎么说：用百炼 / Drama 3 打电话，她前面很短的一句（"嗯。""好。"）要等下一句才一起出声 / 费用涨得太快
    // 怎么调：付费声音一句话少于多少个字就和下一句并成一次朗读（0 = 不并，一句一次，最快也最费）；系统声音不受影响
    paidMinChunkChars: 6,
  }),

  session: Object.freeze({
    // 用户可能怎么说：通话到第十几句她突然慢了一下
    // 怎么调：通话中她的常驻进程连续用多少轮才换新的（平时 12 轮，换新要多等约 0.7 秒）；越大越快，但每轮带的历史越长
    maxTurns: 40,
  }),

  addOn: Object.freeze({
    // 用户可能怎么说：她的字已经写完了、声音还没出来，我补的一句没接上 / 她写完了半天不出声，回复也迟迟不算数
    // 怎么调：I-197：她的回复写完但声音还没出来时，最多等多少毫秒（等她出声，或者等你补的一句）；过了就照常算这条回复
    holdMs: 6000,
  }),

  vad: Object.freeze({
    // 用户可能怎么说：通话时背景有点声音（音乐、键盘）她就以为我在说话
    // 怎么调：语音检测给出的"是人声"的把握（0～1）超过多少才算人声；调大更不容易被杂音骗，但小声说话可能听不到（Silero 默认 0.5）
    threshold: 0.5,
    // 用户可能怎么说：我说话中间稍微一顿，她就以为我说完了
    // 怎么调：已经在说话时，把握低于多少才算安静（比上面那个低一点，免得一句话里忽断忽续）
    negThreshold: 0.35,
    // 用户可能怎么说：我"嗯"一下、咳一声她也当我开口了 / 我开口好一会儿她才反应
    // 怎么调：连续多少毫秒都是人声才算开口（每 32 毫秒判断一次；参考 Whispera 的 128）
    startMs: 128,
    // 用户可能怎么说：通话里我说的第一个字常常没识别出来
    // 怎么调：认出开口时，往前补多少毫秒的声音一起交给识别
    prerollMs: 300,
    // 用户可能怎么说：她说话时我咳嗽、拍桌子，她也停了
    // 怎么调：她说话时，一小块声音（约 85 毫秒，两三个判断）里至少多大比例被认成人声，才算你插话（音量还要先过回声门槛）；0.3 = 有一个判断是人声就算（合成测试里比 0.5 早约 85 毫秒停下，拍手、音乐照样不算）
    bargeInShare: 0.3,
    // 用户可能怎么说：（一般不用改）电脑很忙时通话反应变慢
    // 怎么调：一次语音检测最多等多少毫秒，等不到这一块就按音量判断
    timeoutMs: 400,
    // 用户可能怎么说：（一般不用改）刚打通电话那几秒判断得不准
    // 怎么调：通话开始时装载语音检测模型最多等多少毫秒，装好之前按音量判断
    warmTimeoutMs: 8000,
    // 用户可能怎么说：（一般不用改）
    // 怎么调：连续几次检测失败就先改回按音量判断（过 retryAfterMs 再试模型）
    failLimit: 3,
    // 用户可能怎么说："打电话时，不说话也被当成说话了"（2026-11-19：电脑一忙，模型连着超时被放弃，以前整通电话都按音量判断）
    // 怎么调：放弃模型后过多少毫秒重新装载再试；试不成就再等这么久
    retryAfterMs: 10_000,
  }),

  turn: Object.freeze({
    // 用户可能怎么说：我说完了她还要等一会儿才回 / 我停顿想一想她就抢着回
    // 怎么调：你安静这么久之后，请"说完了吗"模型听一次你这一轮的声音；小一点判断得早，但模型能听到的收尾静音更少（模型按停顿约 0.2 秒训练）
    pauseMs: 350,
    // 用户可能怎么说：我话没说完她就回了 / 我说完了她迟迟不回
    // 怎么调：模型认为"这一轮说完了"的把握（0～1）达到多少就立刻交给识别；调大更不容易抢话，调小更快（官方默认 0.5）
    threshold: 0.5,
    // 用户可能怎么说：我想一下再说，她等不及；或者模型觉得没说完，但我其实说完了，要等很久
    // 怎么调：模型认为"还没说完"时，最多再等多少毫秒的安静才当作说完（平时是 endpointSilenceMs）；你中途又开口，仍是同一轮
    // 2026-11-19 从 2500 改成 1200（当天三轮，模型每次都判"没说完"、白等到 2.5 秒上限）
    capMs: 1200,
    // 用户可能怎么说：（一般不用改）
    // 怎么调：交给模型听的声音里，结尾的安静最多留多少毫秒（模型训练时句子后面只跟一小段静音；太长的静音它没见过）
    tailMs: 250,
    // 用户可能怎么说：模型总是觉得我没说完，她老是等很久才回
    // 怎么调：保险：一通电话里，最近 guardOf 次"模型说没说完"里，有 guardWasted 次你根本没接着说（等到上限才算说完），这一通电话就关掉模型、按原来的安静规则（体验记录写 smartTurnOff: guard）
    // 2026-11-19 从 3 改成 2（同上：模型老判错时更早退回原来的安静规则）
    guardWasted: 2,
    // 用户可能怎么说：（一般不用改）
    // 怎么调：保险看最近几次"没说完"的判断（不足几次时按已有的算）
    guardOf: 4,
    // 用户可能怎么说：（一般不用改）电脑很忙时她说完话后反应变慢
    // 怎么调：模型最多等多少毫秒给答案，超时就按原来的安静规则（endpointSilenceMs）处理
    timeoutMs: 800,
    // 用户可能怎么说：（一般不用改）刚打通电话时判断说完不灵
    // 怎么调：通话开始时装载模型最多等多少毫秒，装好之前按原来的安静规则
    warmTimeoutMs: 10000,
    // 用户可能怎么说：（一般不用改）
    // 怎么调：连续几次没有答案，这一通电话就都按原来的安静规则
    failLimit: 3,
  }),
});
