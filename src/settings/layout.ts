import { uiText, uiHtml, uiMarkup, uiTemplate } from '../foundation/ui-language';
import { icon } from "../foundation/icons";
import { renderControlNavigation } from "./ControlNavigation";
import "../senses/CameraSharingPanel"; // I-036: registers the English copy of the camera rows below (same words as the companion's panel)
import "./control-navigation.css";
import "../stage/pet-recovery.css";
import "../stage/immersive-notice.css";
import "../safety/assistant.css"; // I-071 v2 Claude 助手 (here, so the panel module stays importable in tests)
import "../safety/agent-channel.css";
import "./part-health.css"; // overhaul step 7: one part is off (the banner: src/safety/PartHealthNotice.ts)
import "../memory/journal.css";
import "../brain/chat-setting-card.css";
import "../initiative/take-me-there.css";
import "../initiative/her-folder.css";
import "../safety/test-command-notes.css";
import "../brain/chat-availability.css";

function button(id: string, label: string, glyph: string, cls = ""): string {
  return `<button id="${id}" class="${cls}" type="button">${icon(glyph)}<span>${uiText(label)}</span></button>`;
}
function toggle(id: string, title: string, description: string): string {
  return `<label class="toggle-row"><span><strong>${uiText(title)}</strong><small>${uiText(description)}</small></span><input id="${id}" type="checkbox" role="switch" /></label>`;
}
function number(
  id: string,
  label: string,
  min: number,
  max: number,
  step: number,
): string {
  return `<label class="number-field"><span>${label}</span><input id="${id}" type="number" min="${min}" max="${max}" step="${step}" /></label>`;
}
function range(
  id: string,
  label: string,
  min: number,
  max: number,
  step: number,
): string {
  return `<label class="range-field"><span>${label}<output id="${id}-value"></output></span><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" /></label>`;
}

