/**
 * Renders the weekly digest as a .pptx with pptxgenjs.
 *
 * Deck structure:
 *   Title
 *   Week summary           — top insights, top releases
 *   Technical articles     — one slide per substantive article
 *   Low-substance articles — short summaries, several per slide
 */

import PptxGenJS from 'pptxgenjs';
import type { Article } from './blocksandfiles';
import type { ArticleAnalysis, WeekSynthesis } from './analysis';

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
const LOW_ITEMS_PER_SLIDE = 7;

const SECTION_TECH = 'Technical articles';
const SECTION_LOW = 'Low-substance articles';
const SECTION_SUMMARY = 'Week summary';

export interface DeckItem {
  article: Article;
  analysis: ArticleAnalysis;
}

const fmtDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function addTitle(slide: PptxGenJS.Slide, title: string, subtitle?: string) {
  slide.addShape('rect', { x: 0, y: 0, w: W, h: 0.12, fill: { color: C.accent }, line: { color: C.accent } });
  slide.addText(title, {
    x: MARGIN, y: 0.3, w: CONTENT_W, h: 0.7,
    fontFace: FONT, fontSize: 24, bold: true, color: C.ink, fit: 'shrink', valign: 'top',
  });
  if (subtitle) {
    slide.addText(subtitle, { x: MARGIN, y: 0.95, w: CONTENT_W, h: 0.35, fontFace: FONT, fontSize: 12, color: C.muted });
  }
}

function addSourceFooter(slide: PptxGenJS.Slide, url: string) {
  slide.addText([{ text: 'Source: ' }, { text: url, options: { hyperlink: { url }, color: C.link } }], {
    x: MARGIN, y: 7.0, w: CONTENT_W, h: 0.3, fontFace: FONT, fontSize: 8, color: C.muted, fit: 'shrink',
  });
}

const PARA_GAP_PT = 4;

function bullets(lines: string[], fontSize: number): PptxGenJS.TextProps[] {
  return lines.map((text) => ({
    text,
    options: { bullet: { indent: 14 }, fontSize, paraSpaceAfter: PARA_GAP_PT, breakLine: true },
  }));
}

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

/** A titled, filled box on the right-hand column; `paragraphs` are rendered as bullets. */
function addPanel(slide: PptxGenJS.Slide, y: number, h: number, heading: string, paragraphs: string[], fill: string) {
  const x = 8.35;
  const w = W - MARGIN - x;
  const pt = fitFontSize([heading, ...paragraphs], w - 0.45, h - 0.1, 11);
  slide.addShape('rect', { x, y, w, h, fill: { color: fill }, line: { color: fill } });
  slide.addText(
    [
      { text: heading, options: { bold: true, fontSize: pt + 1, color: C.accent, breakLine: true, paraSpaceAfter: PARA_GAP_PT } },
      ...bullets(paragraphs, pt),
    ],
    { x: x + 0.1, y: y + 0.05, w: w - 0.2, h: h - 0.1, fontFace: FONT, color: C.ink, valign: 'top' },
  );
}

