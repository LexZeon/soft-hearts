// The companion, its window and its model on the internal channel (docs/claude/2026-11-17-app-tools-split.md): show_pet, recover_pet,
// open_control_page, load_model (a file: always the dialog), use_bundled_model, play_preview, the model check (list / set / try
// model capability) and play_her_action (one of her seven small actions).
import { TAKE_ME_THERE } from '../../../../shared/initiative';
import { controlPageRequest, type ControlPageRequest } from './control-page';
import { MODEL_CAPABILITY_IDS, deriveModelCapabilities, type CapabilityChoice, type ModelCapabilityId } from '../../../../shared/stage';
import { CAPABILITY_LABELS, type ModelCapabilityView } from '../../../../shared/stage';
import { approximateActions, fingerReasonWords, fingerWords, missingActionGroups, modelAdaptation, partWords } from '../../../../shared/brain';
import { HER_ACTIONS } from '../../../../shared/actions';
import { CHAT_ACTION_WORDS, type ChatActionWord } from '../../../../shared/brain';
import type { ChannelActionResult } from '../../../brain';
import { AgentToolError, type AgentCallContext, type AgentToolDefinition } from '../registry';
import { argsObject, assertUnchanged, inspectLocalFile, localFilePath, noArgs, oneOf, type FileFacts } from '../validate';
import { title, unavailable, type ToolContext } from './common';
import { MODEL_FILE_EXTENSIONS } from '../../../../shared/foundation/model-format';
import { ASSISTANT_NAME } from '../../../../shared/foundation/assistant-name';

/** I-024: the table the character page shows, for the channel: ids, labels and states only (no part names, no paths). */
function modelCapabilityFacts(view: ModelCapabilityView) {
  const card = deriveModelCapabilities(view.profile, view.record?.choices ?? {}, view.record?.haiku ?? {});
  return {
    model: view.modelKey ? 'loaded' : 'none',
    checked: view.record?.checkedAt ? new Date(view.record.checkedAt).toISOString() : null,
    items: MODEL_CAPABILITY_IDS.map(id => ({ id, label: CAPABILITY_LABELS[id], has: card[id].detected, foundBy: card[id].source,
      choice: card[id].choice ?? 'auto', on: card[id].enabled, missing: [...card[id].missing] })),
    // T-213: her actions on this model by the stage's own pre-play rule, in standard part words (never the model's own names).
    actions: (() => {
      const adaptation = modelAdaptation(view.profile, view.record?.haiku ?? {});
      return { total: HER_ACTIONS.length, possible: HER_ACTIONS.filter(id => adaptation.actions[id].ok).length, cannot: missingActionGroups(adaptation),
        // Skeleton step 2: done as an approximation (a face shape it lacks, built from its own near ones), as the character page says.
        approximate: approximateActions(adaptation).map(row => `${row.action}：没有${row.part}，用${row.using.join('、')}${row.lighter ? '拼的，会轻一点' : '代替'}`),
        fingersLeftOut: adaptation.fingerIssues.map(issue => `${fingerWords(issue.finger)}：${fingerReasonWords(issue.reason)}`),
        skeleton: adaptation.structure.map(row => `${partWords(row.bone)}接在${partWords(row.actual)}下（标准是${partWords(row.expected)}下）`) };
    })(),
    note: view.profile ? 'choice: auto 跟着有没有走；on/off 是用户在角色页（或通过 set_model_capability）选的。actions 是按骨骼结构的检查；真正做时还会核对动作轨，适配检查也可能跳过。'
      : '这个模型还没有档案（第一次载入时生成），所以都算没有。',
  };
}
const CHAT_ACTION_NOTICE: Readonly<Record<ChatActionWord, string>> = Object.freeze({
  wave: '让她打招呼', nod: '让她点头', tilt: '让她歪头', heart: '让她比心', clap: '让她鼓掌', wink: '让她眨一只眼', pout: '让她撅嘴' });

