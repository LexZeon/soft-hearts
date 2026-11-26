// 数据地图: one table of everything the
// app keeps under the profile directory (and the few things it keeps outside it), what each holds (never the contents), whose it is,
// and what happens to it on each privacy action:
//   (a) deleting a character with "同时删除她的记忆" ticked (C2, electron/cards/character-forget.ts),
//   (b) "允许记录" turned off (the diary ticket; electron/memory/user-profile-management.ts → electron/memory/privacy-wiring.ts),
//   (c) the agent channel's delete_memories (I-014, recoverable, electron/memory/recoverable-forget.ts),
//   (d) a character card export (electron/cards/character-response.ts export),
//   (e) a profile backup (scripts/experience/backup-profile.mjs: every file under the profile),
//   (f) diagnostics (the agent channel's get_diagnostics: numbers from memory only).
// The table describes what the code does TODAY; "pending" marks a gap that is the user's call (docs/claude/2026-11-16-data-map.md
// lists each with a recommendation). The actions follow it: the character-forget and recording-off registries are typed from the rows
// (`CharacterForgetId`, `RecordingOffId`), so a row that says "delete" cannot compile without its clear function, and
// tests/data-map.test.ts fails when the code writes a new file or folder name the table does not cover.
// No Electron import; nothing here reads or writes a file.
import type { RecycleItemKind } from '../../shared/foundation/recycle-bin';
import type { DataStoreRow } from './data-map-types';
import { MEMORY_ROWS } from './data-map-rows-memory';
import { APP_ROWS } from './data-map-rows-app';
import { CHARACTER_ROWS } from './data-map-rows-character';

// The row types live in data-map-types.ts (re-exported here, so every import of data-map keeps working).
export type {
  DataScope, CharacterForgetPolicy, RecordingOffPolicy, AgentDeletePolicy, RecyclePolicy, CardExportPolicy, DiagnosticsPolicy, DataStoreRow,
} from './data-map-types';
import type { DataScope, CharacterForgetPolicy, RecordingOffPolicy, AgentDeletePolicy } from './data-map-types';
import { ASSISTANT_NAME } from '../../shared/foundation/assistant-name';

/** The table, in order: memory, then her own state and the app's records, then the character and what is outside the profile. */
export const DATA_MAP = [...MEMORY_ROWS, ...APP_ROWS, ...CHARACTER_ROWS] as const satisfies readonly DataStoreRow[];

type Row = (typeof DATA_MAP)[number];
export type DataStoreId = Row['id'];
/** Rows that (a) deletes through the registry: each needs a clear function in CharacterForgetRegistry. */
export type CharacterForgetId = Extract<Row, { characterForget: 'delete' }>['id'];
/** Rows that (b) deletes through the registry: each needs a clear function in RecordingOffRegistry. */
export type RecordingOffId = Extract<Row, { recordingOff: 'delete' }>['id'];

/** I-144: rows the recycle bin keeps; each needs a capture, a remove and a restore in RecycleRegistry (electron/memory/recycle-wiring.ts). */
export type RecycleId = Extract<Row, { recycle: 'take' }>['id'];
// Compile-time: a row any deletion removes ('delete', 'follows', 'with-card') is either kept by the bin or says why not ('skip' needs a reason).
type RemovedButStays = Extract<Row, { characterForget: 'delete' | 'follows' | 'with-card'; recycle: 'stays' }>['id'];
type SkipWithoutReason = Exclude<Extract<Row, { recycle: 'skip' }>, { recycleWhy: string }>['id'];
const recycleRule: [RemovedButStays | SkipWithoutReason] extends [never] ? true : { error: 'a removed row must be recycled, or skipped with a reason'; rows: RemovedButStays | SkipWithoutReason } = true;
void recycleRule;
/** I-144b: the kinds of single deletion the rows name; electron/memory/recycle/items-wiring.ts must restore each one. */
export type RecycleItemRowKind = Extract<Row, { recycleItems: readonly string[] }>['recycleItems'][number];
// Compile-time: every single-deletion kind belongs to a row, no row the bin never keeps has single deletions, and an 'items' row names its kinds.
type KindWithoutRow = Exclude<RecycleItemKind, RecycleItemRowKind>;
type ItemsOnStayRow = Extract<Row, { recycle: 'stays' | 'skip'; recycleItems: readonly string[] }>['id'];
type ItemsRowWithout = Exclude<Extract<Row, { recycle: 'items' }>, { recycleItems: readonly string[] }>['id'];
const itemRule: [KindWithoutRow | ItemsOnStayRow | ItemsRowWithout] extends [never] ? true : { error: 'every single deletion needs a row the bin keeps'; rows: KindWithoutRow | ItemsOnStayRow | ItemsRowWithout } = true;
void itemRule;

