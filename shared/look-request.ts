/**
 * 识图分三档 · 第 1 步「细看」(docs/claude/2026-11-03-image-depth-step1.md, plan docs/claude/2026-11-03-company-and-image-depth-plan.md).
 *
 * With screen sharing on, an ordinary message carries no picture any more: she looks closely only when the user asks her to.
 * Whether a message asks is decided here, on this computer, before it is sent (no model call: 0 ms, the first token does not
 * move). The user's decision by default (question 3, recommended option): match what the user says to her —
 * "你看看这个""帮我看看""看这道题""看我屏幕""你瞧瞧" — and not the user talking about their own looking ("我看看", "让我看看")
 * or teasing her ("你看看你"). A button ("给她看看屏幕") always works, and when this misses she may ask "要我凑近看看吗"
 * (isLookOffer reads that from what she said; electron/look-turns.ts keeps it for one message); a short yes to that
 * ("嗯""看吧""好") is read by isLookAffirmation.
 *
 * Pure text rules, no persona or user data. A miss only means she does not look (she can still ask, the button always works); a
 * false hit sends a frame the user did not ask for — turning sharing on is not a yes to every turn — so when unsure it is a miss.
 */

/** What the user asked her to look at: the shared screen, the user (camera), or "this" (whichever is on; the screen first). */
export type LookTarget = 'screen' | 'camera' | 'either';

/** Looking verbs in their "have a look" forms. */
const LOOK = '看看|看一看|看一下|看下|看一眼|瞧瞧|瞧一瞧|瞧一下|瞅瞅|瞅一瞅|瞅一眼|瞅一下|瞄一眼|瞄瞄';
const MODAL = '(?:来|过来|快|先|再|也|就|能|能不能|可以|可不可以|要不要|想不想|帮我|帮忙|帮)*';
/**
 * 你 / 帮我 … + a look verb: the user asks her ("你看看这个", "你帮我看一下", "这道题你看看", "你能看看吗", "你看这道题").
 * Group 1 = a "have a look" verb, group 2 = a bare 看 / 瞧 / 瞅 (which needs a clear object, see objectTarget), group 3 = the rest.
 */
const ASK = new RegExp(`(?:你|帮我|帮忙|麻烦你|麻烦|让你)${MODAL}(?:(${LOOK})|(看|瞧|瞅))(.*)$`, 'u');
/** 给你看…: the user shows her something ("给你看个东西", "给你看看这个"). */
const SHOW = /给你(?:看看|看一看|看一下|看下|看一眼|瞧瞧|看个|看张|看段|看点|看样|看)(.*)$/u;
/** "快来看", "你过来看看", "过来瞧瞧这个" (not "来看看今天吃什么": 来 alone is "let's"). */
const COME = new RegExp(`(?:你|快)过?来|过来`, 'u');
const COME_LOOK = new RegExp(`(?:(?:你|快)过?来|过来)(?:(${LOOK})|(看|瞧|瞅))(.*)$`, 'u');
/** A clause that starts by telling her where to look: "看这道题", "看看这个", "瞧那边", "看看我". */
const DIRECT = new RegExp(`^(?:快|嘿|欸|诶|喂|哎|那|那你|那就|宝|宝贝)?(?:(${LOOK})|(看|瞧|瞅))((?:这|那|我).*)$`, 'u');
/** Anywhere: looking at the screen itself ("看下我屏幕", "看一眼电脑"); not "看到我屏幕" (a question whether she can see it). */
const SCREEN_LOOK = /(?:看|瞧|瞅|瞄)(?:看|一看|一下|下|一眼)?(?:一下)?(?:我的?|这个?|我这个?)?(?:屏幕|电脑|桌面|显示器|窗口)/u;
/** The user is the one looking: "我看看", "让我看看", "我先看一下", "我在看屏幕", "给我看看你的…". */
const SELF = /(?:^|[^帮给让])我(?:先|再|去|来|要|想|得|在|正在|也|就|还|自己|们)?(?:看|瞧|瞅|瞄)|让我(?:看|瞧|瞅|瞄)|给我(?:看|瞧)/u;
/** Objects that make it not a request: teasing ("你看看你"), comparisons ("你看看人家"), idioms ("让你看看我的厉害", "你看这样子"). */
const NOT_OBJECT = /^(?:你|人家|别人|我的?厉害|我的?心情|我干嘛|我干什么|我做什么|我笑话|我说|我就说|我讲|我猜|这样|那样|这么|那么|这天|这架势|这情况|这意思|样子|情况|着办)/u;
/** After a bare 看: only a pointed-at thing ("这个", "那道题", "这里") or the user ("我…", checked below), never "这次", "这样". */
const BARE_OBJECT = /^(?:(?:这|那)(?:个|道|张|段|题|里|边|儿|条|句|行|篇|页|幅|本|件|些|东西|玩意)|我)/u;
/** Things on a screen. */
const SCREEN_THING = /屏幕|电脑|桌面|显示器|窗口|代码|程序|题|文档|作业|作文|论文|表格|网页|页面|报错|错误|消息|聊天|视频|游戏|图|截图|照片|文章|这段|这行|这句|写的|做的|画的|改的|弄的|发的|打的/u;
/** The user themself (camera): "你看看我", "看看我今天的发型", "你看我这身". */
const ME = /^我(?:$|今天|现在|这身|这件|这套|穿|帅|美|好看|怎么样|呀|啊|嘛|吧|呢|哦|的?(?:发型|头发|新发型|衣服|新衣服|裙子|穿搭|脸|样子|妆|眼睛|手|帽子|眼镜))/u;

