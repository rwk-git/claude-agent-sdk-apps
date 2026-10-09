/**
 * Claude Agent SDK calls for the bucket reports: extracting the problem each
 * paper addresses, sorting papers into a fixed list of buckets, and proposing
 * a list of buckets by clustering the problems.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { z } from 'zod';
import type { Paper } from './arxiv';
import { cacheFile, readJson, writeJson } from './cache';
import { chunk, mapLimit, runStructured } from './evaluate';

export interface Bucket {
  name: string;
  /** Optional: what belongs in the bucket. */
  description: string;
}

export const OTHER = 'Other';

export interface BatchOptions {
  model: string;
  batchSize: number;
  concurrency: number;
}

const hash = (...parts: string[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\0');
  return h.digest('hex').slice(0, 16);
};

const paperBlock = (p: Paper, body: string) => `<paper id="${p.id}">\nTitle: ${p.title}\n${body}\n</paper>`;

/**
 * Runs `work` over the papers that have no cached result yet, in batches,
 * with one retry round in small batches for papers the model skipped.
 * Returns the results that exist afterwards, cached or new.
 */
async function batched<R>(
  papers: Paper[],
  opts: BatchOptions,
  cached: (p: Paper) => R | undefined,
  work: (batch: Paper[]) => Promise<Map<string, R>>,
  save: (id: string, r: R) => void,
): Promise<Map<string, R>> {
  const results = new Map<string, R>();
  for (const p of papers) {
    const r = cached(p);
    if (r !== undefined) results.set(p.id, r);
  }
  if (results.size) console.log(`  💾 ${results.size} already done, reusing them`);

  for (const [round, size] of [[1, opts.batchSize], [2, 5]] as const) {
    const todo = papers.filter((p) => !results.has(p.id));
    if (!todo.length) break;
    console.log(round === 1 ? `  ${todo.length} papers in batches of ${size}, ${opts.concurrency} at a time` : `\n  Retrying ${todo.length} papers`);
    const batches = chunk(todo, size);
    await mapLimit(batches, opts.concurrency, async (batch, i) => {
      const label = `batch ${i + 1}/${batches.length}`;
      try {
        const ids = new Set(batch.map((p) => p.id));
        let n = 0;
        for (const [id, r] of await work(batch)) {
          if (!ids.has(id)) continue; // ignore ids the model made up
          results.set(id, r);
          save(id, r);
          n++;
        }
        console.log(`  ✓ ${label}: ${n} of ${batch.length}`);
      } catch (err) {
        console.warn(`  ❌ ${label}: ${(err as Error).message}`);
      }
    });
  }

  const missing = papers.filter((p) => !results.has(p.id));
  if (missing.length) console.warn(`  ⚠️  ${missing.length} papers were left out: ${missing.map((p) => p.id).join(', ')}`);
  return results;
}

// ---------------------------------------------------------------------------
// Problem extraction
// ---------------------------------------------------------------------------

const PROBLEM_PROMPT = `You extract the problem each arXiv paper addresses.

You get a batch of papers (title and abstract). For each one, state the problem the paper sets out to solve: the bottleneck, limitation or gap in current systems or methods that motivates the work.

Rules:
- State the problem, not the solution. "KV cache size limits the batch size of long-context LLM serving" rather than "We propose X, which offloads the KV cache".
- Be specific: which workload, which resource (GPU memory, bandwidth, latency, cost, ...) and why it falls short.
- One or two sentences, max ~250 characters.
- Judge from the title and abstract only.
- Return exactly one result per paper, using the ids you are given.`;

const Problems = z.object({
  results: z
    .array(
      z.object({
        id: z.string().describe('arXiv id, exactly as given.'),
        problem: z.string().describe('The problem the paper addresses, not its solution. Max ~250 chars.'),
      }),
    )
    .describe('Exactly one entry per paper, in the order given.'),
});

interface ProblemEntry {
  prompt_hash: string;
  model: string;
  problem: string;
}

/** The problem each paper addresses, by arXiv id. Cached per paper in `cacheDir`. */
export async function extractProblems(papers: Paper[], cacheDir: string, opts: BatchOptions): Promise<Map<string, string>> {
  const promptHash = hash(PROBLEM_PROMPT);
  return batched(
    papers,
    opts,
    (p) => {
      const e = readJson<ProblemEntry>(cacheFile(cacheDir, p.id));
      return e?.prompt_hash === promptHash && e.problem ? e.problem : undefined;
    },
    async (batch) => {
      const prompt = batch.map((p) => paperBlock(p, `Abstract: ${p.abstract || '(not available, judge from the title)'}`)).join('\n\n');
      const { results } = await runStructured(Problems, PROBLEM_PROMPT, prompt, opts.model);
      return new Map(results.map((r) => [r.id, r.problem]));
    },
    (id, problem) => writeJson(cacheFile(cacheDir, id), { prompt_hash: promptHash, model: opts.model, problem } satisfies ProblemEntry),
  );
}

// ---------------------------------------------------------------------------
// Buckets file
// ---------------------------------------------------------------------------

/**
 * Reads a buckets file: each top-level "- " bullet is a bucket name, and the
 * indented lines right below it (if any) describe it. Everything else
 * (headings, paragraphs) is ignored. An "Other" bucket is added if missing.
 */
export function readBuckets(file: string): Bucket[] {
  const buckets: Bucket[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const item = line.match(/^[-*]\s+(.+)$/);
    if (item) {
      buckets.push({ name: item[1].replace(/\*\*/g, '').trim(), description: '' });
    } else if (/^\s+\S/.test(line) && buckets.length) {
      const last = buckets[buckets.length - 1];
      last.description = `${last.description} ${line.trim()}`.trim();
    }
  }
  if (!buckets.length) throw new Error(`${file} has no buckets (one "- name" line per bucket)`);
  if (!buckets.some((b) => b.name.toLowerCase() === OTHER.toLowerCase())) buckets.push({ name: OTHER, description: '' });
  return buckets;
}

export function writeBuckets(file: string, buckets: Bucket[], intro: string) {
  const lines = ['# Problem buckets', '', intro, ''];
  for (const b of buckets) {
    lines.push(`- ${b.name}`);
    if (b.description) lines.push(`  ${b.description}`);
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

const bucketList = (buckets: Bucket[]) =>
  buckets.map((b) => `- ${b.name}${b.description ? `: ${b.description}` : ''}`).join('\n');

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const classifyPrompt = (maxBuckets: number) => `You sort arXiv papers into buckets by the problem they address.

You get the list of buckets, then a batch of papers, each with its title and the problem it addresses. Put each paper in the bucket that best matches its problem${
  maxBuckets > 1 ? `, and in up to ${maxBuckets - 1} more if its problem clearly spans them` : ''
}.

Rules:
- Go by the problem, not by the technique the paper uses or the field it comes from.
- The first bucket is the main one: the one that names the paper's main bottleneck.${
  maxBuckets > 1
    ? `
- Add another bucket only when that bucket's problem is a substantial part of the paper's problem, not a passing aspect. Most papers belong in one or two buckets; one is a fine answer.`
    : ''
}
- Use "${OTHER}" only when no other bucket fits, and then on its own.
- Give a short reason (max ~150 chars).
- Return exactly one result per paper, using the ids you are given.`;

export interface Classification {
  /** Main bucket first. */
  buckets: string[];
  reason: string;
}

/** The buckets of each paper (at most `maxBuckets`), by arXiv id. Cached per bucket list and paper under `cacheDir`. */
export async function classifyProblems(
  papers: Paper[],
  problems: Map<string, string>,
  buckets: Bucket[],
  maxBuckets: number,
  cacheDir: string,
  opts: BatchOptions,
): Promise<Map<string, Classification>> {
  const names = buckets.map((b) => b.name) as [string, ...string[]];
  const Classified = z.object({
    results: z
      .array(
        z.object({
          id: z.string().describe('arXiv id, exactly as given.'),
          buckets: z
            .array(z.enum(names))
            .min(1)
            .max(maxBuckets)
            .describe(`1-${maxBuckets} bucket names, exactly as listed, main bucket first.`),
          reason: z.string().describe('Why it belongs there. Max ~150 chars.'),
        }),
      )
      .describe('Exactly one entry per paper, in the order given.'),
  });
  // Drops duplicates, and "Other" when a real bucket was given too.
  const clean = (bs: string[]) => {
    const unique = [...new Set(bs)].filter((b) => names.includes(b));
    const real = unique.filter((b) => b !== OTHER);
    return (real.length ? real : unique).slice(0, maxBuckets);
  };
  const instructions = classifyPrompt(maxBuckets);
  // Results for a different bucket list, maximum or prompt go to a different folder.
  const dir = path.join(cacheDir, hash(instructions, bucketList(buckets)));
  const system = `${instructions}\n\n<buckets>\n${bucketList(buckets)}\n</buckets>`;
  return batched(
    papers,
    opts,
    (p) => {
      const c = readJson<Classification>(cacheFile(dir, p.id));
      return c && Array.isArray(c.buckets) && clean(c.buckets).length ? { ...c, buckets: clean(c.buckets) } : undefined;
    },
    async (batch) => {
      const prompt = batch.map((p) => paperBlock(p, `Problem: ${problems.get(p.id)}`)).join('\n\n');
      const { results } = await runStructured(Classified, system, prompt, opts.model);
      return new Map(
        results.filter((r) => clean(r.buckets).length).map((r) => [r.id, { buckets: clean(r.buckets), reason: r.reason }]),
      );
    },
    (id, c) => writeJson(cacheFile(dir, id), c),
  );
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

const CLUSTER_PROMPT = `You group research problems into buckets.

You get the problems addressed by a set of arXiv papers, one per paper. Propose the buckets that best partition them, so that each paper can then be sorted into exactly one bucket by its problem.

Rules:
- Group by the problem (the bottleneck or limitation addressed), not by technique or application field.
- Buckets must not overlap, and together should cover nearly every paper.
- Prefer buckets of comparable size. Split a bucket that would hold more than about a third of the papers; merge ones that would hold only a couple.
- Each bucket gets a short name (2-6 words, like "KV cache and model state memory" or "Scheduling, SLO, goodput") and one sentence saying which problems belong in it, precise enough to decide borderline cases.
- Do not include an "${OTHER}" bucket; it is added for whatever is left.`;

const Clusters = z.object({
  buckets: z
    .array(
      z.object({
        name: z.string().describe('Short bucket name, 2-6 words.'),
        description: z.string().describe('One sentence: which problems belong in this bucket.'),
      }),
    )
    .describe('The buckets, largest first.'),
});

/** Proposes buckets for the papers' problems in one query (plus "Other"). */
export async function clusterProblems(
  papers: Paper[],
  problems: Map<string, string>,
  model: string,
  count?: number,
): Promise<Bucket[]> {
  const size = count ? `Propose exactly ${count} buckets.` : 'Propose between 5 and 10 buckets, whatever fits the problems best.';
  const prompt = `${size}\n\n${papers.map((p) => paperBlock(p, `Problem: ${problems.get(p.id)}`)).join('\n\n')}`;
  const { buckets } = await runStructured(Clusters, CLUSTER_PROMPT, prompt, model);
  return [...buckets.filter((b) => b.name.toLowerCase() !== OTHER.toLowerCase()), { name: OTHER, description: 'Problems that fit none of the buckets above.' }];
}