export const dataStore = (id: DataStoreId): DataStoreRow => DATA_MAP.find(row => row.id === id)!;
/** I-144: the rows the bin keeps, in the table's order. */
export const recycleIds = (): RecycleId[] => DATA_MAP.filter(row => row.recycle === 'take').map(row => row.id as RecycleId);
export const characterForgetIds = (): CharacterForgetId[] => DATA_MAP.filter(row => row.characterForget === 'delete').map(row => row.id as CharacterForgetId);
export const recordingOffIds = (): RecordingOffId[] => DATA_MAP.filter(row => row.recordingOff === 'delete').map(row => row.id as RecordingOffId);

// ---- The Chinese rendering for docs/data-map.md (a test keeps the page in step with the table) ----

const SCOPE_ZH: Record<DataScope, string> = { character: '每个角色', 'character-connection': '每个角色×连接', global: '整个配置', 'outside-profile': '配置目录外' };
const FORGET_ZH: Record<CharacterForgetPolicy, string> = { delete: '删', follows: '跟着删', 'with-card': '随卡删', 'keep-confirmed': '留（已确认）', keep: '留', pending: '留（待用户定）' };
const RECORDING_ZH: Record<RecordingOffPolicy, string> = { delete: '删', 'by-switch': '删', 'stops-new': '不再写，已有的留', unaffected: '—', pending: '留（待用户定）' };
const AGENT_ZH: Record<AgentDeletePolicy, string> = { recycle: '进回收站', 'rides-chat': '随聊天进回收站', follows: '跟着处理', 'rides-profile': '随画像进回收站', 'deleted-for-good': '直接删（不进回收站）', 'own-tool': '另有工具', untouched: '—' };

/** One Markdown table row per store; no contents, only what each holds and the policies. */
export function renderDataMapMarkdown(rows: readonly DataStoreRow[] = DATA_MAP): string {
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `| 数据 | 存什么 | 位置 | 归属 | 关于你 | 删角色并勾选「同时删除她的记忆」 | 关「允许记录」 | ${ASSISTANT_NAME} 删除记忆 | 进回收站 | 导出角色卡 | 备份 | 诊断 |`,
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const row of rows) {
    const follows = row.characterForget === 'follows' && row.follows ? `（随「${dataStore(row.follows as DataStoreId).label}」）` : '';
    const recording = RECORDING_ZH[row.recordingOff] + (row.diaryCleared ? '；清空日记时也删' : '');
    lines.push(`| ${cell(row.label)} | ${cell(row.holds)} | ${cell(row.paths.map(p => `\`${p}\``).join('、'))} | ${SCOPE_ZH[row.scope]} | ${row.holdsUserData ? '是' : '否'} | `
      + `${FORGET_ZH[row.characterForget]}${follows} | ${recording} | ${AGENT_ZH[row.agentDelete]} | ${row.recycle === 'take' ? '收' : row.recycle === 'items' ? '单条删除收（删角色不动）' : row.recycle === 'skip' ? `不收（${cell(row.recycleWhy ?? '')}）` : '不收（不会被删）'} | ${row.cardExport === 'included' ? '带' : '不带'} | `
      + `${row.backup ? '带' : '不带'} | ${row.diagnostics === 'numbers' ? '只有数字' : '不带'} |`);
  }
  return lines.join('\n');
}
