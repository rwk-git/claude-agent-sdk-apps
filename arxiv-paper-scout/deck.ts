/**
 * Renders the selected papers as a .pptx with pptxgenjs.
 *
 * Deck structure:
 *   Title
 *   Overview        — ranked table; titles link to the paper slides
 *   Papers          — one slide per selected paper
 *   Also relevant   — papers that passed screening but did not make the cut
 */

import PptxGenJS from 'pptxgenjs';
import { absUrl, pdfUrl } from './arxiv';
import type { Evaluated } from './evaluate';

// pptxgenjs's ESM build is loaded as a namespace object by tsx; unwrap the class.
const Pptx = ((PptxGenJS as any).default ?? PptxGenJS) as typeof PptxGenJS;

const FONT = 'Calibri';
const C = {
  ink: '1F2933',
  muted: '6B7280',
  accent: '0F766E',
  accentSoft: 'E6F4F1',
  warnSoft: 'FFF7E6',
  link: '2563EB',
  rule: 'D1D5DB',
};

// LAYOUT_WIDE is 13.333 x 7.5 in.
const W = 13.333;
const MARGIN = 0.5;
const CONTENT_W = W - 2 * MARGIN;
const OVERVIEW_ROWS = 12;
const EXTRA_ROWS = 10;

/** Qualitative label for a score, matching the scoring guide in objective.md. */
export function fitLabel(score: number): { label: string; color: string } {
  if (score >= 9) return { label: 'Excellent fit', color: '0F766E' };
  if (score >= 7) return { label: 'Strong fit', color: '2563EB' };
  if (score >= 5) return { label: 'Moderate fit', color: 'B45309' };
  if (score >= 3) return { label: 'Weak fit', color: '6B7280' };
  return { label: 'No fit', color: '9CA3AF' };
}

const PARA_GAP_PT = 4;

/**
 * Largest font size (pt) at which `paragraphs` fit in a w x h inch box.
 * pptxgenjs's `fit: 'shrink'` only takes effect once PowerPoint re-lays out
 * the text, so we size text ourselves from a rough Calibri estimate
 * (average glyph width ~0.5 em, line height 1.2 em).
 */
function fitFontSize(paragraphs: string[], w: number, h: number, max: number, min = 8): number {
  const height = (pt: number) => {
    const charsPerLine = (w * 72) / (pt * 0.5);
    const lines = paragraphs.reduce((n, p) => n + Math.max(1, Math.ceil(p.length / charsPerLine)), 0);
    return (lines * pt * 1.2 + paragraphs.length * PARA_GAP_PT) / 72;
  };
  for (let pt = max; pt > min; pt -= 0.5) if (height(pt) <= h) return pt;
  return min;
}

function addHeader(slide: PptxGenJS.Slide, title: string, subtitle?: string, titleW = CONTENT_W) {
  slide.addShape('rect', { x: 0, y: 0, w: W, h: 0.12, fill: { color: C.accent }, line: { color: C.accent } });
  slide.addText(title, {
    x: MARGIN, y: 0.25, w: titleW, h: 0.9, valign: 'middle',
    fontFace: FONT, fontSize: fitFontSize([title], titleW - 0.1, 0.85, 24, 14), bold: true, color: C.ink,
  });
  if (subtitle) {
    slide.addText(subtitle, {
      x: MARGIN, y: 1.15, w: CONTENT_W, h: 0.35, fontFace: FONT, color: C.muted,
      fontSize: fitFontSize([subtitle], CONTENT_W - 0.1, 0.3, 12, 8),
    });
  }
}

const authorLine = (authors: string[]) =>
  authors.length > 4 ? `${authors.slice(0, 3).join(', ')} et al.` : authors.join(', ');

/** A titled, filled box; `body` is a single paragraph. */
function addPanel(slide: PptxGenJS.Slide, x: number, y: number, w: number, h: number, heading: string, body: string, fill: string) {
  const pt = fitFontSize([heading, body], w - 0.3, h - 0.15, 13);
  slide.addShape('rect', { x, y, w, h, fill: { color: fill }, line: { color: fill } });
  slide.addText(
    [
      { text: heading, options: { bold: true, fontSize: pt + 1, color: C.accent, breakLine: true, paraSpaceAfter: PARA_GAP_PT } },
      { text: body, options: { fontSize: pt } },
    ],
    { x: x + 0.1, y: y + 0.05, w: w - 0.2, h: h - 0.1, fontFace: FONT, color: C.ink, valign: 'top' },
  );
}

