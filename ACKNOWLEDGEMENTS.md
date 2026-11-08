# 鸣谢与参考边界

本项目从空仓库独立实现，面向 MMD 桌宠。以下项目帮助确定了桌面陪伴、模型接入与用户控制的需求；它们没有为本项目背书。

| 参考项目 | 本次参考内容 | 原项目许可 |
| --- | --- | --- |
| [Project AIRI / moeru-ai/airi](https://github.com/moeru-ai/airi) | 虚拟伙伴、多后端、桌面体验，以及[发行说明](https://github.com/moeru-ai/airi/releases)中的角色卡管理与模型关联概念 | [MIT](https://github.com/moeru-ai/airi/blob/main/LICENSE)，Copyright 2024-PRESENT Neko Ayaka |
| [AIRI Character Forge / LexZeon/airi-phoenix-local](https://github.com/LexZeon/airi-phoenix-local) | README 中关于本地服务、相机构图、权限关闭及验证边界的经验 | [MIT（限定范围）](https://github.com/LexZeon/airi-phoenix-local/blob/main/LICENSE)；角色 IP、官方媒体、派生同人素材另有边界 |
| [rtmlib / Tau-J/rtmlib](https://github.com/Tau-J/rtmlib)（commit `03a1693`） | 本地姿态感知（I-001）的 RTMDet / RTMPose 前后处理逻辑：只读了源码，在 `electron/pose/pipeline.ts` 里用 TypeScript 重写，没有复制或分发它的代码 | [Apache-2.0](https://github.com/Tau-J/rtmlib/blob/main/LICENSE) |

用户最初提到的 [FDEAABH6/AIRI](https://github.com/FDEAABH6/AIRI) 保留为溯源入口。截至 2026-10-25，GitHub 接口返回的仓库大小为 0，README 与 LICENSE 请求均为 404，未能确认其代码或许可证。它不作为本项目的代码依赖。

本次仅阅读上述仓库的介绍、许可与发行说明，没有移植其源代码、界面、角色、人设、模型、动作或贴图。角色卡使用本项目独立的数据与界面实现，JSON 基础字段参考公开的 [Character Card V2 规范](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)，不宣称完整兼容 AIRI ZIP 或 Tavern V2 编辑器。本项目实际使用的开源依赖另列于 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。以后若引入外部实现，应在同一次变更中记录来源、修改范围及相应许可通知。

感谢 Three.js、Electron、OpenAI Codex 及构建工具的维护者。用户提供的 MMD 模型仅在本地测试，模型、贴图、角色权利不属于本项目 MIT 许可证的授权范围。
