/**
 * Fetches arXiv listings and abstracts without hammering arxiv.org.
 *
 * - Listing pages (/list/<category>/<recent|new|YYYY-MM>) are read 2000
 *   entries at a time.
 * - Abstracts come, in order of preference, from the local cache, from the
 *   listing itself (/new pages include them), from the OAI-PMH bulk endpoint
 *   (about 1300 records per request), and finally from individual /abs pages,
 *   which robots.txt limits to one request every 15 seconds.
 */

import * as fs from 'fs';
import { cacheFile, readJson, writeJson } from './cache';

export interface Paper {
  id: string;
  title: string;
  authors: string[];
  /** Subjects line from the listing, e.g. "Artificial Intelligence (cs.AI); Machine Learning (cs.LG)". */
  subjects: string;
  /** Listing section the entry appeared under, e.g. "Fri, 2 Oct 2026" or "New submissions". */
  listedUnder: string;
  /** Category of the listing it came from, e.g. "cs.AI". */
  category: string;
  /** Empty if no source had it. */
  abstract: string;
}

export const absUrl = (id: string) => `https://arxiv.org/abs/${id}`;
export const pdfUrl = (id: string) => `https://arxiv.org/pdf/${id}`;

const USER_AGENT = 'arxiv-paper-scout/1.0 (Claude Agent SDK demo)';
const PAGE_SIZE = 2000; // largest `show` value arxiv.org accepts
const OAI_ENDPOINT = 'https://oaipmh.arxiv.org/oai';
const OAI_GAP_MS = 3000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const lastRequestAt = new Map<string, number>();

