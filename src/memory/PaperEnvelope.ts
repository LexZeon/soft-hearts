import { PAPER_ENVELOPE } from '../../shared/memory/paper-envelope';

const SVG_NS = 'http://www.w3.org/2000/svg';

export type PixelRun = { x: number; y: number; width: number; color: string };

/** One run per stretch of same-coloured pixels in a row; '.' is left empty. */
export function paperEnvelopeRuns(rows: readonly string[] = PAPER_ENVELOPE.rows, palette: Record<string, string> = PAPER_ENVELOPE.palette): PixelRun[] {
  const runs: PixelRun[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const key = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === key) end++;
      if (key !== '.') {
        const color = palette[key];
        if (!color) throw new Error(`paper envelope: no colour for "${key}"`);
        runs.push({ x, y, width: end - x, color });
      }
      x = end;
    }
  });
  return runs;
}

/**
 * The little pixel envelope (I-123) as an inline SVG: built element by element from fixed data, no markup strings. Decorative,
 * so hidden from screen readers; the size comes from CSS (.about-letter-stamp) and the pixels stay crisp.
 */
export function createPaperEnvelope(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'about-letter-stamp');
  svg.setAttribute('viewBox', `0 0 ${PAPER_ENVELOPE.width} ${PAPER_ENVELOPE.height}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const run of paperEnvelopeRuns()) {
    const rect = doc.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(run.x));
    rect.setAttribute('y', String(run.y));
    rect.setAttribute('width', String(run.width));
    rect.setAttribute('height', '1');
    rect.setAttribute('fill', run.color);
    svg.append(rect);
  }
  return svg;
}
