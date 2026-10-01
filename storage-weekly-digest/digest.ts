/**
 * Storage Weekly Digest using Claude Agent SDK
 *
 * Reads the last week of articles from blocksandfiles.com, has Claude strip
 * the marketing language from each one, and writes a PowerPoint deck with
 * one slide per technical article, a section for low-substance articles,
 * and the week's top insights and releases.
 *
 * Usage: npx tsx digest.ts [--days 7] [--until YYYY-MM-DD] [--model opus] [--concurrency 4] [--out out]
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import { fetchArticles, type Article } from './blocksandfiles';
import { analyzeArticle, synthesizeWeek, getTotalCostUsd, ArticleAnalysis, type RunOptions } from './analysis';
import { buildDeck, type DeckItem } from './deck';

const { values: args } = parseArgs({
  options: {
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

async function main() {
  const to = args.until ? new Date(`${args.until}T00:00:00`) : new Date();
  const from = new Date(to.getTime() - Number(args.days) * 24 * 3600 * 1000);
  const opts: RunOptions = { model: args.model! };
  const isoDay = (d: Date) => d.toISOString().slice(0, 10);

  const outDir = path.resolve(args.out!);
  const cacheDir = path.join(outDir, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  console.log(`\n📡 Fetching blocksandfiles.com articles from ${from.toISOString()} to ${to.toISOString()}\n`);
  const articles = await fetchArticles(from, to);
  if (!articles.length) {
    console.log('No articles found in this window.');
    return;
  }
  console.log(`Found ${articles.length} articles.\n`);

  console.log(`🧠 Analysing articles with ${opts.model}...\n`);
  const items = (await mapLimit(articles, Number(args.concurrency), (a) => analyzeCached(a, cacheDir, opts))).filter(
    (x): x is DeckItem => x !== null,
  );

  if (!items.length) throw new Error('No article could be analysed.');

  console.log('\n📊 Synthesising the week...\n');
  const synthesis = await synthesizeWeek(items, opts);
  fs.writeFileSync(path.join(outDir, `synthesis-${isoDay(from)}_${isoDay(to)}.json`), JSON.stringify(synthesis, null, 2));

  const deckPath = path.join(outDir, `storage-digest-${isoDay(from)}_${isoDay(to)}.pptx`);
  await buildDeck(items, synthesis, { from, to }, deckPath);

  console.log('='.repeat(50));
  console.log(`📄 Deck saved to: ${deckPath}`);
  console.log(`💰 Claude cost this run: $${getTotalCostUsd().toFixed(2)}`);
  console.log('='.repeat(50) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
