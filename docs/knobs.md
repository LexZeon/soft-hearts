# 想改什么 → 改哪里

这张表回答一个问题：你想让她某个地方不一样，应该去哪个文件的哪个数字。

## 怎么用

1. 在下面的表里找到你想改的那句话（左边那一列）。
2. 看“改哪里”那一列，那是一个文件里的一个名字（例如 `BLUSH_KNOBS.recent`）。文件路径在每一节开头。
3. 打开那个文件，找到这个名字，改它后面的数字（或范围）。文件里每个数字上方都有一行注释，写着它管什么。
4. 保存后运行 `pnpm typecheck`。改动较大时再运行 `pnpm test`。

每一行只改一个值，改完只影响这一件事，别处不变。改之前最好先记下原来的值，方便改回去。

也可以直接让你自己的 Claude Code 做：把你想要的样子用大白话告诉它，比如“她太容易脸红了，帮我找到管这件事的数字，只改一个，告诉我改前改后的值”。

## 一些说明

- 这里的“用户可能怎么说”是大白话的说法，方便你对照。不是说要你照着说。
- 表里只列了已经改成“数字可调”的行为。还没搬过来的固定规则，要改时得去代码里找。
- 有些数字有代码里的硬上限或保底（比如每天问模型的次数），调整时以表里写的说明为准。
- 角色卡里也有很多数值（心情、想念、无聊等），见 [角色卡和她的数值怎么写](character-card-guide.md)。

## 各功能用的写法

| 功能 | 写法 | 旋钮文件 | 旋钮数 |
|---|---|---|---|
| 脸红：红成什么样、多久才会再红、害羞的更容易红 | 数字可调（旋钮文件） | `shared/behaviors/blush/knobs.ts` | 7 |
| 你不理她时，多久看你一眼、动一下、想开口 | 数字可调（旋钮文件） | `shared/behaviors/boredom-timing/knobs.ts` | 6 |
| 最近聊得多，她主动开口的上限跟着提高 | 数字可调（旋钮文件） | `shared/behaviors/busy-chat/knobs.ts` | 12 |
| 喂点心时的语气词和吃法 | 数字可调（旋钮文件） | `shared/behaviors/feed-cue/knobs.ts` | 19 |
| 她闲着时“动一动”“看你一眼”的样子和表情 | 数字可调（旋钮文件） | `shared/behaviors/idle-gesture/knobs.ts` | 18 |
| 她自己想事情（内心循环）的节奏：忽长忽短，深夜和你不在时拉长 | 数字可调（旋钮文件） | `shared/behaviors/inner-rhythm/knobs.ts` | 12 |
| 互动余额：她自己主动做的事有多少，跟着你们最近的互动和她的性格 | 数字可调（旋钮文件） | `shared/behaviors/interaction-budget/knobs.ts` | 18 |
| 心情调整员：haiku 在后台按“此刻”再微调一下她的心情（默认关） | 数字可调（旋钮文件） | `shared/behaviors/mood-judge/knobs.ts` | 21 |
| 她想找你说话时，这次说什么 | 数字可调（旋钮文件） | `shared/behaviors/opening-choice/knobs.ts` | 8 |
| 停停说说：haiku 按她的性格和心情决定说到哪停、停多久（默认关） | 数字可调（旋钮文件） | `shared/behaviors/pause-talk/knobs.ts` | 15 |
| 她的即时反应（反应清单、打分、haiku 挑） | 数字可调（旋钮文件） | `shared/behaviors/reactions/knobs.ts` | 36 |
| 回复说完以后，气泡留多久 | 数字可调（旋钮文件） | `shared/behaviors/reply-linger/knobs.ts` | 12 |
| 她的作息：关着应用算休息、夜里那一觉更容易睡、睡得更透 | 数字可调（旋钮文件） | `shared/behaviors/sleep-rhythm/knobs.ts` | 15 |
| 摸头、捏脸、喂点心让她心情好多少，多快会腻 | 数字可调（旋钮文件） | `shared/behaviors/touch-feed-effect/knobs.ts` | 9 |
| 你在专心做事时，她安静下来做自己的事 | 数字可调（旋钮文件） | `shared/behaviors/user-activity/knobs.ts` | 11 |
| 屏幕共享开着时她跟着你看视频 | 数字可调（旋钮文件） | `shared/behaviors/watch-along/knobs.ts` | 4 |
| 她把聊天记忆整理成笔记，想得起以前的事 | 数字可调（旋钮文件） | `shared/memory-notes/knobs.ts` | 18 |
| haiku 调度台：你这句话是不是在叫某个模块（现在只登记了猜拳） | 数字可调（旋钮文件） | `shared/module-router/knobs.ts` | 8 |
| 其他行为 | 固定在代码里 | 见代码 | — |

## 脸红：红成什么样、多久才会再红、害羞的更容易红

旋钮文件：`shared/behaviors/blush/knobs.ts`

| 用户可能怎么说 | 改哪里 | 怎么调 |
|---|---|---|
| 她每次脸红都一个样／她脸红的样子变来变去太没准了 | `BLUSH_KNOBS.recent` | 上一次、上上次红成的那种样子，这次分量 × 这几个数；越小越不重复，1 = 不管重复 |
| 她脸红得太厉害了／她害羞的时候脸红得不够明显 | `BLUSH_KNOBS.looks.deep` | 太常 → base 调小或 mood、personality 里的倍数调小；太深太久 → depth、hold 的上限调小 |
| 脸红平时太明显了／太淡了（不是某几次，是一直都这样） | `BLUSH_KNOBS.looks.usual` | 一直都明显/淡 → 先改角色卡的脸红强度（中心值，控制窗口里也能按模型校准）；只是"红一下"这一档 → 改这里的范围 |
| 她脸红一闪就没了，看不清／她生气的时候还脸红很奇怪 | `BLUSH_KNOBS.looks.faint` | 太常 → base 调小或 mood、personality 里的倍数调小；看不清 → depth、hold 的下限调大 |
| 她脸红太频繁了／她好久才脸红一次 | `BLUSH_KNOBS.cooldown` | 红过以后至少隔"卡上的冷却 × range 里的一个数 × 性格倍数"，永远不小于卡上的；太频繁 → range 调大或先改卡上的冷却；太少 → range 的上限调小（下限是 1，不能更小） |
| 她那么害羞，摸头却不怎么脸红／她摸一下头就脸红 | `BLUSH_KNOBS.ease` | 被摸头时亲近要涨够"卡上的 fastThreshold × 性格倍数"才红；cautious 的数越负，谨慎（容易害羞）的卡越容易红、大胆的越难红；range 是最容易和最难 |
| Gene（没有自带脸红表情、靠程序在两颊画红晕的模型）红了也看不出来／程序画的红晕太浓了 | `BLUSH_KNOBS.procedural` | 程序红晕的深浅 = 1 −（1 − 原来的深浅）^ boost；1 = 原样，2 = 淡的明显加深（0.35 → 0.58）、深的几乎不变。只管程序红晕，模型自带的脸红表情不受影响 |

## 你不理她时，多久看你一眼、动一下、想开口

旋钮文件：`shared/behaviors/boredom-timing/knobs.ts`

| 用户可能怎么说 | 改哪里 | 怎么调 |
|---|---|---|
| 她每次来找我的节奏都差不多／她忽早忽晚太没规律了 | `BOREDOM_TIMING_KNOBS.recent` | 上一轮、上上轮她真的来找你时用的节奏，这次分量 × 这几个数；越小越不重复，1 = 不管重复 |
| 她看我、动一下、开口的时间还是能掐表 | `BOREDOM_TIMING_KNOBS.apartMinutes` | 同一种时机和上一次真的发生的那次至少隔几分钟（太近就往后或往前挪开；动一下和开口一起挪，不会早于卡上的时刻） |
| 她看我一眼的时间太固定了／她看我一眼忽早忽晚差太多 | `BOREDOM_TIMING_KNOBS.look` | "看你一眼"的门槛每轮 × 这个范围里的一个数；范围越宽越不固定。只管看你一眼，不管动一下和开口 |
| 她太黏了，老是很早就来找我／她开心的时候也不急着找我 | `BOREDOM_TIMING_KNOBS.tempos.eager` | 太常 → base 调小或 mood 里的倍数调小；"早"得太多 → pace 上限调小（只影响看你一眼）；动一下、开口最早就是卡上的时刻，这一档的 later 只是更贴近它 |
| 她平时找我找得太早了／太晚了（不是某几次，是一直都这样） | `BOREDOM_TIMING_KNOBS.tempos.usual` | 一直都早/晚 → 先改角色卡里的无聊参数（宽限、涨速、三个门槛是中心，要你点确认）；只是"照常"这一档 → 改这里的范围 |
| 她找我找得太晚了／她累了、不高兴的时候还是那么早来找我 | `BOREDOM_TIMING_KNOBS.tempos.unhurried` | 太常 → base 调小或 mood、moments 里的倍数调小；太晚 → later、grace 的上限调小，或 pace 的下限调大（涨得慢时门槛不低于卡上的，会更晚） |

