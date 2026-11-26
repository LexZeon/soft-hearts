// I-163: the "nothing is left out of 带我去" lists. tests/take-me-there-coverage.test.ts reads the app's own registries (the control
// window's navigation, the capability list of every switch, the panels the wiring mounts, the developer-panel tools) and fails when
// one of them is neither pointed at a 带我去 destination here nor listed as not navigable WITH a reason. So a new page or switch cannot
// ship without "带我去 / 帮我打开" knowing about it. Data only. Opening a place only opens a page; it flips nothing.
//
// Adding a page, section or switch: 1) give it a place in take-me-there-places.ts (or reuse one), 2) list it here, 3) put the English
// title in shared/foundation/ui-copy.take-me-there.en.ts. "Not navigable" is for things that are not a page: say why in a few words.
import type { TakeMeThereId } from './take-me-there';

export type PlaceCover = TakeMeThereId | { readonly not: string };

const to = (destination: TakeMeThereId, ...ids: string[]): Array<[string, PlaceCover]> => ids.map(id => [id, destination]);
const no = (reason: string, ...ids: string[]): Array<[string, PlaceCover]> => ids.map(id => [id, { not: reason }]);
const table = (...groups: Array<Array<[string, PlaceCover]>>): Readonly<Record<string, PlaceCover>> => Object.freeze(Object.fromEntries(groups.flat()));

/** Control-window navigation leaves that no destination points at: they are another entry of a page a destination already opens. */
export const NOT_NAVIGABLE_LEAVES: Readonly<Record<string, string>> = Object.freeze({
  'chat-new': '聊天页里的按钮', 'chat-input': '聊天页里的输入框', 'chat-screen': '聊天页里的按钮', 'chat-camera': '聊天页里的按钮',
  'motion-local': '和「动作库」同一页（motion）', 'physics-chest': '和「头发和胸部物理」同一段（physics）', 'physics-quality': '和「头发和胸部物理」同一段（physics）',
  'camera-edit': '和「镜头」同一段（stage-camera）', 'camera-framing': '和「镜头」同一段（stage-camera）',
  'natural-breath': '和「自然表现」同一段（natural-motion）', 'natural-fps': '和「自然表现」同一段（natural-motion）',
  'memory-detail': '和「查找记忆」同一页（memory-search）', 'memory-config': '和「查找记忆」同一页（memory-search）',
  'agent-list': '和「Claude 任务」同一页（claude-tasks）', 'agent-prompt': '和「Claude 任务」同一页（claude-tasks）',
  'agent-transcript': '和「Claude 任务」同一页（claude-tasks）', 'agent-approvals': '和「Claude 任务」同一页（claude-tasks）',
});

/**
 * Every entry of the capability list (shared/settings/capabilities.ts, which tests/capability-coverage.test.ts keeps complete for the
 * control window) → where 带我去 takes the user for it. Only the interface itself, and things that are not a page, are "not".
 */
