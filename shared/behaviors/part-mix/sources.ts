/**
 * I-175 部位表：每个来源用哪几个部位、在部位上怎么叠、能不能边说边做、进出多久（interface.ts）。
 * 这是"谁在用、怎么叠"的一张表，给以后接手的人一眼看全；规则本身在 mouth.ts、closed-mouth.ts、lids-head.ts（"做多久"在 ../speech-beats/how-long.ts）。
 * 表里写的是 Unbound 引擎（桌宠窗口和全屏共用的 figure）现在的样子；老舞台不接（I-176 删）。
 * 测试 tests/part-mix.test.ts 核对：每个部位都有人用、嘴的开合只有口型是底形、闭嘴类从不边说边做、撅嘴（小动作的嘴形）边说边做。
 */
import type { Part, PartClaim, SourceDecl, SourceId } from './interface';

const claim = (kind: PartClaim['kind'], talkThrough: boolean, easeS: number): PartClaim => Object.freeze({ kind, talkThrough, easeS });

export const SOURCES: readonly SourceDecl[] = Object.freeze([
  // 待机：学来的待机动作加程序小动作，垫在最底下；聊天时头的晃动收着（talkCalm）。
  { id: 'idle', zh: '待机', parts: { head: claim('base', true, 1.2), neck: claim('base', true, 1.2), body: claim('base', true, 1.2), arms: claim('base', true, 1.2), eyelids: claim('additive', true, 0.15) } },
  // 看向：共用的视线选择器给眼和头一个目标，眼头协调分到眼、头、上身（E1）。
  { id: 'gaze', zh: '看向', parts: { head: claim('additive', true, 0.4), neck: claim('additive', true, 0.4) } },
  // 口型：嘴的开合唯一的底形；说话时表情里张着的嘴让给它（mouth.ts talkFade）。
  { id: 'lipSync', zh: '口型', parts: { mouthOpen: claim('base', true, 0.06) } },
  // 边说边演的拍子：表情定嘴形底形、眉眼叠加；歪头、凑近叠在头和身体上；手放脸边、比 V 用手臂和手。
  { id: 'speechBeat', zh: '边说边演', parts: { mouthShape: claim('base', true, 0.3), brows: claim('additive', true, 0.3), eyelids: claim('additive', true, 0.3),
    cheeks: claim('additive', true, 1.2), head: claim('additive', true, 0.4), body: claim('additive', true, 0.6), arms: claim('additive', true, 0.5), hands: claim('additive', true, 0.5) } },
  // 点和摸的反应：摸头时眼皮半闭、头蹭一下；捏脸占脸颊和头。
  { id: 'touchReaction', zh: '点和摸的反应', parts: { eyelids: claim('additive', true, 0.2), head: claim('additive', true, 0.3), cheeks: claim('exclusive', true, 0.25), brows: claim('additive', true, 0.3) } },
  // 脸红、吃惊、害羞：脸颊和眉眼叠加，嘴形是底形。
  { id: 'feeling', zh: '脸红、吃惊、害羞', parts: { cheeks: claim('additive', true, 1.2), brows: claim('additive', true, 0.3), eyelids: claim('additive', true, 0.3), mouthShape: claim('base', true, 0.3) } },
  // 小动作：点头、挥手、歪头叠在头和手臂上；撅嘴是嘴形底形，能边说边做（方案第 1 条）。
  { id: 'smallAction', zh: '小动作（点头、挥手、歪头、撅嘴）', parts: { head: claim('additive', true, 0.25), neck: claim('additive', true, 0.25), arms: claim('additive', true, 0.4),
    hands: claim('additive', true, 0.4), mouthShape: claim('base', true, 0.2) } },
  // 闭嘴类：鼓腮、吐舌、亲。脸的独占整组归它一小会儿；说话时不开始，排到停顿（closed-mouth.ts）。
  { id: 'closedMouth', zh: '鼓腮、吐舌、亲', parts: { mouthShape: claim('exclusive', false, 0.2), mouthOpen: claim('exclusive', false, 0.2), cheeks: claim('exclusive', false, 0.2) } },
  // 递东西、猜拳、牵手：手臂和手被占着（"手被占着"判断已经共用）。
  { id: 'handGame', zh: '递东西、猜拳、牵手', parts: { arms: claim('exclusive', true, 0.5), hands: claim('exclusive', true, 0.5) } },
  // 睡觉：整个身体和眼皮。
  { id: 'sleep', zh: '睡觉', parts: { body: claim('exclusive', false, 1.5), head: claim('exclusive', false, 1.5), neck: claim('exclusive', false, 1.5), arms: claim('exclusive', false, 1.5),
    eyelids: claim('exclusive', false, 1) } },
  // 聊天时头稳（I-170）：只收待机层自己给头和脖子的晃动，按比例，不占部位。
  { id: 'talkCalm', zh: '聊天时头稳', parts: { head: claim('additive', true, 1.2), neck: claim('additive', true, 1.2) } },
] as SourceDecl[]);

/** One source's declaration (undefined for an id not in the table). */
export const sourceOf = (id: SourceId): SourceDecl | undefined => SOURCES.find(source => source.id === id);

/** Who uses a part, and how (table order). */
export function claimsOn(part: Part): { id: SourceId; claim: PartClaim }[] {
  const out: { id: SourceId; claim: PartClaim }[] = [];
  for (const source of SOURCES) { const c = source.parts[part]; if (c) out.push({ id: source.id, claim: c }); }
  return out;
}