function addTechnicalSlide(pptx: PptxGenJS, { article, analysis: a }: DeckItem) {
  const slide = pptx.addSlide({ sectionTitle: SECTION_TECH });
  const subtitle = [a.vendor, fmtDate(article.published), a.release ? `Release: ${a.release.product}` : null]
    .filter(Boolean)
    .join('  ·  ');
  addTitle(slide, a.slide_title, subtitle);

  // Left column: context summary, then technical essence, key figures, key insights.
  slide.addShape('rect', { x: MARGIN, y: 1.45, w: 0.06, h: 0.75, fill: { color: C.accent }, line: { color: C.accent } });
  slide.addText(a.summary, {
    x: MARGIN + 0.15, y: 1.45, w: 7.45, h: 0.75, fontFace: FONT, color: C.ink, valign: 'middle',
    fontSize: fitFontSize([a.summary], 7.25, 0.7, 13),
  });

  const sections: [string, string[]][] = [
    ['Technical essence', a.technical_essence.slice(0, 5)],
    ['Key figures', a.key_figures.slice(0, 3)],
    ['Key insights', a.key_insights.slice(0, 3)],
  ];
  const nonEmpty = sections.filter(([, lines]) => lines.length);
  const pt = fitFontSize(nonEmpty.flatMap(([title, lines]) => [title, ...lines]), 7.3, 4.5, 12);
  const left = nonEmpty.flatMap(([title, lines]): PptxGenJS.TextProps[] => [
    { text: title, options: { bold: true, fontSize: pt + 1.5, color: C.accent, breakLine: true, paraSpaceAfter: PARA_GAP_PT } },
    ...bullets(lines, pt),
  ]);
  slide.addText(left, { x: MARGIN, y: 2.35, w: 7.6, h: 4.55, fontFace: FONT, color: C.ink, valign: 'top' });

  // Right column: novelty, marketing decoder, open-source path.
  addPanel(slide, 1.45, 1.75, "What's actually new", [a.whats_new], C.warnSoft);
  const decoder = a.marketing_decoder.slice(0, 3).map((d) => `${d.marketing_term} → ${d.what_it_is}`);
  addPanel(slide, 3.3, 1.6, 'Marketing → reality', decoder.length ? decoder : ['No marketing names to decode.'], C.accentSoft);
  addPanel(slide, 5.0, 1.85, 'Open-source path', a.open_source_path.slice(0, 3), C.accentSoft);

  addSourceFooter(slide, article.url);
}

function addLowSubstanceSlides(pptx: PptxGenJS, items: DeckItem[]) {
  const pages = Math.ceil(items.length / LOW_ITEMS_PER_SLIDE);
  for (let p = 0; p < pages; p++) {
    const slide = pptx.addSlide({ sectionTitle: SECTION_LOW });
    const suffix = pages > 1 ? ` (${p + 1}/${pages})` : '';
    addTitle(slide, `Low-substance articles${suffix}`, 'Business news and announcements with little technical content');

    const rows: PptxGenJS.TableRow[] = items.slice(p * LOW_ITEMS_PER_SLIDE, (p + 1) * LOW_ITEMS_PER_SLIDE).map(
      ({ article, analysis }) => [
        { text: analysis.vendor, options: { bold: true } },
        {
          text: [
            { text: analysis.summary, options: { breakLine: true } },
            { text: article.url, options: { hyperlink: { url: article.url }, fontSize: 8, color: C.link } },
          ],
        },
      ],
    );
    slide.addTable(rows, {
      x: MARGIN, y: 1.45, w: CONTENT_W, colW: [2.2, CONTENT_W - 2.2],
      fontFace: FONT, fontSize: 12, color: C.ink, valign: 'top',
      border: { type: 'solid', pt: 0.5, color: C.rule }, margin: 0.06,
    });
  }
}

function addInsightsSlide(pptx: PptxGenJS, synthesis: WeekSynthesis, byId: Map<string, DeckItem>) {
  const slide = pptx.addSlide({ sectionTitle: SECTION_SUMMARY });
  addTitle(slide, 'Most important insights of the week');

  const runs: PptxGenJS.TextProps[] = [];
  synthesis.top_insights.slice(0, 6).forEach((insight, i) => {
    runs.push({ text: `${i + 1}. ${insight.headline}`, options: { bold: true, fontSize: 14, color: C.accent, breakLine: true } });
    runs.push({ text: insight.detail, options: { fontSize: 12, breakLine: true } });
    const refs = insight.article_ids.map((id) => byId.get(id)).filter((x): x is DeckItem => !!x);
    if (refs.length) {
      refs.forEach((ref, j) => {
        runs.push({
          text: (j === 0 ? '↳ ' : ' · ') + ref.analysis.vendor,
          options: { fontSize: 8, color: C.link, hyperlink: { url: ref.article.url } },
        });
      });
      runs.push({ text: '', options: { breakLine: true } });
    }
    runs.push({ text: ' ', options: { fontSize: 6, breakLine: true } });
  });
  slide.addText(runs, { x: MARGIN, y: 1.2, w: CONTENT_W, h: 5.7, fontFace: FONT, color: C.ink, valign: 'top', fit: 'shrink' });
}