function addPaperSlide(pptx: PptxGenJS, { paper, assessment: a }: Evaluated, rank: number, overviewSlide: number) {
  const slide = pptx.addSlide({ sectionTitle: 'Papers' });
  const subtitle = [authorLine(paper.authors), paper.listedUnder, `arXiv:${paper.id}`, paper.subjects.split(';')[0]]
    .filter(Boolean)
    .join('  ·  ');
  addHeader(slide, `${rank}. ${paper.title}`, subtitle, CONTENT_W - 2.1);

  // Score badge, top right.
  const fit = fitLabel(a.score);
  slide.addShape('roundRect', { x: W - MARGIN - 1.9, y: 0.3, w: 1.9, h: 0.8, fill: { color: fit.color }, line: { color: fit.color }, rectRadius: 0.08 });
  slide.addText(
    [
      { text: `${a.score}/10`, options: { fontSize: 22, bold: true, breakLine: true } },
      { text: fit.label, options: { fontSize: 11 } },
    ],
    { x: W - MARGIN - 1.9, y: 0.3, w: 1.9, h: 0.8, fontFace: FONT, color: 'FFFFFF', align: 'center', valign: 'middle' },
  );

  // Left: abstract.
  const abstract = paper.abstract || '(Abstract not available.)';
  const pt = fitFontSize(['Abstract', abstract], 7.6, 5.2, 14);
  slide.addText(
    [
      { text: 'Abstract', options: { bold: true, fontSize: pt + 1.5, color: C.accent, breakLine: true, paraSpaceAfter: PARA_GAP_PT } },
      { text: abstract, options: { fontSize: pt } },
    ],
    { x: MARGIN, y: 1.6, w: 7.8, h: 5.3, fontFace: FONT, color: C.ink, valign: 'top' },
  );

  // Right: why it fits, the storage angle, topics.
  const x = 8.55;
  const w = W - MARGIN - x;
  addPanel(slide, x, 1.6, w, 2.35, 'Why it fits', a.rationale, C.accentSoft);
  addPanel(slide, x, 4.05, w, 2.25, 'Storage angle', a.storage_angle || 'None identified.', C.warnSoft);
  if (a.topics.length) {
    slide.addText(a.topics.join('  ·  '), {
      x, y: 6.35, w, h: 0.5, fontFace: FONT, fontSize: fitFontSize([a.topics.join('  ·  ')], w - 0.1, 0.45, 11), color: C.accent, bold: true, valign: 'top',
    });
  }

  // Footer: links.
  slide.addText(
    [
      { text: absUrl(paper.id), options: { hyperlink: { url: absUrl(paper.id) }, color: C.link } },
      { text: '   ·   ' },
      { text: 'PDF', options: { hyperlink: { url: pdfUrl(paper.id) }, color: C.link } },
      { text: '   ·   ' },
      { text: 'Back to overview', options: { hyperlink: { slide: overviewSlide }, color: C.link } },
    ],
    { x: MARGIN, y: 7.0, w: CONTENT_W, h: 0.3, fontFace: FONT, fontSize: 10, color: C.muted },
  );
}

function scoreCell(score: number): PptxGenJS.TableCell {
  const fit = fitLabel(score);
  return { text: `${score}/10 ${fit.label.replace(' fit', '')}`, options: { bold: true, color: fit.color } };
}

function addOverviewSlides(pptx: PptxGenJS, selected: Evaluated[], firstPaperSlide: number) {
  const pages = Math.ceil(selected.length / OVERVIEW_ROWS);
  for (let p = 0; p < pages; p++) {
    const slide = pptx.addSlide({ sectionTitle: 'Overview' });
    addHeader(slide, `Selected papers${pages > 1 ? ` (${p + 1}/${pages})` : ''}`, 'Titles link to the paper slides');
    const header: PptxGenJS.TableRow = ['#', 'Fit', 'Title', 'Topics'].map((text) => ({
      text,
      options: { bold: true, color: 'FFFFFF', fill: { color: C.accent } },
    }));
    const rows = selected.slice(p * OVERVIEW_ROWS, (p + 1) * OVERVIEW_ROWS).map(({ paper, assessment: a }, i): PptxGenJS.TableRow => {
      const n = p * OVERVIEW_ROWS + i;
      return [
        { text: String(n + 1) },
        scoreCell(a.score),
        { text: [{ text: paper.title, options: { hyperlink: { slide: firstPaperSlide + n }, color: C.link } }] },
        { text: a.topics.join(', '), options: { color: C.muted } },
      ];
    });
    slide.addTable([header, ...rows], {
      x: MARGIN, y: 1.55, w: CONTENT_W, colW: [0.45, 1.6, 7.6, CONTENT_W - 9.65],
      fontFace: FONT, fontSize: 10, color: C.ink, valign: 'middle',
      border: { type: 'solid', pt: 0.5, color: C.rule }, margin: 0.05,
    });
  }
}

