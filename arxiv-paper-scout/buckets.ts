/**
 * Bucket reports over the papers already screened by scout.ts: works only
 * from the cache in out/cache, nothing is downloaded.
 *
 *   classify: extracts the problem each paper (score >= --min-score)
 *             addresses and sorts the papers into the buckets listed in
 *             --buckets (default buckets.md), up to --max-buckets per
 *             paper. Writes out/buckets/<name>.md/.json.
 *   cluster:  extracts the same problems and proposes buckets for them,
 *             written to --buckets (default cluster_buckets.md) in the format
 *             classify reads.
 *
 * Usage: npx tsx buckets.ts classify [--buckets buckets.md] [--max-buckets 3]
 *        npx tsx buckets.ts cluster [--buckets cluster_buckets.md] [--count N]
 *        [--min-score 5] [--model sonnet] [--cluster-model opus]
 *        [--batch-size 25] [--concurrency 8] [--out out]
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import { absUrl, type Paper } from './arxiv';
import { cacheFile, readJson } from './cache';
import { getTotalCostUsd, type Assessment } from './evaluate';
import { classifyProblems, clusterProblems, extractProblems, readBuckets, writeBuckets, type BatchOptions } from './problems';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    buckets: { type: 'string' }, // classify: buckets to read; cluster: file to write
    count: { type: 'string' }, // cluster: number of buckets (default: the model picks 5-10)
    'max-buckets': { type: 'string', default: '3' }, // classify: buckets per paper, main one first
    'min-score': { type: 'string', default: '5' },
    model: { type: 'string', default: 'sonnet' }, // problem extraction and classification
    'cluster-model': { type: 'string', default: 'opus' },
    'batch-size': { type: 'string', default: '25' },
    concurrency: { type: 'string', default: '8' },
    out: { type: 'string', default: 'out' },
  },
});

interface Scored {
  paper: Paper;
  score: number;
}

/** Every cached paper whose cached screening score is at least `minScore`, best first. */
function loadScored(cacheDir: string, minScore: number): Scored[] {
  const screeningDir = path.join(cacheDir, 'screening');
  const scored: Scored[] = [];
  for (const f of fs.readdirSync(screeningDir)) {
    if (!f.endsWith('.json')) continue;
    const a = readJson<{ assessment: Assessment }>(path.join(screeningDir, f))?.assessment;
    if (!a || a.score < minScore) continue;
    const paper = readJson<Paper>(cacheFile(path.join(cacheDir, 'papers'), a.id));
    if (paper) scored.push({ paper, score: a.score });
  }
  return scored.sort((a, b) => b.score - a.score || b.paper.id.localeCompare(a.paper.id));
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

async function run() {
  const mode = positionals[0];
  if (mode !== 'classify' && mode !== 'cluster') throw new Error('Usage: npx tsx buckets.ts classify|cluster [options]');

  const outRoot = path.resolve(args.out!);
  const cacheDir = path.join(outRoot, 'cache');
  const minScore = Number(args['min-score']);
  const opts: BatchOptions = { model: args.model!, batchSize: Number(args['batch-size']), concurrency: Number(args.concurrency) };

  const scored = loadScored(cacheDir, minScore);
  console.log(`\n📚 ${scored.length} screened papers score ${minScore} or more`);
  if (!scored.length) return;
  const papers = scored.map((s) => s.paper);

  console.log(`\n🔎 Extracting the problem each paper addresses with ${opts.model}\n`);
  const problems = await extractProblems(papers, path.join(cacheDir, 'problems'), opts);
  const withProblem = scored.filter((s) => problems.has(s.paper.id));

  if (mode === 'cluster') {
    const file = args.buckets ?? 'cluster_buckets.md';
    console.log(`\n🧩 Clustering ${withProblem.length} problems with ${args['cluster-model']}\n`);
    const buckets = await clusterProblems(
      withProblem.map((s) => s.paper),
      problems,
      args['cluster-model']!,
      args.count ? Number(args.count) : undefined,
    );
    writeBuckets(
      file,
      buckets,
      `Proposed on ${new Date().toISOString().slice(0, 10)} from the problems of ${withProblem.length} papers scoring ${minScore} or more. ` +
        `Edit freely, then sort the papers with \`npx tsx buckets.ts classify --buckets ${file}\`.`,
    );
    for (const b of buckets) console.log(`  • ${b.name}${b.description ? `: ${b.description}` : ''}`);
    console.log(`\n📝 Buckets saved to: ${path.resolve(file)}`);
    return;
  }

  const bucketsFile = args.buckets ?? 'buckets.md';
  const buckets = readBuckets(bucketsFile);
  const maxBuckets = Math.max(1, Number(args['max-buckets']));
  console.log(
    `\n🗂️  Sorting ${withProblem.length} papers into ${maxBuckets > 1 ? `up to ${maxBuckets} of ` : ''}${buckets.length} buckets from ${bucketsFile} with ${opts.model}\n`,
  );
  const classes = await classifyProblems(
    withProblem.map((s) => s.paper),
    problems,
    buckets,
    maxBuckets,
    path.join(cacheDir, 'buckets'),
    opts,
  );
  const classified = withProblem.filter((s) => classes.has(s.paper.id));

  // A paper is listed under each of its buckets: first where it is the main bucket, then where it is an extra one.
  const groups = buckets.map((b) => {
    const isMain = (s: Scored) => classes.get(s.paper.id)!.buckets[0] === b.name;
    const members = classified.filter((s) => classes.get(s.paper.id)!.buckets.includes(b.name));
    return {
      ...b,
      main: members.filter(isMain).length,
      papers: [...members.filter(isMain), ...members.filter((s) => !isMain(s))].map(({ paper, score }) => ({
        id: paper.id,
        title: paper.title,
        listed: paper.listedUnder,
        score,
        problem: problems.get(paper.id)!,
        buckets: classes.get(paper.id)!.buckets,
        reason: classes.get(paper.id)!.reason,
      })),
    };
  });

  const stem = path.basename(bucketsFile, path.extname(bucketsFile));
  const outDir = path.join(outRoot, 'buckets');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, `${stem}.json`),
    JSON.stringify(
      { buckets_file: bucketsFile, min_score: minScore, max_buckets: maxBuckets, papers: classified.length, buckets: groups },
      null,
      1,
    ),
  );

  const anchor = (name: string) => name.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
  const multi = maxBuckets > 1;
  const md = [
    `# Papers by problem (${stem})`,
    '',
    `${classified.length} papers scoring ${minScore} or more, sorted into the buckets of \`${bucketsFile}\`` +
      (multi ? `, up to ${maxBuckets} per paper. A paper is listed under each of its buckets; "Main" counts the papers for which it is the main one.` : '.'),
    '',
    ...(multi
      ? ['| Bucket | Main | Total |', '|---|---|---|', ...groups.map((g) => `| [${cell(g.name)}](#${anchor(g.name)}) | ${g.main} | ${g.papers.length} |`)]
      : ['| Bucket | Papers |', '|---|---|', ...groups.map((g) => `| [${cell(g.name)}](#${anchor(g.name)}) | ${g.papers.length} |`)]),
  ];
  for (const g of groups) {
    md.push('', `## ${g.name}`, '');
    if (g.description) md.push(g.description, '');
    if (!g.papers.length) {
      md.push('_No papers._');
      continue;
    }
    if (multi) {
      // "Also in" names the paper's other buckets, the main one in bold.
      const others = (bs: string[]) =>
        bs.map((b, i) => (b === g.name ? null : i === 0 ? `**${cell(b)}**` : cell(b))).filter(Boolean).join(', ');
      md.push('| Score | Paper | Problem | Also in |', '|---|---|---|---|');
      for (const p of g.papers) md.push(`| ${p.score} | [${cell(p.title)}](${absUrl(p.id)}) | ${cell(p.problem)} | ${others(p.buckets)} |`);
    } else {
      md.push('| Score | Paper | Problem |', '|---|---|---|');
      for (const p of g.papers) md.push(`| ${p.score} | [${cell(p.title)}](${absUrl(p.id)}) | ${cell(p.problem)} |`);
    }
  }
  fs.writeFileSync(path.join(outDir, `${stem}.md`), md.join('\n') + '\n');

  console.log('');
  const width = Math.max(...groups.map((g) => g.name.length));
  if (multi) console.log(`  ${''.padEnd(width)}  ${'main'.padStart(5)}  ${'total'.padStart(5)}`);
  for (const g of groups) {
    console.log(`  ${g.name.padEnd(width)}  ${multi ? `${String(g.main).padStart(5)}  ${String(g.papers.length).padStart(5)}` : String(g.papers.length).padStart(4)}`);
  }
  console.log(`\n📝 Report saved to: ${path.join(outDir, `${stem}.md`)} (and .json)`);
}

run()
  .then(() => console.log(`💰 Claude cost this run: $${getTotalCostUsd().toFixed(2)}\n`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