## 最近聊得多，她主动开口的上限跟着提高

旋钮文件：`shared/behaviors/busy-chat/knobs.ts`

| 用户可能怎么说 | 改哪里 | 怎么调 |
|---|---|---|
| 我刚才聊了半天她怎么还是那么安静／聊完很久她还是话多 | `BUSY_CHAT_KNOBS.windowMinutes` | 只数最近多少分钟里你发的消息（越长，聊完以后"热乎劲"退得越慢） |
| 我才聊了几句就开始变话多／聊了好多她还是老样子 | `BUSY_CHAT_KNOBS.busyAt` | 最近这么多条消息起算"聊得多" |
| 聊得特别热的时候她还可以更主动 | `BUSY_CHAT_KNOBS.veryBusyAt` | 最近这么多条消息起算"聊得很热" |
| 聊得多时她两次主动开口隔得还是太久 | `BUSY_CHAT_KNOBS.busyInterval` | 两次主动开口的最短间隔 × 几（0.75 = 缩短四分之一；1 = 不缩） |
| 聊得特别热时她还是隔很久才主动说一句 | `BUSY_CHAT_KNOBS.veryBusyInterval` | 同上，聊得很热那一档（0.5 = 缩短一半） |
| 聊得多时她一小时还是说得太少 | `BUSY_CHAT_KNOBS.busyExtra` | 每小时主动开口上限加几句 |
| 聊得特别热时一小时还能多说几句 | `BUSY_CHAT_KNOBS.veryBusyExtra` | 同上，聊得很热那一档 |
| 黏人的她聊得多时应该更主动 | `BUSY_CHAT_KNOBS.clingyWeight` | 黏人倾向每高 50 点，系数多几（0.6 = 倾向 100 时系数 1.6） |
| 克制的她聊得多也不该一下子话多 | `BUSY_CHAT_KNOBS.restrainedWeight` | 克制倾向每高 50 点，系数少几 |
| 性格对话多话少的影响太大／太小 | `BUSY_CHAT_KNOBS.scaleRange` | 性格系数最低、最高各是几（1 = 不受性格影响） |
| 我没回她，她还是隔不久就又来一句／我没回她，她就彻底不说了 | `BUSY_CHAT_KNOBS.unansweredFactor` | 你一直没回应时，她下一次主动开口的最短间隔 × 几（3 = 30 分钟变 90 分钟；你还没回、她又说了一句就再 × 一次：270 分钟）。1 = 不拉长；你一回应就恢复。热聊放宽先算，这个倍数乘在后面 |
| 我一直不回，她隔太久才又来一句／我没回她，她还是隔不久就来 | `BUSY_CHAT_KNOBS.unansweredCapMinutes` | 你一直没回应时，拉长后的间隔最多这么多分钟（默认 90：30 分钟的卡没回应 1 句后 90 分钟，之后再不回也是 90）。卡自己的间隔已经更长就用卡的，不会因为封顶变短 |

## 喂点心时的语气词和吃法

旋钮文件：`shared/behaviors/feed-cue/knobs.ts`

| 用户可能怎么说 | 改哪里 | 怎么调 |
|---|---|---|
| 她吃东西的声音太单调了／她老是两种声音换着来 | `FEED_CUE_KNOBS.recentBefore` | 上上次出过的那一声，这次分量 × 这个数（上一次的那一声这次一定不出，写死）；越小越不重复，1 = 不管上上次 |
| 她张嘴老是"啊～"／"啊～"太少了 | `FEED_CUE_KNOBS.open.ah` | 太常 → base 调小或 mood 里的倍数调小；这是原来那一声，平静的时候最常见 |
| 她看到吃的不够惊喜／她老是"哇"太夸张了 | `FEED_CUE_KNOBS.open.wa` | 太常 → base 调小或 mood、taste 里的倍数调小；太少 → 反过来 |
| 她吃东西太斯文了，不够调皮／"嗷呜"不像她 | `FEED_CUE_KNOBS.open.aowu` | personality.playful 是"爱玩的卡更常这样"；不像她 → base 调小（或改 text） |
| 她吃东西太大声了／她害羞的时候也太放得开了 | `FEED_CUE_KNOBS.open.soft` | personality.cautious 是"谨慎（容易害羞）的卡更常小声"；太常 → base 调小 |
| 上次喂了不是吃的，她这次一点都不怀疑／她老是"嗯？"像不信任我 | `FEED_CUE_KNOBS.open.huh` | taste.notFood 是"不久前喂过不是吃的"时的倍数；full 是吃腻了时的倍数；太常 → base 调小 |
| 她每次都要出声，太吵了／她张嘴老是不出声 | `FEED_CUE_KNOBS.open.quiet` | 太常 → base 调小或 moments、full 里的倍数调小；想更安静 → 调大 |
| 她吃到老是"嗯～"／"嗯～"太少了 | `FEED_CUE_KNOBS.eat.mm` | 这是原来那一声；太常 → base 调小 |
| 她吃到好吃的不够开心／她吃什么都"嗯嗯！"太夸张了 | `FEED_CUE_KNOBS.eat.yum` | landing.full 是"这一块吃得很香"时的倍数；太常 → base 调小 |
| 她从来不说好吃／她老是说好吃，敷衍 | `FEED_CUE_KNOBS.eat.haochi` | word 表示认图会说一句时不出现（不抢话）；太常 → base 调小或 landing.full 调小 |
| 她嚼东西的声音不够满足／"唔嗯"太闷了 | `FEED_CUE_KNOBS.eat.wuen` | personality.comfortable 是"随和（会享受）的卡更常这样"；太常 → base 调小 |
| 她吃腻了也不表现出来／她老是勉强的样子 | `FEED_CUE_KNOBS.eat.wu` | landing.light 是"这一块没什么胃口"时的倍数，full 是吃腻了时的倍数；太常 → base 调小 |
| 她吃东西每次都出声，太吵了／她嚼着嚼着不出声了 | `FEED_CUE_KNOBS.eat.quiet` | 太常 → base 调小或 landing、moments 里的倍数调小 |
| 她吃多了还那么积极／她第三块就慢吞吞的 | `FEED_CUE_KNOBS.manner.start` | 腻到这个程度（0～1，由新鲜感算出来的）才开始慢下来；越大越晚，1 = 永远照旧 |
| 她吃饱了张嘴还是那么快／她张嘴慢得像卡住了 | `FEED_CUE_KNOBS.manner.open` | 腻到底时张嘴快慢 × rate 里抽的数、张多大 × size 里抽的数（1 = 照旧）；只会更慢、更小，不会比原来快 |
| 她吃饱了嚼得还是那么快 | `FEED_CUE_KNOBS.manner.chew` | 腻到底时嚼的快慢 × rate 里抽的数、嚼的幅度 × size 里抽的数（1 = 照旧） |
| 她吃撑了也不摇头／她老是摇头，像不想吃 | `FEED_CUE_KNOBS.manner.shake` | chance × 腻的程度 = 这次摇头的机会（再乘 mood 里的倍数）；amplitude 是摇多大（弧度，0.03 ≈ 1.7 度），ms 是摇多久 |
| 上次喂了不是吃的，她这次还是张大嘴 | `FEED_CUE_KNOBS.manner.wary` | 不久前喂过不是吃的时，张嘴快慢 × rate、张多大 × size（再叠在吃腻上） |
| 她早就忘了上次喂的是什么，还在怀疑 | `FEED_CUE_KNOBS.tasteMinutes` | 认图认出的口味（爱吃、不合口味、不是吃的）在这么多分钟里影响下一块的声音和张嘴 |

## 她闲着时"动一动""看你一眼"的样子和表情

旋钮文件：`shared/behaviors/idle-gesture/knobs.ts`

