/**
 * arXiv Paper Scout using Claude Agent SDK
 *
 * Reads one or more arXiv listings, screens every abstract against the
 * research objective in objective.md, keeps the best matches (re-ranking
 * them when more than --max-papers pass) and writes a PowerPoint deck with
 * one slide per paper.
 *
 * Usage: npx tsx scout.ts [listing URL ...] [--objective objective.md] [--max-papers 50] [--min-score 5]
 *        [--screen-model sonnet] [--rank-model opus] [--batch-size 25] [--concurrency 8]
 *        [--delay 15] [--limit N] [--new-only] [--rescreen] [--out out]
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import { absUrl, fetchListing, fillAbstracts, type Paper } from './arxiv';
import { screenPapers, rankPapers, getTotalCostUsd, type Evaluated } from './evaluate';
import { buildDeck, fitLabel } from './deck';
import { readJson, writeJson } from './cache';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    objective: { type: 'string', default: 'objective.md' },
    'max-papers': { type: 'string', default: '50' }, // slides in the deck
    'min-score': { type: 'string', default: '5' }, // 0-10; papers below this are dropped
    'screen-model': { type: 'string', default: 'sonnet' },
    'rank-model': { type: 'string', default: 'opus' },
    'batch-size': { type: 'string', default: '25' }, // abstracts per screening query
    concurrency: { type: 'string', default: '8' }, // screening queries in flight
    rescreen: { type: 'boolean', default: false }, // re-score papers scored with an earlier objective.md
    delay: { type: 'string', default: '15' }, // seconds between arxiv.org page requests (robots.txt Crawl-delay)
    limit: { type: 'string' }, // only the first N listing entries, for trying things out
    'new-only': { type: 'boolean', default: false }, // skip papers already selected in an earlier deck
    out: { type: 'string', default: 'out' },
  },
});

const DEFAULT_LISTING = 'https://arxiv.org/list/cs.AI/recent';

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
  const urls = positionals.length ? positionals : [DEFAULT_LISTING];
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
  const byId = new Map<string, Paper>();
  for (const url of urls) {
    const listing = await fetchListing(url, delayMs);
    listingNames.push(`${listing.category}/${listing.kind}`);
    for (const p of listing.papers) if (!byId.has(p.id)) byId.set(p.id, p);
  }
  let papers = [...byId.values()];
  if (args.limit) papers = papers.slice(0, Number(args.limit));

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
  const name = listingNames.join('+').replace(/\//g, '-');
  const outDir = path.join(outRoot, name);
  fs.mkdirSync(outDir, { recursive: true });
  const stem = `${name}-${isoDay(new Date())}`;

  fs.writeFileSync(
    path.join(outDir, `${stem}.json`),
    JSON.stringify({ objective: objectiveTitle, listings: listingNames, selected, also_relevant: extra, screened: screened.length }, null, 1),
  );
  writeMarkdown(path.join(outDir, `${stem}.md`), `${objectiveTitle}: ${listingNames.join(', ')}`, selected, extra);

  if (selected.length) {
    const deckPath = path.join(outDir, `${stem}.pptx`);
    await buildDeck(selected, extra, {
      objectiveTitle, listings: listingNames, screened: screened.length, matched: matched.length, date: new Date(),
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