function target(object: string): LookTarget {
  if (SCREEN_THING.test(object)) return 'screen';
  if (ME.test(object)) return 'camera';
  return 'either';
}

function objectTarget(object: string, clause: string, bare: boolean): LookTarget | null {
  if (NOT_OBJECT.test(object)) return null;
  if (SCREEN_LOOK.test(clause)) return 'screen';
  if (bare && (!BARE_OBJECT.test(object) || (object.startsWith('我') && !ME.test(object) && !SCREEN_THING.test(object)))) return null;
  return target(object);
}

/** One clause: what it asks her to look at, or null. */
function clauseTarget(clause: string): LookTarget | null {
  const show = SHOW.exec(clause);
  if (show) return objectTarget(show[1], clause, false);
  const ask = ASK.exec(clause);
  if (ask) {
    // "你快来看", "你过来瞧": a bare verb with nothing after it is still a request when she is called over.
    if (ask[2] && !ask[3] && COME.test(clause)) return 'either';
    return objectTarget(ask[3], clause, !!ask[2]);
  }
  const come = COME_LOOK.exec(clause);
  if (come) return come[3] ? objectTarget(come[3], clause, !!come[2]) : 'either';
  // Before SELF: "陪我看剧" has "我看" in it, but it asks her to watch with the user.
  if (WATCH_INVITE.test(clause) || WATCH_TOGETHER.test(clause)) return 'screen';
  if (SELF.test(clause)) return null;
  if (SCREEN_LOOK.test(clause)) return 'screen';
  const direct = DIRECT.exec(clause);
  return direct ? objectTarget(direct[3], clause, !!direct[2]) : null;
}

/*
 * An invitation to watch something together now ("和我一起看会儿视频吧", "陪我看剧", "一起看电影吧"; stable build 2026-11-08: with
 * screen sharing on she answered "我这边看不到你的屏幕"). It asks her to look at the screen: with sharing on the turn carries a
 * frame, with sharing off her line says so. Someone else watching with the user ("我和朋友一起看了电影") is not one: the invitation
 * names the user or "us" right before the verb, or starts the clause and ends like an invitation.
 */
const WATCH_WHAT = '(?:视频|剧|电视剧|美剧|日剧|韩剧|电影|动画|动漫|番|直播|节目|综艺|比赛|片子|片|这个|这集|这部|这段)';
const WATCH_VERB = `(?:看|追)(?:会儿?|一会儿?|下|一下|点|看)?(?:这个?|这部|这集|这段|个|部|集)?${WATCH_WHAT}`;
const WATCH_INVITE = new RegExp(`(?:^|[^朋友别人他她们])(?:陪我|和我|跟我|咱们?|我们)(?:一起|一块儿?)?(?:来)?${WATCH_VERB}`, 'u');
const WATCH_TOGETHER = new RegExp(`^(?:来|快|那|那就|走|要不)?(?:一起|一块儿?)(?:来)?${WATCH_VERB}(?:吧|呀|啊|嘛|呗|好不好|怎么样|好吗|$)`, 'u');

/*
 * A no and someone else's words are never a request (Codex T-112 round 030, 2026-11-03: with sharing on, "不要看我的屏幕",
 * "别看我屏幕", "不用看屏幕", "你先别看我屏幕", "我不想让你看我的屏幕" each took a screen frame, and 他说“你看看这个报错”
 * picked the screen). Missing a request is fine (the button always works); reading a no as a yes is not.
 *
 * Codex T-205 round 2 (X-253, 2026-11-04, a9ad29f): "禁止查看我的屏幕", "请停止查看我的屏幕", "别擅自看我的屏幕",
 * "没授权你看我屏幕", "不允许你看我屏幕" and 同事原话是‘你看看这个报错’ still took a frame each in the real app: 禁止 was no
 * "no" word, 查看 / 观看 no look verb, 擅自 / 授权 / 允许 nothing that may stand between a no and the look, ‘…’ no quote and
 * 原话是 no speech. This is the one place that reads the user's words for looking (the host's attachments, the turn's own
 * perception line), so it is fixed here, and when unsure it says no (docs/claude/2026-11-04-v1-refusal-grab.md): a ban or a
 * "without my permission" anywhere in a clause about looking, and a question whether she is looking ("你是不是在看我屏幕"),
 * are not a request either.
 */