| 用户可能怎么说 | 改哪里 | 怎么调 |
|---|---|---|
| 她动来动去太多了、动作太大太明显；她动得太小，看不出她在动 | `IDLE_GESTURE_KNOBS.size` | 所有样子的幅度一起 × 这个数（1 是现在，0.5 是一半）。要是说的是"多久动一次"，那是"你不理她时"那一节的无聊门槛，不在这里 |
| 她老重复同一个动作／她太刻意地不重复了 | `IDLE_GESTURE_KNOBS.recent` | 上一次、上上次、再上一次挑过的样子和表情，分量 × 这几个数；越小越不重复，1 = 不管重复 |
| 她老是歪头／她怎么不歪头了／歪头歪得太厉害了 | `IDLE_GESTURE_KNOBS.shapes.tilt` | 太多/太少 → base（多常用，0 = 不用它）；太厉害/太轻 → amplitude（幅度范围，弧度）；太快/太慢 → pace |
| 她老点头／她怎么从来不点头／点头太用力了 | `IDLE_GESTURE_KNOBS.shapes.nod` | 太多/太少 → base（多常用，0 = 不用它）；太厉害/太轻 → amplitude（幅度范围，弧度）；太快/太慢 → pace |
| 她老往旁边看／她看向一边太远了 | `IDLE_GESTURE_KNOBS.shapes.glance` | 太多/太少 → base（多常用，0 = 不用它）；太厉害/太轻 → amplitude（幅度范围，弧度）；太快/太慢 → pace |
| 她老抬眼看我／她都不看我 | `IDLE_GESTURE_KNOBS.shapes.lift` | 太多/太少 → base（多常用，0 = 不用它）；太厉害/太轻 → amplitude（幅度范围，弧度）；太快/太慢 → pace |
| 她老伸脖子／伸得太夸张了 | `IDLE_GESTURE_KNOBS.shapes.stretch` | 太多/太少 → base（多常用，0 = 不用它）；太厉害/太轻 → amplitude（幅度范围，弧度）；太快/太慢 → pace |
| 原来那个轻轻晃一下头太多了／太少了 | `IDLE_GESTURE_KNOBS.shapes.sway` | 太多/太少 → base（多常用，0 = 不用它）；太厉害/太轻 → amplitude（幅度范围，弧度）；太快/太慢 → pace |
| 她闲着时太没表情了／太多表情了 | `IDLE_GESTURE_KNOBS.faces.plain` | 太多/太少 → base（多常用，0 = 不用它）；笑多笑少 → smile |
| 她老是一副若有所思的样子 | `IDLE_GESTURE_KNOBS.faces.convinced` | 太多/太少 → base（多常用，0 = 不用它）；笑多笑少 → smile |
| 她笑得太多了／她闲着时都不笑 | `IDLE_GESTURE_KNOBS.faces.smile` | 太多/太少 → base（多常用，0 = 不用它）；笑多笑少 → smile |
| 她老是害羞地笑／不够害羞 | `IDLE_GESTURE_KNOBS.faces.shy` | 太多/太少 → base（多常用，0 = 不用它）；笑多笑少 → smile |
| 她闲着时太开心了／不够开心 | `IDLE_GESTURE_KNOBS.faces.happy` | 太多/太少 → base（多常用，0 = 不用它）；笑多笑少 → smile |
| 她难过的时候闲着也太丧了 | `IDLE_GESTURE_KNOBS.faces.mood` | 太丧 → base 调小（她更常"只是看着"）；这是原来的做法，serious 第二个数 0 = 心情不沉重时从不用它 |
| 摸完头好一会儿了，她还当是刚被摸过 | `IDLE_GESTURE_KNOBS.moments.pat` | 多久以内算"不久前被摸过头"（毫秒） |
| 捏完脸好一会儿了，她还当是刚被捏过 | `IDLE_GESTURE_KNOBS.moments.pinch` | 多久以内算"不久前被捏过脸"（毫秒） |
| 喂完点心好一会儿了，她还当是刚吃过 | `IDLE_GESTURE_KNOBS.moments.food` | 多久以内算"不久前吃过点心"（毫秒） |
| 她才闲了一会儿就开始伸脖子 | `IDLE_GESTURE_KNOBS.moments.bored` | 无聊到多少（0～100）算"闲了很久" |

## 她自己想事情（内心循环）的节奏：忽长忽短，深夜和你不在时拉长

旋钮文件：`shared/behaviors/inner-rhythm/knobs.ts`

| 用户可能怎么说 | 改哪里 | 怎么调 |
|---|---|---|
| 她隔多久想一次太有规律／她想事情的节奏忽快忽慢太乱了 | `INNER_RHYTHM_KNOBS.spread` | 随机倍数最多再长多少（1.1 = 最长是原来最短间隔的约 2 倍；0 = 不随机，回到每次一样） |
| 她总是隔很久才想一次／总是隔差不多的时间 | `INNER_RHYTHM_KNOBS.shape` | 越大越偏向短的一边（1 = 平均；2 = 多数接近原来的最短间隔，偶尔隔很久） |
| 爱玩的她应该更勤快／安静的她应该更慢 | `INNER_RHYTHM_KNOBS.spreadByPlayful` | spread 再 ÷ playful 权重，夹在这两个数之间（第一个数越小，爱玩的卡越勤快） |
| 她这次和上次想事情的间隔怎么又一样 | `INNER_RHYTHM_KNOBS.differentBy` | 新抽的倍数和上一次差得不到这个比例（占 spread），就再抽一次取离上次更远的 |
| 我睡觉的时候她还一直在想事情／深夜她太安静了 | `INNER_RHYTHM_KNOBS.night` | 深夜（她的作息算出的那一段）里最短间隔 × 几；1 = 不拉长 |
| 她一犯困就该安静下来 | `INNER_RHYTHM_KNOBS.drowsy` | 只是"有点困"（还没到深夜）时 × 几 |
| 我出去半天了她还在隔十几分钟想一次 | `INNER_RHYTHM_KNOBS.awayFromMinutes` | 你离开多少分钟之后才开始拉长 |
| 我走了之后她安静得太快／太慢 | `INNER_RHYTHM_KNOBS.awayRampMinutes` | 过了上面那个时间，每多这么多分钟，倍数多 1 |
| 我一整天不在，她还是隔挺久就问一次 | `INNER_RHYTHM_KNOBS.awayMax` | 你不在时倍数的上限 |
| 我锁屏离开了她还在想事情 | `INNER_RHYTHM_KNOBS.awayState` | 系统读到你人不在（锁屏、很久没碰键盘鼠标）时，不在倍数至少是几 |
| 你少说点话吧／她太安静了，多找我聊聊 | `INNER_RHYTHM_KNOBS.talkLess` | 设置选「少一点」时，最短间隔再 × 几（2 = 约一半的次数） |
| 她能不能多找我说说话 | `INNER_RHYTHM_KNOBS.talkMore` | 设置选「多一点」时，最短间隔 × 几（0.6 = 更勤快；结果最低夹回原来的最短间隔，所以只会压掉随机拉长和深夜/不在的那部分） |

## 互动余额：她自己主动做的事有多少，跟着你们最近的互动和她的性格

旋钮文件：`shared/behaviors/interaction-budget/knobs.ts`

