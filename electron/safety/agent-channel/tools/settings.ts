// list_settings and set_setting (docs/claude/2026-11-17-app-tools-split.md): each setting is applied through the host path its own
// control already uses (applySetting). A value that needs consent takes the user's words (confirm tier, tierFor); a sensitive one
// (privacy, spending, downloads: settingAlwaysDialog) opens the dialog as well. 撤回 never goes back to a value that needed consent.
// How each setting reads and what its values mean: ./setting-values.ts.
import { proactiveTalk } from '../../../../shared/foundation/settings'; // the settings vocabulary (wiring rewrite step 1; was shared/behaviors/inner-rhythm/knobs)
import { crisisRegionPreference } from '../../../../shared/safety/crisis-lines';
import { DEFAULT_TTS_CONFIG, validFishMonthlyCap, type TtsConfig } from '../../../../shared/voice';
import { AGENT_TIER_LABELS, agentSetting, settingAlwaysDialog, settingValueNeedsConsent, validateAgentSettingValue, type AgentSettingId, type AgentSettingSpec, type AgentSettingValue } from '../../../../shared/safety/agent-channel';
import { isRealerDuration, type RealerDuration } from '../../../../shared/mood';
import type { ModelPhysicsSettings } from '../../../../shared/stage';
import { AgentToolError, type AgentCallContext, type AgentCommitGuard, type AgentToolDefinition } from '../registry';
import { argsObject, noArgs } from '../validate';
import type { CommitResult } from './app-bridge';
import { title, unavailable, type ToolContext } from './common';
import { componentValue, localAsrValue, ASR_MODEL_BYTES, megabytes, settingDetail, settingValue, realerEmotionsConfirmationFor, settingViews, realerEmotionsInformation, describe, settingNeedsConsent } from './setting-values';
import { drama3View, monthlyLimitConfirmation, voiceSpendingView } from './voice-spend';
import { ASSISTANT_NAME } from '../../../../shared/foundation/assistant-name';

/** T-239: what a set_setting call is about, taken before any dialog; the dialog shows it, and the change applies only while it holds. */
interface SettingRequest { spec: AgentSettingSpec; value: AgentSettingValue; shown: AgentSettingValue | null; card: { id: string; name: string } | null; /** I-112 B: "更真实的情绪" turning on: how long (default a week). */ duration?: RealerDuration }
/** Settings kept on the active character card: a request is bound to the card that was active when it was made. */
const CARD_SETTINGS: ReadonlySet<AgentSettingId> = new Set<AgentSettingId>(['slow_warm_up', 'realer_emotions']);

function committed(result: CommitResult): void {
  if (result.persistence === 'not-committed') throw unavailable('桌宠窗口尚未就绪，没有保存。');
  if (result.persistence === 'unknown') throw unavailable('无法确认设置是否保存，请查看控制窗口。');
}

