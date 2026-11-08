import { t, registerUiMessages } from '../shared/ui-language';
// Context-specific setting words are not button labels. These static keys grant no action.
registerUiMessages({
  en: { 'command.setting.on': 'enabled', 'command.setting.off': 'disabled', 'command.visibility.show': 'show', 'command.visibility.hide': 'hide' },
  'zh-CN': { 'command.setting.on': '开启', 'command.setting.off': '关闭', 'command.visibility.show': '显示', 'command.visibility.hide': '隐藏' },
});
import type {
  CompanionCommandAction,
  CompanionCommandCandidate,
  CompanionCommandIntentInput,
  CompanionCommandReceipt,
} from '../shared/companion-commands';
import { scanBreathRequest } from '../shared/breath-request';
import { scanFramingRequest } from '../shared/framing-request';
import { scanAlwaysOnTopRequest } from './scan-always-on-top.js';
import { scanPetVisibilityRequest } from './scan-pet-visibility-request';
import { scanFollowMouseRequest } from './scan-follow-mouse-request';
import { scanReadoutVolumeRequest } from './scan-readout-volume-request';
import { scanStopReadoutRequest } from '../shared/stop-readout-request';

const action = (value: boolean): CompanionCommandAction => ({
  actionId: 'pet.set-always-on-top', parameters: { value },
});
const visibilityAction = (value: boolean): CompanionCommandAction => ({
  actionId: 'pet.set-visible', parameters: { value },
});
const followMouseAction = (value: boolean): CompanionCommandAction => ({
  actionId: 'pet.set-follow-mouse', parameters: { value },
});

/** Called on Main's accepted current literal human text only. Output is a hint,
 * never an authorization, reusable confirmation, executor or choice ticket. */
