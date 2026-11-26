// I-139 B (docs/claude/2026-11-15-i139-defences.md): under the I-139 switch the instructions call the person she talks to "这个人", so a
// leaked planning draft in the new style names the listener "这个人" or "对方" instead of "用户". The draft guard (ReplyDraftGuard) and the
// long-chat window's leaked-draft check (isLeakedDraft) learn those words behind the switch; she also says them in speech, so ordinary
// replies with them must pass byte for byte, and no reply's first character may come later. Every sentence below is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyDraftGuard } from '../electron/brain/reply-draft-guard';
import { isLeakedDraft } from '../electron/brain/long-chat/history';
import { MoodReplyProtocol } from '../electron/mood/mood-chat';
import { PROMPT_SWITCHES_STABLE, getPromptSwitches, setPromptSwitches } from '../shared/brain/prompt-switches';

function chunkings(text: string): string[][] {
  const pieces = (sizes: (i: number) => number) => { const out: string[] = []; for (let i = 0, n = 0; i < text.length; n++) { const size = Math.max(1, sizes(n)); out.push(text.slice(i, i + size)); i += size; } return out; };
  let seed = 1139;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  return [[text], pieces(() => 1), pieces(() => 2), pieces(() => 3), pieces(() => 1 + Math.floor(random() * 7)), pieces(n => n === 0 ? 1 : 1 + Math.floor(random() * 25))];
}

function run(chunks: readonly string[], listenerWords: boolean): { shown: string; first: string; drops: number } {
  const guard = new ReplyDraftGuard([], { chinese: true, listenerWords });
  let shown = '', first = '';
  chunks.forEach((chunk, index) => { const out = guard.push(chunk); if (index === 0) first = out; shown += out; });
  shown += guard.finish();
  return { shown, first, drops: guard.dropped.length };
}

/** Leaked drafts in the new words, and what she should be left with. */
const LEAKS: Array<{ name: string; raw: string; reply: string }> = [
  { name: 'a note about the listener, a plan, then the reply', raw: '这个人今天加班到很晚，心情不太好。回复要短一点，语气温柔。辛苦啦，先喝口水歇一会儿吧～', reply: '辛苦啦，先喝口水歇一会儿吧～' },
  { name: '"对方" with how to answer in one sentence', raw: '对方说想吃火锅，回应要热情一点。好呀好呀，我们去吃火锅！', reply: '好呀好呀，我们去吃火锅！' },
  { name: 'a note that the listener wants something, then the reply', raw: '这个人想看图里的菜单，需要先回答价格。嗯……第一行写的是二十八块哦。', reply: '嗯……第一行写的是二十八块哦。' },
  { name: 'a plan line with a label', raw: '笔记：这个人刚下班，累了，回复要轻一点，不要说教。\n辛苦了，先歇会儿～', reply: '辛苦了，先歇会儿～' },
  { name: 'a late plan sentence after a short reply', raw: '嗯嗯，听到啦。\n这个人先前说过嗓子疼，可以问一句也可以不问。\n今天嗓子好点了没呀？', reply: '嗯嗯，听到啦。\n今天嗓子好点了没呀？' },
];

for (const leak of LEAKS) {
  test(`I-139 listener words, a leaked draft is cut: ${leak.name}`, () => {
    for (const [index, chunks] of chunkings(leak.raw).entries()) {
      // "对" alone never waits ("对呀", "对不起"), so a draft opening "对方" is caught when its first chunk holds both characters.
      if (/^对方/u.test(leak.raw) && chunks[0].length < 2) continue;
      const on = run(chunks, true);
      // A label's first characters that arrived alone ("笔记" before its colon) may already be out: the protocol then treats the reply
      // as emptied (onlyLabelShown); everything after them is the reply.
      const label = /^[^：:\n]{1,4}[：:]/u.exec(leak.raw)?.[0].slice(0, -1) ?? '';
      assert.ok(on.shown === leak.reply || (label && on.shown === label.slice(0, on.shown.length - leak.reply.length) + leak.reply && on.shown.length > leak.reply.length),
        `listener on, chunking ${index}: ${JSON.stringify(on.shown)}`);
      assert.ok(on.drops > 0, `listener on, chunking ${index}: recorded as a drop`);
    }
    // Without the option (switch off, the instructions still say "用户") the old guard did not know this shape.
    assert.notEqual(run([leak.raw], false).shown, leak.reply, 'the shape is new: the old rules let it through');
  });
}

/** Ordinary replies that say "这个人" / "对方" (or begin like them) and must pass byte for byte with the option on. */
const ORDINARY: readonly string[] = [
  '你这个人真是的，又熬夜了！',
  '这个人真不像话。换我早就生气了。',
  '对方怎么能这样呢？太过分了！',
  '这个人我记得，上次你说过他总抢你功劳。',
  '对呀，我也这么想～',
  '这个嘛，让我想想。',
  '嗯嗯。\n这个人好讨厌哦，别理他啦。',
  '对方要是再这样，你就告诉我，我帮你骂他！',
  '这个人想得也太多了吧。',
  '我这个人就是嘴硬，其实很想你。',
  '对不起嘛，我刚才走神了。',
  '这个人家里有猫吗？好想去摸摸。',
];

