const TERMINAL = /[.!?。！？]/;
const CJK_TERMINAL = /[。！？]/;
const CLOSER = /["'”’」』）)\]】》〉»]/;
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc',
  'e.g', 'i.e', 'fig', 'no', 'dept', 'approx', 'inc', 'ltd',
  'a.m', 'p.m', 'u.s', 'u.k',
]);
const LIST = /^ {0,3}(?:[-+*]\s|\d+[.)]\s|\d+[、）]\s*|[（(]\d+[）)]\s*|[一二三四五六七八九十百]+[、）]\s*)/;

interface InlineState { ticks: number; brackets: number; destination: number; angle: boolean }

function structuredLine(line: string): boolean {
  return /^(?: {4}|\t)/.test(line)
    || LIST.test(line)
    || /^ {0,3}(?:#{1,6}(?:\s|$)|>|\[[^\]]+\]:)/.test(line)
    || /^\s*(?:(?:[-*_]\s*){3,}|[{}]|["'][^"']+["']\s*:)/.test(line)
    || line.includes('|')
    || /^\s*(?:\[[^\]\r\n]{1,40}\]|\d{4}-\d\d-\d\d[T ]|\d\d:\d\d:\d\d|(?:DEBUG|INFO|WARN|WARNING|ERROR|TRACE|FATAL)\b|\$\s|PS\s|at\s.+(?:\(|:\d+))/.test(line);
}

function abbreviation(line: string, dot: number): boolean {
  // Bounded look-behind keeps a long prose line linear in its character count.
  const word = line.slice(Math.max(0, dot - 48), dot).match(/([A-Za-z][A-Za-z.]*)$/)?.[1];
  return !!word && (ABBREVIATIONS.has(word.toLowerCase())
    || /^[A-Za-z]$/.test(word)
    || /^(?:[A-Za-z]\.)+[A-Za-z]$/.test(word));
}

function proseLine(line: string, state: InlineState, format = true, boundary?: (offset: number) => void, terminalAtLineEnd = false): string {
  const pieces: string[] = [];
  let from = 0;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '`') {
      let end = index + 1;
      while (line[end] === '`') end++;
      const count = end - index;
      if (!state.ticks) state.ticks = count;
      else if (state.ticks === count) state.ticks = 0;
      index = end - 1;
      continue;
    }
    if (state.ticks) continue;
    if (char === '\\') { index++; continue; }
    if (char === '<') { state.angle = true; continue; }
    if (state.angle) { if (char === '>') state.angle = false; continue; }
    if (char === '[') { state.brackets++; continue; }
    if (char === ']') { state.brackets = Math.max(0, state.brackets - 1); continue; }
    if (char === '(' && (line[index - 1] === ']' || state.destination)) { state.destination++; continue; }
    if (state.destination) { if (char === ')') state.destination--; continue; }
    if (!format || state.brackets || !TERMINAL.test(char)) continue;

    let end = index + 1;
    while (end < line.length && TERMINAL.test(line[end])) end++;
    const punctuation = line.slice(index, end);
    // Ellipses are often pauses inside one sentence. Never turn their pieces
    // into separate paragraphs, including when streaming a dot at a time.
    if (/^\.{2,}$/.test(punctuation)) { index = end - 1; continue; }
    if (punctuation === '.' && abbreviation(line, index)) continue;
    while (end < line.length && CLOSER.test(line[end])) end++;

    // Keep a sentence's closing Markdown emphasis with it. A marker directly
    // before another word can be an opening marker and stays in the next part.
    const emphasis = line.slice(end, end + 5).match(/^(?:\*{1,3}|_{1,3})(?=\s|$)/)?.[0];
    if (emphasis) end += emphasis.length;
    const cjk = CJK_TERMINAL.test(punctuation);
    if (!cjk && end < line.length && !/\s/.test(line[end])) { index = end - 1; continue; }
    let next = end;
    while (next < line.length && /[ \t]/.test(line[next])) next++;
    // No trailing separator: incomplete text stays immediately visible and a
    // later decimal/abbreviation/closing quote can still be classified safely.
    if (next >= line.length) { if (terminalAtLineEnd) boundary?.(line.length); index = end - 1; continue; }
    boundary?.(next);
    pieces.push(line.slice(from, next), '\n\n');
    from = next;
    index = next - 1;
  }
  if (!pieces.length) return line;
  pieces.push(line.slice(from));
  return pieces.join('');
}