/** GET with a minimum gap between requests to the same host, retrying on 429/503 (honouring Retry-After). */
async function politeFetch(url: string, minGapMs: number): Promise<string> {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    const wait = (lastRequestAt.get(host) ?? 0) + minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt.set(host, Date.now());

    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.ok) return res.text();
    if ((res.status === 429 || res.status === 503) && attempt < 4) {
      const retryAfter = Number(res.headers.get('retry-after')) || 30 * 2 ** attempt;
      console.warn(`  ⏳ ${host} answered ${res.status}, retrying in ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      continue;
    }
    throw new Error(`GET ${url} -> HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// HTML/XML helpers
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return String.fromCodePoint(n);
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Plain text of an HTML fragment, on one line. */
const plainText = (html: string) =>
  decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** Inner HTML of the first element whose opening tag matches `openTag` (a regex source), up to `</tag>`. */
function elementContent(html: string, openTag: string, tag: string): string {
  const m = html.match(new RegExp(`${openTag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : '';
}

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

export interface Listing {
  /** e.g. "cs.AI" */
  category: string;
  /** e.g. "recent", "new", "2026-09" */
  kind: string;
  papers: Paper[];
}

/** Parses one listing page. Entries are <dt>/<dd> pairs, grouped under <h3> section headings. */
function parseListingPage(html: string, category: string): Paper[] {
  const papers: Paper[] = [];
  let listedUnder = '';
  for (const m of html.matchAll(/<h3>([\s\S]*?)<\/h3>|<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
    if (m[1] !== undefined) {
      const heading = plainText(m[1]);
      // Monthly listings only have a "Total of N entries" heading, which isn't a section.
      if (!heading.startsWith('Total of')) listedUnder = heading.replace(/\s*\(.*$/, ''); // drop "(showing 50 of 381 entries)"
      continue;
    }
    const [, , dt, dd] = m;
    const id = dt.match(/href\s*=\s*"\/abs\/([^"]+)"/)?.[1];
    if (!id) continue;
    papers.push({
      id,
      title: plainText(elementContent(dd, "<div class='list-title[^']*'", 'div').replace(/<span class='descriptor'>.*?<\/span>/, '')),
      authors: [...elementContent(dd, "<div class='list-authors'", 'div').matchAll(/<a [^>]*>([^<]*)<\/a>/g)].map((a) =>
        plainText(a[1]),
      ),
      subjects: plainText(elementContent(dd, "<div class='list-subjects'", 'div').replace(/<span class='descriptor'>.*?<\/span>/, '')).replace(/\s+;/g, ';'),
      listedUnder,
      category,
      abstract: plainText(elementContent(dd, "<p class='mathjax'", 'p')),
    });
  }
  return papers;
}

/**
 * Reads every entry of a listing such as https://arxiv.org/list/cs.AI/recent,
 * paging through it 2000 entries at a time.
 */
export async function fetchListing(listingUrl: string, delayMs: number): Promise<Listing> {
  const url = new URL(listingUrl);
  const m = url.pathname.match(/^\/list\/([^/]+)\/([^/]+)\/?$/);
  if (!m) throw new Error(`Not an arXiv listing URL (expected https://arxiv.org/list/<category>/<recent|new|YYYY-MM>): ${listingUrl}`);
  const [, category, kind] = m;

  const papers: Paper[] = [];
  for (let skip = 0; ; skip += PAGE_SIZE) {
    url.searchParams.set('skip', String(skip));
    url.searchParams.set('show', String(PAGE_SIZE));
    const html = await politeFetch(url.toString(), delayMs);
    const page = parseListingPage(html, category);
    // Monthly listings (/list/cs.AI/2026-09) have no sections; label entries with the month.
    if (/^\d{4}-\d{2}$/.test(kind)) {
      const month = new Date(`${kind}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
      for (const p of page) p.listedUnder ||= month;
    }
    papers.push(...page);
    const total = Number(html.match(/Total of (\d+) entries/)?.[1] ?? 0);
    console.log(`  ${category}/${kind}: ${papers.length}${total ? ` of ${total}` : ''} entries`);
    if (page.length < PAGE_SIZE || (total && papers.length >= total)) break;
  }
  return { category, kind, papers };
}

// ---------------------------------------------------------------------------
// Abstracts
// ---------------------------------------------------------------------------

const PHYSICS_ARCHIVES = new Set([
  'astro-ph', 'cond-mat', 'gr-qc', 'hep-ex', 'hep-lat', 'hep-ph', 'hep-th',
  'math-ph', 'nlin', 'nucl-ex', 'nucl-th', 'physics', 'quant-ph',
]);

/** OAI-PMH set containing a category, e.g. "cs" for cs.AI, "physics:hep-th" for hep-th. */
function oaiSet(category: string): string {
  const archive = category.split('.')[0];
  return PHYSICS_ARCHIVES.has(archive) ? `physics:${archive}` : archive;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Earliest date from which OAI records for these papers can be expected.
 * OAI datestamps are the date a record last changed, which for a listed
 * paper is no earlier than a few days before its listing date.
 */
function oaiFromDate(papers: Paper[]): string {
  const listed = papers.map((p) => Date.parse(p.listedUnder.replace(/^\w+,\s*/, ''))).filter((t) => !isNaN(t));
  if (listed.length === papers.length) return isoDay(new Date(Math.min(...listed) - 4 * 24 * 3600 * 1000));
  // No usable listing dates (e.g. a monthly listing): new-style ids start with the submission's YYMM.
  const months = papers.map((p) => p.id.match(/^(\d{2})(\d{2})\./)).filter((x): x is RegExpMatchArray => !!x);
  if (months.length === papers.length) {
    const earliest = months.map(([, yy, mm]) => `20${yy}-${mm}-01`).sort()[0];
    return earliest;
  }
  return isoDay(new Date(Date.now() - 60 * 24 * 3600 * 1000));
}

/**
 * Harvests OAI-PMH records of `set` changed since `from`, calling `onFound`
 * for each wanted id as soon as its page arrives, until all are found.
 */
async function harvestOai(set: string, from: string, wanted: Set<string>, onFound: (id: string, abstract: string) => void) {
  let found = 0;
  let query = `verb=ListRecords&metadataPrefix=arXiv&set=${encodeURIComponent(set)}&from=${from}`;
  for (let page = 1; ; page++) {
    const xml = await politeFetch(`${OAI_ENDPOINT}?${query}`, OAI_GAP_MS);
    if (xml.includes('code="noRecordsMatch"')) break;
    for (const [, record] of xml.matchAll(/<record>([\s\S]*?)<\/record>/g)) {
      const id = elementContent(record, '<id\\b', 'id').trim();
      if (!wanted.has(id)) continue;
      wanted.delete(id);
      found++;
      onFound(id, plainText(elementContent(record, '<abstract\\b', 'abstract')));
    }
    console.log(`  OAI ${set} since ${from}, page ${page}: ${found} found, ${wanted.size} to go`);
    const token = xml.match(/<resumptionToken[^>]*>([^<]+)<\/resumptionToken>/)?.[1];
    if (!token || wanted.size === 0) break;
    query = `verb=ListRecords&resumptionToken=${encodeURIComponent(token)}`;
  }
}

/** Abstract from an /abs page's citation_abstract meta tag. */
async function fetchAbsPage(id: string, delayMs: number): Promise<string> {
  const html = await politeFetch(absUrl(id), delayMs);
  return plainText(html.match(/<meta name="citation_abstract" content="([^"]*)"/)?.[1] ?? '');
}

/**
 * Fills in `abstract` for every paper. Each abstract is cached in `cacheDir`
 * as soon as it is found and never downloaded again, so an interrupted run
 * picks up where it stopped. `delayMs` is the gap between /abs page requests.
 */
export async function fillAbstracts(papers: Paper[], cacheDir: string, delayMs: number): Promise<Paper[]> {
  const save = (p: Paper) => writeJson(cacheFile(cacheDir, p.id), p);

  const result = papers.map((p) => {
    if (p.abstract) {
      if (!fs.existsSync(cacheFile(cacheDir, p.id))) save(p); // abstract came with the listing (/new pages)
      return p;
    }
    const cached = readJson<Paper>(cacheFile(cacheDir, p.id));
    // Keep this listing's metadata; only the abstract comes from the cache.
    return cached?.abstract ? { ...p, abstract: cached.abstract } : p;
  });

  let missing = result.filter((p) => !p.abstract);
  console.log(`  ${result.length - missing.length} abstracts from listings and cache, ${missing.length} to fetch`);

  // Bulk: one OAI-PMH harvest per set.
  const bySet = new Map<string, Paper[]>();
  for (const p of missing) bySet.set(oaiSet(p.category), [...(bySet.get(oaiSet(p.category)) ?? []), p]);
  for (const [set, group] of bySet) {
    const byId = new Map(group.map((p) => [p.id, p]));
    try {
      await harvestOai(set, oaiFromDate(group), new Set(byId.keys()), (id, abstract) => {
        const p = byId.get(id)!;
        p.abstract = abstract;
        if (abstract) save(p);
      });
    } catch (err) {
      console.warn(`  ⚠️  OAI harvest of ${set} failed: ${(err as Error).message}`);
    }
  }

  // Stragglers: one /abs page each.
  missing = result.filter((p) => !p.abstract);
  if (missing.length) {
    const minutes = Math.ceil((missing.length * delayMs) / 60000);
    console.log(`  Fetching ${missing.length} abstract pages, one every ${delayMs / 1000}s (~${minutes} min)`);
  }
  for (const p of missing) {
    try {
      p.abstract = await fetchAbsPage(p.id, delayMs);
      if (p.abstract) save(p);
    } catch (err) {
      console.warn(`  ⚠️  ${p.id}: ${(err as Error).message}`);
    }
  }
  const stillMissing = result.filter((p) => !p.abstract).length;
  if (stillMissing) console.warn(`  ⚠️  ${stillMissing} papers have no abstract; they are judged on their title only`);
  return result;
}
