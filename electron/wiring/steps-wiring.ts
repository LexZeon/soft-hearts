// Which unit each step of the ordered lists belongs to (overhaul step 7, docs/claude/2026-11-17-isolation-step7.md). The lists themselves and
// their order stay in electron/main.ts (wireWindowEvents, wireQuit, wireSettingsSync, wireMoodPublish; the wiring golden reads them there).
// - A window step, a quit or flush step and a sync step runs as a cleanup: always, even while its unit is off (releasing a camera or a
//   microphone is never skipped); in isolate mode its throw is caught and counted, and the next step runs.
// - A mood publish step runs as a callback: skipped while its unit is off.
// - A step not listed here runs as it is (the trunk's own steps, and the steps of core units: her conversation and mood, the stage core,
//   the settings and the shell): its failure is what it was before.
// tests/part-units.test.ts checks every step of the lists is here or named as core there, and that every unit here is declared.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { unitSteps } from './parts-wiring';
import { cancelClosedWindowDownload, cancelMotionDownloads, dropMotionWeightsOwner } from './actions-wiring';
import { closeLanguageAuthoring } from './cards-ready-wiring';
import { disposeR20Offers, disposeGame } from './initiative-cleanup-wiring';
import { publishGateScope, publishR20 } from './initiative-publish-wiring';
import { cancelPetMemorial, flushMemoryNotes, releaseProfile } from './memory-cleanup-wiring';
import { publishMemorials } from './memory-publish-wiring';
import { disposeMoodJudges, judgeMood, releaseFatigue, syncFatigue } from './mood-wiring';
import { interruptOwnedTasks, releaseClaudeTasks } from './safety-wiring';
import { abortVoiceRecognition, clearClosedWindowVision, disposeLook, dropClosedMediaOwner, flushUserActivity, holdForPoseInference, refreshVisionOnVisibility,
  releaseAmbientOwner, releaseCapture, revokeAmbientOwner, revokeAudioOwner, revokeHiddenVoiceInput, revokeVisionOwner, revokeWindowVoiceInput, stopPetSystemAudio,
  stopSensorProcesses, stopVisionAndSound, stopWatching } from './senses-cleanup-wiring';
import { syncVisionContext } from './senses-look-wiring';
import { publishVisionActivity } from './senses-publish-wiring';
import { syncVoiceScope } from './senses-voice-input-wiring';
import { invalidateCompanionCommands, refreshCompanionCommands, releaseCompanionCommands } from './settings-wiring';
import { syncBodyModel, syncBodySelection } from './stage-body-wiring';
import { cancelPetDrag, closeWindowAuthoring, disposeSingleEmoji } from './stage-cleanup-wiring';
import { publishEmojiContext, syncSingleEmoji } from './stage-wiring';
import { releaseUnbound, syncUnbound } from './unbound-wiring';
import { disposeRouting } from './brain-cleanup-wiring';
import { checkVoiceCall, dropWindowSpeech, endVoiceCall, stopPlaybackActivity, stopSpeech } from './voice-cleanup-wiring';

/** wireHealth calls this once, before any list runs. */
export function wireStepUnits(): void {
  // 感知
  unitSteps('senses', 'ambient-audio', revokeAmbientOwner, releaseAmbientOwner, stopWatching);
  unitSteps('senses', 'media', revokeVisionOwner, clearClosedWindowVision, dropClosedMediaOwner, refreshVisionOnVisibility, stopVisionAndSound, syncVisionContext);
  unitSteps('senses', 'voice-host', revokeWindowVoiceInput, revokeHiddenVoiceInput);
  unitSteps('senses', 'system-audio', stopPetSystemAudio);
  unitSteps('senses', 'audio-capture', revokeAudioOwner, releaseCapture);
  unitSteps('senses', 'pose-sensing', holdForPoseInference, stopSensorProcesses);
  unitSteps('senses', 'foreground-asr', abortVoiceRecognition);
  unitSteps('senses', 'look-turns', disposeLook);
  unitSteps('senses', 'user-activity', flushUserActivity);
  unitSteps('senses', 'voice-route', syncVoiceScope);
  unitSteps('senses', 'proactive-vision', publishVisionActivity);
  // 连接任务和安全
  unitSteps('safety', 'claude-tasks', interruptOwnedTasks, releaseClaudeTasks);
  // 身体动作
  unitSteps('actions', 'motion-library', dropMotionWeightsOwner, cancelClosedWindowDownload, cancelMotionDownloads);
  // 声音
  unitSteps('voice', 'reply-speech', dropWindowSpeech);
  unitSteps('voice', 'voice-call', checkVoiceCall, endVoiceCall);
  unitSteps('voice', 'speech-playback', stopPlaybackActivity);
  unitSteps('voice', 'speech-runtime', stopSpeech);
  // 舞台
  unitSteps('stage', 'window-drag', cancelPetDrag);
  unitSteps('stage', 'personalize-authoring', closeWindowAuthoring);
  unitSteps('stage', 'single-emoji', disposeSingleEmoji, syncSingleEmoji, publishEmojiContext);
  unitSteps('stage', 'body-pose', syncBodyModel, syncBodySelection);
  // 设置
  unitSteps('settings', 'companion-commands', invalidateCompanionCommands, refreshCompanionCommands, releaseCompanionCommands);
  // 记忆
  unitSteps('memory', 'text-memorials', cancelPetMemorial, publishMemorials);
  unitSteps('memory', 'user-profiles', releaseProfile);
  unitSteps('memory', 'memory-notes', flushMemoryNotes);
  // 角色卡
  unitSteps('cards', 'personalize-language', closeLanguageAuthoring);
  // 主动
  unitSteps('initiative', 'r20-offers', disposeR20Offers, publishR20);
  unitSteps('initiative', 'rps', disposeGame);
  unitSteps('initiative', 'proactive-speech-gate', publishGateScope);
  // 心情
  unitSteps('mood', 'fatigue-activity', releaseFatigue, syncFatigue);
  unitSteps('mood', 'mood-judge', disposeMoodJudges, judgeMood);
  // Unbound
  unitSteps('unbound', 'unbound', releaseUnbound, syncUnbound);
  // 大脑 (its core steps, the chat turns and her conversation, are not listed; the module router is)
  unitSteps('brain', 'module-router', disposeRouting);
}