/** "能不能", "要不要", "可不可以", "是不是": a question, not a no. */
const A_NOT_A = /(\p{Script=Han})不\1/gu;
/** 不 / 没 words that do not refuse anything: "要不你看看", "不如", "不然", "不好意思", "不知道", "没事". */
const NOT_A_NO = /要不然|要不|不然|不如|不好意思|不知道|不懂|不明白|不清楚|不对|没事|没错|没问题/gu;
/** A no or a ban that can govern a look: "别", "不要", "禁止", "停止", "未经", "无权". */
const NO_HEAD = '不|没|别|甭|莫|勿|休|无需|无须|停止|停下|暂停|禁止|严禁|拒绝|未经|未|无';
/**
 * Between a no and the look verb: "不想让你看", "你先别看", "我没叫你看", "不许偷看", "不用帮我看了", "千万不要再看";
 * permission and manner: "没授权你看", "不允许你看", "别擅自看", "没经过我同意就看", "不希望你看", "无权查看", "先别急着看".
 */
const NO_FILLER = '要|用|必|需|想|愿意|愿|让|许|准|能|可以|该|应该|好|再|先|也|就|还|又|都|去|来|过来|你|我|他|她|人家|给|被|叫|请|帮忙|帮|偷|乱|随便|一直|老|总|多|了|在|有|说|会|敢|着|准备|打算|是|得|现在|今天|一下|继续|千万|可'
  + '|授权|允许|同意|批准|经过|经|征得|得到|希望|喜欢|擅自|私自|随意|任意|胡乱|悄悄|暗中|背着我|主动|自己|资格|权利|权限|权|急着|急于|忙着|着急';
/*
 * Codex T-205 round 5, found on the way (2026-11-04): a word here that is two others put together (需要 = 需 + 要, 帮我, 偷偷, 老是,
 * 总是, 准许, 许可) let the regex engine try every split of a long run of it: "不需要需要…需要" (26 times, 53 characters) took
 * 1.3 s, four times as long with each two more, a 4,000-character message far longer, with the host frozen. Those words are
 * gone (the rest still spell them, so the same texts match), and the run is cut at 10 words (帮忙着 / 着急着 / 经过来 can still be read
 * two ways; a real refusal has 7 or fewer: "千万不要再让他随便偷偷看").
 */
const NO_FILLER_RUN = `(?:${NO_FILLER}){0,10}`;
/** Looking, also "查看", "观看", "截屏", "窥视"; a bare 看 not as a result ("没看懂", "没看到", "不看好": how the user's own looking went). */
const NO_LOOK = '查看|察看|观看|偷窥|窥视|窥探|浏览|监视|监控|截屏|截图|截我|截下|读取|(?:看|瞧|瞅|瞄|盯|窥)(?!懂|到|见|清|完|出|错|过|明白|起|好|上|中|透)';
/** A no that governs a look: "别看", "不要看", "不用看", "没让你看", "暂停看屏幕", "禁止查看", "没授权你看". */
const REFUSE = new RegExp(`(?:${NO_HEAD})${NO_FILLER_RUN}(?:${NO_LOOK})`, 'u');
/** "看什么看", "瞧啥瞧", "谁让你看的", "谁允许你看". */
const SCOLD = /(看|瞧|瞅)(?:什么|啥|个啥|个什么|甚么)\1|谁(?:让|叫|要|准|许|请|允许|同意|授权)你/u;
/**
 * Unsure means no: a ban, a "without permission", a "ask me first" or a dare anywhere in a clause that looks ("看我屏幕是不允许的",
 * "你看我屏幕经过我同意了吗", "看我屏幕前先问我", "你敢看我屏幕试试", "你凭什么看我屏幕"). Error texts that only say what a program
 * refuses ("拒绝访问", "禁止访问", "不准确") are not a ban on her.
 */
const BAN = /禁止(?!访问)|严禁|不准(?!确)|不许|不允许|不让|别让|不要让|不想让|没授权|未授权|没有授权|未经|没经过|没有经过|没同意|没有同意|不同意|拒绝(?!访问|连接)|擅自|私自|偷看|偷窥|窥视|窥探|监视|凭什么|无权|没资格|没有资格|没权|敢(?=看|瞧|瞅|盯|偷)|先(?:问|问过|经过|征得|告诉|通知)(?:一下)?我|(?:经过|经|得到|征得)了?(?:我的?)?(?:同意|允许|授权|批准|许可)/u;
const ANY_LOOK = /看|瞧|瞅|瞄|盯|窥|浏览|截屏|截图/u;
/**
 * A question or complaint whether she is or was looking, not a request: "你是不是在看我屏幕", "你在偷看我屏幕吗", "你有没有看我屏幕",
 * "你怎么又看我屏幕", "你怎么能看我屏幕", "你看了我的屏幕", "干嘛看我屏幕", "看我屏幕干嘛"; and a clause that ends on her having looked
 * ("你刚才是不是看我屏幕了", "你看我屏幕了吗") unless it asks or lets her ("你可以看我屏幕了"). Not "你现在看看", "你再看看".
 */
