// Unbound v1 step 3 「只认你的声音」 (docs/claude/2026-11-17-unbound-step3.md): the control window's switch under the local recognizer, with
// the plain-words explanation, recording the sample (hold T and say a few sentences), one-click delete, removing the model, and the
// last clip's state ("can't confirm" is said, never guessed). Everything shown is host states and counts turned into fixed copy.
import { uiText, uiTemplate } from '../foundation/ui-language';
import { registerUiMessages } from '../../shared/foundation/ui-language';
import { voiceCheckLine, type VoiceprintNotice, type VoiceprintView } from '../../shared/senses/voiceprint';

registerUiMessages({ 'zh-CN': {}, en: {
  '只认你的声音': 'Only your voice',
  '打开后，她只把你的声音当成在跟她说话：旁边别人说话、视频里的人声，明显不是你时她不听，也不会转成文字。拿不准、太短、太吵时都当成是你，并在下面说一声。她出来（Unbound）时，叫她的名字就能开始通话。':
    'When on, she takes only your voice as talking to her: someone nearby or a voice in a video that is clearly not you is not listened to and never becomes text. When unsure, too short or too noisy it counts as you, and the line below says so. When she is out (Unbound), calling her name starts a call.',
  '只记你自己的声音，记的是一串数字，不是录音；只存在这台电脑上，加密保存，随时一键删除，关「允许记录」也会删掉。不发给任何模型。默认关闭；第一次打开要下载约 {0} MB 的声纹模型。':
    'Only your own voice is kept, as a list of numbers, not a recording; only on this computer, encrypted, deletable with one click, and turning “Allow recording” off deletes it too. It is never sent to any model. Off by default; the first time it downloads a voiceprint model of about {0} MB.',
  '录我的声音': 'Record my voice', '重新录': 'Record again', '取消': 'Cancel', '重试下载': 'Retry download', '删除我的声纹': 'Delete my voiceprint', '删除声纹模型': 'Delete the voiceprint model',
  '正在下载声纹模型… {0}%': 'Downloading the voiceprint model… {0}%', '正在校验和安装…': 'Verifying and installing…',
  '要先装好本机语音识别（或姿势识别），它的运行库会被复用；这里不会另外下载。': 'Install local speech recognition (or pose sensing) first; its runtime is reused. Nothing else is downloaded here.',
  '还没录你的声音。打开语音输入，点「录我的声音」，然后按住 T 说几句话（每句两三秒以上，平常的音量）。': 'Your voice is not recorded yet. Turn voice input on, click “Record my voice”, then hold T and say a few sentences (two or three seconds or more each, at your normal volume).',
  '正在录：已经 {0}/{1} 句、{2}/{3} 秒。按住 T 接着说。': 'Recording: {0}/{1} sentences, {2}/{3} seconds so far. Hold T and keep going.',
  '已录好（{0} 句，{1} 秒）。': 'Recorded ({0} sentences, {1} seconds).',
  '这句太短或太吵，没算进去，再说一句吧。': 'That one was too short or too noisy and did not count. Say another one.',
  '这句没能算出来，再说一句吧。': 'That one could not be used. Say another one.',
  '录好了。': 'Done.', '这台电脑没有可用的加密存储，所以不录（不会明文保存）。': 'This computer has no secure storage available, so nothing is recorded (it is never saved in the clear).',
  '已删除你的声纹，开关已关。': 'Your voiceprint was deleted and the switch is off.', '下载没完成，要重试吗？': 'The download did not finish. Try again?',
  '下载的文件没通过校验，已丢弃。要重试吗？': 'A downloaded file failed verification and was discarded. Try again?', '已删除声纹模型。': 'The voiceprint model was deleted.',
  '声纹没能正常运行，先停了。关掉再打开开关可以重试。': 'The voiceprint could not run properly and stopped. Turn the switch off and on to retry.',
  '刚才那句：是你。': 'Last sentence: you.', '刚才那句：拿不准，按是你算。': 'Last sentence: not sure, counted as you.',
  '刚才那句：明显不是你的声音，她没有听。': 'Last sentence: clearly not your voice; she did not listen.',
  '刚才那句：太短，确认不了是不是你（按是你算）。': 'Last sentence: too short to tell whether it was you (counted as you).',
  '刚才那句：太吵，确认不了是不是你（按是你算）。': 'Last sentence: too noisy to tell whether it was you (counted as you).',
  '刚才那句：像是几个人的声音混在一起，确认不了是不是你（按是你算）。': 'Last sentence: several voices seem mixed, so it cannot tell whether it was you (counted as you).',
  '刚才那句：确认不了是不是你（按是你算）。': 'Last sentence: cannot tell whether it was you (counted as you).',
} });

const NOTICE: Record<Exclude<VoiceprintNotice, ''>, string> = {
  'download-failed': '下载没完成，要重试吗？', 'verify-failed': '下载的文件没通过校验，已丢弃。要重试吗？', removed: '已删除声纹模型。',
  failed: '声纹没能正常运行，先停了。关掉再打开开关可以重试。', enrolled: '录好了。', 'no-encryption': '这台电脑没有可用的加密存储，所以不录（不会明文保存）。',
  deleted: '已删除你的声纹，开关已关。', 'needs-runtime': '要先装好本机语音识别（或姿势识别），它的运行库会被复用；这里不会另外下载。',
  'enrol-skipped': '这句太短或太吵，没算进去，再说一句吧。', 'enrol-failed': '这句没能算出来，再说一句吧。',
};

