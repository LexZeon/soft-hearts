// Voice tools of the internal channel (docs/claude/2026-11-17-app-tools-split.md): set_read_aloud, set_voice_style (Bailian's model,
// this character + model's voice and style, Drama 3's voice id and acting style), set_character_voice (2026-11-24: any character's own
// provider, the 「她的声音」 choice; a paid one is spending), voice_preview (a paid voice is spending: the dialog even with the user's
// words). Keys never cross the channel: only whether one is saved. What paid voices cost and read as: ./voice-spend.ts.
import type { AppSettings } from '../../../../shared/foundation/settings';
import type { CharacterCardState } from '../../../../shared/foundation/character-card';
import type { CharacterVoice } from '../../../../shared/foundation/character-voice';
import { FISH_ACTING_STYLE_MAX, cleanFishActingStyle } from '../../../../shared/voice';
import { DEFAULT_TTS_CONFIG, TTS_EMOTIONS, effectiveTtsConfig, resolveStyleBinding, type TtsConfig, type TtsEmotion } from '../../../../shared/voice';
import { cleanVoiceId, normalizeCharacterVoice } from '../../../../shared/foundation/character-voice';
import type { AgentCallContext, AgentToolDefinition } from '../registry';
import { argsObject, cardId, noArgs, oneOf } from '../validate';
import { title, unavailable, invalidInput, type ToolContext } from './common';
import { type PaidVoice, PROVIDER_LABEL, paidVoice } from './setting-values';
import {
  characterVoiceConfirmation, characterVoiceRequest, characterVoiceRows, characterVoiceSpends, drama3View, isPaidProvider, type CharacterVoiceChoice, type CharacterVoiceRequest,
} from './voice-spend';
import { ASSISTANT_NAME } from '../../../../shared/foundation/assistant-name';

const CHARACTER_VOICE_CHOICES: readonly CharacterVoiceChoice[] = ['system', 'bailian', 'fish', 'default'];
/**
 * set_character_voice's arguments: a card, a provider and, optionally, that provider's voice id (in that provider's own shape). Strict: a key,
 * an address or a region is an unknown argument and refused (2026-11-24; "a key or an address becomes settable" is a mutation check).
 */
export function characterVoiceArgs(raw: unknown): { id: string; provider: CharacterVoiceChoice; voiceId?: string } {
  const args = argsObject(raw, ['id', 'provider', 'voiceId']);
  const id = cardId(args.id), provider = oneOf(args.provider, CHARACTER_VOICE_CHOICES, 'provider ');
  if (args.voiceId === undefined) return { id, provider };
  if (provider === 'default') throw invalidInput('provider 是 default 时不用给 voiceId：她会跟随新角色的默认声音。');
  const voiceId = typeof args.voiceId === 'string' ? args.voiceId.trim() : null;
  if (voiceId === null || (voiceId && !cleanVoiceId(provider, voiceId)))
    throw invalidInput(provider === 'fish' ? 'Drama 3 的 voiceId 只接受字母、数字、- 和 _，最多 128 个字符。'
      : provider === 'bailian' ? '百炼的 voiceId 是音色 id（字母、数字和 _ . : -），比如 longanhuan_v3.1。' : '系统声音的 voiceId 是声音的名字，不能是路径或链接。');
  return { id, provider, voiceId: voiceId ? cleanVoiceId(provider, voiceId) : '' };
}

// I-065: Bailian's model (shared by every character) and this character + model's voice, emotion, style text
// and rate, written exactly as the control window's 「百炼语音」 saves them (src/main.ts emotionalVoiceControls onChange). The key,
// the API host and the region are never read or written here.
// I-070: plus Drama 3's fixed voice (`voiceId`, Fish's reference_id; '' = its default voice). Drama 3's key and monthly limit
// are never read or written here either; the rate is the same slider for both.
// I-070 step 2: Drama 3's voice id and acting style belong to this character + model (the global voice id is only the fallback).
export interface VoiceStyle { model: string; voice: string; emotion: TtsEmotion; instruction: string; rate: number; voiceId: string; actingStyle: string;
  /** I-091: this character's own read-aloud provider; '' = follows the global one. Through the channel only '' or 'system' can be set (a paid one is chosen in the control window). */
  provider: '' | 'system' | 'bailian' | 'fish' }