const WATCHING = new RegExp([
  '你(?:怎么|干嘛|为什么|为啥|咋)?(?:是|是否|有没有)?(?:在|正在|一直|老是|总是|又|还在)+(?:偷偷|偷|悄悄)?(?:看|瞧|瞅|瞄|盯)(?!不|懂|到|见|清|完|出|错|明白|起来)',
  '你(?:是否|有没有)(?:偷偷|偷|悄悄)?(?:看|瞧|瞅|瞄|盯)(?!不|懂|到|见|清|完|出|错|明白|起来)',
  '(?:看|瞧|瞅|瞄|盯)(?:了|过)(?:我的?|这个?)?(?:屏幕|电脑|桌面|显示器|窗口)',
  '(?:干嘛|干什么|凭什么)(?:要|老|总|一直|又|偷偷|偷)?(?:看|瞧|瞅|盯)',
  '怎么(?:能|可以|敢|会|又|老|总|还)(?:偷偷|偷|随便|擅自)?(?:看|瞧|瞅|盯)(?!不|懂|到|见|清|完|出|错|明白|起来)',
  '(?:看|瞧|瞅|盯)着?(?:我的?)?(?:屏幕|电脑|桌面)(?:干嘛|干什么|做什么|想干嘛)',
].join('|'), 'u');
/** "…看我屏幕了(吗)": she has looked; with 可以 / 能 / 来 / 帮 / 请 it asks or lets her instead. */
const LOOKED = /(?:看|瞧|瞅|瞄|盯)(?:我的?|这个?)?(?:屏幕|电脑|桌面|显示器|窗口)(?:了|过)(?:吗|么|没|吧|呀|啊|呢|嘛)?$/u;
const LETS = /可以|能|来|快|帮|麻烦|请|让你|给你/u;
/** Quoted words are someone's words, not this request: "他说“你看看这个报错”", 同事原话是‘你看看这个报错’, "他说'你看看'". */
const QUOTED = /“[^”]*(?:”|$)|‘[^’]*(?:’|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|〝[^〞]*(?:〞|$)|"[^"]*(?:"|$)|＂[^＂]*(?:＂|$)|'[^']*(?:'|$)/gu;
/** "他说：你看看这个报错", "同事原话：…", "他发来：…": everything after a speech verb and a colon is what was said. */
const SAID_COLON = /(说|讲|道|问|写着|写道|告诉我|回复|回我|原话是?|原文是?|发来|留言|弹幕|评论)(?:过|了|着)?[:：][\s\S]*$/u;
/**
 * Before the first look verb, the clause ends in someone's speech: "他说你看看", "她说让你看看", "老师叫你看看",
 * "同事原话是你看看", "老板说的是你看一下"; round 5 also "同事跟你说一声你看看" (unpunctuated, so "我跟你说一下你看看" is not read
 * either, as "我跟你说你看看" already was not).
 */
const SAID_BEFORE = /(?:(?<![小传听])(?:说|讲)|告诉我|提醒我|嘱咐我|吩咐我|交代我|转告我?|原话(?:是|就是|说)?|原文(?:是)?|(?:说|讲|写|问)的(?:是|就是)|发来|发过来)(?:过|了|着|道)?(?:一声|一下|一句)?(?:你|让你|叫你|要你)?(?:帮我|帮忙|帮)?$|(?:他|她|它|他们|她们|人家|别人|有人|大家|老师|老板|同事|朋友|同学|妈妈|妈|爸爸|爸)(?:也|都|还|就)?(?:让|叫|要|喊)你(?:帮我|帮忙|帮)?$/u;

/*
 * Codex T-205 round 4 (X-258, 2026-11-04, 9f58785): with sharing on, "我撤回你看我屏幕的授权。" and the unquoted, comma-separated
 * "同事当时说，你看看这个报错。" (also with "这是他的原话" after it) each took a frame: a take-back of a permission was no "no", and
 * someone's words after "某人说，" stood as their own clause, read as the user's request. When unsure it is still no.
 */
const AUTH = '授权|允许|同意|许可|权限|权利|批准|准许';
/** Taking a permission back: always about a permission ("撤回授权", "收回刚才的同意", "授权作废了"). */
const TAKE_BACK = '撤回|收回|撤销|撤掉|撤除|收走|作废|废除|吊销|拿回|反悔';
/** Words that also end other things ("取消订单", "关闭窗口"): only with a permission that is hers ("取消对你的授权", "关掉你看屏幕的权限"). */
const END_IT = '取消|解除|终止|中止|停止|停掉|关闭|关掉|关了|拿走|去掉|删掉|删除|没收|失效|到期|结束|不算数|不作数';
const HER_AUTH = `(?:你|看(?:我的?)?(?:屏幕|电脑|桌面|画面)?|屏幕|画面|共享)的?(?:${AUTH})|(?:${AUTH})(?:给|对)?你`;
const REVOKE = new RegExp([
  `(?:${TAKE_BACK}).*?(?:${AUTH})`, `(?:${AUTH}).*?(?:${TAKE_BACK})`,
  `(?:${END_IT}).*?(?:${HER_AUTH})`, `(?:${HER_AUTH}).*?(?:${END_IT})`,
  `(?:不再|再也不|以后不|今后不|从此不).{0,4}?(?:${AUTH})`,
].join('|'), 'u');

function refuses(clause: string): boolean {
  const plain = clause.replace(A_NOT_A, '$1').replace(NOT_A_NO, '');
  return REFUSE.test(plain) || SCOLD.test(plain) || (BAN.test(plain) && ANY_LOOK.test(plain)) || WATCHING.test(plain)
    || (LOOKED.test(plain) && !LETS.test(plain)) || REVOKE.test(plain);
}

function reported(clause: string): boolean {
  const first = clause.search(/[看瞧瞅瞄]/u);
  return first > 0 && SAID_BEFORE.test(clause.slice(0, first));
}

/**
 * A clause that ends on someone saying, asking or sending something: what follows, to the end of the sentence (or the next sentence
 * when this one ends here), is their words, not this request ("同事当时说，你看看这个报错", "他说了，…", "群里有人问，…", "他发来，…").
 */
const SPEECH_END = /(?:说|讲|问|问我|说道|笑道|问道|写道|答道|回道|喊道|叫道|写着|告诉我|提醒我|嘱咐我|吩咐我|交代我|转告我?|回复我?|回我|留言|评论|弹幕|发来|发过来|原话是?|原文是?|(?:说|讲|写|问|发)的(?:是|就是))$/u;
/**
 * Not someone else's words: the user talking to her ("我是说", "听我说", "你说"; "我跟你说" is TO_YOU below), sayings ("说实话" ends
 * elsewhere; "老实说", "总的来说", "比如说", "再说", "别说了", "这么说" points back), and words that only end in 说 ("小说", "听说", "据说").
 */
const OWN_WORDS = /(?:^我|^我们|^咱们?|小|传|听|据|解|演|学|胡|瞎|乱|好|再|要|虽|想|来|或者|比如|譬如|就是|换句话|老实|实话|坦白|简单|总之|怎么|咋|这么|这样|那么|那样|别|不用|不要|甭|少|不必|没|可以|应该|我是|我只是|我就是|我就|我得|我先|我再|我还|^让我|^容我|你|听我)(?:说|讲|问)(?:说|讲|问)?$/u;
/*
 * Codex T-205 round 5 (X-260, 2026-11-04, de4f312): "同事跟你说，你看看这个报错。" took a frame. Round 4 took a clause ending in
 * "跟你说" for the user's own words whoever said it, so the colleague's words after it were read as the user's request. Words said
 * to her are the user's own only when the user is the one saying them.
 */
/** A clause that ends on words said to her: "我跟你说", "同事跟你说", "老板对你讲过", "同事让我跟你说一声". Group 1 = who says it. */
const TO_YOU = /^(.*?)(?:跟|和|对|给|同|向)你(?:说|讲|问)(?:说|讲|问)?(?:过|了)?(?:一声|一下|一句|个事|件事)?$/u;
const OPENER = '嗯|哎|唉|诶|欸|喂|哈|那|那么|所以|然后|其实|好|好吧|对了|说真的|讲真|真的|总之|反正';
const MY_ADV = '想|要|得|必须|先|再|就|还|只|只是|也|都|偷偷|悄悄|小声|私下|老实|认真|好好|实话|直接|早|之前|刚才|上次|已经|一直|可以|来|今天|现在|顺便|特意|特地|专门|当面|真|一定|最后|又';
/**
 * The user is the one saying it: nobody before it ("跟你说"), or 我 / 我们 / 咱 / 让我 / 容我 / 听我 with an opener before and a few
 * adverbs after ("那我跟你说", "说真的我跟你说", "我老实跟你说", "我早就跟你说过"). Anyone else ("同事跟你说", "我同事跟你说",
 * "小王跟你说", "他刚才跟你说") or someone who sent the user ("同事让我跟你说") makes what follows their words; unsure is theirs.
 */
const MY_VOICE = new RegExp(`^(?:${OPENER})*(?:(?:我们|我|咱们|咱|让我|容我|听我)(?:${MY_ADV})*)?$`, 'u');
function speaks(clause: string): boolean {
  const tail = clause.replace(/(?:过|了|着)+$/u, '');
  const toYou = TO_YOU.exec(tail);
  if (toYou) return !MY_VOICE.test(toYou[1]);
  const said = SPEECH_END.exec(tail);
  // Round 6: who is speaking is read once for both rules ("我刚才说了，你看看这个", "要我说，……" are the user's own words).
  return !!said && !OWN_WORDS.test(tail) && reportSpeaker(tail.slice(0, said.index)) !== 'own';
}
const WHO = '他|她|它|他们|她们|人家|别人|有人|对方|同事|老板|领导|老师|朋友|同学|客户|网友|家人|室友|经理|上司|妈妈|妈|爸爸|爸';
/** Anywhere in the message: words passed on for someone ("他让我转告你", "同事让我跟你说一声", "我转述一下", "帮他带个话", "原话如此"). */
const RELAYED = new RegExp(`(?:${WHO})(?:也|都|还|就|特意|特地|专门|刚才|当时)?(?:让|叫|要|托|请|拜托)我(?:转告|转达|告诉|带话|传话|带个话|问问?你|(?:跟|和|对|给|向|同)你(?:说|讲|带话|传话|带个话))|转告|转达|转述|带话|带个话|传话|(?:原话|原文|原句)(?:如此|而已|就是这样|是这样)`, 'u');
/** A clause that only labels the words around it as someone's: "这是他的原话", "他原话", "这是同事说的", "他是这么说的". */
const LABEL = new RegExp(`^(?:(?:这|那|以上|上面|前面|刚才)(?:句|段|些)?话?(?:是|就是|都是|全是)?)?(?:${WHO})?(?:当时|刚才|之前|原来|就|也)?是?(?:的?(?:原话|原文|原句)|(?:这么|这样|那样|如此)?(?:说|讲|问)的(?:话|原话)?)(?:啊|哈|呀|哦|噢|吧|嘛|呢|啦)?$`, 'u');
/*
 * Codex T-205 round 6 (X-263, 2026-11-04, 8225ccc): "同事跟你说了声，你看看这个报错。" and "同事跟你说——你看看这个报错。" each took a
 * frame: 了声 and a dash were two more ways around the lists above, after five rounds of adding words to them. So one structural rule
 * now sits on top of the lists (docs/claude/2026-11-04-v1-refusal-grab.md, 「第六轮：从词表改成结构规则」): when anyone but the user
 * says, tells, asks, sends, answers or has someone do something anywhere before the request — earlier in the message, or earlier in
 * the same clause, whatever follows the verb (a comma, a dash, 了声, 过, nothing at all) — no words in the message ask her to look.
 * Who is speaking is read from the words right before the verb; anything but 我 / 我们 / 咱 is someone else (unsure is someone else),
 * and so is nobody named after a stretch the user does not start ("同事刚才找我，说你看看"). The button never reads words, so it still
 * works. A miss only means she does not look this turn.
 */
/** Saying, telling, asking, sending, answering, having someone do something; not as part of another word (小说, 说明, 问题, 头发, 这回). */
const REPORT = new RegExp([
  '(?<![小传听据解演学游劝])说(?!明|法|服|不定|书|唱|辞|客|真的|实话|白了|起来|到底|正经|正事|回来|句实话|实在|老实话)',
  '(?<![演开主听])讲(?!究|座|义|台|课|堂|师|解|理|价|和|学)',
  '(?<![请访疑学顾慰审盘拷])问(?!题|号|候|世|津|卷|责|鼎)',
  '告诉|提醒(?:我|你)|嘱咐|吩咐|交代(?:我|你)|转告|转达|转发|带话|带个话|传话|写道|写着|原话|喊|嚷|吼',
  '(?<![头理毛白黑长短烫染剪开出激爆引自突散蒸批颁分奋揭告研首先后生启萌沙焕勃挥收整齐秀假美卷直洗吹])发(?:来|过来|过|了|给|的|消息|信息|微信|邮件|短信|语音|截图|图|链接|在|到|我|你|群|个|条|一|张|段|这|那|帖|言)',
  '(?<![这那一几上下收退找返来往挽撤召轮迂买取送拿带驳赎追夺换打折放寄发赢捞搬跑走飞转划绕拉推调改开驶弹])回(?:我|你|他|她|复|了|道|话|信|消息|答|应|过|帖)',
  '(?:让|叫|要|托|请|求|拜托|喊)(?:我|你)',
].join('|'), 'gu');
/** Where one stretch of words ends ("同事跟你说——你看看": the dash too); "@" is not one ("有人@我说"). */
const REPORT_SEP = /[，,。.!！?？；;:：~～…、—–\-·\n\r()（）[\]【】<>《》「」『』“”‘’"'/|]/u;
/** Between the speaker and the verb: "跟你", "也", "刚才", "特意", "没", "这么", "是" ("同事跟你说", "他也说过", "我是说"). No word is two others put together. */
const REPORT_BETWEEN = new RegExp(`(?:跟你|和你|对你|给你|同你|向你|跟您|和您|对您|给您|也|都|还|就|又|再|刚才|刚|当时|之前|以前|早|已经|一直|特意|特地|专门|偷偷|悄悄|私下|当面|老实|实话|坦白|认真|好好|直接|顺便|只|真|一定|最后|先|想|要|得|必须|可以|来|去|不|没|没有|别|不用|不必|甭|这么|那么|这样|那样|怎么|咋|在|正在|是|了|过|着|一声|一下|一句)+$`, 'u');
/** The user's own way of starting ("老实说", "说真的我跟你说", "比如说", "那我跟你说"), and when ("昨天我跟你说过"). */
const REPORT_OPENER = new RegExp(`^(?:嗯|哎|唉|诶|欸|喂|哈|那|那么|那个|所以|然后|其实|好|好吧|好的|对了|说真的|讲真|真的|总之|反正|老实|实话|坦白|简单|比如|譬如|换句话|话|俗话|一句话|就是|也就是|或者|总的来|一般来|还有|另外|而且|但是|但|不过|可是|昨天|今天|刚才|刚刚|之前|上次|早上|晚上|中午|下午|前天|那天|当时|现在)+`, 'u');
/** Only the user: 我 / 我们 / 咱 ("要我说", "就像我说的", "让我问问"). 你 is not the user either ("你说的那个", "你刚才说"): unsure. */
const REPORT_OWN = /^(?:要|依|照|据|在|让|容|听|像|就像|正如|如同|按|按照)?(?:我们|我|咱们|咱)(?:俩|自己)?$/u;
const REPORT_TO_HER = /(?:跟|和|对|给|同|向)(?:你|您)/u;
const REPORT_KIN = '同事|老板|领导|老师|朋友|同学|客户|室友|舍友|经理|上司|组长|导师|师兄|师姐|学长|学姐|妈妈|妈|爸爸|爸|哥|姐|弟|妹|家|老公|老婆|对象|男朋友|女朋友|闺蜜|儿子|女儿|爷爷|奶奶|外婆|外公|叔|阿姨|舅|姨|表|堂';
/** A stretch the user starts: nothing but openers, or 我 / 我们 / 咱 that is not "我同事", "我们老板", "我妈". */
const REPORT_OWN_START = new RegExp(`^(?:(?:我们|我(?!们)|咱们|咱(?!们))(?!的?(?:${REPORT_KIN}))|$)`, 'u');

/**
 * Whose words follow this verb: the user's, someone else's, or whoever spoke in the stretch before (nobody named: "，说你看看").
 * Words said to her with nobody before them ("跟你说，") are the user's, as in round 5; so are the user's openers ("老实说").
 */
function reportSpeaker(subject: string): 'own' | 'other' | 'before' {
  if (subject.length > 24) return 'other';
  const between = REPORT_BETWEEN.exec(subject);
  const bare = between ? subject.slice(0, between.index) : subject;
  const opener = REPORT_OPENER.exec(bare);
  const who = opener ? bare.slice(opener[0].length) : bare;
  if (who) return REPORT_OWN.test(who) ? 'own' : 'other';
  return opener || (between && REPORT_TO_HER.test(between[0])) ? 'own' : 'before';
}

/**
 * Where in `text` someone other than the user first says (tells, asks, sends…) something; -1 when nobody does. Linear: every
 * position's stretch start is found in one pass, and the first such verb ends the search.
 */
function firstReported(text: string): number {
  const start = new Int32Array(text.length + 1), lastWord = new Int32Array(text.length + 1);
  let stretch = 0, word = -1;
  for (let i = 0; i < text.length; i++) {
    if (REPORT_SEP.test(text[i]!)) stretch = i + 1; else word = i;
    start[i] = stretch;
    lastWord[i] = word;
  }
  start[text.length] = stretch;
  REPORT.lastIndex = 0;
  let mine = -1; // where the user's last verb in this stretch ends ("让我问问", "我说了说": the same speaker goes on)
  for (let match = REPORT.exec(text); match; match = REPORT.exec(text)) {
    const at = match.index, from = start[at]!, going = mine >= from;
    let speaker = reportSpeaker(text.slice(going ? mine : from, at));
    if (speaker === 'before' && going) speaker = 'own';
    else if (speaker === 'before') {
      // Nobody named: whoever spoke in the stretch before ("同事刚才找我，说你看看" is the colleague; at the start it is the user).
      const end = from > 0 ? lastWord[from - 1]! : -1;
      if (end < 0) speaker = 'own';
      else {
        const before = text.slice(start[end]!, end + 1);
        const opener = REPORT_OPENER.exec(before);
        speaker = REPORT_OWN_START.test(opener ? before.slice(opener[0].length) : before) ? 'own' : 'other';
      }
    }
    if (speaker === 'other') return at;
    mine = at + match[0].length;
  }
  return -1;
}
/** The last looking verb in a clause (the request is never after it). */
function lastLook(clause: string): number {
  for (let i = clause.length - 1; i >= 0; i--) if ('看瞧瞅瞄'.includes(clause[i]!)) return i;
  return clause.length;
}

/** A message's clauses (split at any punctuation) and whether a sentence ends after each one. */
const CLAUSE = /([^，,。.!！?？；;:：~～…\n\r]+)([，,。.!！?？；;:：~～…\n\r]*)/gu;
const SENTENCE_END = /[。.!！?？\n\r]/u;

/**
 * Whether this message asks her to look, and at what. The screen wins over "either" across clauses: "你看看，这道题怎么做"
 * names nothing in its first clause and a screen thing in the second. A message with a no to looking anywhere in it asks
 * nothing ("先别看屏幕，你看看这个" stays null); a clause that only reports someone's words asks nothing.
 */
export function scanLookRequest(text: unknown): LookTarget | null {
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) return null;
  const spoken = text.replace(/\s+/gu, '').replace(SAID_COLON, '$1').replace(QUOTED, '那个');
  const clauses = [...spoken.matchAll(CLAUSE)].map(match => ({ clause: match[1], end: SENTENCE_END.test(match[2]), at: match.index }));
  const parts = clauses.map(item => item.clause);
  if (parts.some(refuses) || RELAYED.test(spoken) || parts.some(part => LABEL.test(part))) return null;
  const someoneSaid = firstReported(spoken);
  const found: LookTarget[] = [];
  let quoting = false;
  for (const { clause, end, at } of clauses) {
    if (quoting) { if (end) quoting = false; continue; }
    const asked = reported(clause) ? null : clauseTarget(clause);
    // Round 6: a request after someone else's words, anywhere before it, is theirs; then nothing in the message asks.
    if (asked && someoneSaid >= 0 && at + lastLook(clause) > someoneSaid) return null;
    if (asked) found.push(asked);
    if (speaks(clause)) quoting = true;
  }
  if (!found.length) return null;
  if (found.includes('screen')) return 'screen';
  if (found.includes('camera')) return 'camera';
  // "你看看" alone, then the thing in the next clause ("你看看，这个报错什么意思").
  if (parts.some(part => SCREEN_THING.test(part) && !SELF.test(part))) return 'screen';
  return 'either';
}

/**
 * Why an ordinary message with screen sharing on carries no frame (V1; the
 * host otherwise sends the latest frame it already has, electron/look-turns.ts):
 *  - 'refused': the user says no to looking, bans it, takes the permission back or asks whether she is looking — the same rules that
 *    make scanLookRequest ask nothing ("别看我屏幕", "禁止查看我的屏幕", "我撤回你看我屏幕的授权", "你是不是在看我屏幕");
 *  - 'relayed': the message passes on someone else's words about looking (quoted, after "他说：", "同事跟你说，", "转告"…): read
 *    word by word a clause asks or forbids looking, read as scanLookRequest reads it nothing does, so those words are not the user's;
 *  - 'unread': too long to read (over 4000 characters); unsure is a no.
 * null: nothing in it says no. Words that only contain 看 ("好看", "看起来", "我看看", "你看看你") are not about her looking.
 */
export type LookWithheld = 'refused' | 'relayed' | 'unread';
export function withheldLook(text: unknown): LookWithheld | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  if (text.length > 4000) return 'unread';
  const compact = text.replace(/\s+/gu, '');
  const clausesOf = (value: string) => [...value.matchAll(CLAUSE)].map(match => match[1]!);
  if (clausesOf(compact.replace(SAID_COLON, '$1').replace(QUOTED, '那个')).some(refuses)) return 'refused';
  const naive = clausesOf(compact).some(clause => refuses(clause) || clauseTarget(clause) !== null);
  return naive && scanLookRequest(text) === null ? 'relayed' : null;
}

