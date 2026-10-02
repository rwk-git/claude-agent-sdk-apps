/**
 * arXiv Paper Scout using Claude Agent SDK
 *
 * Reads one or more arXiv listings, screens every abstract against the
 * research objective in objective.md, keeps the best matches (re-ranking
 * them when more than --max-papers pass) and writes a PowerPoint deck with
 * one slide per paper.
 *
 * Usage: npx tsx scout.ts [--cat cs.AI,cs.DC] [--period recent|new|YYYY-MM|YYYY-MM..YYYY-MM] [listing URL ...]
 *        [--objective objective.md] [--max-papers 50] [--min-score 5]
 *        [--screen-model sonnet] [--rank-model opus] [--batch-size 25] [--concurrency 8]
 *        [--delay 15] [--offset N] [--limit N] [--new-only] [--rescreen] [--out out]
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import { absUrl, fetchListing, fillAbstracts, type Listing, type Paper } from './arxiv';
import { screenPapers, rankPapers, getTotalCostUsd, type Evaluated } from './evaluate';
import { buildDeck, fitLabel } from './deck';
import { readJson, writeJson } from './cache';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cat: { type: 'string' }, // comma-separated arXiv categories, e.g. cs.OS,cs.DC (default cs.AI unless URLs are given)
    period: { type: 'string', default: 'recent' }, // comma-separated: recent, new, YYYY-MM or YYYY-MM..YYYY-MM
    objective: { type: 'string', default: 'objective.md' },
    'max-papers': { type: 'string', default: '50' }, // slides in the deck
    'min-score': { type: 'string', default: '5' }, // 0-10; papers below this are dropped
    'screen-model': { type: 'string', default: 'sonnet' },
    'rank-model': { type: 'string', default: 'opus' },
    'batch-size': { type: 'string', default: '25' }, // abstracts per screening query
    concurrency: { type: 'string', default: '8' }, // screening queries in flight
    rescreen: { type: 'boolean', default: false }, // re-score papers scored with an earlier objective.md
    delay: { type: 'string', default: '15' }, // seconds between arxiv.org page requests (robots.txt Crawl-delay)
    offset: { type: 'string', default: '0' }, // skip the first N listing entries
    limit: { type: 'string' }, // only take N listing entries (after --offset)
    'new-only': { type: 'boolean', default: false }, // skip papers already selected in an earlier deck
    out: { type: 'string', default: 'out' },
  },
});

const DEFAULT_CATEGORY = 'cs.AI';

const splitList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** Expands a --period value into listing kinds, e.g. "2026-07..2026-09" -> ["2026-07", "2026-08", "2026-09"]. */
function expandPeriods(spec: string): string[] {
  return splitList(spec).flatMap((item) => {
    const range = item.match(/^(\d{4})-(\d{2})\.\.(\d{4})-(\d{2})$/);
    if (range) {
      const [, y1, m1, y2, m2] = range.map(Number);
      const months: string[] = [];
      for (let i = y1 * 12 + m1 - 1; i <= y2 * 12 + m2 - 1; i++) {
        months.push(`${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);
      }
      if (!months.length) throw new Error(`Empty month range "${item}"`);
      return months;
    }
    if (item === 'recent' || item === 'new' || /^\d{4}-\d{2}$/.test(item)) return [item];
    throw new Error(`Unknown period "${item}". Use recent, new, YYYY-MM or YYYY-MM..YYYY-MM.`);
  });
}

const uniq = (xs: string[]) => [...new Set(xs)];

/** YYYY-MM-DD in local time (listing dates are parsed as local midnight). */
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Readable name for the periods the listings cover: consecutive months are
 * merged ("2026-07..2026-09") and "recent" becomes the dates it covered
 * ("2026-09-28..2026-10-02").
 */
function periodName(listings: Listing[]): string {
  const months = uniq(listings.map((l) => l.kind).filter((k) => /^\d{4}-\d{2}$/.test(k))).sort();
  const parts: string[] = [];
  const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
  for (let i = 0; i < months.length; ) {
    let j = i;
    while (j + 1 < months.length && monthIndex(months[j + 1]) === monthIndex(months[j]) + 1) j++;
    parts.push(i === j ? months[i] : `${months[i]}..${months[j]}`);
    i = j + 1;
  }
  if (listings.some((l) => l.kind === 'recent')) {
    const days = listings
      .filter((l) => l.kind === 'recent')
      .flatMap((l) => l.papers.map((p) => Date.parse(p.listedUnder.replace(/^\w+,\s*/, ''))))
      .filter((t) => !isNaN(t));
    const first = localDay(new Date(Math.min(...days)));
    const last = localDay(new Date(Math.max(...days)));
    parts.push(!days.length ? 'recent' : first === last ? first : `${first}..${last}`);
  }
  if (listings.some((l) => l.kind === 'new')) parts.push(`${localDay(new Date())}-new`);
  return parts.join('+');
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Ids of papers selected in earlier runs, with the date they were first selected. */
function loadSeen(file: string): Record<string, string> {
  return readJson<Record<string, string>>(file) ?? {};
}

function writeMarkdown(file: string, title: string, selected: Evaluated[], extra: Evaluated[]) {
  const row = ({ paper, assessment: a }: Evaluated, i: number) =>
    `| ${i + 1} | ${a.score} ${fitLabel(a.score).label} | [${paper.title.replace(/\|/g, '\\|')}](${absUrl(paper.id)}) | ${a.rationale.replace(/\|/g, '\\|')} |`;
  const table = (items: Evaluated[]) => ['| # | Fit | Title | Why it fits |', '|---|---|---|---|', ...items.map(row)].join('\n');
  const md = [`# ${title}`, '', `## Selected (${selected.length})`, '', table(selected)];
  if (extra.length) md.push('', `## Also relevant (${extra.length})`, '', table(extra));
  fs.writeFileSync(file, md.join('\n') + '\n');
}

async function main() {
  // Every --cat x --period combination, plus any listing URLs given as arguments.
  const categories = args.cat ? splitList(args.cat) : positionals.length ? [] : [DEFAULT_CATEGORY];
  const urls = [
    ...positionals,
    ...expandPeriods(args.period!).flatMap((period) => categories.map((c) => `https://arxiv.org/list/${c}/${period}`)),
  ];
  const objective = fs.readFileSync(args.objective!, 'utf8');
  const objectiveTitle = objective.match(/^#\s+(.+)$/m)?.[1].trim() ?? 'Research objective';
  const maxPapers = Number(args['max-papers']);
  const minScore = Number(args['min-score']);
  const delayMs = Number(args.delay) * 1000;

  const outRoot = path.resolve(args.out!);
  const cacheDir = path.join(outRoot, 'cache');
  const seenFile = path.join(outRoot, 'seen.json');

  // 1. Listings
  console.log(`\n📡 Reading ${urls.length} arXiv listing(s)\n`);
  const listingNames: string[] = [];
  const listings: Listing[] = [];
  const byId = new Map<string, Paper>();
  for (const url of urls) {
    const listing = await fetchListing(url, delayMs);
    listingNames.push(`${listing.category}/${listing.kind}`);
    listings.push(listing);
    for (const p of listing.papers) if (!byId.has(p.id)) byId.set(p.id, p);
  }
  let papers = [...byId.values()];
  // A slice of the listing, e.g. --offset 2000 --limit 2000 for entries 2001-4000.
  const offset = Number(args.offset);
  const total = papers.length;
  papers = papers.slice(offset, args.limit ? offset + Number(args.limit) : undefined);
  const range = papers.length < total ? { from: offset + 1, to: offset + papers.length } : null;
  if (range) console.log(`  Taking entries ${range.from}-${range.to} of ${total}`);

  const seen = loadSeen(seenFile);
  if (args['new-only']) {
    const before = papers.length;
    papers = papers.filter((p) => !seen[p.id]);
    console.log(`  Skipping ${before - papers.length} papers selected in earlier runs`);
  }
  console.log(`  ${papers.length} unique papers\n`);
  if (!papers.length) return;

  // 2. Abstracts
  console.log('📚 Collecting abstracts\n');
  papers = await fillAbstracts(papers, path.join(cacheDir, 'papers'), delayMs);

  // 3. Screening
  console.log(`\n🧠 Screening ${papers.length} papers with ${args['screen-model']}\n`);
  const screened = await screenPapers(papers, objective, path.join(cacheDir, 'screening'), {
    model: args['screen-model']!,
    batchSize: Number(args['batch-size']),
    concurrency: Number(args.concurrency),
    minScore,
    rescreen: args.rescreen!,
  });
  const matched = screened
    .filter((e) => e.assessment.score >= minScore)
    .sort((a, b) => b.assessment.score - a.assessment.score);
  console.log(`\n  ${matched.length} of ${screened.length} papers score ${minScore} or more`);

  // 4. Selection: re-rank only when there are more matches than slides.
  let selected = matched;
  if (matched.length > maxPapers) {
    console.log(`\n🏆 Ranking the matches with ${args['rank-model']} to keep the best ${maxPapers}\n`);
    selected = await rankPapers(matched, objective, maxPapers, args['rank-model']!, path.join(cacheDir, 'ranking'));
  }
  const selectedIds = new Set(selected.map((e) => e.paper.id));
  const extra = matched.filter((e) => !selectedIds.has(e.paper.id));

  // 5. Outputs
  // One folder per set of categories, one file per period, e.g.
  // out/cs.AR+cs.DC+cs.OS/2026-09.pptx or out/cs.AI/2026-09_2001-4000.pptx for a slice.
  const cats = uniq(listings.map((l) => l.category)).sort();
  const period = periodName(listings);
  const outDir = path.join(outRoot, cats.join('+'));
  fs.mkdirSync(outDir, { recursive: true });
  const stem = `${period}${range ? `_${range.from}-${range.to}` : ''}`;
  const label = `${cats.join(', ')} · ${period}${range ? ` (entries ${range.from}-${range.to} of ${total})` : ''}`;

  fs.writeFileSync(
    path.join(outDir, `${stem}.json`),
    JSON.stringify({ objective: objectiveTitle, listings: listingNames, range, selected, also_relevant: extra, screened: screened.length }, null, 1),
  );
  writeMarkdown(path.join(outDir, `${stem}.md`), `${objectiveTitle}: ${label}`, selected, extra);

  if (selected.length) {
    const deckPath = path.join(outDir, `${stem}.pptx`);
    await buildDeck(selected, extra, {
      objectiveTitle, listings: [label], screened: screened.length, matched: matched.length, date: new Date(),
    }, deckPath);
    console.log(`\n📄 Deck saved to: ${deckPath}`);
    for (const e of selected) seen[e.paper.id] ??= isoDay(new Date());
    writeJson(seenFile, seen);
  } else {
    console.log('\nNo paper matched the objective, so no deck was written.');
  }
  console.log(`📝 Summary saved to: ${path.join(outDir, `${stem}.md`)}`);

  console.log('\n' + '='.repeat(50));
  console.log(`💰 Claude cost this run: $${getTotalCostUsd().toFixed(2)}`);
  console.log('='.repeat(50) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
