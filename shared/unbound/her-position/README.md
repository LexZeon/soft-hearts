# 她知道自己站在哪、自己决定走去哪（I-193 → I-211 → I-212）

记录：I-193、I-211 / I-212。

全屏 Unbound 里：每轮聊天多一句"你现在离用户约 4 米，站在屏幕偏右（横向约 80% 处）；用户看到的你：全身，脚边是任务栏。"（只是说明，不叫她做什么）；她在回复里写 `⟦go-left⟧` 这类词，身体就用走路的步态走过去（不瞬移）；写隐藏记号 `⟪keep-place⟫` / `⟪clear-place⟫` 设或清你给她定的出场位置。

I-193 带数（2026-11-24，记录）：那句后面再说她占屏幕多大、这块屏幕和她身高的远近对照（几米时你看到她哪一截，能站的最近和最远）、上一轮的走位走没走；她可以写 `⟦go 30% 1.2m⟧`（横向百分比、离你的米数，可只写一个），主机按同一把尺换算、夹在最远和"只有脸"之间走过去；"走近"到了默认位置那么近以后再说就再近一步，到"只有脸"停。

**位置用屏幕上的样子说**（I-212）：`LifeSpot` = `{ across, size }`，横向占屏幕宽度，`size` 是她整个人的高度占可用高度（去掉任务栏）的比例。换成米只在 `shared/unbound/screen-terms` 一处（这里一个米数也不算）。纯规则：不碰 Electron、Three.js、时钟和 DOM（调用的人给位置和随机数）。

## 文件

| 文件 | 做什么 |
|---|---|
| `knobs.ts` | 旋钮：左中右的分界、边缘多近、远近的大小门槛、每个词的范围、走近走远一次变大变小多少倍、走一小步最大到多大、到鼠标旁边站多远、走完停多久、鼠标位置多久内算知道、画面里露出多少算膝盖以上/半身/胸口以上/只有脸 |
| `words.ts` | `herPosition`（样子 → 左中右、远近、边缘、脚在不在地面线上；体验记录用这些封闭词）、`herPositionLine`（每轮那句：离你几米、你看到她什么样、横向百分比、你的默认位置、靠边、任务栏；英文聊天用英文） |
| `seen.ts` | `herSeen`（按真的取景算画面里露出她的哪一截：全身 / 膝盖以上 / 半身 / 胸口以上 / 只有脸 / 脸贴得很近，头顶出没出画） |
| `marks.ts` | 两个隐藏记号 `keep-place`、`clear-place`（`placeMarkOf` 从回复的 ⟪…⟫ 里读第一个；`placeMarkWordsLine` 她词表里那一句，只说是什么、不说什么时候用）；算不算数在 `electron/unbound/place-marks.ts` |
| `ask.ts` | 8 个"去哪"的词（`GO_WORDS`：7 个老词加 `go`，和 `shared/behaviors/speech-beats/interface.ts` 的 `SPEECH_BEAT_GO_WORDS` 是同一份，测试守着相等）；`go` 的目标 `GoTarget`（她写的百分比和米数，原样）；页面问主机的问题 `GoBeatAsk`（数只在 `go` 上收，至少一个）和答案 `go`/`stay` |
| `go.ts` | `goSpot`（词 → 一个走得到的样子：在词的范围里随机、带一点心情、不是原地、不穿"必须让开的窗口"、走近一小步不过全身放得下的大小；`go` 的目标夹在最远和 `nearestLimit`（只有脸）之间；"走近"到了默认位置后一步一步再近到 `nearestLimit`；也给走的快慢（米/秒，脚要对上地）和走完停多久） |
| `first.ts` | `firstWaistUpSize`（2026-11-25：没默认位置也没上次位置的第一次出场，按这块屏幕和她自己的身高算"半身（腰以上）"那一档的大小；旋钮 `firstBandPosition`；取代 I-212 的"半屏高、全身"；见 记录） |
| `near.ts` | `comeNearSize`（"走近"第一次走到哪：默认位置的大小，没设就按她身高算的上半身入镜；旋钮 `comeNearToPlace` 默认开；之后再近一步见 `go.ts`） |
| `reach.ts` | `nearestWalkSize`（她自己能走到的最近：还是"只有脸"、不穿过屏幕）、`farthestWalkSize`（"走远"的最远）、`nearTable`（这块屏幕、她这个身高的远近对照，按真的取景、米数用 `toldDistanceM`） |
| `screen-facts.ts` | 每轮那句后面的几段：`screenFactsLine`（占屏幕多大、远近对照）、`goOutcomeLine`（上一轮的走位走没走、原因）；只说明，守门和那句一样（没有指令词、没有"走/去/移"） |
| `outcome.ts` | `GoOutcomes`（从写体验记录的同一处收下每个走位词的结果，下一轮说一次；20 分钟内有效，最多 3 条） |
| `journal.ts` | 体验记录的两种行：每个走位词一行（`go-beat`：走了/没走、封闭原因、米数；`go` 带数时多 `target`）、她每走完一次一行（`place-moved`） |
| `gates.ts` | `goBlock`（不在屏幕上/睡着/被拉/在玩/开着框打字/贴近的时刻在演，通话不算）、`interruptsGoWalk`（走到一半什么收回她：拉、玩、点） |
| `keep.ts` | `chosenSpotUntil`/`chosenSpotOpen`（I-205b：她自己选的地方 30 分钟内，程序自己的"换个地方站"不把她挪走；旋钮 `chosenSpotMinutes`；你拉她结束，睡意重往角落照旧） |
| `index.ts` | 公开页 |