const YES_TOKEN = /嗯|恩|好|行|可以|要|对|是的|是|看看|看|来|凑近|一下|帮我|快|吧|呀|啊|呗|哦|噢|嘞|哒|的|呢|你|那|就|谢谢|谢|麻烦了|麻烦|拜托|ok|okay|yes|sure/giu;
const YES_CORE = /嗯|恩|好|行|可以|要|对|是|看|来|ok|okay|yes|sure/iu;

/** A short yes to her "要我凑近看看吗" ("嗯", "看吧", "好呀", "可以", "你看吧"); never "不用", "不要", "算了". */
export function isLookAffirmation(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const plain = text.replace(/[\s，,。.!！?？~～…、]+/gu, '');
  if (!plain || plain.length > 10 || /不|别|算|没|甭|免|吗/u.test(plain)) return false;
  return !plain.replace(YES_TOKEN, '') && YES_CORE.test(plain);
}

/**
 * A short no to her "要我凑近看看吗" ("不用", "算了", "好，先不用", "不了谢谢", "没事"): with sharing on (V1) that is a no to looking,
 * like "别看" (electron/look-turns.ts), though it names no looking itself. Only read while her offer is open.
 */
export function isLookDecline(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const plain = text.replace(/[\s，,。.!！?？~～…、]+/gu, '');
  return !!plain && plain.length <= 12 && !isLookAffirmation(text) && /不用|不要|不必|不需要|不了|别|甭|算了|免了|先不|没事|没关系|(?<![a-z])no(?:pe)?(?![a-z])/iu.test(plain);
}

