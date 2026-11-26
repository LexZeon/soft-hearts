/**
 * Click-through, UI half: does the element under the pointer draw anything there? (the catch area must be her body and what is visible, nothing else.)
 *
 * A control that is shown but only a transparent box (the chat container around its form, a panel's margin, an overlay's padding) has
 * pointer-events: auto yet shows nothing; it used to count as a control and took the mouse. A control counts only if it paints: a
 * background, an image, a border, a shadow, own text, or it is a form control / button / link / media. Anything else lets the pointer
 * fall back to the stage (her pixels decide) or through. Pure: the style is read through the `view` the caller passes.
 */
export interface PaintStyle {
  backgroundColor: string; backgroundImage: string; boxShadow: string;
  borderTopWidth: string; borderTopStyle: string; borderLeftWidth: string; borderLeftStyle: string;
  borderBottomWidth: string; borderBottomStyle: string; borderRightWidth: string; borderRightStyle: string;
}
export interface PaintView { getComputedStyle?(element: Element): PaintStyle }

/** Elements that are a control or content by what they are, whatever their style says. */
const ALWAYS_PAINTED = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A', 'SUMMARY', 'CANVAS', 'IMG', 'SVG', 'VIDEO', 'DIALOG', 'OPTION', 'LABEL']);

/** True when the colour text is not fully transparent ("rgba(0, 0, 0, 0)", "transparent"). */
export function colourShows(value: string): boolean {
  const text = value.trim().toLowerCase();
  if (!text || text === 'transparent') return false;
  const rgba = /^rgba?\(([^)]*)\)$/.exec(text);
  if (rgba) {
    const parts = rgba[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length >= 4) return Number.parseFloat(parts[3]) > 0.02;
    return true;
  }
  return true;
}

const sideShows = (width: string, style: string): boolean => style !== 'none' && style !== 'hidden' && Number.parseFloat(width) > 0;

/** Does `element` draw something of its own (so a click on it is a click on something the user sees)? Unknown style: assume it does. */
export function elementPaints(element: Element, view: PaintView | null | undefined): boolean {
  const tag = String((element as { tagName?: string }).tagName ?? '').toUpperCase();
  if (ALWAYS_PAINTED.has(tag)) return true;
  if ((element as { isContentEditable?: boolean }).isContentEditable === true) return true;
  const style = typeof view?.getComputedStyle === 'function' ? view.getComputedStyle(element) : null;
  if (!style) return true;
  if (colourShows(style.backgroundColor) || (style.backgroundImage && style.backgroundImage !== 'none')) return true;
  if (style.boxShadow && style.boxShadow !== 'none') return true;
  if (sideShows(style.borderTopWidth, style.borderTopStyle) || sideShows(style.borderLeftWidth, style.borderLeftStyle)
    || sideShows(style.borderBottomWidth, style.borderBottomStyle) || sideShows(style.borderRightWidth, style.borderRightStyle)) return true;
  return ownText(element);
}

/**
 * Is there something drawn at the point: the element under the pointer or the first of its ancestors (a path inside an icon inside a
 * button; a gap inside a panel that has a background) that paints? The page roots are never painted things (`isRoot`).
 */
export function paintedAt(element: Element, view: PaintView | null | undefined, isRoot: (element: Element) => boolean): boolean {
  let node: Element | null = element;
  for (let depth = 0; node && depth < 40 && !isRoot(node); depth++) {
    if (elementPaints(node, view)) return true;
    node = (node as { parentElement?: Element | null }).parentElement ?? null;
  }
  return false;
}

/** Text that sits directly in the element (not in a child): the words themselves are what is under the pointer. */
function ownText(element: Element): boolean {
  for (const node of Array.from(element.childNodes ?? [])) {
    if (node.nodeType === 3 && (node.textContent ?? '').trim() !== '') return true;
  }
  return false;
}
