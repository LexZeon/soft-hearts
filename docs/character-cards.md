# 角色卡

在「连接与声音」中管理角色卡。每张卡保存名称、简介、性格、情境、开场白、对话示例和补充系统指令。新建或复制后可先保存，点击「保存并启用」开始使用；选择已有卡片会直接启用。切换或修改当前角色的人设会结束旧聊天、清除两窗口的文字上下文，并显示开场白。

源码已增加随卡保存的数值心情模板，包括五通道基线、恢复和敏感度，B/M、反应倾向、表现强度和自动脸红。以下说明对应该实现；真实 Electron 验收和日常构建部署结果以实施记录为准，不表示仍在运行的旧版本已经更新。生成、保存和启用的区别见[角色卡和数值怎么写](character-card-guide.md)。

现有 `persona` 会迁入默认角色，不丢弃原文字。角色卡保存在应用用户数据目录的 `characters.json`；不写进项目或源码 ZIP。最多 64 张，组合人设上限 12000 字，导入 JSON 最大 1 MB。重置应用连接与窗口设置会保留角色卡。

卡片可关联当前通过原生选择器载入的 MMD。关联只保存在本机；预装 Gene 使用稳定标识，不依赖便携应用的临时解压路径。启用绑定卡时应用其模型，模型已移动则提示并保留当前模型。镜头、声音、连接、共享开关与 agent 权限继续独立管理；卡片不能授权工具或改动密钥。

## 导入和导出

本项目使用独立 JSON 格式；也可从 Tavern V1/V2 JSON 导入基础文字字段 `name`、`description`、`personality`、`scenario`、`first_mes`、`mes_example` 和 `system_prompt`。新导入卡生成独立编号，先保存而不自动启用。原文件不会被改写。

当前导出使用 `format: "soft-hearts-character-card"`、外层 `version: 2`；`card` 包含原有七个文字字段和 `mood: { version: 1, parameters: ... }`。`parameters` 是完整有效的心情参数对象，时间单位为毫秒。外层卡片 v2 与内层心情模板 v1 是不同版本号，不能互换。完整可导入文件见[原创角色示例](mood/character-card-example.json)，字段、单位和技术范围见[角色卡和数值怎么写](character-card-guide.md)。

旧 soft hearts v1 仍可导入，只允许原文字字段；Tavern 仅映射基础文字，非空 `extensions` 和未知字段会拒绝，不执行世界书、插件或完整 Tavern 语义。没有模板的旧卡继承 Gene 默认；升级已有卡时，若旧心情存档中已经为该角色调过参数，会优先迁移这份配置，再补新脸红默认，不重置实时状态。PNG 内嵌卡、AIRI ZIP 仍未实现。

导出只带人设和参数模板；不带模型、贴图、本机绑定路径、当前通道值、B/M、互动时间、聊天、连接或密钥。导入中的路径、提供商、执行权限和运行数据字段会被拒绝。用户提供的文字按纯文字显示，不执行 HTML。内部 `characters.json` 的存储版本仍为 1，不是便携导入文件，不能拿整个内部存档当 v2 角色卡分享。

## 编辑、保存与读回

在角色卡的「心情数值模板」中，五通道控件可编辑静息基线、事件敏感度和恢复半衰期；控件的半衰期单位为分钟，完整 JSON 仍为毫秒。自动脸红可单独关闭或设强度为 0，尺寸与强度独立调整。当前默认走程序化双颊红晕，模型原生 morph 是适配备选，二者不同时叠加；没有原生脸红 morph 不代表不能使用程序化红晕。实际效果仍取决于头部定位、当前事件与手选动作，模型定位校准另归本机适配数据，不随卡分享。

「完整心情模板 JSON」编辑的是整个 `mood` 对象，即 `{ "version": 1, "parameters": ... }`，不填整张角色卡或裸 `parameters`。「恢复 Gene 模板」只改未保存的编辑内容，保存后才应用；保存到当前卡不清空其已有数值和记忆。复制创建新卡实例，仅复制模板，不复制原角色的私人经历。导出始终使用上次保存版本，未保存编辑不在文件内。

| 入口 | 对应界面元素 |
| --- | --- |
| 角色选择、新建、复制、导入/导出 | `#character-select`、`#character-new`、`#character-duplicate`、`#character-import`、`#character-export` |
| 完整数值模板 | `#character-mood-template`；五通道为 `#character-mood-baseline-D`、`#character-mood-sensitivity-D`、`#character-mood-half-life-D` 等，末尾按 D/O/E/N/C 替换 |
| 自动脸红、独立大小及恢复模板 | `#character-blush-enabled`、`#character-blush-intensity`、`#character-blush-size`、`#character-mood-gene` |
| 保存、保存并启用 | `#character-save`、`#character-save-activate` |

已启用卡的开发者面板也可调整参数；「应用参数」会同时保存当前角色卡模板与主进程有效参数。角色卡编辑器的恢复按钮只是待保存编辑，开发者面板的「恢复 Gene 参数」则直接保存到当前卡，均保留实时状态与记忆。读回以 `getCharacterCards()` 中当前卡的 `mood.parameters` 和 `getMood().parameters` 为准；接口只提供这项应用能力，不赋予文件或 agent 权限。实际按键与读回仍需相应构建的原生验收。

下面保留兼容的旧 v1 文字卡示例；生成新数值卡请使用上方完整 v2 示例文件：

```json
{
  "format": "soft-hearts-character-card",
  "version": 1,
  "card": {
    "name": "林间",
    "description": "喜欢观察日常小事的桌面伙伴。",
    "personality": "说话自然简短，先倾听，再提出具体建议。",
    "scenario": "陪用户处理今天的安排。",
    "greeting": "今天想从哪件小事开始？",
    "examples": "用户：有点累。\n林间：先休息一下吧，等你想说时我在。",
    "systemPrompt": "用中文交谈，尊重用户明确表达的边界。"
  }
}
```

功能概念参考 [AIRI 的公开发行说明](https://github.com/moeru-ai/airi/releases)；基础文字字段映射参考 [Character Card V2 规范](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)。实现独立完成，参考边界见根目录鸣谢。