| 用户可能怎么说 | 改哪里 | 怎么调 |
|---|---|---|
| 我们聊了好多，她还是不怎么主动／我就发了几句，她就变得很热情 | `INTERACTION_BUDGET_KNOBS.gains.message` | 你发一条消息给她攒多少；调大 → 聊得多以后她更活跃 |
| 我回了她主动说的话，她好像也没更愿意找我 | `INTERACTION_BUDGET_KNOBS.gains.answer` | 你接住她主动说的那句（她说完、你还没回时你发的第一条，或在她的猜拳邀请上点"来！/下次吧"）攒多少；比普通消息多，因为说明你愿意接她的话 |
| 我摸摸她、喂她，她之后也不怎么找我 | `INTERACTION_BUDGET_KNOBS.gains.touch` | 一次摸头或捏脸（从按下到松开算一次）攒多少 |
| 我走开一会儿回来，她攒着一堆话倒给我／我才走开一会儿，她就没劲了 | `INTERACTION_BUDGET_KNOBS.halfLifeHours` | 攒下的余额过多少小时少一半；越小越快回到安静 |
| 聊了一整天以后，她一直停不下来 | `INTERACTION_BUDGET_KNOBS.earnedMax` | 攒下的最多多少（保底另算）；调小 → 再热闹也不会攒太多 |
| 我一整天没理她，她一次都不来找我／我不理她，她还是隔一会儿就来 | `INTERACTION_BUDGET_KNOBS.floor.max` | 保底最多多少；1 = 和原来一样，无聊久了还能来找你一次（"没人回应最多几句"照旧管着追不追着说） |
| 我一天只来几下，她还是挺主动的／我隔很久才来一下，她都没精神找我 | `INTERACTION_BUDGET_KNOBS.floor.perHour` | 保底每小时长回多少（0.125 = 8 小时长满，一晚上正好长满）；越小，你一直不来、或者只偶尔来一下时她越安静 |
| 我好久没理她，她还冒出小情绪／猜拳里话多 | `INTERACTION_BUDGET_KNOBS.floor.pays` | 保底只用来做这几件：无聊久了还能看你一眼、说一句；不在这里的（小情绪、猜拳里一句、停停说说）只能用你最近的互动攒下的 |
| 她主动找我说话太勤了／太少了（和你们最近聊得多少有关时） | `INTERACTION_BUDGET_KNOBS.costs.speak` | 主动开口一次花多少（她挑说自己的小情绪、聊刚听完的、看一看屏幕、邀你玩，都在这一次说话时机里，先看余额够不够这一项） |
| 她的小情绪（有点闷、想找人说话……）太多了／我们挺热闹的她也没有 | `INTERACTION_BUDGET_KNOBS.costs.need` | 开始一件小需要花多少；比普通开口"重"一点 |
| 猜拳时她话太多了／太少了 | `INTERACTION_BUDGET_KNOBS.costs.gameLine` | 猜拳里她说一句花多少（每局一次一句的规则照旧在猜拳那边） |
| 停停说说开着时，安静的角色也每条都问 haiku | `INTERACTION_BUDGET_KNOBS.costs.pausePlan` | 停停说说每条消息问一次 haiku 花多少（你发消息本身会攒 1，所以聊天时几乎总有余额） |
| 她停下来等我，我没接，她又自己接着说下去了（我不在的时候也这样） | `INTERACTION_BUDGET_KNOBS.costs.continue` | 停停说说里"等你没接、她接着说完"花多少；余额不够时她这条回复就不停下来等你，一口气说完 |
| 半夜她还是挺主动的 | `INTERACTION_BUDGET_KNOBS.nightCost` | 深夜（她的作息里的夜里）花费 × 这个数；深夜本来就只剩提醒休息，这里只让她更安静 |
| 黏人的角色也不怎么主动／谨慎的角色太主动了 | `INTERACTION_BUDGET_KNOBS.character.close` | 花费的性格倍数 = 1 + close ×（黏人 − 1）+ playful ×（爱玩 − 1）+ cautious ×（谨慎 − 1），再夹在 min～max；负数 = 越黏人花得越少 |
| 安静的角色也和活泼的一样费额度 | `INTERACTION_BUDGET_KNOBS.share.pausePlan` | 停停说说里，性格倍数大于 1（安静、谨慎）的角色每条消息问 haiku 的机会 = 1 / 倍数，最少这么多；活泼的照旧每条都问 |
| 她很想我的时候也憋着不说 | `INTERACTION_BUDGET_KNOBS.strong.from` | 心情有多强烈（0～1）从 from 开始越过余额的压低，到 full 完全不压；moods 是哪几种心情算多强烈 |
| 她刚邀请过我玩，又邀请／玩完没多久她又来邀请 | `INTERACTION_BUDGET_KNOBS.again.invite` | 上次邀请（或上次玩完）以后，你们之间要再有几次互动她才可能再邀请（原来是隔 2 小时、玩完 1 小时、每天最多 2 次） |

## 心情调整员：haiku 在后台按"此刻"再微调一下她的心情（默认关）

旋钮文件：`shared/behaviors/mood-judge/knobs.ts`

| 用户可能怎么说 | 改哪里 | 怎么调 |
|---|---|---|
| 她想了想以后的变化来得太慢了／问得太勤了 | `MOOD_JUDGE_KNOBS.gatherMs` | 第一件事来了以后先等多少毫秒再问，把挨得近的事收成一批（喂食和认图结果、你的话和她的尾注） |
| 一天问 haiku 的次数太多了／她的心情跟不上发生的事 | `MOOD_JUDGE_KNOBS.spacingMs` | 两次问 haiku 至少隔多少毫秒（隔得越久次数越少，但期待、激活这种几分钟就回落的数就赶不上了） |
| 她回我话的时候电脑好像卡了一下 | `MOOD_JUDGE_KNOBS.busyRecheckMs` | 她正在回你话（或上一次还没答完）时，过多少毫秒再看一次能不能问；她这条回复说完才问，不和第一个字抢 |
| haiku 卡住了，好久都没结论 | `MOOD_JUDGE_KNOBS.timeoutMs` | 问出去多少毫秒还没答就放弃这一批（不重试） |
| 很久以前的事她现在才"想了想"，接不上 | `MOOD_JUDGE_KNOBS.staleMs` | 一批收完（到了该问的时候）以后，过了多少毫秒还没问出去、或答案还没回来，就整批丢掉 |
| 怕它出错把额度刷光／聊得少的一天她也该"想一想" | `MOOD_JUDGE_KNOBS.callsPerDay` | 一天问 haiku 的打底次数（本地零点重置，重启不清零）；当天的上限 = 这个数 + 下面的"每聊一句加几次"× 今天和她聊的句数，不超过再下面的"最多"。超了当天只用本机规则。当天的上限会随聊天句数增加 |
| 聊得多的一天傍晚以后她就不"想一想"了／聊得多的时候问得太勤 | `MOOD_JUDGE_KNOBS.callsPerChat` | 今天和她每聊一句（打字或语音），当天的上限多几次。2 = 聊 50 句的普通一天上限约 220，聊 120 句约 360（模拟的实际用量约 78 和 180） |
| 怕哪天聊得特别多把额度刷光 | `MOOD_JUDGE_KNOBS.callsPerDayMax` | 不管聊多少，一天最多问 haiku 多少次 |
| 她想了想以后变化太大了／几乎看不出变化 | `MOOD_JUDGE_KNOBS.perCall` | 每次每个数最多加减多少。期待（D）、激活（N）几分钟就回落一半，晚到的修正留不住，所以只给 ±3；haiku 主要调亲近（O）、舒适（E）、压力（C） |
| 我说的话 Opus 已经判断过了，haiku 又改了一遍，改反了 | `MOOD_JUDGE_KNOBS.afterOpus` | 这一批里有你说的话、而且 Opus 的尾注已经生效时，每个数最多再修这么多（Opus 先生效，haiku 在旁边看合不合理） |
| 她想了想以后整个人都变了 | `MOOD_JUDGE_KNOBS.totalPerCall` | 一次五个数加减的绝对值合起来最多多少；超了按比例一起缩小 |
| 她被 haiku 越调越低（或越高），回不来了 | `MOOD_JUDGE_KNOBS.hourlyNet` | 一小时内，haiku 对同一个数的修正合起来最多加减多少（越接近满分越难再加，这条照用） |
| haiku 自己都拿不准还乱改 | `MOOD_JUDGE_KNOBS.minConfidence` | haiku 的把握低于这个数（0～1），整条答案不用 |
| 她的心情被 haiku 来回拉扯 | `MOOD_JUDGE_KNOBS.reversal` | windowMs 毫秒内把自己上一次的修正反过来时，幅度乘 factor（0.5 = 减半） |
| 事情一多，haiku 看漏了 | `MOOD_JUDGE_KNOBS.maxEvents` | 一批最多交给 haiku 看几件事，再多的只说"还有几件小事"（越多每次越费 token） |
| 我说了一大段话，haiku 只看到开头 | `MOOD_JUDGE_KNOBS.userTextChars` | 你说的话最多交给 haiku 多少个字（和发给 Opus 的是同一句，只截短，不多给） |
| 我隔了一会儿才回她，haiku 却当我没理她 | `MOOD_JUDGE_KNOBS.herLineAnswerMs` | 她主动说了一句以后，多少毫秒内你发了消息就算"你回了"，过了就算"没人回" |
| 我只是去倒了杯水，她就当我"回来了" | `MOOD_JUDGE_KNOBS.returnAfterMs` | 离开多少毫秒以后第一次互动，才算"你回来了" |
| 我切了一下窗口，她就以为我换了事做 | `MOOD_JUDGE_KNOBS.screenHoldMs` | 屏幕共享开着时，新的事（写代码、看视频……）要做满多少毫秒才算"你换了在做的事" |
| haiku 不了解她的性格，调得不像她 | `MOOD_JUDGE_KNOBS.personaChars` | 交给 haiku 的性格摘要最多多少个字（取自角色卡的性格和描述；越长越费 token） |
| 开发者面板里心情调整员那一行想多看几条 | `MOOD_JUDGE_KNOBS.whyKept` | 开发者面板"心情调整员"那一行最多留几次 |

## 她想找你说话时，这次说什么

旋钮文件：`shared/behaviors/opening-choice/knobs.ts`

