// Character cards on the internal channel (docs/claude/2026-11-17-app-tools-split.md): list_characters, activate_character,
// set_reaction_dispositions (the character page's six sliders), import_character_card and update_character_card (files: nothing of
// them is read before the user's OK; always the dialog), bind / unbind the model, create a character for the current model, and (I-173)
// delete_character (into the recycle bin; the user's words and always the dialog; never the active character or the last card).
import { cardLanguageOf, type CharacterCardState } from '../../../../shared/foundation/character-card';
import { cardUpdateSummaryLines, type CharacterCardUpdatePlanView } from '../../../../shared/cards';
import { DISPOSITIONS, DISPOSITION_IDS, type DispositionId } from '../../../../shared/mood';
import { AgentToolError, type AgentCallContext, type AgentToolDefinition } from '../registry';
import { argsObject, assertUnchanged, cardId, inspectLocalFile, localFilePath, noArgs, type FileFacts } from '../validate';
import { readConfirmedText } from '../file-binding';
import { title, unavailable, type ToolContext } from './common';
import { ASSISTANT_NAME } from '../../../../shared/foundation/assistant-name';

/**
 * C3 update_character_card after its checks: the file the user is asked about. T-239: `content` and `plan` exist only after the
 * user agreed to the file being read (registry `load`); the second dialog shows the plan.
 */
interface CardUpdateRequest { facts: FileFacts; id: string; name: string; content?: string; plan?: CharacterCardUpdatePlanView;
  /** I-173: the user's own words asked for the file's voice too (the 角色页's tick); the second dialog says so. */
  useFileVoice?: boolean }

/** I-173 delete_character after its checks: the card asked about and whether her memories go too. */
interface CharacterDeleteRequest { id: string; name: string; forgetMemories: boolean }
/** The 角色页's own rules for deleting: never the character who is with the user now (switch first), never the last card. */
function refuseDeleting(state: CharacterCardState, target: { id: string; name: string }): void {
  if (state.activeId === target.id) throw unavailable(`「${target.name}」正在陪着你，不能直接删：先和用户确认换成谁，用 activate_character 换过去，再删。`);
  if (state.cards.length <= 1) throw unavailable('至少要保留一张角色卡，最后一张不能删。');
}
/** The dialog's text: the 角色页's own question (recycle bin, days, memories stay unless asked). */
export function characterDeleteDetail(target: CharacterDeleteRequest, days: number): string {
  return [`要删除的角色：${target.name}`,
    target.forgetMemories ? '同时删除她的记忆：聊天记录、日记和画像、熟悉度和昵称、她记得的计划和笔记、一起听一起看、我们的小东西、特别的日子等。' : '只删这张角色卡和模型关联；她的聊天记忆、日记和画像都留着。',
    `会先放进回收站，留 ${days} 天，期间可以完整找回；到期才真正删除。`].join('\n');
}

