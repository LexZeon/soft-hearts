import { validateLanguageRules, type LanguageRules } from './personalize-language';

export const AUTHORING_MATERIAL_LIMIT = 12_000;
export const AUTHORING_FEEDBACK_LIMIT = 2_000;
export const AUTHORING_OUTPUT_LIMIT = 16_000;
export interface LanguageAuthoringSession { id: string; characterId: string; savedRevision: number; revision: number }
export interface LanguageStudy {
  observations: { quote: string; finding: string }[];
  inferences: string[]; questions: string[]; insufficient: string; rules: LanguageRules;
}
export interface LanguageResearchRequest {
  sessionId: string; revision: number; materials: string; refinement: string; rules: LanguageRules;
}
export interface LanguageResearchResult { session: LanguageAuthoringSession; study: LanguageStudy }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('研究数据格式不正确。');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) throw Error('研究数据包含未知或缺少字段。');
  return row;
}
export function authoringText(value: unknown, limit: number, required = false): string {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw Error(`研究文字须为 ${limit} 字以内的纯文本。`);
  const text = value.trim(); if (required && !text) throw Error('请先填写需要研究的台词或文本。'); return text;
}
export function validateLanguageResearch(value: unknown): LanguageResearchRequest {
  const row = record(value, ['sessionId', 'revision', 'materials', 'refinement', 'rules']);
  if (typeof row.sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(row.sessionId) || !Number.isSafeInteger(row.revision) || (row.revision as number) < 0) throw Error('研究草稿身份不正确。');
  return { sessionId: row.sessionId, revision: row.revision as number,
    materials: authoringText(row.materials, AUTHORING_MATERIAL_LIMIT, true), refinement: authoringText(row.refinement, AUTHORING_FEEDBACK_LIMIT), rules: validateLanguageRules(row.rules) };
}
/** A data-only result: no extra tool, path, HTML, permission or execution fields. */
export function parseLanguageStudy(raw: string, materials: string): LanguageStudy {
  if (raw.length > AUTHORING_OUTPUT_LIMIT) throw Error('研究结果过长，当前草稿已保留。');
  let value: unknown; try { value = JSON.parse(raw); } catch { throw Error('Claude 未返回合格的研究数据，当前草稿已保留。'); }
  const row = record(value, ['observations', 'inferences', 'questions', 'insufficient', 'rules']);
  const plain = (v: unknown, limit: number, required = true) => {
    const text = authoringText(v, limit, required);
    if (/<\/?[a-z!][^>]*>/i.test(text) || /```/.test(text)) throw Error('研究结果包含非纯文本内容，已忽略。');
    return text;
  };
  const list = (v: unknown, max: number): string[] => {
    if (!Array.isArray(v) || v.length > max) throw Error('研究结果条数超限。');
    return v.map(item => plain(item, 400));
  };
  if (!Array.isArray(row.observations) || row.observations.length > 5) throw Error('研究依据条数不正确。');
  const observations = row.observations.map(item => {
    const itemRow = record(item, ['quote', 'finding']), quote = plain(itemRow.quote, 300), finding = plain(itemRow.finding, 400);
    if (!materials.includes(quote)) throw Error('研究引用未出现在当前材料中，结果已忽略。');
    return { quote, finding };
  });
  const rules = validateLanguageRules(row.rules);
  for (const text of Object.values(rules)) plain(text, 600, false);
  return { observations, inferences: list(row.inferences, 4), questions: list(row.questions, 3), insufficient: plain(row.insufficient, 600, false), rules };
}
