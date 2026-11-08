# 她的动作（Codex 为 soft hearts next 做的原创 VMD）

- 制作：Codex（soft hearts next 的研究助手），任务 T-211 第 1–7 批，2026-11-04；指一指和鼓掌换成第 9 批的修订版，2026-11-05；只有脸部形态的鼓腮、撅嘴、眨一只眼、吐舌头（第 6、7 批）2026-11-05 随 T-215 收进来。
- 不是第三方下载：关键帧由程序在随包 Gene 的 Stand 第 0 帧上原创求解，再用 T-211/batch-001/generate-vmd.mjs
  （SHA-256 65eba3af31920c65394425bcbd2e1699ea354cae39c12bd4d2e20cba5138ee84，Node 24：`node generate-vmd.mjs <关键帧.json> <输出.vmd>`）写成 VMD。
  生成脚本和每个动作的关键帧 JSON 在沟通桥 研究成果/Codex/T-211/batch-00N/，这里不复制。
- 字节未改：这里的 23 个 VMD 与 Codex 交来的 SHA256SUMS 一致；逐个哈希见 source.json 和 shared/motion-catalog.json。
- 授权：随本仓库（MIT）。
- 第 9 批修订（2026-11-05，报告 研究成果/Codex/T-211/batch-009/report.md，候选清单 SHA-256 295409d0…2455）：
  - 指一指（point）：换成 batch-009/candidate/point.vmd（SHA-256 120729f3…4751，仍 109 帧）。原版在半身镜头里手伸出画面；
    修订版弯肘向下、手腕收到右太阳穴附近，指向同一个合成方向，保持段右手和袖口没有顶点出框。
  - 鼓掌（clap）：换成 batch-009/candidate/clap.vmd（SHA-256 852bbcfd…f576，96 → 163 帧，5.43 秒）。原版拍手部分窄、短，看起来像合十；
    修订版张得更开（掌心距离摆幅约为原来的 2.86 倍），拍三下。
  - 哈欠捂嘴（cover-yawn）没换：第 9 批的两个候选都还露嘴（第二个主要靠袖口挡），Codex 建议不替换。
  - 旧版字节在 git 历史里（上一版内容目录 44a58f87ff848cec93b2a3f82b67b89d58a3c520），新旧对照见 source.json 的 revisions。
- 没收进来的：指尖比心（finger-heart），Codex 自己判为失败（拇指和食指仍像捏在一起）。
- 只有脸部形态的四个（2026-11-05，T-215）：鼓腮 cheek-puff（batch-006/cheek-puff.vmd，SHA-256 f88f34af…0c5a）、撅嘴 pout（batch-006/pout.vmd，9d4bf077…4450）、
  眨一只眼 wink（batch-006/wink-positive-x.vmd，39c5e055…a7d0；模型 +X 侧的眼，画面右边那只）、吐舌头 tongue-out（batch-007/tongue-out.vmd，30f463f4…2342）。
  由 T-211/batch-006/generate-morph-vmd.mjs（SHA-256 18c47291…5924）从关键帧 JSON 写成，只有形态轨、没有骨骼轨，形态名是 Gene 自己的。
  它们和口型、眨眼、笑眼共用顶点，“她的动作”经舞台的"短暂独占"（src/stage/face-exclusive.ts）播放：整组冲突形态一次写完，说话和眨眼来了平滑交还。
  上一版内容目录 701ddf4318eea6d6bc6e8082395470338024db56（19 个动作，字节都没变，只是搬过来）。
- 只在 Gene 上核过；别的模型走现有的重定向和适配检查，缺部位的模型跳过这个动作。
