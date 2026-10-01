# Storage Weekly Digest

Turns a week of [Blocks and Files](https://www.blocksandfiles.com/) storage news into a PowerPoint deck of technical substance, using the Claude Agent SDK to strip the marketing language.

## What you get

- **Most important insights of the week**: patterns across articles, linked to their sources
- **Most important releases of the week**: ranked by technical significance
- **One slide per technical article**, with:
  - a 1–2 sentence summary of what the article is about
  - the technical essence in standard engineering terms
  - key figures, and whether they come with enough context to mean anything
  - key insights in plain English, for quick reading
  - *What's actually new*: what is genuinely novel, or which existing technique is being repackaged
  - *Marketing → reality*: product names mapped to the technique behind them
  - *Open-source path*: how you could build it from open-source parts (Ceph, DAOS, Lustre, SPDK, kernel features, …) and what the hard part is
  - a small hyperlink to the source article
- **Low-substance articles** (funding, earnings, hires, analyst reports, …) as short summaries in their own section

## Usage

```bash
npm install
npm start                         # last 7 days
npm start -- --until 2026-09-28   # the 7 days before 28 Sep 2026
npm start -- --days 14 --model sonnet --concurrency 6
```

Output is written to `out/`:

- `storage-digest-<from>_<to>.pptx`: the deck
- `synthesis-<from>_<to>.json`: the week's insights and releases
- `cache/<article-id>.json`: one analysis per article. Re-runs reuse these, so changing the deck layout doesn't cost another analysis pass. Delete a file to re-analyse that article. Entries that no longer match the schema (after you change it) are re-analysed automatically.

Authentication works the same way as for Claude Code (`ANTHROPIC_API_KEY` or an existing `claude` login).

## How it works

1. `blocksandfiles.ts` reads the site's RSS feed, keeps the items in the date window, and pulls the plain text out of each article's `bodytext` container.
2. `analysis.ts` runs one `query()` per article (several at once) with `outputFormat: { type: 'json_schema' }`, so each result is validated JSON (zod schema `ArticleAnalysis`). Built-in tools are turned off because the article text goes straight into the prompt. If extraction failed, that article's query gets `WebFetch` and reads the page itself.
3. A second `query()` gets all the analyses and returns the top insights and releases (`WeekSynthesis`).
4. `deck.ts` builds the slides from those structured results with [pptxgenjs](https://gitbrent.github.io/PptxGenJS/). Claude never writes the layout code, so the deck looks the same every week. Font sizes are chosen per text box from a length estimate so that long analyses shrink instead of overflowing.

To change how skeptical or detailed the analysis is, edit `ANALYST_PROMPT` and the field descriptions in `analysis.ts`.

## Cost

With the default `opus` model, a full run for a typical week (~16 articles) has cost between $1 and $3. `--model sonnet` is cheaper. The run prints its total cost when it finishes.
