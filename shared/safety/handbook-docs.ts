// I-071 v2: the manuals read_handbook can read ({doc},
// {doc, section}, {find}). Which pages those are is one list, shared/safety/user-manuals.json: the pages written for the person who
// uses the app (how-to answers, the card and voice guides, the knob table, the data map, release notes). The same list decides what the
// packaged app bundles (package.json build.extraResources) and what the public snapshot keeps (scripts/release/export-public.mjs);
// tests/user-manuals.test.ts keeps the three in step. Development pages (the project handbook, dated records, design write-ups) are
// not on it: they are not shipped, so they are not read. Callers name a page by its id; the host maps the id to a file it found itself,
// never to a caller's path. Pure: the host reads files and passes text.
import userManuals from './user-manuals.json';

/** guide: how to use and set up the app; design: how her mood and interactions were designed; handbook: the project handbook. A page has the kind the list gives it; today every shipped page is a guide. */
export type HandbookDocKind = 'guide' | 'design' | 'handbook';
export type HandbookDocId = string;
export interface HandbookDocSpec {
  id: HandbookDocId;
  /** Path under the docs root: the repository in a source checkout, resources/assistant-docs/ when packaged (package.json extraResources). */
  file: string;
  kind: HandbookDocKind;
  title: string;
  about: string;
}

/** The pages the app ships and reads: file under the docs root → kind (shared/safety/user-manuals.json). */
export const USER_MANUALS: ReadonlyMap<string, HandbookDocKind> = new Map(Object.entries(userManuals.manuals as Record<string, HandbookDocKind>));

export const HANDBOOK_DOC_KIND_LABEL: Readonly<Record<HandbookDocKind, string>> = Object.freeze({
  guide: '说明文档（怎么用、怎么设置）',
  design: '设计资料（心情、互动和各功能当初怎么设计的；较早的可能落后于现在）',
  handbook: '项目手册（开发用：功能状态、路线图、想法、规矩）',
});

/** Better one-line descriptions for a few pages; every other page describes itself (its first plain line). Never decides what is in. */
const ABOUT: Readonly<Record<string, { title?: string; about: string }>> = Object.freeze({
  'character-card-guide': { about: '写卡、改卡：人设、数值模板 mood、反应倾向、"想要这样的她 → 这样写"、常见问题' },
  'character-cards': { about: '角色卡的导入、导出、编辑、保存与读回' },
  knobs: { title: '想改什么 → 改哪里（旋钮表）', about: '她的各种行为节奏和幅度由哪些旋钮决定：脸红、主动开口、闲着的小动作、作息、反应、记忆笔记……' },
  'voice-design-guide': { about: '给她设计一个声音：怎么描述、挑候选、存成固定声音，情绪标签怎么用' },
  'touching-her': { about: '摸头、捏脸、喂零食、牵手、拉她：入口在哪里、怎么做' },
  'data-map': { about: '她记得的东西总表：存了什么、怎么删、怎么备份' },
});