## 谁在用

- 主机：`shared/unbound/life/host.ts` 的 `LifeHost.goAsk`（页面的问题；发"换个地方站"的走路计划，不写心情）、`LifeHost.here()`、`LifeHost.takeGoOutcomes()`（上一轮的走位结果，说一次）；`electron/unbound/her-place.ts`（`HerPlace`：样子 ↔ 米、走近走到哪、最近、`go` 的目标、每轮那句的事实和远近对照；`lifeLink()` 交给 LifeHost）；`electron/unbound/host.ts` 的 `peekReport` 先问它。
- 页面：`src/unbound/speech-beat-player.ts`（遇到词只问主机；`go` 带着数问，没有可用的数不问）、`src/unbound/go-cursor.ts`（鼠标横向位置，只用在 `go-cursor` 这一次问话上）。
- 提示：`electron/brain/speech-beats/turn.ts`（全屏才把这些词写进提示句）、`electron/wiring/unbound-wiring.ts` 的 `unboundNoticedLine`（每轮那句和两个记号是什么）、`unboundPlaceMarks`（聊天一轮读她的记号）。

## 没做

- "到你正在用的窗口旁边"：程序没有读你窗口的读数，加这个是新的感知，要用户同意；`goSpot` 已留了 `covers`（不盖住必须让开的窗口）的口子。
- I-211 第 2 步（她说"走近到胸口以上"这类画面档）：等第 1 步试过再定。
- 通话里的记号：通话那条路没接（每轮那句也不在通话里）。

## 守着的（变异 `scripts/dev/mutations/unbound.json`、`brain.json` 的 `I193-*`、`I211-*`、`I212-*`）

每轮那句只是说明（不变指令）、带数的走位记号从不漏进气泡和朗读（`brain.json` 的 `I193-numbered-go-*`）、米数只在 screen-terms 换算、"走近"够近了再近一步、没走的不说成走了、数只在 go 上、超出范围停在边上（`I193-*`，2026-11-24）、告诉她的米数按屏幕的公式不按世界里的米数、去哪是走过去不是瞬移、五个门各自、不盖让开的窗口、走近不过全身放得下、说话时不收回走路、拉/玩/点会收回、小窗不多说词、页面只问不演、鼠标位置不猜；站哪的决定只在 screen-terms 换算；第一次出场跟着屏幕大小；旧位置文件换算一次；记号只认回应你的那条回复、只在全屏里。
