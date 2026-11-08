import { uiText, uiTemplate } from './ui/ui-language';
import type { AudioReadingRefusal, CameraRefusal, VoiceRefusal } from '../shared/contracts';
import { VOICE_INPUT_FAILURES, type VoiceInputFailure } from '../shared/speech-failure';
export type NoticeAction = 'voice-setup' | `camera-${CameraRefusal}` | `voice-${VoiceRefusal | VoiceInputFailure}` | `reading-${AudioReadingRefusal}`;
export const NOTICE_ACTIONS: Readonly<Record<NoticeAction,string>> = Object.freeze({
  'voice-setup':'语音需要连接服务，请在“连接与声音”查看设置说明。',
  // Shown in the window where the 「姿势识别」 switch was clicked (2026-11-03: the pet button looked dead; I-036: the camera's
  // two switches, a refused 「姿势识别」 never turns 「发图片」 on instead).
  'camera-needs-component':'姿势识别要先下载本地识别组件（只在这台电脑上运行），在控制窗口的「隐私」页点「下载」就好。「发图片」不用下载。',
  'camera-preparing':'本地识别组件还在下载或安装，好了再打开姿势识别。',
  'camera-unavailable':'姿势识别这会儿开不了：本地识别没能准备好，也不会自动改成发图片。重启软件再试试；想让我看看你，可以打开「发图片」或用「拍一张给她看」。',
  // Voice input: why it did not turn on, or why it turned off.
  'voice-needs-component':'想让我听见你说话，要先下载本机识别组件（只在这台电脑上运行，声音不会离开电脑）。在控制窗口的「连接与声音」→「语音输入」点「下载」就好。',
  'voice-preparing':'本机识别组件还在下载或安装，好了再打开语音输入，我就能听见你了。',
  'voice-unavailable':'这台电脑上用不了本机识别。想用语音，可以在「连接与声音」→「语音输入」改用兼容接口地址。',
  'voice-local-failed':'刚才本机识别出了点问题，我没听清，就先把语音输入关了。再打开试试；还不行的话重启一下软件。',
  'voice-unreachable':'我连不上你设置的识别服务，现在听不到你说话，就先把语音输入关了。可以在「连接与声音」→「语音输入」改用「本机自带识别」。',
  'voice-service':'识别服务回了一个错误，我没听清，就先把语音输入关了。去「连接与声音」→「语音输入」看看地址和模型对不对。',
  'voice-timeout':'识别等了太久没有回音，我没听清，就先把语音输入关了。过一会儿再打开试试。',
  'voice-other':'刚才没听清，就先把语音输入关了。再打开试试。',
  // the two notes that do not turn voice input off (src/voice-unheard.ts picks among variants).
  'voice-no-sound':'我这边一直听不到一点声音。麦克风是不是被静音了，或者系统选错了输入设备？到 Windows 的「设置 → 系统 → 声音 → 输入」看看，对着它说一句试试。',
  'voice-empty':'我好像听到你说话了，可是没听出字来。靠近麦克风一点，慢一点再说一遍吧。',
  // Listening / watching along (R12): why the switch the user clicked did not turn on.
  'reading-needs-component':'想陪你听歌、看剧，我要先下载本机识别组件（只在这台电脑上运行，声音不会离开电脑）。在控制窗口的「连接与声音」→「语音输入」点「下载」就好。',
  'reading-preparing':'本机识别组件还在下载或安装，好了再打开，我就能陪你听了。',
  // I-016 (Codex T-207): played sound is transcribed only on this computer, so neither line offers the compatible address any more.
  'reading-unavailable':'这台电脑上用不了本机识别，我只能跟着节奏，听不懂歌词和对白。声音不会发到别处。',
  'reading-not-local':'我只用这台电脑上的本机识别来听歌词和对白，声音不会离开电脑。现在「语音输入」选的是兼容接口地址，所以我先只跟着节奏；想让我听懂，改成「本机自带识别」就好。',
});
const CAMERA_REFUSALS: readonly CameraRefusal[] = ['needs-component', 'preparing', 'unavailable'];
const VOICE_REFUSALS: readonly VoiceRefusal[] = ['needs-component', 'preparing', 'unavailable'];
const READING_REFUSALS: readonly AudioReadingRefusal[] = [...VOICE_REFUSALS, 'not-local'];
/** The fixed line for a refused camera request (the setRuntimeState reply), or null when nothing was refused. */
export function cameraRefusalAction(reply: unknown): NoticeAction | null {
  const reason = reply && typeof reply === 'object' ? (reply as { cameraRefused?: unknown }).cameraRefused : undefined;
  return CAMERA_REFUSALS.includes(reason as CameraRefusal) ? `camera-${reason as CameraRefusal}` : null;
}
/** The fixed line for a refused voice-input request (the setRuntimeState reply), or null. */
export function voiceRefusalAction(reply: unknown): NoticeAction | null {
  const reason = reply && typeof reply === 'object' ? (reply as { voiceRefused?: unknown }).voiceRefused : undefined;
  return VOICE_REFUSALS.includes(reason as VoiceRefusal) ? `voice-${reason as VoiceRefusal}` : null;
}
/** The fixed line for a refused listening/watching switch (the host's desk:audio-reading-refused event), or null. */
export function readingRefusalAction(reason: unknown): NoticeAction | null {
  return READING_REFUSALS.includes(reason as AudioReadingRefusal) ? `reading-${reason as AudioReadingRefusal}` : null;
}
/** The fixed line for a recognition failure that turned voice input off (the fault event's category), or null. */
export function voiceFailureAction(failure: unknown): NoticeAction | null {
  return (VOICE_INPUT_FAILURES as readonly unknown[]).includes(failure) ? `voice-${failure as VoiceInputFailure}` : null;
}
/**
 * what she says when voice input is on but nothing usable came of it. Several ways to say each (she
 * does not repeat the one she just used), and the same note is not repeated within 20 s (a fallback so a noisy room does not
 * become a stream of sentences; the status line still follows).
 */