export function classifyCompanionCommand(input: CompanionCommandIntentInput): CompanionCommandCandidate {
  if (!input || typeof input.requestId !== 'string' || !input.requestId
      || typeof input.contextId !== 'string' || !input.contextId
      || typeof input.currentValue !== 'boolean') return { kind: 'none' };
  const breath = scanBreathRequest(input.text);
  if (breath.kind !== 'none') {
    if (typeof input.currentBreath !== 'number' || !Number.isFinite(input.currentBreath) || input.currentBreath < 0 || input.currentBreath > 1) return { kind: 'none' };
    const strength = (value: number | true): CompanionCommandAction => ({ actionId: 'pet.set-breath', parameters: { value } });
    if (breath.kind === 'off') return { kind: 'explicit', action: strength(0) };
    if (breath.kind === 'percent') return { kind: 'explicit', action: strength(breath.percent) };
    if (breath.kind === 'on' && input.currentBreath > 0) return { kind: 'explicit', action: strength(true) };
    return { kind: 'clarify', prompt: breath.kind === 'on'
      ? t('当前呼吸强度为0。要将强度设为50%并开启吗？不会恢复过去的强度。')
      : t('要将呼吸强度设为多少？请选择具体设置，或取消后说明0%到100%的整数百分比。'),
      choices: (breath.kind === 'on' ? [50] : [0, 50]).map(value => ({
        label: value === 0 ? t('将呼吸强度设为0%并关闭') : t('将呼吸强度设为50%并开启'), action: strength(value) })) };
  }
  if (/呼吸|\bbreathing\b/iu.test(input.text)) return { kind: 'none' };
  const framing = scanFramingRequest(input.text);
  if (framing !== 'none') {
    const frame = (value: 'full' | 'portrait'): CompanionCommandAction => ({ actionId: 'pet.frame', parameters: { value } });
    return framing !== 'ambiguous' ? { kind: 'explicit', action: frame(framing) }
      : { kind: 'clarify', prompt: t('要将当前桌宠切换为哪种取景？只调整镜头，窗口和动作保持原样。'), choices: [
        { label: t('当前桌宠全身取景'), action: frame('full') }, { label: t('当前桌宠近景取景'), action: frame('portrait') },
      ] };
  }
  const stop = scanStopReadoutRequest(input.text);
  if (stop !== 'none') {
    const stopAction = { actionId: 'voice.stop-readout', parameters: { value: true } } as const;
    return stop === 'explicit' ? { kind: 'explicit', action: stopAction }
      : { kind: 'clarify', prompt: t('要停止当前这一次回复朗读吗？文字、朗读开关和其他声音保持不变。'),
        choices: [{ label: t('只停止当前这次回复朗读'), action: stopAction }] };
  }
  const volume = scanReadoutVolumeRequest(input.text);
  if (volume.kind !== 'none') {
    if (!Number.isFinite(input.currentReadoutVolume) || input.currentReadoutVolume! < 0 || input.currentReadoutVolume! > 1) return { kind: 'none' };
    const volumeAction = (value: number): CompanionCommandAction => ({ actionId: 'voice.set-volume', parameters: { value } });
    if (volume.kind === 'explicit') return { kind: 'explicit', action: volumeAction(volume.percent) };
    const current = Math.round(input.currentReadoutVolume! * 100);
    const values = volume.kind === 'ambiguous' && volume.percent !== undefined ? [volume.percent]
      : volume.kind === 'ambiguous' && volume.direction
        ? [10, 20].map(step => Math.max(0, Math.min(100, current + (volume.direction === 'down' ? -step : step))))
        : [40, 60];
    return { kind: 'clarify', prompt: volume.kind === 'invalid'
      ? t('朗读音量只能设为 0% 到 100% 的整数。请选择具体音量，或取消后重新说明。')
      : t('要将后续朗读的音量设为多少？确认后只保存朗读音量。'),
    choices: [...new Set(values)].map(value => ({ label: t("将朗读音量设为 {0}%", { 0: value }), action: volumeAction(value) })) };
  }
  // Unsupported or compound audio requests cannot fall through to another setting domain.
  if (/朗读|播报|音量|声音|\b(?:volume|readout|tts)\b/iu.test(input.text)) return { kind: 'none' };
  const followMouse = scanFollowMouseRequest(input.text);
  if (followMouse !== 'none') {
    if (typeof input.currentFollowMouse !== 'boolean') return { kind: 'none' };
    if (followMouse === 'on' || followMouse === 'off')
      return { kind: 'explicit', action: followMouseAction(followMouse === 'on') };
    return { kind: 'clarify', prompt: t('要开启还是关闭桌宠的鼠标视线跟随设置？'), choices: [
      { label: t('开启桌宠鼠标视线跟随设置'), action: followMouseAction(true) },
      { label: t('关闭桌宠鼠标视线跟随设置'), action: followMouseAction(false) },
    ] };
  }
  // No other domain may extract a supported substring from an unsupported mouse request.
  if (/(?:鼠标|\bmouse\b)/iu.test(input.text)) return { kind: 'none' };
  const visibility = scanPetVisibilityRequest(input.text);
  if (visibility !== 'none') {
    if (typeof input.currentVisible !== 'boolean') return { kind: 'none' };
    // The bounded scanner may retain a visibility hint from a compound request;
    // this turn still offers only one fixed action domain, never two executions.
    const compound = /置顶|\bon top\b/iu.test(input.text);
    if (!compound && (visibility === 'show' || visibility === 'hide'))
      return { kind: 'explicit', action: visibilityAction(visibility === 'show') };
    const show = { label: t('显示当前桌宠窗口'), action: visibilityAction(true) };
    const hide = { label: t('隐藏当前桌宠窗口'), action: visibilityAction(false) };
    const prompt = compound
      ? t('你同时提到了显隐和置顶。本次先选择显示还是隐藏桌宠；置顶请另行说明。')
      : t('你想显示当前桌宠窗口，还是隐藏当前桌宠窗口？');
    return { kind: 'clarify', prompt, choices: visibility === 'hide' ? [hide, show] : [show, hide] };
  }
  const hint = scanAlwaysOnTopRequest(input.text);
  if (hint === 'none') return { kind: 'none' };
  if (hint === 'on' || hint === 'off') return { kind: 'explicit', action: action(hint === 'on') };

  const obstruction = /挡|压在|block/iu.test(input.text);
  const prompt = obstruction
    ? (input.currentValue ? t('你是想取消桌宠置顶，还是继续保持置顶？') : t('要调整桌宠的置顶状态吗？目前置顶设置已关闭。'))
    : t('你想让当前桌宠保持置顶，还是取消置顶？');
  const on = { label: input.currentValue ? t('继续保持桌宠置顶') : t('让桌宠保持置顶'), action: action(true) };
  const off = { label: input.currentValue ? t('取消桌宠置顶') : t('保持桌宠不置顶'), action: action(false) };
  return { kind: 'clarify', prompt, choices: input.currentValue ? [off, on] : [on, off] };
}