/** Which manual a file under the docs root is (`docs/knobs.md` → knobs, `docs/release-notes/v0.2.0.md` → release-notes/v0.2.0), or null when it is not on the list. */
export function handbookDocFor(file: string, manuals: ReadonlyMap<string, HandbookDocKind> = USER_MANUALS): { id: HandbookDocId; kind: HandbookDocKind } | null {
  const kind = manuals.get(file);
  if (!kind || !/^[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/.test(file) || file.includes('..') || file.includes('//')) return null;
  return { id: (file.startsWith('docs/') ? file.slice(5) : file).slice(0, -3), kind };
}

/** A doc id as a caller may write it: letters, digits, `.`, `_`, `-`, at most one folder; never a file name or a path. */
export const isHandbookDocIdShape = (value: unknown): value is HandbookDocId =>
  typeof value === 'string' && value.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(value)
  && !/\.md$/i.test(value) && !value.includes('..');

const plain = (line: string) => line.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_>#|]/g, '').replace(/\s+/g, ' ').trim();

/** A page's title (its first `# ` heading) and one line about it (its first plain line), or null when the file is not a manual. */
export function handbookDocSpec(file: string, markdown: string, manuals: ReadonlyMap<string, HandbookDocKind> = USER_MANUALS): HandbookDocSpec | null {
  const found = handbookDocFor(file, manuals);
  if (!found) return null;
  const lines = markdown.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const heading = lines.find(line => /^#\s+\S/.test(line));
  const curated = ABOUT[found.id];
  const title = (curated?.title ?? (heading ? plain(heading) : '') ?? '').slice(0, 80) || found.id;
  let about = curated?.about ?? '';
  if (!about) {
    let fenced = false;
    for (const line of lines) {
      if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
      if (fenced || /^\s*(#|\||-{3,}|$)/.test(line)) continue;
      const text = plain(line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''));
      if ([...text].length >= 6) { about = [...text].length > 60 ? `${[...text].slice(0, 60).join('')}…` : text; break; }
    }
  }
  return Object.freeze({ id: found.id, file, kind: found.kind, title, about });
}

/** One `## ` section (the text before the first one is section 0, "开头"). Long sections are cut into parts. */
export interface HandbookDocSection { index: number; heading: string; text: string }

/** Characters per returned piece: a tool result stays well under the channel's 48 KB limit. */
export const DOC_PART_CHARS = 9_000;

export function splitDoc(markdown: string): HandbookDocSection[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const sections: HandbookDocSection[] = [];
  let heading = '开头', body: string[] = [], fenced = false;
  const flush = () => {
    const text = body.join('\n').trim();
    if (text || sections.length || heading !== '开头') sections.push({ index: sections.length, heading, text });
    body = [];
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const match = !fenced ? /^##\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (match && !line.startsWith('###')) { flush(); heading = match[1].trim().slice(0, 120); continue; }
    body.push(line);
  }
  flush();
  return sections;
}

export interface HandbookDocPage {
  doc: HandbookDocId; title: string;
  /** Present when no section was asked for: the table of contents. */
  contents?: Array<{ section: number; heading: string; chars: number }>;
  section?: number; heading?: string; part?: number; parts?: number; text?: string;
  cite: string;
}

/** `section` absent: the contents and section 0; with `part` for a long section (1-based). */
export function readDocPage(spec: HandbookDocSpec, markdown: string, section?: number, part = 1): HandbookDocPage {
  const sections = splitDoc(markdown);
  const contents = sections.map(item => ({ section: item.index, heading: item.heading, chars: item.text.length }));
  const pick = section === undefined ? 0 : section;
  const found = sections[pick];
  if (!found) {
    if (section === undefined) return { doc: spec.id, title: spec.title, contents, cite: `《${spec.title}》` };
    throw new RangeError(`《${spec.title}》只有 0～${Math.max(0, sections.length - 1)} 节。`);
  }
  const parts = Math.max(1, Math.ceil(found.text.length / DOC_PART_CHARS));
  if (!Number.isInteger(part) || part < 1 || part > parts) throw new RangeError(`这一节只有 1～${parts} 段。`);
  const text = found.text.slice((part - 1) * DOC_PART_CHARS, part * DOC_PART_CHARS);
  return {
    doc: spec.id, title: spec.title, ...(section === undefined ? { contents } : {}),
    section: found.index, heading: found.heading, ...(parts > 1 ? { part, parts } : {}), text,
    cite: `《${spec.title}》「${found.heading}」`,
  };
}

export interface HandbookDocHit { doc: HandbookDocId; title: string; section: number; heading: string; snippet: string; score: number; kind: HandbookDocKind }

/** Question words carry no topic: a pair holding one of these characters is not a search term ("怎么", "什么", "么写"). */
const FILLER = /[么什怎吗呢吧啊呀嘛哪]/u;

/** Words of a query: Latin words, and Chinese runs cut into overlapping pairs (no dictionary needed). */
export function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const word of query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []) terms.add(word);
  for (const run of query.match(/[㐀-鿿]+/g) ?? []) {
    if (run.length <= 2) { if (!FILLER.test(run)) terms.add(run); continue; }
    for (let index = 0; index + 2 <= run.length; index++) { const pair = run.slice(index, index + 2); if (!FILLER.test(pair)) terms.add(pair); }
  }
  return [...terms].slice(0, 40);
}

/** Characters of one scored piece at most (a long paragraph is cut into pieces of this size). */
const CHUNK_CHARS = 1_200;
/** A section cut into the pieces that are scored: table rows and paragraphs, so one row of a long table is found on its own. */
function chunksOf(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\n[ \t]*\n|\n(?=[ \t]*\|)/u)) {
    const piece = block.trim();
    if (!piece) continue;
    for (let at = 0; at < piece.length; at += CHUNK_CHARS) out.push(piece.slice(at, at + CHUNK_CHARS));
  }
  return out.length ? out : [''];
}

