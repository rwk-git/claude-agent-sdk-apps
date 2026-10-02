/**
 * Claude Agent SDK calls: one structured analysis per article, then one
 * synthesis pass over the whole week.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Article } from './sources';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const ArticleAnalysis = z.object({
  substance: z
    .enum(['technical', 'low'])
    .describe(
      '"technical" if the article contains at least one real technical mechanism, architecture detail, ' +
        'hardware capability or meaningful performance/capacity/cost figure. "low" for funding, earnings, ' +
        'hires, partnerships, customer wins, awards, market-share reports, vague AI positioning, etc.',
    ),
  slide_title: z
    .string()
    .describe('Neutral, de-marketed title naming the vendor and the actual technical thing. Max ~70 chars.'),
  vendor: z.string().describe('Main company the article is about.'),
  summary: z
    .string()
    .describe(
      '1-2 plain-language sentences (max ~250 chars) giving the reader context: who announced what, and what it is for. ' +
        'No marketing words.',
    ),
  technical_essence: z
    .array(z.string())
    .describe(
      '3-5 bullets (each max ~180 chars) describing the underlying mechanisms in standard engineering terms. ' +
        'Empty for "low" articles.',
    ),
  marketing_decoder: z
    .array(z.object({ marketing_term: z.string(), what_it_is: z.string() }))
    .describe('Up to 3 vendor/marketing names mapped to the well-known technique behind them (what_it_is max ~90 chars).'),
  whats_new: z
    .string()
    .describe(
      'Max ~300 chars. What is genuinely novel or valuable vs. prior art, or an honest statement that it is ' +
        'a repackaging of an existing technique (name it and roughly how old it is).',
    ),
  open_source_path: z
    .array(z.string())
    .describe(
      '1-3 bullets (each max ~160 chars): how one could build the same thing from open-source building blocks ' +
        '(name projects / kernel features) and what the hard part would be. Empty for "low" articles.',
    ),
  key_figures: z
    .array(z.string())
    .describe('Up to 3 concrete numbers from the article with what they measure (e.g. "1.2 TB/s read, 32-node cluster").'),
  key_insights: z
    .array(z.string())
    .describe(
      '2-3 takeaways (each max ~140 chars) in plain English that a reader can absorb in seconds: why this matters ' +
        'or what it tells us about where storage is heading. Technical terms are fine, jargon chains are not. ' +
        'Empty for "low" articles.',
    ),
  release: z
    .object({
      product: z.string(),
      what_it_is: z.string().describe('Technical description, max ~120 chars.'),
      availability: z.string().describe('Max ~40 chars: GA / preview / date as stated in the article, or "not stated".'),
    })
    .nullable()
    .describe('Set when the article announces a product, product version or feature release; null otherwise.'),
});
export type ArticleAnalysis = z.infer<typeof ArticleAnalysis>;

export const WeekSynthesis = z.object({
  top_insights: z
    .array(
      z.object({
        headline: z.string().describe('Max ~90 chars.'),
        detail: z.string().describe('Max ~220 chars: the technical insight and why it matters to a storage researcher.'),
        article_ids: z.array(z.string()).describe('ids of the supporting articles.'),
      }),
    )
    .describe('The 4-6 most important technical insights or trends of the week, most important first.'),
  top_releases: z
    .array(
      z.object({
        vendor: z.string(),
        product: z.string(),
        why_it_matters: z.string().describe('Max ~140 chars, technical.'),
        article_id: z.string(),
      }),
    )
    .describe('The up to 8 most important product releases of the week, most important first.'),
});
export type WeekSynthesis = z.infer<typeof WeekSynthesis>;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const analystPrompt = (siteName: string) => `You are a senior storage-systems engineer briefing a storage researcher on the week's trade press (${siteName}).

The articles are written largely in vendor marketing language: long-established ideas are presented as breakthroughs under product names. Your job is to recover the technical essence.

Rules:
- Describe mechanisms in standard engineering terms (e.g. erasure coding, log-structured writes, metadata sharding, NVMe-oF over RDMA, GPUDirect Storage, KV-cache offload to flash, ZNS/FDP, CXL memory pooling, client-side caching, policy-based tiering, content-addressed dedup).
- Be skeptical. If something is a repackaging of an old technique, say so plainly and name the technique. Only call something novel when it plausibly is (a new hardware capability, a new combination that changes trade-offs, numbers that move the state of the art).
- Do not invent details. When the article gives no mechanism, you may state the most likely implementation but mark it as "likely".
- Keep concrete figures and say what they measure; flag figures that lack context (no workload, no cluster size).
- The open-source path must be concrete: name projects (Ceph, DAOS, Lustre, BeeGFS, OpenZFS, SPDK, Linux kernel features, Apache Iceberg, etc.) and the missing piece.
- For hands-on reviews and benchmarks, focus on the test setup, the measured results and what they reveal about the design.
- Write the summary and key insights for a reader skimming the slide: short sentences, plain English.
- Respect the length hints in the schema: the output goes on a single slide.`;

const SYNTHESIS_PROMPT = `You are a senior storage-systems engineer writing the closing slides of a weekly technical digest for a storage researcher.

You get the per-article analyses of the week as JSON. Identify:
1. The most important technical insights or trends: cross-article patterns count more than single announcements; ignore marketing momentum without technical content.
2. The most important product releases, ranked by technical significance (not by vendor size).

Reference articles only by the ids you are given.`;

// ---------------------------------------------------------------------------
// SDK helper
// ---------------------------------------------------------------------------

export interface RunOptions {
  model: string;
  /** Display name of the news site, used in the prompts. */
  siteName: string;
}

let totalCostUsd = 0;
export const getTotalCostUsd = () => totalCostUsd;

/** Runs one query() and returns its structured output, validated with `schema`. */
async function runStructured<T>(
  schema: z.ZodType<T>,
  systemPrompt: string,
  prompt: string,
  opts: RunOptions & { tools?: string[] },
): Promise<T> {
  const tools = opts.tools ?? [];
  // The CLI's schema validator does not know zod's default draft-2020-12 `$schema` tag.
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema);
  const q = query({
    prompt,
    options: {
      model: opts.model,
      systemPrompt,
      tools,
      allowedTools: tools,
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const MIN_EXTRACTED_CHARS = 400;

export async function analyzeArticle(article: Article, opts: RunOptions): Promise<ArticleAnalysis> {
  const header = `Title: ${article.title}\nURL: ${article.url}\nSection: ${article.section}\nPublished: ${article.published.toISOString()}`;

  // If our HTML extraction failed, let the agent read the page itself.
  if (article.text.length < MIN_EXTRACTED_CHARS) {
    return runStructured(
      ArticleAnalysis,
      analystPrompt(opts.siteName),
      `${header}\n\nUse WebFetch to read the full article at the URL above, then analyse it.`,
      { ...opts, tools: ['WebFetch'] },
    );
  }
  return runStructured(ArticleAnalysis, analystPrompt(opts.siteName), `${header}\n\n<article>\n${article.text}\n</article>`, opts);
}

export async function synthesizeWeek(
  items: { article: Article; analysis: ArticleAnalysis }[],
  opts: RunOptions,
): Promise<WeekSynthesis> {
  const payload = items.map(({ article, analysis }) => ({ id: article.id, title: article.title, ...analysis }));
  return runStructured(WeekSynthesis, SYNTHESIS_PROMPT, JSON.stringify(payload, null, 1), opts);
}