| 用户可能怎么说 | 改哪里 | 怎么调 |
|---|---|---|
| 她老说同一类事（上次说屏幕这次还说屏幕）／她太刻意地换话题了 | `OPENING_CHOICE_KNOBS.recent` | 上一次、上上次挑过的那一类，分量 × 这几个数；越小越不重复，1 = 不管重复（从不完全排除） |
| 她太爱聊歌了／一起听的时候她都不聊歌 | `OPENING_CHOICE_KNOBS.candidates.listen` | 太多/太少 → base（0 = 一起听时从不聊歌）；深夜、困的时候 → moments 里的 night、drowsy（现在约三分之一） |
| 她太爱说屏幕了／开着屏幕主动聊天她也很少说屏幕 | `OPENING_CHOICE_KNOBS.candidates.screen` | 太多/太少 → base（0 = 开着也从不说屏幕）；深夜、困的时候 → moments 里的 night、drowsy（现在约三分之一） |
| 她老说自己的小情绪、撒娇太多了／她从来不说自己的事 | `OPENING_CHOICE_KNOBS.candidates.mood` | 太多/太少 → base；她正好有一件小需要时更想说多少 → moments.need |
| 她老邀我玩猜拳／她都不邀我玩 | `OPENING_CHOICE_KNOBS.candidates.play` | 太多/太少 → base（0 = 从不在这里邀你玩）；什么时候能邀（每天几次、刚玩过不邀）是猜拳自己的规则，不在这里 |
| 她太安静了，到了想说话的时候老是不说／她太吵了，该多安静一点 | `OPENING_CHOICE_KNOBS.candidates.quiet` | 太多/太少 → base；谨慎的卡更常不说 → personality.cautious；深夜、困了、上次想说话你没来 → moments |
| 她才闲了一会儿就说自己无聊 | `OPENING_CHOICE_KNOBS.moments.bored` | 无聊到多少（0～100）算"闲了很久"；开口时机本身要到卡上的说话门槛（默认 75）才有 |
| 我在专心做事的时候她还是来找我说话／我专心的时候她一句都不说了 | `OPENING_CHOICE_KNOBS.moments.busy` | 各候选里的 moments.busy 倍数：想找你说话的几件 <1，"这次不要" >1；小情绪的倍数最大、再加上心情倍数，所以她很想你、有小情绪时仍然能开口 |

## 停停说说：haiku 按她的性格和心情决定说到哪停、停多久、要不要停下来等你（默认关）

旋钮文件：`shared/behaviors/pause-talk/knobs.ts`

| 用户可能怎么说 | 改哪里 | 怎么调 |
|---|---|---|
| 开了停停说说以后，发消息她第一个字好像慢了 | `PAUSE_TALK_KNOBS.startDelayMs` | 你发出消息后，等多少毫秒再起 haiku 的进程（和调度台一样：起进程占主线程约 20 毫秒，晚一点起，Opus 那一轮先写出去）；太大则 haiku 更常来不及 |
| haiku 卡住了，她的节奏一直是老样子 | `PAUSE_TALK_KNOBS.timeoutMs` | 从你发出消息算起，haiku 多少毫秒还没答就放弃这一次（之后的气泡照原来的公式出） |
| 她停一下的时候太短了，看不出来在想 | `PAUSE_TALK_KNOBS.pauseMinMs` | 一处小停顿最短多少毫秒；haiku 给得比这还短就当没停 |
| 她停一下停得太久了，像卡住了 | `PAUSE_TALK_KNOBS.pauseMaxMs` | 一处小停顿最长多少毫秒；haiku 给得更长就按这个算 |
| 她一条回复里停得太多了，说一句停一句 | `PAUSE_TALK_KNOBS.maxPauses` | 一条回复最多几处小停顿（多出来的不用） |
| 她停下来等我，没等一会儿就又自己说下去了 | `PAUSE_TALK_KNOBS.waitMinMs` | 停下来等你，最少等多少毫秒 |
| 她停下来等我太久了，后面的话半天不出来 | `PAUSE_TALK_KNOBS.waitMaxMs` | 停下来等你，最多等多少毫秒；过了还没人接，她就把留着的话接着说完 |
| （一般不用改） | `PAUSE_TALK_KNOBS.maxAfter` | haiku 最多能说"第几句"以后停；更大的数当答得不对 |
| 我正在打字回她，她却自己接着说下去了 | `PAUSE_TALK_KNOBS.typingRecheckMs` | 她等你接话时，等完发现你输入框里有字，再隔多少毫秒看一次 |
| 我输入框里留着字，她就一直不往下说 | `PAUSE_TALK_KNOBS.typingMaxMs` | 因为你在打字而多等的时间，最多加多少毫秒 |
| 我打断她以后，她下一句老是提上一条没说完的话／提得太长 | `PAUSE_TALK_KNOBS.backgroundMaxChars` | 没说出口的那段，最多带多少个字进下一轮的背景（多的截掉，加"……"） |
| （一般不用改） | `PAUSE_TALK_KNOBS.userChars` | 你这条消息最多给 haiku 看多少个字 |
| （一般不用改） | `PAUSE_TALK_KNOBS.personaChars` | 她的性格摘要（角色卡的性格和描述）最多给 haiku 看多少个字 |
| 怕它出错把额度刷光 | `PAUSE_TALK_KNOBS.callsPerDay` | 一天最多问 haiku 多少次（只在内存里数，重启从 0 数）；平时每条回复一次，普通的一天 30～80 次，只防出错时刷额度 |
| 开发者面板里停停说说那一行想多看几条 | `PAUSE_TALK_KNOBS.whyKept` | 开发者面板最多留几条回复的节奏 |

## 她的即时反应（反应清单、打分、haiku 挑）

旋钮文件：`shared/behaviors/reactions/knobs.ts`