export const CAPABILITY_PLACES: Readonly<Record<string, PlaceCover>> = table(
  to('companion-window', 'pet_visible', 'always_on_top', 'click_through'), // no-pet-ok: capability id
  no('每一页顶栏都有的按钮，不是一页', 'recover_pet'), // no-pet-ok: capability id
  no('预览卡片在每一页旁边', 'play_preview'),
  no('按钮在全屏（Unbound）里她旁边的小面板，设置窗口里没有这一页', 'unbound_default_place'), // 2026-11-23
  to('stage-camera', 'pet_framing', 'camera'), // no-pet-ok: capability id
  no('界面本身：导航、展开收起、搜索', 'ui_navigation', 'ui_panels', 'open_control_page'),
  no('出问题时自己出现的提示条', 'chat_retry'),
  to('chat-page', 'network_settings'), // I-173: the notice with its button shows on the chat page
  to('chat-page', 'chat_itself', 'voice_call', 'her_small_actions'), // I-173: the chat page itself (before: "聊天本身，她就在那里", not navigable)
  to('trial-features', 'channel_gates'),
  to('delete-character', 'character_delete'), // I-173: the tile's 「更多」 menu (open_control_page with a character opens it)
  to('characters-page', 'active_character', 'character_export', 'character_recycle_open', 'character_model', 'character_unbind_model', 'character_avatar',
    'model_capability_switch', 'model_capability_try'),
  to('convert-character', 'character_convert'),
  to('import-character', 'character_import', 'character_new_current', 'character_new'),
  to('character-persona', 'character_persona', 'slow_warm_up', 'music_taste', 'card_slips', 'realer_emotions', 'character_mood_template', 'character_blush', 'character_understanding',
    'character_editor_open', 'character_archive', 'personalize_language', 'personalize_visual', 'personalize_body'),
  to('character-response', 'character_response'),
  to('character-voice', 'character_voice'), // I-162 step 2
  to('blush-calibration', 'blush_calibration'),
  to('reaction-dispositions', 'reaction_dispositions'),
  to('import-model', 'model'),
  to('bundled-model', 'bundled_model'),
  to('motion', 'vmd_motion', 'motion_library', 'motion_tag_weights', 'motion_library_browse'),
  to('physics', 'physics_hair', 'physics_chest', 'physics_quality', 'physics_strength'),
  to('single-emoji', 'single_emoji', 'character_stickers'),
  to('natural-motion', 'follow_mouse', 'breath', 'music_strength', 'music_always_dance', 'fps'),
  to('memory-search', 'memory_browse', 'memory_edit', 'memory_parameters', 'listen_delete', 'ambient_delete', 'clear_song_memory'),
  to('delete-memory', 'memory_delete_one', 'delete_memories'),
  to('her-folder', 'her_folder', 'her_folder_open'),
  to('moving-memory', 'moving_memory'),
  to('chat-model', 'chat_model'),
  to('voice-input', 'asr_engine', 'asr_key', 'local_asr', 'local_asr_later', 'component_import'),
  to('voice-scheme', 'read_aloud', 'voice_rate', 'voice_mood_influence', 'voice_first_chunk', 'pause_talk', 'speech_beats', 'system_voice_name', 'voice_preview', 'voice_preview_controls',
    'readout_volume', 'voice_provider'),
  to('bailian-key', 'tts_connection', 'tts_key', 'tts_voice_style', 'tts_guides'),
  to('fish-key', 'tts_fish_key', 'tts_fish_cap', 'tts_fish_pages'),
  to('claude-tasks', 'claude_tasks'),
  to('claude-assistant', 'claude_assistant'),
  to('developer-mode', 'developer_mode'),
  to('mic', 'voice_input'),
  to('screen', 'screen_sharing', 'proactive_vision', 'self_look'),
  to('camera', 'camera_sharing', 'camera_images', 'camera_pose'),
  to('face-check', 'face_check', 'face_check_data'),
  to('listen', 'system_audio'),
  to('pose-sensing', 'pose_sensing', 'pose_redetect'),
  to('ui-language', 'ui_language'),
  to('agent-channel', 'interconnect', 'agent_channel_switch', 'claude_code_link', 'undo_last_action', 'agent_channel_copy', 'agent_channel_diagnostics'),
  to('delete-data', 'recycle_bin_days', 'restore_memories', 'recycle_delete_for_good', 'reset_settings', 'quit_app'),
  to('feed-recognition', 'feed_recognition'),
  to('mood-judge', 'mood_judge'),
  to('reactions', 'new_reactions'),
  to('proactive-talk', 'proactive_talk'),
  to('user-activity', 'user_activity'),
  to('journal', 'experience_journal', 'journal_filter'),
  to('crisis-region', 'crisis_region'),
  to('user-profile', 'profile_recording', 'profile_edit', 'profile_reload'),
);

/**
 * Panels and tools the wiring mounts in the control window (src/wiring/*-wiring.ts, the developer panel in src/mood/MoodCompanion.ts)
 * by their class or mount function → where 带我去 takes the user. This is the check that sees what the capability list cannot reach:
 * panels the capability scan does not mount and the developer-mode tools.
 */
