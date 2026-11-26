// Her memories on the internal channel (docs/claude/2026-11-17-app-tools-split.md): delete_memories (into her recycle bin, never for
// good; the user's words and always the dialog), clear_song_memory (the same), list_recycle_bin and restore_memories. Only while
// 三方互通 is on.
import type { AgentRecyclePart, AgentRecycleSummary } from '../../../../shared/safety/agent-channel';
import { AgentToolError, type AgentCallContext, type AgentToolDefinition } from '../registry';
import { argsObject, cardId, noArgs, oneOf } from '../validate';
import { title, unavailable, type ToolContext } from './common';
import { ASSISTANT_NAME } from '../../../../shared/foundation/assistant-name';

export function memoryTools(context: ToolContext): AgentToolDefinition<any, any>[] {
  const { bridge, card, targetCardStill } = context;
  return [
    {
      // I-014 回收站 (Claude's suggestion): nothing is deleted for good at once; each part waits in her recycle bin.
      // I-025: deletion needs the user's own words (confirm tier; 三方互通 is always on for this tool).
      // 敏感操作弹窗 (2026-11-12): deleting always opens the dialog, after the user's words.
      name: 'delete_memories', title: title('delete_memories'), tier: 'confirm', interconnectOnly: true, alwaysConfirm: true,
      confirmation: (target: { name: string; parts: AgentRecyclePart[] }) => ({ title: `${ASSISTANT_NAME} 请求删除「${target.name}」的记忆`,
        detail: `${target.parts.map(part => part === 'chat' ? '聊天记忆' : '画像和日记').join('、')}会先进回收站，${bridge.memories?.days() ?? 7} 天内可以找回。` }),
      wordsItem: (target: { parts: AgentRecyclePart[] }) => ({ item: 'delete_memories', value: target.parts.join(',') }),
      validate: raw => {
        const args = argsObject(raw, ['id', 'parts']);
        const id = cardId(args.id);
        if (!Array.isArray(args.parts) || args.parts.length < 1 || args.parts.length > 2) throw new AgentToolError('invalid_input', 'parts 只能是 chat、profile 里的一两项。');
        const parts: AgentRecyclePart[] = [];
        for (const part of args.parts) {
          const value = oneOf(part, ['chat', 'profile'] as const, 'parts ');
          if (parts.includes(value)) throw new AgentToolError('invalid_input', 'parts 不能重复。');
          parts.push(value);
        }
        return { id, parts };
      },
      prepare: (input: { id: string; parts: AgentRecyclePart[] }) => {
        if (!bridge.memories) throw unavailable('这个版本还没有回收站，不能删除记忆。');
        const target = card(input.id);
        return { id: target.id, name: target.name, parts: input.parts };
      },
      noticeDetail: (target: { name: string; parts: AgentRecyclePart[] }) =>
        `「${target.name}」的${target.parts.map(part => part === 'chat' ? '聊天记忆' : '画像和日记').join('、')}进了回收站（${bridge.memories?.days() ?? 7} 天内可找回）`,
      run: async (target: { id: string; name: string; parts: AgentRecyclePart[] }, context: AgentCallContext) => {
        const memories = bridge.memories!;
        targetCardStill(target);
        const outcome = await memories.forget(target.id, target.name, target.parts, context.check);
        if (outcome.entries.length) context.offerUndo({ label: `把「${target.name}」删掉的记忆放回去`, run: async guard => {
          for (const entry of outcome.entries) await memories.restore(entry.id, guard);
        } });
        return {
          character: { id: target.id, name: target.name },
          recycled: outcome.entries.map(entry => ({ entryId: entry.id, part: entry.part, label: entry.label, expiresAt: new Date(entry.expiresAt).toISOString() })),
          nothingToDelete: outcome.empty, failed: outcome.failed,
          note: `没有永久删除：在回收站里留 ${memories.days()} 天，期间可以用 restore_memories 或 undo_last_action 找回，到期才清理。`
            + (outcome.failed.length ? ' 有一部分没能放进回收站，所以那部分没有删除。' : ''),
        };
      },
    },
    {
      // I-077 step 2: the songs she recognises (a few numbers each, no audio, no titles). Clearing is a delete: the user's own words (confirm tier,
      // 三方互通 always on for this tool), and the undo puts the same numbers back. Nothing reads them out: the channel can only clear.
      name: 'clear_song_memory', title: title('clear_song_memory'), tier: 'confirm', interconnectOnly: true, alwaysConfirm: true, validate: noArgs,
      confirmation: () => ({ title: `${ASSISTANT_NAME} 请求清除她记得的歌`, detail: '她认得的常放的歌会全部忘掉（只是每首歌前奏的几个数，不是声音，也没有歌名）；之后要重新听过几遍才会再认得。' }),
      wordsItem: () => ({ item: 'clear_song_memory', value: null }),
      prepare: () => { if (!bridge.songs) throw unavailable('这个版本还没有她记得歌的功能。'); return null; },
      noticeDetail: () => '她记得的歌被清除了',
      run: async (_target: null, context: AgentCallContext) => {
        const outcome = await bridge.songs!.clear();
        if (outcome.count) context.offerUndo({ label: '把她记得的歌放回去', run: async guard => { guard(); await outcome.restore(); } });
        return { cleared: outcome.count, note: outcome.count ? '她记得的歌已经清除（只是几个数）；用 undo_last_action 可以放回去。' : '她本来就没有记着的歌。' };
      },
    },
    {
      name: 'list_recycle_bin', title: title('list_recycle_bin'), tier: 'read', interconnectOnly: true, validate: noArgs,
      run: () => {
        if (!bridge.memories) throw unavailable('这个版本还没有回收站。');
        return { retentionDays: bridge.memories.days(), entries: bridge.memories.list().map(entry => ({
          entryId: entry.id, characterId: entry.characterId, characterName: entry.characterName, part: entry.part, label: entry.label,
          deletedAt: new Date(entry.deletedAt).toISOString(), expiresAt: new Date(entry.expiresAt).toISOString() })) };
      },
    },
    {
      name: 'restore_memories', title: title('restore_memories'), tier: 'reversible', interconnectOnly: true,
      validate: raw => {
        const entryId = argsObject(raw, ['entryId']).entryId;
        if (typeof entryId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entryId))
          throw new AgentToolError('invalid_input', 'entryId 必须是 list_recycle_bin 返回的编号。');
        return entryId.toLowerCase();
      },
      prepare: (entryId: string) => {
        if (!bridge.memories) throw unavailable('这个版本还没有回收站。');
        const entry = bridge.memories.list().find(item => item.id === entryId);
        if (!entry) throw unavailable('回收站里没有这一项（可能已经找回或到期清理了）。');
        return entry;
      },
      noticeDetail: (entry: AgentRecycleSummary) => `「${entry.characterName}」的${entry.label}`,
      run: async (entry: AgentRecycleSummary, context: AgentCallContext) => {
        const outcome = await bridge.memories!.restore(entry.id, context.check);
        return { restored: { characterName: entry.characterName, part: entry.part, label: entry.label },
          ...(outcome.replaced ? { replaced: { entryId: outcome.replaced.id, label: outcome.replaced.label,
            note: '她在删除之后又记了新的画像或日记；那一份没有丢，换进了回收站。' } } : {}) };
      },
    },
  ];
}