export function renderControls(app: HTMLElement): void {
  app.innerHTML = uiHtml`
  <aside class="sidebar">
    <div class="brand"><div class="brand-mark">${icon("spark")}</div><div><span class="brand-name">soft hearts</span><small>3D DESKTOP COMPANION</small></div></div>
    <div class="sidebar-label">你的桌面伙伴</div>
    ${renderControlNavigation()}
    <div class="sidebar-bottom"><div class="local-badge"><span class="dot"></span>本地桌面应用</div><small>为长久的陪伴，留一点空间。</small><span class="version"><b>v0.2.0</b></span></div>
  </aside>
  <div class="shell">
    <header class="topbar pet-recovery-topbar"><div><span class="eyebrow">YOUR LITTLE CORNER</span><h1 id="page-title">陪伴对话</h1></div><div class="top-status pet-recovery-status"><button id="show-pet" class="pet-recovery-button" type="button" title="显示桌宠，保留位置和镜头">${icon("eye")}<span>显示桌宠</span></button><button id="recover-pet" class="primary pet-recovery-button" type="button" title="居中显示，恢复默认大小与镜头；保留模型和连接">${icon("refresh")}<span>一键恢复桌宠</span></button><button id="user-profile-toggle" type="button" aria-controls="user-profile-panel" aria-expanded="false">用户画像</button><button id="notice-details" class="notice-details-button" type="button" hidden>查看问题详情</button><span id="privacy-indicator" class="privacy-pill">${icon("shield")} 输入与共享已关闭</span><span id="provider-badge" class="connection-pill">未连接</span></div></header>
    <section id="chat-availability" class="chat-availability" aria-label="需要处理" hidden></section>
    <section id="part-health" class="chat-availability" aria-label="有一部分暂时关了" hidden></section>
    <main class="workspace">
      <section class="preview-card" aria-label="模型预览">
        <div class="preview-heading"><div><span class="dot"></span>实时预览</div><span id="fps-label">60 FPS</span></div>
        <div id="stage" class="stage"></div>
        <div id="preview-camera-help" class="preview-camera-help hidden">按住左键原地转向 · 按住右键平移<br />WASD 前后左右 · Space 上升 · Z 下降<br /><small>Shift ¼ 微调 · Tab 重新取景 · Esc 完成调整</small></div>
        <div id="preview-empty" class="preview-empty"><div class="empty-orbit">${icon("box")}</div><h2>让你的伙伴住进来</h2><p>载入自己的模型（MMD 或 VRM）<br />从一个熟悉的身影开始。</p>${button("empty-import", uiText("选择模型（MMD 或 VRM）"), "plus", "primary")}</div>
        <div class="preview-bottom"><div><strong id="model-name">尚未载入模型</strong><span id="stage-status">PMX / PMD / VRM · 本地读取</span></div><div class="view-actions">${button("surprise-preview", uiText("惊喜试作"), "spark")}${button("shy-preview", uiText("害羞试作"), "spark")}${button("surprise-stop", uiText("停止试作"), "stop")}${button("frame-portrait", uiText("半身"), "eye")}${button("frame-full", uiText("全身"), "box")}</div></div>
        <div class="preview-footnotes"><div id="surprise-preview-status" class="preview-footnote" role="status">预览表情与头身（害羞含垂眼、低头、红晕和抿嘴笑），手暂未加入；不保存动作。</div>
        <div id="preview-camera-hint" class="preview-footnote">点击「调整模式」控制镜头 · 构图同步至桌宠</div></div>
      </section>
      <section class="content-card">
        <div id="tab-memory" class="tab-panel scroll-panel"><div id="memory-panel"></div><div class="settings-section" id="her-folder"></div><div class="settings-section" id="moving-memory" hidden></div><div class="settings-section" id="our-things"></div><div class="settings-section" id="people-things"></div></div>
        <div id="tab-chat" class="tab-panel active chat-panel">
          <div class="panel-heading"><div><h2>聊一会儿</h2><p>今天，有什么想和我分享的？</p></div>${button("new-chat", uiText("新对话"), "plus", "subtle")}</div>
          <div id="messages" class="messages" aria-live="polite"><div class="welcome"><div class="welcome-mark">${icon("spark")}</div><h3>我在这里。</h3><p>先在「连接与声音」选择聊天模型，<br />然后开始你们的第一段对话。</p><div class="suggestions"><button data-prompt="你好，介绍一下你自己吧。">打个招呼</button><button data-prompt="今天想做点什么，陪我一起规划一下吧。">一起规划今天</button></div><p class="welcome-note">她的话由角色卡和 AI 模型一起生成，代表的是这个角色，不代表模型提供方（Anthropic）或开发者的立场。</p></div></div>
          <div class="composer-wrap"><div id="attachments" class="attachments"></div><form id="chat-form"><textarea id="chat-input" rows="3" placeholder="和桌面伙伴说点什么…" aria-label="聊天消息"></textarea><div id="voice-action-slot" class="voice-action-slot"></div><div class="composer-tools"><div>${button("attach-screen", "屏幕快照", "screen", "tool")}${button("attach-camera", "拍一张给她看", "camera", "tool")}</div><button id="send-chat" type="submit" class="send-button" aria-label="发送消息">${icon("send")}</button>${button("stop-chat", "停止", "stop", "danger hidden")}</div></form><div class="composer-note"><span id="chat-state">Enter 发送 · Shift + Enter 换行</span><span>仅发送你选中的快照</span></div></div>
        </div>
        <div id="tab-characters" class="tab-panel scroll-panel">
          <div class="panel-heading"><div><h2>陪着你的她们</h2><p>点「换成她」，桌面上的她就换了：模型、人设和记忆一起换。</p></div></div>
          <div id="character-page"></div>
          <div id="character-cards"></div>
          <div class="settings-section" id="reaction-dispositions"></div>
        </div>
    <div id="tab-appearance" class="tab-panel scroll-panel">
          <div class="panel-heading"><div><h2>属于你的样子</h2><p>模型、动作与镜头，独立调整。</p></div></div>
          <div class="settings-section"><h3>模型与动作</h3><div class="asset-row" id="appearance-model"><div><strong>模型（MMD / VRM）</strong><small id="model-path">选择 .pmx、.pmd 或 .vrm；MMD 模型保留原贴图目录</small></div>${button("import-model", uiText("载入"), "folder")}${button("use-bundled-model", uiText("使用预装 Gene"), "refresh", "subtle")}</div><div class="asset-row" id="appearance-motion"><div><strong>VMD 动作</strong><small id="motion-name">未载入 · 使用默认站姿</small></div>${button("import-motion", uiText("载入"), "folder")}${button("clear-motion", uiText("清除"), "refresh", "subtle")}</div><p id="model-character-hint" class="hint model-character-hint" role="status" hidden></p><p class="hint">保留模型原有文件夹结构。局部物理按下方开关启用，默认关闭。</p></div>
          <div id="motion-library"></div>
          <div class="settings-section" id="model-physics-controls"><h3>局部物理 <small>头发跟随与胸部弹性</small></h3>${toggle('physics-hair-enabled', uiText('头发物理'), uiText('使用模型已有的头发刚体与关节结构'))}<p id="physics-hair-support" class="hint" role="status">正在检查模型结构…</p>${range('physics-hair-strength', uiText('头发效果强度'), 0, 1, 0.05)}${toggle('physics-chest-enabled', uiText('胸部弹性'), uiText('只在模型具备相应骨骼、权重与连接时可用'))}<p id="physics-chest-support" class="hint" role="status">正在检查模型结构…</p>${range('physics-chest-strength', uiText('胸部效果强度'), 0, 1, 0.05)}<label class="field horizontal"><span>物理质量</span><select id="physics-quality"><option value="low">省电</option><option value="standard">标准</option><option value="high">细致</option></select></label><p class="hint">质量调整计算频率和求解预算，效果强度单独调节。效果在桌宠窗口生效，预览不重复计算。</p><p id="physics-save-state" class="hint" role="status">正在读取物理设置…</p></div>
          <div class="settings-section camera-section" id="camera-section"><h3>虚拟镜头 <small>调整伙伴显示的视角</small>${button('camera-edit',uiText('调整模式'),'sliders','camera-edit-button')}</h3><div class="number-grid">${number("camera-yaw", uiText("水平角度 °"), -180, 180, 1)}${number("camera-pitch", uiText("俯仰角度 °"), -80, 80, 1)}${number("camera-distance", uiText("镜头距离"), 1, 500, 0.5)}${number("camera-fov", uiText("视野 FOV °"), 12, 80, 1)}${number("camera-targetX", uiText("水平中心"), -1000, 1000, 0.2)}${number("camera-targetY", uiText("垂直中心"), -1000, 1000, 0.2)}</div></div>
          <div class="settings-section" id="single-emoji-controls"></div><div class="settings-section" id="appearance-natural"><h3>轻一点，自然一点</h3>${toggle("follow-mouse", uiText("视线跟随鼠标"), uiText("眼球与头部共同跟随，远处增加头部权重，不记录轨迹"))}${range("breath", uiText("呼吸幅度"), 0, 1, 0.05)}${range('music-strength', uiText('音乐律动强度'), 0, 1, 0.05)}<p id="music-save-state" class="hint" role="status">正在读取音乐强度…</p><p class="hint">音乐按钮只表示允许她听到本机声音；跳不跳、怎么跳由她的性格、心情和精力决定。强度为 0 时不做律动，朗读、直接互动和手选头部动作优先。</p><details class="advanced-settings"><summary>高级</summary>${toggle('music-always-dance', uiText('让她一直跟着跳'), uiText('打开后音乐一响她就跳，和以前一样；关掉时由她自己决定跳、点头或不动'))}</details><label class="field horizontal"><span>渲染帧率</span><select id="pet-fps"><option value="24">24 FPS · 节能</option><option value="30">30 FPS · 均衡</option><option value="60">60 FPS · 流畅</option></select></label></div>
        </div>
        <div id="tab-providers" class="tab-panel scroll-panel">
          <div class="panel-heading"><div><h2>连接一颗大脑</h2><p>聊天使用你本机已登录的 Claude Code。</p></div></div>
          <div class="settings-section" id="providers-connection"><h3>聊天连接</h3><p class="hint">Claude · 本机已登录的 Claude Code</p><label class="field"><span>模型</span><select id="provider-model"><option value="">Opus（默认）</option><option value="sonnet">Sonnet</option><option value="haiku">Haiku</option><option value="follow-default">跟随 Claude Code 的默认</option></select></label><p class="hint">她默认用 Opus 聊天。账号用不了 Opus 时，会自动换成「跟随 Claude Code 的默认」。换模型不会换掉她的记忆和你们正在聊的话。</p><p id="provider-help" class="hint">使用本机已登录的 Claude Code。陪伴聊天关闭全部工具，只聊天；需要读写文件或运行命令时，在「Claude 任务」里单独打开、逐项批准。</p><p class="hint stance-note">她的话由角色卡和 AI 模型一起生成，代表的是这个角色，不代表模型提供方（Anthropic）或开发者的立场。</p></div>
          <div class="settings-section" id="character-cards-moved"><h3>角色卡</h3><p class="hint">角色卡搬到了「角色」页：每个角色一张卡，点「换成她」就换。</p>${button("goto-characters", uiText("去「角色」页"), "heart", "subtle")}</div>
          <div class="settings-section" id="providers-asr"><h3>语音输入</h3><output id="voice-input-state" class="hint hidden" role="status"></output><label class="field horizontal"><span>识别方式</span><select id="asr-engine"><option value="local">本机自带识别（推荐）</option><option value="compatible">兼容接口地址</option></select></label><label class="field"><span>语言</span><input id="asr-language" placeholder="zh" /></label><div id="asr-local-fields"><p class="hint">免费，声音只在这台电脑上识别，不保存、不上传。第一次使用要先下载识别组件。开启语音输入后，停顿会触发识别并在空闲时发送。</p><div id="local-asr" class="pose-sensing" hidden></div></div><div id="asr-compatible-fields" hidden><label class="field"><span>识别服务地址</span><input id="asr-url" type="url" placeholder="http://127.0.0.1:8000/v1" /></label><label class="field"><span>识别模型</span><input id="asr-model" placeholder="whisper-1 / 你的本地识别模型" /></label><label class="field"><span>识别服务密钥 <small>本地服务通常可留空</small></span><input id="asr-key" type="password" autocomplete="off" /></label><p class="hint">兼容音频转写接口。开启语音输入后，停顿会触发识别并在空闲时发送；回复期间识别到的文字会保留在输入框。</p></div></div>
          <div class="settings-section" id="providers-voice"><h3>声音</h3>${toggle("voice-enabled", uiText("朗读回复"), uiText("按下方选择的语音方案朗读；百炼由你的账号提供服务"))}<div id="system-voice-options"><label class="field"><span>系统声音</span><select id="voice-select"></select></label><p id="voice-select-line" class="hint"></p>${range("voice-rate", uiText("系统语速"), 0.5, 2, 0.1)}${range("voice-mood", uiText("心情影响系统语音（语速和音调）"), 0, 100, 5)}${button("test-voice", uiText("试听系统声音"), "volume", "subtle")}</div>${range("voice-volume", uiText("音量"), 0, 1, 0.05)}<label class="field horizontal"><span>朗读从哪里开口</span><select id="voice-first-chunk" aria-describedby="voice-first-chunk-hint"><option value="sentence">整句读（默认）</option><option value="comma">第一句遇到逗号先读</option></select></label><p id="voice-first-chunk-hint" class="hint">逗号先读：第一句里遇到逗号、前面的字够多（系统声音 4 个，百炼 8 个），就先读这一段，后面照旧整句读；都只读气泡里已经显示的字，从下一条回复起生效。</p>${toggle("voice-pause-talk", uiText("停停说说（试用）"), uiText("她说一小段可能停一下，或者说完一段就停下来等你接话；在哪停、停多久由 haiku 按她的心情和性格定（每条回复多问一次 haiku，占你的 Claude 用量），第一个字照样马上出来。默认关。"))}<div id="speech-beats-switch"></div><p class="hint">完整回复后开始合成，百炼音频可边接收边播放；播放时暂停语音识别，减少回声误识别。口型为轻量近似。</p></div>
          <div id="emotional-voice"></div>
        </div>
        <div id="tab-agent" class="tab-panel scroll-panel">
          <div id="codex-tasks"></div>
        </div>
        <div id="tab-assistant" class="tab-panel chat-panel"><div id="assistant-panel" class="assistant-panel"></div></div>
        <div id="tab-privacy" class="tab-panel scroll-panel">
          <div class="panel-heading" id="privacy-developer"><div><h2>安心地待在桌面</h2><p>需要什么能力，由你决定。</p></div>${button('open-mood', uiText('开发者模式'), 'terminal', 'subtle')}</div>
          <div class="privacy-card">${icon("shield")}<div><strong id="privacy-state">屏幕与摄像头：共享关闭</strong><p>可手动附加快照，或开启共享供消息附图及角色需要关注时的主动话题。自动截图另行开启，只更新内存中的最新帧；关闭即清除画面和旧视觉上下文，重启后源与自动截图均关闭。</p></div></div>
          <div class="settings-section" id="privacy-sharing"><h3>输入与共享</h3>${toggle('runtime-voice',uiText('语音输入'),uiText('开启后从麦克风识别语音；停顿时自动转写。她也会听出你每句话的语气（笑、哭、生气、难过、开心，只记这几个词，不存声音），攒成她对你今天状态的一个大概感觉，只放在内存里，几小时后忘掉。'))}${toggle('runtime-screen',uiText('屏幕共享'),uiText('分享桌宠所在屏幕；可展开自动截图与主动话题选项'))}<div id="camera-sharing-group" class="camera-sharing-group"><strong>${uiText('摄像头共享')}</strong><small>${uiText('两个开关各管各的：可以都开、只开一个，或都不开。')} ${uiText('两个都开时，她平时知道识别出的姿势和她自己看你一眼时记下的话；叫她看时才附图。')}</small>${toggle('runtime-camera-images','发图片','开着时她能看你：平时发消息不附图，她用的是自己看你一眼时记下的一句话（十分钟内）；叫她“看看我”、问她你的样子或点「拍一张给她看」时，发清楚的一张。不用下载，不保存。')}${toggle('runtime-camera','姿势识别（本机）','识别你在不在、朝向、坐着还是站着、动作幅度、挥手，以及你在画面里的位置、离屏幕大概多远和身体各个点的坐标；只在这台电脑上算，不保存、不上传，画面不离开电脑。打开就算你同意她用这些；第一次要下载本地识别组件。')}${toggle('self-look','她自己看一眼','「发图片」开着时，她想你、好奇、担心或无聊时会自己看你一眼；你们聊天时，她手里没有新鲜的那句看到的话时，你发完一句她也会在后台看一眼（这一句不等它，下一句就能提到）。看到的变成一句话给她当背景（画面不保存，这句话 10 分钟后就忘）。每看一次是一次 haiku，用你的 Claude 用量：不限次数，她想看就看，最多大约每分钟一次（体验记录里能看到这一小时第几次）。她睡着了时不看；你在打字时，她不会自己起意看你；你说“别看”她自己会听，真不想让她看就关「发图片」。她看到你像是累了或在笑，也会记进她对你今天状态的大概感觉（只记“累”“笑”这样的词，只放内存，几小时后忘）。')}</div><div id="pose-sensing" class="pose-sensing" hidden></div><div id="face-check" class="pose-sensing" hidden></div></div>
          <div class="settings-section" id="interface-language"><h3>界面语言</h3><label class="field"><span>界面语言</span><select id="ui-language" aria-describedby="ui-language-status"><option value="system">跟随系统</option><option value="en">English</option><option value="zh-CN">简体中文</option></select></label><p id="ui-language-status" class="hint" role="status"></p></div><div class="settings-section" id="privacy-window"><h3>桌宠窗口</h3>${toggle("pet-visible", uiText("显示桌宠"), uiText("透明窗口，可拖动顶部手柄移动"))}${toggle("always-on-top", uiText("始终置顶"), uiText("让她停在普通窗口上方；截图、开始菜单和别的置顶窗口出现时盖在她上面"))}${toggle("click-through", uiText("鼠标穿透"), uiText("开启后只有她身边的空白处让点击穿过去，她本人、聊天框和工具栏照常能点；托盘菜单的「恢复鼠标交互」会把它关掉，Ctrl + Alt + P 只是显示或隐藏她"))}<p class="hint">托盘菜单可随时打开控制窗口、恢复点击或退出。</p></div>
          <div class="settings-section" id="agent-channel"></div>
          <div class="settings-section" id="feed-recognition"></div>
          <div class="settings-section" id="proactive-talk-section"><h3>她主动找你说话</h3><label class="field"><span>频繁程度</span><select id="proactive-talk" aria-describedby="proactive-talk-hint"><option value="less">少一点</option><option value="normal">适中（默认）</option><option value="more">多一点</option></select></label><p id="proactive-talk-hint" class="hint">她自己开口、自己动一动的频繁程度。少一点：明显更安静；多一点：更勤快些。她两次说话至少隔多久、一小时最多说几次、深夜的安静，都不会因此放宽。你也可以直接对她说“话少一点”，或让你的 Claude 帮你改。</p></div>
          <div class="settings-section" id="crisis-region-section"><h3>所在地区（求助信息用）</h3><label class="field"><span>所在地区</span><select id="crisis-region" aria-describedby="crisis-region-hint"><option value="auto">自动（按系统时区猜）</option><option value="US">美国</option><option value="CA">加拿大</option><option value="CN">中国大陆</option><option value="TW">台湾</option><option value="HK">香港</option><option value="other">其他地区</option></select></label><p id="crisis-region-hint" class="hint">只有你的话里出现明确的危险信号（比如说想死、想伤害自己）时，软件会在她的角色之外显示一张求助信息卡：先给这个地区的求助电话，其他地区列在下面。号码写在软件里，不联网，也不记录你说了什么。</p></div>
          <div class="settings-section" id="user-activity"></div>
          <div class="settings-section" id="channel-gates"></div>
          <div class="settings-section" id="voice-keep" hidden></div>
          <div class="settings-section" id="mood-judge"></div>
          <div class="settings-section" id="reactions"></div>
          <div class="settings-section" id="experience-journal"></div>
          <div class="settings-section" id="privacy-data"><h3>数据与恢复</h3><p class="hint">配置、心情和文字记忆保存在本机系统用户目录，API 密钥由操作系统加密。双方聊天文字与时间持续保存，可在「聊天记忆」单独删除；自动召回按当前角色和连接隔离。图片和快照不存入记忆。Claude 聊天每次回复都是一次性调用，不在 Claude Code 里保存会话。远程服务会收到当前消息及本轮选取的相关文字记忆。</p><div class="action-line">${button("reset-settings", uiText("重置应用设置"), "refresh", "subtle")}${button("quit-app", uiText("退出应用"), "stop", "subtle")}</div><p class="hint">重置连接和窗口设置，保留角色卡、心情、文字记忆、任务索引与原模型文件；模型恢复为预装 Gene。</p></div>
          <div class="about"><div class="brand-mark">${icon("spark")}</div><strong>soft hearts</strong><span>独立实现 · 模块化 · 为长期开发留白</span><span class="stance-note">她的话由角色卡和 AI 模型一起生成，代表的是这个角色，不代表模型提供方（Anthropic）或开发者的立场。</span><small>鸣谢与依赖许可见项目 ACKNOWLEDGEMENTS.md</small></div>
        </div>
      </section>
    </main>
    <footer class="statusbar"><span><span class="dot"></span><span id="footer-model">等待载入模型</span></span><span>呼吸待机 · 鼠标视线</span></footer>
  </div>
  <dialog id="screen-dialog"><div class="panel-heading"><div><h2>选择一张屏幕快照</h2><p>选择后仍需点击发送，才会交给聊天模型。</p></div>${button("close-screen", uiText("取消"), "plus", "subtle")}</div><div id="screen-sources" class="screen-sources"></div></dialog>
  <dialog id="reset-dialog"><h2>重置这个应用？</h2><p>将清除配置、密钥及当前对话。你的模型文件会保留。</p><div class="action-line">${button("cancel-reset", uiText("取消"), "plus", "subtle")}${button("confirm-reset", uiText("重置"), "refresh", "danger")}</div></dialog>
  <div id="toast" class="toast" role="status"></div><section id="notice-detail-panel" class="notice-detail-panel" aria-label="问题详情" hidden><strong>问题详情</strong><button id="notice-detail-close" type="button">关闭</button><pre id="notice-detail-text"></pre></section><section id="user-profile-panel" class="user-profile-panel" data-mood-ui aria-label="用户画像" hidden></section>`;
}
