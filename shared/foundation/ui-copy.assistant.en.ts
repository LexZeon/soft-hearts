/** I-071 v2 第二步 「Claude 助手」 page: fixed interface copy only (never the model's words or the host's tool results). */
export const ENGLISH_ASSISTANT_UI_COPY: Readonly<Record<string, string>> = {
  'Claude 助手': 'Claude assistant', '和 Claude 助手说话': 'Talk to the Claude assistant',
  '你自己的 Claude，帮你用和调整 soft hearts。它不是她；这里的对话只存在这一页。':
    'Your own Claude, here to help you use and adjust soft hearts. It is not her; this conversation stays on this page.',
  '模型': 'Model', '思考强度': 'Thinking effort', '{0}（推荐）': '{0} (recommended)', '低': 'low', '高': 'high', '清空': 'Clear',
  '发送': 'Send', '停止': 'Stop', '你': 'You', '思考中…': 'Thinking…', '（已停止）': '(stopped)', '这次没能回完。': 'This reply did not finish.',
  '给 Claude 助手的消息': 'Message to the Claude assistant',
  '问 soft hearts 的事，或者让它帮你改设置…（Enter 发送，Shift+Enter 换行）': 'Ask about soft hearts, or have it change a setting… (Enter to send, Shift+Enter for a new line)',
  '要你同意的操作会先弹窗问你。': 'Anything that needs your OK asks you first.',
  '想调整什么？': 'What would you like to adjust?',
  '问它软件怎么用，它会查手册再答；让它改设置，它会直接动手。要你同意的，会先弹窗问你。':
    'Ask how something works and it looks it up in the manual; ask it to change a setting and it does it. Anything that needs your OK asks you first.',
  '怎么让她更常主动说话？': 'How do I get her to start talking more often?', '声音能换成什么？': 'What voices can she use?', '帮我把朗读关掉': 'Turn off reading aloud for me',
  '撤回': 'Undo', '：': ': ',
  '查看了：{0}': 'Looked at: {0}', '{0} · 可以撤回': '{0} · can be undone', '{0} · 不能撤回': '{0} · cannot be undone', '{0} · 已撤回': '{0} · undone',
  '没有执行：{0}（你没有允许）': 'Not done: {0} (you did not allow it)', '没有执行：{0}（没有确认，算作不允许）': 'Not done: {0} (no answer, counted as not allowed)',
  '没有执行：{0}（已停止）': 'Not done: {0} (stopped)', '没有执行：{0}（另一个确认还开着）': 'Not done: {0} (another confirmation is still open)',
  '没做成：{0}': 'Did not work: {0}',
  '来自 Claude 助手（{0}）。{1} 秒内不回应就算不允许。': 'From the Claude assistant ({0}). No answer within {1} s counts as not allowed.',
  '不允许': 'Don’t allow', '允许': 'Allow',
  // Tool titles from the internal channel's catalog, as the action lines and the popup name them.
  '读取状态': 'Read status', '看看她现在怎么样': 'See how she is', '列出角色卡': 'List character cards', '列出可调设置': 'List settings', '翻手册': 'Read the manual',
  '读取诊断数字': 'Read diagnostics', '切换角色': 'Switch character', '朗读开关': 'Reading aloud', '调整设置': 'Change a setting', '播放表情试作': 'Play expression preview',
  '看这个模型能做什么': 'See what this model can do', '开关这个模型的一项能力': 'Switch a model capability', '让她试一下这一项': 'Let her try it',
  '让她做一个小动作': 'Have her do a small gesture', '调她的反应倾向': 'Adjust her reaction tendencies',
  '打开控制窗口的某一页': 'Open a control window page', '设置朗读声音的模型、音色和风格': 'Set the reading voice, timbre and style', '撤回上一步': 'Undo the last step',
  '开关感知': 'Perception switch', '导入角色卡': 'Import character card', '用角色卡文件更新角色': 'Update a character from a card file', '载入模型': 'Load model',
  '把当前模型关联到角色': 'Link the current model to a character', '试听语音': 'Voice preview', '删除记忆（进回收站）': 'Delete memories (to the recycle bin)',
  '查看回收站': 'View the recycle bin', '从回收站找回': 'Restore from the recycle bin', '换回预装 Gene': 'Switch back to bundled Gene',
  '解除角色和模型的关联': 'Unlink character and model', '用现在的模型新建角色': 'New character for the current model', '三方互通开关': 'Three-way interconnect switch',
  // I-071 v2 第三步 转换成英文 / 中文角色
  '看看转换会带过去什么': 'See what a conversion carries over', '转换成另一种语言的角色': 'Convert to a character in the other language',
  '查看转换进度': 'Check the conversion', '取消转换': 'Cancel the conversion',
  '英文版': 'English version', '中文版': 'Chinese version', '把「{0}」转成{1}': 'Converting "{0}" into the {1}',
  '先备份': 'Back up first', '读她的记忆（只读）': 'Read her memories (read only)', '翻译人设': 'Translate the persona', '翻译记忆': 'Translate her memories',
  '检查新卡': 'Check the new card', '保存新角色': 'Save the new character',
  '转好了：新角色「{0}」在角色页（还不是当前角色）。原来的「{1}」没有任何改动。':
    'Done: the new character "{0}" is on the Characters page (not the current one yet). The original "{1}" is unchanged.',
  '已取消：没有留下任何新东西，原角色没有任何改动。': 'Cancelled: nothing new was left behind and the original character is unchanged.',
  '没有转成，原角色没有任何改动。': 'The conversion did not finish; the original character is unchanged.',
  // I-071 fix 5: memory items left out after their re-ask
  '有 {0} 条记忆重问一次还是翻得不合格，没有带过去（新卡里没有它们，原角色里都还在）：':
    '{0} memories still did not translate properly after one more try and were not carried over (the new card does not have them; the original still does):',
  '还有 {0} 条': '{0} more',
  '又写出了先不带的名字': 'a pet name left for later came back', '没按你选的译名写（名字或称呼和你选的不一致）': 'a name was not written the way you chose',
  '还留着原来语言的字': 'text in the original language remained', '像是自己编了一个昵称或爱称': 'it seemed to make up a pet name',
  '两次都没有对上格式': 'the answer was malformed twice',
  // I-071 fix 8: everything not carried whole is listed, each with its reason
  '有 {0} 项没有完整带过去（原角色里都还在）：': '{0} items were not carried over in full (the original still has all of them):',
  '翻回来是空的或少了，这部分没有带': 'came back empty or incomplete; that part was not carried',
  '翻得太长，被截短了，后面没有带': 'came back too long and was cut; the rest was not carried',
  '超出这次带过去的范围（设计如此），没有带': 'older than what a conversion carries (by design); not carried',
  '和另一条重复，只带了一条': 'the same as another one; carried once',
  '看起来像密码、密钥或文件路径，画像不收': 'looked like a password, key or file path; the profile does not keep that',
  '朗读设置已经满 64 条，为了不挤掉别的角色的，新卡的没有加': 'the voice settings are full (64); the new card\'s was not added so no other character\'s is dropped',
};
