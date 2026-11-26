// Data map rows: the character and her model, and what lives outside the profile (split out of data-map.ts 2026-11-18; table order).
import type { DataStoreRow } from './data-map-types';
import { ASSISTANT_NAME } from '../../shared/foundation/assistant-name';

export const CHARACTER_ROWS = [
  // ---- The character and her model (not about the user) ----
  { id: 'character-cards', label: '角色卡', holds: '角色卡的设定文字、关联的模型', paths: ['characters.json'], scope: 'character', holdsUserData: false,
    recycle: 'take', characterForget: 'with-card', recordingOff: 'unaffected', agentDelete: 'untouched', cardExport: 'included', backup: true, diagnostics: 'never', owner: 'electron/cards/character-cards.ts',
    note: '导出时去掉模型路径、头像和本机文件夹。' },
  { id: 'card-backups', label: '角色卡的旧版备份', holds: '更新角色卡、拆开模型前的 characters.json 副本', paths: ['characters.before-update-*.json', 'characters.before-model-split.json'], scope: 'global', holdsUserData: false,
    recycle: 'stays', characterForget: 'keep', recordingOff: 'unaffected', agentDelete: 'untouched', cardExport: 'never', backup: true, diagnostics: 'never', owner: 'electron/cards/character-card-update.ts' },
  { id: 'character-response', label: '反应细调', holds: '这张卡的反应规则', paths: ['character-response-settings.json'], scope: 'character', holdsUserData: false,
    recycle: 'take', characterForget: 'with-card', recordingOff: 'unaffected', agentDelete: 'untouched', cardExport: 'included', backup: true, diagnostics: 'never', owner: 'electron/cards/character-response.ts' },
  { id: 'character-avatars', label: '角色头像', holds: '角色页上的头像图', paths: ['character-avatars/*.png'], scope: 'character', holdsUserData: false,
    recycle: 'take', characterForget: 'with-card', recordingOff: 'unaffected', agentDelete: 'untouched', cardExport: 'never', backup: true, diagnostics: 'never', owner: 'electron/cards/character-avatars.ts' },
  { id: 'character-personalization', label: '角色的个性化', holds: '语言习惯、身体姿势、眉眼行为', paths: ['personalize-language.json', 'personalize-body.json', 'personalize-visual.json'], scope: 'character', holdsUserData: false,
    recycle: 'stays', characterForget: 'keep', recordingOff: 'unaffected', agentDelete: 'untouched', cardExport: 'never', backup: true, diagnostics: 'never', owner: 'electron/cards/character-revision-store.ts',
    note: '卡删了以后这几份留着不再用（条目超过上限时才清掉没有卡的）。' },
  { id: 'character-stickers', label: '角色贴图', holds: '为模型做的表情贴图', paths: ['character-stickers/**'], scope: 'global', holdsUserData: false,
    recycle: 'stays', characterForget: 'keep', recordingOff: 'unaffected', agentDelete: 'untouched', cardExport: 'never', backup: true, diagnostics: 'never', owner: 'electron/cards/character-sticker-store.ts' },
  { id: 'model-data', label: '模型和动作的数据', holds: '模型档案、动作适配、模型能力、脸红校准、动作标注、动作库、物理调参（按模型内容区分）', scope: 'global', holdsUserData: false,
    paths: ['model-profiles.json', 'motion-fits.json', 'model-capabilities.json', 'model-capabilities.unreadable-*.json', 'blush-calibrations.json', 'motion-tag-annotations.json', 'library/motions/**', 'physics-tuning.json'],
    recycle: 'stays', characterForget: 'keep', recordingOff: 'unaffected', agentDelete: 'untouched', cardExport: 'never', backup: true, diagnostics: 'never', owner: 'electron/model-*.ts, electron/motion-*.ts' },
  { id: 'gene-preinstall', label: '预装角色的记号', holds: '预装角色装没装过', paths: ['gene-preinstalled-card.json', 'gene-english-preinstalled-card.json', 'one-preinstalled-card.json', 'one-en-preinstalled-card.json', 'mumi-preinstalled-card.json', 'mumi-en-preinstalled-card.json'], scope: 'global', holdsUserData: false,
    recycle: 'stays', characterForget: 'keep', recordingOff: 'unaffected', agentDelete: 'untouched', cardExport: 'never', backup: true, diagnostics: 'never', owner: 'electron/cards/gene-preinstalled-card.ts' },
  { id: 'voice-call-fillers', label: '语音电话的垫话', holds: '她的几句垫话录音缓存', paths: ['voice-call-fillers/**'], scope: 'character', holdsUserData: false,
    recycle: 'stays', characterForget: 'keep', recordingOff: 'unaffected', agentDelete: 'untouched', cardExport: 'never', backup: true, diagnostics: 'never', owner: 'electron/voice/voice-call/fillers.ts' },
  { id: 'chat-workdir', label: '聊天工作目录', holds: `聊天时 ${ASSISTANT_NAME} 的工作目录（空的，不存对话）`, paths: ['chat/**'], scope: 'global', holdsUserData: false,
    recycle: 'stays', characterForget: 'keep', recordingOff: 'unaffected', agentDelete: 'untouched', cardExport: 'never', backup: true, diagnostics: 'never', owner: 'electron/brain/claude.ts (--no-session-persistence)' },

  // ---- Outside the profile ----
  { id: 'color-block-log', label: '色块诊断', holds: '色块出现的次数和时间（只有数字）', paths: ['%LOCALAPPDATA%\\soft-hearts-diagnostics\\color-block'], scope: 'outside-profile', holdsUserData: false,
    recycle: 'stays', characterForget: 'keep', recordingOff: 'unaffected', agentDelete: 'untouched', cardExport: 'never', backup: false, diagnostics: 'never', owner: 'electron/mood/color-block-log.ts' },
  { id: 'components', label: '离线组件', holds: '下载或导入的离线模型（姿势、语音识别、认脸、按意思想起、声纹）', paths: ['%LOCALAPPDATA%\\soft-hearts-claude\\components'], scope: 'outside-profile', holdsUserData: false,
    recycle: 'stays', characterForget: 'keep', recordingOff: 'unaffected', agentDelete: 'untouched', cardExport: 'never', backup: false, diagnostics: 'never', owner: 'electron/senses/pose/component-store.ts' },
] as const satisfies readonly DataStoreRow[];
