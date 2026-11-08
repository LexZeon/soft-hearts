// I-025 漏项检查: how an entry of the capability registry (shared/capabilities.ts) names the controls it covers in the
// control window, and how a scan of that window (tests/capability-coverage.test.mjs) is checked against it. Pure data and
// string matching; the scan itself runs in a real browser on the real markup.

/** One interactive element of the control window, as the scan reads it from the DOM. */
export interface ControlDescriptor {
  tag: string;
  /** input/button type ('' when it has none). */
  type: string;
  id: string;
  /** What the user reads on it: aria-label, its text, placeholder, title or its <label> (whitespace collapsed). */
  label: string;
  /** Its data-* attributes, without the `data-` prefix. */
  data: Record<string, string>;
  /** Ids of its ancestors, nearest first. */
  within: string[];
}

/**
 * A pattern is a few space-separated parts; every part must hold:
 * - `#id` (or `#prefix*`): the control's own id;
 * - `@id`: inside the element with this id;
 * - `[data-name]`, `[data-name=value]`, `[data-name=prefix*]`: a data attribute;
 * - `「label」` (or `「prefix*」`): what the user reads on it;
 * - `button` / `input` / `select` / `textarea` / `summary`: its tag.
 */
export interface ControlPattern {
  source: string;
  id?: { value: string; prefix: boolean };
  within: string[];
  data: Array<{ name: string; value: string | null; prefix: boolean }>;
  label?: { value: string; prefix: boolean };
  tag?: string;
}

const TAGS = new Set(['button', 'input', 'select', 'textarea', 'summary']);
const NAME = /^[a-z0-9][a-z0-9_-]*$/u;

const pick = (text: string) => text.endsWith('*') ? { value: text.slice(0, -1), prefix: true } : { value: text, prefix: false };

/** Throws on anything it does not understand, so a typo in the registry fails its own test instead of matching nothing. */
export function parseControlPattern(source: string): ControlPattern {
  const pattern: ControlPattern = { source, within: [], data: [] };
  const parts = source.match(/「[^」]*」|\S+/gu) ?? [];
  if (!parts.length) throw new Error(`空的控件写法：「${source}」`);
  for (const part of parts) {
    if (part.startsWith('「')) {
      if (pattern.label) throw new Error(`一个控件写法只能有一个「文字」：${source}`);
      const text = part.slice(1, -1);
      if (!text || text === '*') throw new Error(`「文字」不能为空：${source}`);
      pattern.label = pick(text);
    } else if (part.startsWith('#')) {
      const id = pick(part.slice(1));
      if (pattern.id || !id.value || !NAME.test(id.value)) throw new Error(`控件 id 写法不对：${source}`);
      pattern.id = id;
    } else if (part.startsWith('@')) {
      const id = part.slice(1);
      if (!NAME.test(id)) throw new Error(`@ 后面要写所在区域的 id：${source}`);
      pattern.within.push(id);
    } else if (part.startsWith('[data-') && part.endsWith(']')) {
      const [name, value] = part.slice(6, -1).split('=', 2);
      if (!NAME.test(name) || value === '') throw new Error(`data 属性写法不对：${source}`);
      pattern.data.push(value === undefined ? { name, value: null, prefix: false } : { name, ...pick(value) });
    } else if (TAGS.has(part)) {
      if (pattern.tag) throw new Error(`一个控件写法只能有一个标签名：${source}`);
      pattern.tag = part;
    } else throw new Error(`看不懂的控件写法「${part}」：${source}`);
  }
  return pattern;
}

const same = (actual: string, expected: { value: string; prefix: boolean }) =>
  expected.prefix ? actual.startsWith(expected.value) : actual === expected.value;

export function controlMatches(pattern: ControlPattern, control: ControlDescriptor): boolean {
  if (pattern.tag && control.tag !== pattern.tag) return false;
  if (pattern.id && !same(control.id, pattern.id)) return false;
  if (pattern.label && !same(control.label, pattern.label)) return false;
  if (pattern.within.some(id => !control.within.includes(id))) return false;
  return pattern.data.every(({ name, value, prefix }) => {
    const actual = control.data[name];
    return actual !== undefined && (value === null || same(actual, { value, prefix }));
  });
}

/** One line a person can find the control by: page area, tag, id or data attribute, and what it says. */
export function describeControl(control: ControlDescriptor): string {
  const key = control.id ? `#${control.id}`
    : Object.entries(control.data).map(([name, value]) => `[data-${name}=${value}]`).join('') || `「${control.label}」`;
  return `${control.within[0] ? `@${control.within[0]} ` : ''}${control.tag}${control.type && control.type !== control.tag ? `:${control.type}` : ''} ${key}`
    + (control.label ? ` —「${control.label.slice(0, 40)}」` : '');
}

/** Controls no pattern covers: each is a gap in the registry (neither listed nor marked 不开放). */
export function unregisteredControls(controls: readonly ControlDescriptor[], patterns: readonly ControlPattern[]): ControlDescriptor[] {
  return controls.filter(control => !patterns.some(pattern => controlMatches(pattern, control)));
}

/** Patterns that match nothing on the page: the control was renamed or removed, so the registry is out of date. */
export function unusedPatterns(controls: readonly ControlDescriptor[], patterns: readonly ControlPattern[]): ControlPattern[] {
  return patterns.filter(pattern => !controls.some(control => controlMatches(pattern, control)));
}
