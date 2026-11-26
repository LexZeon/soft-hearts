// set_perception (docs/claude/2026-11-17-app-tools-split.md): the camera (images, pose), 认出是不是你, the microphone, screen sharing and
// the computer's sound, through the same host paths as the user's own switches. Opening one needs the user's words and always the
// dialog (privacy); closing is direct; 撤回 can close a sense again, never re-open one. Only while 三方互通 is on.
import { POSE_LOCAL_ONLY, POSE_RECOGNISES } from '../../../../shared/senses'; // I-081: what pose sensing recognises, said wherever it is turned on
import { AgentToolError, type AgentCallContext, type AgentToolDefinition } from '../registry';
import { argsObject, oneOf } from '../validate';
import type { PerceptionKind, SystemAudioPurpose, PerceptionFacts } from './app-bridge';
import { title, unavailable, type ToolContext } from './common';
import { ASSISTANT_NAME } from '../../../../shared/foundation/assistant-name';

const PERCEPTION_LABELS: Readonly<Record<PerceptionKind, string>> = Object.freeze({ camera: '摄像头', camera_images: '摄像头发图片', camera_pose: '摄像头姿势识别', face_check: '认出是不是你（Beta）',
  microphone: '麦克风', screen: '屏幕共享', system_audio: '电脑声音' });
/** I-135: what the dialog says before 认出是不是你 turns on through the channel (the same facts as the switch's own explanation). */
export const FACE_CHECK_CONSENT = '打开后，摄像头开着时她会在这台电脑上看一眼是不是你；明显不是你时她会客气疏远一点，拿不准都当成是你。只记你自己的脸，存的是一串数字不是照片，只在这台电脑上、加密保存，随时一键删除；不认别人是谁，也不存别人。第一次打开会下载约 10 MB 的识别组件（要是还没装过本机识别，会多下载运行库）。';
const PURPOSE_LABELS: Readonly<Record<SystemAudioPurpose, string>> = Object.freeze({ music: '陪听音乐', movie: '陪看视频' });
function perceptionOn(facts: PerceptionFacts, kind: PerceptionKind, purposes: readonly SystemAudioPurpose[]): boolean {
  if (kind === 'system_audio') return purposes.some(purpose => facts.systemAudio[purpose]);
  if (kind === 'camera_images') return facts.cameraImages === true;
  if (kind === 'camera_pose') return facts.cameraPose === true;
  if (kind === 'face_check') return facts.faceCheck === true;
  return facts[kind];
}

export function senseTools(context: ToolContext): AgentToolDefinition<any, any>[] {
  const { bridge } = context;
  return [
    {
      // I-014 感知: the same host paths as the user's own switches; never on unless asked, off is always allowed.
      name: 'set_perception', title: title('set_perception'), tier: 'reversible', interconnectOnly: true,
      validate: raw => {
        const args = argsObject(raw, ['kind', 'state', 'purpose']);
        const kind = oneOf(args.kind, ['camera', 'camera_images', 'camera_pose', 'face_check', 'microphone', 'screen', 'system_audio'] as const, 'kind ');
        const state = oneOf(args.state, ['on', 'off'] as const, 'state ');
        if (args.purpose !== undefined && kind !== 'system_audio') throw new AgentToolError('invalid_input', 'purpose 只用于 system_audio。');
        const purpose = args.purpose === undefined ? undefined : oneOf(args.purpose, ['music', 'movie'] as const, 'purpose ');
        const purposes: SystemAudioPurpose[] = kind !== 'system_audio' ? [] : purpose ? [purpose] : state === 'on' ? ['music'] : ['music', 'movie'];
        return { kind, enabled: state === 'on', purposes };
      },
      // I-025: privacy: opening a sense needs the user's own words (三方互通 is always on for this tool); closing never does.
      tierFor: (input: { enabled: boolean }) => input.enabled ? 'confirm' : 'reversible',
      // 敏感操作弹窗 (2026-11-12): opening a sense is privacy: the dialog as well, after the user's words. Closing stays direct.
      alwaysConfirmFor: (input: { enabled: boolean }) => input.enabled,
      confirmation: (input: { kind: PerceptionKind; purposes: SystemAudioPurpose[] }) => ({ title: `${ASSISTANT_NAME} 请求打开${PERCEPTION_LABELS[input.kind]}`,
        detail: `${PERCEPTION_LABELS[input.kind]}${input.kind === 'system_audio' && input.purposes.length === 1 ? `（${PURPOSE_LABELS[input.purposes[0]]}）` : ''}默认是关的；打开后随时可以关。${input.kind === 'camera_pose' || input.kind === 'camera' ? `姿势识别会识别${POSE_RECOGNISES}；${POSE_LOCAL_ONLY}，画面不离开电脑。打开就算同意她用这些。` : ''}${input.kind === 'face_check' ? FACE_CHECK_CONSENT : ''}` }),
      wordsItem: (input: { kind: PerceptionKind; enabled: boolean; purposes: SystemAudioPurpose[] }) =>
        ({ item: input.kind, value: input.kind === 'system_audio' && input.purposes.length === 1 ? input.purposes[0] : input.enabled }),
      prepare: (input: { kind: PerceptionKind; enabled: boolean; purposes: SystemAudioPurpose[] }) => {
        if (!bridge.perception || !bridge.setPerception) throw unavailable('这个版本还不能通过内部通道开关感知。');
        const pet = bridge.windows().pet;
        if (input.enabled && input.kind !== 'face_check' && (!pet || !pet.visible || pet.minimized)) throw unavailable('请先让桌宠显示出来（可以用 show_pet），感知在桌宠上打开。');
        return input;
      },
      noticeDetail: (input: { kind: PerceptionKind; enabled: boolean; purposes: SystemAudioPurpose[] }) =>
        `${input.enabled ? '打开' : '关闭'}${PERCEPTION_LABELS[input.kind]}${input.kind === 'system_audio' && input.purposes.length === 1 ? `（${PURPOSE_LABELS[input.purposes[0]]}）` : ''}`,
      run: async (input: { kind: PerceptionKind; enabled: boolean; purposes: SystemAudioPurpose[] }, context: AgentCallContext) => {
        const before = perceptionOn(bridge.perception!(), input.kind, input.purposes);
        await bridge.setPerception!(input.kind, input.enabled, input.purposes, context.check);
        const after = perceptionOn(bridge.perception!(), input.kind, input.purposes);
        // I-025: 撤回 can close a sense again, never re-open one (that needs the user's words).
        if (after !== before && !before) context.offerUndo({ label: `关掉${PERCEPTION_LABELS[input.kind]}`, run: async guard => {
          if (perceptionOn(bridge.perception!(), input.kind, input.purposes) !== after) throw unavailable(`${PERCEPTION_LABELS[input.kind]}之后又改过了，没有撤回。`);
          const pet = bridge.windows().pet;
          if (before && (!pet || !pet.visible || pet.minimized)) throw unavailable('请先让桌宠显示出来，感知在桌宠上打开。');
          await bridge.setPerception!(input.kind, before, input.purposes, guard);
        } });
        return { kind: input.kind, label: PERCEPTION_LABELS[input.kind], on: after,
          ...(input.enabled && !after ? { note: '没有打开：可能缺少需要的组件或语音识别连接，soft hearts 上会有说明。' } : {}) };
      },
    },
  ];
}