/**
 * Her reply offers to look closer ("要我凑近看看吗？", "要不要我帮你看一眼？", "你叫我看我就看哦"): read from what she said, in a
 * sentence that asks or invites. Only used for a turn with screen sharing on and no frame (shared/perception-rule.ts
 * lookOfferAllowed). Measured 2026-11-03: telling her in every turn to mark such an offer in the state tail slowed the first token
 * by about half a second (docs/claude/2026-11-03-image-depth-step1.md), so nothing asks her to; this only listens.
 */
const OFFERS: readonly RegExp[] = [
  /(?:要|要不要|需不需要|需要|想不想|想让|想要|让|准|允许)我(?:帮你|帮忙|来|凑近|凑过去|过去|仔细|认真|再|也)*(?:看看|看一看|看一下|看下|看一眼|瞧瞧|瞅瞅|瞄一眼|看)/u,
  /(?:叫|喊)我(?:一声)?(?:就|再|才|来)?(?:凑近|凑过去|过去)?(?:看|瞧)/u,
  /我(?:就|再)?(?:帮你|来|去|凑近|凑过去)+(?:看看|看一看|看一下|看下|看一眼|瞧瞧)/u,
];
export function isLookOffer(reply: unknown): boolean {
  if (typeof reply !== 'string' || !reply.trim() || reply.length > 6000) return false;
  return reply.replace(/\s+/gu, '').split(/(?<=[。！!？?…])/u).some(sentence =>
    /[？?]|吗|呢|叫我|喊我/u.test(sentence) && sentence.replace(/[。！!？?…～~]+$/u, '').split(/[，,；;：:]/u)
      .some(clause => !/看不到|看不见|没看到|看到了|看见了/u.test(clause) && OFFERS.some(pattern => pattern.test(clause))));
}
