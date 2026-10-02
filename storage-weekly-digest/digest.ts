/**
 * Storage Weekly Digest using Claude Agent SDK
 *
 * Reads the last week of articles from a storage news site, has Claude strip
 * the marketing language from each one, and writes a PowerPoint deck with
 * one slide per technical article, a section for low-substance articles,
 * and the week's top insights and releases.
 *
 * Usage: npx tsx digest.ts [--site blocksandfiles,storagereview|all] [--days 7] [--until YYYY-MM-DD] [--model opus] [--concurrency 4] [--out out]
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import { SOURCES, type Article, type Source } from './sources';
import { analyzeArticle, synthesizeWeek, getTotalCostUsd, ArticleAnalysis, type RunOptions } from './analysis';
import { buildDeck, type DeckItem } from './deck';

const { values: args } = parseArgs({
  options: {
    site: { type: 'string', default: 'blocksandfiles' }, // comma-separated source ids, or "all"
    days: { type: 'string', default: '7' },
    until: { type: 'string' }, // exclusive end date, defaults to now
    model: { type: 'string', default: 'opus' },
    concurrency: { type: 'string', default: '4' },
    out: { type: 'string', default: 'out' },
  },
});

/** Runs `fn` over `items` with at most `limit` calls in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Analyses an article, reusing a cached result from a previous run if there is one. */
async function analyzeCached(article: Article, cacheDir: string, opts: RunOptions): Promise<DeckItem | null> {
  const cacheFile = path.join(cacheDir, `${article.id}.json`);
  if (fs.existsSync(cacheFile)) {
    // A cache entry from an older schema fails validation and is re-analysed.
    const cached = ArticleAnalysis.safeParse(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
    if (cached.success) {
      console.log(`  💾 ${article.title} (cached)`);
      return { article, analysis: cached.data };
    }
  }
  try {
    const analysis = await analyzeArticle(article, opts);
    fs.writeFileSync(cacheFile, JSON.stringify(analysis, null, 2));
    const tag = analysis.substance === 'technical' ? '🔬' : '📰';
    console.log(`  ${tag} ${article.title}`);
    return { article, analysis };
  } catch (err) {
    console.warn(`  ❌ ${article.title}: ${(err as Error).message}`);
    return null;
  }
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

async function digestSite(source: Source, from: Date, to: Date) {
  const opts: RunOptions = { model: args.model!, siteName: source.name };
  const outDir = path.resolve(args.out!, source.id);
  const cacheDir = path.join(outDir, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  console.log(`\n📡 Fetching ${source.name} articles from ${from.toISOString()} to ${to.toISOString()}\n`);
  const articles = await source.fetchArticles(from, to);
  if (!articles.length) {
    console.log('No articles found in this window.');
    return;
  }
  console.log(`Found ${articles.length} articles.\n`);

  console.log(`🧠 Analysing articles with ${opts.model}...\n`);
  const items = (await mapLimit(articles, Number(args.concurrency), (a) => analyzeCached(a, cacheDir, opts))).filter(
    (x): x is DeckItem => x !== null,
  );

  if (!items.length) throw new Error(`No ${source.name} article could be analysed.`);

  console.log('\n📊 Synthesising the week...\n');
  const synthesis = await synthesizeWeek(items, opts);
  const range = `${isoDay(from)}_${isoDay(to)}`;
  fs.writeFileSync(path.join(outDir, `synthesis-${range}.json`), JSON.stringify(synthesis, null, 2));

  const deckPath = path.join(outDir, `${source.id}-digest-${range}.pptx`);
  await buildDeck(source.name, items, synthesis, { from, to }, deckPath);
  console.log(`\n📄 Deck saved to: ${deckPath}`);
}

async function main() {
  const to = args.until ? new Date(`${args.until}T00:00:00`) : new Date();
  const from = new Date(to.getTime() - Number(args.days) * 24 * 3600 * 1000);

  const ids = args.site === 'all' ? SOURCES.map((s) => s.id) : args.site!.split(',').map((s) => s.trim());
  const sources = ids.map((id) => {
    const source = SOURCES.find((s) => s.id === id);
    if (!source) throw new Error(`Unknown site "${id}". Known sites: ${SOURCES.map((s) => s.id).join(', ')}, all`);
    return source;
  });

  for (const source of sources) await digestSite(source, from, to);

  console.log('\n' + '='.repeat(50));
  console.log(`💰 Claude cost this run: $${getTotalCostUsd().toFixed(2)}`);
  console.log('='.repeat(50) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