const unknownResult = '无法确认这次置顶操作的结果，请查看当前设置。';
const unknownVisibility = '无法确认这次桌宠显示或隐藏的结果，请查看当前窗口状态。';
const unknownFollowMouse = '无法确认鼠标视线跟随设置的结果，请查看当前设置。';
const unknownVolume = '暂时无法确认朗读音量是否保存，请查看当前设置。';

function formatVolumeReceipt(receipt: CompanionCommandReceipt): string {
  if (Object.prototype.hasOwnProperty.call(receipt, 'nativeValue')) return t(unknownVolume);
  if (receipt.status === 'saved' || receipt.status === 'unchanged') {
    if (receipt.persistence !== receipt.status || !Number.isInteger(receipt.value)
      || typeof receipt.value !== 'number' || receipt.value < 0 || receipt.value > 100) return t(unknownVolume);
    const saved = t("朗读音量已设为 {0}%，后续朗读会使用这个设置。", { 0: receipt.value });
    if (receipt.presentation === 'not-requested') return saved;
    if (receipt.presentation === 'unknown') return t("{0}界面同步结果尚未确认。", { 0: saved });
    if (receipt.presentation === 'failed') return t("{0}界面未能同步，请查看当前设置。", { 0: saved });
    return t(unknownVolume);
  }
  if (receipt.persistence !== 'not-committed') return t(unknownVolume);
  switch (receipt.status) {
    case 'cancelled': return t('已取消，这次没有修改朗读音量。');
    case 'expired': return t('这组选项已过期，请重新说明要设置的朗读音量。');
    case 'conflict': return t('朗读音量已发生变化，请重新选择。');
    case 'rejected': return t('未更改朗读音量，请确认聊天窗口已就绪。');
    case 'failed': return t('朗读音量未能保存，请查看当前设置。');
    default: return t(unknownVolume);
  }
}

function formatBreathReceipt(receipt: CompanionCommandReceipt): string {
  const unknown = t('无法确认呼吸强度是否保存，请查看当前设置。');
  if (Object.prototype.hasOwnProperty.call(receipt, 'nativeValue')) return unknown;
  if (receipt.status === 'saved' || receipt.status === 'unchanged') {
    if (receipt.persistence !== receipt.status || typeof receipt.value !== 'number' || !Number.isFinite(receipt.value) || receipt.value < 0 || receipt.value > 1) return unknown;
    const value = receipt.value === 0 ? t('呼吸设置已关闭（强度0%）') : t('呼吸设置已开启，当前强度为{0}%', { 0: String(receipt.value * 100) });
    const message = t(receipt.status === 'unchanged' ? '{0}，设置未变。' : '{0}。', { 0: value });
    if (receipt.presentation === 'not-requested') return message + t('可见效果仍受当前呈现状态控制。');
    if (receipt.presentation === 'unknown') return message + t('界面同步结果尚未确认。');
    return unknown;
  }
  if (receipt.persistence !== 'not-committed') return unknown;
  switch (receipt.status) {
    case 'cancelled': return t('已取消，这次没有修改呼吸强度。');
    case 'expired': return t('这组选项已过期，请重新说明呼吸强度。');
    case 'conflict': return t('呼吸强度已发生变化，请重新选择。');
    case 'rejected': return t('未更改呼吸强度，请确认当前桌宠与聊天窗口已就绪。');
    case 'failed': return t('呼吸强度未能保存，请查看当前设置。');
    default: return unknown;
  }
}
function formatFollowMouseReceipt(receipt: CompanionCommandReceipt): string {
  if (Object.prototype.hasOwnProperty.call(receipt, 'nativeValue')) return t(unknownFollowMouse);
  if (receipt.status === 'saved' || receipt.status === 'unchanged') {
    if (receipt.persistence !== receipt.status || typeof receipt.value !== 'boolean') return t(unknownFollowMouse);
    const setting = receipt.value ? t('command.setting.on') : t('command.setting.off');
    if (receipt.presentation === 'not-requested') return t("桌宠的鼠标视线跟随设置已{0}。", { 0: setting });
    if (receipt.presentation === 'unknown') return t("桌宠的鼠标视线跟随设置已{0}，但界面同步结果尚未确认。", { 0: setting });
    return t(unknownFollowMouse);
  }
  if (receipt.persistence !== 'not-committed') return t(unknownFollowMouse);
  switch (receipt.status) {
    case 'cancelled': return t('已取消这次鼠标视线跟随设置更改。');
    case 'expired': return t('这组选项已过期，请重新说明鼠标视线跟随设置。');
    case 'conflict': return t('鼠标视线跟随设置已发生变化，请重新选择。');
    case 'rejected': return t('未更改鼠标视线跟随设置，请确认桌宠窗口已就绪且可见。');
    case 'failed': return t('鼠标视线跟随设置未能保存，请查看当前设置。');
    default: return t(unknownFollowMouse);
  }
}

