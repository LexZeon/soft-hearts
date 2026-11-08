# Bundled model and motion library

soft hearts 预装 Gene：一个 PMX 模型、10 张必要贴图、40 个配套 VMD；另预装 13 个经来源审核和 Gene 适配的精选动作。源码 ZIP 与应用包使用相同的公开目录，首次运行可离线载入；不包含 Uka 或用户私人模型。

## Source and license

- Source: https://github.com/mmdagent-ex/gene
- Revision: `c7eace43dffaccff6ad0597433ef85fa57c91e03`
- License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Original README: https://github.com/mmdagent-ex/gene/blob/c7eace43dffaccff6ad0597433ef85fa57c91e03/README.md

```text
CG-CA Gene (c) 2023 by Nagoya Institute of Technology, Moonshot R&D Goal 1 Avatar Symbiotic Society
```

作者明确规定仓库内文件采用 CC BY 4.0。保留作者署名、来源、许可链接、已有声明并说明修改；代码 MIT 与素材 CC BY 4.0 分开。Gene 的商标及设计权另由作者保留；上游说明列出学术及个人非商业用途，其它商业角色用途需联系作者。预装包保留上游 README、使用指南和上述权利声明，不宣称不受其它权利条件限制。

## English naming and categories

```text
assets/bundled/mmdagent-ex/gene/<revision>/
  model/gene.pmx
  model/tex/*.png
  motions/pose/stand.vmd
  motions/expression/happy.vmd
  motions/reaction/thinking.vmd
  metadata/source.json
  metadata/attribution.txt
  metadata/upstream-readme.md
  metadata/cc-by-4.0.txt
```

外部文件和目录使用英文，动作使用小写 kebab-case。例如上游 `motion/06_embarassedsmile.vmd` 归档为 `motions/expression/embarrassed-smile.vmd`；模型 `Gene.pmx` 归档为 `model/gene.pmx`。PMX、贴图和 VMD 内容不改写，模型内部贴图相对路径、骨骼及表情名称保留原样。

动作分类：`pose` 2 个、`expression` 27 个、`reaction` 11 个。每个动作记录稳定 `id`、英文 `name`、英文 `tags`、原文件名、固定下载地址、SHA-256、大小及真实解析的骨骼/表情帧数和最后帧编号。模型与贴图也保留原名映射、来源和校验值。分类只是描述性元数据，不自动开启心情、随机待机或行为系统；未来用户自定义 tags 应另存，通过稳定 ID 关联，避免修改可重新生成的来源记录。

`shared/bundled-assets.json` 定义模型、必要贴图和默认动作；`shared/motion-catalog.json` 按来源列出 53 个动作。`metadata/source.json` 保留完整资源来源和修改说明。源码使用普通 Git 文件，指定公开 PMX/VMD 有受限的忽略规则例外；用户模型等文件的全局排除继续生效。

## Additional CC BY 4.0 motions

