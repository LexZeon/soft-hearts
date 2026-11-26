/** 体验记录: the journal's English for Claude Code itself: the internal channel's link (I-061), the start gate (I-202) and unknown stream kinds (2026-11-25). Split from ui-copy.journal.en.ts (size check, 2026-11-25). Authored copy only. */
export const ENGLISH_JOURNAL_CLAUDE_UI_COPY: Readonly<Record<string, string>> = {
  // I-061 the internal channel's link to the user's Claude Code
  '复制诊断信息': 'Copy diagnostics', '把版本、系统、Claude Code 版本、内部通道状态和最近几条问题的类别复制下来，可以贴给你自己的 Claude 或 GitHub 问题。不含聊天、角色卡、路径和密钥。': 'Copies the versions, system, Claude Code version, internal channel state and the categories of the last few problems, to paste to your own Claude or into a GitHub issue. No chat, character cards, paths or keys.',
  '内部通道检查了你的 Claude Code：已经接上': 'The internal channel checked your Claude Code: linked', '内部通道检查了你的 Claude Code：刚登记上': 'The internal channel checked your Claude Code: just registered',
  '内部通道检查了你的 Claude Code：登记已改到这个版本': 'The internal channel checked your Claude Code: registration moved to this version',
  '内部通道检查了你的 Claude Code：登记被移除过，没有再加': 'The internal channel checked your Claude Code: the registration had been removed, not added back',
  '内部通道检查了你的 Claude Code：没找到它': 'The internal channel checked: Claude Code was not found', '内部通道没能接上你的 Claude Code': 'The internal channel could not link to your Claude Code',
  '内部通道检查被跳过（测试用配置目录）': 'The internal channel check was skipped (test profile folder)',
  '内部通道检查了你的 Claude Code：登记指向别的版本，没有改': 'The internal channel checked your Claude Code: the registration points at another version, left alone',
  '内部通道检查了你的 Claude Code：读不出登记指向哪里': 'The internal channel checked your Claude Code: could not read where the registration points',
  '名字出现了好几次，内容一样': 'the name appears several times, all the same', '名字出现了好几次，内容不一样': 'the name appears several times, not all the same',
  '这一行没读到结尾的状态': 'the row never ended in a status', '读到的启动命令不是本程序的': 'the launch line read is not this app\'s', '检查被中途打断了': 'the check was cut short', '这一行被折成了几行，又没能单独读出来': 'the row was wrapped and could not be read on its own',
  '名字出现了 {0} 次': 'the name appears {0} time(s)', '检查开头的提示出现了不止一次': 'the check\'s header line appears more than once',
  'Claude Code 不认我们给它的命令参数（多半是版本变了）': 'Claude Code rejected the command arguments (probably a version change)', 'Claude Code 没有在时限内回应': 'Claude Code did not answer in time',
  'Claude Code 没能启动': 'Claude Code could not be started', '没有权限运行 Claude Code 或写它的配置': 'No permission to run Claude Code or write its settings',
  'Claude Code 报了错就退出了': 'Claude Code exited with an error', '改登记到新版本时没做完': 'Moving the registration to the new version was not finished',
  '没能在配置目录里记下改动进度，所以没有改登记': 'Could not note progress in the profile folder, so the registration was not changed', '登记用的名字被别的登记占用了': 'The registration name is taken by another registration',
  '原因不明': 'cause unknown', 'Claude Code {0}': 'Claude Code {0}', '版本未知': 'version unknown', '你点了重新接上': 'you pressed re-link', '自动检查': 'automatic check',
  // I-202 the start gate; 2026-11-25 a stream kind the chat reader does not know (shared/brain/journal-entries.ts)
  'Claude Code 的登录没了，先停一分钟不再起新进程': 'Claude Code lost its sign-in; no new process starts for a minute',
  'Claude Code 的输出里有一种聊天没见过的事件（只记名字）': 'Claude Code sent an event kind the chat does not know (name only)',
  // 2026-11-25 started from inside a Claude Code session (shared/brain/claude-session-env.ts)
  '软件是从一个 Claude Code 会话里打开的：那个会话的连接和登录变量没有交给她的进程（只记名字）': 'The app was started from inside a Claude Code session: that session\'s connection and sign-in variables were not passed to her processes (names only)',
};