function formatVisibilityReceipt(receipt: CompanionCommandReceipt): string {
  if (receipt.status === 'saved' || receipt.status === 'unchanged') {
    if (receipt.persistence !== receipt.status || typeof receipt.value !== 'boolean') return t(unknownVisibility);
    const verb = receipt.value ? t('command.visibility.show') : t('command.visibility.hide');
    if (receipt.presentation === 'applied')
      return receipt.nativeValue === receipt.value ? t("桌宠窗口已{0}。", { 0: verb }) : t(unknownVisibility);
    const setting = receipt.status === 'saved' ? t("已保存{0}桌宠的设置", { 0: verb }) : t('桌宠的显示设置保持不变');
    if (receipt.presentation === 'failed') return t("{0}，但窗口{1}未能同步。", { 0: setting, 1: verb });
    if (receipt.presentation === 'unknown' || receipt.presentation === 'not-requested')
      return t("{0}，实际窗口状态尚未确认。", { 0: setting });
    return t(unknownVisibility);
  }
  if (receipt.persistence !== 'not-committed') return t(unknownVisibility);
  switch (receipt.status) {
    case 'cancelled': return t('已取消这次桌宠显示或隐藏操作。');
    case 'expired': return t('这组选项已过期，请重新说明要显示还是隐藏桌宠。');
    case 'conflict': return t('桌宠的显示设置已发生变化，请重新选择。');
    case 'rejected': return t('未执行这次桌宠显示或隐藏操作，请确认现有桌宠窗口已就绪。');
    case 'failed': return t('桌宠显示设置未能保存，请查看当前设置。');
    default: return t(unknownVisibility);
  }
}

/** Main must supply its actual receipt after the host operation. This formatter
 * never consumes model prose or renderer receipt-shaped data as authority. It
 * deliberately ignores receipt.message to avoid exposing diagnostic contents. */