export function settingTools(context: ToolContext): AgentToolDefinition<any, any>[] {
  const { bridge, via, setReadAloud, interconnected, extras, valueOf, activeId, readBudget, now } = context;
  const applySetting = async (id: AgentSettingId, value: AgentSettingValue, guard: AgentCommitGuard, characterId?: string, duration?: RealerDuration): Promise<void> => {
    switch (id) {
      case 'voice_provider': {
        const current = bridge.settings(), tts = current.tts ?? structuredClone(DEFAULT_TTS_CONFIG) as TtsConfig;
        // The key itself never crosses the channel: the public settings only say whether one is saved.
        if (value === 'bailian' && (!tts.apiKey || !tts.apiHost?.trim()))
          throw unavailable('还没有设好百炼的连接和密钥。请在控制窗口「连接与声音」里自己设置（密钥不经过内部通道）。');
        // I-070: only whether a Drama 3 key is saved is visible here (it arrives redacted); the key itself never crosses.
        if (value === 'fish' && !tts.fishApiKey)
          throw unavailable('还没有填 Drama 3（Fish Audio）的 API Key。请用户自己在控制窗口的朗读设置里填（可以用 open_control_page，page: fish-key 带过去；Key 不经过内部通道）。');
        if (tts.provider !== value) await bridge.saveSettings({ ...current, tts: { ...tts, provider: value as TtsConfig['provider'] } }, guard);
        return;
      }
      case 'drama3_monthly_limit': {
        // 2026-11-24: the 「Drama 3 语音」 page's own field, saved as that page saves it; nothing else in tts moves (keys arrive redacted, no address).
        const current = bridge.settings(), tts = current.tts ?? structuredClone(DEFAULT_TTS_CONFIG) as TtsConfig;
        if (validFishMonthlyCap(tts.fishMonthlyCapUsd) !== value) await bridge.saveSettings({ ...current, tts: { ...tts, fishMonthlyCapUsd: value as number } }, guard);
        return;
      }
      case 'recycle_bin_days':
        if (!bridge.memories) throw unavailable('这个版本还没有回收站。');
        await bridge.memories.setDays(value as number, guard); return;
      case 'slow_warm_up':
        if (!bridge.setSlowWarmUp) throw unavailable('这个版本还不能在聊天里改角色卡设置。');
        await bridge.setSlowWarmUp(value as boolean, guard, characterId); return;
      case 'realer_emotions':
        if (!bridge.setRealerEmotions) throw unavailable('这个版本还不能在聊天里改角色卡设置。');
        await bridge.setRealerEmotions(value as boolean, guard, characterId, duration); return;
      case 'experience_journal':
        if (!bridge.setExperienceJournal) throw unavailable('这个版本还不能通过内部通道改体验记录开关。');
        await bridge.setExperienceJournal(value as boolean, guard); return;
      case 'voice_input': {
        // I-025: the same host path as the user's own 「语音输入」 switch (the companion window's, as set_perception).
        if (!bridge.perception || !bridge.setPerception) throw unavailable('这个版本还不能这样开关语音输入。');
        const pet = bridge.windows().pet;
        if (value === true && (!pet || !pet.visible || pet.minimized)) throw unavailable('请先让桌宠显示出来，语音输入在桌宠上打开。');
        await bridge.setPerception('microphone', value as boolean, [], guard);
        if (value === true && !bridge.perception().microphone) {
          const asr = localAsrValue(extras().localAsr);
          throw unavailable(asr === 'not-installed' || asr === 'downloading'
            ? `语音输入没有打开：本机语音识别${asr === 'downloading' ? '还在下载' : '还没有下载'}（local_asr）。下载好以后再打开。`
            : '语音输入没有打开：可能缺少语音识别连接，soft hearts 上会有说明。');
        }
        return;
      }
      case 'voice_call': {
        // I-091: the companion window's own call handler (the same as its button). Starting it is a sensitive setting (the dialog
        // after the user's words); hanging up is always direct.
        if (!bridge.setVoiceCall || !bridge.voiceCall) throw unavailable('这个版本还不能这样开始或挂断通话。');
        const pet = bridge.windows().pet;
        if (value === true && (!pet || !pet.visible || pet.minimized)) throw unavailable('请先让桌宠显示出来，通话在桌宠上开始。');
        await bridge.setVoiceCall(value as boolean, via, guard);
        if (value === true && !bridge.voiceCall()) throw unavailable('通话没有开始：可能还没有本机语音识别，或者她睡着了；soft hearts 上会有说明。');
        return;
      }
      case 'click_through': case 'chat_model': case 'voice_rate': case 'voice_mood_influence': case 'voice_first_chunk': case 'pause_talk': case 'proactive_talk': case 'self_look': case 'crisis_region': {
        // The settings window's own whole-settings save (the same form fields).
        const current = bridge.settings();
        const next = id === 'click_through' ? { ...current, pet: { ...current.pet, clickThrough: value as boolean } }
          : id === 'chat_model' ? { ...current, provider: { ...current.provider, model: value as string } }
          : id === 'voice_rate' ? { ...current, voice: { ...current.voice, rate: (value as number) / 100 } }
          : id === 'voice_first_chunk' ? { ...current, voice: { ...current.voice, firstChunk: value as 'sentence' | 'comma' } }
          : id === 'proactive_talk' ? { ...current, proactiveTalk: proactiveTalk(value) }
          : id === 'self_look' ? { ...current, selfLook: value === true }
          : id === 'crisis_region' ? { ...current, crisisRegion: crisisRegionPreference(value) }
          : id === 'pause_talk' ? { ...current, voice: { ...current.voice, pauseTalk: value as boolean } }
          : { ...current, voice: { ...current.voice, moodInfluence: value as number } };
        if (settingValue(id, current) !== value) await bridge.saveSettings(next, guard);
        return;
      }
      case 'ui_language':
        if (!bridge.setUiLanguage) throw unavailable('这个版本还不能这样改界面语言。');
        await bridge.setUiLanguage(value as import('../../../../shared/foundation/ui-languages').UiLanguagePreference, guard); return;
      case 'developer_mode':
        if (!bridge.setDeveloperMode) throw unavailable('这个版本还不能这样开关开发者模式。');
        await bridge.setDeveloperMode(value as boolean, guard); return;
      case 'music_strength': case 'music_always_dance':
        if (!bridge.setMusic) throw unavailable('这个版本还不能这样改音乐律动。');
        await bridge.setMusic(id === 'music_strength' ? { strength: (value as number) / 100 } : { alwaysDance: value as boolean }, guard); return;
      case 'physics_hair': case 'physics_chest': case 'physics_quality': {
        const physics = extras().host?.physics;
        if (!bridge.setPhysics || !physics) throw unavailable('这个版本还不能这样改局部物理。');
        await bridge.setPhysics(id === 'physics_quality' ? { ...physics, quality: value as ModelPhysicsSettings['quality'] }
          : { ...physics, [id === 'physics_hair' ? 'hair' : 'chest']: { ...physics[id === 'physics_hair' ? 'hair' : 'chest'], enabled: value as boolean } }, guard);
        return;
      }
      case 'proactive_vision':
        if (!bridge.setProactiveVision) throw unavailable('这个版本还不能这样开关“根据画面主动聊天”。');
        await bridge.setProactiveVision(value as boolean, guard); return;
      case 'feed_recognition':
        if (!bridge.setFeedRecognition) throw unavailable('这个版本还不能这样开关喂食认图。');
        await bridge.setFeedRecognition(value as boolean, guard); return;
      case 'user_activity':
        if (!bridge.setUserActivity) throw unavailable('这个版本还不能这样开关“知道你是不是在忙”。');
        await bridge.setUserActivity(value as boolean, guard); return;
      case 'unbound_default_place':
        if (!bridge.setUnboundDefaultPlace) throw unavailable('这个版本还不能设全屏里她出来的位置。');
        if (!await bridge.setUnboundDefaultPlace(value === 'default', guard)) throw unavailable('她现在不在全屏里，没有“现在的位置”可以记。请先让她出来、摆到想要的位置，再设。');
        return;
      case 'mood_judge':
        if (!bridge.setMoodJudge) throw unavailable('这个版本还不能这样开关心情调整员。');
        await bridge.setMoodJudge(value as boolean, guard); return;
      case 'new_reactions':
        if (!bridge.setReactions) throw unavailable('这个版本还不能这样开关新的反应方式。');
        await bridge.setReactions(value as boolean, guard); return;
      case 'pose_sensing': {
        // The privacy page's own 「下载」/「取消」/「删除感知组件」 (electron/senses/pose/control-ipc.ts), reused as they are.
        if (!bridge.downloadPose || !bridge.cancelPoseDownload || !bridge.removePose) throw unavailable('这个版本还不能这样下载姿态感知组件。');
        const now = componentValue(extras().host?.pose);
        if (now === null || now === 'unsupported') throw unavailable('这台电脑用不了本机姿态感知（只支持 Windows ARM64 / x64）。');
        if (value === 'installed') { if (now === 'not-installed') await bridge.downloadPose(guard); return; }
        if (now === 'downloading') await bridge.cancelPoseDownload(guard);
        else if (now === 'installed') await bridge.removePose(guard);
        return;
      }
      case 'local_asr': {
        // I-025: the control window's own 「下载」/「取消」/「删除识别组件」 (electron/senses/asr/electron-wiring.ts), reused as they are.
        if (!bridge.localAsr || !bridge.downloadLocalAsr || !bridge.cancelLocalAsrDownload || !bridge.removeLocalAsr)
          throw unavailable('这个版本还不能这样下载本机语音识别。');
        const now = localAsrValue(bridge.localAsr());
        if (now === null || now === 'unsupported') throw unavailable('这台电脑用不了本机语音识别（只支持 Windows ARM64 / x64）。');
        if (value === 'installed') { if (now === 'not-installed') await bridge.downloadLocalAsr(guard); return; }
        if (now === 'downloading') await bridge.cancelLocalAsrDownload(guard);
        else if (now === 'installed') await bridge.removeLocalAsr(guard);
        return;
      }
      case 'read_aloud': await setReadAloud(value as boolean, guard); return;
      case 'readout_volume': committed(await bridge.commitReadoutVolume(value as number, guard)); return;
      case 'pet_visible': await bridge.setPetVisible(value as boolean, guard); return;
      case 'always_on_top': committed(await bridge.commitPetBoolean(value as boolean, 'pet.set-always-on-top', guard)); return;
      case 'follow_mouse': committed(await bridge.commitPetBoolean(value as boolean, 'pet.set-follow-mouse', guard)); return;
      case 'breath': committed(await bridge.commitBreath(value as number, guard)); return;
      case 'fps': {
        const current = bridge.settings();
        if (current.pet.fps !== value) await bridge.saveSettings({ ...current, pet: { ...current.pet, fps: value as number } }, guard);
      }
    }
  };
  /**
   * T-239 (Codex review: "确认 A 角色，提交时改 B 角色"): a set_setting request applies only to what it was about. A card setting
   * stays on the card that was active when it was asked (another switch in between refuses it); a value that needed consent
   * applies only while the setting still has the value the dialog (or the user's words) started from.
   */
  const settingStillMeant = (input: SettingRequest): void => {
    const { spec } = input;
    if (CARD_SETTINGS.has(spec.id) && input.card) {
      const cards = bridge.characters(), now = cards.cards.find(item => item.id === cards.activeId);
      if (!cards.cards.some(item => item.id === input.card!.id))
        throw unavailable(`「${input.card.name}」这张角色卡已经不在了，「${spec.label}」什么都没改。`);
      if (now?.id !== input.card.id)
        throw unavailable(`确认期间换了角色：这次是给「${input.card.name}」改「${spec.label}」，现在的角色是「${now?.name ?? '没有选中'}」。什么都没改；需要的话请重新请求。`);
    }
    if (settingNeedsConsent(spec, input.value, via)) {
      const now = valueOf(spec.id);
      if (now !== input.shown)
        throw unavailable(`「${spec.label}」在确认期间变了（确认时是 ${describe(spec, input.shown)}，现在是 ${describe(spec, now)}），这次什么都没改；需要的话请重新请求。`);
    }
  };
  return [
    {
      name: 'list_settings', title: title('list_settings'), tier: 'read', validate: noArgs,
      run: () => {
        const more = extras();
        return {
          settings: settingViews(bridge.settings(), bridge.characters(), more).filter(view => !view.interconnectOnly || interconnected()).map(view => {
            // I-025: what a value needing consent means (download size and source, the microphone), for telling the user first.
            const details = (view.kind === 'number' ? [] : view.choices).flatMap(choice => {
              const text = settingDetail(view.id, choice.value, more);
              return text ? [{ value: choice.value, detail: text }] : [];
            });
            return details.length ? { ...view, details } : view;
          }),
          tiers: AGENT_TIER_LABELS, interconnect: interconnected(),
          // 2026-11-24: paid voices at a glance (so "是不是额度没了" has an answer): Drama 3's limit and spending, each character's voice.
          voices: voiceSpendingView(bridge.settings(), bridge.characters(), readBudget(), now()),
        };
      },
    },
    {
      name: 'set_setting', title: title('set_setting'), tier: 'reversible',
      validate: raw => {
        const args = argsObject(raw, ['id', 'value', 'duration']), spec = agentSetting(args.id);
        // I-014: an interconnect-only setting does not exist while 三方互通 is off.
        if (!spec || (spec.interconnectOnly && !interconnected())) throw new AgentToolError('invalid_input', '没有这项设置，请先用 list_settings 查看。');
        let value: AgentSettingValue;
        try { value = validateAgentSettingValue(spec, args.value); }
        catch (error) { throw new AgentToolError('invalid_input', (error as Error).message); }
        // I-112 B: only turning "更真实的情绪" on takes a duration (day / week / month / forever); without one it is a week.
        if (args.duration === undefined) return { spec, value };
        if (spec.id !== 'realer_emotions' || value !== true) throw new AgentToolError('invalid_input', 'duration 只用于打开“更真实的情绪”（realer_emotions true）。');
        if (!isRealerDuration(args.duration)) throw new AgentToolError('invalid_input', 'duration 只能是 day、week、month 或 forever。');
        return { spec, value, duration: args.duration };
      },
      // F6: turning "更真实的情绪" on asks the user first, with what it does in plain words; turning it off does not. I-025: the same
      // for every value a setting marks (`confirmWhen`: the microphone on, the recognizer's download and removal). With 三方互通 on
      // the call must carry the user's words (registry); with it off the dialog below asks. Her chat: see settingNeedsConsent.
      // T-239: the target is taken here, before any dialog: the value it has now and, for a card setting, the card that is active now.
      prepare: (input: { spec: AgentSettingSpec; value: AgentSettingValue; duration?: RealerDuration }): SettingRequest => {
        const cards = bridge.characters(), active = CARD_SETTINGS.has(input.spec.id) ? cards.cards.find(item => item.id === cards.activeId) : undefined;
        return { ...input, shown: valueOf(input.spec.id), card: active ? { id: active.id, name: active.name } : null };
      },
      tierFor: (input: { spec: AgentSettingSpec; value: AgentSettingValue }) => settingNeedsConsent(input.spec, input.value, via) ? 'confirm' : input.spec.tier,
      // 敏感操作弹窗: privacy, spending, downloads and removals (the catalog's `consent`, all but "behavior") still
      // open the dialog with 三方互通 on, after the user's words; "更真实的情绪" (behavior) keeps the words-only path.
      alwaysConfirmFor: (input: { spec: AgentSettingSpec }) => settingAlwaysDialog(input.spec),
      confirmation: (input: SettingRequest) => {
        if (input.spec.id === 'realer_emotions') return realerEmotionsConfirmationFor(input.card?.name, input.duration);
        if (input.spec.id === 'drama3_monthly_limit') return monthlyLimitConfirmation(input.shown as number | null, input.value as number, drama3View(bridge.settings(), readBudget(), now()), now());
        const detail = settingDetail(input.spec.id, input.value, extras());
        if (input.spec.id === 'local_asr') return { title: input.value === 'installed' ? `${ASSISTANT_NAME} 请求下载本机语音识别` : `${ASSISTANT_NAME} 请求取消或删除本机语音识别`, detail: detail ?? '' };
        if (input.spec.id === 'voice_input') return { title: `${ASSISTANT_NAME} 请求打开语音输入（会用麦克风）`, detail: detail ?? '' };
        if (input.spec.id === 'voice_call') return { title: `${ASSISTANT_NAME} 请求和她开始通话（麦克风会一直听）`, detail: detail ?? '' };
        if (input.spec.id === 'pose_sensing') return { title: input.value === 'installed' ? `${ASSISTANT_NAME} 请求下载本机姿态感知组件` : `${ASSISTANT_NAME} 请求取消或删除姿态感知组件`, detail: detail ?? '' };
        if (detail) return { title: `${ASSISTANT_NAME} 请求把「${input.spec.label}」改为 ${describe(input.spec, input.value)}`, detail };
        return {
          title: `${ASSISTANT_NAME} 请求修改「${input.spec.label}」`,
          detail: `从：${describe(input.spec, input.shown)}\n改为：${describe(input.spec, input.value)}`,
        };
      },
      informWithoutDialog: (input: SettingRequest) =>
        input.spec.id === 'realer_emotions' && input.value === true ? realerEmotionsInformation(bridge.characters(), input.card?.name, input.duration) : undefined,
      noticeDetail: (input: { spec: AgentSettingSpec; value: AgentSettingValue }) => {
        if (input.spec.id === 'local_asr') {
          if (input.value === 'installed') return `开始下载本机语音识别（约 ${megabytes(extras().localAsr?.downloadBytes || ASR_MODEL_BYTES)} MB，来自 Hugging Face）`;
          return localAsrValue(extras().localAsr) === 'downloading' ? '取消下载本机语音识别' : '删除本机语音识别组件';
        }
        if (input.spec.id === 'voice_input') return input.value === true ? '打开语音输入（麦克风）' : '关闭语音输入（麦克风）';
        if (input.spec.id === 'voice_call') return input.value === true ? '开始通话（麦克风一直听）' : '挂断通话';
        if (input.spec.id === 'pose_sensing') {
          if (input.value === 'installed') return `开始下载本机姿态感知组件${extras().host?.pose?.downloadBytes ? `（约 ${megabytes(extras().host!.pose!.downloadBytes)} MB）` : ''}`;
          return componentValue(extras().host?.pose) === 'downloading' ? '取消下载姿态感知组件' : '删除姿态感知组件';
        }
        return `「${input.spec.label}」改为 ${describe(input.spec, input.value)}`;
      },
      wordsItem: (input: { spec: AgentSettingSpec; value: AgentSettingValue }) => ({ item: input.spec.id, value: input.value }),
      run: async (input: SettingRequest, context: AgentCallContext) => {
        const { spec } = input, card = activeId();
        settingStillMeant(input);
        const previous = valueOf(spec.id);
        await applySetting(spec.id, input.value, context.check, input.card?.id, input.duration);
        const value = valueOf(spec.id);
        try { bridge.settingChanged?.(spec.id, previous, value, via); } catch { /* Keeping a record never undoes a change. */ }
        // I-025: a download goes on in the background and is not undone by 撤回 (删除 is its own request, with the user's words).
        if (spec.id === 'pose_sensing') return { id: spec.id, label: spec.label, previous, value, ...(value === 'downloading'
          ? { note: '已开始下载，进度在控制窗口「隐私与设置 → 输入与共享」；下载好以后用户打开摄像头才会用到。' } : {}) };
        if (spec.id === 'local_asr') return { id: spec.id, label: spec.label, previous, value, ...(value === 'downloading'
          ? { note: '已开始下载，进度在控制窗口「连接与声音 → 语音输入」；下载好以后可以用 voice_input 打开语音输入（也要用户的原话）。' } : {}) };
        // I-014 撤回: back to the previous value, only while nobody changed it since (and on the same card for card settings).
        // I-025: 撤回 never does what needs the user's words (the microphone back on, the paid voice, a bigger model, sharing more).
        // 2026-11-23: a default place cleared cannot be put back by 撤回 (it would keep wherever she stands then, not the old place).
        if (previous !== null && value !== previous && !settingValueNeedsConsent(spec, previous) && !(spec.id === 'unbound_default_place' && previous === 'default')) context.offerUndo({ label: `把「${spec.label}」改回 ${describe(spec, previous)}`, run: async guard => {
          if (valueOf(spec.id) !== value || ((spec.id === 'slow_warm_up' || spec.id === 'realer_emotions') && activeId() !== card))
            throw unavailable(`「${spec.label}」之后又改过了，没有撤回。`);
          await applySetting(spec.id, previous, guard, input.card?.id);
          try { bridge.settingChanged?.(spec.id, value, valueOf(spec.id), via); } catch { /* As above. */ }
        } });
        return { id: spec.id, label: spec.label, previous, value };
      },
    },
  ];
}
