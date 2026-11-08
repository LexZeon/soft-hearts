// I-021 (docs/claude/2026-11-04-memory-notes.md): the note section of one memory in 聊天记忆.
export const ENGLISH_MEMORY_NOTES_UI_COPY: Readonly<Record<string, string>> = {
  '她的笔记': 'Her note',
  '提到的人：': 'People mentioned: ',
  '提到的事：': 'Things mentioned: ',
  '你当时的心情：': 'How you felt: ',
  '说好要做的：': 'Plans you mentioned: ',
  '方便想起来的词：': 'Words that bring it back: ',
  '笔记是她自己整理的，可能记错；想起来的时候以下面的原文为准。': 'She wrote this note herself and may have it wrong; when she remembers, the original text below is what counts.',
  '删除这条笔记': 'Delete this note',
  '确认删除这条笔记（原文不删）': 'Confirm: delete the note (the original stays)',
  '这条笔记你删掉了，她不会再给这段写笔记；原文还在。': 'You deleted this note. She will not write one for this chat again; the original is still here.',
  '这段还没有笔记，她会在你不忙的时候慢慢整理。': 'No note yet. She will write one when you are not busy.',
  '这段不写笔记（太短，或者不是你们的聊天）。': 'No note for this one (too short, or not a chat between you).',
  '已经整理了 {0} 段，还有 {1} 段等着整理。': '{0} chats have notes; {1} still waiting.',
};
