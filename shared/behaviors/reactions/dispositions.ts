/**
 * I-037 角色底色：几项 0–100 的"反应倾向"。
 * 所有反应只读这几项（knobs.ts 的反应清单里每行写"挂钩哪几项、每点 ± 多少"）。50 = 一般。
 *
 * 这里是倾向的**唯一登记处**：加一项倾向就在 DISPOSITIONS 里加一行（名字、白话说明、没有倾向文件时怎么从卡上推），
 * 角色页的滑块、内部通道工具的参数、haiku 看到的性格摘要、存档校验都从这张表生成。代价：每个角色都要补一个数
 * （没补的从卡上推），所以要慎重（docs/claude/how-to-add-a-reaction.md）。
 *
 * 倾向**不写进角色卡存档**（旧版本对卡校验严，多一个字段整张卡读不出来）：按角色 id 存在配置目录的
 * reaction-dispositions.json（electron/reactions/store.ts）。没有这个文件、或文件里没有这个角色时，用 deriveDispositions
 * 从卡上现有的数（weights、sensitivity、intensity、blush）推出默认值；默认卡（全是 1、强度 50、脸红 35）推出来全是 50。
 * 纯数据和纯函数：没有 Electron、没有文件、不知道 Claude。
 */
import type { MoodParameters } from '../../mood';

/** 推默认值时读的卡上的数（角色卡心情参数的一部分）。 */
export type DispositionCard = Pick<MoodParameters, 'weights' | 'sensitivity' | 'intensity' | 'blush'>;

export interface DispositionSpec {
  /** 中文名（角色页、haiku 的性格摘要、体验记录）。 */
  readonly label: string;
  /** 一句白话：这一项影响她的什么反应（角色页滑块下面那行字、内部通道工具的说明）。 */
  readonly hint: string;
  /** 没有倾向文件时，从卡上的数推一个 0–100 的默认值（四舍五入、夹在 0–100 由 deriveDispositions 做）。 */
  readonly derive: (card: DispositionCard) => number;
}

const mean = (values: Readonly<Record<string, number>>) => { const list = Object.values(values); return list.reduce((sum, n) => sum + n, 0) / Math.max(1, list.length); };

export const DISPOSITIONS = Object.freeze({
  shy: { label: '害羞', hint: '被夸、被摸头、被捏脸时多容易脸红、低头害羞。',
    derive: card => 50 + 25 * (card.weights.cautious - 1) + 0.3 * (card.blush.intensity - 35) },
  clingy: { label: '黏人', hint: '多想亲近你：撒娇、比心这类亲近的反应。',
    derive: card => 50 + 25 * (card.weights.close - 1) },
  lively: { label: '活泼', hint: '多爱用小动作表达：鼓掌、挥手、眨眼、歪头。',
    derive: card => 50 + 25 * (card.weights.playful - 1) + 0.2 * (card.intensity.playful - 50) },
  soothable: { label: '好哄', hint: '被关心、被哄、听到好消息时多容易开心起来。',
    derive: card => 50 + 25 * (card.weights.comfortable - 1) },
  volatile: { label: '情绪起伏', hint: '反应来得多快多大：起伏大的人一点小事也会有反应。',
    derive: card => 50 + 25 * (mean(card.sensitivity) - 1) },
  restrained: { label: '克制', hint: '多会把反应收着：克制的人动作少、表情轻一点。',
    derive: card => 50 - 0.4 * (card.intensity.expression - 50) },
} satisfies Record<string, DispositionSpec>);

export type DispositionId = keyof typeof DISPOSITIONS;
export const DISPOSITION_IDS = Object.freeze(Object.keys(DISPOSITIONS) as DispositionId[]);
export type Dispositions = Readonly<Record<DispositionId, number>>;

const clamp100 = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

/** 从卡上的数推出的默认倾向（没有倾向文件、或文件里没有这个角色时用）。读不出的项是 50。 */
export function deriveDispositions(card: DispositionCard | null | undefined): Dispositions {
  const out = {} as Record<DispositionId, number>;
  for (const id of DISPOSITION_IDS) {
    let value = 50;
    try { if (card) value = (DISPOSITIONS[id] as DispositionSpec).derive(card); } catch { value = 50; }
    out[id] = Number.isFinite(value) ? clamp100(value) : 50;
  }
  return Object.freeze(out);
}

/**
 * 校验一组倾向：必须正好是登记的这几项，每项 0–100 的整数。`partial` 时可以只给一部分（内部通道工具改其中几项），
 * 但不能有登记以外的键。不对就抛错（错误文字给用户看）。
 */
export function validateDispositions(value: unknown, options: { partial?: boolean } = {}): Partial<Record<DispositionId, number>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('反应倾向的格式不对。');
  const input = value as Record<string, unknown>, out: Partial<Record<DispositionId, number>> = {};
  for (const key of Object.keys(input)) if (!(DISPOSITION_IDS as readonly string[]).includes(key)) throw new Error(`没有「${key}」这一项反应倾向。`);
  for (const id of DISPOSITION_IDS) {
    if (!(id in input)) { if (options.partial) continue; throw new Error(`反应倾向少了「${DISPOSITIONS[id].label}」。`); }
    const n = input[id];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100) throw new Error(`「${DISPOSITIONS[id].label}」要是 0 到 100 的整数。`);
    out[id] = n;
  }
  if (options.partial && !Object.keys(out).length) throw new Error('没有给任何一项反应倾向。');
  return out;
}

/** haiku 看到的性格摘要："害羞 50、黏人 50、……（50 一般）"。 */
export function dispositionSummary(values: Dispositions): string {
  return DISPOSITION_IDS.map(id => `${DISPOSITIONS[id].label} ${Math.round(values[id])}`).join('、');
}