for (const raw of ORDINARY) {
  test(`I-139 listener words, an ordinary reply passes unchanged: ${raw.slice(0, 16)}`, () => {
    for (const [index, chunks] of chunkings(raw).entries()) {
      const on = run(chunks, true), off = run(chunks, false);
      assert.equal(on.shown, raw, `listener on, chunking ${index}`);
      assert.equal(on.drops, 0, `listener on, chunking ${index}: nothing recorded`);
      // A reply whose first chunk already holds the whole word ("这个人", "对方") is held to its first word said to someone or to its
      // sentence end, as one starting "用户" is; any other first chunk goes out exactly as without the option.
      // A first chunk of exactly "这个" waits for one more chunk (it may be "这个人").
      if (!/^(?:这个人|对方)/u.test(chunks[0]) && chunks[0] !== '这个') assert.equal(on.first, off.first, `listener on, chunking ${index}: the first chunk goes out exactly as without the option`);
    }
  });
}

test('I-139 listener words: "对" never waits; "这个" waits for one more chunk only; said to someone, it goes out at once', () => {
  assert.equal(run(['对', '呀～'], true).first, '对', '"对" goes out at once, as before');
  assert.equal(run(['这', '个', '嘛，让我想想。'], true).shown, '这个嘛，让我想想。');
  const held = new ReplyDraftGuard([], { chinese: true, listenerWords: true });
  assert.equal(held.push('这个'), '', '"这个" alone waits for the next chunk');
  assert.equal(held.push('嘛，让我想想。'), '这个嘛，让我想想。', 'and goes out with it when it is not "这个人"');
  const said = new ReplyDraftGuard([], { chinese: true, listenerWords: true });
  assert.equal(said.push('这个人呀'), '这个人呀', 'a particle right behind the word: said to someone, out at once');
});

test('the listener option is behind the I-139 switch: off by default, on with getPromptSwitches().relaxed, an explicit option wins', () => {
  const raw = LEAKS[0].raw, saved = getPromptSwitches();
  const shown = (options: { listenerWords?: boolean }) => { const guard = new ReplyDraftGuard([], { chinese: true, ...options }); return guard.push(raw) + guard.finish(); };
  try {
    setPromptSwitches(PROMPT_SWITCHES_STABLE);
    assert.equal(shown({}), run([raw], false).shown, 'switch off: the old guard');
    setPromptSwitches({ ...PROMPT_SWITCHES_STABLE, relaxed: true });
    assert.equal(shown({}), LEAKS[0].reply, 'switch on: the listener words count');
    assert.equal(shown({ listenerWords: false }), run([raw], false).shown, 'explicit off wins');
    // The real reply protocol builds its guard the same way.
    const out: string[] = [];
    const protocol = new MoodReplyProtocol(text => { out.push(text); }, { settingProposal: { instruction: null }, chineseChat: true });
    protocol.push(raw); protocol.finish(true);
    assert.equal(out.join(''), LEAKS[0].reply, 'MoodReplyProtocol with the switch on');
    // English chat never uses it.
    setPromptSwitches({ ...PROMPT_SWITCHES_STABLE, relaxed: true });
    const english = new ReplyDraftGuard([], { chinese: false });
    assert.equal(english.push(raw) + english.finish(), raw, 'not a Chinese chat: unchanged');
  } finally { setPromptSwitches(saved); }
});

// The reason it is behind the switch: a reply about someone else, said to no one, that reports what that person wants reads exactly
// like a note in the new words. With the switch off (instructions say "用户") it passes as before.
test('known trade-off, documented: "对方想要的是道歉。" passes with the option off, is read as a note with it on', () => {
  const raw = '对方想要的是道歉。';
  assert.equal(run([raw], false).shown, raw);
  assert.notEqual(run([raw], true).shown, raw);
});

test('isLeakedDraft (the long-chat window and her note): notes in the new words, behind the switch; speech with them is not a leak', () => {
  const note = { role: 'assistant' as const, content: '这个人想听安慰，回复要轻一点。抱抱你。' };
  assert.equal(isLeakedDraft(note, { listenerWords: true }), true);
  assert.equal(isLeakedDraft(note, { listenerWords: false }), false, 'option off: as before');
  assert.equal(isLeakedDraft({ role: 'assistant', content: '回复对方的时候语气温和一点就好。' }, { listenerWords: true }), true);
  for (const content of ['对方不回复你就别等了。', '你这个人回复也太慢了吧！', '这个人回复好慢啊。', '我回复对方了，你放心～', '这个人真讨厌。'])
    assert.equal(isLeakedDraft({ role: 'assistant', content }, { listenerWords: true }), false, content);
  assert.equal(isLeakedDraft({ role: 'user', content: note.content }, { listenerWords: true }), false, 'only her replies are judged');
  const saved = getPromptSwitches();
  try {
    setPromptSwitches(PROMPT_SWITCHES_STABLE);
    assert.equal(isLeakedDraft(note), false, 'switch off by default');
    setPromptSwitches({ ...PROMPT_SWITCHES_STABLE, relaxed: true });
    assert.equal(isLeakedDraft(note), true, 'switch on');
  } finally { setPromptSwitches(saved); }
});