| 用户可能怎么说 | 改哪里 | 怎么调 |
|---|---|---|
| 夸她的时候脸红得太少／太多了／摸头摸一下就红 | `REACTION_TABLE.blush` | events 里各事件的基础分；lean.shy 是害羞的人多红多少；recent 是刚红过以后多久才容易再红（不是冷却，分够高照样红） |
| 被夸了也不害羞／老是低头害羞 | `REACTION_TABLE.shy` | 害羞＝一下子低头、垂眼看向一边、脸红、抿嘴笑，约 3 秒；events 是各事件的基础分，lean.shy 是害羞的人多做多少 |
| 报喜的时候她不够开心／一点小事就乐 | `REACTION_TABLE.happy` | 开心＝心情往"愉快"那边抬一下（期待、舒适涨一点，脸上跟着笑），轻重见下面 happyLift |
| 她点头点得太多／听到我关心她也不点头 | `REACTION_TABLE.nod` | — |
| 撒娇的时候想看她歪头 | `REACTION_TABLE.tilt` | — |
| 比心太多／撒娇的时候想要她比心 | `REACTION_TABLE.heart` | — |
| 我报喜她都不鼓掌／一点小事就鼓掌 | `REACTION_TABLE.clap` | — |
| 想看她俏皮地眨眼 | `REACTION_TABLE.wink` | — |
| 捏她脸的时候想看她撅嘴 | `REACTION_TABLE.pout` | — |
| 她挥手挥得莫名其妙 | `REACTION_TABLE.wave` | — |
| 所有反应都触发得再敏感一点／太敏感了 | `REACTION_KNOBS.offset` | 整体偏移：每种反应的分数统一加这么多（正数更容易有反应，负数更少） |
| 同样的事她每次反应都一模一样 | `REACTION_KNOBS.jitter` | 每次打分加减一个不超过这么多的随机数（在她的性格范围里变） |
| haiku 挑来挑去总是那几个 | `REACTION_KNOBS.candidates` | 每一类事件交给 haiku 的候选最多几个（按分数从高到低） |
| 她做了一些完全不像她的反应 | `REACTION_KNOBS.floor` | 分数低于这个数的反应不进候选 |
| 摸头、捏脸、喂点心时她没什么反应／反应太多 | `REACTION_KNOBS.actAt` | 不问 haiku 时（身体互动、haiku 没答），最高分到了这个数才做 |
| 摸了好一会儿她才有反应／刚碰到头就害羞 | `REACTION_KNOBS.patRise` | 一次摸头只反应一次；这一次摸头里亲近涨到角色卡"亲近门槛"的这么多倍时反应（原来的脸红要涨满 1 倍） |
| 脸红总是很淡／一下子红透了 | `REACTION_KNOBS.levelAt` | 不问 haiku 时，分数到 mid 算"中"，到 strong 算"重"，再低是"轻" |
| 一句话她做了一堆反应 | `REACTION_KNOBS.maxPicks` | 一句话 haiku 最多挑几个反应 |
| 她的心情还是太平／一句话心情就变了好多 | `REACTION_KNOBS.moodBlend` | haiku 和她自己的回复尾注都给了心情变化时，各占多少（加起来 1）；只有一边给时用那一边 |
| haiku 给的心情变化太大 | `REACTION_KNOBS.maxDelta` | haiku 给的每个心情数最多加减多少（和她回复尾注的上限一样） |
| 发消息以后她第一个字好像慢了一点 | `REACTION_KNOBS.startDelayMs` | 你发出消息后至少等多少毫秒再起 haiku 的进程（让她的回复先写出去） |
| 发消息以后她第一个字慢了／她的反应来得太晚 | `REACTION_KNOBS.firstCharWaitMs` | haiku 等她回复的第一个字出来再起（实测：和她的回复同时起，第一个字中位慢约 0.5 秒）；第一个字一直没来时最多等这么多毫秒 |
| 她的反应来得太晚／发消息以后她第一个字慢了 | `REACTION_KNOBS.warmParallel` | true（默认）= 有提前待命的 haiku 时，发出后 startDelayMs 就和她的回答同时问（反应约 1.7 秒到，第一个字偶尔慢一点）；false = 等她第一个字出来再问待命的 haiku（约 2.9 秒到，第一个字不受影响） |
| haiku 卡住了，好久都没反应 | `REACTION_KNOBS.timeoutMs` | 从起 haiku 算起，多少毫秒还没答就放弃，改用她回复尾注的语境挑 |
| haiku 拿不准还乱做反应 | `REACTION_KNOBS.minConfidence` | haiku 的把握（0～1）低于这个数，它的答案整条不用（改用尾注的语境挑） |
| 我说了一大段话，haiku 只看到开头 | `REACTION_KNOBS.userTextChars` | 你说的话最多交给 haiku 多少个字（和发给 Opus 的是同一句，只截短） |
| haiku 不了解她，挑得不像她 | `REACTION_KNOBS.personaChars` | 交给 haiku 的角色卡性格摘要最多多少个字（倾向总会给） |
| 怕刷额度／聊得少的一天也要有反应 | `REACTION_KNOBS.callsPerDay` | 一天问 haiku 的打底次数；当天上限 = 这个数 + 每聊一句加的次数 × 今天聊的句数，不超过"最多"（和心情调整员同一个公式） |
| 聊得多的时候傍晚以后她就没反应了 | `REACTION_KNOBS.callsPerChat` | 今天和她每聊一句，当天的上限多几次 |
| 怕哪天聊得特别多把额度刷光 | `REACTION_KNOBS.callsPerDayMax` | 不管聊多少，一天最多问 haiku 多少次（超了只用尾注的语境挑） |
| 害羞和点头挤在一起了 | `REACTION_KNOBS.stageGapMs` | 两个要占舞台的反应（害羞、小动作）一前一后时，第二个在第一个做完后再等多少毫秒 |
| 捏完脸她过了好久才害羞 | `REACTION_KNOBS.freeWaitMs` | 她正在别的互动里（被摸头、在吃）时，要占舞台的反应最多等她空下来多少毫秒，等不到就不做 |
| 开心的反应太淡／太夸张 | `REACTION_KNOBS.happyLift` | 开心轻、中、重各让期待（D）和舒适（E）抬多少（乘角色卡敏感度；期待几分钟就回落一半） |
| 脸红轻重看不出区别 | `REACTION_KNOBS.blushStrength` | 脸红轻、中、重各红多深（0～1，再乘角色卡的脸红强度） |
| 摸摸/夸她时脸红太淡，几乎看不出 | `REACTION_KNOBS.blushFloor` | 反应脸红最深时至少红到多少（0～1，再乘上面轻中重；角色卡脸红强度更高时按角色卡的；角色卡把脸红关了或设成 0 仍然不红；和平时心情带出的脸红无关） |
| 近期惩罚记得太久 | `REACTION_KNOBS.recentKept` | 每个角色记住最近多少次做过的反应（算近期惩罚用） |

## 回复说完以后，气泡留多久

旋钮文件：`shared/behaviors/reply-linger/knobs.ts`

| 用户可能怎么说 | 改哪里 | 怎么调 |
|---|---|---|
| 一大段话还没看完就收了／气泡挂得太久了，一直挡着她 | `REPLY_LINGER_KNOBS.range` | 最短、最长各留多少毫秒（[2500, 20000] 是 2.5～20 秒）。太长的段落会被截在最长，全文可以点"查看完整回复" |
| 我读字慢，一段话还没读完就没了／我读得快，气泡留得太久了 | `REPLY_LINGER_KNOBS.readable.charsPerSecond` | 每秒按几个字算"读得完"。6 = 每分钟 360 字：普通成年人默读中文大约每分钟 300～500 字，桌面上的气泡是瞥一眼读的，取偏慢的一端。调小 = 留得更久 |
| 我还没注意到气泡，它就收了 | `REPLY_LINGER_KNOBS.readable.noticeMs` | 注意到气泡、把眼睛移过去要多久（毫秒），算在"读得完"里 |
| 她说英文的时候气泡留得太久了／太短了 | `REPLY_LINGER_KNOBS.readable.lettersPerChar` | 几个英文字母或数字算一个字（3 = 一个英文单词大约像读 1～2 个汉字）。汉字、假名、表情各算 1 个字，标点和空格不算 |
| 气泡留久一点／气泡收得太突然，读完马上就没了／读完以后还挂着太久 | `REPLY_LINGER_KNOBS.after` | 读完以后再留多久（毫秒），每次在这两个数之间随机取一点：两个数一起加大 = 每个气泡都多留一会儿；两个数差得越多，同一句话两次留的时间差得越多 |
| 她问我的时候别那么快收／她问我话时气泡挂太久了 | `REPLY_LINGER_KNOBS.waiting.question` | 最后一句在问你（以"？"或"吗"结尾）时，余韵 × 这个数 |
| 她说"你呢""跟我说说"的时候，我还没想好怎么回气泡就没了 | `REPLY_LINGER_KNOBS.waiting.handover` | 最后一句把话递给你（"你呢""跟我说说""告诉我""轮到你了"……）时，余韵 × 这个数 |
| 她想我、黏我的时候说完话气泡收得太快了／她兴奋的时候气泡收得太慢了 | `REPLY_LINGER_KNOBS.mood` | 她此刻的心情让余韵 × 多少（没写的心情 = 1）。大于 1 多留一会儿，小于 1 收得早一点 |
| 她正黏着我的时候气泡多留一会儿／她调皮的时候收得利落点 | `REPLY_LINGER_KNOBS.now` | 她这会儿的情绪倾向（心情快照里最强的那一项）让余韵 × 多少 |
| 这个角色很黏人，说完话却收得很干脆，不像她 | `REPLY_LINGER_KNOBS.personality` | 角色卡性格（weights，1 = 一般）的影响有多大：倍数 = 1 + 这个数 × 2 ×（性格值 − 1），夹在 0.75～1.35；负数 = 反过来 |
| 她困的时候说话气泡收得太快／太慢 | `REPLY_LINGER_KNOBS.drowsy` | 她有点困、困了的时候余韵 × 多少 |
| 心情对气泡留多久的影响太大了／看不出心情的影响 | `REPLY_LINGER_KNOBS.lean` | 心情、倾向、性格、困不困乘起来，最多把余韵缩到多少、放大到多少（不含"在等你回话"） |

## 她的作息：关着应用算休息、夜里那一觉更容易睡、睡得更透

旋钮文件：`shared/behaviors/sleep-rhythm/knobs.ts`