export function formatCompanionCommandReceipt(receipt: CompanionCommandReceipt): string {
  if (receipt?.actionId === 'pet.frame') {
    const unknown = t('这次取景的应用或保存结果尚未确认，请查看当前镜头。');
    if (Object.hasOwn(receipt, 'nativeValue')) return unknown;
    const name = receipt.value === 'full' ? t('全身取景') : receipt.value === 'portrait' ? t('近景取景') : null;
    if ((receipt.status === 'saved' || receipt.status === 'unchanged') && receipt.persistence === receipt.status && name) {
      if (receipt.presentation === 'applied') return receipt.status === 'saved' ? t('{0}已应用并保存。', { 0: name }) : t('{0}已应用，镜头设置无变化。', { 0: name });
      if (receipt.presentation === 'failed') return t('{0}设置已保存，但当前镜头未能应用。', { 0: name });
      return t('{0}设置已保存，当前镜头应用结果尚未确认。', { 0: name });
    }
    if (receipt.persistence === 'unknown') return receipt.presentation === 'applied' ? t('取景已应用，但保存结果尚未确认，请查看当前镜头。') : unknown;
    if (receipt.persistence !== 'not-committed') return unknown;
    if (receipt.presentation === 'applied') return t('取景已应用，但未能确认保存；不会恢复或覆盖后来的手动镜头。');
    if (receipt.status === 'cancelled') return t('已取消，这次没有调整取景。');
    if (receipt.status === 'expired' || receipt.status === 'conflict') return t('镜头或目标已变化，请重新说明取景。');
    if (receipt.status === 'rejected') return t('当前桌宠尚未就绪或不可见，未执行取景。');
    return receipt.presentation === 'unknown' ? unknown : t('取景未能完成，请确认桌宠模型已就绪。');
  }
  if (receipt && typeof receipt === 'object' && receipt.actionId === 'voice.stop-readout') {
    const unknown = t('这次朗读停止结果尚未确认，未更改朗读设置。');
    if (receipt.persistence !== 'not-committed' || Object.hasOwn(receipt, 'value') || Object.hasOwn(receipt, 'nativeValue')) return unknown;
    if (receipt.status === 'stopped' && receipt.effect === 'stopped') return t('已停止本次回复朗读，朗读设置保持不变。');
    if (receipt.status === 'no-current' && receipt.effect === 'no-current') return t('当前没有可停止的回复朗读，朗读设置保持不变。');
    if (receipt.status === 'cancelled') return t('已取消这次停止操作，未更改朗读设置。');
    if (receipt.status === 'expired' || receipt.status === 'conflict') return t('原来的朗读目标已变化，这次未执行停止。请重新说明。');
    return unknown;
  }
  if (receipt && typeof receipt === 'object' && receipt.actionId === 'voice.set-volume') return formatVolumeReceipt(receipt);
  if (receipt && typeof receipt === 'object' && receipt.actionId === 'pet.set-breath') return formatBreathReceipt(receipt);
  if (receipt && typeof receipt === 'object' && receipt.actionId === 'pet.set-follow-mouse') return formatFollowMouseReceipt(receipt);
  if (receipt && typeof receipt === 'object' && receipt.actionId === 'pet.set-visible') return formatVisibilityReceipt(receipt);
  if (receipt && typeof receipt === 'object' && receipt.actionId !== undefined && receipt.actionId !== 'pet.set-always-on-top')
    return t('无法确认这次桌宠操作的结果，请查看当前设置。');
  if (!receipt || typeof receipt !== 'object') return t(unknownResult);
  if (receipt.status === 'saved' || receipt.status === 'unchanged') {
    const expected = receipt.status === 'saved' ? 'saved' : 'unchanged';
    if (receipt.persistence !== expected || typeof receipt.value !== 'boolean') return t(unknownResult);
    const setting = receipt.value ? t('command.setting.on') : t('command.setting.off');
    if (receipt.presentation === 'failed') return t("桌宠置顶设置已{0}，但窗口显示未能同步。", { 0: setting });
    if (receipt.presentation === 'unknown') return t("桌宠置顶设置已{0}，窗口显示结果尚未确认。", { 0: setting });
    if (receipt.presentation === 'not-requested') return t("桌宠置顶设置已{0}。", { 0: setting });
    if (receipt.presentation !== 'applied') return t(unknownResult);
    if (receipt.status === 'unchanged') return receipt.value ? t('桌宠已经保持置顶。') : t('桌宠已经取消置顶。');
    return receipt.value ? t('已让桌宠保持置顶。') : t('已取消桌宠置顶。');
  }
  if (receipt.persistence !== 'not-committed') return t(unknownResult);
  switch (receipt.status) {
    case 'cancelled': return t('已取消这次置顶操作。');
    case 'expired': return t('这组选项已过期，请重新说明要保持还是取消桌宠置顶。');
    case 'conflict': return t('置顶设置已发生变化，请重新选择。');
    case 'rejected': return t('未执行这次置顶操作。');
    case 'failed': return t('置顶设置未能保存，请查看当前设置。');
    default: return t(unknownResult);
  }
}