export type VoiceStylePatch = Partial<VoiceStyle>;
const VOICE_STYLE_ID = /^[A-Za-z0-9._-]{1,120}$/u;
const FISH_VOICE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
export function voiceStyleArgs(raw: unknown): VoiceStylePatch {
  const args = argsObject(raw, ['model', 'voice', 'emotion', 'instruction', 'rate', 'voiceId', 'actingStyle', 'provider']);
  const out: VoiceStylePatch = {};
  if (args.provider !== undefined) {
    // I-091: a paid voice for one character costs money like the global switch does, and set_voice_style is the free tier, so only
    // "follow the global one" and the free system voice can be set here. The paid ones: the control window, or set_setting voice_provider.
    if (args.provider === 'bailian' || args.provider === 'fish')
      throw invalidInput('这个角色改用百炼或 Drama 3 会花钱：用 set_character_voice（要用户原话，会弹窗），或请用户自己在控制窗口「角色」页的「她的声音」里选（可以用 open_control_page {"item": "character_voice"} 带过去）；她自己已经选了 Drama 3 时，voiceId 会一起填进「她的声音」；要改新角色的默认声音用 set_setting 的 voice_provider（要用户原话，会弹窗）。');
    if (args.provider !== 'follow' && args.provider !== 'system') throw invalidInput('provider 只接受 follow（跟随全局）或 system（系统语音）。');
    out.provider = args.provider === 'follow' ? '' : 'system';
  }
  if (args.voiceId !== undefined) {
    if (typeof args.voiceId !== 'string' || (args.voiceId !== '' && !FISH_VOICE_ID.test(args.voiceId)))
      throw invalidInput('voiceId 只接受字母、数字、- 和 _，最多 128 个字符；空字符串表示用 Drama 3 自带的声音。');
    out.voiceId = args.voiceId;
  }
  if (args.actingStyle !== undefined) {
    if (typeof args.actingStyle !== 'string' || Array.from(args.actingStyle).length > FISH_ACTING_STYLE_MAX)
      throw invalidInput(`actingStyle 是不超过 ${FISH_ACTING_STYLE_MAX} 字的文字（中文、英文、日文都可以，空字符串表示不加）。`);
    out.actingStyle = cleanFishActingStyle(args.actingStyle);
  }
  for (const key of ['model', 'voice'] as const) if (args[key] !== undefined) {
    if (typeof args[key] !== 'string' || !VOICE_STYLE_ID.test(args[key] as string)) throw invalidInput(`${key} 只接受字母、数字和 . _ -，最多 120 个字符。`);
    out[key] = args[key] as string;
  }
  if (args.emotion !== undefined) out.emotion = oneOf(args.emotion, TTS_EMOTIONS.map(item => item.id), 'emotion ');
  if (args.instruction !== undefined) {
    if (typeof args.instruction !== 'string' || args.instruction.length > 1000 || CONTROL_CHARS.test(args.instruction)) throw invalidInput('instruction 是不超过 1000 字的文字。');
    out.instruction = args.instruction.trim();
  }
  if (args.rate !== undefined) {
    if (typeof args.rate !== 'number' || !Number.isFinite(args.rate) || args.rate < 0.5 || args.rate > 2) throw invalidInput('rate 只接受 0.5 到 2。');
    out.rate = Math.round(args.rate * 100) / 100;
  }
  if (!Object.keys(out).length) throw invalidInput('至少给一项：model、voice、emotion、instruction、rate、voiceId、actingStyle 或 provider。');
  return out;
}
const voiceContextOf = (settings: AppSettings, characterId: string) => ({ characterId, modelPath: settings.model?.path ?? '' });
export function voiceStyleOf(settings: AppSettings, characterId: string): VoiceStyle {
  const tts = (settings.tts ?? DEFAULT_TTS_CONFIG) as TtsConfig, { modelPath } = voiceContextOf(settings, characterId);
  const style = characterId && modelPath ? effectiveTtsConfig(tts, characterId, modelPath) : tts;
  return { model: tts.model, voice: style.voice, emotion: style.emotion, instruction: style.instruction, rate: style.rate,
    voiceId: style.fishVoiceId ?? '', actingStyle: style.fishActingStyle ?? '', provider: style.ownProvider ?? '' };
}
export function withVoiceStyle(settings: AppSettings, characterId: string, patch: VoiceStylePatch): AppSettings {
  const tts = structuredClone((settings.tts ?? DEFAULT_TTS_CONFIG) as TtsConfig), { modelPath } = voiceContextOf(settings, characterId);
  const { model, voice, emotion, instruction, rate, voiceId, actingStyle, provider } = { ...voiceStyleOf(settings, characterId), ...patch };
  const next: TtsConfig = { ...tts, model };
  if (characterId && modelPath) {
    // The Drama 3 fields are written into the binding only when this call sets them or the binding already has them: a Bailian-only
    // change leaves the binding exactly as before, and the global voice id stays the fallback for a character that never set one.
    const own = resolveStyleBinding(tts, characterId, modelPath); // 2026-11-19: another model's binding is the base for the new one
    const fish = {
      ...(patch.voiceId !== undefined ? { fishVoiceId: voiceId } : own?.fishVoiceId !== undefined ? { fishVoiceId: own.fishVoiceId } : {}),
      ...(patch.actingStyle !== undefined ? (actingStyle ? { fishActingStyle: actingStyle } : {}) : own?.fishActingStyle ? { fishActingStyle: own.fishActingStyle } : {}),
    };
    next.styleBindings = [
      ...(tts.styleBindings ?? []).filter(binding => binding.characterId !== characterId || binding.modelPath !== modelPath),
      { characterId, modelPath, voice, instruction, emotion, rate, ...fish, ...(provider ? { provider } : {}) },
    ].slice(-64);
  } else {
    Object.assign(next, { voice, instruction, emotion, rate, fishVoiceId: voiceId });
    if (actingStyle) next.fishActingStyle = actingStyle; else delete next.fishActingStyle;
  }
  return { ...settings, tts: next };
}
/** I-173: her own voice on her card when it is Drama 3 (the 「角色」页「她的声音」 the resolver reads first), else null. */
function ownDrama3Voice(state: CharacterCardState, characterId: string): CharacterVoice | null {
  const voice = characterId ? state.cards.find(item => item.id === characterId)?.voice : undefined;
  return voice?.provider === 'fish' ? structuredClone(voice) : null;
}
const PREVIEW_LINE ='你好，我会在这里，陪你度过平常的一天。';
const PREVIEW_DETAIL: Readonly<Record<PaidVoice, string>> = { system: '语音方案：系统声音（免费）。', bailian: '语音方案：百炼。会用你的百炼账号产生一次付费调用。',
  fish: '语音方案：Drama 3。会用你的 Fish Audio 账号产生一次付费调用（这一句约几十个字节，计入本月上限）。' };