function addAlsoRelevantSlides(pptx: PptxGenJS, extra: Evaluated[]) {
  const pages = Math.ceil(extra.length / EXTRA_ROWS);
  for (let p = 0; p < pages; p++) {
    const slide = pptx.addSlide({ sectionTitle: 'Also relevant' });
    addHeader(slide, `Also relevant${pages > 1 ? ` (${p + 1}/${pages})` : ''}`, 'Passed screening but did not make the selection. Titles link to arXiv.');
    const header: PptxGenJS.TableRow = ['Fit', 'Title', 'Why it fits'].map((text) => ({
      text,
      options: { bold: true, color: 'FFFFFF', fill: { color: C.accent } },
    }));
    const rows = extra.slice(p * EXTRA_ROWS, (p + 1) * EXTRA_ROWS).map(({ paper, assessment: a }): PptxGenJS.TableRow => [
      scoreCell(a.score),
      { text: [{ text: paper.title, options: { hyperlink: { url: absUrl(paper.id) }, color: C.link } }] },
      { text: a.rationale },
    ]);
    slide.addTable([header, ...rows], {
      x: MARGIN, y: 1.55, w: CONTENT_W, colW: [1.6, 5.0, CONTENT_W - 6.6],
      fontFace: FONT, fontSize: 9, color: C.ink, valign: 'middle',
      border: { type: 'solid', pt: 0.5, color: C.rule }, margin: 0.05,
    });
  }
}

export interface DeckInfo {
  /** First heading of objective.md. */
  objectiveTitle: string;
  /** e.g. ["cs.AI/recent", "cs.AR/recent"] */
  listings: string[];
  screened: number;
  matched: number;
  date: Date;
}

export async function buildDeck(selected: Evaluated[], extra: Evaluated[], info: DeckInfo, outPath: string) {
  const pptx = new Pptx();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = `arXiv paper scout: ${info.listings.join(', ')}`;
  const date = info.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  pptx.addSection({ title: 'Title' });
  const title = pptx.addSlide({ sectionTitle: 'Title' });
  title.background = { color: C.accent };
  title.addText('arXiv Paper Scout', {
    x: MARGIN, y: 2.0, w: CONTENT_W, h: 1, fontFace: FONT, fontSize: 40, bold: true, color: 'FFFFFF',
  });
  title.addText(info.objectiveTitle, { x: MARGIN, y: 3.0, w: CONTENT_W, h: 0.6, fontFace: FONT, fontSize: 22, color: 'FFFFFF' });
  title.addText(
    `${info.listings.join(', ')} · ${date}\n` +
      `${info.screened} papers screened · ${info.matched} matched · ${selected.length} selected`,
    { x: MARGIN, y: 3.8, w: CONTENT_W, h: 1, fontFace: FONT, fontSize: 16, color: 'FFFFFF' },
  );

  // Slide numbers are 1-based: title, then the overview slides, then the papers.
  const overviewSlide = 2;
  const firstPaperSlide = overviewSlide + Math.ceil(selected.length / OVERVIEW_ROWS);

  pptx.addSection({ title: 'Overview' });
  addOverviewSlides(pptx, selected, firstPaperSlide);

  pptx.addSection({ title: 'Papers' });
  selected.forEach((e, i) => addPaperSlide(pptx, e, i + 1, overviewSlide + Math.floor(i / OVERVIEW_ROWS)));

  if (extra.length) {
    pptx.addSection({ title: 'Also relevant' });
    addAlsoRelevantSlides(pptx, extra);
  }

  await pptx.writeFile({ fileName: outPath });
}