| 用户可能怎么说 | 改哪里 | 怎么调 |
|---|---|---|
| 白天她怎么老是困／白天她一点都不困、精神得不像话 | `SLEEP_RHYTHM_KNOBS.wake.dayRate` | 白天（下面"回到白天"到"开始变快"之间）困意涨得是原来 18 小时节奏的几倍；越小白天越精神（0～10，不能是 0） |
| 深夜她还不困／一到半夜她就困得不行 | `SLEEP_RHYTHM_KNOBS.wake.nightRate` | 深夜（"最快"那一段）困意涨得是原来节奏的几倍；越大深夜越快困（0～10，不能是 0） |
| 晚上她太早开始犯困了／晚上她困得太晚了 | `SLEEP_RHYTHM_KNOBS.wake.speedUpFrom` | 几点开始越来越快，单位分钟（1260 = 21:00）；从这里到下面的"最快"均匀加快 |
| 她最困的那段太早／太晚开始 | `SLEEP_RHYTHM_KNOBS.wake.fastFrom` | 几点起最快，单位分钟（0 = 午夜 0 点） |
| 天快亮了她还越来越困／凌晨她太早就不困了 | `SLEEP_RHYTHM_KNOBS.wake.fastUntil` | 最快的那段到几点为止，单位分钟（300 = 凌晨 5 点）；之后均匀变慢 |
| 早上她还在越来越困 | `SLEEP_RHYTHM_KNOBS.wake.slowFrom` | 几点起回到白天的速度，单位分钟（480 = 早上 8 点）。四个时刻要按 回到白天→开始变快→最快→最快结束 绕一圈 |
| 关了一整晚，第二天打开她还是困／夜里才关一会儿她就一点都不困了 | `SLEEP_RHYTHM_KNOBS.offline.nightQuality` | 深夜关着的那段，按"深夜在应用里睡着"消退的快慢 × 这个数；1 = 和真睡着一样，0 = 不算休息（只能在 0～1） |
| 白天关一会儿再打开，她一下子就不困了／白天关了大半天她还是困 | `SLEEP_RHYTHM_KNOBS.offline.dayQuality` | 白天关着的那段，按"白天在应用里睡着"消退的快慢 × 这个数；0.5 = 一半时间在休息（她白天也有自己的事），1 = 整段在睡，0 = 不算（只能在 0～1） |
| 关了好几天再打开，她怎么还是那样／关一整夜怎么没算整夜 | `SLEEP_RHYTHM_KNOBS.offline.longestRestHours` | 关着超过这么多小时，多出来的不再算休息（最多 24）；关一整夜（8～10 小时）在这之内，整夜都算。原来是 2 小时 |
| 她的夜晚整体太早了／太晚了（她几点最困） | `SLEEP_RHYTHM_KNOBS.night.peakMinute` | 她最困的那一刻，单位分钟（180 = 凌晨 3 点）。深夜时段从它推出来（默认约 22:26～07:34），"深夜不打扰""深夜提醒你休息"和这里的深夜一起挪 |
| 深夜她一直在打瞌睡、就是不睡着／她晚上太容易睡着了 | `SLEEP_RHYTHM_KNOBS.night.sleepEnter` | 深夜你一阵子没理她时，困倦到多少她就真的入睡（白天是 0.72，不变）；越小越容易睡，要大于"困"的 0.58、不大于 0.72 |
| 她夜里快睡着了又醒回来，反反复复 | `SLEEP_RHYTHM_KNOBS.night.sleepExit` | 深夜正在入睡时，困倦降到多少就不睡了（白天是 0.60）；要比上面那个小、比 0.48 大，差得越多越不反复 |
| 我才走开一会儿她就睡着了／我都走了好久她还不睡 | `SLEEP_RHYTHM_KNOBS.night.quietMinutes` | 深夜你多久没理她（没摸、没聊、没喂、没叫醒），上面两个深夜的门槛才算数，单位分钟；30 = "深夜提醒你休息一次"认定"你还醒着"的 30 分钟，所以提醒那条照旧，别小于 30 |
| 她早上还是太困／她夜里睡一会儿就完全不困了 | `SLEEP_RHYTHM_KNOBS.night.restSpeed` | 深夜睡着时困意消退比白天快几倍（白天睡 3 小时消掉约 63%）；1.5 = 2 小时消掉约 63%，1 = 和白天一样；关着应用的深夜也按这个算（0.5～3） |
| 她半夜自己醒了／她早上醒得太晚、睡得太多了 | `SLEEP_RHYTHM_KNOBS.night.wakeBelow` | 深夜里困意积累降到多少她会自己醒（白天是 0.18）；0 = 深夜不自己醒，等深夜过去、困意够低了再醒（0～0.18）。你摸她、跟她说话照样会醒 |

## 摸头、捏脸、喂点心让她心情好多少，多快会腻

旋钮文件：`shared/behaviors/touch-feed-effect/knobs.ts`

| 用户可能怎么说 | 改哪里 | 怎么调 |
|---|---|---|
| 她每次被摸头、吃点心的反应都差不多／她忽冷忽热太没准了 | `TOUCH_FEED_EFFECT_KNOBS.recent` | 上一次、上上次用过的那种"受用不受用"，这次分量 × 这几个数；越小越不重复，1 = 不管重复。摸头和点心各记各的 |
| 她被摸头太容易满足了／她想我的时候摸头也没那么受用 | `TOUCH_FEED_EFFECT_KNOBS.touch.landings.full` | 太常 → base 调小或 mood、now 里的倍数调小；满足得太多 → range 两个数一起调小（上限不能超过 1） |
| 摸头的效果平时太弱了／太强了（不是某几次，是一直都这样） | `TOUCH_FEED_EFFECT_KNOBS.touch.landings.usual` | 一直都弱/强 → 先改角色卡的"亲近、舒适"敏感度（要你点确认）；只是"照常受用"这一档 → 改这里的 range |
| 她生气的时候摸头一下就好了，太好哄了／摸头老是没什么效果 | `TOUCH_FEED_EFFECT_KNOBS.touch.landings.light` | 太常 → base 调小或 mood、personality 里的倍数调小；太弱 → range 下限调大 |
| 摸几下她就腻了／怎么摸都不腻，太像机器了 | `TOUCH_FEED_EFFECT_KNOBS.touch.tire` | strength 越大，性格越黏人的腻得越慢、越不黏人的腻得越快（0 = 都和卡上一样）；range 是最慢和最快；minFloor 是腻到底还剩多少 |
| 她吃点心太容易满足了／她开心的时候吃东西也不怎么香 | `TOUCH_FEED_EFFECT_KNOBS.food.landings.full` | 太常 → base 调小或 mood、personality 里的倍数调小；满足得太多 → range 两个数一起调小（上限不能超过 1） |
| 喂点心的效果平时太弱了／太强了（不是某几次，是一直都这样） | `TOUCH_FEED_EFFECT_KNOBS.food.landings.usual` | 一直都弱/强 → 先改角色卡的"期待、舒适"敏感度（要你点确认）；只是"照常好吃"这一档 → 改这里的 range |
| 她老是没胃口／她难过的时候喂点心一下就好了，太好哄了 | `TOUCH_FEED_EFFECT_KNOBS.food.landings.light` | 太常 → base 调小或 mood、moments 里的倍数调小；太弱 → range 下限调大 |
| 连着喂几块她就吃腻了／怎么喂都吃不腻 | `TOUCH_FEED_EFFECT_KNOBS.food.tire` | strength 越大，性格越随和（会享受）的腻得越慢、越不随和的腻得越快（0 = 都和卡上一样）；range 是最慢和最快；minFloor 是腻到底还剩多少 |

## 你在专心做事时，她安静下来做自己的事

旋钮文件：`shared/behaviors/user-activity/knobs.ts`

| 用户可能怎么说 | 改哪里 | 怎么调 |
|---|---|---|
| 我停一小会儿看资料，她就觉得我不忙了／我明明在打字她却当我没在忙 | `USER_ACTIVITY_KNOBS.operatingBelowSec` | 两次操作之间停多少秒以内还算"一直在忙"；越大越不容易跳出"在忙" |
| 我才忙了一会儿她就安静了／我忙了很久她还是老来找我 | `USER_ACTIVITY_KNOBS.riseMinutes` | 连续操作多少分钟专注度涨满；越小她越早安静下来（"在忙"要到 busyAt，默认约 6 分钟） |
| 我歇了好一会儿她还一直很安静／我刚歇一下她就开始闹了 | `USER_ACTIVITY_KNOBS.fallMinutes` | 不操作时专注度多少分钟落完；越大她安静得越久 |
| 我忙完转头找她，她还一副我在忙的样子 | `USER_ACTIVITY_KNOBS.returnFallMinutes` | 你在她的窗口里操作（聊天、点她）时，专注度多少分钟落完 |
| 她多快才发现我在忙 | `USER_ACTIVITY_KNOBS.busyAt` | 专注度到多少算"在忙"（0～1） |
| 她多快才发现我不忙了 | `USER_ACTIVITY_KNOBS.busyLeaveAt` | 专注度掉到多少以下才算不忙（要比 busyAt 小） |
| 电脑睡醒以后她的判断怪怪的 | `USER_ACTIVITY_KNOBS.tickCapSec` | 两次读数隔得再久，最多按这么多秒算（防止一次睡眠把专注度一下算满或算空） |
| 测试"假装我在忙"持续多久 | `USER_ACTIVITY_KNOBS.pretendMinutes` | 只在开发者模式的测试命令里用 |
| 我忙了很久停一下，她有时候也跟着歇一歇／她在我刚停手时就跟着动 | `USER_ACTIVITY_KNOBS.pause` | needsPeak＝专心到什么程度才算"忙了一段"；fromIdleSec～toIdleSec＝停手多少秒算歇一下；endsAfterMinutes＝最多持续多久 |
| 我专心的时候她还是老来找我／我专心的时候她完全不理我了 | `USER_ACTIVITY_KNOBS.quiet` | base＝专注度满了以后，她的无聊涨得只有平时的多少倍（1＝不放慢，越小越安静）；personality＝按角色卡性格加减（黏人加、慢热和随和减）；min、max＝夹在这个范围里（max 小于 1，所以永远是放慢，不会比平时更早开口） |
| 我专心的时候她老换来换去／她发呆发得太短 | `USER_ACTIVITY_KNOBS.herLife` | 你在忙时她每件自己的事比平时久多少（0.8＝久八成；专注度没满时按比例） |

