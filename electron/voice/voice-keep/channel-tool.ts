// The user's own Claude can switch the keep-her-voice tool on and off through the dev build's internal channel. Turning it ON keeps her voice on the user's disk, so it is a privacy setting: the call needs the user's own words and the
// soft hearts dialog (alwaysConfirmFor), exactly like turning on the microphone. Turning it OFF and reading the state are direct. The days and
// 清空 are the control window's (the user's own clicks); the channel never deletes anything.
// The tool and its descriptor exist only where the host is given (dev builds, source runs); the shared catalog and the handbook do not list it,
// so the user's Claude on the stable build never sees it. It lists no path: the folder is opened only by the user's button.
import type { AgentToolDescriptor } from '../../../shared/safety';
import { AgentToolError, argsObject, type AgentToolDefinition } from '../../safety';
import type { VoiceKeepView } from '../../../shared/voice/voice-keep';
import type { VoiceKeepHost } from './host';
import { ASSISTANT_NAME } from '../../../shared/foundation/assistant-name';

export const VOICE_KEEP_TOOL = 'voice_keep';
export const VOICE_KEEP_TITLE = '保存她念出来的声音（开发版）';
const MB = 1024 * 1024;

export const VOICE_KEEP_DESCRIPTOR: AgentToolDescriptor = {
  name: VOICE_KEEP_TOOL, title: VOICE_KEEP_TITLE, tier: 'reversible',
  description: '只在开发版有。把她念出来的每一句话的声音（百炼、Drama 3 返回的音频）存在用户这台电脑上，用来和别的声音比对，不发给任何地方，也不交给任何模型。'
    + '打开它是隐私操作：需要用户原话（userWords），soft hearts 还会弹窗由用户点；关闭和只看状态（不带 on）直接做。保存天数（1～30，默认 7，过期自动删）和清空只能在控制窗口的开发区里由用户自己点。系统语音录不下来，不保存。',
  inputSchema: { type: 'object', properties: { on: { type: 'boolean', description: 'true 打开保存，false 关闭；不填只返回状态。' },
    userWords: { type: 'string', description: '打开时必填：用户在对话里说的原话，原样填入。' } }, additionalProperties: false },
};

interface Prepared { on: boolean | null }
function plain(view: VoiceKeepView): Record<string, unknown> {
  return { on: view.on, days: view.days, keptSentences: view.sentences, keptMegabytes: Math.round(view.bytes / MB), stoppedBecauseFull: view.capped,
    capMegabytes: Math.round(view.capBytes / MB), note: '只存她自己念出来的声音（云端语音），不存麦克风和用户的声音；系统语音存不了。' };
}

export function voiceKeepChannelTool(host: () => VoiceKeepHost | null): { tool: AgentToolDefinition<any, any>; descriptor: AgentToolDescriptor } {
  const tool: AgentToolDefinition<Prepared, Prepared> = {
    name: VOICE_KEEP_TOOL, title: VOICE_KEEP_TITLE, tier: 'reversible',
    validate: raw => {
      const args = argsObject(raw, ['on']);
      if (args.on !== undefined && typeof args.on !== 'boolean') throw new AgentToolError('invalid_input', 'on 只接受 true 或 false。');
      return { on: (args.on as boolean | undefined) ?? null };
    },
    prepare: input => {
      if (!host()?.available) throw new AgentToolError('unavailable', '这个版本没有这个功能。');
      return input;
    },
    // Opening it is privacy: words, and the dialog as well even with 三方互通 on. Closing and reading stay direct.
    tierFor: prepared => prepared.on === true ? 'confirm' : 'reversible',
    alwaysConfirmFor: prepared => prepared.on === true,
    confirmation: () => ({ title: `${ASSISTANT_NAME} 请求保存她念出来的声音`,
      detail: '打开后，她念出来的每一句话的声音都会存在这台电脑上（只有云端语音：百炼、Drama 3），用来和别的声音比对。\n不会发给任何地方，也不会交给任何模型；不录麦克风，不录你的声音。\n默认留 7 天，过期自动删；你可以随时在控制窗口的开发区关掉、清空或改天数。' }),
    noticeDetail: prepared => prepared.on === true ? '开始保存她念出来的声音' : prepared.on === false ? '停止保存她念出来的声音' : '查看保存状态',
    wordsItem: prepared => ({ item: VOICE_KEEP_TOOL, value: prepared.on }),
    run: async prepared => {
      const current = host();
      if (!current?.available) throw new AgentToolError('unavailable', '这个版本没有这个功能。');
      return plain(prepared.on === null ? current.view() : await current.setOn(prepared.on));
    },
  };
  return { tool, descriptor: VOICE_KEEP_DESCRIPTOR };
}
