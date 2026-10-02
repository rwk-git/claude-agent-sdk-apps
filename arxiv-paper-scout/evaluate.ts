/**
 * Claude Agent SDK calls: batched screening of every abstract against the
 * objective, then (when too many papers pass) one ranking pass that keeps
 * the most relevant ones.
 */

import * as path from 'path';
import { createHash } from 'crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Paper } from './arxiv';
import { cacheFile, readJson, writeJson } from './cache';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const Assessment = z.object({
  id: z.string().describe('arXiv id, exactly as given.'),
  score: z.number().int().min(0).max(10).describe("Fit with the objective, following the objective's scoring guide."),
  topics: z
    .array(z.string())
    .describe('0-3 short topic tags (1-3 words each), e.g. "KV cache offload", "DPU", "compression". Empty when unrelated.'),
  rationale: z
    .string()
    .describe('Why the paper does or does not fit. Max ~220 chars; a few words is enough for scores below 5.'),
  storage_angle: z
    .string()
    .describe(
      'For scores >= 5, max ~240 chars: the advance, insight or opportunity the paper means for storage research, ' +
        'as defined by the objective. Empty for lower scores.',
    ),
});
export type Assessment = z.infer<typeof Assessment>;

const ScreeningBatch = z.object({
  results: z.array(Assessment).describe('Exactly one entry per paper, in the order given.'),
});

const Ranking = z.object({
  selected: z
    .array(Assessment)
    .describe('The selected papers, most relevant first, with scores and texts revised now that you see them side by side.'),
});