export function voiceprintExplainText(view: Pick<VoiceprintView, 'downloadBytes'>): string {
  return uiText('打开后，她只把你的声音当成在跟她说话：旁边别人说话、视频里的人声，明显不是你时她不听，也不会转成文字。拿不准、太短、太吵时都当成是你，并在下面说一声。她出来（Unbound）时，叫她的名字就能开始通话。') + ' '
    + uiTemplate`只记你自己的声音，记的是一串数字，不是录音；只存在这台电脑上，加密保存，随时一键删除，关「允许记录」也会删掉。不发给任何模型。默认关闭；第一次打开要下载约 ${Math.max(1, Math.round(view.downloadBytes / 1_000_000))} MB 的声纹模型。`;
}

export function voiceprintStatusText(view: VoiceprintView): string {
  if (view.phase === 'unsupported' || !view.enabled) return '';
  if (view.phase === 'downloading') return uiTemplate`正在下载声纹模型… ${Math.round((view.progress ?? 0) * 100)}%`;
  if (view.phase === 'installing') return uiText('正在校验和安装…');
  if (view.phase === 'needs-runtime') return uiText(NOTICE['needs-runtime']);
  if (view.phase === 'not-installed') return '';
  if (view.enrolling) return uiTemplate`正在录：已经 ${view.enrolling.clips}/${view.enrolling.needClips} 句、${view.enrolling.seconds}/${view.enrolling.needSeconds} 秒。按住 T 接着说。`;
  if (!view.enrolled) return uiText('还没录你的声音。打开语音输入，点「录我的声音」，然后按住 T 说几句话（每句两三秒以上，平常的音量）。');
  return [uiTemplate`已录好（${view.enrolled.clips} 句，${view.enrolled.seconds} 秒）。`, view.lastCheck ? uiText(voiceCheckLine(view.lastCheck)) : ''].filter(Boolean).join(' ');
}

export interface VoiceprintPorts {
  get(): Promise<VoiceprintView>;
  changed(callback: (view: VoiceprintView) => void): () => void;
  set(on: boolean): Promise<VoiceprintView>;
  retry(): Promise<VoiceprintView>;
  enrol(): Promise<VoiceprintView>;
  cancelEnrol(): Promise<VoiceprintView>;
  deleteData(): Promise<VoiceprintView>;
  remove(): Promise<VoiceprintView>;
  error(message: string): void;
}

export class VoiceprintPanel {
  private view: VoiceprintView | null = null;
  private busy = false;
  constructor(private readonly root: HTMLElement, private readonly ports: VoiceprintPorts) {
    root.classList.add('voiceprint-panel');
    ports.changed(view => { this.view = view; this.render(); });
    void ports.get().then(view => { this.view = view; this.render(); }, () => { this.root.hidden = true; });
  }

  private async run(action: () => Promise<VoiceprintView>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.render();
    try { this.view = await action(); }
    catch (problem) { this.ports.error(problem instanceof Error ? problem.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(problem)); }
    finally { this.busy = false; this.render(); }
  }

  private render(): void {
    const view = this.view, root = this.root;
    root.replaceChildren();
    if (!view || view.phase === 'unsupported') { root.hidden = true; return; }
    root.hidden = false;
    const label = document.createElement('label');
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = view.enabled; box.disabled = this.busy;
    box.onchange = () => void this.run(() => this.ports.set(box.checked));
    label.append(box, document.createTextNode(' ' + uiText('只认你的声音')));
    const explain = document.createElement('small'); explain.className = 'hint'; explain.textContent = voiceprintExplainText(view);
    root.append(label, explain);
    const status = voiceprintStatusText(view), notice = view.notice && view.notice !== 'needs-runtime' ? uiText(NOTICE[view.notice]) : '';
    for (const text of [status, notice]) if (text) { const line = document.createElement('p'); line.className = 'hint'; line.setAttribute('role', 'status'); line.textContent = text; root.append(line); }
    const tools = document.createElement('div'); tools.className = 'row';
    const button = (text: string, action: () => Promise<VoiceprintView>) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'subtle'; b.textContent = uiText(text); b.disabled = this.busy; b.onclick = () => void this.run(action); tools.append(b); };
    const installed = view.phase === 'idle' || view.phase === 'ready' || view.phase === 'starting';
    if (view.enabled && installed && !view.enrolling) button(view.enrolled ? '重新录' : '录我的声音', () => this.ports.enrol());
    if (view.enrolling) button('取消', () => this.ports.cancelEnrol());
    if (view.enabled && (view.notice === 'download-failed' || view.notice === 'verify-failed')) button('重试下载', () => this.ports.retry());
    if (view.enrolled) button('删除我的声纹', () => this.ports.deleteData());
    if (installed) button('删除声纹模型', () => this.ports.remove());
    if (tools.childElementCount) root.append(tools);
  }
}