const UNHEARD_LINES: Readonly<Record<'no-sound' | 'empty', readonly string[]>> = {
  'no-sound': [
    NOTICE_ACTIONS['voice-no-sound'],
    '麦克风那边好安静，一点声音都没传过来。是不是被静音了，或者输入设备选成了别的？',
    '我一直没听到你的声音呢。看看麦克风有没有开着、系统里选的输入设备对不对？',
  ],
  empty: [
    NOTICE_ACTIONS['voice-empty'],
    '刚才好像有声音，可我没听出你说了什么。再说一遍好不好？可以离麦克风近一点。',
    '嗯？我没听清。慢一点、近一点，再说一次给我听吧。',
  ],
};
let lastUnheard = { failure: '', at: -Infinity, index: -1 };
export function voiceUnheardLine(failure: 'no-sound' | 'empty', now = Date.now(), random = Math.random): string | null {
  if (lastUnheard.failure === failure && now - lastUnheard.at < 20_000) return null;
  const lines = UNHEARD_LINES[failure];
  let index = Math.floor(random() * lines.length) % lines.length;
  if (lastUnheard.failure === failure && index === lastUnheard.index) index = (index + 1) % lines.length;
  lastUnheard = { failure, at: now, index };
  return lines[index];
}
/** Fixed presentation text only. The original failure stays in explicit details. */
export function conciseFailure(value:unknown,context:'operation'|'chat'|'startup'='operation'):string{
  const text=String(value).slice(0,4000);
  if(/401|unauthori[sz]ed|authentication failed|login.{0,20}expired|invalid.{0,12}(?:key|credential)|登录.*失效|认证失败/i.test(text))return uiText('连接验证失败，请检查登录或密钥。');
  if(/access denied|permission (?:denied|was not granted)|NotAllowedError|权限.*拒绝|未.*授权/i.test(text))return uiText('未能完成授权，请检查权限后重试。');
  if(/fetch failed|ECONNREFUSED|ENOTFOUND|network|timed?\s*out|连接.*失败|连接.*超时/i.test(text))return uiText('连接暂时不可用，请检查服务后重试。');
  if(/6000字符限制|6,?000.character.*limit|content.{0,20}too long|消息.*(?:过长|超限)|超出.*字符/i.test(text))return uiText('内容较长，请缩短后重试；已有文字仍保留。');
  if(/(?:原文|文字).*(?:保留|输入框)|已保留.*原文|original (?:text )?(?:is )?(?:kept|retained)|not fully processed/i.test(text))return uiText('这段输入未处理完，原文已保留，可重试。');
  if(/请先.*(?:配置|选择|载入)|未选择.*模型|choose.{0,60}(?:connection|model).{0,40}first|load.{0,20}model.{0,20}first/i.test(text))return uiText('请先在设置中完成连接或模型选择。');
  if(context==='startup')return uiText('暂时未能启动，请查看详情或重试。');
  if(context==='chat')return uiText('这次回复未完成，可查看问题详情后重试。');
  return uiText('操作没有完成，可查看详情后重试。');
}
