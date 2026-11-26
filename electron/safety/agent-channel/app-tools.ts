// The internal channel's tools: what the user's own Claude can read and do in soft hearts (MCP, 三方互通). This file is the index:
// createAppTools builds the one list of tools, in a fixed order (APP_TOOL_ORDER), from the slices in ./tools/, and the names other
// files import are re-exported here, so no importer changed when it was split (docs/claude/2026-11-17-app-tools-split.md). Each
// handler calls an existing host path through AgentAppBridge (./tools/app-bridge.ts); nothing here touches windows, files or settings
// directly except reading the one file the user confirmed.
//
// A NEW TOOL (or a changed one), for the next Claude:
//   1. Put it in the slice of its area, ./tools/<area>.ts: status, characters, settings (setting-values has no tools), handbook, voice
//      (voice-spend has no tools: what paid voices cost and read as), stage, senses, memory. A new area is a new slice file and one line in SLICES. Add its name to APP_TOOL_ORDER and its catalog
//      entry (name, title, tier, description, input schema) to shared/safety/agent-channel-catalog.json.
//   2. Decide its tier on purpose and say why in a comment next to it: 'read' changes nothing; 'reversible' changes something the user
//      can take back (offer it with context.offerUndo); 'confirm' needs the user's words with 三方互通 on and the dialog with it off.
//      Sensitive ones (privacy, spending money or the user's Claude usage, deleting, downloading or loading files) also get alwaysConfirm
//      (or alwaysConfirmFor) and a place in AGENT_ALWAYS_DIALOG_TOOLS (shared/safety/agent-channel.ts): the dialog even with the user's
//      words (CLAUDE.md 敏感操作弹窗). A file tool sets touchesFiles. Keys, running commands, arbitrary files, other permissions and
//      permanent deletion are never exposed (neverExposed in the catalog). Lowering a tier is loosening a safety limit: the user decides.
//   3. Give it calls in tests/helpers/app-tools-world.ts (samplesFor), regenerate the golden
//      (node node_modules/tsx/dist/cli.mjs scripts/dev/app-tools-golden.ts --write) and read its diff before committing, and add its
//      gates to scripts/dev/mutations/safety.json (its tier lowered, its dialog dropped, its undo dropped): each must fail a test.
import type { AgentToolDefinition } from './registry';
import type { AgentAppBridge } from './tools/app-bridge';
import { createToolContext, type AppToolOptions } from './tools/common';
import { statusTools } from './tools/status';
import { characterTools } from './tools/characters';
import { settingTools } from './tools/settings';
import { handbookTools } from './tools/handbook';
import { voiceTools } from './tools/voice';
import { stageTools } from './tools/stage';
import { senseTools } from './tools/senses';
import { memoryTools } from './tools/memory';

export type {
  AgentAppBridge, AgentMemoryBridge, AgentSongBridge, CommitResult, HostSettingFacts, LatencyNumbers, PerceptionFacts, PerceptionKind, SystemAudioPurpose, WindowFacts,
} from './tools/app-bridge';
export type { AppToolOptions } from './tools/common';
export {
  ASR_MODEL_BYTES, VOICE_CALL_ON_TEXT, VOICE_INPUT_ON_TEXT, componentValue, localAsrDownloadText, localAsrValue, poseDownloadText, realerEmotionsConfirmation,
  realerEmotionsConfirmationFor, realerEmotionsInformation, settingDetail, settingExtras, settingNeedsConsent, settingViews,
} from './tools/setting-values';
export type { SettingCards, SettingExtras } from './tools/setting-values';
export { voiceStyleArgs, voiceStyleOf, withVoiceStyle } from './tools/voice';
export type { VoiceStyle, VoiceStylePatch } from './tools/voice';
export { FACE_CHECK_CONSENT } from './tools/senses';
export { handbookRequest } from './tools/handbook';

/** Every slice; each makes its tools from the one shared context. */
const SLICES = [statusTools, characterTools, settingTools, handbookTools, voiceTools, stageTools, senseTools, memoryTools];

/** Every tool, in the order createAppTools returns them (the order they had before the split). */
const APP_TOOL_ORDER: readonly string[] = [
  'get_status', 'get_her_state', 'list_characters', 'list_settings', 'read_handbook', 'get_diagnostics', 'activate_character', 'set_read_aloud',
  'set_setting', 'play_preview', 'list_model_capabilities', 'set_model_capability', 'try_model_capability', 'play_her_action',
  'set_reaction_dispositions', 'show_pet', 'open_control_page', 'set_voice_style', 'set_perception', 'import_character_card',
  'update_character_card', 'load_model', 'bind_current_model_to_character', 'voice_preview', 'recover_pet', 'use_bundled_model',
  'unbind_character_model', 'create_character_for_current_model', 'delete_memories', 'clear_song_memory', 'list_recycle_bin', 'restore_memories',
  'delete_character', // I-173
  'set_character_voice', // 2026-11-24: any character's own voice provider (a paid one: the user's words and the dialog)
];

export function createAppTools(bridge: AgentAppBridge, options: AppToolOptions = {}): AgentToolDefinition[] {
  const context = createToolContext(bridge, options);
  const made = new Map<string, AgentToolDefinition<any, any>>();
  for (const slice of SLICES) for (const tool of slice(context)) {
    // A name made twice fails here, as the registry would refuse it (Duplicate agent tool).
    if (made.has(tool.name)) throw Error(`Duplicate agent tool: ${tool.name}`);
    made.set(tool.name, tool);
  }
  const tools = APP_TOOL_ORDER.map(name => {
    const tool = made.get(name);
    if (!tool) throw Error(`app-tools: ${name} is in APP_TOOL_ORDER but no slice makes it`);
    made.delete(name);
    return tool;
  });
  if (made.size) throw Error(`app-tools: ${[...made.keys()].join(', ')} made by a slice but not in APP_TOOL_ORDER`);
  return tools;
}