export function stageTools(context: ToolContext): AgentToolDefinition<any, any>[] {
  const { bridge, fs, platform, rendererAction, controlsReady, card } = context;
  return [
    {
      name: 'play_preview', title: title('play_preview'), tier: 'reversible',
      validate: raw => oneOf(argsObject(raw, ['kind']).kind, ['surprise', 'shy'] as const, 'kind '),
      prepare: (kind: 'surprise' | 'shy') => { controlsReady(true); return kind; },
      run: (kind: 'surprise' | 'shy', context: AgentCallContext) => {
        if (!rendererAction({ kind: 'play-preview', recipe: kind }, context)) throw unavailable('控制窗口尚未就绪。');
        return { requested: true, kind, note: '已请求控制窗口播放；结果显示在模型预览下方。' };
      },
    },
    {
      // I-024 这个模型能做什么 (the character page's table, the same host operations).
      name: 'list_model_capabilities', title: title('list_model_capabilities'), tier: 'read', validate: noArgs,
      run: async () => {
        if (!bridge.modelCapabilities) throw unavailable('这个版本还没有模型体检。');
        return modelCapabilityFacts(await bridge.modelCapabilities());
      },
    },
    {
      name: 'set_model_capability', title: title('set_model_capability'), tier: 'reversible',
      validate: raw => { const args = argsObject(raw, ['id', 'value']);
        return { id: oneOf(args.id, MODEL_CAPABILITY_IDS, 'id '), value: oneOf(args.value, ['on', 'off'] as const, 'value ') }; },
      prepare: async (input: { id: ModelCapabilityId; value: 'on' | 'off' }) => {
        if (!bridge.modelCapabilities || !bridge.setModelCapabilityChoice) throw unavailable('这个版本还不能这样开关。');
        const view = await bridge.modelCapabilities();
        if (!view.modelKey) throw unavailable('请先载入一个模型。');
        const label = CAPABILITY_LABELS[input.id];
        const card = deriveModelCapabilities(view.profile, view.record?.choices ?? {}, view.record?.haiku ?? {});
        if (input.value === 'on' && !card[input.id].detected) throw unavailable(`这个模型没有「${label}」需要的部位，打不开。`);
        return { ...input, label, modelKey: view.modelKey, previous: (view.record?.choices?.[input.id] ?? null) as CapabilityChoice };
      },
      noticeDetail: (target: { label: string; value: 'on' | 'off' }) => `${target.value === 'on' ? '打开' : '关掉'}了「${target.label}」（只对现在这个模型）`,
      run: async (target: { id: ModelCapabilityId; value: 'on' | 'off'; label: string; modelKey: string; previous: CapabilityChoice }, context: AgentCallContext) => {
        await bridge.setModelCapabilityChoice!(target.modelKey, target.id, target.value, context.check);
        if (target.previous !== target.value) context.offerUndo({ label: `把「${target.label}」改回原来的样子`, run: async guard => {
          const now = await bridge.modelCapabilities!();
          if (now.modelKey !== target.modelKey) throw unavailable('模型之后换过了，没有撤回。');
          if ((now.record?.choices?.[target.id] ?? null) !== target.value) throw unavailable(`「${target.label}」之后又改过了，没有撤回。`);
          await bridge.setModelCapabilityChoice!(target.modelKey, target.id, target.previous, guard);
        } });
        return { id: target.id, label: target.label, value: target.value, note: '只对现在这个模型；存在本机，不改模型文件。' };
      },
    },
    {
      name: 'try_model_capability', title: title('try_model_capability'), tier: 'reversible',
      validate: raw => oneOf(argsObject(raw, ['id']).id, MODEL_CAPABILITY_IDS, 'id '),
      prepare: (id: ModelCapabilityId) => {
        if (!bridge.previewModelCapability) throw unavailable('这个版本还不能试。');
        return id;
      },
      noticeDetail: (id: ModelCapabilityId) => `试了一下「${CAPABILITY_LABELS[id]}」`,
      run: async (id: ModelCapabilityId, context: AgentCallContext) => {
        const result = await bridge.previewModelCapability!(id, context.check);
        const note = result === 'shown' ? '桌宠上演了一次，演完回到原样。' : result === 'pet-hidden' ? '桌宠没在显示，先 show_pet 再试。'
          : '没演：这个模型做不了、这一项关着，或者她正忙着别的（先用 list_model_capabilities 看）。';
        return { id, label: CAPABILITY_LABELS[id], result, note };
      },
    },
    {
      // 通用骨架第 5 步 · 通道: the seven small actions she may pick in a reply, for the user's own Claude. A show,
      // not a setting: reversible, no privacy effect, no dialog (like try_model_capability). It cannot speak or change anything.
      name: 'play_her_action', title: title('play_her_action'), tier: 'reversible',
      validate: raw => oneOf(argsObject(raw, ['action']).action, CHAT_ACTION_WORDS, 'action '),
      prepare: (word: ChatActionWord) => {
        if (!bridge.playChatAction) throw unavailable('这个版本还不能让她做小动作。');
        return word;
      },
      noticeDetail: (word: ChatActionWord) => CHAT_ACTION_NOTICE[word],
      run: async (word: ChatActionWord, context: AgentCallContext) => {
        let result: ChannelActionResult;
        try { result = await bridge.playChatAction!(word, context.check); }
        catch (error) { throw error instanceof AgentToolError ? error : unavailable('控制窗口尚未就绪，或这个版本还不能让她做小动作。'); }
        return { action: word, played: result.played, status: result.status, ...(result.missing.length ? { missing: result.missing } : {}),
          note: result.played ? '她做了一次。' : `没做：${result.reason}` };
      },
    },
    {
      name: 'show_pet', title: title('show_pet'), tier: 'reversible', validate: noArgs,
      run: async (_input: unknown, context: AgentCallContext) => {
        const wasVisible = bridge.settings().pet.visible;
        await bridge.setPetVisible(true, context.check);
        if (!wasVisible) context.offerUndo({ label: '再把桌宠藏起来', run: async guard => {
          if (!bridge.settings().pet.visible) throw unavailable('桌宠已经藏起来了。');
          await bridge.setPetVisible(false, guard);
        } });
        return { petVisibleSetting: bridge.settings().pet.visible, pet: bridge.windows().pet };
      },
    },
    {
      // I-065: take the user to a page of the control window, the same move as her 「带我去」 (I-051). Navigation only.
      // I-173: or an item of the handbook (its page, and the element there flashes); a card id opens that card's 「更多」 (deleting).
      name: 'open_control_page', title: title('open_control_page'), tier: 'reversible',
      validate: raw => controlPageRequest(raw),
      prepare: (request: ControlPageRequest) => {
        const character = request.focus?.character ? card(request.focus.character) : null; // a card that does not exist is refused before anything opens
        return character ? { ...request, characterName: character.name } : request;
      },
      noticeDetail: (request: ControlPageRequest) => request.item ? `带你去「${request.item.label}」` : `带你去「${TAKE_ME_THERE[request.page].title}」`,
      run: async (request: ControlPageRequest & { characterName?: string }, context: AgentCallContext) => {
        if (!bridge.openControlPage) throw unavailable('这个版本还不能这样打开控制窗口的某一页。');
        if (request.focus) await bridge.openControlPage(request.page, context.check, request.focus);
        else await bridge.openControlPage(request.page, context.check);
        return { opened: request.page, title: TAKE_ME_THERE[request.page].title, ...(request.item ? { item: request.item.id, label: request.item.label } : {}),
          ...(request.characterName ? { character: request.characterName } : {}),
          note: '只打开了这一页，没有改任何设置。' + (request.focus?.anchor ? '那一项会闪一下。' : '') + (request.characterName ? `「${request.characterName}」的「更多」菜单已经打开，删除在里面，要用户自己点。` : '') };
      },
    },
    {
      name: 'load_model', title: title('load_model'), tier: 'confirm', touchesFiles: true, alwaysConfirm: true,
      validate: raw => localFilePath(argsObject(raw, ['path']).path, MODEL_FILE_EXTENSIONS, platform), // .pmx .pmd .vrm (I-152)
      // X-435: before the OK only the path checks and the file's stat; nothing of the model is read (no fingerprint either). After
      // the OK its size and time are checked and the path is handed on to the loader, which reads it (and its textures) itself.
      prepare: (file: string) => inspectLocalFile(file, MODEL_FILE_EXTENSIONS, 1024 * 1024 * 1024, fs, platform),
      confirmation: (facts: FileFacts) => ({
        title: `${ASSISTANT_NAME} 请求载入一个模型（MMD 或 VRM）`,
        detail: `文件：${facts.name}\n位置：${facts.directory}\n\n载入后会替换当前模型，并清除当前动作；贴图从同一目录读取，原文件不会被修改。`,
      }),
      noticeDetail: (facts: FileFacts) => facts.name,
      run: async (facts: FileFacts, context: AgentCallContext) => {
        await assertUnchanged(facts, fs);
        // I-014: the model it replaces is remembered, so 撤回 can load it again (the original files are never changed).
        const previous = bridge.settings().model;
        const loaded = await bridge.loadModel(facts.file, context.check);
        const now = bridge.settings().model;
        if (previous && now && previous.path !== now.path) context.offerUndo({ label: `换回模型「${previous.name}」`, run: async guard => {
          if (bridge.settings().model?.path !== now.path) throw unavailable('模型之后又换过了，没有撤回。');
          await bridge.loadModel(previous.path, guard);
        } });
        return { model: { name: loaded.name }, ...(previous ? { previousModel: { name: previous.name } } : {}) };
      },
    },
    {
      // I-025 第 3 段: the control window's 「一键恢复桌宠」.
      name: 'recover_pet', title: title('recover_pet'), tier: 'reversible', validate: noArgs,
      prepare: () => { if (!bridge.recoverPet) throw unavailable('这个版本还不能这样恢复桌宠。'); return null; },
      run: async (_input: unknown, context: AgentCallContext) => {
        await bridge.recoverPet!(context.check);
        return { recovered: true, note: '桌宠已居中显示，恢复默认大小和镜头；模型和连接没变。' };
      },
    },
    {
      // I-025 第 3 段: 「使用预装 Gene」 (replaces the model, like load_model; 撤回 loads the previous one again).
      name: 'use_bundled_model', title: title('use_bundled_model'), tier: 'confirm', validate: noArgs,
      // T-239: the dialog names the model it replaces; a different model loaded meanwhile is not replaced under that OK.
      prepare: (): { name: string | null; path: string | null } => {
        if (!bridge.useBundledModel) throw unavailable('这个版本还不能这样换回预装模型。');
        const model = bridge.settings().model;
        return { name: model?.name ?? null, path: model?.path ?? null };
      },
      confirmation: (shown: { name: string | null }) => ({ title: `${ASSISTANT_NAME} 请求换回预装的 Gene 模型`,
        detail: `${shown.name ? `现在的模型：${shown.name}
` : ''}换回后会清除当前动作；原来的模型文件不会被修改，可以撤回。` }),
      noticeDetail: () => '换回预装 Gene',
      run: async (shown: { name: string | null; path: string | null }, context: AgentCallContext) => {
        if ((bridge.settings().model?.path ?? null) !== shown.path) throw unavailable('当前模型在确认之后变了，已取消；需要的话请重新请求。');
        const previous = bridge.settings().model;
        await bridge.useBundledModel!(context.check);
        const now = bridge.settings().model;
        if (previous && now && previous.path !== now.path) context.offerUndo({ label: `换回模型「${previous.name}」`, run: async guard => {
          if (bridge.settings().model?.path !== now.path) throw unavailable('模型之后又换过了，没有撤回。');
          await bridge.loadModel(previous.path, guard);
        } });
        return { model: now ? { name: now.name } : null, ...(previous ? { previousModel: { name: previous.name } } : {}) };
      },
    },
  ];
}