/**
 * Ranks sections for a question (with every manual in, the long handbook pages held
 * every common pair and outranked the one table row that answered "睡觉做到哪一步了"). Each section is cut into rows and paragraphs;
 * a piece scores the query's words it holds, each weighted by how rare it is across all pieces (a word found everywhere, like 现在
 * or 功能, counts for little), single Chinese characters at half weight beside the pairs, a heading hit twice. A section's score is
 * its best piece; the snippet comes from that piece. At most `limit` hits, and at most `perDoc` of one page.
 */
export function searchDocs(query: string, docs: ReadonlyArray<{ spec: HandbookDocSpec; markdown: string }>, limit = 8, perDoc = Infinity, rows = false): HandbookDocHit[] {
  const pairs = queryTerms(query);
  if (!pairs.length) return [];
  const singles = [...new Set((query.match(/[㐀-鿿]/gu) ?? []).filter(c => !FILLER.test(c)))].filter(c => !pairs.includes(c));
  const terms = [...pairs.map(term => ({ term, factor: 1 })), ...singles.map(term => ({ term, factor: 0.5 }))];
  const pieces: Array<{ spec: HandbookDocSpec; section: HandbookDocSection; heading: string; text: string; raw: string; index: number }> = [];
  for (const { spec, markdown } of docs) for (const section of splitDoc(markdown)) {
    const heading = section.heading.toLowerCase();
    chunksOf(section.text).forEach((raw, index) => pieces.push({ spec, section, heading, text: raw.toLowerCase(), raw, index }));
  }
  const n = pieces.length;
  const weight = new Map(terms.map(({ term, factor }) => {
    const df = pieces.reduce((count, piece) => count + (piece.text.includes(term) || piece.heading.includes(term) ? 1 : 0), 0);
    return [term, factor * Math.log(1 + (n - df + 0.5) / (df + 0.5))];
  }));
  const total = [...weight.values()].reduce((sum, value) => sum + value, 0);
  const best = new Map<string, HandbookDocHit>();
  for (const piece of pieces) {
    let score = 0, first = -1;
    for (const { term } of terms) {
      const w = weight.get(term)!;
      if (piece.heading.includes(term)) score += w;
      const at = piece.text.indexOf(term);
      if (at >= 0) { score += w; if (first < 0 || at < first) first = at; }
    }
    // A piece must hold at least a fifth of what the question says, weighted (a few common words are not a match). Inside one page
    // (rows) any piece that holds a word counts: the list is ranked and short, and a row that names the thing in other words (the
    // third isolated test: "睡觉" against the sleep row, which says 睡下去 / 睡着) would otherwise never be seen.
    if (score <= 0 || (!rows && score < total / 5)) continue;
    // rows: every matching row or paragraph is its own hit (searching inside one page); otherwise a section's best piece stands for it.
    const key = rows ? `${piece.spec.id}#${piece.section.index}#${piece.index}` : `${piece.spec.id}#${piece.section.index}`;
    const kept = best.get(key);
    if (kept && kept.score >= score) continue;
    const start = Math.max(0, first - 60);
    const snippet = piece.raw.slice(start, start + 220).replace(/\s+/g, ' ').trim();
    best.set(key, { doc: piece.spec.id, title: piece.spec.title, section: piece.section.index, heading: piece.section.heading, snippet,
      score: Math.round(score * 100) / 100, kind: piece.spec.kind });
  }
  // On a tie the user guides come first, then the design pages, then the project handbook.
  const order = (kind: HandbookDocKind) => kind === 'guide' ? 0 : kind === 'design' ? 1 : 2;
  const sorted = [...best.values()].sort((a, b) => b.score - a.score || order(a.kind) - order(b.kind) || a.doc.localeCompare(b.doc) || a.section - b.section);
  // perDoc: at most this many sections of one page, so one long page cannot fill the list (the assistant opens the page for more).
  const taken = new Map<string, number>();
  return sorted.filter(hit => { const count = taken.get(hit.doc) ?? 0; if (count >= perDoc) return false; taken.set(hit.doc, count + 1); return true; }).slice(0, limit);
}