const PREVIEW_NOTICE: Readonly<Record<PaidVoice, string>> = { system: '系统声音（免费）', bailian: '百炼（一次付费调用）', fish: 'Drama 3（一次付费调用）' };

export function voiceTools(context: ToolContext): AgentToolDefinition<any, any>[] {
  const { bridge, setReadAloud, activeId, rendererAction, controlsReady, card, targetCardStill, readBudget, now } = context;
  const ownVoiceOf = (id: string) => normalizeCharacterVoice((bridge.characters().cards.find(item => item.id === id) as { voice?: unknown } | undefined)?.voice) ?? null;
  const voiceName = (request: Pick<CharacterVoiceRequest, 'next' | 'provider'>) =>
    request.next ? PROVIDER_LABEL[request.provider] : `跟随新角色的默认声音（${PROVIDER_LABEL[request.provider]}）`;
  return [
    {
      name: 'set_read_aloud', title: title('set_read_aloud'), tier: 'reversible',
      validate: raw => oneOf(argsObject(raw, ['state']).state, ['on', 'off'] as const, 'state '),
      run: async (state: 'on' | 'off', context: AgentCallContext) => {
        const previous = bridge.settings().voice.enabled;
        const readAloud = await setReadAloud(state === 'on', context.check);
        if (readAloud !== previous) context.offerUndo({ label: previous ? '重新打开朗读' : '关掉朗读', run: async guard => {
          if (bridge.settings().voice.enabled !== readAloud) throw unavailable('朗读之后又改过了，没有撤回。');
          await setReadAloud(previous, guard);
        } });
        return { readAloud };
      },
    },
    {
      // I-065: Bailian's model and this character + model's voice and style, saved as the control window saves them.
      name: 'set_voice_style', title: title('set_voice_style'), tier: 'reversible',
      validate: raw => voiceStyleArgs(raw),
      run: async (patch: VoiceStylePatch, context: AgentCallContext) => {
        const characterId = activeId(), before = bridge.settings();
        const previous = voiceStyleOf(before, characterId);
        await bridge.saveSettings(withVoiceStyle(before, characterId, patch), context.check);
        const after = bridge.settings(), set = voiceStyleOf(after, characterId);
        // I-173: when her own voice (「角色」页「她的声音」) is already Drama 3, the id goes into her own voice too, so the
        // page and the channel name the same voice. No new spending decision (she is on Drama 3 by the user's own choice); no key touched.
        const own = ownDrama3Voice(bridge.characters(), characterId);
        const ownVoice = own && patch.voiceId && own.voiceId !== patch.voiceId && bridge.saveCharacterVoice
          ? await bridge.saveCharacterVoice(characterId, { ...own, voiceId: patch.voiceId }, context.check).then(() => ({ before: own, after: { ...own, voiceId: patch.voiceId! } }))
          : null;
        // Undo puts back only what this call changed, so a Bailian-only change never freezes the global voice id into the binding.
        const undoPatch = Object.fromEntries((Object.keys(set) as (keyof VoiceStyle)[]).filter(key => set[key] !== previous[key]).map(key => [key, previous[key]])) as VoiceStylePatch;
        if (JSON.stringify(set) !== JSON.stringify(previous) || ownVoice) context.offerUndo({ label: '把朗读声音的设置改回去', run: async guard => {
          const now = bridge.settings();
          if (activeId() !== characterId || JSON.stringify(voiceStyleOf(now, characterId)) !== JSON.stringify(set))
            throw unavailable('百炼的模型和音色之后又改过了，没有撤回。');
          if (ownVoice && JSON.stringify(ownDrama3Voice(bridge.characters(), characterId)) !== JSON.stringify(ownVoice.after))
            throw unavailable('「她的声音」之后又改过了，没有撤回。');
          if (Object.keys(undoPatch).length) await bridge.saveSettings(withVoiceStyle(now, characterId, undoPatch), guard);
          if (ownVoice) await bridge.saveCharacterVoice!(characterId, ownVoice.before, guard);
        } });
        const provider = paidVoice(after);
        return { previous, ...set, appliesTo: characterId && after.model?.path ? '当前角色和当前模型（模型 id 所有角色共用；Drama 3 的 voiceId 和 actingStyle 只属于当前角色，没设过的角色用全局的声音编号）' : '默认设置（还没有选定角色和模型）',
          ...(ownVoice ? { herOwnVoice: { provider: 'fish', voiceId: ownVoice.after.voiceId, note: '她自己的声音（「角色」页「她的声音」）是 Drama 3，这个声音编号也填进了那里。' } } : {}),
          provider, ownProvider: set.provider, note: provider !== 'system' || own ?'下一句朗读就用新设置；想先听一下可以用 voice_preview（会花一次钱，要用户原话）。'
            : '现在朗读用的是系统语音，这些设置先存着。要用百炼或 Drama 3，用户先在控制窗口自己填好 Key（可用 open_control_page 的 bailian-key 或 fish-key 带过去），再用 set_setting 把 voice_provider 改成 bailian 或 fish（会花钱，要用户原话）。' };
      },
    },
    {
      // 2026-11-24: the 角色页's 「她的声音」 provider, for any character (not only the active one), through the
      // page's own save. Tier: a paid result (Bailian or Drama 3, or 'default' while the default for new characters is paid) is spending:
      // the user's words AND the dialog with its price (tierFor + alwaysConfirmFor), and no undo (going back would be a spending decision
      // too). A free result is reversible: direct, with an undo while what it replaced was free. Keys, addresses and regions never cross.
      name: 'set_character_voice', title: title('set_character_voice'), tier: 'reversible', interconnectOnly: true,
      validate: characterVoiceArgs,
      prepare: (input: { id: string; provider: CharacterVoiceChoice; voiceId?: string }): CharacterVoiceRequest => {
        if (!bridge.saveCharacterVoice) throw unavailable('这个版本还不能通过通道换角色的声音；可以用 open_control_page {"item": "character_voice"} 带用户去「她的声音」自己选。');
        return characterVoiceRequest(bridge.settings(), bridge.characters(), card(input.id), input.provider, input.voiceId);
      },
      tierFor: (request: CharacterVoiceRequest) => characterVoiceSpends(request) ? 'confirm' : 'reversible',
      alwaysConfirmFor: (request: CharacterVoiceRequest) => characterVoiceSpends(request),
      confirmation: (request: CharacterVoiceRequest) => characterVoiceConfirmation(request, drama3View(bridge.settings(), readBudget(), now()), now()),
      noticeDetail: (request: CharacterVoiceRequest) => `「${request.name}」的声音：${voiceName(request)}`,
      wordsItem: (request: CharacterVoiceRequest) => ({ item: 'character_voice', value: request.next ? request.provider : 'default' }),
      run: async (request: CharacterVoiceRequest, context: AgentCallContext) => {
        targetCardStill(request);
        // T-239: only what was asked about (and shown in the dialog): her voice, and for 'default' the default provider, are as they were.
        if (JSON.stringify(ownVoiceOf(request.id)) !== JSON.stringify(request.before))
          throw unavailable(`确认期间「${request.name}」的声音变了，这次什么都没改；需要的话请重新请求。`);
        if (!request.next && paidVoice(bridge.settings()) !== request.provider)
          throw unavailable('确认期间「新角色的默认声音」变了，这次什么都没改；需要的话请重新请求。');
        if (request.changed) await bridge.saveCharacterVoice!(request.id, request.next, context.check);
        const written = ownVoiceOf(request.id);
        // 撤回 only back to a free voice, and never to "the default" once the default has become a paid one.
        if (request.changed && !isPaidProvider(request.previousProvider)) context.offerUndo({ label: `把「${request.name}」的声音改回原来的`, run: async guard => {
          if (JSON.stringify(ownVoiceOf(request.id)) !== JSON.stringify(written)) throw unavailable(`「${request.name}」的声音之后又改过了，没有撤回。`);
          if (!request.before && isPaidProvider(paidVoice(bridge.settings()))) throw unavailable('新角色的默认声音现在是付费的，改回去会花钱，没有撤回。');
          await bridge.saveCharacterVoice!(request.id, request.before, guard);
        } });
        const drama3 = drama3View(bridge.settings(), readBudget(), now());
        const row = characterVoiceRows(bridge.settings(), bridge.characters(), drama3).find(item => item.id === request.id);
        return { id: request.id, name: request.name, active: request.active, previous: request.before, voice: written, provider: request.provider,
          paid: isPaidProvider(request.provider), ...(request.changed ? {} : { unchanged: true }), speaksWith: row?.speaksWith ?? null, ...(row?.because ? { because: row.because } : {}),
          note: [request.changed ? '' : '她的声音本来就是这样，什么都没改。', request.ready ? '' : `${request.provider === 'fish' ? 'Drama 3 ' : '百炼'}的 Key 还没有填，填好之前她先用别的声音读；可以用 open_control_page（page: ${request.provider === 'fish' ? 'fish-key' : 'bailian-key'}）带用户去自己填（Key 不经过内部通道）。`,
            request.active ? '' : '她现在没在陪着用户，换到她时才会用这个声音。',
            isPaidProvider(request.provider) ? '以后她每读一句都会计费；改回免费的系统声音用 set_character_voice 的 provider system（不需要原话）。' : ''].filter(Boolean).join('') || undefined };
      },
    },
    {
      name: 'voice_preview', title: title('voice_preview'), tier: 'confirm', validate: noArgs,
      prepare: () => { controlsReady(false); return paidVoice(bridge.settings()); },
      // 敏感操作弹窗 (2026-11-12): a paid voice's preview is spending: the dialog as well. The free system voice keeps the words-only path.
      alwaysConfirmFor: (provider: PaidVoice) => provider !== 'system',
      confirmation: (provider: PaidVoice) => ({
        title: `${ASSISTANT_NAME} 请求试听语音`,
        detail: `${PREVIEW_DETAIL[provider]}\n试听内容：“${PREVIEW_LINE}”`,
      }),
      noticeDetail: (provider: PaidVoice) => PREVIEW_NOTICE[provider],
      run: (provider: PaidVoice, context: AgentCallContext) => {
        if (paidVoice(bridge.settings()) !== provider) throw unavailable('语音方案在确认之后变了，已取消。');
        if (!rendererAction({ kind: 'voice-preview' }, context)) throw unavailable('控制窗口尚未就绪。');
        return { requested: true, provider };
      },
    },
  ];
}