| Source | Bundled subset | Attribution and conversion |
| --- | --- | --- |
| [100STYLE](https://www.ianxmason.com/100style/) | Neutral、Arms Folded、Arms Behind Back、Proud、Depressed，5 个 idle | Ian Mason、Sebastian Starke、Taku Komura；按作者 Frame_Cuts 裁去 T-pose，BVH→Gene VMD |
| [MPI EMBM](https://figshare.com/articles/dataset/MPI_EMBM_Database_Mocap_Files/1220428) | Neutral、Joy、Pride、Sadness、Anger，5 段 conversation gesture | Ekaterina Volkova (2014)，DOI 10.6084/m9.figshare.1220428.v1；截取上半身，保持 Gene 站姿下肢 |
| [GENEA 2022 submissions](https://zenodo.org/records/6977157) | FSB 的 2 段 speaking gesture | Yoon et al. (2022)，完整作者表在包署名中；排除非商业组 FNA、UNA |
| [fnoji Split Dance](https://www.nicovideo.jp/watch/sm46039479) | 1 个完整短舞 | fnoji (えふのじ)；作者原页声明 CC BY 4.0，VMD 原字节保留 |

目录为 `assets/bundled/<source>/<pack-id>/<content-revision>/`，内含 `motions/{idle,gesture,dance}/` 及 `metadata/`。内容修订号由实际来源哈希、转换器和参数计算，不冒充上游 Git 提交。每包保留 CC BY 4.0 全文、署名、来源、原文件名/原哈希、输出哈希及转换说明。BVH 转换求解源/目标骨段和实际 Gene 层级，转为 30 FPS、固定根位移、混合循环接缝并重算脚 IK；没有合成脸部表情或手指细节。

原始完整资料仅在忽略的 `.local/motion-sources/<source>/` 归档，不进入源码 ZIP 或安装包。MPI 官方 ZIP 的大小和 MD5 与发布元数据一致，但上游文件缺少中央目录并在第 288 个 BVH 内截断；只恢复并校验 287 个完整文件，不能声称取得其宣传的全部 1440 多个。GENEA 通过官方 ZIP 字节范围只读取合格分组，FNA、UNA 不落盘。叉子摇作者分发帖所在 X 账号目前被冻结，未取得原文件，不列为已预装。

这些动作均由用户手动选择启用；来源中的情绪名只是 tags。短舞不包含音乐、预览视频、舞台或预览模型，也不把动作许可延伸到这些作品。

## Runtime behavior

没有已保存设置的新配置自动选择 Gene 和 Stand。已有设置，包括明确清空的模型或动作，不会被启动逻辑覆盖。在「模型与动作」中点击「使用预装 Gene」恢复预装模型和默认动作，其它连接、人设与权限设置保持原样。预装动作可离线按名称或 tag 搜索和切换；不会复制到下载缓存，也不在资源损坏时静默联网。

动作库上方提供类型筛选（姿势、表情、反应、待机、手势、短舞）及带数量的 tag 选择。多个 tag 采用精确 AND 匹配；英文名称/关键词可拆词搜索，分类也支持中文。已选 tag 可点击移除，动作下方的 tag 也可直接点击筛选；「清除筛选」恢复全部动作。

选择动作后点击「预览动作」，在控制窗口使用当前模型临时试播；预览不会保存动作设置、改变桌宠、加载额外模型或联网。「停止预览」恢复当前已保存的动作；同一动作可重新预览。更换选择、筛选、切换离开本页、隐藏控制窗口或更换模型/已启用动作会结束预览，晚到的资源不会重新开始播放。预览期间调整镜头可正常保存镜头，同时保持动作仍为临时状态。「启用动作」是独立的保存操作，结束临时预览后同步桌宠。

主进程 `previewMotion` 只接受审核清单的包/动作 ID，验证所选 VMD 和所属包授权文件后返回窄资源引用；不会写设置或广播动作，也不占用安装任务。桌宠窗口无权申请该预览引用。控制窗口的 `MotionPreviewSession` 只给自己的舞台叠加临时动作；不会将临时值写进正常设置。无模型时先选择自己的 MMD 或使用预装 Gene。

「应用到」选择身体姿态、手势或面部表情；每层独立启用、清除、预览。选择一个 pose 可以保留另一套表情，手势只覆盖它包含的上身骨骼属性，根、腰与腿仍由身体层控制。面部层取 morph 以及常见眼、口、颌等面骨，不使用身体轨道。未修改层继续自己的播放进度；每层遵循原片段时长循环，不强制互相同步。旧配置继续播放完整 VMD，首次显式分层保留原片段的面部来源。各模型命名差异仍会影响匹配，未知骨骼保守留给身体层。

首次启动与切换检查受信任目录范围和文件哈希，模型注册只授权 `model/` 及贴图，动作注册只授权选中动作目录。源码运行和打包后的 asar 使用相同的 `assets/bundled/` 相对布局。构建与打包前校验全部清单文件和来源记录，并拒绝未知附加文件。附加包仅支持本地预装启用，不会把上游 BVH 地址当作可运行 VMD 下载。

## Maintenance and validation

```powershell
pnpm assets:prepare
pnpm assets:verify
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:bundled
```

`assets:prepare` 为维护者从固定官方版本准备资源，可复用已验证缓存；普通用户下载源码 ZIP 后无需执行它。普通构建与运行不下载任何模型或动作。资源更新需重新审查许可、原名映射、校验值与实际贴图引用；不要扩大全局资产忽略例外。

附加动作的维护者流程为：审核并归档原始文件，运行 `node scripts/prepare-additional-motions.mjs`，再验证、构建并运行 `node scripts/additional-motions-smoke.mjs`。准备脚本只读取已审核的本地输入，不联网。单文件转换示例为 `node scripts/retarget-gene-motions.mjs --input source.bvh --output gene.vmd --upper-body-only`。内容变化会产生新修订目录；旧草稿应移到本地档案，避免混入发布资源。`motions:sync` 更新 Gene 时保留已审核的附加包。

`node scripts/motion-preview-smoke.mjs` 使用隔离配置验证筛选、预览、停止恢复、启用才保存、镜头保存与权限边界。支持 `MMD_TEST_APP_DIR` / `MMD_TEST_EXE`，仅输出忽略的舞台截图与报告，不调用聊天、媒体或屏幕捕获。异步 IPC 等待使用显式轮询；纯控制器测试另覆盖加载迟到、停止、更换模型和销毁。

分层验证运行 `node scripts/motion-layers-smoke.mjs`，覆盖独立启用/切换/清除、表情临时预览、保存竞态与重启恢复。系统声音律动另用 `node scripts/system-audio-smoke.mjs`：隔离配置播放短暂的合成测试声音，检查真实 Windows loopback、兼容视频轨立即停止及关闭资源；不保存原始音频或桌面画面。音乐的频段与鼓点强弱仅用于本机有界身体叠加，不修改 VMD、不识别曲名、不发送给聊天。

`smoke:bundled` 使用隔离配置，检查首次默认 Gene、全部 40 个动作离线启用、署名、tag 搜索、重启保留、切回预装模型和重置。可通过 `MMD_TEST_MODEL` 只读测试已有用户模型的选择保留；`MMD_TEST_EXE` 可验证打包应用，标准 `--user-data-dir` 参数确保配置隔离。报告与应用舞台截图只保留在忽略的 `.local/bundled-assets-smoke/`，不调用聊天、屏幕捕获或摄像头。

`normal.vmd` 的上游显示模型名字段在 Shift-JIS 双字节中截断。舞台只在解析内存副本中处理孤立尾字节，原文件字节、哈希和动作帧不变。成功载入不代表对其它 PMX/PMD 完整重定向：专有表情和辅助骨骼可能不匹配。

所有 VMD（预装、预览及用户本地动作）解析后统一忽略整条零位移/单位旋转的静止骨轨，以及整条零权重的表情轨。动态轨道、静态非默认初始姿势及非零表情保留；不会把有意义的非大字形姿势删掉。原始资源和来源哈希不改写，清理仅作用于播放内存数据；保留原骨骼/表情时间轴长度，空轨动作也使用安全的非零循环时长。本规则不裁剪动作时间段，不删除动作中途停顿，也不根据当前模型缺骨情况移除动态轨。