export interface Evaluated {
  paper: Paper;
  assessment: Assessment;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SCREENING_PROMPT = `You are screening new arXiv papers for the researchers described in the objective.

You get the research objective, then a batch of papers (title, subjects, abstract). Score each paper from 0 to 10 using the objective's scoring guide.

Rules:
- Judge from the title and abstract only. Do not assume content the abstract does not support.
- Be strict about vocabulary: a passing mention of "memory", "efficiency" or "scalability" is not a storage angle on its own. Follow the objective on which topics count and how much.
- Do look for the non-obvious: papers whose bottleneck is memory capacity, memory/I-O bandwidth or data movement even when they never use storage terms. Those are exactly the opportunities the researcher wants to find.
- For relevant papers, the storage angle must be specific (which data, which tier, what could move closer to the data), not generic.
- Return exactly one result per paper, using the ids you are given.`;

const RANKING_PROMPT = `You are selecting the papers the researchers described in the objective should read from this week's arXiv listings.

You get the research objective and the candidates that passed a first screening, each with its screening score and rationale. Those scores were given one batch at a time; now compare the candidates side by side.

Rules:
- Select the requested number of papers, most relevant first. Relevance to the objective comes first; among papers of similar relevance, prefer ones that cover different topics of the objective, and concrete systems contributions over position papers.
- Re-score each selected paper on the same 0-10 scale, and rewrite its rationale and storage angle if the comparison changes your view.
- Use only the ids you are given.`;

const objectiveBlock = (objective: string) => `<objective>\n${objective.trim()}\n</objective>`;

function paperBlock(p: Paper, extra = ''): string {
  return [
    `<paper id="${p.id}">`,
    `Title: ${p.title}`,
    `Subjects: ${p.subjects}`,
    `Abstract: ${p.abstract || '(not available, judge from the title)'}`,
    extra,
    '</paper>',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// SDK helpers
// ---------------------------------------------------------------------------

let totalCostUsd = 0;
export const getTotalCostUsd = () => totalCostUsd;

/** Runs one tool-less query() and returns its structured output, validated with `schema`. */
async function runStructured<T>(schema: z.ZodType<T>, systemPrompt: string, prompt: string, model: string): Promise<T> {
  // The CLI's schema validator does not know zod's default draft-2020-12 `$schema` tag.
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema);
  const q = query({
    prompt,
    options: {
      model,
      systemPrompt,
      tools: [], // everything the model needs is in the prompt
      outputFormat: { type: 'json_schema', schema: jsonSchema },
      maxTurns: 10,
      settingSources: [], // ignore local CLAUDE.md / settings so results are reproducible
      persistSession: false,
    },
  });

  for await (const msg of q) {
    if (msg.type !== 'result') continue;
    totalCostUsd += msg.total_cost_usd ?? 0;
    if (msg.subtype !== 'success') throw new Error(`query failed: ${msg.subtype}`);
    return schema.parse(msg.structured_output);
  }
  throw new Error('query ended without a result');
}

/** Runs `fn` over `items` with at most `limit` calls in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const chunk = <T>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

export interface ScreeningOptions {
  model: string;
  batchSize: number;
  concurrency: number;
  /** Only used to highlight matches in the log. */
  minScore: number;
  /** Re-screen papers whose cached score was made with a different objective.md. */
  rescreen: boolean;
}

/** Identifies the objective (and prompt) a cached score was made with. */
const objectiveHash = (objective: string) =>
  createHash('sha256').update(SCREENING_PROMPT).update(objective).digest('hex').slice(0, 16);

interface CacheEntry {
  objective_hash: string;
  model: string;
  assessment: Assessment;
}

export async function screenPapers(
  papers: Paper[],
  objective: string,
  cacheDir: string,
  opts: ScreeningOptions,
): Promise<Evaluated[]> {
  const hash = objectiveHash(objective);
  const assessments = new Map<string, Assessment>();

  // Every score is cached as soon as its batch finishes, so a paper is never
  // screened twice: not after an interrupted run, and by default not after
  // objective.md changes either (unless --rescreen).
  let stale = 0;
  for (const p of papers) {
    const entry = readJson<CacheEntry>(cacheFile(cacheDir, p.id));
    const parsed = Assessment.safeParse(entry?.assessment);
    if (!parsed.success) continue;
    if (entry!.objective_hash !== hash) {
      stale++;
      if (opts.rescreen) continue;
    }
    assessments.set(p.id, parsed.data);
  }
  if (assessments.size) console.log(`  💾 ${assessments.size} papers already screened, reusing their scores`);
  if (stale) {
    console.log(
      opts.rescreen
        ? `  🔄 Re-screening ${stale} papers scored with an earlier objective.md`
        : `  ℹ️  ${stale} of them were scored with an earlier objective.md (pass --rescreen to re-score them)`,
    );
  }

  const screenBatch = async (batch: Paper[], label: string) => {
    const prompt = `${objectiveBlock(objective)}\n\n${batch.map((p) => paperBlock(p)).join('\n\n')}`;
    try {
      const { results } = await runStructured(ScreeningBatch, SCREENING_PROMPT, prompt, opts.model);
      const ids = new Set(batch.map((p) => p.id));
      let matches = 0;
      for (const a of results) {
        if (!ids.has(a.id)) continue; // ignore ids the model made up
        assessments.set(a.id, a);
        writeJson(cacheFile(cacheDir, a.id), { objective_hash: hash, model: opts.model, assessment: a } satisfies CacheEntry);
        if (a.score >= opts.minScore) {
          matches++;
          console.log(`    ⭐ ${a.score}/10 ${batch.find((p) => p.id === a.id)!.title}`);
        }
      }
      console.log(`  ✓ ${label}: ${matches} of ${batch.length} match`);
    } catch (err) {
      console.warn(`  ❌ ${label}: ${(err as Error).message}`);
    }
  };

  const remaining = papers.length - assessments.size;
  if (remaining) console.log(`  ${remaining} papers to screen in batches of ${opts.batchSize}, ${opts.concurrency} at a time`);

  // Second round in small batches for anything the first round dropped or failed on.
  for (const [round, size] of [[1, opts.batchSize], [2, 5]] as const) {
    const todo = papers.filter((p) => !assessments.has(p.id));
    if (!todo.length) break;
    if (round === 2) console.log(`\n  Retrying ${todo.length} papers that were not scored`);
    const batches = chunk(todo, size);
    await mapLimit(batches, opts.concurrency, (b, i) => screenBatch(b, `batch ${i + 1}/${batches.length}`));
  }

  const unscored = papers.filter((p) => !assessments.has(p.id));
  if (unscored.length) console.warn(`  ⚠️  ${unscored.length} papers could not be screened: ${unscored.map((p) => p.id).join(', ')}`);

  return papers.filter((p) => assessments.has(p.id)).map((paper) => ({ paper, assessment: assessments.get(paper.id)! }));
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Picks the `count` most relevant of `candidates` (sorted by screening score,
 * best first) in one comparative pass. Only the best `4 * count` candidates
 * are sent, to keep the prompt a manageable size. The result is cached in
 * `cacheDir` for this exact pool, objective and model.
 */
export async function rankPapers(
  candidates: Evaluated[],
  objective: string,
  count: number,
  model: string,
  cacheDir: string,
): Promise<Evaluated[]> {
  const pool = candidates.slice(0, 4 * count);
  const byId = new Map(pool.map((e) => [e.paper.id, e]));
  const key = createHash('sha256')
    .update(JSON.stringify([RANKING_PROMPT, objective, model, count, pool.map((e) => e.paper.id)]))
    .digest('hex')
    .slice(0, 16);
  const file = path.join(cacheDir, `${key}.json`);
  const prompt =
    `${objectiveBlock(objective)}\n\nSelect the ${count} most relevant of these ${pool.length} candidates.\n\n` +
    pool
      .map(({ paper, assessment: a }) =>
        paperBlock(paper, `Screening: ${a.score}/10. ${a.rationale}${a.storage_angle ? ` Storage angle: ${a.storage_angle}` : ''}`),
      )
      .join('\n\n');

  let selected = Ranking.safeParse(readJson(file)).data?.selected;
  if (selected) {
    console.log('  💾 Same candidates as an earlier run, reusing its ranking');
  } else {
    selected = (await runStructured(Ranking, RANKING_PROMPT, prompt, model)).selected;
    writeJson(file, { selected });
  }

  const result: Evaluated[] = [];
  for (const a of selected) {
    const e = byId.get(a.id);
    if (!e || result.some((r) => r.paper.id === a.id)) continue;
    result.push({ paper: e.paper, assessment: a });
  }
  // If the model returned fewer papers than asked, top up in screening order.
  for (const e of pool) {
    if (result.length >= count) break;
    if (!result.some((r) => r.paper.id === e.paper.id)) result.push(e);
  }
  return result.slice(0, count);
}

// ---------------------------------------------------------------------------
// Plan usage
// ---------------------------------------------------------------------------

export interface UsageWindow {
  /** Percentage of the window used, 0-100. */
  utilization: number;
  resetsAt: Date | null;
}

export interface PlanUsage {
  /** e.g. "pro", "max", "team" */
  subscription: string;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
}

/**
 * Current claude.ai plan utilization (what /usage shows), or null when the
 * run is billed per token (API key, Bedrock, Vertex) or the lookup fails.
 * Uses a session that never sends a message, so it costs nothing.
 * Relies on an experimental SDK call that may change in later SDK versions.
 */
export async function getPlanUsage(): Promise<PlanUsage | null> {
  let release!: () => void;
  const idle = new Promise<void>((resolve) => (release = resolve));
  async function* noMessages() {
    await idle;
  }
  const q = query({ prompt: noMessages(), options: { tools: [], settingSources: [], persistSession: false } });
  try {
    const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    if (!u.rate_limits_available || !u.rate_limits) return null;
    const window = (w?: { utilization: number | null; resets_at: string | null } | null): UsageWindow | null =>
      w && w.utilization !== null ? { utilization: w.utilization, resetsAt: w.resets_at ? new Date(w.resets_at) : null } : null;
    return {
      subscription: u.subscription_type ?? 'subscription',
      fiveHour: window(u.rate_limits.five_hour),
      sevenDay: window(u.rate_limits.seven_day),
    };
  } catch {
    return null;
  } finally {
    release();
    q.close();
  }
}
