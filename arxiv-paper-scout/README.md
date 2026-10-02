# arXiv Paper Scout

Goes through an arXiv listing (for example the ~2500 entries of [cs.AI/recent](https://arxiv.org/list/cs.AI/recent)), uses the Claude Agent SDK to score every abstract against a research objective written in [`objective.md`](./objective.md), and turns the best matches into a PowerPoint deck.

The included objective is aimed at storage research in general: devices and interfaces (FTL, NVMe, ZNS, FDP, JBOF/EBOF, tape), storage servers, file systems, in-/near-storage computing and DPUs. It also covers the places where storage matters to other fields, such as KV cache management for LLM inference and memory and file systems for AI agents.

## What you get

- **One slide per selected paper**, with:
  - title, authors, listing date, arXiv id and primary subject
  - the full abstract
  - a score badge: 0-10 plus a qualitative label (*Excellent / Strong / Moderate / Weak fit*)
  - *Why it fits*: the reason for the score
  - *Storage angle*: the advance, insight or opportunity the paper means for storage research
  - topic tags, and links to the arXiv page and the PDF
- **An overview table** of the selected papers. Each title links to its slide, and each slide links back to the table.
- **Also relevant**: papers that passed screening but didn't make the selection, with links.
- A Markdown summary and a JSON file with the same results.

## Usage

```bash
npm install
npm start                                           # cs.AI, recent (last 5 announcement days)
npm start -- --cat cs.OS,cs.DC,cs.AR,cs.DB          # several categories, one deck
npm start -- --cat cs.AI --period new               # only today's announcement
npm start -- --cat cs.AI --period 2026-09           # a whole month (older papers)
npm start -- --cat cs.OS,cs.DC --period 2026-07..2026-09   # a range of months
npm start -- --cat cs.AI --period 2026-09 --offset 2000 --limit 2000   # entries 2001-4000 of that month
npm start -- https://arxiv.org/list/cs.AI/recent    # listing URLs also work, alone or with --cat
npm start -- --limit 100 --max-papers 5             # quick, cheap trial run
npm start -- --new-only                             # leave out papers already selected in an earlier deck
npm start -- --objective my-objective.md --min-score 6 --max-papers 30
```

| Option | Default | Meaning |
|---|---|---|
| `--cat` | `cs.AI` | Comma-separated arXiv categories. Defaults to cs.AI only when no listing URL is given |
| `--period` | `recent` | Comma-separated: `recent` (last 5 announcement days), `new` (latest announcement), `YYYY-MM`, or a range `YYYY-MM..YYYY-MM`. Every category is read for every period |
| `--objective` | `objective.md` | The research objective and scoring guide |
| `--max-papers` | `50` | Number of paper slides. If more papers pass screening, a ranking pass keeps the best ones |
| `--min-score` | `5` | Papers that score lower are dropped |
| `--screen-model` | `sonnet` | Model that screens the abstracts in batches |
| `--rank-model` | `opus` | Model that compares the matches when there are more than `--max-papers` |
| `--batch-size` | `25` | Abstracts per screening query |
| `--concurrency` | `8` | Screening queries (separate agents) running at the same time. Raise it to go faster, up to your API rate limit |
| `--delay` | `15` | Seconds between arxiv.org page requests (the robots.txt `Crawl-delay`) |
| `--offset` | `0` | Skip the first N listing entries |
| `--limit` | none | Only take N listing entries (after `--offset`) |
| `--new-only` | off | Leave out papers listed in `out/seen.json` (papers selected in earlier runs) |
| `--rescreen` | off | Re-score papers whose cached score was made with an earlier version of `objective.md` |

Output goes to one folder per set of categories, with one deck (plus `.md` and `.json`) per period:

```
out/cs.AI/2026-09-28..2026-10-02.pptx      # --period recent: the dates it covered
out/cs.AI/2026-09.pptx                     # --period 2026-09
out/cs.AI/2026-09_2001-4000.pptx           # --offset 2000 --limit 2000
out/cs.AR+cs.DB+cs.DC+cs.OS/2026-07..2026-09.pptx
```

Categories are sorted, so `--cat cs.OS,cs.DC` and `--cat cs.DC,cs.OS` write to the same folder. Running the same categories and period again replaces that deck.

### Older papers

`/recent` only covers the last five announcement days. For older papers, use the monthly listings: `--period YYYY-MM`, or `--period YYYY-MM..YYYY-MM` for several months. cs.AI had 6116 entries in September 2026. You can screen a whole month in one run, or in slices with `--offset` and `--limit`. Each slice gets its own files, e.g. `out/cs.AI/2026-09_2001-4000.pptx`, and its range is shown on the title slide.

Papers already processed for another listing (for example the end of the month, which overlaps `/recent`) are not downloaded or screened again. A month-long bulk download takes a few minutes.

Slices are best for spreading the cost over several runs. The deck of a slice only ranks the papers in that slice. To get one deck of the best papers of the month, run the whole month afterwards: everything is cached by then, so only the final ranking runs.

### Cache and resuming

Everything expensive is saved as soon as it exists, and the app never deletes its cache. You can interrupt a run (Ctrl-C) at any point and start it again: it continues where it stopped.

- `out/cache/papers/<id>.json`: abstracts, saved as each OAI page or `/abs` page arrives. An abstract is downloaded once, ever.
- `out/cache/screening/<id>.json`: scores, saved as each batch finishes. A paper is screened once, ever. An interrupt loses at most the batches that were in flight.
- `out/cache/ranking/<hash>.json`: the result of a ranking pass, reused when the same candidates, objective and model come up again.

Only the listing pages themselves (2 requests for cs.AI/recent) are fetched on every run, because they change every day. Files are written to a temporary name and then renamed, so an interrupt can't leave a corrupt file behind.

Scores are **not** redone when you edit `objective.md`. Each cache entry records which version of the objective it was scored with, and the run tells you how many entries are from an older version. Pass `--rescreen` to re-score those papers (each one only once) against the new objective.

Authentication works the same way as for Claude Code (`ANTHROPIC_API_KEY` or an existing `claude` login).

## How it works

1. **Listings** (`arxiv.ts`): the listing is read 2000 entries per request (the largest page size arXiv allows) for ids, titles, authors and subjects. `/new` listings already include the abstracts.
2. **Abstracts** (`arxiv.ts`): arXiv's robots.txt asks for 15 seconds between requests, so fetching 2500 `/abs` pages one by one would take about 10 hours. Instead, abstracts come from arXiv's [OAI-PMH](https://info.arxiv.org/help/oa/index.html) bulk metadata endpoint, which returns about 1300 records per request (for cs.AI/recent, all 2454 abstracts in about 45 s). The harvest starts a few days before the oldest listing date and stops as soon as every paper is found. Papers OAI doesn't have yet are fetched from their `/abs` page, one every `--delay` seconds. (The export API at `export.arxiv.org/api` is not used because it is heavily rate-limited.)
3. **Screening** (`evaluate.ts`): abstracts are sent in batches of 25 to a tool-less `query()` with `outputFormat: { type: 'json_schema' }`, together with the objective. Each paper gets a score, topic tags, a rationale and a storage angle (zod schema `Assessment`). Papers the model skips are retried in batches of 5.
4. **Ranking** (`evaluate.ts`): if more than `--max-papers` papers score at least `--min-score`, one more query compares the best `4 × max-papers` of them side by side, re-scores them and returns the selection in order. Screening scores come from separate batches, so this pass is what makes the final order consistent.
5. **Deck** (`deck.ts`): built with [pptxgenjs](https://gitbrent.github.io/PptxGenJS/) from the structured results. Font sizes are estimated per text box, so long abstracts shrink instead of overflowing.

## Tuning the objective

`objective.md` is passed to the model word for word, so edit it like a brief for a colleague:

- **Core topics** and **Opportunity topics** say what to look for. The second list is where cross-field papers come from (e.g. LLM inference papers bound by KV cache size).
- **Out of scope** is the most effective place to cut noise. cs.AI has many agent "memory" papers that have nothing to do with storage, for example.
- **Scoring guide** defines the 0-10 scale. The labels on the slides (`fitLabel` in `deck.ts`) assume the same bands.

After editing it, run with `--rescreen` so that papers already scored are re-scored against the new version. After a run, read the *Also relevant* section and the low scores in the JSON. Papers there that you wanted, or selected papers you didn't, show what to change in the objective.

## Time and cost

A run ends with a summary of how long each step took, the cost, and, when you're logged in with a claude.ai subscription instead of an API key, how much of your plan's usage limits the run used:

```
============================================================
⏱  Reading arXiv listings       45.1s
   Collecting abstracts          0.0s
   Screening                     6.2s
   Ranking                       6.3s
   Writing deck and summary      0.1s
   Total                        59.2s
💰 API-equivalent cost: $0.09 (covered by your team plan, not billed per token)
📊 Plan usage: weekly 41% → 41% (+0), resets Sat, 3 Oct, 15:00 · 5-hour 57% → 57% (+0), resets Fri, 2 Oct, 17:00
============================================================
```

The plan usage comes from the same data as Claude Code's `/usage` and is read before and after the run (`getPlanUsage` in `evaluate.ts`). Keep in mind:

- The percentages are whole numbers for your whole account, so small runs show +0. Anything else using the account at the same time (Claude Code, claude.ai) is included in the difference.
- The usage data comes from an experimental SDK call (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`). If a later SDK version changes or removes it, the plan usage line is left out and the rest of the summary still prints.
- With an API key, the line shows the actual per-token cost instead.


A 100-paper trial run (`--limit 100 --max-papers 3`), including one ranking query with `opus`, cost $0.43. The run prints its total cost when it finishes.