export function characterTools(context: ToolContext): AgentToolDefinition<any, any>[] {
  const { bridge, fs, platform, fileBytes, card, activeId, targetCardStill } = context;
  return [
    {
      name: 'list_characters', title: title('list_characters'), tier: 'read', validate: noArgs,
      run: () => {
        const state = bridge.characters();
        return { activeId: state.activeId, characters: state.cards.map(item => ({
          id: item.id, name: item.name, modelName: item.modelName ?? null, active: item.id === state.activeId,
          language: cardLanguageOf(item) })) }; // I-071 v2: the one language this card speaks
      },
    },
    {
      name: 'activate_character', title: title('activate_character'), tier: 'reversible',
      validate: raw => ({ id: cardId(argsObject(raw, ['id']).id) }),
      prepare: (input: { id: string }) => card(input.id),
      noticeDetail: (target: { name: string }) => `换成「${target.name}」`,
      run: async (target: { id: string; name: string }, context: AgentCallContext) => {
        const previous = activeId();
        await bridge.activateCharacter(target.id, context.check);
        const state = bridge.characters();
        const back = state.cards.find(item => item.id === previous);
        if (back && previous !== state.activeId) context.offerUndo({ label: `换回「${back.name}」`, run: async guard => {
          if (activeId() !== target.id) throw unavailable('之后又换过角色了，没有撤回。');
          await bridge.activateCharacter(back.id, guard);
        } });
        return { activeId: state.activeId, name: state.cards.find(item => item.id === state.activeId)?.name ?? null };
      },
    },
    {
      // I-037: the six 反应倾向 are decided with the user and kept per character id (never in the card). The 角色页's
      // own sliders, for the user's own Claude: reversible (the previous values come back with undo_last_action), no privacy effect.
      name: 'set_reaction_dispositions', title: title('set_reaction_dispositions'), tier: 'reversible',
      validate: raw => {
        const args = argsObject(raw, [...DISPOSITION_IDS, 'reset']);
        if (args.reset !== undefined && args.reset !== true) throw new AgentToolError('invalid_input', 'reset 只能是 true。');
        const values: Partial<Record<DispositionId, number>> = {};
        for (const id of DISPOSITION_IDS) {
          const n = args[id];
          if (n === undefined) continue;
          if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100) throw new AgentToolError('invalid_input', `${id}（${DISPOSITIONS[id].label}）要是 0～100 的整数。`);
          values[id] = n;
        }
        const given = Object.keys(values).length;
        if (args.reset === true && given) throw new AgentToolError('invalid_input', 'reset 不能和六项同时给。');
        if (args.reset !== true && !given) throw new AgentToolError('invalid_input', '至少给一项（shy、clingy、lively、soothable、volatile、restrained），或者 reset:true。');
        return args.reset === true ? null : values;
      },
      prepare: (values: Partial<Record<DispositionId, number>> | null) => {
        if (!bridge.setReactionDispositions) throw unavailable('这个版本还不能这样调她的反应倾向。');
        return values;
      },
      noticeDetail: (values: Partial<Record<DispositionId, number>> | null) => values === null ? '把她的反应倾向改回按角色卡推算'
        : `调了她的反应倾向：${(Object.keys(values) as DispositionId[]).map(id => `${DISPOSITIONS[id].label} ${values[id]}`).join('、')}`,
      run: async (values: Partial<Record<DispositionId, number>> | null, context: AgentCallContext) => {
        const result = await bridge.setReactionDispositions!(values, context.check);
        const characterId = result.characterId, after = result.values, stored = result.stored;
        context.offerUndo({ label: '把她的反应倾向改回原来的值', run: async guard => {
          if (bridge.reactionDispositions?.()?.characterId !== characterId) throw unavailable('之后换过角色了，没有撤回。');
          await bridge.setReactionDispositions!(result.before, guard);
        } });
        return { characterId, values: after, fromCard: !stored, before: result.before ?? '按角色卡推算',
          note: '只属于当前角色，存在本机，不写进角色卡；从下一件事起生效。' };
      },
    },
    {
      // 敏感操作弹窗 (2026-11-12): the three file tools always open the dialog (after the user's words with 三方互通 on).
      name: 'import_character_card', title: title('import_character_card'), tier: 'confirm', touchesFiles: true, alwaysConfirm: true,
      validate: raw => localFilePath(argsObject(raw, ['path']).path, ['.json'], platform),
      // T-239 + X-435: before the OK only the path checks and the file's stat (name, place, size, time); nothing of it is read.
      // After the OK its bytes are read once and exactly those are imported.
      prepare: (file: string) => inspectLocalFile(file, ['.json'], 1_000_000, fs, platform),
      noticeDetail: (facts: FileFacts) => facts.name,
      confirmation: (facts: FileFacts) => ({
        title: `${ASSISTANT_NAME} 请求导入一张角色卡`,
        detail: `文件：${facts.name}\n位置：${facts.directory}\n大小：${Math.max(1, Math.round(facts.size / 1024))} KB\n\n只读取这个 JSON 并按角色卡格式检查；导入不授予任何文件或执行权限。`,
      }),
      run: async (facts: FileFacts, context: AgentCallContext) => {
        const content = await readConfirmedText(facts, fileBytes, fs);
        const before = new Set(bridge.characters().cards.map(item => item.id));
        const state = await bridge.importCharacterCard(content, context.check);
        const added = state.cards.find(item => !before.has(item.id));
        return { imported: added ? { id: added.id, name: added.name } : null, notice: state.notice ?? null, count: state.cards.length };
      },
    },
    {
      // C3 (docs/claude/2026-11-03-card-update-in-place.md): the same card, the same id; her memories stay hers.
      name: 'update_character_card', title: title('update_character_card'), tier: 'confirm', touchesFiles: true, alwaysConfirm: true,
      validate: raw => {
        const args = argsObject(raw, ['id', 'path', 'useFileVoice']);
        // I-173: the 角色页's 「也换成文件里的声音」 tick, for the channel. Only when the user's own words asked for it; the tool
        // is confirm tier with the dialog, so it needs those words (三方互通 on) and the dialog names the voice before anything is written.
        if (args.useFileVoice !== undefined && args.useFileVoice !== true) throw new AgentToolError('invalid_input', 'useFileVoice 只能是 true（不给就保留她现在的声音）。');
        return { id: cardId(args.id), file: localFilePath(args.path, ['.json'], platform), ...(args.useFileVoice === true ? { useFileVoice: true } : {}) };
      },
      // T-239 (Codex review: "更新操作在同意前读取任意位置的合规 JSON") + X-435: before the first OK only the file's name, place, size and
      // time are known (nothing of it is read); after that OK it is read once and planned (`load`), the second dialog shows that
      // plan, and `run` writes exactly the content that was planned and shown — the file is never read again by path.
      prepare: async (input: { id: string; file: string; useFileVoice?: boolean }): Promise<CardUpdateRequest> => {
        if (!bridge.planCharacterCardUpdate || !bridge.updateCharacterCard) throw unavailable('这个版本还不能用角色卡文件更新角色。');
        const target = card(input.id);
        const facts = await inspectLocalFile(input.file, ['.json'], 1_000_000, fs, platform);
        return { facts, id: target.id, name: target.name, ...(input.useFileVoice ? { useFileVoice: true } : {}) };
      },
      confirmation: (request: CardUpdateRequest) => ({
        title: `${ASSISTANT_NAME} 请求读取一个角色卡文件，用来更新「${request.name}」`,
        detail: [`要更新的角色：${request.name}`, `文件：${request.facts.name}`, `位置：${request.facts.directory}`,
          `大小：${Math.max(1, Math.round(request.facts.size / 1024))} KB`, '',
          '允许后才会读这个文件；读完会再给你看具体要改哪些地方，你再确认一次才会更新。'].join('\n'),
        buttons: ['不读', '允许读取'],
      }),
      load: async (request: CardUpdateRequest): Promise<CardUpdateRequest> => {
        const content = await readConfirmedText(request.facts, fileBytes, fs);
        const target = card(request.id);
        let plan: CharacterCardUpdatePlanView;
        try { plan = await bridge.planCharacterCardUpdate!(target.id, content); }
        catch (error) { throw new AgentToolError('invalid_input', error instanceof Error && error.message ? error.message.slice(0, 200) : '角色卡文件无法读取。'); }
        // I-173: with the user's words for the file's voice, the plan shows it taken ('replaced'), as the 角色页 does after its tick.
        if (request.useFileVoice && plan.summary.voice === 'offered') plan = { ...plan, summary: { ...plan.summary, voice: 'replaced' } };
        if (plan.summary.unchanged) throw unavailable(`文件里的人设和「${target.name}」现在的一模一样，不需要更新。`);
        return { ...request, content, id: plan.id, name: target.name, plan };
      },
      confirmLoaded: (request: CardUpdateRequest) => ({
        title: request.plan!.summary.name.changed ? `${ASSISTANT_NAME} 请求用角色卡文件更新一个角色（名字不一样，请看清）` : `${ASSISTANT_NAME} 请求用角色卡文件更新一个角色`,
        detail: [`要更新的角色：${request.name}（原地更新，还是同一个她）`, `文件：${request.facts.name}`, `位置：${request.facts.directory}`, '',
          ...cardUpdateSummaryLines(request.plan!.summary).map(line => (line.warning ? '⚠ ' : '') + line.text),
          ...(request.useFileVoice ? [request.plan!.summary.voice === 'replaced' ? '声音也换成文件里的（你在对话里要求的）；不允许就什么都不改。' : '你要求换成文件里的声音，但文件里没有别的声音，她的声音不变。'] : [])].join('\n'),
      }),
      noticeDetail: (request: CardUpdateRequest) => `「${request.name}」，用 ${request.facts.name}（更新前已备份）`,
      run: async (request: CardUpdateRequest, context: AgentCallContext) => {
        if (request.content === undefined || !request.plan) throw unavailable('文件还没有在允许后读取，什么都没改。');
        // The content in hand is the one read once after the OK and shown as the plan; it is what is written. A file changed
        // (size or time) while the plan was shown is still refused (the user may have meant the new one).
        await assertUnchanged(request.facts, fs);
        const takeVoice = request.useFileVoice === true && request.plan.summary.voice === 'replaced';
        const outcome = takeVoice ? await bridge.updateCharacterCard!(request.id, request.content, request.plan.expected, context.check, { useFileVoice: true })
          : await bridge.updateCharacterCard!(request.id, request.content, request.plan.expected, context.check);
        const updated = outcome.state.cards.find(item => item.id === request.id);
        return { updated: { id: request.id, name: updated?.name ?? null }, nameChanged: outcome.summary.name.changed,
          changedFields: outcome.summary.changedFields, mood: outcome.summary.mood, slowWarmUp: outcome.summary.slowWarmUp.after, language: outcome.summary.language,
          sleepHabit: outcome.summary.sleepHabit, voice: outcome.summary.voice === 'replaced' ? '换成了文件里的声音' : outcome.summary.voice === 'offered' ? '保留了她现在的声音（文件里带了另一个；用户原话要求时可以带 useFileVoice: true）' : '没变',
          response: outcome.summary.response, kept: '还是同一个角色：聊天、日记、画像、熟悉度和昵称、模型和头像都保留。',
          backup: '更新前已把角色卡存档备份在配置目录里（characters.before-update-…json）。', notice: outcome.notice ?? null };
      },
    },
    {
      name: 'bind_current_model_to_character', title: title('bind_current_model_to_character'), tier: 'confirm',
      validate: raw => ({ id: cardId(argsObject(raw, ['id']).id) }),
      prepare: (input: { id: string }) => {
        const target = card(input.id), model = bridge.settings().model;
        if (!model) throw unavailable('请先载入一个 MMD 模型。');
        return { id: target.id, name: target.name, modelName: model.name, modelPath: model.path };
      },
      confirmation: (target: { name: string; modelName: string }) => ({
        title: `${ASSISTANT_NAME} 请求把当前模型关联到角色`,
        detail: `角色：${target.name}\n模型：${target.modelName}\n\n以后切换到这个角色时会自动载入这个模型。`,
      }),
      noticeDetail: (target: { name: string; modelName: string }) => `「${target.modelName}」→「${target.name}」`,
      run: async (target: { id: string; name: string; modelPath: string }, context: AgentCallContext) => {
        // A model changed while the dialog was open must not be bound under the old confirmation.
        if (bridge.settings().model?.path !== target.modelPath) throw unavailable('当前模型在确认之后变了，已取消。');
        targetCardStill(target);
        await bridge.bindCurrentModel(target.id, context.check);
        const bound = bridge.characters().cards.find(item => item.id === target.id);
        return { id: target.id, modelName: bound?.modelName ?? null };
      },
    },
    {
      // I-025 第 3 段: 「解除关联」 in the card editor.
      name: 'unbind_character_model', title: title('unbind_character_model'), tier: 'reversible',
      validate: raw => ({ id: cardId(argsObject(raw, ['id']).id) }),
      prepare: (input: { id: string }) => {
        if (!bridge.unbindCharacterModel) throw unavailable('这个版本还不能这样解除关联。');
        const target = card(input.id);
        if (!target.modelName) throw unavailable(`「${target.name}」没有关联模型。`);
        return { id: target.id, name: target.name, modelName: target.modelName };
      },
      noticeDetail: (target: { name: string; modelName: string }) => `「${target.name}」不再自动载入「${target.modelName}」`,
      run: async (target: { id: string; name: string; modelName: string }, context: AgentCallContext) => {
        const loaded = bridge.settings().model;
        await bridge.unbindCharacterModel!(target.id, context.check);
        // 撤回 (2026-11-07): the app only knows how to bind the model that is loaded now, so the undo is offered when that is still the model the
        // character was tied to (the usual case: unbinding leaves it loaded) and it is the same file when the undo runs.
        if (loaded && loaded.name === target.modelName) context.offerUndo({ label: `把「${target.name}」重新关联到「${target.modelName}」`, run: async guard => {
          if (bridge.settings().model?.path !== loaded.path) throw unavailable('现在载入的模型已经不是原来的那个，没有撤回；先载入原来的模型，再用“关联当前模型”。');
          if (card(target.id).modelName) throw unavailable(`「${target.name}」已经关联了模型，没有撤回。`);
          await bridge.bindCurrentModel(target.id, guard);
        } });
        return { id: target.id, name: target.name, unbound: target.modelName };
      },
    },
    {
      // I-173: the 角色页's 「更多 → 删除」 for the user's own Claude, by the rules of deleting memories: into the recycle bin
      // (never for good; restore_memories or undo_last_action brings her back), the user's words AND the dialog they click (alwaysConfirm),
      // only with 三方互通 on, never the character who is with the user now (switch first), never the last card.
      name: 'delete_character', title: title('delete_character'), tier: 'confirm', interconnectOnly: true, alwaysConfirm: true,
      validate: raw => {
        const args = argsObject(raw, ['id', 'forgetMemories']);
        if (args.forgetMemories !== undefined && typeof args.forgetMemories !== 'boolean') throw new AgentToolError('invalid_input', 'forgetMemories 只能是 true 或 false（不给就是 false：只删角色卡，她的记忆留着）。');
        return { id: cardId(args.id), forgetMemories: args.forgetMemories === true };
      },
      prepare: (input: { id: string; forgetMemories: boolean }) => {
        if (!bridge.deleteCharacter) throw unavailable('这个版本还不能通过通道删除角色卡；可以用 open_control_page {"item": "character_delete"} 带用户去角色卡片自己删。');
        const state = bridge.characters(), target = card(input.id);
        refuseDeleting(state, target);
        return { id: target.id, name: target.name, forgetMemories: input.forgetMemories };
      },
      confirmation: (target: CharacterDeleteRequest) => ({ title: `${ASSISTANT_NAME} 请求删除角色「${target.name}」`, detail: characterDeleteDetail(target, bridge.memories?.days() ?? 7) }),
      wordsItem: (target: CharacterDeleteRequest) => ({ item: 'delete_character', value: target.forgetMemories ? 'card+memories' : 'card' }),
      noticeDetail: (target: CharacterDeleteRequest) => `「${target.name}」${target.forgetMemories ? '连同她的记忆' : ''}进了回收站（${bridge.memories?.days() ?? 7} 天内可找回）`,
      run: async (target: CharacterDeleteRequest, context: AgentCallContext) => {
        targetCardStill(target);
        refuseDeleting(bridge.characters(), target); // the active card or the card count may have changed while the dialog was open
        const before = new Set((bridge.memories?.list() ?? []).map(entry => entry.id));
        const state = await bridge.deleteCharacter!(target.id, target.forgetMemories, context.check);
        const entry = (bridge.memories?.list() ?? []).find(item => !before.has(item.id) && item.characterId === target.id);
        if (entry && bridge.memories) { const memories = bridge.memories; context.offerUndo({ label: `把「${target.name}」从回收站找回来`, run: async guard => { await memories.restore(entry.id, guard); } }); }
        return { deleted: { id: target.id, name: target.name }, forgetMemories: target.forgetMemories, count: state.cards.length, notice: state.notice ?? null,
          recycled: entry ? { entryId: entry.id, expiresAt: new Date(entry.expiresAt).toISOString() } : null,
          note: `没有永久删除：在回收站里留 ${bridge.memories?.days() ?? 7} 天，期间可以用 restore_memories（或 undo_last_action）完整找回，到期才清理。`
            + (target.forgetMemories ? '' : '她的聊天记忆、日记和画像都还留着。') };
      },
    },
    {
      // I-025 第 3 段: 「新增角色 → 用现在的模型」 on the character page.
      name: 'create_character_for_current_model', title: title('create_character_for_current_model'), tier: 'reversible', validate: noArgs,
      prepare: () => {
        if (!bridge.createCharacterForCurrentModel) throw unavailable('这个版本还不能这样新建角色。');
        const model = bridge.settings().model;
        if (!model) throw unavailable('请先载入一个模型。');
        return model.name;
      },
      noticeDetail: (model: string) => `用「${model}」新建了一个角色`,
      run: async (_model: string, context: AgentCallContext) => {
        const before = new Set(bridge.characters().cards.map(item => item.id));
        const state = await bridge.createCharacterForCurrentModel!(context.check);
        const added = state.cards.find(item => !before.has(item.id));
        return { created: added ? { id: added.id, name: added.name } : null, activeId: state.activeId,
          note: '没有换到新角色；要换就用 activate_character。人设可以用 update_character_card 填。' };
      },
    },
  ];
}