export const PANEL_PLACES: Readonly<Record<string, PlaceCover>> = table(
  to('single-emoji', 'SingleEmojiControls', 'CharacterStickerControls'),
  to('feed-recognition', 'FeedRecognitionPanel'),
  to('trial-features', 'ChannelGatesPanel'),
  to('voice-scheme', 'SpeechBeatsSwitch'), // 边说边演: its switch sits in the voice section
  to('mood-judge', 'MoodJudgePanel'),
  to('reactions', 'ReactionsPanel'),
  to('reaction-dispositions', 'ReactionDispositionsPanel'),
  to('user-activity', 'UserActivityPanel'),
  to('journal', 'JournalPanel'),
  to('her-folder', 'HerFolderPanel'),
  to('our-things', 'OurThingsPanel'),
  to('moving-memory', 'MovingMemoryPanel'),
  to('people-things', 'PeopleThingsPanel'),
  to('agent-channel', 'AgentChannelPanel'),
  to('voice-input', 'LocalAsrPanel'),
  to('voiceprint', 'VoiceprintPanel'),
  to('pose-sensing', 'PoseSensingPanel'),
  to('face-check', 'FaceCheckPanel'),
  no('出问题时自己出现的提示条，不是一页', 'ChatAvailabilityNotice', 'PartHealthNotice'),
  to('bailian-key', 'EmotionalVoiceControls'),
  to('claude-tasks', 'CodexTasks'),
  to('motion', 'MotionLibraryControls'),
  to('character-persona', 'CharacterCards'),
  to('characters-page', 'CharacterPage', 'ModelCapabilityPanel'),
  to('blush-calibration', 'BlushCalibrationControls'),
  to('user-profile', 'UserProfilePanel', 'TextMemorialPanel'),
  to('memory-search', 'MemoryPanel', 'SemanticRecallPanel', 'ListenTogetherPanel', 'AmbientTranscriptHistory'),
  to('screen', 'ScreenSharingOptions'),
  no('聊天框里的「给她看看」按钮，不是一页', 'LookButton'),
  no('只在开发版里有的内部测试开关，稳定版里隐藏，不是给用户的一页（2026-11-24 保存她念出来的声音）', 'VoiceKeepPanel'),
  // The developer panel (only shows in developer mode): opening it never turns developer mode on.
  to('developer-mode', 'ProceduralLifeToggle', 'MoodPanel', 'PetWindowDiagnosticsPanel'), // no-pet-ok: the class name of the developer panel tool
  to('unbound-lab', 'UnboundSwitch'),
  to('unbound-entry', 'UnboundEntryButton'),
  to('physics-lab', 'mountPhysicsLabButton'),
);

/** Destinations that open a page where a privacy, paid or permission switch lives: the page opens, the switch stays the user's. */
export const CONSENT_PLACES: readonly TakeMeThereId[] = Object.freeze(['screen', 'camera', 'mic', 'listen', 'face-check', 'pose-sensing', 'voiceprint', 'bailian-key', 'fish-key',
  'claude-tasks', 'task-folder', 'mood-judge', 'reactions', 'feed-recognition', 'user-activity', 'unbound-entry', 'touch-soft', 'trial-features', 'agent-channel', 'delete-data', 'delete-memory',
  'journal', 'proactive-talk', 'her-folder', 'developer-mode', 'physics-lab', 'unbound-lab', 'companion-window', 'user-profile', 'voice-input'] as TakeMeThereId[]);

export interface CoverageInput {
  /** Leaf ids of the control window's navigation. */
  readonly leaves: readonly string[];
  /** Ids of the capability list. */
  readonly capabilityIds: readonly string[];
  /** Panel classes and mount functions the wiring and the developer panel mount. */
  readonly panels: readonly string[];
  /** The destinations that exist (id → its leaf). */
  readonly destinations: Readonly<Record<string, { readonly leafId: string }>>;
  readonly notNavigableLeaves?: Readonly<Record<string, string>>;
  readonly capabilityPlaces?: Readonly<Record<string, PlaceCover>>;
  readonly panelPlaces?: Readonly<Record<string, PlaceCover>>;
}

const resolves = (cover: PlaceCover | undefined, destinations: CoverageInput['destinations']): boolean =>
  cover !== undefined && (typeof cover === 'string' ? Object.prototype.hasOwnProperty.call(destinations, cover) : cover.not.trim().length >= 4);

/** What has no 带我去 entry, as readable lines (empty when nothing is left out). Pure: the test feeds it the app's real registries. */
export function takeMeThereGaps(input: CoverageInput): string[] {
  const optOut = input.notNavigableLeaves ?? NOT_NAVIGABLE_LEAVES, capabilities = input.capabilityPlaces ?? CAPABILITY_PLACES, panels = input.panelPlaces ?? PANEL_PLACES;
  const reached = new Set(Object.values(input.destinations).map(destination => destination.leafId));
  const gaps: string[] = [];
  for (const leaf of input.leaves) if (!reached.has(leaf) && !((optOut[leaf]?.trim().length ?? 0) >= 4)) gaps.push(`页面入口 ${leaf}：没有「带我去」的去处，也没写不能去的原因`);
  for (const id of input.capabilityIds) if (!resolves(capabilities[id], input.destinations)) gaps.push(`开关 ${id}：没有指向存在的去处，也没写不能去的原因`);
  for (const panel of input.panels) if (!resolves(panels[panel], input.destinations)) gaps.push(`面板或工具 ${panel}：没有指向存在的去处，也没写不能去的原因`);
  return gaps;
}