## 屏幕共享开着时她跟着你看视频

旋钮文件：`shared/behaviors/watch-along/knobs.ts`

| 用户可能怎么说 | 改哪里 | 怎么调 |
|---|---|---|
| 我刚打开网页她就以为我在看剧／我看了好一会儿剧她还不知道 | `WATCH_ALONG_KNOBS.browserFrontSeconds` | 浏览器要在前台连续停多少秒，才可能去看一眼小图 |
| 我只是停一下手她就去看我的屏幕／我明明在看剧她迟迟不跟着看 | `WATCH_ALONG_KNOBS.idleSeconds` | 你多少秒没碰键盘鼠标，才算"没在操作"（要比"知道你是不是在忙"的"操作中"那条线小） |
| 看剧时额度花得太快／聊得很多她却还是很少看浏览器 | `WATCH_ALONG_KNOBS.quota` | base＝每小时最少几次；interactionsPerExtra＝过去一小时每多少次聊天或互动多一次；max＝最多几次；windowMinutes＝往回数多久 |
| 她看屏幕的方向不对／她转得太夸张／她看屏幕看得不够明显 | `WATCH_ALONG_KNOBS.gaze` | x、y＝朝屏幕中间看的幅度（窗口在屏幕边上时最大）；down＝窗口正在屏幕中间时也微微往下看的量；eyeHeight＝把她的眼睛算在窗口的哪个高度（0 顶～1 底）；followSeconds＝她拖到别处后视线跟上要多久 |

## 她把聊天记忆整理成笔记，想得起以前的事

旋钮文件：`shared/memory-notes/knobs.ts`

| 用户可能怎么说 | 改哪里 | 怎么调 |
|---|---|---|
| 一打开软件她就在后台调模型，太急了 | `MEMORY_NOTES_KNOBS.pace.startDelaySeconds` | 启动以后至少等多少秒才开始整理笔记 |
| 旧对话的笔记补得太慢了／后台调模型太频繁了 | `MEMORY_NOTES_KNOBS.pace.spacingSeconds` | 两次整理之间至少隔多少秒（40 秒加上一次调用本身，一小时大约 70～80 段） |
| 我刚停下来她就在后台整理，等我真的闲下来再说 | `MEMORY_NOTES_KNOBS.pace.quietSeconds` | 你最后一次和她互动（聊天、摸头、喂食）之后，至少过多少秒才开始整理 |
| 整理笔记一天用的额度太多了 | `MEMORY_NOTES_KNOBS.pace.dailyCalls` | 一天最多整理几段（每段一次 haiku）；到了就等第二天接着补 |
| Claude 出问题的时候她还一直在后台重试 | `MEMORY_NOTES_KNOBS.pace.errorPauseMinutes` | 调用出错（不是写坏了）以后歇多少分钟再试 |
| 就说了一句"晚安"也写一条笔记，没必要 | `MEMORY_NOTES_KNOBS.note.minUserChars` | 一段里你说的话加起来少于这么多字就不写笔记（这样的段还是能按原来的字面规则想起来） |
| 很长的一段聊天，笔记只记住了开头 | `MEMORY_NOTES_KNOBS.note.inputChars` | 交给 haiku 的原文最多多少字；超了就留开头和结尾、省略中间 |
| 我发了一大段，笔记没记到后面的事 | `MEMORY_NOTES_KNOBS.note.messageChars` | 每一句最多交多少字 |
| 有的段一直没笔记 | `MEMORY_NOTES_KNOBS.note.maxAttempts` | haiku 写出来的不合格时最多再试几次（原文变了会重新算） |
| 我提到朋友的名字，她想不起来我们聊过他 | `MEMORY_NOTES_KNOBS.recall.person` | 你这句话里出现了笔记里记的人名，加几分 |
| 我说店名、地名、事情，她想不起来 | `MEMORY_NOTES_KNOBS.recall.longTerm` | 出现了笔记里三个字以上的词（"拉面店""毕业旅行"），加几分 |
| 我随口说个"周末"，她就翻出不相干的旧事 | `MEMORY_NOTES_KNOBS.recall.shortTerm` | 出现了笔记里两个字的词（"周末""学校"），加几分；没有"还记得""那件事"这类话时，光靠它想不起来 |
| 我说"拉面"她想不起"拉面店"那次 | `MEMORY_NOTES_KNOBS.recall.partial` | 只对上了笔记里一个词的头两个字或末两个字，加几分 |
| 我说"那家店""那部电影"，她不知道是哪个 | `MEMORY_NOTES_KNOBS.recall.pointer` | 你说"那家店""那部电影"这种指着以前的东西的话，笔记里有对得上的（"拉面店""电影"），加几分 |
| 我问"去了吗""怎么样了"，她想不起来我们约过什么 | `MEMORY_NOTES_KNOBS.recall.followUp` | 你在问后来怎么样（"去了吗""怎么样了""后来呢"），笔记里正好记了打算，加几分 |
| 我问"那家店去了吗"，她翻出的是别的打算 | `MEMORY_NOTES_KNOBS.recall.planHit` | 在问后来怎么样，而且笔记里的打算就是你说的那件事，再加几分 |
| 我说"还记得……"，她还是说不记得 | `MEMORY_NOTES_KNOBS.recall.withCue` | 你在提以前的事（"还记得""那件事""那家店""去了吗"）时，笔记至少几分才算想起来；调小 = 更容易想起来 |
| 我只是随口一说，她就翻出以前的事 | `MEMORY_NOTES_KNOBS.recall.withoutCue` | 没在提以前的事时，笔记至少几分才翻出来；调大 = 更不容易乱翻 |

## haiku 调度台：你这句话是不是在叫某个模块（现在只登记了猜拳）

旋钮文件：`shared/module-router/knobs.ts`

| 用户可能怎么说 | 改哪里 | 怎么调 |
|---|---|---|
| 我换了个说法叫她玩，她没反应／额度用得太多了 | `MODULE_ROUTER_KNOBS.prefilter` | true = 消息里有某个模块登记的那些字（猜拳：猜拳、石头、剪刀、布、拳、比划、玩一把……）才问 haiku，省额度，但完全不带这些字的说法会漏；false = 每条消息都问（每天多 30～80 次 haiku） |
| 我随口提一句石头，她就开局了／我明明在叫她玩，她没开局 | `MODULE_ROUTER_KNOBS.minConfidence` | haiku 的把握至少多少才算叫到（0～1）；调高更少误开局，调低更少漏 |
| 回复说完好一会儿才开局／haiku 慢了一点就不开局了 | `MODULE_ROUTER_KNOBS.graceAfterReplyMs` | 她的回复说完后，最多再等 haiku 多少毫秒；等不到就当没叫（本机规则照旧） |
| 发消息以后她第一个字好像慢了一点 | `MODULE_ROUTER_KNOBS.startDelayMs` | 你发出消息后，等多少毫秒再起 haiku 的进程。起进程会占住主线程约 20 毫秒（本机实测中位约 21 毫秒，最多约 60 毫秒），晚一点起，Opus 那一轮先写出去，第一个字不受影响；太大则回复说完时 haiku 还没答完 |
| haiku 卡住了，好久都没结论 | `MODULE_ROUTER_KNOBS.timeoutMs` | 从你发出消息算起，haiku 多少毫秒还没答就放弃这一次 |
| 我说了一大段话，中间说要玩猜拳，她没开局 | `MODULE_ROUTER_KNOBS.maxChars` | 消息超过这么多字就不问（长消息几乎不会是在叫她玩） |
| 怕它出错把额度刷光 | `MODULE_ROUTER_KNOBS.callsPerDay` | 一天最多问 haiku 多少次（只在内存里数，重启从 0 数）；只防出错时刷额度，正常用远到不了 |
| 开发者面板里调度台那一行想多看几条 | `MODULE_ROUTER_KNOBS.whyKept` | 开发者面板"调度台"那一行最多留几条消息 |