/**
 * Display-only, deterministic formatting of one cumulative logical reply.
 * Only inserts blank lines; the caller retains the original for archive, TTS,
 * protocol identity and semantic actions. There is no sentence queue or timer.
 * Each call is independent, so cancellation/scope changes retain no old text.
 * Original line breaks, Markdown blocks and whitespace are never removed.
 */
function processReplySegments(text: string, boundary?: (offset: number) => void): string {
  const lines = text.split(/(\r\n|\r|\n)/);
  const offsets: number[] = [];
  for (let i = 0, offset = 0; i < lines.length; i++) { offsets.push(offset); offset += lines[i].length; }
  let fence: { marker: string; count: number } | undefined;
  let listContinuation = false;
  const inline: InlineState = { ticks: 0, brackets: 0, destination: 0, angle: false };
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index];
    if (!fence && !line.trim()) {
      listContinuation = false;
      inline.ticks = inline.brackets = inline.destination = 0; inline.angle = false;
      continue;
    }
    if (!fence && (inline.ticks || inline.brackets || inline.destination || inline.angle)) {
      lines[index] = proseLine(line, inline, !structuredLine(line), offset => boundary?.(offsets[index] + offset), !!boundary && offsets[index] + line.length < text.length);
      continue;
    }
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.count && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) {
      fence = { marker: marker[1][0], count: marker[1].length };
      continue;
    }
    if (LIST.test(line) || /^ {0,3}>/.test(line)) listContinuation = true;
    if (listContinuation || structuredLine(line)) continue;
    if (/^\s*(?:={3,}|-{3,})\s*$/.test(lines[index + 2] ?? '')) continue;
    lines[index] = proseLine(line, inline, true, offset => boundary?.(offsets[index] + offset), !!boundary && offsets[index] + line.length < text.length);
  }
  return lines.join('');
}


export interface ReplySegment { start: number; end: number; text: string }

/** Display keeps its legacy formatting; archive and authorization keep original bytes. */
export function formatReplySegments(text: string): string { return processReplySegments(text); }

const MAX_SEGMENTS = 128;
const MAX_SPEECH_SEGMENT = 2_000;

/** Bounded original-text slices from a completed reply; no changed or omitted characters.
 * Throws before playback if the whole text cannot fit in the bounded queue. */
export function splitReplySegments(text: string): ReplySegment[] {
  if (!text) return [];
  if (text.length > MAX_SEGMENTS * MAX_SPEECH_SEGMENT) throw new Error('回复过长，无法完整分段朗读。');
  const boundaries: number[] = [];
  const lastContentEnd = text.search(/\s*$/);
  processReplySegments(text, offset => {
    if (offset > (boundaries.at(-1) ?? 0) && offset < lastContentEnd) boundaries.push(offset);
  });
  const segments: ReplySegment[] = [];
  let start = 0, boundaryIndex = 0;
  while (start < text.length) {
    if (segments.length >= MAX_SEGMENTS) throw new Error('回复过长，无法完整分段朗读。');
    let limit = Math.min(start + MAX_SPEECH_SEGMENT, text.length);
    if (limit < text.length && /[\uD800-\uDBFF]/.test(text[limit - 1]) && /[\uDC00-\uDFFF]/.test(text[limit])) limit--;
    const minEnd = Math.max(start + 1, text.length - (MAX_SEGMENTS - segments.length - 1) * MAX_SPEECH_SEGMENT);
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex] < minEnd) boundaryIndex++;
    const boundary = boundaries[boundaryIndex];
    const end = boundary !== undefined && boundary <= limit ? boundary : limit;
    if (end < minEnd || end <= start) throw new Error('回复过长，无法完整分段朗读。');
    segments.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  return segments;
}

/** Native preview adds only delimiters between the same exact source slices. */
export function formatReplyBubbles(text: string): string {
  try { return splitReplySegments(text).map(segment => segment.text).join("\n\n"); }
  catch { return formatReplySegments(text); }
}