function addReleasesSlide(pptx: PptxGenJS, synthesis: WeekSynthesis, byId: Map<string, DeckItem>) {
  const slide = pptx.addSlide({ sectionTitle: SECTION_SUMMARY });
  addTitle(slide, 'Most important releases of the week');

  const header: PptxGenJS.TableRow = ['Vendor', 'Product', 'Why it matters', 'Availability'].map((text) => ({
    text,
    options: { bold: true, color: 'FFFFFF', fill: { color: C.accent } },
  }));
  const rows: PptxGenJS.TableRow[] = synthesis.top_releases.slice(0, 8).map((r) => {
    const item = byId.get(r.article_id);
    const product: PptxGenJS.TableCell = item
      ? { text: [{ text: r.product, options: { hyperlink: { url: item.article.url }, color: C.link } }] }
      : { text: r.product };
    return [
      { text: r.vendor, options: { bold: true } },
      product,
      { text: r.why_it_matters },
      { text: item?.analysis.release?.availability ?? '' },
    ];
  });
  slide.addTable([header, ...rows], {
    x: MARGIN, y: 1.2, w: CONTENT_W, colW: [1.8, 2.6, 6.0, CONTENT_W - 10.4],
    fontFace: FONT, fontSize: 10, color: C.ink, valign: 'top',
    border: { type: 'solid', pt: 0.5, color: C.rule }, margin: 0.06,
  });
  slide.addText('Product names link to the source articles.', {
    x: MARGIN, y: 7.0, w: CONTENT_W, h: 0.3, fontFace: FONT, fontSize: 8, color: C.muted,
  });
}

export async function buildDeck(
  items: DeckItem[],
  synthesis: WeekSynthesis,
  window: { from: Date; to: Date },
  outPath: string,
) {
  const pptx = new Pptx();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = `Storage weekly digest ${fmtDate(window.from)} – ${fmtDate(window.to)}`;

  const technical = items.filter((i) => i.analysis.substance === 'technical');
  const low = items.filter((i) => i.analysis.substance === 'low');
  const byId = new Map(items.map((i) => [i.article.id, i]));

  pptx.addSection({ title: 'Title' });
  const title = pptx.addSlide({ sectionTitle: 'Title' });
  title.background = { color: C.accent };
  title.addText('Storage Weekly — Technical Digest', {
    x: MARGIN, y: 2.4, w: CONTENT_W, h: 1, fontFace: FONT, fontSize: 40, bold: true, color: 'FFFFFF',
  });
  title.addText(
    `Blocks and Files, ${fmtDate(window.from)} – ${fmtDate(window.to)}\n` +
      `${items.length} articles · ${technical.length} technical · ${low.length} low-substance`,
    { x: MARGIN, y: 3.5, w: CONTENT_W, h: 1, fontFace: FONT, fontSize: 18, color: 'FFFFFF' },
  );

  pptx.addSection({ title: SECTION_SUMMARY });
  addInsightsSlide(pptx, synthesis, byId);
  addReleasesSlide(pptx, synthesis, byId);

  if (technical.length) {
    pptx.addSection({ title: SECTION_TECH });
    technical.forEach((item) => addTechnicalSlide(pptx, item));
  }
  if (low.length) {
    pptx.addSection({ title: SECTION_LOW });
    addLowSubstanceSlides(pptx, low);
  }

  await pptx.writeFile({ fileName: outPath });
}
